import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { identifier, label, recipeSchema, type Recipe } from './recipes.js';
import { retargetProfileSchema, type RetargetProfile } from './retarget.js';
import { animationPatchSchema, patchAnimation, patchLayerIdFactory, preservationRegionsSchema } from './animation-patch.js';
import { fingerprint } from './inspection.js';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const captureJointMapSchema = z.record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)).refine(map => Object.keys(map).length <= 256);
const captureJointMapFingerprint = (map: Record<string, string>) => createHash('sha256')
  .update(JSON.stringify(Object.entries(map).sort(([left], [right]) => left.localeCompare(right)))).digest('hex');
const jointMappingProvenanceSchema = z.object({ fingerprint: sha256, appliedFingerprint: sha256.optional(), renamedJointCount: z.number().int().nonnegative(), nameMapApplied: z.boolean(),
  renamedJoints: z.array(z.object({ source: z.string().min(1).max(128), target: z.string().min(1).max(128) }).strict()).max(512).optional(),
  jointMap: captureJointMapSchema.optional(),
  limitation: z.string().min(1).max(300) }).strict().superRefine((mapping, context) => {
    if (mapping.nameMapApplied !== (mapping.renamedJointCount > 0)) context.addIssue({ code: 'custom', path: ['nameMapApplied'], message: 'Name-map applied status must match the renamed-joint count.' });
    if (mapping.renamedJoints && mapping.renamedJoints.length !== mapping.renamedJointCount) context.addIssue({ code: 'custom', path: ['renamedJoints'], message: 'Renamed-joint details must match the declared count.' });
    if (mapping.renamedJoints && (new Set(mapping.renamedJoints.map(item => item.source)).size !== mapping.renamedJoints.length
      || mapping.renamedJoints.some(item => item.source === item.target))) context.addIssue({ code: 'custom', path: ['renamedJoints'], message: 'Renamed-joint details must have unique source names and actual name changes.' });
    if (mapping.jointMap && captureJointMapFingerprint(mapping.jointMap) !== mapping.fingerprint) context.addIssue({ code: 'custom', path: ['jointMap'], message: 'Exact joint map must match the recorded fingerprint.' });
  });
const patchFindingSchema = z.object({ historyRecordId: identifier, reportFingerprint: sha256, candidateFingerprint: sha256,
  candidateLabel: z.string().min(1).max(80), criterion: z.string().min(3).max(240), status: z.literal('contradicted'), observation: z.string().min(10).max(600),
  evidence: z.array(z.object({ captureId: identifier, time: z.number().finite().min(0).max(30), normalizedProgress: z.number().finite().min(0).max(1).optional(),
    view: z.string().min(1).max(40), sha256, jointMapping: jointMappingProvenanceSchema.optional() }).strict()).min(1).max(8) }).strict();
const revisionProvenanceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('ai_candidate_patch'), sourceFingerprint: sha256, sourceRecipe: recipeSchema,
  candidateFingerprint: sha256, candidateRecipeFingerprint: sha256, operations: animationPatchSchema, preserve: preservationRegionsSchema,
  changeIntent: z.string().min(10).max(600).optional(), visualFinding: patchFindingSchema.optional(), provenanceFingerprint: sha256 }).strict();
export type RevisionProvenance = z.infer<typeof revisionProvenanceSchema>;
export const importSourceIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), assetId: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ kind: z.literal('anim_saves'), sequenceName: label, sequenceLocator: z.string().min(1).max(2000).optional() }).strict(),
]);
export type ImportSourceIdentity = z.infer<typeof importSourceIdentitySchema>;
const importProvenanceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('roblox_animation_import'),
  sourceIdentity: importSourceIdentitySchema, recipeFingerprint: sha256, rigGeometryFingerprint: sha256, provenanceFingerprint: sha256 }).strict();
