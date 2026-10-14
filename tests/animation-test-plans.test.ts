import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnimationTestPlanLibrary } from '../src/animation-test-plans.js';
import { Library } from '../src/library.js';
import { fingerprint } from '../src/inspection.js';
import { animationPreset, vfxPreset } from '../src/recipes.js';

function fingerprintCheck(recipe: Parameters<typeof fingerprint>[0]) {
  const value = fingerprint(recipe);
  return { id: 'asset_fingerprint', status: 'passed', detail: 'Fingerprint matches.', observed: value, expected: value };
}

test('animation test plans pin exact assets, preserve immutable revisions, and persist run history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plans-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('idle', 'Pinned idle', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const created = await plans.create('Idle release gate', [{ assetId: source.id, loop: true }]);
  assert.equal(created.revision, 1);
  assert.equal(created.cases[0]!.expectedFingerprint, fingerprint(source.recipe));
  assert.equal((await plans.get(created.id)).cases[0]!.loop, true);

  const child = await plans.create('Idle release gate', [{ assetId: source.id, loop: false }], created.id);
  assert.equal(child.parentId, created.id);
  assert.equal(child.revision, 2);
  assert.equal((await plans.get(created.id)).cases[0]!.loop, true, 'parent revision must remain immutable');
  assert.equal((await plans.list()).total, 2);

  await assert.rejects(() => plans.recordRun({ planId: child.id, planRevision: child.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'R15|root>torso', status: 'passed', summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 },
    results: [{ assetId: source.id, fingerprint: 'f'.repeat(64), status: 'passed', checks: [] }] }), /different from its pinned plan revision/i);

  const run = await plans.recordRun({ planId: child.id, planRevision: child.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'R15|root>torso', status: 'passed', summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 },
    results: [{ assetId: source.id, fingerprint: fingerprint(source.recipe), status: 'passed', checks: [fingerprintCheck(source.recipe), { id: 'loop', status: 'passed', detail: 'Loop mode matches.' }] }] });
  const reopened = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), new Library(animations.directory));
  const history = await reopened.listRuns(child.id);
  assert.equal(history.total, 1);
  assert.equal(history.runs[0]!.id, run.id);
  assert.equal(history.runs[0]!.planRevision, 2);

  await assert.rejects(() => plans.create('Stale pin', [{ assetId: source.id, expectedFingerprint: '0'.repeat(64), loop: true }]), /no longer matches the supplied fingerprint/i);
});

