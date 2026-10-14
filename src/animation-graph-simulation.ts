import { createHash } from 'node:crypto';
import { z } from 'zod';
import { animationGraphFingerprint, animationGraphSchema, evaluateAnimationGraphTransition, normalizeAnimationGraphParameters,
  type AnimationGraph } from './animation-graph.js';
import { createComposedJointEvaluationSampler } from './animation-patch.js';
import { animationSchema, identifier, label } from './recipes.js';
import { fingerprint } from './inspection.js';
import { quaternionAngularDistanceDegrees, quaternionAngularVelocityDegrees, transportVectorBetweenQuaternionFrames,
  weightedQuaternionMean, type Quaternion4 } from './quaternion-blend.js';
import { studioPlayRetriggerProbeSchema } from './animation-graph-fade-calibrations.js';
import { sampleAnimationGraphBlendSpace1D } from './animation-graph-blend-space.js';
import { sampleAnimationGraphBlendSpace2D } from './animation-graph-blend-space-2d.js';
import { analyzeBlendSpacePhaseSynchronizationBatch } from './animation-graph-phase-sync.js';

// Bump whenever authored local-pose sampling, priority allocation, or rotation composition changes.
export const animationGraphPoseModelAlgorithmVersion = 2 as const;

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const parameterValue = z.union([z.boolean(), z.number().finite(), z.string().max(256)]);
const MAX_PARAMETER_RAMP_SAMPLES = 10000;
const timedEvent = z.discriminatedUnion('kind', [
  z.object({ at: z.number().finite().min(0).max(120), kind: z.literal('trigger'), trigger: label,
    setParameters: z.record(id, parameterValue).default({}), expectTransitionId: id.optional() }).strict(),
  z.object({ at: z.number().finite().min(0).max(120), kind: z.literal('set_parameters'), values: z.record(id, parameterValue) }).strict(),
  z.object({ at: z.number().finite().min(0).max(120), kind: z.literal('ramp_parameters'),
    values: z.record(id, z.number().finite()).refine(values => Object.keys(values).length > 0,
      'At least one numeric parameter target is required.'), duration: z.number().finite().min(0.01).max(120),
    easing: z.enum(['linear', 'smoothstep']).default('linear') }).strict()
    .describe('Animate numeric graph parameters from their current values to targets over duration. Parameter updates occur at the saved graph sample rate (not the optional output observation rate); the final target is applied exactly when ramp completion falls within the simulation horizon. If the horizon ends first, the ramp remains partial and its current value is reported. Direct writes and successfully committed trigger updates cancel overlapping ramp channels.'),
  z.object({ at: z.number().finite().min(0).max(120), kind: z.literal('set_playback_speed'), multiplier: z.number().finite().min(0.1).max(4) }).strict(),
]);

const animationGraphSimulationInputObjectSchema = z.object({
  duration: z.number().finite().min(0.01).max(120),
  sampleRateHz: z.number().int().min(10).max(120).optional()
    .describe('Optional per-run uniform blend/pose sampling rate from 10 to 120 Hz. Defaults to the graph sample rate. Runtime events remain scheduled at their exact modeled timestamps; higher rates only densify returned samples and consume the existing sample and pose budgets. The complete serialized result is also capped at 8 MiB; if exceeded, lower the rate/duration, request fewer poseJoints, use explicit sampleTimes, or disable pose samples.'),
  maxPoseSampleGapSeconds: z.number().finite().min(0).max(10).optional()
    .describe('Optional sampling-density gate: fail the reported gate when adjacent composed pose timestamps are farther apart than this value. Requires includePoseSamples=true. This measures temporal coverage only; it does not establish motion accuracy.'),
  naturalCompletionFadeSeconds: z.number().finite().min(0).max(3).optional()
    .describe('Explicit assumption for how long a naturally completed non-looping track continues fading before AnimationEnded is delivered. Defaults to zero for compatibility. Supply only a duration measured or intentionally assumed for the target Studio/runtime; this does not reuse Stop() fade calibration.'),
  initialParameters: z.record(id, parameterValue).default({}),
  observedBlendAnimationLengths: z.record(id, z.record(id, z.number().finite().min(0.001).max(120))).default({})
    .describe('Optional live Roblox AnimationTrack.Length measurements in seconds, keyed first by BlendSpace controller state ID and then by sample source state ID. Provide every sample source length for each calibrated controller; the simulator then uses the runtime synchronizer speed ratios and maps authored poses/markers by normalized phase. Use fresh measurements from the same published animation assets.'),
  observedBlendAnimationPlaybackSpeeds: z.record(id, z.record(id, z.number().finite().min(0.0001).max(100000))).default({})
    .describe('Live Roblox AnimationTrack.Speed measurements matching every supplied observedBlendAnimationLengths controller/source pair. These preserve whether the runtime has synchronized playback or is still using authored-duration speeds.'),
  observedBlendAnimationStartPhases: z.record(id, z.record(id, z.number().finite().min(0).lt(1))).default({})
    .describe('Optional live normalized TimePosition phases, in [0, 1), keyed by BlendSpace controller and sample state. When supplied with complete length/speed maps, initializes each simulated source clock at the captured phase before advancing time.'),
  observedBlendAnimationAssetSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('Asset-set fingerprint returned by GetBlendState().simulationTimingCalibration; pass it together with expectedBlendAnimationAssetSetFingerprint to bind live lengths to the exact graph and published animation IDs.'),
  expectedBlendAnimationAssetSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('Asset-set fingerprint returned by motion_animation_graph_runtime_export for the graph and published animation IDs expected by this simulation. When supplied, it must equal observedBlendAnimationAssetSetFingerprint.'),
  unavailableStateIds: z.array(id).max(64).default([]).describe('Optional runtime fault injection: treat these non-entry destination states as failing AnimationTrack loading. A failed selected transition leaves state, active tracks, and parameter updates unchanged; it does not fall through to another branch.'),
  events: z.array(timedEvent).max(512).default([])
    .describe('Timestamped graph triggers, typed parameter updates, numeric parameter ramps, or set_playback_speed changes. Equal-time inputs retain authored order under the documented baseline policy. Ramps update at the saved graph sample rate; sampleRateHz and sampleTimes only control returned observations and cannot change simulated behavior. Ramps can be interrupted per parameter by later direct or committed trigger updates and are subject to a 10,000 generated-ramp-sample work limit. A speed change preserves active normalized phases, scales all active BlendSpace source clocks by the same ratio, and reschedules future marker and natural-completion callbacks.'),
  sampleTimes: z.array(z.number().finite().min(0).max(120)).max(512).default([]),
  poseJoints: z.array(label).max(256).default([])
    .describe('Optional exact joint names to include in composedPoseSamples and poseMotionDiagnostics. Diagnostics include sampled local translation/angular speed, translation acceleration (change in sampled local velocity), angular acceleration (change in sampled local angular-velocity vector), and angular-speed magnitude change, with observed intervals. Adjacent angular-velocity vectors are transported into the newer interval start frame before comparison. These are discrete samples, not continuous-time or rendered/world-space motion or an artistic-quality verdict. For an active BlendSpace source with positive pose weight but no authored channel on a requested joint, joints[].unanimatedTracks identifies its source/controller, priority, normalized playback time, and current/target pose weights; its weight remains neutral local residual, not fabricated motion.'),
  includePoseSamples: z.boolean().default(true).describe('Set false to skip per-joint local pose composition while retaining blendSamples and requested track-weight timestamps. Cannot be combined with poseJoints. When enabled, composedPoseSamples include source-attributed unanimatedTracks evidence for missing BlendSpace joint channels.'),
  includeBlendSamplePoses: z.boolean().default(false).describe('Compose local poses at every generated blend sample (uniform frame grid plus event and explicitly requested timestamps), in addition to sampleTimes. Bounded by the composed joint-time safety limit, a 4 MiB serialized recipe-provenance limit, and the complete 8 MiB result limit; set poseJoints to focus the trace or use explicit sampleTimes for a smaller trace.'),
  analyzeEventOrderSensitivity: z.boolean().default(false).describe('Run a second deterministic simulation with runtime marker/AnimationEnded callbacks ordered before user inputs at tied timestamps. Compare state, parameters, marker/timeline outcomes, and blend/composed-pose values at timestamps present in both runs. This is a sensitivity diagnostic, not a Roblox callback-order guarantee.'),
  maxEventOrderDivergences: z.number().int().min(0).max(7).optional().describe('Optional pass/fail gate for divergent outcome dimensions across final state, transition IDs, parameters, marker delivery, timeline, blend samples, and composed poses. It passes only when divergence is within the limit and both policies have complete blend/pose sample timestamp coverage. Requires analyzeEventOrderSensitivity=true.'),
}).strict();

const fadeCalibrationCurveSchema = z.array(z.object({ at: z.number().finite().min(0).max(3),
  weightCurrent: z.number().finite().min(0).max(1), weightTarget: z.number().finite().min(0).max(1) }).strict()).min(2).max(362);
const resolvedFadeCalibrationSchema = z.object({ id: identifier, stateId: id, recipeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/), fadeSeconds: z.number().finite().min(0.05).max(3),
  sampleRateHz: z.number().int().min(10).max(120).optional(),
  playIn: fadeCalibrationCurveSchema, stopOut: fadeCalibrationCurveSchema,
  adjustWeightIn: fadeCalibrationCurveSchema.optional(), adjustWeightOut: fadeCalibrationCurveSchema.optional(),
  playRetrigger: studioPlayRetriggerProbeSchema.optional(), naturalCompletion: z.object({
    authoredDurationSeconds: z.number().finite().min(0.01).max(30), animationLengthSeconds: z.number().finite().positive().max(30),
    playbackSpeed: z.number().finite().min(0.1).max(4), endedAfterStoppedSeconds: z.number().finite().min(0).max(3),
    samples: z.array(z.object({ at: z.number().finite().min(0).max(3), weightCurrent: z.number().finite().min(0).max(1),
      weightTarget: z.number().finite().min(0).max(1) }).strict()).min(1).max(362),
  }).strict().optional() }).strict().superRefine((profile, context) => {
    for (const [name, curve, target] of [['playIn', profile.playIn, 1], ['stopOut', profile.stopOut, 0]] as const) {
      if (curve[0]!.at !== 0 || Math.abs(curve[0]!.weightTarget - target) > 1e-4
        || Math.abs(curve.at(-1)!.at - profile.fadeSeconds) > 0.001
        || Math.abs(curve.at(-1)!.weightCurrent - target) > 0.01
        || curve.some((sample, index) => index > 0 && sample.at <= curve[index - 1]!.at)) {
        context.addIssue({ code: 'custom', path: [name], message: 'Fade calibration curve must have ordered timestamps and verified start/end evidence matching its duration.' });
      }
    }
    if ((profile.adjustWeightIn === undefined) !== (profile.adjustWeightOut === undefined)) {
      context.addIssue({ code: 'custom', path: ['adjustWeightIn'], message: 'Both AdjustWeight fade directions must be supplied together.' });
    }
    for (const [name, curve, target] of [['adjustWeightIn', profile.adjustWeightIn, 1], ['adjustWeightOut', profile.adjustWeightOut, 0]] as const) {
      if (curve && (curve[0]!.at !== 0 || Math.abs(curve[0]!.weightTarget - target) > 1e-4
        || Math.abs(curve.at(-1)!.at - profile.fadeSeconds) > 0.001
        || Math.abs(curve.at(-1)!.weightCurrent - target) > 0.01
        || curve.some((sample, index) => index > 0 && sample.at <= curve[index - 1]!.at))) {
        context.addIssue({ code: 'custom', path: [name], message: 'AdjustWeight calibration curve must have ordered times and verified start/end evidence matching its duration.' });
      }
    }
    if (profile.naturalCompletion) {
      const measurement = profile.naturalCompletion;
      if (measurement.samples[0]!.at !== 0
        || Math.abs(measurement.samples.at(-1)!.at - measurement.endedAfterStoppedSeconds) > 0.001
        || Math.abs(measurement.samples.at(-1)!.weightCurrent) > 0.01
        || measurement.samples.some((sample, index) => index > 0 && sample.at <= measurement.samples[index - 1]!.at)
        || (measurement.endedAfterStoppedSeconds === 0 && measurement.samples.length !== 1)
        || (measurement.endedAfterStoppedSeconds > 0 && measurement.samples.length < 2)) {
        context.addIssue({ code: 'custom', path: ['naturalCompletion'], message: 'Natural-completion samples must be ordered and span the observed track fade through zero WeightCurrent.' });
      }
    }
  });

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const animationGraphSimulationInputShape = animationGraphSimulationInputObjectSchema.shape;
export const animationGraphSimulationInputSchema = animationGraphSimulationInputObjectSchema.superRefine((input, context) => {
  input.sampleTimes.forEach((at, index) => {
    if (at > input.duration) context.addIssue({ code: 'custom', path: ['sampleTimes', index], message: 'Blend sample time cannot exceed simulation duration.' });
  });
  if (!input.includePoseSamples && input.poseJoints.length > 0) context.addIssue({ code: 'custom', path: ['poseJoints'], message: 'poseJoints cannot be supplied when includePoseSamples is false.' });
  if (!input.includePoseSamples && input.includeBlendSamplePoses) context.addIssue({ code: 'custom', path: ['includeBlendSamplePoses'], message: 'includeBlendSamplePoses requires includePoseSamples=true.' });
  if (!input.includePoseSamples && input.maxPoseSampleGapSeconds !== undefined) context.addIssue({ code: 'custom', path: ['maxPoseSampleGapSeconds'], message: 'maxPoseSampleGapSeconds requires includePoseSamples=true.' });
  if (input.maxEventOrderDivergences !== undefined && !input.analyzeEventOrderSensitivity) {
    context.addIssue({ code: 'custom', path: ['maxEventOrderDivergences'], message: 'A divergence gate requires analyzeEventOrderSensitivity=true.' });
  }
  const observedAssetFingerprintSupplied = input.observedBlendAnimationAssetSetFingerprint !== undefined;
  const expectedAssetFingerprintSupplied = input.expectedBlendAnimationAssetSetFingerprint !== undefined;
  if (observedAssetFingerprintSupplied !== expectedAssetFingerprintSupplied) {
    context.addIssue({ code: 'custom', path: ['expectedBlendAnimationAssetSetFingerprint'], message: 'Observed and expected asset-set fingerprints must be supplied together.' });
  }
  const hasObservedBlendLengths = Object.keys(input.observedBlendAnimationLengths).length > 0;
  const hasObservedBlendSpeeds = Object.keys(input.observedBlendAnimationPlaybackSpeeds).length > 0;
  if (hasObservedBlendLengths !== hasObservedBlendSpeeds) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationPlaybackSpeeds'], message: 'Live BlendSpace calibration requires both complete observed length and actual playback-speed maps.' });
  }
  if (Object.keys(input.observedBlendAnimationLengths).some(controllerId => input.observedBlendAnimationPlaybackSpeeds[controllerId] === undefined)
    || Object.keys(input.observedBlendAnimationPlaybackSpeeds).some(controllerId => input.observedBlendAnimationLengths[controllerId] === undefined)) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationPlaybackSpeeds'], message: 'Length and playback-speed maps must contain the same controller IDs.' });
  }
  if (Object.keys(input.observedBlendAnimationStartPhases).length > 0 && !hasObservedBlendLengths) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationStartPhases'],
      message: 'Observed starting phases require the matching complete Roblox length and playback-speed maps and their asset-set fingerprints.' });
  }
  if (hasObservedBlendLengths && !observedAssetFingerprintSupplied) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationAssetSetFingerprint'],
      message: 'Observed BlendSpace lengths must be bound to both the runtime snapshot and expected export asset-set fingerprints.' });
  }
  if (observedAssetFingerprintSupplied && Object.keys(input.observedBlendAnimationLengths).length === 0) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationLengths'], message: 'Asset-set fingerprints can only bind supplied live BlendSpace length measurements.' });
  }
  if (observedAssetFingerprintSupplied
    && input.observedBlendAnimationAssetSetFingerprint !== input.expectedBlendAnimationAssetSetFingerprint) {
    context.addIssue({ code: 'custom', path: ['observedBlendAnimationAssetSetFingerprint'], message: 'Observed live measurements belong to a different graph/published animation asset set than this simulation.' });
  }
});

function countParameterRampSamples(input: Pick<z.infer<typeof animationGraphSimulationInputSchema>, 'duration' | 'events'>,
  sampleRateHz: number): number {
  return input.events.reduce((count, event) => {
    if (event.kind !== 'ramp_parameters' || event.at > input.duration) return count;
    const rampEnd = Math.min(event.at + event.duration, input.duration);
    if (rampEnd <= event.at) return count;
    const firstFrame = Math.floor(event.at * sampleRateHz) + 1;
    const uniformFrameCount = Math.max(0, Math.ceil((rampEnd - 1e-12) * sampleRateHz) - firstFrame);
    return count + uniformFrameCount + 1;
  }, 0);
}

type GraphState = AnimationGraph['states'][number];
type GraphBlendSource = { stateId: string };
function blendSources(controller: GraphState): GraphBlendSource[] {
  return controller.blendSpace1D?.samples ?? controller.blendSpace2D?.samples ?? [];
}
function isBlendController(controller: GraphState): boolean {
  return controller.blendSpace1D !== undefined || controller.blendSpace2D !== undefined;
}
function sampleGraphBlend(controller: GraphState, parameters: Record<string, boolean | number | string>) {
  if (controller.blendSpace1D) {
    const parameterValue = parameters[controller.blendSpace1D.parameter];
    if (typeof parameterValue !== 'number') throw new Error(`BlendSpace1D parameter ${controller.blendSpace1D.parameter} must be numeric.`);
    const sampled = sampleAnimationGraphBlendSpace1D(controller.blendSpace1D, parameterValue);
    return { parameter: sampled.parameter, value: sampled.parameterValue, clampedValue: sampled.sampledValue,
      lowerStateId: sampled.lowerSample, upperStateId: sampled.upperSample, weights: sampled.weights,
      parameters: { [sampled.parameter]: sampled.parameterValue }, clampedParameters: { [sampled.parameter]: sampled.sampledValue },
      parameterNames: { x: sampled.parameter, y: null }, method: sampled.method };
  }
  if (controller.blendSpace2D) {
    const x = parameters[controller.blendSpace2D.xParameter], y = parameters[controller.blendSpace2D.yParameter];
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`BlendSpace2D parameters ${controller.blendSpace2D.xParameter}/${controller.blendSpace2D.yParameter} must be numeric.`);
    const sampled = sampleAnimationGraphBlendSpace2D(controller.blendSpace2D, { x, y });
    const active = sampled.weights.filter(sample => sample.weight > 0);
    const clampedValue = sampled.weights.reduce((point, sample) => ({ x: point.x + sample.x * sample.weight, y: point.y + sample.y * sample.weight }), { x: 0, y: 0 });
    return { parameter: `${controller.blendSpace2D.xParameter},${controller.blendSpace2D.yParameter}`,
      value: { x, y }, clampedValue, lowerStateId: active[0]?.stateId ?? controller.id,
      upperStateId: active.at(-1)?.stateId ?? controller.id, weights: sampled.weights,
      parameters: { [controller.blendSpace2D.xParameter]: x, [controller.blendSpace2D.yParameter]: y },
      clampedParameters: { [controller.blendSpace2D.xParameter]: clampedValue.x, [controller.blendSpace2D.yParameter]: clampedValue.y },
      parameterNames: { x: controller.blendSpace2D.xParameter, y: controller.blendSpace2D.yParameter }, axisValues: { x, y }, method: sampled.method };
  }
  throw new Error(`Graph state ${controller.id} is not a blend-space controller.`);
}

