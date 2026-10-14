import { z } from 'zod';
import { bezierCurve, label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { rigSemanticRoleSchema } from './rig-semantics.js';
import { quaternionAngularDistanceDegrees } from './quaternion-blend.js';
import { quaternionToEulerXYZDegrees } from './rotation.js';
import { sampleComposedRecipeJoint } from './sequencer.js';

const phaseLabel = z.enum(['anticipation', 'main_action', 'follow_through', 'recovery']);
export const MAX_ANIMATION_BLUEPRINT_RESPONSE_BYTES = 8 * 1024 * 1024;

export function assertAnimationBlueprintResponseSize(response: unknown): void {
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new Error('Animation blueprint preview could not be serialized as JSON.');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MAX_ANIMATION_BLUEPRINT_RESPONSE_BYTES) {
    throw new Error(`Animation blueprint preview serialized response is ${serializedBytes} bytes, above the ${MAX_ANIMATION_BLUEPRINT_RESPONSE_BYTES} byte (8 MiB) safety limit. Reduce authored poses or bind to a smaller rig profile.`);
  }
}

const phaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  label: phaseLabel,
  intent: z.string().trim().min(1).max(240).optional()
    .describe('Optional short statement of the user-intended visible beat (for example, “draws the bow back before release”). Returned in preview diagnostics for AI review; not converted into a Roblox marker or runtime behavior.'),
  markerName: label.optional().describe('Optional authored animation event marker. Defaults to the semantic marker derived from label.'),
  markerProgress: z.number().finite().min(0).max(1).optional().describe('Normalized progress within this phase at which markerName is emitted. Defaults to 0 (phase start).'),
  start: z.number().finite().min(0).max(1),
  end: z.number().finite().min(0).max(1),
}).strict();
const blueprintPoseSchema = z.object({
  phaseId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  progress: z.number().finite().min(0).max(1).describe('Normalized progress inside the named phase, not the whole clip.'),
  joint: label.optional().describe('Exact driven rig-joint name from inspection. Supply this or semanticRole, never both.'),
  semanticRole: rigSemanticRoleSchema.optional().describe('Standard body role such as left_hand. Requires an inspected R6/R15 rig and resolves only recognized exact convention mappings; custom name inference is not accepted here.'),
  position: z.tuple([z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100)]).optional()
    .describe('Optional local position offset in studs. If omitted, carries forward the previous authored position for this joint (or neutral [0,0,0] before its first authored position).'),
  rotation: z.tuple([z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720)]).optional()
    .describe('Optional local XYZ Euler rotation in degrees. If omitted, carries forward the previous authored rotation for this joint (or neutral [0,0,0] before its first authored rotation).'),
  easingStyle: z.enum(['Linear', 'Constant', 'CubicV2', 'Bounce', 'Elastic', 'Bezier']).optional()
    .describe('Outgoing interpolation for the segment from this pose to the next key on this joint. A generated start boundary has default easing; easing is not copied backward from an interior pose.'),
  easingDirection: z.enum(['In', 'Out', 'InOut']).optional()
    .describe('Outgoing Roblox Pose easing direction for the segment after this key. Omitted means the recipe default (Out).'),
  curve: bezierCurve.optional().describe('Optional normalized cubic Bezier handles for the outgoing segment; supply easingStyle=Bezier. outTime/outValue and inTime/inValue shape time and pose progression. If omitted with Bezier, the recipe default curve is used.'),
}).strict()
  .refine(pose => Boolean(pose.joint) !== Boolean(pose.semanticRole), 'Specify exactly one of joint or semanticRole for each pose.')
  .refine(pose => pose.position !== undefined || pose.rotation !== undefined, 'Each pose must specify position, rotation, or both.')
  .refine(pose => pose.curve === undefined || pose.easingStyle === 'Bezier', 'Custom Bezier curve handles require easingStyle Bezier.');
