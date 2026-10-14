import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { importSourceIdentitySchema, type ImportSourceIdentity } from './library.js';
import { identifier, label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { retargetProfileSchema, type RetargetProfile } from './retarget.js';
import { areCanonicalMappedTargets } from './export-targets.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const exportEvidenceSchema = z.object({ frameCount: z.number().int().min(1).max(2048), poseCount: z.number().int().nonnegative(),
  markerCount: z.number().int().nonnegative(), animatedTrackCount: z.number().int().min(1).max(1024),
  mappedTargetJoints: z.array(label).max(1024).optional() }).strict()
  .refine(evidence => evidence.mappedTargetJoints === undefined || (evidence.animatedTrackCount === evidence.mappedTargetJoints.length
    && areCanonicalMappedTargets(evidence.mappedTargetJoints)),
  'Mapped export target names must be unique, sorted, and match the target count.');
const candidateSchema = z.object({ expiresAt: z.number().finite().nonnegative(), jobId: identifier, sessionId: identifier, rigId: identifier,
  recipe: recipeSchema, sourceRigProfile: retargetProfileSchema, sourceIdentity: importSourceIdentitySchema,
  sourceType: z.enum(['KeyframeSequence', 'CurveAnimation']), unmapped: z.array(label).max(256),
  diagnostics: z.record(z.unknown()), exportPreflightJobId: identifier.optional(), exportEvidence: exportEvidenceSchema.optional(),
  exportFailure: z.string().min(1).max(2000).optional(), openJobId: identifier.optional() }).strict()
  .refine(candidate => candidate.recipe.kind === 'animation', 'Import candidate recipe must be an animation.')
  .refine(candidate => !(candidate.exportEvidence && candidate.exportFailure), 'Import export evidence cannot be both valid and failed.');
const entrySchema = z.object({ candidateFingerprint: sha256, candidate: candidateSchema, integrity: sha256 }).strict();
const storeSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(entrySchema).max(32) }).strict();

export interface PersistedImportCandidate {
  expiresAt: number;
  jobId: string;
  sessionId: string;
  rigId: string;
  recipe: AnimationRecipe;
  sourceRigProfile: RetargetProfile;
  sourceIdentity: ImportSourceIdentity;
  sourceType: 'KeyframeSequence' | 'CurveAnimation';
  unmapped: string[];
  diagnostics: Record<string, unknown>;
  exportPreflightJobId?: string;
  exportEvidence?: z.infer<typeof exportEvidenceSchema>;
  exportFailure?: string;
  openJobId?: string;
}

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** A small, local-only restart handoff for candidates that already passed Studio import conversion. */
export class ImportCandidateStore {
  private readonly entries = new Map<string, PersistedImportCandidate>();

  constructor(private readonly path: string, private readonly now = Date.now) {
    let contents: string;
    try { contents = readFileSync(path, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(contents, 'utf8') > 32 * 1024 * 1024) throw new Error('Import candidate store exceeds its 32 MiB safety limit; refusing to load it.');
    const parsed = storeSchema.parse(JSON.parse(contents));
    for (const entry of parsed.entries) {
      const { candidateFingerprint, candidate } = entry;
      if (digest({ version: 1, candidateFingerprint, candidate }) !== entry.integrity) {
        throw new Error(`Import candidate ${candidateFingerprint} failed its integrity check; refusing unsafe recovery.`);
      }
      if (candidate.expiresAt <= now()) continue;
      if (candidate.recipe.kind !== 'animation') throw new Error(`Import candidate ${candidateFingerprint} is not an animation.`);
      this.entries.set(candidateFingerprint, candidate as PersistedImportCandidate);
    }
    this.persist();
  }

  get(candidateFingerprint: string): PersistedImportCandidate | undefined {
    const candidate = this.entries.get(candidateFingerprint);
    if (!candidate) return undefined;
    if (candidate.expiresAt <= this.now()) { this.delete(candidateFingerprint); return undefined; }
    return structuredClone(candidate);
  }

  list(): Array<[string, PersistedImportCandidate]> {
    this.prune();
    return [...this.entries].map(([key, value]) => [key, structuredClone(value)]);
  }

  set(candidateFingerprint: string, candidate: PersistedImportCandidate) {
    const validated = candidateSchema.parse(candidate);
    if (validated.recipe.kind !== 'animation') throw new Error('Only animation imports can be stored as recoverable import candidates.');
    this.entries.set(candidateFingerprint, structuredClone(validated) as PersistedImportCandidate);
    this.prune();
    this.persist();
  }

  delete(candidateFingerprint: string) {
    if (!this.entries.delete(candidateFingerprint)) return;
    this.persist();
  }

  private prune() {
    for (const [key, candidate] of this.entries) if (candidate.expiresAt <= this.now()) this.entries.delete(key);
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value as string);
  }

  private persist() {
    this.prune();
    const entries = [...this.entries].map(([candidateFingerprint, candidate]) => ({ candidateFingerprint, candidate,
      integrity: digest({ version: 1, candidateFingerprint, candidate }) }));
    const contents = JSON.stringify({ schemaVersion: 1, entries });
    if (Buffer.byteLength(contents, 'utf8') > 32 * 1024 * 1024) throw new Error('Import candidate store would exceed its 32 MiB safety limit.');
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporaryPath, contents, { flag: 'wx' });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* Temporary file may not exist. */ }
      throw error;
    }
  }
}
