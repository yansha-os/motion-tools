import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnimationGraphLibrary, animationGraphFingerprint } from '../src/animation-graph.js';
import { fingerprint } from '../src/inspection.js';
import { AnimationGraphTimelineHistory, animationGraphTimelineCaseReportSchema, animationGraphTimelineNextAction } from '../src/animation-graph-timeline-history.js';
import { runAnimationGraphTimelineSuite } from '../src/animation-graph-timeline-tests.js';
import { Library } from '../src/library.js';
import { animationPreset, animationSchema } from '../src/recipes.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'motion-graph-timeline-history-'));
  const animations = new Library(join(root, 'library'));
  const idle = await animations.save(animationPreset('idle', 'Timeline Idle', 1, 0.2));
  const attack = await animations.save(animationPreset('slash', 'Timeline Attack', 1, 0.8));
  const recovery = await animations.save(animationPreset('idle', 'Timeline Recovery', 1.5, 0.3));
  const graphs = new AnimationGraphLibrary(join(root, 'graphs'), animations);
  const graph = await graphs.save({ kind: 'animation_graph', name: 'Timeline Combat', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }, { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 }],
    transitions: [{ id: 'act', from: 'idle', to: 'attack', trigger: 'Act', blendSeconds: 0.1 },
      { id: 'release', from: 'attack', to: 'idle', trigger: 'Release', blendSeconds: 0.1 }] });
  const history = new AnimationGraphTimelineHistory(join(root, 'timeline-history'), graphs);
  const cases = [{ id: 'attack-release', name: 'Attack returns on marker', duration: 1.25, events: [{ at: 0, kind: 'trigger' as const, trigger: 'Act' }],
    expect: { finalState: 'idle', maxAmbiguousEventOrderingCollisions: 0, maxEventOrderDivergences: 0,
      transitionIds: { mode: 'exact' as const, ids: ['act', 'release'] },
      markers: [{ name: 'Release', minCount: 1, maxCount: 1, window: { start: 0.45, end: 0.55 } }],
      blends: [{ at: 0.05, stateId: 'idle', weight: { min: 0.5, max: 0.5 }, isPlaying: false, isAffectingPose: true },
        { at: 0.05, stateId: 'attack', weight: { min: 0.5, max: 0.5 }, isPlaying: true, isAffectingPose: true }],
      poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0.001,
        rotationBlendConfidence: { min: 0, max: 1 }, rotationInfluence: { min: 0, max: 1 } }],
      stateAt: [{ at: 0.25, stateId: 'attack' }, { at: 0.75, stateId: 'idle' }],
      transitionTimes: [{ transitionId: 'act', minAt: 0, maxAt: 0 }, { transitionId: 'release', minAt: 0.45, maxAt: 0.55 }] } }];
  return { root, animations, idle, attack, recovery, graphs, graph, history, cases };
}