test('test-plan preview pins exact checks and fingerprints without writing a plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-preview-'));
  const animations = new Library(join(root, 'library'));
  const asset = await animations.save(animationPreset('walk', 'Previewed walk', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const parent = await plans.create('Walk release gate', [{ assetId: asset.id, loop: true }]);
  const before = await plans.list();
  const bendPlane = { rootJoint: 'LeftUpperLeg', middleJoint: 'LeftLowerLeg', effector: 'LeftFoot', start: 0.4, end: 0.9,
    poleTarget: [1, 0, 0] as [number, number, number], maxDeviationDegrees: 12 };
  const draft = await plans.preview('Walk release gate', [{ assetId: asset.id, loop: true, requiredMarkers: ['plant'],
    maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond: 0.25,
    maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: 30, maxLoopComposedPositionOffsetStuds: 0.1,
    maxLoopComposedAngularOffsetDegrees: 2, jointLoopLimits: [{ joint: 'Head', maxAngularOffsetDegrees: 5 }], bendPlanes: [bendPlane] }], parent.id);
  assert.equal(draft.willWrite, false);
  assert.equal(draft.proposedRevision, 2);
  assert.equal(draft.parentPlan?.id, parent.id);
  assert.match(draft.draftFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(draft.review[0]!.currentFingerprint, fingerprint(asset.recipe));
  assert.deepEqual(draft.review[0]!.declaredCheckIds, ['asset_fingerprint', 'loop', 'marker:plant', 'max_loop_seam_position_velocity_discontinuity', 'max_loop_seam_angular_velocity_discontinuity', 'max_loop_composed_position_offset', 'max_loop_composed_angular_offset', 'loop-joint:Head:angular', 'bend-plane:LeftFoot:1']);
  assert.equal(draft.review[0]!.checkRequirements.at(-1)!.evidenceSource, 'live_studio');
  assert.equal(draft.review[0]!.checkRequirements.find(item => item.checkId === 'max_loop_seam_position_velocity_discontinuity')!.evidenceSource, 'offline_recipe_analysis');
  for (const id of ['max_loop_composed_position_offset', 'max_loop_composed_angular_offset', 'loop-joint:Head:angular']) {
    const requirement = draft.review[0]!.checkRequirements.find(item => item.checkId === id)!;
    assert.equal(requirement.evidenceSource, 'offline_recipe_analysis');
    assert.deepEqual(requirement.requiredStudioEvidence, []);
  }
  assert.deepEqual(draft.review[0]!.validationPlan.bendPlaneWindows, [{ rootJoint: 'LeftUpperLeg', middleJoint: 'LeftLowerLeg', effector: 'LeftFoot',
    start: 0.4, end: 0.9, minSamples: 3, maxSampleGapSeconds: 0.25 }]);
  assert.deepEqual(draft.review[0]!.validationPlan.requiredDrivenJoints, ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot']);
  assert.equal((await plans.list()).total, before.total, 'preview must not write an immutable plan');
  await assert.rejects(() => plans.create('Walk release gate', [{ assetId: asset.id, loop: true, requiredMarkers: ['changed'] }], parent.id, draft.draftFingerprint), /differs from the reviewed preview/i);
  const [committed, retried] = await Promise.all([
    plans.create('Walk release gate', draft.cases, parent.id, draft.draftFingerprint),
    plans.create('Walk release gate', draft.cases, parent.id, draft.draftFingerprint),
  ]);
  assert.equal(committed.revision, 2);
  assert.equal(retried.id, committed.id);
  assert.equal(retried.createdAt, committed.createdAt);
  assert.equal((await plans.list()).total, before.total + 1, 'concurrent retries must create one immutable plan');

  const assetPath = join(animations.directory, `${asset.id}.json`);
  const externallyChanged = JSON.parse(await readFile(assetPath, 'utf8')) as typeof asset;
  externallyChanged.recipe.name = 'Changed after commit';
  await writeFile(assetPath, JSON.stringify(externallyChanged, null, 2));
  const retryAfterAssetDrift = await plans.create('Walk release gate', draft.cases, parent.id, draft.draftFingerprint);
  assert.equal(retryAfterAssetDrift.id, committed.id, 'a lost-response retry returns the original plan even if its source later becomes stale');

  await assert.rejects(() => plans.preview('Stale draft', [{ assetId: asset.id, expectedFingerprint: '0'.repeat(64), loop: true }]), /no longer matches the supplied fingerprint/i);
});

test('plan commit refuses an animation changed after its preview was reviewed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-plan-commit-drift-'));
  const animations = new Library(join(root, 'library'));
  const asset = await animations.save(animationPreset('idle', 'Preview then change', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const draft = await plans.preview('Release gate', [{ assetId: asset.id, loop: true }]);
  const assetPath = join(animations.directory, `${asset.id}.json`);
  const externallyChanged = JSON.parse(await readFile(assetPath, 'utf8')) as typeof asset;
  externallyChanged.recipe.name = 'Changed between preview and commit';
  await writeFile(assetPath, JSON.stringify(externallyChanged, null, 2));
  await assert.rejects(() => plans.create('Release gate', draft.cases, undefined, draft.draftFingerprint), /no longer matches the supplied fingerprint/i);
  assert.equal((await plans.list()).total, 0, 'stale preview must not create a plan');

  const missingAsset = await animations.save(animationPreset('walk', 'Removed after preview', 2, 1));
  const missingDraft = await plans.preview('Missing asset gate', [{ assetId: missingAsset.id, loop: false }]);
  await unlink(join(animations.directory, `${missingAsset.id}.json`));
  await assert.rejects(() => plans.create('Missing asset gate', missingDraft.cases, undefined, missingDraft.draftFingerprint), /ENOENT/);
  assert.equal((await plans.list()).total, 0, 'missing source asset must not create a plan');
});

test('reuse evidence is bound to the current recipe fingerprint and exact rig topology', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-reuse-evidence-'));
  const animations = new Library(join(root, 'library'));
  const tested = await animations.save(animationPreset('walk', 'Evidence walk', 2, 1));
  const untouched = await animations.save(animationPreset('idle', 'No evidence', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Walk technical gate', [{ assetId: tested.id, loop: false }]);
  await plans.recordRun({ planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'R15|walk-rig-v1', status: 'passed', summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 },
    results: [{ assetId: tested.id, fingerprint: fingerprint(tested.recipe), status: 'passed', checks: [
      fingerprintCheck(tested.recipe),
      { id: 'loop', status: 'passed', detail: 'Loop mode matches.' },
    ] }] });
  const evidence = await plans.findAssetEvidence([
    { assetId: tested.id, currentFingerprint: fingerprint(tested.recipe) },
    { assetId: untouched.id, currentFingerprint: fingerprint(untouched.recipe) },
  ], 'R15|walk-rig-v1');
  assert.equal(evidence.results[0]!.evidenceStatus, 'latest_applicable_run_passed');
  assert.equal(evidence.results[0]!.latestApplicableRun?.currentRecipe, true);
  assert.equal(evidence.results[0]!.latestApplicableRun?.rigMatchesTarget, true);
  assert.equal(evidence.results[0]!.latestApplicableRun?.checks.find(check => check.id === 'loop')?.id, 'loop');
  assert.deepEqual(evidence.results[0]!.latestApplicableRun?.criteriaCoverage.missingCheckIds, []);
  assert.equal(evidence.results[0]!.acceptanceCoverageGap.status, 'declared_checks_passed');
  assert.equal(evidence.results[1]!.evidenceStatus, 'no_recorded_runs');

  const otherRig = await plans.findAssetEvidence([{ assetId: tested.id, currentFingerprint: fingerprint(tested.recipe) }], 'R15|different-rig-v1');
  assert.equal(otherRig.results[0]!.evidenceStatus, 'current_recipe_tested_on_other_rig');
  assert.equal(otherRig.results[0]!.latestApplicableRun, null);
  assert.equal(otherRig.results[0]!.latestCurrentRecipeRun?.rigMatchesTarget, false);

  const stale = await plans.findAssetEvidence([{ assetId: tested.id, currentFingerprint: 'f'.repeat(64) }]);
  assert.equal(stale.results[0]!.evidenceStatus, 'only_stale_recipe_runs');
  assert.equal(stale.results[0]!.staleRecipeRunCount, 1);
});

test('reuse evidence shows parent history without inheriting it to a changed child revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-reuse-lineage-'));
  const animations = new Library(join(root, 'library'));
  const parentAsset = await animations.save(animationPreset('slash', 'Tested slash', 2, 1));
  const childAsset = await animations.save({ ...parentAsset.recipe, name: 'Revised slash' }, parentAsset.id);
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Parent acceptance', [{ assetId: parentAsset.id, loop: false }]);
  await plans.recordRun({ planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'R15|lineage-test-rig', status: 'passed', summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 },
    results: [{ assetId: parentAsset.id, fingerprint: fingerprint(parentAsset.recipe), status: 'passed', checks: [
      fingerprintCheck(parentAsset.recipe),
      { id: 'loop', status: 'passed', detail: 'Parent loop passed.' },
    ] }] });

  const report = await plans.findAssetLineageEvidence([childAsset.id], 'R15|lineage-test-rig');
  const child = report.results[0]!;
  assert.equal(child.exactRevisionEvidence.evidenceStatus, 'no_recorded_runs');
  assert.equal(child.ancestors.length, 1);
  assert.equal(child.ancestors[0]!.assetId, parentAsset.id);
  assert.equal(child.ancestors[0]!.evidence.evidenceStatus, 'latest_applicable_run_passed');
  assert.equal(child.ancestors[0]!.sameRecipeContentAsSelected, false);
  assert.equal(child.ancestors[0]!.appliesToSelectedRevision, false);
  assert.equal(child.lineageTruncated, false);
});

