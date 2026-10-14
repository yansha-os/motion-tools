import test from 'node:test';
import assert from 'node:assert/strict';
import { animationPreset } from '../src/recipes.js';
import { evaluateAnimationBenchmarkGate, runAnimationBenchmark } from '../src/animation-benchmark.js';

function suite() {
  const recipe = animationPreset('idle', 'Benchmark idle', 2, 1);
  recipe.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.2, end: 1.8 }];
  recipe.markers = [{ name: 'Settle', time: 1.5 }];
  recipe.tracks.push({ joint: 'LeftFoot', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] });
  return { schemaVersion: 1, cases: [{
    id: 'idle-stable', name: 'Stable idle', recipe,
    expectations: [
      { id: 'recipe-valid', description: 'The recipe is valid.', outcome: 'pass', evidence: 'Strict schema validation.' },
      { id: 'contact-track:LeftFoot:0.2:1.8', description: 'The support effector has a track.', outcome: 'pass', evidence: 'Track name and contact effector match.' },
    ],
  }] };
}

test('offline animation benchmark verifies explicit recipe and contact-channel assertions with fingerprinted evidence', () => {
  const first = runAnimationBenchmark(suite());
  const second = runAnimationBenchmark(suite());
  assert.equal(first.summary.cases, 1);
  assert.equal(first.summary.matchedExpectations, 2);
  assert.equal(first.cases[0]!.status, 'pass');
  assert.equal(first.cases[0]!.fingerprint, second.cases[0]!.fingerprint);
  assert.match(first.suiteFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.reportFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.suiteFingerprint, second.suiteFingerprint);
  assert.equal(first.reportFingerprint, second.reportFingerprint);
  assert.equal(first.cases[0]!.expectedOutcomes.every(outcome => outcome.matched), true);
  assert.match(first.cases[0]!.limitations.join(' '), /world-space contacts/i);
});

test('offline benchmark exposes missing contact tracks as warnings and flags expectation mismatches', () => {
  const input = suite();
  (input.cases[0]!.recipe as ReturnType<typeof animationPreset>).tracks = (input.cases[0]!.recipe as ReturnType<typeof animationPreset>).tracks.filter(track => track.joint !== 'LeftFoot');
  const report = runAnimationBenchmark(input);
  assert.equal(report.cases[0]!.status, 'fail');
  assert.equal(report.cases[0]!.expectedOutcomes[1]!.actual, 'warn');
  assert.equal(report.cases[0]!.expectedOutcomes[1]!.matched, false);
  assert.ok(report.cases[0]!.findings.some(finding => finding.id.startsWith('contact-track:') && finding.severity === 'warn'));
});

test('offline benchmark rejects malformed, duplicate, oversized, and non-animation suites', () => {
  assert.throws(() => runAnimationBenchmark({ schemaVersion: 2, cases: [] }), /schemaVersion: 1/i);
  const duplicate = suite();
  duplicate.cases.push(structuredClone(duplicate.cases[0]!));
  assert.throws(() => runAnimationBenchmark(duplicate), /IDs must be unique/i);
  const invalid = structuredClone(suite()) as { schemaVersion: number; cases: Array<{ recipe: unknown }> };
  invalid.cases[0]!.recipe = { kind: 'vfx' };
  const report = runAnimationBenchmark(invalid);
  assert.equal(report.cases[0]!.status, 'fail');
  assert.equal(report.cases[0]!.fingerprint, null);
});

test('benchmark treats an explicitly expected failure as a matched regression case', () => {
  const input = structuredClone(suite()) as { schemaVersion: number; cases: Array<{ id: string; name: string; recipe: unknown; expectations: Array<{ id: string; description: string; outcome: string; evidence: string }> }> };
  input.cases[0]!.recipe = { kind: 'not-an-animation' };
  input.cases[0]!.expectations = [{ id: 'recipe-invalid', description: 'This fixture must remain invalid.', outcome: 'fail', evidence: 'Malformed fixture is expected to be rejected.' }];
  const report = runAnimationBenchmark(input);
  assert.equal(report.cases[0]!.expectedOutcomes[0]!.matched, true);
  assert.equal(report.cases[0]!.status, 'pass');
});

