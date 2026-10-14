import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { animationSchema, identifier, label } from './recipes.js';
import { retargetProfileSchema } from './retarget.js';
import { fingerprint, fingerprintUuid } from './inspection.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const editorDraftResultSchema = z.object({ rigId: identifier, rigSignature: z.string().min(1).max(30000), assetId: identifier,
  ephemeral: z.boolean(), dirty: z.boolean(), parentAssetId: identifier.optional(), sourceRigProfile: retargetProfileSchema.optional(),
  sourceFingerprint: sha256.optional(), currentTime: z.number().finite().min(0).max(30), recipe: animationSchema,
}).strict().superRefine((draft, context) => {
  if (draft.currentTime > draft.recipe.duration) context.addIssue({ code: 'custom', path: ['currentTime'], message: 'Editor playhead must be inside the draft duration.' });
  if (!draft.dirty && draft.sourceFingerprint && fingerprint(draft.recipe) !== draft.sourceFingerprint) {
    context.addIssue({ code: 'custom', message: 'Studio marked the editor draft clean, but its recipe differs from the selected asset fingerprint. Re-read the editor and inspect its state before editing.' });
  }
});
const checkpointDataSchema = z.object({ version: z.literal(1), id: identifier, name: label, note: z.string().max(2000),
  readRequestedAt: z.string().datetime(), sessionId: identifier, readJobId: identifier, draftFingerprint: sha256, draft: editorDraftResultSchema,
}).strict();
const checkpointSchema = checkpointDataSchema.extend({ checkpointFingerprint: sha256 }).strict();
export type EditorCheckpoint = z.infer<typeof checkpointSchema>;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const digest = (record: object) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
export const checkpointFilterSchema = z.object({
  rigSignature: z.string().min(1).max(30000).optional(),
  rigId: identifier.optional(),
  dirty: z.boolean().optional(),
}).strict();

export class EditorCheckpointLibrary {
  constructor(readonly directory: string) {}

  async create(input: { name: string; note: string; sessionId: string; readJobId: string; readRequestedAt: string;
    draftFingerprint: string; draft: z.infer<typeof editorDraftResultSchema> }) {
    const id = fingerprintUuid(digest({ purpose: 'editor-checkpoint', sessionId: input.sessionId, readJobId: input.readJobId, draftFingerprint: input.draftFingerprint }));
    const data = checkpointDataSchema.parse({ ...input, version: 1, id });
    if (fingerprint(data.draft.recipe) !== data.draftFingerprint) throw new Error('Checkpoint draft fingerprint does not match its exact recipe.');
    const checkpoint = checkpointSchema.parse({ ...data, checkpointFingerprint: digest(data) });
    const content = JSON.stringify(checkpoint);
    if (Buffer.byteLength(content) > MAX_CHECKPOINT_BYTES) throw new Error('Editor checkpoint exceeds the 8 MiB storage limit.');
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${id}.json`);
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      try { await link(temporary, target); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
        const existing = await this.get(id);
        if (existing.checkpointFingerprint !== checkpoint.checkpointFingerprint) throw new Error('This read already has an immutable checkpoint with different metadata. Read it before creating another checkpoint.');
        return { checkpoint: existing, alreadyRecorded: true };
      }
      return { checkpoint, alreadyRecorded: false };
    } finally { await unlink(temporary); }
  }

  async get(id: string): Promise<EditorCheckpoint> {
    identifier.parse(id);
    const path = join(this.directory, `${id}.json`);
    if ((await stat(path)).size > MAX_CHECKPOINT_BYTES) throw new Error('Editor checkpoint exceeds its storage limit.');
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_CHECKPOINT_BYTES) throw new Error('Editor checkpoint exceeds its storage limit.');
    const checkpoint = checkpointSchema.parse(JSON.parse(raw));
    const { checkpointFingerprint, ...data } = checkpoint;
    if (checkpoint.id !== id || digest(data) !== checkpointFingerprint || fingerprint(checkpoint.draft.recipe) !== checkpoint.draftFingerprint) {
      throw new Error('Editor checkpoint identity or contents failed verification.');
    }
    return checkpoint;
  }

  async list(offset = 0, limit = 20, filter: z.infer<typeof checkpointFilterSchema> = {}) {
    z.number().int().min(0).max(100000).parse(offset);
    z.number().int().min(1).max(50).parse(limit);
    const filters = checkpointFilterSchema.parse(filter);
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') names = [];
      else throw error;
    }
    const entries: Array<Omit<EditorCheckpoint, 'draft'> & { rigId: string; rigSignature: string; sourceRigName: string | null; assetId: string; duration: number; dirty: boolean; ephemeral: boolean }> = [];
    const invalidRecords: Array<{ id: string; detail: string }> = [];
    let invalidRecordCount = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || !identifier.safeParse(name.slice(0, -5)).success) continue;
      const id = name.slice(0, -5);
      try {
        const { draft, ...checkpoint } = await this.get(id);
        if (filters.rigSignature !== undefined && draft.rigSignature !== filters.rigSignature
          || filters.rigId !== undefined && draft.rigId !== filters.rigId
          || filters.dirty !== undefined && draft.dirty !== filters.dirty) continue;
        entries.push({ ...checkpoint, rigId: draft.rigId, rigSignature: draft.rigSignature, sourceRigName: draft.sourceRigProfile?.rigName ?? null, assetId: draft.assetId,
          duration: draft.recipe.duration, dirty: draft.dirty, ephemeral: draft.ephemeral });
      } catch {
        invalidRecordCount++;
        if (invalidRecords.length < 8) invalidRecords.push({ id, detail: 'Checkpoint is unreadable or failed identity/content validation.' });
      }
    }
    entries.sort((left, right) => right.readRequestedAt.localeCompare(left.readRequestedAt) || left.id.localeCompare(right.id));
    return { entries: entries.slice(offset, offset + limit), total: entries.length, offset, limit, filters,
      nextOffset: offset + limit < entries.length ? offset + limit : null, invalidRecordCount, invalidRecords };
  }
}
