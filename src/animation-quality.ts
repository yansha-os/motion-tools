import type { AnimationRecipe } from './recipes.js';
import { easeProgress } from './easing.js';
import { createComposedJointSampler } from './animation-patch.js';
import { extractActionPhaseWindows, type ActionPhaseWindow } from './animation-phases.js';
import { resolveRigSemanticRoles, type RigSemanticRole } from './rig-semantics.js';
import { retargetProfileSchema } from './retarget.js';
import { eulerXYZDegreesToQuaternion } from './rotation.js';
import { formatAnimationTime } from './time-format.js';
export { extractActionPhaseWindows } from './animation-phases.js';

function compareOrdinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

export type AnimationAdvisory = { id: string; severity: 'check' | 'note'; detail: string };
type ContactTrackCoverage = { contactIndex: number; effector: string; kind: 'support' | 'grip'; startTime: number; endTime: number;
  status: 'active_channel' | 'inactive_channels_only' | 'no_matching_channel'; channels: { source: 'base' | 'layer' | 'rootMotion'; active: boolean; layerId?: string; layerName?: string }[] };

export function summarizeRootMotionPath(recipe: AnimationRecipe) {
  const track = recipe.rootMotion;
  if (!track) return null;
  const first = track.keys[0]!;
  const last = track.keys.at(-1)!;
  const netLocalDisplacement = last.position.map((value, axis) => value - first.position[axis]!) as [number, number, number];
  const netLocalDistance = Math.hypot(...netLocalDisplacement);
  const authoredPolylineLength = track.keys.slice(1).reduce((length, key, index) => {
    const previous = track.keys[index]!;
    return length + Math.hypot(...key.position.map((value, axis) => value - previous.position[axis]!));
  }, 0);
  return {
    joint: track.joint,
    basis: 'Root-motion channel local coordinates; key-to-key translation polyline. Not hierarchy-composed world-space travel.',
    keyCount: track.keys.length,
    startTime: first.time,
    endTime: last.time,
    startPosition: [...first.position] as [number, number, number],
    endPosition: [...last.position] as [number, number, number],
    netLocalDisplacement,
    netLocalDistance,
    authoredPolylineLength,
    straightnessRatio: authoredPolylineLength > 1e-12 ? Math.min(1, netLocalDistance / authoredPolylineLength) : null,
    interpretation: 'A straightness ratio near 1 means the authored translation keys follow a nearly direct path; it does not judge whether that path fits the action. Rotation, other channels on the same joint, rig hierarchy, character facing, collision, and gameplay displacement are excluded.',
  };
}

type TrackMotionMetric = {
  channel: 'base' | 'layer' | 'rootMotion';
  joint: string;
  layerId?: string;
  layerName?: string;
  enabled?: boolean;
  blendMode?: 'Override' | 'Additive';
  weight?: number;
  peakLocalPositionSpeed: { unitsPerSecond: number; startTime: number; endTime: number; startKeyIndex: number; endKeyIndex: number };
  peakLocalAngularSpeed: { degreesPerSecond: number; startTime: number; endTime: number; startKeyIndex: number; endKeyIndex: number };
  largestLocalPositionVelocityChange: { unitsPerSecondSquared: number; time: number; keyIndex: number } | null;
  largestLocalAngularVelocityChange: { degreesPerSecondSquared: number; time: number; keyIndex: number } | null;
};

type Vector3 = [number, number, number];
type Quaternion = [number, number, number, number];
type KeySegmentContext = {
  startKeyIndex: number;
  endKeyIndex: number;
  startTime: number;
  endTime: number;
  easingStyle: string;
  easingDirection: string;
  curve?: { outTime: number; outValue: number; inTime: number; inValue: number };
};
type MotionPhaseTiming = {
  status: 'active' | 'still';
  thresholdFraction: number;
  onsetTime: number | null;
  peakTime: number | null;
  settleTime: number | null;
  peakSpeed: number;
  activeDuration: number;
  activeSampleDuration: number;
  activeSampleCount: number;
  activeCoverageFraction: number;
};
type CurveMotionMetric = {
  channel: 'base' | 'layer' | 'rootMotion';
  joint: string;
  layerId?: string;
  layerName?: string;
  enabled?: boolean;
  blendMode?: 'Override' | 'Additive';
  weight?: number;
  evaluationCount: number;
  phaseTiming: { position: MotionPhaseTiming; angular: MotionPhaseTiming };
  peakLocalPositionSpeed: { unitsPerSecond: number; startTime: number; endTime: number; keySegment: KeySegmentContext };
  peakLocalAngularSpeed: { degreesPerSecond: number; startTime: number; endTime: number; keySegment: KeySegmentContext };
  peakLocalPositionAcceleration: { unitsPerSecondSquared: number; time: number; keySegment: KeySegmentContext };
  peakLocalAngularAcceleration: { degreesPerSecondSquared: number; time: number; keySegment: KeySegmentContext };
  peakLocalPositionJerk: { unitsPerSecondCubed: number; time: number; keySegment: KeySegmentContext };
  peakLocalAngularJerk: { degreesPerSecondCubed: number; time: number; keySegment: KeySegmentContext };
};
type SegmentSignalPeak = { time: number; value: number };
type SegmentSignalSample = SegmentSignalPeak & { windowStartTime: number; windowEndTime: number };
type SegmentMotionPeak = {
  keySegment: KeySegmentContext;
  position: SegmentSignalSample;
  angular: SegmentSignalSample;
  positionAcceleration: SegmentSignalSample;
  angularAcceleration: SegmentSignalSample;
  positionJerk: SegmentSignalSample;
  angularJerk: SegmentSignalSample;
};
type CurveMotionAnalysis = { metric: CurveMotionMetric; segmentPeaks: SegmentMotionPeak[]; keyTimes: number[] };
type LoopSeamVelocityMetric = { channel: 'base' | 'layer' | 'rootMotion'; joint: string; layerId?: string; layerName?: string; enabled?: boolean; weight?: number; positionDiscontinuityStudsPerSecond: number; angularDiscontinuityDegreesPerSecond: number;
  endpointPositionOffsetStuds: number; endpointAngularOffsetDegrees: number; velocitySampleStepSeconds: number;
  interpretation: string };

type RefinementTarget = {
  rankWithinSignal: number;
  signal: string;
  value: number;
  unit: string;
  joint: string;
  channel: CurveMotionMetric['channel'];
  layerId?: string;
  layerName?: string;
  eventTime: number;
  keySegment: KeySegmentContext;
  phaseContext: { source: 'named_markers' | 'unsegmented'; label: ActionPhase['label']; occurrence: number; startTime: number; endTime: number; boundaryMarkers: string[] };
  overlappingContacts: { effector: string; kind: 'support' | 'grip'; start: number; end: number }[];
  interpretation: { signalMeaning: string; evidenceScope: string; issueStatus: 'unclassified'; requiresVisualDecision: true };
  measurementProvenance: {
    sampleRateHz: 30 | 60 | 120 | 240;
    derivativeOrder: 1 | 2 | 3;
    sampleWindow: { startTime: number; endTime: number };
    segmentAttribution: 'segment_containing_event_time';
    crossedBoundaries: Array<{ kind: 'authored_key' | 'phase_marker'; time: number; leftSegmentStartKeyIndex: number; rightSegmentStartKeyIndex: number }>;
  };
  repairOptions: { operation: string; whenToUse: string; risk: string }[];
  suggestedNextStep: string;
  patchFocus: { joint: string; layerId?: string; keyTime: number; startKeyIndex: number; endKeyIndex: number; availableOperations: string[] };
};