test('release gate passes declared matching assertions and blocks empty-assertion cases by default', () => {
  const passing = runAnimationBenchmark(suite());
  assert.equal(evaluateAnimationBenchmarkGate(passing).decision, 'pass');

  const noAssertions = structuredClone(suite());
  noAssertions.cases[0]!.expectations = [];
  const blocked = evaluateAnimationBenchmarkGate(runAnimationBenchmark(noAssertions));
  assert.equal(blocked.decision, 'blocked');
  assert.ok(blocked.blockingReasons.some(reason => /no declared expectations/i.test(reason.reason)));
});

test('release gate can explicitly allow warnings but never ignores failed expectations', () => {
  const warningCase = structuredClone(suite());
  warningCase.cases[0]!.expectations.push({ id: 'events-undeclared', description: 'No event marker is authored.', outcome: 'warn', evidence: 'Warning is accepted for this test.' });
  const warningReport = runAnimationBenchmark(warningCase);
  assert.equal(evaluateAnimationBenchmarkGate(warningReport).decision, 'blocked');
  assert.equal(evaluateAnimationBenchmarkGate(warningReport, { failOnWarnings: false }).decision, 'pass');

  const failingCase = structuredClone(suite());
  failingCase.cases[0]!.expectations[0]!.outcome = 'fail';
  const failed = evaluateAnimationBenchmarkGate(runAnimationBenchmark(failingCase), { failOnWarnings: false });
  assert.equal(failed.decision, 'blocked');
  assert.ok(failed.blockingReasons.some(reason => /did not match/i.test(reason.reason)));
});

test('offline benchmark suites assert numeric loop-seam limits and retain measured evidence', () => {
  const input = suite();
  const recipe = input.cases[0]!.recipe as ReturnType<typeof animationPreset>;
  const foot = recipe.tracks.find(track => track.joint === 'LeftFoot')!;
  foot.keys = [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.5, position: [1, 0, 0], rotation: [60, 0, 0] },
    { time: 1.5, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ];
  Object.assign(input.cases[0]!, { limits: {
    maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond: 1,
    maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: 30,
  } });
  input.cases[0]!.expectations.push(
    { id: 'loop-seam-position-velocity', description: 'Position seam limit is an expected regression.', outcome: 'fail', evidence: 'A measured discontinuity above 1 studs/s is expected in this fixture.' },
    { id: 'loop-seam-angular-velocity', description: 'Angular seam limit is an expected regression.', outcome: 'fail', evidence: 'A measured discontinuity above 30 degrees/s is expected in this fixture.' },
  );
  const report = runAnimationBenchmark(input);
  const result = report.cases[0]!;
  assert.equal(result.expectedOutcomes.find(outcome => outcome.id === 'loop-seam-position-velocity')?.matched, true);
  assert.equal(result.expectedOutcomes.find(outcome => outcome.id === 'loop-seam-angular-velocity')?.matched, true);
  assert.ok(result.findings.find(finding => finding.id === 'loop-seam-position-velocity')?.evidence.includes('Observed 2.000000 studs/second'));
  assert.ok(result.findings.find(finding => finding.id === 'loop-seam-angular-velocity')?.evidence.includes('Observed 120.000000 degrees/second'));
  assert.equal(result.status, 'pass', 'an explicitly expected failure is a matched regression case');
  assert.throws(() => runAnimationBenchmark({ ...input, cases: [{ ...input.cases[0]!, recipe: { ...recipe, loop: false } }] }), /require a valid looping animation/i);
});

test('benchmark attestations are stable across runs and bind both suite contents and gate policy', () => {
  const input = suite();
  const report = runAnimationBenchmark(input);
  const sameReport = runAnimationBenchmark(structuredClone(input));
  assert.equal(report.reportFingerprint, sameReport.reportFingerprint);
  const gate = evaluateAnimationBenchmarkGate(report);
  const sameGate = evaluateAnimationBenchmarkGate(sameReport);
  assert.equal(gate.gateFingerprint, sameGate.gateFingerprint);
  const differentPolicy = evaluateAnimationBenchmarkGate(report, { failOnWarnings: false });
  assert.notEqual(gate.gateFingerprint, differentPolicy.gateFingerprint);

  const changedSuite = structuredClone(input);
  changedSuite.cases[0]!.expectations[0]!.evidence = 'Changed assertion provenance.';
  const changedReport = runAnimationBenchmark(changedSuite);
  assert.notEqual(report.suiteFingerprint, changedReport.suiteFingerprint);
  assert.notEqual(report.reportFingerprint, changedReport.reportFingerprint);
});
