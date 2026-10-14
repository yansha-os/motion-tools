import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AnimationGraphLibrary } from './animation-graph.js';
import { animationGraphEndedTimingSchema, animationGraphEventOrderingDiagnosticsSchema, animationGraphEventOrderSensitivitySchema,
  animationGraphPlaybackRetriggerModelSchema } from './animation-graph-simulation.js';
import { animationGraphTimelineSuiteSchema, animationGraphTimelineSuiteShape, runAnimationGraphTimelineSuite,
  validateAnimationGraphTimelinePhaseSyncReferences } from './animation-graph-timeline-tests.js';
import { animationSchema, identifier, label } from './recipes.js';
import { assessAnimationGraphFadeCalibration, studioBuildIdentitySchema, studioPlayRetriggerProbeSchema,
  type AnimationGraphFadeCalibration } from './animation-graph-fade-calibrations.js';
import { quaternionAngularDistanceDegrees } from './quaternion-blend.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unitQuaternion = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(value => Math.abs(Math.hypot(...value) - 1) <= 1e-3, 'Quaternion must be normalized.');
const parentSchema = z.object({ id: identifier, revision: z.number().int().positive() }).strict();
const suiteSchema = animationGraphTimelineSuiteSchema;
type TimelineSuite = z.infer<typeof suiteSchema>;