type PhaseProfile = { joint: string; onsetTime: number; peakTime: number; settleTime: number; peakSpeed: number };
type PhaseRelationship = { earlierJoint: string; laterJoint: string; lagSeconds: number; overlapSeconds: number };
type CoordinationReport = {
  basis: string;
  sampleRateHz: number;
  uniformSampleCount?: number;
  uniformSampleCapped?: boolean;
  phaseLagWindowSeconds: number;
  position: { activeJointCount: number; synchronizedPeakGroups: { joints: string[]; startTime: number; endTime: number; spreadSeconds: number }[]; largestOnsetLags: PhaseRelationship[]; largestPeakLags: PhaseRelationship[] };
  angular: { activeJointCount: number; synchronizedPeakGroups: { joints: string[]; startTime: number; endTime: number; spreadSeconds: number }[]; largestOnsetLags: PhaseRelationship[]; largestPeakLags: PhaseRelationship[] };
};
type ActionPhase = {
  label: ActionPhaseWindow['label'];
  occurrence: number;
  startTime: number;
  endTime: number;
  duration: number;
  boundaryMarkers: string[];
  endingMarkers: string[];
  boundaryLabels: Exclude<ActionPhase['label'], 'unclassified' | 'unsegmented'>[];
  activeChannelCount: number;
  activeChannels: { joint: string; channel: CurveMotionMetric['channel']; layerId?: string; layerName?: string; positionWindow?: { startTime: number; peakTime: number | null; settleTime: number }; angularWindow?: { startTime: number; peakTime: number | null; settleTime: number } }[];
  omittedActiveChannelCount: number;
  peakEvents: { joint: string; channel: CurveMotionMetric['channel']; layerId?: string; dimension: 'position' | 'angular'; peakTime: number; peakSpeed: number; unit: string; keySegment: KeySegmentContext }[];
  omittedPeakEventCount: number;
  poseProgression: {
    basis: string;
    sampleRateHz: number;
    uniformSampleCount: number;
    uniformSampleCapped: boolean;
    jointCount: number;
    omittedJointCount: number;
    joints: Array<{
      joint: string;
      entry: { position: Vector3; rotationQuaternion: Quaternion };
      exit: { position: Vector3; rotationQuaternion: Quaternion };
      netTranslationStuds: number;
      netRotationDegrees: number;
      peakTranslationFromEntryStuds: number;
      peakTranslationTime: number;
      peakRotationFromEntryDegrees: number;
      peakRotationTime: number;
      evaluationCount: number;
    }>;
  };
  contacts: { effector: string; kind: 'support' | 'grip'; start: number; end: number }[];
};
type ActionPhaseMap = {
  source: 'named_markers' | 'unsegmented';
  markerRule: string;
  detailLimitPerPhase: number;
  phases: ActionPhase[];
};

/** Exact-name authored-channel coverage against one inspected rig; this is not anatomy inference. */
export function analyzeRigAnimationCoverage(recipe: AnimationRecipe, joints: { name: string; parent: string; driven: boolean }[], jointMap: Record<string, string> = {}) {
  const authoredTracks = [
    ...recipe.tracks.map(track => ({ track, sourceJoint: track.joint, joint: jointMap[track.joint] ?? track.joint,
      source: 'base' as const, layerId: undefined, layerName: undefined, active: true })),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => ({ track, sourceJoint: track.joint, joint: jointMap[track.joint] ?? track.joint,
      source: 'layer' as const, layerId: layer.id, layerName: layer.name, active: layer.enabled && layer.weight > 0 }))),
    ...(recipe.rootMotion ? [{ track: recipe.rootMotion, sourceJoint: recipe.rootMotion.joint, joint: jointMap[recipe.rootMotion.joint] ?? recipe.rootMotion.joint,
      source: 'rootMotion' as const, layerId: undefined, layerName: undefined, active: true }] : []),
  ];
  const channelsByJoint = new Map<string, { sourceJoint: string; source: 'base' | 'layer' | 'rootMotion'; layerId?: string; layerName?: string; active: boolean; keyCount: number }[]>();
  for (const { track, joint, sourceJoint, ...channel } of authoredTracks) {
    const channels = channelsByJoint.get(joint) ?? [];
    channels.push({ ...channel, sourceJoint, keyCount: track.keys.length });
    channelsByJoint.set(joint, channels);
  }
  const driven = joints.filter(joint => joint.driven);
  const drivenNames = new Set(driven.map(joint => joint.name));
  const unresolvedTrackJoints = [...channelsByJoint.keys()].filter(name => !drivenNames.has(name));
  const rootMotion = recipe.rootMotion ? { sourceJoint: recipe.rootMotion.joint,
    joint: jointMap[recipe.rootMotion.joint] ?? recipe.rootMotion.joint,
    keyCount: recipe.rootMotion.keys.length,
    status: drivenNames.has(jointMap[recipe.rootMotion.joint] ?? recipe.rootMotion.joint) ? 'resolved' as const : 'unresolved' as const } : null;
  const rigNodesByName = new Map(joints.map(joint => [joint.name, joint]));
  const contactCoverage = (recipe.contacts ?? []).map((contact, contactIndex) => {
    const rigJoint = jointMap[contact.effector] ?? contact.effector;
    const rigNode = rigNodesByName.get(rigJoint);
    const channels = channelsByJoint.get(rigJoint) ?? [];
    return { contactIndex, effector: contact.effector, rigJoint, kind: contact.kind,
      startTime: contact.start, endTime: contact.end,
      rigStatus: !rigNode ? 'unresolved' as const : rigNode.driven ? 'driven' as const : 'not_driven' as const,
      channelStatus: channels.some(channel => channel.active) ? 'active_channel' as const
        : channels.length ? 'inactive_channels_only' as const : 'no_matching_channel' as const,
      channels: channels.map(channel => ({ sourceJoint: channel.sourceJoint, source: channel.source, active: channel.active,
        ...(channel.layerId ? { layerId: channel.layerId } : {}), ...(channel.layerName ? { layerName: channel.layerName } : {}) })),
    };
  });
  return { drivenJointCount: driven.length, authoredJointCount: channelsByJoint.size,
    coveredDrivenJointCount: driven.filter(joint => (channelsByJoint.get(joint.name) ?? []).some(channel => channel.active)).length,
    unresolvedTrackJoints, rootMotion, contacts: contactCoverage,
    joints: driven.map(joint => { const channels = channelsByJoint.get(joint.name) ?? []; return { name: joint.name, parent: joint.parent,
      channels, active: channels.some(channel => channel.active), note: channels.length ? undefined : 'No authored track; intentional stillness is valid.' }; }),
    excludedChannels: authoredTracks.filter(({ active }) => !active).map(({ track, joint, sourceJoint, source, layerId, layerName }) => ({ joint, sourceJoint,
      source, layerId, layerName, keyCount: track.keys.length, reason: 'Layer disabled or weight is zero; not part of active coverage.' })),
    limitation: 'Coverage uses exact target names or the caller-supplied jointMap; it does not infer semantic body roles. Unmapped names remain unresolved; inactive channels are disclosed but excluded. Contact coverage identifies rig-node/channel availability only and cannot prove support, grip, collision, or visible contact.' };
}

/** Reports recipe coverage for recognized body roles without turning stillness into a defect or a quota. */
export function analyzeRigSemanticRoleCoverage(recipe: AnimationRecipe, profileInput: unknown, jointMap: Record<string, string> = {},
  confirmedMappings: readonly { role: RigSemanticRole; joint: string; resolution: 'exact' | 'user_confirmed' }[] = []) {
  const profile = retargetProfileSchema.parse(profileInput);
  const resolution = resolveRigSemanticRoles(profile);
  const confirmedByRole = new Map(confirmedMappings.map(mapping => [mapping.role, mapping]));
  const exactCoverage = analyzeRigAnimationCoverage(recipe, profile.joints, jointMap);
  const coverageByJoint = new Map(exactCoverage.joints.map(joint => [joint.name, joint]));
  const roles = resolution.resolutions.map(item => {
    const confirmed = confirmedByRole.get(item.role);
    const joint = confirmed?.joint ?? item.joint;
    const channels = joint ? coverageByJoint.get(joint)?.channels ?? [] : [];
    const state = !joint ? 'unresolved' as const
      : channels.some(channel => channel.active) ? 'active' as const
        : channels.length ? 'inactive_only' as const : 'not_authored' as const;
    return { role: item.role, resolution: confirmed?.resolution ?? item.status, state, ...(joint ? { joint } : {}), candidates: item.candidates,
      ...(confirmed ? { mappingEvidence: 'Caller explicitly mapped this semantic role to an inspected driven joint; this is user-attested intent, not anatomical verification.' } : {}),
      channels: channels.map(channel => ({ sourceJoint: channel.sourceJoint, source: channel.source,
        ...(channel.layerId ? { layerId: channel.layerId } : {}), ...(channel.layerName ? { layerName: channel.layerName } : {}),
        active: channel.active, keyCount: channel.keyCount })) };
  });
  const rolesByJoint = new Map<string, string[]>();
  for (const role of roles) if (role.joint) rolesByJoint.set(role.joint, [...(rolesByJoint.get(role.joint) ?? []), role.role]);
  const sharedJointRoles = [...rolesByJoint].filter(([, shared]) => shared.length > 1)
    .map(([joint, sharedRoles]) => ({ joint, roles: sharedRoles }));
  return { rig: { id: profile.rigId, name: profile.rigName, type: profile.rigType, signature: profile.rigSignature },
    summary: { roleCount: roles.length, resolvedRoleCount: roles.filter(role => role.joint).length,
      activeRoleCount: roles.filter(role => role.state === 'active').length,
      inactiveOnlyRoleCount: roles.filter(role => role.state === 'inactive_only').length,
      notAuthoredRoleCount: roles.filter(role => role.state === 'not_authored').length,
      unresolvedRoleCount: roles.filter(role => role.state === 'unresolved').length },
    roles, sharedJointRoles,
    limitation: 'Role resolution uses exact R6/R15 naming conventions, explicitly caller-confirmed exact driven-joint mappings, or a unique joint-name token match labeled inferred; inferred roles require review. Caller-confirmed mapping is not anatomical truth. It uses no mesh, position, axes, anatomy, or joint-limit evidence. Role counts may share one driven joint (especially R6 arm/hand and leg/foot aliases), and absent or inactive roles are not failures: intentional stillness is valid. This is coverage context, not a quality score or quota.' };
}

