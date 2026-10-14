import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnimationGraphLibrary, animationGraphSchema, diagnoseAnimationGraph, evaluateAnimationGraphTransition } from '../src/animation-graph.js';
import { Library } from '../src/library.js';
import { animationPreset, animationSchema, type AnimationRecipe } from '../src/recipes.js';
import { createComposedJointSampler } from '../src/animation-patch.js';
import { quaternionAngularDistanceDegrees, weightedQuaternionMean } from '../src/quaternion-blend.js';
import { fingerprint } from '../src/inspection.js';
import { animationGraphEventOrderSensitivitySchema, animationGraphEventOrderingDiagnosticsSchema, animationGraphSimulationInputSchema,
  simulateAnimationGraphTimeline } from '../src/animation-graph-simulation.js';
import { animationGraphTimelineCaseReportSchema } from '../src/animation-graph-timeline-history.js';
import { animationGraphTimelineSuiteSchema, runAnimationGraphTimelineSuite } from '../src/animation-graph-timeline-tests.js';
import { analyzeBlendSpacePhaseSynchronization, analyzeBlendSpacePhaseSynchronizationBatch } from '../src/animation-graph-phase-sync.js';
import { generateAnimationGraphRuntime } from '../src/animation-graph-runtime.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'motion-animation-graph-'));
  const animations = new Library(join(root, 'animations'));
  const idle = await animations.save(animationPreset('idle', 'Graph Idle', 2, 0.4));
  const attack = await animations.save(animationPreset('slash', 'Graph Attack', 1, 0.8));
  const recovery = await animations.save(animationPreset('idle', 'Graph Recovery', 1.5, 0.3));
  const library = new AnimationGraphLibrary(join(root, 'graphs'), animations);
  const graph = {
    kind: 'animation_graph' as const, name: 'Combat', entryState: 'idle', sampleRate: 30,
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 2 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [
      { id: 'beginAttack', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.2 },
      { id: 'finishAttack', from: 'attack', to: 'recovery', trigger: 'AnimationEnded', blendSeconds: 0.1 },
      { id: 'returnIdle', from: 'recovery', to: 'idle', trigger: 'AnimationEnded', blendSeconds: 0.15 },
    ],
  };
  return { root, animations, idle, attack, recovery, library, graph };
}

test('phase synchronization analysis is permutation-stable and bounds deterministic randomized clock traces', () => {
  let seed = 0x51f15e;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const stateIds = ['sourceA', 'sourceB', 'sourceC'];
  const circularDistance = (difference: number) => {
    const wrapped = ((difference % 1) + 1) % 1;
    return Math.min(wrapped, 1 - wrapped);
  };
  for (let trial = 0; trial < 64; trial++) {
    const phases = new Map(stateIds.map(stateId => [stateId, random()]));
    const speeds = new Map(stateIds.map(stateId => [stateId, 0.1 + random() * 2]));
    const durations = new Map(stateIds.map(stateId => [stateId, 0.4 + random() * 2]));
    const intervalSeconds = 0.005 + random() * 0.2;
    const samples = [0, intervalSeconds].map(at => ({ at, blendSpaceEvaluations: [{ controllerStateId: 'blend',
      samples: stateIds.map(stateId => ({ stateId, playback: { isPlaying: true,
        normalizedPhase: ((phases.get(stateId)! + speeds.get(stateId)! / durations.get(stateId)! * at) % 1 + 1) % 1,
        playbackSpeed: speeds.get(stateId)! } })) }] }));
    const sourceDurations = new Map(durations);
    const analyzed = analyzeBlendSpacePhaseSynchronization(samples, 'blend', stateIds, sourceDurations);
    const permuted = analyzeBlendSpacePhaseSynchronization([...samples].reverse().map(sample => ({ ...sample,
      blendSpaceEvaluations: sample.blendSpaceEvaluations.map(evaluation => ({ ...evaluation,
        samples: [...evaluation.samples].reverse() })) })), 'blend', [...stateIds].reverse(), sourceDurations);
    assert.deepEqual(permuted, analyzed, `analysis should be invariant to source/sample ordering (trial ${trial})`);
    assert.equal(analyzed.coverageStatus, 'complete');
    assert.equal(analyzed.controllerActiveSampleCount, 2);
    assert.equal(analyzed.controllerActiveIntervalCount, 1);
    assert.equal(analyzed.interpolatedIntervalCount, 1);
    assert.ok(analyzed.maxCircularPhaseDifference !== null && analyzed.maxCircularPhaseDifference <= 0.5);

    let denseMaximum = 0;
    for (let step = 0; step <= 2000; step++) {
      const at = intervalSeconds * step / 2000;
      const samplePhases = stateIds.map(stateId => (phases.get(stateId)!
        + speeds.get(stateId)! / durations.get(stateId)! * at) % 1);
      for (let left = 0; left < samplePhases.length; left++) for (let right = left + 1; right < samplePhases.length; right++) {
        denseMaximum = Math.max(denseMaximum, circularDistance(samplePhases[left]! - samplePhases[right]!));
      }
    }
    assert.ok(analyzed.maxCircularPhaseDifference! + 1e-12 >= denseMaximum,
      `analytic interval maximum must bound dense samples (trial ${trial})`);
  }
  const emptyCoverage = analyzeBlendSpacePhaseSynchronization([], 'blend', stateIds, new Map());
  assert.equal(emptyCoverage.coverageStatus, 'not_observed');
  assert.equal(emptyCoverage.maxCircularPhaseDifference, null);
  assert.deepEqual(analyzeBlendSpacePhaseSynchronizationBatch([], []), [],
    'a graph without BlendSpace controllers should skip shared trace indexing entirely');
  assert.throws(() => analyzeBlendSpacePhaseSynchronization([], 'blend', ['sourceA'], new Map()), /at least two unique/i);
  const completeSamples = [0, 1].map(at => ({ at, blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: stateIds.map(stateId => ({
    stateId, playback: { normalizedPhase: at * 0.1, playbackSpeed: 1, isPlaying: true },
  })) }] }));
  const pointOnlyCoverage = analyzeBlendSpacePhaseSynchronization([completeSamples[0]!], 'blend', stateIds,
    new Map(stateIds.map(stateId => [stateId, 10])));
  assert.equal(pointOnlyCoverage.coverageStatus, 'incomplete');
  assert.equal(pointOnlyCoverage.comparableSampleCount, 1);
  assert.equal(pointOnlyCoverage.interpolatedIntervalCount, 0);
  const sharedControllerSamples = completeSamples.map(sample => ({ ...sample,
    blendSpaceEvaluations: [...sample.blendSpaceEvaluations, { ...sample.blendSpaceEvaluations[0]!, controllerStateId: 'blendSecondary' }] }));
  const sharedDurationMap = new Map(stateIds.map(stateId => [stateId, 10]));
  const sharedRequests = [
    { controllerStateId: 'blend', sourceStateIds: stateIds, sourceDurations: sharedDurationMap },
    { controllerStateId: 'blendSecondary', sourceStateIds: stateIds, sourceDurations: sharedDurationMap },
  ];
  const batchedAnalysis = analyzeBlendSpacePhaseSynchronizationBatch(sharedControllerSamples, sharedRequests);
  assert.deepEqual(batchedAnalysis, sharedRequests.map(request => analyzeBlendSpacePhaseSynchronization(sharedControllerSamples,
    request.controllerStateId, request.sourceStateIds, request.sourceDurations)),
  'batch indexing should preserve single-controller results for every BlendSpace');
  assert.deepEqual(analyzeBlendSpacePhaseSynchronizationBatch([...sharedControllerSamples].reverse().map(sample => ({ ...sample,
    blendSpaceEvaluations: [...sample.blendSpaceEvaluations].reverse() })), sharedRequests), batchedAnalysis,
  'batch indexing must remain deterministic when simulator samples and controller evaluations are permuted');
  assert.throws(() => analyzeBlendSpacePhaseSynchronization([...completeSamples, { ...completeSamples[1]!, at: 0 }],
    'blend', stateIds, sharedDurationMap), /sample times must be unique/i,
  'duplicate timestamps must not silently create ambiguous phase evidence');
  const duplicateControllerEvaluation = { ...completeSamples[0]!, blendSpaceEvaluations: [
    ...completeSamples[0]!.blendSpaceEvaluations, completeSamples[0]!.blendSpaceEvaluations[0]!,
  ] };
  assert.throws(() => analyzeBlendSpacePhaseSynchronization([duplicateControllerEvaluation], 'blend', stateIds, sharedDurationMap),
    /duplicate controller evaluation/i, 'duplicate controller evaluations must not silently discard phase evidence');
  const duplicateSourceEvaluation = { ...completeSamples[0]!, blendSpaceEvaluations: [{
    ...completeSamples[0]!.blendSpaceEvaluations[0]!,
    samples: [...completeSamples[0]!.blendSpaceEvaluations[0]!.samples, completeSamples[0]!.blendSpaceEvaluations[0]!.samples[0]!],
  }] };
  assert.throws(() => analyzeBlendSpacePhaseSynchronization([duplicateSourceEvaluation], 'blend', stateIds, sharedDurationMap),
    /duplicate source state/i, 'duplicate source channels must not silently select the first phase observation');
  const missingClockSamples = completeSamples.map((sample, index) => index === 0 ? sample : ({ ...sample,
    blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: sample.blendSpaceEvaluations[0]!.samples.map(source => source.stateId === 'sourceC'
      ? { ...source, playback: { ...source.playback, isPlaying: false } } : source) }] }));
  const missingClockCoverage = analyzeBlendSpacePhaseSynchronization(missingClockSamples, 'blend', stateIds,
    new Map(stateIds.map(stateId => [stateId, 10])));
  assert.equal(missingClockCoverage.coverageStatus, 'incomplete');
  assert.equal(missingClockCoverage.incompleteSampleCount, 1);
  assert.equal(missingClockCoverage.incompleteIntervalCount, 1);
  assert.equal(missingClockCoverage.interpolatedIntervalCount, 0);
  const missingDurationCoverage = analyzeBlendSpacePhaseSynchronization(completeSamples, 'blend', stateIds,
    new Map([['sourceA', 10], ['sourceB', 10]]));
  assert.equal(missingDurationCoverage.coverageStatus, 'incomplete');
  assert.equal(missingDurationCoverage.unevaluableIntervalCount, 1);
  assert.equal(missingDurationCoverage.interpolatedIntervalCount, 0);
  const discontinuousPhaseSamples = completeSamples.map((sample, index) => index === 0 ? sample : ({ ...sample,
    blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: sample.blendSpaceEvaluations[0]!.samples.map(source => source.stateId === 'sourceC'
      ? { ...source, playback: { ...source.playback, normalizedPhase: 0.3 } } : source) }] }));
  const discontinuousPhaseCoverage = analyzeBlendSpacePhaseSynchronization(discontinuousPhaseSamples, 'blend', stateIds,
    new Map(stateIds.map(stateId => [stateId, 10])));
  assert.equal(discontinuousPhaseCoverage.coverageStatus, 'incomplete',
    'endpoint phases that contradict the constant-speed clock model must not be interpolated as complete coverage');
  assert.equal(discontinuousPhaseCoverage.comparableSampleCount, 2,
    'valid endpoint measurements remain useful even when the gap between them is not reconstructable');
  assert.equal(discontinuousPhaseCoverage.unevaluableIntervalCount, 1);
  assert.equal(discontinuousPhaseCoverage.interpolatedIntervalCount, 0);
  const outOfRangePhaseSamples = completeSamples.map((sample, index) => index === 1 ? ({ ...sample,
    blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: sample.blendSpaceEvaluations[0]!.samples.map(source => source.stateId === 'sourceC'
      ? { ...source, playback: { ...source.playback, normalizedPhase: 1 } } : source) }] }) : sample);
  const outOfRangePhaseCoverage = analyzeBlendSpacePhaseSynchronization(outOfRangePhaseSamples, 'blend', stateIds,
    new Map(stateIds.map(stateId => [stateId, 10])));
  assert.equal(outOfRangePhaseCoverage.coverageStatus, 'incomplete',
    'normalized phases at 1 or outside [0, 1) must not be accepted as valid wrapped clocks');
  assert.equal(outOfRangePhaseCoverage.incompleteSampleCount, 1);
  assert.equal(outOfRangePhaseCoverage.incompleteIntervalCount, 1);
  assert.equal(outOfRangePhaseCoverage.interpolatedIntervalCount, 0);
  const multiSourceIds = ['sourceA', 'sourceB', 'sourceC'];
  const multiSourceSamples = [0, 1].map(at => ({ at, blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: [
    { stateId: 'sourceA', playback: { normalizedPhase: 0, playbackSpeed: 0, isPlaying: true } },
    { stateId: 'sourceB', playback: { normalizedPhase: 0.1 + 0.4 * at, playbackSpeed: 0.4, isPlaying: true } },
    { stateId: 'sourceC', playback: { normalizedPhase: 0.25 + 0.4 * at, playbackSpeed: 0.4, isPlaying: true } },
  ] }] }));
  const tiedWorstPairs = analyzeBlendSpacePhaseSynchronization(multiSourceSamples, 'blend', multiSourceIds,
    new Map(multiSourceIds.map(stateId => [stateId, 1])));
  assert.equal(tiedWorstPairs.maxCircularPhaseDifference, 0.5);
  assert.ok(Math.abs(tiedWorstPairs.worstAt! - 0.625) < 1e-12,
    'equally severe pairwise drift reports the earliest worst instant, even if a sample-point tie was visited first');
  assert.deepEqual(tiedWorstPairs.worstPair, { stateIds: ['sourceA', 'sourceC'], circularDifference: 0.5 });
  assert.deepEqual(tiedWorstPairs.worstInterval, { startAt: 0, endAt: 1 });
  const speedChangeSamples = [
    { at: 0, phases: [0, 0.1], speeds: [1, 1] },
    { at: 0.5, phases: [0.5, 0.6], speeds: [1, 0.2] },
    { at: 1, phases: [0, 0.7], speeds: [1, 0.2] },
  ].map(sample => ({ at: sample.at, blendSpaceEvaluations: [{ controllerStateId: 'blend', samples: ['sourceA', 'sourceB'].map((stateId, index) => ({
    stateId, playback: { normalizedPhase: sample.phases[index]!, playbackSpeed: sample.speeds[index]!, isPlaying: true },
  })) }] }));
  const speedChangeResult = analyzeBlendSpacePhaseSynchronization(speedChangeSamples, 'blend', ['sourceB', 'sourceA'],
    new Map([['sourceA', 1], ['sourceB', 1]]));
  assert.ok(Math.abs(speedChangeResult.maxCircularPhaseDifference! - 0.3) < 1e-12);
  assert.equal(speedChangeResult.worstAt, 1);
  assert.equal(speedChangeResult.controllerActiveIntervalCount, 2,
    'a speed mutation at a sample boundary splits the constant-speed analysis into separately covered intervals');
  assert.equal(speedChangeResult.interpolatedIntervalCount, 2);
});

