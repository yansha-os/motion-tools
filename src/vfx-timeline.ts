import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './inspection.js';
import { Library } from './library.js';
import { identifier, label, type VfxRecipe } from './recipes.js';
import { resolvePreviewCueTime } from './preview-cues.js';

const sourceFingerprint = z.string().regex(/^[0-9a-f]{64}$/);
export const vfxTimelineCueSchema = z.object({
  effectId: identifier,
  part: label,
  time: z.number().finite().min(0).max(30).optional(),
  marker: label.optional(),
  occurrence: z.number().int().min(1).max(100).optional(),
  offset: z.number().finite().min(-30).max(30).optional(),
}).strict().superRefine((cue, context) => {
  const hasTime = cue.time !== undefined;
  const hasMarker = cue.marker !== undefined;
  if (hasTime === hasMarker) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Specify exactly one cue time or marker name.' });
  if (hasTime && (cue.occurrence !== undefined || cue.offset !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Occurrence and offset are valid only for marker-relative cues.' });
  }
});

export const vfxTimelineSchema = z.object({
  name: label,
  animationId: identifier,
  seconds: z.number().finite().min(0.1).max(30).default(5),
  cues: z.array(vfxTimelineCueSchema).min(1).max(12),
}).strict();
export type VfxTimelineRecipe = z.infer<typeof vfxTimelineSchema>;

export function vfxTimelineFingerprint(recipe: VfxTimelineRecipe, sourceFingerprints: string[]) {
  return createHash('sha256').update(JSON.stringify({ recipe, sourceFingerprints })).digest('hex');
}

export interface SavedVfxTimeline {
  id: string;
  createdAt: string;
  parentId?: string;
  sourceFingerprints: string[];
  candidateFingerprint: string;
  recipe: VfxTimelineRecipe;
}

const savedVfxTimelineSchema = z.object({
  id: identifier,
  createdAt: z.string().datetime(),
  parentId: identifier.optional(),
  sourceFingerprints: z.array(sourceFingerprint).min(2).max(13),
  candidateFingerprint: sourceFingerprint,
  recipe: vfxTimelineSchema,
}).strict();

export async function validateVfxTimeline(input: unknown, library: Library) {
  const recipe = vfxTimelineSchema.parse(input);
  const animationAsset = await library.get(recipe.animationId);
  if (animationAsset.recipe.kind !== 'animation') throw new Error('A VFX timeline must reference an animation asset.');
  const animation = animationAsset.recipe;
  const effectAssets = await Promise.all(recipe.cues.map(cue => library.get(cue.effectId)));
  const effects = [] as { part: string; time: number; recipe: VfxRecipe; sourceMarker?: { name: string; occurrence: number; offset: number } }[];
  for (const [index, effectAsset] of effectAssets.entries()) {
    if (effectAsset.recipe.kind !== 'vfx') throw new Error(`VFX cue ${index + 1} must reference a VFX asset.`);
    const cue = recipe.cues[index]!;
    const time = resolvePreviewCueTime({ ...cue, assetId: cue.effectId }, animation, recipe.seconds);
    effects.push({
      part: cue.part,
      time,
      recipe: effectAsset.recipe,
      ...(cue.marker === undefined ? {} : { sourceMarker: { name: cue.marker, occurrence: cue.occurrence ?? 1, offset: cue.offset ?? 0 } }),
    });
  }
  const sourceFingerprints = [fingerprint(animationAsset.recipe), ...effectAssets.map(asset => fingerprint(asset.recipe))];
  return { recipe, animation, effects, sourceFingerprints, candidateFingerprint: vfxTimelineFingerprint(recipe, sourceFingerprints) };
}

export class VfxTimelineLibrary {
  constructor(readonly directory: string, readonly assets: Library) {}

  async preview(input: unknown) {
    return validateVfxTimeline(input, this.assets);
  }

  async save(input: unknown, expectedCandidateFingerprint: string, parentId?: string): Promise<SavedVfxTimeline> {
    const candidate = await validateVfxTimeline(input, this.assets);
    if (candidate.candidateFingerprint !== expectedCandidateFingerprint) throw new Error('The VFX timeline or one of its source assets changed since preview. Preview the exact timeline again before saving.');
    if (parentId) await this.load(parentId);
    const saved: SavedVfxTimeline = {
      id: randomUUID(), createdAt: new Date().toISOString(), ...(parentId ? { parentId } : {}),
      sourceFingerprints: candidate.sourceFingerprints, candidateFingerprint: candidate.candidateFingerprint, recipe: candidate.recipe,
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${saved.id}.json`), JSON.stringify(saved, null, 2), { flag: 'wx' });
    return saved;
  }

  private async load(id: string): Promise<SavedVfxTimeline> {
    identifier.parse(id);
    const saved = savedVfxTimelineSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
    if (saved.id !== id) throw new Error('VFX timeline identity mismatch.');
    if (vfxTimelineFingerprint(saved.recipe, saved.sourceFingerprints) !== saved.candidateFingerprint) {
      throw new Error(`VFX timeline ${id} content fingerprint mismatch; the stored cue sheet may have been modified.`);
    }
    return saved;
  }

  private async resolveIntegrity(saved: SavedVfxTimeline) {
    try {
      const current = await validateVfxTimeline(saved.recipe, this.assets);
      if (saved.sourceFingerprints.length !== current.sourceFingerprints.length) return { status: 'stale' as const, issue: 'Stored source fingerprint count does not match the cue sheet.' };
      for (const [index, expected] of saved.sourceFingerprints.entries()) {
        if (current.sourceFingerprints[index] !== expected) return { status: 'stale' as const, issue: `Source asset ${index + 1} changed after this cue sheet was saved.` };
      }
      return { status: 'verified' as const };
    } catch (error) {
      return { status: 'stale' as const, issue: error instanceof Error ? `A source asset is no longer compatible: ${error.message}` : 'A source asset is no longer compatible.' };
    }
  }

  async get(id: string) {
    const saved = await this.load(id);
    const integrity = await this.resolveIntegrity(saved);
    if (integrity.status === 'stale') throw new Error(`VFX timeline ${id} has stale sources. ${integrity.issue} Create a child revision to explicitly adopt the current assets.`);
    return { ...saved, resolved: await validateVfxTimeline(saved.recipe, this.assets) };
  }

  async list(offset = 0, limit = 30) {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    const all = await Promise.all(files.map(async file => {
      const id = file.slice(0, -5);
      try {
        const saved = await this.load(id);
        const integrity = await this.resolveIntegrity(saved);
        return {
          id: saved.id, createdAt: saved.createdAt, ...(saved.parentId ? { parentId: saved.parentId } : {}),
          name: saved.recipe.name, animationId: saved.recipe.animationId, cueCount: saved.recipe.cues.length,
          sourceIntegrity: integrity.status, ...(integrity.issue ? { sourceIntegrityIssue: integrity.issue } : {}),
        };
      } catch (error) {
        return { id, name: 'Corrupt cue sheet', cueCount: 0, sourceIntegrity: 'corrupt' as const,
          sourceIntegrityIssue: error instanceof Error ? error.message : 'Could not validate this stored cue sheet.' };
      }
    }));
    all.sort((a, b) => ('createdAt' in b ? b.createdAt : '').localeCompare('createdAt' in a ? a.createdAt : '') || a.id.localeCompare(b.id));
    return { total: all.length, offset, timelines: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null };
  }
}