/** Mirrors the viewport-open tool's exact-name gate; a sampling jointMap does not rewrite a candidate. */
export function analyzeViewportCandidateReadiness(recipe: AnimationRecipe, drivenJointNames: ReadonlySet<string>) {
  const authoredJointNames = [...recipe.tracks.map(track => track.joint), ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint))];
  const unresolvedTrackJoints = [...new Set(authoredJointNames.filter(joint => !drivenJointNames.has(joint)))];
  return { status: unresolvedTrackJoints.length ? 'needs_joint_resolution' as const : 'ready' as const,
    unresolvedTrackJoints,
    limitation: 'Viewport preview requires exact driven joint names in the candidate recipe. The evaluation jointMap affects Studio sampling and coverage diagnostics only; it does not rename or retarget the recipe.' };
}

function slerp(from: Quaternion, to: Quaternion, alpha: number): Quaternion {
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

function quaternionDeltaDegrees(from: Quaternion, to: Quaternion): Vector3 {
  let target = to;
  const dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) target = to.map(value => -value) as Quaternion;
  const [x, y, z, w] = from;
  const [a, b, c, d] = target;
  const dx = w * a - x * d - y * c + z * b;
  const dy = w * b + x * c - y * d - z * a;
  const dz = w * c - x * b + y * a - z * d;
  const dw = w * d + x * a + y * b + z * c;
  const vectorLength = Math.hypot(dx, dy, dz);
  if (vectorLength < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(vectorLength, Math.max(0, dw)) * 180 / Math.PI;
  return [dx * angle / vectorLength, dy * angle / vectorLength, dz * angle / vectorLength];
}

function evaluateTrack(track: AnimationRecipe['tracks'][number], time: number) {
  const first = track.keys[0]!;
  if (time <= first.time) return { position: [...first.position] as Vector3, rotation: eulerXYZDegreesToQuaternion(first.rotation) };
  const last = track.keys.at(-1)!;
  if (time >= last.time) return { position: [...last.position] as Vector3, rotation: eulerXYZDegreesToQuaternion(last.rotation) };
  let low = 1, high = track.keys.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (track.keys[middle]!.time < time) low = middle + 1;
    else high = middle;
  }
  const left = track.keys[low - 1]!, right = track.keys[low]!;
  const progress = (time - left.time) / (right.time - left.time);
  const alpha = easeProgress(left.easingStyle, left.easingDirection, progress, left.curve);
  return {
    position: left.position.map((value, axis) => value + (right.position[axis]! - value) * alpha) as Vector3,
    rotation: slerp(eulerXYZDegreesToQuaternion(left.rotation), eulerXYZDegreesToQuaternion(right.rotation), alpha),
  };
}

function vectorMagnitude(value: Vector3) { return Math.hypot(...value); }
function difference(from: Vector3, to: Vector3, seconds: number): Vector3 {
  return from.map((value, axis) => (to[axis]! - value) / seconds) as Vector3;
}

function keySegmentAt(track: AnimationRecipe['tracks'][number], time: number): KeySegmentContext {
  let endKeyIndex = 1;
  while (endKeyIndex < track.keys.length - 1 && time > track.keys[endKeyIndex]!.time) endKeyIndex++;
  const left = track.keys[endKeyIndex - 1]!, right = track.keys[endKeyIndex]!;
  return {
    startKeyIndex: endKeyIndex - 1, endKeyIndex,
    startTime: left.time, endTime: right.time,
    easingStyle: left.easingStyle ?? 'Linear', easingDirection: left.easingDirection ?? 'Out',
    ...(left.curve ? { curve: left.curve } : {}),
  };
}

function phaseTiming(velocities: ReturnType<typeof makeVelocities>, dimension: 'position' | 'angular'): MotionPhaseTiming {
  const peak = velocities.reduce((best, current) => vectorMagnitude(current[dimension]) > vectorMagnitude(best[dimension]) ? current : best, velocities[0]!);
  const peakSpeed = vectorMagnitude(peak[dimension]);
  if (peakSpeed <= 1e-8) return { status: 'still', thresholdFraction: 0.05, onsetTime: null, peakTime: null, settleTime: null, peakSpeed: 0, activeDuration: 0, activeSampleDuration: 0, activeSampleCount: 0, activeCoverageFraction: 0 };
  const threshold = peakSpeed * 0.05;
  const active = velocities.filter(sample => vectorMagnitude(sample[dimension]) >= threshold);
  const first = active[0]!, last = active.at(-1)!;
  const activeSampleDuration = active.reduce((sum, sample) => sum + sample.endTime - sample.startTime, 0);
  const timelineDuration = velocities.at(-1)!.endTime - velocities[0]!.startTime;
  return {
    status: 'active', thresholdFraction: 0.05,
    onsetTime: first.startTime, peakTime: peak.midpoint, settleTime: last.endTime,
    peakSpeed, activeDuration: last.endTime - first.startTime,
    activeSampleDuration, activeSampleCount: active.length,
    activeCoverageFraction: timelineDuration > 0 ? activeSampleDuration / timelineDuration : 0,
  };
}

function makeVelocities(orderedTimes: number[], poses: ReturnType<typeof evaluateTrack>[]) {
  return orderedTimes.slice(1).map((time, index) => {
    const previousTime = orderedTimes[index]!;
    const seconds = time - previousTime;
    const before = poses[index]!, after = poses[index + 1]!;
    return {
      startTime: previousTime, endTime: time, midpoint: (previousTime + time) / 2,
      position: difference(before.position, after.position, seconds),
      angular: difference([0, 0, 0], quaternionDeltaDegrees(before.rotation, after.rotation), seconds),
    };
  });
}

