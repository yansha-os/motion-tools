import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier, label, type AnimationRecipe, type Recipe } from './recipes.js';
import { sameAnimationTime } from './time-format.js';

const coordinate = z.number().finite().min(-10000).max(10000);
const point = z.tuple([coordinate, coordinate, coordinate]);
const orientation = z.tuple([
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
]);
const maxInspectionSamples = 128;
export const telemetrySchema = z.object({
  version: z.literal(1), source: z.literal('studio_pose_evaluator'), rigId: identifier, rigSignature: z.string().min(1).max(30000).optional(), assetId: identifier,
  duration: z.number().min(0.1).max(30), loop: z.boolean(), height: z.number().finite().min(0.1).max(10000),
  groundSource: z.enum(['rest_foot_bounds', 'rest_node_bounds']), note: z.string().max(2000),
  nodes: z.array(z.object({ name: label, parent: z.number().int().min(0).max(96), driven: z.boolean(), foot: z.boolean(),
    targetKind: z.enum(['Motor6D', 'AnimationConstraint', 'Bone']).optional() }).strict()).min(1).max(96),
  restPose: z.object({ points: z.array(point).min(1).max(96), orientations: z.array(orientation).min(1).max(96) }).strict().optional(),
  samples: z.array(z.object({ id: z.string().regex(/^s\d{3}$/), time: z.number().finite().min(0).max(30), points: z.array(point).min(1).max(96), pivotPoints: z.array(point).min(1).max(96).optional(), jointPoints: z.array(point).min(1).max(96).optional(), bottoms: z.array(coordinate).min(1).max(96), orientations: z.array(orientation).min(1).max(96).optional() }).strict()).min(2).max(maxInspectionSamples),
}).strict().superRefine((data, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(data.nodes.map(n => n.name)).size !== data.nodes.length) issue('Duplicate sampled node names.');
  if (data.nodes.some((n, index) => n.parent > index)) issue('Sampled hierarchy must be in parent-first order.');
  if (data.restPose && (data.restPose.points.length !== data.nodes.length || data.restPose.orientations.length !== data.nodes.length)) issue('Rest-pose node count differs from the declared rig.');
  if (data.restPose?.orientations.some(value => Math.abs(Math.hypot(...value) - 1) > 0.01)) issue('Rest-pose orientations must be unit quaternions.');
  const pivotPointSamples = data.samples.map(sample => sample.pivotPoints !== undefined);
  if (pivotPointSamples.some(Boolean) && pivotPointSamples.some(value => !value)) issue('Pivot-local positions must be present in every sample or none.');
  const jointPointSamples = data.samples.map(sample => sample.jointPoints !== undefined);
  if (jointPointSamples.some(Boolean) && jointPointSamples.some(value => !value)) issue('Joint-pivot positions must be present in every sample or none.');
  if (new Set(data.samples.map(s => s.id)).size !== data.samples.length) issue('Duplicate sample IDs.');
  if (data.samples[0]!.time !== 0 || data.samples.at(-1)!.time !== data.duration) issue('Sampled timeline does not cover the entire clip.');
  for (const [index, sample] of data.samples.entries()) {
    if (sample.points.length !== data.nodes.length || sample.bottoms.length !== data.nodes.length) issue('Sample node count differs from the declared rig.');
    if (sample.pivotPoints && sample.pivotPoints.length !== data.nodes.length) issue('Pivot-local sample node count differs from the declared rig.');
    if (sample.jointPoints && sample.jointPoints.length !== data.nodes.length) issue('Joint-pivot sample node count differs from the declared rig.');
    if (sample.orientations && sample.orientations.length !== data.nodes.length) issue('Sample orientation count differs from the declared rig.');
    if (sample.orientations?.some(value => Math.abs(Math.hypot(...value) - 1) > 0.01)) issue('Sample orientations must be unit quaternions.');
    if (index && sample.time <= data.samples[index - 1]!.time) issue('Sample times must increase.');
  }
});
export type Telemetry = z.infer<typeof telemetrySchema>;
export function resolveTelemetryNodeName(nodes: Telemetry['nodes'], name: string) {
  const exactIndex = nodes.findIndex(node => node.name === name);
  if (exactIndex >= 0) return { status: 'exact' as const, index: exactIndex };
  const normalizedName = name.toLocaleLowerCase('en-US');
  const matches = nodes.flatMap((node, index) => node.name.toLocaleLowerCase('en-US') === normalizedName ? [index] : []);
  if (matches.length === 1) return { status: 'case_insensitive' as const, index: matches[0]! };
  if (matches.length > 1) return { status: 'ambiguous' as const, candidates: matches.map(index => nodes[index]!.name) };
  return { status: 'missing' as const };
}

type SpatialTracePoint = { sampleId: string; time: number; position: [number, number, number]; orientation?: Quaternion; restOrientation?: Quaternion };
function selectSpatialTrace(points: SpatialTracePoint[], limit: number) {
  const selected = new Set<number>([0, points.length - 1]);
  const axisExtrema = (['x', 'y', 'z'] as const).map((axis, coordinate) => {
    let minimum = 0, maximum = 0;
    for (let index = 1; index < points.length; index++) {
      if (points[index]!.position[coordinate]! < points[minimum]!.position[coordinate]!) minimum = index;
      if (points[index]!.position[coordinate]! > points[maximum]!.position[coordinate]!) maximum = index;
    }
    selected.add(minimum);
    selected.add(maximum);
    return { axis, minimumSampleId: points[minimum]!.sampleId, maximumSampleId: points[maximum]!.sampleId };
  });
  let peakInterval: { startSampleId: string; endSampleId: string } | null = null;
  let peakIntervalIndexes: [number, number] | null = null;
  let peakSpeed = -1;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const seconds = point.time - previous.time;
    const speed = seconds > 0 ? distance(previous.position, point.position) / seconds : 0;
    if (speed > peakSpeed) {
      peakSpeed = speed;
      peakIntervalIndexes = [index - 1, index];
      peakInterval = { startSampleId: previous.sampleId, endSampleId: point.sampleId };
    }
  }
  if (peakIntervalIndexes) for (const index of peakIntervalIndexes) selected.add(index);
  let orientationEvidence: { referenceSampleId: string; maximumDriftSampleId: string; maximumDriftDegrees: number;
    peakAngularSpeedDegreesPerSecond: number | null;
    peakAngularSpeedIntervalSampleIds: { startSampleId: string; endSampleId: string } | null;
    maximumRestDeviation: { sampleId: string; degrees: number } | null } | null = null;
  if (points.every(point => point.orientation !== undefined)) {
    let maximumDriftIndex = 0, maximumDriftDegrees = 0;
    for (let index = 1; index < points.length; index++) {
      const drift = angularDistanceDegrees(points[0]!.orientation!, points[index]!.orientation!);
      if (drift > maximumDriftDegrees) { maximumDriftDegrees = drift; maximumDriftIndex = index; }
    }
    selected.add(maximumDriftIndex);
    let maximumRestDeviationIndex = -1, maximumRestDeviationDegrees = -1;
    if (points.every(point => point.restOrientation !== undefined)) {
      for (let index = 0; index < points.length; index++) {
        const deviation = angularDistanceDegrees(points[index]!.restOrientation!, points[index]!.orientation!);
        if (deviation > maximumRestDeviationDegrees) { maximumRestDeviationDegrees = deviation; maximumRestDeviationIndex = index; }
      }
      selected.add(maximumRestDeviationIndex);
    }
    let peakAngularInterval: [number, number] | null = null, peakAngularSpeed = -1;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!, point = points[index]!;
      const seconds = point.time - previous.time;
      const speed = seconds > 0 ? angularDistanceDegrees(previous.orientation!, point.orientation!) / seconds : 0;
      const tieTolerance = 1e-9 * Math.max(1, Math.abs(speed), Math.abs(peakAngularSpeed));
      if (peakAngularInterval === null || speed > peakAngularSpeed + tieTolerance) {
        peakAngularSpeed = speed;
        peakAngularInterval = [index - 1, index];
      }
    }
    if (peakAngularInterval) for (const index of peakAngularInterval) selected.add(index);
    orientationEvidence = { referenceSampleId: points[0]!.sampleId,
      maximumDriftSampleId: points[maximumDriftIndex]!.sampleId, maximumDriftDegrees,
      peakAngularSpeedDegreesPerSecond: peakAngularInterval ? Math.max(0, peakAngularSpeed) : null,
      peakAngularSpeedIntervalSampleIds: peakAngularInterval
        ? { startSampleId: points[peakAngularInterval[0]]!.sampleId, endSampleId: points[peakAngularInterval[1]]!.sampleId } : null,
      maximumRestDeviation: maximumRestDeviationIndex >= 0
        ? { sampleId: points[maximumRestDeviationIndex]!.sampleId, degrees: maximumRestDeviationDegrees } : null };
  }
  while (selected.size < Math.min(limit, points.length)) {
    const ordered = [...selected].sort((left, right) => left - right);
    let bestGap: { left: number; right: number; duration: number } | null = null;
    for (let index = 1; index < ordered.length; index++) {
      const left = ordered[index - 1]!, right = ordered[index]!;
      if (right - left <= 1) continue;
      const duration = points[right]!.time - points[left]!.time;
      if (!bestGap || duration > bestGap.duration) bestGap = { left, right, duration };
    }
    if (!bestGap) break;
    const midpointTime = (points[bestGap.left]!.time + points[bestGap.right]!.time) / 2;
    let midpoint = bestGap.left + 1;
    while (midpoint < bestGap.right && points[midpoint]!.time < midpointTime) midpoint++;
    if (midpoint >= bestGap.right) midpoint = bestGap.right - 1;
    if (midpoint < bestGap.right && Math.abs(points[midpoint - 1]!.time - midpointTime) <= Math.abs(points[midpoint]!.time - midpointTime)) midpoint--;
    selected.add(midpoint);
  }
  return { indexes: [...selected].sort((left, right) => left - right), axisExtrema, peakInterval, orientationEvidence };
}

