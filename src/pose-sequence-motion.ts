import type { AnimationRecipe } from './recipes.js';
import { createComposedJointSampler } from './animation-patch.js';

type Vector3 = [number, number, number];
type Quaternion = [number, number, number, number];
type Interval = { startTime: number; endTime: number; fromPoseNames: string[]; toPoseNames: string[];
  enteringJoints?: string[]; leavingJoints?: string[]; sharedJoints?: string[] };
type BoundaryCurveContext = { source: 'base' | 'layer' | 'root_motion'; layerId?: string; layerName?: string;
  blendMode?: 'Override' | 'Additive'; enabled: boolean; weight: number; keyAtBoundary: number | null;
  previousKeyTime: number | null; nextKeyTime: number | null;
  incomingEasing: { style: string; direction: string } | null; outgoingEasing: { style: string; direction: string } | null };
type Peak = { joint: string; value: number; time: number; windowStart: number; windowEnd: number };
type PeakEventContext = { markers: Array<{ name: string; time: number; offsetSeconds: number; phase?: string; value?: string }>;
  contacts: Array<{ effector: string; kind: 'support' | 'grip'; start: number; end: number; relation: 'active_at_peak' | 'overlaps_peak_window' }>;
  markerWindowSeconds: number; omittedMarkerCount: number; omittedContactCount: number };
type RefinedPeak = { joint: string; value: number; time: number; coarseValue: number;
  eventContext: PeakEventContext;
  refinement: { status: 'sampled' | 'budget_exhausted'; sampleRateHz: number; evaluationCount: number;
    windowStart: number; windowEnd: number; resolvedWithinFivePercent: boolean | null } };

const REQUESTED_SAMPLE_RATE_HZ = 60;
const MAX_COARSE_EVALUATIONS = 1_000_000;
const MAX_TOTAL_EVALUATIONS = 1_500_000;
const REFINEMENT_SAMPLE_RATE_HZ = 240;
const DETAIL_LIMIT = 8;
const REFINEMENT_POOL_SIZE = DETAIL_LIMIT * 2;
const EVENT_CONTEXT_LIMIT = 4;
const MARKER_CONTEXT_WINDOW_SECONDS = 0.25;

function magnitude(vector: Vector3) { return Math.hypot(...vector); }
function subtract(left: Vector3, right: Vector3): Vector3 { return left.map((value, index) => value - right[index]!) as Vector3; }
function scale(vector: Vector3, factor: number): Vector3 { return vector.map(value => value * factor) as Vector3; }

function angularDeltaDegrees(from: Quaternion, to: Quaternion): Vector3 {
  let target = to;
  const dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) target = to.map(value => -value) as Quaternion;
  const [x, y, z, w] = from;
  const [a, b, c, d] = target;
  const relative: Quaternion = [w * a - x * d - y * c + z * b,
    w * b + x * c - y * d - z * a, w * c - x * b + y * a - z * d,
    w * d + x * a + y * b + z * c];
  const vectorLength = Math.hypot(relative[0], relative[1], relative[2]);
  if (vectorLength < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(vectorLength, Math.max(0, relative[3])) * 180 / Math.PI;
  return [relative[0] * angle / vectorLength, relative[1] * angle / vectorLength, relative[2] * angle / vectorLength];
}

function sortPeaks(peaks: Peak[]) {
  return peaks.sort((left, right) => right.value - left.value || left.time - right.time || left.joint.localeCompare(right.joint));
}