function recipeHasJointChannel(recipe: z.infer<typeof animationSchema> | undefined, joint: string): boolean {
  return recipe !== undefined && (recipe.tracks.some(track => track.joint === joint)
    || (recipe.layers ?? []).some(layer => layer.enabled && layer.weight > 0 && layer.tracks.some(track => track.joint === joint))
    || recipe.rootMotion?.joint === joint);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function deterministicId(fingerprint: string): string {
  const bytes = createHash('sha256').update(`motion-tools:graph-timeline-plan:${fingerprint}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function planDraft(value: { name: string; parent?: { id: string; revision: number }; graphId: string; graphFingerprint: string;
  sourceFingerprints: string[]; cases: TimelineSuite['cases'] }, fingerprintVersion: 1 | 2 = 2) {
  const suiteFingerprint = digest({ schemaVersion: 1, cases: value.cases });
  if (fingerprintVersion === 1) return { schemaVersion: 1, name: value.name, parent: value.parent ?? null, graphId: value.graphId,
    graphFingerprint: value.graphFingerprint, suiteFingerprint, cases: value.cases };
  return { schemaVersion: 2, name: value.name, parent: value.parent ?? null, graphId: value.graphId,
    graphFingerprint: value.graphFingerprint, sourceFingerprints: value.sourceFingerprints, suiteFingerprint, cases: value.cases };
}
async function writeImmutable(path: string, value: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await link(temporaryPath, path);
  } finally { await unlink(temporaryPath).catch(() => undefined); }
}

const planSchema = z.object({
  fingerprintVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  id: identifier, name: label, revision: z.number().int().positive(), parent: parentSchema.nullable(), graphId: identifier,
  graphFingerprint: hash, sourceFingerprints: z.array(hash).min(1).max(64), suiteFingerprint: hash,
  draftFingerprint: hash, planFingerprint: hash, createdAt: z.string().datetime(), cases: animationGraphTimelineSuiteShape.cases,
}).strict().superRefine((plan, context) => {
  const suiteResult = suiteSchema.safeParse({ cases: plan.cases });
  if (!suiteResult.success) context.addIssue({ code: 'custom', path: ['cases'], message: 'Timeline plan cases violate suite-wide resource or uniqueness limits.' });
  const parent = plan.parent ?? undefined;
  const payload = planDraft({ name: plan.name, parent, graphId: plan.graphId, graphFingerprint: plan.graphFingerprint,
    sourceFingerprints: plan.sourceFingerprints, cases: plan.cases }, plan.fingerprintVersion);
  if (payload.suiteFingerprint !== plan.suiteFingerprint) context.addIssue({ code: 'custom', path: ['suiteFingerprint'], message: 'Timeline plan suite fingerprint does not match its cases.' });
  if (digest(payload) !== plan.draftFingerprint) context.addIssue({ code: 'custom', path: ['draftFingerprint'], message: 'Timeline plan draft fingerprint does not match immutable content.' });
  if (plan.id !== deterministicId(plan.draftFingerprint)) context.addIssue({ code: 'custom', path: ['id'], message: 'Timeline plan ID does not match its reviewed draft.' });
  if (plan.revision !== (parent?.revision ?? 0) + 1) context.addIssue({ code: 'custom', path: ['revision'], message: 'Timeline plan revision must follow its parent.' });
  if (digest({ draftFingerprint: plan.draftFingerprint, revision: plan.revision }) !== plan.planFingerprint) context.addIssue({ code: 'custom', path: ['planFingerprint'], message: 'Timeline plan fingerprint does not match draft and revision.' });
});

const studioStateSampleSchema = z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), animationId: identifier,
  recipeFingerprint: hash, telemetryFingerprint: hash,
  inspection: z.object({ source: z.enum(['studio_pose_evaluator', 'recipe_only']), metrics: z.array(z.unknown()).max(512),
    findings: z.array(z.unknown()).max(512), questions: z.array(z.unknown()).max(64), limitations: z.array(z.string()).max(64) }).strict() }).strict();
const studioEvidenceBaseSchema = z.object({ schemaVersion: z.literal(1), graphFingerprint: hash, rigId: identifier,
  rigSignature: z.string().min(1).max(30000), samples: z.array(studioStateSampleSchema).min(1).max(8),
  uncoveredExpectedStateIds: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)).max(64) }).strict();
const studioEvidenceSchema = studioEvidenceBaseSchema.extend({ fingerprint: hash }).strict()
  .superRefine((evidence, context) => {
    if (new Set(evidence.samples.map(sample => sample.stateId)).size !== evidence.samples.length) context.addIssue({ code: 'custom', path: ['samples'], message: 'Studio evidence state IDs must be unique.' });
    const { fingerprint, ...content } = evidence;
    if (digest(content) !== fingerprint) context.addIssue({ code: 'custom', path: ['fingerprint'], message: 'Studio evidence fingerprint does not match its content.' });
  });
const simulatedTimelineContextSchema = z.object({
  mostRecentTransition: z.object({ transitionId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
    fromState: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), toState: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
    startedAt: z.number().finite().min(0).max(120), blendSeconds: z.number().finite().min(0).max(30), progress: z.number().finite().min(0).max(1),
    sourceWeightAtTransition: z.number().finite().min(0).max(1).optional(),
    destinationWeightAtTransition: z.number().finite().min(0).max(1).optional(), destinationFadeStartWeight: z.number().finite().min(0).max(1).optional() }).strict().nullable(),
  markersAtSample: z.array(z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), name: label, value: z.string().max(256) }).strict()).max(128),
}).strict();
const blendTrackSchema = z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  weight: z.number().finite().min(0).max(1), playbackTimeSeconds: z.number().finite().min(0).max(30) }).strict();
const simulatedContributorSchema = z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), priority: label,
  trackWeight: z.number().finite().min(0).max(1), effectiveWeight: z.number().finite().min(0).max(1),
  contributionStatus: z.enum(['contributing', 'zero_weight', 'masked_by_higher_priority']),
  position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), rotationQuaternion: unitQuaternion }).strict();
const simulatedPriorityLayerSchema = z.object({ priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']),
  priorityRank: z.number().int().min(0).max(6), stateIds: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)).min(1).max(64),
  requestedWeight: z.number().finite().min(0).max(64), availableWeightBefore: z.number().finite().min(0).max(1),
  effectiveBudget: z.number().finite().min(0).max(1), remainingWeightAfter: z.number().finite().min(0).max(1) }).strict();
const studioBlendEvidenceBaseSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10), z.literal(11), z.literal(12)]),
  source: z.literal('studio_animator_native_blend'), calibrationProtocol: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  jointMap: z.record(label, label).refine(map => Object.keys(map).length <= 256).optional(), jointMapFingerprint: hash.optional(),
  graphFingerprint: hash, rigId: identifier, rigSignature: z.string().min(1).max(30000), studioBuildIdentity: studioBuildIdentitySchema.optional(), limitation: z.string().max(1000).optional(),
  samples: z.array(z.object({ caseId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), at: z.number().finite().min(0).max(120),
    joint: label, activeStates: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)).max(64).optional(),
    activeTracks: z.array(blendTrackSchema).max(64).optional(), requestedTracks: z.array(blendTrackSchema).max(64).optional(),
    simulatedTimelineContext: simulatedTimelineContextSchema.optional(),
    simulatedResidualBasis: z.literal('identity_local_animation_delta').optional(),
    simulatedContributors: z.array(simulatedContributorSchema).max(64).optional(), simulatedResidualWeight: z.number().finite().min(0).max(1).optional(),
    simulatedPriorityLayers: z.array(simulatedPriorityLayerSchema).max(7).optional(),
    predicted: z.object({ position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
      rotationQuaternion: unitQuaternion }).strict(),
    measured: z.object({ position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
      rotationQuaternion: unitQuaternion }).strict(),
    positionErrorStuds: z.number().finite().min(0), rotationErrorDegrees: z.number().finite().min(0).max(180) }).strict()).min(1).max(4096),
}).strict();
const studioBlendEvidenceSchema = studioBlendEvidenceBaseSchema.extend({ fingerprint: hash }).strict()
  .superRefine((evidence, context) => {
    const keys = evidence.samples.map(sample => `${sample.caseId}:${sample.at}:${sample.joint}`);
    if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['samples'], message: 'Studio blend evidence cannot repeat a case/time/joint sample.' });
    evidence.samples.forEach((sample, index) => {
      const measuredPositionError = Math.hypot(...sample.measured.position.map((value, axis) => value - sample.predicted.position[axis]!));
      const measuredRotationError = quaternionAngularDistanceDegrees(sample.predicted.rotationQuaternion, sample.measured.rotationQuaternion);
      if (Math.abs(sample.positionErrorStuds - measuredPositionError) > 1e-9 * Math.max(1, measuredPositionError)) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'positionErrorStuds'], message: 'Reported position error must match predicted and measured poses.' });
      }
      if (Math.abs(sample.rotationErrorDegrees - measuredRotationError) > 1e-7) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'rotationErrorDegrees'], message: 'Reported rotation error must match predicted and measured poses.' });
      }
      if (sample.activeStates === undefined && sample.activeTracks === undefined) context.addIssue({ code: 'custom', path: ['samples', index, 'activeTracks'], message: 'Blend evidence requires track context.' });
      for (const [field, tracks] of [['activeTracks', sample.activeTracks], ['requestedTracks', sample.requestedTracks]] as const) {
        if (tracks && new Set(tracks.map(track => track.stateId)).size !== tracks.length) {
          context.addIssue({ code: 'custom', path: ['samples', index, field], message: 'Blend track context cannot repeat a graph state.' });
        }
      }
      if (sample.activeStates && new Set(sample.activeStates).size !== sample.activeStates.length) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'activeStates'], message: 'Active state context cannot repeat a graph state.' });
      }
      if (sample.activeTracks && sample.activeStates && canonical(sample.activeStates) !== canonical(sample.activeTracks.map(track => track.stateId))) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'activeStates'], message: 'Blend state names must match exact active track context.' });
      }
      if (evidence.schemaVersion === 2 && !sample.activeTracks) context.addIssue({ code: 'custom', path: ['samples', index, 'activeTracks'], message: 'Version 2 blend evidence requires exact track weights and playback positions.' });
      if (evidence.schemaVersion === 3 && (!sample.activeTracks || !sample.simulatedTimelineContext)) context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 3 blend evidence requires exact track inputs and simulated timeline context.' });
      if (evidence.schemaVersion === 4 && (!sample.activeTracks || !sample.requestedTracks || !sample.simulatedTimelineContext)) context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 4 blend evidence requires measured and requested track values plus simulated timeline context.' });
      if (evidence.schemaVersion === 5 && (!sample.activeTracks || !sample.requestedTracks || !sample.simulatedTimelineContext
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 5 blend evidence requires per-joint simulated contributor weights and residual pose weight.' });
      }
      if (evidence.schemaVersion === 6 && (!sample.activeTracks || !sample.requestedTracks || !sample.simulatedTimelineContext
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined || !evidence.limitation)) {
        context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 6 blend evidence requires complete blend context and a persisted calibration limitation.' });
      }
      if (evidence.schemaVersion === 7 && (!sample.activeTracks || !sample.requestedTracks || !sample.simulatedTimelineContext
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined || !sample.simulatedPriorityLayers || !evidence.limitation)) {
        context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 7 blend evidence requires contributor context, priority-layer budgets, and the calibration limitation.' });
      }
      if (evidence.schemaVersion === 8 && (!evidence.studioBuildIdentity || !sample.activeTracks || !sample.requestedTracks
        || !sample.simulatedTimelineContext || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined
        || !sample.simulatedPriorityLayers || !evidence.limitation)) {
        context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 8 blend evidence requires engine-build provenance and complete native-blend context.' });
      }
      if (evidence.schemaVersion >= 9 && (!evidence.studioBuildIdentity || !sample.activeTracks || !sample.requestedTracks
        || !sample.simulatedTimelineContext || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined
        || !sample.simulatedPriorityLayers || !evidence.limitation
        || sample.simulatedTimelineContext.mostRecentTransition !== null
          && (sample.simulatedTimelineContext.mostRecentTransition.sourceWeightAtTransition === undefined
            || sample.simulatedTimelineContext.mostRecentTransition.destinationWeightAtTransition === undefined
            || sample.simulatedTimelineContext.mostRecentTransition.destinationFadeStartWeight === undefined))) {
        context.addIssue({ code: 'custom', path: ['samples', index], message: 'Version 9 blend evidence requires engine-build provenance, complete blend context, and transition fade-origin weights.' });
      }
      if ((sample.simulatedContributors === undefined) !== (sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedContributors'], message: 'Simulated contributors and their residual pose weight must be recorded together.' });
      }
      if (sample.simulatedResidualBasis !== undefined
        && (!sample.simulatedContributors || sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedResidualBasis'], message: 'A residual basis requires its simulated contributor and residual-weight evidence.' });
      }
      if (evidence.schemaVersion === 10 && (sample.simulatedResidualBasis !== 'identity_local_animation_delta'
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedResidualBasis'], message: 'Version 10 blend evidence requires a verified neutral-animation residual basis and complete simulated pose context.' });
      }
      if (evidence.schemaVersion === 11 && (!evidence.calibrationProtocol
        || sample.simulatedResidualBasis !== 'identity_local_animation_delta'
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['calibrationProtocol'], message: 'Version 11 blend evidence requires an explicit Studio calibration protocol and complete simulated pose context.' });
      }
      if (evidence.schemaVersion === 12 && (!evidence.calibrationProtocol || !evidence.jointMap || !evidence.jointMapFingerprint
        || digest(evidence.jointMap) !== evidence.jointMapFingerprint
        || sample.simulatedResidualBasis !== 'identity_local_animation_delta'
        || !sample.simulatedContributors || sample.simulatedResidualWeight === undefined)) {
        context.addIssue({ code: 'custom', path: ['jointMapFingerprint'], message: 'Version 12 blend evidence requires a fingerprint-verified joint map, Studio calibration protocol, and complete simulated pose context.' });
      }
      if ((evidence.jointMap === undefined) !== (evidence.jointMapFingerprint === undefined)
        || evidence.jointMap !== undefined && digest(evidence.jointMap) !== evidence.jointMapFingerprint) {
        context.addIssue({ code: 'custom', path: ['jointMapFingerprint'], message: 'Joint-map provenance must include its matching content fingerprint.' });
      }
      sample.simulatedContributors?.forEach((contributor, contributorIndex) => {
        const statusMatchesWeights = contributor.trackWeight === 0
          ? contributor.effectiveWeight === 0 && contributor.contributionStatus === 'zero_weight'
          : contributor.effectiveWeight > 0 ? contributor.contributionStatus === 'contributing'
            : contributor.contributionStatus === 'masked_by_higher_priority';
        if (!statusMatchesWeights) context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedContributors', contributorIndex, 'contributionStatus'],
          message: 'Contributor status must agree with its requested and effective weights.' });
      });
      if (sample.simulatedContributors && sample.simulatedResidualWeight !== undefined) {
        const contributorIds = sample.simulatedContributors.map(contributor => contributor.stateId);
        if (new Set(contributorIds).size !== contributorIds.length) context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedContributors'], message: 'Simulated pose contributors cannot repeat a graph state.' });
        const totalPoseWeight = sample.simulatedContributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, sample.simulatedResidualWeight);
        if (Math.abs(totalPoseWeight - 1) > 1e-6) context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedResidualWeight'], message: 'Simulated contributor weights plus neutral local animation residual must sum to one.' });
        if (sample.requestedTracks && sample.simulatedContributors.some(contributor => {
          const requested = sample.requestedTracks!.find(track => track.stateId === contributor.stateId);
          return !requested || Math.abs(requested.weight - contributor.trackWeight) > 1e-6;
        })) context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedContributors'], message: 'Simulated contributor track weights must match the requested tracks.' });
      }
      if (sample.simulatedPriorityLayers) {
        const rankByPriority = { Core: 0, Idle: 1, Movement: 2, Action: 3, Action2: 4, Action3: 5, Action4: 6 } as const;
        let remaining = 1;
        const coveredStates: string[] = [];
        sample.simulatedPriorityLayers.forEach((layer, layerIndex) => {
          if (layer.priorityRank !== rankByPriority[layer.priority] || layerIndex > 0
            && sample.simulatedPriorityLayers![layerIndex - 1]!.priorityRank <= layer.priorityRank) {
            context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers', layerIndex], message: 'Priority layers must use canonical ranks in descending priority order.' });
          }
          if (Math.abs(layer.availableWeightBefore - remaining) > 1e-6
            || Math.abs(layer.effectiveBudget - Math.min(remaining, layer.requestedWeight)) > 1e-6
            || Math.abs(layer.remainingWeightAfter - (remaining - layer.effectiveBudget)) > 1e-6) {
            context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers', layerIndex], message: 'Priority layer budget does not conserve the available joint weight.' });
          }
          if (new Set(layer.stateIds).size !== layer.stateIds.length) context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers', layerIndex, 'stateIds'], message: 'Priority layer state IDs must be unique.' });
          if (sample.simulatedContributors) {
            const layerContributors = sample.simulatedContributors.filter(contributor => layer.stateIds.includes(contributor.stateId));
            const requestedWeight = layerContributors.reduce((sum, contributor) => sum + contributor.trackWeight, 0);
            const effectiveWeight = layerContributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, 0);
            if (layerContributors.length !== layer.stateIds.length || layerContributors.some(contributor => contributor.priority !== layer.priority)
              || Math.abs(requestedWeight - layer.requestedWeight) > 1e-6 || Math.abs(effectiveWeight - layer.effectiveBudget) > 1e-6) {
              context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers', layerIndex], message: 'Priority layer members and budgets must agree with the per-state contributor evidence.' });
            }
          }
          coveredStates.push(...layer.stateIds);
          remaining = layer.remainingWeightAfter;
        });
        if (sample.simulatedResidualWeight !== undefined && Math.abs(remaining - sample.simulatedResidualWeight) > 1e-6) {
          context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers'], message: 'Priority layer remainder must equal the stored neutral local animation residual.' });
        }
        if (sample.simulatedContributors && canonical([...coveredStates].sort()) !== canonical(sample.simulatedContributors.map(contributor => contributor.stateId).sort())) {
          context.addIssue({ code: 'custom', path: ['samples', index, 'simulatedPriorityLayers'], message: 'Priority layer state IDs must account for every simulated contributor exactly once.' });
        }
      }
      if (sample.activeTracks && sample.requestedTracks) {
        const observed = [...sample.activeTracks].sort((left, right) => left.stateId.localeCompare(right.stateId));
        const requested = [...sample.requestedTracks].sort((left, right) => left.stateId.localeCompare(right.stateId));
        if (observed.length !== requested.length || observed.some((track, trackIndex) => {
          const expected = requested[trackIndex];
          return !expected || track.stateId !== expected.stateId || Math.abs(track.weight - expected.weight) > 0.0001
            || Math.abs(track.playbackTimeSeconds - expected.playbackTimeSeconds) > 0.001;
        })) context.addIssue({ code: 'custom', path: ['samples', index, 'activeTracks'], message: 'Measured Animator track values exceed readback tolerance from requested values.' });
      }
    });
    const { fingerprint, ...content } = evidence;
    if (digest(content) !== fingerprint) context.addIssue({ code: 'custom', path: ['fingerprint'], message: 'Studio blend evidence fingerprint does not match its content.' });
  });
const studioMetricSchema = z.object({ id: z.string(), label: z.string(), value: z.number().finite(), unit: z.string(), detail: z.string(),
  sampleIds: z.array(z.string()), semanticKey: z.string().optional() }).passthrough();
const studioFindingSchema = z.object({ id: z.string(), severity: z.string(), title: z.string(), detail: z.string(), sampleIds: z.array(z.string()) }).passthrough();

function summarizeStudioBlendCalibration(samples: z.infer<typeof studioBlendEvidenceSchema>['samples'] | undefined) {
  if (!samples) return null;
  const percentile = (values: number[], fraction: number): number | null => {
    if (values.length === 0) return null;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
  };
  const errorDistribution = (entries: typeof samples) => ({
    sampleCount: entries.length,
    positionErrorStuds: { p50: percentile(entries.map(sample => sample.positionErrorStuds), 0.5),
      p95: percentile(entries.map(sample => sample.positionErrorStuds), 0.95) },
    rotationErrorDegrees: { p50: percentile(entries.map(sample => sample.rotationErrorDegrees), 0.5),
      p95: percentile(entries.map(sample => sample.rotationErrorDegrees), 0.95) },
  });
  const byCompositionDimension = (select: (sample: NonNullable<z.infer<typeof studioBlendEvidenceSchema>['samples']>[number]) => number | undefined) => {
    const groups = new Map<number | null, typeof samples>();
    for (const sample of samples) {
      const value = select(sample) ?? null;
      const group = groups.get(value) ?? [];
      group.push(sample);
      groups.set(value, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left === null ? 1 : right === null ? -1 : left - right)
      .map(([value, entries]) => ({ value, ...errorDistribution(entries) }));
  };
  const samplesByCaseAndJoint = new Map<string, typeof samples>();
  for (const sample of samples) {
    const key = `${sample.caseId}:${sample.joint}`;
    const group = samplesByCaseAndJoint.get(key) ?? [];
    group.push(sample);
    samplesByCaseAndJoint.set(key, group);
  }
  const worstPosition = [...samples].sort((left, right) => right.positionErrorStuds - left.positionErrorStuds
    || left.caseId.localeCompare(right.caseId) || left.at - right.at || left.joint.localeCompare(right.joint))[0];
  const worstRotation = [...samples].sort((left, right) => right.rotationErrorDegrees - left.rotationErrorDegrees
    || left.caseId.localeCompare(right.caseId) || left.at - right.at || left.joint.localeCompare(right.joint))[0];
  return {
    sampleCount: samples.length,
    caseCount: new Set(samples.map(sample => sample.caseId)).size,
    timestampCount: new Set(samples.map(sample => `${sample.caseId}:${sample.at}`)).size,
    errorDistribution: { ...errorDistribution(samples), method: 'nearest_rank_percentile' as const,
      limitation: 'Percentiles summarize only explicitly Studio-sampled fixed-weight poses; they are descriptive and do not imply an acceptance threshold or validate unsampled fade trajectories.' },
    compositionStrata: {
      byObservedActiveTrackCount: byCompositionDimension(sample => sample.activeTracks?.length),
      bySimulatedPriorityLayerCount: byCompositionDimension(sample => sample.simulatedPriorityLayers?.length),
      bySimulatedSamePriorityOverlapCount: byCompositionDimension(sample => sample.simulatedPriorityLayers
        ?.reduce((sum, layer) => sum + Math.max(0, layer.stateIds.length - 1), 0)),
      limitation: 'Each stratum groups the same measured-versus-predicted local-pose errors by one dimension at a time. Active track count is Studio readback; priority-layer and overlap counts come from the simulator model. These are descriptive correlations, not causal attribution, native blend decomposition, quality thresholds, or proof about runtime fade behavior. Missing historical context is grouped as value=null.',
    },
    byCaseAndJoint: [...samplesByCaseAndJoint.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
      const separator = key.indexOf(':');
      return { caseId: key.slice(0, separator), joint: key.slice(separator + 1), ...errorDistribution(entries) };
    }),
    samplesWithoutExactTrackContext: samples.filter(sample => !sample.activeTracks).length,
    maxPositionErrorStuds: worstPosition?.positionErrorStuds ?? null,
    worstPosition: worstPosition ? { caseId: worstPosition.caseId, at: worstPosition.at, joint: worstPosition.joint,
      activeTracks: worstPosition.activeTracks ?? null, simulatedTimelineContext: worstPosition.simulatedTimelineContext ?? null,
      positionErrorStuds: worstPosition.positionErrorStuds } : null,
    maxRotationErrorDegrees: worstRotation?.rotationErrorDegrees ?? null,
    worstRotation: worstRotation ? { caseId: worstRotation.caseId, at: worstRotation.at, joint: worstRotation.joint,
      activeTracks: worstRotation.activeTracks ?? null, simulatedTimelineContext: worstRotation.simulatedTimelineContext ?? null,
      rotationErrorDegrees: worstRotation.rotationErrorDegrees } : null,
    interpretation: 'These are maximum numeric differences between the local estimate and Studio native Animator evaluation, not pass/fail quality thresholds or artistic judgments.',
  };
}

const studioCalibrationGateSchema = z.object({
  status: z.enum(['not_requested', 'not_run', 'passed', 'failed']),
  checks: z.array(z.object({ caseId: z.string(), joint: label, status: z.enum(['passed', 'failed', 'not_run']),
    expectedSampleCount: z.number().int().nonnegative(), actualSampleCount: z.number().int().nonnegative(),
    missingTimes: z.array(z.number().finite()),
    sampleChecks: z.array(z.object({ at: z.number().finite().min(0), status: z.enum(['passed', 'failed', 'not_run']),
      notRunReason: z.enum(['evidence_not_supplied', 'evidence_sample_missing', 'expected_track_snapshot_not_matched']).optional(),
      positionErrorStuds: z.number().finite().min(0).optional(), rotationErrorDegrees: z.number().finite().min(0).max(180).optional() }).strict()).max(512),
    notRunReason: z.enum(['evidence_not_supplied', 'evidence_sample_missing', 'expected_track_snapshot_not_matched']).optional(),
    worstPositionSample: z.object({ at: z.number().finite().min(0), activeTracks: z.array(blendTrackSchema).max(64), errorStuds: z.number().finite().min(0),
      simulatedTimelineContext: simulatedTimelineContextSchema.nullable() }).strict().optional(),
    worstRotationSample: z.object({ at: z.number().finite().min(0), activeTracks: z.array(blendTrackSchema).max(64), errorDegrees: z.number().finite().min(0).max(180),
      simulatedTimelineContext: simulatedTimelineContextSchema.nullable() }).strict().optional(),
    maxPositionErrorStuds: z.number().finite().min(0).optional(), observedMaxPositionErrorStuds: z.number().finite().min(0).optional(),
    maxRotationErrorDegrees: z.number().finite().min(0).max(180).optional(), observedMaxRotationErrorDegrees: z.number().finite().min(0).max(180).optional() }).strict()).max(2048),
  limitation: z.string(),
}).strict();

function evaluateStudioCalibrationGate(
  cases: TimelineSuite['cases'],
  expectedTrace: NonNullable<ReturnType<typeof runAnimationGraphTimelineSuite>['studioCalibrationTrace']>,
  evidence: z.infer<typeof studioBlendEvidenceSchema> | undefined,
) {
  const requests = cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => pose.studioCalibrationTolerance
    ? [{ caseId: testCase.id, joint: pose.joint, at: pose.at, throughout: pose.throughout, tolerance: pose.studioCalibrationTolerance }]
    : []));
  if (requests.length === 0) return { status: 'not_requested' as const, checks: [],
    limitation: 'No pose assertion requested a Studio-native calibration tolerance; no engine-difference release gate was applied.' };
  const checks = requests.map(request => {
    const expectedTimes = [...new Set(expectedTrace.filter(sample => sample.caseId === request.caseId
      && sample.joints.some(joint => joint.joint === request.joint)
      && (sample.at === request.at || (request.throughout !== undefined && sample.at >= request.throughout.start && sample.at <= request.throughout.end)))
      .map(sample => sample.at))].sort((left, right) => left - right);
    const expectedTracksAt = (at: number) => expectedTrace.find(sample => sample.caseId === request.caseId && sample.at === at)?.tracks;
    const actualSamples = evidence?.samples.filter(sample => {
      if (sample.caseId !== request.caseId || sample.joint !== request.joint || !expectedTimes.includes(sample.at) || !sample.activeTracks) return false;
      const expectedTracks = expectedTracksAt(sample.at);
      if (expectedTracks === undefined || sample.activeTracks.length !== expectedTracks.length) return false;
      return expectedTracks.every(expected => {
        const measured = sample.activeTracks!.find(track => track.stateId === expected.stateId);
        return measured !== undefined && Math.abs(measured.weight - expected.weight) <= 0.0001
          && Math.abs(measured.playbackTimeSeconds - expected.playbackTimeSeconds) <= 0.001;
      });
    }) ?? [];
    const actualByTime = new Map(actualSamples.map(sample => [sample.at, sample]));
    const missingTimes = expectedTimes.filter(at => !actualByTime.has(at));
    const observedMaxPositionErrorStuds = actualSamples.length ? Math.max(...actualSamples.map(sample => sample.positionErrorStuds)) : undefined;
    const observedMaxRotationErrorDegrees = actualSamples.length ? Math.max(...actualSamples.map(sample => sample.rotationErrorDegrees)) : undefined;
    const worstPosition = [...actualSamples].sort((left, right) => right.positionErrorStuds - left.positionErrorStuds || left.at - right.at)[0];
    const worstRotation = [...actualSamples].sort((left, right) => right.rotationErrorDegrees - left.rotationErrorDegrees || left.at - right.at)[0];
    const sampleChecks = expectedTimes.map(at => {
      const exactEvidence = evidence?.samples.find(sample => sample.caseId === request.caseId && sample.joint === request.joint && sample.at === at);
      const matched = actualByTime.get(at);
      if (!matched) return { at, status: 'not_run' as const,
        notRunReason: !evidence ? 'evidence_not_supplied' as const : exactEvidence ? 'expected_track_snapshot_not_matched' as const : 'evidence_sample_missing' as const };
      const passed = (request.tolerance.maxPositionErrorStuds === undefined || matched.positionErrorStuds <= request.tolerance.maxPositionErrorStuds)
        && (request.tolerance.maxRotationErrorDegrees === undefined || matched.rotationErrorDegrees <= request.tolerance.maxRotationErrorDegrees);
      return { at, status: passed ? 'passed' as const : 'failed' as const,
        ...(request.tolerance.maxPositionErrorStuds === undefined ? {} : { positionErrorStuds: matched.positionErrorStuds }),
        ...(request.tolerance.maxRotationErrorDegrees === undefined ? {} : { rotationErrorDegrees: matched.rotationErrorDegrees }) };
    });
    const missingEvidenceReason = !evidence ? 'evidence_not_supplied' as const
      : missingTimes.length > 0 ? (evidence.samples.some(sample => sample.caseId === request.caseId && sample.joint === request.joint
        && expectedTimes.includes(sample.at)) ? 'expected_track_snapshot_not_matched' as const : 'evidence_sample_missing' as const) : null;
    const status = missingEvidenceReason ? 'not_run' as const
      : sampleChecks.some(sample => sample.status === 'failed') ? 'failed' as const : 'passed' as const;
    return { caseId: request.caseId, joint: request.joint, status,
      expectedSampleCount: expectedTimes.length, actualSampleCount: actualSamples.length, missingTimes,
      sampleChecks,
      ...(request.tolerance.maxPositionErrorStuds === undefined ? {} : { maxPositionErrorStuds: request.tolerance.maxPositionErrorStuds }),
      ...(observedMaxPositionErrorStuds === undefined ? {} : { observedMaxPositionErrorStuds }),
      ...(request.tolerance.maxRotationErrorDegrees === undefined ? {} : { maxRotationErrorDegrees: request.tolerance.maxRotationErrorDegrees }),
      ...(observedMaxRotationErrorDegrees === undefined ? {} : { observedMaxRotationErrorDegrees }),
      ...(missingEvidenceReason === null ? {} : { notRunReason: missingEvidenceReason }),
      ...(worstPosition ? { worstPositionSample: { at: worstPosition.at, activeTracks: worstPosition.activeTracks ?? [],
        errorStuds: worstPosition.positionErrorStuds, simulatedTimelineContext: worstPosition.simulatedTimelineContext ?? null } } : {}),
      ...(worstRotation ? { worstRotationSample: { at: worstRotation.at, activeTracks: worstRotation.activeTracks ?? [],
        errorDegrees: worstRotation.rotationErrorDegrees, simulatedTimelineContext: worstRotation.simulatedTimelineContext ?? null } } : {}),
    };
  });
  const status = checks.some(check => check.status === 'failed') ? 'failed' as const
    : checks.every(check => check.status === 'passed') ? 'passed' as const : 'not_run' as const;
  return { status, checks, limitation: 'Opt-in gate compares native Studio Animator local-joint transforms against the deterministic recipe estimate at declared exact pose samples. Studio assigns track weights immediately, so this does not validate Roblox Play/Stop fade trajectories or runtime crossfade timing; fade envelopes remain simulator estimates. It does not certify gameplay scheduling, rendering, replication, physics, or artistic intent.' };
}

function compareStudioSamples(before: z.infer<typeof studioEvidenceSchema>['samples'], after: z.infer<typeof studioEvidenceSchema>['samples']) {
  const leftSamples = new Map(before.map(sample => [sample.stateId, sample]));
  const rightSamples = new Map(after.map(sample => [sample.stateId, sample]));
  return [...new Set([...leftSamples.keys(), ...rightSamples.keys()])].sort().map(stateId => {
    const left = leftSamples.get(stateId), right = rightSamples.get(stateId);
    if (!left || !right) return { stateId, status: left ? 'removed' as const : 'added' as const, changedMetrics: [], addedMetricIds: [], removedMetricIds: [], changedFindingIds: [] };
    const leftMetrics = new Map(left.inspection.metrics.flatMap(value => {
      const parsed = studioMetricSchema.safeParse(value);
      return parsed.success ? [[parsed.data.semanticKey ?? parsed.data.id, parsed.data] as const] : [];
    }));
    const rightMetrics = new Map(right.inspection.metrics.flatMap(value => {
      const parsed = studioMetricSchema.safeParse(value);
      return parsed.success ? [[parsed.data.semanticKey ?? parsed.data.id, parsed.data] as const] : [];
    }));
    const changedMetrics = [...new Set([...leftMetrics.keys(), ...rightMetrics.keys()])].sort().flatMap(id => {
      const first = leftMetrics.get(id), second = rightMetrics.get(id);
      if (!first || !second || first.unit !== second.unit || first.value === second.value) return [];
      return [{ id, unit: second.unit, before: first.value, after: second.value, delta: second.value - first.value }];
    });
    const leftFindings = new Map(left.inspection.findings.flatMap(value => { const parsed = studioFindingSchema.safeParse(value); return parsed.success ? [[parsed.data.id, parsed.data] as const] : []; }));
    const rightFindings = new Map(right.inspection.findings.flatMap(value => { const parsed = studioFindingSchema.safeParse(value); return parsed.success ? [[parsed.data.id, parsed.data] as const] : []; }));
    const changedFindingIds = [...new Set([...leftFindings.keys(), ...rightFindings.keys()])].sort().filter(id => canonical(leftFindings.get(id) ?? null) !== canonical(rightFindings.get(id) ?? null));
    const addedMetricIds = [...rightMetrics.keys()].filter(id => !leftMetrics.has(id)).sort();
    const removedMetricIds = [...leftMetrics.keys()].filter(id => !rightMetrics.has(id)).sort();
    const status = changedMetrics.length || addedMetricIds.length || removedMetricIds.length || changedFindingIds.length ? 'changed' as const : 'stable' as const;
    return { stateId, status, changedMetrics, addedMetricIds, removedMetricIds, changedFindingIds };
  });
}

export const animationGraphTimelineCaseReportSchema = z.object({ id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), status: z.enum(['passed', 'failed']),
  poseModel: z.object({ algorithmVersion: z.number().int().positive().max(1000), kind: z.literal('priority_weighted_local_pose_estimate'),
    residualBasis: z.literal('identity_local_animation_delta').optional(),
    sampleCount: z.number().int().nonnegative(), jointSampleCount: z.number().int().nonnegative(),
    contributionCount: z.number().int().nonnegative(), compositionSourceCount: z.number().int().nonnegative(),
    unanimatedTrackJointCount: z.number().int().nonnegative().optional(), limitation: z.string() }).strict().optional(),
  eventOrderingDiagnostics: animationGraphEventOrderingDiagnosticsSchema.optional(),
  animationEndedTiming: animationGraphEndedTimingSchema.optional(),
  playbackRetriggerModel: animationGraphPlaybackRetriggerModelSchema.optional(),
  eventOrderingCheck: z.object({ status: z.enum(['passed', 'failed']), maximumAllowedCollisions: z.number().int().min(0).max(20000),
    observedCollisions: z.number().int().nonnegative().max(20000) }).strict().optional(),
  eventOrderSensitivity: animationGraphEventOrderSensitivitySchema.nullable().optional(),
  eventOrderSensitivityCheck: z.object({ status: z.enum(['passed', 'failed']), maximumAllowedDivergences: z.number().int().min(0).max(7),
    observedDivergences: z.number().int().min(0).max(7), sampleComparisonComplete: z.boolean().optional() }).strict().optional(),
  playbackClockChecks: z.array(z.object({ transitionId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), occurrence: z.number().int().min(1).max(128),
    status: z.enum(['passed', 'failed']), expected: z.enum(['new_or_stopped_track', 'studio_observed_preserved', 'studio_observed_reset',
      'ambiguous_probe_assumed_reset', 'unmeasured_assumed_reset']),
    observed: z.enum(['new_or_stopped_track', 'studio_observed_preserved', 'studio_observed_reset', 'ambiguous_probe_assumed_reset', 'unmeasured_assumed_reset']).nullable(),
    failureReason: z.enum(['transition_occurrence_not_observed', 'playback_clock_decision_mismatch']).nullable().optional(),
    observedTransitionOccurrences: z.number().int().nonnegative().max(20000).optional() }).strict()).max(128).optional(),
  phaseDonorChecks: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), at: z.number().finite().min(0).max(120).nullable(),
    status: z.enum(['passed', 'failed']), expected: z.unknown(),
    observed: z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/).nullable(), restartedStateIds: z.array(z.string()).nullable(),
      normalizedPhase: z.number().finite().nullable(), currentWeight: z.number().finite().nullable(), targetWeight: z.number().finite().nullable() }).strict().nullable(),
    checks: z.array(z.object({ property: z.enum(['stateId', 'restartedStateIds', 'normalizedPhase', 'currentWeight', 'targetWeight']),
      expected: z.unknown(), observed: z.unknown(), passed: z.boolean() }).strict()).min(1).max(5),
  }).strict()).max(128).optional(),
  incompleteParameterRampChecks: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), status: z.enum(['passed', 'failed']),
    expected: z.unknown(), observed: z.unknown().nullable(), checks: z.array(z.object({ property: z.string(), expected: z.unknown(),
      observed: z.unknown(), passed: z.boolean() }).passthrough()).min(1).max(128),
    failureReason: z.enum(['incomplete_ramp_not_observed', 'incomplete_ramp_expectation_mismatch']).nullable() }).strict()).max(32).optional(),
  parameterRampLifecycleChecks: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), status: z.enum(['passed', 'failed']),
    expected: z.unknown(), observed: z.unknown().nullable(),
    checks: z.array(z.object({ property: z.string(), expected: z.unknown(), observed: z.unknown(), passed: z.boolean() }).passthrough()).min(1).max(128),
    failureReason: z.enum(['parameter_ramp_not_observed', 'parameter_ramp_lifecycle_mismatch']).nullable() }).strict()).max(32).optional(),
  trackLifecycleChecks: z.array(z.object({ stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), status: z.enum(['passed', 'failed']),
    expected: z.unknown(), observed: z.unknown().nullable(),
    checks: z.array(z.object({ property: z.enum(['status', 'playbackCount', 'latestEndReason']), expected: z.unknown(), observed: z.unknown(), passed: z.boolean() }).strict()).min(1).max(3),
  }).strict()).max(128).optional(),
  parameterRampLifecycle: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), startedAt: z.number().finite().min(0).max(120),
    duration: z.number().finite().min(0.01).max(120), easing: z.enum(['linear', 'smoothstep']),
    status: z.enum(['active', 'completed', 'interrupted', 'partially_interrupted', 'mixed']),
    channels: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), startValue: z.number().finite(), targetValue: z.number().finite(),
      status: z.enum(['active', 'completed', 'interrupted']), endedAt: z.number().finite().min(0).max(240).nullable(),
      observedValue: z.number().finite().nullable() }).strict()).min(1).max(64),
  }).strict()).max(512).optional(),
}).passthrough().superRefine((testCase, context) => {
  if (testCase.playbackClockChecks?.some(check => check.status !== (check.observed === check.expected ? 'passed' : 'failed'))
    || testCase.playbackClockChecks?.some(check => check.failureReason !== undefined && check.failureReason !== null
      && check.failureReason !== (check.observedTransitionOccurrences !== undefined && check.observedTransitionOccurrences >= check.occurrence
        ? 'playback_clock_decision_mismatch' : 'transition_occurrence_not_observed'))
    || (testCase.playbackClockChecks?.some(check => check.status === 'failed') && testCase.status !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['playbackClockChecks'], message: 'Playback-clock check statuses must agree with expected and observed transition decisions and cannot fail in a passing case.' });
  }
  if (testCase.incompleteParameterRampChecks?.some(ramp => {
    const observed = ramp.observed !== null;
    const passed = observed && ramp.checks.every(check => check.passed);
    const expectedFailureReason = !observed ? 'incomplete_ramp_not_observed'
      : passed ? null : 'incomplete_ramp_expectation_mismatch';
    return ramp.status !== (passed ? 'passed' : 'failed') || ramp.failureReason !== expectedFailureReason;
  }) || (testCase.incompleteParameterRampChecks?.some(ramp => ramp.status === 'failed') && testCase.status !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['incompleteParameterRampChecks'],
      message: 'Ramp-gate status and failure reason must agree with its observed horizon ramp and checks, and cannot fail in a passing case.' });
  }
  if (testCase.parameterRampLifecycleChecks?.some(ramp => {
    const observed = ramp.observed !== null;
    const passed = observed && ramp.checks.every(check => check.passed);
    const expectedFailureReason = !observed ? 'parameter_ramp_not_observed' : passed ? null : 'parameter_ramp_lifecycle_mismatch';
    return ramp.status !== (passed ? 'passed' : 'failed') || ramp.failureReason !== expectedFailureReason;
  }) || (testCase.parameterRampLifecycleChecks?.some(ramp => ramp.status === 'failed') && testCase.status !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['parameterRampLifecycleChecks'],
      message: 'Ramp lifecycle gate status and failure reason must agree with its observed outcome and checks, and cannot fail in a passing case.' });
  }
  if (testCase.trackLifecycleChecks?.some(track => track.status !== (track.observed !== null && track.checks.every(check => check.passed) ? 'passed' : 'failed'))
    || testCase.trackLifecycleChecks?.some(track => track.observed === null && track.checks.some(check => check.observed !== null))
    || (testCase.trackLifecycleChecks?.some(track => track.status === 'failed') && testCase.status !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['trackLifecycleChecks'], message: 'Track lifecycle check status must agree with its observed summary and assertions, and cannot fail in a passing case.' });
  }
  if (testCase.phaseDonorChecks?.some(donor => donor.status !== (donor.observed !== null && donor.checks.every(check => check.passed) ? 'passed' : 'failed'))
    || testCase.phaseDonorChecks?.some(donor => donor.observed === null && donor.checks.some(check => check.observed !== null))
    || (testCase.phaseDonorChecks?.some(donor => donor.status === 'failed') && testCase.status !== 'failed')) {
    context.addIssue({ code: 'custom', path: ['phaseDonorChecks'], message: 'Phase-donor check status must agree with its observed donor and assertions, and cannot fail in a passing case.' });
  }
  if (testCase.parameterRampLifecycle?.some(ramp => {
    if (new Set(ramp.channels.map(channel => channel.name)).size !== ramp.channels.length) return true;
    const statuses = new Set(ramp.channels.map(channel => channel.status));
    const expectedStatus = statuses.size === 1 ? ramp.channels[0]!.status
      : statuses.has('interrupted') ? 'partially_interrupted' : 'mixed';
    return ramp.status !== expectedStatus || ramp.channels.some(channel => channel.status === 'active'
      ? channel.endedAt !== null || channel.observedValue === null
      : channel.endedAt === null || channel.observedValue === null || channel.endedAt < ramp.startedAt
        || channel.status === 'completed' && Math.abs(channel.endedAt - ramp.startedAt - ramp.duration) > 1e-9);
  })) context.addIssue({ code: 'custom', path: ['parameterRampLifecycle'],
    message: 'Ramp lifecycle summaries must agree with unique per-channel outcomes and valid completion/interruption timestamps and values.' });
  if ((testCase.eventOrderingDiagnostics === undefined) !== (testCase.animationEndedTiming === undefined)) {
    context.addIssue({ code: 'custom', path: ['animationEndedTiming'], message: 'New simulator case records must include event-order and completion-timing diagnostics together.' });
  }
  if (testCase.eventOrderingCheck) {
    if (!testCase.eventOrderingDiagnostics) context.addIssue({ code: 'custom', path: ['eventOrderingCheck'], message: 'An event-order gate requires its simulator diagnostics.' });
    else {
      const passed = testCase.eventOrderingCheck.observedCollisions <= testCase.eventOrderingCheck.maximumAllowedCollisions;
      if (testCase.eventOrderingCheck.observedCollisions !== testCase.eventOrderingDiagnostics.ambiguousCollisionCount
        || testCase.eventOrderingCheck.status !== (passed ? 'passed' : 'failed')) {
        context.addIssue({ code: 'custom', path: ['eventOrderingCheck'], message: 'Event-order gate status and observation must agree with the case diagnostics and maximum.' });
      }
      if (!passed && testCase.status !== 'failed') context.addIssue({ code: 'custom', path: ['status'], message: 'A case that fails its event-order gate cannot have passed status.' });
    }
  }
  if (testCase.eventOrderSensitivityCheck) {
    const sensitivity = testCase.eventOrderSensitivity;
    if (!sensitivity || !sensitivity.gate) context.addIssue({ code: 'custom', path: ['eventOrderSensitivityCheck'], message: 'A sensitivity regression gate requires executed dual-policy evidence.' });
    else {
      const passed = testCase.eventOrderSensitivityCheck.observedDivergences <= testCase.eventOrderSensitivityCheck.maximumAllowedDivergences
        && testCase.eventOrderSensitivityCheck.sampleComparisonComplete !== false;
      if (testCase.eventOrderSensitivityCheck.observedDivergences !== sensitivity.divergenceCount
        || testCase.eventOrderSensitivityCheck.maximumAllowedDivergences !== sensitivity.gate.maximumAllowedDivergences
        || (testCase.eventOrderSensitivityCheck.sampleComparisonComplete !== undefined
          && testCase.eventOrderSensitivityCheck.sampleComparisonComplete !== sensitivity.sampleComparisonComplete)
        || testCase.eventOrderSensitivityCheck.status !== (passed ? 'passed' : 'failed')
        || sensitivity.gate.observedDivergences !== testCase.eventOrderSensitivityCheck.observedDivergences
        || sensitivity.gate.status !== testCase.eventOrderSensitivityCheck.status) {
        context.addIssue({ code: 'custom', path: ['eventOrderSensitivityCheck'], message: 'Sensitivity gate status and counts must agree with the dual-policy report.' });
      }
      if (!passed && testCase.status !== 'failed') context.addIssue({ code: 'custom', path: ['status'], message: 'A case that fails its callback-order sensitivity gate cannot have passed status.' });
    }
  }
});
const runReportSchema = z.object({ schemaVersion: z.literal(1), graphFingerprint: hash, suiteFingerprint: hash,
  status: z.enum(['passed', 'failed']), summary: z.object({ cases: z.number().int().positive(), passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), scheduledEvents: z.number().int().nonnegative(), processedEvents: z.number().int().nonnegative() }).strict(),
  blendModel: z.object({ kind: z.enum(['linear_per_track_weight_estimate', 'studio_calibrated_curve_per_track_estimate']),
    calibrationProfileIds: z.array(identifier).max(64), playbackTimingFingerprint: hash.optional() }).strict().optional(),
  playbackRetriggerModel: animationGraphPlaybackRetriggerModelSchema.optional(),
  fadeCalibrationEvidence: z.array(z.object({ id: identifier, profileFingerprint: hash, stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
    fadeSeconds: z.number().finite().min(0.05).max(3), rigId: identifier, rigSignature: z.string().min(1).max(30000),
    qualityStatus: z.enum(['clean', 'review']).optional(), qualityWarnings: z.array(z.string().max(100)).max(64).optional(),
    studioBuildIdentity: studioBuildIdentitySchema.optional(), playRetrigger: studioPlayRetriggerProbeSchema.optional(),
    naturalCompletion: z.object({ authoredDurationSeconds: z.number().finite().min(0.01).max(30),
      animationLengthSeconds: z.number().finite().min(0).max(30), playbackSpeed: z.number().finite().min(0.1).max(4),
      endedAfterStoppedSeconds: z.number().finite().min(0).max(3),
      samples: z.array(z.object({ at: z.number().finite().min(0).max(3), weightCurrent: z.number().finite().min(0).max(1),
        weightTarget: z.number().finite().min(0).max(1) }).strict()).min(1).max(362),
    }).strict().optional(),
    buildCompatibility: z.enum(['match', 'unknown']).optional() }).strict()).max(64).optional(),
  cases: z.array(animationGraphTimelineCaseReportSchema).min(1).max(32), limitation: z.string(), reportFingerprint: hash }).strict().superRefine((report, context) => {
  const passedCases = report.cases.filter(testCase => testCase.status === 'passed').length;
  const failedCases = report.cases.length - passedCases;
  if (report.summary.cases !== report.cases.length || report.summary.passed !== passedCases || report.summary.failed !== failedCases
    || report.status !== (failedCases === 0 ? 'passed' : 'failed')) {
    context.addIssue({ code: 'custom', path: ['summary'], message: 'Timeline report status and summary counts must agree with its case results.' });
  }
  const evidenceIds = report.fadeCalibrationEvidence?.map(profile => profile.id) ?? [];
  if (new Set(evidenceIds).size !== evidenceIds.length) context.addIssue({ code: 'custom', path: ['fadeCalibrationEvidence'], message: 'Fade calibration provenance IDs must be unique.' });
  if ((report.blendModel?.calibrationProfileIds.length ?? 0) > 0 && !report.fadeCalibrationEvidence) {
    context.addIssue({ code: 'custom', path: ['fadeCalibrationEvidence'], message: 'A calibrated blend report requires fingerprinted calibration provenance.' });
  }
  if (report.blendModel?.calibrationProfileIds.some(id => !evidenceIds.includes(id))) {
    context.addIssue({ code: 'custom', path: ['blendModel', 'calibrationProfileIds'], message: 'Every applied calibration ID must appear in the report provenance.' });
  }
  const { reportFingerprint, ...content } = report;
  if (digest(content) !== reportFingerprint) context.addIssue({ code: 'custom', path: ['reportFingerprint'], message: 'Timeline report fingerprint does not match content.' });
});
const runSchema = z.object({ id: identifier, planId: identifier, planFingerprint: hash, planRevision: z.number().int().positive(),
  graphId: identifier, graphFingerprint: hash, suiteFingerprint: hash, recordedAt: z.string().datetime(), report: runReportSchema,
  studioEvidence: studioEvidenceSchema.optional(), studioBlendEvidence: studioBlendEvidenceSchema.optional(),
  studioCalibrationGate: studioCalibrationGateSchema.optional(), releaseStatus: z.enum(['passed', 'failed']).optional(), runFingerprint: hash }).strict().superRefine((run, context) => {
  if (run.report.graphFingerprint !== run.graphFingerprint || run.report.suiteFingerprint !== run.suiteFingerprint) context.addIssue({ code: 'custom', path: ['report'], message: 'Timeline report does not match pinned graph/suite.' });
  if (run.studioEvidence && run.studioEvidence.graphFingerprint !== run.graphFingerprint) context.addIssue({ code: 'custom', path: ['studioEvidence'], message: 'Studio evidence does not match the run graph fingerprint.' });
  if (run.studioBlendEvidence && run.studioBlendEvidence.graphFingerprint !== run.graphFingerprint) context.addIssue({ code: 'custom', path: ['studioBlendEvidence'], message: 'Studio blend evidence does not match the run graph fingerprint.' });
  if ((run.studioCalibrationGate === undefined) !== (run.releaseStatus === undefined)) context.addIssue({ code: 'custom', path: ['releaseStatus'], message: 'Release status and Studio calibration gate must be stored together.' });
  if (run.studioCalibrationGate && run.releaseStatus !== (run.report.status === 'passed' && run.studioCalibrationGate.status !== 'failed'
    && run.studioCalibrationGate.status !== 'not_run' ? 'passed' : 'failed')) {
    context.addIssue({ code: 'custom', path: ['releaseStatus'], message: 'Release status does not agree with the simulation report and opt-in Studio calibration gate.' });
  }
  const { runFingerprint, ...content } = run;
  if (digest(content) !== runFingerprint) context.addIssue({ code: 'custom', path: ['runFingerprint'], message: 'Timeline run fingerprint does not match content.' });
});
const storedRunSchema = z.object({ run: runSchema, integrity: hash }).strict();
export type AnimationGraphTimelineRun = z.infer<typeof runSchema>;
type TimelineRun = AnimationGraphTimelineRun;

export type AnimationGraphTimelineNextAction = {
  status: 'failed' | 'native_evidence_mismatch' | 'native_evidence_unavailable' | 'native_evidence_unrequested'
    | 'passed' | 'historical_gate_metadata_missing';
  action: 'inspect_failed_assertions' | 'reconcile_expected_vs_observed_tracks' | 'repeat_same_plan_with_live_studio'
    | 'inspect_native_samples_without_gate' | 'optionally_collect_native_samples' | 'inspect_passed_evidence'
    | 'inspect_plan_and_report_before_concluding';
  samePlanRetryRecommended: boolean;
  userProvidedThresholdRequired: boolean;
  planId: string;
  planFingerprint: string;
  failedCaseIds: string[];
  failedCalibrationChecks: Array<{ caseId: string; joint: string; failedTimes: number[] }>;
  trackSnapshotMismatches: Array<{ caseId: string; joint: string; times: number[] }>;
  notRunReasons: string[];
  evidencePaths: string[];
  reason: string;
};

export function animationGraphTimelineNextAction(run: Pick<AnimationGraphTimelineRun,
  'planId' | 'planFingerprint' | 'report' | 'studioCalibrationGate' | 'studioBlendEvidence'>): AnimationGraphTimelineNextAction {
  const gate = run.studioCalibrationGate;
  const failedCaseIds = run.report.cases.filter(testCase => testCase.status === 'failed').map(testCase => testCase.id);
  const failedCalibrationChecks = (gate?.checks ?? []).filter(check => check.status === 'failed').map(check => ({
    caseId: check.caseId, joint: check.joint,
    failedTimes: check.sampleChecks.filter(sample => sample.status === 'failed').map(sample => sample.at),
  }));
  const trackSnapshotMismatches = (gate?.checks ?? []).flatMap(check => {
    const times = check.sampleChecks.filter(sample => sample.notRunReason === 'expected_track_snapshot_not_matched').map(sample => sample.at);
    return check.notRunReason === 'expected_track_snapshot_not_matched' && times.length === 0
      ? [{ caseId: check.caseId, joint: check.joint, times: check.missingTimes }]
      : times.length > 0 ? [{ caseId: check.caseId, joint: check.joint, times }] : [];
  });
  const notRunReasons = [...new Set((gate?.checks ?? []).flatMap(check => [
    ...(check.notRunReason ? [check.notRunReason] : []),
    ...check.sampleChecks.flatMap(sample => sample.notRunReason ? [sample.notRunReason] : []),
  ]))].sort();
  const common = { planId: run.planId, planFingerprint: run.planFingerprint, failedCaseIds,
    failedCalibrationChecks, trackSnapshotMismatches, notRunReasons };
  if (run.report.status === 'failed' || gate?.status === 'failed') return {
    ...common, status: 'failed', action: 'inspect_failed_assertions', samePlanRetryRecommended: false,
    userProvidedThresholdRequired: false,
    evidencePaths: [...(failedCaseIds.length ? ['report.cases[].failures'] : []),
      ...(failedCalibrationChecks.length ? ['studioCalibrationGate.checks[].sampleChecks'] : [])],
    reason: 'At least one requested timeline or native-pose assertion failed. Diagnose its exact case, joint, sample time, and observed error without changing the immutable plan or user-provided tolerances.',
  };
  if (!gate) return {
    ...common, status: 'historical_gate_metadata_missing', action: 'inspect_plan_and_report_before_concluding',
    samePlanRetryRecommended: false, userProvidedThresholdRequired: false, evidencePaths: ['report', 'planFingerprint'],
    reason: 'This historical run predates or lacks persisted Studio calibration-gate metadata. Do not infer whether a native-pose gate was requested or run; inspect the plan and report first.',
  };
  if (gate.status === 'not_run' && trackSnapshotMismatches.length > 0) return {
    ...common, status: 'native_evidence_mismatch', action: 'reconcile_expected_vs_observed_tracks',
    samePlanRetryRecommended: false, userProvidedThresholdRequired: false,
    evidencePaths: ['studioCalibrationGate.checks[].sampleChecks', 'studioBlendEvidence.samples[].requestedTracks', 'studioBlendEvidence.samples[].activeTracks'],
    reason: 'Native samples exist but their active track state/weight/playback snapshot does not match the simulation expectation. Reconcile the exact samples before retrying; blindly rerunning the same plan may reproduce the mismatch.',
  };
  if (gate.status === 'not_run') return {
    ...common, status: 'native_evidence_unavailable', action: 'repeat_same_plan_with_live_studio',
    samePlanRetryRecommended: true, userProvidedThresholdRequired: false,
    evidencePaths: ['studioCalibrationGate.checks[].notRunReason', 'studioCalibrationGate.checks[].missingTimes'],
    reason: 'The requested native-pose gate lacks matching Studio evidence. Re-run this exact immutable plan only after connecting Studio and selecting the intended rig; do not treat simulator-only results as native evidence.',
  };
  if (gate.status === 'not_requested') return run.studioBlendEvidence ? {
    ...common, status: 'native_evidence_unrequested', action: 'inspect_native_samples_without_gate',
    samePlanRetryRecommended: false, userProvidedThresholdRequired: true,
    evidencePaths: ['studioBlendEvidence.samples', 'studioBlendEvidence.limitation'],
    reason: 'Native fixed-weight samples are available, but the plan requested no native-pose tolerance gate. Inspect them as measurements only; add a reviewed child plan with a user-provided threshold only if a release gate is needed.',
  } : {
    ...common, status: 'native_evidence_unrequested', action: 'optionally_collect_native_samples',
    samePlanRetryRecommended: false, userProvidedThresholdRequired: false,
    evidencePaths: ['report', 'studioCalibrationGate.limitation'],
    reason: 'The plan passed without requesting native Animator samples or a native-pose tolerance gate. Collecting native samples is optional; simulator-only results do not establish native blend fidelity.',
  };
  return {
    ...common, status: 'passed', action: 'inspect_passed_evidence', samePlanRetryRecommended: false,
    userProvidedThresholdRequired: false, evidencePaths: ['report', 'studioCalibrationGate.checks', 'studioBlendEvidence.samples'],
    reason: 'The timeline checks and requested native fixed-weight pose gate passed for their sampled cases/times. This does not validate unsampled fades, rendered appearance, deformation, replication, or gameplay, and does not authorize publishing.',
  };
}
const temporalCheckSchema = z.object({ property: z.string(), expected: z.unknown(), observed: z.unknown(), passed: z.boolean() }).passthrough();
const temporalCheckGroupSchema = z.object({ at: z.number().finite(), stateId: z.string().optional(), joint: z.string().optional(),
  status: z.enum(['passed', 'failed']), checks: z.array(temporalCheckSchema), throughoutChecks: z.array(temporalCheckSchema).optional() }).passthrough();
const eventOrderingGateResultSchema = z.object({ status: z.enum(['passed', 'failed']), maximumAllowedCollisions: z.number().int().min(0).max(20000),
  observedCollisions: z.number().int().nonnegative().max(20000) }).strict();
const temporalCaseComparisonSchema = z.object({ id: z.string(), status: z.enum(['passed', 'failed']),
  failures: z.array(z.object({ expectation: z.string() }).passthrough()),
  blendChecks: z.array(temporalCheckGroupSchema).optional(), poseChecks: z.array(temporalCheckGroupSchema).optional(),
  playbackClockChecks: z.array(z.object({ transitionId: z.string(), occurrence: z.number().int(), status: z.enum(['passed', 'failed']),
    expected: z.string(), observed: z.string().nullable(), failureReason: z.string().nullable().optional(),
    observedTransitionOccurrences: z.number().int().nonnegative().optional() }).passthrough()).optional(),
  phaseDonorChecks: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), at: z.number().finite().min(0).max(120).nullable(),
    status: z.enum(['passed', 'failed']), expected: z.unknown(), observed: z.unknown().nullable(),
    checks: z.array(temporalCheckSchema).min(1).max(5) }).strict()).max(128).optional(),
  incompleteParameterRampChecks: z.array(z.object({ inputIndex: z.number().int().nonnegative(), status: z.enum(['passed', 'failed']),
    expected: z.unknown(), observed: z.unknown().nullable(), checks: z.array(temporalCheckSchema),
    failureReason: z.string().nullable() }).strict()).optional(),
  parameterRampLifecycleChecks: z.array(z.object({ inputIndex: z.number().int().min(0).max(511), status: z.enum(['passed', 'failed']),
    expected: z.unknown(), observed: z.unknown().nullable(), checks: z.array(temporalCheckSchema).min(1).max(128),
    failureReason: z.enum(['parameter_ramp_not_observed', 'parameter_ramp_lifecycle_mismatch']).nullable() }).strict()).max(32).optional(),
  trackLifecycleChecks: z.array(z.object({ stateId: z.string(), status: z.enum(['passed', 'failed']), expected: z.unknown(),
    observed: z.unknown().nullable(), checks: z.array(temporalCheckSchema).min(1).max(3) }).strict()).max(128).optional(),
  eventOrderingDiagnostics: animationGraphEventOrderingDiagnosticsSchema.optional(), animationEndedTiming: animationGraphEndedTimingSchema.optional(),
  eventOrderingCheck: eventOrderingGateResultSchema.optional(),
  eventOrderSensitivity: animationGraphEventOrderSensitivitySchema.nullable().optional(),
  eventOrderSensitivityCheck: z.object({ status: z.enum(['passed', 'failed']), maximumAllowedDivergences: z.number().int().min(0).max(7),
    observedDivergences: z.number().int().min(0).max(7), sampleComparisonComplete: z.boolean().optional() }).strict().optional() }).passthrough();

function comparableChecks(testCase: z.infer<typeof temporalCaseComparisonSchema>) {
  const checks = new Map<string, { kind: 'blend' | 'pose' | 'playback_clock' | 'phase_donor' | 'parameter_ramp' | 'track_lifecycle'; status: 'passed' | 'failed'; expected: unknown; observed: unknown; passed: boolean }>();
  for (const [kind, groups] of [['blend', testCase.blendChecks ?? []], ['pose', testCase.poseChecks ?? []]] as const) {
    for (const group of groups) for (const check of [...group.checks, ...(group.throughoutChecks ?? [])]) {
      const subject = kind === 'blend' ? group.stateId : group.joint;
      if (!subject) continue;
      checks.set(`${kind}:${subject}@${group.at}:${check.property}`, { kind, status: group.status,
        expected: check.expected, observed: check.observed, passed: check.passed });
    }
  }
  for (const check of testCase.playbackClockChecks ?? []) checks.set(`playbackClock:${check.transitionId}#${check.occurrence}`, {
    kind: 'playback_clock', status: check.status, expected: check.expected,
    observed: { decision: check.observed, failureReason: check.failureReason ?? null,
      observedTransitionOccurrences: check.observedTransitionOccurrences ?? null },
    passed: check.status === 'passed',
  });
  for (const donor of testCase.phaseDonorChecks ?? []) for (const check of donor.checks) {
    checks.set(`phaseDonor:${donor.inputIndex}@${donor.at ?? 'event'}:${check.property}`, { kind: 'phase_donor', status: donor.status,
      expected: check.expected, observed: check.observed, passed: check.passed });
  }
  for (const ramp of testCase.incompleteParameterRampChecks ?? []) for (const check of ramp.checks) {
    checks.set(`incompleteParameterRamp:${ramp.inputIndex}:${check.property}`, { kind: 'parameter_ramp', status: ramp.status,
      expected: check.expected, observed: check.observed, passed: check.passed });
  }
  for (const ramp of testCase.parameterRampLifecycleChecks ?? []) for (const check of ramp.checks) {
    checks.set(`parameterRampLifecycle:${ramp.inputIndex}:${check.property}`, { kind: 'parameter_ramp', status: ramp.status,
      expected: check.expected, observed: check.observed, passed: check.passed });
  }
  for (const track of testCase.trackLifecycleChecks ?? []) for (const check of track.checks) {
    checks.set(`trackLifecycle:${track.stateId}:${check.property}`, { kind: 'track_lifecycle', status: track.status,
      expected: check.expected, observed: check.observed, passed: check.passed });
  }
  return checks;
}