export type ImportProvenance = z.infer<typeof importProvenanceSchema>;
export const animationAuthoringIntentSchema = z.object({ schemaVersion: z.literal(1), sourceRecipeFingerprint: sha256, phases: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), label: z.enum(['anticipation', 'main_action', 'follow_through', 'recovery']),
  start: z.number().finite().min(0).max(1), end: z.number().finite().min(0).max(1), intent: z.string().trim().min(1).max(240).optional(),
}).strict()).min(1).max(16),
  events: z.array(z.object({ name: label, phaseId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), progress: z.number().finite().min(0).max(1),
    time: z.number().finite().min(0).max(30), value: z.string().max(500).optional() }).strict()).max(84).optional(),
  contacts: z.array(z.object({ effector: label, kind: z.enum(['support', 'grip']), phaseId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    startProgress: z.number().finite().min(0).max(1), endProgress: z.number().finite().min(0).max(1),
    start: z.number().finite().min(0).max(30), end: z.number().finite().min(0).max(30) }).strict()).max(16).optional(),
  authoringIntentFingerprint: sha256.optional(),
}).strict().superRefine((brief, context) => {
  const ids = new Set<string>();
  for (const [index, phase] of brief.phases.entries()) {
    if (ids.has(phase.id)) context.addIssue({ code: 'custom', path: ['phases', index, 'id'], message: 'Authoring-intent phase IDs must be unique.' });
    ids.add(phase.id);
    if (phase.end <= phase.start) context.addIssue({ code: 'custom', path: ['phases', index, 'end'], message: 'Authoring-intent phase end must follow its start.' });
    if (index === 0 && phase.start !== 0) context.addIssue({ code: 'custom', path: ['phases', index, 'start'], message: 'Authoring intent must start at normalized time 0.' });
    if (index > 0 && Math.abs(phase.start - brief.phases[index - 1]!.end) > 1e-6) context.addIssue({ code: 'custom', path: ['phases', index, 'start'], message: 'Authoring-intent phases must be ordered, contiguous, and non-overlapping.' });
  }
  if (Math.abs((brief.phases.at(-1)?.end ?? 0) - 1) > 1e-6) context.addIssue({ code: 'custom', path: ['phases', brief.phases.length - 1, 'end'], message: 'Authoring intent must end at normalized time 1.' });
  if (brief.phases.length + (brief.events?.length ?? 0) > 100) context.addIssue({ code: 'custom', path: ['events'], message: 'Persisted authoring intent cannot contain more than 100 combined phase and event markers.' });
  for (const [index, event] of (brief.events ?? []).entries()) if (!ids.has(event.phaseId)) context.addIssue({ code: 'custom', path: ['events', index, 'phaseId'], message: `Unknown authoring-intent event phase ${event.phaseId}.` });
  for (const [index, contact] of (brief.contacts ?? []).entries()) {
    if (!ids.has(contact.phaseId)) context.addIssue({ code: 'custom', path: ['contacts', index, 'phaseId'], message: `Unknown authoring-intent contact phase ${contact.phaseId}.` });
    if (contact.endProgress <= contact.startProgress) context.addIssue({ code: 'custom', path: ['contacts', index, 'endProgress'], message: 'Authoring-intent contact end progress must follow its start progress.' });
    if (contact.end <= contact.start) context.addIssue({ code: 'custom', path: ['contacts', index, 'end'], message: 'Authoring-intent contact end time must follow its start time.' });
  }
  if (brief.authoringIntentFingerprint) {
    const { authoringIntentFingerprint: _fingerprint, ...identity } = brief;
    if (hashJson(identity) !== brief.authoringIntentFingerprint) context.addIssue({ code: 'custom', path: ['authoringIntentFingerprint'], message: 'Authoring-intent fingerprint does not match its persisted phase, event, and contact content.' });
  }
});
export type AnimationAuthoringIntent = z.infer<typeof animationAuthoringIntentSchema>;
export type AuthoringIntentTimingRelation = 'exact_current_recipe' | 'historical_reference' | 'unavailable';
export function classifyAuthoringIntentTiming(intent: AnimationAuthoringIntent | undefined | null, recipeFingerprint: string | undefined | null): AuthoringIntentTimingRelation {
  if (!intent || !recipeFingerprint) return 'unavailable';
  return intent.sourceRecipeFingerprint === recipeFingerprint ? 'exact_current_recipe' : 'historical_reference';
}
function hashJson(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function patchIdentity(provenance: RevisionProvenance) {
  return hashJson({ sourceFingerprint: provenance.sourceFingerprint, operations: provenance.operations, preserve: provenance.preserve,
    recipeFingerprint: provenance.candidateRecipeFingerprint });
}
function provenanceIdentity(provenance: RevisionProvenance) {
  const { provenanceFingerprint: _provenanceFingerprint, ...identity } = provenance;
  return hashJson(identity);
}
export function createRevisionProvenance(sourceRecipeInput: Recipe, candidateRecipeInput: Recipe, operationsInput: unknown, preserveInput: unknown = []) {
  const sourceRecipe = recipeSchema.parse(sourceRecipeInput), candidateRecipe = recipeSchema.parse(candidateRecipeInput);
  if (sourceRecipe.kind !== 'animation' || candidateRecipe.kind !== 'animation') throw new Error('Patch revision provenance requires animation recipes.');
  const operations = animationPatchSchema.parse(operationsInput), preserve = preservationRegionsSchema.parse(preserveInput);
  const sourceFingerprint = fingerprint(sourceRecipe), candidateRecipeFingerprint = fingerprint(candidateRecipe);
  const replay = patchAnimation(sourceRecipe, operations, patchLayerIdFactory('unsaved-candidate', sourceFingerprint, operations, preserve));
  if (fingerprint(replay.recipe) !== candidateRecipeFingerprint) throw new Error('Patch operations do not reproduce the exact candidate recipe.');
  const core = { schemaVersion: 1 as const, kind: 'ai_candidate_patch' as const, sourceFingerprint, sourceRecipe, candidateRecipeFingerprint,
    operations, preserve, candidateFingerprint: hashJson({ sourceFingerprint, operations, preserve, recipeFingerprint: candidateRecipeFingerprint }) };
  const normalizedCore = revisionProvenanceSchema.omit({ provenanceFingerprint: true }).parse(core);
  return { ...normalizedCore, provenanceFingerprint: hashJson(normalizedCore) } satisfies RevisionProvenance;
}
function validateRevisionProvenance(input: unknown, recipe: Recipe, parent: Asset | undefined) {
  if (input === undefined) return undefined;
  const provenance = revisionProvenanceSchema.parse(input);
  if (recipe.kind !== 'animation') throw new Error('Only animation revisions can carry candidate-patch provenance.');
  if (fingerprint(recipe) !== provenance.candidateRecipeFingerprint) throw new Error('Patch provenance candidate recipe fingerprint does not match the saved animation.');
  if (provenance.candidateFingerprint !== patchIdentity(provenance)) throw new Error('Patch provenance candidate fingerprint does not match its source, operations, preservation guards and recipe.');
  if (provenance.provenanceFingerprint !== provenanceIdentity(provenance)) throw new Error('Patch provenance fingerprint does not match its recorded intent and evidence.');
  if (provenance.sourceRecipe.kind !== 'animation' || fingerprint(provenance.sourceRecipe) !== provenance.sourceFingerprint) {
    throw new Error('Patch provenance source recipe does not match its source fingerprint.');
  }
  const replay = patchAnimation(provenance.sourceRecipe, provenance.operations,
    patchLayerIdFactory('unsaved-candidate', provenance.sourceFingerprint, provenance.operations, provenance.preserve));
  if (fingerprint(replay.recipe) !== provenance.candidateRecipeFingerprint) {
    throw new Error('Recorded patch operations do not reproduce the saved candidate animation.');
  }
  if (parent && fingerprint(parent.recipe) !== provenance.sourceFingerprint) throw new Error('Patch provenance source fingerprint does not match the selected parent asset.');
  return provenance;
}

export interface Asset { id: string; createdAt: string; parentId?: string; sourceRigProfile?: RetargetProfile; authoringIntent?: AnimationAuthoringIntent; revisionProvenance?: RevisionProvenance; importProvenance?: ImportProvenance; recipe: Recipe }
function rigGeometryIdentity(profile: RetargetProfile | undefined) {
  if (!profile) return null;
  return JSON.stringify({ version: profile.version, rigType: profile.rigType, rigSignature: profile.rigSignature, joints: profile.joints });
}
export function assertAnimationJointsDriven(recipe: Recipe, profile: RetargetProfile) {
  if (recipe.kind !== 'animation') throw new Error('Only animation assets can carry source rig provenance.');
  const driven = new Set(profile.joints.filter(joint => joint.driven).map(joint => joint.name));
  const animatedJoints = [
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
  ];
  const missing = [...new Set(animatedJoints.filter(joint => !driven.has(joint)))];
  if (missing.length) throw new Error(`Source rig profile ${profile.rigName} does not contain these animation joints as driven: ${missing.join(', ')}.`);
}
export function deterministicImportAssetId(sourceIdentity: ImportSourceIdentity, recipe: Recipe, sourceRigProfile: RetargetProfile) {
  const bytes = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, sourceIdentity,
    sourceRigGeometry: JSON.parse(rigGeometryIdentity(sourceRigProfile)!), recipe })).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function createImportProvenance(sourceIdentity: ImportSourceIdentity, recipe: Recipe, profile: RetargetProfile): ImportProvenance {
  const core = { schemaVersion: 1 as const, kind: 'roblox_animation_import' as const, sourceIdentity,
    recipeFingerprint: fingerprint(recipe), rigGeometryFingerprint: hashJson(JSON.parse(rigGeometryIdentity(profile)!)) };
  return { ...core, provenanceFingerprint: hashJson(core) };
}
export class Library {
  private readonly idempotentWrites = new Map<string, Promise<Asset>>();
  private readonly importedWrites = new Map<string, Promise<Asset>>();
  constructor(readonly directory: string) {}
  async save(recipe: Recipe, parentId?: string, sourceRigProfileInput?: unknown, revisionProvenanceInput?: unknown): Promise<Asset> {
    const validated = recipeSchema.parse(recipe);
    let parent: Asset | undefined;
    if (parentId) {
      parent = await this.get(parentId);
      if (parent.recipe.kind !== validated.kind) throw new Error('A revision must retain its parent asset kind.');
    }
    const sourceRigProfile = sourceRigProfileInput === undefined
      ? parent?.sourceRigProfile
      : retargetProfileSchema.parse(sourceRigProfileInput);
    if (sourceRigProfile && validated.kind !== 'animation') throw new Error('Only animation assets can carry source rig provenance.');
    if (sourceRigProfile) assertAnimationJointsDriven(validated, sourceRigProfile);
    const authoringIntent = parent?.authoringIntent;
    const revisionProvenance = validateRevisionProvenance(revisionProvenanceInput, validated, parent);
    const asset: Asset = {
      id: randomUUID(), createdAt: new Date().toISOString(), ...(parentId ? { parentId } : {}),
      ...(sourceRigProfile ? { sourceRigProfile } : {}), ...(authoringIntent ? { authoringIntent } : {}),
      ...(revisionProvenance ? { revisionProvenance } : {}), recipe: validated,
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${asset.id}.json`), JSON.stringify(asset, null, 2), { flag: 'wx' });
    return asset;
  }
  /** Save or reuse the exact same immutable asset under a caller-derived stable identity. */
  async saveIdempotent(recipe: Recipe, id: string, parentId?: string, sourceRigProfileInput?: unknown, revisionProvenanceInput?: unknown, importProvenance?: ImportProvenance, authoringIntentInput?: unknown): Promise<Asset> {
    identifier.parse(id);
    const validated = recipeSchema.parse(recipe);
    let parent: Asset | undefined;
    if (parentId) {
      parent = await this.get(parentId);
      if (parent.recipe.kind !== validated.kind) throw new Error('A revision must retain its parent asset kind.');
    }
    const sourceRigProfile = sourceRigProfileInput === undefined
      ? parent?.sourceRigProfile
      : retargetProfileSchema.parse(sourceRigProfileInput);
    if (sourceRigProfile && validated.kind !== 'animation') throw new Error('Only animation assets can carry source rig provenance.');
    if (sourceRigProfile) assertAnimationJointsDriven(validated, sourceRigProfile);
    const authoringIntent = authoringIntentInput === undefined ? parent?.authoringIntent : animationAuthoringIntentSchema.parse(authoringIntentInput);
    if (authoringIntentInput !== undefined && authoringIntent?.sourceRecipeFingerprint !== fingerprint(validated)) {
      throw new Error('New authoring intent must identify the exact recipe being saved; recompile and bind it to that recipe fingerprint.');
    }
    if (authoringIntent && validated.kind !== 'animation') throw new Error('Only animation assets can carry phase authoring intent.');
    const revisionProvenance = validateRevisionProvenance(revisionProvenanceInput, validated, parent);
    const serialize = (value: Recipe) => JSON.stringify(value);
    const matchesExisting = (existing: Asset) => serialize(existing.recipe) === serialize(validated)
      && existing.parentId === parentId && JSON.stringify(existing.sourceRigProfile ?? null) === JSON.stringify(sourceRigProfile ?? null)
      && JSON.stringify(existing.revisionProvenance ?? null) === JSON.stringify(revisionProvenance ?? null)
      && JSON.stringify(existing.importProvenance ?? null) === JSON.stringify(importProvenance ?? null)
      && (JSON.stringify(existing.authoringIntent ?? null) === JSON.stringify(authoringIntent ?? null)
        || (existing.authoringIntent === undefined && authoringIntent !== undefined));
    const existingWrite = this.idempotentWrites.get(id);
    if (existingWrite) {
      const existing = await existingWrite;
      if (!matchesExisting(existing)) throw new Error(`Idempotent asset identity ${id} is already bound to different recipe content, lineage, or rig provenance.`);
      return existing;
    }
    const write = (async () => {
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, `${id}.json`);
      try {
        const asset: Asset = { id, createdAt: new Date().toISOString(), ...(parentId ? { parentId } : {}), ...(sourceRigProfile ? { sourceRigProfile } : {}),
          ...(authoringIntent ? { authoringIntent } : {}), ...(revisionProvenance ? { revisionProvenance } : {}), ...(importProvenance ? { importProvenance } : {}), recipe: validated };
        await writeFile(path, JSON.stringify(asset, null, 2), { flag: 'wx' });
        return asset;
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error;
        const existing = await this.get(id);
        if (!matchesExisting(existing)) throw new Error(`Idempotent asset identity ${id} is already bound to different recipe content, lineage, or rig provenance.`);
        return existing;
      }
    })();
    this.idempotentWrites.set(id, write);
    try { return await write; }
    finally { if (this.idempotentWrites.get(id) === write) this.idempotentWrites.delete(id); }
  }
  async saveImportedIdempotent(recipe: Recipe, id: string, sourceRigProfileInput: unknown, sourceIdentityInput: unknown): Promise<Asset> {
    identifier.parse(id);
    const validatedRecipe = recipeSchema.parse(recipe);
    const sourceRigProfile = retargetProfileSchema.parse(sourceRigProfileInput);
    const sourceIdentity = importSourceIdentitySchema.parse(sourceIdentityInput);
    if (deterministicImportAssetId(sourceIdentity, validatedRecipe, sourceRigProfile) !== id) throw new Error('Imported asset ID does not match its source identity, recipe, and rig geometry.');
    const importProvenance = createImportProvenance(sourceIdentity, validatedRecipe, sourceRigProfile);
    const matchesImport = (existing: Asset) => existing.parentId === undefined && existing.revisionProvenance === undefined
      && JSON.stringify(existing.recipe) === JSON.stringify(validatedRecipe)
      && JSON.stringify(existing.importProvenance ?? null) === JSON.stringify(importProvenance)
      && rigGeometryIdentity(existing.sourceRigProfile) === rigGeometryIdentity(sourceRigProfile);
    const assertMatch = (asset: Asset) => {
      if (!matchesImport(asset)) throw new Error(`Imported asset identity ${id} is already bound to different recipe content or rig geometry.`);
      return asset;
    };
    const activeWrite = this.importedWrites.get(id);
    if (activeWrite) return assertMatch(await activeWrite);
    const write = (async () => {
      const existing = async () => {
        try { return await this.get(id); }
        catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
          throw error;
        }
      };
      const prior = await existing();
      if (prior) return assertMatch(prior);
      try { return await this.saveIdempotent(validatedRecipe, id, undefined, sourceRigProfile, undefined, importProvenance); }
      catch (error) {
        const raced = await existing();
        if (raced && matchesImport(raced)) return raced;
        throw error;
      }
    })();
    this.importedWrites.set(id, write);
    try { return await write; }
    finally { if (this.importedWrites.get(id) === write) this.importedWrites.delete(id); }
  }
  async get(id: string): Promise<Asset> {
    identifier.parse(id);
    const asset = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as Asset;
    if (asset.id !== id) throw new Error('Asset identity mismatch.');
    asset.recipe = recipeSchema.parse(asset.recipe);
    if (asset.sourceRigProfile !== undefined) asset.sourceRigProfile = retargetProfileSchema.parse(asset.sourceRigProfile);
    if (asset.authoringIntent !== undefined) asset.authoringIntent = animationAuthoringIntentSchema.parse(asset.authoringIntent);
    if (asset.authoringIntent && asset.recipe.kind !== 'animation') throw new Error('Only animation assets can carry phase authoring intent.');
    if (asset.sourceRigProfile && asset.recipe.kind !== 'animation') throw new Error('Only animation assets can carry source rig provenance.');
    if (asset.importProvenance !== undefined) {
      const provenance = importProvenanceSchema.parse(asset.importProvenance);
      if (asset.recipe.kind !== 'animation' || !asset.sourceRigProfile
        || provenance.recipeFingerprint !== fingerprint(asset.recipe)
        || provenance.rigGeometryFingerprint !== hashJson(JSON.parse(rigGeometryIdentity(asset.sourceRigProfile)!))
        || provenance.provenanceFingerprint !== hashJson({ schemaVersion: provenance.schemaVersion, kind: provenance.kind,
          sourceIdentity: provenance.sourceIdentity, recipeFingerprint: provenance.recipeFingerprint, rigGeometryFingerprint: provenance.rigGeometryFingerprint })
        || deterministicImportAssetId(provenance.sourceIdentity, asset.recipe, asset.sourceRigProfile) !== asset.id
        || asset.parentId !== undefined || asset.revisionProvenance !== undefined) {
        throw new Error('Animation import provenance failed its identity or content integrity check.');
      }
      asset.importProvenance = provenance;
    }
    if (asset.revisionProvenance !== undefined) {
      const provenance = revisionProvenanceSchema.parse(asset.revisionProvenance);
      if (asset.recipe.kind !== 'animation' || fingerprint(asset.recipe) !== provenance.candidateRecipeFingerprint
        || provenance.candidateFingerprint !== patchIdentity(provenance) || provenance.provenanceFingerprint !== provenanceIdentity(provenance)) {
        throw new Error('Animation revision provenance failed its content integrity check.');
      }
      if (provenance.sourceRecipe.kind !== 'animation' || fingerprint(provenance.sourceRecipe) !== provenance.sourceFingerprint) {
        throw new Error('Animation revision provenance source recipe failed its content integrity check.');
      }
      const replay = patchAnimation(provenance.sourceRecipe, provenance.operations,
        patchLayerIdFactory('unsaved-candidate', provenance.sourceFingerprint, provenance.operations, provenance.preserve));
      if (fingerprint(replay.recipe) !== provenance.candidateRecipeFingerprint) {
        throw new Error('Animation revision patch operations do not reproduce its saved recipe.');
      }
      asset.revisionProvenance = provenance;
    }
    return asset;
  }
  async list(offset = 0, limit = 30, kind?: Recipe['kind']) {
    await mkdir(this.directory, { recursive: true });
    const ids = (await readdir(this.directory)).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).sort();
    const all: { id: string; createdAt: string; parentId?: string; sourceRigId?: string; sourceRigName?: string; sourceRigType?: RetargetProfile['rigType']; name: string; kind: Recipe['kind'] }[] = [];
    // Keep only metadata between batches, instead of retaining every full animation in memory.
    for (let start = 0; start < ids.length; start += 16) {
      const batch = await Promise.all(ids.slice(start, start + 16).map(n => this.get(n.slice(0, -5))));
      for (const { recipe, sourceRigProfile, authoringIntent: _authoringIntent, revisionProvenance: _revisionProvenance, ...meta } of batch) if (!kind || recipe.kind === kind) all.push({
        ...meta, ...(sourceRigProfile ? { sourceRigId: sourceRigProfile.rigId, sourceRigName: sourceRigProfile.rigName, sourceRigType: sourceRigProfile.rigType } : {}),
        name: recipe.name, kind: recipe.kind,
      });
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { total: all.length, offset, assets: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null };
  }
}