test('reuse evidence compares repeated exact-recipe runs only on the same plan and rig', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-reuse-run-trend-'));
  const animations = new Library(join(root, 'library'));
  const asset = await animations.save(animationPreset('cast', 'Repeated test', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Cast gate', [{ assetId: asset.id, maxPeakAngularSpeedDegreesPerSecond: 20 }]);
  const rigId = '11111111-1111-4111-8111-111111111111';
  const record = (status: 'passed' | 'failed', observed: number) => plans.recordRun({ planId: plan.id, planRevision: plan.revision,
    runAt: new Date(Date.now() + observed).toISOString(), rigId, rigSignature: 'same-topology', status,
    summary: { requested: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, incomplete: 0 },
    results: [{ assetId: asset.id, fingerprint: fingerprint(asset.recipe), status, checks: [
      fingerprintCheck(asset.recipe),
      { id: 'max_peak_angular_speed', status, detail: `Measured ${observed} degrees per second.`, observed, expected: 20, unit: 'degrees/second' },
    ] }] });
  await record('passed', 12);
  await record('failed', 28);
  const evidence = await plans.findAssetEvidence([{ assetId: asset.id, currentFingerprint: fingerprint(asset.recipe) }], 'same-topology');
  const comparison = evidence.results[0]!.repeatedRunComparison;
  assert.equal(comparison?.summary.regressions, 1);
  const speedCheck = comparison?.checks.find(check => check.checkId === 'max_peak_angular_speed');
  assert.equal(speedCheck?.trend, 'regression');
  assert.equal(speedCheck?.baselineObserved, 12);
  assert.equal(speedCheck?.candidateObserved, 28);
  assert.equal(speedCheck?.observedDelta, 16);
  assert.equal(speedCheck?.unit, 'degrees/second');
});

test('reuse evidence reports missing declared checks instead of trusting a passed run summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-reuse-coverage-gap-'));
  const animations = new Library(join(root, 'library'));
  const asset = await animations.save(animationPreset('idle', 'Coverage gap', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Loop and duration contract', [{ assetId: asset.id, loop: true, duration: { min: 2, max: 2 } }]);
  await plans.recordRun({ planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'coverage-rig', status: 'incomplete', summary: { requested: 1, passed: 0, failed: 0, incomplete: 1 },
    results: [{ assetId: asset.id, fingerprint: fingerprint(asset.recipe), status: 'incomplete', checks: [
      fingerprintCheck(asset.recipe),
      { id: 'loop', status: 'passed', detail: 'Loop is enabled.' },
    ] }] });
  const report = await plans.findAssetEvidence([{ assetId: asset.id, currentFingerprint: fingerprint(asset.recipe) }], 'coverage-rig');
  const result = report.results[0]!;
  assert.deepEqual(result.latestApplicableRun?.criteriaCoverage.requiredCheckIds, ['asset_fingerprint', 'duration', 'loop']);
  assert.deepEqual(result.latestApplicableRun?.criteriaCoverage.missingCheckIds, ['duration']);
  assert.equal(result.acceptanceCoverageGap.status, 'declared_checks_missing');
  assert.match(result.acceptanceCoverageGap.nextAction, /rerun/i);
});

