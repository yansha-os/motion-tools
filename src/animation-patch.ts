import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { easeProgress } from './easing.js';
import { formatAnimationTime } from './time-format.js';
import { animationMarker, animationSchema, animationTrack, bezierCurve, contactConstraint, identifier, label, poseEasingDirection, poseEasingStyle, recipeSchema, type AnimationRecipe } from './recipes.js';
import { extractActionPhaseWindows } from './animation-phases.js';
import { eulerXYZDegreesToQuaternion, quaternionToEulerXYZDegrees, type Quaternion } from './rotation.js';

const positionVector = z.tuple([
  z.number().finite().min(-100).max(100),
  z.number().finite().min(-100).max(100),
  z.number().finite().min(-100).max(100),
]);
const rotationVector = z.tuple([
  z.number().finite().min(-720).max(720),
  z.number().finite().min(-720).max(720),
  z.number().finite().min(-720).max(720),
]);

const poseFields = {
  position: positionVector.optional().describe('Absolute joint-local XYZ translation in studs.'),
  rotation: rotationVector.optional().describe('Absolute Roblox XYZ Euler rotation in degrees, stored in the joint pose.'),
};
const poseOffsetTarget = z.object({ joint: label,
  positionOffset: positionVector.optional().describe('Add joint-local XYZ translation in studs.'),
  rotationOffset: rotationVector.optional().describe('Compose a local Roblox XYZ Euler rotation offset in degrees using quaternions.'),
}).strict().superRefine((target, ctx) => {
  if (!target.positionOffset && !target.rotationOffset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide positionOffset or rotationOffset for each target joint.' });
  if ((target.positionOffset ?? [0, 0, 0]).every(value => value === 0)
    && (target.rotationOffset ?? [0, 0, 0]).every(value => value === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each target must have a non-zero pose offset.' });
  }
});
const axisSign = z.union([z.literal(-1), z.literal(1)]);
const axisSigns = z.tuple([axisSign, axisSign, axisSign]);
const componentScale = z.tuple([0, 1, 2].map(() => z.number().finite().min(-4).max(4)) as [z.ZodNumber, z.ZodNumber, z.ZodNumber]);

export const animationPatchOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('retime_clip'), duration: z.number().finite().min(0.1).max(30) }).strict(),
  z.object({ operation: z.literal('close_loop'), windowSeconds: z.number().finite().min(0.05).max(10), samples: z.number().int().min(4).max(64).default(16), easingStyle: z.enum(['Linear', 'CubicV2']).default('CubicV2'), easingDirection: poseEasingDirection.default('InOut') }).strict(),
  z.object({ operation: z.literal('smooth_loop_seam'), joint: label.optional(), layerId: identifier.optional(), strength: z.number().finite().min(0.1).max(1).default(1), protectContacts: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal('compress_track'), joint: label, layerId: identifier.optional(), maxPositionErrorStuds: z.number().finite().min(0).max(5).default(0.01), maxRotationErrorDegrees: z.number().finite().min(0).max(45).default(0.5), sampleRateHz: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)]).default(120), protectContactKeys: z.boolean().default(true), protectMarkerKeys: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal('retime_phase'), startMarker: label, endMarker: label, startOccurrence: z.number().int().min(1).max(100).default(1), endOccurrence: z.number().int().min(1).max(100).default(1), newDuration: z.number().finite().min(0.016).max(30) }).strict(),
  z.object({ operation: z.literal('adjust_phase'), startMarker: label, endMarker: label, startOccurrence: z.number().int().min(1).max(100).default(1), endOccurrence: z.number().int().min(1).max(100).default(1), joints: z.array(label).min(1).max(128), layerId: identifier.optional(), positionOffset: positionVector.optional().describe('Add joint-local XYZ translation in studs through the phase envelope.'), rotationOffset: rotationVector.optional().describe('Compose this Roblox XYZ Euler rotation offset in degrees through the phase envelope.'), fadeInProgress: z.number().finite().min(0.01).max(0.5).default(0.15), fadeOutProgress: z.number().finite().min(0.01).max(0.5).default(0.15), easingStyle: z.enum(['Linear', 'CubicV2']).default('CubicV2'), easingDirection: poseEasingDirection.default('Out'), allowDeclaredContactOverlap: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('mirror_pose'), sourceJoint: label, targetJoint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), positionSigns: axisSigns, rotationSigns: axisSigns }).strict(),
  z.object({ operation: z.literal('mirror_tracks'), mappings: z.array(z.object({ sourceJoint: label, targetJoint: label, positionSigns: axisSigns, rotationSigns: axisSigns }).strict()).min(1).max(128).describe('For mirror_tracks: explicit source-to-target joint pairs and +/-1 component signs for position and rotation. Supply both directions for a bilateral swap. Targets must be unique; all source tracks are snapshotted before any targets are written.'), layerId: identifier.optional(), replaceExisting: z.boolean().default(false).describe('For mirror_tracks: must be true to overwrite any existing target track; false only permits new target tracks.') }).strict(),
  z.object({ operation: z.literal('transform_track'), joint: label, sourceJoint: label.optional(), layerId: identifier.optional(), positionScale: componentScale.optional(), positionOffset: positionVector.optional(), rotationScale: componentScale.optional(), rotationOffset: rotationVector.optional(), replaceExisting: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('set_pose'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), ...poseFields }).strict(),
  z.object({ operation: z.literal('offset_pose'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(),
    positionOffset: positionVector.optional().describe('Add this joint-local XYZ translation offset in studs to the existing keyed pose.'),
    rotationOffset: rotationVector.optional().describe('Compose this Roblox XYZ Euler rotation offset in degrees after the existing keyed rotation using quaternions; it is not an absolute replacement.'),
    insertIfMissing: z.boolean().default(false).describe('When true, create a breakdown by interpolating the current track at time before applying the offset. Only valid strictly inside the clip and within the track key limit.') }).strict()
    .describe('Incrementally refine a pose without calculating or replacing its full transform. By default time must match an authored key; insertIfMissing explicitly opts into creating an interpolated breakdown.'),
  z.object({ operation: z.literal('offset_pose_group'), time: z.number().finite().min(0).max(30), layerId: identifier.optional(),
    targets: z.array(poseOffsetTarget).min(2).max(128).describe('Two or more distinct joint-local pose offsets to apply together at the same time. The operation preflights all target joints and keys before changing any of them.'),
    insertIfMissing: z.boolean().default(false).describe('When true, missing keys are interpolated and inserted for all targets; every insertion must be interior to the clip and fit the 128-key track limit.') }).strict()
    .describe('Atomically sculpt one coordinated multi-joint pose. Returns a before/after record for each joint; use preserve guards for unaffected motion.'),
  z.object({ operation: z.literal('insert_key'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), ...poseFields }).strict(),
  z.object({ operation: z.literal('set_easing'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), easingStyle: poseEasingStyle.optional(), easingDirection: poseEasingDirection.optional() }).strict(),
  z.object({ operation: z.literal('set_curve'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), curve: bezierCurve }).strict(),
  z.object({ operation: z.literal('layer_create'), name: label, blendMode: z.enum(['Override', 'Additive']), weight: z.number().finite().min(0).max(1) }).strict(),
  z.object({ operation: z.literal('layer_set'), layerId: identifier, enabled: z.boolean().optional(), weight: z.number().finite().min(0).max(1).optional(), blendMode: z.enum(['Override', 'Additive']).optional() }).strict(),
  z.object({ operation: z.literal('layer_move'), layerId: identifier, direction: z.enum(['up', 'down']) }).strict(),
  z.object({ operation: z.literal('layer_delete'), layerId: identifier }).strict(),
  z.object({ operation: z.literal('layer_set_track'), layerId: identifier, track: animationTrack }).strict(),
  z.object({ operation: z.literal('layer_delete_track'), layerId: identifier, joint: label }).strict(),
  z.object({ operation: z.literal('root_motion_set'), track: animationTrack }).strict(),
  z.object({ operation: z.literal('root_motion_clear') }).strict(),
  z.object({ operation: z.literal('contacts_set'), contacts: z.array(contactConstraint).max(16) }).strict(),
  z.object({ operation: z.literal('markers_set'), markers: z.array(animationMarker).max(100) }).strict(),
  z.object({ operation: z.literal('retime_key'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional(), newTime: z.number().finite().min(0).max(30) }).strict(),
  z.object({ operation: z.literal('delete_key'), joint: label, time: z.number().finite().min(0).max(30), layerId: identifier.optional() }).strict(),
]).superRefine((operation, ctx) => {
  if ((operation.operation === 'set_pose' || operation.operation === 'insert_key') && !operation.position && !operation.rotation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide a position or rotation to change.' });
  }
  if (operation.operation === 'offset_pose') {
    if (!operation.positionOffset && !operation.rotationOffset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide a positionOffset or rotationOffset.' });
    if ((operation.positionOffset ?? [0, 0, 0]).every(value => value === 0)
      && (operation.rotationOffset ?? [0, 0, 0]).every(value => value === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The requested pose offset is an identity operation.' });
    }
  }
  if (operation.operation === 'offset_pose_group') {
    const normalizedJoints = operation.targets.map(target => target.joint.toLowerCase());
    if (new Set(normalizedJoints).size !== normalizedJoints.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: 'Each target joint must be unique, ignoring case.' });
    }
  }
  if (operation.operation === 'adjust_phase') {
    if (!operation.positionOffset && !operation.rotationOffset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positionOffset'], message: 'Provide a positionOffset or rotationOffset.' });
    if (operation.positionOffset?.every(value => value === 0) && operation.rotationOffset?.every(value => value === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The requested phase adjustment is an identity operation.' });
    if (operation.fadeInProgress + operation.fadeOutProgress > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fadeOutProgress'], message: 'Fade-in and fade-out progress must not overlap; their sum must be at most 1.' });
    const normalizedJoints = operation.joints.map(joint => joint.toLowerCase());
    if (new Set(normalizedJoints).size !== normalizedJoints.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['joints'], message: 'Each target joint must be unique, ignoring case.' });
    if (operation.startMarker.toLowerCase() === operation.endMarker.toLowerCase() && operation.startOccurrence >= operation.endOccurrence) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'When phase boundary markers have the same name, endOccurrence must be after startOccurrence.' });
  }
  if (operation.operation === 'set_easing' && !operation.easingStyle && !operation.easingDirection) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide an easing style or direction to change.' });
  }
  if (operation.operation === 'set_curve' && operation.curve.outTime > operation.curve.inTime) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Bezier time handles must remain ordered.' });
  }
  if (operation.operation === 'layer_set' && operation.enabled === undefined && operation.weight === undefined && !operation.blendMode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide enabled, weight, or blendMode to update a layer.' });
  }
  if (operation.operation === 'mirror_pose' && operation.sourceJoint === operation.targetJoint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mirror source and target joints must be different.' });
  }
  if (operation.operation === 'mirror_tracks') {
    const targets = operation.mappings.map(mapping => mapping.targetJoint.toLowerCase());
    if (new Set(targets).size !== targets.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mappings'], message: 'Each mirror mapping must have a unique target joint.' });
    operation.mappings.forEach((mapping, index) => {
      if (mapping.sourceJoint.toLowerCase() === mapping.targetJoint.toLowerCase()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mappings', index], message: 'Mirror source and target joints must be different, ignoring case.' });
    });
  }
  if (operation.operation === 'retime_phase' && operation.startMarker.toLowerCase() === operation.endMarker.toLowerCase() && operation.startOccurrence >= operation.endOccurrence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'When phase boundary markers have the same name, endOccurrence must be after startOccurrence.' });
  }
  if (operation.operation === 'transform_track') {
    const hasTransform = operation.positionScale || operation.positionOffset || operation.rotationScale || operation.rotationOffset;
    const positionScale = operation.positionScale ?? [1, 1, 1];
    const positionOffset = operation.positionOffset ?? [0, 0, 0];
    const rotationScale = operation.rotationScale ?? [1, 1, 1];
    const rotationOffset = operation.rotationOffset ?? [0, 0, 0];
    if (!hasTransform && !operation.sourceJoint) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide a track transform or a sourceJoint to copy.' });
    if (operation.replaceExisting && (!operation.sourceJoint || operation.sourceJoint === operation.joint)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'replaceExisting is only valid when copying from a different sourceJoint.' });
    if (hasTransform && positionScale.every(value => value === 1) && positionOffset.every(value => value === 0)
      && rotationScale.every(value => value === 1) && rotationOffset.every(value => value === 0)
      && (!operation.sourceJoint || operation.sourceJoint === operation.joint)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The requested track transform is an identity operation.' });
    }
  }
  if (operation.operation === 'smooth_loop_seam' && operation.layerId && !operation.joint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['joint'], message: 'Provide joint when targeting one animation layer.' });
  }
});