export function summarizeStudioSpatialTrajectories(telemetry: Telemetry, requestedJoints: readonly string[], limit = 12) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw new Error('Spatial trajectory detail limit must be an integer from 1 to 24.');
  const uniqueJoints = [...new Set(requestedJoints)];
  const resolved = uniqueJoints.map(requestedJoint => ({ requestedJoint, resolution: resolveTelemetryNodeName(telemetry.nodes, requestedJoint) }));
  const available = resolved.filter(item => item.resolution.status !== 'missing' && item.resolution.status !== 'ambiguous');
  const usesJointPoints = telemetry.samples.every(sample => sample.jointPoints !== undefined);
  const usesPivotPoints = !usesJointPoints && telemetry.samples.every(sample => sample.pivotPoints !== undefined);
  const pointSource = usesJointPoints ? 'joint_pivot_or_node_pivot' as const
    : usesPivotPoints ? 'node_pivot' as const : 'ground_relative_legacy' as const;
  const coordinateFrame = pointSource === 'ground_relative_legacy' ? 'ground_relative_legacy' as const : 'rig_pivot_space' as const;
  const trajectories = available.slice(0, limit).map(({ requestedJoint, resolution }) => {
    if (resolution.status === 'missing' || resolution.status === 'ambiguous') throw new Error('Spatial trajectory resolution invariant failed.');
    const nodeIndex = resolution.index;
    const node = telemetry.nodes[nodeIndex]!;
    const parent = node.parent > 0 ? telemetry.nodes[node.parent - 1]!.name : null;
    const points = telemetry.samples.map(sample => ({ sampleId: sample.id, time: sample.time,
      position: (pointSource === 'joint_pivot_or_node_pivot' ? sample.jointPoints![nodeIndex]!
        : pointSource === 'node_pivot' ? sample.pivotPoints![nodeIndex]! : sample.points[nodeIndex]!) as [number, number, number],
      orientation: sample.orientations?.[nodeIndex] as Quaternion | undefined,
      restOrientation: telemetry.restPose?.orientations[nodeIndex] as Quaternion | undefined }));
    const start = points[0]!, end = points.at(-1)!;
    const netDisplacement = end.position.map((value, axis) => value - start.position[axis]!) as [number, number, number];
    const pathLength = points.slice(1).reduce((length, point, index) => length + distance(points[index]!.position, point.position), 0);
    const maxDistanceFromStart = Math.max(...points.map(point => distance(start.position, point.position)));
    const bounds = [0, 1, 2].map(axis => ({ min: Math.min(...points.map(point => point.position[axis]!)),
      max: Math.max(...points.map(point => point.position[axis]!)) }));
    const peakInterval = points.slice(1).reduce<{ startTime: number; endTime: number; speed: number } | null>((peak, point, index) => {
      const previous = points[index]!;
      const seconds = point.time - previous.time;
      const speed = seconds > 0 ? distance(previous.position, point.position) / seconds : 0;
      return !peak || speed > peak.speed ? { startTime: previous.time, endTime: point.time, speed } : peak;
    }, null);
    const traceSelection = selectSpatialTrace(points, 24);
    return { joint: node.name, requestedJoint, resolution: resolution.status, parent, driven: node.driven, foot: node.foot,
      ...(node.targetKind ? { targetKind: node.targetKind } : {}),
      pointSource, coordinateFrame, orientationFrame: 'rig_pivot_composed' as const, sampleCount: points.length,
      start: { sampleId: start.sampleId, time: start.time, position: start.position },
      end: { sampleId: end.sampleId, time: end.time, position: end.position },
      netDisplacement, netDistance: distance(start.position, end.position), pathLength,
      straightnessRatio: pathLength > 1e-12 ? Math.min(1, distance(start.position, end.position) / pathLength) : null,
      maxDistanceFromStart, bounds, peakInterval,
      trace: traceSelection.indexes.map(index => points[index]!).map(point => ({ sampleId: point.sampleId, time: point.time, position: point.position,
        ...(point.orientation ? { orientation: point.orientation } : {}) })),
      traceSelection: { strategy: 'endpoints_peak_speed_interval_axis_extrema_then_largest_time_gaps',
        peakSpeedIntervalSampleIds: traceSelection.peakInterval,
        positionExtremaSampleIds: traceSelection.axisExtrema, orientationEvidence: traceSelection.orientationEvidence },
      omittedTraceSampleCount: Math.max(0, points.length - traceSelection.indexes.length) };
  });
  const unavailable: Array<{ requestedJoint: string; status: 'missing' }
    | { requestedJoint: string; status: 'ambiguous'; candidates: string[] }> = [];
  for (const item of resolved) {
    if (item.resolution.status === 'missing') unavailable.push({ requestedJoint: item.requestedJoint, status: 'missing' });
    else if (item.resolution.status === 'ambiguous') unavailable.push({ requestedJoint: item.requestedJoint,
      status: 'ambiguous', candidates: item.resolution.candidates });
  }
  const omittedTrajectoryCount = Math.max(0, available.length - trajectories.length);
  const omittedJointDetails = available.slice(trajectories.length);
  const omittedJointLimit = 24;
  const omittedJoints = omittedJointDetails.slice(0, omittedJointLimit).map(({ requestedJoint, resolution }) => {
    if (resolution.status === 'missing' || resolution.status === 'ambiguous') throw new Error('Omitted spatial trajectory resolution invariant failed.');
    return { requestedJoint, joint: telemetry.nodes[resolution.index]!.name, resolution: resolution.status };
  });
  return { source: 'studio_pose_evaluator' as const, coordinateFrame,
    pointFrame: pointSource,
    trajectories, totalAvailable: available.length, omittedTrajectoryCount, omittedJoints,
    omittedJointListTruncatedCount: Math.max(0, omittedJointDetails.length - omittedJointLimit), unavailable,
    sampleTimeRange: { start: telemetry.samples[0]!.time, end: telemetry.samples.at(-1)!.time },
    maximumSampleGapSeconds: Math.max(...telemetry.samples.slice(1).map((sample, index) => sample.time - telemetry.samples[index]!.time)),
    limitation: coordinateFrame === 'rig_pivot_space'
      ? 'Hierarchy-composed sampled node positions relative to the selected rig pivot, not literal world coordinates. The `rig_pivot_composed` orientations are evaluated object orientations in the same frame and include ancestor motion; they are not the joint’s authored local Euler channel values. These are discrete pose-evaluator samples, not continuous paths, rendered/skinned geometry, gameplay displacement, collision, or proof of contact. Each trace is capped at 24 points and preserves sampled endpoints, the peak-speed interval, per-axis positional extrema, maximum orientation drift and peak angular-speed interval when orientation telemetry is complete, plus maximum sampled deviation from rig rest when a rest pose is available, before filling remaining capacity across the largest time gaps. Selected trace points include their sampled orientations; inspect traceSelection, sampleCount, omittedTraceSampleCount and maximumSampleGapSeconds before interpreting it.'
      : 'Legacy telemetry lacks rig-pivot-local or joint-pivot positions, so these node positions are ground-relative and must not be interpreted as a hierarchy-composed path. The `rig_pivot_composed` orientations are evaluated object orientations in the rig-pivot frame and include ancestor motion; they are not the joint’s authored local Euler channel values. These are discrete pose-evaluator samples, not continuous paths, rendered/skinned geometry, gameplay displacement, collision, or proof of contact. Each trace is capped at 24 points and preserves sampled endpoints, the peak-speed interval, per-axis positional extrema, maximum orientation drift and peak angular-speed interval when orientation telemetry is complete, plus maximum sampled deviation from rig rest when a rest pose is available, before filling remaining time-gap capacity. Selected trace points include their sampled orientations; inspect traceSelection, sampleCount, omittedTraceSampleCount and maximumSampleGapSeconds before interpreting it.' };
}