test('plan listing flags missing or changed animation sources and rejects non-animation assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-stale-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('walk', 'Pinned walk', 1, 1));
  const effect = await animations.save(vfxPreset('impact', 'Not an animation'));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Walk gate', [{ assetId: source.id, duration: { min: 1, max: 1 } }]);
  await assert.rejects(() => plans.create('Invalid plan', [{ assetId: effect.id, loop: false }]), /not an animation/i);

  const sourcePath = join(animations.directory, `${source.id}.json`);
  const externalEdit = JSON.parse(await readFile(sourcePath, 'utf8')) as typeof source;
  externalEdit.recipe.name = 'Edited outside Motion Tools';
  await writeFile(sourcePath, JSON.stringify(externalEdit, null, 2));
  const listed = await plans.list();
  assert.equal(listed.plans.find(item => item.id === plan.id)?.staleAssetCount, 1);
});

test('regression comparison revalidates persisted fingerprints against both immutable plan revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-history-integrity-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('idle', 'History integrity', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const parent = await plans.create('Pinned idle', [{ assetId: source.id, loop: true }]);
  const child = await plans.create('Pinned idle', [{ assetId: source.id, loop: true }], parent.id);
  const rigId = '11111111-1111-4111-8111-111111111111';
  const saveRun = (plan: typeof parent) => plans.recordRun({ planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId,
    rigSignature: 'same-rig-v1', status: 'passed', summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 },
    results: [{ assetId: source.id, fingerprint: fingerprint(source.recipe), status: 'passed', checks: [fingerprintCheck(source.recipe), { id: 'loop', status: 'passed', detail: 'Loop is enabled.' }] }] });
  const baseline = await saveRun(parent);
  const candidate = await saveRun(child);
  const candidatePath = join(root, 'runs', `${candidate.id}.json`);
  const corrupted = JSON.parse(await readFile(candidatePath, 'utf8')) as { results: { fingerprint: string }[] };
  corrupted.results[0]!.fingerprint = 'f'.repeat(64);
  await writeFile(candidatePath, JSON.stringify(corrupted, null, 2));
  await assert.rejects(() => plans.compareRuns(parent.id, child.id, baseline.id, candidate.id), /different from its pinned plan revision/i);
});