export const animationPatchSchema = z.array(animationPatchOperation).min(1).max(50);
export type AnimationPatchOperation = z.infer<typeof animationPatchOperation>;
const protectedPhaseSchema = z.object({
  label: z.enum(['anticipation', 'main_action', 'follow_through', 'recovery']),
  occurrence: z.number().int().min(1).max(100).default(1),
  startProgress: z.number().finite().min(0).max(1).default(0),
  endProgress: z.number().finite().min(0).max(1).default(1),
}).strict().superRefine((phase, ctx) => {
  if (phase.startProgress >= phase.endProgress) ctx.addIssue({ code: 'custom', message: 'Protected phase progress must be a non-empty interval.' });
});
export const preservationRegionSchema = z.object({
  joint: label, scope: z.enum(['composed', 'track']).default('composed'), layerId: identifier.optional(),
  startTime: z.number().finite().min(0).max(30).optional(), endTime: z.number().finite().min(0).max(30).optional(), phase: protectedPhaseSchema.optional(),
  sampleRateHz: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)]).default(120),
  positionTolerance: z.number().finite().min(0).max(5).default(0.001), rotationToleranceDegrees: z.number().finite().min(0).max(45).default(0.1),
}).strict().superRefine((region, ctx) => {
  const hasStart = region.startTime !== undefined, hasEnd = region.endTime !== undefined;
  if (Boolean(region.phase) === (hasStart || hasEnd) || hasStart !== hasEnd) {
    ctx.addIssue({ code: 'custom', message: 'Specify either phase progress or both absolute startTime and endTime.' });
  }
  if (hasStart && hasEnd && region.startTime! >= region.endTime!) ctx.addIssue({ code: 'custom', message: 'Protected motion must cover a non-empty time interval.' });
  if (region.scope === 'composed' && region.layerId) ctx.addIssue({ code: 'custom', message: 'A composed-motion guard cannot target one layerId; use scope: track for a layer channel.' });
});
export const preservationRegionsSchema = z.array(preservationRegionSchema).max(16).superRefine((regions, ctx) => {
  for (let right = 0; right < regions.length; right++) for (let left = 0; left < right; left++) {
    const a = regions[left]!, b = regions[right]!;
    const sameSelectorSpace = a.phase && b.phase
      ? a.phase.label === b.phase.label && a.phase.occurrence === b.phase.occurrence
      : !a.phase && !b.phase;
    const overlaps = a.phase && b.phase
      ? a.phase.startProgress < b.phase.endProgress && b.phase.startProgress < a.phase.endProgress
      : !a.phase && !b.phase && a.startTime! < b.endTime! && b.startTime! < a.endTime!;
    if (sameSelectorSpace && overlaps && a.joint === b.joint && a.scope === b.scope && a.layerId === b.layerId) {
      ctx.addIssue({ code: 'custom', path: [right], message: `Protected regions ${left + 1} and ${right + 1} overlap for ${a.joint}; combine them and use the stricter tolerance.` });
    }
  }
});
export type PreservationRegion = z.infer<typeof preservationRegionSchema>;

export interface AnimationPatchChange {
  operation: AnimationPatchOperation['operation'];
  joint: string;
  poseOffset?: { position?: [number, number, number]; rotation?: [number, number, number] };
  poseBefore?: { position: [number, number, number]; rotation: [number, number, number] };
  poseAfter?: { position: [number, number, number]; rotation: [number, number, number] };
  insertedKey?: boolean;
  sourceJoint?: string;
  keyCount?: number;
  time: number;
  newTime?: number;
  previousDuration?: number;
  newDuration?: number;
  phaseStartTime?: number;
  phaseEndTime?: number;
  previousPhaseDuration?: number;
  newPhaseDuration?: number;
  timeMap?: { sourceStart: number; sourceEnd: number; candidateStart: number; candidateEnd: number; mode: 'unchanged' | 'scaled' | 'shifted'; scale: number; offset: number }[];
  affected?: { baseKeys: number; layerKeys: number; rootMotionKeys: number; contactIntervals: number; markers: number };
  layerId?: string;
  loopClosure?: { windowStart: number; windowEnd: number; tracks: number; generatedKeys: number; maxPositionGapBefore: number; maxAngularGapBeforeDegrees: number; maxPositionGapAfter: number; maxAngularGapAfterDegrees: number };
  compression?: { originalKeys: number; retainedKeys: number; removedKeys: number; protectedKeys: number; sampleRateHz: 30 | 60 | 120 | 240; sampleCount: number; maxPositionErrorStuds: number; maxPositionErrorAt: number; maxRotationErrorDegrees: number; maxRotationErrorAt: number; positionToleranceStuds: number; rotationToleranceDegrees: number; toleranceSatisfiedAtSamples: boolean };
  loopSeamSmoothing?: { strength: number; tracksChanged: number; tracksSkipped: { channel: 'base' | 'layer' | 'rootMotion'; joint: string; reason: string }[]; maxPositionVelocityDiscontinuityBefore: number; maxPositionVelocityDiscontinuityAfter: number; maxAngularVelocityDiscontinuityBeforeDegrees: number; maxAngularVelocityDiscontinuityAfterDegrees: number };
  phaseAdjustment?: { startMarker: string; endMarker: string; startOccurrence: number; endOccurrence: number; startTime: number; endTime: number; fadeInProgress: number; fadeOutProgress: number; easingStyle: string; easingDirection: string; changedKeys: number; overlappingDeclaredContacts: string[] };
}

const MARKER_KEY_PROTECTION_TOLERANCE_SECONDS = 0.0001;
function sameKeyTime(left: number, right: number) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 4;
}
const applyComponent = (value: number, scale: number, offset: number) => {
  const transformed = value * scale + offset;
  return transformed === 0 ? 0 : transformed;
};

function findTrack(recipe: AnimationRecipe, joint: string, layerId?: string) {
  const layer = layerId ? recipe.layers?.find(candidate => candidate.id === layerId) : undefined;
  if (layerId && !layer) throw new Error(`No animation layer with ID ${layerId}. Read the recipe and use an existing layer ID.`);
  const tracks = layer ? layer.tracks : recipe.tracks;
  const track = tracks.find(candidate => candidate.joint === joint);
  if (!track) throw new Error(`No animation track for ${joint}${layer ? ` in layer ${layer.name}` : ''}. Read the recipe and target an existing joint track.`);
  return track;
}

function findKeyIndex(track: AnimationRecipe['tracks'][number], time: number) {
  const index = track.keys.findIndex(key => sameKeyTime(key.time, time));
  if (index < 0) throw new Error(`No key on ${track.joint} at ${formatAnimationTime(time)}s. Read the recipe and use an existing key time.`);
  return index;
}

function interpolatedPose(track: AnimationRecipe['tracks'][number], time: number) {
  for (let index = 1; index < track.keys.length; index++) {
    const left = track.keys[index - 1]!;
    const right = track.keys[index]!;
    if (time > right.time) continue;
    const rawAlpha = (time - left.time) / (right.time - left.time);
    const alpha = easeProgress(left.easingStyle, left.easingDirection, rawAlpha, left.curve);
    return {
      position: left.position.map((value, axis) => value + (right.position[axis]! - value) * alpha) as [number, number, number],
      rotation: left.rotation.map((value, axis) => value + (right.rotation[axis]! - value) * alpha) as [number, number, number],
      easingStyle: left.easingStyle,
      easingDirection: left.easingDirection,
    };
  }
  throw new Error(`Cannot interpolate a pose on ${track.joint} at ${formatAnimationTime(time)}s.`);
}

function sampleTrack(track: AnimationRecipe['tracks'][number], time: number, transformCache: WeakMap<object, Transform>) {
  const first = track.keys[0]!;
  if (time <= first.time) return transform(first, transformCache);
  if (time >= track.keys.at(-1)!.time) return transform(track.keys.at(-1)!, transformCache);
  let low = 1, high = track.keys.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (track.keys[middle]!.time < time) low = middle + 1;
    else high = middle;
  }
  const rightIndex = low;
  const left = track.keys[rightIndex - 1]!, right = track.keys[rightIndex]!;
  const rawAlpha = (time - left.time) / (right.time - left.time);
  return interpolateTransform(transform(left, transformCache), transform(right, transformCache), easeProgress(left.easingStyle, left.easingDirection, rawAlpha, left.curve));
}

type Transform = { position: [number, number, number]; rotation: Quaternion };
function normalizeQuaternion(value: Quaternion): Quaternion {
  const magnitude = Math.hypot(...value);
  return magnitude < 1e-12 ? [0, 0, 0, 1] : value.map(component => component / magnitude) as Quaternion;
}

function nearestEulerEquivalent(rotation: [number, number, number], reference: [number, number, number]): [number, number, number] {
  const alternatives: [number, number, number][] = [rotation, [rotation[0] + 180, 180 - rotation[1], rotation[2] + 180]];
  return alternatives
    .map(candidate => candidate.map((value, axis) => value + 360 * Math.round((reference[axis]! - value) / 360)) as [number, number, number])
    .sort((left, right) => left.reduce((sum, value, axis) => sum + (value - reference[axis]!) ** 2, 0)
      - right.reduce((sum, value, axis) => sum + (value - reference[axis]!) ** 2, 0))[0]!;
}