const MAX_PROCESSED_EVENTS = 20000;
const MAX_TIMELINE_ENTRIES = 5000;
const MAX_BLEND_SAMPLES = 10000;
const MAX_TRACK_SAMPLES = 100000;
const MAX_BLEND_SPACE_WEIGHT_SAMPLES = 100000;
const MAX_COMPOSED_POSE_JOINT_SAMPLES = 20000;
const MAX_COMPOSED_POSE_CONTRIBUTIONS = 50000;
const MAX_POSE_COMPOSITION_SOURCES = 100000;
const MAX_POSE_PROVENANCE_BYTES = 4 * 1024 * 1024;
const MAX_SIMULATION_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GUARD_DIAGNOSTIC_BYTES = 512 * 1024;
const MAX_EVENT_ORDERING_COLLISION_DETAILS = 512;
const eventOrderingRuntimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('marker'), stateId: id, marker: label }).strict(),
  z.object({ kind: z.literal('animation_end'), stateId: id }).strict(),
  z.object({ kind: z.literal('animation_natural_stop'), stateId: id, blendSourceStateId: id.optional() }).strict(),
]);
const eventOrderingCollisionSchema = z.object({ at: z.number().finite().min(0).max(120), eventCount: z.number().int().positive(),
  externalInputIndices: z.array(z.number().int().min(0).max(511)).max(512),
  runtimeEvents: z.array(eventOrderingRuntimeEventSchema).min(1).max(MAX_PROCESSED_EVENTS) }).strict().superRefine((collision, context) => {
  if (collision.eventCount !== collision.externalInputIndices.length + collision.runtimeEvents.length) {
    context.addIssue({ code: 'custom', path: ['eventCount'], message: 'Collision eventCount must equal its external and runtime event detail counts.' });
  }
  if (collision.externalInputIndices.some((value, index) => index > 0 && value <= collision.externalInputIndices[index - 1]!)) {
    context.addIssue({ code: 'custom', path: ['externalInputIndices'], message: 'External input indices must be unique and sorted.' });
  }
});
export const animationGraphEventOrderingDiagnosticsSchema = z.object({
  policy: z.literal('user inputs are processed before runtime marker/AnimationEnded and modeled natural-completion fade-start events at the same timestamp; user inputs retain authored order; Roblox runtime callback ordering is not guaranteed'),
  ambiguousCollisionCount: z.number().int().nonnegative().max(MAX_PROCESSED_EVENTS),
  detailedCollisionCount: z.number().int().min(0).max(MAX_EVENT_ORDERING_COLLISION_DETAILS),
  truncatedCollisionCount: z.number().int().nonnegative().max(MAX_PROCESSED_EVENTS),
  collisions: z.array(eventOrderingCollisionSchema).max(MAX_EVENT_ORDERING_COLLISION_DETAILS),
}).strict().superRefine((diagnostics, context) => {
  if (diagnostics.detailedCollisionCount !== diagnostics.collisions.length
    || diagnostics.ambiguousCollisionCount !== diagnostics.detailedCollisionCount + diagnostics.truncatedCollisionCount) {
    context.addIssue({ code: 'custom', path: ['ambiguousCollisionCount'], message: 'Collision counts must agree with detailed and truncated collision records.' });
  }
  if (diagnostics.truncatedCollisionCount > 0 && diagnostics.detailedCollisionCount !== MAX_EVENT_ORDERING_COLLISION_DETAILS) {
    context.addIssue({ code: 'custom', path: ['truncatedCollisionCount'], message: 'Collision details may be truncated only after the detail limit is reached.' });
  }
  if (diagnostics.collisions.some((collision, index) => index > 0 && collision.at <= diagnostics.collisions[index - 1]!.at)) {
    context.addIssue({ code: 'custom', path: ['collisions'], message: 'Detailed collision timestamps must be strictly increasing.' });
  }
});
export const animationGraphEventOrderSensitivitySchema = z.object({
  kind: z.literal('user_first_vs_runtime_callbacks_first'), status: z.enum(['equivalent', 'divergent']),
  baselinePolicy: z.string(), alternatePolicy: z.string(), finalStateChanged: z.boolean(), transitionIdsChanged: z.boolean(),
  finalParametersChanged: z.boolean(), markerEventsChanged: z.boolean(), timelineChanged: z.boolean(),
  blendSamplesChanged: z.boolean(), composedPoseSamplesChanged: z.boolean(),
  sampleComparisonScope: z.literal('exact_shared_timestamps_only').optional(),
  sampleComparisonComplete: z.boolean().optional(),
  blendSampleTimeCoverage: z.object({ compared: z.number().int().nonnegative().max(10000),
    baselineOnly: z.number().int().nonnegative().max(10000), alternateOnly: z.number().int().nonnegative().max(10000) }).strict().optional(),
  composedPoseSampleTimeCoverage: z.object({ compared: z.number().int().nonnegative().max(20000),
    baselineOnly: z.number().int().nonnegative().max(20000), alternateOnly: z.number().int().nonnegative().max(20000) }).strict().optional(),
  divergenceCount: z.number().int().min(0).max(7),
  gate: z.object({ status: z.enum(['passed', 'failed']), maximumAllowedDivergences: z.number().int().min(0).max(7),
    observedDivergences: z.number().int().min(0).max(7), sampleComparisonComplete: z.boolean().optional() }).strict().nullable(),
  firstTimelineDifference: z.object({ baseline: z.unknown().nullable(), alternate: z.unknown().nullable() }).strict().nullable(),
  baselineOutcome: z.object({ finalState: id, transitionIds: z.array(id), finalParameters: z.record(parameterValue),
    triggeredMarkerCount: z.number().int().nonnegative() }).strict(),
  alternateOutcome: z.object({ finalState: id, transitionIds: z.array(id), finalParameters: z.record(parameterValue),
    triggeredMarkerCount: z.number().int().nonnegative() }).strict(),
  limitation: z.string().min(1).max(1024),
}).strict().superRefine((result, context) => {
  const divergenceCount = [result.finalStateChanged, result.transitionIdsChanged, result.finalParametersChanged,
    result.markerEventsChanged, result.timelineChanged, result.blendSamplesChanged, result.composedPoseSamplesChanged].filter(Boolean).length;
  if (result.divergenceCount !== divergenceCount || result.status !== (divergenceCount > 0 ? 'divergent' : 'equivalent')) {
    context.addIssue({ code: 'custom', path: ['divergenceCount'], message: 'Sensitivity status and divergence count must agree with the seven outcome dimensions.' });
  }
  if (result.gate && (result.gate.observedDivergences !== divergenceCount
    || result.gate.status !== (divergenceCount <= result.gate.maximumAllowedDivergences
      && result.gate.sampleComparisonComplete !== false ? 'passed' : 'failed'))) {
    context.addIssue({ code: 'custom', path: ['gate'], message: 'Sensitivity gate must agree with observed divergence dimensions and its maximum.' });
  }
  if (result.sampleComparisonComplete !== undefined && (result.blendSampleTimeCoverage === undefined
    || result.composedPoseSampleTimeCoverage === undefined
    || result.sampleComparisonComplete !== (result.blendSampleTimeCoverage.baselineOnly === 0
      && result.blendSampleTimeCoverage.alternateOnly === 0
      && result.composedPoseSampleTimeCoverage.baselineOnly === 0
      && result.composedPoseSampleTimeCoverage.alternateOnly === 0))) {
    context.addIssue({ code: 'custom', path: ['sampleComparisonComplete'], message: 'Sample-comparison completeness must agree with both timestamp-coverage reports.' });
  }
});
const animationGraphEndedTimingCurrentSchema = z.object({ kind: z.literal('assumed_natural_completion_fade'),
  assumedAdditionalFadeSeconds: z.number().finite().min(0).max(3),
  summaryStateId: id, summaryScope: z.enum(['entry_state', 'caller_global_override']),
  source: z.enum(['default_zero', 'caller_supplied', 'studio_calibrated', 'ambiguous_profile_default_zero', 'studio_length_mismatch_default_zero']),
  stateTimings: z.array(z.object({ stateId: id, fadeSeconds: z.number().finite().min(0).max(3),
    source: z.enum(['default_zero', 'caller_supplied', 'studio_calibrated', 'ambiguous_profile_default_zero', 'studio_length_mismatch_default_zero']),
    calibrationProfileId: identifier.nullable(), measuredAnimationLengthSeconds: z.number().finite().positive().max(30).nullable(),
    calibrationConflictProfileIds: z.array(identifier).max(64),
    animationLengthMatchesRecipe: z.boolean().nullable(), animationLengthSeconds: z.number().finite().positive().max(30),
    animationLengthSource: z.enum(['authored_recipe', 'studio_measured']), clipPlaybackSeconds: z.number().finite().min(0).max(30),
    animationEndedAfterPlaybackStartSeconds: z.number().finite().min(0).max(33) }).strict()).max(64),
  naturalCompletionConflicts: z.array(z.object({ stateId: id,
    conflictingFields: z.array(z.enum(['authoredDurationSeconds', 'animationLengthSeconds', 'playbackSpeed', 'endedAfterStoppedSeconds', 'samples'])).min(1).max(5),
    candidates: z.array(z.object({ profileId: identifier, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      measurementFingerprint: z.string().regex(/^[a-f0-9]{64}$/), animationLengthSeconds: z.number().finite().positive().max(30),
      playbackSpeed: z.number().finite().min(0.1).max(4), endedAfterStoppedSeconds: z.number().finite().min(0).max(3),
      sampleCount: z.number().int().min(1).max(362) }).strict()).min(2).max(64) }).strict()).max(64),
  calibrationProfileId: identifier.nullable(), measuredAnimationLengthSeconds: z.number().finite().positive().max(30).nullable(),
  limitation: z.string().min(1).max(1024) }).strict();
const animationGraphEndedTimingLegacyStateSchema = z.object({ stateId: id, fadeSeconds: z.number().finite().min(0).max(3),
  source: z.enum(['default_zero', 'caller_supplied', 'studio_calibrated', 'ambiguous_profile_default_zero', 'studio_length_mismatch_default_zero']),
  calibrationProfileId: identifier.nullable(), measuredAnimationLengthSeconds: z.number().finite().min(0).max(30).nullable(),
  animationLengthMatchesRecipe: z.boolean().nullable(), animationLengthSeconds: z.number().finite().min(0).max(30).optional(),
  animationLengthSource: z.enum(['authored_recipe', 'studio_measured']).optional(), animationEndAfterSeconds: z.number().finite().min(0).max(30).optional(),
}).passthrough();
const animationGraphEndedTimingLegacySchema = z.object({ kind: z.literal('assumed_natural_completion_fade'),
  assumedAdditionalFadeSeconds: z.number().finite().min(0).max(3),
  source: z.enum(['default_zero', 'caller_supplied', 'studio_calibrated', 'ambiguous_profile_default_zero', 'studio_length_mismatch_default_zero']).optional(),
  stateTimings: z.array(animationGraphEndedTimingLegacyStateSchema).max(64).optional(),
  calibrationProfileId: identifier.nullable().optional(), measuredAnimationLengthSeconds: z.number().finite().min(0).max(30).nullable().optional(),
  limitation: z.string().min(1).max(1024) }).passthrough();
/** Legacy reports remain readable without rewriting their fingerprinted historical contents. */
export const animationGraphEndedTimingSchema = z.union([animationGraphEndedTimingCurrentSchema, animationGraphEndedTimingLegacySchema]);
export const animationGraphPlaybackRetriggerModelSchema = z.object({
  measuredPreservedClockTransitions: z.number().int().min(0).max(MAX_PROCESSED_EVENTS),
  measuredResetClockTransitions: z.number().int().min(0).max(MAX_PROCESSED_EVENTS),
  ambiguousProbeAssumedResetTransitions: z.number().int().min(0).max(MAX_PROCESSED_EVENTS),
  unmeasuredAssumedResetTransitions: z.number().int().min(0).max(MAX_PROCESSED_EVENTS),
  limitation: z.string().min(1).max(1024),
}).strict();

type ScheduledEvent = { at: number; order: number; generation: number; kind: 'marker' | 'animation_end' | 'animation_natural_stop' | 'external' | 'parameter_ramp_sample'; marker?: string; stateId?: string; blendSourceStateId?: string; source: 'runtime' | 'user'; inputIndex?: number; trigger?: string; setParameters?: Record<string, boolean | number | string>; expectTransitionId?: string; rampProgress?: number };
type FadeCurvePoint = { progress: number; weight: number };
type FadeEnvelope = { from: number; to: number; start: number; end: number; curve?: FadeCurvePoint[];
  calibrationProfileId?: string; calibrationDirection?: 'playIn' | 'stopOut' | 'adjustWeightIn' | 'adjustWeightOut' | 'naturalCompletion' };
type TrackEpoch = { generation: number; startedAt: number; speed: number; loop: boolean; duration: number; fades: FadeEnvelope[];
  initialPhase?: number; stopAt: number | null; endedAt: number | null; endReason: 'transition' | 'natural_completion' | 'restarted' | null };
type SimulatedTrack = { stateId: string; epochs: TrackEpoch[] };
type Quaternion = Quaternion4;

function latestStartedAtOrBefore<T>(items: readonly T[], at: number, startTime: (item: T) => number): T | undefined {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (startTime(items[middle]!) <= at) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? undefined : items[low - 1];
}

function appendInTimelineOrder<T>(items: T[], item: T, startTime: (item: T) => number, collectionName: string): void {
  const previous = items.at(-1);
  if (previous && startTime(item) < startTime(previous)) {
    throw new Error(`Internal timeline invariant failed: ${collectionName} must be appended in nondecreasing start-time order.`);
  }
  items.push(item);
}

const animationPriorityRank: Record<NonNullable<ReturnType<typeof animationSchema.parse>['priority']>, number> = {
  Core: 0, Idle: 1, Movement: 2, Action: 3, Action2: 4, Action3: 5, Action4: 6,
};

function epochAt(track: SimulatedTrack, at: number): TrackEpoch | undefined {
  return latestStartedAtOrBefore(track.epochs, at, epoch => epoch.startedAt);
}

function epochElapsedAt(epoch: TrackEpoch, at: number): number {
  return (epoch.initialPhase ?? 0) * epoch.duration + Math.max(0, at - epoch.startedAt) * epoch.speed;
}

function epochIsPlayingAt(epoch: TrackEpoch, at: number): boolean {
  if (epoch.stopAt !== null && at >= epoch.stopAt) return false;
  return epoch.loop || epochElapsedAt(epoch, at) < epoch.duration;
}

function sampledOutputsDifferAtCommonTimes<T extends { at: number }>(baseline: readonly T[], alternate: readonly T[]): boolean {
  const alternateByTime = new Map(alternate.map(sample => [sample.at, sample]));
  return baseline.some(sample => {
    const alternateSample = alternateByTime.get(sample.at);
    return alternateSample !== undefined && stableSerialize(sample) !== stableSerialize(alternateSample);
  });
}

function sampleTimeCoverage<T extends { at: number }>(baseline: readonly T[], alternate: readonly T[]) {
  const baselineTimes = new Set(baseline.map(sample => sample.at));
  const alternateTimes = new Set(alternate.map(sample => sample.at));
  let compared = 0;
  for (const at of baselineTimes) if (alternateTimes.has(at)) compared++;
  return { compared, baselineOnly: baselineTimes.size - compared, alternateOnly: alternateTimes.size - compared };
}

function trackWeightEvaluationAt(track: SimulatedTrack, at: number): { weight: number; calibrationWeightClamped: boolean } {
  const epoch = epochAt(track, at);
  if (!epoch) return { weight: 0, calibrationWeightClamped: false };
  const fade = fadeAt(epoch, at);
  if (!fade) return { weight: 0, calibrationWeightClamped: false };
  if (fade.end <= fade.start || at >= fade.end) return { weight: fade.to, calibrationWeightClamped: false };
  const alpha = (at - fade.start) / (fade.end - fade.start);
  if (fade.curve) {
    const first = fade.curve[0]!;
    const last = fade.curve.at(-1)!;
    const curveWeight = (progress: number) => {
      if (progress <= first.progress) return first.weight;
      if (progress >= last.progress) return last.weight;
      let leftIndex = 0;
      let rightIndex = fade.curve!.length - 1;
      while (rightIndex - leftIndex > 1) {
        const middleIndex = leftIndex + Math.floor((rightIndex - leftIndex) / 2);
        if (fade.curve![middleIndex]!.progress < progress) leftIndex = middleIndex;
        else rightIndex = middleIndex;
      }
      const left = fade.curve![leftIndex]!;
      const right = fade.curve![rightIndex]!;
      const span = right.progress - left.progress;
      const curveAlpha = span <= 0 ? 1 : (progress - left.progress) / span;
      return left.weight + (right.weight - left.weight) * curveAlpha;
    };
    const raw = curveWeight(alpha);
    const curveSpan = last.weight - first.weight;
    if (Math.abs(curveSpan) > 1e-9) {
      const rebasedWeight = fade.from + (fade.to - fade.from) * ((raw - first.weight) / curveSpan);
      const weight = Math.max(0, Math.min(1, rebasedWeight));
      return { weight, calibrationWeightClamped: weight !== rebasedWeight };
    }
  }
  return { weight: fade.from + (fade.to - fade.from) * alpha, calibrationWeightClamped: false };
}

function trackWeightAt(track: SimulatedTrack, at: number): number {
  return trackWeightEvaluationAt(track, at).weight;
}

function fadeAt(epoch: TrackEpoch, at: number): FadeEnvelope | undefined {
  return latestStartedAtOrBefore(epoch.fades, at, fade => fade.start);
}