const blueprintContactSchema = z.object({
  effector: label,
  kind: z.enum(['support', 'grip']),
  phaseId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  startProgress: z.number().finite().min(0).max(1),
  endProgress: z.number().finite().min(0).max(1),
}).strict();
const blueprintEventSchema = z.object({
  name: label.describe('Named in-action event such as Impact, Release, or FootPlant.'),
  phaseId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  progress: z.number().finite().min(0).max(1).describe('Normalized progress inside the named phase.'),
  value: z.string().max(500).optional(),
}).strict();
export const animationBlueprintShape = {
  name: label,
  duration: z.number().finite().min(0.1).max(30),
  loop: z.boolean().default(false),
  priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']).optional(),
  phases: z.array(phaseSchema).min(1).max(16),
  poses: z.array(blueprintPoseSchema).min(1).max(1024),
  contacts: z.array(blueprintContactSchema).max(16).default([]),
  events: z.array(blueprintEventSchema).max(84).default([])
    .describe('Optional ordinary in-action event markers. Each is placed at phaseId + normalized progress and classified as phase:event so names such as Impact do not split action phases. Roblox recipes allow at most 100 total markers.'),
};
export const animationBlueprintSchema = z.object(animationBlueprintShape).strict().superRefine((blueprint, ctx) => {
  const phaseIds = new Set<string>();
  for (const [index, phase] of blueprint.phases.entries()) {
    if (phaseIds.has(phase.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', index, 'id'], message: `Duplicate phase id ${phase.id}.` });
    phaseIds.add(phase.id);
    if (phase.end <= phase.start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', index], message: 'Each phase must have positive duration.' });
    if (index === 0 && phase.start !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', index, 'start'], message: 'The first phase must start at normalized time 0.' });
    if (index > 0 && Math.abs(phase.start - blueprint.phases[index - 1]!.end) > 1e-6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', index, 'start'], message: 'Phases must be ordered, contiguous, and non-overlapping.' });
  }
  if (Math.abs((blueprint.phases.at(-1)?.end ?? 0) - 1) > 1e-6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', blueprint.phases.length - 1, 'end'], message: 'The final phase must end at normalized time 1.' });
  for (const [index, pose] of blueprint.poses.entries()) if (!phaseIds.has(pose.phaseId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['poses', index, 'phaseId'], message: `Unknown phase id ${pose.phaseId}.` });
  for (const [index, contact] of blueprint.contacts.entries()) {
    if (!phaseIds.has(contact.phaseId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contacts', index, 'phaseId'], message: `Unknown phase id ${contact.phaseId}.` });
    if (contact.endProgress <= contact.startProgress) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contacts', index], message: 'Contact interval must have positive duration.' });
  }
  if (blueprint.phases.length + blueprint.events.length > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'Phase markers plus event markers cannot exceed the Roblox recipe limit of 100.' });
  for (const [index, event] of blueprint.events.entries()) if (!phaseIds.has(event.phaseId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'phaseId'], message: `Unknown phase id ${event.phaseId}.` });
});

export type AnimationBlueprint = z.infer<typeof animationBlueprintSchema>;

function normalizedTime(phase: AnimationBlueprint['phases'][number], progress: number, duration: number) {
  return duration * (phase.start + (phase.end - phase.start) * progress);
}

function eulerDegreesToQuaternion([xDegrees, yDegrees, zDegrees]: [number, number, number]): [number, number, number, number] {
  const [x, y, z] = [xDegrees, yDegrees, zDegrees].map(value => value * Math.PI / 360) as [number, number, number];
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

export function compileAnimationBlueprint(input: unknown) {
  const parsed = animationBlueprintSchema.parse(input);
  const blueprint = { ...parsed, poses: parsed.poses.map(pose => {
    if (!pose.joint) throw new Error(`Pose role ${pose.semanticRole ?? '(missing)'} must be resolved against a freshly inspected standard R6/R15 rig before compilation.`);
    const { semanticRole: _semanticRole, ...resolvedPose } = pose;
    return { ...resolvedPose, joint: pose.joint };
  }) };
  const phaseBoundaryNormalizations: { phaseId: string; boundary: 'start' | 'end'; authoredNormalizedTime: number; compiledNormalizedTime: number; normalizedDelta: number; secondsDelta: number }[] = [];
  const phases = blueprint.phases.map((phase, index) => ({ ...phase,
    start: index === 0 ? 0 : blueprint.phases[index - 1]!.end,
    end: index === blueprint.phases.length - 1 ? 1 : phase.end,
  }));
  for (const [index, phase] of phases.entries()) {
    const authored = blueprint.phases[index]!;
    if (authored.start !== phase.start) phaseBoundaryNormalizations.push({ phaseId: phase.id, boundary: 'start', authoredNormalizedTime: authored.start,
      compiledNormalizedTime: phase.start, normalizedDelta: phase.start - authored.start, secondsDelta: (phase.start - authored.start) * blueprint.duration });
    if (authored.end !== phase.end) phaseBoundaryNormalizations.push({ phaseId: phase.id, boundary: 'end', authoredNormalizedTime: authored.end,
      compiledNormalizedTime: phase.end, normalizedDelta: phase.end - authored.end, secondsDelta: (phase.end - authored.end) * blueprint.duration });
  }
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));
  const jointKeys = new Map<string, Map<number, AnimationRecipe['tracks'][number]['keys'][number]>>();
  const jointPoseSources = new Map<string, Map<number, { phaseId: string; progress: number }>>();
  const authoredPoses = blueprint.poses.map(pose => {
    const phase = phaseById.get(pose.phaseId)!;
    const time = normalizedTime(phase, pose.progress, blueprint.duration);
    return { pose, time };
  }).sort((left, right) => left.time - right.time
    || (left.pose.joint < right.pose.joint ? -1 : left.pose.joint > right.pose.joint ? 1 : 0)
    || (left.pose.phaseId < right.pose.phaseId ? -1 : left.pose.phaseId > right.pose.phaseId ? 1 : 0)
    || left.pose.progress - right.pose.progress);
  const poseRows = authoredPoses.map(({ pose, time }) => {
    const keys = jointKeys.get(pose.joint) ?? new Map<number, AnimationRecipe['tracks'][number]['keys'][number]>();
    const sources = jointPoseSources.get(pose.joint) ?? new Map<number, { phaseId: string; progress: number }>();
    const existingSource = sources.get(time);
    if (existingSource) throw new Error(`Joint ${pose.joint} has conflicting blueprint poses at ${time}s: phase ${existingSource.phaseId} progress ${existingSource.progress} and phase ${pose.phaseId} progress ${pose.progress} compile to the same key time. Merge their position/rotation into one directive or move one to a distinct time.`);
    const previous = [...keys.values()].at(-1);
    const key = { time, position: pose.position ?? previous?.position ?? [0, 0, 0] as [number, number, number],
      rotation: pose.rotation ?? previous?.rotation ?? [0, 0, 0] as [number, number, number],
      ...(pose.easingStyle ? { easingStyle: pose.easingStyle } : {}), ...(pose.easingDirection ? { easingDirection: pose.easingDirection } : {}),
      ...(pose.curve ? { curve: pose.curve } : {}) };
    keys.set(time, key);
    jointKeys.set(pose.joint, keys);
    sources.set(time, { phaseId: pose.phaseId, progress: pose.progress });
    jointPoseSources.set(pose.joint, sources);
    return { phaseId: pose.phaseId, phaseLabel: phaseById.get(pose.phaseId)!.label, progress: pose.progress, joint: pose.joint, time,
      position: key.position, rotation: key.rotation,
      ...(key.easingStyle ? { easingStyle: key.easingStyle } : {}), ...(key.easingDirection ? { easingDirection: key.easingDirection } : {}),
      ...(key.curve ? { curve: key.curve } : {}) };
  });
  const loopEndpointOverrides: { joint: string; time: number; authoredPosition: [number, number, number]; authoredRotation: [number, number, number]; loopPosition: [number, number, number]; loopRotation: [number, number, number] }[] = [];
  const tracks = [...jointKeys].map(([joint, authored]) => {
    const firstAuthored = [...authored.values()][0]!;
    const lastAuthored = [...authored.values()].at(-1)!;
    const firstKey = firstAuthored.time === 0 ? firstAuthored : { time: 0, position: firstAuthored.position, rotation: firstAuthored.rotation };
    const lastKey = lastAuthored.time === blueprint.duration ? lastAuthored : { time: blueprint.duration, position: lastAuthored.position, rotation: lastAuthored.rotation };
    const keys = new Map<number, AnimationRecipe['tracks'][number]['keys'][number]>([
      [0, firstKey],
      [blueprint.duration, lastKey],
    ]);
    for (const [time, key] of authored) keys.set(time, key);
    const ordered = [...keys.values()].sort((left, right) => left.time - right.time);
    if (blueprint.loop) {
      const authoredEnd = authored.get(blueprint.duration);
      const loopStart = ordered[0]!;
      if (authoredEnd && (authoredEnd.position.some((value, axis) => value !== loopStart.position[axis])
        || authoredEnd.rotation.some((value, axis) => value !== loopStart.rotation[axis]))) {
        loopEndpointOverrides.push({ joint, time: blueprint.duration, authoredPosition: authoredEnd.position, authoredRotation: authoredEnd.rotation,
          loopPosition: loopStart.position, loopRotation: loopStart.rotation });
      }
      ordered[ordered.length - 1] = { time: blueprint.duration, position: loopStart.position, rotation: loopStart.rotation };
    }
    return { joint, keys: ordered };
  });
  if (tracks.length > 256) throw new Error('Blueprint uses more than 256 distinct joints.');

  const eventRows = blueprint.events.map(event => {
    const phase = phaseById.get(event.phaseId)!;
    return { ...event, time: normalizedTime(phase, event.progress, blueprint.duration) };
  }).sort((left, right) => left.time - right.time
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    || (left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0)
    || (left.progress - right.progress)
    || ((left.value ?? '') < (right.value ?? '') ? -1 : (left.value ?? '') > (right.value ?? '') ? 1 : 0));
  const markers: AnimationRecipe['markers'] = [
    ...phases.map(phase => ({
      name: phase.markerName ?? (phase.label === 'main_action' ? 'Action' : phase.label === 'follow_through' ? 'FollowThrough' : phase.label[0]!.toUpperCase() + phase.label.slice(1)),
      time: normalizedTime(phase, phase.markerProgress ?? 0, blueprint.duration), value: `Blueprint phase: ${phase.id}`, phase: phase.label,
    })),
    ...eventRows.map(event => {
      return { name: event.name, time: event.time,
        ...(event.value !== undefined ? { value: event.value } : {}), phase: 'event' as const };
    }),
  ];
  const markerGroups = new Map<string, typeof markers>();
  for (const marker of markers) {
    const key = `${marker.name.toLowerCase()}\u0000${marker.time}`;
    const group = markerGroups.get(key) ?? [];
    group.push(marker);
    markerGroups.set(key, group);
  }
  const duplicateMarkerGroups = [...markerGroups.values()].filter(group => group.length > 1);
  const recipeForMotionEvidence = recipeSchema.parse({ kind: 'animation', name: blueprint.name, duration: blueprint.duration,
    loop: blueprint.loop, ...(blueprint.priority ? { priority: blueprint.priority } : {}), tracks, markers }) as AnimationRecipe;
  const poseCoverageByPhase = new Map(phases.map(phase => [phase.id, { phaseId: phase.id, label: phase.label,
    ...(phase.intent ? { intent: phase.intent } : {}),
    startTime: normalizedTime(phase, 0, blueprint.duration), endTime: normalizedTime(phase, 1, blueprint.duration),
    authoredPoseCount: 0, joints: new Set<string>(), poses: [] as { joint: string; progress: number; time: number }[] }]));
  for (const row of poseRows) {
    const phaseCoverage = poseCoverageByPhase.get(row.phaseId)!;
    phaseCoverage.authoredPoseCount += 1;
    phaseCoverage.joints.add(row.joint);
    phaseCoverage.poses.push({ joint: row.joint, progress: row.progress, time: row.time });
  }
  const poseCoverage = [...poseCoverageByPhase.values()].map(phase => {
    const poses = phase.poses.sort((left, right) => left.progress - right.progress || left.joint.localeCompare(right.joint, 'en-US'));
    const poseCountsByJoint = new Map<string, number>();
    for (const pose of poses) poseCountsByJoint.set(pose.joint, (poseCountsByJoint.get(pose.joint) ?? 0) + 1);
    return { ...phase, distinctJointCount: phase.joints.size, joints: [...phase.joints].sort(), poses,
      jointsWithSingleAuthoredPose: [...poseCountsByJoint.values()].filter(count => count === 1).length,
      jointsWithMultipleAuthoredPoses: [...poseCountsByJoint.values()].filter(count => count > 1).length };
  });
  const sortedJointCoverage = [...jointKeys.keys()].sort((left, right) => left.localeCompare(right, 'en-US'));
  const phasePoseProgressionJointLimit = 64;
  const phaseMotionEvidenceJointLimit = 64;
  const phaseMotionEvidenceSamplesPerPhase = 9;
  const phaseMotionEvidence = sortedJointCoverage.slice(0, phaseMotionEvidenceJointLimit).map(joint => {
    const contributingTracks = [tracks.find(candidate => candidate.joint === joint)!];
    return { joint, phases: phases.map(phase => {
      const startTime = normalizedTime(phase, 0, blueprint.duration);
      const endTime = normalizedTime(phase, 1, blueprint.duration);
      const durationSeconds = endTime - startTime;
      const uniformTimes = Array.from({ length: phaseMotionEvidenceSamplesPerPhase }, (_, index) =>
        startTime + durationSeconds * index / (phaseMotionEvidenceSamplesPerPhase - 1));
      const authoredTimes = [...new Set(contributingTracks.flatMap(source => source.keys.map(key => key.time)))]
        .filter(time => time > startTime && time < endTime);
      const sampleTimes = [...new Set([...uniformTimes, ...authoredTimes])].sort((left, right) => left - right);
      const samples = sampleTimes.map(time => ({ time, pose: sampleComposedRecipeJoint(recipeForMotionEvidence, joint, time) }));
      const intervals = samples.slice(1).map((to, index) => {
        const from = samples[index]!;
        const elapsedSeconds = to.time - from.time;
        const positionDeltaStuds = Math.hypot(...to.pose.position.map((value, axis) => value - from.pose.position[axis]!));
        const rotationDeltaDegrees = quaternionAngularDistanceDegrees(eulerDegreesToQuaternion(from.pose.rotation), eulerDegreesToQuaternion(to.pose.rotation));
        return { startTime: from.time, endTime: to.time, elapsedSeconds, positionDeltaStuds, rotationDeltaDegrees,
          positionRateStudsPerSecond: positionDeltaStuds / elapsedSeconds, angularRateDegreesPerSecond: rotationDeltaDegrees / elapsedSeconds };
      });
      const peakPosition = intervals.reduce((peak, interval) => interval.positionRateStudsPerSecond > peak.positionRateStudsPerSecond ? interval : peak, intervals[0]!);
      const peakRotation = intervals.reduce((peak, interval) => interval.angularRateDegreesPerSecond > peak.angularRateDegreesPerSecond ? interval : peak, intervals[0]!);
      return { phaseId: phase.id, label: phase.label, startTime, endTime, durationSeconds, sampleCount: samples.length, sampledIntervalCount: intervals.length,
        authoredKeyTimeCount: authoredTimes.length,
        sampledPositionPathLengthStuds: intervals.reduce((sum, interval) => sum + interval.positionDeltaStuds, 0),
        sampledAngularPathLengthDegrees: intervals.reduce((sum, interval) => sum + interval.rotationDeltaDegrees, 0),
        peakPositionRate: { studsPerSecond: peakPosition.positionRateStudsPerSecond, startTime: peakPosition.startTime, endTime: peakPosition.endTime },
        peakAngularRate: { degreesPerSecond: peakRotation.angularRateDegreesPerSecond, startTime: peakRotation.startTime, endTime: peakRotation.endTime },
      };
    }) };
  });
  const phaseMotionEvidenceByPhase = phases.map(phase => ({ phaseId: phase.id, label: phase.label,
    startTime: normalizedTime(phase, 0, blueprint.duration), endTime: normalizedTime(phase, 1, blueprint.duration),
    joints: phaseMotionEvidence.map(item => ({ joint: item.joint, ...item.phases.find(sample => sample.phaseId === phase.id)! })) }));
  const phasePoseProgressionByPhase = phases.map((phase, phaseIndex) => {
    const fromPhase = phaseIndex > 0 ? phases[phaseIndex - 1]! : undefined;
    const phaseRows = poseRows.filter(row => row.phaseId === phase.id);
    const previousRows = fromPhase ? poseRows.filter(row => row.phaseId === fromPhase.id) : [];
    const allJoints = [...new Set([...phaseRows, ...previousRows].map(row => row.joint))].sort((left, right) => left.localeCompare(right, 'en-US'));
    const joints = allJoints.slice(0, phasePoseProgressionJointLimit).map(joint => {
      const current = phaseRows.filter(row => row.joint === joint);
      const previous = previousRows.filter(row => row.joint === joint);
      const first = current[0], last = current.at(-1), prior = previous.at(-1);
      const measure = (from: typeof poseRows[number], to: typeof poseRows[number]) => ({
        fromTime: from.time, toTime: to.time, elapsedSeconds: to.time - from.time,
        positionDeltaStuds: Math.hypot(...to.position.map((value, axis) => value - from.position[axis]!)),
        rotationDeltaDegrees: quaternionAngularDistanceDegrees(eulerDegreesToQuaternion(from.rotation), eulerDegreesToQuaternion(to.rotation)),
      });
      return { joint, authoredPoseCount: current.length,
        ...(first ? { firstAuthoredPose: { time: first.time, progress: first.progress } } : {}),
        ...(last && last !== first ? { lastAuthoredPose: { time: last.time, progress: last.progress } } : {}),
        ...(first && last && first !== last ? { withinPhaseAuthoredDelta: measure(first, last) } : {}),
        ...(prior && first ? { authoredBridge: { fromPhaseId: fromPhase!.id, toPhaseId: phase.id, ...measure(prior, first) } } : {}),
      };
    });
    return { phaseId: phase.id, label: phase.label,
      ...(phase.intent ? { intent: phase.intent } : {}), joints, omittedJointCount: Math.max(0, allJoints.length - phasePoseProgressionJointLimit) };
  });
  const jointPhaseCoverage = new Map<string, Map<string, number[]>>();
  for (const row of poseRows) {
    const byPhase = jointPhaseCoverage.get(row.joint) ?? new Map<string, number[]>();
    const progresses = byPhase.get(row.phaseId) ?? [];
    progresses.push(row.progress);
    byPhase.set(row.phaseId, progresses);
    jointPhaseCoverage.set(row.joint, byPhase);
  }
  const sortedJointCoverageByPhase = [...jointPhaseCoverage].sort(([left], [right]) => left.localeCompare(right, 'en-US'));
  const jointCoverageLimit = 64;
  const jointCoverage = sortedJointCoverageByPhase.slice(0, jointCoverageLimit).map(([joint, byPhase]) => ({
    joint,
    authoredPoseCount: [...byPhase.values()].reduce((total, progresses) => total + progresses.length, 0),
    phases: phases.map(phase => ({
      phaseId: phase.id,
      label: phase.label,
      authoredPoseCount: byPhase.get(phase.id)?.length ?? 0,
      progress: [...(byPhase.get(phase.id) ?? [])].sort((left, right) => left - right),
    })),
  }));
  const authoredPosesByJoint = new Map<string, typeof poseRows>();
  for (const row of poseRows) {
    const jointRows = authoredPosesByJoint.get(row.joint) ?? [];
    jointRows.push(row);
    authoredPosesByJoint.set(row.joint, jointRows);
  }
  const poseProgressionJointLimit = 64, poseProgressionTransitionLimit = 16;
  const poseProgression = sortedJointCoverageByPhase.slice(0, poseProgressionJointLimit).map(([joint]) => {
    const rows = authoredPosesByJoint.get(joint) ?? [];
    const terminalPoseOverride = loopEndpointOverrides.find(item => item.joint === joint);
    const transitions = rows.slice(1).map((to, index) => {
      const from = rows[index]!;
      const elapsedSeconds = to.time - from.time;
      const positionDeltaStuds = Math.hypot(...to.position.map((value, axis) => value - from.position[axis]!));
      const rotationDeltaDegrees = quaternionAngularDistanceDegrees(eulerDegreesToQuaternion(from.rotation), eulerDegreesToQuaternion(to.rotation));
      return { fromPhaseId: from.phaseId, toPhaseId: to.phaseId, fromTime: from.time, toTime: to.time, elapsedSeconds,
        positionDeltaStuds, rotationDeltaDegrees, positionRateStudsPerSecond: positionDeltaStuds / elapsedSeconds,
        angularRateDegreesPerSecond: rotationDeltaDegrees / elapsedSeconds,
        ...(from.easingStyle ? { outgoingEasingStyle: from.easingStyle } : {}),
        ...(from.easingDirection ? { outgoingEasingDirection: from.easingDirection } : {}),
        ...(from.curve ? { outgoingBezierCurve: from.curve } : {}) };
    });
    return { joint, authoredPoseCount: rows.length, transitions: transitions.slice(0, poseProgressionTransitionLimit),
      omittedTransitionCount: Math.max(0, transitions.length - poseProgressionTransitionLimit),
      ...(terminalPoseOverride ? { terminalPoseOverride: { time: terminalPoseOverride.time,
        authoredPosition: terminalPoseOverride.authoredPosition, authoredRotation: terminalPoseOverride.authoredRotation,
        compiledLoopPosition: terminalPoseOverride.loopPosition, compiledLoopRotation: terminalPoseOverride.loopRotation } } : {}) };
  });
  const contactRows = blueprint.contacts.map(contact => {
    const phase = phaseById.get(contact.phaseId)!;
    return { effector: contact.effector, kind: contact.kind, phaseId: contact.phaseId,
      startProgress: contact.startProgress, endProgress: contact.endProgress,
      start: normalizedTime(phase, contact.startProgress, blueprint.duration), end: normalizedTime(phase, contact.endProgress, blueprint.duration) };
  }).sort((left, right) => left.start - right.start || left.end - right.end
    || (left.effector < right.effector ? -1 : left.effector > right.effector ? 1 : 0)
    || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
    || (left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0));
  const contacts: AnimationRecipe['contacts'] = contactRows.map(({ effector, kind, start, end }) => ({ effector, kind, start, end }));
  const recipe = recipeSchema.parse({ ...recipeForMotionEvidence, contacts }) as AnimationRecipe;
  const intentPhases = phases.filter(phase => phase.intent);
  const phaseIntentRows = intentPhases.map(phase => {
    const startTime = normalizedTime(phase, 0, blueprint.duration);
    const midpointTime = normalizedTime(phase, 0.5, blueprint.duration);
    const endTime = normalizedTime(phase, 1, blueprint.duration);
    return { phaseId: phase.id, label: phase.label, intent: phase.intent!, startTime, midpointTime, endTime,
      evidenceTimes: [startTime, midpointTime, endTime] };
  });
  const phaseIntentTargetTimes = [...new Set(phaseIntentRows.flatMap(phase => phase.evidenceTimes))]
    .filter(time => time !== 0 && time !== blueprint.duration).sort((left, right) => left - right);
  const phaseIntentReview = {
    phases: phaseIntentRows,
    targetTimes: phaseIntentTargetTimes,
    targetTimeBatches: Array.from({ length: Math.ceil(phaseIntentTargetTimes.length / 8) }, (_, index) =>
      phaseIntentTargetTimes.slice(index * 8, index * 8 + 8)),
    limitation: 'This schedule provides exact sampled poses at each intent phase midpoint and internal phase boundary. It does not interpret the intent, prove appearance between samples, or automatically pass/fail semantic quality; compare the stated intent against authored progression, exact rig-node pose evidence, and rendered frames when appearance matters.',
  };
  const posedPhases = new Set(blueprint.poses.map(pose => pose.phaseId));
  const warnings = [
    ...blueprint.phases.filter(phase => !posedPhases.has(phase.id)).map(phase => `Phase ${phase.id} (${phase.label}) has no explicit pose directive; it inherits motion only through interpolation from adjacent authored keys.`),
    ...duplicateMarkerGroups.map(group => `Blueprint markers ${group.map(marker => marker.value?.startsWith('Blueprint phase: ') ? marker.value.slice('Blueprint phase: '.length) : marker.name).join(', ')} emit the same marker ${group[0]!.name} at ${group[0]!.time}s; confirm the coincident event is intentional or retime one marker.`),
    ...contacts.filter(contact => !jointKeys.has(contact.effector)).map(contact => `Contact ${contact.kind} for ${contact.effector} has no matching authored track; the declaration is review metadata, not an IK solve.`),
    ...(phaseBoundaryNormalizations.length ? [`Phase boundaries within the accepted 1e-6 normalized-time tolerance were canonicalized for a contiguous timeline; inspect diagnostics.phaseBoundaryNormalizations for exact authored/compiled values and time deltas.`] : []),
    ...(blueprint.loop ? ['Loop endpoint keys are forced to each joint’s initial pose; inspect the loop seam and any declared contact continuity.'] : []),
    ...(loopEndpointOverrides.length ? [`Explicit terminal poses at clip duration are replaced to close the loop on these joints: ${loopEndpointOverrides.map(item => item.joint).join(', ')}. Adjust the initial/end pose or disable looping if that change is not intended.`] : []),
    'Pose rotations are local XYZ degrees and position offsets are local studs. Confirm joint names, axes, and limits on the inspected target rig.',
    'Support/grip windows are declarations only. They do not solve IK, detect collisions, or prove rendered contact.',
  ];
  return {
    recipe,
    blueprint: { phases: phases.map(phase => ({ ...phase, startTime: normalizedTime(phase, 0, blueprint.duration), endTime: normalizedTime(phase, 1, blueprint.duration) })),
      poses: poseRows.map(({ phaseId, phaseLabel, progress, joint, time }) => ({ phaseId, phaseLabel, progress, joint, time })), contacts: contactRows, events: eventRows },
    diagnostics: { phaseCount: phases.length, authoredPoseCount: blueprint.poses.length, distinctJointCount: tracks.length,
      contactCount: contacts.length, generatedKeyCount: tracks.reduce((total, track) => total + track.keys.length, 0), duplicateMarkerGroupCount: duplicateMarkerGroups.length,
      phaseBoundaryNormalizations, loopEndpointOverrideCount: loopEndpointOverrides.length, loopEndpointOverrides, warnings,
      poseCoverage: { phases: poseCoverage, phasesWithAuthoredPoses: poseCoverage.filter(phase => phase.authoredPoseCount > 0).length,
        phasesWithoutAuthoredPoses: poseCoverage.filter(phase => phase.authoredPoseCount === 0).map(phase => phase.phaseId),
        joints: jointCoverage, omittedJointCount: Math.max(0, sortedJointCoverageByPhase.length - jointCoverageLimit),
        authoredPoseTimings: poseRows.slice(0, 32).map(row => ({ phaseId: row.phaseId, phaseLabel: row.phaseLabel, joint: row.joint, progress: row.progress, time: row.time })),
        omittedAuthoredPoseTimingCount: Math.max(0, poseRows.length - 32),
        progressionByJoint: poseProgression,
        progressionByPhase: phasePoseProgressionByPhase,
        sampledMotionByPhase: phaseMotionEvidenceByPhase,
        omittedSampledMotionJointCount: Math.max(0, sortedJointCoverage.length - phaseMotionEvidenceJointLimit),
        sampledMotionByPhaseLimitations: `Each authored track is sampled at ${phaseMotionEvidenceSamplesPerPhase} evenly spaced phase-local timestamps plus every authored key time inside each phase. Path lengths and peak rates describe sampled local track transforms, not continuous extrema, composed layer/root-motion output, world-space motion, rig limits, contact, or visual quality. Up to ${phaseMotionEvidenceJointLimit} authored joints are included; omittedSampledMotionJointCount reports truncation. Small values are not automatically a defect because deliberate stillness is valid.`,
        omittedProgressionJointCount: Math.max(0, sortedJointCoverage.length - poseProgressionJointLimit),
        progressionLimitation: `progressionByJoint compares consecutive authored pose endpoints only. progressionByPhase is also based only on authored directives: authoredBridge compares the last directive for a joint in the preceding phase with its first directive in this phase; withinPhaseAuthoredDelta compares its first and last directives inside this phase. Both report local-space endpoint changes, not continuous-curve peaks, rendered motion, axis/anatomy validation, or quality scores. Missing bridge data means a phase has no explicit directive for that joint; interpolation can still animate it. Loop-closed terminal keys may differ from the last authored pose; inspect terminalPoseOverride for affected joints. Each per-joint and per-phase detail is capped at ${poseProgressionJointLimit} joints.`,
        limitation: 'Coverage counts explicit pose directives only. Per-joint phase rows are capped at 64 joints and detailed timings at the first 32 chronologically ordered poses. A zero means the joint has no explicit directive in that phase, not that a pose is required; it does not measure pose quality or imply interpolation through a phase is wrong.' },
      phaseIntentReview },
    next: 'Review diagnostics.poseCoverage.progressionByPhase and sampledMotionByPhase. Compare authoredBridge, withinPhaseAuthoredDelta, and sampled path/rate cues with each phase intent; sampled values are sparse local-curve evidence, not continuous extrema or quality gates, and stillness may be intentional. Missing authored directives do not imply missing interpolated motion. For explicit phase intents, use each diagnostics.phaseIntentReview.targetTimeBatches entry in a separate motion_animation_candidate_evaluate call with includeTargetPoseEvidence=true and the same expectedFingerprint. Each batch contains at most eight exact times; match sample IDs/times to diagnostics.phaseIntentReview.phases and map arrays through targetedPoseEvidence.poseEvidenceIndex.nodeSlots. For rendered review, select up to eight important phase intent midpointTime values and pass them as exact front-view frames to motion_studio_capture_candidate_views with the same recipe fingerprint; capture further bounded batches for additional intents and disclose omissions. Numerical pose telemetry is not rendered appearance, and stills do not prove continuous motion. Inspect the target rig, then save only after visual review. This preview does not persist an asset.',
  };
}