function angularDistanceDegrees(left: Quaternion, right: Quaternion) {
  const dot = Math.min(1, Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function angularVelocityDegrees(from: Quaternion, to: Quaternion, seconds: number): [number, number, number] {
  let target = to;
  if (from.reduce((sum, value, index) => sum + value * to[index]!, 0) < 0) target = to.map(value => -value) as Quaternion;
  const relative = multiplyQuaternion([-from[0], -from[1], -from[2], from[3]], target);
  const vectorLength = Math.hypot(relative[0], relative[1], relative[2]);
  if (vectorLength < 1e-12) return [0, 0, 0];
  const angleDegrees = 2 * Math.atan2(vectorLength, Math.max(0, relative[3])) * 180 / Math.PI;
  return [relative[0] / vectorLength * angleDegrees / seconds, relative[1] / vectorLength * angleDegrees / seconds, relative[2] / vectorLength * angleDegrees / seconds];
}

function quaternionFromAngularVelocity(velocity: [number, number, number], seconds: number): Quaternion {
  const magnitude = Math.hypot(...velocity);
  if (magnitude < 1e-12) return [0, 0, 0, 1];
  const halfAngle = magnitude * seconds * Math.PI / 360;
  const factor = Math.sin(halfAngle) / magnitude;
  return normalizeQuaternion([velocity[0] * factor, velocity[1] * factor, velocity[2] * factor, Math.cos(halfAngle)]);
}

function loopSeamVelocity(track: AnimationRecipe['tracks'][number], duration: number) {
  const step = Math.min(duration / 1000, 1 / 240);
  const start = sampleTrack(track, 0, new WeakMap<object, Transform>());
  const afterStart = sampleTrack(track, step, new WeakMap<object, Transform>());
  const beforeEnd = sampleTrack(track, duration - step, new WeakMap<object, Transform>());
  const end = sampleTrack(track, duration, new WeakMap<object, Transform>());
  const outgoingPosition = start.position.map((value, axis) => (afterStart.position[axis]! - value) / step) as [number, number, number];
  const incomingPosition = beforeEnd.position.map((value, axis) => (end.position[axis]! - value) / step) as [number, number, number];
  const outgoingAngular = angularVelocityDegrees(start.rotation, afterStart.rotation, step);
  const incomingAngular = angularVelocityDegrees(beforeEnd.rotation, end.rotation, step);
  return {
    step,
    start, end,
    outgoingPosition, incomingPosition, outgoingAngular, incomingAngular,
    positionGap: Math.hypot(...outgoingPosition.map((value, axis) => value - incomingPosition[axis]!)),
    angularGap: Math.hypot(...outgoingAngular.map((value, axis) => value - incomingAngular[axis]!)),
  };
}

function multiplyQuaternion(left: Quaternion, right: Quaternion): Quaternion {
  const [x, y, z, w] = left, [a, b, c, d] = right;
  return normalizeQuaternion([w * a + x * d + y * c - z * b, w * b - x * c + y * d + z * a, w * c + x * b - y * a + z * d, w * d - x * a - y * b - z * c]);
}

function transform(key: AnimationRecipe['tracks'][number]['keys'][number], cache: WeakMap<object, Transform>): Transform {
  const cached = cache.get(key);
  if (cached) return cached;
  const result: Transform = { position: [...key.position] as [number, number, number], rotation: eulerXYZDegreesToQuaternion(key.rotation) };
  cache.set(key, result);
  return result;
}

function interpolateQuaternion(from: Quaternion, to: Quaternion, alpha: number): Quaternion {
  let target = to;
  let dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) { target = to.map(value => -value) as Quaternion; dot = -dot; }
  if (dot > 0.9995) return normalizeQuaternion(from.map((value, index) => value + (target[index]! - value) * alpha) as Quaternion);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))), sine = Math.sin(angle);
  return normalizeQuaternion(from.map((value, index) => value * Math.sin((1 - alpha) * angle) / sine + target[index]! * Math.sin(alpha * angle) / sine) as Quaternion);
}

function interpolateTransform(from: Transform, to: Transform, alpha: number): Transform {
  return { position: from.position.map((value, axis) => value + (to.position[axis]! - value) * alpha) as [number, number, number], rotation: interpolateQuaternion(from.rotation, to.rotation, alpha) };
}

function rotateVector(rotation: Quaternion, vector: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = rotation;
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [vector[0] + w * tx + y * tz - z * ty, vector[1] + w * ty + z * tx - x * tz, vector[2] + w * tz + x * ty - y * tx];
}

function multiplyTransform(left: Transform, right: Transform): Transform {
  const offset = rotateVector(left.rotation, right.position);
  return { position: left.position.map((value, axis) => value + offset[axis]!) as [number, number, number], rotation: multiplyQuaternion(left.rotation, right.rotation) };
}

const identityTransform: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function tracksForJoint(recipe: AnimationRecipe, joint: string) {
  return [
    ...recipe.tracks.filter(track => track.joint === joint),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.filter(track => track.joint === joint)),
    ...(recipe.rootMotion?.joint === joint ? [recipe.rootMotion] : []),
  ];
}

function compressTrackKeys(track: AnimationRecipe['tracks'][number], recipe: AnimationRecipe, options: Extract<AnimationPatchOperation, { operation: 'compress_track' }>) {
  const originalKeys = track.keys;
  const protectedIndices = new Set<number>([0, originalKeys.length - 1]);
  for (let index = 1; index < originalKeys.length - 1; index++) {
    const key = originalKeys[index]!;
    const inContact = options.protectContactKeys && (recipe.contacts ?? []).some(contact => key.time >= contact.start && key.time <= contact.end);
    const atMarker = options.protectMarkerKeys && recipe.markers.some(marker => Math.abs(marker.time - key.time) <= MARKER_KEY_PROTECTION_TOLERANCE_SECONDS);
    if (inContact || atMarker) protectedIndices.add(index);
  }
  const contactBoundaries = (recipe.contacts ?? []).flatMap(contact => [contact.start, contact.end]);
  const markerTimes = recipe.markers.map(marker => marker.time);
  const sampleTimes = new Set<number>([0, recipe.duration, ...originalKeys.map(key => key.time), ...contactBoundaries, ...markerTimes]);
  const gridIntervals = Math.ceil(recipe.duration * options.sampleRateHz);
  for (let index = 1; index < gridIntervals; index++) sampleTimes.add(recipe.duration * index / gridIntervals);
  for (let index = 1; index < originalKeys.length; index++) {
    const left = originalKeys[index - 1]!, right = originalKeys[index]!;
    for (const fraction of [0.25, 0.5, 0.75]) sampleTimes.add(left.time + (right.time - left.time) * fraction);
  }
  const orderedTimes = [...sampleTimes].sort((left, right) => left - right);
  if (orderedTimes.length > 8192) throw new Error(`Compression of ${track.joint} requires ${orderedTimes.length} validation samples (limit 8192); lower sampleRateHz.`);
  const originalTrack = { joint: track.joint, keys: structuredClone(originalKeys) };
  const retained = new Set(protectedIndices);
  const sampleError = (candidateKeys: AnimationRecipe['tracks'][number]['keys'], time: number) => {
    const sourcePose = sampleTrack(originalTrack, time, new WeakMap<object, Transform>());
    const candidatePose = sampleTrack({ joint: track.joint, keys: candidateKeys }, time, new WeakMap<object, Transform>());
    const positionError = Math.hypot(...sourcePose.position.map((value, axis) => value - candidatePose.position[axis]!));
    const rotationError = angularDistanceDegrees(sourcePose.rotation, candidatePose.rotation);
    return { positionError, rotationError };
  };
  const buildCandidate = () => [...retained].sort((a, b) => a - b).map(index => structuredClone(originalKeys[index]!));
  for (;;) {
    const candidateKeys = buildCandidate();
    let worst: { time: number; positionError: number; rotationError: number; normalizedError: number } | undefined;
    for (const time of orderedTimes) {
      const error = sampleError(candidateKeys, time);
      const positionRatio = options.maxPositionErrorStuds === 0 ? (error.positionError <= 1e-9 ? 0 : Number.POSITIVE_INFINITY) : error.positionError / options.maxPositionErrorStuds;
      const rotationRatio = options.maxRotationErrorDegrees === 0 ? (error.rotationError <= 1e-7 ? 0 : Number.POSITIVE_INFINITY) : error.rotationError / options.maxRotationErrorDegrees;
      const normalizedError = Math.max(positionRatio, rotationRatio);
      if (normalizedError > 1 + 1e-9 && (!worst || normalizedError > worst.normalizedError + 1e-9 || (Math.abs(normalizedError - worst.normalizedError) <= 1e-9 && time < worst.time))) {
        worst = { time, ...error, normalizedError };
      }
    }
    if (!worst) break;
    let leftOriginalIndex = 0;
    const orderedRetained = [...retained].sort((a, b) => a - b);
    for (let index = 1; index < orderedRetained.length; index++) {
      if (originalKeys[orderedRetained[index]!]!.time >= worst.time) break;
      leftOriginalIndex = orderedRetained[index]!;
    }
    const rightOriginalIndex = orderedRetained.find(index => originalKeys[index]!.time > worst!.time) ?? originalKeys.length - 1;
    const splitCandidates = Array.from({ length: Math.max(0, rightOriginalIndex - leftOriginalIndex - 1) }, (_, offset) => leftOriginalIndex + offset + 1)
      .filter(index => !retained.has(index));
    if (!splitCandidates.length) throw new Error(`Compression could not meet the requested error tolerance for ${track.joint} near ${formatAnimationTime(worst.time)}s without adding keys. Relax the tolerance or preserve the original track.`);
    splitCandidates.sort((left, right) => Math.abs(originalKeys[left]!.time - worst!.time) - Math.abs(originalKeys[right]!.time - worst!.time) || left - right);
    retained.add(splitCandidates[0]!);
  }
  const keys = buildCandidate();
  let maxPositionErrorStuds = 0, maxPositionErrorAt = 0, maxRotationErrorDegrees = 0, maxRotationErrorAt = 0;
  for (const time of orderedTimes) {
    const error = sampleError(keys, time);
    if (error.positionError > maxPositionErrorStuds) { maxPositionErrorStuds = error.positionError; maxPositionErrorAt = time; }
    if (error.rotationError > maxRotationErrorDegrees) { maxRotationErrorDegrees = error.rotationError; maxRotationErrorAt = time; }
  }
  return {
    keys,
    report: { originalKeys: originalKeys.length, retainedKeys: keys.length, removedKeys: originalKeys.length - keys.length,
      protectedKeys: protectedIndices.size, sampleRateHz: options.sampleRateHz, sampleCount: orderedTimes.length,
      maxPositionErrorStuds: Math.round(maxPositionErrorStuds * 1e9) / 1e9, maxPositionErrorAt,
      maxRotationErrorDegrees: Math.round(maxRotationErrorDegrees * 1e7) / 1e7, maxRotationErrorAt,
      positionToleranceStuds: options.maxPositionErrorStuds, rotationToleranceDegrees: options.maxRotationErrorDegrees,
      toleranceSatisfiedAtSamples: maxPositionErrorStuds <= options.maxPositionErrorStuds + 1e-9 && maxRotationErrorDegrees <= options.maxRotationErrorDegrees + 1e-7 },
  };
}

export type ComposedChannelOverride = { layerId: string | null; time: number; position: [number, number, number]; rotation: [number, number, number] };