function boundaryCurveContext(recipe: AnimationRecipe, joint: string, time: number): BoundaryCurveContext[] {
  const channels: Array<{ source: BoundaryCurveContext['source']; track: AnimationRecipe['tracks'][number];
    layerId?: string; layerName?: string; blendMode?: 'Override' | 'Additive'; enabled: boolean; weight: number }> = [];
  const base = recipe.tracks.find(track => track.joint === joint);
  if (base) channels.push({ source: 'base', track: base, enabled: true, weight: 1 });
  for (const layer of recipe.layers ?? []) {
    const track = layer.tracks.find(candidate => candidate.joint === joint);
    if (track) channels.push({ source: 'layer', track, layerId: layer.id, layerName: layer.name,
      blendMode: layer.blendMode, enabled: layer.enabled, weight: layer.weight });
  }
  if (recipe.rootMotion?.joint === joint) channels.push({ source: 'root_motion', track: recipe.rootMotion, enabled: true, weight: 1 });
  return channels.map(channel => {
    const keys = channel.track.keys;
    const keyAt = keys.find(key => Math.abs(key.time - time) <= 1e-9);
    const previous = [...keys].reverse().find(key => key.time < time - 1e-9);
    const next = keys.find(key => key.time > time + 1e-9);
    const easing = (key: typeof keys[number] | undefined) => key
      ? { style: key.easingStyle ?? 'Linear', direction: key.easingDirection ?? 'Out' } : null;
    return { source: channel.source, ...(channel.layerId ? { layerId: channel.layerId } : {}),
      ...(channel.layerName ? { layerName: channel.layerName } : {}), ...(channel.blendMode ? { blendMode: channel.blendMode } : {}),
      enabled: channel.enabled, weight: channel.weight, keyAtBoundary: keyAt?.time ?? null,
      previousKeyTime: previous?.time ?? null, nextKeyTime: next?.time ?? null,
      incomingEasing: easing(previous), outgoingEasing: easing(keyAt ?? previous) };
  });
}

function peakEventContext(recipe: AnimationRecipe, time: number, windowStart: number, windowEnd: number): PeakEventContext {
  const markerWindowStart = Math.max(0, Math.min(windowStart, time - MARKER_CONTEXT_WINDOW_SECONDS));
  const markerWindowEnd = Math.min(recipe.duration, Math.max(windowEnd, time + MARKER_CONTEXT_WINDOW_SECONDS));
  const nearbyMarkers = recipe.markers.filter(marker => marker.time >= markerWindowStart - 1e-9 && marker.time <= markerWindowEnd + 1e-9)
    .sort((left, right) => Number(!(left.time >= windowStart - 1e-9 && left.time <= windowEnd + 1e-9))
      - Number(!(right.time >= windowStart - 1e-9 && right.time <= windowEnd + 1e-9))
      || Math.abs(left.time - time) - Math.abs(right.time - time) || left.time - right.time || left.name.localeCompare(right.name));
  const contacts = (recipe.contacts ?? []).filter(contact => contact.end >= windowStart && contact.start <= windowEnd)
    .map(contact => ({ ...contact, relation: contact.start <= time && contact.end >= time
      ? 'active_at_peak' as const : 'overlaps_peak_window' as const }))
    .sort((left, right) => Number(right.relation === 'active_at_peak') - Number(left.relation === 'active_at_peak')
      || Math.min(Math.abs(time - left.start), Math.abs(time - left.end)) - Math.min(Math.abs(time - right.start), Math.abs(time - right.end))
      || left.effector.localeCompare(right.effector) || left.kind.localeCompare(right.kind));
  return { markers: nearbyMarkers.slice(0, EVENT_CONTEXT_LIMIT).map(marker => ({ name: marker.name, time: marker.time,
    offsetSeconds: Number((marker.time - time).toFixed(6)), ...(marker.phase ? { phase: marker.phase } : {}),
    ...(marker.value !== undefined ? { value: marker.value } : {}) })),
    contacts: contacts.slice(0, EVENT_CONTEXT_LIMIT), markerWindowSeconds: MARKER_CONTEXT_WINDOW_SECONDS,
    omittedMarkerCount: Math.max(0, nearbyMarkers.length - EVENT_CONTEXT_LIMIT),
    omittedContactCount: Math.max(0, contacts.length - EVENT_CONTEXT_LIMIT) };
}