test('persisted acceptance runs cannot claim pass when checks or summary are tampered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-run-integrity-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('idle', 'Acceptance integrity', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Integrity gate', [{ assetId: source.id, loop: true }]);
  const run = await plans.recordRun({ planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(),
    rigId: '11111111-1111-4111-8111-111111111111', rigSignature: 'integrity-rig', status: 'passed',
    summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 }, results: [{ assetId: source.id, fingerprint: fingerprint(source.recipe), status: 'passed',
      checks: [fingerprintCheck(source.recipe), { id: 'loop', status: 'passed', detail: 'Loop is enabled.', observed: true, expected: true }] }] });
  const runPath = join(root, 'runs', `${run.id}.json`);
  const corrupted = JSON.parse(await readFile(runPath, 'utf8')) as { results: { checks: { id: string; status: string }[] }[] };
  corrupted.results[0]!.checks.find(check => check.id === 'loop')!.status = 'failed';
  await writeFile(runPath, JSON.stringify(corrupted, null, 2));
  await assert.rejects(() => plans.readRunForPlan(run.id, plan.id), /checks and declared criteria require failed/i);
  await assert.rejects(() => plans.listRuns(plan.id), /checks and declared criteria require failed/i);

  const statusTampered = JSON.parse(await readFile(runPath, 'utf8')) as { results: { checks: { id: string; status: string }[] }[]; summary: { passed: number } };
  statusTampered.results[0]!.checks.find(check => check.id === 'loop')!.status = 'passed';
  statusTampered.summary.passed = 0;
  await writeFile(runPath, JSON.stringify(statusTampered, null, 2));
  await assert.rejects(() => plans.readRunForPlan(run.id, plan.id), /Run summary does not match/i);
});

test('persisted regression runs reject malformed or internally inconsistent contact-segment evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-segment-integrity-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('idle', 'Segment integrity', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const plan = await plans.create('Segment contract', [{ assetId: source.id, loop: true }]);
  const base = { planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId: '11111111-1111-4111-8111-111111111111',
    rigSignature: 'same-rig-v1', status: 'failed' as const, summary: { requested: 1, passed: 0, failed: 1, incomplete: 0 } };
  const record = (...checks: Record<string, unknown>[]) => plans.recordRun({ ...base, results: [{ assetId: source.id, fingerprint: fingerprint(source.recipe), status: 'failed', checks }] });
  const segment = { startTime: 0.5, endTime: 0.75, startSampleId: 's001', endSampleId: 's002', displacementStuds: 0.1 };
  await assert.rejects(() => record({ id: 'loop', status: 'failed', detail: 'Malformed segment attachment.', observed: 0.4, expected: 1,
    unit: 'studs/second', sampleIds: ['s001', 's002'], segment }), /only valid on step-speed checks/i);
  await assert.rejects(() => record({ id: 'contact:LeftFoot:1:step-speed', status: 'failed', detail: 'Mismatched sample IDs.', observed: 0.4, expected: 0.3,
    unit: 'studs/second', sampleIds: ['s002', 's003'], segment }), /must exactly match the structured segment endpoints/i);
  await assert.rejects(() => record({ id: 'contact:LeftFoot:1:step-speed', status: 'failed', detail: 'Mismatched speed.', observed: 0.5, expected: 0.3,
    unit: 'studs/second', sampleIds: ['s001', 's002'], segment }), /does not match segment displacement/i);
  const validStepCheck = { id: 'contact:LeftFoot:1:step-speed', status: 'failed', detail: 'Valid evidence.', sampleIds: ['s001', 's002'], segment,
    observed: 0.4, expected: 0.3, unit: 'studs/second' };
  await assert.rejects(() => record(validStepCheck, validStepCheck), /duplicate check IDs/i);
});