export function summarizeDeclaredContactTrajectories(telemetry: Telemetry, recipe: AnimationRecipe, jointMap: Record<string, string> = {}) {
  const contacts = recipe.contacts ?? [];
  const usesJointPoints = telemetry.samples.every(sample => sample.jointPoints !== undefined);
  const usesPivotPoints = !usesJointPoints && telemetry.samples.every(sample => sample.pivotPoints !== undefined);
  const pointSource = usesJointPoints ? 'joint_pivot_or_node_pivot' as const
    : usesPivotPoints ? 'node_pivot' as const : 'ground_relative_legacy' as const;
  const coordinateFrame = pointSource === 'ground_relative_legacy' ? 'ground_relative_legacy' as const : 'rig_pivot_space' as const;
  const items = contacts.map((contact, index) => {
    const requestedJoint = jointMap[contact.effector] ?? contact.effector;
    const resolution = resolveTelemetryNodeName(telemetry.nodes, requestedJoint);
    if (resolution.status === 'missing' || resolution.status === 'ambiguous') return {
      contactIndex: index, effector: contact.effector, kind: contact.kind, startTime: contact.start, endTime: contact.end,
      status: resolution.status, requestedJoint, ...(resolution.status === 'ambiguous' ? { candidates: resolution.candidates } : {}),
      pointSource, coordinateFrame,
      sampleCount: 0, startBoundary: null, midpointBoundary: null, endBoundary: null,
      maximumSampleGapSeconds: contact.end - contact.start, maxDriftFromFirstObservedStuds: null,
      cumulativePathLengthStuds: null, peakSampledSpeed: null, maxOrientationDriftDegrees: null, orientationSampleCount: 0, trace: [],
      traceSelection: null, omittedTraceSampleCount: 0,
    };
    const nodeIndex = resolution.index;
    const points = telemetry.samples.map(sample => ({ sampleId: sample.id, time: sample.time,
      position: (sample.jointPoints?.[nodeIndex] ?? sample.pivotPoints?.[nodeIndex] ?? sample.points[nodeIndex]!) as [number, number, number],
      orientation: sample.orientations?.[nodeIndex] as [number, number, number, number] | undefined }));
    const within = points.filter(point => point.time >= contact.start && point.time <= contact.end);
    const boundary = (time: number) => {
      const match = points.reduce<{ sampleId: string; time: number; error: number } | null>((best, point) => {
        const error = Math.abs(point.time - time);
        return sameAnimationTime(point.time, time) && (!best || error < best.error) ? { sampleId: point.sampleId, time: point.time, error } : best;
      }, null);
      return match ? { requestedTime: time, sampleId: match.sampleId, sampledTime: match.time } : null;
    };
    const startBoundary = boundary(contact.start);
    const midpointBoundary = boundary((contact.start + contact.end) / 2);
    const endBoundary = boundary(contact.end);
    const windowGaps = within.slice(1).map((point, gapIndex) => point.time - within[gapIndex]!.time);
    if (within.length) {
      windowGaps.unshift(Math.max(0, within[0]!.time - contact.start));
      windowGaps.push(Math.max(0, contact.end - within.at(-1)!.time));
    }
    const maximumSampleGapSeconds = windowGaps.length ? Math.max(...windowGaps) : contact.end - contact.start;
    const first = within[0];
    let cumulativePathLengthStuds = 0;
    let peakSampledSpeed: { studsPerSecond: number; startTime: number; endTime: number } | null = null;
    for (let pointIndex = 1; pointIndex < within.length; pointIndex++) {
      const previous = within[pointIndex - 1]!, point = within[pointIndex]!;
      const segmentLength = distance(previous.position, point.position);
      cumulativePathLengthStuds += segmentLength;
      const seconds = point.time - previous.time;
      const speed = seconds > 0 ? segmentLength / seconds : 0;
      if (!peakSampledSpeed || speed > peakSampledSpeed.studsPerSecond) peakSampledSpeed = {
        studsPerSecond: speed, startTime: previous.time, endTime: point.time };
    }
    const oriented = within.filter(point => point.orientation !== undefined);
    const maxOrientationDriftDegrees = oriented.length === within.length && oriented.length > 0
      ? Math.max(...oriented.map(point => angularDistanceDegrees(oriented[0]!.orientation!, point.orientation!))) : null;
    const maximumDrift = first ? Math.max(...within.map(point => distance(first.position, point.position))) : null;
    const traceSelection = selectSpatialTrace(within, 24);
    const status = within.length < 2 ? 'insufficient_samples'
      : startBoundary && endBoundary ? 'sampled_full_window' : 'sampled_partial_window';
    return { contactIndex: index, effector: contact.effector, kind: contact.kind, joint: telemetry.nodes[nodeIndex]!.name,
      parent: telemetry.nodes[nodeIndex]!.parent > 0 ? telemetry.nodes[telemetry.nodes[nodeIndex]!.parent - 1]!.name : null,
      requestedJoint, resolution: resolution.status, startTime: contact.start, endTime: contact.end, status,
      pointSource, coordinateFrame,
      sampleCount: within.length, startBoundary, midpointBoundary, endBoundary, maximumSampleGapSeconds,
      measuredWindowStartTime: first?.time ?? null, maxDriftFromFirstObservedStuds: maximumDrift,
      cumulativePathLengthStuds: within.length >= 2 ? cumulativePathLengthStuds : null, peakSampledSpeed,
      maxOrientationDriftDegrees, orientationSampleCount: oriented.length,
      trace: traceSelection.indexes.map(pointIndex => within[pointIndex]!).map(point => ({ sampleId: point.sampleId, time: point.time, position: point.position,
        ...(point.orientation ? { orientation: point.orientation } : {}) })),
      traceSelection: { strategy: 'endpoints_peak_speed_interval_axis_extrema_then_largest_time_gaps',
        peakSpeedIntervalSampleIds: traceSelection.peakInterval, positionExtremaSampleIds: traceSelection.axisExtrema,
        orientationEvidence: traceSelection.orientationEvidence },
      omittedTraceSampleCount: Math.max(0, within.length - traceSelection.indexes.length),
    };
  });
  return { source: 'studio_pose_evaluator' as const, coordinateFrame, pointSource, contacts: items,
    limitation: coordinateFrame === 'rig_pivot_space'
      ? 'These values describe sampled hierarchy-composed rig-pivot-space joint/node motion during declared contact windows, not literal world-space positions. Drift is anchored at the first observed in-window sample (reported as measuredWindowStartTime), not necessarily the exact declared start when its boundary is missing. The trace is capped at 24 points and preserves sampled endpoints, peak linear/angular intervals, positional extrema and maximum orientation drift when available before filling remaining time gaps; inspect traceSelection and omittedTraceSampleCount. Partial/insufficient coverage is not a pass; numeric stability does not prove visible or physical contact, and no allowable threshold is inferred.'
      : 'Legacy telemetry lacks rig-pivot-local or joint-pivot positions, so contact samples are ground-relative and must not be interpreted as hierarchy-composed paths. Drift is anchored at the first observed in-window sample (reported as measuredWindowStartTime), not necessarily the exact declared start when its boundary is missing. The trace is capped at 24 points and preserves sampled endpoints, peak linear/angular intervals, positional extrema and maximum orientation drift when available before filling remaining time gaps; inspect traceSelection and omittedTraceSampleCount. Partial/insufficient coverage is not a pass; numeric stability does not prove visible or physical contact, and no allowable threshold is inferred.' };
}
export const motionMode = z.enum(['unknown', 'in_place', 'root_motion', 'stationary']);
export type MotionMode = z.infer<typeof motionMode>;
export type Question = { id: string; question: string; choices?: string[] };
export type Finding = { id: string; severity: 'note' | 'possible_issue' | 'unknown'; title: string; detail: string; sampleIds: string[] };
export type ContactSamplingEvidence = { status: 'complete' | 'partial' | 'insufficient'; sampleTimes: number[];
  maximumSampleGapSeconds: number; exactStart: boolean; exactMidpoint: boolean; exactEnd: boolean };
export type Metric = { id: string; label: string; value: number; unit: string; detail: string; sampleIds: string[];
  semanticKey?: string; contactSampling?: ContactSamplingEvidence };
export type Inspection = { source: 'studio_pose_evaluator' | 'recipe_only'; metrics: Metric[]; findings: Finding[]; questions: Question[]; limitations: string[] };

