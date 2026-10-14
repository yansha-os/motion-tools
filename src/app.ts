import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { identifier, label, recipeSchema } from './recipes.js';
import { Library } from './library.js';
import type { Queue } from './bridge.js';
import { Authoring, draftSchema } from './authoring.js';
import { Connections, providerId } from './providers.js';
import { Reviews } from './reviews.js';
import { fingerprint } from './inspection.js';
import { areCanonicalMappedTargets, mappedAnimationTargets } from './export-targets.js';

export async function appToken(root: string) {
  const path = join(root, '.local', 'app-token');
  await mkdir(join(root, '.local'), { recursive: true });
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return z.string().regex(/^[a-f0-9]{64}$/).parse((await readFile(path, 'utf8')).trim());
}
export const listSchema = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(100), kind: z.enum(['animation', 'vfx']).optional() }).strict();
export const readSchema = z.object({ id: identifier }).strict();
const actionSchema = z.object({ sessionId: identifier, rigId: identifier, assetId: identifier, part: label.default('RightHand'), seconds: z.number().min(0.1).max(30).default(10) }).strict();
const saveRequestSchema = z.object({ sessionId: identifier, rigId: identifier, assetId: identifier, part: label.default('RightHand'), seconds: z.number().min(0.1).max(30).default(10),
  preflightJobId: identifier.optional(), userApprovedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const exportPreflightResultSchema = z.object({ valid: z.literal(true), assetId: identifier, assetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rigId: identifier, rigSignature: z.string().min(1).max(30000), frameCount: z.number().int().min(1).max(2048), poseCount: z.number().int().nonnegative(),
  markerCount: z.number().int().nonnegative(), animatedTrackCount: z.number().int().min(1).max(1024), mappedTargetJoints: z.array(label).max(1024),
  format: z.literal('KeyframeSequence'), saved: z.literal(false), note: z.string().min(1).max(1000) }).strict()
  .refine(evidence => evidence.animatedTrackCount === evidence.mappedTargetJoints.length && areCanonicalMappedTargets(evidence.mappedTargetJoints),
  'Mapped target joints must be sorted, unique, and match the target count.');

export class MotionApp {
  readonly authoring: Authoring;
  readonly reviews: Reviews;
  constructor(readonly token: string, readonly library: Library, readonly queue: Queue, readonly connections: Connections, root: string, authoring?: Authoring, reviews?: Reviews) {
    this.reviews = reviews ?? new Reviews(join(root, 'artifacts', 'reviews'), library, queue, connections);
    this.authoring = authoring ?? new Authoring(library, queue, connections, root, undefined, this.reviews);
  }
  async handle(path: string, input: unknown): Promise<unknown> {
    switch (path) {
      case '/app-api/state': return { providers: await this.connections.list(), sessions: this.queue.listSessions().filter(s => s.online) };
      case '/app-api/connect': return this.connections.save(input);
      case '/app-api/disconnect': return this.connections.remove(z.object({ provider: providerId }).strict().parse(input).provider);
      case '/app-api/library': { const { offset, limit, kind } = listSchema.parse(input); return this.library.list(offset, limit, kind); }
      case '/app-api/asset': return this.library.get(readSchema.parse(input).id);
      case '/app-api/generate': return this.authoring.start(input);
      case '/app-api/draft': return this.authoring.get(readSchema.parse(input).id);
      case '/app-api/cancel': return this.authoring.cancel(readSchema.parse(input).id);
      case '/app-api/inspect': return this.reviews.start(input);
      case '/app-api/review': { const record = await this.reviews.read(readSchema.parse(input).id); return { ...record, questions: this.reviews.questions(record) }; }
      case '/app-api/review-latest': { const record = await this.reviews.latest(readSchema.parse(input).id); return record ? { ...record, questions: this.reviews.questions(record) } : null; }
      case '/app-api/review-feedback': return this.reviews.feedback(input);
      case '/app-api/review-critique': return this.reviews.critique(input);
      case '/app-api/review-cancel': return this.reviews.cancel(readSchema.parse(input).id);
      case '/app-api/review-image': return this.reviews.attach(input);
      case '/app-api/review-image-read': { const data = z.object({ reviewId: identifier, imageId: identifier }).strict().parse(input); return this.reviews.imageData(data.reviewId, data.imageId); }
      case '/app-api/review-revise': {
        const data = z.object({ reviewId: identifier, revision: z.number().int().min(1), provider: providerId, sessionId: identifier.optional(), rigId: identifier.optional(), maxTokens: z.number().int().min(1024).max(32000).default(12000), repair: z.boolean().default(false), aiReview: z.boolean().default(false) }).strict().parse(input);
        const context = await this.reviews.reserveRevision(data.reviewId, data.revision);
        try {
          const asset = await this.library.get(context.assetId), review = await this.reviews.read(context.reviewId);
          return this.authoring.start({ provider: data.provider, parentId: asset.id, kind: asset.recipe.kind, prompt: context.changes, sessionId: data.sessionId, rigId: data.rigId, maxTokens: data.maxTokens, repair: data.repair, aiReview: data.aiReview, inspectAfter: true, motionMode: review.request.motionMode }, context);
        } catch (error) { await this.reviews.finishRevision(context, undefined, 'Generation could not start. Your feedback was preserved.'); throw error; }
      }
      case '/app-api/job': return this.queue.get(readSchema.parse(input).id);
      case '/app-api/stop': return this.queue.enqueue(z.object({ sessionId: identifier }).strict().parse(input).sessionId, 'stop_preview', {});
      case '/app-api/save-preflight': {
        const data = actionSchema.parse(input);
        const asset = await this.library.get(data.assetId);
        if (asset.recipe.kind !== 'animation') throw new Error('Only animation assets use KeyframeSequence export preflight.');
        const session = this.queue.listSessions().find(candidate => candidate.id === data.sessionId && candidate.online);
        const activeRig = z.object({ id: identifier, rigSignature: z.string().min(1).max(30000) }).passthrough().safeParse(session?.snapshot.activeRig);
        if (!activeRig.success || activeRig.data.id !== data.rigId) throw new Error('Select the target rig in the Motion Tools plugin and reconnect before preflighting this animation.');
        const assetFingerprint = fingerprint(asset.recipe);
        return this.queue.enqueue(data.sessionId, 'validate_animation_export', { rigId: data.rigId, rigSignature: activeRig.data.rigSignature,
          assetId: data.assetId, assetFingerprint, recipe: asset.recipe, jointMap: {} });
      }
      case '/app-api/preview':
      case '/app-api/save': {
        const data = saveRequestSchema.parse(input);
        if (path === '/app-api/preview' && (data.preflightJobId || data.userApprovedFingerprint)) throw new Error('Export approval fields are only valid for native animation saves.');
        const asset = await this.library.get(data.assetId), recipe = asset.recipe;
        if (path === '/app-api/preview') return this.queue.enqueue(data.sessionId, 'preview', {
          rigId: data.rigId, seconds: data.seconds, jointMap: {},
          ...(recipe.kind === 'animation' ? { animation: recipe, effects: [] } : { effects: [{ recipe, part: data.part, time: 0 }] }),
        });
        if (recipe.kind === 'animation') {
          if (!data.preflightJobId || !data.userApprovedFingerprint) throw new Error('A successful Studio export preflight and explicit approval of the exact animation fingerprint are required before saving.');
          const session = this.queue.listSessions().find(candidate => candidate.id === data.sessionId && candidate.online);
          const activeRig = z.object({ id: identifier, rigSignature: z.string().min(1).max(30000) }).passthrough().safeParse(session?.snapshot.activeRig);
          if (!activeRig.success || activeRig.data.id !== data.rigId) throw new Error('Select the target rig in the Motion Tools plugin and reconnect before saving this animation.');
          const assetFingerprint = fingerprint(recipe);
          if (data.userApprovedFingerprint !== assetFingerprint) throw new Error('Approval fingerprint does not match the current animation revision. Review and approve the exact current fingerprint before saving.');
          const preflightJob = this.queue.get(data.preflightJobId);
          if (preflightJob.status !== 'succeeded' || preflightJob.operation !== 'validate_animation_export' || preflightJob.sessionId !== data.sessionId
            || Date.now() - preflightJob.createdAt > 600000) throw new Error('A recent successful Studio export preflight for this exact animation is required. Preflight again before saving.');
          const preflightInput = z.object({ rigId: identifier, rigSignature: z.string().min(1).max(30000), assetId: identifier,
            assetFingerprint: z.string().regex(/^[a-f0-9]{64}$/), recipe: recipeSchema, jointMap: z.record(z.string(), z.string()) }).strict().parse(preflightJob.payload);
          const preflightResult = exportPreflightResultSchema.parse(preflightJob.result);
          if (fingerprint(preflightInput.recipe) !== assetFingerprint || preflightInput.rigId !== data.rigId || preflightInput.rigSignature !== activeRig.data.rigSignature
            || preflightInput.assetId !== data.assetId || preflightInput.assetFingerprint !== assetFingerprint || preflightResult.assetId !== data.assetId
            || preflightResult.assetFingerprint !== assetFingerprint || preflightResult.rigId !== data.rigId || preflightResult.rigSignature !== activeRig.data.rigSignature
            || Object.keys(preflightInput.jointMap).length !== 0 || JSON.stringify(preflightResult.mappedTargetJoints) !== JSON.stringify(mappedAnimationTargets(recipe, {})))
            throw new Error('Export preflight no longer matches this exact asset revision, rig topology, mapped targets, or joint map. Preflight the intended save again.');
          const jointMapFingerprint = createHash('sha256').update(JSON.stringify([])).digest('hex');
          const preflightFingerprint = createHash('sha256').update(JSON.stringify({ version: 1, rigId: data.rigId, rigSignature: activeRig.data.rigSignature,
            assetId: data.assetId, assetFingerprint, jointMapFingerprint, frameCount: preflightResult.frameCount, poseCount: preflightResult.poseCount,
            markerCount: preflightResult.markerCount, animatedTrackCount: preflightResult.animatedTrackCount })).digest('hex');
          return this.queue.enqueue(data.sessionId, 'save_animation', { rigId: data.rigId, assetId: data.assetId, recipe, jointMap: {},
            assetFingerprint, rigSignature: activeRig.data.rigSignature, preflightFingerprint });
        }
        if (data.preflightJobId || data.userApprovedFingerprint) throw new Error('Export approval fields are only valid for native animation saves.');
        return this.queue.enqueue(data.sessionId, 'save_vfx', { rigId: data.rigId, assetId: data.assetId, recipe, jointMap: {}, part: data.part });
      }
      default: throw new Error('Unknown local app endpoint.');
    }
  }
  async handleStudio(path: string, input: unknown): Promise<unknown> {
    switch (path) {
      case '/studio-api/state': return { providers: await this.connections.list() };
      case '/studio-api/generate': {
        const data = draftSchema.parse(input);
        if (data.kind !== 'animation') throw new Error('The Studio editor currently creates animations only.');
        return this.authoring.start(data);
      }
      case '/studio-api/draft': return this.authoring.get(readSchema.parse(input).id);
      case '/studio-api/cancel': return this.authoring.cancel(readSchema.parse(input).id);
      default: throw new Error('Unknown Studio authoring endpoint.');
    }
  }
}