test('state graphs validate branch priorities and report reachability without pretending to judge quality', () => {
  const { graph } = { graph: {
    kind: 'animation_graph' as const, name: 'Reachability', entryState: 'idle', sampleRate: 30,
    states: ['idle', 'orphan', 'terminal'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [{ id: 'finish', from: 'idle', to: 'terminal', trigger: 'Finished', blendSeconds: 0.1 }],
  } };
  const diagnostics = diagnoseAnimationGraph(graph);
  assert.deepEqual(diagnostics.reachableStateIds, ['idle', 'terminal']);
  assert.deepEqual(diagnostics.unreachableStateIds, ['orphan']);
  assert.deepEqual(diagnostics.terminalStateIds, ['orphan', 'terminal']);
  assert.match(diagnostics.limitation, /separate runtime-export tool/);
  const branched = diagnoseAnimationGraph({ ...graph, transitions: [
    { ...graph.transitions[0]!, priority: 10 },
    { id: 'shadowed', from: 'idle', to: 'orphan', trigger: 'finished', priority: 0, guards: [], blendSeconds: 0 },
  ] });
  assert.equal(branched.transitionBranches.length, 1, 'trigger diagnostics should use the evaluator’s case-insensitive trigger matching');
  assert.deepEqual(branched.transitionBranches[0]?.unreachableTransitionIds, ['shadowed']);
  assert.equal(branched.transitionBranches[0]?.branches[1]?.shadowedByUnconditional, true);
  assert.throws(() => animationGraphSchema.parse({ ...graph, transitions: [
    ...graph.transitions, { id: 'finishAgain', from: 'idle', to: 'orphan', trigger: 'finished', blendSeconds: 0 },
  ] }), /distinct priorities/i);
  assert.throws(() => animationGraphSchema.parse({ ...graph, entryState: 'missing' }), /entryState/i);
});

test('BlendSpace1D graph states bind ordered samples to declared numeric parameters and existing states', async () => {
  const f = await fixture();
  try {
    const configuredGraph = { ...f.graph, parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 12 }],
      states: f.graph.states.map(state => state.id === 'idle' ? { ...state, blendSpace1D: { parameter: 'speed', samples: [
        { value: 0, stateId: 'idle' }, { value: 12, stateId: 'attack' },
      ] } } : state) };
    assert.doesNotThrow(() => animationGraphSchema.parse(configuredGraph));

    assert.throws(() => animationGraphSchema.parse({ ...configuredGraph, parameters: [] }), /Unknown BlendSpace1D parameter speed/i);
    assert.throws(() => animationGraphSchema.parse({ ...configuredGraph, parameters: [{ name: 'speed', type: 'boolean', defaultValue: false }] }), /must be numeric/i);
    assert.throws(() => animationGraphSchema.parse({ ...configuredGraph, states: configuredGraph.states.map(state => state.id === 'idle'
      ? { ...state, blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 12, stateId: 'missing' }] } } : state) }), /Unknown BlendSpace1D source state missing/i);
    assert.throws(() => animationGraphSchema.parse({ ...configuredGraph, states: configuredGraph.states.map(state => state.id === 'idle'
      ? { ...state, blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'attack' }, { value: 12, stateId: 'recovery' }] } } : state) }), /must include itself as a sample source/i);
    const partiallyUnreachableBlend = { ...configuredGraph,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 5 }],
      states: configuredGraph.states.map(state => state.id === 'idle' ? { ...state,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 5, stateId: 'attack' },
          { value: 12, stateId: 'recovery' }] } } : state) };
    const blendDiagnostics = diagnoseAnimationGraph(partiallyUnreachableBlend).blendSpaceDiagnostics[0]!;
    assert.deepEqual(blendDiagnostics.reachableSourceStateIds, ['idle', 'attack']);
    assert.deepEqual(blendDiagnostics.unreachableSourceStateIds, ['recovery'],
      'the AI-facing graph diagnostics should reveal clips outside the declared parameter’s reachable domain');
    assert.equal(blendDiagnostics.sources.find(source => source.stateId === 'attack')?.speedAuthority, 'blend_controller');
    assert.equal(blendDiagnostics.sources.find(source => source.stateId === 'attack')?.authoredStateSpeed,
      partiallyUnreachableBlend.states.find(state => state.id === 'attack')!.speed);
    assert.deepEqual(blendDiagnostics.sources.find(source => source.stateId === 'attack')?.witnessParameterValues, [5]);
    assert.doesNotThrow(() => animationGraphSchema.parse(partiallyUnreachableBlend),
      'out-of-range samples remain readable; diagnostics should surface the authoring issue without breaking old graph files');
    assert.equal(configuredGraph.states.find(state => state.id === 'idle')!.animationId, f.idle.id);
    assert.equal(configuredGraph.states.find(state => state.id === 'attack')!.animationId, f.attack.id);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace2D graph declarations validate directional sources and support parameterized timeline simulation', async () => {
  const f = await fixture();
  try {
    const graph = { ...f.graph, sampleRate: 20,
      parameters: [
        { name: 'moveX', type: 'number' as const, defaultValue: 0, min: -1, max: 1 },
        { name: 'moveY', type: 'number' as const, defaultValue: 0, min: -1, max: 1 },
      ],
      states: f.graph.states.map(state => state.id === 'idle' ? { ...state, blendSpace2D: {
        xParameter: 'moveX', yParameter: 'moveY', samples: [
          { x: 0, y: 0, stateId: 'idle' }, { x: 1, y: 0, stateId: 'attack' }, { x: 0, y: 1, stateId: 'recovery' },
        ],
      } } : state) };
    assert.doesNotThrow(() => animationGraphSchema.parse(graph));
    const diagnostics = diagnoseAnimationGraph(graph).blendSpaceDiagnostics[0]!;
    assert.deepEqual(diagnostics.reachableSourceStateIds, ['idle', 'attack', 'recovery']);
    assert.ok('analysis' in diagnostics);
    if ('analysis' in diagnostics) assert.equal(diagnostics.analysis, 'continuous_piecewise_linear_maximum');
    const recoveryDiagnostics = diagnostics.sources.find(source => source.stateId === 'recovery');
    assert.ok(recoveryDiagnostics && 'samplePosition' in recoveryDiagnostics);
    assert.deepEqual(recoveryDiagnostics.samplePosition, { x: 0, y: 1 });
    assert.equal(recoveryDiagnostics.maximumReachableWeight, 1);
    assert.equal(recoveryDiagnostics.witnessParameterValues.length, 1);
    assert.ok(recoveryDiagnostics.witnessParameterValues[0]!.x >= -1 && recoveryDiagnostics.witnessParameterValues[0]!.x <= 1);
    assert.ok(recoveryDiagnostics.witnessParameterValues[0]!.y >= -1 && recoveryDiagnostics.witnessParameterValues[0]!.y <= 1);
    const representativeDiagnostics = diagnoseAnimationGraph({ ...graph,
      parameters: graph.parameters.map(parameter => ({ name: parameter.name, type: 'number' as const,
        defaultValue: parameter.defaultValue })) }).blendSpaceDiagnostics[0]!;
    assert.ok('analysisCoverage' in representativeDiagnostics);
    if ('analysisCoverage' in representativeDiagnostics) {
      assert.equal(representativeDiagnostics.analysisCoverage, 'authored_extent_for_unbounded_axes');
      assert.deepEqual(representativeDiagnostics.effectiveParameterRanges, { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } });
    }
    const baseRecipe = animationSchema.parse(f.idle.recipe);
    const blendRecipes = [f.idle, f.attack, f.recovery].map(animation => ({ ...animationSchema.parse(animation.recipe),
      loop: baseRecipe.loop, priority: baseRecipe.priority, markers: [] }));
    assert.throws(() => animationGraphSchema.parse({ ...graph,
      parameters: graph.parameters.map(parameter => parameter.name === 'moveY' ? { ...parameter, type: 'boolean' as const, defaultValue: false } : parameter) }), /must be numeric/i);
    assert.throws(() => animationGraphSchema.parse({ ...graph,
      states: graph.states.map(state => state.id === 'idle' ? { ...state,
        blendSpace1D: { parameter: 'moveX', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'attack' }] } } : state) }), /only one blend-space controller/i);
    const blendSimulation = simulateAnimationGraphTimeline(graph, { [f.idle.id]: blendRecipes[0]!, [f.attack.id]: blendRecipes[1]!,
      [f.recovery.id]: blendRecipes[2]! }, { duration: 0.5, sampleRateHz: 10,
        initialParameters: { moveX: 0.25, moveY: 0.5 }, sampleTimes: [0, 0.25],
        events: [{ at: 0.25, kind: 'set_parameters', values: { moveX: 0, moveY: 0 } }] });
    const atStart = blendSimulation.blendSamples.find(sample => sample.at === 0)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(atStart.axisValues, { x: 0.25, y: 0.5 });
    assert.deepEqual(atStart.samples.map(sample => [sample.stateId, sample.weight]), [['idle', 0.25], ['attack', 0.25], ['recovery', 0.5]]);
    const afterUpdate = blendSimulation.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(afterUpdate.samples.map(sample => [sample.stateId, sample.targetPoseContributionWeight]),
      [['idle', 1], ['attack', 0], ['recovery', 0]]);
    const diagonalRamp = simulateAnimationGraphTimeline(graph, { [f.idle.id]: blendRecipes[0]!, [f.attack.id]: blendRecipes[1]!,
      [f.recovery.id]: blendRecipes[2]! }, { duration: 0.5, sampleRateHz: 10,
      initialParameters: { moveX: 0, moveY: 0 },
      sampleTimes: [0.25],
      events: [{ at: 0, kind: 'ramp_parameters', values: { moveX: 1, moveY: 1 }, duration: 0.5, easing: 'smoothstep' }] });
    const diagonalMidpoint = diagonalRamp.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(diagonalMidpoint.axisValues, { x: 0.5, y: 0.5 });
    assert.deepEqual(diagonalMidpoint.samples.map(sample => [sample.stateId, sample.weight]),
      [['idle', 0], ['attack', 0.5], ['recovery', 0.5]],
      'a single multi-parameter ramp should drive both axes of the 2D directional blend');
    assert.equal(blendSimulation.blendModel.phaseSynchronization[0]?.coverageStatus, 'complete');
    assert.doesNotThrow(() => generateAnimationGraphRuntime(graph, blendRecipes.map(({ duration, loop, priority, markers }) => ({ duration, loop, priority, markers })),
      { idle: '101', attack: '102', recovery: '103' }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace1D simulation evaluates live parameters into normalized-time weighted clip poses', async () => {
  const f = await fixture();
  try {
    const idleRecipe = { ...animationSchema.parse(f.idle.recipe), priority: 'Movement' as const, markers: [] };
    const alternateRecipe = { ...idleRecipe, name: 'Graph Alternate Locomotion', duration: 1,
      tracks: idleRecipe.tracks.map(track => ({ ...track, keys: track.keys.map(key => ({ ...key,
        time: key.time / idleRecipe.duration,
        rotation: [key.rotation[0] + 20, key.rotation[1], key.rotation[2]] as [number, number, number] })) })) };
    const graph = { ...f.graph, sampleRate: 20, entryState: 'idle', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Idle controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'alternate' }] } },
        { id: 'alternate', name: 'Alternate clip', animationId: f.attack.id, speed: 1 },
      ], transitions: [] };
    const result = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 1, initialParameters: { speed: 0 }, sampleTimes: [0, 0.5, 0.75], includeBlendSamplePoses: false,
      events: [{ at: 0.5, kind: 'set_parameters', values: { speed: 5 } },
        { at: 0.75, kind: 'set_parameters', values: { speed: 0 } }],
    });
    const start = result.blendSamples.find(sample => sample.at === 0)!;
    const middle = result.blendSamples.find(sample => sample.at === 0.5)!;
    assert.deepEqual(result.blendModel.phaseSynchronization,
      [{ controllerStateId: 'idle', maxCircularPhaseDifference: 0, worstAt: 0,
        worstPair: { stateIds: ['alternate', 'idle'], circularDifference: 0 },
        worstInterval: null, controllerActiveSampleCount: 21, comparableSampleCount: 21, incompleteSampleCount: 0,
        controllerActiveIntervalCount: 20, incompleteIntervalCount: 0, unevaluableIntervalCount: 0,
        interpolatedIntervalCount: 20, coverageStatus: 'complete', measurementBasis: 'sampled_points_and_constant_speed_intervals',
        limitation: 'Circular normalized phase differences are estimates from the selected authored or asset-bound live timing maps. Between sampled timestamps, playback speed is assumed constant until the next simulation event/sample boundary. Coverage status and active, incomplete, unevaluable, and evaluated point/interval counts are explicit; not-observed or incomplete coverage is not a passing result.' }],
      'the simulator should report interval-aware phase drift and explicit evidence coverage');
    assert.deepEqual(start.blendSpaceEvaluations[0]?.samples.map(sample => [sample.stateId, sample.weight,
      sample.poseContributionWeight, sample.targetPoseContributionWeight]), [['idle', 1, 1, 1], ['alternate', 0, 0, 0]]);
    assert.deepEqual(middle.blendSpaceEvaluations[0]?.samples.map(sample => [sample.stateId, sample.weight,
      sample.poseContributionWeight, sample.targetPoseContributionWeight]), [['idle', 0.5, 0.5, 0.5], ['alternate', 0.5, 0.5, 0.5]]);
    assert.deepEqual(middle.blendSpaceEvaluations[0]?.samples.map(sample => [sample.stateId,
      sample.playback.timeSeconds, sample.playback.normalizedPhase, sample.playback.playbackSpeed,
      sample.playback.authoredStateSpeed, sample.playback.isPlaying]),
    [['idle', 0.5, 0.25, 1, 1, true], ['alternate', 0.25, 0.25, 0.5, 1, true]],
    'blend diagnostics should expose each source clock, effective speed and authored state speed');
    const returnedToIdle = result.blendSamples.find(sample => sample.at === 0.75)!.blendSpaceEvaluations[0]!;
    assert.equal(returnedToIdle.samples[1]!.targetPoseContributionWeight, 0);
    assert.equal(returnedToIdle.samples[1]!.playback.isPlaying, true,
      'AdjustWeight(0) must fade a source to zero without incorrectly stopping its Roblox playback clock');
    const observedLengths = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, initialParameters: { speed: 5 }, sampleTimes: [0.5], poseJoints: [idleRecipe.tracks[0]!.joint],
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    });
    const observedSample = observedLengths.blendSamples.find(sample => sample.at === 0.5)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(observedSample.samples.map(sample => [sample.stateId, sample.playback.timeSeconds,
      sample.playback.normalizedPhase, sample.playback.playbackSpeed]),
    [['idle', 0.5, 1 / 6, 1], ['alternate', 0.125, 1 / 6, 0.25]],
    'observed Roblox lengths should use runtime speed ratios and keep source normalized phase aligned');
    assert.deepEqual(observedLengths.blendModel.playbackTiming.controllers[0]?.clips,
      [{ stateId: 'idle', observedLengthSeconds: 3, observedStartPhase: null, playbackSpeed: 1,
        playbackCycleDurationSeconds: 3, playbackCycleDurationRatioToController: 1 },
        { stateId: 'alternate', observedLengthSeconds: 0.75, observedStartPhase: null, playbackSpeed: 0.25,
          playbackCycleDurationSeconds: 3, playbackCycleDurationRatioToController: 1 }],
      'the simulator should return explicit runtime timing provenance for each clip');
    assert.equal(observedLengths.blendModel.playbackTiming.controllers[0]?.controllerCycleDurationSeconds, 3);
    assert.equal(observedLengths.blendModel.playbackTiming.assetSetFingerprint, 'a'.repeat(64));
    assert.equal(observedLengths.blendModel.playbackTiming.assetSetFingerprintStatus, 'matched');
    const unsynchronizedLengths = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, initialParameters: { speed: 5 }, sampleTimes: [0.5],
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    });
    const unsynchronizedSamples = unsynchronizedLengths.blendSamples.find(sample => sample.at === 0.5)!.blendSpaceEvaluations[0]!.samples;
    assert.equal(unsynchronizedSamples[1]!.playback.playbackSpeed, 0.2);
    assert.equal(unsynchronizedSamples[1]!.playback.normalizedPhase, 0.2 * 0.5 / 0.75,
      'live unsynchronized speeds must be used directly instead of inferring the post-sync length ratio');
    assert.equal(unsynchronizedLengths.blendModel.playbackTiming.controllers[0]?.clips[1]?.playbackCycleDurationSeconds, 3.75);
    assert.equal(unsynchronizedLengths.blendModel.playbackTiming.controllers[0]?.clips[1]?.playbackCycleDurationRatioToController, 1.25,
      'the timing report should expose that this source clip takes 25% longer to complete a cycle at its captured live speed');
    const phaseSeeded = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.25, initialParameters: { speed: 5 }, sampleTimes: [0, 0.25],
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.5, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    });
    const phaseSeededStart = phaseSeeded.blendSamples.find(sample => sample.at === 0)!.blendSpaceEvaluations[0]!;
    const phaseSeededLater = phaseSeeded.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(phaseSeededStart.samples.map(sample => sample.playback.normalizedPhase), [0.5, 0.25]);
    assert.deepEqual(phaseSeededLater.samples.map(sample => sample.playback.normalizedPhase), [7 / 12, 19 / 60],
      'simulated source clocks should advance from their captured Roblox phase without forcing phase alignment');
    assert.deepEqual(phaseSeeded.blendModel.playbackTiming.controllers[0]?.clips.map(clip => clip.observedStartPhase), [0.5, 0.25]);
    assert.ok(Math.abs(phaseSeeded.blendModel.phaseSynchronization[0]!.maxCircularPhaseDifference! - (4 / 15)) < 1e-12,
      'phase drift diagnostics must report the worst accumulated mismatch from deliberately unsynchronized live clocks');
    const wrappedPhases = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.1, sampleRateHz: 10, initialParameters: { speed: 5 },
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.99, alternate: 0.01 } },
      observedBlendAnimationAssetSetFingerprint: 'b'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'b'.repeat(64),
    });
    assert.ok(Math.abs(wrappedPhases.blendModel.phaseSynchronization[0]!.maxCircularPhaseDifference! - 0.02) < 1e-12,
      'phase drift summaries must use circular distance across the loop seam rather than report a false 0.98-cycle mismatch');
    const intervalSummary = (sampleRateHz: number) => simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { duration: 0.5, sampleRateHz,
        initialParameters: { speed: 5 },
        observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.499, alternate: 0 } },
        observedBlendAnimationAssetSetFingerprint: 'f'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'f'.repeat(64),
      }).blendModel.phaseSynchronization[0]!;
    const intervalSummary30Hz = intervalSummary(30);
    const intervalSummary15Hz = intervalSummary(15);
    assert.equal(intervalSummary30Hz.maxCircularPhaseDifference, 0.5,
      'standalone simulator diagnostics must detect a half-cycle peak between sampled frames');
    assert.ok(Math.abs(intervalSummary30Hz.worstAt! - 0.015) < 1e-12);
    assert.equal(intervalSummary15Hz.maxCircularPhaseDifference, intervalSummary30Hz.maxCircularPhaseDifference,
      'standalone phase drift summaries must use the same interval analysis independent of sample rate');
    assert.ok(Math.abs(intervalSummary15Hz.worstAt! - intervalSummary30Hz.worstAt!) < 1e-12);
    assert.equal(intervalSummary30Hz.coverageStatus, 'complete');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.25, observedBlendAnimationStartPhases: { idle: { idle: 0.5, alternate: 0.25 } },
    }), /starting phases require the matching complete Roblox length and playback-speed maps/i,
    'phase snapshots cannot be mistaken for portable timing calibration without asset-bound lengths and speeds');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.25 } },
    }), /must be bound to both the runtime snapshot and expected export asset-set fingerprints/i,
    'measured lengths must not be accepted without the export/runtime asset identity binding');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'b'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }), /different graph\/published animation asset set/i,
    'live blend lengths captured from a different export must not enter the simulation');
    const observedPose = observedLengths.composedPoseSamples.find(sample => sample.at === 0.5)!.joints[0]!;
    const expectedObservedPoseByState = new Map([
      ['idle', createComposedJointSampler(idleRecipe, observedPose.joint)!(idleRecipe.duration / 6).position],
      ['alternate', createComposedJointSampler(alternateRecipe, observedPose.joint)!(alternateRecipe.duration / 6).position],
    ]);
    assert.ok(observedPose.contributors.every(contributor => Math.hypot(...contributor.position.map((value, axis) =>
      value - expectedObservedPoseByState.get(contributor.stateId)![axis]!)) < 1e-9),
    'observed asset lengths should alter playback clocks without sampling recipe poses outside normalized authored time');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { idle: { idle: 3 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }), /must include every sample of BlendSpace controller idle/i,
    'partial measured lengths must not silently mix runtime and authored speed ratios');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { missing: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { missing: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }), /unknown graph controller missing/i,
    'timing measurements must be bound to actual BlendSpace controller identifiers');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { idle: { idle: 3, recovery: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, recovery: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }), /contains non-sample state IDs: recovery/i,
    'a controller measurement set must reject states that are not its declared samples');
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.5, observedBlendAnimationLengths: { alternate: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { alternate: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }), /not a BlendSpace controller/i,
    'measurements must be keyed by a state that actually owns a BlendSpace');
    const sharedSourceGraph = { ...f.graph, parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 5, min: 0, max: 10 }],
      states: f.graph.states.map(state => state.id === 'idle' ? { ...state,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] },
      } : state.id === 'recovery' ? { ...state,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'attack' }, { value: 10, stateId: 'recovery' }] },
      } : state) };
    const independentlyCalibrated = simulateAnimationGraphTimeline(sharedSourceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: idleRecipe }, {
        duration: 0.25, observedBlendAnimationLengths: { idle: { idle: 3, attack: 0.75 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 0.25 } },
        observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
      });
    assert.deepEqual(independentlyCalibrated.blendModel.playbackTiming.controllers.map(controller =>
      [controller.controllerStateId, controller.source]), [
      ['idle', 'observed_roblox_lengths_and_speeds'], ['recovery', 'authored_recipe_durations'],
    ], 'controllers that share a source state must remain independently calibratable');
    const markedControllerRecipe = animationSchema.parse({ ...idleRecipe, markers: [{ name: 'Contact', time: 1, value: '' }] });
    const markedAlternateRecipe = animationSchema.parse({ ...alternateRecipe, markers: [{ name: 'Contact', time: 0.5, value: '' }] });
    const controllerNotAnchorGraph = { ...graph, states: graph.states.map(state => state.id === 'idle' ? { ...state,
      blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'alternate' }, { value: 10, stateId: 'idle' }] },
    } : state) };
    const controllerNotAnchor = simulateAnimationGraphTimeline(controllerNotAnchorGraph,
      { [f.idle.id]: markedControllerRecipe, [f.attack.id]: markedAlternateRecipe }, {
        duration: 0.4, initialParameters: { speed: 5 }, sampleTimes: [0.375],
        observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 4, alternate: 1 } },
        observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
      });
    assert.deepEqual(controllerNotAnchor.triggeredMarkers.map(marker => [marker.at, marker.stateId, marker.marker]),
      [[0.375, 'idle', 'Contact']],
      'controller-state markers must use that controller clip’s own observed Roblox length and playback speed');
    assert.ok(Math.abs(controllerNotAnchor.blendSamples.find(sample => sample.at === 0.375)!
      .blendSpaceEvaluations[0]!.samples[1]!.playback.normalizedPhase - 0.5) < 1e-12,
      'a non-anchor controller sample must still match the shared phase at its normalized authored marker');
    const middlePose = result.composedPoseSamples.find(sample => sample.at === 0.5)!.joints[0]!;
    assert.deepEqual(middlePose.contributors.map(contributor => contributor.stateId).sort(), ['alternate', 'idle']);
    assert.ok(Math.abs(middlePose.contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, 0) - 1) < 1e-12);
    const sourcePoses = [
      { stateId: 'idle', pose: createComposedJointSampler(idleRecipe, middlePose.joint)!(middle.blendSpaceEvaluations[0]!.samples[0]!.playback.timeSeconds), weight: 0.5 },
      { stateId: 'alternate', pose: createComposedJointSampler(alternateRecipe, middlePose.joint)!(middle.blendSpaceEvaluations[0]!.samples[1]!.playback.timeSeconds), weight: 0.5 },
    ];
    const expectedPosition = [0, 1, 2].map(axis => sourcePoses.reduce((sum, source) =>
      sum + source.pose.position[axis]! * source.weight, 0));
    const expectedRotation = weightedQuaternionMean(sourcePoses.map(source => ({
      rotation: source.pose.rotation, weight: source.weight,
    }))).rotation;
    assert.ok(Math.hypot(...middlePose.position.map((value, axis) => value - expectedPosition[axis]!)) < 1e-9,
      'the composed BlendSpace pose must sample every source at its normalized controller phase before weighting');
    assert.ok(quaternionAngularDistanceDegrees(middlePose.rotationQuaternion, expectedRotation) < 1e-5,
      'the composed BlendSpace orientation must match the weighted mean of source orientations at normalized phase');

    const alternateWithoutTorso = animationSchema.parse({ ...alternateRecipe,
      tracks: alternateRecipe.tracks.filter(track => track.joint !== middlePose.joint) });
    const missingBlendChannel = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateWithoutTorso }, {
        duration: 0.5, initialParameters: { speed: 5 }, sampleTimes: [0.5], poseJoints: [middlePose.joint],
      });
    const missingBlendJoint = missingBlendChannel.composedPoseSamples[0]!.joints[0]!;
    assert.deepEqual(missingBlendJoint.unanimatedTracks.map(track => [track.stateId, track.blendControllerStateId,
      track.trackWeight, track.targetTrackWeight, track.reason]), [['alternate', 'idle', 0.5, 0.5, 'joint_not_animated']],
    'AI pose evidence should identify the BlendSpace source, its current/target weight, and its missing authored joint channel');
    assert.equal(missingBlendJoint.residualWeight, 0.5,
      'a source clip missing the joint must retain its share as neutral local animation residual');
    assert.equal(missingBlendJoint.contributors[0]!.effectiveWeight, 0.5,
      'the source that does animate the joint must retain only its authored BlendSpace weight');
    const channelContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateWithoutTorso },
      { cases: [{ id: 'missing-channel', name: 'Pin expected BlendSpace channel coverage', duration: 0.5,
        initialParameters: { speed: 5 }, expect: { poses: [{ at: 0.5, joint: middlePose.joint,
          missingBlendChannels: [{ controllerStateId: 'idle', sourceStateId: 'alternate' }] }] } }] });
    assert.equal(channelContract.status, 'passed');
    assert.deepEqual(channelContract.cases[0]!.poseChecks[0]!.checks.map(check => [check.property, check.passed]), [
      ['missingBlendChannels', true],
    ], 'temporal regression plans should be able to pin intentional missing-channel coverage');
    const unexpectedMissingChannel = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateWithoutTorso },
      { cases: [{ id: 'unexpected-channel-gap', name: 'Reject an unplanned missing channel', duration: 0.5,
        initialParameters: { speed: 5 }, expect: { poses: [{ at: 0.5, joint: middlePose.joint, missingBlendChannels: [] }] } }] });
    assert.equal(unexpectedMissingChannel.status, 'failed');
    const missingChannelFailure = unexpectedMissingChannel.cases[0]!.failures[0]!;
    assert.match(missingChannelFailure.expectation, /missingBlendChannels/);
    assert.deepEqual(missingChannelFailure.diagnosis!.missingBlendChannels, [{ controllerStateId: 'idle', sourceStateId: 'alternate',
      priority: 'Movement', trackWeight: 0.5, targetTrackWeight: 0.5, playbackTimeSeconds: 0.25 }],
    'failed channel-coverage assertions should surface actionable per-source weights and timing');
    const alternateSourcePose = createComposedJointSampler(alternateRecipe, middlePose.joint)!(0.25);
    const sourcePoseContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-pose', name: 'Pin a BlendSpace source local pose', duration: 0.5, initialParameters: { speed: 5 },
        expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{ controllerStateId: 'idle', sourceStateId: 'alternate',
          effectiveWeight: { min: 0.49, max: 0.51 },
          throughout: { start: 0.25, end: 0.5, sampleRateHz: 10, effectiveWeight: { min: 0, max: 1 },
            maxSampleGapSeconds: 0.1, maxLinearSpeedStudsPerSecond: 100000 },
          expectedPosition: alternateSourcePose.position, positionToleranceStuds: 0,
          expectedRotation: [20, 0, 0], rotationToleranceDegrees: 0.5 }] }] } }] });
    assert.equal(sourcePoseContract.status, 'passed', JSON.stringify(sourcePoseContract.cases[0]?.failures));
    assert.ok(sourcePoseContract.cases[0]!.poseChecks[0]!.throughoutChecks!.some(check =>
      check.property === 'blendSourcePose.sampleCoverage:idle/alternate' && check.passed));
    assert.ok(sourcePoseContract.cases[0]!.poseChecks[0]!.throughoutChecks!.some(check =>
      check.property === 'blendSourcePose.effectiveWeightThroughout:idle/alternate' && check.passed));
    const sourceWindowWeightRegression = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-window-weight-regression', name: 'Catch priority masking within a blend window', duration: 0.5,
        initialParameters: { speed: 5 }, expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{
          controllerStateId: 'idle', sourceStateId: 'alternate', throughout: { start: 0.25, end: 0.5, sampleRateHz: 10,
            effectiveWeight: { min: 0.75 } },
        }] }] } }] });
    const weightWindowFailure = sourceWindowWeightRegression.cases[0]!.failures.find(failure =>
      failure.expectation.includes('blendSourcePose.effectiveWeightThroughout:idle/alternate'))!;
    const observedWeightRange = (weightWindowFailure.observed as { range: { min: number; max: number; samples: unknown[] } }).range;
    assert.deepEqual([observedWeightRange.min, observedWeightRange.max, observedWeightRange.samples.length], [0.5, 0.5, 4]);
    const sourceWindowMotionRegression = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-window-motion-regression', name: 'Catch a per-step source rotation spike', duration: 0.5,
        initialParameters: { speed: 5 }, expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{
          controllerStateId: 'idle', sourceStateId: 'alternate', throughout: { start: 0.25, end: 0.5, sampleRateHz: 10,
            maxAngularStepDegrees: 0 },
        }] }] } }] });
    assert.ok(sourceWindowMotionRegression.cases[0]!.failures.some(failure =>
      failure.expectation.includes('blendSourcePose.maximumAngularStepDegrees:idle/alternate')));
    const sourceWindowAccelerationRegression = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-window-acceleration-regression', name: 'Gate BlendSpace source angular acceleration', duration: 0.5,
        initialParameters: { speed: 5 }, expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{
          controllerStateId: 'idle', sourceStateId: 'alternate', throughout: { start: 0.25, end: 0.5, sampleRateHz: 10,
            maxAngularAccelerationDegreesPerSecondSquared: 0 },
        }] }] } }] });
    const sourceAccelerationFailure = sourceWindowAccelerationRegression.cases[0]!.failures.find(failure =>
      failure.expectation.includes('blendSourcePose.maximumAngularAccelerationDegreesPerSecondSquared:idle/alternate'))!;
    const sourceAccelerationObserved = (sourceAccelerationFailure.observed as { motion: { intervalMidpointSpacingSeconds: number;
      intervalCount: number; effectiveWeightAtEnd: number } }).motion;
    const sourceAccelerationDiagnosis = (sourceAccelerationFailure as typeof sourceAccelerationFailure & { motionGuidance: {
      kind: string; suggestedNextStep: string; limitation: string } }).motionGuidance;
    const sourceAccelerationCheck = sourceWindowAccelerationRegression.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check =>
      check.property === 'blendSourcePose.maximumAngularAccelerationDegreesPerSecondSquared:idle/alternate')!;
    assert.ok(sourceAccelerationObserved.intervalMidpointSpacingSeconds > 0);
    assert.ok(sourceAccelerationObserved.intervalCount > 0);
    assert.ok(sourceAccelerationObserved.effectiveWeightAtEnd > 0,
      'source acceleration failures must preserve the BlendSpace contribution at the measured interval');
    assert.equal(sourceAccelerationDiagnosis.kind, 'sampled_threshold_exceeded');
    assert.match(sourceAccelerationDiagnosis.suggestedNextStep, /preview the exact candidate.*rerun this gate/i);
    assert.match(sourceAccelerationDiagnosis.limitation, /not.*quality judgment/i);
    assert.deepEqual(sourceAccelerationCheck.motionGuidance, sourceAccelerationDiagnosis,
      'the source check and failure surfaces must share identical next-step guidance');
    const badSourcePoseContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-pose-mismatch', name: 'Diagnose a BlendSpace source pose mismatch', duration: 0.5, initialParameters: { speed: 5 },
        expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{ controllerStateId: 'idle', sourceStateId: 'alternate',
          expectedPosition: [99, 0, 0], positionToleranceStuds: 0 }] }] } }] });
    assert.equal(badSourcePoseContract.status, 'failed');
    assert.ok(badSourcePoseContract.cases[0]!.failures.some(failure => failure.expectation.includes('blendSourcePose.positionErrorStuds:idle/alternate')));
    assert.ok((badSourcePoseContract.cases[0]!.failures.find(failure => failure.expectation.includes('blendSourcePose.positionErrorStuds'))!.observed as { effectiveWeight: number }).effectiveWeight > 0);
    const badSourceWeightContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe },
      { cases: [{ id: 'source-weight-mismatch', name: 'Detect priority-masked source influence', duration: 0.5, initialParameters: { speed: 5 },
        expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{ controllerStateId: 'idle', sourceStateId: 'alternate',
          effectiveWeight: { min: 0.75 } }] }] } }] });
    const sourceWeightFailure = badSourceWeightContract.cases[0]!.failures[0]!;
    assert.ok(sourceWeightFailure.expectation.includes('blendSourcePose.effectiveWeight:idle/alternate'));
    assert.deepEqual(sourceWeightFailure.observed, { effectiveWeight: 0.5, trackWeight: 0.5, contributionStatus: 'contributing', priority: 'Movement' });
    const missingSourcePoseContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateWithoutTorso },
      { cases: [{ id: 'source-pose-channel-gap', name: 'Explain a missing source joint channel', duration: 0.5, initialParameters: { speed: 5 },
        expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{ controllerStateId: 'idle', sourceStateId: 'alternate',
          expectedPosition: [0, 0, 0], positionToleranceStuds: 0 }] }] } }] });
    const missingSourceCheck = missingSourcePoseContract.cases[0]!.poseChecks[0]!.checks[0]!;
    assert.deepEqual(missingSourceCheck.observed, { status: 'missing_joint_channel', priority: 'Movement', trackWeight: 0.5,
      targetTrackWeight: 0.5, playbackTimeSeconds: 0.25, reason: 'joint_not_animated' });
    const missingSourceWindowContract = runAnimationGraphTimelineSuite(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateWithoutTorso },
      { cases: [{ id: 'source-window-channel-gap', name: 'Detect a missing source channel throughout a window', duration: 0.5, initialParameters: { speed: 5 },
        expect: { poses: [{ at: 0.5, joint: middlePose.joint, blendSourcePoses: [{ controllerStateId: 'idle', sourceStateId: 'alternate',
          throughout: { start: 0.25, end: 0.5, sampleRateHz: 10, maxSampleGapSeconds: 0.1 } }] }] } }] });
    const sourceCoverageFailure = missingSourceWindowContract.cases[0]!.failures.find(failure =>
      failure.expectation.includes('blendSourcePose.sampleCoverage:idle/alternate'))!;
    assert.ok((sourceCoverageFailure.observed as { missing: Array<{ status: string }> }).missing.every(item => item.status === 'missing_joint_channel'));

    const looped = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 2.25, sampleTimes: [1.25, 2.25], initialParameters: { speed: 0 },
      events: [{ at: 0.25, kind: 'set_parameters', values: { speed: 5 } }],
    });
    for (const at of [1.25, 2.25]) {
      const sample = looped.blendSamples.find(candidate => candidate.at === at)!;
      assert.equal(sample.activeTracks.find(track => track.stateId === 'idle')!.playbackTimeSeconds, at % idleRecipe.duration,
        'the looped two-second controller must retain its phase across a parameter retarget');
      const blendEvaluation = sample.blendSpaceEvaluations[0]!;
      assert.ok(blendEvaluation.samples.every(source => Math.abs(source.playback.normalizedPhase
        - (at % idleRecipe.duration) / idleRecipe.duration) < 1e-12),
      `source-channel diagnostics should preserve shared normalized phase after loop wrapping at ${at}s`);
      const actual = looped.composedPoseSamples.find(candidate => candidate.at === at)!.joints[0]!;
      const expected = [
        { pose: createComposedJointSampler(idleRecipe, actual.joint)!(blendEvaluation.samples[0]!.playback.timeSeconds), weight: 0.5 },
        { pose: createComposedJointSampler(alternateRecipe, actual.joint)!(blendEvaluation.samples[1]!.playback.timeSeconds), weight: 0.5 },
      ];
      const position = [0, 1, 2].map(axis => expected.reduce((sum, source) => sum + source.pose.position[axis]! * source.weight, 0));
      const rotation = weightedQuaternionMean(expected.map(source => ({ rotation: source.pose.rotation, weight: source.weight }))).rotation;
      assert.ok(Math.hypot(...actual.position.map((value, axis) => value - position[axis]!)) < 1e-9,
        `loop-seam blend translation should preserve normalized source phase at ${at}s`);
      assert.ok(quaternionAngularDistanceDegrees(actual.rotationQuaternion, rotation) < 1e-5,
        `loop-seam blend rotation should preserve normalized source phase at ${at}s`);
    }

    const crossfadeGraph = { ...graph, entryState: 'alternate',
      transitions: [
        { id: 'enterBlend', from: 'alternate', to: 'idle', trigger: 'Blend', blendSeconds: 0.5 },
        { id: 'leaveBlend', from: 'idle', to: 'alternate', trigger: 'Leave', blendSeconds: 0.5 },
      ] };
    const retargeted = simulateAnimationGraphTimeline(crossfadeGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { duration: 0.875, sampleTimes: [0.25, 0.5, 0.875],
        initialParameters: { speed: 0 }, events: [
          { at: 0, kind: 'trigger', trigger: 'Blend' },
          { at: 0.25, kind: 'set_parameters', values: { speed: 5 } },
          { at: 0.75, kind: 'trigger', trigger: 'Leave' },
        ] });
    const retargetedMiddle = retargeted.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    const retargetedEnd = retargeted.blendSamples.find(sample => sample.at === 0.5)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(retargetedMiddle.samples.map(sample => [sample.weight, sample.poseContributionWeight,
      sample.targetPoseContributionWeight]), [[0.5, 0.5, 0.5], [0.5, 0, 0.5]],
    'parameter changes during a blend-entry crossfade must retarget each live source track from its observed weight');
    assert.deepEqual(retargetedEnd.samples.map(sample => [sample.poseContributionWeight, sample.targetPoseContributionWeight]),
      [[0.5, 0.5], [0.5, 0.5]],
      'the simulator must not incorrectly multiply retargeted source-track weights by the controller crossfade a second time');
    const fadingOut = retargeted.blendSamples.find(sample => sample.at === 0.875)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(fadingOut.samples.map(sample => [sample.poseContributionWeight, sample.targetPoseContributionWeight]),
      [[0.375, 0], [0.375, 0]], 'leaving a BlendSpace must fade each actual source channel instead of only scaling a virtual controller');

    const reentryGraph = { ...graph, entryState: 'idle', transitions: [
      { id: 'leaveBlend', from: 'idle', to: 'alternate', trigger: 'Leave', blendSeconds: 0.4 },
      { id: 'returnBlend', from: 'alternate', to: 'idle', trigger: 'Return', blendSeconds: 0.4 },
    ] };
    const reentered = simulateAnimationGraphTimeline(reentryGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { duration: 0.3, initialParameters: { speed: 10 },
        sampleTimes: [0.1, 0.2, 0.25], events: [
          { at: 0.1, kind: 'trigger', trigger: 'Leave' },
          { at: 0.2, kind: 'trigger', trigger: 'Return' },
        ] });
    const beforeReentry = reentered.blendSamples.find(sample => sample.at === 0.2)!.blendSpaceEvaluations[0]!;
    assert.equal(beforeReentry.samples.find(sample => sample.stateId === 'alternate')!.poseContributionWeight, 0.75,
      're-entering a controller while its source is stopping must resume from that source track\'s current fade weight');
    assert.equal(beforeReentry.samples.find(sample => sample.stateId === 'alternate')!.targetPoseContributionWeight, 1,
      'the restarted source should target full weight while preserving its current weight as the fade origin');
    const reentryProgress = reentered.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    assert.ok(reentryProgress.samples.find(sample => sample.stateId === 'alternate')!.poseContributionWeight > 0.75,
      'the restarted source should blend upward from its retained weight after re-entry');

    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe,
      [f.attack.id]: { ...alternateRecipe, loop: false } }, { duration: 0.1 }), /different loop setting/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace simulation preserves distinct parameter updates 50 microseconds apart', async () => {
  const f = await fixture();
  try {
    const idleRecipe = { ...animationSchema.parse(f.idle.recipe), markers: [] };
    const alternateRecipe = { ...animationSchema.parse(f.attack.recipe), loop: idleRecipe.loop, priority: idleRecipe.priority, markers: [] };
    const graph = { ...f.graph, sampleRate: 30, entryState: 'locomotion', parameters: [
      { name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 },
    ], states: [
      { id: 'locomotion', name: 'Locomotion', animationId: f.idle.id, speed: 1,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'locomotion' }, { value: 10, stateId: 'alternate' }] } },
      { id: 'alternate', name: 'Alternate', animationId: f.attack.id, speed: 1 },
    ], transitions: [] };
    const firstUpdateAt = 0.2;
    const secondUpdateAt = firstUpdateAt + 0.00005;
    const result = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.4, initialParameters: { speed: 0 },
      events: [
        { at: firstUpdateAt, kind: 'set_parameters', values: { speed: 5 } },
        { at: secondUpdateAt, kind: 'set_parameters', values: { speed: 10 } },
      ],
    });

    const firstUpdateSample = result.blendSamples.find(sample => sample.at === firstUpdateAt);
    const secondUpdateSample = result.blendSamples.find(sample => sample.at === secondUpdateAt);
    assert.ok(firstUpdateSample, 'the first exact parameter event time must be observable');
    assert.ok(secondUpdateSample, 'the distinct second event must not be rounded or merged into the first');
    assert.equal(firstUpdateSample.blendSpaceEvaluations[0]!.value, 5);
    assert.equal(secondUpdateSample.blendSpaceEvaluations[0]!.value, 10);
    assert.deepEqual(firstUpdateSample.blendSpaceEvaluations[0]!.samples.map(sample => [sample.stateId, sample.targetPoseContributionWeight]),
      [['locomotion', 0.5], ['alternate', 0.5]]);
    assert.deepEqual(secondUpdateSample.blendSpaceEvaluations[0]!.samples.map(sample => [sample.stateId, sample.targetPoseContributionWeight]),
      [['locomotion', 0], ['alternate', 1]]);
    assert.equal(result.timeline.filter(event => event.event === 'set_parameters').length, 2);
    assert.deepEqual(result.timeline.filter(event => event.event === 'set_parameters').map(event => event.at), [firstUpdateAt, secondUpdateAt]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline simulation ramps BlendSpace parameters over time with easing and authored interruption', async () => {
  const f = await fixture();
  try {
    const idleRecipe = { ...animationSchema.parse(f.idle.recipe), priority: 'Movement' as const, markers: [] };
    const movingRecipe = { ...idleRecipe, name: 'Ramped Locomotion', duration: 1 };
    const graph = { ...f.graph, entryState: 'idle', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Idle controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'moving' }] } },
        { id: 'moving', name: 'Moving clip', animationId: f.attack.id, speed: 1 },
      ], transitions: [] };
    const recipes = { [f.idle.id]: idleRecipe, [f.attack.id]: movingRecipe };
    const linear = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.4, sampleRateHz: 10,
      events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.4, easing: 'linear' }] });
    const linearQuarter = linear.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(linearQuarter.samples.map(sample => [sample.stateId, sample.weight]), [['idle', 0.75], ['moving', 0.25]]);
    assert.equal(linear.timeline.find(event => event.event === 'ramp_parameters')?.easing, 'linear');
    assert.equal(linear.timeline.filter(event => event.event === 'set_parameters').length, 12);
    assert.equal(linear.scheduledEvents, 12, 'prequeued ramp samples must be included in scheduled-event telemetry');
    assert.equal(linear.processedEvents, 13, 'the ramp start plus its graph-rate samples are all processed events');
    assert.deepEqual(linear.incompleteParameterRamps, [], 'a ramp ending exactly at the horizon is complete, not in flight');
    assert.deepEqual(linear.parameterRampLifecycle[0], { inputIndex: 0, startedAt: 0, duration: 0.4, easing: 'linear', status: 'completed',
      channels: [{ name: 'speed', startValue: 0, targetValue: 10, status: 'completed', endedAt: 0.4, observedValue: 10 }] });
    assert.equal(linear.blendSamples.at(-1)?.blendSpaceEvaluations[0]?.samples[1]?.targetPoseContributionWeight, 1);

    const offGrid = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.4, sampleRateHz: 10,
      events: [{ at: 0.05, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.4 }] });
    const offGridFrame = offGrid.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!;
    assert.ok(Math.abs(offGridFrame.samples[1]!.weight - 0.125) < 1e-12,
      'a ramp starting between frames should advance by the elapsed fraction at the next global sample frame');
    assert.ok(Math.abs(offGrid.blendSamples.at(-1)!.blendSpaceEvaluations[0]!.samples[1]!.weight - 0.875) < 1e-12,
      'the simulation horizon should expose the partial progress of a ramp that continues beyond the horizon');
    assert.equal(offGrid.incompleteParameterRamps.length, 1);
    const incompleteRamp = offGrid.incompleteParameterRamps[0]!;
    assert.equal(incompleteRamp.inputIndex, 0);
    assert.equal(incompleteRamp.simulatedProgress, 0.875);
    assert.ok(Math.abs(incompleteRamp.remainingSecondsAtHorizon - 0.05) < 1e-12);
    assert.deepEqual(incompleteRamp.parameters, [{ name: 'speed', currentValue: 8.75, targetValue: 10 }],
      'the endpoint summary must identify ramp channels that are still in flight and their current/target values');
    assert.equal(offGrid.parameterRampLifecycle[0]?.status, 'active');
    assert.equal(offGrid.parameterRampLifecycle[0]?.channels[0]?.observedValue, 8.75);

    const eased = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.4, sampleRateHz: 10,
      events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.4, easing: 'smoothstep' }] });
    const easedQuarter = eased.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!;
    assert.ok(Math.abs(easedQuarter.samples[1]!.weight - 0.15625) < 1e-12,
      'smoothstep at 25% time should yield 15.625% of the target parameter');

    const interrupted = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.6, sampleRateHz: 10,
      events: [
        { at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.6 },
        { at: 0.3, kind: 'set_parameters', values: { speed: 0 } },
      ] });
    assert.equal(interrupted.blendSamples.find(sample => sample.at === 0.3)?.blendSpaceEvaluations[0]?.samples[1]?.targetPoseContributionWeight, 0);
    assert.equal(interrupted.blendSamples.find(sample => sample.at === 0.6)?.blendSpaceEvaluations[0]?.samples[1]?.targetPoseContributionWeight, 0,
      'a direct authored parameter write must cancel remaining samples for that parameter');
    assert.equal(interrupted.timeline.filter(event => event.event === 'set_parameters' && event.inputIndex === 0).length, 9,
      'ramp samples through the same-time direct override should be applied, but later samples must be canceled');
    assert.deepEqual(interrupted.incompleteParameterRamps, [], 'a direct parameter write that cancels every ramp channel leaves no incomplete ramp');
    assert.deepEqual(interrupted.parameterRampLifecycle[0], { inputIndex: 0, startedAt: 0, duration: 0.6, easing: 'linear', status: 'interrupted',
      channels: [{ name: 'speed', startValue: 0, targetValue: 10, status: 'interrupted', endedAt: 0.3, observedValue: 0 }] });

    const triggered = simulateAnimationGraphTimeline({ ...graph, transitions: [
      { id: 'leaveBlend', from: 'idle', to: 'moving', trigger: 'LeaveBlend', blendSeconds: 0 },
    ] }, recipes, { duration: 0.6, sampleRateHz: 10,
      events: [
        { at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.6 },
        { at: 0.3, kind: 'trigger', trigger: 'LeaveBlend', setParameters: { speed: 0 } },
      ] });
    assert.equal(triggered.finalState, 'moving');
    assert.equal(triggered.finalParameters.speed, 0);
    assert.equal(triggered.timeline.filter(event => event.event === 'set_parameters' && event.inputIndex === 0).length, 9,
      'a committed trigger parameter update must stop future samples from an overlapping ramp');

    const partialGraph = { ...graph, parameters: [...graph.parameters,
      { name: 'stamina', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }] };
    const partiallyInterrupted = simulateAnimationGraphTimeline(partialGraph, recipes, { duration: 0.6, sampleRateHz: 10,
      initialParameters: { speed: 0, stamina: 0 },
      events: [
        { at: 0, kind: 'ramp_parameters', values: { speed: 10, stamina: 10 }, duration: 0.6 },
        { at: 0.2, kind: 'ramp_parameters', values: { speed: 0 }, duration: 0.2 },
      ] });
    assert.equal(partiallyInterrupted.finalParameters.speed, 0);
    assert.equal(partiallyInterrupted.finalParameters.stamina, 10,
      'starting an overlapping ramp should replace only the shared parameter, allowing other ramp channels to finish');
    assert.deepEqual(partiallyInterrupted.parameterRampLifecycle[0], { inputIndex: 0, startedAt: 0, duration: 0.6, easing: 'linear',
      status: 'partially_interrupted', channels: [
        { name: 'speed', startValue: 0, targetValue: 10, status: 'interrupted', endedAt: 0.2, observedValue: 3.333333333333334 },
        { name: 'stamina', startValue: 0, targetValue: 10, status: 'completed', endedAt: 0.6, observedValue: 10 },
      ] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline simulator uses separately fingerprint-bound Studio AdjustWeight curves for BlendSpace retargets', async () => {
  const f = await fixture();
  try {
    const idleRecipe = { ...animationSchema.parse(f.idle.recipe), loop: true, markers: [] };
    const movingRecipe = { ...animationSchema.parse(f.attack.recipe), loop: true, markers: [] };
    const recoveryRecipe = { ...animationSchema.parse(f.recovery.recipe), loop: true, markers: [] };
    const graph = { ...f.graph, entryState: 'recovery', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'recovery', name: 'Entry', animationId: f.recovery.id, speed: 1 },
        { id: 'idle', name: 'Locomotion', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Moving source', animationId: f.attack.id, speed: 1 },
      ], transitions: [{ id: 'enterLocomotion', from: 'recovery', to: 'idle', trigger: 'Move', blendSeconds: 0.5 }] };
    const makeProfile = (stateId: string, recipe: AnimationRecipe, adjustWeightIn: Array<{ at: number; weightCurrent: number; weightTarget: number }>,
      adjustWeightOut: Array<{ at: number; weightCurrent: number; weightTarget: number }>) => ({
      id: `00000000-0000-4000-8000-${stateId === 'idle' ? '000000000011' : '000000000012'}`,
      stateId, recipeFingerprint: fingerprint(recipe), profileFingerprint: 'b'.repeat(64), fadeSeconds: 0.25,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.25, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.25, weightCurrent: 0, weightTarget: 0 }],
      adjustWeightIn, adjustWeightOut,
    });
    const profiles = [
      makeProfile('idle', idleRecipe, [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.125, weightCurrent: 0.3, weightTarget: 1 },
        { at: 0.25, weightCurrent: 1, weightTarget: 1 }], [{ at: 0, weightCurrent: 1, weightTarget: 0 },
        { at: 0.125, weightCurrent: 0.7, weightTarget: 0 }, { at: 0.25, weightCurrent: 0, weightTarget: 0 }]),
      makeProfile('attack', movingRecipe, [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.125, weightCurrent: 0.3, weightTarget: 1 },
        { at: 0.25, weightCurrent: 1, weightTarget: 1 }], [{ at: 0, weightCurrent: 1, weightTarget: 0 },
        { at: 0.125, weightCurrent: 0.7, weightTarget: 0 }, { at: 0.25, weightCurrent: 0, weightTarget: 0 }]),
    ];
    const input = { duration: 0.5, sampleRateHz: 10, sampleTimes: [0.375], includePoseSamples: false,
      events: [{ at: 0, kind: 'trigger' as const, trigger: 'Move' }, { at: 0.25, kind: 'set_parameters' as const, values: { speed: 10 } }] };
    const calibrated = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: movingRecipe, [f.recovery.id]: recoveryRecipe }, input, profiles);
    const uncalibrated = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: movingRecipe, [f.recovery.id]: recoveryRecipe }, input);
    const calibratedSources = calibrated.blendSamples.find(sample => sample.at === 0.375)!.blendSpaceEvaluations[0]!.samples;
    const defaultSources = uncalibrated.blendSamples.find(sample => sample.at === 0.375)!.blendSpaceEvaluations[0]!.samples;
    assert.ok(Math.abs(calibratedSources[0]!.poseContributionWeight - 0.35) < 1e-12,
      'the native AdjustWeight-out curve should be rebased from the current half-faded weight');
    assert.ok(Math.abs(calibratedSources[1]!.poseContributionWeight - 0.3) < 1e-12,
      'the native AdjustWeight-in curve should shape the newly requested source weight');
    assert.ok(Math.abs(defaultSources[0]!.poseContributionWeight - 0.25) < 1e-12
      && Math.abs(defaultSources[1]!.poseContributionWeight - 0.5) < 1e-12,
    'without exact measured AdjustWeight curves, the simulator must retain its explicit linear fallback');
    assert.equal(calibrated.blendModel.kind, 'studio_calibrated_curve_per_track_estimate');
    assert.equal(calibrated.blendModel.calibrationProfileIds.length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('speed retiming preserves fade history while calibrated BlendSpace retargets take precedence', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, loop: true, markers: [] });
    const movingRecipe = animationSchema.parse({ ...f.attack.recipe, loop: true, markers: [] });
    const recoveryRecipe = animationSchema.parse({ ...f.recovery.recipe, loop: true, markers: [] });
    const graph = { ...f.graph, entryState: 'recovery', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'recovery', name: 'Entry', animationId: f.recovery.id, speed: 1 },
        { id: 'idle', name: 'Locomotion', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Moving source', animationId: f.attack.id, speed: 1 },
      ], transitions: [{ id: 'enterLocomotion', from: 'recovery', to: 'idle', trigger: 'Move', blendSeconds: 0.5 }] };
    const makeProfile = (stateId: string, recipe: AnimationRecipe, profileSuffix: string) => ({
      id: `00000000-0000-4000-8000-${profileSuffix}`,
      stateId, recipeFingerprint: fingerprint(recipe), profileFingerprint: 'c'.repeat(64), fadeSeconds: 0.3,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.3, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.3, weightCurrent: 0, weightTarget: 0 }],
      adjustWeightIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.15, weightCurrent: 0.7, weightTarget: 1 },
        { at: 0.3, weightCurrent: 1, weightTarget: 1 }],
      adjustWeightOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.15, weightCurrent: 0.7, weightTarget: 0 },
        { at: 0.3, weightCurrent: 0, weightTarget: 0 }],
    });
    const profiles = [makeProfile('idle', idleRecipe, '000000000021'), makeProfile('attack', movingRecipe, '000000000022')];
    const result = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: movingRecipe, [f.recovery.id]: recoveryRecipe }, {
        duration: 0.5, sampleRateHz: 10, sampleTimes: [0.2, 0.35], includePoseSamples: false,
        events: [{ at: 0, kind: 'trigger', trigger: 'Move' },
          { at: 0.2, kind: 'set_playback_speed', multiplier: 2 },
          { at: 0.2, kind: 'set_parameters', values: { speed: 10 } }],
      }, profiles);
    const atRetarget = result.blendSamples.find(sample => sample.at === 0.2)!.blendSpaceEvaluations[0]!.samples;
    const afterRetarget = result.blendSamples.find(sample => sample.at === 0.35)!.blendSpaceEvaluations[0]!.samples;
    assert.deepEqual(atRetarget.map(sample => sample.poseContributionWeight), [0.4, 0],
      'retiming at the retarget timestamp must preserve the in-flight graph fade before the calibrated adjustment starts');
    assert.ok(Math.abs(afterRetarget[0]!.poseContributionWeight - 0.28) < 1e-12,
      'the calibrated outgoing curve should rebase from the pre-existing 0.4 contribution after epoch retiming');
    assert.ok(Math.abs(afterRetarget[1]!.poseContributionWeight - 0.7) < 1e-12,
      'the latest calibrated incoming curve should win over copied fade history in the retimed epoch');
    assert.equal(afterRetarget[0]!.targetPoseContributionWeight, 0);
    assert.equal(afterRetarget[1]!.targetPoseContributionWeight, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace parameter changes during a graph crossfade preserve the original fade deadline', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, loop: true, priority: 'Movement', markers: [] });
    const alternateRecipe = animationSchema.parse({ ...f.attack.recipe, loop: true, priority: 'Movement', markers: [] });
    const graph = { ...f.graph, entryState: 'recovery', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'recovery', name: 'Entry', animationId: f.recovery.id, speed: 1 },
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Alternate Source', animationId: f.attack.id, speed: 1 },
      ], transitions: [{ id: 'enterBlend', from: 'recovery', to: 'idle', trigger: 'EnterBlend', blendSeconds: 0.4 }] };
    const result = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: f.recovery.recipe }, {
      duration: 0.5, sampleTimes: [0.2, 0.35, 0.4], includePoseSamples: true,
      poseJoints: [idleRecipe.tracks[0]!.joint],
        events: [{ at: 0, kind: 'trigger', trigger: 'EnterBlend' },
          { at: 0.2, kind: 'set_parameters', values: { speed: 10 } }],
      });
    const atChange = result.blendSamples.find(sample => sample.at === 0.2)!.blendSpaceEvaluations[0]!;
    assert.ok(Math.abs(atChange.samples[0]!.poseContributionWeight - 0.5) < 1e-12,
      'the source that is fading out should retain its current weight at the parameter update');
    assert.ok(Math.abs(atChange.samples[1]!.poseContributionWeight - 0) < 1e-12,
      'the newly targeted source should begin from its current zero weight');
    const retargetPose = result.composedPoseSamples.find(sample => sample.at === 0.2)!.joints[0]!;
    assert.ok(retargetPose.contributors.some(contributor => contributor.stateId === 'idle' && Math.abs(contributor.effectiveWeight - 0.5) < 1e-12),
      'pose composition must include the outgoing source while its AnimationTrack fades, even when the current BlendSpace parameter gives it zero target weight');
    const beforeDeadline = result.blendSamples.find(sample => sample.at === 0.35)!.blendSpaceEvaluations[0]!;
    assert.ok(beforeDeadline.samples[1]!.poseContributionWeight > 0.7,
      'retargeting uses only the 0.2 seconds left in the original crossfade');
    const atDeadline = result.blendSamples.find(sample => sample.at === 0.4)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(atDeadline.samples.map(sample => sample.poseContributionWeight), [0, 1],
      'parameter retargeting must not extend the already-running transition fade');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace parameter ramps during controller entry reach the final source weights at the original deadline', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, loop: true, priority: 'Movement', markers: [] });
    const attackRecipe = animationSchema.parse({ ...f.attack.recipe, loop: true, priority: 'Movement', markers: [] });
    const recoveryRecipe = animationSchema.parse({ ...f.recovery.recipe, loop: true, priority: 'Movement', markers: [] });
    const graph = { ...f.graph, entryState: 'recovery', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'recovery', name: 'Entry', animationId: f.recovery.id, speed: 1 },
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Attack Source', animationId: f.attack.id, speed: 1 },
      ], transitions: [{ id: 'enterBlend', from: 'recovery', to: 'idle', trigger: 'EnterBlend', blendSeconds: 0.4 }] };
    const result = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe, [f.recovery.id]: recoveryRecipe }, {
        duration: 0.5, sampleTimes: [0.2, 0.4],
        events: [{ at: 0, kind: 'trigger', trigger: 'EnterBlend' },
          { at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.4 }],
      });
    const middle = result.blendSamples.find(sample => sample.at === 0.2)!.blendSpaceEvaluations[0]!;
    assert.ok(Math.abs(middle.samples[0]!.weight - 0.5) < 1e-12 && Math.abs(middle.samples[1]!.weight - 0.5) < 1e-12,
      'the BlendSpace parameter should be halfway through its ramp at the crossfade midpoint');
    const deadline = result.blendSamples.find(sample => sample.at === 0.4)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(deadline.samples.map(sample => sample.weight), [0, 1],
      'the parameter ramp should reach its target exactly when the original controller-entry fade completes');
    assert.deepEqual(deadline.samples.map(sample => sample.poseContributionWeight), [0, 1],
      'source track contributions should not lag behind or extend the finished entry fade');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace source fade tails remain composed after the controller track fades out first', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, loop: true, priority: 'Movement', markers: [] });
    const attackRecipe = animationSchema.parse({ ...f.attack.recipe, loop: true, priority: 'Movement', markers: [] });
    const recoveryRecipe = animationSchema.parse({ ...f.recovery.recipe, loop: true, priority: 'Movement', markers: [] });
    const graph = { ...f.graph, entryState: 'recovery', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 10, min: 0, max: 10 }],
      states: [
        { id: 'recovery', name: 'Recovery', animationId: f.recovery.id, speed: 1 },
        { id: 'idle', name: 'Locomotion controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Fading source only', animationId: f.attack.id, speed: 1 },
      ], transitions: [
        { id: 'enterBlend', from: 'recovery', to: 'idle', trigger: 'EnterBlend', blendSeconds: 0.4 },
        { id: 'leaveBlend', from: 'idle', to: 'recovery', trigger: 'LeaveBlend', blendSeconds: 0.4 },
      ] };
    const makeProfile = (stateId: string, recipe: AnimationRecipe, suffix: string, stopOut: Array<{ at: number; weightCurrent: number; weightTarget: number }>) => ({
      id: `00000000-0000-4000-8000-${suffix}`, stateId, recipeFingerprint: fingerprint(recipe), profileFingerprint: 'd'.repeat(64), fadeSeconds: 0.4,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.4, weightCurrent: 1, weightTarget: 1 }],
      stopOut,
    });
    const profiles = [
      makeProfile('idle', idleRecipe, '000000000031', [
        { at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0, weightTarget: 0 },
        { at: 0.4, weightCurrent: 0, weightTarget: 0 },
      ]),
      makeProfile('attack', attackRecipe, '000000000032', [
        { at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.4, weightCurrent: 0, weightTarget: 0 },
      ]),
    ];
    const result = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe, [f.recovery.id]: recoveryRecipe }, {
        duration: 0.5, sampleTimes: [0.2, 0.5], poseJoints: [idleRecipe.tracks[0]!.joint],
        events: [{ at: 0, kind: 'trigger', trigger: 'EnterBlend' }, { at: 0.1, kind: 'trigger', trigger: 'LeaveBlend' }],
      }, profiles);
    const controllerTrack = result.blendSamples.find(sample => sample.at === 0.2)!.activeTracks.find(track => track.stateId === 'idle');
    assert.equal(controllerTrack, undefined, 'the controller track has already finished its calibrated fast stop fade');
    const blendSample = result.blendSamples.find(sample => sample.at === 0.2)!;
    const sourceWeight = blendSample.blendSpaceEvaluations[0]?.samples.find(sample => sample.stateId === 'attack')?.poseContributionWeight ?? 0;
    assert.ok(sourceWeight > 0, 'the independent source channel should still expose its positive fade weight');
    const sourcePose = result.composedPoseSamples.find(sample => sample.at === 0.2)!.joints[0]!;
    assert.ok(sourcePose.contributors.some(contributor => contributor.stateId === 'attack'
      && Math.abs(contributor.effectiveWeight - sourceWeight) < 1e-12),
      'the source AnimationTrack still has positive weight, so its pose must remain in composition after the virtual controller track reaches zero');
    const afterTail = result.blendSamples.find(sample => sample.at === 0.5)!;
    assert.equal(afterTail.blendSpaceEvaluations.some(evaluation => evaluation.controllerStateId === 'idle'), false,
      'the orphaned controller evaluation should retire when every source channel reaches zero');
    assert.equal(result.composedPoseSamples.find(sample => sample.at === 0.5)!.joints[0]!.contributors
      .some(contributor => contributor.stateId === 'attack'), false,
    'a fully faded source must not remain as a stale pose contributor');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('playback-speed events preserve BlendSpace phase and reschedule marker and one-shot end callbacks', async () => {
  const f = await fixture();
  try {
    const withMarker = (recipeInput: unknown, name: string): AnimationRecipe => {
      const recipe = animationSchema.parse(recipeInput);
      return animationSchema.parse({ ...recipe, name, duration: 1, loop: false, priority: 'Movement',
        markers: [{ name: 'Contact', time: 0.5, value: '' }],
        tracks: recipe.tracks.map(track => ({ ...track, keys: track.keys.map(key => ({ ...key,
          time: key.time / recipe.duration })) })),
      });
    };
    const idleRecipe = withMarker(f.idle.recipe, 'Speed Event Idle');
    const attackRecipe = withMarker(f.attack.recipe, 'Speed Event Attack');
    const graph = { ...f.graph, entryState: 'idle', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 1 }],
      states: [
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'attack' }] } },
        { id: 'attack', name: 'Blend Source', animationId: f.attack.id, speed: 1 },
      ], transitions: [] };
    const result = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe }, {
      duration: 0.8, sampleTimes: [0.25, 0.375, 0.625],
      events: [{ at: 0.25, kind: 'set_playback_speed', multiplier: 2 }],
    });
    assert.equal(result.finalPlaybackSpeedMultiplier, 2);
    assert.deepEqual(result.triggeredMarkers.map(marker => [marker.at, marker.stateId, marker.marker]), [[0.375, 'idle', 'Contact']],
      'the controller marker must move from the old 0.5s deadline to the new phase-correct 0.375s deadline');
    assert.equal(result.timeline.find(event => event.event === 'animation_end')?.at, 0.625,
      'a speed change must invalidate the old one-shot completion and schedule the phase-correct new end');
    const atRetarget = result.blendSamples.find(sample => sample.at === 0.25)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(atRetarget.samples.map(sample => [sample.playback.normalizedPhase, sample.playback.playbackSpeed]),
      [[0.25, 2], [0.25, 2]],
      'every active BlendSpace source must preserve normalized phase and scale speed proportionally');
    const atMarker = result.blendSamples.find(sample => sample.at === 0.375)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(atMarker.samples.map(sample => sample.playback.normalizedPhase), [0.5, 0.5]);

    const measuredMarkerGraph = { ...graph, transitions: [
      { id: 'measuredContact', from: 'idle', to: 'attack', trigger: 'Contact', blendSeconds: 0.1 },
    ] };
    const assetSetFingerprint = 'd'.repeat(64);
    const measuredMarkerRun = simulateAnimationGraphTimeline(measuredMarkerGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe }, {
        duration: 2.1,
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 2 } },
        observedBlendAnimationAssetSetFingerprint: assetSetFingerprint,
        expectedBlendAnimationAssetSetFingerprint: assetSetFingerprint,
      });
    assert.deepEqual(measuredMarkerRun.triggeredMarkers.map(marker => [marker.at, marker.stateId, marker.marker]),
      [[2, 'idle', 'Contact']],
      'BlendSpace marker callbacks must follow the measured self-source Length/Speed and normalized authored marker phase');
    assert.deepEqual(measuredMarkerRun.transitionIds, ['measuredContact']);
    assert.equal(measuredMarkerRun.finalState, 'attack');
    assert.equal(measuredMarkerRun.triggeredMarkers.filter(marker => marker.marker === 'Contact').length, 1,
      'a BlendSpace marker must be emitted exactly once rather than once per simultaneously playing source channel');
    const capturedPhaseRun = simulateAnimationGraphTimeline(measuredMarkerGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe }, {
        duration: 1.1,
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 2 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.25, attack: 0.25 } },
        observedBlendAnimationAssetSetFingerprint: assetSetFingerprint,
        expectedBlendAnimationAssetSetFingerprint: assetSetFingerprint,
      });
    assert.deepEqual(capturedPhaseRun.triggeredMarkers.map(marker => [marker.at, marker.stateId, marker.marker]),
      [[1, 'idle', 'Contact']],
      'captured source phases must schedule the next normalized marker occurrence from the live phase, not reset it');
    assert.deepEqual(capturedPhaseRun.transitionIds, ['measuredContact']);

    const tiedCallback = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: attackRecipe }, {
      duration: 0.8, events: [{ at: 0.5, kind: 'set_playback_speed', multiplier: 2 }], analyzeEventOrderSensitivity: true,
    });
    assert.equal(tiedCallback.eventOrderingDiagnostics.ambiguousCollisionCount, 2,
      'the same-time marker competes with the speed change, and retiming now reveals the later source/controller natural-stop callback tie');
    assert.deepEqual(tiedCallback.eventOrderingDiagnostics.collisions[0]!.runtimeEvents,
      [{ kind: 'marker', stateId: 'idle', marker: 'Contact' }]);
    assert.equal(tiedCallback.eventOrderSensitivity?.markerEventsChanged, true,
      'the event-order sensitivity run must expose that the marker may fire before the same-time speed change');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('non-looping BlendSpace source channels fade at their own measured natural end', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, duration: 2, loop: false, priority: 'Movement', markers: [] });
    const shortRecipe = animationSchema.parse({ ...f.attack.recipe, duration: 1, loop: false, priority: 'Movement', markers: [] });
    const graph = { ...f.graph, entryState: 'idle', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 5, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Short Blend Source', animationId: f.attack.id, speed: 1 },
      ], transitions: [] };
    const identity = 'e'.repeat(64);
    const result = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
      duration: 1.5, sampleTimes: [0.9, 1, 1.1, 1.2], naturalCompletionFadeSeconds: 0.2,
      observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
    });
    const contributionAt = (at: number) => result.blendSamples.find(sample => sample.at === at)!
      .blendSpaceEvaluations[0]!.samples.find(sample => sample.stateId === 'attack')!.poseContributionWeight;
    assert.equal(contributionAt(0.9), 0.5);
    assert.equal(contributionAt(1), 0.5, 'the natural completion fade begins at the measured source end');
    assert.ok(Math.abs(contributionAt(1.1) - 0.25) < 1e-12,
      'the shorter source should fade independently while the controller and longer source keep playing');
    assert.equal(contributionAt(1.2), 0, 'the source channel should reach zero at its own natural-fade deadline');

    const exactHorizon = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
      duration: 1, sampleTimes: [1], naturalCompletionFadeSeconds: 0.2,
      observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
    });
    const exactHorizonSource = exactHorizon.blendSamples.find(sample => sample.at === 1)!
      .blendSpaceEvaluations[0]!.samples.find(sample => sample.stateId === 'attack')!;
    assert.equal(exactHorizon.timeline.some(event => event.event === 'animation_natural_stop'
      && event.at === 1 && event.blendSourceStateId === 'attack'), true,
    'a source natural-stop callback exactly on the inclusive simulation horizon must be processed');
    assert.equal(exactHorizonSource.playback.isPlaying, false);
    assert.equal(exactHorizonSource.poseContributionWeight, 0.5,
      'the natural-fade envelope should begin at the exact-horizon callback without a weight discontinuity');
    assert.equal(exactHorizonSource.targetPoseContributionWeight, 0,
      'the exact-horizon natural stop should target zero while preserving the current contribution at fade start');

    const beforeNaturalEnd = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
      duration: 1 - 1e-10, sampleTimes: [1 - 1e-10], naturalCompletionFadeSeconds: 0.2,
      observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
    });
    const beforeNaturalEndSource = beforeNaturalEnd.blendSamples.at(-1)!
      .blendSpaceEvaluations[0]!.samples.find(sample => sample.stateId === 'attack')!;
    assert.equal(beforeNaturalEnd.timeline.some(event => event.event === 'animation_natural_stop'
      && event.blendSourceStateId === 'attack'), false,
    'a source natural-stop callback beyond the horizon must not be reported as executed');
    assert.equal(beforeNaturalEndSource.playback.isPlaying, true);
    assert.equal(beforeNaturalEndSource.poseContributionWeight, 0.5,
      'the source must retain its pre-stop contribution when the horizon ends before natural completion');

    const retimed = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
      duration: 1.5, sampleTimes: [0.75, 0.85, 0.95], naturalCompletionFadeSeconds: 0.2,
      observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
      events: [{ at: 0.5, kind: 'set_playback_speed', multiplier: 2 }],
    });
    const retimedContributionAt = (at: number) => retimed.blendSamples.find(sample => sample.at === at)!
      .blendSpaceEvaluations[0]!.samples.find(sample => sample.stateId === 'attack')!.poseContributionWeight;
    assert.equal(retimedContributionAt(0.75), 0.5, 'the speed change must move the source end to its phase-correct new time');
    assert.ok(Math.abs(retimedContributionAt(0.85) - 0.25) < 1e-12,
      'the rescheduled source natural fade must use the retimed clock and original normalized phase');
    assert.equal(retimedContributionAt(0.95), 0, 'a stale pre-retime source-end event must not extend the faded source');

    const tiedStop = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
      duration: 1.5, naturalCompletionFadeSeconds: 0.2, analyzeEventOrderSensitivity: true,
      observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
      events: [{ at: 1, kind: 'set_playback_speed', multiplier: 2 }],
    });
    assert.deepEqual(tiedStop.eventOrderingDiagnostics.collisions[0]?.runtimeEvents,
      [{ kind: 'animation_natural_stop', stateId: 'idle', blendSourceStateId: 'attack' }],
      'event-order diagnostics must identify the exact BlendSpace source channel at a tied natural-stop timestamp');

    const staleLengthProfile = { id: '00000000-0000-4000-8000-000000000039', stateId: 'attack',
      recipeFingerprint: fingerprint(shortRecipe), profileFingerprint: 'f'.repeat(64), fadeSeconds: 0.2,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }],
      naturalCompletion: { authoredDurationSeconds: 1, animationLengthSeconds: 1, playbackSpeed: 1,
        endedAfterStoppedSeconds: 0.2, samples: [{ at: 0, weightCurrent: 1, weightTarget: 1 },
          { at: 0.2, weightCurrent: 0, weightTarget: 0 }] } };
    const changedAssetLength = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
        duration: 2.2, sampleTimes: [1.9, 2, 2.1],
        observedBlendAnimationLengths: { idle: { idle: 2, attack: 2 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
        observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
      }, [staleLengthProfile]);
    const changedLengthWeight = (at: number) => changedAssetLength.blendSamples.find(sample => sample.at === at)!
      .blendSpaceEvaluations.find(evaluation => evaluation.controllerStateId === 'idle')?.samples
      .find(sample => sample.stateId === 'attack')?.poseContributionWeight ?? 0;
    assert.equal(changedLengthWeight(1.9), 0.5);
    assert.equal(changedLengthWeight(2), 0, 'a calibration for a one-second asset must not be applied to a newly measured two-second asset');
    assert.equal(changedLengthWeight(2.1), 0, 'a mismatched natural-fade profile must fail closed instead of fading an uncalibrated asset');

    const retargetAtNaturalEnd = simulateAnimationGraphTimeline(graph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: shortRecipe }, {
        duration: 1.3, sampleTimes: [1, 1.25], naturalCompletionFadeSeconds: 0.2, analyzeEventOrderSensitivity: true,
        observedBlendAnimationLengths: { idle: { idle: 2, attack: 1 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
        observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
        events: [{ at: 1, kind: 'set_parameters', values: { speed: 10 } }],
      });
    const restartedAtEnd = retargetAtNaturalEnd.blendSamples.find(sample => sample.at === 1)!
      .blendSpaceEvaluations.find(evaluation => evaluation.controllerStateId === 'idle')!.samples
      .find(sample => sample.stateId === 'attack')!;
    assert.equal(restartedAtEnd.poseContributionWeight, 1,
      'the same-time parameter retarget should restart the naturally ended source at its new full BlendSpace weight');
    assert.equal(retargetAtNaturalEnd.timeline.some(event => event.event === 'animation_natural_stop'
      && event.at === 1 && event.blendSourceStateId === 'attack'), false,
    'the old source-end callback must not stop the replacement epoch after the user-first retarget');
    assert.equal(retargetAtNaturalEnd.eventOrderingDiagnostics.collisions[0]?.runtimeEvents
      .find(event => event.kind === 'animation_natural_stop')?.blendSourceStateId, 'attack',
      'event-order diagnostics should retain the source-end callback that a same-time user retarget invalidated');
    assert.equal(retargetAtNaturalEnd.eventOrderSensitivity?.timelineChanged, true,
      'runtime-first ordering should reveal that this tied callback can be observed before the retarget');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace parameter updates restart ended channels at a live source phase and fail closed without a clock', async () => {
  const f = await fixture();
  try {
    const idleRecipe = animationSchema.parse({ ...f.idle.recipe, loop: false, priority: 'Movement', markers: [] });
    const alternateRecipe = animationSchema.parse({ ...f.attack.recipe, loop: false, priority: 'Movement', markers: [] });
    const graph = { ...f.graph, entryState: 'idle', parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'attack' }] } },
        { id: 'attack', name: 'Alternate Source', animationId: f.attack.id, speed: 1 },
      ], transitions: [] };
    const identity = 'c'.repeat(64);
    const measured = { observedBlendAnimationLengths: { idle: { idle: 4, attack: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity };
    const resumed = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 2, sampleTimes: [1.5, 2], events: [{ at: 1.5, kind: 'set_parameters', values: { speed: 10 } }], ...measured,
    });
    const update = resumed.timeline.find(event => event.event === 'set_parameters')!;
    assert.deepEqual(update.restartedStateIds, ['attack']);
    assert.equal(update.phaseSourceStateId, 'idle');
    assert.deepEqual(resumed.blendSamples.find(sample => sample.at === 1.5)!.blendSpaceEvaluations[0]!.samples
      .map(sample => [sample.stateId, sample.playback.normalizedPhase, sample.playback.isPlaying]),
    [['idle', 0.375, true], ['attack', 0.375, true]],
    'a genuinely ended source should restart at the phase of the first still-playing channel');
    assert.equal(resumed.blendSamples.find(sample => sample.at === 2)!.blendSpaceEvaluations[0]!.samples[1]!.playback.normalizedPhase, 0.875);

    const phasePreferenceGraph = { ...graph, parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 1, min: 0, max: 2 }],
      states: [
        { id: 'idle', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'attack' },
            { value: 2, stateId: 'recovery' }] } },
        { id: 'attack', name: 'Dominant source clock', animationId: f.attack.id, speed: 1 },
        { id: 'recovery', name: 'Ended target source', animationId: f.recovery.id, speed: 1 },
      ], transitions: [] };
    const phaseIdentity = 'b'.repeat(64);
    const preferDominantClock = simulateAnimationGraphTimeline(phasePreferenceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, {
        duration: 0.2, sampleTimes: [0.1], events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2, recovery: 1 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 0.5, recovery: 1 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.1, attack: 0.4, recovery: 0.9 } },
        observedBlendAnimationAssetSetFingerprint: phaseIdentity, expectedBlendAnimationAssetSetFingerprint: phaseIdentity,
      });
    const preferredClockUpdate = preferDominantClock.timeline.find(event => event.event === 'set_parameters')!;
    assert.equal(preferredClockUpdate.phaseSourceStateId, 'attack',
      'when several source clocks continue playing, retargeting should use the currently contributing clock rather than an earlier zero-weight channel');
    assert.ok(typeof preferredClockUpdate.phaseSourceNormalizedPhase === 'number'
      && Math.abs(preferredClockUpdate.phaseSourceNormalizedPhase - 0.425) < 1e-12,
      'the timeline should expose the donor clock phase used for the restarted source');
    assert.equal(preferredClockUpdate.phaseSourceCurrentWeight, 1);
    assert.equal(preferredClockUpdate.phaseSourceTargetWeight, 1);
    const phaseDonorPlan = runAnimationGraphTimelineSuite(phasePreferenceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, { cases: [{
        id: 'restart-from-visible-blend-clock', name: 'Pin the phase donor decision', duration: 0.2,
        events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2, recovery: 1 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 0.5, recovery: 1 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.1, attack: 0.4, recovery: 0.9 } },
        observedBlendAnimationAssetSetFingerprint: phaseIdentity, expectedBlendAnimationAssetSetFingerprint: phaseIdentity,
        expect: { phaseDonors: [{ inputIndex: 0, stateId: 'attack', restartedStateIds: ['recovery'], normalizedPhase: { min: 0.424999999, max: 0.425000001 },
          currentWeight: { min: 1, max: 1 }, targetWeight: { min: 1, max: 1 } }] },
      }] });
    assert.equal(phaseDonorPlan.status, 'passed');
    const observedPhaseDonor = phaseDonorPlan.cases[0]!.phaseDonorChecks[0]!.observed!;
    assert.equal(observedPhaseDonor.stateId, 'attack');
    assert.deepEqual(observedPhaseDonor.restartedStateIds, ['recovery']);
    assert.ok(Math.abs(observedPhaseDonor.normalizedPhase! - 0.425) < 1e-12);
    assert.equal(observedPhaseDonor.currentWeight, 1);
    assert.equal(observedPhaseDonor.targetWeight, 1);
    assert.equal(animationGraphTimelineSuiteSchema.safeParse({ cases: [{ id: 'bad-phase-donor-input', name: 'Wrong event kind', duration: 0.2,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }],
      expect: { phaseDonors: [{ inputIndex: 0, stateId: 'attack' }] } }] }).success, false,
    'phase-donor gates must bind to an explicit parameter update, not an unrelated event');
    assert.throws(() => runAnimationGraphTimelineSuite(phasePreferenceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, { cases: [{
        id: 'unknown-phase-donor', name: 'Unknown donor state', duration: 0.2,
        events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
        expect: { phaseDonors: [{ inputIndex: 0, stateId: 'ghost' }] },
      }] }), /unknown state ghost/);
    assert.throws(() => runAnimationGraphTimelineSuite(phasePreferenceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, { cases: [{
        id: 'unknown-restarted-phase-state', name: 'Unknown restarted state', duration: 0.2,
        events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
        expect: { phaseDonors: [{ inputIndex: 0, stateId: 'attack', restartedStateIds: ['ghost'] }] },
      }] }), /phase-donor restart for unknown state ghost/);
    const mismatchedPhaseDonorPlan = runAnimationGraphTimelineSuite(phasePreferenceGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, { cases: [{
        id: 'reject-wrong-phase-donor', name: 'Reject changed phase donor', duration: 0.2,
        events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2, recovery: 1 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1, recovery: 1 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.1, attack: 0.4, recovery: 0.9 } },
        observedBlendAnimationAssetSetFingerprint: phaseIdentity, expectedBlendAnimationAssetSetFingerprint: phaseIdentity,
        expect: { phaseDonors: [{ inputIndex: 0, stateId: 'idle', restartedStateIds: [] }] },
      }] });
    assert.equal(mismatchedPhaseDonorPlan.status, 'failed');
    assert.ok(mismatchedPhaseDonorPlan.cases[0]!.failures.some(failure => failure.expectation === 'phaseDonor:0'));
    assert.equal(mismatchedPhaseDonorPlan.cases[0]!.phaseDonorChecks[0]!.checks.find(check => check.property === 'restartedStateIds')?.passed, false,
      'the saved phase gate must fail when the expected channel restart did not happen');

    const rampGraph = { ...graph, sampleRate: 20 };
    const rampDonorInput = { duration: 1.1, sampleTimes: [1.05, 1.1],
      events: [{ at: 1, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: 0.4 }] };
    const rampDonorSimulation = simulateAnimationGraphTimeline(rampGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { ...rampDonorInput,
        ...measured, observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } } });
    const rampDonorUpdate = rampDonorSimulation.timeline.find(event => event.event === 'set_parameters'
      && event.inputIndex === 0 && event.at === 1.05)!;
    assert.deepEqual(rampDonorUpdate.restartedStateIds, ['attack'],
      'the first ramp sample after the one-shot ends should restart its channel');
    assert.equal(rampDonorUpdate.phaseSourceStateId, 'idle');
    assert.ok(typeof rampDonorUpdate.phaseSourceNormalizedPhase === 'number'
      && Math.abs(rampDonorUpdate.phaseSourceNormalizedPhase - 1.05 / 4) < 1e-12,
    'ramp-triggered restarts should use the donor phase at the actual generated sample time');
    const rampDonorPlan = runAnimationGraphTimelineSuite(rampGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { cases: [{
        id: 'ramped-restart-donor', name: 'Pin ramp-time phase donation', duration: rampDonorInput.duration,
        events: rampDonorInput.events,
        observedBlendAnimationLengths: measured.observedBlendAnimationLengths,
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
        observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
        expect: { phaseDonors: [{ inputIndex: 0, at: 1.05, stateId: 'idle', restartedStateIds: ['attack'],
          normalizedPhase: { min: 0.262499999, max: 0.262500001 } }] },
      }] });
    assert.equal(rampDonorPlan.status, 'passed');
    assert.equal(rampDonorPlan.cases[0]!.phaseDonorChecks[0]!.observed?.stateId, 'idle');
    assert.ok(rampDonorPlan.cases[0]!.phaseDonorChecks[0]!.checks.every(check => check.passed));
    const overlappingRampInput = { duration: 1.85, sampleTimes: [1.05, 1.1, 1.15, 1.3, 1.8, 1.85],
      events: [
        { at: 1, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: 0.4 },
        { at: 1.1, kind: 'ramp_parameters' as const, values: { speed: 0 }, duration: 0.2 },
        { at: 1.8, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: 0.2 },
      ] };
    const overlappingRampSimulation = simulateAnimationGraphTimeline(rampGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { ...overlappingRampInput,
        ...measured, observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } } });
    const secondRampStart = overlappingRampSimulation.timeline.find(event => event.event === 'ramp_parameters' && event.inputIndex === 1)!;
    assert.ok(Math.abs((secondRampStart.startValues as Record<string, number>).speed! - 2.5) < 1e-12,
      'an overlapping ramp must start from the first ramp’s value after its same-time generated sample');
    const finalRampStart = overlappingRampSimulation.timeline.find(event => event.event === 'ramp_parameters' && event.inputIndex === 2)!;
    assert.ok(Math.abs((finalRampStart.startValues as Record<string, number>).speed!) < 1e-12,
      'the next ramp must start from the preceding ramp’s completed zero target');
    const finalRampRetarget = overlappingRampSimulation.timeline.find(event => event.event === 'set_parameters'
      && event.inputIndex === 2 && Math.abs(Number(event.at) - 1.85) < 1e-9)!;
    assert.deepEqual(finalRampRetarget.restartedStateIds, ['attack'],
      `after the zero-weight source naturally completes, the next ramp should restart that channel; ${JSON.stringify(overlappingRampSimulation.timeline.filter(event => Number(event.at) >= 1 && Number(event.at) <= 1.85))}`);
    assert.ok(typeof finalRampRetarget.phaseSourceNormalizedPhase === 'number'
      && Math.abs(finalRampRetarget.phaseSourceNormalizedPhase - 0.4625) < 1e-12,
    'after the zero-weight source naturally ends, a later ramp should restart it from the donor’s then-current phase');
    const overlappingRampPlan = runAnimationGraphTimelineSuite(rampGraph,
      { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, { cases: [{
        id: 'overlapping-ramp-phase-donors', name: 'Pin interrupted ramp phase clocks', duration: overlappingRampInput.duration,
        events: overlappingRampInput.events,
        observedBlendAnimationLengths: measured.observedBlendAnimationLengths,
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1 } },
        observedBlendAnimationAssetSetFingerprint: identity, expectedBlendAnimationAssetSetFingerprint: identity,
        expect: { phaseDonors: [
          { inputIndex: 0, at: 1.05, stateId: 'idle', restartedStateIds: ['attack'], normalizedPhase: { min: 0.262499999, max: 0.262500001 } },
          { inputIndex: 1, at: 1.15, stateId: 'idle', restartedStateIds: [], normalizedPhase: { min: 0.287499999, max: 0.287500001 } },
          { inputIndex: 2, at: 1.85, stateId: 'idle', restartedStateIds: ['attack'], normalizedPhase: { min: 0.462499999, max: 0.462500001 } },
        ] },
      }] });
    assert.equal(overlappingRampPlan.status, 'passed');
    assert.equal(overlappingRampPlan.cases[0]!.phaseDonorChecks.length, 3);
    assert.ok(Math.abs(preferDominantClock.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!
      .samples.find(sample => sample.stateId === 'recovery')!.playback.normalizedPhase - 0.425) < 1e-12,
    'a restarted target clip should inherit the dominant source phase despite its own different clip length and playback speed');

    const loopingDonorRecipe = animationSchema.parse({ ...idleRecipe, loop: true });
    const loopingAlternateRecipe = animationSchema.parse({ ...alternateRecipe, loop: true });
    const loopBoundaryRetarget = simulateAnimationGraphTimeline(phasePreferenceGraph,
      { [f.idle.id]: loopingDonorRecipe, [f.attack.id]: loopingAlternateRecipe, [f.recovery.id]: loopingAlternateRecipe }, {
        duration: 3.6, initialParameters: { speed: 0.5 }, sampleTimes: [3.6],
        events: [{ at: 3.6, kind: 'set_parameters', values: { speed: 2 } }],
        observedBlendAnimationLengths: { idle: { idle: 4, attack: 2, recovery: 1 } },
        observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 0.5, recovery: 1 } },
        observedBlendAnimationStartPhases: { idle: { idle: 0.1, attack: 0.4, recovery: 0.9 } },
        observedBlendAnimationAssetSetFingerprint: phaseIdentity, expectedBlendAnimationAssetSetFingerprint: phaseIdentity,
      });
    const loopBoundaryUpdate = loopBoundaryRetarget.timeline.find(event => event.event === 'set_parameters')!;
    assert.equal(loopBoundaryUpdate.phaseSourceStateId, 'idle');
    assert.ok(typeof loopBoundaryUpdate.phaseSourceNormalizedPhase === 'number'
      && Math.min(loopBoundaryUpdate.phaseSourceNormalizedPhase, 1 - loopBoundaryUpdate.phaseSourceNormalizedPhase) < 1e-12,
    'a loop donor exactly at its cycle seam should wrap to phase zero rather than leak phase one');
    assert.ok(typeof loopBoundaryUpdate.phaseSourceCurrentWeight === 'number'
      && Math.abs(loopBoundaryUpdate.phaseSourceCurrentWeight - 0.5) < 1e-12
      && typeof loopBoundaryUpdate.phaseSourceTargetWeight === 'number'
      && Math.abs(loopBoundaryUpdate.phaseSourceTargetWeight - 0.5) < 1e-12,
    'the seam trace should retain the donor’s actual current and target contributions');

    const equalContributionClock = simulateAnimationGraphTimeline({ ...phasePreferenceGraph,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 2 }] },
    { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe, [f.recovery.id]: alternateRecipe }, {
      duration: 0.2, sampleTimes: [0.1], events: [{ at: 0.1, kind: 'set_parameters', values: { speed: 2 } }],
      observedBlendAnimationLengths: { idle: { idle: 4, attack: 2, recovery: 1 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, attack: 1, recovery: 1 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.1, attack: 0.4, recovery: 0.9 } },
      observedBlendAnimationAssetSetFingerprint: phaseIdentity, expectedBlendAnimationAssetSetFingerprint: phaseIdentity,
    });
    const equalContributionUpdate = equalContributionClock.timeline.find(event => event.event === 'set_parameters')!;
    assert.equal(equalContributionUpdate.phaseSourceStateId, 'idle',
      'equal current and target contributions must resolve to the first authored still-playing source deterministically');
    assert.equal(equalContributionUpdate.phaseSourceNormalizedPhase, 0.125);
    assert.equal(equalContributionUpdate.phaseSourceCurrentWeight, 0.5);
    assert.equal(equalContributionUpdate.phaseSourceTargetWeight, 0.5);
    assert.ok(Math.abs(equalContributionClock.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!
      .samples.find(sample => sample.stateId === 'recovery')!.playback.normalizedPhase - 0.125) < 1e-12,
    'the authored-order tie-break must be reflected in the restarted clip clock');

    const restartGraph = { ...graph, transitions: [{ id: 'restartBlend', from: 'idle', to: 'idle', trigger: 'Restart', blendSeconds: 0.2 }] };
    const preservedPlayProfile = (stateId: string, recipe: AnimationRecipe, suffix: string) => ({
      id: `00000000-0000-4000-8000-00000000004${suffix}`, stateId, recipeFingerprint: fingerprint(recipe),
      profileFingerprint: suffix.repeat(64), fadeSeconds: 0.2,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }],
      playRetrigger: { probeElapsedSeconds: 0.05, timePositionBefore: 0.05, timePositionImmediatelyAfter: 0.05,
        timePositionAfterStep: 0.1, weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1,
        observedClockBehavior: 'preserved' as const },
    });
    const replayed = simulateAnimationGraphTimeline(restartGraph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.8, sampleTimes: [0.5, 0.75], events: [{ at: 0.5, kind: 'trigger', trigger: 'Restart' }],
    }, [preservedPlayProfile('idle', idleRecipe, '4'), preservedPlayProfile('attack', alternateRecipe, '5')]);
    const replayedBlend = replayed.blendSamples.find(sample => sample.at === 0.75)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(replayedBlend.samples.map(sample => sample.playback.timeSeconds), [0.75, 0.375],
      'a matching Play-retrigger probe must preserve the clocks of every already-playing BlendSpace source');
    assert.equal(replayed.playbackRetriggerModel.measuredPreservedClockTransitions, 3,
      'the runtime probe must be applied to the controller clock and its independently playing source channels');
    const resetReplay = simulateAnimationGraphTimeline(restartGraph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 0.8, sampleTimes: [0.5, 0.75], events: [{ at: 0.5, kind: 'trigger', trigger: 'Restart' }],
    });
    assert.deepEqual(resetReplay.blendSamples.find(sample => sample.at === 0.75)!.blendSpaceEvaluations[0]!.samples
      .map(sample => sample.playback.timeSeconds), [0.25, 0.125]);
    assert.equal(resetReplay.playbackRetriggerModel.unmeasuredAssumedResetTransitions, 3,
      'without a matching probe, retrigger assumptions must be counted for each real BlendSpace track clock');

    const noClock = simulateAnimationGraphTimeline(graph, { [f.idle.id]: idleRecipe, [f.attack.id]: alternateRecipe }, {
      duration: 1.6, events: [{ at: 1.5, kind: 'set_parameters', values: { speed: 10 } }],
      ...{ ...measured, observedBlendAnimationLengths: { idle: { idle: 1, attack: 1 } } },
    });
    const rejectedUpdate = noClock.timeline.find(event => event.event === 'set_parameters')!;
    assert.equal(rejectedUpdate.failureReason, 'no_usable_source_clock');
    assert.deepEqual(noClock.finalParameters, { speed: 0 },
      'a phase-dependent channel restart must not commit parameter values when no source clock is active');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('BlendSpace1D sample expansion has its own deterministic output-work limit', async () => {
  const f = await fixture();
  try {
    const stateIds = Array.from({ length: 16 }, (_, index) => `clip${index}`);
    const graph = { kind: 'animation_graph' as const, name: 'Blend budget', entryState: stateIds[0]!, sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 15 }],
      states: stateIds.map((id, index) => ({ id, name: id, animationId: f.idle.id, speed: 1,
        ...(index === 0 ? { blendSpace1D: { parameter: 'speed', samples: stateIds.map((stateId, sampleIndex) => ({
          value: sampleIndex, stateId,
        })) } } : {}) })), transitions: [] };
    assert.throws(() => simulateAnimationGraphTimeline(graph, { [f.idle.id]: animationSchema.parse(f.idle.recipe) }, {
      duration: 60, sampleRateHz: 120, includePoseSamples: false,
    }), /exceeded the 100000-weight safety limit/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('timeline simulation estimates marker and non-looping clip-end transitions using state playback speed', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const simulated = simulateAnimationGraphTimeline(graph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 1.25, events: [{ at: 0, kind: 'trigger', trigger: 'Attack', expectTransitionId: 'beginAttack' }],
  });
  assert.deepEqual(simulated.transitionIds, ['beginAttack', 'finishAttack']);
  assert.equal(simulated.finalState, 'recovery');
  assert.deepEqual(simulated.triggeredMarkers.map(marker => [marker.at, marker.marker]), [[0.25, 'Release']]);
  assert.equal(simulated.timeline.find(event => event.event === 'animation_end')?.at, 0.5);
  assert.equal(simulated.animationEndedTiming.kind, 'assumed_natural_completion_fade');
  assert.equal(simulated.animationEndedTiming.assumedAdditionalFadeSeconds, 0);
  assert.equal(simulated.animationEndedTiming.summaryStateId, 'idle');
  assert.equal(simulated.animationEndedTiming.summaryScope, 'entry_state');
  assert.equal(simulated.animationEndedTiming.source, 'default_zero');
  assert.deepEqual(simulated.animationEndedTiming.stateTimings, [{
    stateId: 'attack', source: 'default_zero', fadeSeconds: 0,
    calibrationProfileId: null, measuredAnimationLengthSeconds: null,
    calibrationConflictProfileIds: [],
    animationLengthMatchesRecipe: null,
    animationLengthSeconds: 1, animationLengthSource: 'authored_recipe', clipPlaybackSeconds: 0.5,
    animationEndedAfterPlaybackStartSeconds: 0.5,
  }]);
  assert.match(simulated.animationEndedTiming.limitation, /selected fingerprint-verified profile/);
  assert.deepEqual(simulated.trackLifecycles.map(track => [track.stateId, track.status, track.playbackCount, track.latestEndReason]), [
    ['idle', 'stopped', 1, 'transition'], ['attack', 'completed', 1, 'natural_completion'], ['recovery', 'playing', 1, null],
  ]);
  assert.equal(simulated.blendSamples.find(sample => sample.at === 0.25)?.activeTracks.find(track => track.stateId === 'attack')?.isPlaying, true,
    'a later AnimationEnded event must not rewrite the track lifecycle in earlier samples');
  assert.equal(simulated.simulatedThrough, 1.25);
  assert.match(simulated.limitation, /not executed/);
});

