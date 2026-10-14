import { createHash } from 'node:crypto';
import { z } from 'zod';
import { animationGraphFingerprint, animationGraphSchema } from './animation-graph.js';
import { animationGraphSimulationInputShape, simulateAnimationGraphTimeline } from './animation-graph-simulation.js';
import { easeProgress } from './easing.js';
import { animationSchema, label } from './recipes.js';
import { studioPlayRetriggerProbeSchema, type StudioBuildIdentity } from './animation-graph-fade-calibrations.js';
import { quaternionAngularDistanceDegrees, quaternionAngularVelocityDegrees, transportVectorBetweenQuaternionFrames,
  type Quaternion4 } from './quaternion-blend.js';
import { analyzeBlendSpacePhaseSynchronization } from './animation-graph-phase-sync.js';

const stateId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const transitionId = stateId;
const markerExpectation = z.object({ name: label, minCount: z.number().int().min(0).max(100), maxCount: z.number().int().min(0).max(100).optional(),
  window: z.object({ start: z.number().finite().min(0).max(120), end: z.number().finite().min(0).max(120) }).strict().optional() }).strict()
  .superRefine((expectation, context) => {
    if (expectation.maxCount !== undefined && expectation.maxCount < expectation.minCount) context.addIssue({ code: 'custom', path: ['maxCount'], message: 'maxCount cannot be less than minCount.' });
    if (expectation.window && expectation.window.start > expectation.window.end) context.addIssue({ code: 'custom', path: ['window'], message: 'Marker window start cannot exceed end.' });
  });

const unitRange = z.object({ min: z.number().finite().min(0).max(1).optional(), max: z.number().finite().min(0).max(1).optional() }).strict()
  .superRefine((range, context) => {
    if (range.min === undefined && range.max === undefined) context.addIssue({ code: 'custom', message: 'Provide a minimum, maximum, or both.' });
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) context.addIssue({ code: 'custom', message: 'Minimum cannot exceed maximum.' });
  });
const secondsRange = z.object({ min: z.number().finite().min(0).max(120).optional(), max: z.number().finite().min(0).max(120).optional() }).strict()
  .superRefine((range, context) => {
    if (range.min === undefined && range.max === undefined) context.addIssue({ code: 'custom', message: 'Provide a minimum, maximum, or both.' });
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) context.addIssue({ code: 'custom', message: 'Minimum cannot exceed maximum.' });
  });

type SampledLocalPose = { position: [number, number, number]; rotationQuaternion: Quaternion4 };
type PoseWindowSample = { at: number; pose?: SampledLocalPose };
type MotionGateGuidance = { kind: 'sampled_threshold_exceeded' | 'insufficient_contiguous_samples'; interpretation: string;
  suggestedNextStep: string; limitation: string };
function measureSampledPoseMotion(samples: readonly PoseWindowSample[]) {
  const intervals = samples.slice(1).flatMap((current, index) => {
    const previous = samples[index]!;
    if (!previous.pose || !current.pose) return [];
    const seconds = current.at - previous.at;
    if (seconds <= 0) return [];
    const linearVelocity = current.pose.position.map((value, axis) =>
      (value - previous.pose!.position[axis]!) / seconds) as [number, number, number];
    const angularVelocity = quaternionAngularVelocityDegrees(previous.pose.rotationQuaternion, current.pose.rotationQuaternion, seconds);
    return [{ from: previous.at, to: current.at, seconds,
      linearStepStuds: Math.hypot(...current.pose.position.map((value, axis) => value - previous.pose!.position[axis]!)),
      angularStepDegrees: quaternionAngularDistanceDegrees(previous.pose.rotationQuaternion, current.pose.rotationQuaternion),
      linearVelocity, angularVelocity, angularFrame: previous.pose.rotationQuaternion,
      linearSpeedStudsPerSecond: Math.hypot(...linearVelocity),
      angularSpeedDegreesPerSecond: Math.hypot(...angularVelocity) }];
  });
  const accelerations = intervals.slice(1).flatMap((current, index) => {
    const previous = intervals[index]!;
    if (previous.to !== current.from) return [];
    const midpointDelta = (current.from + current.to - previous.from - previous.to) / 2;
    if (midpointDelta <= 0) return [];
    const transportedAngularVelocity = transportVectorBetweenQuaternionFrames(previous.angularVelocity,
      previous.angularFrame, current.angularFrame);
    return [{ from: previous.from, to: current.to, midpointDelta,
      linearAccelerationStudsPerSecondSquared: Math.hypot(...current.linearVelocity.map((value, axis) =>
        (value - previous.linearVelocity[axis]!) / midpointDelta)),
      angularAccelerationDegreesPerSecondSquared: Math.hypot(...current.angularVelocity.map((value, axis) =>
        (value - transportedAngularVelocity[axis]!) / midpointDelta)),
      angularSpeedChangeDegreesPerSecondSquared: Math.abs(Math.hypot(...current.angularVelocity)
        - Math.hypot(...previous.angularVelocity)) / midpointDelta }];
  });
  return { intervals, accelerations };
}
const numericRange = z.object({ min: z.number().finite().optional(), max: z.number().finite().optional() }).strict()
  .superRefine((range, context) => {
    if (range.min === undefined && range.max === undefined) context.addIssue({ code: 'custom', message: 'Provide a minimum, maximum, or both.' });
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) context.addIssue({ code: 'custom', message: 'Minimum cannot exceed maximum.' });
  });
const parameterRampExpectation = z.object({
  inputIndex: z.number().int().min(0).max(511),
  simulatedProgress: unitRange.optional(), easedProgress: unitRange.optional(), remainingSecondsAtHorizon: secondsRange.optional(),
  parameters: z.array(z.object({ name: stateId, currentValue: numericRange.optional(), targetValue: numericRange.optional() }).strict()
    .superRefine((parameter, context) => {
      if (parameter.currentValue === undefined && parameter.targetValue === undefined) {
        context.addIssue({ code: 'custom', message: 'Check the current value, target value, or both.' });
      }
    })).min(1).max(64),
}).strict().superRefine((expectation, context) => {
  if (expectation.simulatedProgress === undefined && expectation.easedProgress === undefined
    && expectation.remainingSecondsAtHorizon === undefined) {
    context.addIssue({ code: 'custom', message: 'Check progress, eased progress, remaining time, or a combination.' });
  }
  if (new Set(expectation.parameters.map(parameter => parameter.name)).size !== expectation.parameters.length) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Each ramp parameter can be asserted only once.' });
  }
});
const parameterRampLifecycleExpectation = z.object({
  inputIndex: z.number().int().min(0).max(511),
  status: z.enum(['active', 'completed', 'interrupted', 'partially_interrupted', 'mixed']).optional(),
  parameters: z.array(z.object({ name: stateId, status: z.enum(['active', 'completed', 'interrupted']).optional(),
    observedValue: numericRange.optional(), targetValue: numericRange.optional(), endedAt: secondsRange.optional() }).strict()
    .superRefine((parameter, context) => {
      if (parameter.status === undefined && parameter.observedValue === undefined && parameter.targetValue === undefined && parameter.endedAt === undefined) {
        context.addIssue({ code: 'custom', message: 'Assert a channel outcome, observed value, target value, or outcome time.' });
      }
    })).max(64).default([]),
}).strict().superRefine((expectation, context) => {
  if (expectation.status === undefined && expectation.parameters.length === 0) {
    context.addIssue({ code: 'custom', message: 'Assert the ramp outcome, at least one channel, or both.' });
  }
  if (new Set(expectation.parameters.map(parameter => parameter.name)).size !== expectation.parameters.length) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Each ramp channel can be asserted only once.' });
  }
});
const trackLifecycleExpectation = z.object({
  stateId,
  status: z.enum(['not_started', 'playing', 'stopped', 'stopped_fading', 'completed']).optional(),
  playbackCount: z.number().int().min(0).max(10000).optional(),
  latestEndReason: z.enum(['natural_completion', 'transition']).nullable().optional(),
}).strict().superRefine((expectation, context) => {
  if (expectation.status === undefined && expectation.playbackCount === undefined && expectation.latestEndReason === undefined) {
    context.addIssue({ code: 'custom', message: 'Assert track status, playback count, latest end reason, or a combination.' });
  }
});
const phaseDonorExpectation = z.object({
  inputIndex: z.number().int().min(0).max(511),
  at: z.number().finite().min(0).max(120).optional(),
  stateId,
  restartedStateIds: z.array(stateId).max(16).optional(),
  normalizedPhase: unitRange.optional(),
  currentWeight: unitRange.optional(),
  targetWeight: unitRange.optional(),
}).strict().superRefine((expectation, context) => {
  if (expectation.restartedStateIds && new Set(expectation.restartedStateIds).size !== expectation.restartedStateIds.length) {
    context.addIssue({ code: 'custom', path: ['restartedStateIds'], message: 'Restarted source state IDs must be unique.' });
  }
});
const blendSpaceExpectation = z.object({ parameterValue: numericRange.optional(),
  parameterValues: z.object({ x: numericRange.optional(), y: numericRange.optional() }).strict().optional(),
  phaseSync: z.object({ stateIds: z.array(stateId).min(2).max(16), maxCircularPhaseDifference: z.number().finite().min(0).max(0.5) })
    .strict().optional().describe('Assert that named BlendSpace source playback clocks remain phase-locked. Difference is measured in normalized cycles with wraparound, so phases 0.99 and 0.01 differ by 0.02.'),
  phaseSyncThroughout: z.object({ stateIds: z.array(stateId).min(2).max(16), maxCircularPhaseDifference: z.number().finite().min(0).max(0.5) })
    .strict().optional().describe('Gate the maximum circular normalized-phase difference between named sources across sampled timestamps and linearly evaluated intervals between them while this controller is active. Playback-clock speeds are constant within each simulated interval; every compared source must remain playing. The report identifies active, incomplete, unevaluable and evaluated interval counts plus the worst time, interval and pair; it fails closed if an active interval cannot be measured.'),
  clips: z.array(z.object({ stateId, weight: unitRange.optional(), poseContributionWeight: unitRange.optional(),
    targetPoseContributionWeight: unitRange.optional(), playback: z.object({ timeSeconds: secondsRange.optional(),
      normalizedPhase: unitRange.optional(), playbackSpeed: numericRange.optional(), playbackCycleDurationSeconds: secondsRange.optional(),
      playbackCycleDurationRatioToController: numericRange.optional(), isPlaying: z.boolean().optional() }).strict().optional() }).strict()
    .superRefine((clip, context) => {
      const hasPlaybackAssertion = clip.playback !== undefined && Object.values(clip.playback).some(value => value !== undefined);
      if (clip.weight === undefined && clip.poseContributionWeight === undefined && clip.targetPoseContributionWeight === undefined && !hasPlaybackAssertion) {
        context.addIssue({ code: 'custom', message: 'A clip assertion must check sample weight, pose contribution, playback time, normalized phase, playback speed, playing state, or a combination.' });
      }
    })).min(1).max(16).optional() }).strict().superRefine((expectation, context) => {
  if (expectation.parameterValue === undefined && expectation.parameterValues === undefined && expectation.clips === undefined && expectation.phaseSync === undefined
    && expectation.phaseSyncThroughout === undefined) {
    context.addIssue({ code: 'custom', message: 'A blend-space assertion must check the parameter value, source clip properties, or source phase synchronization.' });
  }
  if (expectation.clips && new Set(expectation.clips.map(clip => clip.stateId)).size !== expectation.clips.length) {
    context.addIssue({ code: 'custom', path: ['clips'], message: 'A source clip can be asserted only once per blend sample.' });
  }
  if (expectation.phaseSync && new Set(expectation.phaseSync.stateIds).size !== expectation.phaseSync.stateIds.length) {
    context.addIssue({ code: 'custom', path: ['phaseSync', 'stateIds'], message: 'Phase-sync source state IDs must be unique.' });
  }
  if (expectation.phaseSyncThroughout && new Set(expectation.phaseSyncThroughout.stateIds).size !== expectation.phaseSyncThroughout.stateIds.length) {
    context.addIssue({ code: 'custom', path: ['phaseSyncThroughout', 'stateIds'], message: 'Throughout phase-sync source state IDs must be unique.' });
  }
});
const blendExpectation = z.object({
  at: z.number().finite().min(0).max(120), stateId, present: z.boolean().optional(),
  weight: unitRange.optional(), targetWeight: unitRange.optional(), fadeRemainingSeconds: secondsRange.optional(), playbackTimeSeconds: secondsRange.optional(),
  isPlaying: z.boolean().optional(), isAffectingPose: z.boolean().optional(),
  blendSpace: blendSpaceExpectation.optional().describe('For a BlendSpace1D or BlendSpace2D controller state, assert parameter coordinates, normalized source weights, estimated current/target source-track pose contributions, per-source playback time/phase/playing state, phase synchronization at this exact timestamp, or maximum phase drift throughout the sampled run. Use parameterValue for 1D and parameterValues.x/y for 2D. By default, timing uses authored recipes; provide both observedBlendAnimationLengths and observedBlendAnimationPlaybackSpeeds, plus optional observedBlendAnimationStartPhases, on the case to model live Roblox timing accurately.'),
}).strict().superRefine((expectation, context) => {
  const hasTrackAssertion = expectation.weight !== undefined || expectation.targetWeight !== undefined
    || expectation.fadeRemainingSeconds !== undefined || expectation.playbackTimeSeconds !== undefined
    || expectation.isPlaying !== undefined || expectation.isAffectingPose !== undefined || expectation.blendSpace !== undefined;
  if (expectation.present === undefined && !hasTrackAssertion) context.addIssue({ code: 'custom', message: 'Each blend assertion must check track presence or at least one track property.' });
  if (expectation.present === false && hasTrackAssertion) context.addIssue({ code: 'custom', message: 'A track expected to be absent cannot also have track-property assertions.' });
});
const blendSourceThroughoutExpectation = z.object({
  start: z.number().finite().min(0).max(120), end: z.number().finite().min(0).max(120),
  sampleRateHz: z.number().int().min(1).max(120).default(30),
  effectiveWeight: unitRange.optional(),
  maxSampleGapSeconds: z.number().finite().min(0).max(10).optional(),
  maxLinearSpeedStudsPerSecond: z.number().finite().min(0).max(100000).optional(),
  maxAngularSpeedDegreesPerSecond: z.number().finite().min(0).max(3600000).optional(),
  maxLinearAccelerationStudsPerSecondSquared: z.number().finite().min(0).max(100000000).optional()
    .describe('Optional source-channel finite-difference gate for local translation-velocity change; needs three consecutive covered samples.'),
  maxAngularAccelerationDegreesPerSecondSquared: z.number().finite().min(0).max(3600000000).optional()
    .describe('Optional source-channel finite-difference gate for local angular-velocity-vector change; frame-transported and requires three consecutive covered samples.'),
  maxLinearStepStuds: z.number().finite().min(0).max(200).optional(),
  maxAngularStepDegrees: z.number().finite().min(0).max(180).optional(),
}).strict().superRefine((window, context) => {
  if (window.start > window.end) context.addIssue({ code: 'custom', path: ['end'], message: 'BlendSpace source window end cannot precede start.' });
  if (window.effectiveWeight === undefined && window.maxSampleGapSeconds === undefined
    && window.maxLinearSpeedStudsPerSecond === undefined && window.maxAngularSpeedDegreesPerSecond === undefined
    && window.maxLinearAccelerationStudsPerSecondSquared === undefined && window.maxAngularAccelerationDegreesPerSecondSquared === undefined
    && window.maxLinearStepStuds === undefined && window.maxAngularStepDegrees === undefined) {
    context.addIssue({ code: 'custom', message: 'A source throughout window must check effectiveWeight, sample gap, motion speed, acceleration, or step.' });
  }
});
const blendSourcePoseExpectation = z.object({
  controllerStateId: stateId, sourceStateId: stateId,
  effectiveWeight: unitRange.optional().describe('Optional assertion for this source’s final joint contribution after track-priority masking; distinct from its normalized BlendSpace source weight.'),
  throughout: blendSourceThroughoutExpectation.optional().describe('Optional sampled window gate for this source joint channel. Samples authored keys, easing extrema, and graph transition boundaries in addition to the uniform sample grid. Can cap local speed, acceleration, and pose steps. A source must contribute the joint at every checked time; acceleration requires three consecutive covered samples.'),
  expectedPosition: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  positionToleranceStuds: z.number().finite().min(0).max(100).optional(),
  expectedRotation: z.tuple([z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720)]).optional(),
  rotationToleranceDegrees: z.number().finite().min(0).max(180).optional(),
}).strict().superRefine((expectation, context) => {
  if (expectation.expectedPosition === undefined && expectation.expectedRotation === undefined
    && expectation.effectiveWeight === undefined && expectation.throughout === undefined) {
    context.addIssue({ code: 'custom', message: 'A BlendSpace source-pose assertion must check a transform, effectiveWeight, throughout window, or combination.' });
  }
  if ((expectation.expectedPosition === undefined) !== (expectation.positionToleranceStuds === undefined)) {
    context.addIssue({ code: 'custom', path: ['positionToleranceStuds'], message: 'Provide positionToleranceStuds exactly when expectedPosition is provided.' });
  }
  if ((expectation.expectedRotation === undefined) !== (expectation.rotationToleranceDegrees === undefined)) {
    context.addIssue({ code: 'custom', path: ['rotationToleranceDegrees'], message: 'Provide rotationToleranceDegrees exactly when expectedRotation is provided.' });
  }
});
type BlendSourcePoseExpectation = z.infer<typeof blendSourcePoseExpectation>;
const poseExpectation = z.object({
  at: z.number().finite().min(0).max(120), joint: label,
  blendSourcePoses: z.array(blendSourcePoseExpectation).max(64).optional()
    .describe('Optional exact-time and sampled-window assertions against each named BlendSpace source’s local joint pose before final inter-track pose blending. Position uses local recipe studs; rotation uses local XYZ degrees. Windows can gate effective weight, sampling gap, and source motion speed/acceleration/steps. These verify explicit authored-source criteria, not visual or artistic quality.'),
  missingBlendChannels: z.array(z.object({ controllerStateId: stateId, sourceStateId: stateId }).strict()).max(64).optional()
    .describe('Optional exact set of active BlendSpace controller/source pairs with positive current pose weight but no authored channel for this joint. An empty array asserts that none are missing. This checks authored-channel coverage, not whether the resulting pose is visually good.'),
  throughout: z.object({ start: z.number().finite().min(0).max(120), end: z.number().finite().min(0).max(120),
    sampleRateHz: z.number().int().min(1).max(120).default(30),
    maxSampleGapSeconds: z.number().finite().min(0).max(10).optional()
      .describe('Optional sampling-density assertion: the maximum time between adjacent composed-pose samples in this window. A failure reports the widest interval; this measures temporal coverage, not motion accuracy.'),
    maxLinearSpeedStudsPerSecond: z.number().finite().min(0).max(100000).optional(),
    maxAngularSpeedDegreesPerSecond: z.number().finite().min(0).max(3600000).optional(),
    maxLinearAccelerationStudsPerSecondSquared: z.number().finite().min(0).max(100000000).optional()
      .describe('Optional finite-difference gate for local translation-velocity change; requires three consecutive samples and uses actual interval-midpoint spacing.'),
    maxAngularAccelerationDegreesPerSecondSquared: z.number().finite().min(0).max(3600000000).optional()
      .describe('Optional finite-difference gate for local angular-velocity-vector change; earlier velocity is frame-transported into the newer interval start frame. Requires three consecutive samples and is not a rendered-quality guarantee.'),
    maxLinearStepStuds: z.number().finite().min(0).max(200).optional(),
    maxAngularStepDegrees: z.number().finite().min(0).max(180).optional() }).strict().optional(),
  expectedPosition: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  positionToleranceStuds: z.number().finite().min(0).max(100).optional(),
  expectedRotation: z.tuple([z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720), z.number().finite().min(-720).max(720)]).optional(),
  rotationToleranceDegrees: z.number().finite().min(0).max(180).optional(),
  studioCalibrationTolerance: z.object({ maxPositionErrorStuds: z.number().finite().min(0).max(100).optional(),
    maxRotationErrorDegrees: z.number().finite().min(0).max(180).optional() }).strict().optional(),
  rotationBlendConfidence: unitRange.optional(), rotationInfluence: unitRange.optional(),
}).strict().superRefine((expectation, context) => {
  if (expectation.expectedPosition === undefined && expectation.expectedRotation === undefined
    && expectation.rotationBlendConfidence === undefined && expectation.rotationInfluence === undefined
    && expectation.blendSourcePoses === undefined
    && expectation.missingBlendChannels === undefined
    && expectation.throughout?.maxLinearSpeedStudsPerSecond === undefined
    && expectation.throughout?.maxAngularSpeedDegreesPerSecond === undefined
    && expectation.throughout?.maxLinearAccelerationStudsPerSecondSquared === undefined
    && expectation.throughout?.maxAngularAccelerationDegreesPerSecondSquared === undefined
    && expectation.throughout?.maxLinearStepStuds === undefined
    && expectation.throughout?.maxAngularStepDegrees === undefined
    && expectation.throughout?.maxSampleGapSeconds === undefined) {
    context.addIssue({ code: 'custom', message: 'Each pose assertion must check position, rotation, blend confidence/influence, BlendSpace source poses/channels, or a throughout sampling-gap/motion-speed/acceleration/step limit.' });
  }
  if (expectation.blendSourcePoses && new Set(expectation.blendSourcePoses.map(source => `${source.controllerStateId}\u0000${source.sourceStateId}`)).size !== expectation.blendSourcePoses.length) {
    context.addIssue({ code: 'custom', path: ['blendSourcePoses'], message: 'Each BlendSpace controller/source pair may be asserted only once per pose sample.' });
  }
  if (expectation.missingBlendChannels) {
    const seen = new Set<string>();
    for (let index = 0; index < expectation.missingBlendChannels.length; index++) {
      const channel = expectation.missingBlendChannels[index]!;
      const key = `${channel.controllerStateId}\u0000${channel.sourceStateId}`;
      if (seen.has(key)) context.addIssue({ code: 'custom', path: ['missingBlendChannels', index], message: 'Missing BlendSpace controller/source pairs must be unique.' });
      seen.add(key);
    }
  }
  if ((expectation.expectedPosition === undefined) !== (expectation.positionToleranceStuds === undefined)) {
    context.addIssue({ code: 'custom', path: ['positionToleranceStuds'], message: 'Provide positionToleranceStuds exactly when expectedPosition is provided.' });
  }
  if ((expectation.expectedRotation === undefined) !== (expectation.rotationToleranceDegrees === undefined)) {
    context.addIssue({ code: 'custom', path: ['rotationToleranceDegrees'], message: 'Provide rotationToleranceDegrees exactly when expectedRotation is provided.' });
  }
  if (expectation.throughout && expectation.throughout.start > expectation.throughout.end) {
    context.addIssue({ code: 'custom', path: ['throughout', 'end'], message: 'Pose window end cannot precede its start.' });
  }
  if (expectation.throughout && expectation.expectedPosition === undefined && expectation.expectedRotation === undefined
    && expectation.throughout.maxLinearSpeedStudsPerSecond === undefined
    && expectation.throughout.maxAngularSpeedDegreesPerSecond === undefined
    && expectation.throughout.maxLinearAccelerationStudsPerSecondSquared === undefined
    && expectation.throughout.maxAngularAccelerationDegreesPerSecondSquared === undefined
    && expectation.throughout.maxLinearStepStuds === undefined
    && expectation.throughout.maxAngularStepDegrees === undefined
    && expectation.throughout.maxSampleGapSeconds === undefined) {
    context.addIssue({ code: 'custom', path: ['throughout'], message: 'A throughout window requires an expected position/rotation target or a maximum sampling-gap/motion-speed/acceleration/step limit.' });
  }
  if (expectation.studioCalibrationTolerance && expectation.studioCalibrationTolerance.maxPositionErrorStuds === undefined
    && expectation.studioCalibrationTolerance.maxRotationErrorDegrees === undefined) {
    context.addIssue({ code: 'custom', path: ['studioCalibrationTolerance'], message: 'Studio calibration tolerance must specify a maximum position error, rotation error, or both.' });
  }
});

