import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnimationGraphLibrary } from '../src/animation-graph.js';
import { AnimationGraphScenarioHistory } from '../src/animation-graph-scenario-history.js';
import { Library } from '../src/library.js';
import { animationPreset } from '../src/recipes.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'motion-graph-scenario-history-'));
  const animations = new Library(join(root, 'library'));
  const idle = await animations.save(animationPreset('idle', 'Idle', 1, 0.2));
  const action = await animations.save(animationPreset('slash', 'Action', 1, 0.8));
  const graphs = new AnimationGraphLibrary(join(root, 'graphs'), animations);
  const graph = await graphs.save({ kind: 'animation_graph', name: 'Graph', entryState: 'idle', sampleRate: 30,
    states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }, { id: 'action', name: 'Action', animationId: action.id, speed: 1 }],
    transitions: [{ id: 'act', from: 'idle', to: 'action', trigger: 'Act', blendSeconds: 0.1 }] });
  const history = new AnimationGraphScenarioHistory(join(root, 'scenario-history'), graphs);
  const scenarios = [{ id: 'action', name: 'Action route', steps: [{ trigger: 'Act', expect: { kind: 'transition' as const, transitionId: 'act' } }] },
    { id: 'negative', name: 'Unknown trigger', steps: [{ trigger: 'Other', expect: { kind: 'no_transition' as const } }] }];
  return { root, animations, graphs, graph, history, scenarios };
}

test('graph scenario plans are reviewed, immutable, idempotent, and run reports persist with integrity', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Combat smoke suite', f.graph.id, f.scenarios);
    assert.equal(preview.willWrite, false);
    assert.equal(preview.proposedRevision, 1);
    const plan = await f.history.create('Combat smoke suite', f.graph.id, f.scenarios, preview.draftFingerprint);
    const retry = await f.history.create('Combat smoke suite', f.graph.id, f.scenarios, preview.draftFingerprint);
    assert.equal(plan.id, preview.proposedPlanId);
    assert.equal(retry.planFingerprint, plan.planFingerprint);

    const [first, second] = await Promise.all([f.history.run(plan.id, plan.planFingerprint), f.history.run(plan.id, plan.planFingerprint)]);
    assert.notEqual(first.id, second.id);
    assert.equal(first.report.status, 'passed');
    assert.equal(first.report.reportFingerprint, second.report.reportFingerprint);
    const history = await f.history.history(plan.id, 10);
    assert.equal(history.total, 2);
    assert.deepEqual(new Set(history.runs.map(run => run.id)), new Set([first.id, second.id]));
    const comparison = await f.history.compare(first.id, second.id);
    assert.equal(comparison.comparability, 'same_contract');
    assert.equal(comparison.summary.stablePasses, 2);

    const runPath = join(f.root, 'scenario-history', 'runs', `${first.id}.json`);
    const stored = JSON.parse(await readFile(runPath, 'utf8')) as { run: { report: { status: string } }; integrity: string };
    stored.integrity = '0'.repeat(64);
    await writeFile(runPath, JSON.stringify(stored));
    await assert.rejects(() => f.history.history(plan.id, 10), /integrity check failed/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('graph scenario plans support explicit immutable child revisions and reject stale draft or graph fingerprints', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Smoke', f.graph.id, f.scenarios);
    await assert.rejects(() => f.history.create('Different name', f.graph.id, f.scenarios, preview.draftFingerprint), /differs from the reviewed preview/i);
    const parent = await f.history.create('Smoke', f.graph.id, f.scenarios, preview.draftFingerprint);
    const childScenarios = [{ id: 'action', name: 'Action route', steps: [
      { trigger: 'Act', expect: { kind: 'transition' as const, transitionId: 'act' } },
      { trigger: 'Unknown', expect: { kind: 'no_transition' as const } },
    ] }];
    const childPreview = await f.history.preview('Smoke tightened', f.graph.id, childScenarios, parent.id);
    const child = await f.history.create('Smoke tightened', f.graph.id, childScenarios, childPreview.draftFingerprint, parent.id);
    assert.equal(child.parent?.id, parent.id);
    assert.equal(child.revision, parent.revision + 1);
    await assert.rejects(() => f.history.run(parent.id, 'f'.repeat(64)), /differs from the reviewed expectation/i);

    const graphRecordPath = join(f.root, 'graphs', `${f.graph.id}.json`);
    const record = JSON.parse(await readFile(graphRecordPath, 'utf8')) as { graph: { states: { animationId: string }[] } };
    const assetPath = join(f.root, 'library', `${record.graph.states[0]!.animationId}.json`);
    const asset = JSON.parse(await readFile(assetPath, 'utf8')) as { recipe: { name: string } };
    asset.recipe.name = 'Mutated idle';
    await writeFile(assetPath, JSON.stringify(asset));
    await assert.rejects(() => f.history.run(child.id), /stale source assets/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('graph scenario history detects missing records and lists plans read-only', async () => {
  const f = await fixture();
  try {
    const preview = await f.history.preview('Smoke', f.graph.id, f.scenarios);
    const plan = await f.history.create('Smoke', f.graph.id, f.scenarios, preview.draftFingerprint);
    const listed = await f.history.list(0, 10);
    assert.equal(listed.total, 1);
    assert.equal(listed.plans[0]?.id, plan.id);
    await assert.rejects(() => f.history.compare('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'));
    assert.deepEqual(await readdir(join(f.root, 'scenario-history', 'plans')), [`${plan.id}.json`]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