test('interrupted one-shots remain stopped instead of falsely completing when their unfrozen fade clock later reaches the end', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const interruptedGraph = { ...graph, transitions: [
    { id: 'beginAttack', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0 },
    { id: 'abortAttack', from: 'attack', to: 'recovery', trigger: 'Abort', blendSeconds: 0.1 },
  ] };
  const result = simulateAnimationGraphTimeline(interruptedGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
      duration: 0.8, events: [
        { at: 0, kind: 'trigger', trigger: 'Attack' },
        { at: 0.2, kind: 'trigger', trigger: 'Abort' },
      ], sampleTimes: [0.25, 0.8],
    });
  const interruptedSample = result.blendSamples.find(sample => sample.at === 0.25)!
    .activeTracks.find(track => track.stateId === 'attack');
  assert.equal(interruptedSample?.isPlaying, false);
  assert.equal(interruptedSample?.playbackTimeSeconds, 0.5,
    'the modeled TimePosition keeps advancing during the stop fade; that must not redefine why playback ended');
  const attackLifecycle = result.trackLifecycles.find(track => track.stateId === 'attack')!;
  assert.equal(attackLifecycle.status, 'stopped');
  assert.equal(attackLifecycle.latestEndReason, 'transition');
  assert.equal(attackLifecycle.playbackTimeSeconds, 1,
    'the reported clock may reach its clip limit after interruption, while lifecycle status remains transition-stopped');
  const lifecycleSuite = { cases: [{ id: 'interrupted-clip-lifecycle', name: 'Transition-stopped one-shot stays stopped', duration: 0.8,
    events: [{ at: 0, kind: 'trigger' as const, trigger: 'Attack' }, { at: 0.2, kind: 'trigger' as const, trigger: 'Abort' }],
    expect: { trackLifecycles: [{ stateId: 'attack', status: 'stopped' as const, playbackCount: 1,
      latestEndReason: 'transition' as const }] } }] };
  const lifecycleReport = runAnimationGraphTimelineSuite(interruptedGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, lifecycleSuite);
  assert.equal(lifecycleReport.status, 'passed', JSON.stringify(lifecycleReport.cases[0]!.failures));
  assert.deepEqual(lifecycleReport.cases[0]!.trackLifecycleChecks[0]!.checks.map(check => [check.property, check.passed]), [
    ['status', true], ['playbackCount', true], ['latestEndReason', true],
  ]);
  const wrongLifecycle = runAnimationGraphTimelineSuite(interruptedGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { cases: [{
      ...lifecycleSuite.cases[0]!, expect: { trackLifecycles: [{ stateId: 'attack', status: 'completed' as const }] },
    }] });
  assert.equal(wrongLifecycle.status, 'failed', 'a saved timeline assertion must reject a false natural-completion status');
  assert.equal(wrongLifecycle.cases[0]!.failures[0]!.expectation, 'trackLifecycle:attack');
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{
    ...lifecycleSuite.cases[0]!, expect: { trackLifecycles: [{ stateId: 'attack', latestEndReason: 'restarted' }] },
  }] }), /Invalid enum value/,
  'the lifecycle assertion contract should accept only end reasons emitted by the simulator');
});

