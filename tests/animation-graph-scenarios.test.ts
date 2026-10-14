import assert from 'node:assert/strict';
import test from 'node:test';
import { runAnimationGraphScenarioSuite } from '../src/animation-graph-scenarios.js';
import { animationGraphFingerprint } from '../src/animation-graph.js';

function graph() {
  return {
    kind: 'animation_graph' as const, name: 'Scenario test graph', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'stamina', type: 'number' as const, defaultValue: 0.4, min: 0, max: 1 }],
    states: ['idle', 'heavy', 'light', 'recover'].map(id => ({ id, name: id, animationId: '00000000-0000-4000-8000-000000000001', speed: 1 })),
    transitions: [
      { id: 'heavyAttack', from: 'idle', to: 'heavy', trigger: 'Attack', priority: 10, blendSeconds: 0.1,
        guards: [{ parameter: 'stamina', operator: 'gte' as const, value: 0.7 }] },
      { id: 'lightAttack', from: 'idle', to: 'light', trigger: 'Attack', priority: 1, blendSeconds: 0.1, guards: [] },
      { id: 'recoverHeavy', from: 'heavy', to: 'recover', trigger: 'AnimationEnded', blendSeconds: 0.15, guards: [] },
      { id: 'recoverLight', from: 'light', to: 'recover', trigger: 'AnimationEnded', blendSeconds: 0.15, guards: [] },
    ],
  };
}

test('graph scenario runner executes stateful parameter updates and reports branch/state coverage', () => {
  const source = graph();
  const result = runAnimationGraphScenarioSuite(source, { scenarios: [
    { id: 'heavy-route', name: 'Heavy attack path', steps: [
      { trigger: 'Attack', setParameters: { stamina: 0.8 }, expect: { kind: 'transition', transitionId: 'heavyAttack' } },
      { trigger: 'AnimationEnded', expect: { kind: 'transition', transitionId: 'recoverHeavy' } },
    ] },
    { id: 'light-route', name: 'Low-stamina fallback', steps: [
      { trigger: 'Attack', setParameters: { stamina: 0.2 }, expect: { kind: 'transition', transitionId: 'lightAttack' } },
      { trigger: 'AnimationEnded', expect: { kind: 'transition', transitionId: 'recoverLight' } },
    ] },
    { id: 'negative-route', name: 'Unrecognized action', steps: [
      { trigger: 'Dodge', expect: { kind: 'no_transition' } },
    ] },
  ] });
  assert.equal(result.status, 'passed');
  assert.equal(result.graphFingerprint, animationGraphFingerprint(source));
  assert.deepEqual(result.summary, { scenarios: 3, passed: 3, failed: 0, steps: 5, coveredStates: 4, totalStates: 4, coveredTransitions: 4, totalTransitions: 4 });
  assert.deepEqual(result.uncoveredTransitionIds, []);
  const heavy = result.scenarios.find(scenario => scenario.id === 'heavy-route')!;
  assert.equal(heavy.steps[1]?.stateBefore, 'heavy');
  assert.equal(heavy.steps[1]?.actualStateAfter, 'recover');
});

test('scenario runner reports wrong expectations and invalid parameter updates without aborting later cases', () => {
  const result = runAnimationGraphScenarioSuite(graph(), { scenarios: [
    { id: 'bad-branch', name: 'Wrong expected branch', steps: [
      { trigger: 'Attack', setParameters: { stamina: 0.9 }, expect: { kind: 'transition', transitionId: 'lightAttack' } },
    ] },
    { id: 'bad-value', name: 'Out-of-range value', steps: [
      { trigger: 'Attack', setParameters: { stamina: 2 }, expect: { kind: 'transition', transitionId: 'heavyAttack' } },
    ] },
  ] });
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.failed, 2);
  assert.equal(result.scenarios[0]?.steps[0]?.actualTransitionId, 'heavyAttack', 'simulation should follow the actual selected branch after an expectation mismatch');
  assert.match(result.scenarios[1]?.steps[0]?.error ?? '', /outside its declared range/);
  assert.deepEqual(result.scenarios[1]?.visitedStateIds, ['idle']);
});