function trackSnapshot(track: SimulatedTrack, at: number, currentState: string) {
  const epoch = epochAt(track, at);
  if (!epoch) return { stateId: track.stateId, weight: 0, targetWeight: 0, fadeRemainingSeconds: 0,
    playbackTimeSeconds: 0, isCurrentState: track.stateId === currentState, isPlaying: false, isAffectingPose: false };
  const weightEvaluation = trackWeightEvaluationAt(track, at);
  const weight = weightEvaluation.weight;
  const fade = fadeAt(epoch, at);
  const elapsed = epochElapsedAt(epoch, at);
  const playbackTimeSeconds = epoch.loop ? elapsed % epoch.duration : Math.min(epoch.duration, elapsed);
  const stillPlaying = epochIsPlayingAt(epoch, at);
  return { stateId: track.stateId, weight, targetWeight: fade?.to ?? 0,
    fadeRemainingSeconds: Math.max(0, (fade?.end ?? at) - at), playbackTimeSeconds,
    isCurrentState: track.stateId === currentState, isPlaying: stillPlaying, isAffectingPose: weight > 0,
    ...(fade?.calibrationProfileId ? { fadeCalibrationProfileId: fade.calibrationProfileId,
      fadeCalibrationDirection: fade.calibrationDirection,
      fadeCalibrationRebased: Math.abs(fade.from - (fade.calibrationDirection === 'playIn' || fade.calibrationDirection === 'adjustWeightIn'
        ? 0 : fade.calibrationDirection === 'stopOut' || fade.calibrationDirection === 'adjustWeightOut' ? 1 : fade.curve?.[0]?.weight ?? 1)) > 1e-9
        || Math.abs(fade.to - (fade.calibrationDirection === 'playIn' || fade.calibrationDirection === 'adjustWeightIn' ? 1 : 0)) > 1e-9,
      fadeCalibrationWeightClamped: weightEvaluation.calibrationWeightClamped } : {}) };
}

function setTrackWeight(track: SimulatedTrack, at: number, to: number, duration: number,
  endReason: TrackEpoch['endReason'] = null, calibration?: { curve: FadeCurvePoint[]; profileId: string;
    direction: 'playIn' | 'stopOut' | 'adjustWeightIn' | 'adjustWeightOut' | 'naturalCompletion' },
  stopPlayback = true): void {
  const epoch = epochAt(track, at);
  if (!epoch) return;
  appendInTimelineOrder(epoch.fades, { from: trackWeightAt(track, at), to, start: at, end: at + duration,
    ...(calibration ? { curve: calibration.curve, calibrationProfileId: calibration.profileId, calibrationDirection: calibration.direction } : {}) },
  fade => fade.start, 'fade envelopes');
  if (to === 0) {
    if (stopPlayback) {
      const stopAt = at;
      const alreadyEndingAtSameTime = epoch.stopAt === stopAt && epoch.endReason !== null;
      epoch.stopAt = stopAt;
      epoch.endedAt = stopAt;
      if (!alreadyEndingAtSameTime) epoch.endReason = endReason;
    } else {
      epoch.stopAt = null;
      epoch.endedAt = null;
      epoch.endReason = null;
    }
  } else {
    epoch.stopAt = null;
    epoch.endedAt = null;
    epoch.endReason = null;
  }
}

function eventComesBefore(left: ScheduledEvent, right: ScheduledEvent, policy: 'user_inputs_first' | 'runtime_callbacks_first'): boolean {
  if (left.at !== right.at) return left.at < right.at;
  const leftRank = left.source === 'user' ? (policy === 'user_inputs_first' ? 0 : 1) : (policy === 'runtime_callbacks_first' ? 0 : 1);
  const rightRank = right.source === 'user' ? (policy === 'user_inputs_first' ? 0 : 1) : (policy === 'runtime_callbacks_first' ? 0 : 1);
  if (leftRank !== rightRank) return leftRank < rightRank;
  if (left.source === 'user' && right.source === 'user' && left.inputIndex !== undefined && right.inputIndex !== undefined
    && left.inputIndex !== right.inputIndex) return left.inputIndex < right.inputIndex;
  return left.order < right.order;
}

function pushEvent(queue: ScheduledEvent[], event: ScheduledEvent, policy: 'user_inputs_first' | 'runtime_callbacks_first'): void {
  let index = queue.length;
  queue.push(event);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const previous = queue[parent]!;
    if (!eventComesBefore(event, previous, policy)) break;
    queue[index] = previous;
    index = parent;
  }
  queue[index] = event;
}

function popEvent(queue: ScheduledEvent[], policy: 'user_inputs_first' | 'runtime_callbacks_first'): ScheduledEvent | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (!first || !last || queue.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= queue.length) break;
    const child = right < queue.length && eventComesBefore(queue[right]!, queue[left]!, policy) ? right : left;
    if (!eventComesBefore(queue[child]!, last, policy)) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = last;
  return first;
}