test('timeline simulation can model an explicit natural-completion fade before AnimationEnded', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const recipes = { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe };
  const simulated = simulateAnimationGraphTimeline(graph, recipes, {
    duration: 0.8, naturalCompletionFadeSeconds: 0.2,
    events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.6],
  });
  assert.equal(simulated.animationEndedTiming.assumedAdditionalFadeSeconds, 0.2);
  assert.equal(simulated.animationEndedTiming.source, 'caller_supplied');
  assert.equal(simulated.animationEndedTiming.summaryScope, 'caller_global_override');
  const attackTiming = simulated.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')!;
  assert.equal(attackTiming.fadeSeconds, 0.2);
  assert.equal(attackTiming.clipPlaybackSeconds, 0.5);
  assert.equal(attackTiming.animationEndedAfterPlaybackStartSeconds, 0.7);
  assert.equal(simulated.timeline.find(event => event.event === 'animation_natural_stop')?.at, 0.5);
  assert.equal(simulated.timeline.find(event => event.event === 'animation_end')?.at, 0.7);
  const attackAtFadeMidpoint = simulated.blendSamples.find(sample => sample.at === 0.6)!.activeTracks.find(track => track.stateId === 'attack')!;
  assert.equal(attackAtFadeMidpoint.isPlaying, false);
  assert.ok(Math.abs(attackAtFadeMidpoint.weight - 0.5) < 1e-12,
    'the track stops playing at authored clip end but continues affecting the pose during the assumed fade');
  assert.deepEqual(simulated.transitionIds, ['beginAttack', 'finishAttack']);

  const suite = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{
    id: 'natural-fade', name: 'Natural completion fade timing', duration: 0.8, naturalCompletionFadeSeconds: 0.2,
    events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }],
    expect: { transitionTimes: [{ transitionId: 'finishAttack', minAt: 0.7, maxAt: 0.7 }],
      blends: [{ at: 0.6, stateId: 'attack', isPlaying: false, weight: { min: 0.5, max: 0.5 } }] },
  }] });
  assert.equal(suite.status, 'passed', JSON.stringify(suite.cases[0]?.failures));
  assert.equal(suite.cases[0]?.animationEndedTiming.assumedAdditionalFadeSeconds, 0.2);
});

test('timeline simulation applies matching measured Play and Stop curves and falls back for unmatched durations', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const profiles = [
    { id: '00000000-0000-4000-8000-000000000011', stateId: 'idle', recipeFingerprint: fingerprint(idle.recipe), profileFingerprint: 'a'.repeat(64), fadeSeconds: 0.2,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.25, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }] },
    { id: '00000000-0000-4000-8000-000000000012', stateId: 'attack', recipeFingerprint: fingerprint(attack.recipe), profileFingerprint: 'b'.repeat(64), fadeSeconds: 0.2,
      playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.7, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
      stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.25, weightTarget: 0 },
        { at: 0.2, weightCurrent: 0, weightTarget: 0 }], sampleRateHz: 30,
      naturalCompletion: { authoredDurationSeconds: 1, animationLengthSeconds: 0.99, playbackSpeed: 2, endedAfterStoppedSeconds: 0.2,
        samples: [{ at: 0, weightCurrent: 1, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.5, weightTarget: 0 },
          { at: 0.2, weightCurrent: 0, weightTarget: 0 }] } },
  ];
  const simulationInput = { duration: 0.2, events: [{ at: 0, kind: 'trigger' as const, trigger: 'Attack' }], sampleTimes: [0.1] };
  const calibrated = simulateAnimationGraphTimeline(graph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, simulationInput, profiles);
  const midpoint = calibrated.blendSamples.find(sample => sample.at === 0.1)!;
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'idle')?.weight, 0.25);
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'attack')?.weight, 0.7);
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'idle')?.fadeCalibrationProfileId, '00000000-0000-4000-8000-000000000011');
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'idle')?.fadeCalibrationDirection, 'stopOut');
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'attack')?.fadeCalibrationProfileId, '00000000-0000-4000-8000-000000000012');
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'attack')?.fadeCalibrationDirection, 'playIn');
  assert.equal(midpoint.activeTracks.find(track => track.stateId === 'attack')?.fadeCalibrationRebased, false);
  const naturalFadeMidpoint = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.595] }, profiles);
  const attackDuringNaturalFade = naturalFadeMidpoint.blendSamples.find(sample => sample.at === 0.595)!
    .activeTracks.find(track => track.stateId === 'attack')!;
  assert.equal(attackDuringNaturalFade.isPlaying, false);
  assert.ok(Math.abs(attackDuringNaturalFade.weight - 0.5) < 1e-12);
  assert.equal(attackDuringNaturalFade.fadeCalibrationProfileId, '00000000-0000-4000-8000-000000000012');
  assert.equal(attackDuringNaturalFade.fadeCalibrationDirection, 'naturalCompletion');
  assert.equal(attackDuringNaturalFade.fadeCalibrationWeightClamped, false);
  assert.equal(naturalFadeMidpoint.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')?.source, 'studio_calibrated');
  assert.equal(naturalFadeMidpoint.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')?.fadeSeconds, 0.2);
  assert.equal(naturalFadeMidpoint.animationEndedTiming.summaryStateId, 'idle');
  assert.equal(naturalFadeMidpoint.animationEndedTiming.summaryScope, 'entry_state');
  assert.equal(naturalFadeMidpoint.animationEndedTiming.source, 'default_zero',
    'entry summary must not imply a looping entry track has calibrated natural-completion timing');
  assert.equal(naturalFadeMidpoint.animationEndedTiming.assumedAdditionalFadeSeconds, 0);
  assert.equal(naturalFadeMidpoint.timeline.find(event => event.event === 'animation_natural_stop')?.at, 0.495);
  const exactNaturalStopSample = naturalFadeMidpoint.blendSamples.find(sample => sample.at === 0.495);
  assert.ok(exactNaturalStopSample, 'off-grid natural-stop events must produce an exact blend sample even when absent from sampleTimes');
  const attackAtNaturalStop = exactNaturalStopSample.activeTracks.find(track => track.stateId === 'attack')!;
  assert.equal(attackAtNaturalStop.isPlaying, false);
  assert.ok(Math.abs(attackAtNaturalStop.weight - 1) < 1e-12,
    'the off-grid boundary sample must show playback stopped while the measured natural fade begins at its observed starting weight');
  const naturalEndEvent = naturalFadeMidpoint.timeline.find(event => event.event === 'animation_end') as { at: number } | undefined;
  assert.ok(naturalEndEvent && Math.abs(naturalEndEvent.at - 0.695) < 1e-12);
  const calibratedAttackTiming = naturalFadeMidpoint.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')!;
  assert.equal(calibratedAttackTiming.animationLengthSource, 'studio_measured');
  assert.equal(calibratedAttackTiming.animationLengthSeconds, 0.99);
  assert.equal(calibratedAttackTiming.clipPlaybackSeconds, 0.495);
  assert.ok(Math.abs(calibratedAttackTiming.animationEndedAfterPlaybackStartSeconds - 0.695) < 1e-12);
  const lengthMismatch = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }] },
    profiles.map(profile => profile.stateId === 'attack' ? { ...profile, naturalCompletion: {
      ...profile.naturalCompletion!, animationLengthSeconds: 0.9,
    } } : profile));
  assert.equal(lengthMismatch.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')?.source,
    'studio_length_mismatch_default_zero');
  assert.equal(lengthMismatch.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')?.animationLengthMatchesRecipe, false);
  const measuredMismatchTiming = lengthMismatch.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')!;
  assert.equal(measuredMismatchTiming.animationLengthSeconds, 0.9,
    'an exact unambiguous calibration still provides the actual playback clock when Studio Length differs from authored duration');
  assert.equal(measuredMismatchTiming.animationLengthSource, 'studio_measured');
  assert.equal(measuredMismatchTiming.clipPlaybackSeconds, 0.45);
  assert.ok(Math.abs(measuredMismatchTiming.animationEndedAfterPlaybackStartSeconds - 0.45) < 1e-12,
    'a mismatched natural-fade profile must still schedule AnimationEnded from measured clip length while defaulting the unsupported fade to zero');
  assert.equal(lengthMismatch.timeline.find(event => event.event === 'animation_end')?.at, 0.45);
  assert.equal(lengthMismatch.animationEndedTiming.assumedAdditionalFadeSeconds, 0);
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }] },
    profiles.map(profile => profile.stateId === 'attack' ? { ...profile, naturalCompletion: {
      ...profile.naturalCompletion!, animationLengthSeconds: 0,
    } } : profile)),
  /greater than 0|> 0/i,
  'direct simulation input must reject an unloaded zero-length observation instead of scheduling immediate AnimationEnded');
  const conflictingAttackProfile = { ...profiles[1]!, id: '00000000-0000-4000-8000-000000000013', profileFingerprint: 'c'.repeat(64),
    fadeSeconds: 0.3, playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.3, weightCurrent: 1, weightTarget: 1 }],
    stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.3, weightCurrent: 0, weightTarget: 0 }],
    naturalCompletion: { authoredDurationSeconds: 1, animationLengthSeconds: 0.98, playbackSpeed: 2, endedAfterStoppedSeconds: 0.24,
      samples: [{ at: 0, weightCurrent: 1, weightTarget: 1 }, { at: 0.12, weightCurrent: 0.5, weightTarget: 0 },
        { at: 0.24, weightCurrent: 0, weightTarget: 0 }] } };
  const ambiguousNaturalCompletion = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }] }, [...profiles, conflictingAttackProfile]);
  const ambiguousAttackTiming = ambiguousNaturalCompletion.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')!;
  assert.equal(ambiguousAttackTiming.source, 'ambiguous_profile_default_zero');
  assert.deepEqual(ambiguousAttackTiming.calibrationConflictProfileIds, ['00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013']);
  assert.deepEqual(ambiguousNaturalCompletion.animationEndedTiming.naturalCompletionConflicts[0]?.conflictingFields,
    ['animationLengthSeconds', 'endedAfterStoppedSeconds', 'samples']);
  assert.equal(ambiguousNaturalCompletion.animationEndedTiming.naturalCompletionConflicts[0]?.candidates.length, 2);
  const ambiguousWithCallerOverride = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, naturalCompletionFadeSeconds: 0.15, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }] },
    [...profiles, conflictingAttackProfile]);
  const overriddenAmbiguousTiming = ambiguousWithCallerOverride.animationEndedTiming.stateTimings.find(timing => timing.stateId === 'attack')!;
  assert.equal(overriddenAmbiguousTiming.source, 'caller_supplied');
  assert.deepEqual(overriddenAmbiguousTiming.calibrationConflictProfileIds, ambiguousAttackTiming.calibrationConflictProfileIds,
    'a caller assumption can define timing but must not hide the conflicting empirical profiles');
  const noisyNaturalCurveProfiles = profiles.map(profile => profile.stateId === 'attack' ? { ...profile, naturalCompletion: {
    ...profile.naturalCompletion!, samples: [{ at: 0, weightCurrent: 0.8, weightTarget: 1 },
      { at: 0.1, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }],
  } } : profile);
  const noisyNaturalCurve = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.595] }, noisyNaturalCurveProfiles);
  const noisyNaturalFadeTrack = noisyNaturalCurve.blendSamples.find(sample => sample.at === 0.595)!
    .activeTracks.find(track => track.stateId === 'attack')!;
  assert.equal(noisyNaturalFadeTrack.weight, 1, 'rebased noisy empirical weights must remain within Roblox’s [0, 1] track-weight range');
  assert.equal(noisyNaturalFadeTrack.fadeCalibrationWeightClamped, true,
    'the simulator must tell the AI when measurement noise forced a calibrated weight clamp');
  assert.equal(calibrated.blendModel.kind, 'studio_calibrated_curve_per_track_estimate');
  assert.deepEqual(calibrated.blendModel.calibrationProfileIds, ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012']);
  assert.match(calibrated.blendModel.limitation, /unmatched fade durations retain a linear estimate/);
  assert.match(calibrated.limitation, /WeightCurrent curves are piecewise-linearly interpolated only for exact state\/fade-duration matches, while unmatched fades remain linear/i);
  assert.doesNotMatch(calibrated.limitation, /blend samples track independent per-state linear weight envelopes/i);
  const interruptedCalibrated = simulateAnimationGraphTimeline({ ...graph, transitions: graph.transitions.map(transition =>
    transition.id === 'finishAttack' ? { ...transition, blendSeconds: 0.2 } : transition) },
  { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 0.2, events: [
      { at: 0, kind: 'trigger' as const, trigger: 'Attack' },
      { at: 0.1, kind: 'trigger' as const, trigger: 'AnimationEnded' },
    ], sampleTimes: [0.15],
  }, profiles);
  const interruptedAttack = interruptedCalibrated.blendSamples.find(sample => sample.at === 0.15)!
    .activeTracks.find(track => track.stateId === 'attack')!;
  assert.ok(Math.abs(interruptedAttack.weight - 0.4375) < 1e-12,
    'a measured stop curve must be shape-rebased from the track’s current 0.7 weight when an in-progress play fade is interrupted');
  assert.equal(interruptedAttack.fadeCalibrationProfileId, '00000000-0000-4000-8000-000000000012');
  assert.equal(interruptedAttack.fadeCalibrationDirection, 'stopOut');
  assert.equal(interruptedAttack.fadeCalibrationRebased, true);
  assert.match(interruptedCalibrated.blendModel.limitation, /interrupted, the measured curve shape is normalized and rebased from the track’s current weight/i);
  const mismatchedDuration = simulateAnimationGraphTimeline({ ...graph, transitions: graph.transitions.map(transition =>
    transition.id === 'beginAttack' ? { ...transition, blendSeconds: 0.3 } : transition) },
  { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { ...simulationInput, duration: 0.3, sampleTimes: [0.15] }, profiles);
  assert.equal(mismatchedDuration.blendModel.kind, 'linear_per_track_weight_estimate');
  assert.deepEqual(mismatchedDuration.blendModel.calibrationProfileIds, []);
  assert.match(mismatchedDuration.limitation, /fade envelopes are linear because no matching Studio calibration curves were applied/i);
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, simulationInput,
    [{ ...profiles[0]!, recipeFingerprint: 'c'.repeat(64) }]), /does not match the current graph state/i);
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, simulationInput,
    [{ ...profiles[0]!, playIn: [...profiles[0]!.playIn].reverse() }]), /ordered timestamps and verified start\/end evidence/i);
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, simulationInput,
    [{ ...profiles[0]!, stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0.2, weightTarget: 0 }] }]),
  /ordered timestamps and verified start\/end evidence/i);
});

test('calibrated fade interpolation holds the last measurement across the allowed endpoint timestamp tolerance', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const idleRecipe = animationSchema.parse(idle.recipe);
  const attackRecipe = animationSchema.parse(attack.recipe);
  const recoveryRecipe = animationSchema.parse(recovery.recipe);
  const capturedAt = Array.from({ length: 361 }, (_, index) => (0.1995 * index) / 360);
  const fullRateCurve = (target: number) => capturedAt.map(at => ({ at, weightCurrent: target === 1
    ? (at / 0.1995) ** 2 : 1 - (at / 0.1995) ** 2, weightTarget: target }));
  const nearEndpoint = (fadeSeconds: number, stateId: string, recipe: AnimationRecipe) => ({
    id: stateId === 'idle' ? '00000000-0000-4000-8000-000000000031' : '00000000-0000-4000-8000-000000000032',
    stateId, recipeFingerprint: fingerprint(recipe), profileFingerprint: 'd'.repeat(64), fadeSeconds,
    playIn: fullRateCurve(1), stopOut: fullRateCurve(0),
  });
  const profiles = [nearEndpoint(0.2, 'idle', idleRecipe), nearEndpoint(0.2, 'attack', attackRecipe)];
  const simulation = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: recoveryRecipe },
    { duration: 0.2, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.19975] }, profiles);
  const tracks = simulation.blendSamples.find(sample => sample.at === 0.19975)!.activeTracks;
  const outgoingTrack = tracks.find(track => track.stateId === 'idle');
  assert.ok(!outgoingTrack || Math.abs(outgoingTrack.weight) < 1e-9,
    'fade-out should hold its final measured zero-weight sample until the exact fade deadline');
  assert.ok(Math.abs(tracks.find(track => track.stateId === 'attack')!.weight - 1) < 1e-9,
    'fade-in should hold its final measured full-weight sample until the exact fade deadline');
});

test('timeline simulation models selected destination load failure as atomic and does not fall through', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const loadFailureGraph = { ...graph, parameters: [{ name: 'armed', type: 'boolean' as const, defaultValue: false }],
    transitions: [
      { id: 'preferredUnavailable', from: 'idle', to: 'attack', trigger: 'Attack', priority: 10, blendSeconds: 0.2, guards: [] },
      { id: 'lowerFallback', from: 'idle', to: 'recovery', trigger: 'Attack', priority: 0, blendSeconds: 0.1, guards: [] },
      ...graph.transitions.filter(transition => transition.from !== 'idle'),
    ] };
  const simulated = simulateAnimationGraphTimeline(loadFailureGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, initialParameters: { armed: false }, unavailableStateIds: ['attack'],
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack', setParameters: { armed: true }, expectTransitionId: 'preferredUnavailable' }],
      sampleTimes: [0.1, 0.2] });
  assert.deepEqual(simulated.transitionIds, [], 'a load failure must not be recorded as a successful graph transition');
  assert.equal(simulated.finalState, 'idle');
  assert.deepEqual(simulated.finalParameters, { armed: false }, 'parameter updates must roll back when the selected destination cannot load');
  assert.deepEqual(simulated.timeline.filter(event => event.event === 'transition_failed').map(event => [
    event.selectedTransitionId, event.failedStateId, event.failureReason, event.stateBefore, event.stateAfter,
  ]), [['preferredUnavailable', 'attack', 'destination_animation_unavailable', 'idle', 'idle']]);
  assert.equal(simulated.blendSamples.find(sample => sample.at === 0.2)?.activeTracks.find(track => track.stateId === 'idle')?.weight, 1,
    'the current track must not begin fading when destination loading fails');
  assert.deepEqual(simulated.loadFailureSimulation.unavailableStateIds, ['attack']);
  assert.equal(simulated.loadFailureSimulation.count, 1);
  assert.match(simulated.loadFailureSimulation.limitation, /does not model preloadAll failures/);
  assert.throws(() => simulateAnimationGraphTimeline(loadFailureGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.1, unavailableStateIds: ['idle'] }), /entry state cannot be unavailable/i);
  assert.throws(() => simulateAnimationGraphTimeline(loadFailureGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.1, unavailableStateIds: ['attack', 'attack'] }), /must not contain duplicates/i);
});

test('timeline simulation preserves overlapping per-track fades across interrupted transitions', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const interruptedGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'interruptAttack', from: 'attack', to: 'recovery', trigger: 'Interrupt', blendSeconds: 0.4,
  }] };
  const simulated = simulateAnimationGraphTimeline(interruptedGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.6, events: [
      { at: 0, kind: 'trigger', trigger: 'Attack', expectTransitionId: 'beginAttack' },
      { at: 0.1, kind: 'trigger', trigger: 'Interrupt', expectTransitionId: 'interruptAttack' },
    ] });

  const interruption = simulated.timeline.find(event => event.transitionId === 'interruptAttack')!;
  assert.deepEqual(interruption.interruptedBlend, ['idle']);
  assert.equal(interruption.sourceWeightAtTransition, 0.5);
  assert.equal(interruption.destinationWeightAtTransition, 0);
  const middle = simulated.blendSamples.find(sample => sample.at === 5 / graph.sampleRate)!;
  assert.equal(middle.currentState, 'recovery');
  assert.deepEqual(middle.activeTracks.map(track => [track.stateId, track.weight]), [
    ['attack', 0.4166666666666667], ['idle', 0.16666666666666674], ['recovery', 0.16666666666666663],
  ]);
  assert.deepEqual(middle.activeTracks.map(track => [track.stateId, track.targetWeight, track.fadeRemainingSeconds]), [
    ['attack', 0, 0.33333333333333337], ['idle', 0, 0.033333333333333354], ['recovery', 1, 0.33333333333333337],
  ]);
  assert.deepEqual(middle.activeTracks.map(track => [track.stateId, track.isPlaying, track.isAffectingPose]), [
    ['attack', false, true], ['idle', false, true], ['recovery', true, true],
  ]);
  const settled = simulated.blendSamples.find(sample => sample.at === 0.5)!;
  assert.deepEqual(settled.activeTracks.map(track => [track.stateId, track.weight]), [['recovery', 1]]);
  assert.equal(simulated.trackLifecycles.find(track => track.stateId === 'idle')?.status, 'stopped');
  assert.equal(simulated.blendModel.kind, 'linear_per_track_weight_estimate');
  assert.match(simulated.blendModel.limitation, /not normalized/);
  assert.match(simulated.poseModel.limitation, /order-independent Markley weighted quaternion mean/);
});

test('timeline history lookup stays correct across rapid same-timestamp restarts and repeated fade interruptions', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const rapidGraph = { ...graph, transitions: [
    { id: 'cycleAttack', from: 'idle', to: 'attack', trigger: 'CycleAttack', blendSeconds: 0.1 },
    { id: 'cycleRecovery', from: 'attack', to: 'recovery', trigger: 'CycleRecovery', blendSeconds: 0.1 },
    { id: 'cycleIdle', from: 'recovery', to: 'idle', trigger: 'CycleIdle', blendSeconds: 0.1 },
  ] };
  const cycles = 50;
  const events = Array.from({ length: cycles }, (_, cycle) => {
    const at = cycle / 100;
    return [
      { at, kind: 'trigger' as const, trigger: 'CycleAttack' },
      { at, kind: 'trigger' as const, trigger: 'CycleRecovery' },
      { at, kind: 'trigger' as const, trigger: 'CycleIdle' },
    ];
  }).flat();
  const lastTransitionAt = (cycles - 1) / 100;
  const sampleAt = lastTransitionAt + 0.005;
  const report = simulateAnimationGraphTimeline(rapidGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.6, events, sampleTimes: [sampleAt] });
  const sample = report.blendSamples.find(item => item.at === sampleAt)!;
  assert.equal(sample.currentState, 'idle');
  const currentIdleTrack = sample.activeTracks.find(track => track.stateId === 'idle')!;
  assert.equal(currentIdleTrack.targetWeight, 1,
    'same-time stop/play operations must resolve to the last appended fade envelope');
  assert.ok(Math.abs(currentIdleTrack.fadeRemainingSeconds - 0.095) < 1e-12,
    'the active fade must be measured from the final transition in the timestamp group');
  assert.equal(report.transitionIds.length, cycles * 3);
  assert.deepEqual(report.trackLifecycles.map(track => [track.stateId, track.playbackCount]), [
    ['idle', cycles + 1], ['attack', cycles], ['recovery', cycles],
  ], 'every rapid revisit must append a new playback epoch without losing history');
});

test('track lifecycle summary is explicitly timestamped and distinguishes fading from never-started tracks', async () => {
  const { idle, attack } = await fixture();
  const graph = { kind: 'animation_graph' as const, name: 'Lifecycle snapshot', entryState: 'idle', sampleRate: 30,
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'unused', name: 'Unused', animationId: attack.id, speed: 1 },
    ],
    transitions: [{ id: 'attack', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.4 }],
  };
  const report = simulateAnimationGraphTimeline(graph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe }, {
    duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }],
  });
  assert.deepEqual(report.trackLifecycles.map(track => [track.stateId, track.observedAt, track.status, track.playbackCount, track.latestEndAt]), [
    ['idle', 0.3, 'stopped_fading', 1, 0.1], ['attack', 0.3, 'playing', 1, null], ['unused', 0.3, 'not_started', 0, null],
  ]);
  const fadingIdle = report.trackLifecycles.find(track => track.stateId === 'idle')!;
  assert.equal(fadingIdle.latestStopRequestedAt, 0.1);
  assert.equal(fadingIdle.fadeOutCompletesAt, 0.5);
  assert.ok(Math.abs(fadingIdle.fadeOutRemainingSeconds - 0.2) < 1e-12);
  const activeAttack = report.trackLifecycles.find(track => track.stateId === 'attack')!;
  assert.equal(activeAttack.latestStopRequestedAt, null);
  assert.equal(activeAttack.fadeOutCompletesAt, null);
  assert.equal(activeAttack.fadeOutRemainingSeconds, 0);
  const endpoint = report.blendSamples.find(sample => sample.at === 0.3)!;
  assert.equal(endpoint.activeTracks.find(track => track.stateId === 'idle')?.weight, 0.5);
  assert.equal(endpoint.activeTracks.find(track => track.stateId === 'unused'), undefined);
});