function numericObservedDeltas(before: unknown, after: unknown): Record<string, number> | undefined {
  if (typeof before !== 'object' || before === null || Array.isArray(before)
    || typeof after !== 'object' || after === null || Array.isArray(after)) return undefined;
  const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
  const deltas: Record<string, number> = {};
  for (const key of Object.keys(left).sort()) {
    const first = left[key], second = right[key];
    if (typeof first === 'number' && Number.isFinite(first) && typeof second === 'number' && Number.isFinite(second)) {
      deltas[key] = second - first;
    }
  }
  return Object.keys(deltas).length ? deltas : undefined;
}

export class AnimationGraphTimelineHistory {
  constructor(private readonly directory: string, private readonly graphs: AnimationGraphLibrary) {}

  private async loadPlan(id: string) {
    const parsedId = identifier.parse(id);
    return planSchema.parse(JSON.parse(await readFile(join(this.directory, 'plans', `${parsedId}.json`), 'utf8')));
  }

  async preview(nameInput: string, graphIdInput: string, casesInput: unknown, parentPlanId?: string) {
    const name = label.parse(nameInput), graphId = identifier.parse(graphIdInput);
    const saved = await this.graphs.get(graphId), suite = suiteSchema.parse({ cases: casesInput });
    validateAnimationGraphTimelinePhaseSyncReferences(saved.graph, suite, { allowInvalidSourcePoseReferences: true });
    const sourceRecipes = new Map<string, z.infer<typeof animationSchema>>();
    for (const state of saved.graph.states) {
      const asset = await this.graphs.animations.get(state.animationId);
      if (asset.recipe.kind !== 'animation') throw new Error(`Graph state ${state.id} must reference an animation recipe.`);
      sourceRecipes.set(state.id, asset.recipe);
    }
    type SourceReferenceBlocker = { caseId: string; joint: string; at: number; controllerStateId: string; sourceStateId: string;
      expectedChannel: boolean; reason: 'controller_not_blend_space' | 'source_not_in_controller' | 'source_joint_channel_missing' | 'source_joint_channel_present';
      recommendedAction: string };
    const sourceReferenceBlockers: SourceReferenceBlocker[] = suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => [
      ...(pose.missingBlendChannels ?? []).map(reference => ({ caseId: testCase.id, joint: pose.joint, at: pose.at,
        controllerStateId: reference.controllerStateId, sourceStateId: reference.sourceStateId, expectedChannel: false as const })),
      ...(pose.blendSourcePoses ?? []).map(reference => ({ caseId: testCase.id, joint: pose.joint, at: pose.at,
        controllerStateId: reference.controllerStateId, sourceStateId: reference.sourceStateId, expectedChannel: true as const })),
    ])).flatMap(reference => {
      const controller = saved.graph.states.find(state => state.id === reference.controllerStateId
        && (state.blendSpace1D !== undefined || state.blendSpace2D !== undefined));
      const sourceIsSample = controller !== undefined
        && (controller.blendSpace1D?.samples ?? controller.blendSpace2D?.samples ?? []).some(sample => sample.stateId === reference.sourceStateId);
      const hasJointChannel = recipeHasJointChannel(sourceRecipes.get(reference.sourceStateId), reference.joint);
      const invalidReference: SourceReferenceBlocker[] = !sourceIsSample ? [{ ...reference,
        reason: controller ? 'source_not_in_controller' as const : 'controller_not_blend_space' as const,
        recommendedAction: 'Select a BlendSpace controller and one of its actual source state IDs.' }]
        : reference.expectedChannel && !hasJointChannel ? [{ ...reference, reason: 'source_joint_channel_missing' as const,
          recommendedAction: 'Author this joint in the source animation, or use missingBlendChannels if its absence is intentional.' }]
          : !reference.expectedChannel && hasJointChannel ? [{ ...reference, reason: 'source_joint_channel_present' as const,
            recommendedAction: 'Remove this missing-channel expectation or assert the source pose with blendSourcePoses.' }]
            : [];
      return invalidReference;
    }).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.at - right.at
      || left.joint.localeCompare(right.joint) || left.controllerStateId.localeCompare(right.controllerStateId)
      || left.sourceStateId.localeCompare(right.sourceStateId));
    const parent = parentPlanId ? await this.loadPlan(parentPlanId) : undefined;
    const parentRef = parent ? { id: parent.id, revision: parent.revision } : undefined;
    const payload = planDraft({ name, parent: parentRef, graphId, graphFingerprint: saved.graphFingerprint,
      sourceFingerprints: saved.sourceFingerprints, cases: suite.cases });
    const draftFingerprint = digest(payload);
    return { fingerprintVersion: 2 as const, name, graphId, graphFingerprint: saved.graphFingerprint, sourceFingerprints: saved.sourceFingerprints,
      parent: parentRef ?? null, proposedRevision: (parent?.revision ?? 0) + 1, proposedPlanId: deterministicId(draftFingerprint),
      suiteFingerprint: payload.suiteFingerprint, draftFingerprint, cases: suite.cases,
      coveragePreview: { caseCount: suite.cases.length, externalEventCount: suite.cases.reduce((sum, testCase) => sum + testCase.events.length, 0),
        valid: sourceReferenceBlockers.length === 0,
        blockers: sourceReferenceBlockers,
        eventOrderingGate: { assertions: suite.cases.filter(testCase => testCase.expect.maxAmbiguousEventOrderingCollisions !== undefined).length,
          cases: suite.cases.flatMap(testCase => testCase.expect.maxAmbiguousEventOrderingCollisions === undefined ? []
            : [{ caseId: testCase.id, maximumAllowedCollisions: testCase.expect.maxAmbiguousEventOrderingCollisions }]) },
        eventOrderSensitivityGate: { assertions: suite.cases.filter(testCase => testCase.expect.maxEventOrderDivergences !== undefined).length,
          cases: suite.cases.flatMap(testCase => testCase.expect.maxEventOrderDivergences === undefined ? []
            : [{ caseId: testCase.id, maximumAllowedDivergences: testCase.expect.maxEventOrderDivergences }]) },
        expectedTransitions: [...new Set(suite.cases.flatMap(testCase => [...(testCase.expect.transitionIds?.ids ?? []), ...testCase.expect.transitionTimes.map(timing => timing.transitionId)]))].sort(),
        playbackClockAssertions: { assertions: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.playbackClock?.length ?? 0), 0),
          transitions: [...new Set(suite.cases.flatMap(testCase => (testCase.expect.playbackClock ?? []).map(assertion => assertion.transitionId)))].sort() },
        phaseDonorAssertions: { assertions: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.phaseDonors?.length ?? 0), 0),
          cases: suite.cases.flatMap(testCase => (testCase.expect.phaseDonors ?? []).map(assertion => ({ caseId: testCase.id,
            inputIndex: assertion.inputIndex, at: assertion.at ?? null, donorStateId: assertion.stateId,
            restartedStateIds: assertion.restartedStateIds ?? null }))) },
        expectedMarkers: [...new Set(suite.cases.flatMap(testCase => testCase.expect.markers.map(marker => marker.name)))].sort(),
        parameterRampCoverage: (() => {
          const ramps = suite.cases.flatMap(testCase => testCase.events.flatMap((event, inputIndex) => {
            if (event.kind !== 'ramp_parameters') return [];
            const parameterNames = Object.keys(event.values).sort();
            const authoredEndAt = event.at + event.duration;
            const simulatedEndAt = Math.min(authoredEndAt, testCase.duration);
            const startsWithinHorizon = event.at <= testCase.duration;
            const potentialInterruptions = testCase.events.flatMap((candidate, candidateIndex) => {
              const isLaterInAuthoredOrder = candidate.at > event.at || (candidate.at === event.at && candidateIndex > inputIndex);
              if (!startsWithinHorizon || !isLaterInAuthoredOrder || candidate.at > simulatedEndAt) return [];
              const updates = candidate.kind === 'set_parameters' ? candidate.values
                : candidate.kind === 'trigger' ? candidate.setParameters : undefined;
              const overlaps = candidate.kind === 'ramp_parameters' ? Object.keys(candidate.values).filter(name => parameterNames.includes(name))
                : updates ? Object.keys(updates).filter(name => parameterNames.includes(name)) : [];
              return overlaps.length > 0 ? [{ inputIndex: candidateIndex, at: candidate.at, kind: candidate.kind,
                parameterNames: [...new Set(overlaps)].sort(),
                ...(candidate.kind === 'trigger' ? { requiresSuccessfulTransition: true } : {}) }] : [];
            });
            return [{ caseId: testCase.id, inputIndex, at: event.at, duration: event.duration,
              authoredEndAt, simulatedEndAt, startsWithinHorizon,
              easing: event.easing, parameterNames, targetValues: event.values, potentialInterruptions }];
          }));
          const incompleteAssertions = suite.cases.flatMap(testCase => (testCase.expect.incompleteParameterRamps ?? []).map(assertion => ({
            caseId: testCase.id, inputIndex: assertion.inputIndex,
            assertedProperties: [...(assertion.simulatedProgress ? ['simulatedProgress'] : []),
              ...(assertion.easedProgress ? ['easedProgress'] : []),
              ...(assertion.remainingSecondsAtHorizon ? ['remainingSecondsAtHorizon'] : []),
              ...assertion.parameters.flatMap(parameter => [
                ...(parameter.currentValue ? [`parameter:${parameter.name}:currentValue`] : []),
                ...(parameter.targetValue ? [`parameter:${parameter.name}:targetValue`] : []),
              ])],
          })));
          const lifecycleAssertions = suite.cases.flatMap(testCase => (testCase.expect.parameterRampLifecycle ?? []).map(assertion => ({
            caseId: testCase.id, inputIndex: assertion.inputIndex, expectedStatus: assertion.status ?? null,
            channels: assertion.parameters.map(parameter => ({ name: parameter.name, status: parameter.status ?? null,
              checksObservedValue: parameter.observedValue !== undefined, checksTargetValue: parameter.targetValue !== undefined,
              checksEndedAt: parameter.endedAt !== undefined })),
          })));
          return { count: ramps.length,
            parameterNames: [...new Set(ramps.flatMap(ramp => ramp.parameterNames))].sort(),
            easingKinds: [...new Set(ramps.map(ramp => ramp.easing))].sort(), ramps,
            incompleteAssertions, incompleteAssertionCount: incompleteAssertions.length,
            lifecycleAssertions, lifecycleAssertionCount: lifecycleAssertions.length };
        })(),
        blendCoverage: (() => {
          const blendAssertions = suite.cases.flatMap(testCase => testCase.expect.blends.map(blend => ({ caseId: testCase.id, ...blend })));
          const blendSpaceAssertions = blendAssertions.filter(assertion => assertion.blendSpace !== undefined);
          const controllers = saved.graph.states.filter(state => state.blendSpace1D || state.blendSpace2D).map(controller => {
            const assertions = blendSpaceAssertions.filter(assertion => assertion.stateId === controller.id);
            const assertedClips = [...new Set(assertions.flatMap(assertion => assertion.blendSpace?.clips?.map(clip => clip.stateId) ?? []))].sort();
            const sourceStateIds = (controller.blendSpace1D?.samples ?? controller.blendSpace2D?.samples ?? []).map(sample => sample.stateId);
            return { stateId: controller.id, dimension: controller.blendSpace1D ? '1d' as const : '2d' as const,
              parameter: controller.blendSpace1D?.parameter ?? null,
              parameters: controller.blendSpace1D ? { x: controller.blendSpace1D.parameter, y: null }
                : { x: controller.blendSpace2D!.xParameter, y: controller.blendSpace2D!.yParameter },
              sampleTimes: [...new Set(assertions.map(assertion => assertion.at))].sort((left, right) => left - right),
              parameterAssertions: assertions.filter(assertion => assertion.blendSpace?.parameterValue !== undefined
                || assertion.blendSpace?.parameterValues !== undefined).length,
              phaseSyncAssertions: assertions.filter(assertion => assertion.blendSpace?.phaseSync !== undefined).length,
              phaseSyncSources: [...new Set(assertions.flatMap(assertion => assertion.blendSpace?.phaseSync?.stateIds ?? []))].sort(),
              phaseSyncThroughoutAssertions: assertions.filter(assertion => assertion.blendSpace?.phaseSyncThroughout !== undefined).length,
              phaseSyncThroughoutSources: [...new Set(assertions.flatMap(assertion => assertion.blendSpace?.phaseSyncThroughout?.stateIds ?? []))].sort(),
              phaseSyncThroughoutGates: assertions.flatMap(assertion => assertion.blendSpace?.phaseSyncThroughout
                ? [{ caseId: assertion.caseId, stateIds: assertion.blendSpace.phaseSyncThroughout.stateIds,
                  maxCircularPhaseDifference: assertion.blendSpace.phaseSyncThroughout.maxCircularPhaseDifference }] : []),
              clipWeightAssertions: assertions.reduce((sum, assertion) => sum + (assertion.blendSpace?.clips?.length ?? 0), 0),
              clipAssertionKinds: assertions.reduce((counts, assertion) => {
                for (const clip of assertion.blendSpace?.clips ?? []) {
                  if (clip.weight !== undefined) counts.normalizedWeight++;
                  if (clip.poseContributionWeight !== undefined) counts.currentPoseContribution++;
                  if (clip.targetPoseContributionWeight !== undefined) counts.targetPoseContribution++;
                  if (clip.playback?.timeSeconds !== undefined) counts.sourcePlaybackTime++;
                  if (clip.playback?.normalizedPhase !== undefined) counts.sourceNormalizedPhase++;
                  if (clip.playback?.playbackSpeed !== undefined) counts.sourcePlaybackSpeed++;
                  if (clip.playback?.isPlaying !== undefined) counts.sourcePlayingState++;
                }
                return counts;
              }, { normalizedWeight: 0, currentPoseContribution: 0, targetPoseContribution: 0,
                sourcePlaybackTime: 0, sourceNormalizedPhase: 0, sourcePlaybackSpeed: 0, sourcePlayingState: 0 }),
              assertedClips, uncoveredClips: sourceStateIds.filter(stateId => !assertedClips.includes(stateId)).sort() };
          });
          return { assertions: blendAssertions.length,
            sampleTimes: [...new Set(blendAssertions.map(assertion => assertion.at))].sort((left, right) => left - right),
            stateIds: [...new Set(blendAssertions.map(assertion => assertion.stateId))].sort(),
            blendSpace: { assertions: blendSpaceAssertions.length,
              sampleTimes: [...new Set(blendSpaceAssertions.map(assertion => assertion.at))].sort((left, right) => left - right),
              controllers, uncoveredControllerIds: controllers.filter(controller => controller.sampleTimes.length === 0).map(controller => controller.stateId).sort() } };
        })(),
        poseCoverage: { assertions: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.poses?.length ?? 0), 0),
          sampleTimes: [...new Set(suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => [pose.at,
            ...(pose.throughout ? Array.from({ length: Math.ceil((pose.throughout.end - pose.throughout.start) * pose.throughout.sampleRateHz) + 1 }, (_, index) =>
              Math.min(pose.throughout!.end, pose.throughout!.start + index / pose.throughout!.sampleRateHz)) : []),
            ...(pose.blendSourcePoses ?? []).flatMap(source => source.throughout
              ? Array.from({ length: Math.ceil((source.throughout.end - source.throughout.start) * source.throughout.sampleRateHz) + 1 }, (_, index) =>
                Math.min(source.throughout!.end, source.throughout!.start + index / source.throughout!.sampleRateHz)) : [])])))].sort((left, right) => left - right),
          throughoutWindows: suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => pose.throughout
            ? [{ caseId: testCase.id, joint: pose.joint, ...pose.throughout }] : [])),
          blendSourceThroughoutWindows: suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose =>
            (pose.blendSourcePoses ?? []).flatMap(source => source.throughout
              ? [{ caseId: testCase.id, joint: pose.joint, controllerStateId: source.controllerStateId,
                sourceStateId: source.sourceStateId, ...source.throughout }] : []))),
          criticalSamplePolicy: 'at-run-time: authored joint-key occurrences, Bezier extrema, exact Bounce/Elastic extrema, and graph transition/blend boundaries',
          studioCalibrationGate: { assertions: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.poses ?? [])
            .filter(pose => pose.studioCalibrationTolerance !== undefined).length, 0),
            contracts: suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => pose.studioCalibrationTolerance
              ? [{ caseId: testCase.id, joint: pose.joint, at: pose.at, throughout: pose.throughout ?? null, limits: pose.studioCalibrationTolerance }]
              : [])),
            missingStudioEvidence: 'blocks_release' as const },
          joints: [...new Set(suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).map(pose => pose.joint)))].sort(),
          sourceReferenceAssertions: (() => {
            const cases = suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => [
              ...(pose.missingBlendChannels ?? []).map(pair => ({ caseId: testCase.id, joint: pose.joint, at: pose.at,
                controllerStateId: pair.controllerStateId, sourceStateId: pair.sourceStateId, expectedChannel: false })),
              ...(pose.blendSourcePoses ?? []).map(source => ({ caseId: testCase.id, joint: pose.joint, at: pose.at,
                controllerStateId: source.controllerStateId, sourceStateId: source.sourceStateId, expectedChannel: true })),
            ])).map(assertion => {
              const controller = saved.graph.states.find(state => state.id === assertion.controllerStateId
                && (state.blendSpace1D !== undefined || state.blendSpace2D !== undefined));
              const sourceIsSample = controller !== undefined && (controller.blendSpace1D?.samples ?? controller.blendSpace2D?.samples ?? [])
                .some(sample => sample.stateId === assertion.sourceStateId);
              const recipe = sourceRecipes.get(assertion.sourceStateId);
              const hasJointChannel = recipeHasJointChannel(recipe, assertion.joint);
              return { ...assertion, sourceIsSample, hasJointChannel,
                valid: sourceIsSample && (assertion.expectedChannel ? hasJointChannel : !hasJointChannel) };
            }).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.at - right.at
              || left.joint.localeCompare(right.joint) || left.controllerStateId.localeCompare(right.controllerStateId)
              || left.sourceStateId.localeCompare(right.sourceStateId));
            return { references: cases, invalid: cases.filter(assertion => !assertion.valid) };
          })(),
          missingBlendChannelAssertions: (() => {
            const cases = suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => pose.missingBlendChannels === undefined ? [] : [{
              caseId: testCase.id, joint: pose.joint, at: pose.at,
              expectedPairs: [...pose.missingBlendChannels].sort((left, right) => left.controllerStateId.localeCompare(right.controllerStateId)
                || left.sourceStateId.localeCompare(right.sourceStateId)),
            }])).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.at - right.at || left.joint.localeCompare(right.joint));
            return { assertions: cases.length, cases };
          })(),
          blendSourcePoseAssertions: (() => {
            const cases = suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => (pose.blendSourcePoses ?? []).map(source => ({
              caseId: testCase.id, joint: pose.joint, at: pose.at, controllerStateId: source.controllerStateId, sourceStateId: source.sourceStateId,
              ...(source.effectiveWeight ? { effectiveWeight: source.effectiveWeight } : {}),
              ...(source.throughout ? { throughout: source.throughout } : {}),
              ...(source.expectedPosition ? { expectedPosition: source.expectedPosition, positionToleranceStuds: source.positionToleranceStuds } : {}),
              ...(source.expectedRotation ? { expectedRotation: source.expectedRotation, rotationToleranceDegrees: source.rotationToleranceDegrees } : {}),
            })))).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.at - right.at || left.joint.localeCompare(right.joint)
              || left.controllerStateId.localeCompare(right.controllerStateId) || left.sourceStateId.localeCompare(right.sourceStateId));
            return { assertions: cases.length, cases };
          })(),
          blendSourceCoverage: (() => {
            const cases = suite.cases.flatMap(testCase => (testCase.expect.poses ?? []).flatMap(pose => {
              return (pose.blendSourcePoses ?? []).map(source => {
                return { caseId: testCase.id, joint: pose.joint, at: pose.at,
                  controllerStateId: source.controllerStateId, sourceStateId: source.sourceStateId,
                  checksEffectiveWeight: source.effectiveWeight !== undefined,
                  checksLocalPosition: source.expectedPosition !== undefined,
                  checksLocalRotation: source.expectedRotation !== undefined,
                  ...(source.throughout ? { throughout: { start: source.throughout.start, end: source.throughout.end,
                    sampleRateHz: source.throughout.sampleRateHz,
                    uniformSampleCount: Math.ceil((source.throughout.end - source.throughout.start) * source.throughout.sampleRateHz) + 1,
                    criticalTimesAddedAtRun: true,
                    checksEffectiveWeight: source.throughout.effectiveWeight !== undefined,
                    checksMaximumSampleGap: source.throughout.maxSampleGapSeconds !== undefined,
                    checksMaximumLinearSpeed: source.throughout.maxLinearSpeedStudsPerSecond !== undefined,
                    checksMaximumAngularSpeed: source.throughout.maxAngularSpeedDegreesPerSecond !== undefined,
                    checksMaximumLinearStep: source.throughout.maxLinearStepStuds !== undefined,
                    checksMaximumAngularStep: source.throughout.maxAngularStepDegrees !== undefined } } : {}),
                };
              });
            })).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.at - right.at
              || left.joint.localeCompare(right.joint) || left.controllerStateId.localeCompare(right.controllerStateId)
              || left.sourceStateId.localeCompare(right.sourceStateId));
            return { assertions: cases.length, cases };
          })(),
          diagnosticAssertions: { rotationBlendConfidence: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.poses ?? []).filter(pose => pose.rotationBlendConfidence !== undefined).length, 0),
            rotationInfluence: suite.cases.reduce((sum, testCase) => sum + (testCase.expect.poses ?? []).filter(pose => pose.rotationInfluence !== undefined).length, 0) } } },
      willWrite: false, commitTool: 'motion_animation_graph_timeline_plan_create',
      limitation: 'Preview pins current graph/source content and validates the suite contract. It does not run or persist test results.' };
  }

  async create(nameInput: string, graphIdInput: string, casesInput: unknown, expectedDraftFingerprint: string, parentPlanId?: string) {
    const expected = hash.parse(expectedDraftFingerprint), name = label.parse(nameInput), graphId = identifier.parse(graphIdInput);
    const suite = suiteSchema.parse({ cases: casesInput }), parent = parentPlanId ? await this.loadPlan(parentPlanId) : undefined;
    const currentDraft = await this.preview(name, graphId, suite.cases, parentPlanId);
    const planPath = join(this.directory, 'plans', `${deterministicId(expected)}.json`);
    try {
      const existing = planSchema.parse(JSON.parse(await readFile(planPath, 'utf8')));
      if (existing.draftFingerprint === expected) {
        if (canonical(existing.sourceFingerprints) !== canonical(currentDraft.sourceFingerprints)
          || existing.graphFingerprint !== currentDraft.graphFingerprint) {
          throw new Error('Reviewed timeline plan is stale because its pinned graph or source animation content changed. Re-preview before creating a new plan.');
        }
        if (existing.name === name && existing.graphId === graphId && existing.parent?.id === parent?.id
          && canonical(existing.cases) === canonical(suite.cases)) return existing;
      }
      throw new Error('Reviewed timeline draft fingerprint belongs to a different immutable plan request.');
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const draft = currentDraft;
    if (draft.draftFingerprint !== expected) throw new Error('Timeline plan differs from the reviewed preview. Re-preview the graph and cases before committing.');
    const blocker = draft.coveragePreview.blockers[0];
    if (blocker) throw new Error(`Timeline plan blocked by ${blocker.reason} in case ${blocker.caseId} for ${blocker.controllerStateId}/${blocker.sourceStateId} joint ${blocker.joint} at ${blocker.at}s. ${blocker.recommendedAction}`);
    const sourceGraph = await this.graphs.get(graphId);
    validateAnimationGraphTimelinePhaseSyncReferences(sourceGraph.graph, suite);
    const validationRecipes = new Map<string, z.infer<typeof animationSchema>>();
    for (const state of sourceGraph.graph.states) {
      const asset = await this.graphs.animations.get(state.animationId);
      if (asset.recipe.kind !== 'animation') throw new Error(`Graph state ${state.id} must reference an animation recipe.`);
      validationRecipes.set(state.id, asset.recipe);
    }
    for (const testCase of suite.cases) for (const pose of testCase.expect.poses ?? []) {
      for (const reference of [...(pose.missingBlendChannels ?? []), ...(pose.blendSourcePoses ?? [])]) {
        const controller = sourceGraph.graph.states.find(state => state.id === reference.controllerStateId
          && (state.blendSpace1D !== undefined || state.blendSpace2D !== undefined));
        const sourceIsSample = controller !== undefined
          && (controller.blendSpace1D?.samples ?? controller.blendSpace2D?.samples ?? []).some(sample => sample.stateId === reference.sourceStateId);
        if (!sourceIsSample) throw new Error(`Case ${testCase.id} pose for joint ${pose.joint} has invalid BlendSpace source reference ${reference.controllerStateId}/${reference.sourceStateId}.`);
      }
      for (const source of pose.blendSourcePoses ?? []) {
        const recipe = validationRecipes.get(source.sourceStateId);
        const hasChannel = recipeHasJointChannel(recipe, pose.joint);
        if (!hasChannel) throw new Error(`Case ${testCase.id} pose for joint ${pose.joint} expects a source channel, but BlendSpace source ${source.sourceStateId} does not author joint ${pose.joint}. Use missingBlendChannels to assert its absence.`);
      }
      for (const missing of pose.missingBlendChannels ?? []) {
        const recipe = validationRecipes.get(missing.sourceStateId);
        const hasChannel = recipeHasJointChannel(recipe, pose.joint);
        if (hasChannel) throw new Error(`Case ${testCase.id} pose for joint ${pose.joint} expects BlendSpace source ${missing.sourceStateId} to lack the channel, but it authors joint ${pose.joint}.`);
      }
    }
    const plan = planSchema.parse({ fingerprintVersion: 2, id: draft.proposedPlanId, name, revision: draft.proposedRevision, parent: draft.parent,
      graphId, graphFingerprint: draft.graphFingerprint, sourceFingerprints: draft.sourceFingerprints,
      suiteFingerprint: draft.suiteFingerprint, draftFingerprint: draft.draftFingerprint,
      planFingerprint: digest({ draftFingerprint: draft.draftFingerprint, revision: draft.proposedRevision }),
      createdAt: new Date().toISOString(), cases: draft.cases });
    await mkdir(join(this.directory, 'plans'), { recursive: true });
    try { await writeImmutable(planPath, plan); return plan; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.loadPlan(plan.id);
      if (existing.planFingerprint !== plan.planFingerprint) throw new Error('Timeline plan identity collision; refusing to overwrite immutable content.');
      return existing;
    }
  }

  async read(id: string) {
    const plan = await this.loadPlan(id);
    try {
      const graph = await this.graphs.get(plan.graphId);
      return { plan, graphStatus: graph.graphFingerprint === plan.graphFingerprint ? 'current' as const : 'changed' as const,
        sourceFingerprintsCurrent: canonical(graph.sourceFingerprints) === canonical(plan.sourceFingerprints), currentGraphFingerprint: graph.graphFingerprint };
    } catch (error) { return { plan, graphStatus: 'unavailable' as const, graphIssue: error instanceof Error ? error.message : String(error) }; }
  }

  async list(offset = 0, limit = 30) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Timeline plan pagination requires offset ≥ 0 and limit 1–100.');
    const directory = join(this.directory, 'plans');
    const names = (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    const plans = await Promise.all(names.map(name => this.loadPlan(name.slice(0, -5))));
    const rows = await Promise.all(plans.map(async plan => {
      try {
        const graph = await this.graphs.get(plan.graphId);
        return { id: plan.id, name: plan.name, revision: plan.revision, parentId: plan.parent?.id ?? null, graphId: plan.graphId,
          graphStatus: graph.graphFingerprint === plan.graphFingerprint ? 'current' as const : 'changed' as const,
          caseCount: plan.cases.length, suiteFingerprint: plan.suiteFingerprint, createdAt: plan.createdAt };
      } catch { return { id: plan.id, name: plan.name, revision: plan.revision, parentId: plan.parent?.id ?? null, graphId: plan.graphId,
        graphStatus: 'unavailable' as const, caseCount: plan.cases.length, suiteFingerprint: plan.suiteFingerprint, createdAt: plan.createdAt }; }
    }));
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { total: rows.length, offset, plans: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  async run(planId: string, expectedPlanFingerprint?: string, studioEvidenceInput?: unknown, studioBlendEvidenceInput?: unknown,
    fadeCalibrationProfiles: AnimationGraphFadeCalibration[] = []) {
    const plan = await this.loadPlan(planId);
    if (expectedPlanFingerprint !== undefined && hash.parse(expectedPlanFingerprint) !== plan.planFingerprint) throw new Error('Timeline plan fingerprint differs from reviewed expectation. Read the current immutable plan before running it.');
    const graph = await this.graphs.get(plan.graphId);
    if (graph.graphFingerprint !== plan.graphFingerprint || canonical(graph.sourceFingerprints) !== canonical(plan.sourceFingerprints)) {
      throw new Error('Saved graph/source fingerprints differ from this timeline plan. Create a reviewed child plan for the new graph revision.');
    }
    validateAnimationGraphTimelinePhaseSyncReferences(graph.graph, { cases: plan.cases });
    const recipes: Record<string, z.infer<typeof animationSchema>> = {};
    for (const state of graph.graph.states) {
      const asset = await this.graphs.animations.get(state.animationId);
      if (asset.recipe.kind !== 'animation') throw new Error(`Graph state ${state.id} no longer references an animation recipe.`);
      recipes[state.animationId] = asset.recipe;
    }
    const fadeProfiles = fadeCalibrationProfiles.map(profile => ({ id: profile.id, stateId: profile.stateId,
      recipeFingerprint: profile.recipeFingerprint, profileFingerprint: profile.profileFingerprint, fadeSeconds: profile.fadeSeconds,
      sampleRateHz: profile.sampleRateHz, playIn: profile.playIn, stopOut: profile.stopOut,
      ...(profile.playRetrigger ? { playRetrigger: profile.playRetrigger } : {}),
      ...(profile.naturalCompletion ? { naturalCompletion: profile.naturalCompletion } : {}) }));
    const fadeCalibrationEvidence = fadeCalibrationProfiles.map(profile => {
      const quality = assessAnimationGraphFadeCalibration(profile);
      const qualityWarnings = (['playIn', 'stopOut', 'adjustWeightIn', 'adjustWeightOut', 'naturalCompletion'] as const)
        .flatMap(curve => quality[curve] ? quality[curve]!.warnings.map(warning => `${curve}:${warning}`) : []).sort();
      return { id: profile.id, profileFingerprint: profile.profileFingerprint,
      stateId: profile.stateId, fadeSeconds: profile.fadeSeconds, rigId: profile.rigId, rigSignature: profile.rigSignature,
      qualityStatus: quality.status, qualityWarnings,
      studioBuildIdentity: profile.studioBuildIdentity ?? { status: 'unavailable' as const, value: null, source: 'unavailable' as const },
      ...(profile.playRetrigger ? { playRetrigger: profile.playRetrigger } : {}),
      ...(profile.naturalCompletion ? { naturalCompletion: profile.naturalCompletion } : {}) };
    });
    const report = runAnimationGraphTimelineSuite(graph.graph, recipes, { cases: plan.cases }, { fadeProfiles, fadeCalibrationEvidence });
    if (report.suiteFingerprint !== plan.suiteFingerprint) throw new Error('Timeline plan content failed its suite-fingerprint check.');
    const hasStudioCalibrationGate = plan.cases.some(testCase => testCase.expect.poses?.some(pose => pose.studioCalibrationTolerance));
    const needsCalibrationTrace = hasStudioCalibrationGate || studioBlendEvidenceInput !== undefined;
    const calibrationTrace = needsCalibrationTrace
      ? runAnimationGraphTimelineSuite(graph.graph, recipes, { cases: plan.cases }, { includeStudioCalibrationTrace: true,
        fadeProfiles, fadeCalibrationEvidence }).studioCalibrationTrace ?? []
      : [];
    const parsedStudioEvidence = studioEvidenceInput === undefined ? undefined : studioEvidenceBaseSchema.parse(studioEvidenceInput);
    const studioEvidence = parsedStudioEvidence ? studioEvidenceSchema.parse({ ...parsedStudioEvidence, fingerprint: digest(parsedStudioEvidence) }) : undefined;
    const parsedStudioBlendEvidence = studioBlendEvidenceInput === undefined ? undefined : studioBlendEvidenceBaseSchema.parse(studioBlendEvidenceInput);
    const studioBlendEvidence = parsedStudioBlendEvidence ? studioBlendEvidenceSchema.parse({ ...parsedStudioBlendEvidence,
      fingerprint: digest(parsedStudioBlendEvidence) }) : undefined;
    if (studioEvidence) {
      if (studioEvidence.graphFingerprint !== plan.graphFingerprint) throw new Error('Studio pose evidence was sampled against a different graph revision.');
      for (const sample of studioEvidence.samples) {
        const index = graph.graph.states.findIndex(state => state.id === sample.stateId);
        const state = graph.graph.states[index];
        if (!state || state.animationId !== sample.animationId || graph.sourceFingerprints[index] !== sample.recipeFingerprint) {
          throw new Error(`Studio pose evidence for state ${sample.stateId} does not match the plan's pinned source animation.`);
        }
        if (sample.inspection.source !== 'studio_pose_evaluator') throw new Error(`Studio evidence for ${sample.stateId} must include actual Studio pose-evaluator results.`);
      }
    }
    if (studioBlendEvidence && studioBlendEvidence.graphFingerprint !== plan.graphFingerprint) {
      throw new Error('Studio Animator blend evidence was sampled against a different graph revision.');
    }
    if (studioBlendEvidence) {
      const traceBySample = new Map(calibrationTrace.map(sample => [`${sample.caseId}:${sample.at}`, sample]));
      for (const sample of studioBlendEvidence.samples) {
        const expected = traceBySample.get(`${sample.caseId}:${sample.at}`);
        if (!expected) throw new Error(`Studio blend evidence sample ${sample.caseId}@${sample.at}s is not requested by the immutable timeline plan.`);
        const expectedJoint = expected.joints.find(joint => joint.joint === sample.joint);
        if (!expectedJoint) throw new Error(`Studio blend evidence joint ${sample.joint} at ${sample.caseId}@${sample.at}s is not requested by the immutable timeline plan.`);
        const stateIds = expected.tracks.map(track => track.stateId);
        if (sample.activeStates && canonical(sample.activeStates) !== canonical(stateIds)) {
          throw new Error(`Studio blend evidence active states do not match the planned tracks at ${sample.caseId}@${sample.at}s.`);
        }
        if (sample.activeTracks && (sample.activeTracks.length !== expected.tracks.length || expected.tracks.some(track => {
          const observed = sample.activeTracks!.find(candidate => candidate.stateId === track.stateId);
          return !observed || Math.abs(observed.weight - track.weight) > 0.0001
            || Math.abs(observed.playbackTimeSeconds - track.playbackTimeSeconds) > 0.001;
        }))) throw new Error(`Studio blend evidence tracks do not match the plan's simulator request at ${sample.caseId}@${sample.at}s.`);
        if (sample.requestedTracks && canonical(sample.requestedTracks) !== canonical(expected.tracks)) {
          throw new Error(`Studio blend evidence requested tracks do not match the immutable plan at ${sample.caseId}@${sample.at}s.`);
        }
        if (sample.simulatedTimelineContext && canonical(sample.simulatedTimelineContext) !== canonical(expected.timelineContext)) {
          throw new Error(`Studio blend evidence timeline context does not match the immutable plan at ${sample.caseId}@${sample.at}s.`);
        }
        if (studioBlendEvidence.schemaVersion >= 5 && canonical(sample.predicted) !== canonical(expectedJoint.predicted)) {
          throw new Error(`Studio blend evidence predicted pose does not match the immutable plan at ${sample.caseId}@${sample.at}s for ${sample.joint}.`);
        }
        if (sample.simulatedContributors && canonical(sample.simulatedContributors) !== canonical(expectedJoint.simulatedContributors)) {
          throw new Error(`Studio blend evidence contributors do not match the immutable plan at ${sample.caseId}@${sample.at}s for ${sample.joint}.`);
        }
        if (sample.simulatedPriorityLayers && canonical(sample.simulatedPriorityLayers) !== canonical(expectedJoint.simulatedPriorityLayers)) {
          throw new Error(`Studio blend evidence priority layers do not match the immutable plan at ${sample.caseId}@${sample.at}s for ${sample.joint}.`);
        }
        if (sample.simulatedResidualWeight !== undefined && sample.simulatedResidualWeight !== expectedJoint.simulatedResidualWeight) {
          throw new Error(`Studio blend evidence pose residual does not match the immutable plan at ${sample.caseId}@${sample.at}s for ${sample.joint}.`);
        }
        if (studioBlendEvidence.schemaVersion >= 10 && sample.simulatedResidualBasis !== expectedJoint.simulatedResidualBasis) {
          throw new Error(`Studio blend evidence residual basis does not match the immutable plan at ${sample.caseId}@${sample.at}s for ${sample.joint}.`);
        }
      }
      const expectedSampleKeys = new Set(calibrationTrace.flatMap(sample => sample.joints.map(joint => `${sample.caseId}:${sample.at}:${joint.joint}`)));
      const observedSampleKeys = new Set(studioBlendEvidence.samples.map(sample => `${sample.caseId}:${sample.at}:${sample.joint}`));
      const missingSamples = [...expectedSampleKeys].filter(key => !observedSampleKeys.has(key));
      const unplannedSamples = [...observedSampleKeys].filter(key => !expectedSampleKeys.has(key));
      if (missingSamples.length > 0 || unplannedSamples.length > 0) {
        throw new Error(`Studio blend evidence coverage is incomplete: ${missingSamples.length} planned joint samples are missing and ${unplannedSamples.length} unplanned joint samples were supplied.`);
      }
    }
    const studioCalibrationGate = evaluateStudioCalibrationGate(plan.cases, calibrationTrace, studioBlendEvidence);
    const releaseStatus = report.status === 'passed' && studioCalibrationGate.status !== 'failed'
      && studioCalibrationGate.status !== 'not_run' ? 'passed' as const : 'failed' as const;
    const base = { id: randomUUID(), planId: plan.id, planFingerprint: plan.planFingerprint, planRevision: plan.revision,
      graphId: plan.graphId, graphFingerprint: plan.graphFingerprint, suiteFingerprint: plan.suiteFingerprint,
      recordedAt: new Date().toISOString(), report, ...(studioEvidence ? { studioEvidence } : {}),
      ...(studioBlendEvidence ? { studioBlendEvidence } : {}), studioCalibrationGate, releaseStatus };
    const run = runSchema.parse({ ...base, runFingerprint: digest(base) });
    const directory = join(this.directory, 'runs');
    await mkdir(directory, { recursive: true });
    await writeImmutable(join(directory, `${run.id}.json`), { run, integrity: digest(run) });
    return run;
  }

  private async readRun(path: string, expectedId?: string): Promise<TimelineRun> {
    const stored = storedRunSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if ((expectedId !== undefined && stored.run.id !== expectedId) || digest(stored.run) !== stored.integrity) throw new Error('Timeline run identity or integrity check failed.');
    return stored.run;
  }

  async history(planId: string, limit = 20) {
    const plan = await this.loadPlan(planId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Timeline run history limit must be 1–100.');
    const directory = join(this.directory, 'runs');
    const names = (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const all = await Promise.all(names.map(name => this.readRun(join(directory, name), name.slice(0, -5))));
    const runs = all.filter(run => run.planId === plan.id);
    for (const run of runs) if (run.planFingerprint !== plan.planFingerprint) throw new Error(`Run ${run.id} does not match its immutable timeline plan.`);
    runs.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || left.id.localeCompare(right.id));
    return { planId: plan.id, planFingerprint: plan.planFingerprint, total: runs.length, runs: runs.slice(0, limit) };
  }

  async compare(beforeRunId: string, afterRunId: string) {
    const directory = join(this.directory, 'runs');
    const before = await this.readRun(join(directory, `${identifier.parse(beforeRunId)}.json`), beforeRunId);
    const after = await this.readRun(join(directory, `${identifier.parse(afterRunId)}.json`), afterRunId);
    const [beforePlan, afterPlan] = await Promise.all([this.loadPlan(before.planId), this.loadPlan(after.planId)]);
    const sourceComparability = canonical(beforePlan.sourceFingerprints) === canonical(afterPlan.sourceFingerprints)
      ? 'same_sources' as const : 'different_sources' as const;
    const beforeCases = new Map(before.report.cases.map(value => { const item = temporalCaseComparisonSchema.parse(value); return [item.id, item] as const; }));
    const afterCases = new Map(after.report.cases.map(value => { const item = temporalCaseComparisonSchema.parse(value); return [item.id, item] as const; }));
    const cases = [...new Set([...beforeCases.keys(), ...afterCases.keys()])].sort().map(id => {
      const left = beforeCases.get(id), right = afterCases.get(id);
      const trend = !left ? 'added' : !right ? 'removed' : left.status === right.status
        ? left.status === 'passed' ? 'stable_pass' : 'stable_fail'
        : left.status === 'passed' ? 'regression' : 'improvement';
      const leftFailures = new Set(left?.failures.map(failure => failure.expectation) ?? []);
      const rightFailures = new Set(right?.failures.map(failure => failure.expectation) ?? []);
      const leftChecks = left ? comparableChecks(left) : new Map();
      const rightChecks = right ? comparableChecks(right) : new Map();
      const checkChanges = [...new Set([...leftChecks.keys(), ...rightChecks.keys()])].sort().map(expectation => {
        const first = leftChecks.get(expectation), second = rightChecks.get(expectation);
        const expectedChanged = first !== undefined && second !== undefined && canonical(first.expected) !== canonical(second.expected);
        const observedChanged = first !== undefined && second !== undefined && canonical(first.observed) !== canonical(second.observed);
        const status = !first ? 'added' as const : !second ? 'removed' as const
          : first.passed && !second.passed ? 'regression' as const : !first.passed && second.passed ? 'improvement' as const
            : expectedChanged ? 'expectation_changed' as const : observedChanged ? 'measurement_changed' as const : 'stable' as const;
        return { expectation, kind: second?.kind ?? first?.kind ?? 'pose', status,
          before: first ? { expected: first.expected, observed: first.observed, passed: first.passed } : null,
          after: second ? { expected: second.expected, observed: second.observed, passed: second.passed } : null,
          ...(expectedChanged ? { expectedChanged: true } : {}),
          ...(observedChanged ? { observedChanged: true } : {}),
          ...(first && second && typeof first.observed === 'number' && typeof second.observed === 'number'
            ? { observedDelta: second.observed - first.observed } : {}),
          ...(first && second ? { observedNumericDeltas: numericObservedDeltas(first.observed, second.observed) } : {}) };
      });
      const beforeCollisionCount = left?.eventOrderingDiagnostics?.ambiguousCollisionCount;
      const afterCollisionCount = right?.eventOrderingDiagnostics?.ambiguousCollisionCount;
      const eventOrderingDiagnosticsStatus = !left || !right ? 'not_compared' as const
        : beforeCollisionCount === undefined && afterCollisionCount === undefined ? 'unavailable' as const
          : beforeCollisionCount === undefined || afterCollisionCount === undefined ? 'incomplete' as const
            : canonical(left.eventOrderingDiagnostics) === canonical(right.eventOrderingDiagnostics) ? 'stable' as const : 'changed' as const;
      const beforeOrderingGate = left?.eventOrderingCheck;
      const afterOrderingGate = right?.eventOrderingCheck;
      const eventOrderingGateThresholdChange = !left || !right ? 'not_compared' as const
        : !beforeOrderingGate && !afterOrderingGate ? 'not_asserted' as const
          : !beforeOrderingGate ? 'added' as const : !afterOrderingGate ? 'removed' as const
            : beforeOrderingGate.maximumAllowedCollisions === afterOrderingGate.maximumAllowedCollisions ? 'unchanged' as const
              : afterOrderingGate.maximumAllowedCollisions < beforeOrderingGate.maximumAllowedCollisions ? 'tightened' as const : 'relaxed' as const;
      const eventOrderingGateOutcomeChange = !left || !right ? 'not_compared' as const
        : !beforeOrderingGate && !afterOrderingGate ? 'not_asserted' as const
          : !beforeOrderingGate ? afterOrderingGate!.status === 'failed' ? 'failed' as const : 'passed' as const
            : !afterOrderingGate ? 'removed' as const
              : beforeOrderingGate.status === afterOrderingGate.status ? 'stable' as const
                : beforeOrderingGate.status === 'passed' ? 'regression' as const : 'improvement' as const;
      const eventOrderingGateStatus = eventOrderingGateOutcomeChange === 'regression' ? 'regression' as const
        : eventOrderingGateOutcomeChange === 'improvement' ? 'improvement' as const
          : eventOrderingGateThresholdChange === 'added' && eventOrderingGateOutcomeChange === 'failed' ? 'added_failure' as const
            : eventOrderingGateThresholdChange === 'added' ? 'added' as const
              : eventOrderingGateThresholdChange === 'removed' ? 'removed' as const
                : eventOrderingGateThresholdChange === 'tightened' ? 'tightened' as const
                  : eventOrderingGateThresholdChange === 'relaxed' ? 'relaxed' as const
                    : eventOrderingGateOutcomeChange === 'failed' ? 'failed' as const
                      : eventOrderingGateOutcomeChange === 'passed' ? 'passed' as const
                        : eventOrderingGateOutcomeChange === 'removed' ? 'removed' as const : 'stable' as const;
      const beforeSensitivity = left?.eventOrderSensitivity ?? null;
      const afterSensitivity = right?.eventOrderSensitivity ?? null;
      const sensitivityDiagnosticsStatus = !left || !right ? 'not_compared' as const
        : beforeSensitivity === null && afterSensitivity === null ? 'unavailable' as const
          : beforeSensitivity === null || afterSensitivity === null ? 'incomplete' as const
            : canonical(beforeSensitivity) === canonical(afterSensitivity) ? 'stable' as const : 'changed' as const;
      const beforeSensitivityGate = left?.eventOrderSensitivityCheck;
      const afterSensitivityGate = right?.eventOrderSensitivityCheck;
      const sensitivityGateThresholdChange = !left || !right ? 'not_compared' as const
        : !beforeSensitivityGate && !afterSensitivityGate ? 'not_asserted' as const
          : !beforeSensitivityGate ? 'added' as const : !afterSensitivityGate ? 'removed' as const
            : beforeSensitivityGate.maximumAllowedDivergences === afterSensitivityGate.maximumAllowedDivergences ? 'unchanged' as const
              : afterSensitivityGate.maximumAllowedDivergences < beforeSensitivityGate.maximumAllowedDivergences ? 'tightened' as const : 'relaxed' as const;
      const sensitivityGateOutcomeChange = !left || !right ? 'not_compared' as const
        : !beforeSensitivityGate && !afterSensitivityGate ? 'not_asserted' as const
          : !beforeSensitivityGate ? afterSensitivityGate!.status === 'failed' ? 'failed' as const : 'passed' as const
            : !afterSensitivityGate ? 'removed' as const
              : beforeSensitivityGate.status === afterSensitivityGate.status ? 'stable' as const
                : beforeSensitivityGate.status === 'passed' ? 'regression' as const : 'improvement' as const;
      const sensitivityGateStatus = sensitivityGateOutcomeChange === 'regression' ? 'regression' as const
        : sensitivityGateOutcomeChange === 'improvement' ? 'improvement' as const
          : sensitivityGateThresholdChange === 'added' && sensitivityGateOutcomeChange === 'failed' ? 'added_failure' as const
            : sensitivityGateThresholdChange === 'added' ? 'added' as const
              : sensitivityGateThresholdChange === 'removed' ? 'removed' as const
                : sensitivityGateThresholdChange === 'tightened' ? 'tightened' as const
                  : sensitivityGateThresholdChange === 'relaxed' ? 'relaxed' as const
                    : sensitivityGateOutcomeChange === 'failed' ? 'failed' as const
                      : sensitivityGateOutcomeChange === 'passed' ? 'passed' as const
                        : sensitivityGateOutcomeChange === 'removed' ? 'removed' as const : 'stable' as const;
      return { id, trend, beforeStatus: left?.status ?? null, afterStatus: right?.status ?? null,
        newFailures: [...rightFailures].filter(item => !leftFailures.has(item)).sort(), resolvedFailures: [...leftFailures].filter(item => !rightFailures.has(item)).sort(),
        checkChanges, eventOrdering: { diagnosticsStatus: eventOrderingDiagnosticsStatus,
          beforeAmbiguousCollisionCount: beforeCollisionCount ?? null, afterAmbiguousCollisionCount: afterCollisionCount ?? null,
          ...(beforeCollisionCount !== undefined && afterCollisionCount !== undefined
            ? { ambiguousCollisionDelta: afterCollisionCount - beforeCollisionCount } : {}),
          gateStatus: eventOrderingGateStatus, gateThresholdChange: eventOrderingGateThresholdChange,
          gateOutcomeChange: eventOrderingGateOutcomeChange, beforeGate: beforeOrderingGate ?? null, afterGate: afterOrderingGate ?? null },
        eventOrderSensitivity: { diagnosticsStatus: sensitivityDiagnosticsStatus,
          beforeDivergenceCount: beforeSensitivity?.divergenceCount ?? null, afterDivergenceCount: afterSensitivity?.divergenceCount ?? null,
          ...(beforeSensitivity && afterSensitivity ? { divergenceDelta: afterSensitivity.divergenceCount - beforeSensitivity.divergenceCount } : {}),
          gateStatus: sensitivityGateStatus, gateThresholdChange: sensitivityGateThresholdChange,
          gateOutcomeChange: sensitivityGateOutcomeChange, beforeGate: beforeSensitivityGate ?? null, afterGate: afterSensitivityGate ?? null } };
    });
    const beforeStudio = before.studioEvidence, afterStudio = after.studioEvidence;
    const studioEvidenceComparability = !beforeStudio && !afterStudio ? 'both_missing' as const
      : !beforeStudio || !afterStudio ? 'one_missing' as const
        : beforeStudio.rigId === afterStudio.rigId && beforeStudio.rigSignature === afterStudio.rigSignature ? 'same_rig' as const : 'different_rig' as const;
    const beforeSampledStates = new Set(beforeStudio?.samples.map(sample => sample.stateId) ?? []);
    const afterSampledStates = new Set(afterStudio?.samples.map(sample => sample.stateId) ?? []);
    const studioStateChanges = beforeStudio && afterStudio ? compareStudioSamples(beforeStudio.samples, afterStudio.samples) : [];
    const poseModels = (run: typeof before) => run.report.cases.map(testCase => ({ caseId: testCase.id, poseModel: testCase.poseModel ?? null }));
    const beforePoseModels = poseModels(before), afterPoseModels = poseModels(after);
    const hasCompletePoseModelProvenance = (models: ReturnType<typeof poseModels>) => models.every(item => item.poseModel !== null);
    const poseModelProvenanceStatus = !hasCompletePoseModelProvenance(beforePoseModels) || !hasCompletePoseModelProvenance(afterPoseModels)
      ? 'incomplete_provenance' as const
      : canonical(beforePoseModels) === canonical(afterPoseModels) ? 'same_model' as const : 'different_model' as const;
    const samePoseModel = poseModelProvenanceStatus === 'same_model';
    const fadeCalibrationProfiles = (run: typeof before) => {
      const profilesById = new Map((run.report.fadeCalibrationEvidence ?? []).map(profile => [profile.id, profile] as const));
      return (run.report.blendModel?.calibrationProfileIds ?? []).map(id => profilesById.get(id) ?? null);
    };
    const beforeFadeCalibrationProfiles = fadeCalibrationProfiles(before);
    const afterFadeCalibrationProfiles = fadeCalibrationProfiles(after);
    const hasCompleteFadeCalibrationProvenance = (profiles: ReturnType<typeof fadeCalibrationProfiles>) => profiles.every(profile => profile !== null);
    const fadeCalibrationProvenanceStatus = beforeFadeCalibrationProfiles.length === 0 && afterFadeCalibrationProfiles.length === 0
      ? 'same_profiles' as const
      : !hasCompleteFadeCalibrationProvenance(beforeFadeCalibrationProfiles) || !hasCompleteFadeCalibrationProvenance(afterFadeCalibrationProfiles)
        ? 'incomplete_provenance' as const
        : canonical(beforeFadeCalibrationProfiles) === canonical(afterFadeCalibrationProfiles) ? 'same_profiles' as const : 'different_profiles' as const;
    const fadeCalibrationProvenanceComparable = fadeCalibrationProvenanceStatus === 'same_profiles';
    const sameBlendModel = before.report.blendModel !== undefined && after.report.blendModel !== undefined
      && canonical(before.report.blendModel) === canonical(after.report.blendModel) && samePoseModel && fadeCalibrationProvenanceComparable;
    const beforeBlend = before.studioBlendEvidence, afterBlend = after.studioBlendEvidence;
    const studioBlendBuildComparability = !beforeBlend && !afterBlend ? 'both_missing' as const
      : !beforeBlend || !afterBlend ? 'one_missing' as const
        : beforeBlend.studioBuildIdentity?.status !== 'captured' || afterBlend.studioBuildIdentity?.status !== 'captured' ? 'unknown' as const
          : beforeBlend.studioBuildIdentity.value === afterBlend.studioBuildIdentity.value ? 'match' as const : 'mismatch' as const;
    const studioBlendProtocolComparability = !beforeBlend && !afterBlend ? 'both_missing' as const
      : !beforeBlend || !afterBlend ? 'one_missing' as const
        : !beforeBlend.calibrationProtocol || !afterBlend.calibrationProtocol ? 'unknown' as const
          : beforeBlend.calibrationProtocol === afterBlend.calibrationProtocol ? 'match' as const : 'mismatch' as const;
    const studioBlendJointMapComparability = !beforeBlend && !afterBlend ? 'both_missing' as const
      : !beforeBlend || !afterBlend ? 'one_missing' as const
        : !beforeBlend.jointMapFingerprint || !afterBlend.jointMapFingerprint ? 'unknown' as const
          : beforeBlend.jointMapFingerprint === afterBlend.jointMapFingerprint ? 'match' as const : 'mismatch' as const;
    const studioBlendEvidenceComparability = !beforeBlend && !afterBlend ? 'both_missing' as const
      : !beforeBlend || !afterBlend ? 'one_missing' as const
        : beforeBlend.rigId !== afterBlend.rigId || beforeBlend.rigSignature !== afterBlend.rigSignature ? 'different_rig' as const
          : sourceComparability === 'different_sources' ? 'same_rig_changed_sources' as const
          : before.graphFingerprint !== after.graphFingerprint || before.suiteFingerprint !== after.suiteFingerprint ? 'same_rig_changed_contract' as const
            : studioBlendProtocolComparability === 'mismatch' ? 'same_rig_same_contract_different_calibration_protocol' as const
              : studioBlendProtocolComparability !== 'match' ? 'same_rig_same_contract_unknown_calibration_protocol' as const
                : studioBlendJointMapComparability === 'mismatch' ? 'same_rig_same_contract_different_joint_map' as const
                  : studioBlendJointMapComparability !== 'match' ? 'same_rig_same_contract_unknown_joint_map' as const
                    : studioBlendBuildComparability === 'match' ? 'same_rig_same_contract_same_studio_build' as const
                      : studioBlendBuildComparability === 'mismatch' ? 'same_rig_same_contract_different_studio_build' as const
                        : 'same_rig_same_contract_unknown_studio_build' as const;
    const studioBlendErrorDeltasComparable = studioBlendEvidenceComparability === 'same_rig_same_contract_same_studio_build'
      && studioBlendProtocolComparability === 'match' && sameBlendModel;
    const beforeStudioBlendCalibration = summarizeStudioBlendCalibration(beforeBlend?.samples);
    const afterStudioBlendCalibration = summarizeStudioBlendCalibration(afterBlend?.samples);
    const beforeCalibrationGroups = new Map(beforeStudioBlendCalibration?.byCaseAndJoint.map(group => [`${group.caseId}:${group.joint}`, group]) ?? []);
    const afterCalibrationGroups = new Map(afterStudioBlendCalibration?.byCaseAndJoint.map(group => [`${group.caseId}:${group.joint}`, group]) ?? []);
    const calibrationGroupKeys = [...new Set([...beforeCalibrationGroups.keys(), ...afterCalibrationGroups.keys()])].sort();
    const calibrationCoverageMatches = beforeStudioBlendCalibration !== null && afterStudioBlendCalibration !== null
      && beforeStudioBlendCalibration.sampleCount === afterStudioBlendCalibration.sampleCount
      && calibrationGroupKeys.every(key => beforeCalibrationGroups.get(key)?.sampleCount === afterCalibrationGroups.get(key)?.sampleCount);
    const studioBlendCalibrationDeltaComparable = studioBlendErrorDeltasComparable && calibrationCoverageMatches;
    const studioBlendCalibrationDelta = !studioBlendCalibrationDeltaComparable ? {
      status: 'not_comparable' as const,
      reason: beforeStudioBlendCalibration === null || afterStudioBlendCalibration === null ? 'missing_calibration_samples' as const
        : !calibrationCoverageMatches ? 'sample_coverage_changed' as const
          : sourceComparability === 'different_sources' ? 'source_animations_changed' as const
            : studioBlendEvidenceComparability === 'different_rig' ? 'rig_changed' as const
              : studioBlendEvidenceComparability === 'same_rig_changed_contract' ? 'graph_or_test_contract_changed' as const
                : studioBlendProtocolComparability === 'mismatch' ? 'calibration_protocol_changed' as const
                  : studioBlendProtocolComparability !== 'match' ? 'calibration_protocol_unknown' as const
                    : studioBlendJointMapComparability === 'mismatch' ? 'joint_map_changed' as const
                      : studioBlendJointMapComparability !== 'match' ? 'joint_map_unknown' as const
                        : studioBlendBuildComparability === 'mismatch' ? 'studio_build_changed' as const
                          : studioBlendBuildComparability !== 'match' ? 'studio_build_unknown' as const
                            : !before.report.blendModel || !after.report.blendModel
                              || poseModelProvenanceStatus === 'incomplete_provenance' || fadeCalibrationProvenanceStatus === 'incomplete_provenance'
                              ? 'blend_model_provenance_incomplete' as const
                              : !sameBlendModel ? 'blend_model_changed' as const : 'native_evidence_not_comparable' as const,
    } : {
      status: 'comparable' as const,
      method: 'after_minus_before_nearest_rank_percentile' as const,
      beforeSampleCount: beforeStudioBlendCalibration!.sampleCount,
      afterSampleCount: afterStudioBlendCalibration!.sampleCount,
      positionErrorStuds: {
        p50: afterStudioBlendCalibration!.errorDistribution.positionErrorStuds.p50! - beforeStudioBlendCalibration!.errorDistribution.positionErrorStuds.p50!,
        p95: afterStudioBlendCalibration!.errorDistribution.positionErrorStuds.p95! - beforeStudioBlendCalibration!.errorDistribution.positionErrorStuds.p95!,
      },
      rotationErrorDegrees: {
        p50: afterStudioBlendCalibration!.errorDistribution.rotationErrorDegrees.p50! - beforeStudioBlendCalibration!.errorDistribution.rotationErrorDegrees.p50!,
        p95: afterStudioBlendCalibration!.errorDistribution.rotationErrorDegrees.p95! - beforeStudioBlendCalibration!.errorDistribution.rotationErrorDegrees.p95!,
      },
      byCaseAndJoint: calibrationGroupKeys.map(key => {
        const beforeGroup = beforeCalibrationGroups.get(key)!;
        const afterGroup = afterCalibrationGroups.get(key)!;
        return { caseId: afterGroup.caseId, joint: afterGroup.joint, sampleCount: afterGroup.sampleCount,
          positionErrorStuds: { p50: afterGroup.positionErrorStuds.p50! - beforeGroup.positionErrorStuds.p50!,
            p95: afterGroup.positionErrorStuds.p95! - beforeGroup.positionErrorStuds.p95! },
          rotationErrorDegrees: { p50: afterGroup.rotationErrorDegrees.p50! - beforeGroup.rotationErrorDegrees.p50!,
            p95: afterGroup.rotationErrorDegrees.p95! - beforeGroup.rotationErrorDegrees.p95! } };
      }),
      limitation: 'Negative values mean lower sampled prediction error after the change; positive values mean higher error. Deltas are emitted only for exact matching case/joint sample coverage, rig, graph/test contract, captured Studio build, pose model, and fade-model provenance. This compares sampled fixed-weight native poses, not unsampled fade trajectories.',
    };
    const beforeBlendSamples = new Map(beforeBlend?.samples.map(sample => [`${sample.caseId}:${sample.at}:${sample.joint}`, sample]) ?? []);
    const afterBlendSamples = new Map(afterBlend?.samples.map(sample => [`${sample.caseId}:${sample.at}:${sample.joint}`, sample]) ?? []);
    const studioBlendSampleChanges = [...new Set([...beforeBlendSamples.keys(), ...afterBlendSamples.keys()])].sort().map(key => {
      const first = beforeBlendSamples.get(key), second = afterBlendSamples.get(key);
      return { caseId: second?.caseId ?? first!.caseId, at: second?.at ?? first!.at, joint: second?.joint ?? first!.joint,
        status: !first ? 'added' as const : !second ? 'removed' as const
          : canonical({ activeStates: first.activeStates ?? first.activeTracks?.map(track => track.stateId), activeTracks: first.activeTracks,
            requestedTracks: first.requestedTracks,
            simulatedTimelineContext: first.simulatedTimelineContext,
            simulatedResidualBasis: first.simulatedResidualBasis,
            simulatedContributors: first.simulatedContributors, simulatedPriorityLayers: first.simulatedPriorityLayers,
            simulatedResidualWeight: first.simulatedResidualWeight,
            predicted: first.predicted, measured: first.measured, positionErrorStuds: first.positionErrorStuds,
            rotationErrorDegrees: first.rotationErrorDegrees }) !== canonical({ predicted: second.predicted, measured: second.measured,
              activeStates: second.activeStates ?? second.activeTracks?.map(track => track.stateId), activeTracks: second.activeTracks,
              requestedTracks: second.requestedTracks,
              simulatedTimelineContext: second.simulatedTimelineContext,
              simulatedResidualBasis: second.simulatedResidualBasis,
              simulatedContributors: second.simulatedContributors, simulatedPriorityLayers: second.simulatedPriorityLayers,
              simulatedResidualWeight: second.simulatedResidualWeight,
              positionErrorStuds: second.positionErrorStuds, rotationErrorDegrees: second.rotationErrorDegrees }) ? 'changed' as const : 'stable' as const,
        activeTracksChanged: first && second && first.activeTracks && second.activeTracks ? canonical(first.activeTracks) !== canonical(second.activeTracks) : null,
        before: first ? { activeStates: first.activeStates ?? first.activeTracks?.map(track => track.stateId) ?? [], activeTracks: first.activeTracks ?? null,
          requestedTracks: first.requestedTracks ?? null,
          simulatedTimelineContext: first.simulatedTimelineContext ?? null,
          simulatedResidualBasis: first.simulatedResidualBasis ?? null,
          ...(first.simulatedContributors === undefined ? {} : { simulatedContributors: first.simulatedContributors,
            simulatedResidualWeight: first.simulatedResidualWeight ?? null }),
          ...(first.simulatedPriorityLayers === undefined ? {} : { simulatedPriorityLayers: first.simulatedPriorityLayers }),
          predicted: first.predicted, measured: first.measured,
          positionErrorStuds: first.positionErrorStuds, rotationErrorDegrees: first.rotationErrorDegrees } : null,
        after: second ? { activeStates: second.activeStates ?? second.activeTracks?.map(track => track.stateId) ?? [], activeTracks: second.activeTracks ?? null,
          requestedTracks: second.requestedTracks ?? null,
          simulatedTimelineContext: second.simulatedTimelineContext ?? null,
          simulatedResidualBasis: second.simulatedResidualBasis ?? null,
          ...(second.simulatedContributors === undefined ? {} : { simulatedContributors: second.simulatedContributors,
            simulatedResidualWeight: second.simulatedResidualWeight ?? null }),
          ...(second.simulatedPriorityLayers === undefined ? {} : { simulatedPriorityLayers: second.simulatedPriorityLayers }),
          predicted: second.predicted, measured: second.measured,
          positionErrorStuds: second.positionErrorStuds, rotationErrorDegrees: second.rotationErrorDegrees } : null,
        ...(first && second ? { errorDeltasComparable: studioBlendErrorDeltasComparable,
          positionErrorDeltaStuds: studioBlendErrorDeltasComparable ? second.positionErrorStuds - first.positionErrorStuds : null,
          rotationErrorDeltaDegrees: studioBlendErrorDeltasComparable ? second.rotationErrorDegrees - first.rotationErrorDegrees : null } : {}) };
    });
    return { before: { id: before.id, planId: before.planId, planFingerprint: before.planFingerprint, graphFingerprint: before.graphFingerprint,
      sourceFingerprints: beforePlan.sourceFingerprints,
      suiteFingerprint: before.suiteFingerprint, reportFingerprint: before.report.reportFingerprint, status: before.report.status,
      releaseStatus: before.releaseStatus ?? null, studioCalibrationGate: before.studioCalibrationGate ?? null,
      studioEvidenceFingerprint: beforeStudio?.fingerprint ?? null, studioBlendEvidenceFingerprint: beforeBlend?.fingerprint ?? null,
      studioBlendCalibration: beforeStudioBlendCalibration,
      studioBuildIdentity: beforeBlend?.studioBuildIdentity ?? null,
      calibrationProtocol: beforeBlend?.calibrationProtocol ?? null, jointMap: beforeBlend?.jointMap ?? null,
      jointMapFingerprint: beforeBlend?.jointMapFingerprint ?? null,
      rigId: beforeStudio?.rigId ?? beforeBlend?.rigId ?? null, rigSignature: beforeStudio?.rigSignature ?? beforeBlend?.rigSignature ?? null },
    after: { id: after.id, planId: after.planId, planFingerprint: after.planFingerprint, graphFingerprint: after.graphFingerprint,
      sourceFingerprints: afterPlan.sourceFingerprints,
      suiteFingerprint: after.suiteFingerprint, reportFingerprint: after.report.reportFingerprint, status: after.report.status,
      releaseStatus: after.releaseStatus ?? null, studioCalibrationGate: after.studioCalibrationGate ?? null,
      studioEvidenceFingerprint: afterStudio?.fingerprint ?? null, studioBlendEvidenceFingerprint: afterBlend?.fingerprint ?? null,
      studioBlendCalibration: afterStudioBlendCalibration,
      studioBuildIdentity: afterBlend?.studioBuildIdentity ?? null,
      calibrationProtocol: afterBlend?.calibrationProtocol ?? null, jointMap: afterBlend?.jointMap ?? null,
      jointMapFingerprint: afterBlend?.jointMapFingerprint ?? null,
      rigId: afterStudio?.rigId ?? afterBlend?.rigId ?? null, rigSignature: afterStudio?.rigSignature ?? afterBlend?.rigSignature ?? null },
    comparability: sourceComparability === 'different_sources' ? 'changed_sources'
      : before.graphFingerprint !== after.graphFingerprint || before.suiteFingerprint !== after.suiteFingerprint ? 'changed_contract'
      : !before.report.blendModel || !after.report.blendModel ? 'incomplete_model_provenance'
        : poseModelProvenanceStatus === 'incomplete_provenance' || fadeCalibrationProvenanceStatus === 'incomplete_provenance' ? 'incomplete_model_provenance'
          : sameBlendModel ? 'same_contract' : 'changed_blend_model',
    blendModelComparability: !before.report.blendModel || !after.report.blendModel
      || poseModelProvenanceStatus === 'incomplete_provenance' || fadeCalibrationProvenanceStatus === 'incomplete_provenance' ? 'incomplete_provenance' as const
      : sameBlendModel ? 'same_model' as const : 'different_model' as const,
    blendModels: { before: before.report.blendModel ?? null, after: after.report.blendModel ?? null },
    poseModels: { before: beforePoseModels, after: afterPoseModels },
    fadeCalibrationProfiles: { before: beforeFadeCalibrationProfiles, after: afterFadeCalibrationProfiles,
      comparability: fadeCalibrationProvenanceStatus },
    sourceComparability,
    studioEvidenceComparability,
      studioBlendEvidenceComparability, studioBlendBuildComparability, studioBlendProtocolComparability, studioBlendJointMapComparability,
      studioBlendCalibrationDelta, studioBlendSampleChanges,
    studioSampledStateChanges: [...new Set([...beforeSampledStates, ...afterSampledStates])].sort().filter(stateId => beforeSampledStates.has(stateId) !== afterSampledStates.has(stateId)),
    studioStateChanges,
    cases, summary: { regressions: cases.filter(item => item.trend === 'regression').length,
      improvements: cases.filter(item => item.trend === 'improvement').length, stableFailures: cases.filter(item => item.trend === 'stable_fail').length,
      stablePasses: cases.filter(item => item.trend === 'stable_pass').length, added: cases.filter(item => item.trend === 'added').length,
      removed: cases.filter(item => item.trend === 'removed').length,
      newFailedExpectations: cases.reduce((sum, item) => sum + item.newFailures.length, 0), resolvedExpectations: cases.reduce((sum, item) => sum + item.resolvedFailures.length, 0),
      changedChecks: cases.reduce((sum, item) => sum + item.checkChanges.filter(check => check.status !== 'stable').length, 0),
      checkRegressions: cases.reduce((sum, item) => sum + item.checkChanges.filter(check => check.status === 'regression').length, 0),
      checkImprovements: cases.reduce((sum, item) => sum + item.checkChanges.filter(check => check.status === 'improvement').length, 0),
      changedEventOrderingDiagnostics: cases.filter(item => item.eventOrdering.diagnosticsStatus === 'changed').length,
      increasedEventOrderingCollisionCases: cases.filter(item => (item.eventOrdering.ambiguousCollisionDelta ?? 0) > 0).length,
      eventOrderingGateRegressions: cases.filter(item => item.eventOrdering.gateStatus === 'regression' || item.eventOrdering.gateStatus === 'added_failure').length,
      tightenedEventOrderingGates: cases.filter(item => item.eventOrdering.gateThresholdChange === 'tightened').length,
      relaxedEventOrderingGates: cases.filter(item => item.eventOrdering.gateThresholdChange === 'relaxed').length,
      changedEventOrderSensitivityDiagnostics: cases.filter(item => item.eventOrderSensitivity.diagnosticsStatus === 'changed').length,
      increasedEventOrderDivergenceCases: cases.filter(item => (item.eventOrderSensitivity.divergenceDelta ?? 0) > 0).length,
      eventOrderSensitivityGateRegressions: cases.filter(item => item.eventOrderSensitivity.gateStatus === 'regression'
        || item.eventOrderSensitivity.gateStatus === 'added_failure').length,
      tightenedEventOrderSensitivityGates: cases.filter(item => item.eventOrderSensitivity.gateThresholdChange === 'tightened').length,
      relaxedEventOrderSensitivityGates: cases.filter(item => item.eventOrderSensitivity.gateThresholdChange === 'relaxed').length,
      changedStudioStates: studioStateChanges.filter(item => item.status === 'changed').length,
      changedStudioBlendSamples: studioBlendSampleChanges.filter(item => item.status === 'changed').length,
      changedStudioMetrics: studioStateChanges.reduce((sum, item) => sum + item.changedMetrics.length + item.addedMetricIds.length + item.removedMetricIds.length, 0) },
    interpretation: 'Per-check observations and deltas explain deterministic local blend/pose estimate changes. Comparability accounts for the track-weight model, per-case pose-composition algorithm provenance, and full fingerprints of applied calibration profiles before comparing native Studio error deltas. changed_blend_model means numeric blend/pose deltas were produced by different estimators or calibration content, while incomplete_model_provenance means at least one historical report lacks required estimator provenance. If comparability is changed_contract, expected thresholds or sample coverage also changed and must be reviewed separately. These are not Roblox runtime, crossfade appearance, gameplay, or artistic-quality verdicts.' };
  }
}