function composedJointEvaluationSampler(recipe: AnimationRecipe, joint: string, transformCache: WeakMap<object, Transform>, override?: ComposedChannelOverride) {
  type Track = AnimationRecipe['tracks'][number];
  type Source = { kind: 'base' | 'layer' | 'root_motion'; track: Track; layerId?: string; layerName?: string;
    blendMode?: 'Override' | 'Additive'; weight: number; applied: boolean; sampled: Transform;
    before: Transform; after: Transform };
  const base = recipe.tracks.find(track => track.joint === joint);
  const layers = (recipe.layers ?? []).flatMap(layer => {
    const track = layer.tracks.find(candidate => candidate.joint === joint);
    return track ? [{ track, id: layer.id, name: layer.name, weight: layer.weight, blendMode: layer.blendMode, enabled: layer.enabled }] : [];
  });
  const rootMotion = recipe.rootMotion?.joint === joint ? recipe.rootMotion : undefined;
  return (time: number): Transform & { sources: Source[] } => {
    let value = identityTransform;
    const sources: Source[] = [];
    if (base) {
      const before = value;
      value = override?.layerId === null && override.time === time
        ? { position: [...override.position] as [number, number, number], rotation: eulerXYZDegreesToQuaternion(override.rotation) }
        : sampleTrack(base, time, transformCache);
      sources.push({ kind: 'base', track: base, weight: 1, applied: true, sampled: value, before, after: value });
    }
    for (const layer of layers) {
      const sampled = override?.layerId === layer.id && override.time === time
        ? { position: [...override.position] as [number, number, number], rotation: eulerXYZDegreesToQuaternion(override.rotation) }
        : sampleTrack(layer.track, time, transformCache);
      const before = value;
      const applied = layer.enabled && layer.weight > 0;
      if (applied) {
        value = layer.blendMode === 'Additive'
          ? multiplyTransform(value, interpolateTransform(identityTransform, sampled, layer.weight))
          : interpolateTransform(value, sampled, layer.weight);
      }
      sources.push({ kind: 'layer', track: layer.track, layerId: layer.id, layerName: layer.name,
        blendMode: layer.blendMode, weight: layer.weight, applied, sampled, before, after: value });
    }
    if (rootMotion) {
      const sampled = sampleTrack(rootMotion, time, transformCache);
      const before = value;
      value = multiplyTransform(value, sampled);
      sources.push({ kind: 'root_motion', track: rootMotion, weight: 1, applied: true, sampled, before, after: value });
    }
    return { ...value, sources };
  };
}

function composedJointSampler(recipe: AnimationRecipe, joint: string, transformCache: WeakMap<object, Transform>) {
  const evaluate = composedJointEvaluationSampler(recipe, joint, transformCache);
  return (time: number): Transform => {
    const { position, rotation } = evaluate(time);
    return { position, rotation };
  };
}

/** Create a cached sampler matching patch composition; optionally substitute one exact channel sample without cloning the recipe. */
export function createComposedJointSampler(recipe: AnimationRecipe, joint: string, override?: ComposedChannelOverride) {
  if (!tracksForJoint(recipe, joint).length) return null;
  const evaluate = composedJointEvaluationSampler(recipe, joint, new WeakMap<object, Transform>(), override);
  return (time: number): Transform => {
    const { position, rotation } = evaluate(time);
    return { position, rotation };
  };
}

/** Create a cached sampler that also explains which authored channels formed the local pose. */
export function createComposedJointEvaluationSampler(recipe: AnimationRecipe, joint: string) {
  if (!tracksForJoint(recipe, joint).length) return null;
  return composedJointEvaluationSampler(recipe, joint, new WeakMap<object, Transform>());
}

function trackForRegion(recipe: AnimationRecipe, region: PreservationRegion) {
  if (region.scope === 'composed') {
    const tracks = tracksForJoint(recipe, region.joint);
    if (!tracks.length) throw new Error(`Protected composed motion cannot find any track for ${region.joint}.`);
    return tracks;
  }
  const layer = region.layerId ? recipe.layers?.find(candidate => candidate.id === region.layerId) : undefined;
  if (region.layerId && !layer) throw new Error(`Protected motion references missing layer ${region.layerId}.`);
  const track = (layer ? layer.tracks : recipe.tracks).find(candidate => candidate.joint === region.joint);
  if (!track) throw new Error(`Protected motion cannot find ${region.joint}${layer ? ` in layer ${layer.name}` : ' in base tracks'}.`);
  return [track];
}

function preservationSignature(recipe: AnimationRecipe, region: PreservationRegion) {
  if (region.scope === 'track') return JSON.stringify({ duration: recipe.duration, track: trackForRegion(recipe, region)[0] });
  trackForRegion(recipe, region);
  const base = recipe.tracks.find(track => track.joint === region.joint);
  const layers = (recipe.layers ?? []).flatMap(layer => {
    const track = layer.tracks.find(candidate => candidate.joint === region.joint);
    return track ? [{ enabled: layer.enabled, weight: layer.weight, blendMode: layer.blendMode, track }] : [];
  });
  const rootMotion = recipe.rootMotion?.joint === region.joint ? recipe.rootMotion : undefined;
  return JSON.stringify({ duration: recipe.duration, base, layers, rootMotion });
}