export function compareContactStability(source: Inspection, candidate: Inspection) {
  const contactMetric = /^declared-contact(?:-rotation)?-\d+$/;
  const keyOf = (metric: Metric) => metric.semanticKey ?? metric.id;
  const sourceMetrics = new Map(source.metrics.filter(metric => contactMetric.test(metric.id)).map(metric => [keyOf(metric), metric]));
  const candidateMetrics = new Map(candidate.metrics.filter(metric => contactMetric.test(metric.id)).map(metric => [keyOf(metric), metric]));
  const keys = new Set([...sourceMetrics.keys(), ...candidateMetrics.keys()]);
  return [...keys].sort().map(key => {
    const before = sourceMetrics.get(key), after = candidateMetrics.get(key), id = after?.id ?? before?.id ?? key;
    if (!before || !after || before.unit !== after.unit) return {
      id, label: after?.label ?? before?.label ?? id, status: 'unknown' as const,
      reason: !before ? 'The source sample has no measurement for this declared contact.' : !after ? 'The candidate sample has no measurement for this declared contact.' : 'Source and candidate measurements use different units.',
      ...(before ? { source: { value: before.value, unit: before.unit, sampleIds: before.sampleIds } } : {}),
      ...(after ? { candidate: { value: after.value, unit: after.unit, sampleIds: after.sampleIds } } : {}),
    };
    const sourceCoverage = before.contactSampling, candidateCoverage = after.contactSampling;
    const sameTime = (left: number, right: number) => Math.abs(left - right)
      <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 4;
    if (!sourceCoverage || !candidateCoverage || sourceCoverage.status !== 'complete' || candidateCoverage.status !== 'complete') return {
      id, label: after.label, status: 'unknown' as const,
      reason: 'At least one contact measurement lacks complete declared-window sample coverage; no stability change is inferred.',
      source: { value: before.value, unit: before.unit, sampleIds: before.sampleIds, contactSampling: sourceCoverage ?? null },
      candidate: { value: after.value, unit: after.unit, sampleIds: after.sampleIds, contactSampling: candidateCoverage ?? null },
    };
    const missingSourceTimes = sourceCoverage.sampleTimes.filter(sourceTime =>
      !candidateCoverage.sampleTimes.some(candidateTime => sameTime(sourceTime, candidateTime)));
    if (missingSourceTimes.length > 0) return {
      id, label: after.label, status: 'unknown' as const,
      reason: 'The candidate contact evaluation did not retain every source sample time, so its sampled maximum could miss a source-observed excursion.',
      source: { value: before.value, unit: before.unit, sampleIds: before.sampleIds, contactSampling: sourceCoverage },
      candidate: { value: after.value, unit: after.unit, sampleIds: after.sampleIds, contactSampling: candidateCoverage },
      missingSourceSampleTimes: missingSourceTimes,
    };
    const delta = after.value - before.value;
    const status = delta < -1e-6 ? 'improved' as const : delta > 1e-6 ? 'worsened' as const : 'unchanged' as const;
    return { id, label: after.label, status, unit: after.unit, source: { value: before.value, sampleIds: before.sampleIds },
      candidate: { value: after.value, sampleIds: after.sampleIds }, delta,
      samplingComparison: { sourceSampleCount: sourceCoverage.sampleTimes.length, candidateSampleCount: candidateCoverage.sampleTimes.length,
        sourceMaximumGapSeconds: sourceCoverage.maximumSampleGapSeconds, candidateMaximumGapSeconds: candidateCoverage.maximumSampleGapSeconds,
        candidateRetainsAllSourceSampleTimes: true,
        limitation: 'This compares sampled contact measurements only; retaining source times avoids a sparser candidate hiding a sampled excursion but does not prove continuous or physical contact.' } };
  });
}
export function fingerprint(recipe: Recipe) { return createHash('sha256').update(JSON.stringify(recipe)).digest('hex'); }
export function fingerprintUuid(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Candidate identity requires a lowercase SHA-256 fingerprint.');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
function keyMotionSalience(track: AnimationRecipe['tracks'][number], channelWeight: number) {
  const segments = track.keys.slice(1).map((right, index) => {
    const left = track.keys[index]!;
    const seconds = right.time - left.time;
    const positionSpeed = Math.hypot(...left.position.map((value, axis) => right.position[axis]! - value)) / seconds;
    const angularSpeed = Math.hypot(...left.rotation.map((value, axis) => {
      const difference = right.rotation[axis]! - value;
      return ((difference + 180) % 360 + 360) % 360 - 180;
    })) / seconds;
    return { left: left.time, right: right.time, positionSpeed, angularSpeed };
  });
  const median = (values: number[]) => {
    const positive = values.filter(value => value > 1e-8).sort((a, b) => a - b);
    if (!positive.length) return 0;
    const middle = Math.floor(positive.length / 2);
    return positive.length % 2 ? positive[middle]! : (positive[middle - 1]! + positive[middle]!) / 2;
  };
  const positionBaseline = median(segments.map(segment => segment.positionSpeed));
  const angularBaseline = median(segments.map(segment => segment.angularSpeed));
  const salience = new Map<number, number>();
  for (const segment of segments) {
    const positionRatio = positionBaseline ? Math.min(10, segment.positionSpeed / positionBaseline) : 0;
    const angularRatio = angularBaseline ? Math.min(10, segment.angularSpeed / angularBaseline) : 0;
    const score = Math.max(positionRatio, angularRatio) * channelWeight;
    salience.set(segment.left, (salience.get(segment.left) ?? 0) + score);
    salience.set(segment.right, (salience.get(segment.right) ?? 0) + score);
  }
  return salience;
}
export type RequiredInspectionWindow = { start: number; end: number; maxSampleGapSeconds: number };
export function sampleTimes(recipe: AnimationRecipe, requiredWindows: RequiredInspectionWindow[] = [], requiredTimes: number[] = []) {
  const times = [0, recipe.duration];
  const addDistinct = (time: number) => {
    if (times.length < maxInspectionSamples && times.every(sample => !sameAnimationTime(sample, time))) times.push(time);
  };
  const addMandatory = (time: number, reason: string) => {
    if (times.some(sample => sameAnimationTime(sample, time))) return;
    if (times.length >= maxInspectionSamples) throw new Error(`${reason} exceed the ${maxInspectionSamples}-sample Studio inspection limit.`);
    times.push(time);
  };
  for (const [index, time] of requiredTimes.entries()) {
    if (!Number.isFinite(time) || time < 0 || time > recipe.duration) {
      throw new Error(`Requested sample time ${index + 1} must be finite and inside the animation duration.`);
    }
    addMandatory(time, 'Explicit requested sample times');
  }
  for (const [index, window] of requiredWindows.entries()) {
    if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || !Number.isFinite(window.maxSampleGapSeconds)
      || window.start < 0 || window.end > recipe.duration || window.start >= window.end || window.maxSampleGapSeconds <= 0) {
      throw new Error(`Required inspection window ${index + 1} must be ordered inside the animation duration and have a positive maximum sample gap.`);
    }
    const intervals = Math.ceil((window.end - window.start) / window.maxSampleGapSeconds);
    if (!Number.isFinite(intervals) || intervals > maxInspectionSamples) {
      throw new Error(`Required acceptance window ${index + 1} subdivisions exceed the ${maxInspectionSamples}-sample Studio inspection limit.`);
    }
    for (let step = 0; step <= intervals; step++) addMandatory(step === intervals ? window.end : window.start + (window.end - window.start) * step / intervals, 'Required acceptance windows');
  }
  // Declared support/grip boundaries and midpoint are mandatory inspection beats.
  // Silently omitting them would make the resulting contact analysis incomplete.
  for (const contact of recipe.contacts ?? []) {
    addMandatory(contact.start, 'Declared contact boundaries and midpoints');
    addMandatory((contact.start + contact.end) / 2, 'Declared contact boundaries and midpoints');
    addMandatory(contact.end, 'Declared contact boundaries and midpoints');
  }

  // Prefer authored poses over an arbitrary grid. Under the 128-sample cap, retain
  // every distinct key time; for denser clips, select a deterministic temporal spread.
  const authoredTracks = [
    ...recipe.tracks.map(track => ({ track, weight: 1 })),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => ({ track, weight: layer.enabled ? Math.max(layer.weight, 0.1) : 0.1 }))),
    ...(recipe.rootMotion ? [{ track: recipe.rootMotion, weight: 1 }] : []),
  ];
  const keyTimes = [...new Set(authoredTracks.flatMap(item => item.track.keys.map(key => key.time)))].sort((a, b) => a - b)
    .filter(time => times.every(sample => !sameAnimationTime(sample, time)));
  const slots = maxInspectionSamples - times.length;
  if (keyTimes.length <= slots) keyTimes.forEach(addDistinct);
  else if (slots > 0) {
    const salience = new Map<number, number>();
    for (const item of authoredTracks) for (const [time, score] of keyMotionSalience(item.track, item.weight)) {
      salience.set(time, (salience.get(time) ?? 0) + score);
    }
    const priorityCount = Math.min(Math.ceil(slots / 2), keyTimes.filter(time => (salience.get(time) ?? 0) > 0).length);
    const priorityTimes = [...keyTimes].sort((left, right) => (salience.get(right) ?? 0) - (salience.get(left) ?? 0) || left - right)
      .filter(time => (salience.get(time) ?? 0) > 0).slice(0, priorityCount);
    const selected = new Set(priorityTimes);
    const temporalCount = slots - selected.size;
    if (temporalCount > 0) {
      const spread = temporalCount === 1 ? [keyTimes[Math.floor((keyTimes.length - 1) / 2)]!] : Array.from({ length: temporalCount }, (_, index) => keyTimes[Math.round(index * (keyTimes.length - 1) / (temporalCount - 1))]!);
      spread.forEach(time => selected.add(time));
    }
    for (const time of keyTimes) if (selected.size < slots) selected.add(time);
    [...selected].slice(0, slots).sort((a, b) => a - b).forEach(addDistinct);
  }

  // Marker times are useful context but do not displace contact or authored-pose samples.
  for (const marker of recipe.markers) addDistinct(marker.time);
  for (let index = 1; index < 48 && times.length < maxInspectionSamples; index++) addDistinct(Number((recipe.duration * index / 48).toFixed(6)));
  return times.sort((a, b) => a - b);
}
const round = (n: number) => Math.round(n * 10000) / 10000;
const distance = (a: number[], b: number[], horizontal = false) => Math.hypot(a[0]! - b[0]!, horizontal ? 0 : a[1]! - b[1]!, a[2]! - b[2]!);
export type MotionComparison =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'available'; normalizedSamples: number; changedJointCount: number; largestDisplacement: number;
      positionFrame: 'pivot_local' | 'ground_relative_legacy';
      positionChangeIntervals: { startProgress: number; endProgress: number; peakProgress: number; rmsDisplacement: number; peakDisplacement: number; parentStartTime: number; parentEndTime: number; childStartTime: number; childEndTime: number; joints: string[]; omittedJointCount: number; parentSampleIds: string[]; childSampleIds: string[] }[];
      rotationChangeIntervals: { startProgress: number; endProgress: number; peakProgress: number; rmsAngularDisplacement: number; peakAngularDisplacement: number; parentStartTime: number; parentEndTime: number; childStartTime: number; childEndTime: number; joints: string[]; omittedJointCount: number; parentSampleIds: string[]; childSampleIds: string[] }[];
      baselineStatus: 'verified' | 'not_recorded';
      omittedPositionChangeCount: number;
      largestChanges: { joint: string; maxDisplacement: number; rmsDisplacement: number; candidateMinusSourceAtPeak?: [number, number, number]; atProgress: number; parentTime: number; childTime: number; parentSampleIds: string[]; childSampleIds: string[] }[];
      rotationStatus: 'available' | 'unavailable'; rotationUnavailableReason?: string; changedRotationJointCount: number; largestAngularDisplacement: number;
      omittedRotationChangeCount: number; angularEvaluationSamples: number;
      largestRotationChanges: { joint: string; maxAngularDisplacement: number; rmsAngularDisplacement: number; atProgress: number; parentTime: number; childTime: number; parentSampleIds: string[]; childSampleIds: string[] }[];
      actionPhaseComparison: ActionPhaseComparison;
      limitation: string;
    };

export type ActionPhaseWindow = { label: string; occurrence: number; startTime: number; endTime: number };
export type ActionPhaseComparison =
  | { status: 'unavailable'; reason: string; matchedPhaseCount: 0; unmatchedParentPhaseCount: number; unmatchedChildPhaseCount: number; phases: [] }
  | { status: 'available'; matchedPhaseCount: number; unmatchedParentPhaseCount: number; unmatchedChildPhaseCount: number; phases: {
      label: string; occurrence: number; parentStartTime: number; parentEndTime: number; childStartTime: number; childEndTime: number;
      normalizedSamples: number;
      position: { rmsDisplacement: number; peakDisplacement: number; changedJointCount: number; largestChanges: { joint: string; maxDisplacement: number; rmsDisplacement: number; atPhaseProgress: number; parentTime: number; childTime: number; parentSampleIds: string[]; childSampleIds: string[] }[] };
      rotation: { status: 'available' | 'unavailable'; reason?: string; rmsAngularDisplacement: number; peakAngularDisplacement: number; changedJointCount: number; largestChanges: { joint: string; maxAngularDisplacement: number; rmsAngularDisplacement: number; atPhaseProgress: number; parentTime: number; childTime: number; parentSampleIds: string[]; childSampleIds: string[] }[] };
    }[] };

function samplePointAtProgress(telemetry: Telemetry, nodeIndex: number, progress: number, positionFrame: 'pivot_local' | 'ground_relative_legacy') {
  const time = progress * telemetry.duration;
  const samples = telemetry.samples;
  const points = (sample: Telemetry['samples'][number]) => positionFrame === 'pivot_local' ? sample.pivotPoints! : sample.points;
  let upperIndex = samples.findIndex(sample => sample.time >= time);
  if (upperIndex < 0) {
    upperIndex = samples.length - 1;
    return { point: points(samples[upperIndex]!)[nodeIndex]!, evidenceIds: [samples[upperIndex]!.id] };
  }
  if (upperIndex === 0) return { point: points(samples[0]!)[nodeIndex]!, evidenceIds: [samples[0]!.id] };
  const left = samples[upperIndex - 1]!;
  const right = samples[upperIndex]!;
  const alpha = (time - left.time) / (right.time - left.time);
  return {
    point: points(left)[nodeIndex]!.map((value, axis) => value + (points(right)[nodeIndex]![axis]! - value) * alpha),
    evidenceIds: [left.id, right.id],
  };
}