function curveMotionMetric(
  track: AnimationRecipe['tracks'][number],
  context: Omit<CurveMotionMetric, 'joint' | 'evaluationCount' | 'phaseTiming' | 'peakLocalPositionSpeed' | 'peakLocalAngularSpeed' | 'peakLocalPositionAcceleration' | 'peakLocalAngularAcceleration' | 'peakLocalPositionJerk' | 'peakLocalAngularJerk'>,
  sampleRateHz: 30 | 60 | 120 | 240,
): CurveMotionAnalysis {
  const times = new Set<number>(track.keys.map(key => key.time));
  for (let keyIndex = 1; keyIndex < track.keys.length; keyIndex++) {
    const left = track.keys[keyIndex - 1]!, right = track.keys[keyIndex]!;
    const steps = Math.max(1, Math.ceil((right.time - left.time) * sampleRateHz));
    for (let step = 1; step < steps; step++) times.add(left.time + (right.time - left.time) * step / steps);
  }
  const orderedTimes = [...times].sort((a, b) => a - b);
  const poses = orderedTimes.map(time => evaluateTrack(track, time));
  const velocities = makeVelocities(orderedTimes, poses);
  const peakVelocity = (dimension: 'position' | 'angular') => velocities.reduce((best, current) =>
    vectorMagnitude(current[dimension]) > vectorMagnitude(best[dimension]) ? current : best, velocities[0]!);
  const accelerations = velocities.slice(1).map((current, index) => {
    const previous = velocities[index]!;
    const seconds = current.midpoint - previous.midpoint;
    return {
      time: (previous.endTime + current.startTime) / 2,
      windowStartTime: previous.startTime,
      windowEndTime: current.endTime,
      position: difference(previous.position, current.position, seconds),
      angular: difference(previous.angular, current.angular, seconds),
    };
  });
  const jerks = accelerations.slice(1).map((current, index) => {
    const previous = accelerations[index]!;
    const seconds = current.time - previous.time;
    return { time: (previous.time + current.time) / 2, windowStartTime: previous.windowStartTime, windowEndTime: current.windowEndTime,
      position: difference(previous.position, current.position, seconds), angular: difference(previous.angular, current.angular, seconds) };
  });
  const peakAcceleration = (dimension: 'position' | 'angular') => accelerations.reduce((best, current) =>
    vectorMagnitude(current[dimension]) > vectorMagnitude(best[dimension]) ? current : best, accelerations[0]!);
  const peakJerk = (dimension: 'position' | 'angular') => jerks.reduce((best, current) =>
    vectorMagnitude(current[dimension]) > vectorMagnitude(best[dimension]) ? current : best, jerks[0]!);
  const positionSpeed = peakVelocity('position'), angularSpeed = peakVelocity('angular');
  const positionAcceleration = peakAcceleration('position'), angularAcceleration = peakAcceleration('angular');
  const positionJerk = peakJerk('position'), angularJerk = peakJerk('angular');
  const segmentPeaks = new Map<number, SegmentMotionPeak>();
  const segmentFor = (time: number) => {
    const keySegment = keySegmentAt(track, time);
    const existing = segmentPeaks.get(keySegment.startKeyIndex) ?? {
      keySegment,
      position: { time, value: 0, windowStartTime: time, windowEndTime: time }, angular: { time, value: 0, windowStartTime: time, windowEndTime: time },
      positionAcceleration: { time, value: 0, windowStartTime: time, windowEndTime: time }, angularAcceleration: { time, value: 0, windowStartTime: time, windowEndTime: time },
      positionJerk: { time, value: 0, windowStartTime: time, windowEndTime: time }, angularJerk: { time, value: 0, windowStartTime: time, windowEndTime: time },
    };
    segmentPeaks.set(keySegment.startKeyIndex, existing);
    return existing;
  };
  const recordPeak = (time: number, windowStartTime: number, windowEndTime: number, signal: keyof Omit<SegmentMotionPeak, 'keySegment'>, value: number) => {
    const segment = segmentFor(time);
    if (value > segment[signal].value) segment[signal] = { time, value, windowStartTime, windowEndTime };
  };
  for (const velocity of velocities) {
    recordPeak(velocity.midpoint, velocity.startTime, velocity.endTime, 'position', vectorMagnitude(velocity.position));
    recordPeak(velocity.midpoint, velocity.startTime, velocity.endTime, 'angular', vectorMagnitude(velocity.angular));
  }
  for (const acceleration of accelerations) {
    recordPeak(acceleration.time, acceleration.windowStartTime, acceleration.windowEndTime, 'positionAcceleration', vectorMagnitude(acceleration.position));
    recordPeak(acceleration.time, acceleration.windowStartTime, acceleration.windowEndTime, 'angularAcceleration', vectorMagnitude(acceleration.angular));
  }
  for (const jerk of jerks) {
    recordPeak(jerk.time, jerk.windowStartTime, jerk.windowEndTime, 'positionJerk', vectorMagnitude(jerk.position));
    recordPeak(jerk.time, jerk.windowStartTime, jerk.windowEndTime, 'angularJerk', vectorMagnitude(jerk.angular));
  }
  const metric: CurveMotionMetric = {
    ...context, joint: track.joint, evaluationCount: poses.length,
    phaseTiming: { position: phaseTiming(velocities, 'position'), angular: phaseTiming(velocities, 'angular') },
    peakLocalPositionSpeed: { unitsPerSecond: vectorMagnitude(positionSpeed.position), startTime: positionSpeed.startTime, endTime: positionSpeed.endTime, keySegment: keySegmentAt(track, positionSpeed.midpoint) },
    peakLocalAngularSpeed: { degreesPerSecond: vectorMagnitude(angularSpeed.angular), startTime: angularSpeed.startTime, endTime: angularSpeed.endTime, keySegment: keySegmentAt(track, angularSpeed.midpoint) },
    peakLocalPositionAcceleration: { unitsPerSecondSquared: vectorMagnitude(positionAcceleration.position), time: positionAcceleration.time, keySegment: keySegmentAt(track, positionAcceleration.time) },
    peakLocalAngularAcceleration: { degreesPerSecondSquared: vectorMagnitude(angularAcceleration.angular), time: angularAcceleration.time, keySegment: keySegmentAt(track, angularAcceleration.time) },
    peakLocalPositionJerk: { unitsPerSecondCubed: vectorMagnitude(positionJerk.position), time: positionJerk.time, keySegment: keySegmentAt(track, positionJerk.time) },
    peakLocalAngularJerk: { degreesPerSecondCubed: vectorMagnitude(angularJerk.angular), time: angularJerk.time, keySegment: keySegmentAt(track, angularJerk.time) },
  };
  return { metric, segmentPeaks: [...segmentPeaks.values()].sort((a, b) => a.keySegment.startKeyIndex - b.keySegment.startKeyIndex), keyTimes: track.keys.map(key => key.time) };
}

function measureLoopBoundary(sample: (time: number) => { position: Vector3; rotation: Quaternion }, duration: number) {
  const step = Math.min(duration / 1000, 1 / 240);
  const start = sample(0), afterStart = sample(step);
  const beforeEnd = sample(duration - step), end = sample(duration);
  const outgoingPosition = difference(start.position, afterStart.position, step);
  const incomingPosition = difference(beforeEnd.position, end.position, step);
  const outgoingAngular = difference([0, 0, 0], quaternionDeltaDegrees(start.rotation, afterStart.rotation), step);
  const incomingAngular = difference([0, 0, 0], quaternionDeltaDegrees(beforeEnd.rotation, end.rotation), step);
  return {
    endpointPositionOffsetStuds: vectorMagnitude(end.position.map((value, axis) => value - start.position[axis]!) as Vector3),
    endpointAngularOffsetDegrees: vectorMagnitude(quaternionDeltaDegrees(start.rotation, end.rotation)),
    velocitySampleStepSeconds: step,
    positionDiscontinuityStudsPerSecond: vectorMagnitude(outgoingPosition.map((value, axis) => value - incomingPosition[axis]!) as Vector3),
    angularDiscontinuityDegreesPerSecond: vectorMagnitude(outgoingAngular.map((value, axis) => value - incomingAngular[axis]!) as Vector3),
  };
}

function loopSeamVelocityMetric(track: AnimationRecipe['tracks'][number], context: Pick<LoopSeamVelocityMetric, 'channel' | 'layerId' | 'layerName' | 'enabled' | 'weight'>, duration: number): LoopSeamVelocityMetric {
  return { ...context, joint: track.joint, ...measureLoopBoundary(time => evaluateTrack(track, time), duration),
    interpretation: 'Local channel endpoints and one-sided sampled velocities, before layer composition or rig hierarchy. Equal velocities do not imply matching endpoint poses. Root travel or turning may intentionally accumulate across loops; disabled or zero-weight layers do not imply visible motion. Review the rendered wrap against the intended action.' };
}

function composedLoopBoundaries(recipe: AnimationRecipe) {
  if (!recipe.loop) return [];
  const tracks = [...recipe.tracks, ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks),
    ...(recipe.rootMotion ? [recipe.rootMotion] : [])];
  return [...new Set(tracks.map(track => track.joint))].sort(compareOrdinal).flatMap(joint => {
    const sample = createComposedJointSampler(recipe, joint);
    return sample ? [{ joint, ...measureLoopBoundary(sample, recipe.duration),
      interpretation: 'Resultant local joint pose after base, enabled weighted layer stack and matching root-motion composition. Disabled/zero-weight-only joints are omitted. This excludes hierarchy, world-space contact, rendered appearance and intent; root accumulation may be deliberate.' }] : [];
  });
}

