import { z } from 'zod';
import { formatAnimationTime, sameAnimationTime } from './time-format.js';
import { fingerprint, motionMode, resolveTelemetryNodeName, type Inspection, type Telemetry } from './inspection.js';
import { label, type AnimationRecipe } from './recipes.js';

const durationRange = z.object({ min: z.number().finite().min(0.1).max(30), max: z.number().finite().min(0.1).max(30) }).strict()
  .superRefine((range, ctx) => { if (range.min > range.max) ctx.addIssue({ code: 'custom', message: 'Duration minimum must not exceed maximum.' }); });
const contactRequirement = z.object({
  effector: label, kind: z.enum(['support', 'grip']), start: z.number().finite().min(0).max(30), end: z.number().finite().min(0).max(30),
  maxDriftStuds: z.number().finite().min(0).max(100), minSamples: z.number().int().min(2).max(64).default(3),
  maxAngularDriftDegrees: z.number().finite().min(0).max(360).optional().describe('Optional maximum sampled world-orientation change in degrees from the first pose inside this declared contact window; missing orientation telemetry is unknown.'),
  maxCumulativeTravelStuds: z.number().finite().min(0).max(1000).optional().describe('Optional maximum sum of sampled effector displacement between consecutive poses in this contact window; this sampled path-length estimate can miss movement between samples.'),
  maxStepSpeedStudsPerSecond: z.number().finite().min(0).max(100000).optional().describe('Optional maximum sampled effector speed between consecutive poses in this contact window; reports the exact worst adjacent sample pair.'),
  maxGroundOffsetStuds: z.number().finite().min(0).max(100).optional().describe('Optional maximum absolute distance of a foot sole bound from the estimated rest-ground plane during a support window; this is not collision physics.'),
  targetPosition: z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)]).optional().describe('Optional fixed target position in the rig-pivot-local frame, used with maxTargetDistanceStuds.'),
  maxTargetDistanceStuds: z.number().finite().min(0).max(100).optional().describe('Maximum pivot-local effector distance from targetPosition for every sampled contact pose; requires pivot-local Studio telemetry.'),
  targetOrientation: z.tuple([z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)]).optional().describe('Optional desired pivot-local quaternion [x,y,z,w], used with maxAngularTargetErrorDegrees.'),
  maxAngularTargetErrorDegrees: z.number().finite().min(0).max(180).optional().describe('Maximum sampled angular error from targetOrientation; requires Studio orientation telemetry.'),
  maxSampleGapSeconds: z.number().finite().min(0.016).max(30).default(0.25),
}).strict().superRefine((contact, ctx) => {
  if (contact.start >= contact.end) ctx.addIssue({ code: 'custom', message: 'Required contact must have a non-empty interval.' });
  if ((contact.targetPosition === undefined) !== (contact.maxTargetDistanceStuds === undefined)) ctx.addIssue({ code: 'custom', path: ['targetPosition'], message: 'targetPosition and maxTargetDistanceStuds must be supplied together.' });
  if ((contact.targetOrientation === undefined) !== (contact.maxAngularTargetErrorDegrees === undefined)) ctx.addIssue({ code: 'custom', path: ['targetOrientation'], message: 'targetOrientation and maxAngularTargetErrorDegrees must be supplied together.' });
  if (contact.targetOrientation && Math.abs(Math.hypot(...contact.targetOrientation) - 1) > 0.01) ctx.addIssue({ code: 'custom', path: ['targetOrientation'], message: 'targetOrientation must be a unit quaternion.' });
  if (contact.maxGroundOffsetStuds !== undefined && contact.kind !== 'support') ctx.addIssue({ code: 'custom', path: ['maxGroundOffsetStuds'], message: 'Ground-offset limits apply only to support contacts.' });
});
const bendPlaneRequirement = z.object({
  rootJoint: label, middleJoint: label, effector: label,
  start: z.number().finite().min(0).max(30), end: z.number().finite().min(0).max(30),
  poleTarget: z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)])
    .describe('Desired bend-side point in the rig-pivot-local frame; only its direction projected perpendicular to the root-to-effector axis is used.'),
  maxDeviationDegrees: z.number().finite().min(0).max(180),
  minSamples: z.number().int().min(2).max(64).default(3),
  maxSampleGapSeconds: z.number().finite().min(0.016).max(30).default(0.25),
}).strict().superRefine((requirement, ctx) => {
  if (requirement.start >= requirement.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'Bend-plane interval must have positive duration.' });
  const names = [requirement.rootJoint, requirement.middleJoint, requirement.effector].map(name => name.toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['effector'], message: 'Root, middle, and effector joints must be three distinct names.' });
});

const jointLoopLimitSchema = z.object({
  joint: label,
  maxPositionOffsetStuds: z.number().finite().min(0).max(100000).optional(),
  maxAngularOffsetDegrees: z.number().finite().min(0).max(180).optional(),
}).strict().refine(value => value.maxPositionOffsetStuds !== undefined || value.maxAngularOffsetDegrees !== undefined,
  'A joint loop requirement must specify at least one endpoint limit.');