type Quaternion = [number, number, number, number];
function normalizeQuaternion(value: Quaternion): Quaternion {
  const magnitude = Math.hypot(...value);
  return magnitude < 1e-12 ? [0, 0, 0, 1] : value.map(component => component / magnitude) as Quaternion;
}
function interpolateQuaternion(from: Quaternion, to: Quaternion, alpha: number): Quaternion {
  let target = to;
  let dot = from.reduce((sum, value, index) => sum + value * to[index]!, 0);
  if (dot < 0) { target = to.map(value => -value) as Quaternion; dot = -dot; }
  if (dot > 0.9995) return normalizeQuaternion(from.map((value, index) => value + (target[index]! - value) * alpha) as Quaternion);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))), sine = Math.sin(angle);
  return normalizeQuaternion(from.map((value, index) => value * Math.sin((1 - alpha) * angle) / sine + target[index]! * Math.sin(alpha * angle) / sine) as Quaternion);
}
function sampleOrientationAtProgress(telemetry: Telemetry, nodeIndex: number, progress: number) {
  const time = progress * telemetry.duration;
  const samples = telemetry.samples;
  let upperIndex = samples.findIndex(sample => sample.time >= time);
  if (upperIndex < 0) upperIndex = samples.length - 1;
  const exact = samples[upperIndex]!;
  if (!exact.orientations) return undefined;
  if (upperIndex === 0 || exact.time === time) return { orientation: exact.orientations[nodeIndex]!, evidenceIds: [exact.id] };
  const left = samples[upperIndex - 1]!;
  if (!left.orientations) return undefined;
  const alpha = (time - left.time) / (exact.time - left.time);
  return { orientation: interpolateQuaternion(left.orientations[nodeIndex]!, exact.orientations[nodeIndex]!, alpha), evidenceIds: [left.id, exact.id] };
}
function angularDistanceDegrees(a: Quaternion, b: Quaternion) {
  const dot = Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

const comparablePhaseLabels = new Set(['anticipation', 'main_action', 'follow_through', 'recovery']);

function compareActionPhases(
  parent: Telemetry,
  child: Telemetry,
  pairs: { name: string; parentIndex: number; childIndex: number }[],
  positionFrame: 'pivot_local' | 'ground_relative_legacy',
  windows?: { parent: ActionPhaseWindow[]; child: ActionPhaseWindow[] },
): ActionPhaseComparison {
  const unavailable = (reason: string, unmatchedParentPhaseCount = 0, unmatchedChildPhaseCount = 0): ActionPhaseComparison => ({
    status: 'unavailable', reason, matchedPhaseCount: 0,
    unmatchedParentPhaseCount, unmatchedChildPhaseCount, phases: [],
  });
  if (!windows) return unavailable('No marker-defined action phases were supplied; only whole-clip comparison is available.');
  const usable = (entries: ActionPhaseWindow[], duration: number) => entries.filter(entry =>
    comparablePhaseLabels.has(entry.label) && Number.isInteger(entry.occurrence) && entry.occurrence > 0 &&
    Number.isFinite(entry.startTime) && Number.isFinite(entry.endTime) && entry.startTime >= 0 &&
    entry.endTime <= duration && entry.endTime > entry.startTime);
  const parentWindows = usable(windows.parent, parent.duration);
  const childWindows = usable(windows.child, child.duration);
  const childByKey = new Map(childWindows.map(entry => [`${entry.label}:${entry.occurrence}`, entry]));
  const matched = parentWindows.flatMap(parentWindow => {
    const childWindow = childByKey.get(`${parentWindow.label}:${parentWindow.occurrence}`);
    return childWindow ? [{ parentWindow, childWindow }] : [];
  });
  const unmatchedParentPhaseCount = parentWindows.length - matched.length;
  const unmatchedChildPhaseCount = childWindows.length - matched.length;
  if (!matched.length) return unavailable(
    'No matching recognized phase labels and occurrence numbers were found in both revisions.',
    unmatchedParentPhaseCount, unmatchedChildPhaseCount,
  );

  const phases = matched.map(({ parentWindow, childWindow }) => {
    const parentLength = parentWindow.endTime - parentWindow.startTime;
    const childLength = childWindow.endTime - childWindow.startTime;
    const progressValues = new Set<number>(Array.from({ length: 17 }, (_, index) => index / 16));
    for (const sample of parent.samples) {
      if (sample.time > parentWindow.startTime && sample.time < parentWindow.endTime) {
        progressValues.add((sample.time - parentWindow.startTime) / parentLength);
      }
    }
    for (const sample of child.samples) {
      if (sample.time > childWindow.startTime && sample.time < childWindow.endTime) {
        progressValues.add((sample.time - childWindow.startTime) / childLength);
      }
    }
    const progressGrid = [...progressValues].filter(value => value >= 0 && value <= 1).sort((a, b) => a - b);
    const absoluteProgress = (window: ActionPhaseWindow, duration: number, phaseProgress: number) =>
      (window.startTime + (window.endTime - window.startTime) * phaseProgress) / duration;
    const positionChanges = pairs.map(({ name, parentIndex, childIndex }) => {
      const deltas = progressGrid.map(phaseProgress => {
        const parentPose = samplePointAtProgress(parent, parentIndex, absoluteProgress(parentWindow, parent.duration, phaseProgress), positionFrame);
        const childPose = samplePointAtProgress(child, childIndex, absoluteProgress(childWindow, child.duration, phaseProgress), positionFrame);
        const delta = parentPose.point.map((value, axis) => value - childPose.point[axis]!);
        return { phaseProgress, delta, displacement: Math.hypot(...delta), parentSampleIds: parentPose.evidenceIds, childSampleIds: childPose.evidenceIds };
      });
      let squaredIntegral = 0;
      for (let index = 1; index < deltas.length; index++) {
        const before = deltas[index - 1]!.delta;
        const after = deltas[index]!.delta;
        const interval = progressGrid[index]! - progressGrid[index - 1]!;
        const beforeSquared = before.reduce((sum, value) => sum + value * value, 0);
        const afterSquared = after.reduce((sum, value) => sum + value * value, 0);
        const cross = before.reduce((sum, value, axis) => sum + value * after[axis]!, 0);
        squaredIntegral += interval * (beforeSquared + cross + afterSquared) / 3;
      }
      const peak = deltas.reduce((best, current) => current.displacement > best.displacement ? current : best, deltas[0]!);
      return {
        joint: name, maxDisplacement: peak.displacement, rmsDisplacement: Math.sqrt(squaredIntegral),
        atPhaseProgress: peak.phaseProgress,
        parentTime: parentWindow.startTime + parentLength * peak.phaseProgress,
        childTime: childWindow.startTime + childLength * peak.phaseProgress,
        parentSampleIds: peak.parentSampleIds, childSampleIds: peak.childSampleIds,
      };
    });
    const rankedPosition = [...positionChanges].sort((a, b) => b.maxDisplacement - a.maxDisplacement || b.rmsDisplacement - a.rmsDisplacement || a.joint.localeCompare(b.joint));
    const changedPosition = rankedPosition.filter(change => change.maxDisplacement > 0.01);
    const positionIntegral = positionChanges.reduce((sum, change) => sum + change.rmsDisplacement ** 2, 0);

    const rotationChanges = pairs.map(({ name, parentIndex, childIndex }) => {
      let integral = 0;
      let peakDisplacement = -1;
      let peakProgress = 0;
      let peakParentIds: string[] = [];
      let peakChildIds: string[] = [];
      let available = true;
      const evaluate = (phaseProgress: number) => {
        const parentPose = sampleOrientationAtProgress(parent, parentIndex, absoluteProgress(parentWindow, parent.duration, phaseProgress));
        const childPose = sampleOrientationAtProgress(child, childIndex, absoluteProgress(childWindow, child.duration, phaseProgress));
        if (!parentPose || !childPose) { available = false; return 0; }
        const displacement = angularDistanceDegrees(parentPose.orientation, childPose.orientation);
        if (displacement > peakDisplacement) {
          peakDisplacement = displacement;
          peakProgress = phaseProgress;
          peakParentIds = parentPose.evidenceIds;
          peakChildIds = childPose.evidenceIds;
        }
        return displacement * displacement;
      };
      const coarse = progressGrid.map(evaluate);
      for (let index = 1; index < progressGrid.length; index++) {
        const start = progressGrid[index - 1]!;
        const step = (progressGrid[index]! - start) / 8;
        let weightedInterior = 0;
        for (let substep = 1; substep < 8; substep++) {
          const value = evaluate(start + step * substep);
          weightedInterior += (substep % 2 === 0 ? 2 : 4) * value;
        }
        integral += step / 3 * (coarse[index - 1]! + coarse[index]! + weightedInterior);
      }
      return {
        joint: name, available, maxAngularDisplacement: Math.max(0, peakDisplacement),
        rmsAngularDisplacement: Math.sqrt(Math.max(0, integral)), atPhaseProgress: peakProgress,
        parentTime: parentWindow.startTime + parentLength * peakProgress,
        childTime: childWindow.startTime + childLength * peakProgress,
        parentSampleIds: peakParentIds, childSampleIds: peakChildIds,
      };
    });
    const allRotationsAvailable = rotationChanges.every(change => change.available);
    const rankedRotation = [...rotationChanges].sort((a, b) => b.maxAngularDisplacement - a.maxAngularDisplacement || b.rmsAngularDisplacement - a.rmsAngularDisplacement || a.joint.localeCompare(b.joint));
    const changedRotation = rankedRotation.filter(change => change.maxAngularDisplacement > 0.1);
    const rotationIntegral = rotationChanges.reduce((sum, change) => sum + change.rmsAngularDisplacement ** 2, 0);
    return {
      label: parentWindow.label, occurrence: parentWindow.occurrence,
      parentStartTime: round(parentWindow.startTime), parentEndTime: round(parentWindow.endTime),
      childStartTime: round(childWindow.startTime), childEndTime: round(childWindow.endTime),
      normalizedSamples: progressGrid.length,
      position: {
        rmsDisplacement: round(Math.sqrt(positionIntegral / Math.max(1, pairs.length))),
        peakDisplacement: round(rankedPosition[0]?.maxDisplacement ?? 0),
        changedJointCount: changedPosition.length,
        largestChanges: changedPosition.slice(0, 8).map(change => ({
          joint: change.joint, maxDisplacement: round(change.maxDisplacement), rmsDisplacement: round(change.rmsDisplacement),
          atPhaseProgress: round(change.atPhaseProgress), parentTime: round(change.parentTime), childTime: round(change.childTime),
          parentSampleIds: change.parentSampleIds, childSampleIds: change.childSampleIds,
        })),
      },
      rotation: {
        status: allRotationsAvailable ? 'available' as const : 'unavailable' as const,
        ...(!allRotationsAvailable ? { reason: 'One or both samples lack orientation telemetry for at least one rig joint.' } : {}),
        rmsAngularDisplacement: allRotationsAvailable ? round(Math.sqrt(rotationIntegral / Math.max(1, pairs.length))) : 0,
        peakAngularDisplacement: allRotationsAvailable ? round(Math.max(0, rankedRotation[0]?.maxAngularDisplacement ?? 0)) : 0,
        changedJointCount: allRotationsAvailable ? changedRotation.length : 0,
        largestChanges: allRotationsAvailable ? changedRotation.slice(0, 8).map(change => ({
          joint: change.joint, maxAngularDisplacement: round(change.maxAngularDisplacement), rmsAngularDisplacement: round(change.rmsAngularDisplacement),
          atPhaseProgress: round(change.atPhaseProgress), parentTime: round(change.parentTime), childTime: round(change.childTime),
          parentSampleIds: change.parentSampleIds, childSampleIds: change.childSampleIds,
        })) : [],
      },
    };
  });
  return { status: 'available', matchedPhaseCount: phases.length, unmatchedParentPhaseCount, unmatchedChildPhaseCount, phases };
}

/** Quantify trajectory changes for revisions on the same rig; this is not an artistic score. */
export function compareMotion(parent: Telemetry, child: Telemetry, detailLimit = 12, phaseWindows?: { parent: ActionPhaseWindow[]; child: ActionPhaseWindow[] }): MotionComparison {
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 96) return { status: 'unavailable', reason: 'Comparison detailLimit must be an integer from 1 to 96.' };
  if (parent.rigId !== child.rigId) return { status: 'unavailable', reason: 'Parent and child were sampled on different rigs.' };
  if (parent.nodes.length !== child.nodes.length) return { status: 'unavailable', reason: 'Parent and child rig topologies have different node counts.' };
  const parentHasPivotPoints = parent.samples.every(sample => sample.pivotPoints !== undefined);
  const childHasPivotPoints = child.samples.every(sample => sample.pivotPoints !== undefined);
  if (parentHasPivotPoints !== childHasPivotPoints) return { status: 'unavailable', reason: 'Samples use different position reference frames; resample both animations with the same Studio plugin version.' };
  const positionFrame = parentHasPivotPoints ? 'pivot_local' : 'ground_relative_legacy';
  const childIndices = new Map(child.nodes.map((node, index) => [node.name, index]));
  const pairs: { name: string; parentIndex: number; childIndex: number }[] = [];
  for (const [parentIndex, node] of parent.nodes.entries()) {
    const childIndex = childIndices.get(node.name);
    if (childIndex === undefined) return { status: 'unavailable', reason: `Child rig is missing node ${node.name}.` };
    const parentParent = node.parent === 0 ? '' : parent.nodes[node.parent - 1]!.name;
    const childNode = child.nodes[childIndex]!;
    const childParent = childNode.parent === 0 ? '' : child.nodes[childNode.parent - 1]!.name;
    if (parentParent !== childParent) return { status: 'unavailable', reason: `Parent relationship changed at node ${node.name}.` };
    pairs.push({ name: node.name, parentIndex, childIndex });
  }
  const baselineStatus = parent.restPose && child.restPose ? 'verified' : 'not_recorded';
  if (baselineStatus === 'verified') {
    for (const { name, parentIndex, childIndex } of pairs) {
      const restDisplacement = distance(parent.restPose!.points[parentIndex]!, child.restPose!.points[childIndex]!);
      const restAngularDisplacement = angularDistanceDegrees(parent.restPose!.orientations[parentIndex]! as Quaternion, child.restPose!.orientations[childIndex]! as Quaternion);
      if (restDisplacement > 0.01 || restAngularDisplacement > 0.5) {
        return { status: 'unavailable', reason: `Rig rest pose differs at ${name} (${round(restDisplacement)} studs, ${round(restAngularDisplacement)}°). Reinspect/restore the same rig before comparing animation revisions.` };
      }
    }
  }
  const phases = new Set<number>([0, 1]);
  for (const telemetry of [parent, child]) {
    for (const sample of telemetry.samples) phases.add(sample.time / telemetry.duration);
  }
  for (let index = 1; index < 32; index++) phases.add(index / 32);
  const orderedPhases = [...phases].sort((a, b) => a - b);
  const intervalStats = orderedPhases.slice(1).map((endProgress, index) => ({
    startProgress: orderedPhases[index]!, endProgress, integral: 0, duration: endProgress - orderedPhases[index]!, peakDisplacement: 0,
    peakProgress: orderedPhases[index]!, jointContribution: new Map<string, number>(), parentSampleIds: new Set<string>(), childSampleIds: new Set<string>(),
  }));
  const changes = pairs.map(({ name, parentIndex, childIndex }) => {
    let maxDisplacement = 0, atProgress = 0, candidateMinusSourceAtPeak: [number, number, number] = [0, 0, 0], parentSampleIds: string[] = [], childSampleIds: string[] = [];
    const displacementVectors: number[][] = [];
    for (const progress of orderedPhases) {
      const parentPose = samplePointAtProgress(parent, parentIndex, progress, positionFrame);
      const childPose = samplePointAtProgress(child, childIndex, progress, positionFrame);
      const delta = parentPose.point.map((value, axis) => value - childPose.point[axis]!);
      const displacement = Math.hypot(...delta);
      displacementVectors.push(delta);
      if (displacement > maxDisplacement) {
        maxDisplacement = displacement;
        atProgress = progress;
        candidateMinusSourceAtPeak = delta.map(value => {
          const component = round(-value);
          return component === 0 ? 0 : component;
        }) as [number, number, number];
        parentSampleIds = parentPose.evidenceIds;
        childSampleIds = childPose.evidenceIds;
      }
    }
    // The difference between two linearly interpolated positions is linear per
    // phase interval; integrate its squared norm analytically, independent of
    // how densely that interval happened to be sampled.
    let squaredIntegral = 0;
    for (let index = 1; index < orderedPhases.length; index++) {
      const before = displacementVectors[index - 1]!;
      const after = displacementVectors[index]!;
      const interval = orderedPhases[index]! - orderedPhases[index - 1]!;
      const beforeSquared = before.reduce((sum, value) => sum + value * value, 0);
      const afterSquared = after.reduce((sum, value) => sum + value * value, 0);
      const cross = before.reduce((sum, value, axis) => sum + value * after[axis]!, 0);
      const contribution = interval * (beforeSquared + cross + afterSquared) / 3;
      squaredIntegral += contribution;
      const stats = intervalStats[index - 1]!;
      stats.integral += contribution;
      stats.jointContribution.set(name, (stats.jointContribution.get(name) ?? 0) + contribution);
      const beforeDistance = Math.hypot(...before), afterDistance = Math.hypot(...after);
      const intervalPeak = Math.max(beforeDistance, afterDistance);
      if (intervalPeak > stats.peakDisplacement) {
        stats.peakDisplacement = intervalPeak;
        stats.peakProgress = beforeDistance >= afterDistance ? orderedPhases[index - 1]! : orderedPhases[index]!;
      }
      for (const progress of [orderedPhases[index - 1]!, orderedPhases[index]!]) {
        const parentPose = samplePointAtProgress(parent, parentIndex, progress, positionFrame);
        const childPose = samplePointAtProgress(child, childIndex, progress, positionFrame);
        parentPose.evidenceIds.forEach(id => stats.parentSampleIds.add(id));
        childPose.evidenceIds.forEach(id => stats.childSampleIds.add(id));
      }
    }
    return {
      joint: name,
      maxDisplacement: round(maxDisplacement),
      rmsDisplacement: round(Math.sqrt(squaredIntegral)),
      candidateMinusSourceAtPeak,
      atProgress, parentTime: atProgress * parent.duration, childTime: atProgress * child.duration, parentSampleIds, childSampleIds,
    };
  });
  const ranked = [...changes].sort((a, b) => b.maxDisplacement - a.maxDisplacement || b.rmsDisplacement - a.rmsDisplacement || a.joint.localeCompare(b.joint));
  const changed = ranked.filter(change => change.maxDisplacement > 0.01);
  const intervals: { startProgress: number; endProgress: number; peakProgress: number; integral: number; duration: number; peakDisplacement: number; jointContribution: Map<string, number>; parentSampleIds: Set<string>; childSampleIds: Set<string> }[] = [];
  for (const stats of intervalStats) {
    if (stats.peakDisplacement <= 0.01) continue;
    const previous = intervals.at(-1);
    if (previous && previous.endProgress === stats.startProgress) {
      previous.endProgress = stats.endProgress;
      previous.integral += stats.integral;
      previous.duration += stats.duration;
      for (const [joint, contribution] of stats.jointContribution) previous.jointContribution.set(joint, (previous.jointContribution.get(joint) ?? 0) + contribution);
      stats.parentSampleIds.forEach(id => previous.parentSampleIds.add(id));
      stats.childSampleIds.forEach(id => previous.childSampleIds.add(id));
      if (stats.peakDisplacement > previous.peakDisplacement) {
        previous.peakDisplacement = stats.peakDisplacement;
        previous.peakProgress = stats.peakProgress;
      }
    } else intervals.push({ ...stats, jointContribution: new Map(stats.jointContribution), parentSampleIds: new Set(stats.parentSampleIds), childSampleIds: new Set(stats.childSampleIds) });
  }
  const positionChangeIntervals = intervals.map(interval => {
    const rankedJoints = [...interval.jointContribution].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      startProgress: interval.startProgress, endProgress: interval.endProgress, peakProgress: interval.peakProgress,
      rmsDisplacement: round(Math.sqrt(interval.integral / interval.duration / pairs.length)), peakDisplacement: round(interval.peakDisplacement),
      parentStartTime: interval.startProgress * parent.duration, parentEndTime: interval.endProgress * parent.duration,
      childStartTime: interval.startProgress * child.duration, childEndTime: interval.endProgress * child.duration,
      joints: rankedJoints.slice(0, 8).map(([joint]) => joint), omittedJointCount: Math.max(0, rankedJoints.length - 8),
      parentSampleIds: [...interval.parentSampleIds].slice(0, 16), childSampleIds: [...interval.childSampleIds].slice(0, 16),
    };
  }).sort((a, b) => b.peakDisplacement - a.peakDisplacement || b.rmsDisplacement - a.rmsDisplacement || a.startProgress - b.startProgress).slice(0, 8);
  const rotationPairs = pairs.flatMap(pair => orderedPhases.every(progress => sampleOrientationAtProgress(parent, pair.parentIndex, progress) && sampleOrientationAtProgress(child, pair.childIndex, progress)) ? [pair] : []);
  const angularIntervalStats = orderedPhases.slice(1).map((endProgress, index) => ({
    startProgress: orderedPhases[index]!, endProgress, integral: 0, duration: endProgress - orderedPhases[index]!, peakAngularDisplacement: 0,
    peakProgress: orderedPhases[index]!, jointContribution: new Map<string, number>(), parentSampleIds: new Set<string>(), childSampleIds: new Set<string>(),
  }));
  const rotations = rotationPairs.map(({ name, parentIndex, childIndex }) => {
    let maxAngularDisplacement = 0, atProgress = 0, parentSampleIds: string[] = [], childSampleIds: string[] = [];
    let squaredIntegral = 0;
    const evaluate = (progress: number) => {
      const parentPose = sampleOrientationAtProgress(parent, parentIndex, progress)!;
      const childPose = sampleOrientationAtProgress(child, childIndex, progress)!;
      const displacement = angularDistanceDegrees(parentPose.orientation, childPose.orientation);
      if (displacement > maxAngularDisplacement) {
        maxAngularDisplacement = displacement;
        atProgress = progress;
        parentSampleIds = parentPose.evidenceIds;
        childSampleIds = childPose.evidenceIds;
      }
      return { displacement, squared: displacement * displacement, parentSampleIds: parentPose.evidenceIds, childSampleIds: childPose.evidenceIds };
    };
    const phaseValues = orderedPhases.map(evaluate);
    // Relative orientation under two SLERP paths is nonlinear. Composite
    // Simpson integration (8 bounded substeps per phase interval) gives a
    // time-weighted estimate and also checks interior angular maxima.
    for (let index = 1; index < orderedPhases.length; index++) {
      const start = orderedPhases[index - 1]!;
      const end = orderedPhases[index]!;
      const step = (end - start) / 8;
      let weightedInterior = 0;
      const stats = angularIntervalStats[index - 1]!;
      const startValue = phaseValues[index - 1]!;
      const endValue = phaseValues[index]!;
      const intervalValues = [startValue];
      for (let substep = 1; substep < 8; substep++) {
        const value = evaluate(start + step * substep);
        intervalValues.push(value);
        weightedInterior += (substep % 2 === 0 ? 2 : 4) * value.squared;
      }
      intervalValues.push(endValue);
      const contribution = step / 3 * (startValue.squared + endValue.squared + weightedInterior);
      squaredIntegral += contribution;
      stats.integral += contribution;
      stats.jointContribution.set(name, (stats.jointContribution.get(name) ?? 0) + contribution);
      for (let substep = 0; substep < intervalValues.length; substep++) {
        const value = intervalValues[substep]!;
        if (value.displacement > stats.peakAngularDisplacement) {
          stats.peakAngularDisplacement = value.displacement;
          stats.peakProgress = start + step * substep;
        }
        value.parentSampleIds.forEach(id => stats.parentSampleIds.add(id));
        value.childSampleIds.forEach(id => stats.childSampleIds.add(id));
      }
    }
    return { joint: name, maxAngularDisplacement: round(maxAngularDisplacement), rmsAngularDisplacement: round(Math.sqrt(squaredIntegral)), atProgress, parentTime: atProgress * parent.duration, childTime: atProgress * child.duration, parentSampleIds, childSampleIds };
  });
  const rankedRotations = rotations.sort((a, b) => b.maxAngularDisplacement - a.maxAngularDisplacement || b.rmsAngularDisplacement - a.rmsAngularDisplacement || a.joint.localeCompare(b.joint));
  const changedRotations = rankedRotations.filter(change => change.maxAngularDisplacement > 0.1);
  const angularIntervals: { startProgress: number; endProgress: number; peakProgress: number; integral: number; duration: number; peakAngularDisplacement: number; jointContribution: Map<string, number>; parentSampleIds: Set<string>; childSampleIds: Set<string> }[] = [];
  for (const stats of angularIntervalStats) {
    if (stats.peakAngularDisplacement <= 0.1) continue;
    const previous = angularIntervals.at(-1);
    if (previous && previous.endProgress === stats.startProgress) {
      previous.endProgress = stats.endProgress;
      previous.integral += stats.integral;
      previous.duration += stats.duration;
      for (const [joint, contribution] of stats.jointContribution) previous.jointContribution.set(joint, (previous.jointContribution.get(joint) ?? 0) + contribution);
      stats.parentSampleIds.forEach(id => previous.parentSampleIds.add(id));
      stats.childSampleIds.forEach(id => previous.childSampleIds.add(id));
      if (stats.peakAngularDisplacement > previous.peakAngularDisplacement) {
        previous.peakAngularDisplacement = stats.peakAngularDisplacement;
        previous.peakProgress = stats.peakProgress;
      }
    } else angularIntervals.push({ ...stats, jointContribution: new Map(stats.jointContribution), parentSampleIds: new Set(stats.parentSampleIds), childSampleIds: new Set(stats.childSampleIds) });
  }
  const rotationChangeIntervals = angularIntervals.map(interval => {
    const rankedJoints = [...interval.jointContribution].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      startProgress: interval.startProgress, endProgress: interval.endProgress, peakProgress: interval.peakProgress,
      rmsAngularDisplacement: round(Math.sqrt(interval.integral / interval.duration / Math.max(1, rotationPairs.length))), peakAngularDisplacement: round(interval.peakAngularDisplacement),
      parentStartTime: interval.startProgress * parent.duration, parentEndTime: interval.endProgress * parent.duration,
      childStartTime: interval.startProgress * child.duration, childEndTime: interval.endProgress * child.duration,
      joints: rankedJoints.slice(0, 8).map(([joint]) => joint), omittedJointCount: Math.max(0, rankedJoints.length - 8),
      parentSampleIds: [...interval.parentSampleIds].slice(0, 16), childSampleIds: [...interval.childSampleIds].slice(0, 16),
    };
  }).sort((a, b) => b.peakAngularDisplacement - a.peakAngularDisplacement || b.rmsAngularDisplacement - a.rmsAngularDisplacement || a.startProgress - b.startProgress).slice(0, 8);
  const actionPhaseComparison = compareActionPhases(parent, child, pairs, positionFrame, phaseWindows);
  return {
    status: 'available', baselineStatus, positionFrame, positionChangeIntervals, rotationChangeIntervals, normalizedSamples: orderedPhases.length, changedJointCount: changed.length,
    largestDisplacement: round(ranked[0]?.maxDisplacement ?? 0), largestChanges: changed.slice(0, detailLimit), omittedPositionChangeCount: Math.max(0, changed.length - detailLimit),
    rotationStatus: rotations.length === pairs.length ? 'available' : 'unavailable',
    ...(rotations.length !== pairs.length ? { rotationUnavailableReason: 'One or both samples predate orientation telemetry; positional comparison is still available.' } : {}),
    changedRotationJointCount: changedRotations.length, largestAngularDisplacement: round(rankedRotations[0]?.maxAngularDisplacement ?? 0), largestRotationChanges: changedRotations.slice(0, detailLimit), omittedRotationChangeCount: Math.max(0, changedRotations.length - detailLimit),
    angularEvaluationSamples: rotationPairs.length ? 1 + (orderedPhases.length - 1) * 8 : 0, actionPhaseComparison,
    limitation: 'Position deltas compare sampled joint locations relative to each rig pivot; positional RMS integrates the piecewise-linear sampled displacement over normalized time. Angular RMS is a time-weighted trapezoidal estimate between common phases. They show where motion changed, not whether it improved; brief motion between Studio samples can still be missed.',
  };
}