function buildRefinementPlan(curveAnalyses: CurveMotionAnalysis[], phaseMap: ActionPhaseMap, sampleRateHz: 30 | 60 | 120 | 240): RefinementTarget[] {
  const signals = [
    { signal: 'peakLocalPositionSpeed', unit: 'studs/second', segmentSignal: 'position' },
    { signal: 'peakLocalAngularSpeed', unit: 'degrees/second', segmentSignal: 'angular' },
    { signal: 'peakLocalPositionAcceleration', unit: 'studs/second^2', segmentSignal: 'positionAcceleration' },
    { signal: 'peakLocalAngularAcceleration', unit: 'degrees/second^2', segmentSignal: 'angularAcceleration' },
    { signal: 'peakLocalPositionJerk', unit: 'studs/second^3', segmentSignal: 'positionJerk' },
    { signal: 'peakLocalAngularJerk', unit: 'degrees/second^3', segmentSignal: 'angularJerk' },
  ] as const;
  const targets: RefinementTarget[] = [];
  for (const descriptor of signals) {
    const segmentCandidates = curveAnalyses.flatMap(({ metric, segmentPeaks, keyTimes }) =>
      segmentPeaks.map(segment => ({ metric, keyTimes, value: segment[descriptor.segmentSignal].value,
        time: segment[descriptor.segmentSignal].time, segment: segment.keySegment,
        sampleWindow: { startTime: segment[descriptor.segmentSignal].windowStartTime, endTime: segment[descriptor.segmentSignal].windowEndTime } })),
    );
    const rankedSegments = segmentCandidates
      .sort((a, b) => b.value - a.value || a.time - b.time || compareOrdinal(a.metric.joint, b.metric.joint)
        || compareOrdinal(a.metric.channel, b.metric.channel) || compareOrdinal(a.metric.layerId ?? '', b.metric.layerId ?? ''))
      .filter(candidate => candidate.value > 0);
    const uniqueSegments = rankedSegments.filter((candidate, index, all) => all.findIndex(other => other.metric.channel === candidate.metric.channel
      && other.metric.joint === candidate.metric.joint && other.metric.layerId === candidate.metric.layerId
      && other.segment.startKeyIndex === candidate.segment.startKeyIndex) === index);
    const phaseFor = (time: number) => phaseMap.phases.find((phase, index) => time >= phase.startTime - 1e-8
      && (time < phase.endTime - 1e-8 || (index === phaseMap.phases.length - 1 && time <= phase.endTime + 1e-8))) ?? phaseMap.phases.at(-1)!;
    // Keep the global peak, then prefer the strongest target from a different marked phase.
    const selected = uniqueSegments.length ? [uniqueSegments[0]!] : [];
    for (const candidate of uniqueSegments.slice(1)) {
      if (selected.length >= 3) break;
      const phase = phaseFor(candidate.time);
      if (!selected.some(existing => phaseFor(existing.time) === phase)) selected.push(candidate);
    }
    for (const candidate of uniqueSegments) {
      if (selected.length >= 3) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    selected.forEach(({ metric, keyTimes, value, time, segment, sampleWindow }, index) => {
      const rootMotion = metric.channel === 'rootMotion';
      const phase = phaseFor(time);
      const overlappingContacts = phase.contacts.filter(contact => time >= contact.start - 1e-8 && time <= contact.end + 1e-8);
      const phaseName = phase.label === 'unsegmented' ? 'unsegmented clip' : `${phase.label.replaceAll('_', ' ')} phase`;
      const signalName = descriptor.signal.replace('peakLocal', '').replaceAll(/([A-Z])/g, ' $1').trim().toLowerCase();
      const derivativeOrder = descriptor.signal.includes('Speed') ? 1 : descriptor.signal.includes('Acceleration') ? 2 : 3;
      const crossesWindow = (boundaryTime: number) => sampleWindow.startTime < boundaryTime - 1e-8 && sampleWindow.endTime > boundaryTime + 1e-8;
      const segmentAround = (boundaryTime: number) => {
        const exactKeyIndex = keyTimes.findIndex(keyTime => Math.abs(keyTime - boundaryTime) <= 1e-8);
        if (exactKeyIndex > 0 && exactKeyIndex < keyTimes.length - 1) return { leftSegmentStartKeyIndex: exactKeyIndex - 1, rightSegmentStartKeyIndex: exactKeyIndex };
        const insertionIndex = keyTimes.findIndex(keyTime => keyTime > boundaryTime);
        const segmentStartKeyIndex = Math.max(0, Math.min(keyTimes.length - 2, insertionIndex - 1));
        return { leftSegmentStartKeyIndex: segmentStartKeyIndex, rightSegmentStartKeyIndex: segmentStartKeyIndex };
      };
      const crossedBoundaries: RefinementTarget['measurementProvenance']['crossedBoundaries'] = [
        ...keyTimes.filter(crossesWindow).filter(boundaryTime => boundaryTime > 1e-8 && boundaryTime < keyTimes.at(-1)! - 1e-8).map(boundaryTime => ({
          kind: 'authored_key' as const, time: boundaryTime, ...segmentAround(boundaryTime),
        })),
        ...phaseMap.phases.slice(1).map(phase => phase.startTime).filter(crossesWindow).map(boundaryTime => ({
          kind: 'phase_marker' as const, time: boundaryTime, ...segmentAround(boundaryTime),
        })),
      ].sort((a, b) => a.time - b.time || compareOrdinal(a.kind, b.kind));
      const contactNote = overlappingContacts.length
        ? ` This event overlaps declared ${overlappingContacts.map(contact => `${contact.kind} contact on ${contact.effector}`).join(' and ')}; inspect contact stability and intent before changing it.`
        : '';
      const boundaryNote = crossedBoundaries.length
        ? ` Its finite-difference sample window crosses ${crossedBoundaries.map(boundary => `${boundary.kind === 'authored_key' ? 'key' : 'phase'} boundary at ${formatAnimationTime(boundary.time)}s`).join(', ')}; the reported patch segment is selected by event time, so inspect both sides before editing.`
        : '';
      const signalMeaning = descriptor.signal.includes('Speed')
        ? 'Local pose change per second; a high value may be intentional for a fast action.'
        : descriptor.signal.includes('Acceleration')
          ? 'Change in local pose speed; this can reflect a deliberate sharp accent or curve transition.'
          : 'Change in local pose acceleration; this can reflect a deliberate snap, easing choice, or sampling sensitivity.';
      const evidenceScope = `Sampled at ${metric.evaluationCount} evaluations over the authored ${metric.channel} channel using local recipe transforms and the recorded outgoing easing. It excludes rig hierarchy, skinning, world-space motion, physics, and rendered appearance.`;
      const repairOptions = rootMotion
        ? [{ operation: 'root_motion_set', whenToUse: 'Only when viewport review confirms the authored travel or turn is unintended.', risk: 'Replaces the entire root-motion channel; can alter travel distance, turning, or loop trajectory.' }]
        : [
          { operation: 'set_easing', whenToUse: 'When the endpoint poses are right but the transition timing/acceleration reads incorrectly.', risk: 'Changes motion throughout this key segment and may shift contact timing.' },
          { operation: 'set_curve', whenToUse: 'When a custom Bezier timing curve is needed and the segment endpoints should remain fixed.', risk: 'Curve handles can create overshoot or sharp velocity changes; re-audit and preview.' },
          { operation: 'insert_key', whenToUse: 'When review identifies a specific missing breakdown pose that clarifies the arc, contact, or anticipation.', risk: 'Adds a new pose and can change silhouette, spacing, and neighboring interpolation.' },
        ];
      targets.push({
        rankWithinSignal: index + 1, signal: descriptor.signal, value, unit: descriptor.unit,
        joint: metric.joint, channel: metric.channel,
        ...(metric.layerId ? { layerId: metric.layerId } : {}), ...(metric.layerName ? { layerName: metric.layerName } : {}),
        eventTime: time, keySegment: segment,
        phaseContext: { source: phaseMap.source, label: phase.label, occurrence: phase.occurrence, startTime: phase.startTime, endTime: phase.endTime, boundaryMarkers: [...phase.boundaryMarkers, ...phase.endingMarkers] },
        overlappingContacts,
        interpretation: { signalMeaning, evidenceScope, issueStatus: 'unclassified', requiresVisualDecision: true },
        measurementProvenance: { sampleRateHz, derivativeOrder, sampleWindow, segmentAttribution: 'segment_containing_event_time', crossedBoundaries },
        repairOptions,
        suggestedNextStep: rootMotion
          ? `Preview the ${phaseName} around ${formatAnimationTime(time)}s and decide whether this root-motion impulse is intentional.${contactNote}${boundaryNote} This measurement is not itself a defect. If you confirm a problem, preview root_motion_set as a whole-track replacement, compare the exact before/after trajectory, then re-audit and preview again.`
          : `Preview the ${phaseName} around ${formatAnimationTime(time)}s and decide whether this ${signalName} is intentional.${contactNote}${boundaryNote} This measurement is not itself a defect. If the endpoint poses are right, dry-run set_easing first; use set_curve only for a deliberate custom timing shape, and insert_key only for a specific missing breakdown. Preserve declared contact and accepted motion, compare before/after, then re-audit and preview again.`,
        patchFocus: {
          joint: metric.joint, ...(metric.layerId ? { layerId: metric.layerId } : {}), keyTime: segment.startTime,
          startKeyIndex: segment.startKeyIndex, endKeyIndex: segment.endKeyIndex,
          availableOperations: rootMotion ? ['root_motion_set'] : ['set_easing', 'set_curve', 'insert_key'],
        },
      });
    });
  }
  return targets;
}

function buildCoordination(curveMotion: CurveMotionMetric[], sampleRateHz: 30 | 60 | 120 | 240): CoordinationReport {
  const dimensionProfiles = (dimension: 'position' | 'angular') => curveMotion.filter(metric => metric.channel === 'base')
    .flatMap(metric => {
      const phase = metric.phaseTiming[dimension];
      return phase.status === 'active' && phase.onsetTime !== null && phase.peakTime !== null && phase.settleTime !== null
        ? [{ joint: metric.joint, onsetTime: phase.onsetTime, peakTime: phase.peakTime, settleTime: phase.settleTime, peakSpeed: phase.peakSpeed }]
        : [];
    });
  return coordinationFromProfiles(dimensionProfiles('position'), dimensionProfiles('angular'), sampleRateHz,
    'Independent base-track local channels only. Enabled/disabled layers and root motion remain separately reported and are not composed here; no hierarchy or world-space inference is made.');
}

function coordinationFromProfiles(positionProfiles: PhaseProfile[], angularProfiles: PhaseProfile[], sampleRateHz: 30 | 60 | 120 | 240,
  basis: string, sampleCoverage?: { uniformSampleCount: number; uniformSampleCapped: boolean }): CoordinationReport {
  const phaseLagWindowSeconds = 1 / sampleRateHz;
  const dimensionReport = (profiles: PhaseProfile[]) => {
    const synchronizedPeakGroups: CoordinationReport['position']['synchronizedPeakGroups'] = [];
    const sortedByPeak = [...profiles].sort((a, b) => a.peakTime - b.peakTime || compareOrdinal(a.joint, b.joint));
    for (let index = 0; index < sortedByPeak.length;) {
      const start = sortedByPeak[index]!.peakTime;
      const group = sortedByPeak.slice(index).filter(profile => profile.peakTime - start <= phaseLagWindowSeconds);
      if (group.length >= 2) {
        const end = group.at(-1)!.peakTime;
        synchronizedPeakGroups.push({ joints: group.map(profile => profile.joint), startTime: start, endTime: end, spreadSeconds: end - start });
        index += group.length;
      } else index++;
    }
    const pairLags = (phase: 'onsetTime' | 'peakTime') => {
      const relationships: PhaseRelationship[] = [];
      for (let left = 0; left < profiles.length; left++) for (let right = left + 1; right < profiles.length; right++) {
        const a = profiles[left]!, b = profiles[right]!;
        if (a.joint === b.joint) continue;
        const aTime = a[phase], bTime = b[phase];
        const aIsEarlier = aTime < bTime || (aTime === bTime && compareOrdinal(a.joint, b.joint) <= 0);
        const earlier = aIsEarlier ? a : b, later = aIsEarlier ? b : a;
        relationships.push({
          earlierJoint: earlier.joint, laterJoint: later.joint,
          lagSeconds: Math.abs(bTime - aTime),
          overlapSeconds: Math.max(0, Math.min(a.settleTime, b.settleTime) - Math.max(a.onsetTime, b.onsetTime)),
        });
      }
      return relationships.sort((a, b) => b.lagSeconds - a.lagSeconds || compareOrdinal(a.earlierJoint, b.earlierJoint)
        || compareOrdinal(a.laterJoint, b.laterJoint)).slice(0, 16);
    };
    return {
      activeJointCount: profiles.length, synchronizedPeakGroups,
      largestOnsetLags: pairLags('onsetTime'), largestPeakLags: pairLags('peakTime'),
    };
  };
  return {
    basis, ...sampleCoverage,
    sampleRateHz, phaseLagWindowSeconds,
    position: dimensionReport(positionProfiles), angular: dimensionReport(angularProfiles),
  };
}

function buildComposedCoordination(recipe: AnimationRecipe, sampleRateHz: 30 | 60 | 120 | 240): CoordinationReport {
  const activeTracks = [...recipe.tracks,
    ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks),
    ...(recipe.rootMotion ? [recipe.rootMotion] : [])];
  const joints = [...new Set(activeTracks.map(track => track.joint))].sort(compareOrdinal);
  const requestedIntervals = Math.max(1, Math.ceil(recipe.duration * sampleRateHz));
  const intervalCount = Math.min(256, requestedIntervals);
  const uniformTimes = Array.from({ length: intervalCount + 1 }, (_, index) => index === intervalCount
    ? recipe.duration : recipe.duration * index / intervalCount);
  const positionProfiles: PhaseProfile[] = [], angularProfiles: PhaseProfile[] = [];
  for (const joint of joints) {
    const sampler = createComposedJointSampler(recipe, joint);
    if (!sampler) continue;
    const authoredTimes = activeTracks.filter(track => track.joint === joint).flatMap(track => track.keys
      .map(key => key.time).filter(time => time > 0 && time < recipe.duration));
    const times = [...new Set([...uniformTimes, ...authoredTimes])].sort((left, right) => left - right);
    const velocities = makeVelocities(times, times.map(time => sampler(time)));
    const profileFor = (dimension: 'position' | 'angular') => {
      const phase = phaseTiming(velocities, dimension);
      return phase.status === 'active' && phase.onsetTime !== null && phase.peakTime !== null && phase.settleTime !== null
        ? { joint, onsetTime: phase.onsetTime, peakTime: phase.peakTime, settleTime: phase.settleTime, peakSpeed: phase.peakSpeed }
        : undefined;
    };
    const position = profileFor('position'), angular = profileFor('angular');
    if (position) positionProfiles.push(position);
    if (angular) angularProfiles.push(angular);
  }
  return coordinationFromProfiles(positionProfiles, angularProfiles, sampleRateHz,
    'Composed local joint trajectories sampled after base tracks, enabled weighted layers in stack order, and matching root-motion channels. Disabled and zero-weight layers are excluded. This is resultant local motion, not per-source attribution; it does not infer hierarchy, world-space travel, rendered quality, or intent.',
    { uniformSampleCount: intervalCount + 1, uniformSampleCapped: requestedIntervals > intervalCount });
}