test('requested pose samples compose per-joint track weights by Roblox priority and preserve joint coverage', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const withConstantTorsoOffset = (recipe: AnimationRecipe, priority: NonNullable<AnimationRecipe['priority']>, offset: number) => ({
    ...recipe, priority,
    tracks: recipe.tracks.filter(track => track.joint === 'UpperTorso').map(track => ({ ...track,
      keys: track.keys.map(key => ({ ...key, position: [offset, 0, 0] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] })) })),
  });
  const idleRecipe = withConstantTorsoOffset(animationSchema.parse(idle.recipe), 'Action', 2);
  const attackRecipe = withConstantTorsoOffset(animationSchema.parse(attack.recipe), 'Movement', 10);
  const recoveryRecipe = animationSchema.parse(recovery.recipe);
  const noTorsoRecipe = { ...recoveryRecipe, tracks: recoveryRecipe.tracks.filter(track => track.joint !== 'UpperTorso') };
  const simulated = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.2], poseJoints: ['UpperTorso'] });
  assert.equal(simulated.poseModel.kind, 'priority_weighted_local_pose_estimate');
  assert.equal(simulated.poseModel.sampleCount, 1);
  assert.equal(simulated.poseModel.jointSampleCount, 1);
  assert.equal(simulated.poseModel.contributionCount, 2);
  assert.equal(simulated.poseModel.residualBasis, 'identity_local_animation_delta');
  assert.match(simulated.poseModel.limitation, /not the rig’s authored rest CFrame/i);
  assert.match(simulated.poseModel.limitation, /order-independent Markley weighted quaternion mean/);
  const pose = simulated.composedPoseSamples[0]!.joints[0]!;
  assert.equal(pose.joint, 'UpperTorso');
  assert.ok(Math.abs(pose.position[0] - (2 * 0.5 + 10 * 0.5)) < 1e-12);
  assert.deepEqual(pose.contributors.map(contributor => [contributor.stateId, contributor.priority]), [
    ['idle', 'Action'], ['attack', 'Movement'],
  ]);
  assert.ok(pose.contributors.every(contributor => Math.abs(contributor.effectiveWeight - 0.5) < 1e-12));
  assert.deepEqual(pose.priorityLayers.map(layer => [layer.priority, layer.stateIds]), [
    ['Action', ['idle']], ['Movement', ['attack']],
  ], 'pose evidence must expose high-to-low priority layers and contributing states');
  assert.ok(pose.priorityLayers.every((layer, index) => Math.abs(layer.requestedWeight - 0.5) < 1e-12
    && Math.abs(layer.availableWeightBefore - (index === 0 ? 1 : 0.5)) < 1e-12
    && Math.abs(layer.effectiveBudget - 0.5) < 1e-12
    && Math.abs(layer.remainingWeightAfter - (index === 0 ? 0.5 : 0)) < 1e-12),
  'priority-layer budgets must account for requested weight, available weight, applied weight and fallthrough');
  assert.equal(pose.residualWeight, 0);

  const missingJointCoverage = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.7], poseJoints: ['UpperTorso'] });
  const missingJointPose = missingJointCoverage.composedPoseSamples[0]!.joints[0]!;
  assert.equal(missingJointCoverage.composedPoseSamples[0]!.currentState, 'recovery');
  assert.deepEqual(missingJointPose.unanimatedTracks, [{ stateId: 'recovery', priority: 'Core', trackWeight: 1,
    playbackTimeSeconds: 0.19999999999999996, reason: 'joint_not_animated' }]);
  assert.equal(missingJointPose.residualWeight, 1,
    'a missing joint channel must leave its full pose budget neutral rather than fabricate motion');
  assert.equal(missingJointCoverage.poseModel.unanimatedTrackJointCount, 1);

  const zeroWeight = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { duration: 0.1, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0], poseJoints: ['UpperTorso'] })
    .composedPoseSamples[0]!.joints[0]!;
  assert.equal(zeroWeight.contributors.find(contributor => contributor.stateId === 'attack')?.trackWeight, 0);
  assert.equal(zeroWeight.contributors.find(contributor => contributor.stateId === 'attack')?.contributionStatus, 'zero_weight');

  const samePriority = simulateAnimationGraphTimeline(graph,
    { [idle.id]: { ...idleRecipe, priority: 'Movement' }, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.2], poseJoints: ['UpperTorso'] });
  const samePriorityContributors = samePriority.composedPoseSamples[0]!.joints[0]!.contributors;
  assert.deepEqual(samePriorityContributors.map(contributor => contributor.stateId), ['attack', 'idle']);
  assert.ok(samePriorityContributors.every(contributor => Math.abs(contributor.effectiveWeight - 0.5) < 1e-12));
  assert.equal(samePriority.composedPoseSamples[0]!.joints[0]!.priorityLayers.length, 1,
    'same-priority tracks must share one priority budget layer');
  const withTorsoRotation = (recipe: AnimationRecipe, degrees: number) => ({ ...recipe, tracks: recipe.tracks.map(track => track.joint !== 'UpperTorso' ? track : ({
    ...track, keys: track.keys.map(key => ({ ...key, rotation: [0, 0, degrees] as [number, number, number] })),
  })) });
  const rotationBlend = simulateAnimationGraphTimeline(graph, {
    [idle.id]: withTorsoRotation({ ...idleRecipe, priority: 'Movement' }, 30),
    [attack.id]: withTorsoRotation(attackRecipe, 90), [recovery.id]: noTorsoRecipe,
  }, { duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.2], poseJoints: ['UpperTorso'] })
    .composedPoseSamples[0]!.joints[0]!.rotationQuaternion;
  assert.ok(Math.abs(rotationBlend[2] - Math.sin(Math.PI / 6)) < 1e-10);
  assert.ok(Math.abs(rotationBlend[3] - Math.cos(Math.PI / 6)) < 1e-10,
    'equal-weight 30/90 degree rotations should compose to the 60 degree Markley mean');
  const withTorsoEuler = (recipe: AnimationRecipe, rotation: [number, number, number]) => ({ ...recipe,
    tracks: recipe.tracks.map(track => track.joint !== 'UpperTorso' ? track : ({
      ...track, keys: track.keys.map(key => ({ ...key, rotation })),
    })) });
  const crossAxisBlend = simulateAnimationGraphTimeline(graph, {
    [idle.id]: withTorsoEuler({ ...idleRecipe, priority: 'Movement' }, [90, 0, 0]),
    [attack.id]: withTorsoEuler(attackRecipe, [0, 90, 0]), [recovery.id]: noTorsoRecipe,
  }, { duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.2], poseJoints: ['UpperTorso'] })
    .composedPoseSamples[0]!.joints[0]!.rotationQuaternion;
  assert.ok(Math.abs(crossAxisBlend[0] - 1 / Math.sqrt(6)) < 1e-10);
  assert.ok(Math.abs(crossAxisBlend[1] - 1 / Math.sqrt(6)) < 1e-10);
  assert.ok(Math.abs(crossAxisBlend[2]) < 1e-10);
  assert.ok(Math.abs(crossAxisBlend[3] - 2 / Math.sqrt(6)) < 1e-10,
    'equal-weight orthogonal-axis rotations should match the principal-eigenvector mean');
  const ambiguousGraph = { ...graph, transitions: [...graph.transitions.map(transition => transition.id === 'beginAttack'
    ? { ...transition, blendSeconds: 0.4 } : transition), {
    id: 'interruptForRotation', from: 'attack', to: 'recovery', trigger: 'Interrupt', blendSeconds: 0.4,
  }] };
  const ambiguousRecipes = (recoveryDegrees: number) => ({
    [idle.id]: withTorsoRotation({ ...idleRecipe, priority: 'Movement' }, 0),
    [attack.id]: withTorsoRotation(attackRecipe, 180),
    [recovery.id]: withTorsoRotation(recoveryRecipe, recoveryDegrees),
  });
  const ambiguousInput = { duration: 0.3, events: [
    { at: 0, kind: 'trigger' as const, trigger: 'Attack' },
    { at: 0.1, kind: 'trigger' as const, trigger: 'Interrupt' },
  ], sampleTimes: [0.23], poseJoints: ['UpperTorso'] };
  const ambiguous = simulateAnimationGraphTimeline(ambiguousGraph, ambiguousRecipes(-180), ambiguousInput)
    .composedPoseSamples[0]!.joints[0]!;
  const alternateAntipodal = simulateAnimationGraphTimeline(ambiguousGraph, ambiguousRecipes(180), ambiguousInput)
    .composedPoseSamples[0]!.joints[0]!;
  assert.ok(ambiguous.rotationBlendConfidence < 0.02,
    `near-equal 0/180 degree modes should report low orientation confidence: ${ambiguous.rotationBlendConfidence} ${JSON.stringify(ambiguous.contributors.map(item => [item.stateId, item.effectiveWeight, item.rotationQuaternion]))}`);
  assert.ok(Math.abs(ambiguous.rotationInfluence + ambiguous.residualWeight - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...ambiguous.rotationQuaternion) - 1) < 1e-12);
  assert.ok(ambiguous.rotationQuaternion.every((value, index) => Math.abs(Math.abs(value) - Math.abs(alternateAntipodal.rotationQuaternion[index]!)) < 1e-10),
    'equivalent antipodal quaternion representations must produce the same orientation');

  const fadingGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'interruptForPose', from: 'attack', to: 'recovery', trigger: 'Interrupt', blendSeconds: 0.4,
  }] };
  const residual = simulateAnimationGraphTimeline(fadingGraph, { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: recoveryRecipe }, {
    duration: 0.3, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }, { at: 0.1, kind: 'trigger', trigger: 'Interrupt' }],
    sampleTimes: [0.15], poseJoints: ['UpperTorso'],
  }).composedPoseSamples[0]!.joints[0]!;
  assert.ok(Math.abs(residual.residualWeight - 0.1875) < 1e-12, 'unfilled weight must remain on the identity local animation delta');
  assert.ok(Math.abs(residual.rotationInfluence - 0.8125) < 1e-12, 'rotation influence must report animated weight separately from neutral local animation weight');
  assert.ok(Math.abs(residual.rotationInfluence + residual.residualWeight - 1) < 1e-12);
  assert.ok(Math.abs(residual.contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, 0) + residual.residualWeight - 1) < 1e-12);

  const saturatedGraph = { kind: 'animation_graph' as const, name: 'Priority saturation', entryState: 'idle', sampleRate: 30,
    states: graph.states, transitions: [
      { id: 'slowStart', from: 'idle', to: 'attack', trigger: 'Start', blendSeconds: 5 },
      { id: 'instantInterrupt', from: 'attack', to: 'recovery', trigger: 'Interrupt', blendSeconds: 0 },
    ] };
  const saturation = simulateAnimationGraphTimeline(saturatedGraph, {
    [idle.id]: { ...idleRecipe, priority: 'Core' }, [attack.id]: { ...attackRecipe, priority: 'Movement' },
    [recovery.id]: { ...withConstantTorsoOffset(recoveryRecipe, 'Action4', 30) },
  }, { duration: 0.2, events: [{ at: 0, kind: 'trigger', trigger: 'Start' }, { at: 0.1, kind: 'trigger', trigger: 'Interrupt' }],
    sampleTimes: [0.1], poseJoints: ['UpperTorso'] }).composedPoseSamples[0]!.joints[0]!;
  assert.equal(saturation.contributors.find(contributor => contributor.stateId === 'recovery')?.effectiveWeight, 1);
  assert.equal(saturation.contributors.find(contributor => contributor.stateId === 'idle')?.contributionStatus, 'masked_by_higher_priority');
  assert.equal(saturation.contributors.find(contributor => contributor.stateId === 'idle')?.effectiveWeight, 0);
  assert.deepEqual(saturation.priorityLayers.map(layer => [layer.priority, layer.effectiveBudget, layer.remainingWeightAfter]), [
    ['Action4', 1, 0], ['Core', 0, 0],
  ], 'a saturated high-priority pose must diagnose lower-priority masking');
  assert.ok(Math.abs(saturation.position[0] - 30) < 1e-12);
  const poseSuite = runAnimationGraphTimelineSuite(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'blend-pose', name: 'Priority blend reaches expected local offset', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.2, joint: 'UpperTorso',
        expectedPosition: [6, 0, 0], positionToleranceStuds: 0.001, expectedRotation: [0, 0, 90], rotationToleranceDegrees: 0.01 }] } }] });
  assert.equal(poseSuite.status, 'passed');
  assert.equal(poseSuite.cases[0]!.poseChecks[0]!.status, 'passed');
  const wrongPoseSuite = runAnimationGraphTimelineSuite(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'wrong-pose', name: 'Detect wrong local offset', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.2, joint: 'UpperTorso',
        expectedPosition: [8, 0, 0], positionToleranceStuds: 0.001,
        expectedRotation: [0, 0, 180], rotationToleranceDegrees: 0.001 }] } }] });
  assert.equal(wrongPoseSuite.status, 'failed');
  assert.equal(wrongPoseSuite.cases[0]!.poseChecks[0]!.status, 'failed');
  const diagnosedContributors = wrongPoseSuite.cases[0]!.poseChecks[0]!.diagnosis!.dominantContributors;
  assert.ok(diagnosedContributors[0]!.effectiveWeight >= diagnosedContributors[1]!.effectiveWeight);
  assert.ok(diagnosedContributors[0]!.effectiveWeight > 0);
  assert.ok(diagnosedContributors[0]!.recipeChannels.some(channel => channel.kind === 'base' && channel.applied));
  const positionFailure = wrongPoseSuite.cases[0]!.failures.find(failure => failure.expectation.endsWith(':position'))!;
  assert.equal(positionFailure.diagnosis!.dominantContributors[0]!.effectiveWeight, 0.5);
  const positionAttribution = positionFailure.diagnosis!.positionErrorAttribution!;
  assert.ok(Math.abs(positionAttribution.errorVector[0] + 2) < 1e-12);
  assert.ok(positionAttribution.errorVector.slice(1).every(value => Math.abs(value) < 1e-12));
  assert.ok(positionAttribution.accountingErrorStuds < 1e-12,
    'per-state and residual-pose error attribution must reconstruct the exact composed-position mismatch');
  assert.equal(positionAttribution.contributors.find(contributor => contributor.stateId === 'idle')?.role, 'pushes_toward_mismatch');
  assert.equal(positionAttribution.contributors.find(contributor => contributor.stateId === 'attack')?.role, 'counteracts_mismatch');
  assert.equal(positionAttribution.neutralAnimationPose.basis, 'identity_local_animation_delta');
  assert.equal(positionAttribution.neutralAnimationPose.role, 'no_directional_effect');
  const rotationFailure = wrongPoseSuite.cases[0]!.failures.find(failure => failure.expectation.endsWith(':rotation'))!;
  const rotationComparison = rotationFailure.diagnosis!.rotationTargetComparison!;
  assert.ok(rotationComparison.composedErrorDegrees > 0);
  assert.equal(rotationComparison.contributors[0]!.stateId, 'idle');
  assert.ok(rotationComparison.contributors[0]!.weightedTargetErrorScore > rotationComparison.contributors[1]!.weightedTargetErrorScore);
  assert.match(rotationComparison.rankingLimitation, /not additive/);
  assert.equal(rotationComparison.neutralAnimationPose.basis, 'identity_local_animation_delta');
  const throughoutSuite = runAnimationGraphTimelineSuite(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'pose-window', name: 'Detect transition excursion', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.3, joint: 'UpperTorso',
        expectedPosition: [12, 0, 0], positionToleranceStuds: 0.001,
        throughout: { start: 0.1, end: 0.3, sampleRateHz: 10, maxSampleGapSeconds: 0.01,
          maxLinearSpeedStudsPerSecond: 0.1, maxAngularSpeedDegreesPerSecond: 0.1,
          maxLinearAccelerationStudsPerSecondSquared: 0.1, maxAngularAccelerationDegreesPerSecondSquared: 0.1 } }] } }] });
  const windowCheck = throughoutSuite.cases[0]!.poseChecks[0]!;
  assert.equal(windowCheck.status, 'failed', 'a passing endpoint must not conceal an excursion during the transition');
  assert.ok(windowCheck.throughoutChecks!.some(check => check.property === 'maximumPositionErrorStuds'));
  const positionWindowCheck = windowCheck.throughoutChecks!.find(check => check.property === 'maximumPositionErrorStuds')!;
  const windowObserved = positionWindowCheck.observed as { errorStuds: number; blendContext: {
    currentState: string; activeTracks: Array<{ stateId: string; weight: number; drivesJoint: boolean; effectiveWeight?: number }>;
    lastTransition: { transitionId: string; phase: string; blendProgress: number } | null;
  } };
  assert.ok(windowObserved.errorStuds > 0.001);
  assert.equal(windowObserved.blendContext.currentState, 'attack');
  assert.ok(windowObserved.blendContext.activeTracks.some(track => track.stateId === 'idle' && track.drivesJoint));
  assert.ok(windowObserved.blendContext.activeTracks.some(track => track.stateId === 'attack'));
  assert.equal(windowObserved.blendContext.lastTransition!.transitionId, 'beginAttack');
  assert.equal(windowObserved.blendContext.lastTransition!.phase, 'crossfading');
  assert.equal(positionWindowCheck.passed, false);
  assert.ok(throughoutSuite.cases[0]!.failures.some(failure => failure.expectation.endsWith(':positionThroughout')));
  const linearSpeedCheck = windowCheck.throughoutChecks!.find(check => check.property === 'maximumSampledLinearSpeedStudsPerSecond')!;
  assert.equal(linearSpeedCheck.passed, false, 'the handoff must fail an explicitly too-low sampled local-speed limit');
  assert.ok((linearSpeedCheck.observed as { studsPerSecond: number }).studsPerSecond > 0.1);
  assert.equal(windowCheck.throughoutChecks!.find(check => check.property === 'maximumSampledAngularSpeedDegreesPerSecond')!.passed, true,
    'a zero angular-speed trace should pass its explicit angular-speed gate');
  assert.ok(throughoutSuite.cases[0]!.failures.some(failure => failure.expectation.endsWith(':maximumLinearSpeed')));
  const linearAccelerationCheck = windowCheck.throughoutChecks!.find(check => check.property === 'maximumSampledLinearAccelerationStudsPerSecondSquared')!;
  assert.equal(linearAccelerationCheck.passed, true, 'a steady local-translation velocity should pass a conservative acceleration cap');
  assert.equal(windowCheck.throughoutChecks!.find(check => check.property === 'maximumSampledAngularAccelerationDegreesPerSecondSquared')!.passed, true,
    'a stationary angular trace must pass its explicit angular-acceleration gate');
  const maximumPoseGapCheck = windowCheck.throughoutChecks!.find(check => check.property === 'maximumPoseSampleGapSeconds')!;
  assert.equal(maximumPoseGapCheck.passed, false, 'a temporal regression plan must fail when adjacent pose observations violate its requested spacing');
  const maximumPoseGapObserved = maximumPoseGapCheck.observed as { seconds: number; from: number; to: number; sampleCoverage: number };
  assert.ok(maximumPoseGapObserved.seconds > 0.01);
  assert.equal(maximumPoseGapObserved.to - maximumPoseGapObserved.from, maximumPoseGapObserved.seconds);
  assert.ok(maximumPoseGapObserved.sampleCoverage > 1);
  assert.ok(throughoutSuite.cases[0]!.failures.some(failure => failure.expectation.endsWith(':maximumSampleGap')));
  const undersampledRecipe = animationSchema.parse({ kind: 'animation', name: 'Undersampled acceleration gate', duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] }] });
  const undersampledGate = runAnimationGraphTimelineSuite({ kind: 'animation_graph', name: 'Undersampled gate', entryState: 'idle', sampleRate: 15,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions: [] },
    { [idle.id]: undersampledRecipe }, { cases: [{ id: 'insufficient-acceleration-samples', name: 'Require acceleration evidence', duration: 0.4,
      events: [], expect: { poses: [{ at: 0.4, joint: 'UpperTorso', throughout: { start: 0.3, end: 0.4, sampleRateHz: 1,
        maxLinearAccelerationStudsPerSecondSquared: 100 } }] } }] });
  assert.equal(undersampledGate.status, 'failed', 'an acceleration limit must fail closed when fewer than three contiguous poses are available');
  const unavailableAcceleration = undersampledGate.cases[0]!.failures.find(failure => failure.expectation.endsWith(':maximumLinearAcceleration'))!;
  assert.deepEqual(unavailableAcceleration.observed, { intervalCount: 0, sampleCoverage: 2 });
  const unavailableAccelerationDiagnosis = (unavailableAcceleration as typeof unavailableAcceleration & { motionGuidance: {
    kind: string; suggestedNextStep: string } }).motionGuidance;
  assert.equal(unavailableAccelerationDiagnosis.kind, 'insufficient_contiguous_samples');
  assert.match(unavailableAccelerationDiagnosis.suggestedNextStep, /at least three contiguous covered samples/i);
  const unavailableAccelerationCheck = undersampledGate.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check =>
    check.property === 'maximumSampledLinearAccelerationStudsPerSecondSquared')!;
  assert.deepEqual(unavailableAccelerationCheck.motionGuidance, unavailableAccelerationDiagnosis,
    'the sparse-evidence check must carry the same guidance as its failure');
  const rapidBezierRecipe = animationSchema.parse({ ...idleRecipe, duration: 0.2, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier',
        curve: { outTime: 0.001, outValue: 0.05, inTime: 0.002, inValue: 0.95 } },
      { time: 0.2, position: [10, 0, 0], rotation: [0, 0, 0] },
    ] }], layers: [], rootMotion: undefined });
  const rapidBezierSpeed = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: rapidBezierRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'rapid-bezier-speed', name: 'Probe rapid eased local motion', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', throughout: { start: 0, end: 0.2, sampleRateHz: 1,
        maxLinearSpeedStudsPerSecond: 1, maxLinearAccelerationStudsPerSecondSquared: 0.1 } }] } }] });
  const rapidBezierSpeedCheck = rapidBezierSpeed.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check => check.property === 'maximumSampledLinearSpeedStudsPerSecond')!;
  assert.equal(rapidBezierSpeedCheck.passed, false, 'interior ease probes must detect fast motion hidden by the coarse endpoint grid');
  const rapidBezierSpeedObserved = rapidBezierSpeedCheck.observed as { from: number; to: number; studsPerSecond: number; intervalCount: number };
  assert.ok(rapidBezierSpeedObserved.studsPerSecond > 1);
  assert.ok(rapidBezierSpeedObserved.to - rapidBezierSpeedObserved.from <= 0.05 + 1e-12,
    'speed diagnostics must use authored-segment interior probes when a speed gate is active');
  const rapidBezierAccelerationCheck = rapidBezierSpeed.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check =>
    check.property === 'maximumSampledLinearAccelerationStudsPerSecondSquared')!;
  assert.equal(rapidBezierAccelerationCheck.passed, false,
    'an authored fast ease must fail a conservative sampled local-acceleration limit');
  assert.ok((rapidBezierAccelerationCheck.observed as { value: number }).value > 0.1);
  const accelerationOnlyGate = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: rapidBezierRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'acceleration-only', name: 'Run an acceleration-only pose gate', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', throughout: { start: 0, end: 0.2, sampleRateHz: 1,
        maxLinearAccelerationStudsPerSecondSquared: 0.1 } }] } }] });
  const accelerationOnlyCheck = accelerationOnlyGate.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check =>
    check.property === 'maximumSampledLinearAccelerationStudsPerSecondSquared');
  assert.equal(accelerationOnlyGate.status, 'failed', 'an acceleration-only assertion must execute without a speed or step limit');
  assert.ok(accelerationOnlyCheck, 'the report must include the acceleration-only check');
  assert.equal(accelerationOnlyCheck.passed, false, 'acceleration-only assertions must fail when the measured acceleration exceeds the limit');
  const accelerationOnlyFailure = accelerationOnlyGate.cases[0]!.failures.find(failure =>
    failure.expectation.endsWith(':maximumLinearAcceleration'))!;
  const accelerationOnlyObserved = accelerationOnlyFailure.observed as { intervalCount: number; sampleCoverage: number;
    intervalMidpointSpacingSeconds: number; blendContext: { currentState: string } };
  const accelerationOnlyDiagnosis = (accelerationOnlyFailure as typeof accelerationOnlyFailure & { motionGuidance: {
    kind: string; suggestedNextStep: string } }).motionGuidance;
  assert.ok(accelerationOnlyObserved.intervalCount > 0);
  assert.ok(accelerationOnlyObserved.sampleCoverage >= 3);
  assert.ok(accelerationOnlyObserved.intervalMidpointSpacingSeconds > 0);
  assert.equal(accelerationOnlyObserved.blendContext.currentState, 'idle',
    'the failure itself must carry the graph context needed to diagnose the motion');
  assert.equal(accelerationOnlyDiagnosis.kind, 'sampled_threshold_exceeded');
  assert.match(accelerationOnlyDiagnosis.suggestedNextStep, /preserve intended contacts and timing.*rerun this gate/i);
  assert.deepEqual(accelerationOnlyCheck.motionGuidance, accelerationOnlyDiagnosis,
    'the composed-pose check and failure surfaces must share identical next-step guidance');
  const abruptHandoffGraph = { ...graph, transitions: graph.transitions.map(transition => ({ ...transition, blendSeconds: 0 })) };
  const abruptHandoff = runAnimationGraphTimelineSuite(abruptHandoffGraph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'abrupt-handoff-step', name: 'Reject an instant local-pose jump', duration: 0.2,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.2, joint: 'UpperTorso',
        throughout: { start: 0, end: 0.2, sampleRateHz: 10, maxLinearStepStuds: 1 } }] } }] });
  const abruptStepCheck = abruptHandoff.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check => check.property === 'maximumSampledLinearStepStuds')!;
  assert.equal(abruptStepCheck.passed, false, 'an instantaneous zero-fade state handoff must fail its local-pose jump limit');
  const abruptStepObserved = abruptStepCheck.observed as { from: number; to: number; studs: number };
  assert.ok(Math.abs(abruptStepObserved.from - (0.1 - 1e-4)) < 1e-12,
    'a pre-event epsilon probe should isolate the step from ordinary motion before the handoff');
  assert.equal(abruptStepObserved.to, 0.1, 'the worst local-pose step should be attributed to the exact transition timestamp');
  assert.ok(abruptStepObserved.studs > 1);
  const narrowKeySpike = animationSchema.parse({ ...idleRecipe, loop: true, duration: 0.1,
    tracks: [...idleRecipe.tracks.filter(track => track.joint !== 'UpperTorso'), { joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.04, position: [10, 0, 0], rotation: [0, 0, 0] },
      { time: 0.04001, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] });
  const keyAwareWindow = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: narrowKeySpike, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'narrow-key-window', name: 'Catch a narrow authored key excursion', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0,
        throughout: { start: 0, end: 0.2, sampleRateHz: 1 } }] } }] });
  const keyAwareCheck = keyAwareWindow.cases[0]!.poseChecks[0]!;
  assert.equal(keyAwareCheck.checks[0]!.passed, true, 'the endpoint itself returns to the expected pose');
  assert.equal(keyAwareCheck.status, 'failed', 'exact authored key-time probes must catch a narrow excursion missed by the 1 Hz window grid');
  const keyAwareObserved = keyAwareCheck.throughoutChecks![0]!.observed as { at: number; errorStuds: number; criticalSampleCount: number };
  assert.equal(keyAwareObserved.at, 0.04);
  assert.ok(keyAwareObserved.errorStuds > 9.99);
  assert.ok(keyAwareObserved.criticalSampleCount >= 4, 'looped authored keys should be probed on each occurrence within the window');
  const bezierOvershoot = animationSchema.parse({ ...idleRecipe, duration: 0.2, loop: false, markers: [], contacts: [], layers: [], rootMotion: undefined,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier',
        curve: { outTime: 0.25, outValue: 2, inTime: 0.75, inValue: 2 } },
      { time: 0.1, position: [1, 0, 0], rotation: [0, 0, 0] },
      { time: 0.2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] });
  const bezierWindow = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: bezierOvershoot, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'bezier-extremum-window', name: 'Probe Bezier extrema', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', expectedPosition: [0.5, 0, 0], positionToleranceStuds: 0.51,
        throughout: { start: 0, end: 0.2, sampleRateHz: 1 } }] } }] });
  const bezierCheck = bezierWindow.cases[0]!.poseChecks[0]!;
  assert.equal(bezierCheck.checks[0]!.passed, true, 'the endpoint remains within the allowed envelope');
  assert.equal(bezierCheck.status, 'failed', 'Bezier overshoot extrema should be probed between authored keys');
  const bezierObserved = bezierCheck.throughoutChecks![0]!.observed as { errorStuds: number; at: number; criticalSampleCount: number };
  assert.ok(bezierObserved.errorStuds > 0.51);
  assert.ok(bezierObserved.at > 0 && bezierObserved.at < 0.1);
  assert.ok(bezierObserved.criticalSampleCount >= 1);
  const elasticOvershoot = animationSchema.parse({ ...bezierOvershoot, tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Elastic' },
    { time: 0.1, position: [1, 0, 0], rotation: [0, 0, 0] },
    { time: 0.2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] });
  const elasticWindow = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: elasticOvershoot, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'elastic-extremum-window', name: 'Probe elastic overshoot', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', expectedPosition: [0.5, 0, 0], positionToleranceStuds: 0.51,
        throughout: { start: 0, end: 0.2, sampleRateHz: 1 } }] } }] });
  const elasticCheck = elasticWindow.cases[0]!.poseChecks[0]!;
  assert.equal(elasticCheck.checks[0]!.passed, true, 'the endpoint remains within the allowed envelope');
  assert.equal(elasticCheck.status, 'failed', 'elastic interior overshoot must be sampled despite the coarse window grid');
  const elasticObserved = elasticCheck.throughoutChecks![0]!.observed as { errorStuds: number; at: number; criticalSampleCount: number };
  assert.ok(elasticObserved.errorStuds > 0.51);
  assert.ok(elasticObserved.at > 0 && elasticObserved.at < 0.1);
  assert.ok(Math.abs(elasticObserved.at - 0.0865) < 0.001, 'analytic Elastic In extrema should land at the actual interior peak, not a nearby coarse probe');
  assert.ok(elasticObserved.criticalSampleCount >= 1);
  const bounceRecipe = animationSchema.parse({ ...bezierOvershoot, tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bounce' },
    { time: 0.1, position: [1, 0, 0], rotation: [0, 0, 0] },
    { time: 0.2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] });
  const bounceWindow = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 },
    { [idle.id]: bounceRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { cases: [{ id: 'bounce-extrema-window', name: 'Sample bounce extrema', duration: 0.2, events: [],
      expect: { poses: [{ at: 0.2, joint: 'UpperTorso', expectedPosition: [0.5, 0, 0], positionToleranceStuds: 0.51,
        throughout: { start: 0, end: 0.2, sampleRateHz: 1 } }] } }] });
  const bounceCheck = bounceWindow.cases[0]!.poseChecks[0]!;
  assert.equal(bounceCheck.status, 'passed');
  assert.ok((bounceCheck.throughoutChecks![0]!.observed as { criticalSampleCount: number }).criticalSampleCount > 1);
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: noTorsoRecipe },
    { duration: 0.3, sampleTimes: [0.2], poseJoints: ['RightHand'] }), /Unknown poseJoints entry/);
});

test('speed-scaled playback samples the correct authored pose and carries that time into native calibration', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const idleSource = animationSchema.parse(idle.recipe);
  const attackSource = animationSchema.parse(attack.recipe);
  const recoverySource = animationSchema.parse(recovery.recipe);
  const idleRecipe = animationSchema.parse({ ...idleSource,
    tracks: idleSource.tracks.filter(track => track.joint !== 'UpperTorso') });
  const attackRecipe = animationSchema.parse({ ...attackSource,
    tracks: attackSource.tracks.filter(track => track.joint === 'UpperTorso').map(track => ({ ...track,
      keys: track.keys.map(key => ({ ...key, position: [key.time / attackSource.duration * 10, 0, 0] as [number, number, number] })) })) });
  const recoveryRecipe = animationSchema.parse({ ...recoverySource,
    tracks: recoverySource.tracks.filter(track => track.joint !== 'UpperTorso') });
  const input = { duration: 0.3, events: [{ at: 0.1, kind: 'trigger' as const, trigger: 'Attack' }],
    sampleTimes: [0.2], poseJoints: ['UpperTorso'] };
  const simulation = simulateAnimationGraphTimeline(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: recoveryRecipe }, input);
  const sample = simulation.composedPoseSamples[0]!;
  const joint = sample.joints[0]!;
  const attackContributor = joint.contributors.find(contributor => contributor.stateId === 'attack')!;
  const attackTrack = simulation.blendSamples.find(candidate => candidate.at === 0.2)!.activeTracks
    .find(track => track.stateId === 'attack')!;
  assert.equal(attackTrack.playbackTimeSeconds, 0.2,
    '0.1 seconds of wall time after the transition must advance a speed-2 clip by 0.2 authored seconds');
  assert.ok(Math.abs(attackContributor.position[0] - 2) < 1e-9,
    'pose sampling must evaluate the speed-scaled authored time, not the wall-clock time');
  assert.ok(Math.abs(joint.position[0] - 1) < 1e-9,
    'native-calibration prediction must include the sampled pose at its effective track weight');

  const suite = runAnimationGraphTimelineSuite(graph,
    { [idle.id]: idleRecipe, [attack.id]: attackRecipe, [recovery.id]: recoveryRecipe },
    { cases: [{ id: 'speed-sample', name: 'Speed-2 pose uses authored time 0.2', duration: 0.3,
      events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.2, joint: 'UpperTorso',
        expectedPosition: [1, 0, 0], positionToleranceStuds: 1e-9 }] } }] },
    { includeStudioCalibrationTrace: true });
  assert.equal(suite.cases[0]!.status, 'passed');
  const calibrationSample = suite.studioCalibrationTrace!.find(candidate => candidate.at === 0.2)!;
  assert.equal(calibrationSample.tracks.find(track => track.stateId === 'attack')!.playbackTimeSeconds, 0.2,
    'native Studio blend calibration must receive the same speed-scaled playback time as the prediction');
  assert.deepEqual(calibrationSample.joints[0]!.predicted.position, joint.position);
});

test('composed pose provenance distinguishes the same source state played by overlapping BlendSpaces', async () => {
  const { idle, attack, recovery } = await fixture();
  const makeBlendRecipe = (recipeInput: unknown, name: string, torsoOffset: number): AnimationRecipe => {
    const recipe = animationSchema.parse(recipeInput);
    return animationSchema.parse({ ...recipe, name, loop: true, priority: 'Movement', markers: [],
      tracks: recipe.tracks.map(track => track.joint !== 'UpperTorso' ? track : ({ ...track,
        keys: track.keys.map(key => ({ ...key, position: [torsoOffset, 0, 0] as [number, number, number] })) })),
    });
  };
  const blendGraph = { kind: 'animation_graph' as const, name: 'Shared Blend source provenance', entryState: 'blendA', sampleRate: 30,
    parameters: [{ name: 'blend', type: 'number' as const, defaultValue: 1, min: 0, max: 1 }],
    states: [
      { id: 'blendA', name: 'Blend A', animationId: idle.id, speed: 1,
        blendSpace1D: { parameter: 'blend', samples: [{ value: 0, stateId: 'blendA' }, { value: 1, stateId: 'shared' }] } },
      { id: 'blendB', name: 'Blend B', animationId: attack.id, speed: 1,
        blendSpace1D: { parameter: 'blend', samples: [{ value: 0, stateId: 'blendB' }, { value: 1, stateId: 'shared' }] } },
      { id: 'shared', name: 'Shared source', animationId: recovery.id, speed: 1 },
    ],
    transitions: [{ id: 'switchBlend', from: 'blendA', to: 'blendB', trigger: 'Switch', blendSeconds: 0.4 }],
  };
  const recipes = {
    [idle.id]: makeBlendRecipe(idle.recipe, 'Blend A clip', 0),
    [attack.id]: makeBlendRecipe(attack.recipe, 'Blend B clip', 3),
    [recovery.id]: makeBlendRecipe(recovery.recipe, 'Shared blend clip', 8),
  };
  const report = simulateAnimationGraphTimeline(blendGraph, recipes, {
    duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Switch' }],
    sampleTimes: [0.3], poseJoints: ['UpperTorso'],
  });
  const sample = report.composedPoseSamples[0]!.joints[0]!;
  const sharedContributors = sample.contributors.filter(contributor => contributor.stateId === 'shared');
  assert.deepEqual(sharedContributors.map(contributor => contributor.blendControllerStateId), ['blendA', 'blendB'],
  'same-state source tracks must remain separate and identify the BlendSpace controller that owns each playback channel');
  assert.ok(sharedContributors.every(contributor => Math.abs(contributor.trackWeight - 0.5) < 1e-12
    && Math.abs(contributor.effectiveWeight - 0.5) < 1e-12));
  assert.ok(Math.abs(sample.position[0] - 8) < 1e-12,
    'adding source-channel provenance must not change the existing weighted pose result');
  const diagnosed = runAnimationGraphTimelineSuite(blendGraph, recipes, { cases: [{ id: 'shared-source',
    name: 'Keep overlapping blend-source ownership in pose diagnosis', duration: 0.3,
    events: [{ at: 0.1, kind: 'trigger', trigger: 'Switch' }],
    expect: { poses: [{ at: 0.3, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0.01 }] },
  }] }, { includeStudioCalibrationTrace: true });
  const dominant = diagnosed.cases[0]!.poseChecks[0]!.diagnosis!.dominantContributors;
  assert.deepEqual(dominant.map(contributor => contributor.blendControllerStateId), ['blendA', 'blendB'],
    'AI-readable pose failure diagnosis must preserve each shared source channel owner');
  assert.deepEqual(diagnosed.cases[0]!.failures[0]!.diagnosis!.positionErrorAttribution!.contributors
    .map(contributor => [contributor.stateId, contributor.blendControllerStateId]),
  [['shared', 'blendA'], ['shared', 'blendB']],
  'position-error attribution must retain distinct source-channel ownership when state IDs are shared');
  assert.deepEqual(diagnosed.studioCalibrationTrace![0]!.joints[0]!.simulatedContributors
    .filter(contributor => contributor.stateId === 'shared').map(contributor => contributor.blendControllerStateId), ['blendA', 'blendB'],
  'Studio calibration evidence must pin the same controller-qualified contributor identities as pose prediction');
});

test('dense interrupted priority fades conserve the per-joint pose budget at every requested sample', async () => {
  const { idle, attack, recovery } = await fixture();
  const states = [
    { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
    { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
    { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    { id: 'finish', name: 'Finish', animationId: idle.id, speed: 1 },
  ];
  const graph = { kind: 'animation_graph' as const, name: 'Interrupted priority budget', entryState: 'idle', sampleRate: 30,
    states, transitions: [
      { id: 'toAttack', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.4 },
      { id: 'toRecovery', from: 'attack', to: 'recovery', trigger: 'Recover', blendSeconds: 0.35 },
      { id: 'toFinish', from: 'recovery', to: 'finish', trigger: 'Finish', blendSeconds: 0.3 },
    ] };
  const withPose = (recipe: AnimationRecipe, priority: NonNullable<AnimationRecipe['priority']>, offset: number) => ({
    ...recipe, loop: true, priority,
    tracks: recipe.tracks.filter(track => track.joint === 'UpperTorso').map(track => ({ ...track,
      keys: track.keys.map(key => ({ ...key, position: [offset, 0, 0] as [number, number, number] })) })),
  });
  const recipes = {
    [idle.id]: withPose(animationSchema.parse(idle.recipe), 'Core', 1),
    [attack.id]: withPose(animationSchema.parse(attack.recipe), 'Movement', 2),
    [recovery.id]: withPose(animationSchema.parse(recovery.recipe), 'Action', 3),
  };
  const sampleTimes = Array.from({ length: 13 }, (_, index) => index / 20);
  const result = simulateAnimationGraphTimeline(graph, recipes, {
    duration: 0.6,
    events: [
      { at: 0, kind: 'trigger', trigger: 'Attack' },
      { at: 0.1, kind: 'trigger', trigger: 'Recover' },
      { at: 0.2, kind: 'trigger', trigger: 'Finish' },
    ],
    sampleTimes,
    poseJoints: ['UpperTorso'],
  });
  assert.deepEqual(result.transitionIds, ['toAttack', 'toRecovery', 'toFinish']);
  assert.equal(result.composedPoseSamples.length, sampleTimes.length);
  for (const sample of result.composedPoseSamples) {
    const joint = sample.joints[0]!;
    const contributionTotal = joint.contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, 0);
    assert.ok(Math.abs(contributionTotal + joint.residualWeight - 1) < 1e-12,
      `pose budget must sum to one at ${sample.at}s: ${contributionTotal} + ${joint.residualWeight}`);
    assert.ok(Math.abs(joint.rotationInfluence + joint.residualWeight - 1) < 1e-12,
      `rotation influence and neutral local animation delta must conserve the budget at ${sample.at}s`);
    assert.ok(joint.priorityLayers.every((layer, index) => Math.abs(layer.availableWeightBefore
      - (index === 0 ? 1 : joint.priorityLayers[index - 1]!.remainingWeightAfter)) < 1e-12),
    `priority layer budgets must flow continuously at ${sample.at}s`);
    assert.ok(joint.priorityLayers.every(layer => Math.abs(layer.availableWeightBefore
      - layer.effectiveBudget - layer.remainingWeightAfter) < 1e-12),
    `priority layer must conserve its available budget at ${sample.at}s`);
    assert.ok(joint.position.every(Number.isFinite));
    assert.ok(joint.rotationQuaternion.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...joint.rotationQuaternion) - 1) < 1e-10,
      `composed quaternion must remain normalized at ${sample.at}s`);
  }
});

test('interrupted blends conserve pose weight across all seven Roblox animation priorities', async () => {
  const { idle } = await fixture();
  const priorities = ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'] as const;
  const animationIds = priorities.map((_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const states = priorities.map((priority, index) => ({ id: `state${index}`, name: priority, animationId: animationIds[index]!, speed: 1 }));
  const graph = { kind: 'animation_graph' as const, name: 'Full priority stack', entryState: 'state0', sampleRate: 30,
    states, transitions: priorities.slice(1).map((_, index) => ({ id: `advance${index + 1}`,
      from: `state${index}`, to: `state${index + 1}`, trigger: `Advance${index + 1}`, blendSeconds: 0.5 })) };
  const baseRecipe = { ...animationSchema.parse(idle.recipe), loop: true,
    tracks: animationSchema.parse(idle.recipe).tracks.filter(track => track.joint === 'UpperTorso') };
  const recipes: Record<string, AnimationRecipe> = Object.fromEntries(priorities.map((priority, index) =>
    [animationIds[index]!, { ...baseRecipe, priority }]));
  const events = priorities.slice(1).map((_, index) => ({ at: (index + 1) / 20,
    kind: 'trigger' as const, trigger: `Advance${index + 1}` }));
  const report = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.4, events, sampleTimes: [0.35], poseJoints: ['UpperTorso'] });
  assert.deepEqual(report.transitionIds, priorities.slice(1).map((_, index) => `advance${index + 1}`));
  const pose = report.composedPoseSamples[0]!.joints[0]!;
  assert.deepEqual(pose.priorityLayers.map(layer => layer.priority), [...priorities].reverse(),
    'all seven priority layers must be composed from highest to lowest');
  assert.equal(pose.contributors.length, priorities.length, 'all seven still-playing tracks should be represented');
  assert.ok(pose.priorityLayers.every(layer => layer.effectiveBudget >= 0 && layer.effectiveBudget <= layer.availableWeightBefore
    && Math.abs(layer.availableWeightBefore - layer.effectiveBudget - layer.remainingWeightAfter) < 1e-12));
  assert.ok(Math.abs(pose.contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, pose.residualWeight) - 1) < 1e-12,
    'the effective track contributions and neutral local animation delta must account for the complete joint pose');
  assert.ok(Math.abs(pose.rotationInfluence + pose.residualWeight - 1) < 1e-12);
});

test('pose samples explain base, ordered layers, and root-motion composition for every contributing state', async () => {
  const { idle, attack, recovery } = await fixture();
  const graph = { kind: 'animation_graph' as const, name: 'Composition provenance', entryState: 'idle', sampleRate: 30,
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [{ id: 'beginAttack', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0 }],
  };
  const constantTrack = (joint: string, positionX: number) => ({ joint, keys: [0, 1].map(time => ({
    time, position: [positionX, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  })) });
  const attackRecipe = animationSchema.parse(attack.recipe);
  const layeredAttack = animationSchema.parse({ ...attackRecipe, duration: 1, loop: false,
    tracks: [constantTrack('HumanoidRootPart', 1), ...attackRecipe.tracks.filter(track => track.joint !== 'HumanoidRootPart')],
    layers: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Follow through', blendMode: 'Additive', weight: 0.5, enabled: true,
        tracks: [constantTrack('HumanoidRootPart', 2)] },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Disabled accent', blendMode: 'Override', weight: 1, enabled: false,
        tracks: [constantTrack('HumanoidRootPart', 90)] },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Polish', blendMode: 'Override', weight: 0.25, enabled: true,
        tracks: [constantTrack('HumanoidRootPart', 6)] },
    ], rootMotion: constantTrack('HumanoidRootPart', 4) });
  const noRootTrack = (recipe: AnimationRecipe) => ({ ...recipe,
    tracks: recipe.tracks.filter(track => track.joint !== 'HumanoidRootPart'),
    layers: [], rootMotion: undefined });
  const report = simulateAnimationGraphTimeline(graph,
    { [idle.id]: noRootTrack(animationSchema.parse(idle.recipe)), [attack.id]: layeredAttack,
      [recovery.id]: noRootTrack(animationSchema.parse(recovery.recipe)) },
    { duration: 0.1, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0], poseJoints: ['HumanoidRootPart'] });
  const joint = report.composedPoseSamples[0]!.joints[0]!;
  const attackContribution = joint.contributors.find(contributor => contributor.stateId === 'attack')!;
  assert.ok(Math.abs(attackContribution.position[0] - 7) < 1e-12,
    'base 1 + half-weight additive 2 + quarter-weight override 6 + root motion 4 composes to local X=7');
  assert.deepEqual(attackContribution.recipeComposition.map(source => [source.kind, source.layerName ?? null,
    source.blendMode ?? null, source.weight, source.applied, source.position[0], source.beforePosition[0], source.afterPosition[0]]), [
    ['base', null, null, 1, true, 1, 0, 1], ['layer', 'Follow through', 'Additive', 0.5, true, 2, 1, 2],
    ['layer', 'Disabled accent', 'Override', 1, false, 90, 2, 2], ['layer', 'Polish', 'Override', 0.25, true, 6, 2, 3],
    ['root_motion', null, null, 1, true, 4, 3, 7],
  ]);
  assert.equal(attackContribution.effectiveWeight, 1);
});

test('blend samples preserve close requested timestamps and timeline assertions bind to exact times', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const recipes = { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe };
  const firstAt = 0.0000001, secondAt = 0.0000004;
  const direct = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.01, sampleTimes: [firstAt, secondAt], poseJoints: ['UpperTorso'] });
  assert.ok(direct.blendSamples.some(sample => sample.at === firstAt));
  assert.ok(direct.blendSamples.some(sample => sample.at === secondAt));
  assert.notEqual(direct.blendSamples.find(sample => sample.at === firstAt)?.at,
    direct.blendSamples.find(sample => sample.at === secondAt)?.at);
  assert.equal(direct.blendSamples.find(sample => sample.at === firstAt)?.activeTracks[0]?.playbackTimeSeconds, firstAt);
  assert.equal(direct.blendSamples.find(sample => sample.at === secondAt)?.activeTracks[0]?.playbackTimeSeconds, secondAt);
  assert.deepEqual(direct.composedPoseSamples.map(sample => sample.at), [firstAt, secondAt],
    'direct sample indexing must retain distinct close timestamps in composed-pose output');
  assert.deepEqual(direct.composedPoseSamples.map(sample => sample.joints[0]?.joint), ['UpperTorso', 'UpperTorso']);

  const frameTime = 1 / 30;
  const frameAligned = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.1, sampleTimes: [frameTime],
    events: [{ at: frameTime, kind: 'trigger', trigger: 'Noop' }], poseJoints: ['UpperTorso'], includeBlendSamplePoses: true });
  assert.deepEqual(frameAligned.blendSamples.filter(sample => Math.abs(sample.at - frameTime) < 1e-9).map(sample => sample.at),
    [frameTime], 'an event, explicit sample, and uniform 30 Hz frame at one instant must share one observation timestamp');
  assert.equal(frameAligned.composedPoseSamples.filter(sample => Math.abs(sample.at - frameTime) < 1e-9).length, 1,
    'pose composition must not duplicate the same frame because its event clock used a different floating representation');

  const nearbyEventAt = 0.5 + Number.EPSILON;
  const nearerSampleAt = 0.5 + Number.EPSILON / 2;
  const fartherSampleAt = 0.5 + Number.EPSILON * 2;
  const nearTie = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.6,
    sampleTimes: [fartherSampleAt, nearerSampleAt], events: [{ at: nearbyEventAt, kind: 'trigger', trigger: 'Noop' }] });
  assert.equal(nearTie.timeline.find(event => event.trigger === 'Noop')?.at, nearerSampleAt,
    'event time normalization must bind to the closest nearby requested sample, not the first inserted sample');
  assert.ok(nearTie.blendSamples.some(sample => sample.at === nearerSampleAt));
  assert.ok(nearTie.blendSamples.some(sample => sample.at === fartherSampleAt));

  const earlierTieAt = 0.5 - Number.EPSILON;
  const laterTieAt = 0.5 + Number.EPSILON;
  const exactTie = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.6,
    sampleTimes: [laterTieAt, earlierTieAt], events: [{ at: 0.5, kind: 'trigger', trigger: 'Noop' }] });
  assert.equal(exactTie.timeline.find(event => event.trigger === 'Noop')?.at, earlierTieAt,
    'equidistant nearby samples must use the documented earlier-timestamp tie break');

  const report = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ id: 'precise', name: 'Precise blend sample binding', duration: 0.01,
    events: [], expect: { blends: [
      { at: firstAt, stateId: 'idle', playbackTimeSeconds: { min: firstAt, max: firstAt } },
      { at: secondAt, stateId: 'idle', playbackTimeSeconds: { min: secondAt, max: secondAt } },
    ] } }] });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.cases[0]!.blendChecks.map(check => check.track?.playbackTimeSeconds), [firstAt, secondAt]);
});

test('timeline trigger records explain selected, rejected and shadowed guard branches', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const diagnosticGraph = { ...graph, parameters: [{ name: 'armed', type: 'boolean' as const, defaultValue: false }], transitions: [
    { id: 'preferred', from: 'idle', to: 'attack', trigger: 'Choose', priority: 10, blendSeconds: 0.1,
      guards: [{ parameter: 'armed', operator: 'eq' as const, value: true }] },
    { id: 'fallback', from: 'idle', to: 'recovery', trigger: 'Choose', priority: 0, blendSeconds: 0.1, guards: [] },
    { id: 'shadowed', from: 'idle', to: 'attack', trigger: 'Choose', priority: -10, blendSeconds: 0.1, guards: [] },
  ] };
  const report = simulateAnimationGraphTimeline(diagnosticGraph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 0.1, events: [{ at: 0, kind: 'trigger', trigger: 'Choose' }],
  });
  const event = report.timeline.find(item => item.transitionId === 'fallback')!;
  assert.equal(event.stateAfter, 'recovery');
  assert.deepEqual(event.guardEvaluation, {
    detailStatus: 'complete',
    selectedTransition: { id: 'fallback', from: 'idle', to: 'recovery', priority: 0, blendSeconds: 0.1,
      selectionReason: 'highest-priority branch whose guards all matched', checks: [] },
    matchedTransitionIds: ['fallback', 'shadowed'], shadowedTransitionIds: ['shadowed'],
    rejectedBranches: [{ transitionId: 'preferred', failedGuards: [{ parameter: 'armed', operator: 'eq', value: true, observed: false, matched: false }] }],
  });
  assert.deepEqual(report.decisionDiagnostics, { detailedTriggerEvaluations: 1, truncatedTriggerEvaluations: 0,
    detailedBytes: report.decisionDiagnostics.detailedBytes, maxDetailedBytes: 512 * 1024 });
  assert.ok(report.decisionDiagnostics.detailedBytes > 0);
});

test('timeline guard diagnostics stay within a deterministic output budget', async () => {
  const { idle } = await fixture();
  const transitions = Array.from({ length: 128 }, (_, index) => ({ id: `branch${index}`, from: 'idle', to: 'idle',
    trigger: 'Repeat', priority: 127 - index, blendSeconds: 0, guards: [] }));
  const oneStateGraph = { kind: 'animation_graph' as const, name: 'Diagnostic budget', entryState: 'idle', sampleRate: 15,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions };
  const report = simulateAnimationGraphTimeline(oneStateGraph, { [idle.id]: idle.recipe }, { duration: 0.01,
    events: Array.from({ length: 512 }, (_, index) => ({ at: 0, kind: 'trigger' as const, trigger: 'Repeat', expectTransitionId: 'branch0' })) });
  assert.ok(report.decisionDiagnostics.detailedBytes <= report.decisionDiagnostics.maxDetailedBytes);
  assert.ok(report.decisionDiagnostics.detailedTriggerEvaluations > 0);
  assert.ok(report.decisionDiagnostics.truncatedTriggerEvaluations > 0);
  const detailed = report.timeline.find(event => (event.guardEvaluation as { detailStatus: string }).detailStatus === 'complete');
  const truncated = report.timeline.find(event => (event.guardEvaluation as { detailStatus: string }).detailStatus === 'truncated_output_budget');
  assert.ok(detailed);
  assert.ok(truncated);
  assert.equal((truncated!.guardEvaluation as { selectedTransitionId: string }).selectedTransitionId, 'branch0');
});