test('timeline plans are reviewed, immutable, idempotent, and retain integrity-checked run history', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Combat timeline release gate', f.graph.id, f.cases);
    assert.equal(preview.willWrite, false);
    assert.equal(preview.cases[0]!.expect.playbackClock, undefined,
      'omitting the optional playback-clock assertion must not rewrite legacy suite content or fingerprints');
    assert.equal(preview.coveragePreview.caseCount, 1);
    assert.deepEqual(preview.coveragePreview.eventOrderingGate, { assertions: 1,
      cases: [{ caseId: 'attack-release', maximumAllowedCollisions: 0 }] });
    assert.deepEqual(preview.coveragePreview.eventOrderSensitivityGate, { assertions: 1,
      cases: [{ caseId: 'attack-release', maximumAllowedDivergences: 0 }] });
    assert.deepEqual(preview.coveragePreview.phaseDonorAssertions, { assertions: 0, cases: [] });
    assert.deepEqual(preview.coveragePreview.blendCoverage, { assertions: 2, sampleTimes: [0.05], stateIds: ['attack', 'idle'],
      blendSpace: { assertions: 0, sampleTimes: [], controllers: [], uncoveredControllerIds: [] } });
    assert.deepEqual(preview.coveragePreview.poseCoverage, { assertions: 1, sampleTimes: [0.05], joints: ['UpperTorso'],
      throughoutWindows: [], blendSourceThroughoutWindows: [],
      criticalSamplePolicy: 'at-run-time: authored joint-key occurrences, Bezier extrema, exact Bounce/Elastic extrema, and graph transition/blend boundaries',
      studioCalibrationGate: { assertions: 0, contracts: [], missingStudioEvidence: 'blocks_release' },
      sourceReferenceAssertions: { references: [], invalid: [] },
      missingBlendChannelAssertions: { assertions: 0, cases: [] },
      blendSourcePoseAssertions: { assertions: 0, cases: [] },
      blendSourceCoverage: { assertions: 0, cases: [] },
      diagnosticAssertions: { rotationBlendConfidence: 1, rotationInfluence: 1 } });
    const intervalPreview = await f.history.preview('Interval coverage preview', f.graph.id, [{ ...f.cases[0]!,
      expect: { ...f.cases[0]!.expect, poses: [{ ...f.cases[0]!.expect.poses[0]!, throughout: { start: 0.05, end: 0.15, sampleRateHz: 10 } }] } }]);
    assert.deepEqual(intervalPreview.coveragePreview.poseCoverage.sampleTimes, [0.05, 0.15]);
    assert.deepEqual(intervalPreview.coveragePreview.poseCoverage.throughoutWindows, [
      { caseId: 'attack-release', joint: 'UpperTorso', start: 0.05, end: 0.15, sampleRateHz: 10 },
    ]);
    assert.match(intervalPreview.coveragePreview.poseCoverage.criticalSamplePolicy, /Bezier extrema.*Bounce\/Elastic extrema/);
    const plan = await f.history.create('Combat timeline release gate', f.graph.id, f.cases, preview.draftFingerprint);
    const retry = await f.history.create('Combat timeline release gate', f.graph.id, f.cases, preview.draftFingerprint);
    assert.equal(plan.id, preview.proposedPlanId);
    assert.equal(retry.planFingerprint, plan.planFingerprint);
    const legacyPayload = { schemaVersion: 1, name: 'Legacy timeline plan', parent: null, graphId: plan.graphId,
      graphFingerprint: plan.graphFingerprint, suiteFingerprint: digest({ schemaVersion: 1, cases: plan.cases }), cases: plan.cases };
    const legacyDraftFingerprint = digest(legacyPayload);
    const legacyPlanBytes = createHash('sha256').update(`motion-tools:graph-timeline-plan:${legacyDraftFingerprint}`).digest().subarray(0, 16);
    legacyPlanBytes[6] = (legacyPlanBytes[6]! & 0x0f) | 0x50;
    legacyPlanBytes[8] = (legacyPlanBytes[8]! & 0x3f) | 0x80;
    const legacyPlanHex = legacyPlanBytes.toString('hex');
    const legacyPlanId = `${legacyPlanHex.slice(0, 8)}-${legacyPlanHex.slice(8, 12)}-${legacyPlanHex.slice(12, 16)}-${legacyPlanHex.slice(16, 20)}-${legacyPlanHex.slice(20)}`;
    const legacyPlanRecord: Record<string, unknown> = { ...plan, id: legacyPlanId, name: 'Legacy timeline plan',
      draftFingerprint: legacyDraftFingerprint, planFingerprint: digest({ draftFingerprint: legacyDraftFingerprint, revision: 1 }) };
    delete legacyPlanRecord.fingerprintVersion;
    const legacyPlansDirectory = join(f.root, 'timeline-history', 'plans');
    await mkdir(legacyPlansDirectory, { recursive: true });
    await writeFile(join(legacyPlansDirectory, `${legacyPlanId}.json`), `${JSON.stringify(legacyPlanRecord)}\n`);
    const legacyRead = await f.history.read(legacyPlanId);
    assert.equal(legacyRead.plan.fingerprintVersion, 1,
      'pre-v2 plans without the fingerprintVersion field must still validate using their original fingerprint payload');
    const [first, second] = await Promise.all([f.history.run(plan.id, plan.planFingerprint), f.history.run(plan.id, plan.planFingerprint)]);
    assert.notEqual(first.id, second.id);
    assert.equal(first.report.status, 'passed');
    assert.equal(first.studioCalibrationGate?.status, 'not_requested');
    assert.equal(first.releaseStatus, 'passed');
    const firstCase = first.report.cases[0] as unknown as { blendChecks: Array<{ status: string }>; poseChecks: Array<{ status: string }>;
      eventOrderingDiagnostics: { ambiguousCollisionCount: number }; animationEndedTiming: { assumedAdditionalFadeSeconds: number };
      eventOrderingCheck: { status: string; maximumAllowedCollisions: number; observedCollisions: number };
      eventOrderSensitivity: { status: string; divergenceCount: number; gate: { status: string; maximumAllowedDivergences: number;
        observedDivergences: number; sampleComparisonComplete?: boolean } | null };
      eventOrderSensitivityCheck: { status: string; maximumAllowedDivergences: number; observedDivergences: number; sampleComparisonComplete?: boolean } };
    assert.deepEqual(firstCase.blendChecks.map(check => check.status), ['passed', 'passed']);
    assert.deepEqual(firstCase.poseChecks.map(check => check.status), ['passed']);
    assert.equal(firstCase.eventOrderingDiagnostics.ambiguousCollisionCount, 0);
    assert.equal(firstCase.animationEndedTiming.assumedAdditionalFadeSeconds, 0);
    const legacyAnimationEndedTiming = { kind: 'assumed_natural_completion_fade', assumedAdditionalFadeSeconds: 0,
      source: 'default_zero', limitation: 'Legacy report written before per-state completion timing fields were added.' };
    const legacyCase = animationGraphTimelineCaseReportSchema.parse({ id: 'legacy-timing', status: 'passed',
      eventOrderingDiagnostics: firstCase.eventOrderingDiagnostics, animationEndedTiming: legacyAnimationEndedTiming });
    assert.deepEqual(legacyCase.animationEndedTiming, legacyAnimationEndedTiming,
      'historical timing diagnostics remain unchanged so their enclosing report fingerprints can still verify');
    const priorVersionTiming = { kind: 'assumed_natural_completion_fade', assumedAdditionalFadeSeconds: 0,
      source: 'default_zero', stateTimings: [{ stateId: 'attack', fadeSeconds: 0, source: 'default_zero',
        calibrationProfileId: null, measuredAnimationLengthSeconds: null, animationLengthMatchesRecipe: null,
        animationLengthSeconds: 1, animationLengthSource: 'authored_recipe', animationEndAfterSeconds: 1 }],
      calibrationProfileId: null, measuredAnimationLengthSeconds: null, limitation: 'Prior per-state timing report.' };
    const priorVersionCase = animationGraphTimelineCaseReportSchema.parse({ id: 'prior-timing', status: 'passed',
      eventOrderingDiagnostics: firstCase.eventOrderingDiagnostics, animationEndedTiming: priorVersionTiming });
    assert.deepEqual(priorVersionCase.animationEndedTiming, priorVersionTiming,
      'reports from the immediately preceding per-state schema remain readable as fingerprint-stable legacy data');
    assert.deepEqual(firstCase.eventOrderingCheck, { status: 'passed', maximumAllowedCollisions: 0, observedCollisions: 0 });
    assert.equal(firstCase.eventOrderSensitivity.status, 'equivalent');
    assert.deepEqual(firstCase.eventOrderSensitivityCheck, { status: 'passed', maximumAllowedDivergences: 0,
      observedDivergences: 0, sampleComparisonComplete: true });
    assert.equal(first.report.reportFingerprint, second.report.reportFingerprint);
    assert.equal((await f.history.read(plan.id)).graphStatus, 'current');
    assert.equal((await f.history.list()).total, 2);
    assert.equal((await f.history.history(plan.id)).total, 2);
    const comparison = await f.history.compare(first.id, second.id);
    assert.equal(comparison.comparability, 'same_contract');
    assert.equal(comparison.summary.stablePasses, 1);
    const storedPath = join(f.root, 'timeline-history', 'runs', `${first.id}.json`);
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { integrity: string };
    stored.integrity = '0'.repeat(64);
    await writeFile(storedPath, JSON.stringify(stored));
    await assert.rejects(() => f.history.history(plan.id), /integrity check failed/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('durable timeline plans fingerprint, run and compare missing BlendSpace joint-channel gates', async () => {
  const f = await fixture();
  try {
    const joint = 'UpperTorso';
    if (f.idle.recipe.kind !== 'animation') throw new Error('Expected an animation fixture.');
    const idleRecipe = f.idle.recipe;
    assert.ok(idleRecipe.tracks.some(track => track.joint === joint));
    const alternate = await f.animations.save({ ...idleRecipe, name: 'Timeline Alternate Missing Torso',
      tracks: idleRecipe.tracks.filter(track => track.joint !== joint) });
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Missing-channel timeline graph', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0.25, min: 0, max: 1 }], states: [
        { id: 'idle', name: 'Idle source', animationId: f.idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate source', animationId: alternate.id, speed: 1 },
        { id: 'blend', name: 'Locomotion blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 0.5, stateId: 'alternate' }, { value: 1, stateId: 'blend' }] } },
      ], transitions: [] });
    const cases = [{ id: 'torso-coverage', name: 'Pin expected source channel gap', duration: 0.2, initialParameters: { speed: 0.25 },
      expect: { poses: [{ at: 0.1, joint, missingBlendChannels: [{ controllerStateId: 'blend', sourceStateId: 'alternate' }] }] } }];
    const preview = await f.history.preview('Missing-channel coverage', graph.id, cases);
    assert.equal(preview.willWrite, false);
    assert.equal(preview.cases[0]!.expect.poses![0]!.missingBlendChannels![0]!.sourceStateId, 'alternate');
    assert.deepEqual(preview.coveragePreview.poseCoverage.missingBlendChannelAssertions, {
      assertions: 1, cases: [{ caseId: 'torso-coverage', joint, at: 0.1,
        expectedPairs: [{ controllerStateId: 'blend', sourceStateId: 'alternate' }] }],
    }, 'preview should make source-channel coverage gates explicit before the plan is committed');
    const plan = await f.history.create('Missing-channel coverage', graph.id, cases, preview.draftFingerprint);
    const persisted = await f.history.read(plan.id);
    assert.deepEqual(persisted.plan.cases[0]!.expect.poses![0]!.missingBlendChannels,
      [{ controllerStateId: 'blend', sourceStateId: 'alternate' }], 'immutable storage must retain the exact channel contract');
    const baseline = await f.history.run(plan.id, plan.planFingerprint);
    assert.equal(baseline.report.status, 'passed');

    const tightenedCases = [{ ...cases[0]!, expect: { poses: [{ at: 0.1, joint, missingBlendChannels: [] }] } }];
    const tightenedPreview = await f.history.preview('Missing-channel coverage', graph.id, tightenedCases);
    assert.notEqual(tightenedPreview.draftFingerprint, preview.draftFingerprint,
      'review fingerprints must bind the exact expected missing-channel pair set');
    assert.notEqual(tightenedPreview.suiteFingerprint, preview.suiteFingerprint,
      'suite fingerprints must bind the exact expected missing-channel pair set');
    const tightenedPlan = await f.history.create('Missing-channel coverage', graph.id, tightenedCases, tightenedPreview.draftFingerprint);
    const tightenedRun = await f.history.run(tightenedPlan.id, tightenedPlan.planFingerprint);
    assert.equal(tightenedRun.report.status, 'failed');
    const tightenedCase = tightenedRun.report.cases[0] as unknown as { poseChecks: Array<{ checks: Array<{
      property: string; passed: boolean; observed: unknown }> }> };
    const failedCheck = tightenedCase.poseChecks[0]!.checks.find(check => check.property === 'missingBlendChannels')!;
    assert.equal(failedCheck.passed, false);
    assert.deepEqual((failedCheck.observed as unknown[]), [{ controllerStateId: 'blend', sourceStateId: 'alternate' }]);
    const comparison = await f.history.compare(baseline.id, tightenedRun.id);
    assert.equal(comparison.cases[0]!.trend, 'regression');
    const channelRegression = comparison.cases[0]!.checkChanges.find(check => check.expectation.endsWith(':missingBlendChannels'));
    assert.equal(channelRegression?.status, 'regression', 'run comparison must classify the missing-channel gate as a regression');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline plan preview exposes BlendSpace1D controller and per-source-clip assertion gaps', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Timeline BlendSpace', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0.5, min: 0, max: 2 }],
      states: [{ id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 },
        { id: 'attack', name: 'Attack', animationId: f.attack.id, speed: 1 },
        { id: 'blend', name: 'Locomotion Blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'attack' },
            { value: 2, stateId: 'blend' }] } }], transitions: [] });
    const cases = [{ id: 'blend-midpoint', name: 'Blend midpoint', duration: 1, events: [], expect: {
      blends: [{ at: 0.5, stateId: 'blend', blendSpace: { parameterValue: { min: 0.5, max: 0.5 },
        phaseSyncThroughout: { stateIds: ['idle', 'attack'], maxCircularPhaseDifference: 0.05 },
        clips: [{ stateId: 'idle', weight: { min: 0.5, max: 0.5 }, playback: { playbackSpeed: { min: 1, max: 1 } } }] } }] } }];
    const preview = await f.history.preview('BlendSpace coverage', graph.id, cases);
    assert.deepEqual(preview.coveragePreview.blendCoverage, { assertions: 1, sampleTimes: [0.5], stateIds: ['blend'],
      blendSpace: { assertions: 1, sampleTimes: [0.5], controllers: [{ stateId: 'blend', dimension: '1d', parameter: 'speed',
        parameters: { x: 'speed', y: null }, sampleTimes: [0.5],
        parameterAssertions: 1, phaseSyncAssertions: 0, phaseSyncSources: [],
        phaseSyncThroughoutAssertions: 1, phaseSyncThroughoutSources: ['attack', 'idle'],
        phaseSyncThroughoutGates: [{ caseId: 'blend-midpoint', stateIds: ['idle', 'attack'], maxCircularPhaseDifference: 0.05 }],
        clipWeightAssertions: 1,
        clipAssertionKinds: { normalizedWeight: 1, currentPoseContribution: 0, targetPoseContribution: 0,
          sourcePlaybackTime: 0, sourceNormalizedPhase: 0, sourcePlaybackSpeed: 1, sourcePlayingState: 0 },
        assertedClips: ['idle'], uncoveredClips: ['attack', 'blend'] }], uncoveredControllerIds: [] } });

    const detailedCases = [{ ...cases[0]!, expect: { ...cases[0]!.expect,
      blends: [{ ...cases[0]!.expect.blends[0]!, blendSpace: { ...cases[0]!.expect.blends[0]!.blendSpace,
        clips: [{ stateId: 'idle', poseContributionWeight: { min: 0.1, max: 0.9 },
          targetPoseContributionWeight: { min: 0.4, max: 0.6 }, playback: { normalizedPhase: { min: 0.2, max: 0.3 },
            playbackSpeed: { min: 0.9, max: 1.1 }, isPlaying: true } }] } }] } }];
    const detailedPreview = await f.history.preview('BlendSpace contribution coverage', graph.id, detailedCases);
    assert.deepEqual(detailedPreview.coveragePreview.blendCoverage.blendSpace.controllers[0]!.clipAssertionKinds,
      { normalizedWeight: 0, currentPoseContribution: 1, targetPoseContribution: 1,
        sourcePlaybackTime: 0, sourceNormalizedPhase: 1, sourcePlaybackSpeed: 1, sourcePlayingState: 1 });
    const detailedPlan = await f.history.create('BlendSpace contribution coverage', graph.id, detailedCases, detailedPreview.draftFingerprint);
    assert.deepEqual(detailedPlan.cases[0]!.expect.blends[0]!.blendSpace!.clips![0], {
      stateId: 'idle', poseContributionWeight: { min: 0.1, max: 0.9 }, targetPoseContributionWeight: { min: 0.4, max: 0.6 },
      playback: { normalizedPhase: { min: 0.2, max: 0.3 }, playbackSpeed: { min: 0.9, max: 1.1 }, isPlaying: true },
    }, 'reviewed and stored plans must preserve distinct current and target contribution bounds');
    const replayGraph = { ...graph.graph, states: graph.graph.states.map(state => ({ ...state, animationId: f.idle.id })) };
    const replayedCase = runAnimationGraphTimelineSuite(replayGraph, { [f.idle.id]: f.idle.recipe },
      { cases: detailedPlan.cases }).cases[0]!;
    const sourceCheckIds = replayedCase.blendChecks[0]!.checks.map(check => check.property);
    assert.ok(sourceCheckIds.includes('blendSpace.poseContributionWeight:idle'));
    assert.ok(sourceCheckIds.includes('blendSpace.targetPoseContributionWeight:idle'));
    assert.ok(sourceCheckIds.includes('blendSpace.playback.normalizedPhase:idle'));
    assert.ok(sourceCheckIds.includes('blendSpace.playback.playbackSpeed:idle'));
    assert.ok(sourceCheckIds.includes('blendSpace.playback.isPlaying:idle'));
    const clockGraph = await f.graphs.save({ kind: 'animation_graph', name: 'Blend source clock gate', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0.5, min: 0, max: 2 }], states: [
        { id: 'idle', name: 'Idle source', animationId: f.idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate source', animationId: f.idle.id, speed: 1 },
        { id: 'blend', name: 'Blend controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'alternate' },
            { value: 2, stateId: 'blend' }] } },
      ], transitions: [] });
    const playbackPlanCases = [{ ...detailedCases[0]!, duration: 0.75, events: [], expect: { ...detailedCases[0]!.expect, blends: [{
      ...detailedCases[0]!.expect.blends[0]!, blendSpace: { ...detailedCases[0]!.expect.blends[0]!.blendSpace,
        phaseSync: { stateIds: ['idle', 'alternate', 'blend'], maxCircularPhaseDifference: 0 },
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0 },
        clips: [{ stateId: 'idle', playback: { timeSeconds: { min: 0.49, max: 0.51 },
          normalizedPhase: { min: 0.49, max: 0.51 }, playbackSpeed: { min: 0.9, max: 1.1 }, isPlaying: true } }] },
    }] } }];
    const playbackPreview = await f.history.preview('Blend source clock release gate', clockGraph.id, playbackPlanCases);
    assert.deepEqual(playbackPreview.coveragePreview.blendCoverage.blendSpace.controllers[0]!.phaseSyncSources, ['alternate', 'blend', 'idle']);
    assert.equal(playbackPreview.coveragePreview.blendCoverage.blendSpace.controllers[0]!.phaseSyncAssertions, 1);
    const invalidPhaseSyncCases = playbackPlanCases.map(testCase => ({ ...testCase, expect: { ...testCase.expect, blends: [{
      ...testCase.expect.blends[0]!, blendSpace: { ...testCase.expect.blends[0]!.blendSpace,
        phaseSync: { stateIds: ['missingSource', 'idle'], maxCircularPhaseDifference: 0 } },
    }] } }));
    await assert.rejects(() => f.history.preview('Invalid phase-lock sources', clockGraph.id, invalidPhaseSyncCases),
      /phase-sync source state missingSource is not a sample of controller blend/i,
      'review preview must reject misspelled or unrelated source IDs before a plan can be saved');
    const playbackPlan = await f.history.create('Blend source clock release gate', clockGraph.id, playbackPlanCases, playbackPreview.draftFingerprint);
    const playbackRun = await f.history.run(playbackPlan.id, playbackPlan.planFingerprint);
    const playbackCase = playbackRun.report.cases[0] as unknown as { status: string;
      blendChecks: Array<{ status: string; checks: Array<{ property: string; observed: unknown; passed: boolean }> }> };
    assert.equal(playbackCase.status, 'passed');
    assert.deepEqual(playbackCase.blendChecks[0]!.checks.map(check => [check.property, check.observed, check.passed]), [
      ['blendSpace.parameterValue', 0.5, true],
      ['blendSpace.phaseSync', { sourcePhases: [{ stateId: 'idle', normalizedPhase: 0.5, isPlaying: true,
        poseContributionWeight: 0.5, eligibility: 'eligible' },
        { stateId: 'alternate', normalizedPhase: 0.5, isPlaying: true, poseContributionWeight: 0.5, eligibility: 'eligible' },
        { stateId: 'blend', normalizedPhase: 0.5, isPlaying: true, poseContributionWeight: 0, eligibility: 'eligible' }], maxCircularPhaseDifference: 0,
        worstPair: { stateIds: ['idle', 'alternate'], circularDifference: 0 } }, true],
      ['blendSpace.phaseSyncThroughout', { maxCircularPhaseDifference: 0, worstAt: 0,
        worstPair: { stateIds: ['alternate', 'idle'], circularDifference: 0 }, worstInterval: null,
        controllerActiveSampleCount: 24, coverageStatus: 'complete',
        comparableSampleCount: 24, incompleteSampleCount: 0, controllerActiveIntervalCount: 23,
        incompleteIntervalCount: 0, unevaluableIntervalCount: 0, interpolatedIntervalCount: 23,
        measurementBasis: 'sampled_points_and_constant_speed_intervals' }, true],
      ['blendSpace.playback.timeSeconds:idle', 0.5, true],
      ['blendSpace.playback.normalizedPhase:idle', 0.5, true],
      ['blendSpace.playback.playbackSpeed:idle', 1, true],
      ['blendSpace.playback.isPlaying:idle', true, true],
    ], 'persisted timeline runs must evaluate source-channel clock gates against the pinned graph recipes');
    assert.equal((await f.history.history(playbackPlan.id)).runs[0]!.id, playbackRun.id,
      'the passing playback-clock gate should be retained in immutable timeline run history');
    const phaseRegressionCases = playbackPlanCases.map(testCase => ({ ...testCase, expect: { ...testCase.expect, blends: [{
      ...testCase.expect.blends[0]!, blendSpace: { ...testCase.expect.blends[0]!.blendSpace,
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.01 },
        clips: [{ stateId: 'idle', playback: { normalizedPhase: { min: 0.8, max: 0.9 } } }] },
    }] } }));
    const phaseRegressionPreview = await f.history.preview('Blend source phase regression', clockGraph.id, phaseRegressionCases);
    const phaseRegressionPlan = await f.history.create('Blend source phase regression', clockGraph.id,
      phaseRegressionCases, phaseRegressionPreview.draftFingerprint);
    const phaseRegressionRun = await f.history.run(phaseRegressionPlan.id, phaseRegressionPlan.planFingerprint);
    assert.equal(phaseRegressionRun.report.cases[0]!.status, 'failed');
    const phaseComparison = await f.history.compare(playbackRun.id, phaseRegressionRun.id);
    const phaseChange = phaseComparison.cases[0]!.checkChanges.find(check =>
      check.expectation === 'blend:blend@0.5:blendSpace.playback.normalizedPhase:idle');
    assert.ok(phaseChange);
    assert.equal(phaseChange.kind, 'blend');
    assert.equal(phaseChange.status, 'regression');
    assert.deepEqual(phaseChange.before?.observed, 0.5);
    assert.deepEqual(phaseChange.after?.observed, 0.5);
    assert.equal(phaseChange.expectedChanged, true);
    assert.equal(phaseChange.observedChanged, undefined,
      'comparison omits an observed-change flag when the measured source phase stayed exactly the same');
    const phaseDriftChange = phaseComparison.cases[0]!.checkChanges.find(check =>
      check.expectation === 'blend:blend@0.5:blendSpace.phaseSyncThroughout');
    assert.ok(phaseDriftChange);
    assert.equal(phaseDriftChange.expectedChanged, true,
      'comparison reports a tolerance change independently from observed whole-run drift');
    assert.deepEqual(phaseDriftChange.observedNumericDeltas, { comparableSampleCount: 0,
      incompleteSampleCount: 0, controllerActiveSampleCount: 0, controllerActiveIntervalCount: 0, incompleteIntervalCount: 0,
      unevaluableIntervalCount: 0, interpolatedIntervalCount: 0, maxCircularPhaseDifference: 0, worstAt: 0 },
      'structured blend measurements expose field-level deltas for drift, evidence coverage, and worst-case time');

    const noBlendCase = [{ id: 'no-blend-coverage', name: 'No blend check', duration: 1, events: [],
      expect: { finalState: 'blend' } }];
    const noBlendPreview = await f.history.preview('Missing BlendSpace coverage', graph.id, noBlendCase);
    assert.deepEqual(noBlendPreview.coveragePreview.blendCoverage.blendSpace.uncoveredControllerIds, ['blend']);

    const directionalGraph = await f.graphs.save({ kind: 'animation_graph', name: 'Directional BlendSpace Coverage', entryState: 'blend', sampleRate: 20,
      parameters: [
        { name: 'moveX', type: 'number', defaultValue: 0, min: -1, max: 1 },
        { name: 'moveY', type: 'number', defaultValue: 0, min: -1, max: 1 },
      ],
      states: [
        { id: 'idle', name: 'Center', animationId: f.idle.id, speed: 1 },
        { id: 'attack', name: 'Right', animationId: f.idle.id, speed: 1 },
        { id: 'blend', name: 'Directional controller', animationId: f.idle.id, speed: 1,
          blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
            { x: 0, y: 0, stateId: 'blend' }, { x: 1, y: 0, stateId: 'attack' }, { x: 0, y: 1, stateId: 'idle' },
          ] } },
      ], transitions: [] });
    const directionalPreview = await f.history.preview('Directional ramp coverage', directionalGraph.id, [{
      id: 'diagonal-ramp', name: 'Ramp diagonally', duration: 0.5,
      events: [{ at: 0, kind: 'ramp_parameters' as const, values: { moveX: 1, moveY: 1 }, duration: 0.5,
        easing: 'smoothstep' as const }],
      expect: { blends: [{ at: 0.25, stateId: 'blend', blendSpace: {
        parameterValues: { x: { min: 0.5, max: 0.5 }, y: { min: 0.5, max: 0.5 } },
      } }] },
    }]);
    const directionalController = directionalPreview.coveragePreview.blendCoverage.blendSpace.controllers[0]!;
    assert.equal(directionalController.dimension, '2d');
    assert.deepEqual(directionalController.parameters, { x: 'moveX', y: 'moveY' });
    assert.equal(directionalController.parameterAssertions, 1);
    assert.deepEqual(directionalPreview.coveragePreview.parameterRampCoverage.parameterNames, ['moveX', 'moveY']);
    assert.deepEqual(directionalPreview.coveragePreview.parameterRampCoverage.easingKinds, ['smoothstep']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline plans gate BlendSpace stop and re-entry without a source-weight pop', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Blend Stop-Reentry', entryState: 'idle', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 10, min: 0, max: 10 }],
      states: [{ id: 'idle', name: 'Locomotion', animationId: f.idle.id, speed: 1,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
      { id: 'attack', name: 'Running source', animationId: f.recovery.id, speed: 1 }],
      transitions: [{ id: 'leaveBlend', from: 'idle', to: 'attack', trigger: 'Leave', blendSeconds: 0.4 },
        { id: 'returnBlend', from: 'attack', to: 'idle', trigger: 'Return', blendSeconds: 0.4 }] });
    const cases = [{ id: 'source-reentry', name: 'Source resumes from its current stop-fade weight', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger' as const, trigger: 'Leave' }, { at: 0.2, kind: 'trigger' as const, trigger: 'Return' }],
      expect: { blends: [
        { at: 0.2, stateId: 'idle', blendSpace: { clips: [{ stateId: 'attack',
          poseContributionWeight: { min: 0.75, max: 0.75 }, targetPoseContributionWeight: { min: 1, max: 1 } }] } },
        { at: 0.25, stateId: 'idle', blendSpace: { clips: [{ stateId: 'attack',
          poseContributionWeight: { min: 0.781249, max: 0.781251 }, targetPoseContributionWeight: { min: 1, max: 1 } }] } },
      ] } }];
    const preview = await f.history.preview('Blend source stop-reentry gate', graph.id, cases);
    const plan = await f.history.create('Blend source stop-reentry gate', graph.id, cases, preview.draftFingerprint);
    const run = await f.history.run(plan.id, plan.planFingerprint);
    assert.equal(run.report.status, 'passed', JSON.stringify(run.report.cases[0]?.failures));
    const checks = (run.report.cases[0] as unknown as { blendChecks: Array<{ at: number; checks: Array<{ property: string; observed: unknown; passed: boolean }> }> }).blendChecks;
    assert.deepEqual(checks.map(check => [check.at, check.checks.map(item => [item.property, item.observed, item.passed])]), [
      [0.2, [['blendSpace.poseContributionWeight:attack', 0.75, true], ['blendSpace.targetPoseContributionWeight:attack', 1, true]]],
      [0.25, [['blendSpace.poseContributionWeight:attack', 0.78125, true], ['blendSpace.targetPoseContributionWeight:attack', 1, true]]],
    ]);
    const incorrectCases = [{ ...cases[0]!, expect: { blends: [{ ...cases[0]!.expect.blends[0]!, blendSpace: {
      clips: [{ stateId: 'attack', poseContributionWeight: { min: 0.99, max: 1 } }],
    } }] } }];
    const incorrectPreview = await f.history.preview('Detect Blend source re-entry pop', graph.id, incorrectCases);
    const incorrectPlan = await f.history.create('Detect Blend source re-entry pop', graph.id, incorrectCases, incorrectPreview.draftFingerprint);
    const incorrectRun = await f.history.run(incorrectPlan.id, incorrectPlan.planFingerprint);
    assert.equal(incorrectRun.report.status, 'failed');
    const comparison = await f.history.compare(run.id, incorrectRun.id);
    const regression = comparison.cases[0]?.checkChanges.find(check => check.expectation === 'blend:idle@0.2:blendSpace.poseContributionWeight:attack');
    assert.equal(regression?.status, 'regression', 'saved history should make a BlendSpace re-entry weight regression visible');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline plans pin ramped BlendSpace trajectories and compare intermediate-weight regressions', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Ramped Locomotion Regression', entryState: 'idle', sampleRate: 20,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Locomotion controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'moving' }] } },
        { id: 'moving', name: 'Moving source', animationId: f.recovery.id, speed: 1 },
      ], transitions: [] });
    const makeCases = (rampDuration: number) => [{ id: 'speed-up', name: 'Blend ramps from idle into motion', duration: 1,
      events: [{ at: 0, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: rampDuration, easing: 'linear' as const }],
      expect: { blends: [
        { at: 0.25, stateId: 'idle', blendSpace: { parameterValue: { min: 2.5, max: 2.5 }, clips: [
          { stateId: 'idle', weight: { min: 0.75, max: 0.75 } }, { stateId: 'moving', weight: { min: 0.25, max: 0.25 } },
        ] } },
        { at: 0.75, stateId: 'idle', blendSpace: { parameterValue: { min: 7.5, max: 7.5 }, clips: [
          { stateId: 'idle', weight: { min: 0.25, max: 0.25 } }, { stateId: 'moving', weight: { min: 0.75, max: 0.75 } },
        ] } },
      ] } }];

    const cases = makeCases(1);
    const preview = await f.history.preview('Ramped locomotion trajectory', graph.id, cases);
    assert.deepEqual(preview.coveragePreview.parameterRampCoverage, {
      count: 1, parameterNames: ['speed'], easingKinds: ['linear'],
      ramps: [{ caseId: 'speed-up', inputIndex: 0, at: 0, duration: 1, authoredEndAt: 1, simulatedEndAt: 1,
        startsWithinHorizon: true, easing: 'linear',
        parameterNames: ['speed'], targetValues: { speed: 10 }, potentialInterruptions: [] }],
      incompleteAssertions: [], incompleteAssertionCount: 0, lifecycleAssertions: [], lifecycleAssertionCount: 0,
    }, 'plan preview should expose ramp duration, targets, easing, and possible interruption events');
    assert.deepEqual(preview.coveragePreview.blendCoverage.blendSpace.controllers[0]?.sampleTimes, [0.25, 0.75],
      'preview coverage should include every intermediate blend assertion');
    const plan = await f.history.create('Ramped locomotion trajectory', graph.id, cases, preview.draftFingerprint);
    const run = await f.history.run(plan.id, plan.planFingerprint);
    assert.equal(run.report.status, 'passed');
    const passingRampCase = run.report.cases[0] as unknown as { blendChecks: Array<{ status: string }> };
    assert.deepEqual(passingRampCase.blendChecks.map(check => check.status), ['passed', 'passed']);

    const changedCases = makeCases(0.5);
    const changedPreview = await f.history.preview('Ramped locomotion trajectory changed', graph.id, changedCases);
    const changedPlan = await f.history.create('Ramped locomotion trajectory changed', graph.id, changedCases, changedPreview.draftFingerprint);
    const changedRun = await f.history.run(changedPlan.id, changedPlan.planFingerprint);
    assert.equal(changedRun.report.status, 'failed', 'shortening the ramp should violate its pinned intermediate trajectory');
    const comparison = await f.history.compare(run.id, changedRun.id);
    const comparedCase = comparison.cases[0] as { trend: string; checkChanges: Array<{ expectation: string; status: string;
      before: { observed: unknown } | null; after: { observed: unknown } | null }> };
    assert.equal(comparedCase.trend, 'regression');
    const midpointRegression = comparedCase.checkChanges.find(check =>
      check.expectation === 'blend:idle@0.75:blendSpace.clipWeight:moving');
    assert.equal(midpointRegression?.status, 'regression');
    assert.equal(midpointRegression?.before?.observed, 0.75);
    assert.equal(midpointRegression?.after?.observed, 1);

    const horizonCases = (rampDuration: number) => [{ id: 'ramp-horizon', name: 'Ramp remains active at horizon', duration: 0.25,
      events: [{ at: 0, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: rampDuration, easing: 'linear' as const }],
      expect: { incompleteParameterRamps: [{ inputIndex: 0, simulatedProgress: { min: 0.249999, max: 0.250001 },
        parameters: [{ name: 'speed', currentValue: { min: 2.49999, max: 2.50001 }, targetValue: { min: 10, max: 10 } }] }],
        parameterRampLifecycle: [{ inputIndex: 0, status: 'active' as const,
          parameters: [{ name: 'speed', status: 'active' as const, observedValue: { min: 2.49999, max: 2.50001 } }] }] } }];
    const horizonDraft = await f.history.preview('Ramp horizon contract', graph.id, horizonCases(1));
    assert.equal(horizonDraft.coveragePreview.parameterRampCoverage.incompleteAssertionCount, 1);
    assert.equal(horizonDraft.coveragePreview.parameterRampCoverage.lifecycleAssertionCount, 1);
    assert.deepEqual(horizonDraft.coveragePreview.parameterRampCoverage.incompleteAssertions[0]?.assertedProperties,
      ['simulatedProgress', 'parameter:speed:currentValue', 'parameter:speed:targetValue']);
    const horizonPlan = await f.history.create('Ramp horizon contract', graph.id, horizonCases(1), horizonDraft.draftFingerprint);
    const horizonRun = await f.history.run(horizonPlan.id, horizonPlan.planFingerprint);
    assert.equal(horizonRun.report.status, 'passed');
    assert.equal(animationGraphTimelineCaseReportSchema.parse(horizonRun.report.cases[0]).incompleteParameterRampChecks?.[0]?.status, 'passed');
    assert.equal(animationGraphTimelineCaseReportSchema.parse(horizonRun.report.cases[0]).parameterRampLifecycleChecks?.[0]?.status, 'passed');
    assert.equal(animationGraphTimelineCaseReportSchema.parse(horizonRun.report.cases[0]).parameterRampLifecycle?.[0]?.status, 'active');
    const forgedLifecycleCase = structuredClone(horizonRun.report.cases[0]) as Record<string, unknown>;
    const forgedLifecycle = forgedLifecycleCase.parameterRampLifecycle as Array<Record<string, unknown>>;
    forgedLifecycle[0] = { ...forgedLifecycle[0], status: 'completed' };
    assert.throws(() => animationGraphTimelineCaseReportSchema.parse(forgedLifecycleCase), /Ramp lifecycle summaries must agree/);
    const forgedRampCase = structuredClone(horizonRun.report.cases[0]) as Record<string, unknown>;
    const forgedChecks = forgedRampCase.incompleteParameterRampChecks as Array<Record<string, unknown>>;
    forgedChecks[0] = { ...forgedChecks[0], status: 'failed', failureReason: 'incomplete_ramp_expectation_mismatch' };
    assert.throws(() => animationGraphTimelineCaseReportSchema.parse(forgedRampCase), /Ramp-gate status and failure reason/);

    const changedHorizonCases = horizonCases(0.5);
    const changedHorizonDraft = await f.history.preview('Ramp horizon contract revision', graph.id, changedHorizonCases, horizonPlan.id);
    const changedHorizonPlan = await f.history.create('Ramp horizon contract revision', graph.id, changedHorizonCases,
      changedHorizonDraft.draftFingerprint, horizonPlan.id);
    const changedHorizonRun = await f.history.run(changedHorizonPlan.id, changedHorizonPlan.planFingerprint);
    assert.equal(changedHorizonRun.report.status, 'failed', 'the endpoint gate must detect slower ramp progress at the horizon');
    const horizonComparison = await f.history.compare(horizonRun.id, changedHorizonRun.id);
    const endpointRegression = horizonComparison.cases[0]?.checkChanges.find(check =>
      check.expectation === 'incompleteParameterRamp:0:simulatedProgress');
    assert.equal(endpointRegression?.status, 'regression', 'saved-plan history should compare ramp horizon checks as regression evidence');
    const lifecycleRegression = horizonComparison.cases[0]?.checkChanges.find(check =>
      check.expectation === 'parameterRampLifecycle:0:parameter:speed:observedValue');
    assert.equal(lifecycleRegression?.status, 'regression', 'saved-plan history should compare lifecycle channel values as regression evidence');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline plan identity binds source-animation fingerprints and source changes block comparable calibration deltas', async () => {
  const f = await fixture();
  try {
    const originalPreview = await f.history.preview('Source-pinned calibration', f.graph.id, f.cases);
    assert.equal(originalPreview.fingerprintVersion, 2);
    const originalPlan = await f.history.create('Source-pinned calibration', f.graph.id, f.cases, originalPreview.draftFingerprint);
    const originalRun = await f.history.run(originalPlan.id, originalPlan.planFingerprint);

    const assetPath = join(f.animations.directory, `${f.idle.id}.json`);
    const storedAsset = JSON.parse(await readFile(assetPath, 'utf8')) as Record<string, unknown>;
    const changedRecipe = structuredClone(f.idle.recipe);
    if (changedRecipe.kind !== 'animation') throw new Error('Expected an animation source fixture.');
    const torso = changedRecipe.tracks.find(track => track.joint === 'UpperTorso');
    assert.ok(torso);
    torso.keys[1]!.rotation[0]! += 1;
    storedAsset.recipe = changedRecipe;
    await writeFile(assetPath, `${JSON.stringify(storedAsset, null, 2)}\n`);
    const graphRecordPath = join(f.graphs.directory, `${f.graph.id}.json`);
    const storedGraph = JSON.parse(await readFile(graphRecordPath, 'utf8')) as { sourceFingerprints: string[]; [key: string]: unknown };
    storedGraph.sourceFingerprints[0] = fingerprint(changedRecipe);
    await writeFile(graphRecordPath, `${JSON.stringify(storedGraph, null, 2)}\n`);

    const changedPreview = await f.history.preview('Source-pinned calibration', f.graph.id, f.cases);
    assert.equal(changedPreview.graphFingerprint, originalPreview.graphFingerprint,
      'the graph structure is intentionally unchanged while its referenced recipe fingerprint changes');
    assert.notDeepEqual(changedPreview.sourceFingerprints, originalPreview.sourceFingerprints);
    assert.notEqual(changedPreview.draftFingerprint, originalPreview.draftFingerprint,
      'the reviewed draft fingerprint must include source-animation content');
    assert.notEqual(changedPreview.proposedPlanId, originalPreview.proposedPlanId);
    await assert.rejects(() => f.history.create('Source-pinned calibration', f.graph.id, f.cases, originalPreview.draftFingerprint),
      /pinned graph or source animation content changed/i);

    const changedPlan = await f.history.create('Source-pinned calibration', f.graph.id, f.cases, changedPreview.draftFingerprint);
    assert.deepEqual(changedPlan.sourceFingerprints, changedPreview.sourceFingerprints);
    const changedRun = await f.history.run(changedPlan.id, changedPlan.planFingerprint);
    const comparison = await f.history.compare(originalRun.id, changedRun.id);
    assert.equal(comparison.sourceComparability, 'different_sources');
    assert.equal(comparison.comparability, 'changed_sources');
    assert.deepEqual(comparison.before.sourceFingerprints, originalPlan.sourceFingerprints);
    assert.deepEqual(comparison.after.sourceFingerprints, changedPlan.sourceFingerprints);
    assert.equal(comparison.studioBlendEvidenceComparability, 'both_missing');
    assert.equal(comparison.studioBlendCalibrationDelta.reason, 'missing_calibration_samples');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline plan preview summarizes and fingerprints rotation diagnostic thresholds', async () => {
  const f = await fixture();
  try {
    const cases = f.cases.map(testCase => ({ ...testCase, expect: { ...testCase.expect,
      poses: [{ ...testCase.expect.poses[0]!, rotationBlendConfidence: { min: 0.6, max: 1 }, rotationInfluence: { min: 0.9 } }] } }));
    const preview = await f.history.preview('Rotation diagnostics', f.graph.id, cases);
    assert.deepEqual(preview.coveragePreview.poseCoverage.diagnosticAssertions, { rotationBlendConfidence: 1, rotationInfluence: 1 });
    const plan = await f.history.create('Rotation diagnostics', f.graph.id, cases, preview.draftFingerprint);
    assert.deepEqual(plan.cases[0]!.expect.poses?.[0]?.rotationBlendConfidence, { min: 0.6, max: 1 });
    assert.deepEqual(plan.cases[0]!.expect.poses?.[0]?.rotationInfluence, { min: 0.9 });
    const changedCases = cases.map(testCase => ({ ...testCase, expect: { ...testCase.expect,
      poses: [{ ...testCase.expect.poses[0]!, rotationInfluence: { min: 0.95 } }] } }));
    await assert.rejects(() => f.history.create('Rotation diagnostics', f.graph.id, changedCases, preview.draftFingerprint), /different immutable plan request/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline plan preview summarizes and fingerprints source-level BlendSpace pose assertions', async () => {
  const f = await fixture();
  try {
    const alternate = await f.animations.save(animationPreset('idle', 'Timeline Blend Alternate', 1, 0.2));
    const blendGraph = await f.graphs.save({ kind: 'animation_graph', name: 'Timeline source pose graph', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 }], states: [
        { id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate', animationId: alternate.id, speed: 1 },
        { id: 'blend', name: 'Blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 0.5, stateId: 'alternate' }, { value: 1, stateId: 'blend' }] } },
      ], transitions: [] });
    const cases = [{ ...f.cases[0]!, expect: { ...f.cases[0]!.expect, poses: [{ at: 0.05, joint: 'UpperTorso', blendSourcePoses: [{
      controllerStateId: 'blend', sourceStateId: 'alternate', effectiveWeight: { min: 0.4, max: 0.6 },
      throughout: { start: 0.05, end: 0.15, sampleRateHz: 10, effectiveWeight: { min: 0.3, max: 0.7 },
        maxSampleGapSeconds: 0.1, maxLinearSpeedStudsPerSecond: 100000 },
      expectedPosition: [1, 0, 0] as [number, number, number], positionToleranceStuds: 0.1,
    }] }] } }];
    const preview = await f.history.preview('Source pose regression', blendGraph.id, cases);
    assert.deepEqual(preview.coveragePreview.poseCoverage.blendSourceThroughoutWindows, [{ caseId: 'attack-release', joint: 'UpperTorso',
      controllerStateId: 'blend', sourceStateId: 'alternate', start: 0.05, end: 0.15, sampleRateHz: 10,
      effectiveWeight: { min: 0.3, max: 0.7 }, maxSampleGapSeconds: 0.1, maxLinearSpeedStudsPerSecond: 100000 }]);
    assert.deepEqual(preview.coveragePreview.poseCoverage.sampleTimes, [0.05, 0.15]);
    assert.deepEqual(preview.coveragePreview.poseCoverage.blendSourcePoseAssertions, { assertions: 1, cases: [{ caseId: 'attack-release',
      joint: 'UpperTorso', at: 0.05, controllerStateId: 'blend', sourceStateId: 'alternate', effectiveWeight: { min: 0.4, max: 0.6 },
      throughout: { start: 0.05, end: 0.15, sampleRateHz: 10, effectiveWeight: { min: 0.3, max: 0.7 },
        maxSampleGapSeconds: 0.1, maxLinearSpeedStudsPerSecond: 100000 },
      expectedPosition: [1, 0, 0], positionToleranceStuds: 0.1 }] });
    assert.deepEqual(preview.coveragePreview.poseCoverage.sourceReferenceAssertions, { references: [{ caseId: 'attack-release',
      joint: 'UpperTorso', at: 0.05, controllerStateId: 'blend', sourceStateId: 'alternate', expectedChannel: true,
      sourceIsSample: true, hasJointChannel: true, valid: true }], invalid: [] });
    assert.deepEqual(preview.coveragePreview.poseCoverage.blendSourceCoverage, { assertions: 1, cases: [{ caseId: 'attack-release',
      joint: 'UpperTorso', at: 0.05, controllerStateId: 'blend', sourceStateId: 'alternate',
      checksEffectiveWeight: true, checksLocalPosition: true, checksLocalRotation: false,
      throughout: { start: 0.05, end: 0.15, sampleRateHz: 10, uniformSampleCount: 2, criticalTimesAddedAtRun: true,
        checksEffectiveWeight: true, checksMaximumSampleGap: true, checksMaximumLinearSpeed: true,
        checksMaximumAngularSpeed: false, checksMaximumLinearStep: false, checksMaximumAngularStep: false } }] });
    const plan = await f.history.create('Source pose regression', blendGraph.id, cases, preview.draftFingerprint);
    assert.deepEqual(plan.cases[0]!.expect.poses?.[0]?.blendSourcePoses?.[0]?.expectedPosition, [1, 0, 0]);
    const invalidControllerCases = [{ ...cases[0]!, expect: { ...cases[0]!.expect, poses: [{ ...cases[0]!.expect.poses![0]!,
      blendSourcePoses: undefined, missingBlendChannels: [{ controllerStateId: 'blend', sourceStateId: 'alternate' }] }] } }];
    const invalidControllerPreview = await f.history.preview('Invalid source ref', f.graph.id, invalidControllerCases);
    assert.equal(invalidControllerPreview.coveragePreview.valid, false);
    assert.equal(invalidControllerPreview.coveragePreview.blockers.length, 1);
    await assert.rejects(() => f.history.create('Invalid source ref', f.graph.id, invalidControllerCases, invalidControllerPreview.draftFingerprint),
      /controller_not_blend_space.*Select a BlendSpace controller and one of its actual source state IDs/i);
    const invalidSource = [{ ...cases[0]!, expect: { ...cases[0]!.expect, poses: [{ ...cases[0]!.expect.poses![0]!,
      blendSourcePoses: [{ ...cases[0]!.expect.poses![0]!.blendSourcePoses![0]!, sourceStateId: 'not-a-source' }] }] } }];
    const invalidPreview = await f.history.preview('Invalid source ref', blendGraph.id, invalidSource);
    assert.equal(invalidPreview.coveragePreview.valid, false);
    assert.deepEqual(invalidPreview.coveragePreview.blockers, [{ caseId: 'attack-release', joint: 'UpperTorso', at: 0.05,
      controllerStateId: 'blend', sourceStateId: 'not-a-source', expectedChannel: true,
      reason: 'source_not_in_controller', recommendedAction: 'Select a BlendSpace controller and one of its actual source state IDs.' }]);
    await assert.rejects(() => f.history.create('Invalid source ref', blendGraph.id, invalidSource, invalidPreview.draftFingerprint),
      /source_not_in_controller.*Select a BlendSpace controller and one of its actual source state IDs/i);
    const missingChannelAsset = await f.animations.save({ ...animationPreset('idle', 'Timeline Missing UpperTorso', 1, 0.2),
      tracks: animationPreset('idle', 'Timeline Temp', 1, 0.2).tracks.filter(track => track.joint !== 'UpperTorso') });
    const missingChannelGraph = await f.graphs.save({ kind: 'animation_graph', name: 'Missing source joint graph', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 }], states: [
        { id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate', animationId: missingChannelAsset.id, speed: 1 },
        { id: 'blend', name: 'Blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 0.5, stateId: 'alternate' }, { value: 1, stateId: 'blend' }] } },
      ], transitions: [] });
    const missingChannelPreview = await f.history.preview('Missing source channel', missingChannelGraph.id, cases);
    assert.equal(missingChannelPreview.coveragePreview.valid, false);
    assert.deepEqual(missingChannelPreview.coveragePreview.blockers, [{ caseId: 'attack-release', joint: 'UpperTorso', at: 0.05,
      controllerStateId: 'blend', sourceStateId: 'alternate', expectedChannel: true, reason: 'source_joint_channel_missing',
      recommendedAction: 'Author this joint in the source animation, or use missingBlendChannels if its absence is intentional.' }]);
    await assert.rejects(() => f.history.create('Missing source channel', missingChannelGraph.id, cases, missingChannelPreview.draftFingerprint),
      /source_joint_channel_missing.*Author this joint in the source animation, or use missingBlendChannels/i);
    const wrongMissingCases = [{ ...f.cases[0]!, expect: { poses: [{ at: 0.05, joint: 'UpperTorso',
      missingBlendChannels: [{ controllerStateId: 'blend', sourceStateId: 'alternate' }] }] } }];
    const wrongMissingPreview = await f.history.preview('Wrong missing-channel declaration', blendGraph.id, wrongMissingCases);
    assert.deepEqual(wrongMissingPreview.coveragePreview.blockers, [{ caseId: 'attack-release', joint: 'UpperTorso', at: 0.05,
      controllerStateId: 'blend', sourceStateId: 'alternate', expectedChannel: false, reason: 'source_joint_channel_present',
      recommendedAction: 'Remove this missing-channel expectation or assert the source pose with blendSourcePoses.' }]);
    await assert.rejects(() => f.history.create('Wrong missing-channel declaration', blendGraph.id, wrongMissingCases, wrongMissingPreview.draftFingerprint),
      /source_joint_channel_present.*Remove this missing-channel expectation or assert the source pose with blendSourcePoses/i);

    const baseRecipe = animationPreset('idle', 'Source channel variants', 1, 0.2);
    const layerOnly = await f.animations.save({ ...baseRecipe, name: 'Layer-only UpperTorso',
      tracks: baseRecipe.tracks.filter(track => track.joint !== 'UpperTorso'),
      layers: [{ id: f.idle.id, name: 'UpperTorso override', blendMode: 'Override', weight: 0.6, enabled: true,
        tracks: baseRecipe.tracks.filter(track => track.joint === 'UpperTorso') }] });
    const disabledLayer = await f.animations.save({ ...baseRecipe, name: 'Disabled-layer UpperTorso',
      tracks: baseRecipe.tracks.filter(track => track.joint !== 'UpperTorso'),
      layers: [{ id: f.attack.id, name: 'Disabled UpperTorso override', blendMode: 'Override', weight: 1, enabled: false,
        tracks: baseRecipe.tracks.filter(track => track.joint === 'UpperTorso') }] });
    const zeroWeightLayer = await f.animations.save({ ...baseRecipe, name: 'Zero-layer UpperTorso',
      tracks: baseRecipe.tracks.filter(track => track.joint !== 'UpperTorso'),
      layers: [{ id: f.recovery.id, name: 'Zero UpperTorso override', blendMode: 'Override', weight: 0, enabled: true,
        tracks: baseRecipe.tracks.filter(track => track.joint === 'UpperTorso') }] });
    const rootMotion = await f.animations.save({ ...baseRecipe, name: 'Root-motion UpperTorso',
      tracks: baseRecipe.tracks.filter(track => track.joint !== 'UpperTorso'),
      rootMotion: baseRecipe.tracks.find(track => track.joint === 'UpperTorso') });
    const channelCases = (sourceStateId: string, expectMissing: boolean) => [{ ...f.cases[0]!, expect: {
      poses: [{ at: 0.05, joint: 'UpperTorso', ...(expectMissing
        ? { missingBlendChannels: [{ controllerStateId: 'blend', sourceStateId }] }
        : { blendSourcePoses: [{ controllerStateId: 'blend', sourceStateId, effectiveWeight: { min: 0 } }] }) }],
    } }];
    const variantGraphs = await Promise.all([layerOnly, disabledLayer, zeroWeightLayer, rootMotion].map(async asset => f.graphs.save({
      kind: 'animation_graph', name: `Graph ${asset.recipe.name}`, entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 }], states: [
        { id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate', animationId: asset.id, speed: 1 },
        { id: 'blend', name: 'Blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 0.5, stateId: 'alternate' }, { value: 1, stateId: 'blend' }] } },
      ], transitions: [] })));
    for (const [index, asset] of [layerOnly, disabledLayer, zeroWeightLayer, rootMotion].entries()) {
      const graph = variantGraphs[index]!;
      const expectsChannel = index === 0 || index === 3;
      const previewVariant = await f.history.preview(`Channel variant ${index}`, graph.id, channelCases('alternate', !expectsChannel));
      assert.equal(previewVariant.coveragePreview.valid, true, `variant ${index} should match its expected channel presence`);
      const created = await f.history.create(`Channel variant ${index}`, graph.id, channelCases('alternate', !expectsChannel), previewVariant.draftFingerprint);
      await assert.doesNotReject(() => f.history.run(created.id, created.planFingerprint));
    }
    const changed = [{ ...cases[0]!, expect: { ...cases[0]!.expect, poses: [{ at: 0.05, joint: 'UpperTorso', blendSourcePoses: [{
      controllerStateId: 'blend', sourceStateId: 'alternate', expectedPosition: [2, 0, 0] as [number, number, number], positionToleranceStuds: 0.1,
    }] }] } }];
    const changedPreview = await f.history.preview('Source pose regression', blendGraph.id, changed);
    assert.notEqual(changedPreview.draftFingerprint, preview.draftFingerprint);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline comparison separates increased event-order sensitivity and a newly failing gate', async () => {
  const f = await fixture();
  try {
    const baselineCases = [{ id: 'ordering-drift', name: 'Attack then marker return', duration: 1.1,
      events: [{ at: 0, kind: 'trigger' as const, trigger: 'Act' }],
      expect: { finalState: 'idle', maxEventOrderDivergences: 0,
        transitionIds: { mode: 'exact' as const, ids: ['act', 'release'] } } }];
    const candidateCases = [{ ...baselineCases[0]!,
      events: [...baselineCases[0]!.events, { at: 0.5, kind: 'trigger' as const, trigger: 'Release' }],
      expect: { ...baselineCases[0]!.expect, maxAmbiguousEventOrderingCollisions: 0 } }];
    const baselineDraft = await f.history.preview('Baseline ordering', f.graph.id, baselineCases);
    const baselinePlan = await f.history.create('Baseline ordering', f.graph.id, baselineCases, baselineDraft.draftFingerprint);
    const candidateDraft = await f.history.preview('Candidate ordering', f.graph.id, candidateCases);
    const candidatePlan = await f.history.create('Candidate ordering', f.graph.id, candidateCases, candidateDraft.draftFingerprint);
    const baselineRun = await f.history.run(baselinePlan.id, baselinePlan.planFingerprint);
    const candidateRun = await f.history.run(candidatePlan.id, candidatePlan.planFingerprint);

    assert.equal(baselineRun.report.status, 'passed');
    assert.equal(candidateRun.report.status, 'failed', 'the explicit zero-collision gate should fail the ordering-sensitive case');
    const comparison = await f.history.compare(baselineRun.id, candidateRun.id);
    assert.equal(comparison.cases[0]!.trend, 'regression');
    assert.deepEqual(comparison.cases[0]!.eventOrdering, {
      diagnosticsStatus: 'changed', beforeAmbiguousCollisionCount: 0, afterAmbiguousCollisionCount: 1,
      ambiguousCollisionDelta: 1, gateStatus: 'added_failure', gateThresholdChange: 'added', gateOutcomeChange: 'failed', beforeGate: null,
      afterGate: { status: 'failed', maximumAllowedCollisions: 0, observedCollisions: 1 },
    });
    assert.deepEqual(comparison.cases[0]!.eventOrderSensitivity, {
      diagnosticsStatus: 'changed', beforeDivergenceCount: 0, afterDivergenceCount: 2, divergenceDelta: 2,
      gateStatus: 'regression', gateThresholdChange: 'unchanged', gateOutcomeChange: 'regression',
      beforeGate: { status: 'passed', maximumAllowedDivergences: 0, observedDivergences: 0, sampleComparisonComplete: true },
      afterGate: { status: 'failed', maximumAllowedDivergences: 0, observedDivergences: 2, sampleComparisonComplete: true },
    });
    assert.equal(comparison.summary.changedEventOrderingDiagnostics, 1);
    assert.equal(comparison.summary.increasedEventOrderingCollisionCases, 1);
    assert.equal(comparison.summary.eventOrderingGateRegressions, 1);
    assert.equal(comparison.summary.tightenedEventOrderingGates, 0);
    assert.equal(comparison.summary.changedEventOrderSensitivityDiagnostics, 1);
    assert.equal(comparison.summary.increasedEventOrderDivergenceCases, 1);
    assert.equal(comparison.summary.eventOrderSensitivityGateRegressions, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline plans support immutable child revisions and reject stale drafts, source assets and parent history', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Timeline parent', f.graph.id, f.cases);
    await assert.rejects(() => f.history.create('Wrong name', f.graph.id, f.cases, preview.draftFingerprint), /differs from the reviewed preview/i);
    const parent = await f.history.create('Timeline parent', f.graph.id, f.cases, preview.draftFingerprint);
    const childCases = [{ ...f.cases[0]!, name: 'Tightened marker bound', expect: { ...f.cases[0]!.expect,
      markers: [{ name: 'Release', minCount: 1, maxCount: 1, window: { start: 0.49, end: 0.51 } }] } }];
    const childPreview = await f.history.preview('Timeline child', f.graph.id, childCases, parent.id);
    const child = await f.history.create('Timeline child', f.graph.id, childCases, childPreview.draftFingerprint, parent.id);
    assert.equal(child.parent?.id, parent.id);
    assert.equal(child.revision, parent.revision + 1);
    await assert.rejects(() => f.history.run(parent.id, 'f'.repeat(64)), /differs from reviewed expectation/i);
    const graphRecordPath = join(f.root, 'graphs', `${f.graph.id}.json`);
    const graphRecord = JSON.parse(await readFile(graphRecordPath, 'utf8')) as { graph: { states: { animationId: string }[] } };
    const sourcePath = join(f.root, 'library', `${graphRecord.graph.states[0]!.animationId}.json`);
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as { recipe: { name: string } };
    source.recipe.name = 'Changed after plan review';
    await writeFile(sourcePath, JSON.stringify(source));
    assert.equal((await f.history.read(child.id)).graphStatus, 'unavailable');
    await assert.rejects(() => f.history.run(child.id), /stale source assets/i);
    assert.deepEqual(await readdir(join(f.root, 'timeline-history', 'plans')).then(names => names.length), 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Studio-bound temporal run history compares same-rig per-state pose metric drift', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Rig-bound timeline', f.graph.id, f.cases);
    const plan = await f.history.create('Rig-bound timeline', f.graph.id, f.cases, preview.draftFingerprint);
    const gatedCases = f.cases.map(testCase => ({ ...testCase, expect: { ...testCase.expect,
      poses: testCase.expect.poses?.map(pose => ({ ...pose, studioCalibrationTolerance: { maxPositionErrorStuds: 0.01 } })) } }));
    const gatedPreview = await f.history.preview('Missing Studio calibration should block release', f.graph.id, gatedCases);
    assert.deepEqual(gatedPreview.coveragePreview.poseCoverage.studioCalibrationGate, {
      assertions: 1, contracts: [{ caseId: 'attack-release', joint: 'UpperTorso', at: 0.05, throughout: null,
        limits: { maxPositionErrorStuds: 0.01 } }], missingStudioEvidence: 'blocks_release',
    });
    const gatedPlan = await f.history.create('Missing Studio calibration should block release', f.graph.id, gatedCases, gatedPreview.draftFingerprint);
    const withoutStudio = await f.history.run(gatedPlan.id, gatedPlan.planFingerprint);
    assert.equal(withoutStudio.report.status, 'passed');
    assert.equal(withoutStudio.studioCalibrationGate?.status, 'not_run');
    assert.equal(withoutStudio.studioCalibrationGate?.checks[0]?.notRunReason, 'evidence_not_supplied');
    assert.deepEqual(withoutStudio.studioCalibrationGate?.checks[0]?.sampleChecks, [{ at: 0.05, status: 'not_run', notRunReason: 'evidence_not_supplied' }]);
    assert.equal(withoutStudio.releaseStatus, 'failed');
    const unavailableHandoff = animationGraphTimelineNextAction(withoutStudio);
    assert.equal(unavailableHandoff.status, 'native_evidence_unavailable');
    assert.equal(unavailableHandoff.action, 'repeat_same_plan_with_live_studio');
    assert.equal(unavailableHandoff.samePlanRetryRecommended, true);
    assert.deepEqual(unavailableHandoff.notRunReasons, ['evidence_not_supplied']);
    const savedGraph = await f.graphs.get(f.graph.id);
    const trace = runAnimationGraphTimelineSuite(savedGraph.graph, { [f.idle.id]: f.idle.recipe, [f.attack.id]: f.attack.recipe },
      { cases: f.cases }, { includeStudioCalibrationTrace: true }).studioCalibrationTrace!;
    const expectedSample = trace.find(item => item.caseId === 'attack-release' && item.at === 0.05)!;
    const expectedJoint = expectedSample.joints.find(item => item.joint === 'UpperTorso')!;
    const sample = (value: number) => ({ schemaVersion: 1 as const, graphFingerprint: savedGraph.graphFingerprint,
      rigId: '00000000-0000-4000-8000-000000000099', rigSignature: 'rig-topology-v1', uncoveredExpectedStateIds: [],
      samples: [{ stateId: 'idle', animationId: f.idle.id, recipeFingerprint: savedGraph.sourceFingerprints[0]!, telemetryFingerprint: 'a'.repeat(64),
        inspection: { source: 'studio_pose_evaluator' as const, metrics: [{ id: 'body-rise', label: 'Body rise', value, unit: 'studs', detail: 'sampled', sampleIds: ['s000'] }],
          findings: [], questions: [], limitations: [] } }] });
    const blendSample = (positionErrorStuds: number, rotationErrorDegrees: number, attackWeight = 0.5) => ({ schemaVersion: 3 as const,
      source: 'studio_animator_native_blend' as const, graphFingerprint: savedGraph.graphFingerprint,
      calibrationProtocol: 'identity_local_animation_delta_v1',
      jointMap: {}, jointMapFingerprint: digest({}),
      rigId: '00000000-0000-4000-8000-000000000099', rigSignature: 'rig-topology-v1',
      studioBuildIdentity: { status: 'captured' as const, value: 'test-studio-build-a', source: 'roblox_version_global_deprecated' as const },
      samples: [{ caseId: 'attack-release', at: 0.05, joint: 'UpperTorso', activeStates: expectedSample.tracks.map(track => track.stateId),
        activeTracks: expectedSample.tracks.map(track => ({ ...track, weight: track.stateId === 'attack' ? attackWeight : 1 - attackWeight })),
        simulatedTimelineContext: structuredClone(expectedSample.timelineContext),
        predicted: structuredClone(expectedJoint.predicted),
        measured: { position: expectedJoint.predicted.position.map((value, axis) => value + (axis === 0 ? positionErrorStuds : 0)) as [number, number, number],
          rotationQuaternion: (() => {
            const [x, y, z, w] = expectedJoint.predicted.rotationQuaternion;
            const sine = Math.sin(rotationErrorDegrees * Math.PI / 360), cosine = Math.cos(rotationErrorDegrees * Math.PI / 360);
            return [x * cosine + y * sine, -x * sine + y * cosine, w * sine + z * cosine, w * cosine - z * sine] as [number, number, number, number];
          })() },
        positionErrorStuds, rotationErrorDegrees }] });
    const completeBlendSample = (positionErrorStuds: number, rotationErrorDegrees: number) => {
      const legacyShape = blendSample(positionErrorStuds, rotationErrorDegrees);
      const entry = legacyShape.samples[0]!;
      const requestedTracks = structuredClone(entry.activeTracks!);
      const simulatedContributors = structuredClone(expectedJoint.simulatedContributors);
      return { ...legacyShape, schemaVersion: 12 as const, limitation: 'Identity-relative local animation delta measurements at fixed weights; not Play/Stop fade evidence.',
        samples: [{ ...entry, requestedTracks: structuredClone(expectedSample.tracks), simulatedContributors,
          simulatedResidualBasis: 'identity_local_animation_delta' as const,
          simulatedResidualWeight: expectedJoint.simulatedResidualWeight,
          simulatedPriorityLayers: structuredClone(expectedJoint.simulatedPriorityLayers) }] };
    };
    const failedCalibrationGate = await f.history.run(gatedPlan.id, gatedPlan.planFingerprint, sample(1), completeBlendSample(0.1, 2));
    assert.equal(failedCalibrationGate.studioCalibrationGate?.status, 'failed');
    assert.equal(failedCalibrationGate.studioCalibrationGate?.checks[0]?.worstPositionSample?.at, 0.05);
    assert.deepEqual(failedCalibrationGate.studioCalibrationGate?.checks[0]?.worstPositionSample?.activeTracks, expectedSample.tracks);
    assert.ok(failedCalibrationGate.studioCalibrationGate?.checks[0]?.worstPositionSample?.simulatedTimelineContext);
    assert.deepEqual(failedCalibrationGate.studioCalibrationGate?.checks[0]?.sampleChecks, [{ at: 0.05, status: 'failed',
      positionErrorStuds: 0.1 }]);
    const passedCalibrationGate = await f.history.run(gatedPlan.id, gatedPlan.planFingerprint, sample(1), completeBlendSample(0.001, 0.2));
    assert.equal(passedCalibrationGate.studioCalibrationGate?.status, 'passed');
    assert.deepEqual(passedCalibrationGate.studioCalibrationGate?.checks[0]?.sampleChecks, [{ at: 0.05, status: 'passed',
      positionErrorStuds: 0.001 }]);
    const before = await f.history.run(plan.id, plan.planFingerprint, sample(1), blendSample(0.1, 2));
    const after = await f.history.run(plan.id, plan.planFingerprint, sample(1.5), blendSample(0.25, 4));
    const compared = await f.history.compare(before.id, after.id);
    assert.equal(compared.studioEvidenceComparability, 'same_rig');
    assert.equal(compared.summary.changedStudioStates, 1);
    assert.equal(compared.summary.changedStudioMetrics, 1);
    assert.deepEqual(compared.studioStateChanges[0]!.changedMetrics, [{ id: 'body-rise', unit: 'studs', before: 1, after: 1.5, delta: 0.5 }]);
    assert.equal(compared.studioBlendEvidenceComparability, 'same_rig_same_contract_same_studio_build');
    assert.equal(compared.studioBlendBuildComparability, 'match');
    assert.equal(compared.summary.changedStudioBlendSamples, 1);
    assert.equal(compared.before.studioBlendCalibration?.sampleCount, 1);
    assert.equal(compared.before.studioBlendCalibration?.maxPositionErrorStuds, 0.1);
    assert.equal(compared.before.studioBlendCalibration?.worstRotation?.joint, 'UpperTorso');
    assert.equal(compared.before.studioBlendCalibration?.maxRotationErrorDegrees, 2);
    assert.deepEqual(compared.before.studioBlendCalibration?.compositionStrata.byObservedActiveTrackCount.map(group =>
      [group.value, group.sampleCount]), [[2, 1]], 'calibration summaries should expose errors by exact Studio-observed active-track count');
    assert.deepEqual(compared.before.studioBlendCalibration?.compositionStrata.bySimulatedPriorityLayerCount.map(group =>
      [group.value, group.sampleCount]), [[null, 1]], 'legacy evidence without simulator priority context remains explicitly unknown');
    assert.match(compared.before.studioBlendCalibration?.compositionStrata.limitation ?? '', /not causal attribution.*Missing historical context is grouped as value=null/);
    const blendChange = compared.studioBlendSampleChanges[0]!;
    assert.equal(blendChange.status, 'changed');
    assert.equal(blendChange.positionErrorDeltaStuds, 0.15);
    assert.equal(blendChange.rotationErrorDeltaDegrees, 2);
    assert.deepEqual(blendChange.before?.simulatedTimelineContext, expectedSample.timelineContext);
    assert.deepEqual(blendChange.before?.predicted, expectedJoint.predicted);
    assert.equal(blendChange.before?.positionErrorStuds, 0.1);
    assert.equal(blendChange.after?.positionErrorStuds, 0.25);
    const changedWeight = await f.history.run(plan.id, plan.planFingerprint, sample(1), blendSample(0.1, 2, 0.50005));
    const contextComparison = await f.history.compare(before.id, changedWeight.id);
    assert.equal(contextComparison.studioBlendSampleChanges[0]!.status, 'changed');
    assert.equal(contextComparison.studioBlendSampleChanges[0]!.activeTracksChanged, true);
    assert.equal(contextComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, 0);
    const legacyEvidence = blendSample(0.1, 2);
    const legacy = { ...legacyEvidence, schemaVersion: 1 as const, samples: legacyEvidence.samples.map(({ activeTracks: _activeTracks,
      simulatedTimelineContext: _simulatedTimelineContext, ...entry }) => entry) };
    const legacyGateRun = await f.history.run(gatedPlan.id, gatedPlan.planFingerprint, sample(1), legacy);
    assert.equal(legacyGateRun.studioCalibrationGate?.status, 'not_run');
    assert.deepEqual(legacyGateRun.studioCalibrationGate?.checks[0]?.sampleChecks, [{ at: 0.05, status: 'not_run',
      notRunReason: 'expected_track_snapshot_not_matched' }]);
    const mismatchHandoff = animationGraphTimelineNextAction(legacyGateRun);
    assert.equal(mismatchHandoff.status, 'native_evidence_mismatch');
    assert.equal(mismatchHandoff.action, 'reconcile_expected_vs_observed_tracks');
    assert.equal(mismatchHandoff.samePlanRetryRecommended, false,
      'a mismatched active-track snapshot must be reconciled before retrying the immutable plan');
    assert.deepEqual(mismatchHandoff.trackSnapshotMismatches, [{ caseId: f.cases[0]!.id, joint: 'UpperTorso', times: [0.05] }]);
    assert.deepEqual(mismatchHandoff.notRunReasons, ['expected_track_snapshot_not_matched']);
    const { studioCalibrationGate: _gate, studioBlendEvidence: _blend, ...historicalRunWithoutGate } = legacyGateRun;
    const legacyHandoff = animationGraphTimelineNextAction(historicalRunWithoutGate);
    assert.equal(legacyHandoff.status, 'historical_gate_metadata_missing');
    assert.equal(legacyHandoff.action, 'inspect_plan_and_report_before_concluding');
    assert.equal(legacyHandoff.samePlanRetryRecommended, false,
      'old history without gate metadata must not be described as an unrun requested gate');
    const legacyRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), legacy);
    assert.equal(legacyRun.studioBlendEvidence?.schemaVersion, 1);
    assert.equal(legacyRun.studioBlendEvidence?.samples[0]?.activeTracks, undefined);
    const invalidQuaternion = blendSample(0.1, 2);
    invalidQuaternion.samples[0]!.measured.rotationQuaternion = [0, 0, 0, 2];
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), invalidQuaternion), /Quaternion must be normalized/i);
    const completeEvidence = completeBlendSample(0.1, 2);
    const missingResidualBasis = completeBlendSample(0.1, 2);
    Reflect.deleteProperty(missingResidualBasis.samples[0]!, 'simulatedResidualBasis');
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), missingResidualBasis),
      /Version 12 blend evidence requires a fingerprint-verified joint map/i);
    const missingCalibrationProtocol = completeBlendSample(0.1, 2);
    Reflect.deleteProperty(missingCalibrationProtocol, 'calibrationProtocol');
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), missingCalibrationProtocol),
      /Version 12 blend evidence requires a fingerprint-verified joint map/i);
    const missingJointMap = completeBlendSample(0.1, 2);
    Reflect.deleteProperty(missingJointMap, 'jointMap');
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), missingJointMap),
      /Version 12 blend evidence requires a fingerprint-verified joint map/i);
    const validCompleteRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), completeEvidence);
    assert.equal(validCompleteRun.studioBlendEvidence?.schemaVersion, 12);
    assert.equal(validCompleteRun.studioBlendEvidence?.calibrationProtocol, 'identity_local_animation_delta_v1');
    assert.deepEqual(validCompleteRun.studioBlendEvidence?.jointMap, {});
    assert.equal(validCompleteRun.studioBlendEvidence?.jointMapFingerprint, digest({}));
    assert.equal(validCompleteRun.studioBlendEvidence?.samples[0]?.simulatedResidualBasis, 'identity_local_animation_delta');
    assert.equal(validCompleteRun.report.cases[0]!.poseModel?.algorithmVersion, 2,
      'new persisted runs must pin the pose-composition algorithm used for native calibration');
    assert.equal(validCompleteRun.studioBlendEvidence?.samples[0]?.simulatedTimelineContext?.mostRecentTransition?.destinationFadeStartWeight,
      expectedSample.timelineContext.mostRecentTransition?.destinationFadeStartWeight);
    const currentModelRun = await f.history.run(plan.id, plan.planFingerprint, sample(1.2), completeBlendSample(0.2, 3));
    const legacyRunPath = join(f.root, 'timeline-history', 'runs', `${validCompleteRun.id}.json`);
    const legacyStoredRun = JSON.parse(await readFile(legacyRunPath, 'utf8')) as {
      run: { report: { cases: Array<Record<string, unknown>>; reportFingerprint: string }; runFingerprint: string; [key: string]: unknown };
      integrity: string;
    };
    const storedPoseModel = legacyStoredRun.run.report.cases[0]!.poseModel as { algorithmVersion: number };
    storedPoseModel.algorithmVersion = 1;
    const { reportFingerprint: _oldReportFingerprint, ...reportContentWithChangedAlgorithm } = legacyStoredRun.run.report;
    legacyStoredRun.run.report.reportFingerprint = digest(reportContentWithChangedAlgorithm);
    const { runFingerprint: _oldRunFingerprint, ...runContentWithChangedAlgorithm } = legacyStoredRun.run;
    legacyStoredRun.run.runFingerprint = digest(runContentWithChangedAlgorithm);
    legacyStoredRun.integrity = digest(legacyStoredRun.run);
    await writeFile(legacyRunPath, `${JSON.stringify(legacyStoredRun)}\n`);
    const changedAlgorithmComparison = await f.history.compare(validCompleteRun.id, currentModelRun.id);
    assert.equal(changedAlgorithmComparison.blendModelComparability, 'different_model');
    assert.equal(changedAlgorithmComparison.comparability, 'changed_blend_model');
    assert.equal(changedAlgorithmComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'different pose-composition algorithm versions must not produce numeric error deltas');
    assert.equal(changedAlgorithmComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, null);
    const legacyProtocolEvidence = { ...structuredClone(completeEvidence), schemaVersion: 10 as const };
    Reflect.deleteProperty(legacyProtocolEvidence, 'calibrationProtocol');
    const legacyProtocolRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), legacyProtocolEvidence);
    const legacyProtocolComparison = await f.history.compare(legacyProtocolRun.id, currentModelRun.id);
    assert.equal(legacyProtocolComparison.studioBlendProtocolComparability, 'unknown');
    assert.equal(legacyProtocolComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_unknown_calibration_protocol');
    assert.equal(legacyProtocolComparison.studioBlendCalibrationDelta.reason, 'calibration_protocol_unknown');
    assert.equal(legacyProtocolComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'legacy calibration records without a protocol handshake must not produce native error deltas');
    storedPoseModel.algorithmVersion = 1;
    Reflect.deleteProperty(storedPoseModel, 'residualBasis');
    const { reportFingerprint: _changedReportFingerprint, ...reportContentWithoutResidualBasis } = legacyStoredRun.run.report;
    legacyStoredRun.run.report.reportFingerprint = digest(reportContentWithoutResidualBasis);
    const { runFingerprint: _changedRunFingerprint, ...runContentWithoutResidualBasis } = legacyStoredRun.run;
    legacyStoredRun.run.runFingerprint = digest(runContentWithoutResidualBasis);
    legacyStoredRun.integrity = digest(legacyStoredRun.run);
    await writeFile(legacyRunPath, `${JSON.stringify(legacyStoredRun)}\n`);
    const legacyBasisComparison = await f.history.compare(validCompleteRun.id, currentModelRun.id);
    assert.equal(legacyBasisComparison.blendModelComparability, 'different_model');
    assert.equal(legacyBasisComparison.comparability, 'changed_blend_model');
    assert.equal(legacyBasisComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'legacy pose models without residual-basis provenance must not produce native error deltas');
    assert.equal(legacyBasisComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, null);
    delete legacyStoredRun.run.report.cases[0]!.poseModel;
    const { reportFingerprint: _previousReportFingerprint, ...reportWithoutFingerprint } = legacyStoredRun.run.report;
    legacyStoredRun.run.report.reportFingerprint = digest(reportWithoutFingerprint);
    const { runFingerprint: _previousRunFingerprint, ...runWithoutFingerprint } = legacyStoredRun.run;
    legacyStoredRun.run.runFingerprint = digest(runWithoutFingerprint);
    legacyStoredRun.integrity = digest(legacyStoredRun.run);
    await writeFile(legacyRunPath, `${JSON.stringify(legacyStoredRun)}\n`);
    const legacyModelComparison = await f.history.compare(validCompleteRun.id, currentModelRun.id);
    assert.equal(legacyModelComparison.blendModelComparability, 'incomplete_provenance');
    assert.equal(legacyModelComparison.comparability, 'incomplete_model_provenance');
    assert.equal(legacyModelComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_same_studio_build');
    assert.equal(legacyModelComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'legacy runs lacking pose-model provenance must not produce native error deltas');
    assert.equal(legacyModelComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, null);
    const otherBuildEvidence = { ...completeEvidence,
      studioBuildIdentity: { status: 'captured' as const, value: 'test-studio-build-b', source: 'roblox_version_global_deprecated' as const } };
    const otherBuildRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), otherBuildEvidence);
    const otherBuildComparison = await f.history.compare(validCompleteRun.id, otherBuildRun.id);
    assert.equal(otherBuildComparison.studioBlendBuildComparability, 'mismatch');
    assert.equal(otherBuildComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_different_studio_build');
    assert.equal(otherBuildComparison.studioBlendCalibrationDelta.reason, 'studio_build_changed');
    assert.equal(otherBuildComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false);
    assert.equal(otherBuildComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, null,
      'error deltas must not be presented as comparable across engine builds');
    const otherProtocolEvidence = { ...completeEvidence, calibrationProtocol: 'identity_local_animation_delta_v2' };
    const otherProtocolRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), otherProtocolEvidence);
    const otherProtocolComparison = await f.history.compare(validCompleteRun.id, otherProtocolRun.id);
    assert.equal(otherProtocolComparison.studioBlendProtocolComparability, 'mismatch');
    assert.equal(otherProtocolComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_different_calibration_protocol');
    assert.equal(otherProtocolComparison.studioBlendCalibrationDelta.reason, 'calibration_protocol_changed');
    assert.equal(otherProtocolComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'native pose error deltas must not cross Studio sampling protocols');
    const otherJointMapEvidence = { ...completeEvidence, jointMap: { UpperTorso: 'MappedTorso' },
      jointMapFingerprint: digest({ UpperTorso: 'MappedTorso' }) };
    const otherJointMapRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), otherJointMapEvidence);
    const otherJointMapComparison = await f.history.compare(validCompleteRun.id, otherJointMapRun.id);
    assert.equal(otherJointMapComparison.studioBlendJointMapComparability, 'mismatch');
    assert.equal(otherJointMapComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_different_joint_map');
    assert.equal(otherJointMapComparison.studioBlendCalibrationDelta.reason, 'joint_map_changed');
    assert.equal(otherJointMapComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'native pose error deltas must not cross joint-name mappings');
    const unknownBuildEvidence = { ...completeEvidence,
      studioBuildIdentity: { status: 'unavailable' as const, value: null, source: 'unavailable' as const } };
    const unknownBuildRun = await f.history.run(plan.id, plan.planFingerprint, sample(1), unknownBuildEvidence);
    const unknownBuildComparison = await f.history.compare(validCompleteRun.id, unknownBuildRun.id);
    assert.equal(unknownBuildComparison.studioBlendBuildComparability, 'unknown');
    assert.equal(unknownBuildComparison.studioBlendEvidenceComparability, 'same_rig_same_contract_unknown_studio_build');
    assert.equal(unknownBuildComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false);
    const expandedCases = structuredClone(f.cases);
    expandedCases[0]!.expect.poses!.push({ ...expandedCases[0]!.expect.poses![0]!, at: 0.1 });
    const expandedPreview = await f.history.preview('Require all native blend samples', f.graph.id, expandedCases);
    const expandedPlan = await f.history.create('Require all native blend samples', f.graph.id, expandedCases, expandedPreview.draftFingerprint);
    await assert.rejects(() => f.history.run(expandedPlan.id, expandedPlan.planFingerprint, sample(1), completeEvidence), /coverage is incomplete: 1 planned joint samples are missing/i);
    const inconsistentStatus = structuredClone(completeBlendSample(0.1, 2));
    inconsistentStatus.samples[0]!.simulatedContributors[0]!.contributionStatus = 'masked_by_higher_priority';
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), inconsistentStatus), /Contributor status must agree/i);
    const duplicateTracks = structuredClone(completeBlendSample(0.1, 2));
    duplicateTracks.samples[0]!.activeTracks.push(structuredClone(duplicateTracks.samples[0]!.activeTracks[0]!));
    duplicateTracks.samples[0]!.activeStates.push(duplicateTracks.samples[0]!.activeStates[0]!);
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), duplicateTracks), /track context cannot repeat/i);
    const mismatchedErrors = structuredClone(completeBlendSample(0.1, 2));
    mismatchedErrors.samples[0]!.positionErrorStuds = 0;
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), mismatchedErrors), /Reported position error must match/i);
    const unplannedSample = structuredClone(completeBlendSample(0.1, 2));
    unplannedSample.samples[0]!.caseId = 'otherCase';
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), unplannedSample), /not requested by the immutable timeline plan/i);
    const unboundPrediction = structuredClone(completeBlendSample(0.1, 2));
    unboundPrediction.samples[0]!.predicted.position[0] += 1;
    unboundPrediction.samples[0]!.measured.position[0] += 1;
    await assert.rejects(() => f.history.run(plan.id, plan.planFingerprint, sample(1), unboundPrediction), /predicted pose does not match the immutable plan/i);
    const changedSourceRecipe = structuredClone(f.idle.recipe);
    if (changedSourceRecipe.kind !== 'animation') throw new Error('Expected an animation source fixture.');
    changedSourceRecipe.name = `${changedSourceRecipe.name} revised`;
    const changedAssetPath = join(f.animations.directory, `${f.idle.id}.json`);
    const changedAsset = JSON.parse(await readFile(changedAssetPath, 'utf8')) as Record<string, unknown>;
    changedAsset.recipe = changedSourceRecipe;
    await writeFile(changedAssetPath, `${JSON.stringify(changedAsset, null, 2)}\n`);
    const changedGraphRecordPath = join(f.graphs.directory, `${f.graph.id}.json`);
    const changedGraphRecord = JSON.parse(await readFile(changedGraphRecordPath, 'utf8')) as { sourceFingerprints: string[]; [key: string]: unknown };
    changedGraphRecord.sourceFingerprints[0] = fingerprint(changedSourceRecipe);
    await writeFile(changedGraphRecordPath, `${JSON.stringify(changedGraphRecord, null, 2)}\n`);
    const sourceChangedPreview = await f.history.preview('Source changed calibration', f.graph.id, f.cases);
    const sourceChangedPlan = await f.history.create('Source changed calibration', f.graph.id, f.cases, sourceChangedPreview.draftFingerprint);
    const sourceChangedStudioEvidence = sample(1);
    sourceChangedStudioEvidence.samples[0]!.recipeFingerprint = fingerprint(changedSourceRecipe);
    const sourceChangedRun = await f.history.run(sourceChangedPlan.id, sourceChangedPlan.planFingerprint,
      sourceChangedStudioEvidence, completeEvidence);
    const sourceChangedComparison = await f.history.compare(validCompleteRun.id, sourceChangedRun.id);
    assert.equal(sourceChangedComparison.sourceComparability, 'different_sources');
    assert.equal(sourceChangedComparison.studioBlendEvidenceComparability, 'same_rig_changed_sources');
    assert.equal(sourceChangedComparison.studioBlendCalibrationDelta.reason, 'source_animations_changed');
    assert.equal(sourceChangedComparison.studioBlendSampleChanges[0]!.errorDeltasComparable, false,
      'native calibration deltas must not compare evidence produced against different source-animation content');
    assert.equal(sourceChangedComparison.studioBlendSampleChanges[0]!.positionErrorDeltaStuds, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline run comparison reports per-pose expected values, observed errors and regression deltas', async () => {
  const f = await fixture();
  try {
    const beforePreview = await f.history.preview('Pose baseline', f.graph.id, f.cases);
    const beforePlan = await f.history.create('Pose baseline', f.graph.id, f.cases, beforePreview.draftFingerprint);
    const beforeRun = await f.history.run(beforePlan.id, beforePlan.planFingerprint);
    const changedCases = f.cases.map(testCase => ({ ...testCase, expect: { ...testCase.expect,
      poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [0.25, 0, 0], positionToleranceStuds: 0.001,
        rotationBlendConfidence: { min: 0.1, max: 1 }, rotationInfluence: { min: 0.1, max: 1 } }] } }));
    const afterPreview = await f.history.preview('Pose target changed', f.graph.id, changedCases);
    const afterPlan = await f.history.create('Pose target changed', f.graph.id, changedCases, afterPreview.draftFingerprint);
    const afterRun = await f.history.run(afterPlan.id, afterPlan.planFingerprint);

    const comparison = await f.history.compare(beforeRun.id, afterRun.id);
    assert.equal(comparison.comparability, 'changed_contract');
    const poseChange = comparison.cases[0]!.checkChanges.find(check => check.expectation === 'pose:UpperTorso@0.05:positionErrorStuds');
    assert.ok(poseChange);
    assert.equal(poseChange.kind, 'pose');
    assert.equal(poseChange.status, 'regression');
    assert.equal(poseChange.expectedChanged, true);
    const positionDelta = poseChange.observedDelta;
    assert.ok(positionDelta !== undefined);
    assert.ok(Math.abs(positionDelta - 0.25) < 1e-12);
    assert.ok(Math.abs((poseChange.before?.observed as number) - 0) < 1e-12);
    assert.ok(Math.abs((poseChange.after?.observed as number) - 0.25) < 1e-12);
    const confidenceChange = comparison.cases[0]!.checkChanges.find(check => check.expectation === 'pose:UpperTorso@0.05:rotationBlendConfidence');
    assert.ok(confidenceChange);
    assert.equal(confidenceChange.status, 'expectation_changed');
    assert.deepEqual(confidenceChange.before?.expected, { min: 0, max: 1 });
    assert.deepEqual(confidenceChange.after?.expected, { min: 0.1, max: 1 });
    assert.equal(confidenceChange.observedChanged, undefined);
    assert.equal(confidenceChange.observedDelta, 0);
    assert.equal(comparison.summary.checkRegressions, 1);
    assert.ok(comparison.cases[0]!.newFailures.includes('pose:UpperTorso@0.05:position'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline comparison and saved history preserve new acceleration evidence without inventing a zero baseline', async () => {
  const f = await fixture();
  try {
    const acceleratingAnimation = await f.animations.save(animationSchema.parse({ kind: 'animation', name: 'Rapid acceleration history source',
      duration: 0.2, loop: false, tracks: [{ joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier',
          curve: { outTime: 0.001, outValue: 0.05, inTime: 0.002, inValue: 0.95 } },
        { time: 0.2, position: [10, 0, 0], rotation: [0, 0, 0] },
      ] }] }));
    const accelerationGraph = await f.graphs.save({ kind: 'animation_graph', name: 'Acceleration history graph', entryState: 'motion', sampleRate: 30,
      states: [{ id: 'motion', name: 'Motion', animationId: acceleratingAnimation.id, speed: 1 }], transitions: [] });
    const baselineCases = [{ id: 'acceleration-history', name: 'Eased motion baseline', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', expectedPosition: [10, 0, 0], positionToleranceStuds: 0.001 }] } }];
    const beforePreview = await f.history.preview('Pose baseline without acceleration gate', accelerationGraph.id, baselineCases);
    const beforePlan = await f.history.create('Pose baseline without acceleration gate', accelerationGraph.id, baselineCases, beforePreview.draftFingerprint);
    const beforeRun = await f.history.run(beforePlan.id, beforePlan.planFingerprint);
    const accelerationCases = baselineCases.map(testCase => ({ ...testCase, expect: { ...testCase.expect,
      poses: [{ ...testCase.expect.poses[0]!, throughout: { start: 0, end: 0.2, sampleRateHz: 30,
        maxLinearAccelerationStudsPerSecondSquared: 0 } }] } }));
    const afterPreview = await f.history.preview('Pose baseline with acceleration gate', accelerationGraph.id, accelerationCases);
    const afterPlan = await f.history.create('Pose baseline with acceleration gate', accelerationGraph.id, accelerationCases, afterPreview.draftFingerprint);
    const afterRun = await f.history.run(afterPlan.id, afterPlan.planFingerprint);
    assert.equal(afterRun.report.status, 'failed', 'the zero acceleration cap should produce persisted failure evidence');
    const runFailures = afterRun.report.cases[0]!.failures as Array<{ expectation: string;
      motionGuidance?: { kind: string; suggestedNextStep: string; limitation: string } }>;
    const failure = runFailures.find(item => item.expectation.endsWith(':maximumLinearAcceleration'))!;
    const guidance = failure.motionGuidance!;
    assert.equal(guidance.kind, 'sampled_threshold_exceeded');
    assert.match(guidance.suggestedNextStep, /preview the exact candidate.*rerun this gate/i);
    assert.match(guidance.limitation, /not.*quality judgment/i);
    const savedHistory = await f.history.history(afterPlan.id);
    const savedFailures = savedHistory.runs.find(run => run.id === afterRun.id)!.report.cases[0]!.failures as Array<{ expectation: string;
      motionGuidance?: { kind: string; suggestedNextStep: string; limitation: string } }>;
    const savedFailure = savedFailures.find(item => item.expectation.endsWith(':maximumLinearAcceleration'))!;
    assert.deepEqual(savedFailure.motionGuidance, guidance, 'integrity-checked saved history must preserve the AI next step');

    const comparison = await f.history.compare(beforeRun.id, afterRun.id);
    assert.equal(comparison.comparability, 'changed_contract');
    const accelerationChange = comparison.cases[0]!.checkChanges.find(check =>
      check.expectation === 'pose:UpperTorso@0.2:maximumSampledLinearAccelerationStudsPerSecondSquared');
    assert.ok(accelerationChange);
    assert.equal(accelerationChange.status, 'added');
    assert.equal(accelerationChange.before, null, 'the older run must remain explicitly absent, not appear as a zero measurement');
    assert.equal(accelerationChange.observedDelta, undefined);
    assert.equal(accelerationChange.observedNumericDeltas, undefined);
    assert.equal(accelerationChange.status, 'added');
    assert.equal((accelerationChange.after?.observed as { blendContext: unknown }).blendContext !== undefined, true,
      'the new run should preserve its self-contained AI diagnostic evidence');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline comparison treats blend-model and calibration provenance changes as non-comparable', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Blend model comparison', f.graph.id, f.cases);
    const plan = await f.history.create('Blend model comparison', f.graph.id, f.cases, preview.draftFingerprint);
    const linearRun = await f.history.run(plan.id, plan.planFingerprint);
    const calibrationProfile = { id: '00000000-0000-4000-8000-000000000101', rigId: '00000000-0000-4000-8000-000000000102',
      rigSignature: 'rig-signature', graphId: f.graph.id, graphFingerprint: animationGraphFingerprint(f.graph.graph), stateId: 'idle',
      recipeFingerprint: f.graph.sourceFingerprints[0]!, jointMapFingerprint: 'b'.repeat(64), fadeSeconds: 0.1, sampleRateHz: 10,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 0.8, weightTarget: 0 }, { at: 0.1, weightCurrent: 0, weightTarget: 0 }],
      limitation: 'Test-only fingerprinted calibration.', schemaVersion: 1 as const, createdAt: new Date().toISOString(),
      profileFingerprint: 'a'.repeat(64) };
    const calibratedRun = await f.history.run(plan.id, plan.planFingerprint, undefined, undefined, [calibrationProfile]);
    const comparison = await f.history.compare(linearRun.id, calibratedRun.id);
    assert.equal(comparison.comparability, 'changed_blend_model');
    assert.equal(comparison.blendModelComparability, 'different_model');
    assert.deepEqual(comparison.blendModels.before, { kind: 'linear_per_track_weight_estimate', calibrationProfileIds: [],
      playbackTimingFingerprint: linearRun.report.blendModel!.playbackTimingFingerprint });
    assert.deepEqual(comparison.blendModels.after, { kind: 'studio_calibrated_curve_per_track_estimate',
      calibrationProfileIds: [calibrationProfile.id], playbackTimingFingerprint: linearRun.report.blendModel!.playbackTimingFingerprint });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline plans preserve observed BlendSpace lengths and compare timing-model changes', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Measured Blend Timing', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0.5, min: 0, max: 2 }], states: [
        { id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 },
        { id: 'recovery', name: 'Recovery', animationId: f.recovery.id, speed: 1 },
        { id: 'blend', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'recovery' },
            { value: 2, stateId: 'blend' }] } },
      ], transitions: [] });
    const makeCases = (recoveryLength: number) => [{ id: 'measured-phase', name: 'Measured normalized phase', duration: 0.25,
      observedBlendAnimationLengths: { blend: { idle: 2, recovery: recoveryLength, blend: 1.25 } },
      observedBlendAnimationPlaybackSpeeds: { blend: { idle: 1, recovery: 0.25, blend: 0.625 } },
      observedBlendAnimationStartPhases: { blend: { idle: 0, recovery: 0, blend: 0 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'blend', blendSpace: { parameterValue: { min: 0.5, max: 0.5 },
        clips: [{ stateId: 'recovery', playback: { normalizedPhase: { min: 0.125, max: 0.125 },
          playbackSpeed: { min: 0.25, max: 0.25 } } }] } }] } }];
    const firstCases = makeCases(0.5);
    const preview = await f.history.preview('Measured timing regression', graph.id, firstCases);
    assert.deepEqual(preview.cases[0]!.observedBlendAnimationLengths, firstCases[0]!.observedBlendAnimationLengths,
      'review preview must preserve the exact live length snapshot that shapes the simulation');
    assert.deepEqual(preview.cases[0]!.observedBlendAnimationPlaybackSpeeds, firstCases[0]!.observedBlendAnimationPlaybackSpeeds,
      'review preview must preserve actual Roblox speeds rather than infer synchronization');
    assert.deepEqual(preview.cases[0]!.observedBlendAnimationStartPhases, firstCases[0]!.observedBlendAnimationStartPhases,
      'review preview must preserve the captured source phases');
    const plan = await f.history.create('Measured timing regression', graph.id, firstCases, preview.draftFingerprint);
    const stored = await f.history.read(plan.id);
    assert.deepEqual(stored.plan.cases[0]!.observedBlendAnimationLengths, firstCases[0]!.observedBlendAnimationLengths,
      'immutable plan storage must retain the controller-scoped measurements');
    assert.deepEqual(stored.plan.cases[0]!.observedBlendAnimationPlaybackSpeeds, firstCases[0]!.observedBlendAnimationPlaybackSpeeds,
      'immutable plan storage must retain the exact observed playback speeds');
    assert.deepEqual(stored.plan.cases[0]!.observedBlendAnimationStartPhases, firstCases[0]!.observedBlendAnimationStartPhases,
      'immutable plan storage must retain the exact observed start phases');
    const run = await f.history.run(plan.id, plan.planFingerprint);
    const caseReport = run.report.cases[0]! as unknown as { blendModel: { playbackTiming: {
      calibratedControllerCount: number; controllers: Array<{ controllerStateId: string; source: string; controllerCycleDurationSeconds: number;
        clips: Array<{ stateId: string; observedLengthSeconds: number | null; observedStartPhase: number | null; playbackSpeed: number;
          playbackCycleDurationSeconds: number; playbackCycleDurationRatioToController: number }> }> } } };
    assert.equal(caseReport.blendModel.playbackTiming.calibratedControllerCount, 1);
    assert.deepEqual(caseReport.blendModel.playbackTiming.controllers[0]!.clips,
      [{ stateId: 'idle', observedLengthSeconds: 2, observedStartPhase: 0, playbackSpeed: 1,
        playbackCycleDurationSeconds: 2, playbackCycleDurationRatioToController: 1 },
        { stateId: 'recovery', observedLengthSeconds: 0.5, observedStartPhase: 0, playbackSpeed: 0.25,
          playbackCycleDurationSeconds: 2, playbackCycleDurationRatioToController: 1 },
        { stateId: 'blend', observedLengthSeconds: 1.25, observedStartPhase: 0, playbackSpeed: 0.625,
          playbackCycleDurationSeconds: 2, playbackCycleDurationRatioToController: 1 }],
      'saved run evidence must explain measured lengths and effective synchronized speeds');
    assert.equal(caseReport.blendModel.playbackTiming.controllers[0]!.controllerCycleDurationSeconds, 2);
    assert.match(run.report.blendModel!.playbackTimingFingerprint!, /^[a-f0-9]{64}$/);

    const changedCases = makeCases(1);
    const changedPreview = await f.history.preview('Measured timing changed', graph.id, changedCases);
    const changedPlan = await f.history.create('Measured timing changed', graph.id, changedCases, changedPreview.draftFingerprint);
    const changedRun = await f.history.run(changedPlan.id, changedPlan.planFingerprint);
    const comparison = await f.history.compare(run.id, changedRun.id);
    assert.equal(comparison.comparability, 'changed_contract');
    assert.equal(comparison.blendModelComparability, 'different_model',
      'different observed Roblox length maps must not be summarized as the same playback model');
    assert.notEqual(run.report.blendModel!.playbackTimingFingerprint, changedRun.report.blendModel!.playbackTimingFingerprint);

    const changedSpeedCases = makeCases(0.5).map(testCase => ({ ...testCase,
      observedBlendAnimationPlaybackSpeeds: { blend: { idle: 1, recovery: 0.4, blend: 0.625 } },
    }));
    const changedSpeedPreview = await f.history.preview('Measured playback speed changed', graph.id, changedSpeedCases);
    const changedSpeedPlan = await f.history.create('Measured playback speed changed', graph.id, changedSpeedCases,
      changedSpeedPreview.draftFingerprint);
    const changedSpeedRun = await f.history.run(changedSpeedPlan.id, changedSpeedPlan.planFingerprint);
    const speedComparison = await f.history.compare(run.id, changedSpeedRun.id);
    assert.equal(speedComparison.blendModelComparability, 'different_model',
      'changed actual Roblox playback speeds must not be reported as an identical timing model');
    assert.notEqual(run.report.blendModel!.playbackTimingFingerprint, changedSpeedRun.report.blendModel!.playbackTimingFingerprint);

    const changedPhaseCases = makeCases(0.5).map(testCase => ({ ...testCase,
      observedBlendAnimationStartPhases: { blend: { idle: 0, recovery: 0.1, blend: 0 } },
    }));
    const changedPhasePreview = await f.history.preview('Measured start phase changed', graph.id, changedPhaseCases);
    const changedPhasePlan = await f.history.create('Measured start phase changed', graph.id, changedPhaseCases,
      changedPhasePreview.draftFingerprint);
    const changedPhaseRun = await f.history.run(changedPhasePlan.id, changedPhasePlan.planFingerprint);
    const phaseComparison = await f.history.compare(run.id, changedPhaseRun.id);
    assert.equal(phaseComparison.blendModelComparability, 'different_model',
      'different captured start phases must not be collapsed into an identical playback model');
    assert.notEqual(run.report.blendModel!.playbackTimingFingerprint, changedPhaseRun.report.blendModel!.playbackTimingFingerprint);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline comparison detects changed calibration content and Play-retrigger evidence under a reused profile ID', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Calibration revision comparison', f.graph.id, f.cases);
    const plan = await f.history.create('Calibration revision comparison', f.graph.id, f.cases, preview.draftFingerprint);
    const profileId = '00000000-0000-4000-8000-000000000111';
    const baseProfile = { id: profileId, rigId: '00000000-0000-4000-8000-000000000112',
      rigSignature: 'rig-signature', graphId: f.graph.id, graphFingerprint: animationGraphFingerprint(f.graph.graph), stateId: 'idle',
      recipeFingerprint: f.graph.sourceFingerprints[0]!, jointMapFingerprint: 'd'.repeat(64), fadeSeconds: 0.1, sampleRateHz: 10,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 0.8, weightTarget: 0 }, { at: 0.1, weightCurrent: 0, weightTarget: 0 }],
      limitation: 'Test-only fingerprinted calibration.', schemaVersion: 1 as const, createdAt: new Date().toISOString() };
    const preservedClockProfile = { ...baseProfile, profileFingerprint: 'a'.repeat(64), schemaVersion: 2 as const,
      playRetrigger: { probeElapsedSeconds: 0.05, timePositionBefore: 0.5, timePositionImmediatelyAfter: 0.5,
        timePositionAfterStep: 0.55, weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1,
        observedClockBehavior: 'preserved' as const } };
    const resetClockProfile = { ...baseProfile, profileFingerprint: 'b'.repeat(64), schemaVersion: 2 as const,
      playRetrigger: { ...preservedClockProfile.playRetrigger, timePositionImmediatelyAfter: 0,
        timePositionAfterStep: 0.05, observedClockBehavior: 'reset_to_zero' as const } };
    const before = await f.history.run(plan.id, plan.planFingerprint, undefined, undefined, [preservedClockProfile]);
    const after = await f.history.run(plan.id, plan.planFingerprint, undefined, undefined, [resetClockProfile]);
    const comparison = await f.history.compare(before.id, after.id);
    assert.equal(comparison.comparability, 'changed_blend_model');
    assert.equal(comparison.blendModelComparability, 'different_model');
    assert.equal(comparison.fadeCalibrationProfiles.comparability, 'different_profiles');
    assert.equal(comparison.fadeCalibrationProfiles.before[0]?.profileFingerprint, 'a'.repeat(64));
    assert.equal(comparison.fadeCalibrationProfiles.after[0]?.profileFingerprint, 'b'.repeat(64));
    assert.equal(comparison.fadeCalibrationProfiles.before[0]?.playRetrigger?.observedClockBehavior, 'preserved');
    assert.equal(comparison.fadeCalibrationProfiles.after[0]?.playRetrigger?.observedClockBehavior, 'reset_to_zero');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline comparisons expose playback-clock assertion regressions', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Playback clock contract', entryState: 'idle', sampleRate: 30,
      states: [{ id: 'idle', name: 'Idle', animationId: f.idle.id, speed: 1 }],
      transitions: [{ id: 'restartIdle', from: 'idle', to: 'idle', trigger: 'Restart', blendSeconds: 0.1 }] });
    const cases = [{ id: 'retrigger', name: 'Pinned retrigger clock', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger' as const, trigger: 'Restart' }],
      expect: { playbackClock: [{ transitionId: 'restartIdle', decision: 'studio_observed_preserved' as const }] } }];
    const preview = await f.history.preview('Playback clock contract', graph.id, cases);
    assert.deepEqual(preview.coveragePreview.playbackClockAssertions, { assertions: 1, transitions: ['restartIdle'] });
    const plan = await f.history.create('Playback clock contract', graph.id, cases, preview.draftFingerprint);
    const makeProfile = (profileFingerprint: string, behavior: 'preserved' | 'reset_to_zero') => ({
      id: '00000000-0000-4000-8000-000000000121', schemaVersion: 2 as const, graphId: graph.id,
      graphFingerprint: animationGraphFingerprint(graph.graph), rigId: '00000000-0000-4000-8000-000000000122', rigSignature: 'test-rig',
      stateId: 'idle', recipeFingerprint: fingerprint(f.idle.recipe), jointMapFingerprint: 'f'.repeat(64), fadeSeconds: 0.1, sampleRateHz: 10,
      profileFingerprint,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0, weightTarget: 0 }],
      playRetrigger: { probeElapsedSeconds: 0.05, timePositionBefore: 0.5,
        timePositionImmediatelyAfter: behavior === 'preserved' ? 0.5 : 0,
        timePositionAfterStep: behavior === 'preserved' ? 0.55 : 0.05, weightCurrentBefore: 1,
        weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1, observedClockBehavior: behavior },
      limitation: 'Test calibration.', createdAt: new Date().toISOString(),
    });
    const before = await f.history.run(plan.id, plan.planFingerprint, undefined, undefined, [makeProfile('c'.repeat(64), 'preserved')]);
    const after = await f.history.run(plan.id, plan.planFingerprint, undefined, undefined, [makeProfile('e'.repeat(64), 'reset_to_zero')]);
    const comparison = await f.history.compare(before.id, after.id);
    const change = comparison.cases[0]!.checkChanges.find(check => check.expectation === 'playbackClock:restartIdle#1');
    assert.equal(change?.kind, 'playback_clock');
    assert.equal(change?.status, 'regression');
    assert.deepEqual(change?.after?.observed, { decision: 'studio_observed_reset', failureReason: 'playback_clock_decision_mismatch',
      observedTransitionOccurrences: 1 });
    assert.equal(comparison.summary.checkRegressions, 1);
    const missingCases = [{ ...cases[0]!, events: [] }];
    const missingPreview = await f.history.preview('Missing playback transition', graph.id, missingCases);
    const missingPlan = await f.history.create('Missing playback transition', graph.id, missingCases, missingPreview.draftFingerprint);
    const missingOccurrenceRun = await f.history.run(missingPlan.id, missingPlan.planFingerprint);
    const missingOccurrenceComparison = await f.history.compare(before.id, missingOccurrenceRun.id);
    const missingOccurrenceChange = missingOccurrenceComparison.cases[0]!.checkChanges.find(check => check.expectation === 'playbackClock:restartIdle#1');
    assert.equal(missingOccurrenceChange?.status, 'regression');
    assert.deepEqual(missingOccurrenceChange?.after?.observed, { decision: null, failureReason: 'transition_occurrence_not_observed',
      observedTransitionOccurrences: 0 });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline reports retain only fade profiles actually applied by at least one case', async () => {
  const f = await fixture();
  try {
    const makeProfile = (id: string, fadeSeconds: number) => ({ id, stateId: 'idle', recipeFingerprint: fingerprint(f.idle.recipe),
      profileFingerprint: 'c'.repeat(64), fadeSeconds,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: fadeSeconds, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: fadeSeconds, weightCurrent: 0, weightTarget: 0 }] });
    const profiles = [makeProfile('00000000-0000-4000-8000-000000000201', 0.1), makeProfile('00000000-0000-4000-8000-000000000202', 0.3)];
    const evidence = profiles.map(profile => ({ id: profile.id, profileFingerprint: profile.profileFingerprint, stateId: profile.stateId,
      fadeSeconds: profile.fadeSeconds, rigId: '00000000-0000-4000-8000-000000000203', rigSignature: 'fixture-rig',
      qualityStatus: 'clean' as const, qualityWarnings: [] as string[] }));
    const report = runAnimationGraphTimelineSuite(f.graph.graph,
      { [f.idle.id]: f.idle.recipe, [f.attack.id]: f.attack.recipe }, { cases: f.cases },
      { fadeProfiles: profiles, fadeCalibrationEvidence: evidence });
    assert.deepEqual(report.blendModel.calibrationProfileIds, [profiles[0]!.id]);
    assert.deepEqual(report.fadeCalibrationEvidence?.map(profile => profile.id), [profiles[0]!.id]);
    assert.equal(report.fadeCalibrationEvidence?.[0]?.qualityStatus, 'clean');
    assert.deepEqual(report.fadeCalibrationEvidence?.[0]?.qualityWarnings, []);
    const blendChecks = report.cases[0]!.blendChecks as Array<{ stateId: string; track: { fadeCalibrationProfileId?: string; fadeCalibrationDirection?: string } | null }>;
    assert.equal(blendChecks.find(check => check.stateId === 'idle')?.track?.fadeCalibrationProfileId, profiles[0]!.id);
    assert.equal(blendChecks.find(check => check.stateId === 'idle')?.track?.fadeCalibrationDirection, 'stopOut');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline plans persist and validate interrupted AnimationTrack lifecycle gates', async () => {
  const f = await fixture();
  try {
    const cases = [{ id: 'interrupted-track', name: 'Transition stop does not become natural completion', duration: 0.8,
      events: [{ at: 0, kind: 'trigger' as const, trigger: 'Act' }, { at: 0.2, kind: 'trigger' as const, trigger: 'Release' }],
      expect: { trackLifecycles: [{ stateId: 'attack', status: 'stopped' as const, playbackCount: 1,
        latestEndReason: 'transition' as const }] } }];
    const preview = await f.history.preview('Interrupted track lifecycle contract', f.graph.id, cases);
    const plan = await f.history.create('Interrupted track lifecycle contract', f.graph.id, cases, preview.draftFingerprint);
    const run = await f.history.run(plan.id, plan.planFingerprint);
    assert.equal(run.report.status, 'passed', JSON.stringify(run.report.cases[0]?.failures));
    const savedCase = animationGraphTimelineCaseReportSchema.parse(run.report.cases[0]);
    assert.deepEqual(savedCase.trackLifecycleChecks?.[0]?.checks.map(check => [check.property, check.passed]), [
      ['status', true], ['playbackCount', true], ['latestEndReason', true],
    ]);
    assert.equal((savedCase.trackLifecycleChecks?.[0]?.observed as { latestEndReason?: string } | null)?.latestEndReason, 'transition');
    const persisted = JSON.parse(await readFile(join(f.root, 'timeline-history', 'runs', `${run.id}.json`), 'utf8')) as { run: { report: { cases: unknown[] } } };
    const persistedCase = animationGraphTimelineCaseReportSchema.parse(persisted.run.report.cases[0]);
    assert.equal(persistedCase.trackLifecycleChecks?.[0]?.status, 'passed', 'the immutable run file should retain verified track lifecycle checks');

    const invalidCases = [{ ...cases[0]!, expect: { trackLifecycles: [{ stateId: 'attack', status: 'completed' as const }] } }];
    const invalidPreview = await f.history.preview('Reject false natural completion', f.graph.id, invalidCases);
    const invalidPlan = await f.history.create('Reject false natural completion', f.graph.id, invalidCases, invalidPreview.draftFingerprint);
    const invalidRun = await f.history.run(invalidPlan.id, invalidPlan.planFingerprint);
    assert.equal(invalidRun.report.status, 'failed', 'the saved-plan gate should reject an interrupted clip labeled completed');
    assert.equal(invalidRun.report.cases[0]?.trackLifecycleChecks?.[0]?.status, 'failed');
    const comparison = await f.history.compare(run.id, invalidRun.id);
    const lifecycleRegression = comparison.cases[0]?.checkChanges.find(check => check.expectation === 'trackLifecycle:attack:status');
    assert.equal(lifecycleRegression?.kind, 'track_lifecycle');
    assert.equal(lifecycleRegression?.status, 'regression', 'history comparison should call out the false completion as a lifecycle regression');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('saved timeline comparisons persist and detect phase-donor regressions', async () => {
  const f = await fixture();
  try {
    const graph = await f.graphs.save({ kind: 'animation_graph', name: 'Phase donor history', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number', defaultValue: 0, min: 0, max: 1 }],
      states: [
        { id: 'blend', name: 'Locomotion Blend', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'blend' }, { value: 0.5, stateId: 'idle' }, { value: 1, stateId: 'recovery' }] } },
        { id: 'idle', name: 'Idle channel', animationId: f.idle.id, speed: 1 },
        { id: 'recovery', name: 'Recovery channel', animationId: f.recovery.id, speed: 1 },
      ], transitions: [] });
    const assetSetFingerprint = 'd'.repeat(64);
    const makeCase = (idleStartPhase: number) => [{ id: 'retarget-phase', name: 'Pin source clock donation', duration: 0.2,
      events: [{ at: 0.1, kind: 'set_parameters' as const, values: { speed: 1 } }],
      observedBlendAnimationLengths: { blend: { blend: 4, idle: 4, recovery: 3 } },
      observedBlendAnimationPlaybackSpeeds: { blend: { blend: 1, idle: 1, recovery: 1 } },
      observedBlendAnimationStartPhases: { blend: { blend: idleStartPhase, idle: 0, recovery: 0.3 } },
      observedBlendAnimationAssetSetFingerprint: assetSetFingerprint, expectedBlendAnimationAssetSetFingerprint: assetSetFingerprint,
      expect: { phaseDonors: [{ inputIndex: 0, stateId: 'blend', restartedStateIds: [],
        normalizedPhase: { min: 0.124999999, max: 0.125000001 } }] } }];
    const beforeCases = makeCase(0.1), afterCases = makeCase(0.2);
    const beforePreview = await f.history.preview('Phase donor measured timing baseline', graph.id, beforeCases);
    assert.deepEqual(beforePreview.coveragePreview.phaseDonorAssertions, { assertions: 1,
      cases: [{ caseId: 'retarget-phase', inputIndex: 0, at: null, donorStateId: 'blend', restartedStateIds: [] }] });
    const afterPreview = await f.history.preview('Phase donor changed clock', graph.id, afterCases);
    const beforePlan = await f.history.create('Phase donor measured timing baseline', graph.id, beforeCases, beforePreview.draftFingerprint);
    const afterPlan = await f.history.create('Phase donor changed clock', graph.id, afterCases, afterPreview.draftFingerprint);
    const beforeRun = await f.history.run(beforePlan.id, beforePlan.planFingerprint);
    const afterRun = await f.history.run(afterPlan.id, afterPlan.planFingerprint);
    assert.equal(beforeRun.report.status, 'passed', JSON.stringify(beforeRun.report.cases[0]?.failures));
    assert.equal(afterRun.report.status, 'failed');
    const savedCase = animationGraphTimelineCaseReportSchema.parse(beforeRun.report.cases[0]);
    assert.deepEqual(savedCase.phaseDonorChecks?.[0]?.observed, { stateId: 'blend', restartedStateIds: [],
      normalizedPhase: 0.125, currentWeight: 1, targetWeight: 1 });
    const persisted = JSON.parse(await readFile(join(f.root, 'timeline-history', 'runs', `${afterRun.id}.json`), 'utf8')) as { run: { report: { cases: unknown[] } } };
    assert.equal(animationGraphTimelineCaseReportSchema.parse(persisted.run.report.cases[0]).phaseDonorChecks?.[0]?.status, 'failed');
    const comparison = await f.history.compare(beforeRun.id, afterRun.id);
    const regression = comparison.cases[0]!.checkChanges.find(check => check.expectation === 'phaseDonor:0@event:normalizedPhase');
    assert.equal(regression?.kind, 'phase_donor');
    assert.equal(regression?.status, 'regression');
    assert.equal(regression?.after?.observed, 0.225);
    assert.equal(comparison.summary.checkRegressions, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