function phasePoseProgression(recipe: AnimationRecipe, window: ActionPhaseWindow, detailLimit: number, sampleRateHz: number) {
  const tracks = [...recipe.tracks, ...(recipe.layers ?? []).flatMap(layer => layer.tracks), ...(recipe.rootMotion ? [recipe.rootMotion] : [])];
  const joints = [...new Set(tracks.map(track => track.joint))].sort(compareOrdinal);
  const requestedIntervals = Math.max(1, Math.ceil((window.endTime - window.startTime) * sampleRateHz));
  const intervalCount = Math.min(256, requestedIntervals);
  const uniformTimes = Array.from({ length: intervalCount + 1 }, (_, index) => index === intervalCount
    ? window.endTime : window.startTime + (window.endTime - window.startTime) * index / intervalCount);
  const metrics = joints.flatMap(joint => {
    const sampler = createComposedJointSampler(recipe, joint);
    if (!sampler) return [];
    const keyTimes = tracks.filter(track => track.joint === joint).flatMap(track => track.keys
      .filter(key => key.time > window.startTime && key.time < window.endTime).map(key => key.time));
    const times = [...new Set([...uniformTimes, ...keyTimes])].sort((left, right) => left - right);
    const entry = sampler(window.startTime), exit = sampler(window.endTime);
    let peakTranslationFromEntryStuds = 0, peakTranslationTime = window.startTime;
    let peakRotationFromEntryDegrees = 0, peakRotationTime = window.startTime;
    for (const time of times) {
      const pose = sampler(time);
      const translation = vectorMagnitude(pose.position.map((value, axis) => value - entry.position[axis]!) as Vector3);
      const rotation = vectorMagnitude(quaternionDeltaDegrees(entry.rotation, pose.rotation));
      if (translation > peakTranslationFromEntryStuds) { peakTranslationFromEntryStuds = translation; peakTranslationTime = time; }
      if (rotation > peakRotationFromEntryDegrees) { peakRotationFromEntryDegrees = rotation; peakRotationTime = time; }
    }
    return [{
      joint,
      entry: { position: entry.position, rotationQuaternion: entry.rotation },
      exit: { position: exit.position, rotationQuaternion: exit.rotation },
      netTranslationStuds: vectorMagnitude(exit.position.map((value, axis) => value - entry.position[axis]!) as Vector3),
      netRotationDegrees: vectorMagnitude(quaternionDeltaDegrees(entry.rotation, exit.rotation)),
      peakTranslationFromEntryStuds, peakTranslationTime, peakRotationFromEntryDegrees, peakRotationTime,
      evaluationCount: times.length,
    }];
  }).sort((left, right) => right.peakRotationFromEntryDegrees - left.peakRotationFromEntryDegrees
    || right.peakTranslationFromEntryStuds - left.peakTranslationFromEntryStuds || compareOrdinal(left.joint, right.joint));
  return {
    basis: 'Composed local joint transforms sampled from base tracks, enabled weighted layers in stack order, and matching root-motion tracks. Rotation uses quaternion angular distance. No parent hierarchy, world-space trajectory, rendered appearance, or physical contact is inferred.',
    sampleRateHz, uniformSampleCount: intervalCount + 1, uniformSampleCapped: requestedIntervals > intervalCount,
    jointCount: metrics.length, omittedJointCount: Math.max(0, metrics.length - detailLimit), joints: metrics.slice(0, detailLimit),
  };
}