test('test-plan comparisons track angular contact drift independently from positional drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-angular-contact-'));
  const animations = new Library(join(root, 'library'));
  const recipe = animationPreset('slash', 'Contact strike', 2, 1);
  recipe.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 }];
  const source = await animations.save(recipe);
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const contact = { effector: 'LeftFoot', kind: 'support' as const, start: 0.5, end: 1.5, maxDriftStuds: 0.2, maxAngularDriftDegrees: 30,
    maxCumulativeTravelStuds: 0.5, maxStepSpeedStudsPerSecond: 1,
    maxGroundOffsetStuds: 0.1, targetPosition: [0, 0, 0] as [number, number, number], maxTargetDistanceStuds: 0.2,
    targetOrientation: [0, 0, 0, 1] as [number, number, number, number], maxAngularTargetErrorDegrees: 20 };
  const parent = await plans.create('Stable planted contact', [{ assetId: source.id, contacts: [contact] }]);
  const childAsset = await animations.save({ ...source.recipe, name: 'Contact strike revision' }, source.id);
  const child = await plans.create('Stable planted contact', [{ assetId: childAsset.id, contacts: [contact] }], parent.id);
  const rigId = '11111111-1111-4111-8111-111111111111';
  const record = (plan: typeof parent, assetId: string, measuredAngle: number, angularStatus: 'passed' | 'failed') => plans.recordRun({
    planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId, rigSignature: 'same-rig-v1',
    status: angularStatus === 'failed' ? 'failed' : 'passed',
    summary: { requested: 1, passed: angularStatus === 'failed' ? 0 : 1, failed: angularStatus === 'failed' ? 1 : 0, incomplete: 0 },
    results: [{ assetId, fingerprint: fingerprint(assetId === source.id ? source.recipe : { ...source.recipe, name: 'Contact strike revision' }),
      status: angularStatus === 'failed' ? 'failed' : 'passed', checks: [
        fingerprintCheck(assetId === source.id ? source.recipe : { ...source.recipe, name: 'Contact strike revision' }),
        { id: 'contact:LeftFoot:1', status: 'passed', detail: 'Position is stable.', observed: 0.1, expected: 0.2, unit: 'studs' },
        { id: 'contact:LeftFoot:1:rotation', status: angularStatus, detail: 'Angular drift measured.', observed: measuredAngle, expected: 30, unit: 'degrees' },
        { id: 'contact:LeftFoot:1:ground', status: 'passed', detail: 'Ground clearance is stable.', observed: 0.05, expected: 0.1, unit: 'studs' },
        { id: 'contact:LeftFoot:1:target', status: 'passed', detail: 'Target region is stable.', observed: 0.03, expected: 0.2, unit: 'studs' },
        { id: 'contact:LeftFoot:1:orientation-target', status: angularStatus, detail: 'Orientation target measured.', observed: measuredAngle, expected: 20, unit: 'degrees' },
        { id: 'contact:LeftFoot:1:travel', status: assetId === source.id ? 'passed' : 'failed', detail: 'Cumulative sampled travel measured.', observed: assetId === source.id ? 0.2 : 0.6, expected: 0.5, unit: 'studs' },
        { id: 'contact:LeftFoot:1:step-speed', status: assetId === source.id ? 'passed' : 'failed', detail: 'Worst adjacent sample speed measured.', observed: assetId === source.id ? 0.4 : 1.2, expected: 1, unit: 'studs/second', sampleIds: assetId === source.id ? ['s001', 's002'] : ['s003', 's004'], segment: assetId === source.id
          ? { startTime: 0.5, endTime: 0.75, startSampleId: 's001', endSampleId: 's002', displacementStuds: 0.1 }
          : { startTime: 1, endTime: 1.25, startSampleId: 's003', endSampleId: 's004', displacementStuds: 0.3 } },
      ] }],
  });
  const baseline = await record(parent, source.id, 10, 'passed');
  const candidate = await record(child, childAsset.id, 40, 'failed');
  const comparison = await plans.compareRuns(parent.id, child.id, baseline.id, candidate.id);
  const position = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1');
  const rotation = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:rotation');
  const ground = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:ground');
  const target = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:target');
  const orientationTarget = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:orientation-target');
  const travel = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:travel');
  const stepSpeed = comparison.assets[0]!.checkComparisons.find(check => check.checkId === 'contact:LeftFoot:1:step-speed');
  assert.equal(position?.status, 'stable');
  assert.equal(rotation?.status, 'regression');
  assert.equal(rotation?.measurementTrend, 'worsened');
  assert.equal(rotation?.observedDelta, 30);
  assert.equal(ground?.status, 'stable');
  assert.equal(target?.status, 'stable');
  assert.equal(orientationTarget?.status, 'regression');
  assert.equal(travel?.status, 'regression');
  assert.equal(travel?.measurementTrend, 'worsened');
  assert.ok(Math.abs((travel?.observedDelta ?? 0) - 0.4) < 1e-9);
  assert.equal(stepSpeed?.status, 'regression');
  assert.equal(stepSpeed?.measurementTrend, 'worsened');
  assert.ok(Math.abs((stepSpeed?.observedDelta ?? 0) - 0.8) < 1e-9);
  assert.deepEqual(stepSpeed?.candidateSegment, { startTime: 1, endTime: 1.25, startSampleId: 's003', endSampleId: 's004', displacementStuds: 0.3 });
  assert.deepEqual(stepSpeed?.candidateSampleIds, ['s003', 's004']);
  const triage = comparison.triage.items.find(item => item.checkId === 'contact:LeftFoot:1:step-speed');
  assert.equal(comparison.triage.regressionCount, 4);
  assert.equal(triage?.status, 'regression');
  assert.deepEqual(triage?.sampleIds, ['s003', 's004']);
  assert.deepEqual(triage?.segment, stepSpeed?.candidateSegment);
  assert.match(triage?.nextAction ?? '', /Scrub the candidate from 1s to 1\.25s/i);
});