/** Sample-evaluates an authored joint lane over a protected interval; it never edits either recipe. */
export function verifyMotionPreservation(source: AnimationRecipe, candidate: AnimationRecipe, rawRegions: unknown) {
  const regions = preservationRegionsSchema.parse(rawRegions);
  const transformCache = new WeakMap<object, Transform>();
  return regions.map(region => {
    const resolveRange = (recipe: AnimationRecipe) => {
      if (!region.phase) return { startTime: region.startTime!, endTime: region.endTime! };
      const phase = extractActionPhaseWindows(recipe).phases.find(item => item.label === region.phase!.label && item.occurrence === region.phase!.occurrence);
      if (!phase) throw new Error(`Protected phase ${region.phase.label} #${region.phase.occurrence} was not found in animation "${recipe.name}". Add matching semantic markers or use an absolute-time guard.`);
      return {
        startTime: phase.startTime + (phase.endTime - phase.startTime) * region.phase!.startProgress,
        endTime: phase.startTime + (phase.endTime - phase.startTime) * region.phase!.endProgress,
      };
    };
    const sourceRange = resolveRange(source);
    const candidateRange = resolveRange(candidate);
    if (sourceRange.startTime < 0 || sourceRange.endTime > source.duration || candidateRange.startTime < 0 || candidateRange.endTime > candidate.duration) {
      throw new Error(`Protected interval for ${region.joint} must fit both source (${source.duration}s) and candidate (${candidate.duration}s) clips.`);
    }
    const sourceSignature = preservationSignature(source, region);
    const candidateSignature = preservationSignature(candidate, region);
    const reportRange = region.phase
      ? { phase: region.phase, sourceStartTime: sourceRange.startTime, sourceEndTime: sourceRange.endTime, candidateStartTime: candidateRange.startTime, candidateEndTime: candidateRange.endTime }
      : { startTime: sourceRange.startTime, endTime: sourceRange.endTime };
    if (sourceSignature === candidateSignature && sourceRange.startTime === candidateRange.startTime && sourceRange.endTime === candidateRange.endTime) return {
      joint: region.joint, scope: region.scope, ...(region.layerId ? { layerId: region.layerId } : {}), ...reportRange, sampleRateHz: region.sampleRateHz,
      verificationMethod: 'exact_channel_match' as const, sampleCount: 0, positionTolerance: region.positionTolerance, rotationToleranceDegrees: region.rotationToleranceDegrees,
      maxPositionDrift: 0, positionAt: sourceRange.startTime, candidatePositionAt: candidateRange.startTime,
      maxRotationDriftDegrees: 0, rotationAt: sourceRange.startTime, candidateRotationAt: candidateRange.startTime,
    };
    const sourceTracks = trackForRegion(source, region);
    const candidateTracks = trackForRegion(candidate, region);
    const sampleSource = region.scope === 'composed' ? composedJointSampler(source, region.joint, transformCache) : (time: number) => sampleTrack(sourceTracks[0]!, time, transformCache);
    const sampleCandidate = region.scope === 'composed' ? composedJointSampler(candidate, region.joint, transformCache) : (time: number) => sampleTrack(candidateTracks[0]!, time, transformCache);
    const sourceLength = sourceRange.endTime - sourceRange.startTime;
    const candidateLength = candidateRange.endTime - candidateRange.startTime;
    const progress = new Set<number>([0, 1]);
    for (const [tracks, range, length] of [[sourceTracks, sourceRange, sourceLength], [candidateTracks, candidateRange, candidateLength]] as const) {
      for (const track of tracks) {
        for (const key of track.keys) if (key.time >= range.startTime && key.time <= range.endTime) progress.add((key.time - range.startTime) / length);
        for (let index = 1; index < track.keys.length; index++) {
          const left = track.keys[index - 1]!, right = track.keys[index]!;
          const start = Math.max(range.startTime, left.time), end = Math.min(range.endTime, right.time);
          if (end <= start) continue;
          for (const fraction of [0.25, 0.5, 0.75]) progress.add((start + (end - start) * fraction - range.startTime) / length);
        }
      }
    }
    const gridIntervals = Math.ceil(Math.max(sourceLength, candidateLength) * region.sampleRateHz);
    for (let index = 1; index < gridIntervals; index++) progress.add(index / gridIntervals);
    const orderedProgress = [...progress].filter(value => value >= 0 && value <= 1).sort((a, b) => a - b);
    if (orderedProgress.length > 8192) throw new Error(`Protected ${region.phase ? `phase ${region.phase.label}` : 'interval'} for ${region.joint} requires ${orderedProgress.length} evaluations (limit 8192); narrow the range, lower sampleRateHz, or use scope: track.`);
    let maxPositionDrift = 0, positionAt = sourceRange.startTime, candidatePositionAt = candidateRange.startTime;
    let maxRotationDriftDegrees = 0, rotationAt = sourceRange.startTime, candidateRotationAt = candidateRange.startTime;
    for (const amount of orderedProgress) {
      const sourceTime = sourceRange.startTime + sourceLength * amount;
      const candidateTime = candidateRange.startTime + candidateLength * amount;
      const before = sampleSource(sourceTime);
      const after = sampleCandidate(candidateTime);
      const positionDrift = Math.hypot(...before.position.map((value, axis) => value - after.position[axis]!));
      const dot = Math.min(1, Math.abs(before.rotation.reduce((sum, value, axis) => sum + value * after.rotation[axis]!, 0)));
      const rotationDrift = 2 * Math.acos(dot) * 180 / Math.PI;
      if (positionDrift > maxPositionDrift) { maxPositionDrift = positionDrift; positionAt = sourceTime; candidatePositionAt = candidateTime; }
      if (rotationDrift > maxRotationDriftDegrees) { maxRotationDriftDegrees = rotationDrift; rotationAt = sourceTime; candidateRotationAt = candidateTime; }
    }
    const result = {
      joint: region.joint, scope: region.scope, ...(region.layerId ? { layerId: region.layerId } : {}), ...reportRange, sampleRateHz: region.sampleRateHz,
      verificationMethod: region.phase ? 'sampled_normalized_phase_progress' as const
        : region.scope === 'composed' ? 'sampled_composed_pose' as const : 'sampled_track' as const,
      sampleCount: orderedProgress.length, positionTolerance: region.positionTolerance, rotationToleranceDegrees: region.rotationToleranceDegrees,
      maxPositionDrift: Math.round(maxPositionDrift * 1e6) / 1e6, positionAt, candidatePositionAt,
      maxRotationDriftDegrees: Math.round(maxRotationDriftDegrees * 1e6) / 1e6, rotationAt, candidateRotationAt,
    };
    if (maxPositionDrift > region.positionTolerance || maxRotationDriftDegrees > region.rotationToleranceDegrees) {
      throw new Error(`Protected motion changed for ${region.joint}${region.layerId ? ` in layer ${region.layerId}` : ''}${region.phase ? ` in ${region.phase.label} #${region.phase.occurrence}` : ` during ${sourceRange.startTime}-${sourceRange.endTime}s`}: position drift ${result.maxPositionDrift} studs at source ${positionAt}s / candidate ${candidatePositionAt}s (limit ${region.positionTolerance}); angular drift ${result.maxRotationDriftDegrees}° at source ${rotationAt}s / candidate ${candidateRotationAt}s (limit ${region.rotationToleranceDegrees}). No revision was saved.`);
    }
    return result;
  });
}

export function patchAnimation(source: AnimationRecipe, rawOperations: unknown, layerIdFactory?: (operationIndex: number) => string) {
  const operations = animationPatchSchema.parse(rawOperations);
  const recipe = animationSchema.parse(structuredClone(source));
  const changes: AnimationPatchChange[] = [];

  for (const [operationIndex, operation] of operations.entries()) {
    if (operation.operation === 'adjust_phase') {
      const matchingMarkers = (name: string) => recipe.markers
        .map((marker, index) => ({ marker, index }))
        .filter(item => item.marker.name.toLowerCase() === name.toLowerCase())
        .sort((left, right) => left.marker.time - right.marker.time || left.index - right.index);
      const start = matchingMarkers(operation.startMarker)[operation.startOccurrence - 1]?.marker;
      const end = matchingMarkers(operation.endMarker)[operation.endOccurrence - 1]?.marker;
      if (!start) throw new Error(`Start marker ${operation.startMarker} occurrence ${operation.startOccurrence} was not found; read the animation markers and choose an existing phase boundary.`);
      if (!end) throw new Error(`End marker ${operation.endMarker} occurrence ${operation.endOccurrence} was not found; read the animation markers and choose an existing phase boundary.`);
      if (end.time <= start.time || sameKeyTime(end.time, start.time)) throw new Error('The selected phase markers must define a positive time interval.');

      const positionOffset = operation.positionOffset ?? [0, 0, 0];
      const rotationOffset = operation.rotationOffset ?? [0, 0, 0];
      const tracks = operation.layerId
        ? recipe.layers?.find(layer => layer.id === operation.layerId)?.tracks
        : recipe.tracks;
      if (!tracks) throw new Error(`No animation layer with ID ${operation.layerId}. Read the recipe and use an existing layer ID.`);
      const plans = operation.joints.map(joint => {
        const track = tracks.find(candidate => candidate.joint === joint);
        if (!track) throw new Error(`No animation track for ${joint}${operation.layerId ? ` in layer ${operation.layerId}` : ''}. Read the recipe and target an existing joint track.`);
        const startKeyIndex = findKeyIndex(track, start.time);
        const endKeyIndex = findKeyIndex(track, end.time);
        if (startKeyIndex >= endKeyIndex) throw new Error(`Phase boundary keys on ${joint} are not in chronological order.`);
        const contactOverlaps = (recipe.contacts ?? []).filter(contact => contact.effector.toLowerCase() === joint.toLowerCase()
          && contact.start < end.time && contact.end > start.time);
        if (contactOverlaps.length && !operation.allowDeclaredContactOverlap) {
          const descriptions = contactOverlaps.map(contact => `${contact.kind} ${contact.effector} ${contact.start}-${contact.end}s`).join(', ');
          throw new Error(`Phase adjustment for ${joint} overlaps declared contact ${descriptions}. Set allowDeclaredContactOverlap=true only when changing that contact is intentional; rerun the contact acceptance checks afterward.`);
        }
        const keys = track.keys.slice(startKeyIndex + 1, endKeyIndex).map(key => {
          const progress = (key.time - start.time) / (end.time - start.time);
          const fadeIn = progress < operation.fadeInProgress
            ? easeProgress(operation.easingStyle, operation.easingDirection, progress / operation.fadeInProgress)
            : 1;
          const fadeOut = progress > 1 - operation.fadeOutProgress
            ? easeProgress(operation.easingStyle, operation.easingDirection, (1 - progress) / operation.fadeOutProgress)
            : 1;
          const weight = Math.min(fadeIn, fadeOut);
          if (weight <= 1e-9) return undefined;
          const originalRotation = [...key.rotation] as [number, number, number];
          const targetEuler = originalRotation.map((value, axis) => value + rotationOffset[axis]! * weight) as [number, number, number];
          const composed = quaternionToEulerXYZDegrees(multiplyQuaternion(
            eulerXYZDegreesToQuaternion(originalRotation),
            eulerXYZDegreesToQuaternion(rotationOffset.map(value => value * weight) as [number, number, number]),
          ));
          return {
            key,
            position: key.position.map((value, axis) => value + positionOffset[axis]! * weight) as [number, number, number],
            rotation: nearestEulerEquivalent(composed, targetEuler),
          };
        }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        if (!keys.length) throw new Error(`No interior key on ${joint} falls inside the selected phase's non-zero fade envelope. Add a breakdown key within the phase or widen its fade envelope.`);
        return { joint, track, keys, contactOverlaps };
      });

      for (const plan of plans) {
        for (const entry of plan.keys) {
          entry.key.position = entry.position;
          entry.key.rotation = entry.rotation;
        }
        changes.push({ operation: operation.operation, joint: plan.joint, time: start.time, keyCount: plan.keys.length,
          ...(operation.layerId ? { layerId: operation.layerId } : {}),
          phaseStartTime: start.time, phaseEndTime: end.time,
          phaseAdjustment: { startMarker: start.name, endMarker: end.name, startOccurrence: operation.startOccurrence, endOccurrence: operation.endOccurrence,
            startTime: start.time, endTime: end.time, fadeInProgress: operation.fadeInProgress, fadeOutProgress: operation.fadeOutProgress,
            easingStyle: operation.easingStyle, easingDirection: operation.easingDirection, changedKeys: plan.keys.length,
            overlappingDeclaredContacts: plan.contactOverlaps.map(contact => `${contact.kind}:${contact.effector}@${contact.start}-${contact.end}`) } });
      }
      continue;
    }
    if (operation.operation === 'retime_phase') {
      const matchingMarkers = (name: string) => recipe.markers
        .map((marker, index) => ({ marker, index }))
        .filter(item => item.marker.name.toLowerCase() === name.toLowerCase())
        .sort((left, right) => left.marker.time - right.marker.time || left.index - right.index);
      const start = matchingMarkers(operation.startMarker)[operation.startOccurrence - 1]?.marker;
      const end = matchingMarkers(operation.endMarker)[operation.endOccurrence - 1]?.marker;
      if (!start) throw new Error(`Start marker ${operation.startMarker} occurrence ${operation.startOccurrence} was not found; read the animation markers and choose an existing boundary.`);
      if (!end) throw new Error(`End marker ${operation.endMarker} occurrence ${operation.endOccurrence} was not found; read the animation markers and choose an existing boundary.`);
      const startTime = start.time, endTime = end.time;
      const previousPhaseDuration = endTime - startTime;
      if (previousPhaseDuration <= 0 || sameKeyTime(endTime, startTime)) throw new Error('The selected phase markers must define a positive time interval.');
      if (sameKeyTime(operation.newDuration, previousPhaseDuration)) throw new Error(`The selected phase already has a duration of ${previousPhaseDuration}s.`);
      const delta = operation.newDuration - previousPhaseDuration;
      const previousDuration = recipe.duration;
      const newClipDuration = previousDuration + delta;
      if (newClipDuration < 0.1 || newClipDuration > 30) throw new Error(`Retiming this phase would make the clip ${formatAnimationTime(newClipDuration)}s; total duration must stay between 0.1 and 30s.`);
      const scale = operation.newDuration / previousPhaseDuration;
      const newEndTime = startTime + operation.newDuration;
      const retimeTime = (time: number) => time < startTime ? time
        : time <= endTime ? startTime + (time - startTime) * scale
          : time + delta;
      const preflightTrack = (track: AnimationRecipe['tracks'][number], scope: string) => {
        let previous: { sourceTime: number; candidateTime: number } | undefined;
        for (const key of track.keys) {
          const candidateTime = retimeTime(key.time);
          if (previous && candidateTime <= previous.candidateTime) {
            throw new Error(`Phase retiming would collapse or reorder ${scope} track ${track.joint}: source keys at ${formatAnimationTime(previous.sourceTime)}s and ${formatAnimationTime(key.time)}s map to non-increasing candidate times (${formatAnimationTime(previous.candidateTime)}s and ${formatAnimationTime(candidateTime)}s). Choose a longer phase duration; no revision was saved.`);
          }
          previous = { sourceTime: key.time, candidateTime };
        }
      };
      for (const track of recipe.tracks) preflightTrack(track, 'base');
      if (recipe.rootMotion) preflightTrack(recipe.rootMotion, 'root-motion');
      for (const layer of recipe.layers ?? []) for (const track of layer.tracks) preflightTrack(track, `layer ${layer.name}`);
      const countMovedKeys = (tracks: AnimationRecipe['tracks']) => tracks.reduce((count, track) => count + track.keys.filter(key => !sameKeyTime(retimeTime(key.time), key.time)).length, 0);
      const timeMap: NonNullable<AnimationPatchChange['timeMap']> = [
        ...(startTime > 0 ? [{ sourceStart: 0, sourceEnd: startTime, candidateStart: 0, candidateEnd: startTime, mode: 'unchanged' as const, scale: 1, offset: 0 }] : []),
        { sourceStart: startTime, sourceEnd: endTime, candidateStart: startTime, candidateEnd: newEndTime, mode: 'scaled', scale, offset: startTime * (1 - scale) },
        ...(endTime < previousDuration ? [{ sourceStart: endTime, sourceEnd: previousDuration, candidateStart: newEndTime, candidateEnd: newClipDuration, mode: 'shifted' as const, scale: 1, offset: delta }] : []),
      ];
      const affected = {
        baseKeys: countMovedKeys(recipe.tracks),
        layerKeys: (recipe.layers ?? []).reduce((count, layer) => count + countMovedKeys(layer.tracks), 0),
        rootMotionKeys: recipe.rootMotion ? countMovedKeys([recipe.rootMotion]) : 0,
        contactIntervals: (recipe.contacts ?? []).filter(contact => !sameKeyTime(retimeTime(contact.start), contact.start) || !sameKeyTime(retimeTime(contact.end), contact.end)).length,
        markers: recipe.markers.filter(marker => !sameKeyTime(retimeTime(marker.time), marker.time)).length,
      };
      const retimeTrack = (track: AnimationRecipe['tracks'][number]) => {
        for (const key of track.keys) key.time = retimeTime(key.time);
      };
      recipe.tracks.forEach(retimeTrack);
      if (recipe.rootMotion) retimeTrack(recipe.rootMotion);
      for (const layer of recipe.layers ?? []) layer.tracks.forEach(retimeTrack);
      for (const contact of recipe.contacts ?? []) {
        contact.start = retimeTime(contact.start);
        contact.end = retimeTime(contact.end);
      }
      for (const marker of recipe.markers) marker.time = retimeTime(marker.time);
      recipe.duration = newClipDuration;
      changes.push({ operation: operation.operation, joint: 'timeline', time: startTime, newTime: newEndTime, previousDuration, newDuration: newClipDuration,
        phaseStartTime: startTime, phaseEndTime: endTime, previousPhaseDuration, newPhaseDuration: operation.newDuration, timeMap, affected });
      continue;
    }
    if (operation.operation === 'retime_clip') {
      const previousDuration = recipe.duration;
      if (operation.duration === previousDuration) throw new Error(`The clip already has a duration of ${previousDuration}s.`);
      const scale = operation.duration / previousDuration;
      const scaleTime = (time: number) => time === 0 ? 0 : time === previousDuration ? operation.duration : time * scale;
      const retimeTrack = (track: AnimationRecipe['tracks'][number]) => {
        for (const key of track.keys) key.time = scaleTime(key.time);
      };
      recipe.tracks.forEach(retimeTrack);
      if (recipe.rootMotion) retimeTrack(recipe.rootMotion);
      for (const layer of recipe.layers ?? []) layer.tracks.forEach(retimeTrack);
      for (const contact of recipe.contacts ?? []) {
        contact.start = scaleTime(contact.start);
        contact.end = scaleTime(contact.end);
      }
      for (const marker of recipe.markers) marker.time = scaleTime(marker.time);
      recipe.duration = operation.duration;
      changes.push({ operation: operation.operation, joint: 'timeline', time: previousDuration, previousDuration, newDuration: operation.duration });
      continue;
    }
    if (operation.operation === 'smooth_loop_seam') {
      if (!recipe.loop) throw new Error('Loop seam smoothing requires an animation already marked as looping. Use close_loop first when its endpoint poses do not match.');
      type SeamTarget = { track: AnimationRecipe['tracks'][number]; channel: 'base' | 'layer' | 'rootMotion'; layerId?: string };
      let targets: SeamTarget[];
      if (operation.layerId) {
        const layer = recipe.layers?.find(candidate => candidate.id === operation.layerId);
        if (!layer) throw new Error(`No animation layer with ID ${operation.layerId}.`);
        const track = layer.tracks.find(candidate => candidate.joint === operation.joint);
        if (!track) throw new Error(`No animation track for ${operation.joint} in layer ${layer.name}.`);
        targets = [{ track, channel: 'layer', layerId: layer.id }];
      } else {
        const base = recipe.tracks.filter(track => !operation.joint || track.joint === operation.joint).map(track => ({ track, channel: 'base' as const }));
        const layers = (recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0)
          .flatMap(layer => layer.tracks.filter(track => !operation.joint || track.joint === operation.joint).map(track => ({ track, channel: 'layer' as const, layerId: layer.id })));
        const root = recipe.rootMotion && (!operation.joint || recipe.rootMotion.joint === operation.joint) ? [{ track: recipe.rootMotion, channel: 'rootMotion' as const }] : [];
        targets = [...base, ...layers, ...root];
      }
      if (!targets.length) throw new Error(`No active loop track${operation.joint ? ` for ${operation.joint}` : ''} matched the smoothing request.`);
      const skipped: { channel: 'base' | 'layer' | 'rootMotion'; joint: string; reason: string }[] = [];
      const changed: SeamTarget[] = [];
      const beforeMetrics: ReturnType<typeof loopSeamVelocity>[] = [];
      for (const target of targets) {
        const { track, channel } = target;
        if (track.keys.length < 4) {
          skipped.push({ channel, joint: track.joint, reason: 'At least four keys are required to adjust the first and last interior poses independently.' });
          continue;
        }
        const firstInterior = track.keys[1]!, lastInterior = track.keys.at(-2)!;
        if (firstInterior.time >= lastInterior.time) {
          skipped.push({ channel, joint: track.joint, reason: 'The first and last seam handles resolve to the same key.' });
          continue;
        }
        const protectedContact = operation.protectContacts && (recipe.contacts ?? []).find(contact => contact.effector.toLowerCase() === track.joint.toLowerCase()
          && (contact.start < firstInterior.time && contact.end > 0 || contact.start < recipe.duration && contact.end > lastInterior.time));
        if (protectedContact) {
          skipped.push({ channel, joint: track.joint, reason: `A declared ${protectedContact.kind} contact for this joint overlaps a seam handle; its poses were preserved.` });
          continue;
        }
        const before = loopSeamVelocity(track, recipe.duration);
        beforeMetrics.push(before);
        const meanPosition = before.outgoingPosition.map((value, axis) => (value + before.incomingPosition[axis]!) / 2) as [number, number, number];
        const meanAngular = before.outgoingAngular.map((value, axis) => (value + before.incomingAngular[axis]!) / 2) as [number, number, number];
        const outgoingPosition = before.outgoingPosition.map((value, axis) => value + (meanPosition[axis]! - value) * operation.strength) as [number, number, number];
        const incomingPosition = before.incomingPosition.map((value, axis) => value + (meanPosition[axis]! - value) * operation.strength) as [number, number, number];
        const outgoingAngular = before.outgoingAngular.map((value, axis) => value + (meanAngular[axis]! - value) * operation.strength) as [number, number, number];
        const incomingAngular = before.incomingAngular.map((value, axis) => value + (meanAngular[axis]! - value) * operation.strength) as [number, number, number];
        const startTransform = transform(track.keys[0]!, new WeakMap<object, Transform>());
        const endTransform = transform(track.keys.at(-1)!, new WeakMap<object, Transform>());
        const startSeconds = firstInterior.time - track.keys[0]!.time;
        const endSeconds = track.keys.at(-1)!.time - lastInterior.time;
        firstInterior.position = startTransform.position.map((value, axis) => value + outgoingPosition[axis]! * startSeconds) as [number, number, number];
        lastInterior.position = endTransform.position.map((value, axis) => value - incomingPosition[axis]! * endSeconds) as [number, number, number];
        firstInterior.rotation = quaternionToEulerXYZDegrees(multiplyQuaternion(startTransform.rotation, quaternionFromAngularVelocity(outgoingAngular, startSeconds)));
        lastInterior.rotation = quaternionToEulerXYZDegrees(multiplyQuaternion(endTransform.rotation, quaternionFromAngularVelocity(incomingAngular.map(value => -value) as [number, number, number], endSeconds)));
        track.keys[0]!.easingStyle = 'Linear';
        track.keys[0]!.easingDirection = 'Out';
        delete track.keys[0]!.curve;
        lastInterior.easingStyle = 'Linear';
        lastInterior.easingDirection = 'Out';
        delete lastInterior.curve;
        changed.push(target);
      }
      if (!changed.length) throw new Error(`No loop tracks could be smoothed.${skipped.length ? ` ${skipped.map(item => `${item.joint}: ${item.reason}`).join(' ')}` : ''}`);
      let maxPositionVelocityDiscontinuityBefore = 0, maxPositionVelocityDiscontinuityAfter = 0;
      let maxAngularVelocityDiscontinuityBeforeDegrees = 0, maxAngularVelocityDiscontinuityAfterDegrees = 0;
      for (const before of beforeMetrics) {
        maxPositionVelocityDiscontinuityBefore = Math.max(maxPositionVelocityDiscontinuityBefore, before.positionGap);
        maxAngularVelocityDiscontinuityBeforeDegrees = Math.max(maxAngularVelocityDiscontinuityBeforeDegrees, before.angularGap);
      }
      for (const target of changed) {
        const after = loopSeamVelocity(target.track, recipe.duration);
        maxPositionVelocityDiscontinuityAfter = Math.max(maxPositionVelocityDiscontinuityAfter, after.positionGap);
        maxAngularVelocityDiscontinuityAfterDegrees = Math.max(maxAngularVelocityDiscontinuityAfterDegrees, after.angularGap);
      }
      changes.push({ operation: operation.operation, joint: operation.joint ?? 'all_active_loop_tracks', time: 0,
        ...(operation.layerId ? { layerId: operation.layerId } : {}), keyCount: changed.length * 2,
        loopSeamSmoothing: { strength: operation.strength, tracksChanged: changed.length, tracksSkipped: skipped,
          maxPositionVelocityDiscontinuityBefore, maxPositionVelocityDiscontinuityAfter,
          maxAngularVelocityDiscontinuityBeforeDegrees, maxAngularVelocityDiscontinuityAfterDegrees } });
      continue;
    }
    if (operation.operation === 'close_loop') {
      if (recipe.loop) throw new Error('The animation is already marked as looping.');
      const windowStart = recipe.duration - operation.windowSeconds;
      if (windowStart <= 0) throw new Error(`Loop-closure window must be shorter than the ${recipe.duration}s clip.`);
      const tracks = [...recipe.tracks, ...(recipe.layers ?? []).flatMap(layer => layer.tracks)];
      if (!tracks.length) throw new Error('Loop closure needs at least one base or layer pose track.');
      let maxPositionGapBefore = 0, maxAngularGapBeforeDegrees = 0;
      for (const track of tracks) {
        const start = transform(track.keys[0]!, new WeakMap<object, Transform>());
        const end = transform(track.keys.at(-1)!, new WeakMap<object, Transform>());
        maxPositionGapBefore = Math.max(maxPositionGapBefore, Math.hypot(...start.position.map((value, axis) => value - end.position[axis]!)));
        maxAngularGapBeforeDegrees = Math.max(maxAngularGapBeforeDegrees, angularDistanceDegrees(start.rotation, end.rotation));
      }
      const pending = tracks.map(track => {
        const startPose = transform(track.keys[0]!, new WeakMap<object, Transform>());
        const times = [windowStart, recipe.duration,
          ...track.keys.filter(key => key.time > windowStart && !sameKeyTime(key.time, windowStart)
            && key.time < recipe.duration && !sameKeyTime(key.time, recipe.duration)).map(key => key.time),
          ...Array.from({ length: operation.samples - 1 }, (_, index) => windowStart + operation.windowSeconds * (index + 1) / operation.samples)];
        times.sort((left, right) => left - right);
        const uniqueTimes: number[] = [];
        for (const time of times) {
          if (sameKeyTime(time, recipe.duration)) {
            if (uniqueTimes.at(-1) === undefined || !sameKeyTime(recipe.duration, uniqueTimes.at(-1)!)) uniqueTimes.push(recipe.duration);
            else uniqueTimes[uniqueTimes.length - 1] = recipe.duration;
          } else if (uniqueTimes.length === 0 || !sameKeyTime(time, uniqueTimes.at(-1)!)) uniqueTimes.push(time);
        }
        if (uniqueTimes[0] === undefined || !sameKeyTime(uniqueTimes[0], windowStart)) uniqueTimes.unshift(windowStart);
        if (uniqueTimes.at(-1) === undefined || !sameKeyTime(uniqueTimes.at(-1)!, recipe.duration)) uniqueTimes.push(recipe.duration);
        const generated = uniqueTimes.map(time => {
          const sampled = sampleTrack(track, time, new WeakMap<object, Transform>());
          const progress = (time - windowStart) / operation.windowSeconds;
          const correction = easeProgress(operation.easingStyle, operation.easingDirection, progress);
          const closed = interpolateTransform(sampled, startPose, correction);
          const isEndpoint = time === recipe.duration;
          return {
            time,
            position: isEndpoint ? [...track.keys[0]!.position] as [number, number, number] : closed.position,
            rotation: isEndpoint ? [...track.keys[0]!.rotation] as [number, number, number] : quaternionToEulerXYZDegrees(closed.rotation),
            easingStyle: 'Linear' as const,
            easingDirection: 'Out' as const,
          };
        });
        const kept = track.keys.filter(key => key.time < windowStart && !sameKeyTime(key.time, windowStart));
        if (kept.length + generated.length > 128) {
          throw new Error(`Loop closure would leave ${track.joint} with ${kept.length + generated.length} keys (limit 128). Widen the closure window or reduce samples; no revision was saved.`);
        }
        return { track, keys: [...kept, ...generated] };
      });
      const currentKeyCount = recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0)
        + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.reduce((subtotal, track) => subtotal + track.keys.length, 0), 0)
        + (recipe.rootMotion?.keys.length ?? 0);
      const nextKeyCount = currentKeyCount + pending.reduce((sum, item) => sum + item.keys.length - item.track.keys.length, 0);
      if (nextKeyCount > 4096) throw new Error(`Loop closure would exceed the 4096 total-key limit (${nextKeyCount}); widen the closure window or reduce samples.`);
      for (const item of pending) item.track.keys = item.keys;
      recipe.loop = true;
      let maxPositionGapAfter = 0, maxAngularGapAfterDegrees = 0;
      for (const { track } of pending) {
        const start = transform(track.keys[0]!, new WeakMap<object, Transform>());
        const end = transform(track.keys.at(-1)!, new WeakMap<object, Transform>());
        maxPositionGapAfter = Math.max(maxPositionGapAfter, Math.hypot(...start.position.map((value, axis) => value - end.position[axis]!)));
        maxAngularGapAfterDegrees = Math.max(maxAngularGapAfterDegrees, angularDistanceDegrees(start.rotation, end.rotation));
      }
      const generatedKeys = pending.reduce((sum, item) => sum + item.keys.length - item.track.keys.filter(key => key.time < windowStart && !sameKeyTime(key.time, windowStart)).length, 0);
      changes.push({ operation: operation.operation, joint: 'all_pose_tracks', time: windowStart, newTime: recipe.duration, keyCount: generatedKeys,
        loopClosure: { windowStart, windowEnd: recipe.duration, tracks: pending.length, generatedKeys, maxPositionGapBefore, maxAngularGapBeforeDegrees,
          maxPositionGapAfter, maxAngularGapAfterDegrees } });
      continue;
    }
    if (operation.operation === 'compress_track') {
      const track = findTrack(recipe, operation.joint, operation.layerId);
      const compressed = compressTrackKeys(track, recipe, operation);
      track.keys = compressed.keys;
      changes.push({ operation: operation.operation, joint: operation.joint, time: 0, keyCount: compressed.report.removedKeys,
        ...(operation.layerId ? { layerId: operation.layerId } : {}), compression: compressed.report });
      continue;
    }
    if (operation.operation === 'mirror_pose') {
      if (operation.time > recipe.duration) throw new Error(`Mirror time ${operation.time}s exceeds the ${recipe.duration}s clip duration.`);
      const sourceTrack = findTrack(recipe, operation.sourceJoint, operation.layerId);
      const targetTrack = findTrack(recipe, operation.targetJoint, operation.layerId);
      const sourceKey = sourceTrack.keys[findKeyIndex(sourceTrack, operation.time)]!;
      const mirroredPosition = sourceKey.position.map((value, axis) => applyComponent(value, operation.positionSigns[axis]!, 0)) as [number, number, number];
      const mirroredRotation = sourceKey.rotation.map((value, axis) => applyComponent(value, operation.rotationSigns[axis]!, 0)) as [number, number, number];
      let targetKey = targetTrack.keys.find(key => sameKeyTime(key.time, operation.time));
      if (targetKey) {
        targetKey.position = mirroredPosition;
        targetKey.rotation = mirroredRotation;
      } else {
        if (operation.time <= 0 || operation.time >= recipe.duration) throw new Error('A mirrored endpoint must already exist on the target track.');
        if (targetTrack.keys.length >= 128) throw new Error(`The ${operation.targetJoint} track already has the maximum of 128 keys.`);
        targetKey = { ...structuredClone(sourceKey), time: operation.time, position: mirroredPosition, rotation: mirroredRotation };
        targetTrack.keys.push(targetKey);
        targetTrack.keys.sort((left, right) => left.time - right.time);
      }
      changes.push({ operation: operation.operation, joint: operation.targetJoint, sourceJoint: operation.sourceJoint, time: targetKey.time, ...(operation.layerId ? { layerId: operation.layerId } : {}) });
      continue;
    }
    if (operation.operation === 'mirror_tracks') {
      const tracks = operation.layerId
        ? recipe.layers?.find(layer => layer.id === operation.layerId)?.tracks
        : recipe.tracks;
      if (!tracks) throw new Error(`No animation layer with ID ${operation.layerId}. Read the recipe and use an existing layer ID.`);
      const originalTracks = new Map(tracks.map(track => [track.joint, structuredClone(track)]));
      const destinations = operation.mappings.map(mapping => {
        const sourceTrack = originalTracks.get(mapping.sourceJoint);
        if (!sourceTrack) throw new Error(`No source animation track for ${mapping.sourceJoint}${operation.layerId ? ` in layer ${operation.layerId}` : ''}. Read the recipe and use an existing joint track.`);
        const targetIndex = tracks.findIndex(track => track.joint === mapping.targetJoint);
        if (targetIndex >= 0 && !operation.replaceExisting) throw new Error(`Track ${mapping.targetJoint} already exists. Set replaceExisting=true only if replacing the mapped targets is intended.`);
        const mirrored = {
          joint: mapping.targetJoint,
          keys: sourceTrack.keys.map(key => ({
            ...structuredClone(key),
            position: key.position.map((value, axis) => applyComponent(value, mapping.positionSigns[axis]!, 0)) as [number, number, number],
            rotation: key.rotation.map((value, axis) => applyComponent(value, mapping.rotationSigns[axis]!, 0)) as [number, number, number],
          })),
        };
        return { mapping, targetIndex, mirrored };
      });
      const newTrackCount = destinations.filter(destination => destination.targetIndex < 0).length;
      if (tracks.length + newTrackCount > 256) throw new Error('The target animation or layer would exceed the 256 joint-track limit. No tracks were changed.');
      for (const destination of destinations) {
        if (destination.targetIndex >= 0) tracks[destination.targetIndex] = destination.mirrored;
        else tracks.push(destination.mirrored);
        changes.push({ operation: operation.operation, joint: destination.mapping.targetJoint, sourceJoint: destination.mapping.sourceJoint, time: 0, keyCount: destination.mirrored.keys.length, ...(operation.layerId ? { layerId: operation.layerId } : {}) });
      }
      continue;
    }
    if (operation.operation === 'transform_track') {
      const sourceJoint = operation.sourceJoint ?? operation.joint;
      const sourceTrack = findTrack(recipe, sourceJoint, operation.layerId);
      const positionScale = operation.positionScale ?? [1, 1, 1];
      const positionOffset = operation.positionOffset ?? [0, 0, 0];
      const rotationScale = operation.rotationScale ?? [1, 1, 1];
      const rotationOffset = operation.rotationOffset ?? [0, 0, 0];
      const transformed = sourceTrack.keys.map(key => ({
        ...structuredClone(key),
        position: key.position.map((value, axis) => applyComponent(value, positionScale[axis]!, positionOffset[axis]!)) as [number, number, number],
        rotation: key.rotation.map((value, axis) => applyComponent(value, rotationScale[axis]!, rotationOffset[axis]!)) as [number, number, number],
      }));
      if (sourceJoint === operation.joint) {
        sourceTrack.keys = transformed;
      } else {
        const tracks = operation.layerId
          ? recipe.layers?.find(layer => layer.id === operation.layerId)?.tracks
          : recipe.tracks;
        if (!tracks) throw new Error(`No animation layer with ID ${operation.layerId}. Read the recipe and use an existing layer ID.`);
        const targetIndex = tracks.findIndex(track => track.joint === operation.joint);
        if (targetIndex >= 0 && !operation.replaceExisting) throw new Error(`Track ${operation.joint} already exists. Set replaceExisting=true only if replacing it is intended.`);
        if (targetIndex < 0 && tracks.length >= 256) throw new Error('The target animation or layer already has 256 tracks.');
        const targetTrack = { joint: operation.joint, keys: transformed };
        if (targetIndex >= 0) tracks[targetIndex] = targetTrack;
        else tracks.push(targetTrack);
      }
      changes.push({ operation: operation.operation, joint: operation.joint, sourceJoint, time: 0, keyCount: transformed.length, ...(operation.layerId ? { layerId: operation.layerId } : {}) });
      continue;
    }
    if (operation.operation === 'root_motion_set') {
      recipe.rootMotion = structuredClone(operation.track);
      changes.push({ operation: operation.operation, joint: operation.track.joint, time: 0 });
      continue;
    }
    if (operation.operation === 'root_motion_clear') {
      delete recipe.rootMotion;
      changes.push({ operation: operation.operation, joint: 'rootMotion', time: 0 });
      continue;
    }
    if (operation.operation === 'contacts_set') {
      recipe.contacts = structuredClone(operation.contacts);
      changes.push({ operation: operation.operation, joint: 'contacts', time: 0 });
      continue;
    }
    if (operation.operation === 'markers_set') {
      recipe.markers = structuredClone(operation.markers);
      changes.push({ operation: operation.operation, joint: 'events', time: 0 });
      continue;
    }
    if (operation.operation === 'layer_create' || operation.operation === 'layer_set' || operation.operation === 'layer_move' || operation.operation === 'layer_delete' || operation.operation === 'layer_set_track' || operation.operation === 'layer_delete_track') {
      recipe.layers ??= [];
      if (operation.operation === 'layer_create') {
        if (recipe.layers.length >= 32) throw new Error('An animation may contain at most 32 layers.');
        const layer = { id: layerIdFactory?.(operationIndex) ?? randomUUID(), name: operation.name, blendMode: operation.blendMode, weight: operation.weight, enabled: true, tracks: [] };
        recipe.layers.push(layer);
        changes.push({ operation: operation.operation, joint: layer.name, time: 0, layerId: layer.id });
      } else {
        const layerIndex = recipe.layers.findIndex(layer => layer.id === operation.layerId);
        if (layerIndex < 0) throw new Error(`No animation layer with ID ${operation.layerId}. Read the recipe and use an existing layer ID.`);
        const layer = recipe.layers[layerIndex]!;
        if (operation.operation === 'layer_set') {
          if (operation.enabled !== undefined) layer.enabled = operation.enabled;
          if (operation.weight !== undefined) layer.weight = operation.weight;
          if (operation.blendMode) layer.blendMode = operation.blendMode;
          changes.push({ operation: operation.operation, joint: layer.name, time: 0, layerId: layer.id });
        } else if (operation.operation === 'layer_move') {
          const targetIndex = layerIndex + (operation.direction === 'up' ? -1 : 1);
          if (targetIndex < 0 || targetIndex >= recipe.layers.length) throw new Error(`Layer ${layer.name} cannot move ${operation.direction}; it is already at the stack boundary.`);
          [recipe.layers[layerIndex], recipe.layers[targetIndex]] = [recipe.layers[targetIndex]!, recipe.layers[layerIndex]!];
          changes.push({ operation: operation.operation, joint: layer.name, time: 0, layerId: layer.id });
        } else if (operation.operation === 'layer_delete') {
          recipe.layers.splice(layerIndex, 1);
          changes.push({ operation: operation.operation, joint: layer.name, time: 0, layerId: layer.id });
        } else if (operation.operation === 'layer_set_track') {
          const existing = layer.tracks.findIndex(track => track.joint === operation.track.joint);
          if (existing < 0 && layer.tracks.length >= 256) throw new Error(`Layer ${layer.name} already has 256 tracks.`);
          if (existing < 0) layer.tracks.push(structuredClone(operation.track));
          else layer.tracks[existing] = structuredClone(operation.track);
          changes.push({ operation: operation.operation, joint: operation.track.joint, time: 0, layerId: layer.id });
        } else {
          const existing = layer.tracks.findIndex(track => track.joint === operation.joint);
          if (existing < 0) throw new Error(`No ${operation.joint} track in layer ${layer.name}.`);
          layer.tracks.splice(existing, 1);
          changes.push({ operation: operation.operation, joint: operation.joint, time: 0, layerId: layer.id });
        }
      }
      continue;
    }
    if (operation.operation === 'offset_pose_group') {
      if (operation.time > recipe.duration) throw new Error(`Patch time ${operation.time}s exceeds the ${recipe.duration}s clip duration.`);
      const targetTracks = operation.targets.map(target => {
        const targetLayer = operation.layerId ? recipe.layers?.find(layer => layer.id === operation.layerId) : undefined;
        const availableTracks = targetLayer ? targetLayer.tracks : recipe.tracks;
        const caseVariant = availableTracks.find(candidate => candidate.joint.toLowerCase() === target.joint.toLowerCase());
        if (caseVariant && caseVariant.joint !== target.joint) {
          throw new Error(`Joint ${target.joint} does not exactly match recipe track ${caseVariant.joint}; use the exact case-sensitive joint name from the recipe.`);
        }
        const track = findTrack(recipe, target.joint, operation.layerId);
        return track;
      });
      const plans = operation.targets.map((target, targetIndex) => {
        const track = targetTracks[targetIndex]!;
        let key = track.keys.find(candidate => sameKeyTime(candidate.time, operation.time));
        let insertedKey = false;
        if (!key) {
          if (!operation.insertIfMissing) {
            findKeyIndex(track, operation.time);
            throw new Error(`No key on ${track.joint} at ${formatAnimationTime(operation.time)}s.`);
          }
          if (operation.time <= 0 || operation.time >= recipe.duration) throw new Error('Offset group breakdown keys must be inserted strictly inside the clip; start and end keys are fixed.');
          if (track.keys.length >= 128) throw new Error(`The ${target.joint} track already has the maximum of 128 keys.`);
          const pose = interpolatedPose(track, operation.time);
          key = { time: operation.time, position: pose.position, rotation: pose.rotation,
            easingStyle: pose.easingStyle, easingDirection: pose.easingDirection };
          insertedKey = true;
        }
        const before = { position: [...key.position] as [number, number, number], rotation: [...key.rotation] as [number, number, number] };
        const targetEuler = key.rotation.map((value, axis) => value + (target.rotationOffset?.[axis] ?? 0)) as [number, number, number];
        const composedRotation = quaternionToEulerXYZDegrees(multiplyQuaternion(
          eulerXYZDegreesToQuaternion(key.rotation), eulerXYZDegreesToQuaternion(target.rotationOffset ?? [0, 0, 0]),
        ));
        const after = {
          position: target.positionOffset ? key.position.map((value, axis) => value + target.positionOffset![axis]!) as [number, number, number] : [...key.position] as [number, number, number],
          rotation: target.rotationOffset ? nearestEulerEquivalent(composedRotation, targetEuler) : [...key.rotation] as [number, number, number],
        };
        return { target, track, key, insertedKey, before, after };
      });

      for (const plan of plans) {
        if (plan.insertedKey) {
          plan.track.keys.push(plan.key);
          plan.track.keys.sort((left, right) => left.time - right.time);
        }
        plan.key.position = plan.after.position;
        plan.key.rotation = plan.after.rotation;
        changes.push({ operation: operation.operation, joint: plan.target.joint, time: operation.time,
          ...(operation.layerId ? { layerId: operation.layerId } : {}), ...(plan.insertedKey ? { insertedKey: true } : {}),
          poseBefore: plan.before, poseAfter: { position: [...plan.after.position], rotation: [...plan.after.rotation] },
          poseOffset: { ...(plan.target.positionOffset ? { position: [...plan.target.positionOffset] } : {}),
            ...(plan.target.rotationOffset ? { rotation: [...plan.target.rotationOffset] } : {}) } });
      }
      continue;
    }
    const layerId = 'layerId' in operation ? operation.layerId : undefined;
    const track = findTrack(recipe, operation.joint, layerId);
    if (operation.time > recipe.duration) throw new Error(`Patch time ${operation.time}s exceeds the ${recipe.duration}s clip duration.`);

    if (operation.operation === 'set_pose') {
      const key = track.keys[findKeyIndex(track, operation.time)]!;
      if (operation.position) key.position = [...operation.position];
      if (operation.rotation) key.rotation = [...operation.rotation];
      changes.push({ operation: operation.operation, joint: operation.joint, time: key.time, ...(layerId ? { layerId } : {}) });
    } else if (operation.operation === 'offset_pose') {
      let key = track.keys.find(candidate => sameKeyTime(candidate.time, operation.time));
      let insertedKey = false;
      if (!key && operation.insertIfMissing) {
        if (operation.time <= 0 || operation.time >= recipe.duration) throw new Error('Offset breakdown keys must be inserted strictly inside the clip; start and end keys are fixed.');
        if (track.keys.length >= 128) throw new Error(`The ${operation.joint} track already has the maximum of 128 keys.`);
        const pose = interpolatedPose(track, operation.time);
        key = { time: operation.time, position: pose.position, rotation: pose.rotation,
          easingStyle: pose.easingStyle, easingDirection: pose.easingDirection };
        track.keys.push(key);
        track.keys.sort((left, right) => left.time - right.time);
        insertedKey = true;
      }
      if (!key) {
        findKeyIndex(track, operation.time);
        throw new Error(`No key on ${track.joint} at ${formatAnimationTime(operation.time)}s.`);
      }
      const positionOffset = operation.positionOffset ?? [0, 0, 0];
      const rotationOffset = operation.rotationOffset ?? [0, 0, 0];
      const poseBefore = { position: [...key.position] as [number, number, number], rotation: [...key.rotation] as [number, number, number] };
      const targetEuler = key.rotation.map((value, axis) => value + rotationOffset[axis]!) as [number, number, number];
      const composedRotation = quaternionToEulerXYZDegrees(multiplyQuaternion(
        eulerXYZDegreesToQuaternion(key.rotation), eulerXYZDegreesToQuaternion(rotationOffset),
      ));
      if (operation.positionOffset) key.position = key.position.map((value, axis) => value + positionOffset[axis]!) as [number, number, number];
      if (operation.rotationOffset) key.rotation = nearestEulerEquivalent(composedRotation, targetEuler);
      changes.push({ operation: operation.operation, joint: operation.joint, time: key.time, ...(layerId ? { layerId } : {}),
        ...(insertedKey ? { insertedKey: true } : {}),
        poseBefore, poseAfter: { position: [...key.position] as [number, number, number], rotation: [...key.rotation] as [number, number, number] },
        poseOffset: { ...(operation.positionOffset ? { position: [...operation.positionOffset] } : {}), ...(operation.rotationOffset ? { rotation: [...operation.rotationOffset] } : {}) } });
    } else if (operation.operation === 'set_easing') {
      const key = track.keys[findKeyIndex(track, operation.time)]!;
      if (operation.easingStyle) key.easingStyle = operation.easingStyle;
      if (operation.easingDirection) key.easingDirection = operation.easingDirection;
      changes.push({ operation: operation.operation, joint: operation.joint, time: key.time, ...(layerId ? { layerId } : {}) });
    } else if (operation.operation === 'set_curve') {
      const key = track.keys[findKeyIndex(track, operation.time)]!;
      key.curve = { ...operation.curve };
      key.easingStyle = 'Bezier';
      changes.push({ operation: operation.operation, joint: operation.joint, time: key.time, ...(layerId ? { layerId } : {}) });
    } else if (operation.operation === 'insert_key') {
      if (operation.time <= 0 || operation.time >= recipe.duration) throw new Error('Breakdown keys must be inserted strictly inside the clip; start and end keys are fixed.');
      if (track.keys.length >= 128) throw new Error(`The ${operation.joint} track already has the maximum of 128 keys.`);
      if (track.keys.some(key => sameKeyTime(key.time, operation.time))) throw new Error(`A key already exists on ${operation.joint} at ${formatAnimationTime(operation.time)}s.`);
      const pose = interpolatedPose(track, operation.time);
      const key = {
        time: operation.time,
        position: operation.position ? [...operation.position] as [number, number, number] : pose.position,
        rotation: operation.rotation ? [...operation.rotation] as [number, number, number] : pose.rotation,
        easingStyle: pose.easingStyle,
        easingDirection: pose.easingDirection,
      };
      track.keys.push(key);
      track.keys.sort((left, right) => left.time - right.time);
      changes.push({ operation: operation.operation, joint: operation.joint, time: operation.time, ...(layerId ? { layerId } : {}) });
    } else if (operation.operation === 'retime_key') {
      const keyIndex = findKeyIndex(track, operation.time);
      if (keyIndex === 0 || keyIndex === track.keys.length - 1) throw new Error('Clip endpoint keys are fixed and cannot be retimed.');
      const previous = track.keys[keyIndex - 1]!;
      const key = track.keys[keyIndex]!;
      const next = track.keys[keyIndex + 1]!;
      if (operation.newTime <= previous.time || operation.newTime >= next.time) throw new Error(`New time must stay strictly between neighboring keys (${formatAnimationTime(previous.time)}s and ${formatAnimationTime(next.time)}s).`);
      if (sameKeyTime(operation.newTime, key.time)) throw new Error('The key is already at that time.');
      key.time = operation.newTime;
      changes.push({ operation: operation.operation, joint: operation.joint, time: operation.time, newTime: operation.newTime, ...(layerId ? { layerId } : {}) });
    } else {
      const keyIndex = findKeyIndex(track, operation.time);
      if (keyIndex === 0 || keyIndex === track.keys.length - 1) throw new Error('Clip endpoint keys are fixed and cannot be deleted.');
      track.keys.splice(keyIndex, 1);
      changes.push({ operation: operation.operation, joint: operation.joint, time: operation.time, ...(layerId ? { layerId } : {}) });
    }
  }

  const validated = recipeSchema.parse(recipe);
  if (validated.kind !== 'animation') throw new Error('Animation patch unexpectedly produced a non-animation recipe.');
  return { recipe: validated, changes };
}

/** Stable IDs let an MCP client fingerprint a dry-run and commit that exact candidate. */
export function patchLayerIdFactory(sourceId: string, sourceFingerprint: string, operations: unknown, preserve: unknown = []) {
  const seed = JSON.stringify({ sourceId, sourceFingerprint, operations, preserve });
  return (operationIndex: number) => {
    const hex = [...createHash('sha256').update(`${seed}:${operationIndex}`).digest('hex').slice(0, 32)];
    hex[12] = '5';
    hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  };
}