/** Measure composed local motion and refine the strongest sampled events in a bounded neighborhood. */
export function analyzePoseSequenceTransitions(recipe: AnimationRecipe, intervals: Interval[]) {
  if (!intervals.length) return { sampleRateHz: REQUESTED_SAMPLE_RATE_HZ, effectiveSampleRateHz: 0,
    coarseEvaluationCount: 0, refinementEvaluationCount: 0, evaluationCount: 0,
    coarseEvaluationBudget: MAX_COARSE_EVALUATIONS, totalEvaluationBudget: MAX_TOTAL_EVALUATIONS,
    refinementRateHz: REFINEMENT_SAMPLE_RATE_HZ, refinementPoolPerSignal: REFINEMENT_POOL_SIZE,
    detailLimitPerSignal: DETAIL_LIMIT, intervals: [], boundaryEvaluationCount: 0,
    boundaryContinuity: { boundaryCount: 0, evaluationCount: 0, positionVelocityDiscontinuities: [], angularVelocityDiscontinuities: [],
      limitation: 'No distinct-time pose intervals were supplied for analysis.' },
    limitation: 'No distinct-time pose intervals were supplied for analysis.' };
  if (intervals.length > 31) throw new Error('Pose-transition analysis accepts at most 31 chronological intervals.');
  let previousEnd = 0;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.startTime) || !Number.isFinite(interval.endTime)
      || interval.startTime < previousEnd || interval.endTime <= interval.startTime || interval.endTime > recipe.duration) {
      throw new Error('Pose-transition intervals must be positive, chronological, non-overlapping, and within the animation duration.');
    }
    previousEnd = interval.endTime;
  }
  const joints = [...new Set([
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ])].sort((left, right) => left.localeCompare(right));
  const totalDuration = intervals.reduce((sum, interval) => sum + interval.endTime - interval.startTime, 0);
  const authoredKeyCount = recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0)
    + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.reduce((trackSum, track) => trackSum + track.keys.length, 0), 0)
    + (recipe.rootMotion?.keys.length ?? 0);
  const boundaries = intervals.slice(1).flatMap((right, index) => {
    const left = intervals[index]!;
    return Math.abs(left.endTime - right.startTime) <= 1e-9 ? [{ left, right, time: right.startTime }] : [];
  });
  const boundaryWorkEstimate = boundaries.length * joints.length * 3;
  const fixedScheduleBudget = MAX_COARSE_EVALUATIONS - authoredKeyCount - 2 * joints.length * intervals.length - boundaryWorkEstimate;
  const effectiveSampleRateHz = joints.length && totalDuration > 0
    ? Math.min(REQUESTED_SAMPLE_RATE_HZ, Math.max(1, Math.floor(fixedScheduleBudget / (joints.length * totalDuration))))
    : REQUESTED_SAMPLE_RATE_HZ;
  let coarseEvaluationCount = 0, refinementEvaluationCount = 0;

  const refine = (peaks: Peak[], signal: 'speed' | 'acceleration', dimension: 'position' | 'angular'): RefinedPeak[] => {
    const candidates = sortPeaks(peaks).filter(peak => peak.value > 0).slice(0, REFINEMENT_POOL_SIZE);
    const refined = candidates.map(peak => {
      const sampler = createComposedJointSampler(recipe, peak.joint);
      const span = peak.windowEnd - peak.windowStart;
      const remaining = MAX_TOTAL_EVALUATIONS - coarseEvaluationCount - boundaryWorkEstimate - refinementEvaluationCount;
      const stepBudget = Math.max(0, remaining - 1);
      if (!sampler || span <= 0 || stepBudget < 2) return {
        joint: peak.joint, value: Number(peak.value.toFixed(6)), time: Number(peak.time.toFixed(6)),
        coarseValue: Number(peak.value.toFixed(6)),
        eventContext: peakEventContext(recipe, peak.time, peak.windowStart, peak.windowEnd),
        refinement: { status: 'budget_exhausted' as const, sampleRateHz: 0, evaluationCount: 0,
          windowStart: Number(peak.windowStart.toFixed(6)), windowEnd: Number(peak.windowEnd.toFixed(6)), resolvedWithinFivePercent: null },
      };
      const requestedSteps = Math.max(2, Math.ceil(span * REFINEMENT_SAMPLE_RATE_HZ));
      const steps = Math.min(requestedSteps, stepBudget);
      const times = Array.from({ length: steps + 1 }, (_unused, index) => peak.windowStart + span * index / steps);
      const poses = times.map(time => sampler(time));
      refinementEvaluationCount += poses.length;
      const velocities = times.slice(1).map((time, index) => {
        const start = times[index]!, seconds = time - start;
        const before = poses[index]!, after = poses[index + 1]!;
        return { midpoint: (start + time) / 2,
          position: scale(subtract(after.position, before.position), 1 / seconds),
          angular: scale(angularDeltaDegrees(before.rotation, after.rotation), 1 / seconds) };
      });
      const measurements = signal === 'speed' ? velocities.map(velocity => ({ value: magnitude(velocity[dimension]), time: velocity.midpoint }))
        : velocities.slice(1).map((velocity, index) => {
          const before = velocities[index]!;
          const seconds = velocity.midpoint - before.midpoint;
          return { value: magnitude(scale(subtract(velocity[dimension], before[dimension]), 1 / seconds)),
            time: (velocity.midpoint + before.midpoint) / 2 };
        });
      let refinedValue = 0, refinedTime = peak.time;
      for (const measurement of measurements) if (measurement.value > refinedValue) {
        refinedValue = measurement.value; refinedTime = measurement.time;
      }
      return { joint: peak.joint, value: Number(refinedValue.toFixed(6)), time: Number(refinedTime.toFixed(6)),
        coarseValue: Number(peak.value.toFixed(6)),
        eventContext: peakEventContext(recipe, refinedTime, peak.windowStart, peak.windowEnd),
        refinement: { status: 'sampled' as const, sampleRateHz: Number((steps / span).toFixed(3)), evaluationCount: poses.length,
          windowStart: Number(peak.windowStart.toFixed(6)), windowEnd: Number(peak.windowEnd.toFixed(6)),
          resolvedWithinFivePercent: Math.abs(refinedValue - peak.value) <= Math.max(peak.value * 0.05, 1e-6) },
      };
    });
    return refined.sort((left, right) => right.value - left.value || left.time - right.time || left.joint.localeCompare(right.joint)).slice(0, DETAIL_LIMIT);
  };

  const coarseIntervals = intervals.map(interval => {
    const duration = interval.endTime - interval.startTime;
    const uniformSteps = Math.max(1, Math.ceil(duration * effectiveSampleRateHz));
    const positionSpeed: Peak[] = [], angularSpeed: Peak[] = [];
    const positionAcceleration: Peak[] = [], angularAcceleration: Peak[] = [];
    for (const joint of joints) {
      const sample = createComposedJointSampler(recipe, joint);
      if (!sample) continue;
      const tracks = [
        ...recipe.tracks.filter(track => track.joint === joint),
        ...(recipe.layers ?? []).flatMap(layer => layer.tracks.filter(track => track.joint === joint)),
        ...(recipe.rootMotion?.joint === joint ? [recipe.rootMotion] : []),
      ];
      const times = new Set<number>([interval.startTime, interval.endTime]);
      for (let step = 1; step < uniformSteps; step++) times.add(interval.startTime + duration * step / uniformSteps);
      for (const track of tracks) for (const key of track.keys) {
        if (key.time > interval.startTime && key.time < interval.endTime) times.add(key.time);
      }
      const orderedTimes = [...times].sort((left, right) => left - right);
      const poses = orderedTimes.map(time => sample(time));
      coarseEvaluationCount += poses.length;
      const localPeaks = {
        positionSpeed: { joint, value: 0, time: interval.startTime, windowStart: interval.startTime, windowEnd: interval.endTime },
        angularSpeed: { joint, value: 0, time: interval.startTime, windowStart: interval.startTime, windowEnd: interval.endTime },
        positionAcceleration: { joint, value: 0, time: interval.startTime, windowStart: interval.startTime, windowEnd: interval.endTime },
        angularAcceleration: { joint, value: 0, time: interval.startTime, windowStart: interval.startTime, windowEnd: interval.endTime },
      };
      const velocities = orderedTimes.slice(1).map((time, index) => {
        const previousTime = orderedTimes[index]!, seconds = time - previousTime;
        const before = poses[index]!, after = poses[index + 1]!;
        return { startTime: previousTime, endTime: time, midpoint: (previousTime + time) / 2,
          position: scale(subtract(after.position, before.position), 1 / seconds),
          angular: scale(angularDeltaDegrees(before.rotation, after.rotation), 1 / seconds) };
      });
      for (const velocity of velocities) {
        const positionValue = magnitude(velocity.position), angularValue = magnitude(velocity.angular);
        if (positionValue > localPeaks.positionSpeed.value) localPeaks.positionSpeed = { joint, value: positionValue, time: velocity.midpoint, windowStart: velocity.startTime, windowEnd: velocity.endTime };
        if (angularValue > localPeaks.angularSpeed.value) localPeaks.angularSpeed = { joint, value: angularValue, time: velocity.midpoint, windowStart: velocity.startTime, windowEnd: velocity.endTime };
      }
      for (let index = 1; index < velocities.length; index++) {
        const before = velocities[index - 1]!, after = velocities[index]!;
        const seconds = after.midpoint - before.midpoint;
        const time = (before.midpoint + after.midpoint) / 2;
        const positionValue = magnitude(scale(subtract(after.position, before.position), 1 / seconds));
        const angularValue = magnitude(scale(subtract(after.angular, before.angular), 1 / seconds));
        if (positionValue > localPeaks.positionAcceleration.value) localPeaks.positionAcceleration = { joint, value: positionValue, time, windowStart: before.startTime, windowEnd: after.endTime };
        if (angularValue > localPeaks.angularAcceleration.value) localPeaks.angularAcceleration = { joint, value: angularValue, time, windowStart: before.startTime, windowEnd: after.endTime };
      }
      positionSpeed.push(localPeaks.positionSpeed); angularSpeed.push(localPeaks.angularSpeed);
      positionAcceleration.push(localPeaks.positionAcceleration); angularAcceleration.push(localPeaks.angularAcceleration);
    }
    return { ...interval, duration, uniformSteps, measuredJointCount: joints.length,
      coarsePeaks: { positionSpeed, angularSpeed, positionAcceleration, angularAcceleration } };
  });
  const measuredIntervals = coarseIntervals.map(interval => ({
    startTime: interval.startTime, endTime: interval.endTime, fromPoseNames: interval.fromPoseNames,
    toPoseNames: interval.toPoseNames, duration: interval.duration, uniformSteps: interval.uniformSteps,
    measuredJointCount: interval.measuredJointCount,
    peaks: {
      positionSpeedStudsPerSecond: refine(interval.coarsePeaks.positionSpeed, 'speed', 'position'),
      angularSpeedDegreesPerSecond: refine(interval.coarsePeaks.angularSpeed, 'speed', 'angular'),
      positionAccelerationStudsPerSecondSquared: refine(interval.coarsePeaks.positionAcceleration, 'acceleration', 'position'),
      angularAccelerationDegreesPerSecondSquared: refine(interval.coarsePeaks.angularAcceleration, 'acceleration', 'angular'),
    },
  }));
  const positionVelocityDiscontinuities: Array<{ joint: string; time: number; value: number; sampleOffsetSeconds: number;
    fromPoseNames: string[]; toPoseNames: string[]; authoredCoverage: 'entering' | 'leaving' | 'shared' | 'not_authored';
    curveContext: BoundaryCurveContext[] }> = [];
  const angularVelocityDiscontinuities: typeof positionVelocityDiscontinuities = [];
  let boundaryEvaluationCount = 0;
  for (const boundary of boundaries) {
    const beforeDuration = boundary.time - boundary.left.startTime;
    const afterDuration = boundary.right.endTime - boundary.time;
    const offset = Math.min(1 / REQUESTED_SAMPLE_RATE_HZ, beforeDuration / 4, afterDuration / 4);
    if (!(offset > 0)) continue;
    const entering = new Set((boundary.left.enteringJoints ?? []).map(joint => joint.toLowerCase()));
    const leaving = new Set((boundary.left.leavingJoints ?? []).map(joint => joint.toLowerCase()));
    const shared = new Set((boundary.left.sharedJoints ?? []).map(joint => joint.toLowerCase()));
    for (const joint of joints) {
      const sample = createComposedJointSampler(recipe, joint);
      if (!sample) continue;
      const before = sample(boundary.time - offset);
      const center = sample(boundary.time);
      const after = sample(boundary.time + offset);
      boundaryEvaluationCount += 3;
      const beforePositionVelocity = scale(subtract(center.position, before.position), 1 / offset);
      const afterPositionVelocity = scale(subtract(after.position, center.position), 1 / offset);
      const beforeAngularVelocity = scale(angularDeltaDegrees(before.rotation, center.rotation), 1 / offset);
      const afterAngularVelocity = scale(angularDeltaDegrees(center.rotation, after.rotation), 1 / offset);
      const authoredCoverage = entering.has(joint.toLowerCase()) ? 'entering' as const
        : leaving.has(joint.toLowerCase()) ? 'leaving' as const
          : shared.has(joint.toLowerCase()) ? 'shared' as const : 'not_authored' as const;
      const context = { joint, time: boundary.time, sampleOffsetSeconds: Number(offset.toFixed(6)),
        fromPoseNames: boundary.left.fromPoseNames, toPoseNames: boundary.left.toPoseNames, authoredCoverage,
        curveContext: boundaryCurveContext(recipe, joint, boundary.time) };
      positionVelocityDiscontinuities.push({ ...context, value: Number(magnitude(subtract(afterPositionVelocity, beforePositionVelocity)).toFixed(6)) });
      angularVelocityDiscontinuities.push({ ...context, value: Number(magnitude(subtract(afterAngularVelocity, beforeAngularVelocity)).toFixed(6)) });
    }
  }
  const strongestBoundarySignals = (signals: typeof positionVelocityDiscontinuities) => signals
    .sort((left, right) => right.value - left.value || left.time - right.time || left.joint.localeCompare(right.joint)).slice(0, DETAIL_LIMIT);
  return { sampleRateHz: REQUESTED_SAMPLE_RATE_HZ, effectiveSampleRateHz,
    coarseEvaluationCount, boundaryEvaluationCount, refinementEvaluationCount,
    evaluationCount: coarseEvaluationCount + boundaryEvaluationCount + refinementEvaluationCount,
    coarseEvaluationBudget: MAX_COARSE_EVALUATIONS, totalEvaluationBudget: MAX_TOTAL_EVALUATIONS,
    refinementRateHz: REFINEMENT_SAMPLE_RATE_HZ, refinementPoolPerSignal: REFINEMENT_POOL_SIZE, detailLimitPerSignal: DETAIL_LIMIT,
    intervals: measuredIntervals,
    boundaryContinuity: { boundaryCount: boundaries.length, evaluationCount: boundaryEvaluationCount,
      positionVelocityDiscontinuities: strongestBoundarySignals(positionVelocityDiscontinuities),
      angularVelocityDiscontinuities: strongestBoundarySignals(angularVelocityDiscontinuities),
      limitation: 'One-sided finite-difference velocity gaps use offsets capped at 1/60s and one-quarter of either adjacent beat interval; closer beats therefore use shorter windows. They are inspection cues, not thresholds, continuous-time guarantees, or proof of a visible pop.' },
    limitation: 'Top coarse-sampled peaks receive local 240 Hz neighborhood refinement when the global work budget allows. resolvedWithinFivePercent compares those samples only; it is not a mathematical error bound and cannot detect a peak missed entirely by the coarse pass. Measurements are composed local channels, not world-space motion, rendered deformation, contact, physics, or artistic quality.' };
}