function buildActionPhaseMap(recipe: AnimationRecipe, analyses: CurveMotionAnalysis[], detailLimitPerPhase: number, sampleRateHz: number): ActionPhaseMap {
  const extracted = extractActionPhaseWindows(recipe);
  const windows = extracted.phases;
  const phases = windows.map(window => {
    const activeChannels = analyses.flatMap(analysis => {
      const metric = analysis.metric;
      const position = metric.phaseTiming.position;
      const angular = metric.phaseTiming.angular;
      const positionActive = position.status === 'active' && position.onsetTime! < window.endTime && position.settleTime! > window.startTime;
      const angularActive = angular.status === 'active' && angular.onsetTime! < window.endTime && angular.settleTime! > window.startTime;
      if (!positionActive && !angularActive) return [];
      return [{
        joint: metric.joint, channel: metric.channel,
        ...(metric.layerId ? { layerId: metric.layerId } : {}), ...(metric.layerName ? { layerName: metric.layerName } : {}),
        ...(positionActive ? { positionWindow: { startTime: Math.max(window.startTime, position.onsetTime!), peakTime: position.peakTime! >= window.startTime && position.peakTime! < window.endTime ? position.peakTime : null, settleTime: Math.min(window.endTime, position.settleTime!) } } : {}),
        ...(angularActive ? { angularWindow: { startTime: Math.max(window.startTime, angular.onsetTime!), peakTime: angular.peakTime! >= window.startTime && angular.peakTime! < window.endTime ? angular.peakTime : null, settleTime: Math.min(window.endTime, angular.settleTime!) } } : {}),
      }];
    }).sort((a, b) => compareOrdinal(a.joint, b.joint) || compareOrdinal(a.channel, b.channel)
      || compareOrdinal(a.layerId ?? '', b.layerId ?? ''));
    const peakEvents = analyses.flatMap(analysis => analysis.segmentPeaks.flatMap(segment => {
      const metric = analysis.metric;
      const events: ActionPhase['peakEvents'] = [];
      if (segment.position.value > 0 && segment.position.time >= window.startTime && segment.position.time < window.endTime) events.push({
        joint: metric.joint, channel: metric.channel, ...(metric.layerId ? { layerId: metric.layerId } : {}), dimension: 'position',
        peakTime: segment.position.time, peakSpeed: segment.position.value, unit: 'studs/second', keySegment: segment.keySegment,
      });
      if (segment.angular.value > 0 && segment.angular.time >= window.startTime && segment.angular.time < window.endTime) events.push({
        joint: metric.joint, channel: metric.channel, ...(metric.layerId ? { layerId: metric.layerId } : {}), dimension: 'angular',
        peakTime: segment.angular.time, peakSpeed: segment.angular.value, unit: 'degrees/second', keySegment: segment.keySegment,
      });
      return events;
    })).sort((a, b) => compareOrdinal(a.dimension, b.dimension) || b.peakSpeed - a.peakSpeed || a.peakTime - b.peakTime
      || compareOrdinal(a.joint, b.joint) || compareOrdinal(a.channel, b.channel) || compareOrdinal(a.layerId ?? '', b.layerId ?? ''));
    const selectedEvents = [
      ...peakEvents.filter(event => event.dimension === 'position').slice(0, detailLimitPerPhase),
      ...peakEvents.filter(event => event.dimension === 'angular').slice(0, detailLimitPerPhase),
    ].sort((a, b) => a.peakTime - b.peakTime || compareOrdinal(a.dimension, b.dimension) || compareOrdinal(a.joint, b.joint)
      || compareOrdinal(a.channel, b.channel) || compareOrdinal(a.layerId ?? '', b.layerId ?? ''));
    return {
      label: window.label, occurrence: window.occurrence, startTime: window.startTime, endTime: window.endTime, duration: window.endTime - window.startTime,
      boundaryMarkers: window.boundaryMarkers, endingMarkers: window.endingMarkers, boundaryLabels: window.boundaryLabels,
      activeChannelCount: activeChannels.length, activeChannels: activeChannels.slice(0, detailLimitPerPhase),
      omittedActiveChannelCount: Math.max(0, activeChannels.length - detailLimitPerPhase),
      peakEvents: selectedEvents, omittedPeakEventCount: Math.max(0, peakEvents.length - selectedEvents.length),
      poseProgression: phasePoseProgression(recipe, window, detailLimitPerPhase, sampleRateHz),
      contacts: (recipe.contacts ?? []).filter(contact => contact.start < window.endTime && contact.end > window.startTime)
        .map(contact => ({ effector: contact.effector, kind: contact.kind, start: Math.max(window.startTime, contact.start), end: Math.min(window.endTime, contact.end) })),
    };
  });
  return {
    source: extracted.source,
    markerRule: 'Explicit marker.phase metadata takes precedence: anticipation, main_action, follow_through, and recovery label boundaries; event excludes the marker from phase segmentation. For legacy markers with no phase field, recognized names (anticipation/windup/preparation, action/attack/strike/impact/release/cast, follow-through, recovery/settle/return) retain name-based inference. Ordinary events can use phase:event to disambiguate a phase-like name. Without any recognized phase marker, the full clip is returned as unsegmented; intent is not inferred from motion peaks.',
    detailLimitPerPhase, phases,
  };
}

function shortestAngularDelta(from: number, to: number) {
  const difference = to - from;
  return ((difference + 180) % 360 + 360) % 360 - 180;
}

function trackMotionMetric(track: AnimationRecipe['tracks'][number], context: Omit<TrackMotionMetric, 'joint' | 'peakLocalPositionSpeed' | 'peakLocalAngularSpeed' | 'largestLocalPositionVelocityChange' | 'largestLocalAngularVelocityChange'>): TrackMotionMetric {
  const segments = track.keys.slice(1).map((right, index) => {
    const left = track.keys[index]!;
    const seconds = right.time - left.time;
    const positionDelta = left.position.map((value, axis) => right.position[axis]! - value);
    const angularDelta = left.rotation.map((value, axis) => shortestAngularDelta(value, right.rotation[axis]!));
    const magnitude = (values: number[]) => Math.hypot(...values) / seconds;
    return {
      startTime: left.time, endTime: right.time, startKeyIndex: index, endKeyIndex: index + 1,
      positionVelocity: positionDelta.map(value => value / seconds),
      angularVelocity: angularDelta.map(value => value / seconds),
      positionSpeed: magnitude(positionDelta), angularSpeed: magnitude(angularDelta),
    };
  });
  const peakPosition = segments.reduce((best, current) => current.positionSpeed > best.positionSpeed ? current : best, segments[0]!);
  const peakAngular = segments.reduce((best, current) => current.angularSpeed > best.angularSpeed ? current : best, segments[0]!);
  const largestChange = (dimension: 'position' | 'angular') => {
    const velocityKey = dimension === 'position' ? 'positionVelocity' : 'angularVelocity';
    let result: { magnitude: number; time: number; keyIndex: number } | null = null;
    for (let index = 1; index < segments.length; index++) {
      const before = segments[index - 1]!;
      const after = segments[index]!;
      const elapsed = (before.endTime - before.startTime + after.endTime - after.startTime) / 2;
      const velocityDelta = before[velocityKey].map((value, axis) => after[velocityKey][axis]! - value);
      const magnitude = Math.hypot(...velocityDelta) / elapsed;
      if (!result || magnitude > result.magnitude) result = { magnitude, time: before.endTime, keyIndex: index };
    }
    return result;
  };
  const positionChange = largestChange('position');
  const angularChange = largestChange('angular');
  return {
    ...context,
    joint: track.joint,
    peakLocalPositionSpeed: { unitsPerSecond: peakPosition.positionSpeed, startTime: peakPosition.startTime, endTime: peakPosition.endTime, startKeyIndex: peakPosition.startKeyIndex, endKeyIndex: peakPosition.endKeyIndex },
    peakLocalAngularSpeed: { degreesPerSecond: peakAngular.angularSpeed, startTime: peakAngular.startTime, endTime: peakAngular.endTime, startKeyIndex: peakAngular.startKeyIndex, endKeyIndex: peakAngular.endKeyIndex },
    largestLocalPositionVelocityChange: positionChange ? { unitsPerSecondSquared: positionChange.magnitude, time: positionChange.time, keyIndex: positionChange.keyIndex } : null,
    largestLocalAngularVelocityChange: angularChange ? { degreesPerSecondSquared: angularChange.magnitude, time: angularChange.time, keyIndex: angularChange.keyIndex } : null,
  };
}