test('parent-child comparisons require the same rig and separate true regressions from changed criteria', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-test-plan-compare-'));
  const animations = new Library(join(root, 'library'));
  const source = await animations.save(animationPreset('idle', 'Regression idle', 2, 1));
  const plans = new AnimationTestPlanLibrary(join(root, 'plans'), join(root, 'runs'), animations);
  const parent = await plans.create('Idle contract', [{ assetId: source.id, loop: true, maxPeakAngularSpeedDegreesPerSecond: 100 }]);
  const rigId = '11111111-1111-4111-8111-111111111111';
  await plans.recordRun({ planId: parent.id, planRevision: 1, runAt: new Date().toISOString(), rigId, rigSignature: 'same-rig-v1', status: 'passed',
    summary: { requested: 1, passed: 1, failed: 0, incomplete: 0 }, results: [{ assetId: source.id, fingerprint: fingerprint(source.recipe), status: 'passed', checks: [
      fingerprintCheck(source.recipe),
      { id: 'loop', status: 'passed', detail: 'Loop is enabled.', observed: true, expected: true },
      { id: 'max_peak_angular_speed', status: 'passed', detail: 'Below limit.', observed: 40, expected: 100, unit: 'degrees/second' },
    ] }] });

  const revisedRecipe = { ...source.recipe, name: 'Regression idle child', loop: false };
  const revisedAsset = await animations.save(revisedRecipe, source.id);
  const child = await plans.create('Idle contract', [{ assetId: revisedAsset.id, loop: true, maxPeakAngularSpeedDegreesPerSecond: 100 }], parent.id);
  await plans.recordRun({ planId: child.id, planRevision: child.revision, runAt: new Date().toISOString(), rigId, rigSignature: 'same-rig-v1', status: 'failed',
    summary: { requested: 1, passed: 0, failed: 1, incomplete: 0 }, results: [{ assetId: revisedAsset.id, fingerprint: fingerprint(revisedAsset.recipe), status: 'failed', checks: [
      fingerprintCheck(revisedAsset.recipe),
      { id: 'loop', status: 'failed', detail: 'Loop is disabled.', observed: false, expected: true },
      { id: 'max_peak_angular_speed', status: 'passed', detail: 'Still under limit, but worse.', observed: 95, expected: 100, unit: 'degrees/second' },
    ] }] });
  const regression = await plans.compareRuns(parent.id, child.id);
  assert.equal(regression.summary.regressions, 1);
  assert.equal(regression.assets[0]!.fingerprintChanged, true);
  assert.equal(regression.assets[0]!.lineage, 'child_revision');
  assert.equal(regression.assets[0]!.candidateAssetId, revisedAsset.id);
  assert.equal(regression.assets[0]!.checkComparisons.find(check => check.checkId === 'loop')?.status, 'regression');
  const speedTrend = regression.assets[0]!.checkComparisons.find(check => check.checkId === 'max_peak_angular_speed');
  assert.equal(speedTrend?.status, 'stable', 'the acceptance check still passes');
  assert.equal(speedTrend?.measurementTrend, 'worsened', 'the numeric signal still warns that motion became more abrupt');
  assert.equal(speedTrend?.observedDelta, 55);
  assert.equal(regression.summary.measurementsWorsened, 1);

  const criteriaRevision = await plans.create('Idle contract', [{ assetId: revisedAsset.id, loop: true, maxPeakAngularSpeedDegreesPerSecond: 200 }], child.id);
  await plans.recordRun({ planId: criteriaRevision.id, planRevision: criteriaRevision.revision, runAt: new Date().toISOString(), rigId, rigSignature: 'same-rig-v1', status: 'failed',
    summary: { requested: 1, passed: 0, failed: 1, incomplete: 0 }, results: [{ assetId: revisedAsset.id, fingerprint: fingerprint(revisedAsset.recipe), status: 'failed', checks: [
      fingerprintCheck(revisedAsset.recipe),
      { id: 'loop', status: 'failed', detail: 'Loop remains disabled.', observed: false, expected: true },
      { id: 'max_peak_angular_speed', status: 'passed', detail: 'Below revised limit.', observed: 95, expected: 200, unit: 'degrees/second' },
    ] }] });
  const changedCriteria = await plans.compareRuns(child.id, criteriaRevision.id);
  assert.equal(changedCriteria.summary.criteriaChanged, 1);
  assert.equal(changedCriteria.summary.criteriaChangedChecks, 1);
  assert.equal(changedCriteria.assets[0]!.checkComparisons.find(check => check.checkId === 'loop')?.status, 'stable', 'an unchanged check stays comparable when another criterion changes');
  assert.equal(changedCriteria.assets[0]!.checkComparisons.find(check => check.checkId === 'max_peak_angular_speed')?.status, 'criteria_changed');
  assert.equal(changedCriteria.assets[0]!.checkComparisons.find(check => check.checkId === 'max_peak_angular_speed')?.measurementTrend, 'unchanged', 'changing a pass threshold must not hide an unchanged measurement');
  assert.equal(changedCriteria.summary.improvements, 0, 'changing the acceptance requirement must not be labeled as an improvement');
  await assert.rejects(() => plans.compareRuns(parent.id, criteriaRevision.id), /direct child test-plan revision/i);

  const wrongRig = await plans.recordRun({ planId: criteriaRevision.id, planRevision: criteriaRevision.revision, runAt: new Date().toISOString(), rigId: '22222222-2222-4222-8222-222222222222', rigSignature: 'different-rig-v1', status: 'failed',
    summary: { requested: 1, passed: 0, failed: 1, incomplete: 0 }, results: [{ assetId: revisedAsset.id, fingerprint: fingerprint(revisedAsset.recipe), status: 'failed', checks: [
      fingerprintCheck(revisedAsset.recipe),
      { id: 'loop', status: 'failed', detail: 'Loop remains disabled.', observed: false, expected: true },
      { id: 'max_peak_angular_speed', status: 'passed', detail: 'Below revised limit.', observed: 95, expected: 200, unit: 'degrees/second' },
    ] }] });
  await assert.rejects(() => plans.compareRuns(child.id, criteriaRevision.id, undefined, wrongRig.id), /exact same rig ID and topology signature/i);
});
