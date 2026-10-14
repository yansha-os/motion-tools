import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { easeProgress } from './easing.js';
import { Library } from './library.js';
import { fingerprint } from './inspection.js';
import { identifier, label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { eulerXYZDegreesToQuaternion, quaternionToEulerXYZDegrees, type Quaternion } from './rotation.js';

export const sequenceClipSchema = z.object({
  animationId: identifier,
  start: z.number().finite().min(0).max(120),
  sourceStart: z.number().finite().min(0).max(30),
  sourceEnd: z.number().finite().min(0).max(30),
  speed: z.number().finite().min(0.1).max(4).default(1),
  fadeIn: z.number().finite().min(0).max(10).default(0),
  fadeOut: z.number().finite().min(0).max(10).default(0),
}).strict();
export const sequenceSchema = z.object({
  kind: z.literal('sequence'),
  name: label,
  sampleRate: z.number().int().min(15).max(60).default(30),
  loop: z.boolean().default(false),
  clips: z.array(sequenceClipSchema).min(1).max(64),
}).strict();
export type SequenceClip = z.infer<typeof sequenceClipSchema>;
export type ClipSequence = z.infer<typeof sequenceSchema>;
const sourceFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const savedSequenceSchema = z.object({ id: identifier, createdAt: z.string().datetime(), parentId: identifier.optional(), sourceFingerprints: z.array(sourceFingerprintSchema).min(1).max(64).optional(), recipe: sequenceSchema }).strict();
export interface SavedSequence { id: string; createdAt: string; parentId?: string; sourceFingerprints?: string[]; recipe: ClipSequence }

export async function validateSequence(input: unknown, animations: Library) {
  const recipe = sequenceSchema.parse(input);
  const animationAssets = await Promise.all(recipe.clips.map(clip => animations.get(clip.animationId)));
  for (const [index, asset] of animationAssets.entries()) {
    if (asset.recipe.kind !== 'animation') throw new Error(`Sequence clip ${index + 1} must reference an animation asset.`);
    const clip = recipe.clips[index]!;
    if (clip.sourceStart >= clip.sourceEnd || clip.sourceEnd > asset.recipe.duration) throw new Error(`Sequence clip ${index + 1} source range must be increasing and within its animation.`);
    const sourceDuration = (clip.sourceEnd - clip.sourceStart) / clip.speed;
    if (clip.fadeIn + clip.fadeOut > sourceDuration) throw new Error(`Sequence clip ${index + 1} fade durations exceed its placed duration.`);
    if (clip.start + sourceDuration > 120) throw new Error('A sequence cannot exceed 120 seconds.');
  }
  const duration = sequenceDuration(recipe);
  if (duration < 0.1) throw new Error('A sequence must be at least 0.1 seconds long.');
  return { recipe, animationAssets, duration, sourceFingerprints: animationAssets.map(asset => fingerprint(asset.recipe)) };
}

export class SequenceLibrary {
  constructor(readonly directory: string, readonly animations: Library) {}

  async save(input: ClipSequence, parentId?: string): Promise<SavedSequence> {
    if (parentId) {
      // A stale parent is still valid lineage: saving its revised arrangement
      // pins the current source contents as an explicit new sequence revision.
      const parent = await this.load(parentId);
      if (parent.recipe.kind !== 'sequence') throw new Error('A sequence revision must retain its asset kind.');
    }
    const { recipe, sourceFingerprints } = await validateSequence(input, this.animations);
    const saved: SavedSequence = { id: randomUUID(), createdAt: new Date().toISOString(), ...(parentId ? { parentId } : {}), sourceFingerprints, recipe };
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${saved.id}.json`), JSON.stringify(saved, null, 2), { flag: 'wx' });
    return saved;
  }

  private async load(id: string): Promise<SavedSequence> {
    identifier.parse(id);
    const saved = savedSequenceSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
    if (saved.id !== id) throw new Error('Sequence identity mismatch.');
    return saved;
  }

  private async sourceIntegrity(saved: SavedSequence): Promise<{ status: 'verified' | 'legacy_unverified' | 'stale'; issue?: string }> {
    if (!saved.sourceFingerprints) return { status: 'legacy_unverified' };
    try {
      const current = await validateSequence(saved.recipe, this.animations);
      for (const [index, expected] of saved.sourceFingerprints.entries()) if (current.sourceFingerprints[index] !== expected) {
        return { status: 'stale', issue: `Source animation for clip ${index + 1} changed since this sequence was saved.` };
      }
      if (saved.sourceFingerprints.length !== saved.recipe.clips.length) return { status: 'stale', issue: 'Stored source fingerprint count does not match the timeline clips.' };
      return { status: 'verified' };
    } catch (error) {
      return { status: 'stale', issue: error instanceof Error ? `A source animation is no longer compatible: ${error.message}` : 'A source animation is no longer compatible.' };
    }
  }

  async get(id: string): Promise<SavedSequence> {
    const saved = await this.load(id);
    const integrity = await this.sourceIntegrity(saved);
    if (integrity.status === 'stale') throw new Error(`Sequence ${id} has stale source assets. ${integrity.issue} Create a new sequence revision from the updated source animations to accept changed content.`);
    return saved;
  }

  async list(offset = 0, limit = 30) {
    await mkdir(this.directory, { recursive: true });
    const ids = (await readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    const all: { id: string; createdAt: string; parentId?: string; name: string; clipCount: number; duration: number; sourceIntegrity: 'verified' | 'legacy_unverified' | 'stale'; sourceIntegrityIssue?: string }[] = [];
    for (let start = 0; start < ids.length; start += 16) {
      const batch = await Promise.all(ids.slice(start, start + 16).map(async file => {
        const item = await this.load(file.slice(0, -5));
        return { item, integrity: await this.sourceIntegrity(item) };
      }));
      for (const { item, integrity } of batch) all.push({
        id: item.id, createdAt: item.createdAt, ...(item.parentId ? { parentId: item.parentId } : {}), name: item.recipe.name,
        clipCount: item.recipe.clips.length, duration: sequenceDuration(item.recipe), sourceIntegrity: integrity.status,
        ...(integrity.issue ? { sourceIntegrityIssue: integrity.issue } : {}),
      });
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { total: all.length, offset, sequences: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null };
  }
}

export function sequenceDuration(sequence: ClipSequence) {
  return Math.max(...sequence.clips.map(clip => clip.start + (clip.sourceEnd - clip.sourceStart) / clip.speed));
}

export function sampleAnimationTrack(track: AnimationRecipe['tracks'][number], time: number) {
  if (time <= track.keys[0]!.time) return track.keys[0]!;
  for (let index = 1; index < track.keys.length; index++) {
    const right = track.keys[index]!, left = track.keys[index - 1]!;
    if (time <= right.time) {
      const progress = (time - left.time) / (right.time - left.time);
      const alpha = easeProgress(left.easingStyle, left.easingDirection, progress, left.curve);
      return {
        position: left.position.map((value, axis) => value + (right.position[axis]! - value) * alpha) as [number, number, number],
        rotation: quaternionToEulerXYZDegrees(slerp(eulerXYZDegreesToQuaternion(left.rotation), eulerXYZDegreesToQuaternion(right.rotation), alpha)),
      };
    }
  }
  return track.keys.at(-1)!;
}

type Pose = { position: [number, number, number]; rotation: [number, number, number] };
function normalizeQuaternion(q: Quaternion): Quaternion {
  const magnitude = Math.hypot(...q);
  return magnitude < 1e-12 ? [0, 0, 0, 1] : q.map(value => value / magnitude) as Quaternion;
}
function slerp(from: Quaternion, to: Quaternion, alpha: number): Quaternion {
  let target = to;
  let dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) { target = to.map(value => -value) as Quaternion; dot = -dot; }
  if (dot > 0.9995) return normalizeQuaternion(from.map((value, index) => value + (target[index]! - value) * alpha) as Quaternion);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))), sine = Math.sin(angle);
  const first = Math.sin((1 - alpha) * angle) / sine, second = Math.sin(alpha * angle) / sine;
  return normalizeQuaternion(from.map((value, index) => value * first + target[index]! * second) as Quaternion);
}
function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [x1, y1, z1, w1] = a, [x2, y2, z2, w2] = b;
  return normalizeQuaternion([w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2]);
}
function rotateVector(q: Quaternion, vector: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q, [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

export function sampleComposedRecipeJoint(recipe: AnimationRecipe, joint: string, time: number): Pose {
  const base = recipe.tracks.find(track => track.joint === joint);
  let pose: Pose = base ? sampleAnimationTrack(base, time) : { position: [0, 0, 0], rotation: [0, 0, 0] };
  let orientation = eulerXYZDegreesToQuaternion(pose.rotation);
  for (const layer of recipe.layers ?? []) {
    const track = layer.enabled && layer.weight > 0 ? layer.tracks.find(candidate => candidate.joint === joint) : undefined;
    if (!track) continue;
    const contribution = sampleAnimationTrack(track, time), rotation = eulerXYZDegreesToQuaternion(contribution.rotation);
    if (layer.blendMode === 'Additive') {
      const offset = slerp([0, 0, 0, 1], rotation, layer.weight);
      const moved = rotateVector(orientation, contribution.position.map(value => value * layer.weight) as [number, number, number]);
      pose = { position: pose.position.map((value, axis) => value + moved[axis]!) as [number, number, number], rotation: quaternionToEulerXYZDegrees(multiplyQuaternion(orientation, offset)) };
    } else {
      pose = { position: pose.position.map((value, axis) => value + (contribution.position[axis]! - value) * layer.weight) as [number, number, number], rotation: quaternionToEulerXYZDegrees(slerp(orientation, rotation, layer.weight)) };
    }
    orientation = eulerXYZDegreesToQuaternion(pose.rotation);
  }
  const rootMotion = recipe.rootMotion?.joint === joint ? sampleAnimationTrack(recipe.rootMotion, time) : undefined;
  if (rootMotion) {
    const offset = eulerXYZDegreesToQuaternion(rootMotion.rotation);
    pose = {
      position: pose.position.map((value, axis) => value + rotateVector(orientation, rootMotion.position)[axis]!) as [number, number, number],
      rotation: quaternionToEulerXYZDegrees(multiplyQuaternion(orientation, offset)),
    };
  }
  return pose;
}

function recipeContributesJoint(recipe: AnimationRecipe, joint: string) {
  return recipe.tracks.some(track => track.joint === joint)
    || (recipe.layers ?? []).some(layer => layer.enabled && layer.weight > 0 && layer.tracks.some(track => track.joint === joint))
    || recipe.rootMotion?.joint === joint;
}

function poseAngularGapDegrees(left: Pose, right: Pose) {
  const leftRotation = eulerXYZDegreesToQuaternion(left.rotation), rightRotation = eulerXYZDegreesToQuaternion(right.rotation);
  const dot = Math.min(1, Math.abs(leftRotation.reduce((sum, value, axis) => sum + value * rightRotation[axis]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function angularVelocityDegreesPerSecond(from: Pose, to: Pose, seconds: number): [number, number, number] {
  const fromRotation = eulerXYZDegreesToQuaternion(from.rotation);
  let relative = multiplyQuaternion(eulerXYZDegreesToQuaternion(to.rotation), [-fromRotation[0], -fromRotation[1], -fromRotation[2], fromRotation[3]]);
  if (relative[3] < 0) relative = relative.map(value => -value) as Quaternion;
  const vectorMagnitude = Math.hypot(relative[0], relative[1], relative[2]);
  if (vectorMagnitude < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(vectorMagnitude, Math.max(-1, Math.min(1, relative[3]))) * 180 / Math.PI;
  return [relative[0] / vectorMagnitude * angle / seconds, relative[1] / vectorMagnitude * angle / seconds, relative[2] / vectorMagnitude * angle / seconds];
}

function sampledRecipeVelocity(recipe: AnimationRecipe, joint: string, start: number, end: number) {
  const sampleSeconds = end - start;
  const first = sampleComposedRecipeJoint(recipe, joint, start);
  const last = sampleComposedRecipeJoint(recipe, joint, end);
  const position = first.position.map((value, axis) => (last.position[axis]! - value) / sampleSeconds) as [number, number, number];
  const rotation = angularVelocityDegreesPerSecond(first, last, sampleSeconds);
  return { position, rotation };
}

function sourceBoundaryVelocity(recipe: AnimationRecipe, joint: string, start: number, end: number, speed: number) {
  const velocity = sampledRecipeVelocity(recipe, joint, start, end);
  return {
    position: velocity.position.map(value => value * speed) as [number, number, number],
    rotation: velocity.rotation.map(value => value * speed) as [number, number, number],
  };
}

function vectorDistance(left: [number, number, number], right: [number, number, number]) {
  return Math.hypot(...left.map((value, axis) => value - right[axis]!));
}

function clipWeight(clip: SequenceClip, elapsed: number, duration: number) {
  const fadeIn = clip.fadeIn > 0 ? Math.min(1, elapsed / clip.fadeIn) : 1;
  const remaining = duration - elapsed;
  const fadeOut = clip.fadeOut > 0 ? Math.min(1, remaining / clip.fadeOut) : 1;
  return Math.max(0, Math.min(1, fadeIn, fadeOut));
}

type PreparedSequenceClip = { placement: SequenceClip; duration: number; recipe: AnimationRecipe };

function sampleComposedSequenceJoint(clips: PreparedSequenceClip[], joint: string, time: number, sequenceDuration: number): Pose {
  const samples = clips.flatMap(clip => {
    const elapsed = time - clip.placement.start;
    if (elapsed < 0 || elapsed > clip.duration || (elapsed === clip.duration && time < sequenceDuration)) return [];
    const hasJoint = clip.recipe.tracks.some(candidate => candidate.joint === joint)
      || clip.recipe.rootMotion?.joint === joint
      || clip.recipe.layers?.some(layer => layer.enabled && layer.weight > 0 && layer.tracks.some(candidate => candidate.joint === joint));
    if (!hasJoint) return [];
    const sourceTime = clip.placement.sourceStart + elapsed * clip.placement.speed;
    return [{ pose: sampleComposedRecipeJoint(clip.recipe, joint, sourceTime), weight: clipWeight(clip.placement, elapsed, clip.duration) }];
  }).filter(sample => sample.weight > 0);
  const total = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const position: [number, number, number] = [0, 0, 0];
  let orientation: Quaternion = [0, 0, 0, 1], accumulated = 0;
  if (total > 0) for (const sample of samples) for (let axis = 0; axis < 3; axis++) {
    position[axis]! += sample.pose.position[axis]! * sample.weight / total;
  }
  if (total > 0) for (const sample of samples) {
    const amount = sample.weight / total;
    orientation = accumulated === 0 ? eulerXYZDegreesToQuaternion(sample.pose.rotation) : slerp(orientation, eulerXYZDegreesToQuaternion(sample.pose.rotation), amount / (accumulated + amount));
    accumulated += amount;
  }
  return { position, rotation: quaternionToEulerXYZDegrees(orientation) };
}

function interpolatePose(from: Pose, to: Pose, alpha: number): Pose {
  return {
    position: from.position.map((value, axis) => value + (to.position[axis]! - value) * alpha) as [number, number, number],
    rotation: quaternionToEulerXYZDegrees(slerp(eulerXYZDegreesToQuaternion(from.rotation), eulerXYZDegreesToQuaternion(to.rotation), alpha)),
  };
}

function compileValidatedSequence(checked: ClipSequence, assets: Awaited<ReturnType<Library['get']>>[], duration: number): AnimationRecipe {
  const clips: PreparedSequenceClip[] = checked.clips.map((clip, index) => {
    const recipe = assets[index]!.recipe;
    if (recipe.kind !== 'animation') throw new Error(`Sequence clip ${index + 1} no longer references an animation.`);
    return { placement: clip, duration: (clip.sourceEnd - clip.sourceStart) / clip.speed, recipe };
  });
  if (duration < 0.1) throw new Error('A sequence must be at least 0.1 seconds long.');
  if (duration > 30) throw new Error('Roblox animation export is limited to 30 seconds; shorten this sequence before compiling.');
  const times = new Set<number>([0, duration]);
  for (const clip of clips) {
    const { placement, recipe } = clip;
    times.add(placement.start);
    times.add(placement.start + clip.duration);
    if (placement.fadeIn > 0) times.add(placement.start + placement.fadeIn);
    if (placement.fadeOut > 0) times.add(placement.start + clip.duration - placement.fadeOut);
    for (const marker of recipe.markers) {
      if (marker.time >= placement.sourceStart && marker.time <= placement.sourceEnd) times.add(placement.start + (marker.time - placement.sourceStart) / placement.speed);
    }
    for (const track of [...recipe.tracks, ...(recipe.layers ?? []).flatMap(layer => layer.tracks), ...(recipe.rootMotion ? [recipe.rootMotion] : [])]) for (const key of track.keys) {
      if (key.time > placement.sourceStart && key.time < placement.sourceEnd) times.add(placement.start + (key.time - placement.sourceStart) / placement.speed);
    }
  }
  const joints = [...new Set(clips.flatMap(clip => [...clip.recipe.tracks, ...(clip.recipe.layers ?? []).flatMap(layer => layer.tracks), ...(clip.recipe.rootMotion ? [clip.recipe.rootMotion] : [])].map(track => track.joint)))];
  if (joints.length === 0 || joints.length > 256) throw new Error('Compiled sequence must animate between 1 and 256 unique joints.');
  const maxKeysPerTrack = Math.min(128, Math.floor(4096 / joints.length));
  if (times.size > maxKeysPerTrack) throw new Error(`Clip boundaries and source keys require ${times.size} samples per track, above the ${maxKeysPerTrack}-key export limit. Simplify the sequence or use fewer clips.`);
  const targetKeyCount = Math.min(maxKeysPerTrack, Math.max(times.size, Math.ceil(duration * checked.sampleRate) + 1));
  const sourcePoseCache = new Map<number, Pose[]>();
  const sourcePosesAt = (time: number) => {
    const cached = sourcePoseCache.get(time);
    if (cached) return cached;
    const poses = joints.map(joint => sampleComposedSequenceJoint(clips, joint, time, duration));
    sourcePoseCache.set(time, poses);
    return poses;
  };
  type AdaptiveInterval = { start: number; end: number; positionError: number; positionTime: number; rotationError: number; rotationTime: number };
  while (times.size < targetKeyCount) {
    const sorted = [...times].sort((a, b) => a - b);
    const intervals: AdaptiveInterval[] = [];
    for (let index = 0; index < sorted.length - 1; index++) {
      const start = sorted[index]!, end = sorted[index + 1]!;
      const left = sourcePosesAt(start), right = sourcePosesAt(end);
      const interval: AdaptiveInterval = { start, end, positionError: 0, positionTime: start + (end - start) / 2, rotationError: 0, rotationTime: start + (end - start) / 2 };
      for (const fraction of [0.25, 0.5, 0.75]) {
        const time = start + (end - start) * fraction;
        const exact = sourcePosesAt(time);
        for (let jointIndex = 0; jointIndex < joints.length; jointIndex++) {
          const approximation = interpolatePose(left[jointIndex]!, right[jointIndex]!, fraction);
          const positionError = Math.hypot(...exact[jointIndex]!.position.map((value, axis) => value - approximation.position[axis]!));
          const rotationError = poseAngularGapDegrees(exact[jointIndex]!, approximation);
          if (positionError > interval.positionError) { interval.positionError = positionError; interval.positionTime = time; }
          if (rotationError > interval.rotationError) { interval.rotationError = rotationError; interval.rotationTime = time; }
        }
      }
      intervals.push(interval);
    }
    const rankedPosition = [...intervals].filter(interval => interval.positionError > 1e-9)
      .sort((a, b) => b.positionError - a.positionError || a.start - b.start);
    const rankedRotation = [...intervals].filter(interval => interval.rotationError > 1e-7)
      .sort((a, b) => b.rotationError - a.rotationError || a.start - b.start);
    const positionScores = new Map(rankedPosition.map((interval, index) => [interval, (rankedPosition.length - index) / rankedPosition.length]));
    const rotationScores = new Map(rankedRotation.map((interval, index) => [interval, (rankedRotation.length - index) / rankedRotation.length]));
    const chosen = [...intervals].sort((a, b) => {
      const aScore = Math.max(positionScores.get(a) ?? 0, rotationScores.get(a) ?? 0);
      const bScore = Math.max(positionScores.get(b) ?? 0, rotationScores.get(b) ?? 0);
      return bScore - aScore || (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    }).find(interval => {
      const positionScore = positionScores.get(interval) ?? 0;
      const rotationScore = rotationScores.get(interval) ?? 0;
      return !times.has(positionScore >= rotationScore ? interval.positionTime : interval.rotationTime);
    });
    let nextTime = chosen
      ? (positionScores.get(chosen) ?? 0) >= (rotationScores.get(chosen) ?? 0) ? chosen.positionTime : chosen.rotationTime
      : undefined;
    if (nextTime === undefined || times.has(nextTime)) {
      const fallback = [...intervals].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
      for (const interval of fallback) {
        nextTime = [0.5, 0.25, 0.75].map(fraction => interval.start + (interval.end - interval.start) * fraction).find(time => !times.has(time));
        if (nextTime !== undefined) break;
      }
    }
    if (nextTime === undefined) break;
    times.add(nextTime);
  }
  const sortedTimes = [...times].sort((a, b) => a - b);
  const tracks: AnimationRecipe['tracks'] = joints.map(joint => {
    const jointIndex = joints.indexOf(joint);
    const keys = sortedTimes.map(time => ({ time, ...sourcePosesAt(time)[jointIndex]! }));
    return { joint, keys };
  });
  const markers = clips.flatMap(clip => clip.recipe.markers.flatMap(marker => {
    const time = clip.placement.start + (marker.time - clip.placement.sourceStart) / clip.placement.speed;
    return marker.time >= clip.placement.sourceStart && marker.time <= clip.placement.sourceEnd ? [{ name: `${clip.recipe.name}: ${marker.name}`.slice(0, 80), ...(marker.value !== undefined ? { value: marker.value } : {}), ...(marker.phase !== undefined ? { phase: marker.phase } : {}), time }] : [];
  }));
  if (markers.length > 100) throw new Error('Compiled sequence exceeds the 100 marker limit.');
  const contacts = clips.flatMap(clip => (clip.recipe.contacts ?? []).flatMap(contact => {
    const start = Math.max(contact.start, clip.placement.sourceStart), end = Math.min(contact.end, clip.placement.sourceEnd);
    if (start >= end) return [];
    const remap = (time: number) => Number((clip.placement.start + (time - clip.placement.sourceStart) / clip.placement.speed).toFixed(6));
    return [{ effector: contact.effector, kind: contact.kind, start: remap(start), end: remap(end) }];
  })).sort((a, b) => a.effector.localeCompare(b.effector) || a.start - b.start);
  const mergedContacts = contacts.reduce<typeof contacts>((merged, contact) => {
    const previous = merged.at(-1);
    if (previous?.effector === contact.effector && previous.kind === contact.kind && contact.start <= previous.end) previous.end = Math.max(previous.end, contact.end);
    else merged.push({ ...contact });
    return merged;
  }, []);
  if (checked.loop) for (const track of tracks) {
    const first = track.keys[0]!, last = track.keys.at(-1)!;
    if (first.position.some((value, axis) => Math.abs(value - last.position[axis]!) > 1e-5) || first.rotation.some((value, axis) => Math.abs(value - last.rotation[axis]!) > 1e-4)) {
      throw new Error(`Looping sequence does not close on joint ${track.joint}; adjust clip arrangement or disable looping.`);
    }
  }
  return recipeSchema.parse({ kind: 'animation', name: checked.name, duration, loop: checked.loop, tracks, markers, ...(mergedContacts.length ? { contacts: mergedContacts } : {}) }) as AnimationRecipe;
}

export async function compileSequence(sequence: ClipSequence, library: Library): Promise<AnimationRecipe> {
  const validated = await validateSequence(sequence, library);
  return compileValidatedSequence(validated.recipe, validated.animationAssets, validated.duration);
}

export async function previewSequence(sequence: ClipSequence, library: Library) {
  const validated = await validateSequence(sequence, library);
  const animation = compileValidatedSequence(validated.recipe, validated.animationAssets, validated.duration);
  const preparedClips: PreparedSequenceClip[] = validated.recipe.clips.map((placement, index) => {
    const recipe = validated.animationAssets[index]!.recipe;
    if (recipe.kind !== 'animation') throw new Error(`Sequence clip ${index + 1} no longer references an animation.`);
    return { placement, duration: (placement.sourceEnd - placement.sourceStart) / placement.speed, recipe };
  });
  const intervals = validated.recipe.clips.map((clip, index) => ({
    clipIndex: index, animationId: clip.animationId, start: clip.start,
    end: clip.start + (clip.sourceEnd - clip.sourceStart) / clip.speed,
  }));
  const overlaps: Array<{ firstClip: number; secondClip: number; start: number; end: number; duration: number }> = [];
  for (let first = 0; first < intervals.length; first++) for (let second = first + 1; second < intervals.length; second++) {
    const start = Math.max(intervals[first]!.start, intervals[second]!.start);
    const end = Math.min(intervals[first]!.end, intervals[second]!.end);
    if (start < end) overlaps.push({ firstClip: first, secondClip: second, start, end, duration: end - start });
  }
  const gaps: Array<{ start: number; end: number; duration: number }> = [];
  let coveredUntil = 0;
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (interval.start > coveredUntil) gaps.push({ start: coveredUntil, end: interval.start, duration: interval.start - coveredUntil });
    coveredUntil = Math.max(coveredUntil, interval.end);
  }
  const fidelityByJoint = animation.tracks.map(track => ({
    joint: track.joint,
    position: { errorStuds: 0, time: 0, intervalStart: 0, intervalEnd: 0, probeFraction: 0 },
    rotation: { errorDegrees: 0, time: 0, intervalStart: 0, intervalEnd: 0, probeFraction: 0 },
  }));
  const compiledTimes = animation.tracks[0]?.keys.map(key => key.time) ?? [];
  let fidelitySampleCount = 0;
  for (let interval = 0; interval < compiledTimes.length - 1; interval++) {
    const start = compiledTimes[interval]!, end = compiledTimes[interval + 1]!;
    for (const fraction of [0.25, 0.5, 0.75]) {
      const time = start + (end - start) * fraction;
      for (const [trackIndex, track] of animation.tracks.entries()) {
        const sourcePose = sampleComposedSequenceJoint(preparedClips, track.joint, time, validated.duration);
        const bakedPose = sampleComposedRecipeJoint(animation, track.joint, time);
        const positionError = Math.hypot(...sourcePose.position.map((value, axis) => value - bakedPose.position[axis]!));
        const rotationError = poseAngularGapDegrees(sourcePose, bakedPose);
        const peak = fidelityByJoint[trackIndex]!;
        if (positionError > peak.position.errorStuds) peak.position = { errorStuds: positionError, time, intervalStart: start, intervalEnd: end, probeFraction: fraction };
        if (rotationError > peak.rotation.errorDegrees) peak.rotation = { errorDegrees: rotationError, time, intervalStart: start, intervalEnd: end, probeFraction: fraction };
        fidelitySampleCount++;
      }
    }
  }
  const largestPositionErrors = [...fidelityByJoint].sort((a, b) => b.position.errorStuds - a.position.errorStuds || a.joint.localeCompare(b.joint)).slice(0, 8);
  const largestRotationErrors = [...fidelityByJoint].sort((a, b) => b.rotation.errorDegrees - a.rotation.errorDegrees || a.joint.localeCompare(b.joint)).slice(0, 8);
  const expectedUniformKeyCount = Math.ceil(validated.duration * validated.recipe.sampleRate) + 1;
  const keyBudgetPerTrack = Math.min(128, Math.floor(4096 / Math.max(1, animation.tracks.length)));
  const maximumOutputIntervalSeconds = Math.max(0, ...compiledTimes.slice(1).map((time, index) => time - compiledTimes[index]!));
  const samplingFidelity = {
    method: 'Compare exact source-clip composition with the baked linear candidate at 25%, 50%, and 75% of every output key interval.',
    samplingStrategy: 'Preserve all authored source keys, markers, clip boundaries and fade boundaries; allocate remaining requested keys by repeatedly splitting the interval with the highest rank-normalized probed position or rotation error. If probes show no meaningful curvature, split the longest remaining interval.',
    requestedSampleRateHz: validated.recipe.sampleRate,
    outputIntervalCount: Math.max(0, compiledTimes.length - 1),
    actualKeyCountPerTrack: compiledTimes.length,
    expectedUniformKeyCount,
    keyBudgetPerTrack,
    atTrackKeyBudget: compiledTimes.length >= keyBudgetPerTrack,
    requestedRateExceedsKeyCapacity: expectedUniformKeyCount > keyBudgetPerTrack,
    maximumOutputIntervalSeconds,
    probesPerInterval: 3,
    jointProbeCount: fidelitySampleCount,
    maximumPositionErrorStuds: Math.max(0, ...fidelityByJoint.map(item => item.position.errorStuds)),
    maximumAngularErrorDegrees: Math.max(0, ...fidelityByJoint.map(item => item.rotation.errorDegrees)),
    largestPositionErrors,
    largestRotationErrors,
    limitation: 'Finite interior probes can reveal under-sampling but do not bound error between probes or establish visual quality. Increase the sequence sampleRate and preview again if important motion is poorly approximated; the Roblox per-track and total pose-key limits still apply.',
  };
  const jointSet = new Set(animation.tracks.map(track => track.joint.toLowerCase()));
  const clips = validated.recipe.clips.map((clip, index) => {
    const asset = validated.animationAssets[index]!;
    const sourceRecipe = asset.recipe.kind === 'animation' ? asset.recipe : undefined;
    if (!sourceRecipe) throw new Error(`Sequence clip ${index + 1} no longer references an animation.`);
    const contributed = [...new Set([...sourceRecipe.tracks, ...(sourceRecipe.layers ?? []).flatMap(layer => layer.tracks), ...(sourceRecipe.rootMotion ? [sourceRecipe.rootMotion] : [])].map(track => track.joint))];
    return {
      clipIndex: index, animationId: clip.animationId, name: sourceRecipe.name,
      sourceFingerprint: validated.sourceFingerprints[index]!,
      start: intervals[index]!.start, end: intervals[index]!.end, duration: intervals[index]!.end - intervals[index]!.start,
      sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, speed: clip.speed, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
      contributedJoints: contributed, jointCoverage: contributed.filter(joint => jointSet.has(joint.toLowerCase())).length,
    };
  });
  const orderedClips = validated.recipe.clips.map((placement, index) => ({
    placement, interval: intervals[index]!, recipe: validated.animationAssets[index]!.recipe,
  })).sort((left, right) => left.interval.start - right.interval.start || left.interval.end - right.interval.end || left.interval.clipIndex - right.interval.clipIndex);
  const transitionBoundaries = orderedClips.slice(1).map((right, offset) => {
    const left = orderedClips[offset]!;
    if (left.recipe.kind !== 'animation' || right.recipe.kind !== 'animation') throw new Error('Sequence transition analysis requires animation source clips.');
    const leftRecipe = left.recipe, rightRecipe = right.recipe;
    const joints = [...new Set([
      ...leftRecipe.tracks.map(track => track.joint), ...(leftRecipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)), ...(leftRecipe.rootMotion ? [leftRecipe.rootMotion.joint] : []),
      ...rightRecipe.tracks.map(track => track.joint), ...(rightRecipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)), ...(rightRecipe.rootMotion ? [rightRecipe.rootMotion.joint] : []),
    ])].sort((a, b) => a.localeCompare(b));
    const chronologicalGap = right.interval.start - left.interval.end;
    const boundaryTime = Math.max(left.interval.start, Math.min(left.interval.end, right.interval.start));
    const composedWindowBefore = Math.min(1 / 30, boundaryTime);
    const composedWindowAfter = Math.min(1 / 30, validated.duration - boundaryTime);
    const jointGaps = joints.map(joint => {
      const leftPose = sampleComposedRecipeJoint(leftRecipe, joint, left.placement.sourceEnd);
      const rightPose = sampleComposedRecipeJoint(rightRecipe, joint, right.placement.sourceStart);
      const leftSampleWindow = Math.min(1 / 30, (left.placement.sourceEnd - left.placement.sourceStart) / 2);
      const rightSampleWindow = Math.min(1 / 30, (right.placement.sourceEnd - right.placement.sourceStart) / 2);
      const outgoingVelocity = sourceBoundaryVelocity(leftRecipe, joint, left.placement.sourceEnd - leftSampleWindow, left.placement.sourceEnd, left.placement.speed);
      const incomingVelocity = sourceBoundaryVelocity(rightRecipe, joint, right.placement.sourceStart, right.placement.sourceStart + rightSampleWindow, right.placement.speed);
      const composedOutgoingVelocity = composedWindowBefore > 0
        ? sampledRecipeVelocity(animation, joint, boundaryTime - composedWindowBefore, boundaryTime)
        : null;
      const composedIncomingVelocity = composedWindowAfter > 0
        ? sampledRecipeVelocity(animation, joint, boundaryTime, boundaryTime + composedWindowAfter)
        : null;
      const composedLinearVelocityGap = composedOutgoingVelocity && composedIncomingVelocity
        ? vectorDistance(composedOutgoingVelocity.position, composedIncomingVelocity.position) : null;
      const composedAngularVelocityGap = composedOutgoingVelocity && composedIncomingVelocity
        ? vectorDistance(composedOutgoingVelocity.rotation, composedIncomingVelocity.rotation) : null;
      return {
        joint,
        leftContributes: recipeContributesJoint(leftRecipe, joint), rightContributes: recipeContributesJoint(rightRecipe, joint),
        positionGapStuds: Math.hypot(...leftPose.position.map((value, axis) => value - rightPose.position[axis]!)),
        angularGapDegrees: poseAngularGapDegrees(leftPose, rightPose),
        outgoingVelocityStudsPerSecond: outgoingVelocity.position,
        incomingVelocityStudsPerSecond: incomingVelocity.position,
        linearVelocityGapStudsPerSecond: vectorDistance(outgoingVelocity.position, incomingVelocity.position),
        outgoingAngularVelocityDegreesPerSecond: outgoingVelocity.rotation,
        incomingAngularVelocityDegreesPerSecond: incomingVelocity.rotation,
        angularVelocityGapDegreesPerSecond: vectorDistance(outgoingVelocity.rotation, incomingVelocity.rotation),
        composedOutgoingVelocityStudsPerSecond: composedOutgoingVelocity?.position ?? null,
        composedIncomingVelocityStudsPerSecond: composedIncomingVelocity?.position ?? null,
        composedLinearVelocityGapStudsPerSecond: composedLinearVelocityGap,
        composedOutgoingAngularVelocityDegreesPerSecond: composedOutgoingVelocity?.rotation ?? null,
        composedIncomingAngularVelocityDegreesPerSecond: composedIncomingVelocity?.rotation ?? null,
        composedAngularVelocityGapDegreesPerSecond: composedAngularVelocityGap,
      };
    });
    const composedLinearVelocityGaps = jointGaps.flatMap(item => item.composedLinearVelocityGapStudsPerSecond === null ? [] : [item.composedLinearVelocityGapStudsPerSecond]);
    const composedAngularVelocityGaps = jointGaps.flatMap(item => item.composedAngularVelocityGapDegreesPerSecond === null ? [] : [item.composedAngularVelocityGapDegreesPerSecond]);
    const leftContacts = (leftRecipe.contacts ?? []).filter(contact => contact.start <= left.placement.sourceEnd && contact.end >= left.placement.sourceEnd)
      .map(contact => ({ effector: contact.effector, kind: contact.kind }));
    const rightContacts = (rightRecipe.contacts ?? []).filter(contact => contact.start <= right.placement.sourceStart && contact.end >= right.placement.sourceStart)
      .map(contact => ({ effector: contact.effector, kind: contact.kind }));
    const contactEffectorNames = new Set([...leftContacts, ...rightContacts].map(contact => contact.effector.toLowerCase()));
    const contactBoundaryChanges = [...contactEffectorNames].sort().flatMap(effector => {
      const before = leftContacts.find(contact => contact.effector.toLowerCase() === effector);
      const after = rightContacts.find(contact => contact.effector.toLowerCase() === effector);
      if (before?.kind === after?.kind) return [];
      return [{ effector, leftKind: before?.kind ?? null, rightKind: after?.kind ?? null }];
    });
    return {
      fromClipIndex: left.interval.clipIndex, toClipIndex: right.interval.clipIndex,
      fromAnimationId: left.placement.animationId, toAnimationId: right.placement.animationId,
      fromName: leftRecipe.name, toName: rightRecipe.name, boundaryTime,
      chronologicalGapSeconds: chronologicalGap,
      relation: chronologicalGap > 0 ? 'gap' as const : chronologicalGap < 0 ? 'overlap' as const : 'touching' as const,
      sourceFadeWindowSeconds: { outgoing: left.placement.fadeOut, incoming: right.placement.fadeIn },
      maximumPositionGapStuds: Math.max(0, ...jointGaps.map(item => item.positionGapStuds)),
      maximumAngularGapDegrees: Math.max(0, ...jointGaps.map(item => item.angularGapDegrees)),
      maximumLinearVelocityGapStudsPerSecond: Math.max(0, ...jointGaps.map(item => item.linearVelocityGapStudsPerSecond)),
      maximumAngularVelocityGapDegreesPerSecond: Math.max(0, ...jointGaps.map(item => item.angularVelocityGapDegreesPerSecond)),
      maximumComposedLinearVelocityGapStudsPerSecond: composedLinearVelocityGaps.length ? Math.max(...composedLinearVelocityGaps) : null,
      maximumComposedAngularVelocityGapDegreesPerSecond: composedAngularVelocityGaps.length ? Math.max(...composedAngularVelocityGaps) : null,
      largestPositionGaps: [...jointGaps].sort((a, b) => b.positionGapStuds - a.positionGapStuds || a.joint.localeCompare(b.joint)).slice(0, 8),
      largestAngularGaps: [...jointGaps].sort((a, b) => b.angularGapDegrees - a.angularGapDegrees || a.joint.localeCompare(b.joint)).slice(0, 8),
      largestLinearVelocityGaps: [...jointGaps].sort((a, b) => b.linearVelocityGapStudsPerSecond - a.linearVelocityGapStudsPerSecond || a.joint.localeCompare(b.joint)).slice(0, 8),
      largestAngularVelocityGaps: [...jointGaps].sort((a, b) => b.angularVelocityGapDegreesPerSecond - a.angularVelocityGapDegreesPerSecond || a.joint.localeCompare(b.joint)).slice(0, 8),
      largestComposedLinearVelocityGaps: [...jointGaps].filter(item => item.composedLinearVelocityGapStudsPerSecond !== null)
        .sort((a, b) => b.composedLinearVelocityGapStudsPerSecond! - a.composedLinearVelocityGapStudsPerSecond! || a.joint.localeCompare(b.joint)).slice(0, 8),
      largestComposedAngularVelocityGaps: [...jointGaps].filter(item => item.composedAngularVelocityGapDegreesPerSecond !== null)
        .sort((a, b) => b.composedAngularVelocityGapDegreesPerSecond! - a.composedAngularVelocityGapDegreesPerSecond! || a.joint.localeCompare(b.joint)).slice(0, 8),
      contactBoundaryChanges,
      limitation: 'Endpoint pose and source/composed one-sided velocities are measurements, not pass/fail thresholds. Source velocity uses a local 1/30-second-or-shorter window scaled by clip speed; composed velocity samples the compiled blend over the same maximum window. These are finite differences, not instantaneous derivatives or rendered-quality verdicts. Inspect the compiled transition on the target rig.',
    };
  });
  return {
    sequence: validated.recipe, duration: validated.duration, animation,
    diagnostics: {
      clipCount: clips.length, outputTracks: animation.tracks.length, outputKeys: animation.tracks.reduce((count, track) => count + track.keys.length, 0),
      outputMarkers: animation.markers.length, outputContacts: animation.contacts?.length ?? 0,
      overlaps, gaps, clips, transitionBoundaries, samplingFidelity,
      notes: ['Overlaps are blended by normalized clip weights; gaps compile as the neutral pose.', 'Transition-boundary gaps compare source endpoint poses before crossfade weighting and expose contact-kind changes; they do not score artistic quality.', 'Joint coverage confirms named channels only; inspect local axes, contacts, and crossfade quality on the target rig.'],
    },
  };
}