const timelineCase = z.object({
  id: stateId,
  name: label,
  duration: z.number().finite().min(0.01).max(120),
  naturalCompletionFadeSeconds: animationGraphSimulationInputShape.naturalCompletionFadeSeconds.optional()
    .describe('Explicit assumed fade duration after a non-looping clip reaches its authored end; AnimationEnded is delivered when this fade completes. It is not inferred from Stop() calibration.'),
  observedBlendAnimationLengths: animationGraphSimulationInputShape.observedBlendAnimationLengths.optional()
    .describe('Optional fresh Roblox AnimationTrack.Length measurements keyed first by BlendSpace controller state ID and then by sample source state ID. Supply every sample for each calibrated controller; the simulation uses live length ratios and maps authored poses/markers by normalized phase.'),
  observedBlendAnimationPlaybackSpeeds: animationGraphSimulationInputShape.observedBlendAnimationPlaybackSpeeds.optional()
    .describe('Matching live Roblox AnimationTrack.Speed measurements for every measured controller/source pair; preserves the actual pre/post-synchronization playback mode.'),
  observedBlendAnimationStartPhases: animationGraphSimulationInputShape.observedBlendAnimationStartPhases.optional()
    .describe('Optional complete normalized start-phase map from GetBlendState(); initializes the simulated clocks at the captured live phases before advancing time.'),
  observedBlendAnimationAssetSetFingerprint: animationGraphSimulationInputShape.observedBlendAnimationAssetSetFingerprint,
  expectedBlendAnimationAssetSetFingerprint: animationGraphSimulationInputShape.expectedBlendAnimationAssetSetFingerprint,
  initialParameters: z.record(stateId, z.union([z.boolean(), z.number().finite(), z.string().max(256)])).default({}),
  events: animationGraphSimulationInputShape.events.describe('Timed graph inputs, including numeric ramp_parameters events. Timeline-plan previews summarize ramp targets, easing, authored and simulated time bounds, and possible overlapping parameter updates; trigger updates are potential interruptions only when their transition commits.'),
  expect: z.object({
    finalState: stateId.optional(),
    transitionIds: z.object({ mode: z.enum(['exact', 'contains', 'ordered_subsequence']), ids: z.array(transitionId).max(128) }).strict().optional(),
    markers: z.array(markerExpectation).max(64).default([]),
    blends: z.array(blendExpectation).max(64).default([]),
    poses: z.array(poseExpectation).max(64).optional(),
    stateAt: z.array(z.object({ at: z.number().finite().min(0).max(120), stateId }).strict()).max(64).default([]),
    transitionTimes: z.array(z.object({ transitionId, occurrence: z.number().int().min(1).max(128).default(1),
      minAt: z.number().finite().min(0).max(120).optional(), maxAt: z.number().finite().min(0).max(120).optional() }).strict()).max(128).default([]),
    playbackClock: z.array(z.object({ transitionId, occurrence: z.number().int().min(1).max(128).default(1),
      decision: z.enum(['new_or_stopped_track', 'studio_observed_preserved', 'studio_observed_reset',
        'ambiguous_probe_assumed_reset', 'unmeasured_assumed_reset']) }).strict()).max(128).optional()
      .describe('Optional regression assertions for the measured or assumed AnimationTrack playback-clock behavior on a selected transition.'),
    incompleteParameterRamps: z.array(parameterRampExpectation).max(32).optional()
      .describe('Optional endpoint regression assertions for ramp events that must still be active at the simulation horizon. Check progress, remaining time, and selected channels’ current/target values.'),
    parameterRampLifecycle: z.array(parameterRampLifecycleExpectation).max(32).optional()
      .describe('Optional lifecycle regression assertions for ramps started by this case. Gate active/completed/interrupted or partially-interrupted outcomes and selected channels’ final value, target, status, or completion/interruption time.'),
    trackLifecycles: z.array(trackLifecycleExpectation).max(128).optional()
      .describe('Optional end-of-run AnimationTrack lifecycle assertions. Use these to distinguish a clip that naturally completed from one stopped by a transition, even if its playback clock later reaches the authored clip duration.'),
    phaseDonors: z.array(phaseDonorExpectation).max(128).optional()
      .describe('Optional assertions for the still-playing BlendSpace source that donates normalized phase when a parameter retarget restarts an ended source. Reference a set_parameters event by inputIndex, or a ramp_parameters input plus a generated update timestamp; check donor state, exact restartedStateIds, phase, current weight, target weight, or any combination.'),
    maxAmbiguousEventOrderingCollisions: z.number().int().min(0).max(20000).optional()
      .describe('Optional regression gate for runtime marker/AnimationEnded collisions with each other or external inputs. Set 0 to fail any case with an ordering-sensitive timestamp.'),
    maxEventOrderDivergences: z.number().int().min(0).max(7).optional()
      .describe('Optional regression gate across final state, transition IDs, parameters, marker delivery, event timeline, blend samples, and composed poses when user and runtime callbacks are processed in opposite orders at tied timestamps. Set 0 to reject any deterministic policy divergence.'),
  }).strict().superRefine((expectation, context) => {
    if (expectation.finalState === undefined && expectation.transitionIds === undefined && expectation.markers.length === 0
      && expectation.stateAt.length === 0 && expectation.transitionTimes.length === 0 && (expectation.playbackClock?.length ?? 0) === 0 && expectation.blends.length === 0
      && (expectation.incompleteParameterRamps?.length ?? 0) === 0
      && (expectation.parameterRampLifecycle?.length ?? 0) === 0
      && (expectation.trackLifecycles?.length ?? 0) === 0
      && (expectation.phaseDonors?.length ?? 0) === 0
      && expectation.maxAmbiguousEventOrderingCollisions === undefined && expectation.maxEventOrderDivergences === undefined
      && (expectation.poses?.length ?? 0) === 0) {
      context.addIssue({ code: 'custom', message: 'Each timeline case needs at least one explicit expectation.' });
    }
    expectation.transitionTimes.forEach((timing, index) => {
      if (timing.minAt === undefined && timing.maxAt === undefined) context.addIssue({ code: 'custom', path: ['transitionTimes', index], message: 'Provide minAt, maxAt, or both.' });
      if (timing.minAt !== undefined && timing.maxAt !== undefined && timing.minAt > timing.maxAt) context.addIssue({ code: 'custom', path: ['transitionTimes', index], message: 'minAt cannot exceed maxAt.' });
    });
    const playbackClockKeys = (expectation.playbackClock ?? []).map(assertion => `${assertion.transitionId}#${assertion.occurrence}`);
    if (new Set(playbackClockKeys).size !== playbackClockKeys.length) {
      context.addIssue({ code: 'custom', path: ['playbackClock'], message: 'Each playback-clock transition occurrence may be asserted only once.' });
    }
    const rampInputIndices = (expectation.incompleteParameterRamps ?? []).map(assertion => assertion.inputIndex);
    if (new Set(rampInputIndices).size !== rampInputIndices.length) {
      context.addIssue({ code: 'custom', path: ['incompleteParameterRamps'], message: 'Each ramp input can be asserted only once.' });
    }
    const lifecycleInputIndices = (expectation.parameterRampLifecycle ?? []).map(assertion => assertion.inputIndex);
    if (new Set(lifecycleInputIndices).size !== lifecycleInputIndices.length) {
      context.addIssue({ code: 'custom', path: ['parameterRampLifecycle'], message: 'Each ramp input can be asserted only once.' });
    }
    const lifecycleStateIds = (expectation.trackLifecycles ?? []).map(assertion => assertion.stateId);
    if (new Set(lifecycleStateIds).size !== lifecycleStateIds.length) {
      context.addIssue({ code: 'custom', path: ['trackLifecycles'], message: 'Each AnimationTrack lifecycle state may be asserted only once.' });
    }
    const phaseDonorKeys = (expectation.phaseDonors ?? []).map(assertion => `${assertion.inputIndex}:${assertion.at ?? 'event'}`);
    if (new Set(phaseDonorKeys).size !== phaseDonorKeys.length) {
      context.addIssue({ code: 'custom', path: ['phaseDonors'], message: 'Each parameter-update input/time pair may have only one phase-donor assertion.' });
    }
  }),
}).strict().superRefine((testCase, context) => {
  for (const [index, event] of testCase.events.entries()) if (event.at > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['events', index, 'at'], message: 'Event time cannot exceed case duration.' });
  }
  for (const [index, marker] of testCase.expect.markers.entries()) if (marker.window && marker.window.end > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['expect', 'markers', index, 'window'], message: 'Marker window cannot exceed case duration.' });
  }
  for (const [index, state] of testCase.expect.stateAt.entries()) if (state.at > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['expect', 'stateAt', index, 'at'], message: 'State assertion time cannot exceed case duration.' });
  }
  for (const [index, timing] of testCase.expect.transitionTimes.entries()) {
    if ((timing.minAt !== undefined && timing.minAt > testCase.duration) || (timing.maxAt !== undefined && timing.maxAt > testCase.duration)) {
      context.addIssue({ code: 'custom', path: ['expect', 'transitionTimes', index], message: 'Transition timing bounds cannot exceed case duration.' });
    }
  }
  for (const [index, blend] of testCase.expect.blends.entries()) if (blend.at > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['expect', 'blends', index, 'at'], message: 'Blend sample time cannot exceed case duration.' });
  }
  for (const [index, pose] of (testCase.expect.poses ?? []).entries()) if (pose.at > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['expect', 'poses', index, 'at'], message: 'Pose sample time cannot exceed case duration.' });
  }
  for (const [index, pose] of (testCase.expect.poses ?? []).entries()) if (pose.throughout && pose.throughout.end > testCase.duration) {
    context.addIssue({ code: 'custom', path: ['expect', 'poses', index, 'throughout'], message: 'Pose window cannot exceed case duration.' });
  }
  for (const [index, rampExpectation] of (testCase.expect.incompleteParameterRamps ?? []).entries()) {
    const event = testCase.events[rampExpectation.inputIndex];
    if (event?.kind !== 'ramp_parameters') {
      context.addIssue({ code: 'custom', path: ['expect', 'incompleteParameterRamps', index, 'inputIndex'],
        message: 'An incomplete-ramp assertion must reference a ramp_parameters event in this case.' });
      continue;
    }
    if (event.at > testCase.duration || event.at + event.duration <= testCase.duration) {
      context.addIssue({ code: 'custom', path: ['expect', 'incompleteParameterRamps', index, 'inputIndex'],
        message: 'The referenced ramp must start within the case and have an authored end after the simulation horizon.' });
    }
    for (const [parameterIndex, parameter] of rampExpectation.parameters.entries()) if (!(parameter.name in event.values)) {
      context.addIssue({ code: 'custom', path: ['expect', 'incompleteParameterRamps', index, 'parameters', parameterIndex, 'name'],
        message: `The referenced ramp does not target parameter ${parameter.name}.` });
    }
  }
  for (const [index, lifecycleExpectation] of (testCase.expect.parameterRampLifecycle ?? []).entries()) {
    const event = testCase.events[lifecycleExpectation.inputIndex];
    if (event?.kind !== 'ramp_parameters') {
      context.addIssue({ code: 'custom', path: ['expect', 'parameterRampLifecycle', index, 'inputIndex'],
        message: 'A lifecycle assertion must reference a ramp_parameters event in this case.' });
      continue;
    }
    if (event.at > testCase.duration) context.addIssue({ code: 'custom', path: ['expect', 'parameterRampLifecycle', index, 'inputIndex'],
      message: 'The referenced ramp must start within the case horizon.' });
    for (const [parameterIndex, parameter] of lifecycleExpectation.parameters.entries()) if (!(parameter.name in event.values)) {
      context.addIssue({ code: 'custom', path: ['expect', 'parameterRampLifecycle', index, 'parameters', parameterIndex, 'name'],
        message: `The referenced ramp does not target parameter ${parameter.name}.` });
    }
  }
  for (const [index, donorExpectation] of (testCase.expect.phaseDonors ?? []).entries()) {
    const event = testCase.events[donorExpectation.inputIndex];
    if (event?.kind === 'set_parameters') {
      if (donorExpectation.at !== undefined && Math.abs(donorExpectation.at - event.at) > 1e-9) {
        context.addIssue({ code: 'custom', path: ['expect', 'phaseDonors', index, 'at'],
          message: 'A set_parameters phase-donor assertion must use the authored event timestamp.' });
      }
    } else if (event?.kind === 'ramp_parameters') {
      if (donorExpectation.at === undefined || donorExpectation.at <= event.at
        || donorExpectation.at > Math.min(event.at + event.duration, testCase.duration)) {
        context.addIssue({ code: 'custom', path: ['expect', 'phaseDonors', index, 'at'],
          message: 'A ramp phase-donor assertion must specify a generated parameter-update time after ramp start and no later than its simulated end.' });
      }
    } else {
      context.addIssue({ code: 'custom', path: ['expect', 'phaseDonors', index, 'inputIndex'],
        message: 'A phase-donor assertion must reference a set_parameters or ramp_parameters event in this case.' });
    }
    if (donorExpectation.at !== undefined && donorExpectation.at > testCase.duration) context.addIssue({ code: 'custom',
      path: ['expect', 'phaseDonors', index, 'at'], message: 'The referenced parameter update must occur within the case horizon.' });
  }
  const requestedTemporalSamples = testCase.expect.blends.length + (testCase.expect.poses ?? []).reduce((count, pose) =>
    count + 1 + (pose.throughout ? Math.ceil((pose.throughout.end - pose.throughout.start) * pose.throughout.sampleRateHz) + 1 : 0), 0);
  if (requestedTemporalSamples > 512) context.addIssue({ code: 'custom', path: ['expect'],
    message: 'A timeline case cannot request more than 512 explicit pose/blend sample times, including throughout windows. Reduce the window duration or sample rate.' });
});