/** Structural coaching only: these checks cannot determine whether motion looks good. */
export function auditAnimation(recipe: AnimationRecipe, sampleRateHz: 30 | 60 | 120 | 240 = 60, phaseDetailLimit = 6): { summary: { tracks: number; keys: number; duration: number; loop: boolean; layerTracks: number; rootMotionTracks: number; analyzedTracks: number; analyzedKeys: number }; trackMotion: TrackMotionMetric[]; contactTrackCoverage: ContactTrackCoverage[]; curveMotionSampleRateHz: number; curveMotion: CurveMotionMetric[]; loopSeamVelocity: LoopSeamVelocityMetric[]; composedLoopSeam: ReturnType<typeof composedLoopBoundaries>; coordination: CoordinationReport; composedCoordination: CoordinationReport; actionPhaseMap: ActionPhaseMap; refinementPlan: RefinementTarget[]; advisories: AnimationAdvisory[]; limitation: string } {
  if (![30, 60, 120, 240].includes(sampleRateHz)) throw new RangeError('sampleRateHz must be one of 30, 60, 120, or 240.');
  if (!Number.isInteger(phaseDetailLimit) || phaseDetailLimit < 1 || phaseDetailLimit > 16) {
    throw new RangeError('phaseDetailLimit must be an integer between 1 and 16.');
  }
  const layers = recipe.layers ?? [];
  const layerTracks = layers.flatMap(layer => layer.tracks.map(track => ({ track, context: { channel: 'layer' as const, layerId: layer.id, layerName: layer.name, enabled: layer.enabled, blendMode: layer.blendMode, weight: layer.weight } })));
  const analysisTracks = [
    ...recipe.tracks.map(track => ({ track, context: { channel: 'base' as const } })),
    ...layerTracks,
    ...(recipe.rootMotion ? [{ track: recipe.rootMotion, context: { channel: 'rootMotion' as const } }] : []),
  ].sort((left, right) => compareOrdinal(left.track.joint, right.track.joint)
    || compareOrdinal(left.context.channel, right.context.channel)
    || compareOrdinal('layerId' in left.context ? left.context.layerId : '', 'layerId' in right.context ? right.context.layerId : ''));
  const keyCount = recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0);
  const analyzedKeyCount = analysisTracks.reduce((sum, item) => sum + item.track.keys.length, 0);
  const advisories: AnimationAdvisory[] = [];
  const contactTrackCoverage = (recipe.contacts ?? []).map((contact, contactIndex) => {
    const channels = [
      ...recipe.tracks.filter(track => track.joint === contact.effector).map(track => ({ source: 'base' as const, active: true })),
      ...(recipe.layers ?? []).flatMap(layer => layer.tracks.filter(track => track.joint === contact.effector).map(() => ({
        source: 'layer' as const, layerId: layer.id, layerName: layer.name, active: layer.enabled && layer.weight > 0,
      }))),
      ...(recipe.rootMotion?.joint === contact.effector ? [{ source: 'rootMotion' as const, active: true }] : []),
    ];
    return { contactIndex, effector: contact.effector, kind: contact.kind, startTime: contact.start, endTime: contact.end,
      status: channels.some(channel => channel.active) ? 'active_channel' as const
        : channels.length ? 'inactive_channels_only' as const : 'no_matching_channel' as const,
      channels };
  });
  if (contactTrackCoverage.some(contact => contact.status !== 'active_channel')) {
    const unresolved = contactTrackCoverage.filter(contact => contact.status !== 'active_channel');
    advisories.push({ id: 'contact-channel-coverage', severity: 'check',
        detail: `${unresolved.map(contact => `${contact.kind} ${contact.effector} (${formatAnimationTime(contact.startTime)}–${formatAnimationTime(contact.endTime)}s: ${contact.status})`).join(', ')}. Declared contact windows are intent metadata: a missing/disabled channel can still be intentional rest-pose contact, and an active channel does not prove the effector is planted, gripping, or visually touching. Inspect the target rig and sampled/rendered evidence; do not treat this check as a failure or invent a pass threshold.`,
    });
  }
  const trackMotion = analysisTracks.map(item => trackMotionMetric(item.track, item.context));
  const curveAnalyses = analysisTracks.map(item => curveMotionMetric(item.track, item.context, sampleRateHz));
  const curveMotion = curveAnalyses.map(analysis => analysis.metric);
  const loopSeamVelocity = recipe.loop ? analysisTracks.map(item => loopSeamVelocityMetric(item.track, item.context, recipe.duration)) : [];
  const coordination = buildCoordination(curveMotion, sampleRateHz);
  const composedCoordination = buildComposedCoordination(recipe, sampleRateHz);
  const actionPhaseMap = buildActionPhaseMap(recipe, curveAnalyses, phaseDetailLimit, sampleRateHz);
  const refinementPlan = buildRefinementPlan(curveAnalyses, actionPhaseMap, sampleRateHz);
  const authoredTracks = [...recipe.tracks, ...layers.flatMap(layer => layer.tracks)];
  const sparseTracks = analysisTracks.filter(item => item.track.keys.length <= 2 && item.context.channel !== 'rootMotion');
  if (sparseTracks.length) advisories.push({
    id: 'sparse-tracks', severity: 'check',
    detail: `${sparseTracks.map(item => `${item.track.joint}${item.context.channel === 'layer' ? ` (layer ${item.context.layerName}${item.context.enabled ? '' : ', disabled'})` : ''}`).join(', ')} ${sparseTracks.length === 1 ? 'has' : 'have'} only endpoint keys. Check whether the action needs anticipation, a breakdown, contact, or recovery poses; do not add keys without a purpose.`,
  });
  const denseTracks = authoredTracks.filter(track => track.keys.length > 32).sort((left, right) => compareOrdinal(left.joint, right.joint));
  if (denseTracks.length) advisories.push({
    id: 'dense-tracks', severity: 'check',
    detail: `${denseTracks.map(track => track.joint).join(', ')} has more than 32 keys. Check for redundant keys and preserve only keys that shape timing, arcs, contacts, or secondary motion.`,
  });
  if (recipe.tracks.length >= 3) {
    const referenceTimes = recipe.tracks[0]!.keys.map(key => key.time);
    const sameAuthoredTime = (left: number, right: number) =>
      Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 4;
    const commonTiming = recipe.tracks.every(track => track.keys.length === referenceTimes.length
      && track.keys.every((key, index) => sameAuthoredTime(key.time, referenceTimes[index]!)));
    if (commonTiming) advisories.push({
      id: 'synchronized-timing', severity: 'check',
      detail: 'Every track uses the same key times. Check whether the whole body is moving in lockstep; stagger motion by role where the action calls for it.',
    });
  }
  if (recipe.loop) {
    const abruptTracks = loopSeamVelocity.filter(metric => metric.angularDiscontinuityDegreesPerSecond > 360);
    if (abruptTracks.length) advisories.push({
      id: 'loop-angular-seam', severity: 'check',
      detail: `${abruptTracks.map(metric => `${metric.joint}${metric.channel === 'rootMotion' ? ' (root motion)' : metric.channel === 'layer' ? ` (layer ${metric.layerName}${metric.enabled ? '' : ', disabled'})` : ''}`).join(', ')} has a large sampled local angular-velocity change at the loop seam. This advisory uses a 360 degrees/second heuristic, not an acceptance limit. Inspect composedLoopSeam and play through the boundary before changing timing or poses.`,
    });
    if (recipe.rootMotion) {
      const first = recipe.rootMotion.keys[0]!;
      const last = recipe.rootMotion.keys.at(-1)!;
      const endpointTranslation = vectorMagnitude(last.position.map((value, axis) => value - first.position[axis]!) as Vector3);
      const endpointRotation = vectorMagnitude(quaternionDeltaDegrees(eulerXYZDegreesToQuaternion(first.rotation), eulerXYZDegreesToQuaternion(last.rotation)));
      if (endpointTranslation > 0 || endpointRotation > 1e-6) {
        const seam = loopSeamVelocity.find(metric => metric.channel === 'rootMotion');
        advisories.push({
          id: 'root-motion-loop-travel', severity: 'check',
          detail: `The looping root-motion path has an endpoint offset of ${endpointTranslation.toFixed(3)} studs and ${endpointRotation.toFixed(3)} degrees; its measured seam velocity discontinuity is ${seam?.positionDiscontinuityStudsPerSecond.toFixed(3)} studs/second and ${seam?.angularDiscontinuityDegreesPerSecond.toFixed(3)} degrees/second. Different root-motion endpoints can be intentional for a traveling or turning cycle: inspect the wrap on the target rig and preserve intended displacement rather than forcing endpoint transforms to match.`,
        });
      }
    }
  }
  advisories.push({
    id: 'visual-review', severity: 'note',
    detail: 'Preview the motion on the target rig. Judge silhouette, readable intent, weight shifts, contacts, arcs, spacing, and transitions. Numeric trackMotion values are finite differences of local recipe keys (not rendered/world-space measurements) and can highlight intervals to inspect, but cannot certify animation quality.',
  });
  return {
    summary: { tracks: recipe.tracks.length, keys: keyCount, duration: recipe.duration, loop: recipe.loop, layerTracks: layerTracks.length, rootMotionTracks: recipe.rootMotion ? 1 : 0, analyzedTracks: analysisTracks.length, analyzedKeys: analyzedKeyCount },
    trackMotion,
    contactTrackCoverage,
    advisories,
    curveMotionSampleRateHz: sampleRateHz,
    curveMotion,
    loopSeamVelocity,
    composedLoopSeam: composedLoopBoundaries(recipe),
    coordination,
    composedCoordination,
    actionPhaseMap,
    refinementPlan,
    limitation: 'Structural advisories and kinematic measurements cannot certify an artistic result or claim that the animation was visually inspected. trackMotion uses key-to-key finite differences; curveMotion samples the authored easing and shortest-path quaternion interpolation at the requested rate plus every key time, then estimates derivatives by finite differences. Both operate in local recipe coordinates and exclude rig hierarchy, skinning, rendered/world-space motion, and collision/physics.',
  };
}