const animationTestCriteriaShape = {
  duration: durationRange.optional(), loop: z.boolean().optional(),
  requiredMarkers: z.array(label).max(32).default([]), requiredTracks: z.array(label).max(256).default([]),
  maxPeakAngularSpeedDegreesPerSecond: z.number().finite().positive().max(100000).optional(),
  maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond: z.number().finite().min(0).max(100000).optional(),
  maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: z.number().finite().min(0).max(100000).optional(),
  maxLoopComposedPositionOffsetStuds: z.number().finite().min(0).max(100000).optional(),
  maxLoopComposedAngularOffsetDegrees: z.number().finite().min(0).max(180).optional(),
  jointLoopLimits: z.array(jointLoopLimitSchema).min(1).max(32).optional(),
  contacts: z.array(contactRequirement).max(16).default([]),
  bendPlanes: z.array(bendPlaneRequirement).max(16).default([]),
};
type AnimationTestCriteria = z.infer<z.ZodObject<typeof animationTestCriteriaShape>>;
function refineTestCriteria(criteria: AnimationTestCriteria, ctx: z.RefinementCtx, expectedFingerprint?: string) {
  const configured = expectedFingerprint !== undefined || criteria.duration !== undefined || criteria.loop !== undefined || criteria.requiredMarkers.length > 0 || criteria.requiredTracks.length > 0
    || criteria.maxPeakAngularSpeedDegreesPerSecond !== undefined || criteria.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond !== undefined
    || criteria.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond !== undefined
    || criteria.maxLoopComposedPositionOffsetStuds !== undefined || criteria.maxLoopComposedAngularOffsetDegrees !== undefined
    || criteria.jointLoopLimits !== undefined || criteria.contacts.length > 0 || criteria.bendPlanes.length > 0;
  if (!configured) ctx.addIssue({ code: 'custom', message: 'Specify at least one animation acceptance requirement.' });
  if ((criteria.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond !== undefined || criteria.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond !== undefined
    || criteria.maxLoopComposedPositionOffsetStuds !== undefined || criteria.maxLoopComposedAngularOffsetDegrees !== undefined || criteria.jointLoopLimits !== undefined)
    && criteria.loop !== true) ctx.addIssue({ code: 'custom', path: ['loop'], message: 'Loop seam velocity limits require loop: true.' });
  const markers = criteria.requiredMarkers.map(value => value.toLowerCase());
  if (new Set(markers).size !== markers.length) ctx.addIssue({ code: 'custom', path: ['requiredMarkers'], message: 'Required marker names must be unique, ignoring case.' });
  const tracks = criteria.requiredTracks.map(value => value.toLowerCase());
  if (new Set(tracks).size !== tracks.length) ctx.addIssue({ code: 'custom', path: ['requiredTracks'], message: 'Required track names must be unique, ignoring case.' });
  const loopJoints = (criteria.jointLoopLimits ?? []).map(value => value.joint.toLowerCase());
  if (new Set(loopJoints).size !== loopJoints.length) ctx.addIssue({ code: 'custom', path: ['jointLoopLimits'], message: 'Joint loop limits must have unique joint names, ignoring case.' });
}

export const animationAcceptanceCriteriaSchema = z.object(animationTestCriteriaShape).strict()
  .superRefine((criteria, ctx) => refineTestCriteria(criteria, ctx));
export const animationTestCaseSchema = z.object({
  assetId: z.string().uuid(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), motionMode: motionMode.default('unknown'),
  ...animationTestCriteriaShape,
}).strict().superRefine((testCase, ctx) => refineTestCriteria(testCase, ctx, testCase.expectedFingerprint));

export const contactContractMarginSchema = z.object({
  effector: label, kind: z.enum(['support', 'grip']), start: z.number().finite().min(0).max(30), end: z.number().finite().min(0).max(30),
  allowedDriftIncreaseStuds: z.number().finite().min(0).max(100),
  allowedTravelIncreaseStuds: z.number().finite().min(0).max(1000).optional(),
  allowedStepSpeedIncreaseStudsPerSecond: z.number().finite().min(0).max(100000).optional(),
  minSamples: z.number().int().min(2).max(64).default(3), maxSampleGapSeconds: z.number().finite().min(0.016).max(30).default(0.25),
}).strict().superRefine((contact, ctx) => {
  if (contact.start >= contact.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'The baseline contact window must have positive duration.' });
});

export type AnimationTestCase = z.infer<typeof animationTestCaseSchema>;
export type ContactContractMargin = z.infer<typeof contactContractMarginSchema>;
export type ContactSegmentEvidence = { startTime: number; endTime: number; startSampleId: string; endSampleId: string; displacementStuds: number };
export type AnimationTestCheck = { id: string; status: 'passed' | 'failed' | 'unknown'; detail: string; observed?: number | string | boolean; expected?: number | string | boolean; unit?: string; sampleIds?: string[]; segment?: ContactSegmentEvidence };

/** Draft only mechanically verifiable criteria from authored recipe facts; never invent artistic thresholds. */
export function suggestAnimationTestCase(assetId: string, recipe: AnimationRecipe, mode: z.infer<typeof motionMode>) {
  const unique = (values: string[]) => {
    const byName = new Map<string, string>();
    for (const value of values) if (!byName.has(value.toLowerCase())) byName.set(value.toLowerCase(), value);
    return [...byName.values()];
  };
  const markers = unique(recipe.markers.map(marker => marker.name));
  const authoredTracks = unique([
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ]);
  const prioritizedTrackNames = unique([
    ...(recipe.contacts ?? []).map(contact => contact.effector),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ]);
  const tracks = unique([...prioritizedTrackNames, ...authoredTracks]);
  const requiredMarkers = markers.slice(0, 32);
  const requiredTracks = tracks.slice(0, 256);
  const testCase = animationTestCaseSchema.parse({ assetId, motionMode: mode,
    duration: { min: recipe.duration, max: recipe.duration }, loop: recipe.loop,
    requiredMarkers, requiredTracks });
  return {
    testCase,
    derivedCriteria: [
      { criterion: 'duration', source: 'authored_recipe', value: recipe.duration, unit: 'seconds', note: 'Exact current duration; change the range if the acceptance requirement allows retiming.' },
      { criterion: 'loop', source: 'authored_recipe', value: recipe.loop },
      { criterion: 'requiredMarkers', source: 'authored_recipe', included: requiredMarkers.length, totalUnique: markers.length },
      { criterion: 'requiredTracks', source: 'authored_recipe', included: requiredTracks.length, totalUnique: tracks.length,
        prioritizedJointNames: prioritizedTrackNames.filter(name => requiredTracks.some(track => track.toLowerCase() === name.toLowerCase())) },
    ],
    prioritizedTrackNames: prioritizedTrackNames.filter(name => requiredTracks.some(track => track.toLowerCase() === name.toLowerCase())),
    omitted: { markerNames: markers.slice(32), trackNames: tracks.slice(256) },
    contactReviewCandidates: (recipe.contacts ?? []).map(contact => ({ ...contact,
      nextStep: 'Choose an explicit allowable margin and measure a reviewed baseline with motion_animation_contact_contract_build; no drift, speed, ground, or target threshold was inferred.' })),
    limitations: [
      'These criteria preserve current recipe facts; they do not establish that those facts match the game design or artistic intent.',
      'Required-track checks need live Studio evidence that each recipe track drives a joint on the selected rig.',
      'Contact windows are reported for review only. Their tolerances must be explicitly selected or derived from a measured baseline plus an explicit margin.',
      'No criterion here evaluates rendered appearance, naturalness, appeal, or overall animation quality.',
    ],
  };
}