/** Deterministic estimate of graph playback using authored recipe duration/speed; does not run Roblox AnimationTracks. */
function simulateAnimationGraphTimelineOnce(graphInput: unknown, recipesByAnimationIdInput: unknown, inputValue: unknown,
  eventOrderPolicy: 'user_inputs_first' | 'runtime_callbacks_first', fadeProfilesInput: unknown = []) {
  const graph = animationGraphSchema.parse(graphInput);
  const input = animationGraphSimulationInputSchema.parse(inputValue);
  const sampleRateHz = input.sampleRateHz ?? graph.sampleRate;
  const parameterRampSamples = countParameterRampSamples(input, graph.sampleRate);
  if (parameterRampSamples > MAX_PARAMETER_RAMP_SAMPLES) {
    throw new Error(`Parameter ramps exceed the ${MAX_PARAMETER_RAMP_SAMPLES} generated-sample safety limit at graph rate ${graph.sampleRate} Hz; reduce ramp duration or ramp count.`);
  }
  const recipeMap = z.record(identifier, animationSchema).parse(recipesByAnimationIdInput);
  const fadeProfiles = z.array(resolvedFadeCalibrationSchema).max(64).parse(fadeProfilesInput);
  const stateById = new Map(graph.states.map(state => [state.id, state]));
  if (new Set(input.unavailableStateIds).size !== input.unavailableStateIds.length) throw new Error('unavailableStateIds must not contain duplicates.');
  for (const unavailableStateId of input.unavailableStateIds) {
    if (!stateById.has(unavailableStateId)) throw new Error(`Unknown unavailableStateIds entry ${unavailableStateId}; choose a state from the saved graph.`);
    if (unavailableStateId === graph.entryState) throw new Error('The graph entry state cannot be unavailable because simulation requires its initial track to load.');
  }
  const unavailableStateIds = new Set(input.unavailableStateIds);
  const observedBlendLengthsByController = new Map<string, Map<string, number>>();
  const observedBlendSpeedsByController = new Map<string, Map<string, number>>();
  const observedBlendStartPhasesByController = new Map<string, Map<string, number>>();
  for (const [controllerId, inputLengths] of Object.entries(input.observedBlendAnimationLengths)) {
    const controller = stateById.get(controllerId);
    if (!controller) throw new Error(`observedBlendAnimationLengths contains unknown graph controller ${controllerId}.`);
    if (!isBlendController(controller)) throw new Error(`observedBlendAnimationLengths state ${controllerId} is not a BlendSpace controller.`);
    const sourceIds = blendSources(controller).map(sample => sample.stateId);
    const unknownSourceIds = Object.keys(inputLengths).filter(stateId => !sourceIds.includes(stateId));
    const missingSourceIds = sourceIds.filter(stateId => inputLengths[stateId] === undefined);
    if (unknownSourceIds.length > 0) {
      throw new Error(`observedBlendAnimationLengths controller ${controller.id} contains non-sample state IDs: ${unknownSourceIds.join(', ')}.`);
    }
    if (missingSourceIds.length > 0) {
      throw new Error(`observedBlendAnimationLengths must include every sample of BlendSpace controller ${controller.id}; missing ${missingSourceIds.join(', ')}.`);
    }
    observedBlendLengthsByController.set(controller.id, new Map(sourceIds.map(stateId => [stateId, inputLengths[stateId]!])));
    const inputSpeeds = input.observedBlendAnimationPlaybackSpeeds[controllerId];
    if (!inputSpeeds) throw new Error(`observedBlendAnimationPlaybackSpeeds is missing controller ${controllerId}.`);
    const unknownSpeedIds = Object.keys(inputSpeeds).filter(stateId => !sourceIds.includes(stateId));
    const missingSpeedIds = sourceIds.filter(stateId => inputSpeeds[stateId] === undefined);
    if (unknownSpeedIds.length > 0 || missingSpeedIds.length > 0) {
      throw new Error(`observedBlendAnimationPlaybackSpeeds for ${controller.id} must match every sample exactly; unknown: ${unknownSpeedIds.join(', ') || 'none'}, missing: ${missingSpeedIds.join(', ') || 'none'}.`);
    }
    observedBlendSpeedsByController.set(controller.id, new Map(sourceIds.map(stateId => [stateId, inputSpeeds[stateId]!])));
  }
  for (const [controllerId, inputPhases] of Object.entries(input.observedBlendAnimationStartPhases)) {
    const controller = stateById.get(controllerId);
    if (!controller || !isBlendController(controller)) throw new Error(`observedBlendAnimationStartPhases contains unknown or non-BlendSpace controller ${controllerId}.`);
    const sourceIds = blendSources(controller).map(sample => sample.stateId);
    const unknownSourceIds = Object.keys(inputPhases).filter(stateId => !sourceIds.includes(stateId));
    const missingSourceIds = sourceIds.filter(stateId => inputPhases[stateId] === undefined);
    if (unknownSourceIds.length > 0 || missingSourceIds.length > 0) {
      throw new Error(`observedBlendAnimationStartPhases for ${controller.id} must include every sample exactly; unknown: ${unknownSourceIds.join(', ') || 'none'}, missing: ${missingSourceIds.join(', ') || 'none'}.`);
    }
    if (!observedBlendLengthsByController.has(controllerId) || !observedBlendSpeedsByController.has(controllerId)) {
      throw new Error(`observedBlendAnimationStartPhases for ${controller.id} requires matching measured lengths and speeds.`);
    }
    observedBlendStartPhasesByController.set(controller.id, new Map(sourceIds.map(stateId => [stateId, inputPhases[stateId]!])));
  }
  if (input.observedBlendAnimationAssetSetFingerprint !== undefined
    && input.observedBlendAnimationAssetSetFingerprint !== input.expectedBlendAnimationAssetSetFingerprint) {
    throw new Error('Observed live BlendSpace lengths belong to a different graph/published animation asset set than this simulation. Re-export the intended graph and recapture GetBlendState().');
  }
  const recipeByState = new Map(graph.states.map(state => {
    const recipe = recipeMap[state.animationId];
    if (!recipe) throw new Error(`Missing source animation recipe for graph state ${state.id}.`);
    return [state.id, recipe] as const;
  }));
  const normalizedMarkerSignature = (recipe: z.infer<typeof animationSchema>) => recipe.markers
    .map(marker => ({ name: marker.name, value: marker.value ?? '', phase: marker.time / recipe.duration }))
    .sort((left, right) => left.phase - right.phase || left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
  for (const controller of graph.states.filter(isBlendController)) {
    const sourceIds = blendSources(controller).map(sample => sample.stateId);
    const controllerRecipe = recipeByState.get(controller.id)!;
    const expectedPriority = controllerRecipe.priority ?? 'Core';
    const expectedLoop = controllerRecipe.loop;
    const expectedMarkers = normalizedMarkerSignature(controllerRecipe);
    for (const sourceId of sourceIds) {
      const sourceRecipe = recipeByState.get(sourceId)!;
      if ((sourceRecipe.priority ?? 'Core') !== expectedPriority) {
        throw new Error(`BlendSpace ${controller.id} source ${sourceId} has a different animation priority; all clips, including the controller recipe, must match.`);
      }
      if (sourceRecipe.loop !== expectedLoop) {
        throw new Error(`BlendSpace ${controller.id} source ${sourceId} has a different loop setting; all clips, including the controller recipe, must match.`);
      }
      const sourceMarkers = normalizedMarkerSignature(sourceRecipe);
      if (sourceMarkers.length !== expectedMarkers.length || sourceMarkers.some((marker, index) =>
        marker.name !== expectedMarkers[index]!.name || marker.value !== expectedMarkers[index]!.value
        || Math.abs(marker.phase - expectedMarkers[index]!.phase) > 1e-6)) {
        throw new Error(`BlendSpace ${controller.id} source ${sourceId} has a different normalized marker layout; marker-trigger behavior must stay consistent across the blend.`);
      }
    }
  }
  const fadeProfileByKey = new Map<string, z.infer<typeof resolvedFadeCalibrationSchema>>();
  for (const profile of fadeProfiles) {
    const recipe = recipeByState.get(profile.stateId);
    if (!recipe || fingerprint(recipe) !== profile.recipeFingerprint) throw new Error(`Fade calibration ${profile.id} does not match the current graph state's animation recipe.`);
    const graphState = stateById.get(profile.stateId)!;
    if (profile.naturalCompletion && (profile.naturalCompletion.authoredDurationSeconds !== recipe.duration
      || profile.naturalCompletion.playbackSpeed !== graphState.speed)) {
      throw new Error(`Fade calibration ${profile.id} natural-completion evidence does not match the current graph state duration or speed.`);
    }
    const key = `${profile.stateId}:${profile.fadeSeconds}`;
    if (fadeProfileByKey.has(key)) throw new Error(`Multiple fade calibrations were supplied for state ${profile.stateId} at ${profile.fadeSeconds} seconds.`);
    fadeProfileByKey.set(key, profile);
  }
  const naturalCompletionCandidatesByState = new Map<string, Array<z.infer<typeof resolvedFadeCalibrationSchema>>>();
  for (const profile of fadeProfiles) if (profile.naturalCompletion) {
    const candidates = naturalCompletionCandidatesByState.get(profile.stateId) ?? [];
    candidates.push(profile);
    naturalCompletionCandidatesByState.set(profile.stateId, candidates);
  }
  const naturalCompletionProfileByState = new Map<string, z.infer<typeof resolvedFadeCalibrationSchema>>();
  const ambiguousNaturalCompletionStateIds: string[] = [];
  const naturalCompletionConflictByState = new Map<string, { conflictingFields: Array<'authoredDurationSeconds' | 'animationLengthSeconds' | 'playbackSpeed' | 'endedAfterStoppedSeconds' | 'samples'>;
    candidates: Array<{ profileId: string; profileFingerprint: string; measurementFingerprint: string; animationLengthSeconds: number;
      playbackSpeed: number; endedAfterStoppedSeconds: number; sampleCount: number }> }>();
  for (const [stateId, candidates] of naturalCompletionCandidatesByState) {
    const measurements = new Set(candidates.map(profile => stableSerialize(profile.naturalCompletion)));
    if (measurements.size === 1) naturalCompletionProfileByState.set(stateId,
      candidates.sort((left, right) => left.id.localeCompare(right.id))[0]!);
    else {
      ambiguousNaturalCompletionStateIds.push(stateId);
      const fields = (['authoredDurationSeconds', 'animationLengthSeconds', 'playbackSpeed', 'endedAfterStoppedSeconds', 'samples'] as const)
        .filter(field => new Set(candidates.map(profile => stableSerialize(profile.naturalCompletion![field]))).size > 1);
      naturalCompletionConflictByState.set(stateId, { conflictingFields: [...fields], candidates: candidates
        .map(profile => ({ profileId: profile.id, profileFingerprint: profile.profileFingerprint,
          measurementFingerprint: createHash('sha256').update(stableSerialize(profile.naturalCompletion)).digest('hex'),
          animationLengthSeconds: profile.naturalCompletion!.animationLengthSeconds,
          playbackSpeed: profile.naturalCompletion!.playbackSpeed, endedAfterStoppedSeconds: profile.naturalCompletion!.endedAfterStoppedSeconds,
          sampleCount: profile.naturalCompletion!.samples.length })).sort((left, right) => left.profileId.localeCompare(right.profileId)) });
    }
  }
  const naturalCompletionForState = (stateId: string) => {
    const profile = naturalCompletionProfileByState.get(stateId);
    const measurement = profile?.naturalCompletion;
    const recipe = recipeByState.get(stateId)!;
    if (input.naturalCompletionFadeSeconds !== undefined) {
      const matchesLength = measurement !== undefined && Math.abs(measurement.animationLengthSeconds - recipe.duration)
        <= Math.max(1 / (profile?.sampleRateHz ?? 60), 0.01);
      return { fadeSeconds: input.naturalCompletionFadeSeconds, source: 'caller_supplied' as const,
        profile, animationLengthMatchesRecipe: measurement ? matchesLength : null };
    }
    if (profile && measurement) {
      const matches = Math.abs(measurement.animationLengthSeconds - recipe.duration) <= Math.max(1 / (profile.sampleRateHz ?? 60), 0.01);
      if (matches) return { fadeSeconds: measurement.endedAfterStoppedSeconds, source: 'studio_calibrated' as const,
        profile, animationLengthMatchesRecipe: true };
      return { fadeSeconds: 0, source: 'studio_length_mismatch_default_zero' as const,
        profile, animationLengthMatchesRecipe: false };
    }
    return { fadeSeconds: 0, source: ambiguousNaturalCompletionStateIds.includes(stateId)
      ? 'ambiguous_profile_default_zero' as const : 'default_zero' as const, profile: undefined, animationLengthMatchesRecipe: null };
  };
  const naturalCompletionForPlayback = (stateId: string, playbackLengthSeconds: number) => {
    const timing = naturalCompletionForState(stateId);
    const measurement = timing.profile?.naturalCompletion;
    if (!measurement || Math.abs(measurement.animationLengthSeconds - playbackLengthSeconds)
      <= Math.max(1 / (timing.profile?.sampleRateHz ?? 60), 0.01)) return timing;
    if (input.naturalCompletionFadeSeconds !== undefined) return { ...timing, animationLengthMatchesRecipe: false };
    return { ...timing, fadeSeconds: 0, source: 'studio_length_mismatch_default_zero' as const, animationLengthMatchesRecipe: false };
  };
  const naturalCompletionCurveFor = (stateId: string, fadeSeconds: number, playbackLengthSeconds: number) => {
    if (fadeSeconds <= 0) return undefined;
    const timing = naturalCompletionForPlayback(stateId, playbackLengthSeconds);
    const measurement = timing.profile?.naturalCompletion;
    if (!timing.profile || timing.animationLengthMatchesRecipe !== true || !measurement || measurement.endedAfterStoppedSeconds <= 0) return undefined;
    usedFadeProfiles.add(timing.profile.id);
    return { curve: measurement.samples.map(sample => ({ progress: sample.at / measurement.endedAfterStoppedSeconds, weight: sample.weightCurrent })),
      profileId: timing.profile.id, direction: 'naturalCompletion' as const };
  };
  const entryNaturalTiming = naturalCompletionForState(graph.entryState);
  const entryRecipe = recipeByState.get(graph.entryState)!;
  const summaryTiming = input.naturalCompletionFadeSeconds !== undefined
    ? { ...entryNaturalTiming, profile: entryRecipe.loop ? undefined : entryNaturalTiming.profile }
    : entryRecipe.loop
      ? { fadeSeconds: 0, source: 'default_zero' as const, profile: undefined, animationLengthMatchesRecipe: null }
      : entryNaturalTiming;
  const naturalCompletionFadeSeconds = summaryTiming.fadeSeconds;
  const usedFadeProfiles = new Set<string>();
  const playbackRetriggerCounts = { measuredPreserved: 0, measuredReset: 0, ambiguousProbeAssumedReset: 0, unmeasuredAssumedReset: 0 };
  const fadeCurveFor = (stateId: string, duration: number, direction: 'playIn' | 'stopOut'):
    { curve: FadeCurvePoint[]; profileId: string; direction: 'playIn' | 'stopOut' } | undefined => {
    if (duration <= 0) return undefined;
    const profile = fadeProfileByKey.get(`${stateId}:${duration}`);
    if (!profile) return undefined;
    usedFadeProfiles.add(profile.id);
    return { curve: profile[direction].map(sample => ({ progress: sample.at / duration, weight: sample.weightCurrent })),
      profileId: profile.id, direction };
  };
  const adjustWeightCurveFor = (stateId: string, duration: number, direction: 'adjustWeightIn' | 'adjustWeightOut'):
    { curve: FadeCurvePoint[]; profileId: string; direction: 'adjustWeightIn' | 'adjustWeightOut' } | undefined => {
    if (duration <= 0) return undefined;
    const profile = fadeProfileByKey.get(`${stateId}:${duration}`);
    const curve = profile?.[direction];
    if (!profile || !curve) return undefined;
    usedFadeProfiles.add(profile.id);
    return { curve: curve.map(sample => ({ progress: sample.at / duration, weight: sample.weightCurrent })),
      profileId: profile.id, direction };
  };
  for (const animationId of Object.keys(recipeMap)) if (!graph.states.some(state => state.animationId === animationId)) throw new Error(`Unexpected source animation recipe ${animationId}.`);
  const contributesJoint = (recipe: z.infer<typeof animationSchema>, joint: string) => recipe.tracks.some(track => track.joint === joint)
    || (recipe.layers ?? []).some(layer => layer.enabled && layer.weight > 0 && layer.tracks.some(track => track.joint === joint))
    || recipe.rootMotion?.joint === joint;
  const availablePoseJoints = [...new Set(Object.values(recipeMap).flatMap(recipe => [
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ]))].sort((left, right) => left.localeCompare(right));
  if (new Set(input.poseJoints).size !== input.poseJoints.length) throw new Error('poseJoints must not contain duplicate joint names.');
  for (const joint of input.poseJoints) if (!availablePoseJoints.includes(joint)) throw new Error(`Unknown poseJoints entry ${joint}; choose an animated joint from a referenced animation recipe.`);
  const poseJoints = input.includePoseSamples ? input.poseJoints.length ? input.poseJoints : availablePoseJoints : [];
  const requestedPoseTimes = input.includePoseSamples ? [...new Set(input.sampleTimes)].sort((left, right) => left - right) : [];
  if (requestedPoseTimes.length * poseJoints.length > MAX_COMPOSED_POSE_JOINT_SAMPLES) {
    throw new Error(`Composed pose sampling would evaluate ${requestedPoseTimes.length * poseJoints.length} joint-time pairs, above the ${MAX_COMPOSED_POSE_JOINT_SAMPLES} safety limit. Request fewer sampleTimes or select fewer poseJoints.`);
  }
  const jointSamplersByState = new Map(graph.states.map(state => {
    const recipe = recipeByState.get(state.id)!;
    return [state.id, new Map(poseJoints.filter(joint => contributesJoint(recipe, joint)).map(joint => [joint, createComposedJointEvaluationSampler(recipe, joint)!]))] as const;
  }));

  let parameters = normalizeAnimationGraphParameters(graph, input.initialParameters);
  let state = graph.entryState;
  let playbackSpeedMultiplier = 1;
  let generation = 0;
  let nextOrder = 0;
  const tracks = new Map<string, SimulatedTrack>();
  const blendSourceTracks = new Map<string, SimulatedTrack>();
  const blendChannelKey = (controllerStateId: string, sourceStateId: string) => `${controllerStateId}\u0000${sourceStateId}`;
  const sampleTimes = new Set<number>();
  const sampleTimeBuckets = new Map<number, number[]>();
  const sampleTimeBucket = (at: number) => Math.round(at * 1e12);
  const floatingTimeTolerance = (left: number, right: number) =>
    Number.EPSILON * Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE) * 2;
  const addSampleTime = (at: number) => {
    // Fade endpoints beyond the requested horizon are not observable samples and must not consume its budget.
    if (at < 0 || at > input.duration) return;
    const previousSize = sampleTimes.size;
    sampleTimes.add(at);
    if (sampleTimes.size !== previousSize) {
      const bucket = sampleTimeBucket(at);
      const values = sampleTimeBuckets.get(bucket) ?? [];
      values.push(at);
      sampleTimeBuckets.set(bucket, values);
    }
    if (sampleTimes.size > MAX_BLEND_SAMPLES) {
      throw new Error(`Blend simulation exceeded the ${MAX_BLEND_SAMPLES}-sample safety limit while adding timeline timestamps.`);
    }
  };
  const nearbySampleTime = (at: number) => {
    const bucket = sampleTimeBucket(at);
    let closest: number | undefined;
    let closestDistance = Infinity;
    for (let neighbor = bucket - 1; neighbor <= bucket + 1; neighbor++) {
      for (const sampleAt of sampleTimeBuckets.get(neighbor) ?? []) {
        const distance = Math.abs(sampleAt - at);
        if (distance <= floatingTimeTolerance(sampleAt, at) && (closest === undefined || distance < closestDistance
          || (distance === closestDistance && sampleAt < closest))) {
          closest = sampleAt;
          closestDistance = distance;
        }
      }
    }
    return closest;
  };
  const addMergedSampleTime = (at: number) => {
    if (at < 0 || at > input.duration) return;
    if (nearbySampleTime(at) === undefined) addSampleTime(at);
  };
  addSampleTime(0);
  addSampleTime(input.duration);
  for (const at of input.sampleTimes) addSampleTime(at);
  const frameCount = Math.ceil(input.duration * sampleRateHz);
  for (let frame = 1; frame <= frameCount; frame++) addMergedSampleTime(Math.min(input.duration, frame / sampleRateHz));
  const canonicalSimulationTime = (at: number) => {
    if (at > input.duration || at === input.duration) return at;
    const rounded = Math.min(input.duration, Number(at.toFixed(12)));
    if (Math.abs(rounded - at) > floatingTimeTolerance(rounded, at)) return at;
    return nearbySampleTime(rounded) ?? rounded;
  };
  const addEventSampleTime = (at: number) => {
    if (at < 0 || at > input.duration) return;
    const canonical = canonicalSimulationTime(at);
    if (nearbySampleTime(canonical) === undefined) addSampleTime(canonical);
  };
  const queue: ScheduledEvent[] = [];
  const scheduledEventLedger = new Map<number, ScheduledEvent[]>();
  const userFirstRuntimeCallbacksByTime = new Map<number, Set<ScheduledEvent>>();
  let scheduledEvents = 0;
  const recordScheduledEvent = (event: ScheduledEvent) => {
    const eventsAtTime = scheduledEventLedger.get(event.at) ?? [];
    eventsAtTime.push(event);
    scheduledEventLedger.set(event.at, eventsAtTime);
  };
  for (const [inputIndex, event] of input.events.entries()) {
    const scheduled = { ...event, at: canonicalSimulationTime(event.at), kind: 'external' as const,
      source: 'user' as const, inputIndex, generation: -1, order: nextOrder++ };
    recordScheduledEvent(scheduled);
    pushEvent(queue, scheduled, eventOrderPolicy);
    if (event.kind === 'ramp_parameters') {
      const rampEnd = Math.min(event.at + event.duration, input.duration);
      if (rampEnd > event.at) {
        const rampSampleTimes = new Set<number>();
        const firstFrame = Math.floor(event.at * graph.sampleRate) + 1;
        for (let frame = firstFrame; frame / graph.sampleRate < rampEnd - 1e-12; frame++) {
          rampSampleTimes.add(frame / graph.sampleRate);
        }
        rampSampleTimes.add(rampEnd);
        for (const at of rampSampleTimes) {
          scheduledEvents++;
          if (scheduledEvents > MAX_PROCESSED_EVENTS) {
            throw new Error(`Timeline simulation exceeded ${MAX_PROCESSED_EVENTS} scheduled events.`);
          }
          const rampSample = { at: canonicalSimulationTime(at), order: nextOrder++, generation: -1, kind: 'parameter_ramp_sample' as const,
            source: 'user' as const, inputIndex, rampProgress: Math.min((at - event.at) / event.duration, 1) };
          recordScheduledEvent(rampSample);
          pushEvent(queue, rampSample, eventOrderPolicy);
        }
      }
    }
  }
  const timeline: Array<Record<string, unknown>> = [];
  const triggeredMarkers: Array<{ at: number; stateId: string; marker: string; value: string }> = [];
  const activeParameterRamps = new Map<number, { duration: number; easing: 'linear' | 'smoothstep';
    startValues: Record<string, number>; targetValues: Record<string, number>; activeNames: Set<string> }>();
  const parameterRampLifecycle = new Map<number, { startedAt: number; duration: number; easing: 'linear' | 'smoothstep';
    channels: Map<string, { startValue: number; targetValue: number; status: 'active' | 'completed' | 'interrupted';
      endedAt: number | null; observedValue: number | null }> }>();
  const interruptRampChannels = (rampId: number, ramp: { activeNames: Set<string> }, names: Iterable<string>, at: number) => {
    const lifecycle = parameterRampLifecycle.get(rampId);
    if (!lifecycle) return;
    for (const name of names) {
      if (!ramp.activeNames.has(name)) continue;
      const channel = lifecycle.channels.get(name);
      if (channel) Object.assign(channel, { status: 'interrupted' as const, endedAt: at, observedValue: parameters[name] as number });
      ramp.activeNames.delete(name);
    }
  };
  const cancelParameterRamps = (names: Iterable<string>, at: number) => {
    const interruptedNames = new Set(names);
    for (const [rampId, ramp] of activeParameterRamps) {
      interruptRampChannels(rampId, ramp, interruptedNames, at);
      if (ramp.activeNames.size === 0) activeParameterRamps.delete(rampId);
    }
  };
  const transitionIds: string[] = [];
  let processedEvents = 0;
  let guardDiagnosticBytes = 0;
  let detailedTriggerEvaluations = 0;
  let truncatedTriggerEvaluations = 0;

  const schedule = (event: ScheduledEvent) => {
    scheduledEvents++;
    if (scheduledEvents > MAX_PROCESSED_EVENTS) throw new Error(`Timeline simulation exceeded ${MAX_PROCESSED_EVENTS} scheduled events.`);
    const canonical = { ...event, at: canonicalSimulationTime(event.at) };
    recordScheduledEvent(canonical);
    pushEvent(queue, canonical, eventOrderPolicy);
  };

  const applyParameterUpdates = (at: number, inputIndex: number, values: Record<string, boolean | number | string>,
    ramp?: { progress: number; easing: 'linear' | 'smoothstep' }) => {
    const nextParameters = normalizeAnimationGraphParameters(graph, { ...parameters, ...values });
    const activeState = stateById.get(state)!;
    let blendAdjustment: ReturnType<typeof setBlendSourceTargets> | undefined;
    if (isBlendController(activeState)) {
      const controllerTrack = tracks.get(state);
      const controllerEpoch = controllerTrack?.epochs.at(-1);
      const currentFade = controllerEpoch ? fadeAt(controllerEpoch, at) : undefined;
      const fadeRemaining = currentFade ? Math.max(0, currentFade.end - at) : 0;
      blendAdjustment = setBlendSourceTargets(state, at, fadeRemaining, nextParameters, 'adjust');
    }
    if (blendAdjustment && !blendAdjustment.success) {
      timeline.push({ at, event: 'set_parameters', source: 'user', inputIndex,
        stateBefore: state, stateAfter: state, failureReason: blendAdjustment.reason,
        rejectedParameterUpdates: values, restartedStateIds: blendAdjustment.restartedStateIds,
        ...(ramp ? { rampProgress: ramp.progress, rampEasing: ramp.easing } : {}) });
      return false;
    }
    parameters = nextParameters;
    timeline.push({ at, event: 'set_parameters', source: 'user', inputIndex, stateBefore: state,
      stateAfter: state, updatedParameters: values,
      ...(blendAdjustment ? { restartedStateIds: blendAdjustment.restartedStateIds,
        phaseSourceStateId: blendAdjustment.phaseSourceStateId ?? null,
        phaseSourceNormalizedPhase: blendAdjustment.phaseSource?.phase ?? null,
        phaseSourceCurrentWeight: blendAdjustment.phaseSource?.currentWeight ?? null,
        phaseSourceTargetWeight: blendAdjustment.phaseSource?.targetWeight ?? null } : {}),
      ...(ramp ? { rampProgress: ramp.progress, rampEasing: ramp.easing } : {}) });
    return true;
  };

  const guardDiagnostic = (evaluation: ReturnType<typeof evaluateAnimationGraphTransition>) => {
    const details = { selectedTransition: evaluation.selectedTransition, matchedTransitionIds: evaluation.matchedTransitionIds,
      shadowedTransitionIds: evaluation.shadowedTransitionIds, rejectedBranches: evaluation.rejectedBranches };
    const bytes = Buffer.byteLength(JSON.stringify(details), 'utf8');
    if (guardDiagnosticBytes + bytes <= MAX_GUARD_DIAGNOSTIC_BYTES) {
      guardDiagnosticBytes += bytes;
      detailedTriggerEvaluations++;
      return { detailStatus: 'complete' as const, ...details };
    }
    truncatedTriggerEvaluations++;
    return { detailStatus: 'truncated_output_budget' as const, selectedTransitionId: evaluation.selectedTransition?.id ?? null,
      candidateCount: evaluation.matchedTransitionIds.length + evaluation.rejectedBranches.length,
      matchedTransitionCount: evaluation.matchedTransitionIds.length, shadowedTransitionCount: evaluation.shadowedTransitionIds.length,
      rejectedBranchCount: evaluation.rejectedBranches.length };
  };

  const scheduleEpochCallbacks = (stateId: string, start: number, initialPhase: number, duration: number,
    speed: number, eventGeneration: number, phaseRelative: boolean) => {
    const recipe = recipeByState.get(stateId)!;
    const naturalTiming = naturalCompletionForPlayback(stateId, duration);
    const playbackDuration = duration / speed;
    for (const marker of recipe.markers) {
      const markerPhase = marker.time / recipe.duration;
      const phaseDelta = markerPhase - initialPhase;
      const wrappedPhaseDelta = ((phaseDelta % 1) + 1) % 1;
      const phaseTolerance = floatingTimeTolerance(markerPhase, initialPhase);
      let first = phaseRelative
        ? (recipe.loop ? wrappedPhaseDelta : phaseDelta) * playbackDuration
        : duration === recipe.duration ? marker.time / speed : markerPhase * playbackDuration;
      if (phaseRelative && recipe.loop && wrappedPhaseDelta <= phaseTolerance) first = playbackDuration;
      if (phaseRelative && !recipe.loop && phaseDelta <= phaseTolerance) continue;
      let count = recipe.loop ? Math.floor(Math.max(0, input.duration - start - first) / playbackDuration) + 1 : 1;
      if (recipe.loop && start + (first + count * playbackDuration) <= input.duration) count++;
      for (let cycle = 0; cycle < count; cycle++) {
        const at = start + (first + cycle * playbackDuration);
        if (at <= input.duration) schedule({ at, order: nextOrder++, generation: eventGeneration,
          kind: 'marker', marker: marker.name, stateId, source: 'runtime' });
      }
    }
    if (!recipe.loop) {
      const clipEndAt = start + (duration - initialPhase * duration) / speed;
      if (naturalTiming.fadeSeconds > 0 && clipEndAt <= input.duration) {
        schedule({ at: clipEndAt, order: nextOrder++, generation: eventGeneration,
          kind: 'animation_natural_stop', stateId, source: 'runtime' });
      }
      const endedAt = clipEndAt + naturalTiming.fadeSeconds;
      if (endedAt <= input.duration) schedule({ at: endedAt, order: nextOrder++, generation: eventGeneration,
        kind: 'animation_end', trigger: 'AnimationEnded', stateId, source: 'runtime' });
    }
  };

  const schedulePlayback = (start: number, initialWeight = 0, blendSeconds = 0, stateToPlay = state, phaseOverride?: number) => {
    const currentState = stateById.get(stateToPlay)!;
    const recipe = recipeByState.get(stateToPlay)!;
    const naturalTiming = naturalCompletionForState(stateToPlay);
    const measuredAnimationLengthApplies = !recipe.loop && naturalTiming.profile?.naturalCompletion !== undefined;
    const observedControllerLengths = observedBlendLengthsByController.get(stateToPlay);
    const observedControllerSpeeds = observedBlendSpeedsByController.get(stateToPlay);
    const observedControllerPhases = start === 0 ? observedBlendStartPhasesByController.get(stateToPlay) : undefined;
    const observedAnimationLengthSeconds = observedControllerLengths?.get(stateToPlay);
    const observedPlaybackSpeed = observedControllerSpeeds?.get(stateToPlay);
    const initialPhase = phaseOverride ?? observedControllerPhases?.get(stateToPlay) ?? 0;
    const animationLengthSeconds = observedAnimationLengthSeconds
      ?? (measuredAnimationLengthApplies ? naturalTiming.profile!.naturalCompletion!.animationLengthSeconds : recipe.duration);
    const playbackSpeed = (observedPlaybackSpeed ?? currentState.speed) * playbackSpeedMultiplier;
    const playbackDuration = animationLengthSeconds / playbackSpeed;
    const track = tracks.get(stateToPlay) ?? { stateId: stateToPlay, epochs: [] };
    const previousEpoch = track.epochs.at(-1);
    const previousPlaybackStillRunning = previousEpoch !== undefined && epochIsPlayingAt(previousEpoch, start);
    const playProfile = fadeProfileByKey.get(`${stateToPlay}:${blendSeconds}`);
    const playRetriggerBehavior = previousPlaybackStillRunning ? playProfile?.playRetrigger?.observedClockBehavior : undefined;
    if (previousPlaybackStillRunning && playRetriggerBehavior === 'preserved') {
      playbackRetriggerCounts.measuredPreserved++;
      const playInCalibration = fadeCurveFor(stateToPlay, blendSeconds, 'playIn');
      setTrackWeight(track, start, 1, blendSeconds, null, playInCalibration);
      addEventSampleTime(start);
      if (blendSeconds > 0) addEventSampleTime(start + blendSeconds);
      return;
    }
    if (previousPlaybackStillRunning) {
      if (playRetriggerBehavior === 'reset_to_zero') playbackRetriggerCounts.measuredReset++;
      else if (playRetriggerBehavior === 'ambiguous') playbackRetriggerCounts.ambiguousProbeAssumedReset++;
      else playbackRetriggerCounts.unmeasuredAssumedReset++;
    }
    generation++;
    const currentGeneration = generation;
    if (previousPlaybackStillRunning) {
      previousEpoch.stopAt = start;
      previousEpoch.endedAt = start;
      previousEpoch.endReason = 'restarted';
    }
    const playInCalibration = fadeCurveFor(stateToPlay, blendSeconds, 'playIn');
    appendInTimelineOrder(track.epochs, { generation: currentGeneration, startedAt: start, speed: playbackSpeed, loop: recipe.loop, initialPhase,
      duration: animationLengthSeconds, fades: [{ from: initialWeight, to: 1, start, end: start + blendSeconds,
        ...(playInCalibration ? { curve: playInCalibration.curve, calibrationProfileId: playInCalibration.profileId,
          calibrationDirection: playInCalibration.direction } : {}) }], stopAt: null,
      endedAt: null, endReason: null }, epoch => epoch.startedAt, 'playback epochs');
    tracks.set(stateToPlay, track);
    addEventSampleTime(start);
    if (blendSeconds > 0) addEventSampleTime(start + blendSeconds);
    scheduleEpochCallbacks(stateToPlay, start, initialPhase, animationLengthSeconds, playbackSpeed,
      currentGeneration, phaseOverride !== undefined || observedControllerPhases !== undefined);
  };
  schedulePlayback(0, 1, 0);

  const setBlendSourceTargets = (controllerStateId: string, at: number, duration: number,
    targetParameters: Record<string, boolean | number | string>, mode: 'play' | 'adjust' | 'stop') => {
    const controller = stateById.get(controllerStateId)!;
    if (!isBlendController(controller)) return { success: true as const, restartedStateIds: [] as string[] };
    const targets = new Map(sampleGraphBlend(controller, targetParameters).weights.map(sample => [sample.stateId, sample.weight]));
    const observedLengths = observedBlendLengthsByController.get(controllerStateId);
    const observedSpeeds = observedBlendSpeedsByController.get(controllerStateId);
    const observedStartPhases = at === 0 ? observedBlendStartPhasesByController.get(controllerStateId) : undefined;
    const phaseSource = mode === 'adjust' ? blendSources(controller).flatMap((sample, sampleIndex) => {
      const candidate = blendSourceTracks.get(blendChannelKey(controllerStateId, sample.stateId));
      if (!candidate) return [];
      const snapshot = trackSnapshot(candidate, at, controllerStateId);
      const epoch = epochAt(candidate, at);
      return snapshot.isPlaying && epoch && epoch.duration > 0
        ? [{ stateId: sample.stateId, phase: snapshot.playbackTimeSeconds / epoch.duration,
          currentWeight: snapshot.weight, targetWeight: snapshot.targetWeight, sampleIndex }]
        : [];
    }).sort((left, right) => right.currentWeight - left.currentWeight || right.targetWeight - left.targetWeight
      || left.sampleIndex - right.sampleIndex)[0] : undefined;
    const needsRestart = mode === 'adjust' && blendSources(controller).some(sample => {
      const target = targets.get(sample.stateId)!;
      const track = blendSourceTracks.get(blendChannelKey(controllerStateId, sample.stateId));
      return target > 0 && (!track || !trackSnapshot(track, at, controllerStateId).isPlaying);
    });
    if (needsRestart && !phaseSource) {
      return { success: false as const, reason: 'no_usable_source_clock' as const, restartedStateIds: [] as string[] };
    }
    const restartedStateIds: string[] = [];
    for (const sample of blendSources(controller)) {
      const sourceRecipe = recipeByState.get(sample.stateId)!;
      const key = blendChannelKey(controllerStateId, sample.stateId);
      let track = blendSourceTracks.get(key);
      const target = mode === 'stop' ? 0 : targets.get(sample.stateId)!;
      if (mode === 'play') {
        const previousEpoch = track?.epochs.at(-1);
        const previousPlaying = track !== undefined && trackSnapshot(track, at, controllerStateId).isPlaying;
        const initialWeight = track ? trackWeightAt(track, at) : 0;
        const playProfile = fadeProfileByKey.get(`${sample.stateId}:${duration}`);
        const retriggerBehavior = previousPlaying ? playProfile?.playRetrigger?.observedClockBehavior : undefined;
        if (previousPlaying && retriggerBehavior === 'preserved' && track) {
          playbackRetriggerCounts.measuredPreserved++;
          const playInCalibration = fadeCurveFor(sample.stateId, duration, 'playIn');
          setTrackWeight(track, at, target, duration, null, playInCalibration, false);
          continue;
        }
        if (previousPlaying) {
          if (retriggerBehavior === 'reset_to_zero') playbackRetriggerCounts.measuredReset++;
          else if (retriggerBehavior === 'ambiguous') playbackRetriggerCounts.ambiguousProbeAssumedReset++;
          else playbackRetriggerCounts.unmeasuredAssumedReset++;
        }
        if (!track) {
          track = { stateId: sample.stateId, epochs: [] };
          blendSourceTracks.set(key, track);
        }
        if (previousPlaying && previousEpoch) {
          previousEpoch.stopAt = at;
          previousEpoch.endedAt = at;
          previousEpoch.endReason = 'restarted';
        }
        const playInCalibration = fadeCurveFor(sample.stateId, duration, 'playIn');
        const observedLength = observedLengths?.get(sample.stateId);
        const initialPhase = observedStartPhases?.get(sample.stateId) ?? 0;
        appendInTimelineOrder(track.epochs, { generation: ++generation, startedAt: at,
          speed: (observedSpeeds?.get(sample.stateId)
            ?? (observedLengths && observedLength !== undefined
              ? controller.speed * observedLength / observedLengths.get(blendSources(controller)[0]!.stateId)!
              : controller.speed * sourceRecipe.duration / recipeByState.get(controllerStateId)!.duration)) * playbackSpeedMultiplier,
          loop: sourceRecipe.loop, duration: observedLength ?? sourceRecipe.duration, initialPhase,
          fades: [{ from: initialWeight, to: target, start: at, end: at + duration,
            ...(playInCalibration ? { curve: playInCalibration.curve, calibrationProfileId: playInCalibration.profileId,
              calibrationDirection: playInCalibration.direction } : {}) }],
          stopAt: null, endedAt: null, endReason: null }, epoch => epoch.startedAt, 'playback epochs');
        scheduleBlendSourceNaturalStop(controllerStateId, sample.stateId, track.epochs.at(-1)!);
      } else if (track) {
        const calibration = mode === 'stop' ? fadeCurveFor(sample.stateId, duration, 'stopOut')
          : mode === 'adjust' ? adjustWeightCurveFor(sample.stateId, duration,
            target >= trackWeightAt(track, at) ? 'adjustWeightIn' : 'adjustWeightOut') : undefined;
        const currentlyPlaying = trackSnapshot(track, at, controllerStateId).isPlaying;
        if (mode === 'adjust' && !currentlyPlaying && target > 0 && phaseSource) {
          const playInCalibration = fadeCurveFor(sample.stateId, duration, 'playIn');
          const observedLength = observedLengths?.get(sample.stateId);
          const speed = (observedSpeeds?.get(sample.stateId)
            ?? (observedLengths && observedLength !== undefined
              ? controller.speed * observedLength / observedLengths.get(blendSources(controller)[0]!.stateId)!
              : controller.speed * sourceRecipe.duration / recipeByState.get(controllerStateId)!.duration)) * playbackSpeedMultiplier;
          appendInTimelineOrder(track.epochs, { generation: ++generation, startedAt: at, speed, loop: sourceRecipe.loop,
            duration: observedLength ?? sourceRecipe.duration, initialPhase: phaseSource.phase,
            fades: [{ from: 0, to: target, start: at, end: at + duration,
              ...(playInCalibration ? { curve: playInCalibration.curve, calibrationProfileId: playInCalibration.profileId,
                calibrationDirection: playInCalibration.direction } : {}) }], stopAt: null, endedAt: null, endReason: null },
          epoch => epoch.startedAt, 'playback epochs');
          scheduleBlendSourceNaturalStop(controllerStateId, sample.stateId, track.epochs.at(-1)!);
          restartedStateIds.push(sample.stateId);
          if (sample.stateId === controllerStateId) {
            const controllerTrack = tracks.get(controllerStateId);
            schedulePlayback(at, controllerTrack ? trackWeightAt(controllerTrack, at) : 0,
              duration, controllerStateId, phaseSource.phase);
          }
        } else {
          setTrackWeight(track, at, target, duration, mode === 'stop' ? 'transition' : null, calibration, mode === 'stop');
        }
      }
    }
    return { success: true as const, restartedStateIds,
      ...(phaseSource ? { phaseSourceStateId: phaseSource.stateId, phaseSource } : {}) };
  };
  const retimeActiveTrack = (track: SimulatedTrack, at: number, factor: number, callbackStateId?: string) => {
    const epoch = epochAt(track, at);
    if (!epoch || !trackSnapshot(track, at, state).isPlaying || epoch.duration <= 0) return undefined;
    const currentPhase = trackSnapshot(track, at, state).playbackTimeSeconds / epoch.duration;
    const updated: TrackEpoch = { ...epoch, generation: ++generation, startedAt: at,
      initialPhase: epoch.loop ? currentPhase % 1 : Math.min(currentPhase, 1), speed: epoch.speed * factor,
      fades: epoch.fades.map(fade => ({ ...fade })) };
    appendInTimelineOrder(track.epochs, updated, epoch => epoch.startedAt, 'playback epochs');
    if (callbackStateId) scheduleEpochCallbacks(callbackStateId, at, updated.initialPhase ?? 0, updated.duration,
      updated.speed, updated.generation, true);
    return updated.speed;
  };
  const blendSourceWeight = (controllerStateId: string, sourceStateId: string, at: number) => {
    const track = blendSourceTracks.get(blendChannelKey(controllerStateId, sourceStateId));
    if (!track) return { weight: 0, targetWeight: 0 };
    const epoch = epochAt(track, at);
    const fade = epoch ? fadeAt(epoch, at) : undefined;
    return { weight: trackWeightAt(track, at), targetWeight: fade?.to ?? 0 };
  };
  const scheduleBlendSourceNaturalStop = (controllerStateId: string, sourceStateId: string, epoch: TrackEpoch) => {
    if (epoch.loop) return;
    const at = epoch.startedAt + (epoch.duration - (epoch.initialPhase ?? 0) * epoch.duration) / epoch.speed;
    if (at > input.duration) return;
    schedule({ at, order: nextOrder++, generation: epoch.generation, kind: 'animation_natural_stop',
      stateId: controllerStateId, blendSourceStateId: sourceStateId, source: 'runtime' });
  };
  const entryController = stateById.get(state)!;
  if (isBlendController(entryController)) setBlendSourceTargets(state, 0, 0, parameters, 'play');

  const applyTrigger = (at: number, trigger: string, source: 'runtime' | 'user', inputIndex?: number, setParameters: Record<string, boolean | number | string> = {}, expectTransitionId?: string, marker?: string) => {
    const proposed = { ...parameters, ...setParameters };
    const evaluation = evaluateAnimationGraphTransition(graph, state, trigger, proposed);
    const selected = evaluation.selectedTransition;
    const expectedMatched = expectTransitionId === undefined || selected?.id === expectTransitionId;
    if (selected) {
      if (unavailableStateIds.has(selected.to)) {
        timeline.push({ at, event: 'transition_failed', source,
          ...(inputIndex === undefined ? {} : { inputIndex }), trigger, ...(marker ? { marker } : {}),
          stateBefore: state, stateAfter: state, selectedTransitionId: selected.id,
          failureReason: 'destination_animation_unavailable', failedStateId: selected.to,
          guardEvaluation: guardDiagnostic(evaluation),
          ...(Object.keys(setParameters).length > 0 ? { rejectedParameterUpdates: setParameters } : {}),
          expectedTransitionId: expectTransitionId ?? null, expectationMatched: expectedMatched });
        return;
      }
      cancelParameterRamps(Object.keys(setParameters), at);
      parameters = evaluation.parameterValues;
      const previousState = state;
      const activeBefore = [...tracks.values()].map(track => trackSnapshot(track, at, state)).filter(track => track.weight > 0);
      const previousTrack = tracks.get(previousState);
      const previousWeight = previousTrack ? trackWeightAt(previousTrack, at) : 0;
      const destinationTrack = tracks.get(selected.to);
      const destinationWeight = destinationTrack ? trackWeightAt(destinationTrack, at) : 0;
      if (isBlendController(stateById.get(previousState)!) && selected.to !== previousState) {
        setBlendSourceTargets(previousState, at, selected.blendSeconds, parameters, 'stop');
      }
      if (previousTrack && selected.to !== previousState) setTrackWeight(previousTrack, at, 0, selected.blendSeconds, 'transition',
        fadeCurveFor(previousState, selected.blendSeconds, 'stopOut'));
      state = selected.to;
      transitionIds.push(selected.id);
      const destinationEpoch = destinationTrack?.epochs.at(-1);
      const destinationWasPlaying = destinationEpoch !== undefined && epochIsPlayingAt(destinationEpoch, at);
      const playProfile = fadeProfileByKey.get(`${selected.to}:${selected.blendSeconds}`);
      const playbackClockDecision = !destinationWasPlaying ? 'new_or_stopped_track' as const
        : playProfile?.playRetrigger?.observedClockBehavior === 'preserved' ? 'studio_observed_preserved' as const
          : playProfile?.playRetrigger?.observedClockBehavior === 'reset_to_zero' ? 'studio_observed_reset' as const
            : playProfile?.playRetrigger?.observedClockBehavior === 'ambiguous' ? 'ambiguous_probe_assumed_reset' as const
              : 'unmeasured_assumed_reset' as const;
      timeline.push({ at, event: source === 'runtime' ? marker ? 'marker' : 'animation_end' : 'trigger', source,
        ...(inputIndex === undefined ? {} : { inputIndex }), trigger, ...(marker ? { marker } : {}), stateBefore: previousState,
        stateAfter: state, transitionId: selected.id, blendSeconds: selected.blendSeconds, playbackSpeed: stateById.get(state)!.speed,
        guardEvaluation: guardDiagnostic(evaluation),
        interruptedBlend: activeBefore.filter(track => track.stateId !== previousState).map(track => track.stateId),
        sourceWeightAtTransition: previousWeight, destinationWeightAtTransition: destinationWeight,
        destinationFadeStartWeight: destinationWeight, playbackClockDecision,
        ...(Object.keys(setParameters).length > 0 ? { committedParameterUpdates: setParameters } : {}),
        expectedTransitionId: expectTransitionId ?? null, expectationMatched: expectedMatched });
      // Play targets weight 1; preserve the cached track's current weight as the fade origin.
      schedulePlayback(at, destinationWeight, selected.blendSeconds, selected.to);
      if (isBlendController(stateById.get(selected.to)!)) {
        setBlendSourceTargets(selected.to, at, selected.blendSeconds, parameters, 'play');
      }
    } else {
      timeline.push({ at, event: source === 'runtime' ? marker ? 'marker' : 'animation_end' : 'trigger', source,
        ...(inputIndex === undefined ? {} : { inputIndex }), trigger, ...(marker ? { marker } : {}), stateBefore: state,
        stateAfter: state, transitionId: null, noTransitionReason: evaluation.noTransitionReason,
        guardEvaluation: guardDiagnostic(evaluation),
        ...(Object.keys(setParameters).length > 0 ? { rejectedParameterUpdates: setParameters } : {}),
        expectedTransitionId: expectTransitionId ?? null, expectationMatched: expectedMatched });
    }
  };

  const retainCurrentRuntimeCallbacksAt = (at: number) => {
    const callbacks = (scheduledEventLedger.get(at) ?? []).filter(candidate => {
      if ((candidate.kind !== 'marker' && candidate.kind !== 'animation_end' && candidate.kind !== 'animation_natural_stop')
        || candidate.stateId !== state) return false;
      const track = candidate.blendSourceStateId !== undefined
        ? blendSourceTracks.get(blendChannelKey(candidate.stateId, candidate.blendSourceStateId))
        : tracks.get(candidate.stateId);
      return track !== undefined && epochAt(track, at)?.generation === candidate.generation;
    });
    if (callbacks.length === 0) return;
    const retained = userFirstRuntimeCallbacksByTime.get(at) ?? new Set<ScheduledEvent>();
    for (const callback of callbacks) retained.add(callback);
    userFirstRuntimeCallbacksByTime.set(at, retained);
  };

  while (queue.length > 0) {
    const event = popEvent(queue, eventOrderPolicy)!;
    if (event.at > input.duration) break;
    processedEvents++;
    if (processedEvents > MAX_PROCESSED_EVENTS) throw new Error(`Timeline simulation exceeded ${MAX_PROCESSED_EVENTS} processed events.`);
    if (event.kind === 'external' || event.kind === 'parameter_ramp_sample') retainCurrentRuntimeCallbacksAt(event.at);
    if (event.kind === 'external') {
      const authored = input.events[event.inputIndex!]!;
      if (authored.kind === 'set_parameters') {
        if (applyParameterUpdates(event.at, event.inputIndex!, authored.values)) cancelParameterRamps(Object.keys(authored.values), event.at);
      } else if (authored.kind === 'ramp_parameters') {
        const rampId = event.inputIndex!;
        const from = Object.fromEntries(Object.keys(authored.values).map(name => [name, parameters[name]]));
        const targetParameters = normalizeAnimationGraphParameters(graph, { ...parameters, ...authored.values });
        const target = Object.fromEntries(Object.keys(authored.values).map(name => [name, targetParameters[name] as number]));
        cancelParameterRamps(Object.keys(authored.values), event.at);
        const ramp = { duration: authored.duration, easing: authored.easing,
          startValues: from as Record<string, number>, targetValues: target, activeNames: new Set(Object.keys(target)) };
        activeParameterRamps.set(rampId, ramp);
        parameterRampLifecycle.set(rampId, { startedAt: event.at, duration: authored.duration, easing: authored.easing,
          channels: new Map(Object.keys(target).map(name => [name, { startValue: ramp.startValues[name]!, targetValue: target[name]!,
            status: 'active' as const, endedAt: null, observedValue: null }])) });
        timeline.push({ at: event.at, event: 'ramp_parameters', source: 'user', inputIndex: rampId,
          stateBefore: state, stateAfter: state, startValues: from, targetValues: target, duration: authored.duration, easing: authored.easing });
      } else if (authored.kind === 'set_playback_speed') {
        const previousMultiplier = playbackSpeedMultiplier;
        const changedTracks: Array<{ stateId: string; speed: number }> = [];
        if (authored.multiplier !== previousMultiplier) {
          const controllerTrack = tracks.get(state);
          const controllerSpeed = controllerTrack
            ? retimeActiveTrack(controllerTrack, event.at, authored.multiplier / previousMultiplier, state) : undefined;
          if (controllerSpeed !== undefined) changedTracks.push({ stateId: state, speed: controllerSpeed });
          const activeState = stateById.get(state)!;
          if (isBlendController(activeState)) {
            for (const sample of blendSources(activeState)) {
              const sourceTrack = blendSourceTracks.get(blendChannelKey(state, sample.stateId));
              const sourceSpeed = sourceTrack
                ? retimeActiveTrack(sourceTrack, event.at, authored.multiplier / previousMultiplier) : undefined;
              if (sourceSpeed !== undefined && sourceTrack) {
                changedTracks.push({ stateId: sample.stateId, speed: sourceSpeed });
                const sourceEpoch = epochAt(sourceTrack, event.at);
                if (sourceEpoch) scheduleBlendSourceNaturalStop(state, sample.stateId, sourceEpoch);
              }
            }
          }
          playbackSpeedMultiplier = authored.multiplier;
        }
        timeline.push({ at: event.at, event: 'set_playback_speed', source: 'user', inputIndex: event.inputIndex,
          stateBefore: state, stateAfter: state, previousMultiplier, multiplier: playbackSpeedMultiplier, changedTracks });
      } else applyTrigger(event.at, authored.trigger, 'user', event.inputIndex, authored.setParameters, authored.expectTransitionId);
    } else if (event.kind === 'parameter_ramp_sample') {
      const rampId = event.inputIndex!;
      const ramp = activeParameterRamps.get(rampId);
      if (!ramp || event.rampProgress === undefined) continue;
      const progress = event.rampProgress;
      const easedProgress = ramp.easing === 'smoothstep' ? progress * progress * (3 - 2 * progress) : progress;
      const values = Object.fromEntries([...ramp.activeNames].map(name => [name,
        ramp.startValues[name]! + (ramp.targetValues[name]! - ramp.startValues[name]!) * easedProgress]));
      if (!applyParameterUpdates(event.at, rampId, values, { progress, easing: ramp.easing })) {
        interruptRampChannels(rampId, ramp, [...ramp.activeNames], event.at);
        activeParameterRamps.delete(rampId);
      } else if (progress >= 1) {
        const lifecycle = parameterRampLifecycle.get(rampId);
        for (const name of ramp.activeNames) {
          const channel = lifecycle?.channels.get(name);
          if (channel) Object.assign(channel, { status: 'completed' as const, endedAt: event.at, observedValue: parameters[name] as number });
        }
        activeParameterRamps.delete(rampId);
      }
    } else if (event.kind === 'marker') {
      const eventTrack = tracks.get(event.stateId!);
      if (!eventTrack || epochAt(eventTrack, event.at)?.generation !== event.generation || state !== event.stateId) continue;
      const recipe = recipeByState.get(event.stateId!)!;
      const marker = recipe.markers.find(candidate => candidate.name === event.marker);
      if (!marker) continue;
      triggeredMarkers.push({ at: event.at, stateId: event.stateId!, marker: marker.name, value: marker.value ?? '' });
      applyTrigger(event.at, marker.name, 'runtime', undefined, {}, undefined, marker.name);
    } else if (event.kind === 'animation_natural_stop') {
      if (event.blendSourceStateId !== undefined) {
        const sourceTrack = blendSourceTracks.get(blendChannelKey(event.stateId!, event.blendSourceStateId));
        const sourceEpoch = sourceTrack ? epochAt(sourceTrack, event.at) : undefined;
        if (!sourceTrack || !sourceEpoch || sourceEpoch.generation !== event.generation || state !== event.stateId
          || (sourceEpoch.stopAt !== null && sourceEpoch.stopAt <= event.at)) continue;
        const naturalTiming = naturalCompletionForPlayback(event.blendSourceStateId, sourceEpoch.duration);
        if (naturalTiming.profile) usedFadeProfiles.add(naturalTiming.profile.id);
        setTrackWeight(sourceTrack, event.at, 0, naturalTiming.fadeSeconds, 'natural_completion',
          naturalCompletionCurveFor(event.blendSourceStateId, naturalTiming.fadeSeconds, sourceEpoch.duration));
        timeline.push({ at: event.at, event: 'animation_natural_stop', source: 'runtime', stateBefore: state, stateAfter: state,
          stateId: event.stateId, blendSourceStateId: event.blendSourceStateId, fadeSeconds: naturalTiming.fadeSeconds,
          timingSource: naturalTiming.source, calibrationProfileId: naturalTiming.profile?.id ?? null });
      } else {
        const endingTrack = tracks.get(event.stateId!);
        if (!endingTrack || epochAt(endingTrack, event.at)?.generation !== event.generation || state !== event.stateId) continue;
        const naturalTiming = naturalCompletionForPlayback(event.stateId!, epochAt(endingTrack, event.at)!.duration);
        if (naturalTiming.profile) usedFadeProfiles.add(naturalTiming.profile.id);
        setTrackWeight(endingTrack, event.at, 0, naturalTiming.fadeSeconds, 'natural_completion',
          naturalCompletionCurveFor(event.stateId!, naturalTiming.fadeSeconds, epochAt(endingTrack, event.at)!.duration));
        timeline.push({ at: event.at, event: 'animation_natural_stop', source: 'runtime', stateBefore: state, stateAfter: state,
          stateId: event.stateId, fadeSeconds: naturalTiming.fadeSeconds,
          timingSource: naturalTiming.source, calibrationProfileId: naturalTiming.profile?.id ?? null });
      }
    } else {
      const endedTrack = tracks.get(event.stateId!);
      if (!endedTrack || epochAt(endedTrack, event.at)?.generation !== event.generation || state !== event.stateId) continue;
      const naturalTiming = naturalCompletionForPlayback(event.stateId!, epochAt(endedTrack, event.at)!.duration);
      if (naturalTiming.profile && naturalTiming.animationLengthMatchesRecipe === true) usedFadeProfiles.add(naturalTiming.profile.id);
      if (naturalTiming.fadeSeconds === 0) setTrackWeight(endedTrack, event.at, 0, 0, 'natural_completion');
      applyTrigger(event.at, 'AnimationEnded', 'runtime');
    }
    addEventSampleTime(event.at);
    if (timeline.length > MAX_TIMELINE_ENTRIES) throw new Error(`Timeline simulation exceeded ${MAX_TIMELINE_ENTRIES} timeline entries.`);
  }

  if (sampleTimes.size > MAX_BLEND_SAMPLES) throw new Error(`Blend simulation exceeded the ${MAX_BLEND_SAMPLES}-sample safety limit.`);
  let timelineIndex = 0;
  let sampledState = graph.entryState;
  let trackSampleCount = 0;
  const blendSamples: Array<{ at: number; currentState: string; activeTracks: ReturnType<typeof trackSnapshot>[];
    blendSpaceEvaluations: Array<{ controllerStateId: string; parameter: string; value: number | { x: number; y: number };
      clampedValue: number | { x: number; y: number }; parameters: Record<string, number>; clampedParameters: Record<string, number>;
      parameterNames: { x: string; y: string | null }; axisValues?: { x: number; y: number }; method: string;
      lowerStateId: string; upperStateId: string; controllerWeight: number; controllerTargetWeight: number;
      samples: Array<{ stateId: string; weight: number; poseContributionWeight: number; targetPoseContributionWeight: number;
        playback: { timeSeconds: number; normalizedPhase: number; playbackSpeed: number; playbackCycleDurationSeconds: number;
          playbackCycleDurationRatioToController: number; authoredStateSpeed: number; isPlaying: boolean } }> }> }> = [];
  const parameterEvents = timeline.filter(event => event.event === 'set_parameters' || event.committedParameterUpdates !== undefined)
    .map(event => ({ at: event.at as number, updates: (event.updatedParameters ?? event.committedParameterUpdates) as Record<string, boolean | number | string> }));
  const initialParameterValues = normalizeAnimationGraphParameters(graph, input.initialParameters);
  let parameterEventIndex = 0;
  let sampledParameters = initialParameterValues;
  let blendSpaceWeightSampleCount = 0;
  for (const at of [...sampleTimes].filter(time => time >= 0 && time <= input.duration).sort((left, right) => left - right)) {
    while (timelineIndex < timeline.length) {
      const event = timeline[timelineIndex]!;
      if (typeof event.at !== 'number' || event.at > at) break;
      timelineIndex++;
      if (typeof event.stateAfter === 'string' && event.stateAfter !== event.stateBefore) sampledState = event.stateAfter;
    }
    while (parameterEventIndex < parameterEvents.length && parameterEvents[parameterEventIndex]!.at <= at) {
      sampledParameters = normalizeAnimationGraphParameters(graph, { ...sampledParameters, ...parameterEvents[parameterEventIndex]!.updates });
      parameterEventIndex++;
    }
    const activeTracks = [...tracks.values()].map(track => trackSnapshot(track, at, sampledState))
      .filter(track => track.weight > 0 || track.isPlaying).sort((left, right) => left.stateId.localeCompare(right.stateId));
    trackSampleCount += activeTracks.length;
    if (trackSampleCount > MAX_TRACK_SAMPLES) throw new Error(`Blend simulation exceeded the ${MAX_TRACK_SAMPLES} active-track sample safety limit.`);
    const activeBlendControllerIds = new Set(activeTracks.flatMap(track => {
      const controller = stateById.get(track.stateId)!;
      return isBlendController(controller) ? [controller.id] : [];
    }));
    // Blend source channels have independent AnimationTrack-like weights. A calibrated
    // controller fade can finish before those channels, so keep evaluating the controller
    // while any source still contributes, without pretending its own track is active.
    for (const [key, sourceTrack] of blendSourceTracks) {
      if (trackWeightAt(sourceTrack, at) <= 0) continue;
      activeBlendControllerIds.add(key.slice(0, key.indexOf('\u0000')));
    }
    const blendSpaceEvaluations = [...activeBlendControllerIds].sort((left, right) => left.localeCompare(right)).flatMap(controllerStateId => {
      const controller = stateById.get(controllerStateId)!;
      if (!isBlendController(controller)) return [];
      const activeControllerTrack = activeTracks.find(track => track.stateId === controller.id);
          const controllerRecipe = recipeByState.get(controller.id)!;
          const controllerTrack = tracks.get(controller.id);
          const controllerEpoch = controllerTrack ? epochAt(controllerTrack, at) : undefined;
          const controllerPlaybackSpeed = controllerEpoch?.speed ?? controller.speed * playbackSpeedMultiplier;
          const controllerCycleDurationSeconds = (controllerEpoch?.duration ?? controllerRecipe.duration) / controllerPlaybackSpeed;
      const sampled = sampleGraphBlend(controller, sampledParameters);
      blendSpaceWeightSampleCount += sampled.weights.length;
      if (blendSpaceWeightSampleCount > MAX_BLEND_SPACE_WEIGHT_SAMPLES) {
        throw new Error(`Blend-space evaluation exceeded the ${MAX_BLEND_SPACE_WEIGHT_SAMPLES}-weight safety limit. Reduce the sample rate, duration, or number of active blend spaces.`);
      }
      return [{ controllerStateId: controller.id, parameter: sampled.parameter, value: sampled.value,
        clampedValue: sampled.clampedValue, parameters: sampled.parameters, clampedParameters: sampled.clampedParameters,
        parameterNames: sampled.parameterNames, ...('axisValues' in sampled ? { axisValues: sampled.axisValues } : {}),
        method: sampled.method, lowerStateId: sampled.lowerStateId, upperStateId: sampled.upperStateId,
        controllerWeight: activeControllerTrack?.weight ?? 0, controllerTargetWeight: activeControllerTrack?.targetWeight ?? 0,
        samples: sampled.weights.map(sample => {
          const channel = blendSourceWeight(controller.id, sample.stateId, at);
          const sourceTrack = blendSourceTracks.get(blendChannelKey(controller.id, sample.stateId));
          const sourceEpoch = sourceTrack ? epochAt(sourceTrack, at) : undefined;
          const sourcePlayback = sourceTrack ? trackSnapshot(sourceTrack, at, sampledState) : undefined;
          const sourceRecipe = recipeByState.get(sample.stateId)!;
          const sourceState = stateById.get(sample.stateId)!;
          const sourceDuration = sourceEpoch?.duration ?? sourceRecipe.duration;
          const playbackSpeed = sourceEpoch?.speed
            ?? controller.speed * sourceRecipe.duration / controllerRecipe.duration * playbackSpeedMultiplier;
          const playbackCycleDurationSeconds = sourceDuration / playbackSpeed;
          return { stateId: sample.stateId, weight: sample.weight,
            poseContributionWeight: channel.weight,
            targetPoseContributionWeight: channel.targetWeight,
            playback: { timeSeconds: sourcePlayback?.playbackTimeSeconds ?? 0,
              normalizedPhase: sourceDuration > 0 ? (sourcePlayback?.playbackTimeSeconds ?? 0) / sourceDuration : 0,
              playbackSpeed, playbackCycleDurationSeconds,
              playbackCycleDurationRatioToController: playbackCycleDurationSeconds / controllerCycleDurationSeconds,
              authoredStateSpeed: sourceState.speed,
              isPlaying: sourcePlayback?.isPlaying ?? false } };
        }) }];
    });
    blendSamples.push({ at, currentState: sampledState, activeTracks, blendSpaceEvaluations });
  }
  const blendSampleByTime = new Map(blendSamples.map(sample => [sample.at, sample]));
  const poseSampleTimes = new Set(requestedPoseTimes);
  if (input.includeBlendSamplePoses) for (const sample of blendSamples) poseSampleTimes.add(sample.at);
  if (poseSampleTimes.size * poseJoints.length > MAX_COMPOSED_POSE_JOINT_SAMPLES) {
    throw new Error(`Composed pose sampling would evaluate ${poseSampleTimes.size * poseJoints.length} joint-time pairs, above the ${MAX_COMPOSED_POSE_JOINT_SAMPLES} safety limit. Reduce the simulation duration/sample rate, request fewer sampleTimes, or select fewer poseJoints.`);
  }

  const trackLifecycles = graph.states.map(graphState => {
    const track = tracks.get(graphState.id);
    const epoch = track?.epochs.at(-1);
    const weight = track ? trackWeightAt(track, input.duration) : 0;
    const latestFade = epoch ? fadeAt(epoch, input.duration) : undefined;
    const elapsed = epoch ? epochElapsedAt(epoch, input.duration) : 0;
    const theoreticalNaturalEndAt = epoch && !epoch.loop
      ? epoch.startedAt + (1 - (epoch.initialPhase ?? 0)) * epoch.duration / epoch.speed : null;
    const naturallyEnded = epoch !== undefined && theoreticalNaturalEndAt !== null && input.duration >= theoreticalNaturalEndAt
      && (epoch.stopAt === null || epoch.stopAt >= theoreticalNaturalEndAt);
    const naturalEndAt = naturallyEnded ? theoreticalNaturalEndAt : null;
    const isPlaying = epoch !== undefined && (epoch.stopAt === null || input.duration < epoch.stopAt) && (epoch.loop || elapsed < epoch.duration);
    const status = !epoch ? 'not_started' as const : isPlaying ? 'playing' as const
      : weight > 0 ? 'stopped_fading' as const : epoch.endReason === 'natural_completion' || naturallyEnded ? 'completed' as const : 'stopped' as const;
    return { stateId: graphState.id, observedAt: input.duration, status, playbackCount: track?.epochs.length ?? 0,
      latestStartAt: epoch?.startedAt ?? null, latestEndAt: epoch?.endedAt ?? naturalEndAt,
      latestEndReason: epoch?.endReason ?? (naturallyEnded ? 'natural_completion' as const : null),
      latestStopRequestedAt: epoch?.stopAt ?? naturalEndAt,
      fadeOutCompletesAt: latestFade?.to === 0 ? latestFade.end : null,
      fadeOutRemainingSeconds: latestFade?.to === 0 ? Math.max(0, latestFade.end - input.duration) : 0,
      playbackTimeSeconds: epoch ? trackSnapshot(track!, input.duration, state).playbackTimeSeconds : 0, weight };
  });

  const eventOrderingCollisions: Array<{ at: number; eventCount: number; externalInputIndices: number[];
    runtimeEvents: Array<{ kind: 'marker' | 'animation_end' | 'animation_natural_stop'; stateId: string; marker?: string;
      blendSourceStateId?: string }> }> = [];
  const appliedRampSamples = new Set(timeline.flatMap(event => {
    const inputIndex = event.inputIndex;
    return event.event === 'set_parameters' && typeof event.at === 'number' && typeof inputIndex === 'number'
      && input.events[inputIndex]?.kind === 'ramp_parameters' ? [`${event.at}:${inputIndex}`] : [];
  }));
  let truncatedEventOrderingCollisions = 0;
  const orderedScheduledTimes = [...scheduledEventLedger.entries()].sort(([left], [right]) => left - right);
  let orderingTimelineIndex = 0;
  let orderingState = graph.entryState;
  for (const [at, eventsAtTime] of orderedScheduledTimes) {
    while (orderingTimelineIndex < timeline.length) {
      const timelineEvent = timeline[orderingTimelineIndex]!;
      if (typeof timelineEvent.at !== 'number' || timelineEvent.at >= at) break;
      if (typeof timelineEvent.stateAfter === 'string') orderingState = timelineEvent.stateAfter;
      orderingTimelineIndex++;
    }
    if (at > input.duration) continue;
    const externalEvents = eventsAtTime.filter(event => event.kind === 'external'
      || (event.kind === 'parameter_ramp_sample' && appliedRampSamples.has(`${at}:${event.inputIndex}`)));
    const userFirstRuntimeCallbacks = userFirstRuntimeCallbacksByTime.get(at);
    const runtimeEvents = eventsAtTime.filter((event): event is ScheduledEvent & { kind: 'marker' | 'animation_end' | 'animation_natural_stop'; stateId: string } =>
      (event.kind === 'marker' || event.kind === 'animation_end' || event.kind === 'animation_natural_stop') && event.stateId !== undefined
      && orderingState === event.stateId
      && ((event.blendSourceStateId !== undefined
        ? epochAt(blendSourceTracks.get(blendChannelKey(event.stateId, event.blendSourceStateId))!, at)?.generation
        : epochAt(tracks.get(event.stateId)!, at)?.generation) === event.generation
        || userFirstRuntimeCallbacks?.has(event) === true));
    if (runtimeEvents.length === 0 || (externalEvents.length === 0 && runtimeEvents.length < 2)) continue;
    if (eventOrderingCollisions.length >= MAX_EVENT_ORDERING_COLLISION_DETAILS) {
      truncatedEventOrderingCollisions++;
      continue;
    }
    eventOrderingCollisions.push({ at, eventCount: externalEvents.length + runtimeEvents.length,
      externalInputIndices: externalEvents.map(event => event.inputIndex!).sort((left, right) => left - right),
      runtimeEvents: runtimeEvents.map(event => ({ kind: event.kind, stateId: event.stateId!,
        ...(event.kind === 'marker' ? { marker: event.marker } : {}),
        ...(event.blendSourceStateId ? { blendSourceStateId: event.blendSourceStateId } : {}) })) });
  }
  const eventOrderingDiagnostics = animationGraphEventOrderingDiagnosticsSchema.parse({
    policy: 'user inputs are processed before runtime marker/AnimationEnded and modeled natural-completion fade-start events at the same timestamp; user inputs retain authored order; Roblox runtime callback ordering is not guaranteed',
    ambiguousCollisionCount: eventOrderingCollisions.length + truncatedEventOrderingCollisions,
    detailedCollisionCount: eventOrderingCollisions.length, truncatedCollisionCount: truncatedEventOrderingCollisions,
    collisions: eventOrderingCollisions,
  });
  let composedPoseContributionCount = 0;
  let unanimatedTrackJointCount = 0;
  let poseCompositionSourceCount = 0;
  let poseProvenanceBytes = 0;
  const composedPoseSamples = [...poseSampleTimes].sort((left, right) => left - right).map(at => {
    const blendSample = blendSampleByTime.get(at);
    if (!blendSample) throw new Error(`Requested pose sample at ${at} seconds was not generated.`);
    const active: Array<ReturnType<typeof trackSnapshot> & { playbackTimeSeconds: number;
      priority: NonNullable<ReturnType<typeof animationSchema.parse>['priority']>; priorityRank: number;
      samplers: Map<string, NonNullable<ReturnType<typeof createComposedJointEvaluationSampler>>>;
      sourceStateId: string; sourceWeight: number; controllerStateId?: string }> = blendSample.activeTracks.flatMap(track => {
      const controller = stateById.get(track.stateId)!;
      const evaluation = blendSample.blendSpaceEvaluations.find(candidate => candidate.controllerStateId === controller.id);
      if (!evaluation) {
        const recipe = recipeByState.get(track.stateId)!;
        const activeEpoch = epochAt(tracks.get(track.stateId)!, at);
        const normalizedPhase = activeEpoch && activeEpoch.duration > 0 ? track.playbackTimeSeconds / activeEpoch.duration : 0;
        return [{ ...track, playbackTimeSeconds: normalizedPhase * recipe.duration,
          priority: recipe.priority ?? 'Core', priorityRank: animationPriorityRank[recipe.priority ?? 'Core'],
          samplers: jointSamplersByState.get(track.stateId)!, sourceStateId: track.stateId, sourceWeight: 1 }];
      }
      return evaluation.samples.filter(sample => sample.poseContributionWeight > 0).map(sample => {
        const sourceRecipe = recipeByState.get(sample.stateId)!;
        const sourceTime = sample.playback.normalizedPhase * sourceRecipe.duration;
        return { ...track, stateId: sample.stateId, weight: sample.poseContributionWeight,
          playbackTimeSeconds: sourceTime, priority: sourceRecipe.priority ?? 'Core',
          priorityRank: animationPriorityRank[sourceRecipe.priority ?? 'Core'],
          samplers: jointSamplersByState.get(sample.stateId)!, sourceStateId: sample.stateId, sourceWeight: sample.weight,
          controllerStateId: controller.id };
      });
    });
    const activeControllerIds = new Set(blendSample.activeTracks.filter(track =>
      isBlendController(stateById.get(track.stateId)!)).map(track => track.stateId));
    for (const evaluation of blendSample.blendSpaceEvaluations) {
      if (activeControllerIds.has(evaluation.controllerStateId)) continue;
      for (const sample of evaluation.samples) {
        if (sample.poseContributionWeight <= 0) continue;
        const sourceTrack = blendSourceTracks.get(blendChannelKey(evaluation.controllerStateId, sample.stateId));
        if (!sourceTrack) continue;
        const track = trackSnapshot(sourceTrack, at, blendSample.currentState);
        const sourceRecipe = recipeByState.get(sample.stateId)!;
        active.push({ ...track, stateId: sample.stateId, weight: sample.poseContributionWeight,
          playbackTimeSeconds: sample.playback.normalizedPhase * sourceRecipe.duration,
          priority: sourceRecipe.priority ?? 'Core', priorityRank: animationPriorityRank[sourceRecipe.priority ?? 'Core'],
          samplers: jointSamplersByState.get(sample.stateId)!, sourceStateId: sample.stateId,
          sourceWeight: sample.weight, controllerStateId: evaluation.controllerStateId });
      }
    }
    const joints = poseJoints.map(joint => {
      const byPriority = new Map<number, typeof active>();
      for (const track of active) if (track.samplers.has(joint)) {
        const group = byPriority.get(track.priorityRank) ?? [];
        group.push(track);
        byPriority.set(track.priorityRank, group);
      }
      const contributors: Array<{ stateId: string; priority: string; trackWeight: number; effectiveWeight: number;
        blendControllerStateId?: string;
        contributionStatus: 'contributing' | 'zero_weight' | 'masked_by_higher_priority'; position: [number, number, number];
        rotationQuaternion: Quaternion; recipeComposition: Array<{ kind: 'base' | 'layer' | 'root_motion'; layerId?: string;
          layerName?: string; blendMode?: 'Override' | 'Additive'; weight: number; applied: boolean;
          position: [number, number, number]; rotationQuaternion: Quaternion; beforePosition: [number, number, number];
          beforeRotationQuaternion: Quaternion; afterPosition: [number, number, number]; afterRotationQuaternion: Quaternion }> }> = [];
      const unanimatedTracks: Array<{ stateId: string; blendControllerStateId?: string;
        priority: NonNullable<ReturnType<typeof animationSchema.parse>['priority']>; trackWeight: number;
        targetTrackWeight?: number; playbackTimeSeconds: number; reason: 'joint_not_animated' }> = active.filter(track => !track.controllerStateId && !track.samplers.has(joint)).map(track => ({ stateId: track.stateId,
        priority: track.priority, trackWeight: track.weight, playbackTimeSeconds: track.playbackTimeSeconds,
        reason: 'joint_not_animated' as const }));
      for (const evaluation of blendSample.blendSpaceEvaluations) {
        for (const sample of evaluation.samples) {
          if (sample.poseContributionWeight <= 0 || jointSamplersByState.get(sample.stateId)!.has(joint)) continue;
          unanimatedTracks.push({ stateId: sample.stateId, blendControllerStateId: evaluation.controllerStateId,
            priority: recipeByState.get(sample.stateId)!.priority ?? 'Core', trackWeight: sample.poseContributionWeight,
            targetTrackWeight: sample.targetPoseContributionWeight,
            playbackTimeSeconds: sample.playback.normalizedPhase * recipeByState.get(sample.stateId)!.duration,
            reason: 'joint_not_animated' as const });
        }
      }
      const priorityLayers: Array<{ priority: string; priorityRank: number; stateIds: string[]; requestedWeight: number;
        availableWeightBefore: number; effectiveBudget: number; remainingWeightAfter: number }> = [];
      let remainingWeight = 1;
      for (const [priorityRank, tracksAtPriority] of [...byPriority].sort(([left], [right]) => right - left)) {
        const totalTrackWeight = tracksAtPriority.reduce((sum, track) => sum + track.weight, 0);
        const availableWeightBefore = remainingWeight;
        const priorityBudget = Math.min(remainingWeight, totalTrackWeight);
        for (const track of tracksAtPriority.sort((left, right) => left.stateId.localeCompare(right.stateId))) {
          const effectiveWeight = totalTrackWeight > 0 ? priorityBudget * track.weight / totalTrackWeight : 0;
          const pose = track.samplers.get(joint)!(track.playbackTimeSeconds);
          poseCompositionSourceCount += pose.sources.length;
          if (poseCompositionSourceCount > MAX_POSE_COMPOSITION_SOURCES) {
            throw new Error(`Composed pose sampling exceeded the ${MAX_POSE_COMPOSITION_SOURCES} authored-channel provenance limit. Request fewer sampleTimes or select fewer poseJoints.`);
          }
          const recipeComposition = pose.sources.map(source => ({ kind: source.kind,
            ...(source.layerId ? { layerId: source.layerId } : {}), ...(source.layerName ? { layerName: source.layerName } : {}),
            ...(source.blendMode ? { blendMode: source.blendMode } : {}), weight: source.weight, applied: source.applied,
            position: source.sampled.position, rotationQuaternion: source.sampled.rotation,
            beforePosition: source.before.position, beforeRotationQuaternion: source.before.rotation,
            afterPosition: source.after.position, afterRotationQuaternion: source.after.rotation }));
          poseProvenanceBytes += Buffer.byteLength(JSON.stringify(recipeComposition), 'utf8') + 1;
          if (poseProvenanceBytes > MAX_POSE_PROVENANCE_BYTES) {
            throw new Error(`Composed pose sampling exceeded the ${MAX_POSE_PROVENANCE_BYTES} byte (4 MiB) serialized provenance safety limit. Request fewer sampleTimes or poseJoints, use explicit sampleTimes instead of includeBlendSamplePoses, or disable includePoseSamples.`);
          }
          contributors.push({ stateId: track.stateId, priority: track.priority, trackWeight: track.weight,
          ...(track.controllerStateId ? { blendControllerStateId: track.controllerStateId } : {}),
            effectiveWeight, contributionStatus: track.weight === 0 ? 'zero_weight'
              : effectiveWeight > 0 ? 'contributing' : 'masked_by_higher_priority',
            position: pose.position, rotationQuaternion: pose.rotation, recipeComposition });
        }
        remainingWeight -= priorityBudget;
        if (remainingWeight <= 1e-12) remainingWeight = 0;
        priorityLayers.push({ priority: tracksAtPriority[0]!.priority, priorityRank,
          stateIds: tracksAtPriority.map(track => track.stateId).sort(), requestedWeight: totalTrackWeight,
          availableWeightBefore, effectiveBudget: priorityBudget, remainingWeightAfter: remainingWeight });
      }
      composedPoseContributionCount += contributors.length;
      unanimatedTrackJointCount += unanimatedTracks.length;
      if (composedPoseContributionCount + unanimatedTrackJointCount > MAX_COMPOSED_POSE_CONTRIBUTIONS) {
        throw new Error(`Composed pose sampling exceeded the ${MAX_COMPOSED_POSE_CONTRIBUTIONS} contribution safety limit. Request fewer sampleTimes or poseJoints.`);
      }
      const position: [number, number, number] = [0, 0, 0];
      for (const contributor of contributors) for (let axis = 0; axis < 3; axis++) position[axis]! += contributor.position[axis]! * contributor.effectiveWeight;
      const orientation = weightedQuaternionMean([
        ...contributors.filter(contributor => contributor.effectiveWeight > 0)
          .map(contributor => ({ rotation: contributor.rotationQuaternion, weight: contributor.effectiveWeight })),
        ...(remainingWeight > 0 ? [{ rotation: [0, 0, 0, 1] as Quaternion, weight: remainingWeight }] : []),
      ]);
      const rotationInfluence = contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, 0);
      return { joint, position, rotationQuaternion: orientation.rotation, rotationBlendConfidence: orientation.confidence,
        rotationInfluence: Math.max(0, Math.min(1, rotationInfluence)), contributors, unanimatedTracks, priorityLayers, residualWeight: remainingWeight };
    });
    return { at, currentState: blendSample.currentState, joints };
  });
  const orderedPoseSampleTimes = composedPoseSamples.map(sample => sample.at);
  let maximumPoseSampleGapSeconds = 0;
  let maximumPoseSampleGapInterval: { from: number; to: number } | null = null;
  for (let index = 1; index < orderedPoseSampleTimes.length; index++) {
    const from = orderedPoseSampleTimes[index - 1]!;
    const to = orderedPoseSampleTimes[index]!;
    if (to - from > maximumPoseSampleGapSeconds) {
      maximumPoseSampleGapSeconds = to - from;
      maximumPoseSampleGapInterval = { from, to };
    }
  }
  const poseMotionDiagnostics = {
    samplingBasis: input.includeBlendSamplePoses ? 'all_generated_blend_samples' as const : 'explicit_sample_times' as const,
    sampleRateHz: input.includeBlendSamplePoses ? sampleRateHz : null,
    sampleCount: orderedPoseSampleTimes.length,
    coverageStartAt: orderedPoseSampleTimes[0] ?? null,
    coverageEndAt: orderedPoseSampleTimes.at(-1) ?? null,
    maximumSampleGapSeconds: maximumPoseSampleGapSeconds,
    maximumSampleGapInterval: maximumPoseSampleGapInterval,
    maximumSampleGapGate: input.maxPoseSampleGapSeconds === undefined ? null : {
      status: maximumPoseSampleGapSeconds <= input.maxPoseSampleGapSeconds ? 'passed' as const : 'failed' as const,
      maximumAllowedSeconds: input.maxPoseSampleGapSeconds,
      observedSeconds: maximumPoseSampleGapSeconds,
      interval: maximumPoseSampleGapInterval,
    },
    joints: poseJoints.map(joint => {
      const samples = composedPoseSamples.flatMap(sample => {
        const pose = sample.joints.find(candidate => candidate.joint === joint);
        return pose ? [{ at: sample.at, pose }] : [];
      });
      let maximumSampledLinearSpeedStudsPerSecond = 0;
      let maximumLinearSpeedInterval: { from: number; to: number } | null = null;
      let maximumSampledAngularSpeedDegreesPerSecond = 0;
      let maximumAngularSpeedInterval: { from: number; to: number } | null = null;
      let maximumSampledLinearAccelerationStudsPerSecondSquared = 0;
      let maximumLinearAccelerationInterval: { from: number; to: number } | null = null;
      let maximumSampledAngularSpeedChangeDegreesPerSecondSquared = 0;
      let maximumAngularSpeedChangeInterval: { from: number; to: number } | null = null;
      let maximumSampledAngularAccelerationDegreesPerSecondSquared = 0;
      let maximumAngularAccelerationInterval: { from: number; to: number } | null = null;
      let previousLinearVelocity: [number, number, number] | null = null;
      let previousAngularVelocity: [number, number, number] | null = null;
      let previousAngularFrame: Quaternion4 | null = null;
      let previousIntervalMidpoint: number | null = null;
      for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]!;
        const current = samples[index]!;
        const deltaSeconds = current.at - previous.at;
        if (deltaSeconds <= 0) continue;
        const linearVelocity = current.pose.position.map((value, axis) => (value - previous.pose.position[axis]!) / deltaSeconds) as [number, number, number];
        const linearSpeed = Math.hypot(...linearVelocity);
        if (linearSpeed > maximumSampledLinearSpeedStudsPerSecond) {
          maximumSampledLinearSpeedStudsPerSecond = linearSpeed;
          maximumLinearSpeedInterval = { from: previous.at, to: current.at };
        }
        const angularVelocity = quaternionAngularVelocityDegrees(previous.pose.rotationQuaternion, current.pose.rotationQuaternion, deltaSeconds);
        const angularSpeed = Math.hypot(angularVelocity[0], angularVelocity[1], angularVelocity[2]);
        if (angularSpeed > maximumSampledAngularSpeedDegreesPerSecond) {
          maximumSampledAngularSpeedDegreesPerSecond = angularSpeed;
          maximumAngularSpeedInterval = { from: previous.at, to: current.at };
        }
        const intervalMidpoint = (previous.at + current.at) / 2;
        if (previousLinearVelocity && previousIntervalMidpoint !== null) {
          const midpointDelta = intervalMidpoint - previousIntervalMidpoint;
          if (midpointDelta > 0) {
            const linearAcceleration = Math.hypot(...linearVelocity.map((value, axis) =>
              (value - previousLinearVelocity![axis]!) / midpointDelta));
            if (linearAcceleration > maximumSampledLinearAccelerationStudsPerSecondSquared) {
              maximumSampledLinearAccelerationStudsPerSecondSquared = linearAcceleration;
              maximumLinearAccelerationInterval = { from: samples[index - 2]!.at, to: current.at };
            }
            if (previousAngularVelocity !== null) {
              const transportedAngularVelocity = transportVectorBetweenQuaternionFrames(
                previousAngularVelocity, previousAngularFrame!, previous.pose.rotationQuaternion);
              const angularAcceleration = Math.hypot(...angularVelocity.map((value, axis) =>
                (value - transportedAngularVelocity[axis]!) / midpointDelta));
              if (angularAcceleration > maximumSampledAngularAccelerationDegreesPerSecondSquared) {
                maximumSampledAngularAccelerationDegreesPerSecondSquared = angularAcceleration;
                maximumAngularAccelerationInterval = { from: samples[index - 2]!.at, to: current.at };
              }
              const angularSpeedChange = Math.abs(angularSpeed - Math.hypot(previousAngularVelocity[0], previousAngularVelocity[1], previousAngularVelocity[2])) / midpointDelta;
              if (angularSpeedChange > maximumSampledAngularSpeedChangeDegreesPerSecondSquared) {
                maximumSampledAngularSpeedChangeDegreesPerSecondSquared = angularSpeedChange;
                maximumAngularSpeedChangeInterval = { from: samples[index - 2]!.at, to: current.at };
              }
            }
          }
        }
        previousLinearVelocity = linearVelocity;
        previousAngularVelocity = angularVelocity;
        previousAngularFrame = previous.pose.rotationQuaternion;
        previousIntervalMidpoint = intervalMidpoint;
      }
      return { joint, sampleCount: samples.length, intervalCount: Math.max(0, samples.length - 1),
        maximumSampledLinearSpeedStudsPerSecond, maximumLinearSpeedInterval,
        maximumSampledAngularSpeedDegreesPerSecond, maximumAngularSpeedInterval,
        maximumSampledLinearAccelerationStudsPerSecondSquared, maximumLinearAccelerationInterval,
        maximumSampledAngularSpeedChangeDegreesPerSecondSquared, maximumAngularSpeedChangeInterval,
        maximumSampledAngularAccelerationDegreesPerSecondSquared, maximumAngularAccelerationInterval };
    }),
    limitation: 'Speeds are maximum finite differences between returned local-pose samples. Linear acceleration is the magnitude of change in sampled local translation velocity. Angular acceleration is the magnitude of change in shortest-arc local angular-velocity vectors between adjacent intervals, after transporting the earlier vector into the newer interval start frame; angular-speed change separately reports only scalar magnitude change. These are sampled diagnostics, not continuous-time, rendered/world-space, or quality judgments. For all_generated_blend_samples, sampleRateHz identifies the uniform observation grid supplemented by exact event/request times. For explicit_sample_times, estimates use only caller-selected intervals; changing requested times can change measured maxima. Nonuniform intervals use the elapsed time between adjacent interval midpoints. sampleCount, coverageStartAt, coverageEndAt, maximumSampleGapSeconds, and maximumSampleGapInterval expose actual coverage; estimates depend on sampling density and blend-model fidelity.' as const,
  };

  const blendPhaseControllers = graph.states.filter(isBlendController);
  const phaseSynchronizationRequests = blendPhaseControllers.map(controller => {
    const sourceStateIds = blendSources(controller).map(sample => sample.stateId);
    const sourceDurations = new Map(sourceStateIds.map(sourceStateId => {
      const duration = observedBlendLengthsByController.get(controller.id)?.get(sourceStateId)
        ?? recipeByState.get(sourceStateId)!.duration;
      return [sourceStateId, duration] as const;
    }));
    return { controllerStateId: controller.id, sourceStateIds, sourceDurations };
  });
  const phaseSynchronizationResults = analyzeBlendSpacePhaseSynchronizationBatch(blendSamples, phaseSynchronizationRequests);
  const blendPhaseSynchronization = blendPhaseControllers.map((controller, index) => {
    return { controllerStateId: controller.id,
      ...phaseSynchronizationResults[index]!,
      measurementBasis: 'sampled_points_and_constant_speed_intervals' as const,
      limitation: 'Circular normalized phase differences are estimates from the selected authored or asset-bound live timing maps. Between sampled timestamps, playback speed is assumed constant until the next simulation event/sample boundary. Coverage status and active, incomplete, unevaluable, and evaluated point/interval counts are explicit; not-observed or incomplete coverage is not a passing result.' as const };
  });

  return {
    schemaVersion: 1,
    graphFingerprint: animationGraphFingerprint(graph),
    duration: input.duration,
    entryState: graph.entryState,
    finalState: state,
    finalParameters: parameters,
    finalPlaybackSpeedMultiplier: playbackSpeedMultiplier,
    transitionIds,
    triggeredMarkers,
    processedEvents,
    scheduledEvents,
    decisionDiagnostics: { detailedTriggerEvaluations, truncatedTriggerEvaluations, detailedBytes: guardDiagnosticBytes,
      maxDetailedBytes: MAX_GUARD_DIAGNOSTIC_BYTES },
    outOfWindowEvents: input.events.flatMap((event, index) => event.at > input.duration
      ? [{ inputIndex: index, at: event.at, kind: event.kind }] : []),
    incompleteParameterRamps: [...activeParameterRamps.entries()].flatMap(([inputIndex, ramp]) => {
      const authored = input.events[inputIndex];
      if (authored?.kind !== 'ramp_parameters' || ramp.activeNames.size === 0) return [];
      const progress = Math.max(0, Math.min(1, (input.duration - authored.at) / authored.duration));
      const easedProgress = ramp.easing === 'smoothstep' ? progress * progress * (3 - 2 * progress) : progress;
      return [{ inputIndex, startedAt: authored.at, authoredDurationSeconds: ramp.duration,
        simulatedProgress: progress, easedProgress, easing: ramp.easing,
        remainingSecondsAtHorizon: Math.max(0, authored.at + ramp.duration - input.duration),
        parameters: [...ramp.activeNames].sort((left, right) => left.localeCompare(right)).map(name => ({
          name, currentValue: parameters[name] as number, targetValue: ramp.targetValues[name]!,
        })) }];
    }).sort((left, right) => left.inputIndex - right.inputIndex),
    parameterRampLifecycle: [...parameterRampLifecycle.entries()].flatMap(([inputIndex, lifecycle]) => {
      if (lifecycle.startedAt > input.duration) return [];
      const channels = [...lifecycle.channels.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, channel]) => ({
        name, ...channel, observedValue: channel.status === 'active' ? parameters[name] as number : channel.observedValue,
      }));
      const statuses = new Set(channels.map(channel => channel.status));
      const status = statuses.size === 1 ? channels[0]!.status
        : statuses.has('interrupted') ? 'partially_interrupted' as const : 'mixed' as const;
      return [{ inputIndex, startedAt: lifecycle.startedAt, duration: lifecycle.duration, easing: lifecycle.easing, status, channels }];
    }).sort((left, right) => left.inputIndex - right.inputIndex),
    timeline,
    blendModel: { kind: usedFadeProfiles.size > 0 ? 'studio_calibrated_curve_per_track_estimate' as const : 'linear_per_track_weight_estimate' as const,
      calibrationProfileIds: [...usedFadeProfiles].sort(), sampleRate: sampleRateHz, sampleCount: blendSamples.length, trackSampleCount,
      phaseSynchronization: blendPhaseSynchronization,
      playbackTiming: { calibratedControllerCount: observedBlendLengthsByController.size,
        assetSetFingerprint: input.observedBlendAnimationAssetSetFingerprint ?? null,
        assetSetFingerprintStatus: input.observedBlendAnimationAssetSetFingerprint === undefined ? 'not_supplied' as const : 'matched' as const,
        controllers: graph.states.filter(isBlendController).map(controller => {
          const measuredLengths = observedBlendLengthsByController.get(controller.id);
          const controllerRecipe = recipeByState.get(controller.id)!;
          const measuredSpeeds = observedBlendSpeedsByController.get(controller.id);
          const controllerLength = measuredLengths?.get(controller.id) ?? controllerRecipe.duration;
          const controllerSpeed = measuredSpeeds?.get(controller.id) ?? controller.speed;
          const controllerCycleDurationSeconds = controllerLength / controllerSpeed;
          return { controllerStateId: controller.id, source: measuredLengths ? 'observed_roblox_lengths_and_speeds' as const : 'authored_recipe_durations' as const,
            controllerCycleDurationSeconds,
            clips: blendSources(controller).map(sample => {
              const sourceRecipe = recipeByState.get(sample.stateId)!;
              const measuredLength = measuredLengths?.get(sample.stateId);
              const measuredSpeed = measuredSpeeds?.get(sample.stateId);
              const playbackSpeed = measuredSpeed
                ?? (measuredLengths && measuredLength !== undefined
                  ? controller.speed * measuredLength / measuredLengths.get(blendSources(controller)[0]!.stateId)!
                  : controller.speed * sourceRecipe.duration / controllerRecipe.duration);
              const playbackCycleDurationSeconds = (measuredLength ?? sourceRecipe.duration) / playbackSpeed;
              return { stateId: sample.stateId, observedLengthSeconds: measuredLength ?? null,
                observedStartPhase: observedBlendStartPhasesByController.get(controller.id)?.get(sample.stateId) ?? null,
                playbackSpeed, playbackCycleDurationSeconds,
                playbackCycleDurationRatioToController: playbackCycleDurationSeconds / controllerCycleDurationSeconds };
            }) };
        }),
        limitation: observedBlendLengthsByController.size > 0
          ? 'Observed Roblox Length and Speed values are caller-supplied and were not independently authenticated by the simulator. Every sample must be measured; actual speeds preserve the live synchronized or unsynchronized clock state. Per-clip playbackCycleDurationSeconds and playbackCycleDurationRatioToController expose modeled cycle timing relative to the controller at the captured speed; later global speed changes scale these durations uniformly. Optional captured start phases seed each clock before the simulation advances; authored poses/markers are mapped by normalized phase.'
          : 'No observed Roblox Length/Speed calibration was supplied; BlendSpace timing uses authored recipe duration ratios and reports the inferred per-clip cycle timing relative to the controller. Runtime asset timing can differ; capture both maps from GetBlendState() and rerun.' },
      limitation: usedFadeProfiles.size > 0
        ? 'Track weights use piecewise-linear interpolation of the selected fingerprint-verified Studio WeightCurrent fade samples when state and fade duration match exactly; unmatched fade durations retain a linear estimate. When a fade is interrupted, the measured curve shape is normalized and rebased from the track’s current weight to its new target; per-track weights are not normalized together. If the exact selected profile includes a repeated-Play probe, its observed clock behavior is applied to transitions targeting an already-playing track; ambiguous or absent probes fall back to an explicitly reported restart assumption. Runtime scheduling, engine-version differences, replication and gameplay are not reproduced.'
        : 'Track weights are modeled as independent linear fade envelopes from AnimationTrack:Play/Stop calls and are not normalized. Play fades begin at the cached destination track’s current weight. Optional composedPoseSamples apply a separate per-joint priority-weight estimate; neither model reproduces engine fade curves or runtime scheduling. When no exact matched repeated-Play probe is supplied, retriggering an already-playing destination is modeled as a restart assumption and is reported per transition.' },
    playbackRetriggerModel: animationGraphPlaybackRetriggerModelSchema.parse({ measuredPreservedClockTransitions: playbackRetriggerCounts.measuredPreserved,
      measuredResetClockTransitions: playbackRetriggerCounts.measuredReset,
      ambiguousProbeAssumedResetTransitions: playbackRetriggerCounts.ambiguousProbeAssumedReset,
      unmeasuredAssumedResetTransitions: playbackRetriggerCounts.unmeasuredAssumedReset,
      limitation: 'Only an exact selected state/fade-duration profile with a persisted Studio Play-retrigger probe controls an already-playing track clock. An ambiguous or missing observation does not guess; it retains the restart estimate and is counted separately.' }),
    blendSamples,
    poseModel: { algorithmVersion: animationGraphPoseModelAlgorithmVersion, kind: 'priority_weighted_local_pose_estimate', sampleCount: composedPoseSamples.length,
      jointSampleCount: composedPoseSamples.reduce((sum, sample) => sum + sample.joints.length, 0),
      contributionCount: composedPoseContributionCount,
      unanimatedTrackJointCount,
      compositionSourceCount: poseCompositionSourceCount,
      residualBasis: 'identity_local_animation_delta' as const,
      limitation: 'Per-joint priority budgets and local recipe transforms are composed deterministically. BlendSpace1D evaluates adjacent clip weights from the current numeric parameter and samples source clips at the controller playback phase normalized to each source duration. Translation uses weighted local offsets; rotation uses the order-independent Markley weighted quaternion mean, an approximation of Roblox native weighted pose blending. Missing channels retain identity-local residual weight; this is not the rig’s authored rest CFrame. No rig rest baseline is applied. Rig hierarchy, engine fade curves, exact native rotation blending, runtime scheduling, rendering, and root/world-space motion are not evaluated. Blend source priority, loop settings, and normalized markers must match the controller.' },
    poseMotionDiagnostics,
    loadFailureSimulation: { unavailableStateIds: input.unavailableStateIds,
      count: timeline.filter(event => event.event === 'transition_failed' && event.failureReason === 'destination_animation_unavailable').length,
      limitation: 'Opt-in destination-load fault injection models a selected transition failing before runtime state/track/parameter changes. It does not model preloadAll failures, intermittent network/permission conditions, or per-asset retry behavior.' },
    animationEndedTiming: { kind: 'assumed_natural_completion_fade', assumedAdditionalFadeSeconds: naturalCompletionFadeSeconds,
      source: summaryTiming.source,
      stateTimings: graph.states.filter(graphState => !recipeByState.get(graphState.id)!.loop).map(graphState => {
        const timing = naturalCompletionForState(graphState.id);
        const usesMeasuredLength = timing.profile?.naturalCompletion !== undefined;
        const animationLengthSeconds = usesMeasuredLength ? timing.profile!.naturalCompletion!.animationLengthSeconds
          : recipeByState.get(graphState.id)!.duration;
        const clipPlaybackSeconds = animationLengthSeconds / stateById.get(graphState.id)!.speed;
        return { stateId: graphState.id, fadeSeconds: timing.fadeSeconds, source: timing.source,
          calibrationProfileId: timing.profile?.id ?? null,
          measuredAnimationLengthSeconds: timing.profile?.naturalCompletion?.animationLengthSeconds ?? null,
          calibrationConflictProfileIds: naturalCompletionConflictByState.get(graphState.id)?.candidates.map(candidate => candidate.profileId) ?? [],
          animationLengthMatchesRecipe: timing.animationLengthMatchesRecipe, animationLengthSeconds,
          animationLengthSource: usesMeasuredLength ? 'studio_measured' as const : 'authored_recipe' as const,
          clipPlaybackSeconds, animationEndedAfterPlaybackStartSeconds: clipPlaybackSeconds + timing.fadeSeconds };
      }),
      naturalCompletionConflicts: [...naturalCompletionConflictByState].filter(([stateId]) => !recipeByState.get(stateId)!.loop)
        .map(([stateId, conflict]) => ({ stateId, ...conflict })),
      summaryStateId: graph.entryState, summaryScope: input.naturalCompletionFadeSeconds !== undefined ? 'caller_global_override' as const : 'entry_state' as const,
      calibrationProfileId: summaryTiming.profile?.id ?? null,
      measuredAnimationLengthSeconds: summaryTiming.profile?.naturalCompletion?.animationLengthSeconds ?? null,
    limitation: 'The simulator schedules non-looping playback from measured AnimationTrack.Length whenever a selected fingerprint-verified profile is unambiguous, even if that length differs from the authored recipe duration; the mismatch remains explicitly reported. A mismatched profile does not supply its measured natural-fade duration or curve, so additional fade defaults to zero unless the caller supplies an assumption. Matching measured WeightCurrent samples shape the natural fade only when measured length matches recipe duration within one sample interval. Natural-completion samples are empirical for that Studio rig/build, not a guarantee for other versions, assets, or live gameplay scheduling. Validate timing against the target rig and Studio build before relying on completion behavior.' },
    composedPoseSamples,
    trackLifecycles,
    eventOrderingDiagnostics,
    simulatedThrough: input.duration,
    limitation: `Deterministic estimate from authored recipe durations or fingerprint-verified measured AnimationTrack.Length when an unambiguous natural-completion profile exists for a non-looping state; measured fade curves require the measured length to match the authored recipe within one sample interval. Marker offsets, graph playback speeds and zero-latency event ordering are also modeled. Blend samples track independent per-state fade envelopes, including overlapping fades and interruptions; ${usedFadeProfiles.size > 0
      ? 'fingerprint-verified Studio WeightCurrent curves are piecewise-linearly interpolated only for exact state/fade-duration matches, while unmatched fades remain linear; interrupted calibrated fades rebase the normalized measured curve shape from the current weight to the new target.'
      : 'fade envelopes are linear because no matching Studio calibration curves were applied.'} Track weights are not normalized, and Play fades begin at the cached destination track’s current weight. For an already-playing destination, only an exact selected fade calibration’s repeated-Play probe overrides the restart estimate; missing or ambiguous observations are counted in playbackRetriggerModel and retain the restart assumption. Optional composedPoseSamples apply per-joint priority budgets to local recipe transforms, but do not reproduce exact Roblox pose averaging, rig hierarchy/world-space motion, track loading, frame timing, replication, or gameplay effects. These Roblox runtime behaviors are not executed; simultaneous external/runtime events use deterministic queue insertion order, not a Roblox ordering guarantee. Verify behavior in Studio and the target game.`,
  };
}