export function inspectMotion(recipe: Recipe, raw?: unknown, mode: MotionMode = 'unknown', jointMap: Record<string, string> = {}): { report: Inspection; telemetry?: Telemetry } {
  const report: Inspection = { source: raw ? 'studio_pose_evaluator' : 'recipe_only', metrics: [], findings: [], questions: [], limitations: [] };
  if (recipe.kind === 'vfx') {
    report.source = 'recipe_only';
    report.findings.push({ id: 'vfx-shape', severity: 'note', title: 'Effect construction', detail: recipe.column ? `3D column with ${recipe.column.travelTime}s travel, ${round(recipe.lifetime - recipe.column.travelTime - recipe.column.fadeTime)}s hold, and ${recipe.column.fadeTime}s fade.` : recipe.beam ? 'Native flat beam. Confirm that this matches the volume you wanted.' : 'Particle emitter. Appearance depends on texture, camera, and lighting.', sampleIds: [] });
    report.questions = [{ id: 'shape', question: 'Does the effect have the volume and silhouette you wanted?', choices: ['Yes', 'Needs more volume', 'Needs a different shape'] }, { id: 'timing', question: 'How should its timing change?', choices: ['Keep it', 'Faster arrival', 'Longer hold', 'Faster fade'] }, { id: 'attachment', question: 'Does it start in the right place?', choices: ['Yes', 'Adjust the attachment or direction'] }];
    report.limitations = ['VFX inspection currently reads recipe parameters, not simulated particles or rendered effect geometry. Attach screenshots for a visual critique.'];
    return { report };
  }
  report.metrics.push({ id: 'duration', label: 'Duration', value: recipe.duration, unit: 'seconds', detail: recipe.loop ? 'Looping clip' : 'Plays once', sampleIds: [] });
  report.questions = [
    { id: 'weight', question: 'Does the character feel heavy enough?', choices: ['Yes, keep the weight', 'Heavier with stronger impacts', 'Lighter and quicker'] },
    { id: 'timing', question: 'What should change about the pacing?', choices: ['Keep this pacing', 'More anticipation and recovery', 'Faster action', 'Slower overall'] },
    { id: 'contacts', question: 'Do the feet and hands look right in the preview?', choices: ['Yes', 'Feet need work', 'Hands or arms need work', 'Both need work'] },
  ];
  if (!raw) {
    report.findings.push({ id: 'no-studio-data', severity: 'unknown', title: 'Live motion has not been inspected', detail: 'Connect Studio and select a rig, then run Inspect & ask me. Recipe validity does not prove the animation looks correct.', sampleIds: [] });
    report.limitations.push('No posed rig samples or viewport images were captured.');
    return { report };
  }
  const telemetry = telemetrySchema.parse(raw);
  if (telemetry.duration !== recipe.duration || telemetry.loop !== recipe.loop) throw new Error('Sampled animation timing does not match this recipe.');
  const frames = telemetry.samples, first = frames[0]!, last = frames.at(-1)!;
  let rootMotionNode = -1;
  const nodeIndex = telemetry.nodes.findIndex(n => /^(LowerTorso|Torso|hips|pelvis)$/i.test(n.name));
  const root = nodeIndex < 0 ? telemetry.nodes.findIndex(n => n.driven) : nodeIndex;
  if (root >= 0) {
    const ordered = [...frames].sort((a, b) => a.points[root]![1] - b.points[root]![1]);
    report.metrics.push({ id: 'body-rise', label: 'Body rise / drop', value: round(ordered.at(-1)!.points[root]![1] - ordered[0]!.points[root]![1]), unit: 'studs', detail: 'Range of the sampled pelvis or first driven node, relative to the rest rig.', sampleIds: [ordered[0]!.id, ordered.at(-1)!.id] });
    report.metrics.push({ id: 'body-travel', label: 'Body travel', value: round(distance(first.points[root]!, last.points[root]!, true)), unit: 'studs', detail: 'Horizontal displacement from the first pose to the last.', sampleIds: [first.id, last.id] });
  }
  if (recipe.rootMotion) {
    const rootMotionJoint = jointMap[recipe.rootMotion.joint] ?? recipe.rootMotion.joint;
    const rootMotionResolution = resolveTelemetryNodeName(telemetry.nodes, rootMotionJoint);
    if (rootMotionResolution.status === 'ambiguous') throw new Error(`Studio samples contain ambiguous case-insensitive matches for root-motion joint ${rootMotionJoint}: ${rootMotionResolution.candidates.join(', ')}. Use an exact inspected joint name.`);
    rootMotionNode = rootMotionResolution.status === 'missing' ? -1 : rootMotionResolution.index;
    if (rootMotionNode < 0) throw new Error(`Studio samples do not include root-motion joint ${rootMotionJoint}.`);
    let pathLength = 0;
    for (let sample = 1; sample < frames.length; sample++) pathLength += distance(frames[sample - 1]!.points[rootMotionNode]!, frames[sample]!.points[rootMotionNode]!);
    const net = distance(first.points[rootMotionNode]!, last.points[rootMotionNode]!);
    report.metrics.push({ id: 'root-motion-distance', label: 'Root-motion path length', value: round(pathLength), unit: 'studs', detail: `Measured from the evaluated ${recipe.rootMotion.joint} joint trajectory in Studio; this is authored pose motion, not automatic character/gameplay displacement or collision physics.`, sampleIds: frames.map(frame => frame.id).slice(0, 12) });
    report.metrics.push({ id: 'root-motion-net', label: 'Root-motion endpoint offset', value: round(net), unit: 'studs', detail: 'Net start-to-end displacement of the declared root joint. A nonzero loop offset is intentional authoring data, but Roblox gameplay will not automatically integrate it into character movement.', sampleIds: [first.id, last.id] });
  }
  let endpointGap = 0, velocityGap = 0, velocityNode = '';
  const seamPoint = (frame: Telemetry['samples'][number], node: number) => rootMotionNode >= 0 && node !== rootMotionNode
    ? frame.points[node]!.map((value, axis) => value - frame.points[rootMotionNode]![axis]!)
    : frame.points[node]!;
  const inRootMotionSubtree = (node: number) => {
    let parent = telemetry.nodes[node]!.parent - 1;
    while (parent >= 0) {
      if (parent === rootMotionNode) return true;
      parent = telemetry.nodes[parent]!.parent - 1;
    }
    return false;
  };
  for (let n = 0; n < telemetry.nodes.length; n++) {
    if (n === rootMotionNode || (rootMotionNode >= 0 && !inRootMotionSubtree(n))) continue;
    endpointGap = Math.max(endpointGap, distance(seamPoint(first, n), seamPoint(last, n)));
    const after = frames[1]!, before = frames.at(-2)!;
    const incomingPoint = seamPoint(last, n), beforePoint = seamPoint(before, n);
    const afterPoint = seamPoint(after, n), outgoingPoint = seamPoint(first, n);
    const incoming = incomingPoint.map((v, axis) => (v - beforePoint[axis]!) / (last.time - before.time));
    const outgoing = afterPoint.map((v, axis) => (v - outgoingPoint[axis]!) / (after.time - first.time));
    const gap = distance(incoming, outgoing);
    if (gap > velocityGap) { velocityGap = gap; velocityNode = telemetry.nodes[n]!.name; }
  }
  if (recipe.loop) {
    report.metrics.push({ id: 'loop-position-gap', label: 'Loop pose gap', value: round(endpointGap), unit: 'studs', detail: rootMotionNode >= 0 ? 'Largest start/end difference after removing the declared root-joint translation, so intentional travel is not mistaken for a pose discontinuity.' : 'Largest node position difference between the two loop endpoints.', sampleIds: [first.id, last.id] });
    report.metrics.push({ id: 'loop-velocity-gap', label: 'Loop pose velocity change', value: round(velocityGap), unit: 'studs / second', detail: `Largest estimated pose-relative velocity change, at ${velocityNode}.${rootMotionNode >= 0 ? ' Declared root-joint travel is analyzed separately.' : ''} This uses finite samples and needs visual confirmation.`, sampleIds: [first.id, frames[1]!.id, frames.at(-2)!.id, last.id] });
    if (velocityGap > telemetry.height * 0.4) report.findings.push({ id: 'loop-transition', severity: 'possible_issue', title: 'Check the loop transition', detail: `${velocityNode} changes estimated speed/direction at the seam. Matching endpoint positions alone does not guarantee a smooth loop.`, sampleIds: [first.id, frames[1]!.id, frames.at(-2)!.id, last.id] });
  }
  const feet = telemetry.nodes.flatMap((node, index) => node.foot ? [index] : []);
  for (const [contactIndex, contact] of (recipe.contacts ?? []).entries()) {
    const effectorName = jointMap[contact.effector] ?? contact.effector;
    const effectorResolution = resolveTelemetryNodeName(telemetry.nodes, effectorName);
    if (effectorResolution.status === 'ambiguous') {
      report.findings.push({ id: `contact-ambiguous-${contactIndex}`, severity: 'unknown', title: `Contact joint ${contact.effector} has ambiguous casing`, detail: `Studio contains multiple case-insensitive matches for ${effectorName} (${effectorResolution.candidates.join(', ')}). Use the exact inspected joint name before interpreting contact drift.`, sampleIds: [] });
      continue;
    }
    const effector = effectorResolution.status === 'missing' ? -1 : effectorResolution.index;
    if (effector < 0) {
      report.findings.push({ id: `contact-missing-${contactIndex}`, severity: 'unknown', title: `Contact joint ${contact.effector} was not sampled`, detail: `The contact interval is declared, but Studio telemetry has no matching joint (${effectorName}). Check the rig joint name and mapping.`, sampleIds: [] });
      continue;
    }
    const window = frames.filter(frame => frame.time >= contact.start && frame.time <= contact.end);
    if (window.length < 2) {
      report.findings.push({ id: `contact-sparse-${contactIndex}`, severity: 'unknown', title: `${contact.effector} contact has too few samples`, detail: 'Add more inspection samples or widen the declared contact interval before judging drift.', sampleIds: window.map(frame => frame.id) });
      continue;
    }
    const contactSampleTimes = window.map(frame => frame.time);
    const sampleAtContactTime = (time: number) => window.find(frame => sameAnimationTime(frame.time, time));
    const exactStartSample = sampleAtContactTime(contact.start);
    const exactMidpointSample = sampleAtContactTime((contact.start + contact.end) / 2);
    const exactEndSample = sampleAtContactTime(contact.end);
    const contactCoverageGaps = [
      window[0]!.time - contact.start,
      ...window.slice(1).map((frame, index) => frame.time - window[index]!.time),
      contact.end - window.at(-1)!.time,
    ];
    const contactSampling: ContactSamplingEvidence = {
      status: exactStartSample && exactMidpointSample && exactEndSample
        && new Set([exactStartSample.id, exactMidpointSample.id, exactEndSample.id]).size === 3 ? 'complete' : 'partial',
      sampleTimes: contactSampleTimes,
      maximumSampleGapSeconds: Math.max(...contactCoverageGaps),
      exactStart: exactStartSample !== undefined,
      exactMidpoint: exactMidpointSample !== undefined,
      exactEnd: exactEndSample !== undefined,
    };
    const anchor = window[0]!, drift = Math.max(...window.map(frame => distance(anchor.points[effector]!, frame.points[effector]!)));
    // Preserve full precision for thresholded acceptance tests; only narrative findings are rounded.
    const contactIdentity = JSON.stringify([contact.effector.toLowerCase(), contact.kind, contact.start, contact.end]);
    report.metrics.push({ id: `declared-contact-${contactIndex}`, semanticKey: `contact:${contactIdentity}:position`, label: `${contact.effector} ${contact.kind} drift`, value: drift, unit: 'studs', detail: `Maximum sampled 3D displacement from the first pose in the declared ${contact.start.toFixed(3)}–${contact.end.toFixed(3)}s contact interval: ${round(drift)} studs. This is a warning signal, not an automatic IK correction or proof of physical contact.`, sampleIds: window.map(frame => frame.id).slice(0, 12), contactSampling });
    if (drift > Math.max(0.08, telemetry.height * 0.025)) report.findings.push({ id: `contact-drift-${contactIndex}`, severity: 'possible_issue', title: `Check ${contact.effector} ${contact.kind} stability`, detail: `The joint moves ${round(drift)} studs during its declared contact interval. Confirm whether this is intentional, and refine the pose or contact timing if it should remain planted.`, sampleIds: window.map(frame => frame.id).slice(0, 8) });
    if (window.every(frame => frame.orientations?.[effector])) {
      const orientationDrift = Math.max(...window.map(frame => angularDistanceDegrees(anchor.orientations![effector]! as Quaternion, frame.orientations![effector]! as Quaternion)));
      report.metrics.push({ id: `declared-contact-rotation-${contactIndex}`, semanticKey: `contact:${contactIdentity}:rotation`, label: `${contact.effector} ${contact.kind} angular drift`, value: orientationDrift, unit: 'degrees', detail: `Maximum sampled world-orientation change from the first pose in the declared ${contact.start.toFixed(3)}–${contact.end.toFixed(3)}s contact interval: ${round(orientationDrift)} degrees. Orientation stability is not proof of physical contact.`, sampleIds: window.map(frame => frame.id).slice(0, 12), contactSampling });
    }
  }
  for (const foot of feet) {
    const name = telemetry.nodes[foot]!.name;
    const lowest = frames.reduce((a, b) => b.bottoms[foot]! < a.bottoms[foot]! ? b : a);
    const highest = frames.reduce((a, b) => b.bottoms[foot]! > a.bottoms[foot]! ? b : a);
    report.metrics.push({ id: `clearance-${foot}`, label: `${name} lift`, value: round(highest.bottoms[foot]!), unit: 'studs', detail: 'Highest sampled sole bound above the estimated rest ground plane.', sampleIds: [highest.id] });
    if (lowest.bottoms[foot]! < -telemetry.height * 0.025) report.findings.push({ id: `ground-${foot}`, severity: 'possible_issue', title: `${name} passes below estimated ground`, detail: `The sole bound reaches ${round(lowest.bottoms[foot]!)} studs relative to the rest plane. Check the actual floor, rig placement and foot roll before treating this as penetration.`, sampleIds: [lowest.id] });
    let travel = 0; const ids = new Set<string>();
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      if (Math.abs(a.bottoms[foot]!) <= telemetry.height * 0.03 && Math.abs(b.bottoms[foot]!) <= telemetry.height * 0.03) {
        travel += distance(a.points[foot]!, b.points[foot]!, true); ids.add(a.id); ids.add(b.id);
      }
    }
    report.metrics.push({ id: `contact-travel-${foot}`, label: `${name} near-ground travel`, value: round(travel), unit: 'studs', detail: 'Horizontal foot travel while both sampled sole bounds are near the estimated ground. This is not proof of sliding; in-place walks need backward foot travel.', sampleIds: [...ids].slice(0, 12) });
    if (mode === 'stationary' && travel > telemetry.height * 0.08) report.findings.push({ id: `contact-${foot}`, severity: 'possible_issue', title: `Check ${name} contact`, detail: 'You marked this as stationary, but the foot travels near the estimated floor. Check whether that movement is intentional.', sampleIds: [...ids].slice(0, 8) });
  }
  if (!feet.length) report.findings.push({ id: 'no-feet', severity: 'unknown', title: 'Foot contact is unknown', detail: 'No animated node names contain “foot”. Contact checks need a recognizable foot node or a visual review.', sampleIds: [] });
  if (!report.findings.length) report.findings.push({ id: 'no-flags', severity: 'note', title: 'No large motion flags from these samples', detail: 'This does not certify motion quality. Judge silhouette, intention, weight, hands, and timing in the preview.', sampleIds: [first.id, last.id] });
  report.limitations.push('Samples come from the Studio pose evaluator, not gameplay physics or video.', 'The diagram shows joint positions, not skin, clothing, hair, textures, or collisions.', 'Ground uses rest-pose bounds. Foot travel in an in-place walk can be correct; gameplay speed is not measured.', `Sample interval varies around markers; ${frames.length} poses cannot expose every event between samples.`);
  return { report, telemetry };
}