export function resolveJointMapName(name: string, jointMap: Record<string, string>) {
  const matches = Object.entries(jointMap).filter(([source]) => source.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) return { status: 'ambiguous' as const };
  return { status: 'resolved' as const, name: matches[0]?.[1] ?? name };
}

function quaternionAngularErrorDegrees(left: readonly number[], right: readonly number[]) {
  const dot = Math.min(1, Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}
export function bendPlaneDeviationDegrees(root: readonly number[], middle: readonly number[], effector: readonly number[], pole: readonly number[]) {
  const subtract = (left: readonly number[], right: readonly number[]) => left.map((value, index) => value - right[index]!);
  const dot = (left: readonly number[], right: readonly number[]) => left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const magnitude = (value: readonly number[]) => Math.hypot(...value);
  const axisVector = subtract(effector, root);
  const axisLength = magnitude(axisVector);
  if (axisLength <= 1e-5) return undefined;
  const axis = axisVector.map(value => value / axisLength);
  const projectToBendPlane = (value: number[]) => value.map((component, index) => component - axis[index]! * dot(value, axis));
  const bend = projectToBendPlane(subtract(middle, root));
  const desired = projectToBendPlane(subtract(pole, root));
  const bendLength = magnitude(bend), desiredLength = magnitude(desired);
  if (bendLength <= 1e-5 || desiredLength <= 1e-5) return undefined;
  const cosine = Math.max(-1, Math.min(1, dot(bend, desired) / (bendLength * desiredLength)));
  return Math.acos(cosine) * 180 / Math.PI;
}

/** Builds a regression contract from measured baseline values plus margins explicitly chosen by the caller. */
export function buildContactRegressionContract(assetId: string, rigSignature: string, recipe: AnimationRecipe, contactsInput: unknown,
  structural: ReturnType<typeof import('./animation-quality.js').auditAnimation>, studio: Inspection, telemetry: Telemetry, jointMap: Record<string, string> = {}) {
  const contacts = z.array(contactContractMarginSchema).min(1).max(16).parse(contactsInput);
  const baselineRequest = { assetId, contacts: contacts.map(contact => ({ effector: contact.effector, kind: contact.kind,
    start: contact.start, end: contact.end, maxDriftStuds: 100, minSamples: contact.minSamples, maxSampleGapSeconds: contact.maxSampleGapSeconds,
    ...(contact.allowedTravelIncreaseStuds !== undefined ? { maxCumulativeTravelStuds: 1000 } : {}),
    ...(contact.allowedStepSpeedIncreaseStudsPerSecond !== undefined ? { maxStepSpeedStudsPerSecond: 100000 } : {}) })) };
  const measured = evaluateAnimationTestCase(recipe, baselineRequest, structural, studio, telemetry, jointMap);
  if (measured.status !== 'passed') throw new Error(`Cannot build a contact regression contract from incomplete baseline evidence: ${measured.checks.filter(check => check.status !== 'passed').map(check => `${check.id}: ${check.detail}`).join(' ')}`);
  const contractContacts = contacts.map((contact, index) => {
    const prefix = `contact:${contact.effector}:${index + 1}`;
    const measurement = (suffix: string) => {
      const check = measured.checks.find(item => item.id === (suffix ? `${prefix}:${suffix}` : prefix));
      if (!check || typeof check.observed !== 'number') throw new Error(`Baseline measurement ${suffix || 'drift'} is unavailable for ${contact.effector}.`);
      return check.observed;
    };
    const drift = measurement('');
    const travel = contact.allowedTravelIncreaseStuds === undefined ? undefined : measurement('travel');
    const speed = contact.allowedStepSpeedIncreaseStudsPerSecond === undefined ? undefined : measurement('step-speed');
    return { effector: contact.effector, kind: contact.kind, start: contact.start, end: contact.end,
      maxDriftStuds: drift + contact.allowedDriftIncreaseStuds, minSamples: contact.minSamples, maxSampleGapSeconds: contact.maxSampleGapSeconds,
      ...(travel !== undefined ? { maxCumulativeTravelStuds: travel + contact.allowedTravelIncreaseStuds! } : {}),
      ...(speed !== undefined ? { maxStepSpeedStudsPerSecond: speed + contact.allowedStepSpeedIncreaseStudsPerSecond! } : {}) };
  });
  const testCase = animationTestCaseSchema.parse({ assetId, contacts: contractContacts });
  return { testCase, baseline: { fingerprint: fingerprint(recipe), rigId: telemetry.rigId, rigSignature,
    contacts: contacts.map((contact, index) => {
      const prefix = `contact:${contact.effector}:${index + 1}`;
      const check = (suffix: string) => measured.checks.find(item => item.id === (suffix ? `${prefix}:${suffix}` : prefix))!;
      return { effector: contact.effector, kind: contact.kind, start: contact.start, end: contact.end,
        driftStuds: check('').observed, maxDriftStuds: contractContacts[index]!.maxDriftStuds,
        ...(contact.allowedTravelIncreaseStuds !== undefined ? { cumulativeTravelStuds: check('travel').observed, maxCumulativeTravelStuds: contractContacts[index]!.maxCumulativeTravelStuds } : {}),
        ...(contact.allowedStepSpeedIncreaseStudsPerSecond !== undefined ? { maxStepSpeedStudsPerSecond: check('step-speed').observed, allowedStepSpeedIncreaseStudsPerSecond: contractContacts[index]!.maxStepSpeedStudsPerSecond,
          worstSegment: check('step-speed').segment } : {}) };
    }) }, limitation: 'Thresholds are measured baseline values plus caller-specified margins. This preserves the observed baseline; it does not certify that baseline as artistically correct or physically planted. When applying the template to a new child asset, replace testCase.assetId with that child asset ID and create a test-plan revision to pin its fingerprint.' };
}

/** Evaluate only caller-declared criteria; never infers artistic quality or turns missing telemetry into a pass. */
export function evaluateAnimationTestCase(recipe: AnimationRecipe, testCaseInput: unknown, structural: ReturnType<typeof import('./animation-quality.js').auditAnimation>, studio: Inspection, telemetry?: Telemetry, jointMap: Record<string, string> = {}) {
  const testCase = animationTestCaseSchema.parse(testCaseInput);
  const checks: AnimationTestCheck[] = [];
  const push = (check: AnimationTestCheck) => checks.push(check);
  if (testCase.expectedFingerprint) {
    const observed = fingerprint(recipe);
    const pass = observed === testCase.expectedFingerprint;
    push({ id: 'asset_fingerprint', status: pass ? 'passed' : 'failed',
      detail: pass ? 'Animation content matches the pinned test baseline.' : 'Animation content differs from the pinned test baseline; review the revision before accepting its results.',
      observed, expected: testCase.expectedFingerprint });
  }
  if (testCase.duration) {
    const pass = recipe.duration >= testCase.duration.min && recipe.duration <= testCase.duration.max;
    push({ id: 'duration', status: pass ? 'passed' : 'failed', detail: pass ? 'Clip duration is within the requested range.' : 'Clip duration is outside the requested range.', observed: recipe.duration, expected: `${testCase.duration.min}–${testCase.duration.max}`, unit: 'seconds' });
  }
  if (testCase.loop !== undefined) {
    const pass = recipe.loop === testCase.loop;
    push({ id: 'loop', status: pass ? 'passed' : 'failed', detail: pass ? 'Loop mode matches the contract.' : 'Loop mode does not match the contract.', observed: recipe.loop, expected: testCase.loop });
  }
  const markerNames = new Set(recipe.markers.map(marker => marker.name.toLowerCase()));
  for (const marker of testCase.requiredMarkers) {
    const pass = markerNames.has(marker.toLowerCase());
    push({ id: `marker:${marker}`, status: pass ? 'passed' : 'failed', detail: pass ? 'Required marker exists.' : 'Required marker is missing.', observed: pass ? marker : 'missing', expected: marker });
  }
  const trackNames = new Set([
    ...recipe.tracks.map(track => track.joint), ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ].map(name => name.toLowerCase()));
  for (const joint of testCase.requiredTracks) {
    if (!trackNames.has(joint.toLowerCase())) {
      push({ id: `track:${joint}`, status: 'failed', detail: 'Required animated track is missing from the recipe.', observed: 'missing', expected: joint });
      continue;
    }
    if (!telemetry || studio.source !== 'studio_pose_evaluator') {
      push({ id: `track:${joint}`, status: 'unknown', detail: 'The recipe track exists, but live Studio rig coverage was not verified.', observed: joint, expected: 'a driven joint on the sampled target rig' });
      continue;
    }
    const mapping = resolveJointMapName(joint, jointMap);
    if (mapping.status === 'ambiguous') {
      push({ id: `track:${joint}`, status: 'failed', detail: 'Required track has multiple case-insensitive jointMap entries; provide one unambiguous mapping.', expected: 'one target joint mapping' });
      continue;
    }
    const mapped = mapping.name;
    const targetResolution = resolveTelemetryNodeName(telemetry.nodes, mapped);
    if (targetResolution.status === 'ambiguous') {
      push({ id: `track:${joint}`, status: 'failed', detail: `Required track target has ambiguous case-insensitive rig joints (${targetResolution.candidates.join(', ')}); use an exact inspected joint name.`, observed: 'ambiguous target joint', expected: mapped });
      continue;
    }
    const resolvedTarget = targetResolution.status === 'missing' ? undefined : telemetry.nodes[targetResolution.index];
    const target = resolvedTarget?.driven ? resolvedTarget : undefined;
    push({ id: `track:${joint}`, status: target ? 'passed' : 'failed',
      detail: target ? `Required recipe track maps to driven target joint ${target.name}.` : `Required recipe track does not map to a driven target joint (${mapped}).`,
      observed: target?.name ?? 'not driven on target rig', expected: mapped });
  }
  if (testCase.maxPeakAngularSpeedDegreesPerSecond !== undefined) {
    const activeMotion = structural.curveMotion.filter(metric => metric.channel !== 'layer' || (metric.enabled && (metric.weight ?? 0) > 0));
    const peak = activeMotion.reduce((best, metric) => metric.peakLocalAngularSpeed.degreesPerSecond > (best?.peakLocalAngularSpeed.degreesPerSecond ?? -1) ? metric : best, undefined as typeof activeMotion[number] | undefined);
    const observed = peak?.peakLocalAngularSpeed.degreesPerSecond ?? 0;
    const pass = observed <= testCase.maxPeakAngularSpeedDegreesPerSecond;
    push({ id: 'max_peak_angular_speed', status: pass ? 'passed' : 'failed',
      detail: `${pass ? 'Measured active-channel local angular speed is within the requested limit.' : 'Measured active-channel local angular speed exceeds the requested limit.'}${peak ? ` Peak: ${peak.joint}${peak.layerName ? ` (${peak.layerName})` : ''} from ${formatAnimationTime(peak.peakLocalAngularSpeed.startTime)}s to ${formatAnimationTime(peak.peakLocalAngularSpeed.endTime)}s.` : ''}`,
      observed, expected: testCase.maxPeakAngularSpeedDegreesPerSecond, unit: 'degrees/second' });
  }
  const activeSeamChannels = structural.loopSeamVelocity.filter(metric => metric.channel !== 'layer' || (metric.enabled && (metric.weight ?? 0) > 0));
  for (const requirement of testCase.jointLoopLimits ?? []) {
    const matches = structural.composedLoopSeam.filter(metric => metric.joint === requirement.joint);
    const evidence = matches.length === 1 ? matches[0] : undefined;
    for (const descriptor of [
      { limit: requirement.maxPositionOffsetStuds, metric: 'endpointPositionOffsetStuds', suffix: 'position', unit: 'studs' },
      { limit: requirement.maxAngularOffsetDegrees, metric: 'endpointAngularOffsetDegrees', suffix: 'angular', unit: 'degrees' },
    ] as const) {
      if (descriptor.limit === undefined) continue;
      const observed = evidence?.[descriptor.metric];
      const passed = observed !== undefined && observed <= descriptor.limit;
      push({ id: `loop-joint:${requirement.joint}:${descriptor.suffix}`, status: observed === undefined ? 'unknown' : passed ? 'passed' : 'failed',
        observed, expected: descriptor.limit, unit: descriptor.unit,
        detail: observed === undefined ? `No unique composed local loop evidence for exact authored joint ${requirement.joint}; names are not inferred or retargeted.`
          : `${requirement.joint} composed local endpoint offset ${passed ? 'is within' : 'exceeds'} the explicit caller limit. This includes enabled weighted layers and matching root motion, but excludes rig hierarchy and world-space contact.` });
    }
  }
  for (const descriptor of [
    { limit: testCase.maxLoopComposedPositionOffsetStuds, metric: 'endpointPositionOffsetStuds', id: 'max_loop_composed_position_offset', unit: 'studs' },
    { limit: testCase.maxLoopComposedAngularOffsetDegrees, metric: 'endpointAngularOffsetDegrees', id: 'max_loop_composed_angular_offset', unit: 'degrees' },
  ] as const) {
    if (descriptor.limit === undefined) continue;
    const worst = structural.composedLoopSeam.reduce((best, metric) => !best || metric[descriptor.metric] > best[descriptor.metric] ? metric : best,
      undefined as typeof structural.composedLoopSeam[number] | undefined);
    const observed = worst?.[descriptor.metric];
    const passed = observed !== undefined && observed <= descriptor.limit;
    push({ id: descriptor.id, status: observed === undefined ? 'unknown' : passed ? 'passed' : 'failed', observed,
      expected: descriptor.limit, unit: descriptor.unit,
      detail: observed === undefined ? 'No composed local loop-boundary evidence is available.'
        : `Composed local endpoint offset ${passed ? 'is within' : 'exceeds'} the caller limit (worst joint: ${worst!.joint}). Enabled weighted layers and root motion are composed; hierarchy and world-space contact are excluded. Intentional root accumulation must be considered when choosing the limit.` });
  }
  if (testCase.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond !== undefined) {
    const observed = activeSeamChannels.length ? Math.max(...activeSeamChannels.map(metric => metric.positionDiscontinuityStudsPerSecond)) : undefined;
    const worst = observed === undefined ? undefined : activeSeamChannels.find(metric => metric.positionDiscontinuityStudsPerSecond === observed);
    const passed = observed !== undefined && observed <= testCase.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond;
    push({ id: 'max_loop_seam_position_velocity_discontinuity', status: observed === undefined ? 'unknown' : passed ? 'passed' : 'failed',
      detail: observed === undefined ? 'No active authored channels supplied loop-seam velocity evidence.' : `${passed ? 'Approximate loop-seam position-velocity discontinuity is within' : 'Approximate loop-seam position-velocity discontinuity exceeds'} the caller limit${worst ? ` (worst: ${worst.joint}, ${worst.channel}${worst.layerId ? ` layer ${worst.layerId}` : ''}).` : '.'} This is an authored-channel finite-difference measurement, not composed world-space motion.`,
      ...(observed !== undefined ? { observed } : {}), expected: testCase.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond, unit: 'studs/second' });
  }
  if (testCase.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond !== undefined) {
    const observed = activeSeamChannels.length ? Math.max(...activeSeamChannels.map(metric => metric.angularDiscontinuityDegreesPerSecond)) : undefined;
    const worst = observed === undefined ? undefined : activeSeamChannels.find(metric => metric.angularDiscontinuityDegreesPerSecond === observed);
    const passed = observed !== undefined && observed <= testCase.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond;
    push({ id: 'max_loop_seam_angular_velocity_discontinuity', status: observed === undefined ? 'unknown' : passed ? 'passed' : 'failed',
      detail: observed === undefined ? 'No active authored channels supplied loop-seam velocity evidence.' : `${passed ? 'Approximate loop-seam angular-velocity discontinuity is within' : 'Approximate loop-seam angular-velocity discontinuity exceeds'} the caller limit${worst ? ` (worst: ${worst.joint}, ${worst.channel}${worst.layerId ? ` layer ${worst.layerId}` : ''}).` : '.'} This is an authored-channel finite-difference measurement, not composed world-space motion.`,
      ...(observed !== undefined ? { observed } : {}), expected: testCase.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond, unit: 'degrees/second' });
  }
  for (const [index, requirement] of testCase.contacts.entries()) {
    const matching = (recipe.contacts ?? []).find(contact => contact.effector.toLowerCase() === requirement.effector.toLowerCase()
      && contact.kind === requirement.kind && sameAnimationTime(contact.start, requirement.start) && sameAnimationTime(contact.end, requirement.end));
    const id = `contact:${requirement.effector}:${index + 1}`;
    if (!matching) {
      push({ id, status: 'failed', detail: 'The requested contact window is not declared in the animation recipe.', expected: `${requirement.kind} ${requirement.start}–${requirement.end}s` });
      continue;
    }
    if (requirement.end > recipe.duration) {
      push({ id, status: 'failed', detail: 'The requested contact window extends past the clip duration.', expected: `contact ends by ${recipe.duration} seconds` });
      continue;
    }
    if (studio.source !== 'studio_pose_evaluator') {
      push({ id, status: 'unknown', detail: 'Live Studio pose telemetry is unavailable for this contact check.', expected: `drift ≤ ${requirement.maxDriftStuds} studs` });
      continue;
    }
    const mapping = resolveJointMapName(requirement.effector, jointMap);
    if (mapping.status === 'ambiguous') {
      push({ id, status: 'failed', detail: 'Contact effector has multiple case-insensitive jointMap entries; provide one unambiguous mapping.', expected: 'one target joint mapping' });
      continue;
    }
    const mappedEffector = mapping.name;
    const effectorResolution = telemetry ? resolveTelemetryNodeName(telemetry.nodes, mappedEffector) : { status: 'missing' as const };
    if (effectorResolution.status === 'ambiguous') {
      push({ id, status: 'failed', detail: `Contact effector has ambiguous case-insensitive rig joints (${effectorResolution.candidates.join(', ')}); use an exact inspected joint name.`, observed: 'ambiguous target joint', expected: mappedEffector });
      continue;
    }
    const effectorNodeIndex = effectorResolution.status === 'missing' ? -1 : effectorResolution.index;
    const effectorNode = telemetry?.nodes[effectorNodeIndex];
    if (!effectorNode?.driven) {
      push({ id, status: 'failed', detail: `Contact effector does not resolve to a driven joint on the sampled target rig (${mappedEffector}).`, observed: 'not driven on target rig', expected: mappedEffector });
      continue;
    }
    const contactSamples = telemetry?.samples.filter(sample => sample.time >= requirement.start && sample.time <= requirement.end).sort((a, b) => a.time - b.time) ?? [];
    const contactTimes = contactSamples.map(sample => sample.time);
    const contactSampleIds = contactSamples.map(sample => sample.id);
    const largestSampleGap = contactTimes.length
      ? Math.max(contactTimes[0]! - requirement.start, requirement.end - contactTimes.at(-1)!,
        contactTimes.slice(1).reduce((largest, time, sampleIndex) => Math.max(largest, time - contactTimes[sampleIndex]!), 0))
      : requirement.end - requirement.start;
    if (contactTimes.length < requirement.minSamples) {
      push({ id, status: 'unknown', detail: `Studio sampled only ${contactTimes.length} poses inside the contact window; at least ${requirement.minSamples} are required.`, observed: contactTimes.length, expected: requirement.minSamples, unit: 'samples', sampleIds: contactSampleIds });
      continue;
    }
    if (largestSampleGap > requirement.maxSampleGapSeconds + 1e-6) {
      push({ id, status: 'unknown', detail: `Studio sample coverage of the contact window is too sparse (${largestSampleGap.toFixed(3)}s maximum gap, including both boundaries).`, observed: largestSampleGap, expected: requirement.maxSampleGapSeconds, unit: 'seconds maximum gap', sampleIds: contactSampleIds });
      continue;
    }
    const metric = studio.metrics.find(item => item.id === `declared-contact-${(recipe.contacts ?? []).indexOf(matching)}`);
    if (!metric) {
      push({ id, status: 'unknown', detail: 'Studio did not provide enough samples to measure this declared contact interval.', expected: `drift ≤ ${requirement.maxDriftStuds} studs`, sampleIds: contactSampleIds });
      continue;
    }
    if (metric.contactSampling?.status !== 'complete') {
      push({ id, status: 'unknown', detail: 'Studio did not sample distinct exact contact start, midpoint, and end times; measured drift is not accepted as a complete contact check.',
        observed: metric.contactSampling ? `start=${metric.contactSampling.exactStart}, midpoint=${metric.contactSampling.exactMidpoint}, end=${metric.contactSampling.exactEnd}` : 'contact coverage metadata unavailable',
        expected: 'start=true, midpoint=true, end=true', sampleIds: contactSampleIds });
      continue;
    }
    const pass = metric.value <= requirement.maxDriftStuds;
    push({ id, status: pass ? 'passed' : 'failed', detail: `${pass ? 'Measured effector drift is within the requested limit.' : 'Measured effector drift exceeds the requested limit.'} Joint: ${effectorNode.name}. Evidence: ${contactTimes.length} poses, largest gap ${largestSampleGap.toFixed(3)}s.`, observed: metric.value, expected: requirement.maxDriftStuds, unit: 'studs', sampleIds: contactSampleIds });
    if (requirement.maxCumulativeTravelStuds !== undefined || requirement.maxStepSpeedStudsPerSecond !== undefined) {
      const positions = contactSamples.map(sample => sample.points[effectorNodeIndex]);
      if (positions.some(position => position === undefined)) {
        if (requirement.maxCumulativeTravelStuds !== undefined) push({ id: `${id}:travel`, status: 'unknown', detail: 'Position telemetry is missing from one or more contact samples; cumulative sampled travel was not verified.', expected: `travel ≤ ${requirement.maxCumulativeTravelStuds} studs`, unit: 'studs', sampleIds: contactSampleIds });
        if (requirement.maxStepSpeedStudsPerSecond !== undefined) push({ id: `${id}:step-speed`, status: 'unknown', detail: 'Position telemetry is missing from one or more contact samples; adjacent-pose speed was not verified.', expected: `speed ≤ ${requirement.maxStepSpeedStudsPerSecond} studs/second`, unit: 'studs/second', sampleIds: contactSampleIds });
      } else {
        const segments = contactSamples.slice(1).map((sample, index) => {
          const from = contactSamples[index]!;
          const start = positions[index]!;
          const end = positions[index + 1]!;
          const distance = Math.hypot(...end.map((value, axis) => value - start[axis]!));
          return { from, to: sample, distance, speed: distance / (sample.time - from.time) };
        });
        const worstStep = segments.reduce((worst, segment) => segment.speed > (worst?.speed ?? -1) ? segment : worst, undefined as typeof segments[number] | undefined);
        if (requirement.maxCumulativeTravelStuds !== undefined) {
          const observed = segments.reduce((total, segment) => total + segment.distance, 0);
          const travelPass = observed <= requirement.maxCumulativeTravelStuds;
          push({ id: `${id}:travel`, status: travelPass ? 'passed' : 'failed', detail: `${travelPass ? 'Sampled cumulative effector travel is within' : 'Sampled cumulative effector travel exceeds'} the requested limit. This is the sum of adjacent sampled distances and may underestimate motion between samples.`, observed, expected: requirement.maxCumulativeTravelStuds, unit: 'studs', sampleIds: contactSampleIds });
        }
        if (requirement.maxStepSpeedStudsPerSecond !== undefined) {
          if (!worstStep) push({ id: `${id}:step-speed`, status: 'unknown', detail: 'At least two contact samples are required to measure adjacent-pose speed.', expected: `speed ≤ ${requirement.maxStepSpeedStudsPerSecond} studs/second`, unit: 'studs/second', sampleIds: contactSampleIds });
          else {
            const speedPass = worstStep.speed <= requirement.maxStepSpeedStudsPerSecond;
            push({ id: `${id}:step-speed`, status: speedPass ? 'passed' : 'failed', detail: `${speedPass ? 'Maximum sampled adjacent-pose effector speed is within' : 'Maximum sampled adjacent-pose effector speed exceeds'} the requested limit. Worst segment: ${formatAnimationTime(worstStep.from.time)}–${formatAnimationTime(worstStep.to.time)}s (${worstStep.from.id} → ${worstStep.to.id}); displacement ${worstStep.distance.toFixed(6)} studs.`, observed: worstStep.speed, expected: requirement.maxStepSpeedStudsPerSecond, unit: 'studs/second', sampleIds: [worstStep.from.id, worstStep.to.id], segment: { startTime: worstStep.from.time, endTime: worstStep.to.time, startSampleId: worstStep.from.id, endSampleId: worstStep.to.id, displacementStuds: worstStep.distance } });
          }
        }
      }
    }
    if (requirement.maxAngularDriftDegrees !== undefined) {
      const orientationId = `${id}:rotation`;
      if (!contactTimes.every(time => telemetry?.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)?.orientations?.[effectorNodeIndex] !== undefined)) {
        push({ id: orientationId, status: 'unknown', detail: 'Studio orientation telemetry is unavailable for one or more contact samples; angular stability was not verified.', expected: `angular drift ≤ ${requirement.maxAngularDriftDegrees} degrees`, unit: 'degrees', sampleIds: contactSampleIds });
      } else {
        const angularMetric = studio.metrics.find(item => item.id === `declared-contact-rotation-${(recipe.contacts ?? []).indexOf(matching)}`);
        if (!angularMetric) {
          push({ id: orientationId, status: 'unknown', detail: 'Studio did not provide an angular-drift measurement for this contact interval.', expected: `angular drift ≤ ${requirement.maxAngularDriftDegrees} degrees`, unit: 'degrees', sampleIds: contactSampleIds });
        } else {
          const angularPass = angularMetric.value <= requirement.maxAngularDriftDegrees;
          push({ id: orientationId, status: angularPass ? 'passed' : 'failed', detail: `${angularPass ? 'Measured contact orientation drift is within the requested limit.' : 'Measured contact orientation drift exceeds the requested limit.'} Joint: ${effectorNode.name}.`, observed: angularMetric.value, expected: requirement.maxAngularDriftDegrees, unit: 'degrees', sampleIds: contactSampleIds });
        }
      }
    }
    if (requirement.maxGroundOffsetStuds !== undefined) {
      const groundId = `${id}:ground`;
      if (!effectorNode.foot) {
        push({ id: groundId, status: 'unknown', detail: `Studio does not identify ${effectorNode.name} as a foot with a sole bound; ground proximity cannot be measured reliably.`, expected: `absolute ground offset ≤ ${requirement.maxGroundOffsetStuds} studs`, unit: 'studs', sampleIds: contactSampleIds });
      } else {
        const offsets = contactTimes.map(time => telemetry!.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)!.bottoms[effectorNodeIndex]!);
        const observed = Math.max(...offsets.map(Math.abs));
        const groundPass = observed <= requirement.maxGroundOffsetStuds;
        push({ id: groundId, status: groundPass ? 'passed' : 'failed', detail: `${groundPass ? 'Measured foot sole stayed within' : 'Measured foot sole exceeded'} the requested distance from the estimated rest-ground plane. This is not a physics/collision check.`, observed, expected: requirement.maxGroundOffsetStuds, unit: 'studs', sampleIds: contactSampleIds });
      }
    }
    if (requirement.targetPosition && requirement.maxTargetDistanceStuds !== undefined) {
      const targetId = `${id}:target`;
      if (!contactTimes.every(time => telemetry?.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)?.pivotPoints?.[effectorNodeIndex] !== undefined)) {
        push({ id: targetId, status: 'unknown', detail: 'Pivot-local position telemetry is unavailable for one or more contact samples; target-region adherence was not verified.', expected: `distance ≤ ${requirement.maxTargetDistanceStuds} studs from the supplied pivot-local target`, unit: 'studs', sampleIds: contactSampleIds });
      } else {
        const observed = Math.max(...contactTimes.map(time => {
          const position = telemetry!.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)!.pivotPoints![effectorNodeIndex]!;
          return Math.hypot(...position.map((value, axis) => value - requirement.targetPosition![axis]!));
        }));
        const targetPass = observed <= requirement.maxTargetDistanceStuds;
        push({ id: targetId, status: targetPass ? 'passed' : 'failed', detail: `${targetPass ? 'Every sampled contact pose stayed within' : 'At least one sampled contact pose exceeded'} the pivot-local target region.`, observed, expected: requirement.maxTargetDistanceStuds, unit: 'studs', sampleIds: contactSampleIds });
      }
    }
    if (requirement.targetOrientation && requirement.maxAngularTargetErrorDegrees !== undefined) {
      const orientationTargetId = `${id}:orientation-target`;
      if (!contactTimes.every(time => telemetry?.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)?.orientations?.[effectorNodeIndex] !== undefined)) {
        push({ id: orientationTargetId, status: 'unknown', detail: 'Studio orientation telemetry is unavailable for one or more contact samples; target orientation was not verified.', expected: `angular error ≤ ${requirement.maxAngularTargetErrorDegrees} degrees`, unit: 'degrees', sampleIds: contactSampleIds });
      } else {
        const observed = Math.max(...contactTimes.map(time => {
          const orientation = telemetry!.samples.find(sample => Math.abs(sample.time - time) <= 1e-6)!.orientations![effectorNodeIndex]!;
          return quaternionAngularErrorDegrees(orientation, requirement.targetOrientation!);
        }));
        const orientationTargetPass = observed <= requirement.maxAngularTargetErrorDegrees;
        push({ id: orientationTargetId, status: orientationTargetPass ? 'passed' : 'failed', detail: `${orientationTargetPass ? 'Every sampled contact pose stayed within' : 'At least one sampled contact pose exceeded'} the pivot-local orientation target tolerance.`, observed, expected: requirement.maxAngularTargetErrorDegrees, unit: 'degrees', sampleIds: contactSampleIds });
      }
    }
  }
  for (const [index, requirement] of testCase.bendPlanes.entries()) {
    const id = `bend-plane:${requirement.effector}:${index + 1}`;
    if (requirement.end > recipe.duration) {
      push({ id, status: 'failed', detail: 'The requested bend-plane interval extends past the clip duration.', expected: `end by ${recipe.duration} seconds` });
      continue;
    }
    if (!telemetry || studio.source !== 'studio_pose_evaluator') {
      push({ id, status: 'unknown', detail: 'Live Studio joint-pivot telemetry is unavailable; bend direction cannot be measured from body-part centers.', expected: `deviation ≤ ${requirement.maxDeviationDegrees} degrees` });
      continue;
    }
    const names = [requirement.rootJoint, requirement.middleJoint, requirement.effector];
    const mappings = names.map(name => resolveJointMapName(name, jointMap));
    if (mappings.some(mapping => mapping.status === 'ambiguous')) {
      push({ id, status: 'failed', detail: 'A bend-plane joint has multiple case-insensitive jointMap entries; provide unambiguous mappings.', expected: 'one target mapping per joint' });
      continue;
    }
    const mappedNames = mappings.map((mapping, mappingIndex) => mapping.status === 'resolved' ? mapping.name : names[mappingIndex]!);
    const nodeResolutions = mappedNames.map(name => resolveTelemetryNodeName(telemetry.nodes, name));
    const ambiguousNodes = nodeResolutions.flatMap((resolution, index) => resolution.status === 'ambiguous'
      ? [`${mappedNames[index]} → ${resolution.candidates.join(', ')}`] : []);
    if (ambiguousNodes.length) {
      push({ id, status: 'failed', detail: `Bend-plane joints have ambiguous case-insensitive rig matches (${ambiguousNodes.join('; ')}); use exact inspected joint names.`, observed: 'ambiguous target joints', expected: 'one exact rig joint per chain role' });
      continue;
    }
    const nodeIndices = nodeResolutions.map(resolution => resolution.status === 'missing' ? -1 : resolution.index);
    const [rootIndex, middleIndex, effectorIndex] = nodeIndices;
    if (rootIndex === undefined || middleIndex === undefined || effectorIndex === undefined
      || rootIndex < 0 || middleIndex < 0 || effectorIndex < 0) {
      push({ id, status: 'failed', detail: `Bend-plane chain does not resolve on the sampled rig (${mappedNames.join(' → ')}).`, observed: 'missing joint', expected: 'three joints in the sampled rig' });
      continue;
    }
    const rootNode = telemetry.nodes[rootIndex]!, middleNode = telemetry.nodes[middleIndex]!, effectorNode = telemetry.nodes[effectorIndex]!;
    if (!rootNode.driven || !middleNode.driven || !effectorNode.driven) {
      push({ id, status: 'failed', detail: 'Bend-plane chain contains a node without a driven joint pivot on the sampled rig.', observed: [rootNode, middleNode, effectorNode].filter(node => !node.driven).map(node => node.name).join(', '), expected: 'all three joints driven' });
      continue;
    }
    if (middleNode.parent !== rootIndex + 1 || effectorNode.parent !== middleIndex + 1) {
      push({ id, status: 'failed', detail: 'The declared bend-plane joints are not a direct parent-child chain in the sampled rig hierarchy.', observed: JSON.stringify({ rootParentIndex: middleNode.parent, expectedRootParentIndex: rootIndex + 1, middleParentIndex: effectorNode.parent, expectedMiddleParentIndex: middleIndex + 1 }), expected: `${rootNode.name} → ${middleNode.name} → ${effectorNode.name}` });
      continue;
    }
    if (!telemetry.samples.every(sample => sample.jointPoints !== undefined)) {
      push({ id, status: 'unknown', detail: 'This Studio telemetry predates joint-pivot sampling; bend direction cannot be measured reliably from part centers.', expected: `deviation ≤ ${requirement.maxDeviationDegrees} degrees` });
      continue;
    }
    const samples = telemetry.samples.filter(sample => sample.time >= requirement.start && sample.time <= requirement.end).sort((left, right) => left.time - right.time);
    const sampleIds = samples.map(sample => sample.id);
    const largestGap = samples.length
      ? Math.max(samples[0]!.time - requirement.start, requirement.end - samples.at(-1)!.time,
        samples.slice(1).reduce((largest, sample, sampleIndex) => Math.max(largest, sample.time - samples[sampleIndex]!.time), 0))
      : requirement.end - requirement.start;
    if (samples.length < requirement.minSamples || largestGap > requirement.maxSampleGapSeconds + 1e-6) {
      push({ id, status: 'unknown', detail: samples.length < requirement.minSamples
        ? `Studio sampled ${samples.length} poses in the bend interval; ${requirement.minSamples} are required.`
        : `Bend interval sample coverage is sparse (${largestGap.toFixed(3)}s largest gap, including boundaries).`,
      observed: samples.length < requirement.minSamples ? samples.length : largestGap,
      expected: samples.length < requirement.minSamples ? requirement.minSamples : requirement.maxSampleGapSeconds,
      unit: samples.length < requirement.minSamples ? 'samples' : 'seconds maximum gap', sampleIds });
      continue;
    }
    const measurements = samples.map(sample => ({ sample, deviation: bendPlaneDeviationDegrees(
      sample.jointPoints![rootIndex]!, sample.jointPoints![middleIndex]!, sample.jointPoints![effectorIndex]!, requirement.poleTarget,
    ) }));
    const degenerate = measurements.find(item => item.deviation === undefined);
    if (degenerate) {
            push({ id, status: 'unknown', detail: `Bend plane is degenerate at ${formatAnimationTime(degenerate.sample.time)}s: the limb is straight/axial or the pole target projects onto the limb axis.`, observed: degenerate.sample.time, expected: 'measurable non-zero bend and pole vectors', unit: 'seconds', sampleIds: [degenerate.sample.id] });
      continue;
    }
    const worst = measurements.reduce((best, item) => item.deviation! > best.deviation! ? item : best);
    const pass = worst.deviation! <= requirement.maxDeviationDegrees;
    push({ id, status: pass ? 'passed' : 'failed',
      detail: `${pass ? 'Measured bend direction stayed within' : 'Measured bend direction exceeded'} the requested pole-plane deviation. Chain: ${rootNode.name} → ${middleNode.name} → ${effectorNode.name}; worst sample ${worst.sample.id} at ${formatAnimationTime(worst.sample.time)}s.`,
      observed: worst.deviation!, expected: requirement.maxDeviationDegrees, unit: 'degrees', sampleIds });
  }
  const failed = checks.filter(check => check.status === 'failed').length;
  const unknown = checks.filter(check => check.status === 'unknown').length;
  return {
    status: failed ? 'failed' as const : unknown ? 'incomplete' as const : 'passed' as const,
    summary: { total: checks.length, passed: checks.filter(check => check.status === 'passed').length, failed, unknown }, checks,
    limitation: 'Passing means only that the explicitly declared recipe and sampled-motion checks passed. It does not certify artistic quality, rendered deformation, gameplay physics, or unsampled motion.',
  };
}