/** Optionally compares both deterministic tie-order policies; neither is asserted to match Roblox callback scheduling. */
export function simulateAnimationGraphTimeline(graphInput: unknown, recipesByAnimationIdInput: unknown, inputValue: unknown, fadeProfilesInput: unknown = []) {
  const input = animationGraphSimulationInputSchema.parse(inputValue);
  const baseline = simulateAnimationGraphTimelineOnce(graphInput, recipesByAnimationIdInput, input, 'user_inputs_first', fadeProfilesInput);
  if (!input.analyzeEventOrderSensitivity) return enforceSimulationOutputLimit({ ...baseline, eventOrderSensitivity: null });
  // The final sensitivity report necessarily contains the full baseline. If that
  // report alone is already too large, avoid paying for a second full simulation.
  assertSimulationOutputWithinLimit(baseline);
  const alternate = simulateAnimationGraphTimelineOnce(graphInput, recipesByAnimationIdInput,
    input, 'runtime_callbacks_first', fadeProfilesInput);
  let firstDifferenceIndex = baseline.timeline.findIndex((entry, index) => stableSerialize(entry) !== stableSerialize(alternate.timeline[index]));
  if (firstDifferenceIndex < 0 && baseline.timeline.length !== alternate.timeline.length) {
    firstDifferenceIndex = Math.min(baseline.timeline.length, alternate.timeline.length);
  }
  const firstDifference = firstDifferenceIndex >= 0
    ? { baseline: baseline.timeline[firstDifferenceIndex] ?? null, alternate: alternate.timeline[firstDifferenceIndex] ?? null }
    : baseline.timeline.length !== alternate.timeline.length
      ? { baseline: baseline.timeline[firstDifferenceIndex] ?? null, alternate: alternate.timeline[firstDifferenceIndex] ?? null }
      : null;
  const transitionIdsChanged = stableSerialize(baseline.transitionIds) !== stableSerialize(alternate.transitionIds);
  const finalParametersChanged = stableSerialize(baseline.finalParameters) !== stableSerialize(alternate.finalParameters);
  const finalStateChanged = baseline.finalState !== alternate.finalState;
  const markerEventsChanged = stableSerialize(baseline.triggeredMarkers) !== stableSerialize(alternate.triggeredMarkers);
  const blendSamplesChanged = sampledOutputsDifferAtCommonTimes(baseline.blendSamples, alternate.blendSamples);
  const composedPoseSamplesChanged = sampledOutputsDifferAtCommonTimes(baseline.composedPoseSamples, alternate.composedPoseSamples);
  const blendSampleTimeCoverage = sampleTimeCoverage(baseline.blendSamples, alternate.blendSamples);
  const composedPoseSampleTimeCoverage = sampleTimeCoverage(baseline.composedPoseSamples, alternate.composedPoseSamples);
  const sampleComparisonComplete = blendSampleTimeCoverage.baselineOnly === 0 && blendSampleTimeCoverage.alternateOnly === 0
    && composedPoseSampleTimeCoverage.baselineOnly === 0 && composedPoseSampleTimeCoverage.alternateOnly === 0;
  const timelineChanged = firstDifference !== null;
  const divergenceCount = [finalStateChanged, transitionIdsChanged, finalParametersChanged, markerEventsChanged, timelineChanged,
    blendSamplesChanged, composedPoseSamplesChanged].filter(Boolean).length;
  const eventOrderSensitivity = {
    kind: 'user_first_vs_runtime_callbacks_first',
    status: divergenceCount > 0 ? 'divergent' as const : 'equivalent' as const,
    baselinePolicy: 'user inputs before runtime callbacks; authored order within each source' as const,
    alternatePolicy: 'runtime callbacks before user inputs; authored order within each source' as const,
    finalStateChanged, transitionIdsChanged, finalParametersChanged, markerEventsChanged, timelineChanged,
    blendSamplesChanged, composedPoseSamplesChanged, sampleComparisonScope: 'exact_shared_timestamps_only' as const,
    sampleComparisonComplete, blendSampleTimeCoverage, composedPoseSampleTimeCoverage, divergenceCount,
    gate: input.maxEventOrderDivergences === undefined ? null : {
      status: divergenceCount <= input.maxEventOrderDivergences && sampleComparisonComplete ? 'passed' as const : 'failed' as const,
      maximumAllowedDivergences: input.maxEventOrderDivergences, observedDivergences: divergenceCount, sampleComparisonComplete },
    firstTimelineDifference: firstDifference,
    baselineOutcome: { finalState: baseline.finalState, transitionIds: baseline.transitionIds, finalParameters: baseline.finalParameters,
      triggeredMarkerCount: baseline.triggeredMarkers.length },
    alternateOutcome: { finalState: alternate.finalState, transitionIds: alternate.transitionIds, finalParameters: alternate.finalParameters,
      triggeredMarkerCount: alternate.triggeredMarkers.length },
    limitation: 'This compares two explicit deterministic tie-order policies to expose schedule-sensitive graph behavior. Blend and composed-pose values are compared only at exact shared timestamps; sampleComparisonScope and timestamp-coverage counts disclose points not compared, and no interpolation is performed. It does not reproduce or predict Roblox callback ordering; use it to find fragile same-timestamp designs, then validate on the target rig and runtime.',
  };
  return enforceSimulationOutputLimit({ ...baseline, eventOrderSensitivity: animationGraphEventOrderSensitivitySchema.parse(eventOrderSensitivity) });
}

function enforceSimulationOutputLimit<T>(output: T): T {
  assertSimulationOutputWithinLimit(output);
  return output;
}

function assertSimulationOutputWithinLimit(output: unknown): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (serializedBytes > MAX_SIMULATION_OUTPUT_BYTES) {
    throw new Error(`Animation graph simulation serialized output is ${serializedBytes} bytes, above the ${MAX_SIMULATION_OUTPUT_BYTES} byte (8 MiB) safety limit. Reduce sampleRateHz or simulation duration, request fewer poseJoints, use explicit sampleTimes instead of includeBlendSamplePoses, disable includePoseSamples, or omit analyzeEventOrderSensitivity.`);
  }
}