const animationGraphTimelineSuiteObjectSchema = z.object({ cases: z.array(timelineCase).min(1).max(32) }).strict();
export const animationGraphTimelineSuiteShape = animationGraphTimelineSuiteObjectSchema.shape;
export const animationGraphTimelineSuiteSchema = animationGraphTimelineSuiteObjectSchema.superRefine((suite, context) => {
  const ids = suite.cases.map(testCase => testCase.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline case IDs must be unique.' });
  const externalEvents = suite.cases.reduce((sum, testCase) => sum + testCase.events.length, 0);
  if (externalEvents > 256) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 256 total scheduled user events.' });
  const totalSeconds = suite.cases.reduce((sum, testCase) => sum + testCase.duration, 0);
  if (totalSeconds > 1200) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 1,200 aggregate simulated seconds.' });
  const blendAssertionCount = suite.cases.reduce((sum, testCase) => sum + testCase.expect.blends.length, 0);
  if (blendAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 total blend assertions.' });
  const poseAssertionCount = suite.cases.reduce((sum, testCase) => sum + (testCase.expect.poses?.length ?? 0), 0);
  if (poseAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 total pose assertions.' });
  const playbackClockAssertionCount = suite.cases.reduce((sum, testCase) => sum + (testCase.expect.playbackClock?.length ?? 0), 0);
  if (playbackClockAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 playback-clock assertions.' });
  const phaseDonorAssertionCount = suite.cases.reduce((sum, testCase) => sum + (testCase.expect.phaseDonors?.length ?? 0), 0);
  if (phaseDonorAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 phase-donor assertions.' });
  const rampAssertionCount = suite.cases.reduce((sum, testCase) => sum + (testCase.expect.incompleteParameterRamps?.length ?? 0), 0);
  if (rampAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 incomplete-ramp assertions.' });
  const rampLifecycleAssertionCount = suite.cases.reduce((sum, testCase) => sum + (testCase.expect.parameterRampLifecycle?.length ?? 0), 0);
  if (rampLifecycleAssertionCount > 512) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 512 parameter-ramp lifecycle assertions.' });
  const poseSamplePairs = suite.cases.reduce((sum, testCase) => {
    const joints = new Set<string>();
    let sampleRequests = testCase.expect.blends.length;
    for (const pose of testCase.expect.poses ?? []) {
      joints.add(pose.joint);
      sampleRequests++;
      if (pose.throughout) {
        const { start, end, sampleRateHz } = pose.throughout;
        sampleRequests += Math.ceil((end - start) * sampleRateHz) + 1;
      }
      for (const source of pose.blendSourcePoses ?? []) if (source.throughout) {
        const { start, end, sampleRateHz } = source.throughout;
        sampleRequests += Math.ceil((end - start) * sampleRateHz) + 1;
      }
    }
    return sum + sampleRequests * joints.size;
  }, 0);
  if (poseSamplePairs > 20000) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite cannot exceed 20,000 expanded joint-time pose samples, including throughout windows. Reduce window duration/rate or select fewer joints.' });
  if (Buffer.byteLength(JSON.stringify(suite), 'utf8') > 2 * 1024 * 1024) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline suite must be no larger than 2 MiB after normalization.' });
});

type TimelineSuite = z.infer<typeof animationGraphTimelineSuiteSchema>;

function poseWindowTimes(window: { start: number; end: number; sampleRateHz: number }): number[] {
  const sampleCount = Math.ceil((window.end - window.start) * window.sampleRateHz);
  return [...new Set([...Array.from({ length: sampleCount + 1 }, (_, index) => Math.min(window.end, window.start + index / window.sampleRateHz)), window.end])];
}

function bezierExtremaX(curve: NonNullable<z.infer<typeof animationSchema>['tracks'][number]['keys'][number]['curve']> | undefined): number[] {
  const controls = curve ?? { outTime: 0.25, outValue: 0.1, inTime: 0.75, inValue: 0.9 };
  const derivativeRoots = (first: number, second: number) => {
    const a = 3 * (1 - 3 * second + 3 * first), b = 2 * (3 * second - 6 * first), c = 3 * first;
    const quadratic = a, linear = b;
    if (Math.abs(quadratic) < 1e-12) return Math.abs(linear) < 1e-12 ? [] : [-c / linear];
    const discriminant = linear * linear - 4 * quadratic * c;
    if (discriminant < 0) return [];
    const root = Math.sqrt(discriminant);
    return [(-linear - root) / (2 * quadratic), (-linear + root) / (2 * quadratic)];
  };
  const cubic = (t: number, first: number, second: number) => 3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3;
  return derivativeRoots(controls.outValue, controls.inValue).filter(t => t > 1e-10 && t < 1 - 1e-10)
    .map(t => cubic(t, controls.outTime, controls.inTime));
}

function easingExtremaProgress(style: 'Bezier' | 'Bounce' | 'Elastic', direction: 'In' | 'Out' | 'InOut' | undefined,
  curve: NonNullable<z.infer<typeof animationSchema>['tracks'][number]['keys'][number]['curve']> | undefined): number[] {
  if (style === 'Bezier') return bezierExtremaX(curve);
  if (style === 'Bounce') {
    const effectiveDirection = direction === 'In' ? 'Out' : direction === 'Out' || direction === undefined ? 'In' : 'InOut';
    const bounceCritical = [0, 1 / 2.75, 1.5 / 2.75, 2 / 2.75, 2.25 / 2.75, 2.5 / 2.75, 2.625 / 2.75, 1];
    const progress = effectiveDirection === 'Out' ? bounceCritical
      : effectiveDirection === 'In' ? bounceCritical.map(value => 1 - value)
        : [...bounceCritical.map(value => (1 - value) / 2), ...bounceCritical.map(value => (value + 1) / 2)];
    return [...new Set(progress.filter(value => value > 1e-10 && value < 1 - 1e-10))].sort((left, right) => left - right);
  }
  const effectiveDirection = direction === 'In' ? 'Out' : direction === 'Out' || direction === undefined ? 'In' : 'InOut';
  const frequency = 20 * Math.PI / 3;
  const phaseRoots = (phaseAtZero: number, tangent: number, start: number, end: number) => {
    const principalPhase = Math.atan(tangent);
    const roots: number[] = [];
    for (let cycle = -16; cycle <= 16; cycle++) {
      const progress = (principalPhase + cycle * Math.PI - phaseAtZero) / frequency;
      if (progress > start + 1e-10 && progress < end - 1e-10) roots.push(progress);
    }
    return roots;
  };
  const amplitudeRate = 10 * Math.LN2;
  const inOutAmplitudeRate = 20 * Math.LN2;
  const inOutFrequency = 20 * (2 * Math.PI / 4.5);
  const inOutPhaseAtZero = -11.125 * (2 * Math.PI / 4.5);
  const extrema = effectiveDirection === 'Out'
    ? phaseRoots(-0.75 * (2 * Math.PI / 3), frequency / amplitudeRate, 0, 1)
    : effectiveDirection === 'In'
      ? phaseRoots(-10.75 * (2 * Math.PI / 3), -frequency / amplitudeRate, 0, 1)
      : [...phaseRoots(inOutPhaseAtZero, -inOutFrequency / inOutAmplitudeRate, 0, 0.5), 0.5,
        ...phaseRoots(inOutPhaseAtZero, inOutFrequency / inOutAmplitudeRate, 0.5, 1)];
  return [...new Set(extrema.map(value => Math.round(value * 1e12) / 1e12))].sort((left, right) => left - right);
}

function criticalPoseWindowTimes(
  graph: z.infer<typeof animationGraphSchema>, recipes: Record<string, z.infer<typeof animationSchema>>,
  timeline: ReturnType<typeof simulateAnimationGraphTimeline>['timeline'], joint: string, window: { start: number; end: number },
  includeMotionProbes: boolean, criticalLocalTimesCache: Map<string, { criticalTimes: number[]; keyTimes: number[] }>,
): number[] {
  const times = new Set<number>();
  const add = (at: number) => {
    if (at >= window.start && at <= window.end) {
      times.add(at);
      if (times.size > 512) throw new Error('A pose throughout window expands beyond 512 critical samples. Reduce its duration, lower loop/key density, or narrow the window.');
    }
  };
  const addBoundaryProbes = (at: number) => {
    add(at);
    if (includeMotionProbes) {
      const epsilon = 1e-4;
      add(at - epsilon);
      add(at + epsilon);
    }
  };
  add(window.start); add(window.end);
  const starts: Array<{ stateId: string; at: number; endAt: number | null }> = [{ stateId: graph.entryState, at: 0, endAt: null }];
  let currentStart = starts[0]!;
  const latestStartByState = new Map<string, (typeof starts)[number]>([[graph.entryState, currentStart]]);
  for (const event of timeline) {
    if (typeof event.at !== 'number') continue;
    add(event.at);
    if (event.transitionId && typeof event.stateAfter === 'string') {
      addBoundaryProbes(event.at);
      currentStart.endAt = event.at + (event.stateBefore === event.stateAfter ? 0 : typeof event.blendSeconds === 'number' ? event.blendSeconds : 0);
      const previousDestinationStart = latestStartByState.get(event.stateAfter);
      if (previousDestinationStart && previousDestinationStart !== currentStart
        && (previousDestinationStart.endAt === null || previousDestinationStart.endAt > event.at)) {
        previousDestinationStart.endAt = event.at;
      }
      currentStart = { stateId: event.stateAfter, at: event.at, endAt: null };
      starts.push(currentStart);
      latestStartByState.set(event.stateAfter, currentStart);
      if (typeof event.blendSeconds === 'number') {
        addBoundaryProbes(event.at + event.blendSeconds);
        if (includeMotionProbes && event.blendSeconds > 0) add(event.at + event.blendSeconds / 2);
      }
    } else if (event.event === 'animation_end' && event.stateBefore === currentStart.stateId) {
      currentStart.endAt = event.at;
    }
  }
  for (const start of starts) {
    const state = graph.states.find(candidate => candidate.id === start.stateId);
    if (!state) continue;
    const recipe = recipes[state.animationId];
    if (!recipe || start.at > window.end) continue;
    const sessionEnd = Math.min(window.end, start.endAt ?? window.end,
      recipe.loop ? window.end : start.at + recipe.duration / state.speed);
    if (sessionEnd < window.start) continue;
    const cacheKey = `${state.animationId}:${joint}:${includeMotionProbes ? 'motion' : 'pose'}`;
    let criticalLocalTimes = criticalLocalTimesCache.get(cacheKey);
    if (!criticalLocalTimes) {
      const jointTracks = [...recipe.tracks.filter(track => track.joint === joint),
        ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks.filter(track => track.joint === joint)),
        ...(recipe.rootMotion?.joint === joint ? [recipe.rootMotion] : [])];
      const keyTimes = [...new Set(jointTracks.flatMap(track => track.keys.map(key => key.time)))];
      const criticalTimes = [...new Set(jointTracks.flatMap(track => track.keys.flatMap((key, index) => {
        if (index === track.keys.length - 1) return [key.time];
        const next = track.keys[index + 1]!;
        const segmentExtrema = key.easingStyle === 'Bezier' || key.easingStyle === 'Bounce' || key.easingStyle === 'Elastic'
          ? easingExtremaProgress(key.easingStyle, key.easingDirection, key.curve).map(progress => key.time + (next.time - key.time) * progress) : [];
        const motionProbes = includeMotionProbes
          ? [0.25, 0.5, 0.75].map(progress => key.time + (next.time - key.time) * progress) : [];
        return [key.time, ...segmentExtrema, ...motionProbes];
      })))];
      criticalLocalTimes = { criticalTimes, keyTimes };
      criticalLocalTimesCache.set(cacheKey, criticalLocalTimes);
    }
    const addPlaybackTime = (keyTime: number, boundary: boolean) => {
      const firstCycle = recipe.loop ? Math.max(0, Math.ceil(((window.start - start.at) * state.speed - keyTime) / recipe.duration - 1e-12)) : 0;
      const lastCycle = recipe.loop ? Math.floor(((sessionEnd - start.at) * state.speed - keyTime) / recipe.duration + 1e-12) : 0;
      for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        const at = start.at + (cycle * recipe.duration + keyTime) / state.speed;
        if (boundary) addBoundaryProbes(at);
        else add(at);
      }
    };
    for (const keyTime of criticalLocalTimes.criticalTimes) addPlaybackTime(keyTime, false);
    if (includeMotionProbes) for (const keyTime of criticalLocalTimes.keyTimes) addPlaybackTime(keyTime, true);
  }
  return [...times].sort((left, right) => left - right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function eulerDegreesToQuaternion([xDegrees, yDegrees, zDegrees]: [number, number, number]): [number, number, number, number] {
  const [x, y, z] = [xDegrees, yDegrees, zDegrees].map(value => value * Math.PI / 360) as [number, number, number];
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)], [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * sy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

function rotationGapDegrees(left: [number, number, number], right: [number, number, number, number]): number {
  const expected = eulerDegreesToQuaternion(left);
  const dot = Math.min(1, Math.abs(expected.reduce((sum, value, index) => sum + value * right[index]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function diagnosePoseContribution(
  pose: NonNullable<ReturnType<typeof simulateAnimationGraphTimeline>['composedPoseSamples'][number]['joints'][number]>,
  expectedPosition?: [number, number, number],
  expectedRotation?: [number, number, number],
) {
  const ranked = [...pose.contributors].sort((left, right) => right.effectiveWeight - left.effectiveWeight
    || left.stateId.localeCompare(right.stateId)
    || (left.blendControllerStateId ?? '').localeCompare(right.blendControllerStateId ?? ''));
  const positionErrorAttribution = expectedPosition ? (() => {
    const errorVector = pose.position.map((value, axis) => value - expectedPosition[axis]!) as [number, number, number];
    const errorMagnitude = Math.hypot(...errorVector);
    const errorDirection = errorMagnitude > 1e-12 ? errorVector.map(value => value / errorMagnitude) as [number, number, number] : [0, 0, 0] as [number, number, number];
    const contributors = pose.contributors.map(contributor => {
      const errorContribution = contributor.position.map((value, axis) => contributor.effectiveWeight * (value - expectedPosition[axis]!)) as [number, number, number];
      const signedErrorStuds = errorContribution.reduce((sum, value, axis) => sum + value * errorDirection[axis]!, 0);
      return { stateId: contributor.stateId,
        ...(contributor.blendControllerStateId ? { blendControllerStateId: contributor.blendControllerStateId } : {}),
        effectiveWeight: contributor.effectiveWeight, errorContribution, signedErrorStuds,
        role: signedErrorStuds > 1e-12 ? 'pushes_toward_mismatch' as const
          : signedErrorStuds < -1e-12 ? 'counteracts_mismatch' as const : 'no_directional_effect' as const };
    });
    const neutralAnimationPoseContribution = expectedPosition.map(value => -pose.residualWeight * value) as [number, number, number];
    const neutralAnimationPoseSignedErrorStuds = neutralAnimationPoseContribution.reduce((sum, value, axis) => sum + value * errorDirection[axis]!, 0);
    return { expectedPosition, observedPosition: pose.position, errorVector, errorMagnitude, contributors,
      neutralAnimationPose: { basis: 'identity_local_animation_delta' as const, effectiveWeight: pose.residualWeight,
        errorContribution: neutralAnimationPoseContribution, signedErrorStuds: neutralAnimationPoseSignedErrorStuds,
        role: neutralAnimationPoseSignedErrorStuds > 1e-12 ? 'pushes_toward_mismatch' as const
          : neutralAnimationPoseSignedErrorStuds < -1e-12 ? 'counteracts_mismatch' as const : 'no_directional_effect' as const },
      accountingErrorStuds: Math.hypot(...errorVector.map((value, axis) => value
        - contributors.reduce((sum, contributor) => sum + contributor.errorContribution[axis]!, 0) - neutralAnimationPoseContribution[axis]!)),
    };
  })() : undefined;
  const rotationTargetComparison = expectedRotation ? (() => {
    const target = eulerDegreesToQuaternion(expectedRotation);
    const contributors = pose.contributors.map(contributor => {
      const angularErrorDegrees = rotationGapDegrees(expectedRotation, contributor.rotationQuaternion);
      return { stateId: contributor.stateId,
        ...(contributor.blendControllerStateId ? { blendControllerStateId: contributor.blendControllerStateId } : {}),
        effectiveWeight: contributor.effectiveWeight, angularErrorDegrees,
        weightedTargetErrorScore: contributor.effectiveWeight * angularErrorDegrees };
    }).sort((left, right) => right.weightedTargetErrorScore - left.weightedTargetErrorScore
      || left.stateId.localeCompare(right.stateId)
      || (left.blendControllerStateId ?? '').localeCompare(right.blendControllerStateId ?? ''));
    const neutralAnimationPoseAngularErrorDegrees = rotationGapDegrees(expectedRotation, [0, 0, 0, 1]);
    return { expectedRotation, expectedQuaternion: target, observedQuaternion: pose.rotationQuaternion,
      composedErrorDegrees: rotationGapDegrees(expectedRotation, pose.rotationQuaternion), contributors,
      neutralAnimationPose: { basis: 'identity_local_animation_delta' as const, effectiveWeight: pose.residualWeight,
        angularErrorDegrees: neutralAnimationPoseAngularErrorDegrees,
        weightedTargetErrorScore: pose.residualWeight * neutralAnimationPoseAngularErrorDegrees },
      rankingLimitation: 'weightedTargetErrorScore ranks contributors for inspection; quaternion Markley blending is nonlinear, so these scores are not additive and do not claim causal error decomposition.' };
  })() : undefined;
  return {
    pose: { position: pose.position, rotationQuaternion: pose.rotationQuaternion,
      rotationBlendConfidence: pose.rotationBlendConfidence, rotationInfluence: pose.rotationInfluence, residualWeight: pose.residualWeight },
    missingBlendChannels: pose.unanimatedTracks.filter(track => track.blendControllerStateId && track.trackWeight > 0)
      .map(track => ({ controllerStateId: track.blendControllerStateId!, sourceStateId: track.stateId,
        priority: track.priority, trackWeight: track.trackWeight, targetTrackWeight: track.targetTrackWeight ?? track.trackWeight,
        playbackTimeSeconds: track.playbackTimeSeconds })),
    dominantContributors: ranked.filter(contributor => contributor.effectiveWeight > 0).slice(0, 3).map(contributor => ({
      stateId: contributor.stateId,
      ...(contributor.blendControllerStateId ? { blendControllerStateId: contributor.blendControllerStateId } : {}),
      priority: contributor.priority, trackWeight: contributor.trackWeight,
      effectiveWeight: contributor.effectiveWeight, position: contributor.position,
      rotationQuaternion: contributor.rotationQuaternion,
      recipeChannels: contributor.recipeComposition.map(source => ({ kind: source.kind,
        ...(source.layerName ? { layerName: source.layerName } : {}), ...(source.blendMode ? { blendMode: source.blendMode } : {}),
        weight: source.weight, applied: source.applied, afterPosition: source.afterPosition,
        afterRotationQuaternion: source.afterRotationQuaternion })),
    })),
    omittedContributorCount: Math.max(0, ranked.filter(contributor => contributor.effectiveWeight > 0).length - 3),
    ...(positionErrorAttribution ? { positionErrorAttribution } : {}),
    ...(rotationTargetComparison ? { rotationTargetComparison } : {}),
  };
}

type PoseDiagnosis = ReturnType<typeof diagnosePoseContribution>;

/** Validate phase-lock source references before a reviewed timeline plan is created. */
export function validateAnimationGraphTimelinePhaseSyncReferences(graphInput: unknown, suiteInput: unknown, options: { allowInvalidSourcePoseReferences?: boolean } = {}): void {
  const graph = animationGraphSchema.parse(graphInput);
  const suite = animationGraphTimelineSuiteSchema.parse(suiteInput);
  for (const testCase of suite.cases) for (const expected of testCase.expect.blends) {
    const phaseSyncExpectations = [expected.blendSpace?.phaseSync, expected.blendSpace?.phaseSyncThroughout].filter(value => value !== undefined);
    if (phaseSyncExpectations.length === 0) continue;
    const controller = graph.states.find(state => state.id === expected.stateId);
    const sourceSamples = controller?.blendSpace1D?.samples ?? controller?.blendSpace2D?.samples;
    if (!controller || !sourceSamples) {
      throw new Error(`Case ${testCase.id} expects phase synchronization for non-BlendSpace controller ${expected.stateId}.`);
    }
    for (const phaseSync of phaseSyncExpectations) for (const sourceStateId of phaseSync.stateIds) {
      if (!sourceSamples.some(sample => sample.stateId === sourceStateId)) {
        throw new Error(`Case ${testCase.id} phase-sync source state ${sourceStateId} is not a sample of controller ${controller.id}.`);
      }
    }
  }
  for (const testCase of suite.cases) for (const pose of testCase.expect.poses ?? []) {
    const sourceReferences = [
      ...(pose.blendSourcePoses ?? []).map(source => ({ controllerStateId: source.controllerStateId, sourceStateId: source.sourceStateId })),
      ...(pose.missingBlendChannels ?? []),
    ];
    for (const reference of sourceReferences) {
      const controller = graph.states.find(state => state.id === reference.controllerStateId);
      const sourceSamples = controller?.blendSpace1D?.samples ?? controller?.blendSpace2D?.samples;
      if (!controller || !sourceSamples) {
        if (options.allowInvalidSourcePoseReferences) continue;
        throw new Error(`Case ${testCase.id} pose for joint ${pose.joint} references non-BlendSpace controller ${reference.controllerStateId}.`);
      }
      if (!sourceSamples.some(sample => sample.stateId === reference.sourceStateId)) {
        if (options.allowInvalidSourcePoseReferences) continue;
        throw new Error(`Case ${testCase.id} pose for joint ${pose.joint} references source state ${reference.sourceStateId}, which is not a sample of BlendSpace controller ${controller.id}.`);
      }
    }
  }
}

export function runAnimationGraphTimelineSuite(graphInput: unknown, recipesInput: unknown, suiteInput: unknown,
  options: { includeStudioCalibrationTrace?: boolean; fadeProfiles?: unknown;
    fadeCalibrationEvidence?: { id: string; profileFingerprint: string; stateId: string; fadeSeconds: number; rigId: string; rigSignature: string;
      qualityStatus?: 'clean' | 'review'; qualityWarnings?: string[];
      studioBuildIdentity?: StudioBuildIdentity;
      playRetrigger?: z.infer<typeof studioPlayRetriggerProbeSchema>;
      buildCompatibility?: 'match' | 'unknown' }[] } = {}) {
  const graph = animationGraphSchema.parse(graphInput);
  const recipes = z.record(z.string().uuid(), animationSchema).parse(recipesInput);
  const suite: TimelineSuite = animationGraphTimelineSuiteSchema.parse(suiteInput);
  validateAnimationGraphTimelinePhaseSyncReferences(graph, suite);
  const transitionIds = new Set(graph.transitions.map(transition => transition.id));
  const stateIds = new Set(graph.states.map(state => state.id));
  const availablePoseJoints = new Set(Object.values(recipes).flatMap(recipe => [
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ]));
  for (const testCase of suite.cases) {
    if (testCase.expect.finalState && !stateIds.has(testCase.expect.finalState)) throw new Error(`Case ${testCase.id} expects unknown final state ${testCase.expect.finalState}.`);
    for (const expected of testCase.expect.transitionIds?.ids ?? []) if (!transitionIds.has(expected)) throw new Error(`Case ${testCase.id} expects unknown transition ${expected}.`);
    for (const expected of testCase.expect.transitionTimes) if (!transitionIds.has(expected.transitionId)) throw new Error(`Case ${testCase.id} expects unknown transition ${expected.transitionId}.`);
    for (const expected of testCase.expect.playbackClock ?? []) if (!transitionIds.has(expected.transitionId)) throw new Error(`Case ${testCase.id} expects playback-clock data for unknown transition ${expected.transitionId}.`);
    for (const expected of testCase.expect.trackLifecycles ?? []) if (!stateIds.has(expected.stateId)) throw new Error(`Case ${testCase.id} expects lifecycle data for unknown state ${expected.stateId}.`);
    for (const expected of testCase.expect.phaseDonors ?? []) if (!stateIds.has(expected.stateId)) throw new Error(`Case ${testCase.id} expects phase-donor data for unknown state ${expected.stateId}.`);
    for (const expected of testCase.expect.phaseDonors ?? []) for (const restartedStateId of expected.restartedStateIds ?? []) {
      if (!stateIds.has(restartedStateId)) throw new Error(`Case ${testCase.id} expects a phase-donor restart for unknown state ${restartedStateId}.`);
    }
    for (const expected of testCase.expect.stateAt) if (!stateIds.has(expected.stateId)) throw new Error(`Case ${testCase.id} expects unknown state ${expected.stateId}.`);
    for (const expected of testCase.expect.blends) {
      const state = graph.states.find(candidate => candidate.id === expected.stateId);
      if (!state) throw new Error(`Case ${testCase.id} expects blend data for unknown state ${expected.stateId}.`);
      if (expected.blendSpace) {
        const sourceSamples = state.blendSpace1D?.samples ?? state.blendSpace2D?.samples;
        if (!sourceSamples) throw new Error(`Case ${testCase.id} expects ${state.blendSpace2D ? 'BlendSpace2D' : 'BlendSpace1D'} data for non-controller state ${expected.stateId}.`);
        if (expected.blendSpace.parameterValue && !state.blendSpace1D) throw new Error(`Case ${testCase.id} parameterValue requires a BlendSpace1D controller.`);
        if (expected.blendSpace.parameterValues && !state.blendSpace2D) throw new Error(`Case ${testCase.id} parameterValues requires a BlendSpace2D controller.`);
        for (const clip of expected.blendSpace.clips ?? []) if (!sourceSamples.some(sample => sample.stateId === clip.stateId)) {
          throw new Error(`Case ${testCase.id} expects blend-space weight for non-sample state ${clip.stateId} in controller ${expected.stateId}.`);
        }
      }
    }
    for (const expected of testCase.expect.poses ?? []) if (!availablePoseJoints.has(expected.joint)) throw new Error(`Case ${testCase.id} expects pose data for unknown animated joint ${expected.joint}.`);
  }

  let aggregateEvents = 0;
  let aggregatePoseSamplePairs = 0;
  let calibrationPairCount = 0;
  const studioCalibrationTrace: Array<{ caseId: string; at: number;
    tracks: Array<{ stateId: string; weight: number; playbackTimeSeconds: number }>;
    timelineContext: { mostRecentTransition: { transitionId: string; fromState: string; toState: string;
      startedAt: number; blendSeconds: number; progress: number; sourceWeightAtTransition: number;
      destinationWeightAtTransition: number; destinationFadeStartWeight: number } | null;
      markersAtSample: Array<{ stateId: string; name: string; value: string }> };
    joints: Array<{ joint: string; predicted: { position: [number, number, number]; rotationQuaternion: [number, number, number, number] };
      simulatedResidualBasis: 'identity_local_animation_delta';
      simulatedContributors: Array<{ stateId: string; blendControllerStateId?: string; priority: string; trackWeight: number; effectiveWeight: number;
        contributionStatus: 'contributing' | 'zero_weight' | 'masked_by_higher_priority';
        position: [number, number, number]; rotationQuaternion: [number, number, number, number] }>;
      simulatedPriorityLayers: Array<{ priority: string; priorityRank: number; stateIds: string[]; requestedWeight: number;
        availableWeightBefore: number; effectiveBudget: number; remainingWeightAfter: number }>;
      simulatedResidualWeight: number }> }> = [];
  const criticalLocalTimesCache = new Map<string, { criticalTimes: number[]; keyTimes: number[] }>();
  const results = suite.cases.map(testCase => {
    const poseExpectations = testCase.expect.poses ?? [];
    const poseJoints = [...new Set(poseExpectations.map(expectation => expectation.joint))];
    const sourceWindows = poseExpectations.flatMap(pose => (pose.blendSourcePoses ?? []).flatMap(source => source.throughout
      ? [{ pose, source, window: source.throughout }] : []));
    const pointSampleTimes = [...new Set([...testCase.expect.blends.map(expectation => expectation.at), ...poseExpectations.map(expectation => expectation.at)])];
    const requestedSampleTimes = new Set([...pointSampleTimes, ...poseExpectations.flatMap(expectation =>
      expectation.throughout ? poseWindowTimes(expectation.throughout) : []),
    ...sourceWindows.flatMap(item => poseWindowTimes(item.window))]);
    const criticalTimesByWindow = new Map<(typeof poseExpectations)[number], number[]>();
    const criticalTimesBySourceWindow = new Map<BlendSourcePoseExpectation, number[]>();
    if (poseExpectations.some(expectation => expectation.throughout) || sourceWindows.length > 0) {
      const preliminary = simulateAnimationGraphTimeline(graph, recipes, { duration: testCase.duration,
        ...(testCase.naturalCompletionFadeSeconds === undefined ? {} : { naturalCompletionFadeSeconds: testCase.naturalCompletionFadeSeconds }),
        ...(testCase.observedBlendAnimationLengths === undefined ? {} : { observedBlendAnimationLengths: testCase.observedBlendAnimationLengths }),
        ...(testCase.observedBlendAnimationPlaybackSpeeds === undefined ? {} : { observedBlendAnimationPlaybackSpeeds: testCase.observedBlendAnimationPlaybackSpeeds }),
        ...(testCase.observedBlendAnimationStartPhases === undefined ? {} : { observedBlendAnimationStartPhases: testCase.observedBlendAnimationStartPhases }),
        ...(testCase.observedBlendAnimationAssetSetFingerprint === undefined ? {} : {
          observedBlendAnimationAssetSetFingerprint: testCase.observedBlendAnimationAssetSetFingerprint }),
        ...(testCase.expectedBlendAnimationAssetSetFingerprint === undefined ? {} : {
          expectedBlendAnimationAssetSetFingerprint: testCase.expectedBlendAnimationAssetSetFingerprint }),
        initialParameters: testCase.initialParameters, events: testCase.events, sampleTimes: pointSampleTimes,
        includePoseSamples: false }, options.fadeProfiles);
      for (const expectation of poseExpectations) if (expectation.throughout) {
        const includeMotionProbes = expectation.throughout.maxLinearSpeedStudsPerSecond !== undefined
          || expectation.throughout.maxAngularSpeedDegreesPerSecond !== undefined
          || expectation.throughout.maxLinearAccelerationStudsPerSecondSquared !== undefined
          || expectation.throughout.maxAngularAccelerationDegreesPerSecondSquared !== undefined
          || expectation.throughout.maxLinearStepStuds !== undefined
          || expectation.throughout.maxAngularStepDegrees !== undefined;
        const criticalTimes = criticalPoseWindowTimes(graph, recipes, preliminary.timeline, expectation.joint,
          expectation.throughout, includeMotionProbes, criticalLocalTimesCache);
        criticalTimesByWindow.set(expectation, criticalTimes);
        for (const at of criticalTimes) requestedSampleTimes.add(at);
      }
      for (const { pose, source, window } of sourceWindows) {
        const includeMotionProbes = window.maxLinearSpeedStudsPerSecond !== undefined || window.maxAngularSpeedDegreesPerSecond !== undefined
          || window.maxLinearAccelerationStudsPerSecondSquared !== undefined || window.maxAngularAccelerationDegreesPerSecondSquared !== undefined
          || window.maxLinearStepStuds !== undefined || window.maxAngularStepDegrees !== undefined;
        const criticalTimes = criticalPoseWindowTimes(graph, recipes, preliminary.timeline, pose.joint, window,
          includeMotionProbes, criticalLocalTimesCache);
        criticalTimesBySourceWindow.set(source, criticalTimes);
        for (const at of criticalTimes) requestedSampleTimes.add(at);
      }
    }
    if (requestedSampleTimes.size > 512) throw new Error(`Case ${testCase.id} expands to ${requestedSampleTimes.size} explicit pose/blend timestamps after adding authored key and transition boundaries; the per-case limit is 512.`);
    aggregatePoseSamplePairs += requestedSampleTimes.size * poseJoints.length;
    if (aggregatePoseSamplePairs > 20000) throw new Error('Timeline suite exceeded 20,000 aggregate joint-time pose samples after expanding authored key and transition boundaries. Reduce window duration, sample rate, or joint count.');
    const report = simulateAnimationGraphTimeline(graph, recipes, { duration: testCase.duration,
      ...(testCase.naturalCompletionFadeSeconds === undefined ? {} : { naturalCompletionFadeSeconds: testCase.naturalCompletionFadeSeconds }),
      ...(testCase.observedBlendAnimationLengths === undefined ? {} : { observedBlendAnimationLengths: testCase.observedBlendAnimationLengths }),
      ...(testCase.observedBlendAnimationPlaybackSpeeds === undefined ? {} : { observedBlendAnimationPlaybackSpeeds: testCase.observedBlendAnimationPlaybackSpeeds }),
      ...(testCase.observedBlendAnimationStartPhases === undefined ? {} : { observedBlendAnimationStartPhases: testCase.observedBlendAnimationStartPhases }),
      ...(testCase.observedBlendAnimationAssetSetFingerprint === undefined ? {} : {
        observedBlendAnimationAssetSetFingerprint: testCase.observedBlendAnimationAssetSetFingerprint }),
      ...(testCase.expectedBlendAnimationAssetSetFingerprint === undefined ? {} : {
        expectedBlendAnimationAssetSetFingerprint: testCase.expectedBlendAnimationAssetSetFingerprint }),
      initialParameters: testCase.initialParameters, events: testCase.events, sampleTimes: [...requestedSampleTimes],
      poseJoints, includePoseSamples: poseExpectations.length > 0,
      ...(testCase.expect.maxEventOrderDivergences === undefined ? {} : {
        analyzeEventOrderSensitivity: true, maxEventOrderDivergences: testCase.expect.maxEventOrderDivergences,
      }) }, options.fadeProfiles);
    if (options.includeStudioCalibrationTrace && poseExpectations.length > 0) {
      const calibrationRequests = new Map<number, Set<string>>();
      const request = (at: number, joint: string) => {
        const joints = calibrationRequests.get(at) ?? new Set<string>();
        joints.add(joint);
        calibrationRequests.set(at, joints);
      };
      for (const expectation of poseExpectations) {
        request(expectation.at, expectation.joint);
        if (expectation.throughout) {
          const times = [...new Set([...poseWindowTimes(expectation.throughout), ...(criticalTimesByWindow.get(expectation) ?? [])])];
          for (const at of times) request(at, expectation.joint);
        }
      }
      for (const [at, joints] of [...calibrationRequests].sort(([left], [right]) => left - right)) {
        const blend = report.blendSamples.find(candidate => candidate.at === at);
        const poseSample = report.composedPoseSamples.find(candidate => candidate.at === at);
        if (!blend || !poseSample) throw new Error(`Case ${testCase.id} cannot produce native-Animator calibration evidence at ${at} seconds.`);
        const predictedJoints = [...joints].sort().map(joint => {
          const pose = poseSample.joints.find(candidate => candidate.joint === joint);
          if (!pose) throw new Error(`Case ${testCase.id} has no composed-pose estimate for ${joint} at ${at} seconds.`);
          return { joint, predicted: { position: pose.position, rotationQuaternion: pose.rotationQuaternion },
            simulatedResidualBasis: report.poseModel.residualBasis,
            simulatedContributors: pose.contributors.map(contributor => ({ stateId: contributor.stateId,
              ...(contributor.blendControllerStateId ? { blendControllerStateId: contributor.blendControllerStateId } : {}),
              priority: contributor.priority,
              trackWeight: contributor.trackWeight, effectiveWeight: contributor.effectiveWeight,
              contributionStatus: contributor.contributionStatus, position: contributor.position,
              rotationQuaternion: contributor.rotationQuaternion })),
            simulatedPriorityLayers: pose.priorityLayers,
            simulatedResidualWeight: pose.residualWeight };
        });
        calibrationPairCount += predictedJoints.length;
        if (calibrationPairCount > 4096) throw new Error('Live native-Animator calibration exceeds 4,096 joint samples. Split the timeline plan into smaller reviewed runs.');
        const mostRecentTransition = report.timeline.filter(event => typeof event.at === 'number' && event.at <= at
          && typeof event.transitionId === 'string' && typeof event.stateBefore === 'string'
          && typeof event.stateAfter === 'string' && typeof event.blendSeconds === 'number').at(-1);
        const markersAtSample = report.triggeredMarkers.filter(marker => marker.at === at)
          .map(marker => ({ stateId: marker.stateId, name: marker.marker, value: marker.value }));
        studioCalibrationTrace.push({ caseId: testCase.id, at,
          tracks: blend.activeTracks.map(track => ({ stateId: track.stateId, weight: track.weight, playbackTimeSeconds: track.playbackTimeSeconds })),
          timelineContext: { mostRecentTransition: mostRecentTransition ? {
            transitionId: mostRecentTransition.transitionId as string, fromState: mostRecentTransition.stateBefore as string,
            toState: mostRecentTransition.stateAfter as string, startedAt: mostRecentTransition.at as number,
            blendSeconds: mostRecentTransition.blendSeconds as number,
            progress: mostRecentTransition.blendSeconds === 0 ? 1 : Math.max(0, Math.min(1, (at - (mostRecentTransition.at as number)) / (mostRecentTransition.blendSeconds as number))),
            sourceWeightAtTransition: mostRecentTransition.sourceWeightAtTransition as number,
            destinationWeightAtTransition: mostRecentTransition.destinationWeightAtTransition as number,
            destinationFadeStartWeight: mostRecentTransition.destinationFadeStartWeight as number,
          } : null, markersAtSample },
          joints: predictedJoints });
      }
    }
    aggregateEvents += report.scheduledEvents;
    if (aggregateEvents > 20000) throw new Error('Timeline suite exceeded 20,000 aggregate scheduled events. Reduce case duration or loop-marker density.');
    const blendContextAt = (at: number, pose: NonNullable<ReturnType<typeof simulateAnimationGraphTimeline>['composedPoseSamples'][number]['joints'][number]>) => {
      const blend = report.blendSamples.find(candidate => candidate.at === at);
      const transition = report.timeline.filter(event => typeof event.at === 'number' && event.at <= at && event.transitionId).at(-1);
      const blendSeconds = transition && typeof transition.blendSeconds === 'number' ? transition.blendSeconds : 0;
      const blendProgress = transition && typeof transition.at === 'number'
        ? blendSeconds > 0 ? Math.max(0, Math.min(1, (at - transition.at) / blendSeconds)) : 1 : null;
      return {
        currentState: blend?.currentState ?? null,
        activeTracks: blend?.activeTracks.map(track => {
          const contributor = pose.contributors.find(candidate => candidate.stateId === track.stateId);
          return { stateId: track.stateId, weight: track.weight, targetWeight: track.targetWeight,
            fadeRemainingSeconds: track.fadeRemainingSeconds, playbackTimeSeconds: track.playbackTimeSeconds,
            isPlaying: track.isPlaying, isAffectingPose: track.isAffectingPose,
            ...(track.fadeCalibrationProfileId ? { fadeCalibrationProfileId: track.fadeCalibrationProfileId,
              fadeCalibrationDirection: track.fadeCalibrationDirection, fadeCalibrationRebased: track.fadeCalibrationRebased } : {}),
            ...(contributor ? { drivesJoint: true, priority: contributor.priority, effectiveWeight: contributor.effectiveWeight,
              contributionStatus: contributor.contributionStatus } : { drivesJoint: false }),
          };
        }) ?? [],
        lastTransition: transition && typeof transition.at === 'number' && typeof transition.transitionId === 'string' ? {
          transitionId: transition.transitionId, from: transition.stateBefore ?? null, to: transition.stateAfter ?? null,
          startedAt: transition.at, blendSeconds, fadeEndsAt: transition.at + blendSeconds, blendProgress,
          phase: blendProgress !== null && blendProgress < 1 ? 'crossfading' as const : 'settled' as const,
        } : null,
      };
    };
    const failures: Array<{ expectation: string; expected: unknown; observed: unknown; diagnosis?: PoseDiagnosis;
      motionGuidance?: MotionGateGuidance;
      reason?: 'transition_occurrence_not_observed' | 'playback_clock_decision_mismatch' | 'incomplete_ramp_not_observed'
        | 'parameter_ramp_not_observed' | 'parameter_ramp_lifecycle_mismatch';
      observedTransitionOccurrences?: number }> = [];
    const expected = testCase.expect;
    const eventOrderingCheck = expected.maxAmbiguousEventOrderingCollisions === undefined ? undefined : {
      status: report.eventOrderingDiagnostics.ambiguousCollisionCount <= expected.maxAmbiguousEventOrderingCollisions ? 'passed' as const : 'failed' as const,
      maximumAllowedCollisions: expected.maxAmbiguousEventOrderingCollisions,
      observedCollisions: report.eventOrderingDiagnostics.ambiguousCollisionCount,
    };
    if (eventOrderingCheck?.status === 'failed') failures.push({ expectation: 'eventOrdering:ambiguousCollisionCount',
      expected: { maximum: eventOrderingCheck.maximumAllowedCollisions }, observed: eventOrderingCheck.observedCollisions });
    const eventOrderSensitivityCheck = expected.maxEventOrderDivergences === undefined ? undefined : report.eventOrderSensitivity?.gate ?? undefined;
    if (eventOrderSensitivityCheck?.status === 'failed') failures.push({ expectation: 'eventOrderSensitivity:divergenceCount',
      expected: { maximum: eventOrderSensitivityCheck.maximumAllowedDivergences }, observed: eventOrderSensitivityCheck.observedDivergences });
    if (expected.finalState !== undefined && report.finalState !== expected.finalState) failures.push({ expectation: 'finalState', expected: expected.finalState, observed: report.finalState });
    if (expected.transitionIds) {
      const actual = report.transitionIds;
      const matched = expected.transitionIds.mode === 'exact' ? canonical(actual) === canonical(expected.transitionIds.ids)
        : expected.transitionIds.mode === 'contains' ? expected.transitionIds.ids.every(id => actual.includes(id))
          : (() => { let cursor = 0; return expected.transitionIds!.ids.every(id => { const index = actual.indexOf(id, cursor); if (index < 0) return false; cursor = index + 1; return true; }); })();
      if (!matched) failures.push({ expectation: 'transitionIds', expected: expected.transitionIds, observed: actual });
    }
    for (const markerExpectation of expected.markers) {
      const observed = report.triggeredMarkers.filter(marker => marker.marker.toLowerCase() === markerExpectation.name.toLowerCase()
        && (!markerExpectation.window || (marker.at >= markerExpectation.window.start && marker.at <= markerExpectation.window.end))).length;
      const maximum = markerExpectation.maxCount ?? Number.POSITIVE_INFINITY;
      if (observed < markerExpectation.minCount || observed > maximum) failures.push({ expectation: `marker:${markerExpectation.name}`,
        expected: { minCount: markerExpectation.minCount, maxCount: markerExpectation.maxCount ?? null, window: markerExpectation.window ?? null }, observed });
    }
    for (const stateExpectation of expected.stateAt) {
      const stateEvent = report.timeline.filter(event => typeof event.at === 'number' && event.at <= stateExpectation.at).at(-1);
      const observed = stateEvent?.stateAfter ?? graph.entryState;
      if (observed !== stateExpectation.stateId) failures.push({ expectation: `stateAt:${stateExpectation.at}`, expected: stateExpectation.stateId, observed });
    }
    for (const transitionExpectation of expected.transitionTimes) {
      const occurrence = report.timeline.filter(event => event.transitionId === transitionExpectation.transitionId)[transitionExpectation.occurrence - 1];
      const observed = occurrence && typeof occurrence.at === 'number' ? occurrence.at : undefined;
      if (observed === undefined || (transitionExpectation.minAt !== undefined && observed < transitionExpectation.minAt)
        || (transitionExpectation.maxAt !== undefined && observed > transitionExpectation.maxAt)) {
        failures.push({ expectation: `transitionTime:${transitionExpectation.transitionId}#${transitionExpectation.occurrence}`,
          expected: { minAt: transitionExpectation.minAt ?? null, maxAt: transitionExpectation.maxAt ?? null }, observed: observed ?? null });
      }
    }
    const playbackClockChecks = (expected.playbackClock ?? []).map(clockExpectation => {
      const matchingTransitions = report.timeline.filter(event => event.transitionId === clockExpectation.transitionId);
      const transition = matchingTransitions[clockExpectation.occurrence - 1];
      const observed = transition?.playbackClockDecision;
      const passed = observed === clockExpectation.decision;
      if (!passed) failures.push({ expectation: `playbackClock:${clockExpectation.transitionId}#${clockExpectation.occurrence}`,
        expected: clockExpectation.decision, observed: observed ?? null,
        reason: transition ? 'playback_clock_decision_mismatch' : 'transition_occurrence_not_observed',
        observedTransitionOccurrences: matchingTransitions.length });
      return { transitionId: clockExpectation.transitionId, occurrence: clockExpectation.occurrence,
        status: passed ? 'passed' as const : 'failed' as const, expected: clockExpectation.decision, observed: observed ?? null,
        failureReason: passed ? null : transition ? 'playback_clock_decision_mismatch' as const : 'transition_occurrence_not_observed' as const,
        observedTransitionOccurrences: matchingTransitions.length };
    });
    const phaseDonorChecks = (expected.phaseDonors ?? []).map(donorExpectation => {
      const update = report.timeline.find(event => event.event === 'set_parameters' && event.inputIndex === donorExpectation.inputIndex
        && (donorExpectation.at === undefined || (typeof event.at === 'number' && Math.abs(event.at - donorExpectation.at) <= 1e-9)));
      const normalizedPhase = typeof update?.phaseSourceNormalizedPhase === 'number' ? update.phaseSourceNormalizedPhase : null;
      const currentWeight = typeof update?.phaseSourceCurrentWeight === 'number' ? update.phaseSourceCurrentWeight : null;
      const targetWeight = typeof update?.phaseSourceTargetWeight === 'number' ? update.phaseSourceTargetWeight : null;
      const restartedStateIds = Array.isArray(update?.restartedStateIds)
        ? update.restartedStateIds.filter((value): value is string => typeof value === 'string') : null;
      const observed = update ? { stateId: update.phaseSourceStateId ?? null, restartedStateIds,
        normalizedPhase, currentWeight, targetWeight } : null;
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [
        { property: 'stateId', expected: donorExpectation.stateId, observed: observed?.stateId ?? null,
          passed: observed?.stateId === donorExpectation.stateId },
      ];
      if (donorExpectation.restartedStateIds !== undefined) checks.push({ property: 'restartedStateIds',
        expected: donorExpectation.restartedStateIds, observed: observed?.restartedStateIds ?? null,
        passed: canonical(observed?.restartedStateIds ?? null) === canonical(donorExpectation.restartedStateIds) });
      const inRange = (value: number | null | undefined, range: { min?: number; max?: number } | undefined) => range === undefined
        || (value !== null && value !== undefined && (range.min === undefined || value >= range.min)
          && (range.max === undefined || value <= range.max));
      for (const property of ['normalizedPhase', 'currentWeight', 'targetWeight'] as const) {
        const range = donorExpectation[property];
        if (range) checks.push({ property, expected: range, observed: observed?.[property] ?? null,
          passed: inRange(observed?.[property], range) });
      }
      const passed = observed !== null && checks.every(check => check.passed);
      if (!passed) failures.push({ expectation: `phaseDonor:${donorExpectation.inputIndex}`,
        expected: donorExpectation, observed });
      return { inputIndex: donorExpectation.inputIndex, at: donorExpectation.at ?? null,
        status: passed ? 'passed' as const : 'failed' as const,
        expected: donorExpectation, observed, checks };
    });
    const incompleteParameterRampChecks = (expected.incompleteParameterRamps ?? []).map(rampExpectation => {
      const observed = report.incompleteParameterRamps.find(ramp => ramp.inputIndex === rampExpectation.inputIndex);
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [];
      const matchesRange = (value: number | undefined, range: { min?: number; max?: number } | undefined) => range === undefined
        || (value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max));
      if (rampExpectation.simulatedProgress) checks.push({ property: 'simulatedProgress', expected: rampExpectation.simulatedProgress,
        observed: observed?.simulatedProgress ?? null, passed: matchesRange(observed?.simulatedProgress, rampExpectation.simulatedProgress) });
      if (rampExpectation.easedProgress) checks.push({ property: 'easedProgress', expected: rampExpectation.easedProgress,
        observed: observed?.easedProgress ?? null, passed: matchesRange(observed?.easedProgress, rampExpectation.easedProgress) });
      if (rampExpectation.remainingSecondsAtHorizon) checks.push({ property: 'remainingSecondsAtHorizon',
        expected: rampExpectation.remainingSecondsAtHorizon, observed: observed?.remainingSecondsAtHorizon ?? null,
        passed: matchesRange(observed?.remainingSecondsAtHorizon, rampExpectation.remainingSecondsAtHorizon) });
      for (const parameterExpectation of rampExpectation.parameters) {
        const parameter = observed?.parameters.find(candidate => candidate.name === parameterExpectation.name);
        if (parameterExpectation.currentValue) checks.push({ property: `parameter:${parameterExpectation.name}:currentValue`,
          expected: parameterExpectation.currentValue, observed: parameter?.currentValue ?? null,
          passed: matchesRange(parameter?.currentValue, parameterExpectation.currentValue) });
        if (parameterExpectation.targetValue) checks.push({ property: `parameter:${parameterExpectation.name}:targetValue`,
          expected: parameterExpectation.targetValue, observed: parameter?.targetValue ?? null,
          passed: matchesRange(parameter?.targetValue, parameterExpectation.targetValue) });
      }
      if (!observed || checks.some(check => !check.passed)) failures.push({ expectation: `incompleteParameterRamp:${rampExpectation.inputIndex}`,
        expected: rampExpectation, observed: observed ?? null,
        ...(!observed ? { reason: 'incomplete_ramp_not_observed' as const } : {}) });
      return { inputIndex: rampExpectation.inputIndex, status: observed && checks.every(check => check.passed) ? 'passed' as const : 'failed' as const,
        expected: rampExpectation, observed: observed ?? null, checks,
        failureReason: observed ? checks.some(check => !check.passed) ? 'incomplete_ramp_expectation_mismatch' as const : null
          : 'incomplete_ramp_not_observed' as const };
    });
    const parameterRampLifecycleChecks = (expected.parameterRampLifecycle ?? []).map(rampExpectation => {
      const observed = report.parameterRampLifecycle.find(ramp => ramp.inputIndex === rampExpectation.inputIndex);
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [];
      const inRange = (value: number | undefined, range: { min?: number; max?: number } | undefined) => range === undefined
        || (value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max));
      if (rampExpectation.status !== undefined) checks.push({ property: 'status', expected: rampExpectation.status,
        observed: observed?.status ?? null, passed: observed?.status === rampExpectation.status });
      for (const parameterExpectation of rampExpectation.parameters) {
        const channel = observed?.channels.find(candidate => candidate.name === parameterExpectation.name);
        if (parameterExpectation.status !== undefined) checks.push({ property: `parameter:${parameterExpectation.name}:status`,
          expected: parameterExpectation.status, observed: channel?.status ?? null,
          passed: channel?.status === parameterExpectation.status });
        if (parameterExpectation.observedValue !== undefined) checks.push({ property: `parameter:${parameterExpectation.name}:observedValue`,
          expected: parameterExpectation.observedValue, observed: channel?.observedValue ?? null,
          passed: inRange(channel?.observedValue ?? undefined, parameterExpectation.observedValue) });
        if (parameterExpectation.targetValue !== undefined) checks.push({ property: `parameter:${parameterExpectation.name}:targetValue`,
          expected: parameterExpectation.targetValue, observed: channel?.targetValue ?? null,
          passed: inRange(channel?.targetValue, parameterExpectation.targetValue) });
        if (parameterExpectation.endedAt !== undefined) checks.push({ property: `parameter:${parameterExpectation.name}:endedAt`,
          expected: parameterExpectation.endedAt, observed: channel?.endedAt ?? null,
          passed: inRange(channel?.endedAt ?? undefined, parameterExpectation.endedAt) });
      }
      const passed = observed !== undefined && checks.every(check => check.passed);
      if (!passed) failures.push({ expectation: `parameterRampLifecycle:${rampExpectation.inputIndex}`,
        expected: rampExpectation, observed: observed ?? null,
        reason: observed ? 'parameter_ramp_lifecycle_mismatch' : 'parameter_ramp_not_observed' });
      return { inputIndex: rampExpectation.inputIndex, status: passed ? 'passed' as const : 'failed' as const,
        expected: rampExpectation, observed: observed ?? null, checks,
        failureReason: passed ? null : observed ? 'parameter_ramp_lifecycle_mismatch' as const : 'parameter_ramp_not_observed' as const };
    });
    const trackLifecycleChecks = (expected.trackLifecycles ?? []).map(lifecycleExpectation => {
      const observed = report.trackLifecycles.find(track => track.stateId === lifecycleExpectation.stateId);
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [];
      if (lifecycleExpectation.status !== undefined) checks.push({ property: 'status', expected: lifecycleExpectation.status,
        observed: observed?.status ?? null, passed: observed?.status === lifecycleExpectation.status });
      if (lifecycleExpectation.playbackCount !== undefined) checks.push({ property: 'playbackCount', expected: lifecycleExpectation.playbackCount,
        observed: observed?.playbackCount ?? null, passed: observed?.playbackCount === lifecycleExpectation.playbackCount });
      if (lifecycleExpectation.latestEndReason !== undefined) checks.push({ property: 'latestEndReason', expected: lifecycleExpectation.latestEndReason,
        observed: observed?.latestEndReason ?? null, passed: observed?.latestEndReason === lifecycleExpectation.latestEndReason });
      const passed = observed !== undefined && checks.every(check => check.passed);
      if (!passed) failures.push({ expectation: `trackLifecycle:${lifecycleExpectation.stateId}`,
        expected: lifecycleExpectation, observed: observed ?? null });
      return { stateId: lifecycleExpectation.stateId, status: passed ? 'passed' as const : 'failed' as const,
        expected: lifecycleExpectation, observed: observed ?? null, checks };
    });
    const blendChecks = expected.blends.map(blendExpectation => {
      const sample = report.blendSamples.find(candidate => candidate.at === blendExpectation.at);
      const observed = sample?.activeTracks.find(track => track.stateId === blendExpectation.stateId);
      const observedBlendSpace = sample?.blendSpaceEvaluations.find(evaluation => evaluation.controllerStateId === blendExpectation.stateId);
      const present = observed !== undefined;
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [];
      if (!sample) checks.push({ property: 'sample', expected: blendExpectation.at, observed: null, passed: false });
      if (blendExpectation.present !== undefined) checks.push({ property: 'present', expected: blendExpectation.present, observed: present, passed: blendExpectation.present === present });
      const inRange = (value: number | undefined, range: { min?: number; max?: number } | undefined) => range === undefined
        || (value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max));
      for (const property of ['weight', 'targetWeight', 'fadeRemainingSeconds', 'playbackTimeSeconds'] as const) {
        const range = blendExpectation[property];
        if (range) {
          const value = observed?.[property];
          checks.push({ property, expected: range, observed: value ?? null, passed: inRange(value, range) });
        }
      }
      for (const property of ['isPlaying', 'isAffectingPose'] as const) {
        const value = blendExpectation[property];
        if (value !== undefined) checks.push({ property, expected: value, observed: observed?.[property] ?? null, passed: observed?.[property] === value });
      }
      if (blendExpectation.blendSpace) {
        if (!observedBlendSpace) checks.push({ property: 'blendSpace', expected: blendExpectation.blendSpace, observed: null, passed: false });
        if (blendExpectation.blendSpace.parameterValue) {
          const range = blendExpectation.blendSpace.parameterValue;
          const value = observedBlendSpace?.value;
          checks.push({ property: 'blendSpace.parameterValue', expected: range,
            observed: typeof value === 'number' ? value : null, passed: inRange(typeof value === 'number' ? value : undefined, range) });
        }
        if (blendExpectation.blendSpace.parameterValues) {
          for (const axis of ['x', 'y'] as const) {
            const range = blendExpectation.blendSpace.parameterValues[axis];
            if (!range) continue;
            const value = observedBlendSpace?.axisValues?.[axis];
            checks.push({ property: `blendSpace.parameterValues.${axis}`, expected: range,
              observed: value ?? null, passed: inRange(value, range) });
          }
        }
        if (blendExpectation.blendSpace.phaseSync) {
          const { stateIds, maxCircularPhaseDifference } = blendExpectation.blendSpace.phaseSync;
          const sourcePhases = stateIds.map(sourceStateId => {
            const source = observedBlendSpace?.samples.find(candidate => candidate.stateId === sourceStateId);
            return { stateId: sourceStateId, normalizedPhase: source?.playback.normalizedPhase ?? null,
              isPlaying: source?.playback.isPlaying ?? false,
              poseContributionWeight: source?.poseContributionWeight ?? null,
              eligibility: !source ? 'not_sampled' as const : source.playback.normalizedPhase === null
                ? 'phase_unavailable' as const : !source.playback.isPlaying ? 'not_playing' as const : 'eligible' as const };
          });
          const validPhases = sourcePhases.filter((source): source is typeof source & { normalizedPhase: number } =>
            source.normalizedPhase !== null && source.isPlaying);
          let maxCircularPhaseDifferenceObserved: number | null = null;
          let worstPhasePair: { stateIds: [string, string]; circularDifference: number } | null = null;
          if (validPhases.length === sourcePhases.length) {
            maxCircularPhaseDifferenceObserved = 0;
            for (let left = 0; left < validPhases.length; left++) for (let right = left + 1; right < validPhases.length; right++) {
              const difference = Math.abs(validPhases[left]!.normalizedPhase - validPhases[right]!.normalizedPhase);
              const circularDifference = Math.min(difference, 1 - difference);
              if (worstPhasePair === null || circularDifference > maxCircularPhaseDifferenceObserved + 1e-12) {
                maxCircularPhaseDifferenceObserved = circularDifference;
                worstPhasePair = { stateIds: [validPhases[left]!.stateId, validPhases[right]!.stateId], circularDifference };
              }
            }
          }
          const passed = maxCircularPhaseDifferenceObserved !== null
            && maxCircularPhaseDifferenceObserved <= maxCircularPhaseDifference + 1e-12;
          checks.push({ property: 'blendSpace.phaseSync', expected: { stateIds, maxCircularPhaseDifference },
            observed: { sourcePhases, maxCircularPhaseDifference: maxCircularPhaseDifferenceObserved, worstPair: worstPhasePair }, passed });
        }
        if (blendExpectation.blendSpace.phaseSyncThroughout) {
          const { stateIds, maxCircularPhaseDifference } = blendExpectation.blendSpace.phaseSyncThroughout;
          const sourceDurations = new Map(stateIds.map(sourceStateId => {
            const sourceState = graph.states.find(candidate => candidate.id === sourceStateId);
            return [sourceStateId, testCase.observedBlendAnimationLengths?.[blendExpectation.stateId]?.[sourceStateId]
              ?? (sourceState ? recipes[sourceState.animationId]?.duration : undefined)] as const;
          }));
          const phaseSynchronization = analyzeBlendSpacePhaseSynchronization(report.blendSamples, blendExpectation.stateId,
            stateIds, sourceDurations);
          const passed = phaseSynchronization.coverageStatus === 'complete'
            && phaseSynchronization.maxCircularPhaseDifference !== null
            && phaseSynchronization.maxCircularPhaseDifference <= maxCircularPhaseDifference + 1e-12;
          checks.push({ property: 'blendSpace.phaseSyncThroughout', expected: { stateIds, maxCircularPhaseDifference },
            observed: { ...phaseSynchronization, measurementBasis: 'sampled_points_and_constant_speed_intervals' as const }, passed });
        }
        for (const clipExpectation of blendExpectation.blendSpace.clips ?? []) {
          const clip = observedBlendSpace?.samples.find(candidate => candidate.stateId === clipExpectation.stateId);
          if (clipExpectation.weight !== undefined) checks.push({ property: `blendSpace.clipWeight:${clipExpectation.stateId}`, expected: clipExpectation.weight,
            observed: clip?.weight ?? null, passed: inRange(clip?.weight, clipExpectation.weight) });
          if (clipExpectation.poseContributionWeight !== undefined) checks.push({ property: `blendSpace.poseContributionWeight:${clipExpectation.stateId}`,
            expected: clipExpectation.poseContributionWeight, observed: clip?.poseContributionWeight ?? null,
            passed: inRange(clip?.poseContributionWeight, clipExpectation.poseContributionWeight) });
          if (clipExpectation.targetPoseContributionWeight !== undefined) checks.push({ property: `blendSpace.targetPoseContributionWeight:${clipExpectation.stateId}`,
            expected: clipExpectation.targetPoseContributionWeight, observed: clip?.targetPoseContributionWeight ?? null,
            passed: inRange(clip?.targetPoseContributionWeight, clipExpectation.targetPoseContributionWeight) });
          if (clipExpectation.playback) {
            for (const property of ['timeSeconds', 'normalizedPhase', 'playbackSpeed', 'playbackCycleDurationSeconds',
              'playbackCycleDurationRatioToController'] as const) {
              const range = clipExpectation.playback[property];
              if (range !== undefined) {
                const observed = clip?.playback[property];
                checks.push({ property: `blendSpace.playback.${property}:${clipExpectation.stateId}`, expected: range,
                  observed: observed ?? null, passed: inRange(observed, range) });
              }
            }
            if (clipExpectation.playback.isPlaying !== undefined) checks.push({
              property: `blendSpace.playback.isPlaying:${clipExpectation.stateId}`, expected: clipExpectation.playback.isPlaying,
              observed: clip?.playback.isPlaying ?? null, passed: clip?.playback.isPlaying === clipExpectation.playback.isPlaying });
          }
        }
      }
      const failedChecks = checks.filter(check => !check.passed);
      for (const check of failedChecks) failures.push({ expectation: `blend:${blendExpectation.stateId}@${blendExpectation.at}:${check.property}`,
        expected: check.expected, observed: check.observed });
      return { at: blendExpectation.at, stateId: blendExpectation.stateId, status: failedChecks.length === 0 ? 'passed' as const : 'failed' as const,
        checks, track: observed ?? null, blendSpace: observedBlendSpace ?? null };
    });
    const poseChecks = poseExpectations.map(poseExpectation => {
      const sample = report.composedPoseSamples.find(candidate => candidate.at === poseExpectation.at);
      const observed = sample?.joints.find(candidate => candidate.joint === poseExpectation.joint);
      const checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> = [];
      const diagnosis = observed ? diagnosePoseContribution(observed) : null;
      if (!sample) {
        checks.push({ property: 'sample', expected: poseExpectation.at, observed: null, passed: false });
        failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:sample`, expected: poseExpectation.at, observed: null });
      }
      if (!observed) {
        checks.push({ property: 'joint', expected: poseExpectation.joint, observed: null, passed: false });
        failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:joint`, expected: poseExpectation.joint, observed: null });
      }
      if (poseExpectation.missingBlendChannels !== undefined) {
        const expected = [...poseExpectation.missingBlendChannels].sort((left, right) => left.controllerStateId.localeCompare(right.controllerStateId)
          || left.sourceStateId.localeCompare(right.sourceStateId));
        const observedMissing = observed ? diagnosePoseContribution(observed).missingBlendChannels
          .map(channel => ({ controllerStateId: channel.controllerStateId, sourceStateId: channel.sourceStateId })) : null;
        const sortedObserved = observedMissing ? [...observedMissing].sort((left, right) => left.controllerStateId.localeCompare(right.controllerStateId)
          || left.sourceStateId.localeCompare(right.sourceStateId)) : null;
        const passed = sortedObserved !== null && canonical(sortedObserved) === canonical(expected);
        checks.push({ property: 'missingBlendChannels', expected, observed: sortedObserved, passed });
        if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:missingBlendChannels`,
          expected, observed: sortedObserved, diagnosis: diagnosis ?? undefined });
      }
      for (const sourceExpectation of poseExpectation.blendSourcePoses ?? []) {
        const source = observed?.contributors.find(contributor => contributor.blendControllerStateId === sourceExpectation.controllerStateId
          && contributor.stateId === sourceExpectation.sourceStateId);
        const sourceLabel = `${sourceExpectation.controllerStateId}/${sourceExpectation.sourceStateId}`;
        if (!source) {
          const missingChannel = observed?.unanimatedTracks.find(track => track.blendControllerStateId === sourceExpectation.controllerStateId
            && track.stateId === sourceExpectation.sourceStateId);
          const sourceStatus = missingChannel ? { status: 'missing_joint_channel' as const, priority: missingChannel.priority,
            trackWeight: missingChannel.trackWeight, targetTrackWeight: missingChannel.targetTrackWeight,
            playbackTimeSeconds: missingChannel.playbackTimeSeconds, reason: missingChannel.reason } : { status: 'not_contributing' as const };
          const property = `blendSourcePose.present:${sourceLabel}`;
          checks.push({ property, expected: true, observed: sourceStatus, passed: false });
          failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:${property}`, expected: true, observed: sourceStatus,
            diagnosis: diagnosis ?? undefined });
          continue;
        }
        if (sourceExpectation.effectiveWeight) {
          const range = sourceExpectation.effectiveWeight;
          const passed = (range.min === undefined || source.effectiveWeight >= range.min)
            && (range.max === undefined || source.effectiveWeight <= range.max);
          const property = `blendSourcePose.effectiveWeight:${sourceLabel}`;
          checks.push({ property, expected: range, observed: source.effectiveWeight, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:${property}`,
            expected: range, observed: { effectiveWeight: source.effectiveWeight, trackWeight: source.trackWeight,
              contributionStatus: source.contributionStatus, priority: source.priority } });
        }
        if (sourceExpectation.expectedPosition) {
          const errorStuds = Math.hypot(...source.position.map((value, axis) => value - sourceExpectation.expectedPosition![axis]!));
          const property = `blendSourcePose.positionErrorStuds:${sourceLabel}`;
          const passed = errorStuds <= sourceExpectation.positionToleranceStuds!;
          checks.push({ property, expected: { position: sourceExpectation.expectedPosition, toleranceStuds: sourceExpectation.positionToleranceStuds },
            observed: { position: source.position, errorStuds }, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:${property}`,
            expected: { position: sourceExpectation.expectedPosition, toleranceStuds: sourceExpectation.positionToleranceStuds },
            observed: { position: source.position, errorStuds, effectiveWeight: source.effectiveWeight, rotationQuaternion: source.rotationQuaternion } });
        }
        if (sourceExpectation.expectedRotation) {
          const errorDegrees = rotationGapDegrees(sourceExpectation.expectedRotation, source.rotationQuaternion);
          const property = `blendSourcePose.rotationErrorDegrees:${sourceLabel}`;
          const passed = errorDegrees <= sourceExpectation.rotationToleranceDegrees!;
          checks.push({ property, expected: { rotation: sourceExpectation.expectedRotation, toleranceDegrees: sourceExpectation.rotationToleranceDegrees },
            observed: { rotationQuaternion: source.rotationQuaternion, errorDegrees }, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:${property}`,
            expected: { rotation: sourceExpectation.expectedRotation, toleranceDegrees: sourceExpectation.rotationToleranceDegrees },
            observed: { position: source.position, rotationQuaternion: source.rotationQuaternion, errorDegrees, effectiveWeight: source.effectiveWeight } });
        }
      }
      if (poseExpectation.expectedPosition && observed) {
        const errorStuds = Math.hypot(...observed.position.map((value, axis) => value - poseExpectation.expectedPosition![axis]!));
        const passed = errorStuds <= poseExpectation.positionToleranceStuds!;
        checks.push({ property: 'positionErrorStuds', expected: { maximum: poseExpectation.positionToleranceStuds, position: poseExpectation.expectedPosition }, observed: errorStuds, passed });
        if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:position`,
          expected: { position: poseExpectation.expectedPosition, toleranceStuds: poseExpectation.positionToleranceStuds }, observed: { position: observed.position, errorStuds },
          diagnosis: diagnosePoseContribution(observed, poseExpectation.expectedPosition) });
      }
      if (poseExpectation.expectedRotation && observed) {
        const errorDegrees = rotationGapDegrees(poseExpectation.expectedRotation, observed.rotationQuaternion);
        const passed = errorDegrees <= poseExpectation.rotationToleranceDegrees!;
        checks.push({ property: 'rotationErrorDegrees', expected: { maximum: poseExpectation.rotationToleranceDegrees, rotation: poseExpectation.expectedRotation }, observed: errorDegrees, passed });
        if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:rotation`,
          expected: { rotation: poseExpectation.expectedRotation, toleranceDegrees: poseExpectation.rotationToleranceDegrees }, observed: { rotationQuaternion: observed.rotationQuaternion, errorDegrees },
          diagnosis: diagnosePoseContribution(observed, undefined, poseExpectation.expectedRotation) });
      }
      const throughoutChecks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean;
        motionGuidance?: MotionGateGuidance }> = [];
      for (const sourceExpectation of poseExpectation.blendSourcePoses ?? []) if (sourceExpectation.throughout) {
        const window = sourceExpectation.throughout;
        const sourceLabel = `${sourceExpectation.controllerStateId}/${sourceExpectation.sourceStateId}`;
        const windowTimes = [...new Set([...poseWindowTimes(window), ...(criticalTimesBySourceWindow.get(sourceExpectation) ?? [])])].sort((left, right) => left - right);
        const samples = windowTimes.map(at => {
          const jointPose = report.composedPoseSamples.find(candidate => candidate.at === at)?.joints.find(candidate => candidate.joint === poseExpectation.joint);
          const source = jointPose?.contributors.find(contributor => contributor.blendControllerStateId === sourceExpectation.controllerStateId
            && contributor.stateId === sourceExpectation.sourceStateId);
          const missingChannel = jointPose?.unanimatedTracks.find(track => track.blendControllerStateId === sourceExpectation.controllerStateId
            && track.stateId === sourceExpectation.sourceStateId);
          return { at, jointPose, source, missingChannel };
        });
        const available = samples.filter((entry): entry is typeof entry & { source: NonNullable<typeof entry.source> } => entry.source !== undefined);
        const coveragePassed = available.length === windowTimes.length;
        const missing = samples.filter(entry => !entry.source).map(entry => ({ at: entry.at,
          status: entry.missingChannel ? 'missing_joint_channel' as const : 'not_contributing' as const,
          ...(entry.missingChannel ? { trackWeight: entry.missingChannel.trackWeight,
            targetTrackWeight: entry.missingChannel.targetTrackWeight, playbackTimeSeconds: entry.missingChannel.playbackTimeSeconds } : {}) }));
        const coverageProperty = `blendSourcePose.sampleCoverage:${sourceLabel}`;
        throughoutChecks.push({ property: coverageProperty, expected: windowTimes.length,
          observed: { count: available.length, missing }, passed: coveragePassed });
        if (!coveragePassed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${window.start},${window.end}]:${coverageProperty}`,
          expected: { sampleCount: windowTimes.length }, observed: { count: available.length, missing } });

        if (window.effectiveWeight) {
          const weights = available.map(entry => ({ at: entry.at, effectiveWeight: entry.source.effectiveWeight }));
          const passed = coveragePassed && weights.every(entry => (window.effectiveWeight!.min === undefined || entry.effectiveWeight >= window.effectiveWeight!.min)
            && (window.effectiveWeight!.max === undefined || entry.effectiveWeight <= window.effectiveWeight!.max));
          const property = `blendSourcePose.effectiveWeightThroughout:${sourceLabel}`;
          const observedRange = weights.length ? { min: Math.min(...weights.map(entry => entry.effectiveWeight)),
            max: Math.max(...weights.map(entry => entry.effectiveWeight)), samples: weights } : null;
          throughoutChecks.push({ property, expected: window.effectiveWeight, observed: observedRange, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${window.start},${window.end}]:${property}`,
            expected: window.effectiveWeight, observed: { range: observedRange, missing } });
        }

        const sampleGaps = windowTimes.slice(1).map((at, index) => ({ from: windowTimes[index]!, to: at, seconds: at - windowTimes[index]! }));
        const largestGap = [...sampleGaps].sort((left, right) => right.seconds - left.seconds || left.from - right.from)[0];
        if (window.maxSampleGapSeconds !== undefined) {
          const passed = coveragePassed && (largestGap?.seconds ?? 0) <= window.maxSampleGapSeconds;
          const property = `blendSourcePose.maximumSampleGapSeconds:${sourceLabel}`;
          const observedGap = largestGap ? { ...largestGap, sampleCount: windowTimes.length } : { from: window.start, to: window.end, seconds: 0, sampleCount: windowTimes.length };
          throughoutChecks.push({ property, expected: { maximum: window.maxSampleGapSeconds, sampleRateHz: window.sampleRateHz }, observed: observedGap, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${window.start},${window.end}]:${property}`,
            expected: window.maxSampleGapSeconds, observed: { ...observedGap, missing } });
        }

        const sourceMotion = measureSampledPoseMotion(samples.map(sample => ({ at: sample.at,
          ...(sample.source ? { pose: { position: sample.source.position, rotationQuaternion: sample.source.rotationQuaternion } } : {}) })));
        const motion = sourceMotion.intervals.map(interval => ({ ...interval,
          effectiveWeight: samples.find(sample => sample.at === interval.to)?.source?.effectiveWeight ?? 0 }));
        const motionLimits = [
          { field: 'maxLinearSpeedStudsPerSecond' as const, property: 'maximumLinearSpeedStudsPerSecond', value: (item: typeof motion[number]) => item.linearSpeedStudsPerSecond, unit: 'studsPerSecond' },
          { field: 'maxAngularSpeedDegreesPerSecond' as const, property: 'maximumAngularSpeedDegreesPerSecond', value: (item: typeof motion[number]) => item.angularSpeedDegreesPerSecond, unit: 'degreesPerSecond' },
          { field: 'maxLinearStepStuds' as const, property: 'maximumLinearStepStuds', value: (item: typeof motion[number]) => item.linearStepStuds, unit: 'studs' },
          { field: 'maxAngularStepDegrees' as const, property: 'maximumAngularStepDegrees', value: (item: typeof motion[number]) => item.angularStepDegrees, unit: 'degrees' },
        ];
        for (const limit of motionLimits) {
          const maximum = window[limit.field];
          if (maximum === undefined) continue;
          const worst = [...motion].sort((left, right) => limit.value(right) - limit.value(left) || left.from - right.from)[0];
          const observedValue = worst ? limit.value(worst) : null;
          const passed = coveragePassed && worst !== undefined && observedValue! <= maximum;
          const property = `blendSourcePose.${limit.property}:${sourceLabel}`;
          const observedMotion = worst ? { from: worst.from, to: worst.to, value: observedValue, unit: limit.unit,
            linearStepStuds: worst.linearStepStuds, angularStepDegrees: worst.angularStepDegrees,
            effectiveWeightAtEnd: worst.effectiveWeight } : null;
          throughoutChecks.push({ property, expected: { maximum, sampleRateHz: window.sampleRateHz }, observed: observedMotion, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${window.start},${window.end}]:${property}`,
            expected: { maximum, unit: limit.unit }, observed: { motion: observedMotion, missing } });
        }
        const accelerationLimits = [
          { field: 'maxLinearAccelerationStudsPerSecondSquared' as const, property: 'maximumLinearAccelerationStudsPerSecondSquared',
            value: (item: typeof sourceMotion.accelerations[number]) => item.linearAccelerationStudsPerSecondSquared, unit: 'studsPerSecondSquared' },
          { field: 'maxAngularAccelerationDegreesPerSecondSquared' as const, property: 'maximumAngularAccelerationDegreesPerSecondSquared',
            value: (item: typeof sourceMotion.accelerations[number]) => item.angularAccelerationDegreesPerSecondSquared, unit: 'degreesPerSecondSquared' },
        ];
        for (const limit of accelerationLimits) {
          const maximum = window[limit.field];
          if (maximum === undefined) continue;
          const worst = [...sourceMotion.accelerations].sort((left, right) => limit.value(right) - limit.value(left) || left.from - right.from)[0];
          const observedValue = worst ? limit.value(worst) : null;
          const passed = coveragePassed && worst !== undefined && observedValue! <= maximum;
          const property = `blendSourcePose.${limit.property}:${sourceLabel}`;
          const observedMotion = worst ? { from: worst.from, to: worst.to, value: observedValue, unit: limit.unit,
            intervalMidpointSpacingSeconds: worst.midpointDelta, intervalCount: sourceMotion.accelerations.length,
            sampleCount: available.length, effectiveWeightAtEnd: samples.find(sample => sample.at === worst.to)?.source?.effectiveWeight ?? 0 } : null;
          const motionGuidance: MotionGateGuidance | undefined = passed ? undefined : {
            kind: worst ? 'sampled_threshold_exceeded' : 'insufficient_contiguous_samples',
              interpretation: worst ? 'This source-channel finite-difference measurement exceeds the requested limit; that is a review cue, not an automatic quality verdict.'
                : 'The requested acceleration could not be measured from three contiguous source-channel samples; missing evidence is not zero acceleration.',
              suggestedNextStep: worst
                ? `Inspect ${poseExpectation.joint} from ${worst.from.toFixed(4)}s to ${worst.to.toFixed(4)}s in the target-rig preview, including the ${sourceLabel} source contribution (effective weight ${(samples.find(sample => sample.at === worst.to)?.source?.effectiveWeight ?? 0).toFixed(3)}). Decide whether the acceleration is intentional; only if it is not, refine that joint/channel, preserve intended contacts and timing, preview the exact candidate, then rerun this gate.`
                : `Increase sampleRateHz or widen this source window so at least three contiguous samples have this source channel; verify the source contributes throughout. Rerun the gate before drawing a motion conclusion.`,
            limitation: 'This is a sampled local source-pose derivative, not continuous physics, a rendered-quality judgment, or permission to save/export.' };
          throughoutChecks.push({ property, expected: { maximum, sampleRateHz: window.sampleRateHz }, observed: observedMotion, passed,
            ...(motionGuidance ? { motionGuidance } : {}) });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${window.start},${window.end}]:${property}`,
            expected: { maximum, unit: limit.unit }, observed: { motion: observedMotion, missing }, motionGuidance: motionGuidance! });
        }
      }
      if (poseExpectation.throughout) {
        const windowTimes = [...new Set([...poseWindowTimes(poseExpectation.throughout), ...(criticalTimesByWindow.get(poseExpectation) ?? [])])].sort((left, right) => left - right);
        const windowSamples = windowTimes.map(at => ({ at, pose: report.composedPoseSamples.find(candidate => candidate.at === at)?.joints.find(candidate => candidate.joint === poseExpectation.joint) }));
        const availableSamples = windowSamples.filter((entry): entry is { at: number; pose: NonNullable<typeof observed> } => entry.pose !== undefined);
        const coveragePassed = availableSamples.length === windowTimes.length;
        if (!coveragePassed) {
          throughoutChecks.push({ property: 'sampleCoverage', expected: windowTimes.length, observed: availableSamples.length, passed: false });
          failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:sampleCoverage`,
            expected: { samples: windowTimes.length, sampleRateHz: poseExpectation.throughout.sampleRateHz }, observed: availableSamples.length });
        }
        if (poseExpectation.throughout.maxSampleGapSeconds !== undefined) {
          const gaps = availableSamples.slice(1).map((sample, index) => ({ from: availableSamples[index]!.at, to: sample.at,
            seconds: sample.at - availableSamples[index]!.at }));
          const worstGap = [...gaps].sort((left, right) => right.seconds - left.seconds || left.from - right.from)[0];
          const passed = coveragePassed && (worstGap?.seconds ?? 0) <= poseExpectation.throughout.maxSampleGapSeconds;
          throughoutChecks.push({ property: 'maximumPoseSampleGapSeconds', expected: { maximum: poseExpectation.throughout.maxSampleGapSeconds,
            start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
            sampleRateHz: poseExpectation.throughout.sampleRateHz, measurement: 'largest adjacent timestamp gap in the returned composed-pose samples' },
          observed: { seconds: worstGap?.seconds ?? 0, from: worstGap?.from ?? poseExpectation.throughout.start,
            to: worstGap?.to ?? poseExpectation.throughout.end, intervalCount: gaps.length, sampleCoverage: availableSamples.length }, passed });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:maximumSampleGap`,
            expected: { maximumSeconds: poseExpectation.throughout.maxSampleGapSeconds, sampleRateHz: poseExpectation.throughout.sampleRateHz },
            observed: { seconds: worstGap?.seconds ?? 0, from: worstGap?.from ?? poseExpectation.throughout.start,
              to: worstGap?.to ?? poseExpectation.throughout.end, intervalCount: gaps.length, sampleCoverage: availableSamples.length } });
        }
        if (poseExpectation.expectedPosition) {
          const errors = availableSamples.map(entry => ({ ...entry, errorStuds: Math.hypot(...entry.pose.position.map((value, axis) => value - poseExpectation.expectedPosition![axis]!)) }));
          const worst = [...errors].sort((left, right) => right.errorStuds - left.errorStuds || left.at - right.at)[0];
          const passed = coveragePassed && worst !== undefined && worst.errorStuds <= poseExpectation.positionToleranceStuds!;
          throughoutChecks.push({ property: 'maximumPositionErrorStuds', expected: { maximum: poseExpectation.positionToleranceStuds,
            position: poseExpectation.expectedPosition, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
            sampleRateHz: poseExpectation.throughout.sampleRateHz, criticalBoundarySampling: 'authored keys, Bezier extrema, exact Bounce/Elastic extrema, and graph transition/blend boundaries' },
          observed: worst ? { at: worst.at, errorStuds: worst.errorStuds, position: worst.pose.position,
            sampledTimeCount: windowTimes.length, criticalSampleCount: windowTimes.filter(at => !poseWindowTimes(poseExpectation.throughout!).includes(at)).length,
            blendContext: blendContextAt(worst.at, worst.pose) } : null, passed });
          if (!passed && worst) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:positionThroughout`,
            expected: { position: poseExpectation.expectedPosition, toleranceStuds: poseExpectation.positionToleranceStuds,
              sampleRateHz: poseExpectation.throughout.sampleRateHz }, observed: { at: worst.at, position: worst.pose.position, errorStuds: worst.errorStuds },
            diagnosis: diagnosePoseContribution(worst.pose, poseExpectation.expectedPosition) });
        }
        if (poseExpectation.expectedRotation) {
          const errors = availableSamples.map(entry => ({ ...entry, errorDegrees: rotationGapDegrees(poseExpectation.expectedRotation!, entry.pose.rotationQuaternion) }));
          const worst = [...errors].sort((left, right) => right.errorDegrees - left.errorDegrees || left.at - right.at)[0];
          const passed = coveragePassed && worst !== undefined && worst.errorDegrees <= poseExpectation.rotationToleranceDegrees!;
          throughoutChecks.push({ property: 'maximumRotationErrorDegrees', expected: { maximum: poseExpectation.rotationToleranceDegrees,
            rotation: poseExpectation.expectedRotation, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
            sampleRateHz: poseExpectation.throughout.sampleRateHz, criticalBoundarySampling: 'authored keys, Bezier extrema, exact Bounce/Elastic extrema, and graph transition/blend boundaries' },
          observed: worst ? { at: worst.at, errorDegrees: worst.errorDegrees, rotationQuaternion: worst.pose.rotationQuaternion,
            sampledTimeCount: windowTimes.length, criticalSampleCount: windowTimes.filter(at => !poseWindowTimes(poseExpectation.throughout!).includes(at)).length,
            blendContext: blendContextAt(worst.at, worst.pose) } : null, passed });
          if (!passed && worst) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:rotationThroughout`,
            expected: { rotation: poseExpectation.expectedRotation, toleranceDegrees: poseExpectation.rotationToleranceDegrees,
              sampleRateHz: poseExpectation.throughout.sampleRateHz }, observed: { at: worst.at, rotationQuaternion: worst.pose.rotationQuaternion, errorDegrees: worst.errorDegrees },
            diagnosis: diagnosePoseContribution(worst.pose, undefined, poseExpectation.expectedRotation) });
        }
        const maximumLinearSpeed = poseExpectation.throughout.maxLinearSpeedStudsPerSecond;
        const maximumAngularSpeed = poseExpectation.throughout.maxAngularSpeedDegreesPerSecond;
        const maximumLinearAcceleration = poseExpectation.throughout.maxLinearAccelerationStudsPerSecondSquared;
        const maximumAngularAcceleration = poseExpectation.throughout.maxAngularAccelerationDegreesPerSecondSquared;
        const maximumLinearStep = poseExpectation.throughout.maxLinearStepStuds;
        const maximumAngularStep = poseExpectation.throughout.maxAngularStepDegrees;
        const poseMotionMeasurements = measureSampledPoseMotion(windowSamples);
        const sampledMotion = poseMotionMeasurements.intervals;
        if (maximumLinearSpeed !== undefined || maximumAngularSpeed !== undefined
          || maximumLinearAcceleration !== undefined || maximumAngularAcceleration !== undefined
          || maximumLinearStep !== undefined || maximumAngularStep !== undefined) {
          if (maximumLinearSpeed !== undefined) {
            const worst = [...sampledMotion].sort((left, right) => right.linearSpeedStudsPerSecond - left.linearSpeedStudsPerSecond || left.from - right.from)[0];
            const passed = coveragePassed && worst !== undefined && worst.linearSpeedStudsPerSecond <= maximumLinearSpeed;
            throughoutChecks.push({ property: 'maximumSampledLinearSpeedStudsPerSecond',
              expected: { maximum: maximumLinearSpeed, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
                sampleRateHz: poseExpectation.throughout.sampleRateHz, measurement: 'finite difference between adjacent returned local-pose samples' },
              observed: worst ? { from: worst.from, to: worst.to, studsPerSecond: worst.linearSpeedStudsPerSecond,
                intervalCount: sampledMotion.length, sampleCoverage: availableSamples.length, blendContext: blendContextAt(worst.to,
                  availableSamples.find(sample => sample.at === worst.to)!.pose) } : null, passed });
            if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:maximumLinearSpeed`,
              expected: { maximumStudsPerSecond: maximumLinearSpeed },
              observed: worst ? { from: worst.from, to: worst.to, studsPerSecond: worst.linearSpeedStudsPerSecond } : { intervalCount: 0, sampleCoverage: availableSamples.length } });
          }
          if (maximumAngularSpeed !== undefined) {
            const worst = [...sampledMotion].sort((left, right) => right.angularSpeedDegreesPerSecond - left.angularSpeedDegreesPerSecond || left.from - right.from)[0];
            const passed = coveragePassed && worst !== undefined && worst.angularSpeedDegreesPerSecond <= maximumAngularSpeed;
            throughoutChecks.push({ property: 'maximumSampledAngularSpeedDegreesPerSecond',
              expected: { maximum: maximumAngularSpeed, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
                sampleRateHz: poseExpectation.throughout.sampleRateHz, measurement: 'shortest quaternion arc between adjacent returned local-pose samples' },
              observed: worst ? { from: worst.from, to: worst.to, degreesPerSecond: worst.angularSpeedDegreesPerSecond,
                intervalCount: sampledMotion.length, sampleCoverage: availableSamples.length, blendContext: blendContextAt(worst.to,
                  availableSamples.find(sample => sample.at === worst.to)!.pose) } : null, passed });
            if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:maximumAngularSpeed`,
              expected: { maximumDegreesPerSecond: maximumAngularSpeed },
              observed: worst ? { from: worst.from, to: worst.to, degreesPerSecond: worst.angularSpeedDegreesPerSecond } : { intervalCount: 0, sampleCoverage: availableSamples.length } });
          }
          if (maximumLinearStep !== undefined) {
            const worst = [...sampledMotion].sort((left, right) => right.linearStepStuds - left.linearStepStuds || left.from - right.from)[0];
            const passed = coveragePassed && worst !== undefined && worst.linearStepStuds <= maximumLinearStep;
            throughoutChecks.push({ property: 'maximumSampledLinearStepStuds',
              expected: { maximum: maximumLinearStep, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
                sampleRateHz: poseExpectation.throughout.sampleRateHz, measurement: 'local position delta between adjacent samples; transition and fade boundaries are sampled explicitly' },
              observed: worst ? { from: worst.from, to: worst.to, studs: worst.linearStepStuds,
                intervalCount: sampledMotion.length, sampleCoverage: availableSamples.length,
                blendContext: blendContextAt(worst.to, availableSamples.find(sample => sample.at === worst.to)!.pose) } : null, passed });
            if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:maximumLinearStep`,
              expected: { maximumStuds: maximumLinearStep },
              observed: worst ? { from: worst.from, to: worst.to, studs: worst.linearStepStuds } : { intervalCount: 0, sampleCoverage: availableSamples.length } });
          }
          if (maximumAngularStep !== undefined) {
            const worst = [...sampledMotion].sort((left, right) => right.angularStepDegrees - left.angularStepDegrees || left.from - right.from)[0];
            const passed = coveragePassed && worst !== undefined && worst.angularStepDegrees <= maximumAngularStep;
            throughoutChecks.push({ property: 'maximumSampledAngularStepDegrees',
              expected: { maximum: maximumAngularStep, start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
                sampleRateHz: poseExpectation.throughout.sampleRateHz, measurement: 'shortest quaternion arc between adjacent samples; transition and fade boundaries are sampled explicitly' },
              observed: worst ? { from: worst.from, to: worst.to, degrees: worst.angularStepDegrees,
                intervalCount: sampledMotion.length, sampleCoverage: availableSamples.length,
                blendContext: blendContextAt(worst.to, availableSamples.find(sample => sample.at === worst.to)!.pose) } : null, passed });
            if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:maximumAngularStep`,
              expected: { maximumDegrees: maximumAngularStep },
              observed: worst ? { from: worst.from, to: worst.to, degrees: worst.angularStepDegrees } : { intervalCount: 0, sampleCoverage: availableSamples.length } });
          }
        }
        const accelerationLimits = [
          { maximum: maximumLinearAcceleration, property: 'maximumSampledLinearAccelerationStudsPerSecondSquared',
            value: (item: typeof poseMotionMeasurements.accelerations[number]) => item.linearAccelerationStudsPerSecondSquared,
            unit: 'studsPerSecondSquared', failureSuffix: 'maximumLinearAcceleration' },
          { maximum: maximumAngularAcceleration, property: 'maximumSampledAngularAccelerationDegreesPerSecondSquared',
            value: (item: typeof poseMotionMeasurements.accelerations[number]) => item.angularAccelerationDegreesPerSecondSquared,
            unit: 'degreesPerSecondSquared', failureSuffix: 'maximumAngularAcceleration' },
        ];
        for (const limit of accelerationLimits) {
          if (limit.maximum === undefined) continue;
          const worst = [...poseMotionMeasurements.accelerations].sort((left, right) => limit.value(right) - limit.value(left) || left.from - right.from)[0];
          const observedValue = worst ? limit.value(worst) : null;
          const passed = coveragePassed && worst !== undefined && observedValue! <= limit.maximum;
          const observedAcceleration = worst ? { from: worst.from, to: worst.to, value: observedValue, unit: limit.unit,
            intervalMidpointSpacingSeconds: worst.midpointDelta, intervalCount: poseMotionMeasurements.accelerations.length,
            sampleCoverage: availableSamples.length, blendContext: blendContextAt(worst.to,
              availableSamples.find(sample => sample.at === worst.to)!.pose) } : null;
          const motionGuidance: MotionGateGuidance | undefined = passed ? undefined : {
            kind: worst ? 'sampled_threshold_exceeded' : 'insufficient_contiguous_samples',
            interpretation: worst ? 'This composed local-pose finite-difference measurement exceeds the requested limit; that is a review cue, not an automatic quality verdict.'
              : 'The requested acceleration could not be measured from three contiguous pose samples; missing evidence is not zero acceleration.',
            suggestedNextStep: worst
              ? `Inspect ${poseExpectation.joint} from ${worst.from.toFixed(4)}s to ${worst.to.toFixed(4)}s on the target rig, including the reported state/transition/blend context. Decide whether the acceleration is intentional; only if it is not, refine the affected joint/channel, preserve intended contacts and timing, preview the exact candidate, then rerun this gate.`
              : `Increase sampleRateHz or widen this pose window to provide at least three contiguous covered samples. Confirm the same rig and joint remain available, then rerun the gate before drawing a motion conclusion.`,
            limitation: 'This is a sampled composed local-pose derivative, not continuous physics, a rendered-quality judgment, or permission to save/export.' };
          throughoutChecks.push({ property: limit.property, expected: { maximum: limit.maximum,
            start: poseExpectation.throughout.start, end: poseExpectation.throughout.end,
            sampleRateHz: poseExpectation.throughout.sampleRateHz,
            measurement: 'change between adjacent sampled interval velocities divided by actual interval-midpoint spacing' },
          observed: observedAcceleration, passed, ...(motionGuidance ? { motionGuidance } : {}) });
          if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@[${poseExpectation.throughout.start},${poseExpectation.throughout.end}]:${limit.failureSuffix}`,
            expected: { maximum: limit.maximum, unit: limit.unit },
            observed: observedAcceleration ?? { intervalCount: 0, sampleCoverage: availableSamples.length },
            motionGuidance: motionGuidance! });
        }
      }
      for (const property of ['rotationBlendConfidence', 'rotationInfluence'] as const) {
        const range = poseExpectation[property];
        if (!range) continue;
        const value = observed?.[property];
        const passed = value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
        checks.push({ property, expected: range, observed: value ?? null, passed });
        if (!passed) failures.push({ expectation: `pose:${poseExpectation.joint}@${poseExpectation.at}:${property}`,
          expected: range, observed: value ?? null, diagnosis: diagnosis! });
      }
      const status = [...checks, ...throughoutChecks].every(check => check.passed) ? 'passed' as const : 'failed' as const;
      return { at: poseExpectation.at, joint: poseExpectation.joint, status,
        checks, ...(poseExpectation.throughout ? { throughout: poseExpectation.throughout } : {}),
        ...(throughoutChecks.length > 0 ? { throughoutChecks } : {}),
        pose: observed ?? null, ...(observed ? { blendContext: blendContextAt(poseExpectation.at, observed) } : {}),
        ...(status === 'failed' && diagnosis ? { diagnosis } : {}) };
    });
    return { id: testCase.id, name: testCase.name, status: failures.length === 0 ? 'passed' as const : 'failed' as const,
      failures, finalState: report.finalState, transitionIds: report.transitionIds, triggeredMarkers: report.triggeredMarkers,
      timeline: report.timeline, blendChecks, poseChecks, playbackClockChecks, phaseDonorChecks, incompleteParameterRampChecks, parameterRampLifecycleChecks,
      trackLifecycles: report.trackLifecycles, trackLifecycleChecks,
      incompleteParameterRamps: report.incompleteParameterRamps, parameterRampLifecycle: report.parameterRampLifecycle,
      eventOrderingDiagnostics: report.eventOrderingDiagnostics,
      animationEndedTiming: report.animationEndedTiming,
      playbackRetriggerModel: report.playbackRetriggerModel,
      eventOrderSensitivity: report.eventOrderSensitivity,
      blendModel: report.blendModel,
      poseModel: report.poseModel,
      ...(eventOrderingCheck ? { eventOrderingCheck } : {}),
      ...(eventOrderSensitivityCheck ? { eventOrderSensitivityCheck } : {}),
      processedEvents: report.processedEvents, scheduledEvents: report.scheduledEvents };
  });
  const graphFingerprint = animationGraphFingerprint(graph);
  const suiteFingerprint = digest({ schemaVersion: 1, cases: suite.cases });
  const usedCalibrationProfileIds = [...new Set(results.flatMap(result => result.blendModel.calibrationProfileIds))].sort();
  const usedCalibrationProfileIdSet = new Set(usedCalibrationProfileIds);
  const playbackTimingFingerprint = digest(results.map(result => ({ caseId: result.id,
    playbackTiming: result.blendModel.playbackTiming })));
  const report = { schemaVersion: 1, graphFingerprint, suiteFingerprint,
    status: results.every(result => result.status === 'passed') ? 'passed' as const : 'failed' as const,
    blendModel: { kind: usedCalibrationProfileIds.length > 0 ? 'studio_calibrated_curve_per_track_estimate' as const : 'linear_per_track_weight_estimate' as const,
      calibrationProfileIds: usedCalibrationProfileIds, playbackTimingFingerprint },
    playbackRetriggerModel: results.reduce((total, result) => ({
      measuredPreservedClockTransitions: total.measuredPreservedClockTransitions + result.playbackRetriggerModel.measuredPreservedClockTransitions,
      measuredResetClockTransitions: total.measuredResetClockTransitions + result.playbackRetriggerModel.measuredResetClockTransitions,
      ambiguousProbeAssumedResetTransitions: total.ambiguousProbeAssumedResetTransitions + result.playbackRetriggerModel.ambiguousProbeAssumedResetTransitions,
      unmeasuredAssumedResetTransitions: total.unmeasuredAssumedResetTransitions + result.playbackRetriggerModel.unmeasuredAssumedResetTransitions,
      limitation: result.playbackRetriggerModel.limitation,
    }), { measuredPreservedClockTransitions: 0, measuredResetClockTransitions: 0,
      ambiguousProbeAssumedResetTransitions: 0, unmeasuredAssumedResetTransitions: 0,
      limitation: 'Only exact selected state/fade-duration profiles with a persisted Studio Play-retrigger probe control already-playing track clocks; missing or ambiguous observations retain the restart estimate.' }),
    ...(options.fadeCalibrationEvidence === undefined ? {} : { fadeCalibrationEvidence: options.fadeCalibrationEvidence
      .filter(profile => usedCalibrationProfileIdSet.has(profile.id)).sort((left, right) => left.id.localeCompare(right.id)) }),
    summary: { cases: results.length, passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status === 'failed').length, scheduledEvents: aggregateEvents,
      processedEvents: results.reduce((sum, result) => sum + result.processedEvents, 0) },
    cases: results,
    limitation: usedCalibrationProfileIds.length > 0
      ? 'These assertions run against a deterministic estimate from authored recipes and graph metadata, with piecewise-linear interpolation of fingerprint-verified Studio WeightCurrent curves only for exact state/fade-duration matches; unmatched fades remain linear. Play fades are rebased from the destination track’s current weight. Exact selected profiles with repeated-Play probes supply measured playback-clock behavior; playbackRetriggerModel counts measured and assumed cases. This does not run Roblox AnimationTracks or gameplay and does not certify published marker delivery, frame timing, rendered crossfade appearance, replication, or artistic intent; confirm the motion in Studio.'
      : 'These assertions run against a deterministic estimate from authored recipes and graph metadata, not Roblox AnimationTracks or gameplay. Play fades are rebased from the destination track’s current weight. The playbackRetriggerModel explicitly counts restart assumptions for already-playing tracks when no exact Studio probe is supplied. Passing does not certify published marker delivery, frame timing, crossfade appearance, replication, or artistic intent; confirm the motion in Studio.',
  };
  return { ...report, reportFingerprint: digest(report),
    ...(options.includeStudioCalibrationTrace ? { studioCalibrationTrace } : {}) };
}