test('scenario runner identifies an expected transition that cannot run from the current state or trigger', () => {
  const result = runAnimationGraphScenarioSuite(graph(), { scenarios: [
    { id: 'wrong-source', name: 'Expect the wrong state route', steps: [
      { trigger: 'Attack', setParameters: { stamina: 0.2 }, expect: { kind: 'transition', transitionId: 'lightAttack' } },
      { trigger: 'AnimationEnded', expect: { kind: 'transition', transitionId: 'recoverHeavy' } },
    ] },
    { id: 'wrong-trigger', name: 'Expect the wrong trigger route', steps: [
      { trigger: 'Attack', setParameters: { stamina: 0.2 }, expect: { kind: 'transition', transitionId: 'lightAttack' } },
      { trigger: 'Attack', expect: { kind: 'transition', transitionId: 'recoverLight' } },
    ] },
  ] });
  const sourceError = result.scenarios[0]?.steps[1];
  assert.match(sourceError?.expectationError ?? '', /starts in heavy.*currently in light/);
  assert.equal(sourceError?.actualTransitionId, 'recoverLight', 'the trace should still follow actual runtime selection after diagnosing the bad assertion');
  assert.match(result.scenarios[1]?.steps[1]?.expectationError ?? '', /listens for AnimationEnded, not Attack/);
});

test('scenario suite and report fingerprints are deterministic, content-sensitive, and replay-stable', () => {
  const source = graph();
  const suite = { scenarios: [{ id: 'route', name: 'Light route', steps: [
    { trigger: 'Attack', setParameters: { stamina: 0.2 }, expect: { kind: 'transition', transitionId: 'lightAttack' } },
  ] }] };
  const first = runAnimationGraphScenarioSuite(source, suite);
  const replay = runAnimationGraphScenarioSuite(source, structuredClone(suite));
  const changed = runAnimationGraphScenarioSuite(source, { scenarios: [{ ...suite.scenarios[0]!, steps: [
    { ...suite.scenarios[0]!.steps[0]!, setParameters: { stamina: 0.1 } },
  ] }] });
  assert.equal(first.suiteFingerprint, replay.suiteFingerprint);
  assert.equal(first.reportFingerprint, replay.reportFingerprint);
  assert.notEqual(first.suiteFingerprint, changed.suiteFingerprint);
  assert.notEqual(first.reportFingerprint, changed.reportFingerprint);
});

test('scenario runner rejects duplicate IDs and assertions that reference unknown graph transitions', () => {
  const duplicate = { scenarios: [
    { id: 'same', name: 'First', steps: [{ trigger: 'Attack', expect: { kind: 'no_transition' } }] },
    { id: 'same', name: 'Second', steps: [{ trigger: 'Attack', expect: { kind: 'no_transition' } }] },
  ] };
  assert.throws(() => runAnimationGraphScenarioSuite(graph(), duplicate), /IDs must be unique/);
  assert.throws(() => runAnimationGraphScenarioSuite(graph(), { scenarios: [
    { id: 'unknown', name: 'Unknown route', steps: [{ trigger: 'Attack', expect: { kind: 'transition', transitionId: 'missing' } }] },
  ] }), /expects unknown transition/);
});

test('scenario suites enforce a total-step work bound across individually valid scenarios', () => {
  const step = { trigger: 'Unknown', expect: { kind: 'no_transition' as const } };
  const scenarios = Array.from({ length: 5 }, (_, index) => ({ id: `batch${index}`, name: `Batch ${index}`,
    steps: Array.from({ length: index === 4 ? 1 : 64 }, () => step) }));
  assert.throws(() => runAnimationGraphScenarioSuite(graph(), { scenarios }), /cannot exceed 256 total trigger steps/);
});
