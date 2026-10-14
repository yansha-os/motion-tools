import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { animationPreset } from '../src/recipes.js';
import { AnimationBenchmarkHistory } from '../src/animation-benchmark-history.js';

function suite(recipe: unknown = animationPreset('idle', 'History idle', 2, 1)) {
  return { schemaVersion: 1, cases: [{ id: 'idle', name: 'Idle check', recipe,
    expectations: [{ id: 'recipe-valid', description: 'Recipe must be valid.', outcome: 'pass', evidence: 'Strict schema validation.' }] }] };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'motion-benchmark-history-'));
  return { root, history: new AnimationBenchmarkHistory(root) };
}

test('benchmark runs are append-only, filterable and readable after library recreation', async () => {
  const f = await setup();
  try {
    const first = await f.history.record(suite(), { failOnWarnings: false });
    const second = await new AnimationBenchmarkHistory(f.root).record(suite(), { failOnWarnings: false });
    assert.notEqual(first.id, second.id);
    assert.equal(first.report.reportFingerprint, second.report.reportFingerprint);
    const listed = await f.history.list(10, first.report.suiteFingerprint);
    assert.equal(listed.total, 2);
    assert.deepEqual(new Set(listed.runs.map(run => run.id)), new Set([first.id, second.id]));
    const loaded = await new AnimationBenchmarkHistory(f.root).read(first.id);
    assert.equal(loaded.releaseGate.decision, 'pass');
    assert.equal(loaded.report.reportFingerprint, first.report.reportFingerprint);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark suites are archived by content and historical runs can replay exactly with the original gate policy', async () => {
  const f = await setup();
  try {
    const input = suite();
    const original = await f.history.record(input, { failOnWarnings: false, requireExpectationsPerCase: true });
    const page = await f.history.readSuite(original.id, 0, 1);
    assert.equal(page.replayVerified, true);
    assert.equal(page.suiteFingerprint, original.report.suiteFingerprint);
    assert.equal(page.totalCases, 1);
    assert.deepEqual(page.cases, input.cases);
    assert.equal(page.nextOffset, null);

    const replay = await new AnimationBenchmarkHistory(f.root).rerun(original.id);
    assert.notEqual(replay.id, original.id);
    assert.equal(replay.report.reportFingerprint, original.report.reportFingerprint);
    assert.deepEqual(replay.releaseGate.policy, original.releaseGate.policy);
    assert.equal(replay.releaseGate.decision, original.releaseGate.decision);
    assert.equal((await f.history.list(10, original.report.suiteFingerprint)).total, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark rerun rejects a modified archived source suite', async () => {
  const f = await setup();
  try {
    const original = await f.history.record(suite());
    const suitePath = join(f.root, 'suites', `${original.report.suiteFingerprint}.json`);
    const archived = JSON.parse(await readFile(suitePath, 'utf8')) as { cases: { name: string }[] };
    archived.cases[0]!.name = 'Tampered source';
    await writeFile(suitePath, JSON.stringify(archived));
    await assert.rejects(f.history.readSuite(original.id), /does not reproduce/i);
    await assert.rejects(f.history.rerun(original.id), /does not reproduce/i);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark comparison reports structural status changes without claiming quality changes', async () => {
  const f = await setup();
  try {
    const baseline = await f.history.record(suite({ kind: 'not-an-animation' }));
    const fixed = await f.history.record(suite(), { failOnWarnings: false });
    const diff = await f.history.compare(baseline.id, fixed.id);
    assert.equal(diff.comparability, 'changed_suite');
    assert.equal(diff.before.decision, 'blocked');
    assert.equal(diff.after.decision, 'pass');
    assert.equal(diff.caseChanges[0]!.statusTrend, 'status_improved');
    assert.ok(diff.caseChanges[0]!.findingChanges.some(change => change.findingId === 'recipe-invalid' && change.change === 'disappeared'));
    assert.ok(diff.caseChanges[0]!.findingChanges.some(change => change.findingId === 'recipe-valid' && change.change === 'appeared'));
    assert.match(diff.interpretation, /neither implies artistic quality/i);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark comparison separates changed acceptance criteria from changed observations', async () => {
  const f = await setup();
  try {
    const beforeSuite = suite();
    const before = await f.history.record(beforeSuite, { failOnWarnings: false });
    const afterSuite = suite();
    afterSuite.cases[0]!.name = 'Renamed case, stable ID';
    afterSuite.cases[0]!.expectations[0]!.outcome = 'warn';
    const after = await f.history.record(afterSuite, { failOnWarnings: false });
    const diff = await f.history.compare(before.id, after.id);
    const change = diff.caseChanges[0]!;
    assert.equal(change.caseNameChanged, true);
    assert.equal(change.statusTrend, 'status_worsened');
    assert.deepEqual(change.expectationChanges.map(item => item.change), ['criterion_changed']);
    assert.equal(change.findingChanges.some(item => item.findingId === 'recipe-valid'), false);
    assert.ok(change.expectationChanges[0]!.beforeMatched);
    assert.equal(change.expectationChanges[0]!.afterMatched, false);
    assert.equal(change.expectationChanges[0]!.criterionChanged, true);
    assert.equal(change.expectationChanges[0]!.observedResultChanged, false);
    assert.equal(change.expectationChanges[0]!.matchStateChanged, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark history retains loop-seam measurements and compares later evidence', async () => {
  const f = await setup();
  try {
    const makeSuite = (penultimatePosition: number) => {
      const recipe = animationPreset('idle', 'Loop history', 2, 1);
      recipe.tracks.push({ joint: 'LeftFoot', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 0.5, position: [1, 0, 0], rotation: [60, 0, 0] },
        { time: 1.5, position: [penultimatePosition, 0, 0], rotation: [0, 0, 0] },
        { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
      ] });
      return { schemaVersion: 1, cases: [{ id: 'loop', name: 'Loop seam', recipe,
        limits: { maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond: 3,
          maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: 130 },
        expectations: [
          { id: 'loop-seam-position-velocity', description: 'Bound position seam discontinuity.', outcome: 'pass', evidence: 'Explicit authored threshold.' },
          { id: 'loop-seam-angular-velocity', description: 'Bound angular seam discontinuity.', outcome: 'pass', evidence: 'Explicit authored threshold.' },
        ] }] };
    };
    const baseline = await f.history.record(makeSuite(0), { failOnWarnings: false });
    const loaded = await new AnimationBenchmarkHistory(f.root).read(baseline.id);
    assert.match(loaded.report.cases[0]!.findings.find(item => item.id === 'loop-seam-position-velocity')!.evidence, /Observed 2\.000000 studs\/second/);
    const revised = await f.history.record(makeSuite(0.25), { failOnWarnings: false });
    const diff = await f.history.compare(baseline.id, revised.id);
    const measurementChange = diff.caseChanges[0]!.findingChanges.find(item => item.findingId === 'loop-seam-position-velocity');
    assert.equal(measurementChange?.change, 'evidence_changed');
    assert.match(measurementChange?.beforeEvidence ?? '', /Observed 2\.000000/);
    assert.match(measurementChange?.afterEvidence ?? '', /Observed 2\.500000/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('concurrent benchmark recordings retain every unique immutable run', async () => {
  const f = await setup();
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () => f.history.record(suite(), { failOnWarnings: false })));
    assert.equal(new Set(runs.map(run => run.id)).size, 8);
    const history = await f.history.list(20);
    assert.equal(history.total, 8);
    for (const run of runs) assert.ok(history.runs.some(entry => entry.id === run.id));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('benchmark history rejects tampered persisted report content', async () => {
  const f = await setup();
  try {
    const recorded = await f.history.record(suite());
    const path = join(f.root, `${recorded.id}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as { report: { summary: { passed: number } } };
    stored.report.summary.passed += 1;
    await writeFile(path, JSON.stringify(stored));
    await assert.rejects(f.history.read(recorded.id), /fingerprint attestation/i);
    await assert.rejects(f.history.list(), /fingerprint attestation/i);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