test('timeline simulation rebases a revisited destination fade from its current track weight', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const returnGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'returnDuringFade', from: 'attack', to: 'idle', trigger: 'Return', blendSeconds: 0.3,
  }] };
  const simulated = simulateAnimationGraphTimeline(returnGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.5, events: [
      { at: 0, kind: 'trigger', trigger: 'Attack' },
      { at: 0.1, kind: 'trigger', trigger: 'Return', expectTransitionId: 'returnDuringFade' },
    ] });
  const transition = simulated.timeline.find(event => event.transitionId === 'returnDuringFade')!;
  assert.equal(transition.destinationWeightAtTransition, 0.5);
  assert.equal(transition.destinationFadeStartWeight, 0.5);
  const sample = simulated.blendSamples.find(item => item.at === 0.2)!;
  assert.equal(sample.currentState, 'idle');
  assert.deepEqual(sample.activeTracks.map(track => [track.stateId, track.weight]), [
    ['attack', 0.33333333333333337], ['idle', 0.6666666666666666],
  ]);
  assert.equal(sample.activeTracks.find(track => track.stateId === 'idle')?.playbackTimeSeconds, 0.1,
    're-entering a cached destination begins a new modeled playback epoch');
  assert.equal(simulated.trackLifecycles.find(track => track.stateId === 'idle')?.playbackCount, 2);
  assert.match(simulated.limitation, /repeated-Play probe.*restart assumption/i);
});

test('transition playback diagnostics account for a BlendSpace destination epoch that started from a nonzero phase', async () => {
  const f = await fixture();
  try {
    const controllerRecipe = animationSchema.parse({ ...f.idle.recipe, loop: false, priority: 'Movement', markers: [] });
    const sourceRecipe = animationSchema.parse({ ...f.attack.recipe, loop: false, priority: 'Movement', markers: [] });
    const graph = { kind: 'animation_graph' as const, name: 'Retargeted phase clock', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
      states: [
        { id: 'blend', name: 'Blend Controller', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'blend' }, { value: 10, stateId: 'source' }] } },
        { id: 'source', name: 'One-shot Source', animationId: f.attack.id, speed: 1 },
      ],
      transitions: [{ id: 'enterSource', from: 'blend', to: 'source', trigger: 'Enter', blendSeconds: 0.1 }],
    };
    const identity = 'e'.repeat(64);
    const result = simulateAnimationGraphTimeline(graph, { [f.idle.id]: controllerRecipe, [f.attack.id]: sourceRecipe }, {
      duration: 2.1,
      events: [
        { at: 1.5, kind: 'set_parameters', values: { speed: 10 } },
        { at: 2.1, kind: 'trigger', trigger: 'Enter' },
      ],
      observedBlendAnimationLengths: { blend: { blend: 2, source: 1 } },
      observedBlendAnimationPlaybackSpeeds: { blend: { blend: 1, source: 1 } },
      observedBlendAnimationAssetSetFingerprint: identity,
      expectedBlendAnimationAssetSetFingerprint: identity,
    });
    const transition = result.timeline.find(event => event.transitionId === 'enterSource')!;
    assert.equal(transition.playbackClockDecision, 'new_or_stopped_track',
      'the destination started at phase 0.75 and finished before the transition, even though elapsed wall time is less than its full duration');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('self-transitions preserve current track weight and reset the modeled playback clock', async () => {
  const { idle, attack, recovery } = await fixture();
  const selfRestartGraph = { kind: 'animation_graph' as const, name: 'Self restart', entryState: 'idle', sampleRate: 30,
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [{ id: 'restartIdle', from: 'idle', to: 'idle', trigger: 'Restart', blendSeconds: 0.3 }],
  };
  const simulated = simulateAnimationGraphTimeline(selfRestartGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.4, events: [{ at: 0.1, kind: 'trigger', trigger: 'Restart' }], sampleTimes: [0.1, 0.2] });
  const transition = simulated.timeline.find(event => event.transitionId === 'restartIdle')!;
  assert.equal(transition.sourceWeightAtTransition, 1);
  assert.equal(transition.destinationWeightAtTransition, 1);
  assert.equal(transition.destinationFadeStartWeight, 1);
  const restartSample = simulated.blendSamples.find(sample => sample.at === 0.2)!;
  const track = restartSample.activeTracks.find(candidate => candidate.stateId === 'idle')!;
  assert.equal(track.weight, 1,
    'a self-transition that targets the already-current full weight must not invent a fade from zero');
  assert.equal(track.targetWeight, 1);
  assert.equal(track.playbackTimeSeconds, 0.1,
    'a repeated Play call on an already-playing track begins a new playback epoch');
  assert.equal(simulated.trackLifecycles.find(item => item.stateId === 'idle')?.playbackCount, 2);
  assert.equal(simulated.trackLifecycles.find(item => item.stateId === 'idle')?.latestEndReason, null,
    'the latest epoch has no end reason while the restarted track is playing');
  assert.equal(transition.playbackClockDecision, 'unmeasured_assumed_reset');
  assert.equal(simulated.playbackRetriggerModel.unmeasuredAssumedResetTransitions, 1);
});

test('timeline simulation follows a matching Studio probe when Play preserves an already-playing track clock', async () => {
  const { idle, attack, recovery } = await fixture();
  const selfRestartGraph = { kind: 'animation_graph' as const, name: 'Calibrated self transition', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }],
    transitions: [{ id: 'restartIdle', from: 'idle', to: 'idle', trigger: 'Restart', blendSeconds: 0.3 }],
  };
  const fadeProfile = { id: '00000000-0000-4000-8000-000000000031', stateId: 'idle', recipeFingerprint: fingerprint(idle.recipe),
    profileFingerprint: 'a'.repeat(64), fadeSeconds: 0.3,
    playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.3, weightCurrent: 1, weightTarget: 1 }],
    stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.3, weightCurrent: 0, weightTarget: 0 }],
    playRetrigger: { probeElapsedSeconds: 0.05, timePositionBefore: 0.05, timePositionImmediatelyAfter: 0.05,
      timePositionAfterStep: 0.1, weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1,
      observedClockBehavior: 'preserved' as const } };
  const simulated = simulateAnimationGraphTimeline(selfRestartGraph,
    { [idle.id]: idle.recipe },
    { duration: 0.4, events: [{ at: 0.1, kind: 'trigger', trigger: 'Restart' }], sampleTimes: [0.1, 0.2] }, [fadeProfile]);
  const transition = simulated.timeline.find(event => event.transitionId === 'restartIdle')!;
  assert.equal(transition.playbackClockDecision, 'studio_observed_preserved');
  assert.equal(simulated.blendSamples.find(sample => sample.at === 0.2)!.activeTracks[0]!.playbackTimeSeconds, 0.2);
  assert.equal(simulated.trackLifecycles.find(track => track.stateId === 'idle')!.playbackCount, 1);
  assert.equal(simulated.playbackRetriggerModel.measuredPreservedClockTransitions, 1);
  assert.equal(simulated.playbackRetriggerModel.unmeasuredAssumedResetTransitions, 0);
  const suiteReport = runAnimationGraphTimelineSuite(selfRestartGraph, { [idle.id]: idle.recipe }, { cases: [{
    id: 'measured-retrigger', name: 'Measured repeated Play', duration: 0.4,
    events: [{ at: 0.1, kind: 'trigger', trigger: 'Restart' }],
    expect: { transitionIds: { mode: 'exact', ids: ['restartIdle'] },
      playbackClock: [{ transitionId: 'restartIdle', decision: 'studio_observed_preserved' }] },
  }] }, { fadeProfiles: [fadeProfile] });
  assert.equal(suiteReport.playbackRetriggerModel.measuredPreservedClockTransitions, 1);
  assert.equal(suiteReport.cases[0]!.playbackRetriggerModel.measuredPreservedClockTransitions, 1);
  assert.equal((suiteReport.cases[0]!.timeline[0] as { playbackClockDecision: string }).playbackClockDecision, 'studio_observed_preserved');
  assert.deepEqual(suiteReport.cases[0]!.playbackClockChecks, [{ transitionId: 'restartIdle', occurrence: 1,
    status: 'passed', expected: 'studio_observed_preserved', observed: 'studio_observed_preserved', failureReason: null,
    observedTransitionOccurrences: 1 }]);
  const rejectedSuite = runAnimationGraphTimelineSuite(selfRestartGraph, { [idle.id]: idle.recipe }, { cases: [{
    id: 'unexpected-retrigger', name: 'Changed repeated Play behavior', duration: 0.4,
    events: [{ at: 0.1, kind: 'trigger', trigger: 'Restart' }],
    expect: { playbackClock: [{ transitionId: 'restartIdle', decision: 'studio_observed_reset' }] },
  }] }, { fadeProfiles: [fadeProfile] });
  assert.equal(rejectedSuite.status, 'failed');
  assert.ok(rejectedSuite.cases[0]!.failures.some(failure => failure.expectation === 'playbackClock:restartIdle#1'));
  assert.equal(rejectedSuite.cases[0]!.playbackClockChecks[0]?.failureReason, 'playback_clock_decision_mismatch');
  assert.equal(rejectedSuite.cases[0]!.playbackClockChecks[0]?.observedTransitionOccurrences, 1);
  const missingTransitionSuite = runAnimationGraphTimelineSuite(selfRestartGraph, { [idle.id]: idle.recipe }, { cases: [{
    id: 'missing-retrigger', name: 'Transition path never retriggers', duration: 0.4, events: [],
    expect: { playbackClock: [{ transitionId: 'restartIdle', decision: 'studio_observed_preserved' }] },
  }] }, { fadeProfiles: [fadeProfile] });
  assert.equal(missingTransitionSuite.cases[0]!.playbackClockChecks[0]?.failureReason, 'transition_occurrence_not_observed');
  assert.equal(missingTransitionSuite.cases[0]!.playbackClockChecks[0]?.observedTransitionOccurrences, 0);
});

test('timeline simulation invalidates old playback callbacks when a state track is revisited', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, markers: [{ name: 'OldIdleMarker', time: 0.5 }] };
  const revisitGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'returnDuringPlayback', from: 'attack', to: 'idle', trigger: 'Return', blendSeconds: 0.1,
  }] };
  const simulated = simulateAnimationGraphTimeline(revisitGraph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.7, events: [
      { at: 0, kind: 'trigger', trigger: 'Attack' },
      { at: 0.3, kind: 'trigger', trigger: 'Return' },
    ] });

  assert.deepEqual(simulated.transitionIds, ['beginAttack', 'returnDuringPlayback']);
  assert.equal(simulated.triggeredMarkers.some(marker => marker.marker === 'OldIdleMarker'), false,
    'the first idle epoch was stopped before its marker; re-entry must not revive its stale callback');
});

test('timeline simulation does not let an earlier one-shot completion end a restarted same-state playback', async () => {
  const { attack, recovery } = await fixture();
  const oneShot = { ...attack.recipe, markers: [] };
  const graph = {
    kind: 'animation_graph' as const, name: 'Restarted one-shot', entryState: 'attack', sampleRate: 30,
    states: [
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [
      { id: 'restart', from: 'attack', to: 'attack', trigger: 'Restart', blendSeconds: 0.1 },
      { id: 'finish', from: 'attack', to: 'recovery', trigger: 'AnimationEnded', blendSeconds: 0.1 },
    ],
  };
  const simulated = simulateAnimationGraphTimeline(graph, { [attack.id]: oneShot, [recovery.id]: recovery.recipe }, {
    duration: 1.2, events: [{ at: 0.5, kind: 'trigger', trigger: 'Restart' }],
  });

  assert.deepEqual(simulated.transitionIds, ['restart']);
  assert.equal(simulated.finalState, 'attack', 'the original epoch’s end at t=1 must not transition the restarted track');
});

test('timeline simulation sorts timestamped inputs but keeps input order for simultaneous triggers', async () => {
  const { idle, attack, recovery } = await fixture();
  const graph = {
    kind: 'animation_graph' as const, name: 'Ordered triggers', entryState: 'idle', sampleRate: 30,
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [
      { id: 'begin', from: 'idle', to: 'attack', trigger: 'Begin', blendSeconds: 0.1 },
      { id: 'finish', from: 'attack', to: 'recovery', trigger: 'Finish', blendSeconds: 0.1 },
    ],
  };
  const recipes = { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe };
  const chronologicallySorted = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.5, events: [
    { at: 0.2, kind: 'trigger', trigger: 'Finish' },
    { at: 0, kind: 'trigger', trigger: 'Begin' },
  ] });
  assert.deepEqual(chronologicallySorted.transitionIds, ['begin', 'finish']);

  const closeButDistinct = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.7, events: [
    { at: 0.5 + 1e-13, kind: 'trigger', trigger: 'Finish' },
    { at: 0.5, kind: 'trigger', trigger: 'Begin' },
  ] });
  assert.deepEqual(closeButDistinct.transitionIds, ['begin', 'finish'],
    'distinct inputs within one picosecond must remain chronologically ordered rather than collapse into an authored-order tie');

  const simultaneous = simulateAnimationGraphTimeline(graph, recipes, { duration: 0.1, events: [
    { at: 0, kind: 'trigger', trigger: 'Begin' },
    { at: 0, kind: 'trigger', trigger: 'Finish' },
  ] });
  assert.deepEqual(simultaneous.transitionIds, ['begin', 'finish']);
  assert.deepEqual(simultaneous.timeline.map(event => event.inputIndex), [0, 1]);
});

test('timeline simulation reports exact external-input and runtime-marker ordering collisions', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, markers: [{ name: 'Rest', time: 0.2 }] };
  const simulated = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.4, events: [{ at: 0.2, kind: 'trigger', trigger: 'Attack' }] });

  assert.equal(simulated.finalState, 'attack');
  assert.equal(simulated.triggeredMarkers.length, 0, 'the external transition makes the old-state marker stale');
  assert.deepEqual(simulated.eventOrderingDiagnostics, {
    policy: 'user inputs are processed before runtime marker/AnimationEnded and modeled natural-completion fade-start events at the same timestamp; user inputs retain authored order; Roblox runtime callback ordering is not guaranteed',
    ambiguousCollisionCount: 1,
    detailedCollisionCount: 1,
    truncatedCollisionCount: 0,
    collisions: [{ at: 0.2, eventCount: 2, externalInputIndices: [0],
      runtimeEvents: [{ kind: 'marker', stateId: 'idle', marker: 'Rest' }] }],
  });

  const fractionalMarker = animationSchema.parse({ ...animationPreset('idle', 'Fractional marker', 0.1, 0.05),
    markers: [{ name: 'FractionalImpact', time: 0.0619 }] });
  const fractionalCollision = simulateAnimationGraphTimeline(graph,
    { [idle.id]: fractionalMarker, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.1, events: [{ at: 0.0619, kind: 'trigger', trigger: 'Attack' }] });
  assert.deepEqual(fractionalCollision.eventOrderingDiagnostics.collisions, [{ at: 0.0619, eventCount: 2,
    externalInputIndices: [0], runtimeEvents: [{ kind: 'marker', stateId: 'idle', marker: 'FractionalImpact' }] }],
  'phase-to-seconds floating-point roundoff must not hide a marker/input tie at the same authored time');

  assert.throws(() => animationGraphEventOrderingDiagnosticsSchema.parse({ ...simulated.eventOrderingDiagnostics,
    ambiguousCollisionCount: 0 }), /counts must agree/i);
  assert.throws(() => animationGraphEventOrderingDiagnosticsSchema.parse({ ...simulated.eventOrderingDiagnostics,
    collisions: [{ ...simulated.eventOrderingDiagnostics.collisions[0]!, eventCount: 3 }] }), /eventCount must equal/i);
  assert.throws(() => animationGraphTimelineCaseReportSchema.parse({ id: 'invalid-report', status: 'passed',
    eventOrderingDiagnostics: simulated.eventOrderingDiagnostics, animationEndedTiming: simulated.animationEndedTiming,
    eventOrderingCheck: { status: 'passed', maximumAllowedCollisions: 0, observedCollisions: 0 } }), /gate status and observation/i);

  const sensitivity = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.4, events: [{ at: 0.2, kind: 'trigger', trigger: 'Attack' }], analyzeEventOrderSensitivity: true,
      maxEventOrderDivergences: 0 });
  assert.ok(sensitivity.eventOrderSensitivity);
  assert.equal(sensitivity.eventOrderSensitivity.status, 'divergent');
  assert.equal(sensitivity.eventOrderSensitivity.finalStateChanged, false);
  assert.equal(sensitivity.eventOrderSensitivity.markerEventsChanged, true,
    'runtime-first ordering fires the old-state marker before the same-time user transition');
  const firstTimelineDifference = sensitivity.eventOrderSensitivity.firstTimelineDifference;
  assert.ok(firstTimelineDifference);
  assert.equal((firstTimelineDifference.baseline as { event: string } | null)?.event, 'trigger');
  assert.equal((firstTimelineDifference.alternate as { event: string } | null)?.event, 'marker');
  assert.deepEqual(sensitivity.eventOrderSensitivity.gate, { status: 'failed', maximumAllowedDivergences: 0,
    observedDivergences: 2, sampleComparisonComplete: true });
  assert.match(sensitivity.eventOrderSensitivity.limitation, /does not reproduce or predict Roblox callback ordering/i);
  assert.throws(() => animationGraphSimulationInputSchema.parse({ duration: 0.4, maxEventOrderDivergences: 0 }), /requires analyzeEventOrderSensitivity=true/i);

  const competingGraph = { ...graph, transitions: [
    { id: 'markerAttack', from: 'idle', to: 'attack', trigger: 'Rest', blendSeconds: 0.1 },
    { id: 'userRecovery', from: 'idle', to: 'recovery', trigger: 'Skip', blendSeconds: 0.1 },
  ] };
  const competing = simulateAnimationGraphTimeline(competingGraph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, events: [{ at: 0.2, kind: 'trigger', trigger: 'Skip' }], analyzeEventOrderSensitivity: true,
      maxEventOrderDivergences: 0 });
  assert.ok(competing.eventOrderSensitivity);
  assert.equal(competing.eventOrderSensitivity.status, 'divergent');
  assert.equal(competing.eventOrderSensitivity.finalStateChanged, true);
  assert.equal(competing.eventOrderSensitivity.gate?.status, 'failed');
  assert.equal(competing.finalState, 'recovery');
  assert.equal(competing.eventOrderSensitivity.alternateOutcome.finalState, 'attack');

  const markedAttack = { ...attack.recipe, markers: [{ name: 'ImpactFollowThrough', time: 0.15 }] };
  const offGridCoverage = simulateAnimationGraphTimeline(competingGraph,
    { [idle.id]: markedIdle, [attack.id]: markedAttack, [recovery.id]: recovery.recipe },
    { duration: 0.5, events: [{ at: 0.2, kind: 'trigger', trigger: 'Skip' }], analyzeEventOrderSensitivity: true,
      maxEventOrderDivergences: 0, poseJoints: ['UpperTorso'], includeBlendSamplePoses: true });
  assert.ok(offGridCoverage.eventOrderSensitivity);
  assert.equal(offGridCoverage.eventOrderSensitivity.sampleComparisonScope, 'exact_shared_timestamps_only');
  assert.equal(offGridCoverage.eventOrderSensitivity.sampleComparisonComplete, false,
    'an equivalence result over shared samples must not imply complete cross-run sample coverage');
  assert.ok((offGridCoverage.eventOrderSensitivity.blendSampleTimeCoverage?.alternateOnly ?? 0) > 0,
    'the runtime-first transition schedules the destination marker at an off-grid time that the user-first run never samples');
  assert.ok((offGridCoverage.eventOrderSensitivity.composedPoseSampleTimeCoverage?.alternateOnly ?? 0) > 0,
    'composed-pose comparison must report off-grid timestamps absent from the other tie-order run');
  assert.deepEqual(offGridCoverage.eventOrderSensitivity.gate, { status: 'failed', maximumAllowedDivergences: 0,
    observedDivergences: offGridCoverage.eventOrderSensitivity.divergenceCount, sampleComparisonComplete: false },
  'the divergence threshold cannot pass when timestamp coverage is incomplete');
  const incompleteCoverageSuite = runAnimationGraphTimelineSuite(competingGraph,
    { [idle.id]: markedIdle, [attack.id]: markedAttack, [recovery.id]: recovery.recipe },
    { cases: [{ id: 'incomplete-sensitivity-coverage', name: 'Incomplete cross-policy sample coverage fails closed', duration: 0.5,
      events: [{ at: 0.2, kind: 'trigger', trigger: 'Skip' }], expect: { maxEventOrderDivergences: 0 } }] });
  assert.equal(incompleteCoverageSuite.status, 'failed');
  assert.equal(incompleteCoverageSuite.cases[0]!.eventOrderSensitivityCheck?.sampleComparisonComplete, false);
  assert.ok(incompleteCoverageSuite.cases[0]!.failures.some(failure => failure.expectation === 'eventOrderSensitivity:divergenceCount'),
    'saved timeline regression cases must surface incomplete sample coverage as a failed sensitivity gate');
  assert.throws(() => animationGraphEventOrderSensitivitySchema.parse({ ...offGridCoverage.eventOrderSensitivity,
    sampleComparisonComplete: true }), /must agree with both timestamp-coverage reports/i);
});

test('ramp samples tied to guarded runtime markers report callback-order sensitivity', async () => {
  const { idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, loop: true, markers: [{ name: 'Strike', time: 0.5 }] };
  const graph = {
    kind: 'animation_graph' as const, name: 'Ramped marker guard', entryState: 'idle', sampleRate: 20,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [{ id: 'guardedStrike', from: 'idle', to: 'attack', trigger: 'Strike', blendSeconds: 0.1,
      guards: [{ parameter: 'speed', operator: 'gte' as const, value: 9 }] }],
  };
  const result = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
      duration: 0.6, sampleRateHz: 10,
      events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.5 }],
      analyzeEventOrderSensitivity: true,
    });

  assert.equal(result.finalState, 'attack', 'user-first ordering applies the threshold ramp sample before the marker');
  assert.equal(result.eventOrderingDiagnostics.ambiguousCollisionCount, 1);
  assert.deepEqual(result.eventOrderingDiagnostics.collisions[0], {
    at: 0.5,
    eventCount: 2,
    externalInputIndices: [0],
    runtimeEvents: [{ kind: 'marker', stateId: 'idle', marker: 'Strike' }],
  });
  assert.ok(result.eventOrderSensitivity);
  assert.equal(result.eventOrderSensitivity.status, 'divergent',
    'the transition outcome is stable, but marker delivery changes with callback order');
  assert.equal(result.eventOrderSensitivity.finalStateChanged, false,
    'runtime-first ordering evaluates the marker before the final ramp sample crosses the guard threshold');
  assert.equal(result.eventOrderSensitivity.alternateOutcome.finalState, 'attack');
  assert.equal(result.eventOrderSensitivity.markerEventsChanged, false,
    'both policies deliver the marker; graph-rate ramp updates already crossed the guard before the marker tie');
});

test('event-order sensitivity detects blend output changes when a marker enters a BlendSpace at ramp completion', async () => {
  const { idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, loop: true, markers: [{ name: 'Contact', time: 0.5 }] };
  const sourceRecipe = { ...attack.recipe, loop: true, markers: [] };
  const controllerRecipe = { ...recovery.recipe, loop: true, markers: [] };
  const graph = {
    kind: 'animation_graph' as const, name: 'Blend output order sensitivity', entryState: 'idle', sampleRate: 20,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Slow source', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Fast source', animationId: recovery.id, speed: 1 },
      { id: 'locomotion', name: 'Locomotion BlendSpace', animationId: recovery.id, speed: 1,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'attack' }, { value: 5, stateId: 'recovery' },
          { value: 10, stateId: 'locomotion' }] } },
    ],
    transitions: [
      { id: 'markerEnter', from: 'idle', to: 'locomotion', trigger: 'Contact', blendSeconds: 0.1 },
      { id: 'userEnter', from: 'idle', to: 'locomotion', trigger: 'Skip', blendSeconds: 0.3 },
    ],
  };
  const result = simulateAnimationGraphTimeline(graph, {
    [idle.id]: markedIdle, [attack.id]: sourceRecipe, [recovery.id]: controllerRecipe,
  }, {
    duration: 0.7,
    sampleTimes: [0.5, 0.6, 0.7],
    poseJoints: [animationSchema.parse(idle.recipe).tracks[0]!.joint],
    events: [
      { at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.5 },
      { at: 0.5, kind: 'trigger', trigger: 'Skip' },
    ],
    analyzeEventOrderSensitivity: true,
  });

  assert.equal(result.finalState, 'locomotion');
  assert.deepEqual(result.finalParameters, { speed: 10 });
  assert.ok(result.eventOrderSensitivity);
  assert.equal(result.eventOrderSensitivity.finalStateChanged, false);
  assert.equal(result.eventOrderSensitivity.finalParametersChanged, false);
  assert.equal(result.eventOrderSensitivity.blendSamplesChanged, true,
    'the marker-first policy selects its 0.1-second fade before the user trigger; user-first selects a 0.3-second fade');
  assert.equal(result.eventOrderSensitivity.composedPoseSamplesChanged, true,
    'pose output must be compared at matching explicitly requested timestamps, not inferred only from track-state differences');
  assert.equal(result.eventOrderSensitivity.status, 'divergent');
});

test('event-order diagnostics omit ramp samples canceled before a runtime callback', async () => {
  const { idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, loop: true, markers: [{ name: 'Pulse', time: 0.5 }] };
  const graph = {
    kind: 'animation_graph' as const, name: 'Canceled ramp callback', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }],
    states: [
      { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
      { id: 'attack', name: 'Attack', animationId: attack.id, speed: 1 },
      { id: 'recovery', name: 'Recovery', animationId: recovery.id, speed: 1 },
    ],
    transitions: [],
  };
  const result = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
      duration: 0.6, sampleRateHz: 10,
      events: [
        { at: 0, kind: 'ramp_parameters', values: { speed: 10 }, duration: 0.6 },
        { at: 0.2, kind: 'set_parameters', values: { speed: 0 } },
      ],
    });

  assert.equal(result.finalParameters.speed, 0);
  assert.equal(result.eventOrderingDiagnostics.ambiguousCollisionCount, 0,
    'a ramp sample canceled at 0.2 must not be reported as competing with the live marker at 0.5');
  assert.deepEqual(result.eventOrderingDiagnostics.collisions, []);
});

test('same-time authored inputs do not report callbacks from a state they already left', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, markers: [{ name: 'Rest', time: 0.2 }] };
  const simulated = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.4, events: [
      { at: 0.2, kind: 'trigger', trigger: 'Attack' },
      { at: 0.2, kind: 'trigger', trigger: 'Attack' },
    ] });

  assert.equal(simulated.finalState, 'attack');
  assert.equal(simulated.timeline.filter(event => event.event === 'trigger').length, 2);
  assert.equal(simulated.eventOrderingDiagnostics.ambiguousCollisionCount, 1,
    'only the first same-time trigger competes with the idle marker; the second is already in attack');
  assert.deepEqual(simulated.eventOrderingDiagnostics.collisions[0]!.externalInputIndices, [0, 1]);
  assert.deepEqual(simulated.eventOrderingDiagnostics.collisions[0]!.runtimeEvents,
    [{ kind: 'marker', stateId: 'idle', marker: 'Rest' }]);
});

test('event-order sensitivity reports equivalent outcomes when no same-time runtime callback competes', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const report = simulateAnimationGraphTimeline(graph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 0.3, events: [{ at: 0.05, kind: 'trigger', trigger: 'Attack' }], analyzeEventOrderSensitivity: true,
  });
  assert.ok(report.eventOrderSensitivity);
  assert.equal(report.eventOrderSensitivity.status, 'equivalent');
  assert.equal(report.eventOrderSensitivity.sampleComparisonComplete, true);
  assert.equal(report.eventOrderSensitivity.gate, null);
  assert.equal(report.eventOrderSensitivity.timelineChanged, false);
  assert.equal(report.eventOrderSensitivity.firstTimelineDifference, null);
});

test('timeline ordering diagnostics exclude runtime callbacks made stale before the collision timestamp', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markedIdle = { ...idle.recipe, markers: [{ name: 'Rest', time: 0.2 }] };
  const simulated = simulateAnimationGraphTimeline(graph,
    { [idle.id]: markedIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, events: [
      { at: 0.1, kind: 'trigger', trigger: 'Attack' },
      { at: 0.2, kind: 'trigger', trigger: 'Attack' },
    ] });

  assert.equal(simulated.finalState, 'attack');
  assert.deepEqual(simulated.eventOrderingDiagnostics, {
    policy: 'user inputs are processed before runtime marker/AnimationEnded and modeled natural-completion fade-start events at the same timestamp; user inputs retain authored order; Roblox runtime callback ordering is not guaranteed',
    ambiguousCollisionCount: 0,
    detailedCollisionCount: 0,
    truncatedCollisionCount: 0,
    collisions: [],
  });
});

test('event-order gates use the full collision count after bounded detail truncation', async () => {
  const { idle } = await fixture();
  const graph = { kind: 'animation_graph' as const, name: 'Dense marker collisions', entryState: 'idle', sampleRate: 15,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions: [] };
  const denseLoop = { ...animationPreset('idle', 'Dense marker loop', 0.1, 0.05), loop: true,
    markers: [{ name: 'MarkerA', time: 0.05 }, { name: 'MarkerB', time: 0.05 }] };
  const direct = simulateAnimationGraphTimeline(graph, { [idle.id]: denseLoop }, { duration: 120 });

  assert.equal(direct.eventOrderingDiagnostics.detailedCollisionCount, 512);
  assert.ok(direct.eventOrderingDiagnostics.truncatedCollisionCount > 0);
  assert.equal(direct.eventOrderingDiagnostics.ambiguousCollisionCount,
    direct.eventOrderingDiagnostics.detailedCollisionCount + direct.eventOrderingDiagnostics.truncatedCollisionCount);
  const gated = runAnimationGraphTimelineSuite(graph, { [idle.id]: denseLoop }, { cases: [{
    id: 'truncated-collisions', name: 'The gate sees hidden collision details', duration: 120, events: [],
    expect: { finalState: 'idle', maxAmbiguousEventOrderingCollisions: 0 },
  }] });
  assert.equal(gated.cases[0]!.eventOrderingCheck?.observedCollisions, direct.eventOrderingDiagnostics.ambiguousCollisionCount);
  assert.equal(gated.cases[0]!.eventOrderingCheck?.status, 'failed');
  assert.equal(gated.cases[0]!.eventOrderingDiagnostics.truncatedCollisionCount, direct.eventOrderingDiagnostics.truncatedCollisionCount);
});

test('dense loop markers stop at the scheduled-event work limit', async () => {
  const { root, idle } = await fixture();
  try {
    const graph = { kind: 'animation_graph' as const, name: 'Marker work bound', entryState: 'idle', sampleRate: 15,
      states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions: [] };
    const denseLoop = animationSchema.parse({ ...animationPreset('idle', 'Dense loop markers', 0.1, 0.05), loop: true,
      markers: Array.from({ length: 17 }, (_, index) => ({ name: `Pulse${index}`, time: 0.05 })) });

    assert.throws(() => simulateAnimationGraphTimeline(graph, { [idle.id]: denseLoop }, { duration: 120 }),
      /exceeded 20000 scheduled events/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('blend-sample pose tracing automatically composes every generated timestamp within its joint-time budget', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const withConstantTorsoOffset = (recipe: AnimationRecipe, offset: number, torsoYawDegrees = 0) => {
    if (recipe.kind !== 'animation') throw new Error('Expected an animation fixture.');
    return { ...recipe,
      tracks: recipe.tracks.filter(track => track.joint === 'UpperTorso').map(track => ({ ...track,
        keys: track.keys.map(key => ({ ...key, position: [offset, 0, 0] as [number, number, number], rotation: [0, torsoYawDegrees, 0] as [number, number, number] })) })),
      layers: [], rootMotion: undefined };
  };
  const traced = simulateAnimationGraphTimeline({ ...graph, sampleRate: 15 },
    { [idle.id]: withConstantTorsoOffset(animationSchema.parse(idle.recipe), 0),
      [attack.id]: withConstantTorsoOffset(animationSchema.parse(attack.recipe), 4),
      [recovery.id]: withConstantTorsoOffset(animationSchema.parse(recovery.recipe), 0) },
    { duration: 0.3, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.2],
      poseJoints: ['UpperTorso'], includeBlendSamplePoses: true, maxPoseSampleGapSeconds: 1 / 15 + 1e-12 });

  assert.deepEqual(traced.composedPoseSamples.map(sample => sample.at), traced.blendSamples.map(sample => sample.at),
    'automatic pose tracing must cover the complete generated blend timeline, including exact request/event times');
  assert.equal(traced.poseModel.sampleCount, traced.blendSamples.length);
  assert.ok(traced.composedPoseSamples.every(sample => sample.joints.length === 1 && sample.joints[0]!.joint === 'UpperTorso'));
  assert.equal(traced.poseMotionDiagnostics.samplingBasis, 'all_generated_blend_samples');
  assert.equal(traced.poseMotionDiagnostics.sampleRateHz, 15);
  assert.equal(traced.poseMotionDiagnostics.sampleCount, traced.blendSamples.length);
  assert.ok(traced.poseMotionDiagnostics.maximumSampleGapSeconds <= 1 / 15 + 1e-12);
  assert.ok(Math.abs(traced.poseMotionDiagnostics.maximumSampleGapInterval!.to
    - traced.poseMotionDiagnostics.maximumSampleGapInterval!.from - traced.poseMotionDiagnostics.maximumSampleGapSeconds) < 1e-12);
  assert.deepEqual(traced.poseMotionDiagnostics.maximumSampleGapGate, {
    status: 'passed', maximumAllowedSeconds: 1 / 15 + 1e-12,
    observedSeconds: traced.poseMotionDiagnostics.maximumSampleGapSeconds,
    interval: traced.poseMotionDiagnostics.maximumSampleGapInterval,
  });
  const torsoMotion = traced.poseMotionDiagnostics.joints[0]!;
  assert.equal(torsoMotion.sampleCount, traced.blendSamples.length);
  assert.equal(torsoMotion.intervalCount, traced.blendSamples.length - 1);
  assert.ok(Math.abs(torsoMotion.maximumSampledLinearSpeedStudsPerSecond - 20) < 1e-9,
    `known 4-stud offset over a 0.2s fade should report 20 studs/s, got ${torsoMotion.maximumSampledLinearSpeedStudsPerSecond}`);
  assert.ok(torsoMotion.maximumLinearSpeedInterval !== null);
  assert.equal(torsoMotion.maximumSampledAngularSpeedDegreesPerSecond, 0);
  assert.ok(torsoMotion.maximumSampledLinearAccelerationStudsPerSecondSquared > 0,
    'the fade boundary should be visible as a change in sampled local translation velocity');
  assert.ok(torsoMotion.maximumLinearAccelerationInterval !== null);
  assert.equal(torsoMotion.maximumSampledAngularSpeedChangeDegreesPerSecondSquared, 0);
  assert.equal(torsoMotion.maximumAngularSpeedChangeInterval, null);
  assert.match(traced.poseMotionDiagnostics.limitation, /sampled diagnostics.*not continuous-time/i);
  const sparse = simulateAnimationGraphTimeline({ ...graph, sampleRate: 15 },
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, sampleTimes: [0.05, 0.25], poseJoints: ['UpperTorso'], maxPoseSampleGapSeconds: 0.1 });
  assert.equal(sparse.poseMotionDiagnostics.samplingBasis, 'explicit_sample_times');
  assert.equal(sparse.poseMotionDiagnostics.sampleRateHz, null,
    'a requested sparse trace must not imply an unrelated uniform sampling rate');
  assert.equal(sparse.poseMotionDiagnostics.sampleCount, 2);
  assert.equal(sparse.poseMotionDiagnostics.coverageStartAt, 0.05);
  assert.equal(sparse.poseMotionDiagnostics.coverageEndAt, 0.25);
  assert.equal(sparse.poseMotionDiagnostics.joints[0]!.maximumSampledLinearAccelerationStudsPerSecondSquared, 0,
    'a two-sample trace has no adjacent velocity intervals from which acceleration can be estimated');
  assert.equal(sparse.poseMotionDiagnostics.joints[0]!.maximumLinearAccelerationInterval, null);
  assert.ok(Math.abs(sparse.poseMotionDiagnostics.maximumSampleGapSeconds - 0.2) < 1e-12);
  assert.deepEqual(sparse.poseMotionDiagnostics.maximumSampleGapInterval, { from: 0.05, to: 0.25 });
  assert.deepEqual(sparse.poseMotionDiagnostics.maximumSampleGapGate, {
    status: 'failed', maximumAllowedSeconds: 0.1, observedSeconds: 0.2, interval: { from: 0.05, to: 0.25 },
  });
  const sparseAndDenseObservations = (sampleTimes: number[]) => simulateAnimationGraphTimeline({ ...graph, sampleRate: 15, transitions: [
    { id: 'beginMotion', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.2 },
  ] },
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, sampleTimes, poseJoints: ['UpperTorso'], events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }] });
  const oneInterval = sparseAndDenseObservations([0.1, 0.2]);
  const refinedIntervals = sparseAndDenseObservations([0.1, 0.15, 0.2]);
  assert.deepEqual(refinedIntervals.composedPoseSamples.map(sample => sample.at), [0.1, 0.15, 0.2]);
  assert.deepEqual(oneInterval.composedPoseSamples.map(sample => sample.at), [0.1, 0.2]);
  assert.equal(refinedIntervals.poseMotionDiagnostics.sampleRateHz, null);
  const irregularIntervals = simulateAnimationGraphTimeline({ ...graph, sampleRate: 15, transitions: [
    { id: 'beginIrregularMotion', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.2 },
  ] },
    { [idle.id]: withConstantTorsoOffset(animationSchema.parse(idle.recipe), 0),
      [attack.id]: withConstantTorsoOffset(animationSchema.parse(attack.recipe), 4),
      [recovery.id]: withConstantTorsoOffset(animationSchema.parse(recovery.recipe), 0) },
    { duration: 0.4, sampleTimes: [0.05, 0.08, 0.25, 0.34], events: [{ at: 0.05, kind: 'trigger', trigger: 'Attack' }],
      poseJoints: ['UpperTorso'] });
  const irregularMotion = irregularIntervals.poseMotionDiagnostics.joints[0]!;
  assert.ok(Math.abs(irregularMotion.maximumSampledLinearAccelerationStudsPerSecondSquared - 20 / 0.13) < 1e-8,
    `nonuniform pose samples must use actual interval-midpoint spacing; received ${irregularMotion.maximumSampledLinearAccelerationStudsPerSecondSquared}`);
  assert.deepEqual(irregularMotion.maximumLinearAccelerationInterval, { from: 0.08, to: 0.34 });
  const rotationalTrace = simulateAnimationGraphTimeline({ ...graph, sampleRate: 15, transitions: [
    { id: 'beginRotation', from: 'idle', to: 'attack', trigger: 'Attack', blendSeconds: 0.2 },
  ] },
    { [idle.id]: withConstantTorsoOffset(animationSchema.parse(idle.recipe), 0, 0),
      [attack.id]: withConstantTorsoOffset(animationSchema.parse(attack.recipe), 0, 90),
      [recovery.id]: withConstantTorsoOffset(animationSchema.parse(recovery.recipe), 0, 0) },
    { duration: 0.3, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }],
      poseJoints: ['UpperTorso'], includeBlendSamplePoses: true });
  const rotationalDiagnostics = rotationalTrace.poseMotionDiagnostics.joints[0]!;
  assert.ok(rotationalDiagnostics.maximumSampledAngularSpeedDegreesPerSecond > 0,
    'the rotational fade should produce a measurable sampled angular speed');
  assert.ok(rotationalDiagnostics.maximumSampledAngularSpeedChangeDegreesPerSecondSquared > 0,
    'the rotational fade boundary should produce a sampled angular-speed change');
  assert.ok(rotationalDiagnostics.maximumAngularSpeedChangeInterval !== null);
  assert.ok(rotationalDiagnostics.maximumSampledAngularAccelerationDegreesPerSecondSquared > 0,
    'the rotational fade should produce a sampled angular-velocity-vector change');
  assert.ok(rotationalDiagnostics.maximumAngularAccelerationInterval !== null);
  assert.throws(() => animationGraphSimulationInputSchema.parse({ duration: 1, includePoseSamples: false, includeBlendSamplePoses: true }),
    /includeBlendSamplePoses requires includePoseSamples=true/i);
  assert.throws(() => animationGraphSimulationInputSchema.parse({ duration: 1, includePoseSamples: false, maxPoseSampleGapSeconds: 0.1 }),
    /maxPoseSampleGapSeconds requires includePoseSamples=true/i);
});

