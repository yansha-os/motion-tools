import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { identifier, label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { easeProgress } from './easing.js';
import type { PoseEasingDirection, PoseEasingStyle } from './easing.js';
import { analyzePoseSequenceTransitions } from './pose-sequence-motion.js';
import { createComposedJointSampler } from './animation-patch.js';
import { eulerXYZDegreesToQuaternion, quaternionToEulerXYZDegrees, type Quaternion } from './rotation.js';
import { formatAnimationTime } from './time-format.js';

const vector = (limit: number) => z.tuple([
  z.number().finite().min(-limit).max(limit),
  z.number().finite().min(-limit).max(limit),
  z.number().finite().min(-limit).max(limit),
]);
export const poseInputSchema = z.object({
  name: label,
  description: z.string().max(500).default(''),
  tags: z.array(label).max(20).default([]),
  rigType: z.enum(['R6', 'R15', 'custom']).default('custom'),
  assetType: z.enum(['pose', 'snapshot']).default('pose'),
  rigSignature: z.string().min(1).max(30000).optional(),
  transforms: z.array(z.object({ joint: label, position: vector(100).default([0, 0, 0]), rotation: vector(720) }).strict()).min(1).max(256),
}).strict();
export const poseSchema = poseInputSchema.superRefine((pose, ctx) => {
  if (new Set(pose.transforms.map(transform => transform.joint)).size !== pose.transforms.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A pose can contain only one transform per joint.' });
  }
  if (new Set(pose.tags.map(tag => tag.toLowerCase())).size !== pose.tags.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pose tags must be unique.' });
  }
});
export const snapshotInputSchema = poseInputSchema.extend({ rigSignature: z.string().min(1).max(30000) }).strict();
export type Pose = z.infer<typeof poseSchema>;
export interface PoseAsset { id: string; createdAt: string; pose: Pose }

function getTargetTracks(recipe: AnimationRecipe, layerId?: string) {
  if (!layerId) return recipe.tracks;
  const layer = recipe.layers?.find(candidate => candidate.id === layerId);
  if (!layer) throw new Error(`Animation layer ${layerId} does not exist.`);
  return layer.tracks;
}

export const poseListSchema = z.object({ query: z.string().max(120).default(''), tag: label.optional(), rigType: z.enum(['R6', 'R15', 'custom']).optional(), assetType: z.enum(['pose', 'snapshot']).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const poseSequencePlacementSchema = z.object({ poseId: identifier, time: z.number().finite().min(0).max(30), weight: z.number().finite().gt(0).max(1).default(1),
  layerId: identifier.optional().describe('Optional animation layer to author into; omitted targets base tracks. Preview diagnostics include bounded exact-beat composed-pose comparisons against restoring this destination channel to its original sample.') }).strict();
const markerBeatAssociationWindowSeconds = 0.25;
export const poseSequenceSchema = z.array(poseSequencePlacementSchema).min(1).max(32).superRefine((placements, ctx) => {
  const seen = new Set<string>();
  for (const [index, placement] of placements.entries()) {
    if (index > 0 && placement.time < placements[index - 1]!.time) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'time'], message: 'Pose placements must be in chronological order; same-time placements blend in listed order.' });
    const key = `${placement.poseId}:${placement.time}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'The same pose cannot be placed twice at the same time.' });
    seen.add(key);
  }
});
export type PoseSequencePlacement = z.infer<typeof poseSequencePlacementSchema>;
export const poseTransitionOptionsShape = {
  startTime: z.number().finite().min(0).max(30), endTime: z.number().finite().min(0).max(30),
  steps: z.number().int().min(2).max(32).default(8),
  easingStyle: z.enum(['Linear', 'CubicV2', 'Bounce', 'Elastic', 'Bezier']).default('CubicV2'),
  easingDirection: z.enum(['In', 'Out', 'InOut']).default('InOut'),
  adaptiveRefinement: z.boolean().default(false).describe('When true, bisect the most curved eased segments until their sampled chord error meets the supplied tolerances or bounded depth/key capacity is reached.'),
  positionToleranceStuds: z.number().finite().min(0.0001).max(5).default(0.01),
  rotationToleranceDegrees: z.number().finite().min(0.01).max(45).default(1),
  maxAdaptiveDepth: z.number().int().min(0).max(6).default(3),
  replaceExistingKeys: z.boolean().default(false),
};
export const poseTransitionOptionsSchema = z.object(poseTransitionOptionsShape).strict().superRefine((options, ctx) => {
  if (options.startTime >= options.endTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'Pose transition endTime must be after startTime.' });
  if ((options.endTime - options.startTime) / options.steps <= 0.0001) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Each sampled transition interval must exceed 0.0001 seconds to avoid key-time collisions.' });
});
export type PoseTransitionOptions = z.infer<typeof poseTransitionOptionsSchema>;

function assertPoseRigTypeCompatible(poseRigType: Pose['rigType'], animationRigType: Pose['rigType'] | undefined) {
  if (!animationRigType) return;
  if (poseRigType !== animationRigType && poseRigType !== 'custom' && animationRigType !== 'custom') {
    throw new Error(`Pose rig type ${poseRigType} is incompatible with animation rig type ${animationRigType}.`);
  }
}

function slerpPose(from: Quaternion, to: Quaternion, alpha: number): Quaternion {
  let target = to;
  let dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) { target = to.map(value => -value) as Quaternion; dot = -dot; }
  if (dot > 0.9995) {
    const blended = from.map((value, index) => value + (target[index]! - value) * alpha) as Quaternion;
    const length = Math.hypot(...blended);
    return blended.map(value => value / length) as Quaternion;
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))), sine = Math.sin(angle);
  const blended = from.map((value, index) => value * Math.sin((1 - alpha) * angle) / sine + target[index]! * Math.sin(alpha * angle) / sine) as Quaternion;
  const length = Math.hypot(...blended);
  return blended.map(value => value / length) as Quaternion;
}

function blendRotation(from: [number, number, number], to: [number, number, number], alpha: number): [number, number, number] {
  return quaternionToEulerXYZDegrees(slerpPose(eulerXYZDegreesToQuaternion(from), eulerXYZDegreesToQuaternion(to), alpha));
}

function poseAngularDistanceDegrees(from: [number, number, number], to: [number, number, number]) {
  const left = eulerXYZDegreesToQuaternion(from), right = eulerXYZDegreesToQuaternion(to);
  const dot = Math.min(1, Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

/** Build a bounded pose-to-pose transition on an isolated recipe clone. */
export function transitionPosesInAnimation(source: AnimationRecipe, fromPoseInput: Pose, toPoseInput: Pose, rawOptions: PoseTransitionOptions, animationRigType?: Pose['rigType']) {
  const recipe = recipeSchema.parse(structuredClone(source));
  if (recipe.kind !== 'animation') throw new Error('Pose transitions require an animation recipe.');
  const from = poseSchema.parse(fromPoseInput), to = poseSchema.parse(toPoseInput);
  const options = poseTransitionOptionsSchema.parse(rawOptions);
  if (options.endTime > recipe.duration) throw new Error(`Pose transition ends at ${options.endTime}s, beyond the ${recipe.duration}s animation.`);
  assertPoseRigTypeCompatible(from.rigType, animationRigType);
  assertPoseRigTypeCompatible(to.rigType, animationRigType);
  if (from.rigType !== to.rigType && from.rigType !== 'custom' && to.rigType !== 'custom') throw new Error('Transition poses must target the same rig type.');
  const fromSnapshot = from.assetType === 'snapshot', toSnapshot = to.assetType === 'snapshot';
  if (fromSnapshot !== toSnapshot) throw new Error('Use two snapshots together or two named poses; a single snapshot cannot be mixed with a partial pose.');
  if (fromSnapshot && from.rigSignature !== to.rigSignature) throw new Error('Snapshot topology signatures differ; do not interpolate poses from different rig topologies.');
  const fromByJoint = new Map(from.transforms.map(transform => [transform.joint, transform]));
  const toByJoint = new Map(to.transforms.map(transform => [transform.joint, transform]));
  const sharedJoints = [...fromByJoint.keys()].filter(joint => toByJoint.has(joint));
  if (!sharedJoints.length) throw new Error('The start and end poses have no exactly matching joint names.');
  const oneSidedJoints = [...fromByJoint.keys()].filter(joint => !toByJoint.has(joint)).concat([...toByJoint.keys()].filter(joint => !fromByJoint.has(joint)));
  const inserted: Array<{ joint: string; time: number; rotation: [number, number, number]; position: [number, number, number] }> = [];
  const skippedJoints: string[] = [];
  const newTracks: string[] = [];
  let overwrittenKeyCount = 0;
  const adaptiveDiagnostics: Array<{ joint: string; adaptiveKeyCount: number; maximumPositionChordErrorStuds: number;
    maximumRotationChordErrorDegrees: number; intervalMeasurementCount: number; curveSampleCount: number;
    toleranceMet: boolean | null; depthLimitHit: boolean; keyBudgetLimited: boolean }> = [];
  const allTrackCount = recipe.tracks.length + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.length, 0) + (recipe.rootMotion ? 1 : 0);
  const allKeyCount = recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0)
    + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.reduce((layerSum, track) => layerSum + track.keys.length, 0), 0)
    + (recipe.rootMotion?.keys.length ?? 0);
  const maximumNewTracks = Math.min(256 - recipe.tracks.length, 1024 - allTrackCount, Math.floor((4096 - allKeyCount) / (options.steps + 3)));
  for (const joint of sharedJoints) {
    const startPose = fromByJoint.get(joint)!, endPose = toByJoint.get(joint)!;
    let track = recipe.tracks.find(candidate => candidate.joint === joint);
    if (!track && fromSnapshot) {
      if (newTracks.length >= maximumNewTracks) throw new Error('Pose transition would exceed the 256-track or 4096-key animation limit.');
      track = { joint, keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: recipe.duration, position: [0, 0, 0], rotation: [0, 0, 0] }] };
      recipe.tracks.push(track);
      newTracks.push(joint);
    }
    if (!track) { skippedJoints.push(joint); continue; }
    const existingInInterval = track.keys.filter(key => key.time >= options.startTime - 0.0001 && key.time <= options.endTime + 0.0001);
    if (existingInInterval.length && !options.replaceExistingKeys) throw new Error(`${joint} already has ${existingInInterval.length} authored key(s) in the transition interval at ${existingInInterval.map(key => `${formatAnimationTime(key.time)}s`).join(', ')}. Set replaceExistingKeys=true only after reviewing the preview.`);
    const countRecipeKeys = () => recipe.tracks.reduce((sum, item) => sum + item.keys.length, 0)
      + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.reduce((layerSum, item) => layerSum + item.keys.length, 0), 0)
      + (recipe.rootMotion?.keys.length ?? 0);
    const availableKeys = Math.min(128 - (track.keys.length - existingInInterval.length),
      4096 - (countRecipeKeys() - existingInInterval.length));
    if (availableKeys < options.steps + 1) throw new Error(`${joint} cannot fit the ${options.steps + 1} required transition keys within the 128-key track or 4096-key recipe limit.`);
    overwrittenKeyCount += existingInInterval.length;
    track.keys = track.keys.filter(key => key.time < options.startTime - 0.0001 || key.time > options.endTime + 0.0001);
    const fromRotation = eulerXYZDegreesToQuaternion(startPose.rotation), toRotation = eulerXYZDegreesToQuaternion(endPose.rotation);
    const curvePoseAt = (time: number) => {
      const normalized = (time - options.startTime) / (options.endTime - options.startTime);
      const eased = easeProgress(options.easingStyle as PoseEasingStyle, options.easingDirection as PoseEasingDirection, normalized);
      return { position: startPose.position.map((value, axis) => value + (endPose.position[axis]! - value) * eased) as [number, number, number],
        rotation: slerpPose(fromRotation, toRotation, eased) };
    };
    type Interval = { start: number; end: number; depth: number };
    type MeasuredInterval = Interval & { positionError: number; rotationError: number; score: number };
    const initialIntervals: Interval[] = Array.from({ length: options.steps }, (_, index) => ({
      start: options.startTime + (options.endTime - options.startTime) * index / options.steps,
      end: options.startTime + (options.endTime - options.startTime) * (index + 1) / options.steps,
      depth: 0,
    }));
    let intervalMeasurementCount = 0, curveSampleCount = 0;
    const measureError = (interval: Interval): MeasuredInterval => {
      intervalMeasurementCount += 1;
      const fromCurve = curvePoseAt(interval.start), toCurve = curvePoseAt(interval.end);
      let positionError = 0, rotationError = 0;
      // Roblox Bounce and Elastic easing have interior extrema. A denser fixed
      // probe set reduces the chance that those extrema alias between samples;
      // it remains sampled evidence, not a continuous-time proof.
      for (let probe = 1; probe < 32; probe++) {
        const progress = probe / 32;
        curveSampleCount += 1;
        const actual = curvePoseAt(interval.start + (interval.end - interval.start) * progress);
        const chordPosition = fromCurve.position.map((value, axis) => value + (toCurve.position[axis]! - value) * progress) as [number, number, number];
        positionError = Math.max(positionError, Math.hypot(...actual.position.map((value, axis) => value - chordPosition[axis]!)));
        const chordRotation = slerpPose(fromCurve.rotation, toCurve.rotation, progress);
        const rotation = quaternionToEulerXYZDegrees(actual.rotation), chord = quaternionToEulerXYZDegrees(chordRotation);
        rotationError = Math.max(rotationError, poseAngularDistanceDegrees(rotation, chord));
      }
      return { ...interval, positionError, rotationError, score: Math.max(positionError / options.positionToleranceStuds,
        rotationError / options.rotationToleranceDegrees) };
    };
    const intervalMap = new Map<number, Interval>(initialIntervals.map(interval => [interval.start, interval]));
    const heap: MeasuredInterval[] = [];
    const higherPriority = (left: MeasuredInterval, right: MeasuredInterval) => left.score > right.score
      || left.score === right.score && left.start < right.start;
    const heapPush = (candidate: MeasuredInterval) => {
      let index = heap.length;
      heap.push(candidate);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (higherPriority(heap[parent]!, candidate)) break;
        heap[index] = heap[parent]!;
        index = parent;
      }
      heap[index] = candidate;
    };
    const heapPop = (): MeasuredInterval | undefined => {
      const first = heap[0];
      const last = heap.pop();
      if (!first || !last || heap.length === 0) return first;
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && higherPriority(heap[right]!, heap[left]!) ? right : left;
        if (higherPriority(last, heap[child]!)) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
      return first;
    };
    const enqueueIfNeedsRefinement = (interval: Interval) => {
      const measured = measureError(interval);
      if (measured.score > 1 && interval.depth < options.maxAdaptiveDepth) heapPush(measured);
    };
    let keyBudgetLimited = false;
    if (options.adaptiveRefinement) {
      for (const interval of initialIntervals) enqueueIfNeedsRefinement(interval);
      while (intervalMap.size + 1 < availableKeys && heap.length) {
        const selected = heapPop()!;
        const current = intervalMap.get(selected.start);
        if (!current || current.end !== selected.end || current.depth !== selected.depth) continue;
        intervalMap.delete(current.start);
        const midpoint = (current.start + current.end) / 2;
        const children: Interval[] = [
          { start: current.start, end: midpoint, depth: current.depth + 1 },
          { start: midpoint, end: current.end, depth: current.depth + 1 },
        ];
        for (const child of children) {
          intervalMap.set(child.start, child);
          enqueueIfNeedsRefinement(child);
        }
      }
    }
    const intervals = [...intervalMap.values()].sort((left, right) => left.start - right.start);
    const transitionTimes = [...intervals.map(interval => interval.start), intervals.at(-1)!.end];
    const finalErrors = intervals.map(measureError);
    keyBudgetLimited = options.adaptiveRefinement && intervalMap.size + 1 >= availableKeys
      && finalErrors.some((error, index) => intervals[index]!.depth < options.maxAdaptiveDepth && error.score > 1);
    adaptiveDiagnostics.push({ joint, adaptiveKeyCount: transitionTimes.length,
      maximumPositionChordErrorStuds: Math.max(0, ...finalErrors.map(error => error.positionError)),
      maximumRotationChordErrorDegrees: Math.max(0, ...finalErrors.map(error => error.rotationError)),
      intervalMeasurementCount, curveSampleCount,
      toleranceMet: options.adaptiveRefinement ? finalErrors.every(error => error.score <= 1) : null,
      depthLimitHit: finalErrors.some((error, index) => error.score > 1 && intervals[index]!.depth >= options.maxAdaptiveDepth), keyBudgetLimited });
    if (track.keys.length + transitionTimes.length > 128) throw new Error(`${joint} would exceed the 128-key track limit.`);
    for (const time of transitionTimes) {
      const { position, rotation: rotationQuaternion } = curvePoseAt(time);
      const rotation = quaternionToEulerXYZDegrees(rotationQuaternion);
      const key = { time, position, rotation, easingStyle: 'Linear' as const, easingDirection: 'Out' as const };
      track.keys.push(key);
      inserted.push({ joint, time, position, rotation });
    }
    track.keys.sort((left, right) => left.time - right.time);
    if (recipe.loop && options.startTime === 0) {
      const start = track.keys.find(key => key.time === 0)!;
      const end = track.keys.find(key => key.time === recipe.duration)!;
      end.position = [...start.position]; end.rotation = [...start.rotation];
    } else if (recipe.loop && options.endTime === recipe.duration) {
      const start = track.keys.find(key => key.time === 0)!;
      const end = track.keys.find(key => key.time === recipe.duration)!;
      start.position = [...end.position]; start.rotation = [...end.rotation];
    }
  }
  if (!inserted.length) throw new Error('No pose joints matched existing animation tracks. Add compatible tracks or use matching full-body snapshots.');
  const validated = recipeSchema.parse(recipe);
  if (validated.kind !== 'animation') throw new Error('Pose transition unexpectedly produced a non-animation recipe.');
  return {
    recipe: validated,
    diagnostics: {
      startPose: from.name, endPose: to.name, startTime: options.startTime, endTime: options.endTime, steps: options.steps,
      easingStyle: options.easingStyle, easingDirection: options.easingDirection,
      matchedJoints: [...new Set(inserted.map(item => item.joint))], skippedJoints, oneSidedJoints, addedTracks: newTracks,
      generatedKeys: inserted.length, overwrittenKeyCount,
      adaptiveRefinement: { enabled: options.adaptiveRefinement, positionToleranceStuds: options.positionToleranceStuds,
        rotationToleranceDegrees: options.rotationToleranceDegrees, maxAdaptiveDepth: options.maxAdaptiveDepth, joints: adaptiveDiagnostics,
        intervalMeasurementCount: adaptiveDiagnostics.reduce((sum, joint) => sum + joint.intervalMeasurementCount, 0),
        curveSampleCount: adaptiveDiagnostics.reduce((sum, joint) => sum + joint.curveSampleCount, 0),
        limitation: 'Chord errors use deterministic local-curve probes at 1/32 increments inside each interval. Dense probes reduce missed easing extrema but remain sampled evidence, not a continuous-time error proof or an artistic-quality score. Reaching a work bound may leave a tolerance unmet; inspect toleranceMet, depthLimitHit and keyBudgetLimited.' },
      interpolation: 'linear local position plus shortest-path quaternion SLERP; easing is sampled into bounded keys',
      notes: ['Pose data uses local recipe transforms; exact joint names do not prove matching anatomical axes.', 'A transition preview is not a rendered or world-space contact check. Preview the complete child on the intended rig.'],
    },
  };
}

export class PoseLibrary {
  constructor(readonly directory: string) {}

  async save(input: unknown): Promise<PoseAsset> {
    const pose = poseSchema.parse(input);
    await mkdir(this.directory, { recursive: true });
    const asset: PoseAsset = { id: randomUUID(), createdAt: new Date().toISOString(), pose };
    await writeFile(join(this.directory, `${asset.id}.json`), JSON.stringify(asset, null, 2), { flag: 'wx' });
    return asset;
  }

  async get(id: string): Promise<PoseAsset> {
    identifier.parse(id);
    const asset = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as PoseAsset;
    if (asset.id !== id) throw new Error('Pose identity mismatch.');
    asset.pose = poseSchema.parse(asset.pose);
    return asset;
  }

  async list(input: z.input<typeof poseListSchema> = {}) {
    const options = poseListSchema.parse(input);
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const query = options.query.trim().toLowerCase();
    const matched: Array<Omit<PoseAsset, 'pose'> & { name: string; description: string; tags: string[]; rigType: Pose['rigType']; assetType: Pose['assetType']; jointCount: number; joints: string[] }> = [];
    for (let start = 0; start < names.length; start += 16) {
      const assets = await Promise.all(names.slice(start, start + 16).map(name => this.get(name.slice(0, -5))));
      for (const { pose, ...meta } of assets) {
        if (options.rigType && pose.rigType !== options.rigType && pose.rigType !== 'custom') continue;
        if (options.assetType && pose.assetType !== options.assetType) continue;
        if (options.tag && !pose.tags.some(tag => tag.toLowerCase() === options.tag!.toLowerCase())) continue;
        const searchable = `${pose.name} ${pose.description} ${pose.tags.join(' ')} ${pose.transforms.map(transform => transform.joint).join(' ')}`.toLowerCase();
        if (query && !searchable.includes(query)) continue;
        matched.push({ ...meta, name: pose.name, description: pose.description, tags: pose.tags, rigType: pose.rigType, assetType: pose.assetType, jointCount: pose.transforms.length, joints: pose.transforms.map(transform => transform.joint) });
      }
    }
    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { total: matched.length, offset: options.offset, poses: matched.slice(options.offset, options.offset + options.limit), nextOffset: options.offset + options.limit < matched.length ? options.offset + options.limit : null };
  }
}

export function applyPoseToAnimation(source: AnimationRecipe, pose: Pose, time: number, weight = 1, animationRigType?: Pose['rigType'], layerId?: string) {
  const validated = recipeSchema.parse(structuredClone(source));
  if (validated.kind !== 'animation') throw new Error('Pose application requires an animation recipe.');
  if (!Number.isFinite(time) || time < 0 || time > validated.duration) throw new Error('Pose application time must be within the animation.');
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error('Pose blend weight must be greater than 0 and at most 1.');
  const poseData = poseSchema.parse(pose);
  assertPoseRigTypeCompatible(poseData.rigType, animationRigType);
  const targetTracks = getTargetTracks(validated, layerId);
  const applied: string[] = [];
  const skipped: string[] = [];
  const createdTracks: string[] = [];
  for (const transform of poseData.transforms) {
    let track = targetTracks.find(candidate => candidate.joint === transform.joint);
    if (!track && poseData.assetType === 'snapshot') {
      if (targetTracks.length >= 256) throw new Error(`The ${layerId ? 'selected layer' : 'base animation'} already has the maximum of 256 joint tracks.`);
      const poseKey = { time, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
      track = { joint: transform.joint, keys: time === 0 || time === validated.duration
        ? [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: validated.duration, position: [0, 0, 0], rotation: [0, 0, 0] }]
        : [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, poseKey, { time: validated.duration, position: [0, 0, 0], rotation: [0, 0, 0] }] };
      targetTracks.push(track);
      createdTracks.push(transform.joint);
    }
    if (!track) { skipped.push(transform.joint); continue; }
    // Recipe keys are allowed at sub-millisecond spacing; fuzzy matching here can silently move a pose to a neighboring beat.
    let key = track.keys.find(candidate => candidate.time === time);
    if (!key) {
      if (time <= 0 || time >= validated.duration) throw new Error(`The ${transform.joint} track needs an endpoint key at ${time}s.`);
      if (track.keys.length >= 128) throw new Error(`${transform.joint} already has the maximum of 128 keys.`);
      let rightIndex = track.keys.findIndex(candidate => candidate.time > time);
      if (rightIndex < 0) rightIndex = track.keys.length - 1;
      const left = track.keys[rightIndex - 1]!;
      const right = track.keys[rightIndex]!;
      const alpha = easeProgress(left.easingStyle, left.easingDirection, (time - left.time) / (right.time - left.time), left.curve);
      key = {
        time,
        position: left.position.map((value, axis) => value + (right.position[axis]! - value) * alpha) as [number, number, number],
        rotation: blendRotation(left.rotation, right.rotation, alpha),
        easingStyle: left.easingStyle,
        easingDirection: left.easingDirection,
        ...(left.curve ? { curve: { ...left.curve } } : {}),
      };
      track.keys.splice(rightIndex, 0, key);
    }
    const blend = (target: typeof key) => {
      target.position = target.position.map((value, axis) => value + (transform.position[axis]! - value) * weight) as [number, number, number];
      target.rotation = blendRotation(target.rotation, transform.rotation, weight);
    };
    blend(key);
    if (validated.loop && (key.time === 0 || key.time === validated.duration)) {
      const matching = key.time === 0 ? track.keys.at(-1)! : track.keys[0]!;
      blend(matching);
    }
    applied.push(transform.joint);
  }
  if (applied.length === 0) throw new Error('The pose has no joints matching existing animation tracks. Add matching joint tracks before applying it.');
  const recipe = recipeSchema.parse(validated);
  if (recipe.kind !== 'animation') throw new Error('Pose application unexpectedly produced a non-animation recipe.');
  return { recipe, applied, skipped, createdTracks };
}

/** Apply a chronological pose sequence atomically, sampling inserted keys from the original clip. */
export function applyPoseSequenceToAnimation(source: AnimationRecipe, rawPlacements: unknown, rawPoses: Pose[], animationRigType?: Pose['rigType']) {
  const placements = poseSequenceSchema.parse(rawPlacements);
  if (placements.length !== rawPoses.length) throw new Error('Every pose placement must resolve to exactly one saved pose asset.');
  const recipe = recipeSchema.parse(structuredClone(source));
  if (recipe.kind !== 'animation') throw new Error('Pose sequences require an animation recipe.');
  const original = structuredClone(recipe);
  const applied = [] as Array<{ poseId: string; poseName: string; time: number; weight: number; layerId: string | null; joints: string[]; skippedJoints: string[] }>;
  const blendSteps = new Map<string, Array<{ position: [number, number, number]; rotation: [number, number, number] }>>();
  for (const [index, placement] of placements.entries()) {
    if (placement.time > recipe.duration) throw new Error(`Pose ${rawPoses[index]!.name} is placed beyond the ${recipe.duration}s clip duration.`);
    const pose = poseSchema.parse(rawPoses[index]);
    assertPoseRigTypeCompatible(pose.rigType, animationRigType);
    const targetTracks = getTargetTracks(recipe, placement.layerId);
    const originalTargetTracks = getTargetTracks(original, placement.layerId);
    const joints: string[] = [], skippedJoints: string[] = [];
    for (const transform of pose.transforms) {
      let track = targetTracks.find(candidate => candidate.joint === transform.joint);
      if (!track && pose.assetType === 'snapshot') {
        if (targetTracks.length >= 256) throw new Error(`The ${placement.layerId ? 'selected layer' : 'base animation'} already has the maximum of 256 joint tracks.`);
        track = { joint: transform.joint, keys: [
          { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
          { time: recipe.duration, position: [0, 0, 0], rotation: [0, 0, 0] },
        ] };
        targetTracks.push(track);
      }
      if (!track) { skippedJoints.push(transform.joint); continue; }
      let key = track.keys.find(candidate => candidate.time === placement.time);
      if (!key) {
        if (placement.time <= 0 || placement.time >= recipe.duration) throw new Error(`The ${transform.joint} track needs an endpoint key at ${placement.time}s.`);
        if (track.keys.length >= 128) throw new Error(`${transform.joint} already has the maximum of 128 keys.`);
        const originalTrack = originalTargetTracks.find(candidate => candidate.joint === transform.joint);
        const sourcePose = originalTrack ? sampleTrack(originalTrack, placement.time) : {
          position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
          easingStyle: undefined, easingDirection: undefined, curve: undefined,
        };
        key = { time: placement.time, position: [...sourcePose.position] as [number, number, number], rotation: [...sourcePose.rotation] as [number, number, number],
          ...(sourcePose.easingStyle ? { easingStyle: sourcePose.easingStyle } : {}),
          ...(sourcePose.easingDirection ? { easingDirection: sourcePose.easingDirection } : {}),
          ...(sourcePose.curve ? { curve: { ...sourcePose.curve } } : {}) };
        track.keys.push(key);
        track.keys.sort((left, right) => left.time - right.time);
      }
      const targetKey = key;
      if (!targetKey) throw new Error(`Could not create a key for ${transform.joint} at ${placement.time}s.`);
      targetKey.position = targetKey.position.map((value, axis) => value + (transform.position[axis]! - value) * placement.weight) as [number, number, number];
      targetKey.rotation = blendRotation(targetKey.rotation, transform.rotation, placement.weight);
      if (recipe.loop && (targetKey.time === 0 || targetKey.time === recipe.duration)) {
        const matching = targetKey.time === 0 ? track.keys.at(-1)! : track.keys[0]!;
        matching.position = [...targetKey.position]; matching.rotation = [...targetKey.rotation];
      }
      const blendKey = `${placement.layerId ?? 'base'}@${transform.joint.toLowerCase()}@${placement.time}`;
      const steps = blendSteps.get(blendKey) ?? [];
      steps.push({ position: [...targetKey.position], rotation: [...targetKey.rotation] });
      blendSteps.set(blendKey, steps);
      joints.push(transform.joint);
    }
    applied.push({ poseId: placement.poseId, poseName: pose.name, time: placement.time, weight: placement.weight, layerId: placement.layerId ?? null, joints, skippedJoints });
  }
  const validated = recipeSchema.parse(recipe);
  if (validated.kind !== 'animation') throw new Error('Pose sequence unexpectedly produced a non-animation recipe.');
  const contributions = new Map<string, { joint: string; time: number; layerId: string | null; contributors: Array<{
    poseId: string; poseName: string; weight: number;
    target: { position: [number, number, number]; rotation: [number, number, number] };
    resultAfter: { position: [number, number, number]; rotation: [number, number, number] };
  }> }>();
  for (const [index, placement] of applied.entries()) for (const joint of placement.joints) {
    const layerId = placement.layerId ?? null;
    const key = `${layerId ?? 'base'}@${joint.toLowerCase()}@${placement.time}`;
    const entry = contributions.get(key) ?? { joint, time: placement.time, layerId, contributors: [] };
    const target = rawPoses[index]!.transforms.find(transform => transform.joint.toLowerCase() === joint.toLowerCase());
    if (!target) throw new Error(`Pose ${placement.poseName} lost its authored transform for ${joint}.`);
    const resultAfter = blendSteps.get(key)?.[entry.contributors.length];
    if (!resultAfter) throw new Error(`Pose sequence lost its intermediate blend result for ${joint} at ${placement.time}s.`);
    entry.contributors.push({ poseId: placement.poseId, poseName: placement.poseName, weight: placements[index]!.weight,
      target: { position: [...target.position], rotation: [...target.rotation] },
      resultAfter: { position: [...resultAfter.position], rotation: [...resultAfter.rotation] } });
    contributions.set(key, entry);
  }
  const conflicts = [...contributions.values()].filter(entry => entry.contributors.length > 1).map(entry => {
    const track = getTargetTracks(validated, entry.layerId ?? undefined).find(candidate => candidate.joint.toLowerCase() === entry.joint.toLowerCase());
    const result = track?.keys.find(key => key.time === entry.time);
    return { ...entry, resolution: 'weighted_blend_in_listed_order' as const,
      result: result ? { position: [...result.position] as [number, number, number], rotation: [...result.rotation] as [number, number, number] } : null };
  });
  const beats = applied.reduce((groups, placement) => {
    const current = groups.at(-1);
    if (current?.time === placement.time) {
      current.poseIds.push(placement.poseId); current.poseNames.push(placement.poseName);
      for (const joint of placement.joints) if (!current.joints.some(existing => existing.toLowerCase() === joint.toLowerCase())) current.joints.push(joint);
      for (const joint of placement.joints) if (!current.channels.some(channel => channel.joint.toLowerCase() === joint.toLowerCase() && channel.layerId === (placement.layerId ?? null))) current.channels.push({ joint, layerId: placement.layerId ?? null });
    } else groups.push({ time: placement.time, poseIds: [placement.poseId], poseNames: [placement.poseName], joints: [...placement.joints],
      channels: placement.joints.map(joint => ({ joint, layerId: placement.layerId ?? null })) });
    return groups;
  }, [] as Array<{ time: number; poseIds: string[]; poseNames: string[]; joints: string[]; channels: Array<{ joint: string; layerId: string | undefined | null }> }>);
  const markerBeatAssociations = validated.markers.flatMap((marker, markerIndex) => {
    const nearestDistance = beats.reduce((distance, beat) => Math.min(distance, Math.abs(beat.time - marker.time)), Number.POSITIVE_INFINITY);
    if (nearestDistance > markerBeatAssociationWindowSeconds + 1e-9) return [];
    const matchingBeats = beats.filter(beat => beat.time === marker.time);
    const nearestBeats = matchingBeats.length ? matchingBeats
      : beats.filter(beat => Math.abs(Math.abs(beat.time - marker.time) - nearestDistance) <= 1e-9);
    return [{ markerIndex, name: marker.name, time: marker.time, phase: marker.phase ?? null,
      association: matchingBeats.length ? 'same_time' as const : 'nearby' as const,
      beats: nearestBeats.map(beat => ({ time: beat.time, offsetSeconds: Number((beat.time - marker.time).toFixed(6)),
        poseIds: beat.poseIds, poseNames: beat.poseNames })),
      tieCount: nearestBeats.length }];
  });
  const beatJointSets = beats.map(beat => new Set(beat.joints.map(joint => joint.toLowerCase())));
  const transitionCoverage = beats.slice(1).map((beat, index) => {
    const previous = beats[index]!;
    const before = beatJointSets[index]!;
    const after = beatJointSets[index + 1]!;
    const all = new Set([...before, ...after]);
    const sharedJoints = beat.joints.filter(joint => before.has(joint.toLowerCase()));
    const leavingJoints = previous.joints.filter(joint => !after.has(joint.toLowerCase()));
    const enteringJoints = beat.joints.filter(joint => !before.has(joint.toLowerCase()));
    const duration = beat.time - previous.time;
    const motionDeltas = sharedJoints.flatMap(joint => previous.channels.filter(channel => channel.joint.toLowerCase() === joint.toLowerCase()).flatMap(fromChannel => {
      const toChannel = beat.channels.find(channel => channel.joint.toLowerCase() === joint.toLowerCase() && channel.layerId === (fromChannel.layerId ?? null));
      if (!toChannel) return [];
      const track = getTargetTracks(validated, fromChannel.layerId ?? undefined).find(candidate => candidate.joint.toLowerCase() === joint.toLowerCase());
      const from = track?.keys.find(key => key.time === previous.time);
      const to = track?.keys.find(key => key.time === beat.time);
      if (!from || !to) return [];
      const positionDeltaStuds = Math.hypot(...from.position.map((value, axis) => to.position[axis]! - value));
      const angularDeltaDegrees = poseAngularDistanceDegrees(from.rotation, to.rotation);
      return [{ joint, layerId: fromChannel.layerId ?? null, positionDeltaStuds, angularDeltaDegrees, averagePositionSpeedStudsPerSecond: positionDeltaStuds / duration,
        averageAngularSpeedDegreesPerSecond: angularDeltaDegrees / duration }];
    }));
    return { fromPoseIds: previous.poseIds, fromPoseNames: previous.poseNames, toPoseIds: beat.poseIds, toPoseNames: beat.poseNames,
      startTime: previous.time, endTime: beat.time, duration,
      sharedJoints, enteringJoints, leavingJoints, unionJointCount: all.size,
      continuityCoverage: all.size ? sharedJoints.length / all.size : 1, motionDeltas };
  });
  const transitionMotion = analyzePoseSequenceTransitions(validated, transitionCoverage.map(interval => ({
    startTime: interval.startTime, endTime: interval.endTime,
    fromPoseNames: interval.fromPoseNames, toPoseNames: interval.toPoseNames,
    enteringJoints: interval.enteringJoints, leavingJoints: interval.leavingJoints, sharedJoints: interval.sharedJoints,
  })));
  const allTracks = (animation: AnimationRecipe) => [
    ...animation.tracks.map(track => ({ track, layerId: null as string | null })),
    ...(animation.layers ?? []).flatMap(layer => layer.tracks.map(track => ({ track, layerId: layer.id }))),
  ];
  const originalTrackKeys = new Map(allTracks(original).map(({ track, layerId }) => [`${layerId ?? 'base'}@${track.joint.toLowerCase()}`, new Set(track.keys.map(key => key.time))]));
  const originalTracks = new Set(allTracks(original).map(({ track, layerId }) => `${layerId ?? 'base'}@${track.joint.toLowerCase()}`));
  const candidateTracks = allTracks(validated);
  const insertedKeyCount = candidateTracks.reduce((count, { track, layerId }) => count + track.keys.filter(key => !originalTrackKeys.get(`${layerId ?? 'base'}@${track.joint.toLowerCase()}`)?.has(key.time)).length, 0);
  const totalJoints = rawPoses.reduce((count, pose) => count + pose.transforms.length, 0);
  const matchedJoints = applied.reduce((count, placement) => count + placement.joints.length, 0);
  const destinationLayers = new Map<string, { layerId: string | null; requestedJoints: Set<string>; appliedJoints: Set<string>; skippedJoints: Set<string> }>();
  for (const [index, placement] of applied.entries()) {
    const key = placement.layerId ?? 'base';
    const destination = destinationLayers.get(key) ?? { layerId: placement.layerId, requestedJoints: new Set<string>(), appliedJoints: new Set<string>(), skippedJoints: new Set<string>() };
    for (const transform of rawPoses[index]!.transforms) destination.requestedJoints.add(transform.joint);
    for (const joint of placement.joints) destination.appliedJoints.add(joint);
    for (const joint of placement.skippedJoints) destination.skippedJoints.add(joint);
    destinationLayers.set(key, destination);
  }
  const destinationLayerEffects = [...destinationLayers.values()].map(destination => {
    const layerIndex = destination.layerId ? validated.layers?.findIndex(layer => layer.id === destination.layerId) ?? -1 : -1;
    const layer = layerIndex >= 0 ? validated.layers?.[layerIndex] : undefined;
    const activeJoints = new Set([...destination.appliedJoints].map(joint => joint.toLowerCase()));
    const laterActiveLayerOverlaps = (validated.layers ?? []).flatMap((candidate, index) => {
      if (index <= layerIndex || !candidate.enabled || candidate.weight <= 0) return [];
      const overlappingJoints = candidate.tracks.filter(track => activeJoints.has(track.joint.toLowerCase())).map(track => track.joint);
      return overlappingJoints.length ? [{ layerId: candidate.id, name: candidate.name, blendMode: candidate.blendMode,
        weight: candidate.weight, overlappingJoints }] : [];
    });
    return {
      layerId: destination.layerId, name: layer?.name ?? 'Base animation', blendMode: layer?.blendMode ?? null,
      enabled: layer?.enabled ?? true, weight: layer?.weight ?? 1,
      status: !layer ? 'base' as const : !layer.enabled ? 'disabled' as const : layer.weight === 0 ? 'zero_weight' as const : 'active_weighted' as const,
      requestedJoints: [...destination.requestedJoints], appliedJoints: [...destination.appliedJoints], skippedJoints: [...destination.skippedJoints],
      laterActiveLayerOverlaps,
    };
  });
  const placementTargets = new Map<string, { layerId: string | null; joint: string; time: number }>();
  for (const placement of applied) for (const joint of placement.joints) {
    const key = `${placement.layerId ?? 'base'}@${joint.toLowerCase()}@${placement.time}`;
    if (!placementTargets.has(key)) placementTargets.set(key, { layerId: placement.layerId, joint, time: placement.time });
  }
  const candidateCompositionSamplers = new Map<string, ReturnType<typeof createComposedJointSampler>>();
  const placementCompositionEffects = [...placementTargets.values()].slice(0, 256).flatMap(target => {
    const candidateTrack = getTargetTracks(validated, target.layerId ?? undefined).find(track => track.joint.toLowerCase() === target.joint.toLowerCase());
    const originalTrack = getTargetTracks(original, target.layerId ?? undefined).find(track => track.joint.toLowerCase() === target.joint.toLowerCase());
    const candidateKey = candidateTrack?.keys.find(key => key.time === target.time);
    if (!candidateTrack || !candidateKey) return [];
    const originalPose = originalTrack
      ? originalTrack.keys.find(key => key.time === target.time) ?? sampleTrack(originalTrack, target.time)
      : { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
    const jointKey = target.joint.toLowerCase();
    if (!candidateCompositionSamplers.has(jointKey)) candidateCompositionSamplers.set(jointKey, createComposedJointSampler(validated, target.joint));
    const candidateSampler = candidateCompositionSamplers.get(jointKey);
    const restoredSampler = createComposedJointSampler(validated, target.joint, {
      layerId: target.layerId, time: target.time,
      position: [...originalPose.position] as [number, number, number], rotation: [...originalPose.rotation] as [number, number, number],
    });
    if (!candidateSampler || !restoredSampler) return [];
    const candidatePose = candidateSampler(target.time), restoredPose = restoredSampler(target.time);
    const positionDeltaStuds = Math.hypot(...candidatePose.position.map((value, axis) => value - restoredPose.position[axis]!));
    const rotationDeltaDegrees = poseAngularDistanceDegrees(quaternionToEulerXYZDegrees(candidatePose.rotation), quaternionToEulerXYZDegrees(restoredPose.rotation));
    return [{ layerId: target.layerId, joint: target.joint, time: target.time,
      destination: target.layerId ? 'animation_layer' as const : 'base_animation' as const,
      comparison: 'candidate_vs_same_recipe_with_this_placed_channel_restored_to_its_original_sample' as const,
      candidateComposedPose: { position: candidatePose.position, rotation: quaternionToEulerXYZDegrees(candidatePose.rotation) },
      restoredComposedPose: { position: restoredPose.position, rotation: quaternionToEulerXYZDegrees(restoredPose.rotation) },
      positionDeltaStuds, rotationDeltaDegrees,
      compositionChanged: positionDeltaStuds > 1e-9 || rotationDeltaDegrees > 1e-7,
    }];
  });
  return {
    recipe: validated, applied,
    diagnostics: {
      requestedPoseCount: placements.length, totalJointContributions: totalJoints, matchedJointContributions: matchedJoints,
      skippedJointContributions: totalJoints - matchedJoints, coverage: totalJoints ? matchedJoints / totalJoints : 0,
      insertedKeyCount, addedTracks: candidateTracks.filter(({ track, layerId }) => !originalTracks.has(`${layerId ?? 'base'}@${track.joint.toLowerCase()}`))
        .map(({ track, layerId }) => layerId ? `${layerId}/${track.joint}` : track.joint),
      destinationLayerEffects, placementCompositionEffects,
      omittedPlacementCompositionEffectCount: Math.max(0, placementTargets.size - placementCompositionEffects.length),
      transitionCoverage, transitionMotion, markerBeatAssociations,
      markerAssociationWindowSeconds: markerBeatAssociationWindowSeconds, markerPolicy: 'unchanged_advisory_associations' as const,
      sameTimeConflicts: conflicts, conflictPolicy: 'weighted_blend_in_listed_order' as const,
      notes: ['Coverage is exact name matching only; it does not prove local-axis or rig suitability.', 'Transition coverage reports pose-beat joint overlap; entering/leaving joints may intentionally remain on the source curve.', 'transitionMotion samples easing-aware composed local motion between beats and reports bounded per-signal peaks; the effective rate may be reduced to remain within its evaluation budget.', 'Average interval endpoint rates are not peak speeds and do not account for easing between authored keys.', 'Same-time contributions apply sequential weighted blends in placement order.'],
    },
  };
}

function sampleTrack(track: AnimationRecipe['tracks'][number], time: number) {
  for (let index = 1; index < track.keys.length; index++) {
    const left = track.keys[index - 1]!;
    const right = track.keys[index]!;
    if (time > right.time) continue;
    const alpha = easeProgress(left.easingStyle, left.easingDirection, (time - left.time) / (right.time - left.time), left.curve);
    return {
      position: left.position.map((value, axis) => value + (right.position[axis]! - value) * alpha) as [number, number, number],
      rotation: blendRotation(left.rotation, right.rotation, alpha),
      easingStyle: left.easingStyle,
      easingDirection: left.easingDirection,
      ...(left.curve ? { curve: { ...left.curve } } : {}),
    };
  }
  throw new Error(`Cannot interpolate a pose on ${track.joint} at ${formatAnimationTime(time)}s.`);
}