test('timeline simulator rejects provenance-heavy results that exceed the serialized MCP payload limit', async () => {
  const { idle } = await fixture();
  const track = { joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 30, position: [1, 0, 0] as [number, number, number], rotation: [0, 45, 0] as [number, number, number] },
  ] };
  const recipe = animationSchema.parse({ kind: 'animation', name: 'Layer payload stress test', duration: 30, loop: true,
    tracks: [track], layers: Array.from({ length: 32 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Payload layer ${index + 1}`, blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [track],
    })) });
  const graph = { kind: 'animation_graph' as const, name: 'Payload stress graph', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions: [] };

  assert.throws(() => simulateAnimationGraphTimeline(graph, { [idle.id]: recipe }, {
    duration: 7, sampleRateHz: 120, poseJoints: ['UpperTorso'], includeBlendSamplePoses: true,
  }), /serialized provenance safety limit|serialized output.*8 MiB.*safety limit/i);
  assert.throws(() => simulateAnimationGraphTimeline(graph, { [idle.id]: recipe }, {
    duration: 7, sampleRateHz: 120, poseJoints: ['UpperTorso'], includeBlendSamplePoses: true,
    analyzeEventOrderSensitivity: true,
  }), /serialized provenance safety limit|serialized output.*8 MiB.*safety limit/i,
  'event-order analysis should reject an oversized baseline before running its alternate policy');
  const compact = simulateAnimationGraphTimeline(graph, { [idle.id]: recipe }, {
    duration: 7, sampleRateHz: 10, poseJoints: ['UpperTorso'], includeBlendSamplePoses: true,
  });
  assert.equal(compact.composedPoseSamples.length, compact.blendSamples.length,
    'a bounded trace from the same provenance-heavy recipe should remain available');
});

test('timeline sampling-rate override densifies blend and pose observations without changing graph event outcomes', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const run = (sampleRateHz?: number) => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.3, sampleRateHz, events: [{ at: 0.1, kind: 'trigger', trigger: 'Attack' }],
      poseJoints: ['UpperTorso'], includeBlendSamplePoses: true });
  const authoredRate = run();
  const highRate = run(120);

  assert.equal(authoredRate.blendModel.sampleRate, graph.sampleRate);
  assert.equal(highRate.blendModel.sampleRate, 120);
  assert.ok(highRate.blendSamples.length > authoredRate.blendSamples.length);
  assert.deepEqual(highRate.composedPoseSamples.map(sample => sample.at), highRate.blendSamples.map(sample => sample.at));
  assert.deepEqual(highRate.transitionIds, authoredRate.transitionIds);
  assert.equal(highRate.finalState, authoredRate.finalState);
  assert.equal(highRate.timeline.find(event => event.event === 'trigger')?.at, 0.1,
    'sampling density must not quantize modeled graph events');
  assert.throws(() => simulateAnimationGraphTimeline(graph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { duration: 120, sampleRateHz: 120 }),
  /exceeded the 10000-sample safety limit/i, 'high-rate traces must remain protected by the global sample budget');
  assert.throws(() => animationGraphSimulationInputSchema.parse({ duration: 1, sampleRateHz: 121 }), /too_big|less than or equal to 120/i);
  assert.doesNotThrow(() => animationGraphSimulationInputSchema.parse({ duration: 120, sampleRateHz: 120,
    events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 1 }, duration: 120 }] }),
  'input-only validation cannot estimate ramp work without the saved graph sample rate');
  assert.throws(() => animationGraphSimulationInputSchema.parse({ duration: 1,
    events: [{ at: 0, kind: 'ramp_parameters', values: {}, duration: 0.5 }] }), /At least one numeric parameter target is required/i);
  assert.doesNotThrow(() => animationGraphSimulationInputSchema.parse({ duration: 1, sampleRateHz: 10,
    sampleTimes: Array.from({ length: 512 }, (_, index) => 0.1 + index * 0.001),
    events: Array.from({ length: 20 }, (_, index) => ({ at: 0, kind: 'ramp_parameters' as const,
      values: { speed: index }, duration: 0.01 })) }),
  'input validation must not charge observation timestamps as ramp update work');
  assert.doesNotThrow(() => animationGraphSimulationInputSchema.parse({ duration: 1, sampleRateHz: 10,
    sampleTimes: Array.from({ length: 512 }, () => 0.005),
    events: Array.from({ length: 512 }, (_, index) => ({ at: 0, kind: 'ramp_parameters' as const,
      values: { speed: index }, duration: 0.01 })) }),
  'duplicate explicit timestamps are observation-only and must not affect ramp scheduling');

  const lowRateGraph = { ...graph, sampleRate: 15,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 1 }] };
  const lowRateRamps = Array.from({ length: 512 }, () => ({ at: 0, kind: 'ramp_parameters' as const,
    values: { speed: 0.5 }, duration: 0.5 }));
  assert.doesNotThrow(() => animationGraphSimulationInputSchema.parse({ duration: 1, events: lowRateRamps }),
    'input validation cannot invent a 60 Hz default when the effective rate belongs to the graph');
  const lowRateRampRun = simulateAnimationGraphTimeline(lowRateGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 1, events: lowRateRamps, sampleTimes: [0.123] });
  const denseObservationRampRun = simulateAnimationGraphTimeline(lowRateGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 1, sampleRateHz: 120, events: lowRateRamps, sampleTimes: [0.123, 0.234, 0.345] });
  assert.equal(lowRateRampRun.blendModel.sampleRate, 15);
  assert.equal(denseObservationRampRun.blendModel.sampleRate, 120);
  assert.equal(lowRateRampRun.scheduledEvents, 512 + 512 * 7,
    'the graph-aware budget must match the exact seven generated ramp samples per event at 15 Hz');
  assert.equal(denseObservationRampRun.scheduledEvents, lowRateRampRun.scheduledEvents,
    'changing output sample rate or explicit observation times cannot change ramp events');
  assert.deepEqual(denseObservationRampRun.timeline, lowRateRampRun.timeline);
  assert.deepEqual(denseObservationRampRun.finalParameters, lowRateRampRun.finalParameters);
  const excessiveRampGraph = { ...lowRateGraph, sampleRate: 60 };
  assert.throws(() => simulateAnimationGraphTimeline(excessiveRampGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 120, sampleRateHz: 10, includePoseSamples: false, events: Array.from({ length: 512 }, () => ({
      at: 0, kind: 'ramp_parameters' as const, values: { speed: 1 }, duration: 120,
    })) }),
  /10000 generated-sample safety limit/i,
  'ramp work limits use the graph update rate, independent of requested observation density');
});

test('blend sample safety limit stops dense marker timelines as timestamps are added', async () => {
  const { idle } = await fixture();
  const graph = { kind: 'animation_graph' as const, name: 'Dense sample limit', entryState: 'idle', sampleRate: 60,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }], transitions: [] };
  const denseLoop = { ...animationPreset('idle', 'Dense sample-limit loop', 0.1, 0.01), loop: true,
    markers: [{ name: 'PulseA', time: 0.01 }, { name: 'PulseB', time: 0.04 }, { name: 'PulseC', time: 0.07 }] };

  assert.throws(() => simulateAnimationGraphTimeline(graph, { [idle.id]: denseLoop }, { duration: 120 }),
    /exceeded the 10000-sample safety limit while adding timeline timestamps/i);
});

test('timeline simulation reports user events beyond its horizon instead of silently implying they ran', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const horizonGraph = { ...graph, transitions: graph.transitions.map(transition => ({ ...transition, blendSeconds: 0.4 })) };
  const simulated = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.2, events: [
      { at: 0, kind: 'trigger', trigger: 'Attack' },
      { at: 0.3, kind: 'trigger', trigger: 'Attack' },
      { at: 1, kind: 'set_parameters', values: { stamina: 0.5 } },
    ] });

  assert.deepEqual(simulated.transitionIds, ['beginAttack']);
  assert.ok(simulated.blendSamples.every(sample => sample.at <= simulated.duration),
    'fade completion timestamps after the requested horizon must not become simulation samples');
  assert.deepEqual(simulated.outOfWindowEvents, [
    { inputIndex: 1, at: 0.3, kind: 'trigger' },
    { inputIndex: 2, at: 1, kind: 'set_parameters' },
  ]);

  const justOutside = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.2, events: [{ at: 0.2000000000001, kind: 'trigger', trigger: 'Attack' }] });
  assert.deepEqual(justOutside.outOfWindowEvents, [{ inputIndex: 0, at: 0.2000000000001, kind: 'trigger' }],
    'rounding must never move a caller event from just outside the horizon onto its inclusive boundary');

  const nextTimestampAfterHorizon = 0.2 + Number.EPSILON * 0.2 / 2;
  const userEventJustOutside = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { duration: 0.2, events: [{ at: nextTimestampAfterHorizon, kind: 'trigger', trigger: 'Attack' }] });
  assert.deepEqual(userEventJustOutside.outOfWindowEvents, [{ inputIndex: 0, at: nextTimestampAfterHorizon, kind: 'trigger' }],
    'the next representable user-event timestamp beyond the horizon must remain outside');

  const markerAfterHorizon = { ...idle.recipe, markers: [{ name: 'Attack', time: nextTimestampAfterHorizon }] };
  const derivedJustOutside = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: markerAfterHorizon, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { duration: 0.2 });
  assert.deepEqual(derivedJustOutside.triggeredMarkers, [],
    'a runtime marker at the next representable timestamp beyond the horizon must not be pulled into the run by time normalization');
  assert.deepEqual(derivedJustOutside.transitionIds, []);

  const markerAtHorizon = { ...idle.recipe, markers: [{ name: 'Attack', time: 0.2 }] };
  const inclusiveBoundary = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: markerAtHorizon, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { duration: 0.2 });
  assert.deepEqual(inclusiveBoundary.triggeredMarkers.map(marker => marker.at), [0.2],
    'an authored marker exactly on the horizon remains included');

  const roundoffHorizon = 0.012511;
  const roundoffRecipe = { ...animationPreset('idle', 'Roundoff Boundary', 0.1, 0.05),
    markers: [{ name: 'Attack', time: roundoffHorizon }] };
  const roundoffBoundary = simulateAnimationGraphTimeline(horizonGraph,
    { [idle.id]: roundoffRecipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, { duration: roundoffHorizon });
  assert.deepEqual(roundoffBoundary.triggeredMarkers.map(marker => marker.at), [roundoffHorizon],
    'phase-to-seconds conversion must not move an authored boundary marker one float step past the inclusive horizon');
  assert.deepEqual(roundoffBoundary.transitionIds, ['beginAttack']);
});

test('loop markers at the inclusive horizon survive cycle-time floating-point regrouping', () => {
  const recipeDuration = 0.117;
  const markerTime = 10 * recipeDuration / 100;
  const loopRecipe = animationSchema.parse({ ...animationPreset('idle', 'Loop Boundary Rounding', recipeDuration, 0.05),
    loop: true, markers: [{ name: 'LoopBoundary', time: markerTime }] });
  const animationId = '00000000-0000-4000-8000-000000000001';
  const graph = { kind: 'animation_graph' as const, name: 'Loop Boundary Rounding', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId, speed: 1 }],
    transitions: [{ id: 'restart', from: 'idle', to: 'idle', trigger: 'Restart', blendSeconds: 0 }] };
  const cycleStart = 0.00001;
  const lastCycle = 69;
  const horizon = cycleStart + (markerTime + lastCycle * recipeDuration);
  const report = simulateAnimationGraphTimeline(graph, { [animationId]: loopRecipe }, { duration: horizon,
    events: [{ at: cycleStart, kind: 'trigger', trigger: 'Restart' }] });

  assert.equal(report.triggeredMarkers.at(-1)?.at, horizon,
    'the final loop marker mathematically on the inclusive horizon must not disappear due to addition grouping');

  const ratioDuration = 0.113;
  const ratioMarkerTime = ratioDuration / 100;
  const ratioRecipe = animationSchema.parse({ ...animationPreset('idle', 'Loop Count Rounding', ratioDuration, 0.05),
    loop: true, markers: [{ name: 'LoopBoundary', time: ratioMarkerTime }] });
  const ratioStart = 0.00001;
  const ratioLastCycle = 61;
  const ratioHorizon = ratioStart + (ratioMarkerTime + ratioLastCycle * ratioDuration);
  const ratioReport = simulateAnimationGraphTimeline({ ...graph, states: [{ ...graph.states[0], animationId }], name: 'Loop Count Rounding' },
    { [animationId]: ratioRecipe }, { duration: ratioHorizon,
      events: [{ at: ratioStart, kind: 'trigger', trigger: 'Restart' }] });
  assert.equal(ratioReport.triggeredMarkers.at(-1)?.at, ratioHorizon,
    'cycle-count division rounding down must be corrected when the next grouped callback is exactly within the horizon');

  const retimeAt = 0.00001;
  const retimedSpeed = 2;
  const retimedPhase = retimeAt / ratioDuration;
  const retimedFirst = ((((ratioMarkerTime / ratioDuration - retimedPhase) % 1) + 1) % 1) * (ratioDuration / retimedSpeed);
  const retimedCycle = 61;
  const retimedHorizon = retimeAt + (retimedFirst + retimedCycle * (ratioDuration / retimedSpeed));
  const retimedReport = simulateAnimationGraphTimeline({ ...graph, states: [{ ...graph.states[0], animationId }], name: 'Retimed Loop Boundary' },
    { [animationId]: ratioRecipe }, { duration: retimedHorizon,
      events: [{ at: retimeAt, kind: 'set_playback_speed', multiplier: retimedSpeed }] });
  assert.equal(retimedReport.triggeredMarkers.at(-1)?.at, retimedHorizon,
    'phase-relative loop scheduling after a speed change must retain the marker on the inclusive horizon');
});

test('loop retiming does not postpone a marker that is shortly ahead of the current phase', () => {
  const recipeDuration = 0.117;
  const markerTime = 0.05;
  const recipe = animationSchema.parse({ ...animationPreset('idle', 'Near Retime Marker', recipeDuration, 0.05),
    loop: true, markers: [{ name: 'NearMarker', time: markerTime }] });
  const animationId = '00000000-0000-4000-8000-000000000001';
  const graph = { kind: 'animation_graph' as const, name: 'Near Retime Marker', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId, speed: 1 }], transitions: [] };
  const retimeAt = markerTime - 5e-10;
  const expectedMarkerAt = retimeAt + (markerTime - retimeAt) / 2;
  const report = simulateAnimationGraphTimeline(graph, { [animationId]: recipe }, { duration: 0.06,
    events: [{ at: retimeAt, kind: 'set_playback_speed', multiplier: 2 }] });

  assert.equal(report.triggeredMarkers.length, 1,
    'a marker shortly ahead after retiming should fire in this run, not be deferred by a full loop');
  assert.ok(Math.abs(report.triggeredMarkers[0]!.at - expectedMarkerAt) < 1e-12);

  const oneShotRecipe = animationSchema.parse({ ...recipe, loop: false });
  const oneShotReport = simulateAnimationGraphTimeline(graph, { [animationId]: oneShotRecipe }, { duration: 0.06,
    events: [{ at: retimeAt, kind: 'set_playback_speed', multiplier: 2 }] });
  assert.equal(oneShotReport.triggeredMarkers.length, 1,
    'the phase-relative tolerance must not discard a one-shot marker that remains shortly ahead');
  assert.ok(Math.abs(oneShotReport.triggeredMarkers[0]!.at - expectedMarkerAt) < 1e-12);

  const seamReport = simulateAnimationGraphTimeline(graph, { [animationId]: recipe }, { duration: 0.12,
    events: [{ at: markerTime, kind: 'set_playback_speed', multiplier: 2 }] });
  assert.equal(seamReport.triggeredMarkers.length, 1,
    'a marker exactly at the retimed phase must wait for its next loop occurrence, not fire twice at the seam');
  assert.ok(Math.abs(seamReport.triggeredMarkers[0]!.at - (markerTime + recipeDuration / 2)) < 1e-12);
});

test('retimed one-shot completion remains on an inclusive horizon after phase conversion', () => {
  const recipeDuration = 0.1;
  const recipe = animationSchema.parse({ ...animationPreset('idle', 'Retimed Completion Boundary', recipeDuration, 0.05),
    loop: false, markers: [] });
  const animationId = '00000000-0000-4000-8000-000000000001';
  const graph = { kind: 'animation_graph' as const, name: 'Retimed Completion Boundary', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId, speed: 1 }], transitions: [] };
  const retimeAt = 0.0059;
  const horizon = retimeAt + (recipeDuration - retimeAt) / 2;
  const report = simulateAnimationGraphTimeline(graph, { [animationId]: recipe }, { duration: horizon,
    events: [{ at: retimeAt, kind: 'set_playback_speed', multiplier: 2 }] });

  assert.equal(report.timeline.find(event => event.trigger === 'AnimationEnded')?.at, horizon,
    'phase conversion must not push AnimationEnded just beyond its exact inclusive horizon');
});

test('timeline simulation remains consistent with graph evaluation across deterministic randomized inputs', () => {
  let seed = 917321;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const ids = [
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-000000000204',
  ];
  const stateIds = ['a', 'b', 'c', 'd'];
  const states = stateIds.map((id, index) => ({ id, name: id, animationId: ids[index]!, speed: 0.5 + random() * 2 }));
  const transitions = stateIds.flatMap(from => stateIds.filter(to => to !== from).map((to, index) => ({
    id: `${from}_${to}`, from, to, trigger: `${from}_${to}`, blendSeconds: 0.1 * (index + 1),
  })));
  const graph = { kind: 'animation_graph' as const, name: 'Deterministic event stress', entryState: 'a', sampleRate: 30, states, transitions };
  const recipe = animationPreset('idle', 'Looped stress recipe', 2, 0.2);
  const recipes = Object.fromEntries(ids.map(id => [id, recipe]));

  for (let scenario = 0; scenario < 40; scenario++) {
    const events = Array.from({ length: 24 }, () => ({ at: Math.round(random() * 100) / 100,
      kind: 'trigger' as const, trigger: transitions[Math.floor(random() * transitions.length)]!.trigger }));
    const chronologicalEvents = events.map((event, index) => ({ ...event, index }))
      .sort((left, right) => left.at - right.at || left.index - right.index);
    let expectedState = graph.entryState;
    const expectedTransitions: string[] = [];
    for (const event of chronologicalEvents) {
      const evaluation = evaluateAnimationGraphTransition(graph, expectedState, event.trigger);
      if (evaluation.selectedTransition) {
        expectedTransitions.push(evaluation.selectedTransition.id);
        expectedState = evaluation.selectedTransition.to;
      }
    }

    const actual = simulateAnimationGraphTimeline(graph, recipes, { duration: 1, events });
    assert.deepEqual(actual.transitionIds, expectedTransitions, `transition mismatch in scenario ${scenario}`);
    assert.equal(actual.finalState, expectedState, `final state mismatch in scenario ${scenario}`);
    for (const sample of actual.blendSamples) {
      const sampledStates = new Set<string>();
      for (const track of sample.activeTracks) {
        assert.equal(sampledStates.has(track.stateId), false, `duplicate state track in scenario ${scenario}`);
        sampledStates.add(track.stateId);
        assert.ok(Number.isFinite(track.weight) && track.weight >= 0 && track.weight <= 1);
        assert.ok(Number.isFinite(track.targetWeight) && track.targetWeight >= 0 && track.targetWeight <= 1);
        assert.ok(Number.isFinite(track.fadeRemainingSeconds) && track.fadeRemainingSeconds >= 0);
        assert.ok(Number.isFinite(track.playbackTimeSeconds) && track.playbackTimeSeconds >= 0);
      }
    }
  }
});

test('timeline simulation follows markers as graph triggers, repeats loop markers and keeps failed-trigger parameter updates atomic', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markerGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'releaseRecovery', from: 'attack', to: 'recovery', trigger: 'Release', blendSeconds: 0.1,
  }] };
  const attackRecipe = { ...attack.recipe, markers: [{ name: 'Release', time: 0.5 }] };
  const markerResult = simulateAnimationGraphTimeline(markerGraph, { [idle.id]: idle.recipe, [attack.id]: attackRecipe, [recovery.id]: recovery.recipe }, {
    duration: 1, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }],
  });
  assert.deepEqual(markerResult.transitionIds, ['beginAttack', 'releaseRecovery']);
  assert.equal(markerResult.finalState, 'recovery');
  assert.equal(markerResult.timeline.find(event => event.transitionId === 'releaseRecovery')?.at, 0.25);

  const loopingIdle = { ...idle.recipe, markers: [{ name: 'FootPlant', time: 0.25 }] };
  const loopResult = simulateAnimationGraphTimeline(graph, { [idle.id]: loopingIdle, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 4.25,
  });
  assert.deepEqual(loopResult.triggeredMarkers.map(marker => marker.at), [0.25, 2.25, 4.25]);

  const parameterGraph = { ...graph, parameters: [{ name: 'stamina', type: 'number' as const, defaultValue: 0, min: 0, max: 1 }],
    transitions: graph.transitions.map(transition => transition.id === 'beginAttack' ? { ...transition,
      guards: [{ parameter: 'stamina', operator: 'gte' as const, value: 0.5 }] } : transition) };
  const parameterResult = simulateAnimationGraphTimeline(parameterGraph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    duration: 0.2, events: [
      { at: 0, kind: 'trigger', trigger: 'Attack', setParameters: { stamina: 0.8 } },
      { at: 0.1, kind: 'trigger', trigger: 'NoBranch', setParameters: { stamina: 0.2 } },
    ],
  });
  assert.equal(parameterResult.finalState, 'attack');
  assert.equal(parameterResult.finalParameters.stamina, 0.8);
  assert.equal(parameterResult.timeline.find(event => event.trigger === 'NoBranch')?.expectationMatched, true);
  assert.deepEqual(parameterResult.timeline.find(event => event.trigger === 'NoBranch')?.rejectedParameterUpdates, { stamina: 0.2 });
});

test('temporal graph regression suites assert event order, marker windows, state samples and transition timing deterministically', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const markerGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'releaseRecovery', from: 'attack', to: 'recovery', trigger: 'Release', blendSeconds: 0.1,
  }] };
  const recipes = { [idle.id]: idle.recipe, [attack.id]: { ...attack.recipe, markers: [{ name: 'Release', time: 0.5 }] }, [recovery.id]: recovery.recipe };
  const suite = { cases: [{ id: 'marker-route', name: 'Attack release enters recovery', duration: 0.8,
    events: [{ at: 0, kind: 'trigger' as const, trigger: 'Attack' }], expect: {
      finalState: 'recovery', transitionIds: { mode: 'exact' as const, ids: ['beginAttack', 'releaseRecovery'] },
      markers: [{ name: 'Release', minCount: 1, maxCount: 1, window: { start: 0.2, end: 0.3 } }],
      stateAt: [{ at: 0.1, stateId: 'attack' }, { at: 0.3, stateId: 'recovery' }],
      transitionTimes: [{ transitionId: 'beginAttack', minAt: 0, maxAt: 0 }, { transitionId: 'releaseRecovery', minAt: 0.2, maxAt: 0.3 }],
    } }] };
  const first = runAnimationGraphTimelineSuite(markerGraph, recipes, suite);
  const second = runAnimationGraphTimelineSuite(markerGraph, recipes, suite);
  assert.equal(first.status, 'passed');
  assert.equal(first.summary.passed, 1);
  assert.equal(first.reportFingerprint, second.reportFingerprint);
  assert.equal(first.cases[0]!.failures.length, 0);
  assert.equal(first.cases[0]!.eventOrderingDiagnostics.ambiguousCollisionCount, 0);
  assert.equal(first.cases[0]!.animationEndedTiming.assumedAdditionalFadeSeconds, 0);
  const gated = runAnimationGraphTimelineSuite(markerGraph,
    { [idle.id]: { ...idle.recipe, markers: [{ name: 'Rest', time: 0.5 }] }, [attack.id]: recipes[attack.id], [recovery.id]: recovery.recipe },
    { cases: [{ id: 'ordering-sensitive', name: 'Reject same-time marker ambiguity', duration: 0.8,
      events: [{ at: 0.5, kind: 'trigger', trigger: 'Attack' }],
      expect: { finalState: 'attack', maxAmbiguousEventOrderingCollisions: 0 } }] });
  assert.equal(gated.status, 'failed');
  assert.equal(gated.cases[0]!.eventOrderingCheck?.observedCollisions, 1);
  assert.deepEqual(gated.cases[0]!.failures[0], { expectation: 'eventOrdering:ambiguousCollisionCount',
    expected: { maximum: 0 }, observed: 1 });
  const sensitivityGated = runAnimationGraphTimelineSuite(markerGraph,
    { [idle.id]: { ...idle.recipe, markers: [{ name: 'Attack', time: 0.5 }] }, [attack.id]: recipes[attack.id], [recovery.id]: recovery.recipe },
    { cases: [{ id: 'dual-policy-gate', name: 'Reject callback-order-sensitive marker transition', duration: 0.8,
      events: [{ at: 0.5, kind: 'trigger' as const, trigger: 'Attack' }],
      expect: { finalState: 'attack', maxEventOrderDivergences: 0 } }] });
  assert.equal(sensitivityGated.status, 'failed');
  assert.equal(sensitivityGated.cases[0]!.eventOrderSensitivity?.status, 'divergent');
  assert.deepEqual(sensitivityGated.cases[0]!.eventOrderSensitivityCheck,
    { status: 'failed', maximumAllowedDivergences: 0, observedDivergences: 2, sampleComparisonComplete: true });

  const failed = runAnimationGraphTimelineSuite(markerGraph, recipes, { cases: [{ ...suite.cases[0]!, expect: { finalState: 'idle' } }] });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.cases[0]!.failures[0], { expectation: 'finalState', expected: 'idle', observed: 'recovery' });
});

test('saved temporal suites gate incomplete BlendSpace parameter ramps at the horizon', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const rampGraph = { ...graph, parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 10 }] };
  const recipes = { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe };
  const testCase = { id: 'partialRamp', name: 'Locomotion ramp remains in flight', duration: 0.15,
    events: [{ at: 0, kind: 'ramp_parameters' as const, values: { speed: 10 }, duration: 0.2, easing: 'smoothstep' as const }],
    expect: { incompleteParameterRamps: [{ inputIndex: 0,
      simulatedProgress: { min: 0.749999, max: 0.750001 }, easedProgress: { min: 0.843749, max: 0.843751 },
      remainingSecondsAtHorizon: { min: 0.049999, max: 0.050001 },
      parameters: [{ name: 'speed', currentValue: { min: 8.43749, max: 8.43751 }, targetValue: { min: 10, max: 10 } }] }],
      parameterRampLifecycle: [{ inputIndex: 0, status: 'active', parameters: [{ name: 'speed', status: 'active',
        observedValue: { min: 8.43749, max: 8.43751 }, targetValue: { min: 10, max: 10 } }] }] } };
  const report = runAnimationGraphTimelineSuite(rampGraph, recipes, { cases: [testCase] });
  assert.equal(report.status, 'passed', JSON.stringify(report.cases[0]!.failures));
  assert.equal(report.cases[0]!.incompleteParameterRampChecks[0]!.status, 'passed');
  assert.equal(report.cases[0]!.parameterRampLifecycleChecks[0]!.status, 'passed');
  assert.equal(report.cases[0]!.incompleteParameterRamps[0]!.parameters[0]!.currentValue, 8.4375);
  assert.equal(runAnimationGraphTimelineSuite(rampGraph, recipes, { cases: [{ ...testCase,
    expect: { incompleteParameterRamps: [{ ...testCase.expect.incompleteParameterRamps[0]!,
      parameters: [{ name: 'speed', currentValue: { min: 0, max: 1 }, targetValue: { min: 10, max: 10 } }] }] } }] }).status, 'failed',
  'the persistent timeline gate should fail when the simulated in-flight value regresses');
  assert.equal(runAnimationGraphTimelineSuite(rampGraph, recipes, { cases: [{ ...testCase,
    expect: { parameterRampLifecycle: [{ inputIndex: 0, status: 'completed', parameters: [] }] } }] }).status, 'failed',
  'the lifecycle gate must detect an unexpected active/completed outcome');
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ ...testCase,
    expect: { incompleteParameterRamps: [{ ...testCase.expect.incompleteParameterRamps[0]!, inputIndex: 1 }] } }] }),
  /must reference a ramp_parameters event/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ ...testCase,
    expect: { incompleteParameterRamps: [{ ...testCase.expect.incompleteParameterRamps[0]!,
      parameters: [{ name: 'stamina', currentValue: { min: 0, max: 1 } }] }] } }] }),
  /does not target parameter stamina/i);
});

test('temporal graph regression suites assert blend weights and track lifecycle at authored sample times', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const recipes = { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe };
  const suite = { cases: [{ id: 'crossfade', name: 'Attack crossfade remains measurable', duration: 0.3,
    events: [{ at: 0, kind: 'trigger' as const, trigger: 'Attack' }], expect: { blends: [
      { at: 0.1, stateId: 'idle', present: true, weight: { min: 0.5, max: 0.5 }, targetWeight: { min: 0, max: 0 },
        isPlaying: false, isAffectingPose: true },
      { at: 0.1, stateId: 'attack', weight: { min: 0.5, max: 0.5 }, targetWeight: { min: 1, max: 1 },
        fadeRemainingSeconds: { min: 0.1, max: 0.1 }, playbackTimeSeconds: { min: 0.2, max: 0.2 }, isPlaying: true, isAffectingPose: true },
      { at: 0.2, stateId: 'idle', present: false },
      { at: 0.2, stateId: 'attack', weight: { min: 1, max: 1 }, isPlaying: true },
    ] } }] };
  const report = runAnimationGraphTimelineSuite(graph, recipes, suite);
  const replay = runAnimationGraphTimelineSuite(graph, recipes, suite);
  assert.equal(report.status, 'passed');
  assert.equal(report.reportFingerprint, replay.reportFingerprint);
  assert.deepEqual(report.cases[0]!.blendChecks.map(check => check.status), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(report.cases[0]!.blendChecks[0]!.track?.weight, 0.5);
  assert.equal(report.cases[0]!.blendChecks[1]!.track?.fadeRemainingSeconds, 0.1);

  const interruptedGraph = { ...graph, transitions: [...graph.transitions, {
    id: 'interruptForDiagnostics', from: 'attack', to: 'recovery', trigger: 'Interrupt', blendSeconds: 0.4,
  }] };
  const diagnosticCase = { id: 'poseDiagnostics', name: 'Animation and residual pose weights are bounded', duration: 0.3,
    events: [{ at: 0, kind: 'trigger' as const, trigger: 'Attack' }, { at: 0.1, kind: 'trigger' as const, trigger: 'Interrupt' }],
    expect: { poses: [{ at: 0.15, joint: 'UpperTorso', rotationBlendConfidence: { min: 0, max: 1 },
      rotationInfluence: { min: 0.812499, max: 0.812501 } }] } };
  const diagnosticReport = runAnimationGraphTimelineSuite(interruptedGraph, recipes, { cases: [diagnosticCase] });
  assert.equal(diagnosticReport.status, 'passed', JSON.stringify(diagnosticReport.cases[0]!.failures));
  assert.deepEqual(diagnosticReport.cases[0]!.poseChecks[0]!.checks.map(check => [check.property, check.passed]), [
    ['rotationBlendConfidence', true], ['rotationInfluence', true],
  ]);
  const insufficientInfluence = runAnimationGraphTimelineSuite(interruptedGraph, recipes, { cases: [{ ...diagnosticCase,
    expect: { poses: [{ at: 0.15, joint: 'UpperTorso', rotationInfluence: { min: 0.9 } }] },
  }] });
  assert.equal(insufficientInfluence.status, 'failed');
  assert.equal(insufficientInfluence.cases[0]!.failures[0]!.expectation, 'pose:UpperTorso@0.15:rotationInfluence');
  assert.deepEqual(insufficientInfluence.cases[0]!.failures[0]!.expected, { min: 0.9 });
  assert.ok(Math.abs(insufficientInfluence.cases[0]!.failures[0]!.observed as number - 0.8125) < 1e-12);
  assert.ok(insufficientInfluence.cases[0]!.failures[0]!.diagnosis!.pose.residualWeight > 0.18);

  const failed = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!, expect: { blends: [
    { at: 0.1, stateId: 'idle', weight: { min: 0.8 } },
  ] } }] });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.cases[0]!.failures, [{ expectation: 'blend:idle@0.1:weight', expected: { min: 0.8 }, observed: 0.5 }]);
});

test('temporal regression suites assert BlendSpace1D parameter and per-clip weights', async () => {
  const f = await fixture();
  try {
    const controllerRecipe = { ...animationSchema.parse(f.idle.recipe), priority: 'Movement' as const, markers: [] };
    const alternateRecipe = { ...controllerRecipe, name: 'Alternate Locomotion', duration: 1,
      tracks: controllerRecipe.tracks.map(track => ({ ...track, keys: track.keys.map(key => ({ ...key,
        time: key.time / controllerRecipe.duration,
        rotation: [key.rotation[0] + 20, key.rotation[1], key.rotation[2]] as [number, number, number] })) })) };
    const graph = { kind: 'animation_graph' as const, name: 'Locomotion blend', entryState: 'alternate', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 5, min: 0, max: 10 }],
      states: [
        { id: 'idle', name: 'Locomotion', animationId: f.idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 10, stateId: 'alternate' }] } },
        { id: 'alternate', name: 'Alternate', animationId: f.attack.id, speed: 1 },
      ], transitions: [{ id: 'enterBlend', from: 'alternate', to: 'idle', trigger: 'Blend', blendSeconds: 0.5 }] };
    const recipes = { [f.idle.id]: controllerRecipe, [f.attack.id]: alternateRecipe };
    const suite = { cases: [{ id: 'half-speed', name: 'Blend assertions separate normalized, current, and target channel weights', duration: 0.5,
      events: [{ at: 0, kind: 'trigger' as const, trigger: 'Blend' }], expect: { blends: [
      { at: 0.25, stateId: 'idle', blendSpace: { parameterValue: { min: 5, max: 5 }, clips: [
        { stateId: 'idle', weight: { min: 0.5, max: 0.5 }, poseContributionWeight: { min: 0.25, max: 0.25 },
          targetPoseContributionWeight: { min: 0.5, max: 0.5 } },
        { stateId: 'alternate', weight: { min: 0.5, max: 0.5 }, poseContributionWeight: { min: 0.25, max: 0.25 },
          targetPoseContributionWeight: { min: 0.5, max: 0.5 }, playback: { playbackSpeed: { min: 0.5, max: 0.5 } } },
      ] } },
    ] } }] };
    const report = runAnimationGraphTimelineSuite(graph, recipes, suite);
    assert.equal(report.status, 'passed', JSON.stringify(report.cases[0]?.failures));
    assert.deepEqual(report.cases[0]?.blendChecks[0]?.checks.map(check => [check.property, check.passed]), [
      ['blendSpace.parameterValue', true], ['blendSpace.clipWeight:idle', true], ['blendSpace.poseContributionWeight:idle', true],
      ['blendSpace.targetPoseContributionWeight:idle', true], ['blendSpace.clipWeight:alternate', true],
      ['blendSpace.poseContributionWeight:alternate', true], ['blendSpace.targetPoseContributionWeight:alternate', true],
      ['blendSpace.playback.playbackSpeed:alternate', true],
    ]);
    assert.deepEqual(report.cases[0]?.blendChecks[0]?.blendSpace?.samples.map(sample => [sample.stateId, sample.weight,
      sample.poseContributionWeight, sample.targetPoseContributionWeight]), [
      ['idle', 0.5, 0.25, 0.5], ['alternate', 0.5, 0.25, 0.5],
    ]);
    const measuredLengthCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: {
        phaseSync: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0 },
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.001 },
        clips: [{ stateId: 'alternate', playback: { normalizedPhase: { min: 1 / 12, max: 1 / 12 },
          playbackSpeed: { min: 0.25, max: 0.25 } } }],
      } }] },
    }] });
    assert.equal(measuredLengthCase.status, 'passed', JSON.stringify(measuredLengthCase.cases[0]?.failures));
    assert.equal(measuredLengthCase.cases[0]?.blendModel.playbackTiming.calibratedControllerCount, 1);
    assert.equal(measuredLengthCase.cases[0]?.blendChecks[0]?.blendSpace?.samples[1]?.playback.normalizedPhase, 1 / 12);
    const unsynchronizedLengthCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationAssetSetFingerprint: 'b'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'b'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: { clips: [{ stateId: 'alternate', playback: {
        playbackCycleDurationRatioToController: { min: 1.25, max: 1.25 },
      } }] } }] },
    }] });
    assert.equal(unsynchronizedLengthCase.status, 'passed', JSON.stringify(unsynchronizedLengthCase.cases[0]?.failures));
    assert.ok(unsynchronizedLengthCase.cases[0]?.blendChecks[0]?.checks.some(check =>
      check.property === 'blendSpace.playback.playbackCycleDurationRatioToController:alternate' && check.passed),
    'saved timeline assertions should be able to gate an observed source/controller cycle-duration ratio');
    const lateEntryCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      events: [{ at: 0.2, kind: 'trigger' as const, trigger: 'Blend' }],
      expect: { blends: [{ at: 0.3, stateId: 'idle', blendSpace: {
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0 },
      } }] },
    }] });
    assert.equal(lateEntryCase.status, 'passed', 'inactive timestamps before the BlendSpace is entered are outside its throughout interval');
    const lateEntryPhaseCheck = lateEntryCase.cases[0]!.blendChecks[0]!.checks.find(check => check.property === 'blendSpace.phaseSyncThroughout')!;
    assert.ok((lateEntryPhaseCheck.observed as { worstAt: number }).worstAt >= 0.2);
    const neverEnteredCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      events: [], expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: {
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.1 },
      } }] },
    }] });
    assert.equal(neverEnteredCase.status, 'failed', 'throughout phase assertions fail closed if the controller is never active');
    const neverEnteredPhaseCheck = neverEnteredCase.cases[0]!.blendChecks[0]!.checks.find(check => check.property === 'blendSpace.phaseSyncThroughout')!;
    assert.equal((neverEnteredPhaseCheck.observed as { comparableSampleCount: number }).comparableSampleCount, 0);
    assert.equal((neverEnteredPhaseCheck.observed as { controllerActiveIntervalCount: number }).controllerActiveIntervalCount, 0,
      'a never-entered controller must report zero active intervals instead of presenting a vacuous measurement');
    const driftGatedCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.5, alternate: 0.25 } },
      observedBlendAnimationAssetSetFingerprint: 'c'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'c'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: {
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.1 },
      } }] },
    }] });
    assert.equal(driftGatedCase.status, 'failed', 'a passing timestamp must not hide accumulated source-clock drift later in the run');
    const phaseDriftCheck = driftGatedCase.cases[0]!.blendChecks[0]!.checks.find(check => check.property === 'blendSpace.phaseSyncThroughout')!;
    assert.equal(phaseDriftCheck.passed, false);
    assert.ok((phaseDriftCheck.observed as { maxCircularPhaseDifference: number }).maxCircularPhaseDifference > 0.1);
    const betweenSamplePeakCase = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.499, alternate: 0 } },
      observedBlendAnimationAssetSetFingerprint: 'd'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'd'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: {
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.4995 },
      } }] },
    }] });
    const betweenSamplePeakCheck = betweenSamplePeakCase.cases[0]!.blendChecks[0]!.checks.find(check =>
      check.property === 'blendSpace.phaseSyncThroughout')!;
    assert.equal(betweenSamplePeakCheck.passed, false,
      'a maximum half-cycle phase separation between output samples must still fail the continuous clock-interval gate');
    const betweenSamplePeak = betweenSamplePeakCheck.observed as { maxCircularPhaseDifference: number; worstAt: number;
      worstInterval: { startAt: number; endAt: number } | null; controllerActiveIntervalCount: number;
      incompleteIntervalCount: number; unevaluableIntervalCount: number; interpolatedIntervalCount: number; measurementBasis: string };
    assert.equal(betweenSamplePeak.maxCircularPhaseDifference, 0.5);
    assert.ok(Math.abs(betweenSamplePeak.worstAt - 0.015) < 1e-9);
    assert.deepEqual(betweenSamplePeak.worstInterval, { startAt: 0, endAt: 1 / 30 });
    assert.ok(betweenSamplePeak.interpolatedIntervalCount > 0);
    assert.equal(betweenSamplePeak.interpolatedIntervalCount, betweenSamplePeak.controllerActiveIntervalCount);
    assert.equal(betweenSamplePeak.incompleteIntervalCount, 0);
    assert.equal(betweenSamplePeak.unevaluableIntervalCount, 0);
    assert.equal(betweenSamplePeak.measurementBasis, 'sampled_points_and_constant_speed_intervals');
    const lowerRatePeakCase = runAnimationGraphTimelineSuite({ ...graph, sampleRate: 15 }, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3, alternate: 0.75 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1, alternate: 0.2 } },
      observedBlendAnimationStartPhases: { idle: { idle: 0.499, alternate: 0 } },
      observedBlendAnimationAssetSetFingerprint: 'e'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'e'.repeat(64),
      expect: { blends: [{ at: 0.25, stateId: 'idle', blendSpace: {
        phaseSyncThroughout: { stateIds: ['idle', 'alternate'], maxCircularPhaseDifference: 0.4995 },
      } }] },
    }] });
    const lowerRatePeak = lowerRatePeakCase.cases[0]!.blendChecks[0]!.checks.find(check =>
      check.property === 'blendSpace.phaseSyncThroughout')!.observed as { maxCircularPhaseDifference: number; worstAt: number };
    assert.equal(lowerRatePeak.maxCircularPhaseDifference, betweenSamplePeak.maxCircularPhaseDifference,
      'constant-speed phase drift maxima must not depend on output sample density');
    assert.equal(lowerRatePeak.worstAt, betweenSamplePeak.worstAt);
    assert.throws(() => runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!,
      observedBlendAnimationLengths: { idle: { idle: 3 } },
      observedBlendAnimationPlaybackSpeeds: { idle: { idle: 1 } },
      observedBlendAnimationAssetSetFingerprint: 'a'.repeat(64), expectedBlendAnimationAssetSetFingerprint: 'a'.repeat(64),
    }] }), /must include every sample of BlendSpace controller idle/i,
    'saved timeline tests must reject partial runtime length measurements rather than mix timing sources');
    const mismatched = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!, initialParameters: { speed: 10 } }] });
    assert.equal(mismatched.status, 'failed');
    assert.ok(mismatched.cases[0]?.failures.some(failure => failure.expectation.endsWith('blendSpace.clipWeight:idle')));
    const mismatchedTarget = runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!, expect: { blends: [
      { ...suite.cases[0]!.expect!.blends![0]!, blendSpace: { parameterValue: { min: 5, max: 5 }, clips: [
        { stateId: 'idle', targetPoseContributionWeight: { min: 0.9 } },
      ] } },
    ] } }] });
    assert.equal(mismatchedTarget.status, 'failed');
    assert.ok(mismatchedTarget.cases[0]?.failures.some(failure => failure.expectation.endsWith('blendSpace.targetPoseContributionWeight:idle')));
    assert.throws(() => runAnimationGraphTimelineSuite(graph, recipes, { cases: [{ ...suite.cases[0]!, expect: { blends: [
      { at: 0.25, stateId: 'alternate', blendSpace: { clips: [{ stateId: 'idle', weight: { min: 0.5 } }] } },
    ] } }] }), /BlendSpace1D data for non-controller state alternate/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('2D directional BlendSpace timeline tests assert axis values, source weights, and live parameter changes', async () => {
  const f = await fixture();
  try {
    const baseRecipe = animationSchema.parse(f.idle.recipe);
    const recipes = [f.idle, f.attack, f.recovery].map(animation => ({ ...animationSchema.parse(animation.recipe),
      loop: baseRecipe.loop, priority: baseRecipe.priority, markers: [] }));
    const graph = { kind: 'animation_graph' as const, name: 'Directional locomotion', entryState: 'idle', sampleRate: 30,
      parameters: [
        { name: 'moveX', type: 'number' as const, defaultValue: 0.25, min: -1, max: 1 },
        { name: 'moveY', type: 'number' as const, defaultValue: 0.5, min: -1, max: 1 },
      ], states: [
        { id: 'idle', name: 'Directional controller', animationId: f.idle.id, speed: 1,
          blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
            { x: 0, y: 0, stateId: 'idle' }, { x: 1, y: 0, stateId: 'attack' }, { x: 0, y: 1, stateId: 'recovery' },
          ] } },
        { id: 'attack', name: 'Right strafe', animationId: f.attack.id, speed: 1 },
        { id: 'recovery', name: 'Forward', animationId: f.recovery.id, speed: 1 },
      ], transitions: [] };
    const report = runAnimationGraphTimelineSuite(graph, { [f.idle.id]: recipes[0]!, [f.attack.id]: recipes[1]!,
      [f.recovery.id]: recipes[2]! }, { cases: [{ id: 'directional-weights', name: 'Directional weights follow both axes', duration: 0.5,
        events: [{ at: 0.25, kind: 'set_parameters' as const, values: { moveX: 0, moveY: 0 } }], expect: { blends: [
          { at: 0, stateId: 'idle', blendSpace: { parameterValues: { x: { min: 0.25, max: 0.25 }, y: { min: 0.5, max: 0.5 } }, clips: [
            { stateId: 'idle', weight: { min: 0.25, max: 0.25 } }, { stateId: 'attack', weight: { min: 0.25, max: 0.25 } },
            { stateId: 'recovery', weight: { min: 0.5, max: 0.5 } },
          ] } },
          { at: 0.25, stateId: 'idle', blendSpace: { parameterValues: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 } }, clips: [
            { stateId: 'idle', weight: { min: 1, max: 1 } }, { stateId: 'attack', weight: { min: 0, max: 0 } },
            { stateId: 'recovery', weight: { min: 0, max: 0 } },
          ] } },
        ] } }] });
    assert.equal(report.status, 'passed', JSON.stringify(report.cases[0]?.failures));
    assert.deepEqual(report.cases[0]?.blendChecks.map(check => [check.status, check.blendSpace?.samples.length]), [['passed', 3], ['passed', 3]]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('throughout pose sampling stops adding loop key cycles after a state has faded out', async () => {
  const { graph, idle, attack, recovery } = await fixture();
  const idleRecipe = animationSchema.parse(idle.recipe);
  const shortLoopDuration = 0.1;
  const scaleTrack = (track: AnimationRecipe['tracks'][number]) => ({ ...track,
    keys: track.keys.map(key => ({ ...key, time: key.time / idleRecipe.duration * shortLoopDuration })) });
  const shortLoop = animationSchema.parse({ ...idleRecipe, duration: shortLoopDuration,
    tracks: idleRecipe.tracks.map(scaleTrack),
    layers: idleRecipe.layers?.map(layer => ({ ...layer, tracks: layer.tracks.map(scaleTrack) })),
    rootMotion: idleRecipe.rootMotion ? scaleTrack(idleRecipe.rootMotion) : undefined,
    markers: idleRecipe.markers.map(marker => ({ ...marker, time: marker.time / idleRecipe.duration * shortLoopDuration })) });
  const shortLivedLoopGraph = { ...graph, transitions: [graph.transitions[0]!] };
  const report = runAnimationGraphTimelineSuite(shortLivedLoopGraph,
    { [idle.id]: shortLoop, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { cases: [{ id: 'long-window', name: 'Short idle loop does not consume later sample budget', duration: 120,
      events: [{ at: 0.01, kind: 'trigger', trigger: 'Attack' }], expect: { poses: [{ at: 0.01, joint: 'UpperTorso',
        expectedPosition: [0, 0, 0], positionToleranceStuds: 100,
        throughout: { start: 0, end: 120, sampleRateHz: 1 } }] } }] });
  assert.equal(report.status, 'passed', JSON.stringify(report.cases[0]?.failures));
  const poseCheck = report.cases[0]?.poseChecks[0];
  assert.ok(poseCheck?.throughoutChecks && poseCheck.throughoutChecks.length > 0);
  assert.ok(poseCheck.throughoutChecks.every(check => check.passed));

  const denseShortLoop = animationSchema.parse({ ...shortLoop, tracks: shortLoop.tracks.map(track => track.joint === 'UpperTorso'
    ? { ...track, keys: Array.from({ length: 16 }, (_, index) => ({ ...track.keys[0]!, time: index * shortLoopDuration / 15 })) }
    : track) });
  const reentryGraph = { ...graph, transitions: [
    { ...graph.transitions[0]!, blendSeconds: 5 },
    { id: 'returnToIdle', from: 'attack', to: 'idle', trigger: 'Return', blendSeconds: 0 },
    { id: 'leaveReenteredIdle', from: 'idle', to: 'attack', trigger: 'AttackAgain', blendSeconds: 0 },
  ] };
  const reentry = runAnimationGraphTimelineSuite(reentryGraph,
    { [idle.id]: denseShortLoop, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe },
    { cases: [{ id: 'reentry-window', name: 'Re-entering idle replaces its fading playback session', duration: 5.1,
      events: [{ at: 0.01, kind: 'trigger', trigger: 'Attack' }, { at: 0.05, kind: 'trigger', trigger: 'Return' },
        { at: 0.06, kind: 'trigger', trigger: 'AttackAgain' }],
      expect: { poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 100,
        throughout: { start: 0, end: 5.1, sampleRateHz: 1 } }] } }] });
  assert.equal(reentry.status, 'passed', JSON.stringify(reentry.cases[0]?.failures));
  const reentryCheck = reentry.cases[0]?.poseChecks[0];
  assert.ok(reentryCheck?.throughoutChecks && reentryCheck.throughoutChecks.length > 0);
  assert.ok(reentryCheck.throughoutChecks.every(check => check.passed));

  const lateLoopGraph = { ...graph, transitions: [
    { id: 'startLateLoop', from: 'idle', to: 'attack', trigger: 'Start', blendSeconds: 0 },
    { id: 'stopLateLoop', from: 'attack', to: 'recovery', trigger: 'Stop', blendSeconds: 0 },
  ] };
  const flatRecipe = animationSchema.parse({ kind: 'animation', name: 'Flat boundary clip', duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }], markers: [] });
  const minimalLoop = animationSchema.parse({ ...flatRecipe, duration: 0.1, loop: true,
    tracks: flatRecipe.tracks.map(track => ({ ...track,
      keys: track.keys.map(key => ({ ...key, time: key.time * 0.1 })) })) });
  const lateLoop = runAnimationGraphTimelineSuite(lateLoopGraph,
    { [idle.id]: flatRecipe, [attack.id]: minimalLoop, [recovery.id]: flatRecipe },
    { cases: [{ id: 'late-loop-window', name: 'Loop key sampling starts at playback time zero', duration: 2,
      events: [{ at: 1, kind: 'trigger', trigger: 'Start' }, { at: 1.05, kind: 'trigger', trigger: 'Stop' }],
      expect: { poses: [{ at: 1.02, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 100,
        throughout: { start: 0, end: 2, sampleRateHz: 1 } }] } }] });
  assert.equal(lateLoop.status, 'passed', JSON.stringify(lateLoop.cases[0]?.failures));
  const lateLoopObserved = lateLoop.cases[0]?.poseChecks[0]?.throughoutChecks?.[0]?.observed as { criticalSampleCount: number };
  assert.equal(lateLoopObserved.criticalSampleCount, 1,
    'only the transition/fade boundary should be added beyond the uniform grid; negative loop cycles must not fabricate pre-start samples');
});

test('temporal graph suite rejects vacuous assertions, duplicate case IDs, out-of-window events and excessive aggregate work', async () => {
  const emptyExpectations = { cases: [{ id: 'empty', name: 'No assertions', duration: 1, events: [], expect: {} }] };
  assert.throws(() => animationGraphTimelineSuiteSchema.parse(emptyExpectations), /at least one explicit expectation/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'badOrderingGate', name: 'Invalid ordering gate', duration: 1,
    events: [], expect: { finalState: 'idle', maxAmbiguousEventOrderingCollisions: 20001 } }] }), /too_big|less than or equal to 20000/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [
    { id: 'same', name: 'One', duration: 1, events: [], expect: { finalState: 'idle' } },
    { id: 'same', name: 'Two', duration: 1, events: [], expect: { finalState: 'idle' } },
  ] }), /IDs must be unique/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'late', name: 'Late event', duration: 1,
    events: [{ at: 2, kind: 'trigger', trigger: 'Attack' }], expect: { finalState: 'idle' } }] }), /cannot exceed case duration/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'lateBlend', name: 'Late blend assertion', duration: 1,
    events: [], expect: { blends: [{ at: 2, stateId: 'idle', present: false }] } }] }), /blend sample time cannot exceed case duration/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'emptyBlend', name: 'Empty blend assertion', duration: 1,
    events: [], expect: { blends: [{ at: 0.5, stateId: 'idle' }] } }] }), /must check track presence|track property/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'duplicatePlaybackClock', name: 'Duplicate clock assertion', duration: 1,
    events: [], expect: { playbackClock: [
      { transitionId: 'restartIdle', decision: 'studio_observed_preserved' },
      { transitionId: 'restartIdle', decision: 'studio_observed_reset' },
    ] } }] }), /transition occurrence may be asserted only once/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'invalidPose', name: 'Pose tolerance is required', duration: 1,
    events: [], expect: { poses: [{ at: 0.5, joint: 'UpperTorso', expectedPosition: [0, 0, 0] }] } }] }), /positionToleranceStuds/);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'badWindow', name: 'Window reversed', duration: 1,
    events: [], expect: { poses: [{ at: 0.5, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0,
      throughout: { start: 0.8, end: 0.2 } }] } }] }), /cannot precede/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'lateWindow', name: 'Window past duration', duration: 1,
    events: [], expect: { poses: [{ at: 0.5, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0,
      throughout: { start: 0.2, end: 1.2 } }] } }] }), /pose window cannot exceed case duration/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: [{ id: 'unboundedWindow', name: 'Window too dense', duration: 120,
    events: [], expect: { poses: [{ at: 0, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0,
      throughout: { start: 0, end: 120, sampleRateHz: 120 } }] } }] }), /512 explicit pose\/blend sample times/i);
  const { graph, idle, attack, recovery } = await fixture();
  assert.throws(() => runAnimationGraphTimelineSuite(graph, { [idle.id]: idle.recipe, [attack.id]: attack.recipe, [recovery.id]: recovery.recipe }, {
    cases: [{ id: 'unknownPose', name: 'Unknown pose joint', duration: 1,
      events: [], expect: { poses: [{ at: 0.5, joint: 'MissingJoint', expectedPosition: [0, 0, 0], positionToleranceStuds: 0 }] } }],
  }), /unknown animated joint/);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: Array.from({ length: 9 }, (_, index) => ({
    id: `blend${index}`, name: `Blend ${index}`, duration: 1, events: [], expect: { blends: Array.from({ length: 64 }, () => ({ at: 0.5, stateId: 'idle', present: false })) },
  })) }), /512 total blend assertions/i);
  assert.throws(() => animationGraphTimelineSuiteSchema.parse({ cases: Array.from({ length: 11 }, (_, index) => ({
    id: `case${index}`, name: `Case ${index}`, duration: 120, events: [], expect: { finalState: 'idle' },
  })) }), /1,200 aggregate simulated seconds/i);
});

test('guarded transition evaluation uses typed defaults, ordered priorities and explainable branch evidence', () => {
  const graph = {
    kind: 'animation_graph' as const, name: 'Guarded combat', entryState: 'idle', sampleRate: 30,
    parameters: [
      { name: 'stamina', type: 'number' as const, defaultValue: 0.3, min: 0, max: 1 },
      { name: 'weapon', type: 'string' as const, defaultValue: 'sword' },
      { name: 'grounded', type: 'boolean' as const, defaultValue: true },
    ],
    states: ['idle', 'heavy', 'light', 'fallback'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'heavyAttack', from: 'idle', to: 'heavy', trigger: 'Attack', priority: 10, blendSeconds: 0.1, guards: [
        { parameter: 'stamina', operator: 'gte', value: 0.5 }, { parameter: 'weapon', operator: 'eq', value: 'bow' }, { parameter: 'grounded', operator: 'eq', value: true },
      ] },
      { id: 'lightAttack', from: 'idle', to: 'light', trigger: 'Attack', priority: 5, blendSeconds: 0.1, guards: [
        { parameter: 'stamina', operator: 'gte', value: 0.2 }, { parameter: 'weapon', operator: 'eq', value: 'sword' },
      ] },
      { id: 'attackFallback', from: 'idle', to: 'fallback', trigger: 'Attack', priority: -10, blendSeconds: 0, guards: [] },
    ],
  };
  const selected = evaluateAnimationGraphTransition(graph, 'idle', 'attack');
  assert.equal(selected.selectedTransition?.id, 'lightAttack');
  assert.deepEqual(selected.matchedTransitionIds, ['lightAttack', 'attackFallback']);
  assert.deepEqual(selected.shadowedTransitionIds, ['attackFallback']);
  assert.deepEqual(selected.rejectedBranches[0]?.failedGuards.map(guard => guard.parameter), ['stamina', 'weapon']);
  assert.equal(selected.parameterValues.stamina, 0.3, 'omitted values should use the declaration default');
  assert.equal(selected.selectedTransition?.selectionReason, 'highest-priority branch whose guards all matched');

  const fallback = evaluateAnimationGraphTransition(graph, 'idle', 'Attack', { stamina: 0.1 });
  assert.equal(fallback.selectedTransition?.id, 'attackFallback');
  const noMatch = evaluateAnimationGraphTransition(graph, 'idle', 'Jump');
  assert.equal(noMatch.noTransitionMatched, true);
  assert.equal(noMatch.selectedTransition, null);
  assert.equal(noMatch.noTransitionReason, 'no_transition_for_state_and_trigger');
  assert.equal(evaluateAnimationGraphTransition({ ...graph, transitions: graph.transitions.slice(0, 2) }, 'idle', 'Attack',
    { stamina: 0.1, weapon: 'axe', grounded: false }).noTransitionReason,
    'all_candidate_guards_failed');
  assert.throws(() => evaluateAnimationGraphTransition(graph, 'idle', 'Attack', { stamina: 2 }), /outside its declared range/);
  assert.throws(() => evaluateAnimationGraphTransition(graph, 'idle', 'Attack', { missing: true }), /Unknown graph parameter/);
  assert.throws(() => evaluateAnimationGraphTransition(graph, 'unknown', 'Attack'), /Unknown current graph state/);
  assert.throws(() => animationGraphSchema.parse({ ...graph, transitions: [
    ...graph.transitions, { id: 'samePriority', from: 'idle', to: 'heavy', trigger: 'Attack', priority: 5, blendSeconds: 0.1, guards: [] },
  ] }), /distinct priorities/);
  assert.throws(() => animationGraphSchema.parse({ ...graph, transitions: [
    { ...graph.transitions[0]!, guards: [{ parameter: 'grounded', operator: 'gt', value: true }] }, ...graph.transitions.slice(1),
  ] }), /numeric graph parameters/);
  assert.throws(() => animationGraphSchema.parse({ ...graph, parameters: [{ name: 'stamina', type: 'number', defaultValue: 2, min: 0, max: 1 }, ...graph.parameters.slice(1)] }), /above max/);
});

test('graph diagnostics prove guarded route reachability and return a playable parameter witness', () => {
  const base = {
    kind: 'animation_graph' as const, name: 'Guard proof', entryState: 'idle', sampleRate: 30,
    parameters: [
      { name: 'stamina', type: 'number' as const, defaultValue: 0.3, min: 0, max: 1 },
      { name: 'grounded', type: 'boolean' as const, defaultValue: true },
    ],
    states: ['idle', 'heavy', 'light', 'fallback'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'heavy', from: 'idle', to: 'heavy', trigger: 'Attack', priority: 10, blendSeconds: 0.1,
        guards: [{ parameter: 'stamina', operator: 'gte' as const, value: 0.5 }, { parameter: 'grounded', operator: 'eq' as const, value: true }] },
      { id: 'light', from: 'idle', to: 'light', trigger: 'attack', priority: 5, blendSeconds: 0.1,
        guards: [{ parameter: 'stamina', operator: 'gte' as const, value: 0.2 }] },
      { id: 'fallback', from: 'idle', to: 'fallback', trigger: 'ATTACK', priority: 0, blendSeconds: 0, guards: [] },
    ],
  };
  const diagnostics = diagnoseAnimationGraph(base);
  const route = new Map(diagnostics.guardReachability.map(item => [item.transitionId, item]));
  assert.equal(route.get('heavy')?.status, 'reachable');
  assert.equal(route.get('light')?.status, 'reachable');
  assert.equal(route.get('fallback')?.status, 'reachable');
  assert.ok(route.get('heavy')?.witness && evaluateAnimationGraphTransition(base, 'idle', 'Attack', route.get('heavy')!.witness).selectedTransition?.id === 'heavy');
  assert.ok(route.get('light')?.witness && evaluateAnimationGraphTransition(base, 'idle', 'Attack', route.get('light')!.witness).selectedTransition?.id === 'light');
  assert.ok(route.get('fallback')?.witness && evaluateAnimationGraphTransition(base, 'idle', 'Attack', route.get('fallback')!.witness).selectedTransition?.id === 'fallback');
});

test('graph guard analysis detects conditional shadowing, contradictory ranges and independent fallback witnesses', () => {
  const base = {
    kind: 'animation_graph' as const, name: 'Shadow proof', entryState: 'idle', sampleRate: 30,
    parameters: [
      { name: 'x', type: 'number' as const, defaultValue: 0, min: -2, max: 2 },
      { name: 'enabled', type: 'boolean' as const, defaultValue: false },
    ],
    states: ['idle', 'first', 'shadowed', 'contradiction', 'fallback'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'first', from: 'idle', to: 'first', trigger: 'Go', priority: 30, blendSeconds: 0.1,
        guards: [{ parameter: 'x', operator: 'gte' as const, value: 0 }] },
      { id: 'shadowed', from: 'idle', to: 'shadowed', trigger: 'Go', priority: 20, blendSeconds: 0.1,
        guards: [{ parameter: 'x', operator: 'gt' as const, value: 1 }] },
      { id: 'contradiction', from: 'idle', to: 'contradiction', trigger: 'Go', priority: 10, blendSeconds: 0.1,
        guards: [{ parameter: 'x', operator: 'gt' as const, value: 1 }, { parameter: 'x', operator: 'lt' as const, value: 0 }] },
      { id: 'fallback', from: 'idle', to: 'fallback', trigger: 'Go', priority: 0, blendSeconds: 0.1,
        guards: [{ parameter: 'enabled', operator: 'eq' as const, value: true }] },
    ],
  };
  const route = new Map(diagnoseAnimationGraph(base).guardReachability.map(item => [item.transitionId, item]));
  assert.equal(route.get('first')?.status, 'reachable');
  assert.equal(route.get('shadowed')?.status, 'unreachable');
  assert.match(route.get('shadowed')?.reason ?? '', /higher-priority/);
  assert.equal(route.get('contradiction')?.status, 'unreachable');
  assert.match(route.get('contradiction')?.reason ?? '', /contradictory/);
  assert.equal(route.get('fallback')?.status, 'reachable');
  assert.equal(route.get('fallback')?.witness?.enabled, true);
});

test('graph diagnostics keep case-distinct source states separate while matching trigger names case-insensitively', () => {
  const graph = {
    kind: 'animation_graph' as const, name: 'Case-sensitive source states', entryState: 'Idle', sampleRate: 30,
    parameters: [{ name: 'armed', type: 'boolean' as const, defaultValue: false }],
    states: ['Idle', 'idle', 'ready', 'other'].map(id => ({ id, name: id,
      animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'readyWhenArmed', from: 'Idle', to: 'ready', trigger: 'Go', priority: 0, blendSeconds: 0.1,
        guards: [{ parameter: 'armed', operator: 'eq' as const, value: true }] },
      { id: 'otherUnconditional', from: 'idle', to: 'other', trigger: 'go', priority: 10, blendSeconds: 0.1, guards: [] },
    ],
  };
  const samePriorityDifferentStates = { ...graph, transitions: graph.transitions.map(transition => ({ ...transition, priority: 0 })) };
  assert.doesNotThrow(() => animationGraphSchema.parse(samePriorityDifferentStates),
    'equal branch priorities are valid when the source state IDs differ by case');
  const diagnostics = diagnoseAnimationGraph(graph);
  assert.equal(diagnostics.transitionBranches.length, 2);
  assert.deepEqual(diagnostics.transitionBranches.map(branch => branch.from).sort(), ['Idle', 'idle']);
  assert.deepEqual(diagnostics.transitionBranches.find(branch => branch.from === 'Idle')?.branches.map(branch => branch.id), ['readyWhenArmed']);
  const route = new Map(diagnostics.guardReachability.map(item => [item.transitionId, item]));
  assert.equal(route.get('readyWhenArmed')?.localStatus, 'reachable',
    'an unconditional branch from a case-distinct state must not shadow this transition');
  assert.equal(route.get('readyWhenArmed')?.status, 'reachable');
  assert.equal(route.get('otherUnconditional')?.localStatus, 'reachable');
  assert.equal(route.get('otherUnconditional')?.status, 'unreachable',
    'the second state remains outside entry-state reachability');
});

test('graph guard witnesses stay inside declared numeric parameter bounds', () => {
  const graph = {
    kind: 'animation_graph' as const, name: 'Bounded guard domain', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 }],
    states: ['idle', 'above', 'below'].map(id => ({ id, name: id,
      animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'aboveRange', from: 'idle', to: 'above', trigger: 'Above', blendSeconds: 0.1,
        guards: [{ parameter: 'speed', operator: 'gt' as const, value: 1 }] },
      { id: 'belowRange', from: 'idle', to: 'below', trigger: 'Below', blendSeconds: 0.1,
        guards: [{ parameter: 'speed', operator: 'lt' as const, value: 0 }] },
    ],
  };
  const route = new Map(diagnoseAnimationGraph(graph).guardReachability.map(item => [item.transitionId, item]));
  for (const id of ['aboveRange', 'belowRange']) {
    assert.equal(route.get(id)?.localStatus, 'unreachable');
    assert.equal(route.get(id)?.status, 'unreachable');
    assert.equal(route.get(id)?.witness, undefined, 'impossible bounds must never be returned as a witness');
  }
});

test('guard reachability agrees with the runtime evaluator across numeric truth partitions', () => {
  const conditions: Array<{ operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number }> = [
    { operator: 'eq', value: -1 }, { operator: 'neq', value: -0.5 }, { operator: 'gt', value: 0 },
    { operator: 'gte', value: 0.5 }, { operator: 'lt', value: 1 }, { operator: 'lte', value: 2 },
    { operator: 'gt', value: -2 }, { operator: 'eq', value: 2 },
  ];
  const guardSets = conditions.map(condition => [condition]);
  for (let left = 0; left < conditions.length; left++) for (let right = left + 1; right < conditions.length; right++) {
    guardSets.push([conditions[left]!, conditions[right]!]);
  }
  const graph = {
    kind: 'animation_graph' as const, name: 'Differential guard audit', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'x', type: 'number' as const, defaultValue: 0, min: -1, max: 1 }],
    states: ['idle', ...guardSets.map((_guards, index) => `target${index}`)].map(id => ({ id, name: id,
      animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: guardSets.map((guards, index) => ({ id: `route${index}`, from: 'idle', to: `target${index}`,
      trigger: 'Go', priority: guardSets.length - index, blendSeconds: 0.1,
      guards: guards.map(guard => ({ parameter: 'x', operator: guard.operator, value: guard.value })) })),
  };
  const boundaries = [...new Set([-1, 1, ...conditions.map(condition => condition.value).filter(value => value >= -1 && value <= 1)])]
    .sort((left, right) => left - right);
  const representativeValues = new Set(boundaries);
  for (let index = 1; index < boundaries.length; index++) representativeValues.add((boundaries[index - 1]! + boundaries[index]!) / 2);
  const selectable = new Set<string>();
  for (const x of representativeValues) {
    const selected = evaluateAnimationGraphTransition(graph, 'idle', 'go', { x }).selectedTransition;
    if (selected) selectable.add(selected.id);
  }
  const diagnostics = diagnoseAnimationGraph(graph);
  for (const result of diagnostics.guardReachability) {
    assert.notEqual(result.localStatus, 'unknown', `bounded fixture should decide ${result.transitionId}`);
    assert.equal(result.localStatus === 'reachable', selectable.has(result.transitionId),
      `${result.transitionId} diagnostics should agree with actual priority/guard evaluation`);
    if (result.localStatus === 'reachable') {
      const witness = result.witness;
      assert.ok(witness && typeof witness.x === 'number' && witness.x >= -1 && witness.x <= 1);
      assert.equal(evaluateAnimationGraphTransition(graph, 'idle', 'Go', witness).selectedTransition?.id, result.transitionId,
        `${result.transitionId} should return an executable witness`);
    }
  }
});

test('graph preview emits shortest entry-to-branch trigger scenarios and separates local from entry reachability', () => {
  const graph = {
    kind: 'animation_graph' as const, name: 'Scenario coverage', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'armed', type: 'boolean' as const, defaultValue: false },
      { name: 'x', type: 'number' as const, defaultValue: 0, min: -1, max: 1 }],
    states: ['idle', 'approach', 'done', 'phantom', 'hidden'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'begin', from: 'idle', to: 'approach', trigger: 'Begin', blendSeconds: 0.1,
        guards: [{ parameter: 'armed', operator: 'eq' as const, value: true }] },
      { id: 'finish', from: 'approach', to: 'done', trigger: 'AnimationEnded', blendSeconds: 0.1, guards: [] },
      { id: 'impossibleEntry', from: 'idle', to: 'phantom', trigger: 'Impossible', blendSeconds: 0.1,
        guards: [{ parameter: 'x', operator: 'gt' as const, value: 0.5 }, { parameter: 'x', operator: 'lt' as const, value: 0 }] },
      { id: 'locallyPossible', from: 'phantom', to: 'hidden', trigger: 'Continue', blendSeconds: 0.1, guards: [] },
    ],
  };
  const diagnostics = diagnoseAnimationGraph(graph);
  const routes = new Map(diagnostics.guardReachability.map(item => [item.transitionId, item]));
  const scenario = diagnostics.triggerScenarios.find(item => item.targetTransitionId === 'finish');
  assert.deepEqual(scenario?.transitionPath, ['begin', 'finish']);
  assert.deepEqual(scenario?.statePath, ['idle', 'approach', 'done']);
  assert.equal(scenario?.steps[0]?.parameterValues.armed, true);
  assert.equal(scenario?.steps[1]?.triggerSource, 'animation_end');
  let state = graph.entryState;
  for (const step of scenario?.steps ?? []) {
    const evaluated = evaluateAnimationGraphTransition(graph, state, step.trigger, step.parameterValues);
    assert.equal(evaluated.selectedTransition?.id, step.expectedTransitionId);
    state = evaluated.selectedTransition!.to;
  }
  assert.equal(routes.get('impossibleEntry')?.status, 'unreachable');
  assert.equal(routes.get('locallyPossible')?.localStatus, 'reachable');
  assert.equal(routes.get('locallyPossible')?.entryReachable, false);
  assert.equal(routes.get('locallyPossible')?.status, 'unreachable');
  assert.ok(diagnostics.triggerCoverage.entryUnreachableStateIds.includes('phantom'));
  assert.ok(!diagnostics.triggerScenarios.some(item => item.targetTransitionId === 'locallyPossible'));
});

test('saved graph pins animation contents, rejects stale reads, and child revisions explicitly adopt changes', async () => {
  const f = await fixture();
  const saved = await f.library.save(f.graph);
  assert.equal(saved.sourceFingerprints[0], fingerprint(f.idle.recipe));
  assert.equal((await f.library.get(saved.id)).diagnostics.unreachableStateIds.length, 0);
  const sourcePath = join(f.root, 'animations', `${f.attack.id}.json`);
  const changed = JSON.parse(await readFile(sourcePath, 'utf8')) as typeof f.attack;
  changed.recipe.name = 'Changed attack';
  await writeFile(sourcePath, JSON.stringify(changed));
  await assert.rejects(() => f.library.get(saved.id), /stale source assets.*attack/i);
  assert.equal((await f.library.list()).graphs[0]!.sourceIntegrity, 'stale');
  const child = await f.library.save(f.graph, saved.id);
  assert.equal(child.parentId, saved.id);
  assert.equal((await f.library.get(child.id)).sourceFingerprints[1], fingerprint(changed.recipe));
});

test('graph path preview composes transition speeds and crossfades, and rejects invalid or stale route commits', async () => {
  const f = await fixture();
  const saved = await f.library.save(f.graph);
  const preview = await f.library.previewPath(saved.id, ['beginAttack', 'finishAttack']);
  assert.deepEqual(preview.statePath, ['idle', 'attack', 'recovery']);
  assert.equal(preview.sequence.clips[0]!.start, 0);
  assert.equal(preview.sequence.clips[0]!.fadeOut, 0.2);
  assert.equal(preview.sequence.clips[1]!.speed, 2);
  assert.equal(preview.sequence.clips[1]!.start, 1.8);
  assert.equal(preview.sequence.clips[1]!.fadeIn, 0.2);
  assert.equal(preview.sequence.clips[1]!.fadeOut, 0.1);
  assert.ok(Math.abs(preview.sequence.clips[2]!.start - 2.2) < 1e-9);
  assert.ok(Math.abs(preview.sequencePreview.animation.duration - 3.7) < 1e-9);
  assert.match(preview.candidateFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(() => f.library.previewPath(saved.id, ['finishAttack']), /starts at attack/);
  await assert.rejects(() => f.library.previewPath(saved.id, ['beginAttack', 'returnIdle']), /starts at recovery/);
  const staleGraphPath = join(f.root, 'graphs', `${saved.id}.json`);
  const record = JSON.parse(await readFile(staleGraphPath, 'utf8')) as { sourceFingerprints: string[] };
  record.sourceFingerprints[0] = '0'.repeat(64);
  await writeFile(staleGraphPath, JSON.stringify(record));
  await assert.rejects(() => f.library.previewPath(saved.id, ['beginAttack']), /stale source assets/);
});

test('graph path rejects blends longer than either adjacent state playback', async () => {
  const f = await fixture();
  const invalid = { ...f.graph, transitions: f.graph.transitions.map(transition => transition.id === 'beginAttack' ? { ...transition, blendSeconds: 5 } : transition) };
  const saved = await f.library.save(animationGraphSchema.parse(invalid));
  await assert.rejects(() => f.library.previewPath(saved.id, ['beginAttack']), /exceeds one of its adjacent state playback durations/);
});

test('deterministic route assets are idempotent and reject identity collisions', async () => {
  const f = await fixture();
  const stableId = '00000000-0000-5000-8000-000000000123';
  const candidate = animationPreset('idle', 'Deterministic output', 1, 0.5);
  const [first, retry] = await Promise.all([
    f.animations.saveIdempotent(candidate, stableId),
    f.animations.saveIdempotent(candidate, stableId),
  ]);
  assert.equal(first.id, stableId);
  assert.equal(retry.id, stableId);
  assert.deepEqual(retry.recipe, candidate);
  await assert.rejects(() => f.animations.saveIdempotent({ ...candidate, name: 'Collision' }, stableId), /already bound to different recipe content/);
});

test('idempotent child saves preserve lineage and reject changed parent identity', async () => {
  const f = await fixture();
  const parent = await f.animations.save(animationPreset('idle', 'Blueprint parent', 1, 0.4));
  const candidate = animationPreset('slash', 'Blueprint child', 1.2, 0.7);
  const stableId = '00000000-0000-5000-8000-000000000456';
  const [first, retry] = await Promise.all([
    f.animations.saveIdempotent(candidate, stableId, parent.id),
    f.animations.saveIdempotent(candidate, stableId, parent.id),
  ]);
  assert.equal(first.id, stableId);
  assert.equal(first.parentId, parent.id);
  assert.equal(retry.parentId, parent.id);
  await assert.rejects(() => f.animations.saveIdempotent(candidate, stableId), /lineage/);
});
