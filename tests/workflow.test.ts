import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workflows, type VerifiedWorkflowCapture, type Workflow } from '../src/workflow.js';
import { fingerprint } from '../src/inspection.js';
import { animationPreset, type AnimationRecipe } from '../src/recipes.js';

// Tiny image envelopes test transport and fingerprinting, not artistic judgment.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const png2 = Buffer.concat([png, Buffer.from('fixture-two')]);
async function setup(kind: 'model' | 'animation' | 'vfx' = 'model') {
  const root = await mkdtemp(join(tmpdir(), 'motion-workflow-'));
  const a = join(root, 'a.png'), b = join(root, 'b.png'), artifact = join(root, 'asset.json');
  await Promise.all([writeFile(a, png), writeFile(b, png2), writeFile(artifact,
    JSON.stringify(kind === 'animation' ? animationPreset('idle', 'Workflow Fixture', 1, 1) : {}))]);
  const store = new Workflows(join(root, 'sessions'));
  const brief = { name: 'Test', kind, request: 'Create the requested asset', approach: 'Compare rough forms before detailing', requirements: [{ id: 'shape', description: 'Match reference shape' }], avoid: ['Beveled boxes'], references: [{ path: a, useFor: 'Proportions' }] };
  const { workflow } = await store.start(brief);
  const evidence = [{ path: a, view: 'front', time: 0, description: 'Start' }, { path: b, view: 'side', time: 1, description: 'End' }];
  const attach = (w: Workflow) => store.candidate(w.id, w.revision, artifact, 'Changed silhouette based on the brief', evidence);
  return { root, store, workflow, brief, evidence, attach, artifact, a, b };
}
function review(w: Workflow, verdict: 'pass' | 'fail' | 'unknown' = 'pass') {
  const ids = w.candidates.at(-1)!.evidence.map(e => e.id);
  return { reviewer: 'ai' as const, summary: 'Fixture review, not a real quality assessment', findings: [{ requirementId: 'shape', verdict, evidenceIds: ids, reason: 'Fixture finding', ...(verdict === 'fail' ? { correction: 'Rebuild the silhouette' } : {}) }], exclusions: [{ index: 0, verdict: 'pass' as const, evidenceIds: ids, reason: 'Fixture exclusion check' }] };
}
async function deliverCandidateImages(store: Workflows, workflow: Workflow) {
  const candidate = workflow.candidates.at(-1)!;
  for (const evidence of candidate.evidence) await store.image(workflow.id, evidence.id);
}
async function attachExactAnimationCandidate(store: Workflows, workflow: Workflow, artifactPath: string,
  recipe: AnimationRecipe, changes = 'Captured exact animation candidate') {
  const captureBatchId = randomUUID(), sessionId = randomUUID(), rigId = randomUUID();
  const frames = [{ time: 0, view: 'front' as const }, { time: recipe.duration, view: 'front' as const }];
  const captures: VerifiedWorkflowCapture[] = [png, png2].map((bytes, index) => ({ captureId: randomUUID(), captureBatchId,
    sessionId, source: 'candidate', assetFingerprint: fingerprint(recipe), rigId, rigSignature: 'workflow-fixture-rig',
    imageSha256: createHash('sha256').update(bytes).digest('hex'), time: frames[index]!.time, view: 'front',
    captureBatchExpectedFrames: frames, captureBatchStatus: 'complete', png: bytes }));
  return store.candidateFromCaptures(workflow.id, workflow.revision, artifactPath, changes, captures);
}

test('all asset types follow their own full stage plans and persist across restart', async () => {
  const expected = { model: ['silhouette', 'surfaces', 'rigging'], animation: ['key_poses', 'timing', 'polish'], vfx: ['shape', 'timing', 'integration'] };
  for (const kind of ['model', 'animation', 'vfx'] as const) {
    const s = await setup(kind); let w = s.workflow;
    for (const stage of expected[kind]) {
      assert.equal((await s.store.read(w.id)).next.stage, stage);
      const attached = kind === 'animation'
        ? await attachExactAnimationCandidate(s.store, w, s.artifact, animationPreset('idle', 'Workflow Fixture', 1, 1))
        : await s.attach(w);
      w = attached.workflow;
      assert.equal((await s.store.read(w.id)).next.state, 'needs_review');
      if (stage === expected[kind].at(-1)) {
        const incomplete = { ...review(w), findings: [{ ...review(w).findings[0]!, verdict: 'not_applicable' as const }] };
        await assert.rejects(s.store.review(w.id, w.revision, w.candidates.at(-1)!.id, incomplete), /final stage must assess/);
      }
      await deliverCandidateImages(s.store, w);
      const result = await s.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w));
      w = result.workflow;
    }
    assert.equal((await new Workflows(s.store.directory).read(w.id)).next.state, 'reviewed');
    assert.equal((await s.store.list()).entries[0]!.revision, 7);
    await assert.rejects(s.attach(w), /reviewed/);
  }
});
test('an all-pass AI workflow review requires delivery of every exact candidate image', async () => {
  const s = await setup('model');
  const attached = (await s.attach(s.workflow)).workflow;
  const candidate = attached.candidates.at(-1)!;
  const missing = candidate.evidence[1]!;
  const first = await s.store.image(attached.id, candidate.evidence[0]!.id);
  assert.deepEqual(first.responseReceipt, { workflowId: attached.id, workflowRevision: attached.revision,
    candidateId: candidate.id, evidenceId: candidate.evidence[0]!.id, imageSha256: candidate.evidence[0]!.sha256,
    status: 'included_in_server_response', limitation: 'Confirms the server constructed a response containing these exact candidate image bytes. It does not confirm client receipt, model perception, or correct interpretation.' });
  await assert.rejects(s.store.review(attached.id, attached.revision, candidate.id, review(attached)), error => {
    assert.match(String(error), /all-pass AI review cannot advance before the server has returned every candidate image/);
    assert.match(String(error), new RegExp(missing.id));
    return true;
  });
  await s.store.image(attached.id, missing.id);
  const passed = await s.store.review(attached.id, attached.revision, candidate.id, review(attached));
  assert.equal(passed.next.stage, 'surfaces');
});
test('AI image delivery receipts are ephemeral across workflow server restarts', async () => {
  const s = await setup('model');
  const attached = (await s.attach(s.workflow)).workflow;
  await deliverCandidateImages(s.store, attached);
  const restartedServerStore = new Workflows(s.store.directory);
  await assert.rejects(restartedServerStore.review(attached.id, attached.revision, attached.candidates.at(-1)!.id, review(attached)),
    /all-pass AI review cannot advance before the server has returned every candidate image through motion_workflow_read_evidence in this process/);
  await deliverCandidateImages(restartedServerStore, attached);
  const passed = await restartedServerStore.review(attached.id, attached.revision, attached.candidates.at(-1)!.id, review(attached));
  assert.equal(passed.next.stage, 'surfaces');
});
test('an all-pass AI animation review rejects unbound manual screenshots', async () => {
  const s = await setup('animation');
  const attached = (await s.attach(s.workflow)).workflow;
  await deliverCandidateImages(s.store, attached);
  await assert.rejects(s.store.review(attached.id, attached.revision, attached.candidates.at(-1)!.id, review(attached)),
    /requires complete Studio captures bound to the exact candidate recipe fingerprint/);
});
test('each passed AI animation requirement and exclusion must cite two whole-body capture times', async () => {
  const s = await setup('animation');
  const recipe = animationPreset('idle', 'Temporal citation fixture', 1, 1);
  await writeFile(s.artifact, JSON.stringify(recipe));
  const attached = (await attachExactAnimationCandidate(s.store, s.workflow, s.artifact, recipe)).workflow;
  const candidate = attached.candidates.at(-1)!;
  await deliverCandidateImages(s.store, attached);
  const sparse = review(attached);
  sparse.findings[0]!.evidenceIds = [candidate.evidence[0]!.id];
  await assert.rejects(s.store.review(attached.id, attached.revision, candidate.id, sparse),
    /two or more distinct times for each passed requirement and exclusion.*requirement shape/);
  const missingExclusionTime = review(attached);
  missingExclusionTime.exclusions[0]!.evidenceIds = [candidate.evidence[1]!.id];
  await assert.rejects(s.store.review(attached.id, attached.revision, candidate.id, missingExclusionTime),
    /two or more distinct times for each passed requirement and exclusion.*exclusion 0/);
  const accepted = await s.store.review(attached.id, attached.revision, candidate.id, review(attached));
  assert.equal(accepted.next.stage, 'timing');
});
test('workflow next-step plans are stage- and state-aware advisory tool sequences', async () => {
  const animation = await setup('animation');
  const keyPosePlan = (await animation.store.read(animation.workflow.id)).next.actions;
  assert.match(keyPosePlan.find(action => action.tool === 'motion_studio_open_candidate')!.when, /checkpointHandoff.*motion_editor_checkpoint_create/);
  assert.deepEqual(keyPosePlan.map(action => action.tool),
    ['motion_studio_sessions', 'motion_agent_readiness', 'motion_studio_inspect', 'motion_animation_blueprint_preview',
      'motion_animation_blueprint_goal_preview', 'motion_animation_candidate_evaluate', 'motion_studio_open_candidate',
      'motion_studio_capture_preflight', 'motion_studio_capture_candidate_plan', 'motion_studio_capture_candidate_views',
      'motion_studio_read_candidate_captures', 'motion_workflow_attach_candidate_captures']);
  const goalPreviewGuidance = keyPosePlan.find(action => action.tool === 'motion_animation_blueprint_goal_preview')!;
  assert.equal(goalPreviewGuidance.optional, true, 'world-space IK is a conditional branch, not a mandatory workflow step');
  assert.match(goalPreviewGuidance.when, /user states target positions or trustworthy Studio evidence supplies them; never guess world coordinates/i);
  const workflowRecipe = animationPreset('idle', 'Workflow Fixture', 1, 1);
  let w = (await attachExactAnimationCandidate(animation.store, animation.workflow, animation.artifact, workflowRecipe)).workflow;
  assert.deepEqual((await animation.store.read(w.id)).next.actions.map(action => action.tool),
    ['motion_workflow_read_evidence', 'motion_workflow_append_candidate_captures']);
  await deliverCandidateImages(animation.store, w);
  w = (await animation.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w))).workflow;
  assert.equal((await animation.store.read(w.id)).next.stage, 'timing');
  const timingPlan = (await animation.store.read(w.id)).next.actions;
  assert.match(timingPlan.find(action => action.tool === 'motion_studio_open_candidate')!.when, /does not authorize replacing unsaved edits/);
  assert.deepEqual(timingPlan.map(action => action.tool), [
    'motion_animation_candidate_evaluate', 'motion_studio_open_candidate', 'motion_studio_capture_preflight',
    'motion_studio_capture_candidate_plan', 'motion_studio_capture_candidate_views', 'motion_studio_read_candidate_captures',
    'motion_workflow_attach_candidate_captures', 'motion_animation_audit',
  ]);
  assert.equal(timingPlan.at(-1)?.optional, true, 'saved-asset audit must not imply that an unsaved workflow draft should be committed');
  w = (await attachExactAnimationCandidate(animation.store, w, animation.artifact, workflowRecipe)).workflow;
  await deliverCandidateImages(animation.store, w);
  w = (await animation.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w))).workflow;
  assert.equal((await animation.store.read(w.id)).next.stage, 'polish');
  const polishPlan = (await animation.store.read(w.id)).next.actions;
  assert.match(polishPlan.find(action => action.tool === 'motion_studio_open_candidate')!.when, /respect the dirty-draft guard/);
  assert.deepEqual(polishPlan.map(action => action.tool), [
    'motion_animation_candidate_evaluate', 'motion_studio_open_candidate', 'motion_studio_capture_preflight',
    'motion_studio_capture_candidate_plan', 'motion_studio_capture_candidate_views', 'motion_studio_read_candidate_captures',
    'motion_workflow_attach_candidate_captures', 'motion_animation_audit', 'motion_animation_test_plan_preview',
    'motion_animation_test_plan_create', 'motion_animation_test_plan_run', 'motion_workflow_attach_animation_test_run',
  ]);
  assert.ok(polishPlan.slice(-4).every(action => action.optional), 'technical test planning is optional unless the brief defines measurable gameplay constraints');

  const vfx = await setup('vfx');
  let vfxWorkflow = vfx.workflow;
  for (const stage of ['shape', 'timing'] as const) {
    if (stage === 'timing') {
      vfxWorkflow = (await vfx.attach(vfxWorkflow)).workflow;
      await deliverCandidateImages(vfx.store, vfxWorkflow);
      vfxWorkflow = (await vfx.store.review(vfxWorkflow.id, vfxWorkflow.revision, vfxWorkflow.candidates.at(-1)!.id, review(vfxWorkflow))).workflow;
    }
  }
  assert.deepEqual((await vfx.store.read(vfxWorkflow.id)).next.actions.map(action => action.tool),
    ['motion_vfx_timeline_preview', 'motion_vfx_timeline_create', 'motion_studio_preview']);
});
test('workflow history validates persisted stage lineage and isolates corrupt records in a paginated inbox', async () => {
  const s = await setup('model');
  const attached = (await s.attach(s.workflow)).workflow;
  const latestPath = join(s.store.directory, attached.id, `${String(attached.revision).padStart(6, '0')}.json`);
  const stored = JSON.parse(await readFile(latestPath, 'utf8')) as Workflow;
  stored.candidates[0]!.stage = 'rigging';
  await writeFile(latestPath, JSON.stringify(stored));

  const malformedFileId = randomUUID(), malformedJsonId = randomUUID();
  await writeFile(join(s.store.directory, malformedFileId), 'not a workflow directory');
  await mkdir(join(s.store.directory, malformedJsonId), { recursive: true });
  await writeFile(join(s.store.directory, malformedJsonId, '000001.json'), '{ malformed workflow');
  await assert.rejects(s.store.read(attached.id), /stage history is out of order/);

  const first = await s.store.list(0, 1, 0);
  assert.equal(first.total, 0);
  assert.equal(first.invalidRecordCount, 3);
  assert.equal(first.invalidRecords.length, 1);
  assert.equal(first.nextInvalidOffset, 1);
  const second = await s.store.list(0, 1, first.nextInvalidOffset!);
  assert.equal(second.invalidRecords.length, 1);
  assert.equal(second.nextInvalidOffset, 2);
  const third = await s.store.list(0, 1, second.nextInvalidOffset!);
  assert.equal(third.invalidRecords.length, 1);
  assert.equal(third.nextInvalidOffset, null);
});
test('workflow history refuses to report a valid state when an immutable revision snapshot is missing', async () => {
  const s = await setup('model');
  const attached = (await s.attach(s.workflow)).workflow;
  await unlink(join(s.store.directory, attached.id, '000001.json'));
  await assert.rejects(s.store.read(attached.id), /missing or unexpected snapshots/);
  const inbox = await s.store.list();
  assert.equal(inbox.total, 0);
  assert.equal(inbox.invalidRecordCount, 1);
  assert.match(inbox.invalidRecords[0]!.error, /missing or unexpected snapshots/);
});
test('versioned workflow snapshots detect capture-provenance tampering and retain digest-free legacy reads', async () => {
  const s = await setup('animation');
  const recipe = animationPreset('idle', 'Integrity fixture', 1, 1);
  await writeFile(s.artifact, JSON.stringify(recipe));
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'integrity-rig', captureBatchId = randomUUID();
  const captureBatchExpectedFrames = [{ time: 0, view: 'front' as const }, { time: 0.5, view: 'front' as const }];
  const captures = [0, 0.5].map((time, index) => {
    const bytes = index === 0 ? png : png2;
    return { captureId: randomUUID(), captureBatchId, sessionId, source: 'candidate' as const,
      assetFingerprint: fingerprint(recipe), rigId, rigSignature,
      imageSha256: createHash('sha256').update(bytes).digest('hex'), time, view: 'front' as const, captureBatchExpectedFrames,
      captureBatchStatus: 'complete' as const, png: bytes };
  });
  const attached = await s.store.candidateFromCaptures(s.workflow.id, 1, s.artifact, 'Integrity test', captures);
  const snapshotPath = join(s.store.directory, s.workflow.id, `${String(attached.workflow.revision).padStart(6, '0')}.json`);
  const original = JSON.parse(await readFile(snapshotPath, 'utf8')) as Workflow;
  assert.equal(original.snapshotVersion, 1);
  assert.equal(original.integrity?.algorithm, 'sha256');

  const missingMarker = { ...original } as Workflow;
  delete missingMarker.integrity;
  await writeFile(snapshotPath, JSON.stringify(missingMarker));
  await assert.rejects(s.store.read(s.workflow.id), /Versioned workflow snapshots must include their integrity digest/);

  original.candidates[0]!.evidence.forEach(item => { item.captureBinding!.rigSignature = 'tampered-but-schema-valid'; });
  await writeFile(snapshotPath, JSON.stringify(original));
  await assert.rejects(s.store.read(s.workflow.id), /Workflow snapshot integrity check failed/);

  const legacy = await setup('model');
  const legacyPath = join(legacy.store.directory, legacy.workflow.id, '000001.json');
  const legacySnapshot = JSON.parse(await readFile(legacyPath, 'utf8')) as Workflow;
  delete legacySnapshot.snapshotVersion;
  delete legacySnapshot.integrity;
  await writeFile(legacyPath, JSON.stringify(legacySnapshot));
  assert.equal((await legacy.store.read(legacy.workflow.id)).workflow.id, legacy.workflow.id);
});
test('workflow reads reject persisted stage passes that omit requirements or exclusions', async () => {
  const s = await setup('model');
  let w = (await s.attach(s.workflow)).workflow;
  await deliverCandidateImages(s.store, w);
  w = (await s.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w))).workflow;
  const path = join(s.store.directory, w.id, `${String(w.revision).padStart(6, '0')}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8')) as Workflow;
  stored.candidates[0]!.review!.findings = [];
  await writeFile(path, JSON.stringify(stored));
  await assert.rejects(s.store.read(w.id), /assess every current requirement exactly once/);
  const inbox = await s.store.list();
  assert.equal(inbox.total, 0);
  assert.match(inbox.invalidRecords[0]!.error, /assess every current requirement exactly once/);
});
test('failed and unknown reviews retain the stage and three attempts require a new approach', async () => {
  const s = await setup(); let w = s.workflow;
  for (let i = 0; i < 3; i++) {
    w = (await s.attach(w)).workflow;
    w = (await s.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w, i === 1 ? 'unknown' : 'fail'))).workflow;
    assert.equal((await s.store.read(w.id)).next.stage, 'silhouette');
  }
  await assert.rejects(s.attach(w), /rethink_approach/);
  const revised = await s.store.revise(w.id, w.revision, { ...s.brief, approach: 'A genuinely different approach after feedback' });
  assert.equal(revised.next.attempts, 0); assert.equal(revised.workflow.candidates.length, 3);
  assert.equal(revised.workflow.briefRevision, 2);
});
test('reviews reject omissions, other-candidate evidence, duplicate findings and unreviewed replacement', async () => {
  const s = await setup(); const w = (await s.attach(s.workflow)).workflow; const c = w.candidates.at(-1)!;
  const run = (r: ReturnType<typeof review>) => s.store.review(w.id, w.revision, c.id, r);
  await assert.rejects(s.attach(w), /needs_review/);
  await assert.rejects(run({ ...review(w), exclusions: [] }), /every avoid/);
  await assert.rejects(run({ ...review(w), findings: [...review(w).findings, ...review(w).findings] }), /exactly once/);
  const wrong = review(w); wrong.findings[0]!.evidenceIds = [s.workflow.id];
  await assert.rejects(run(wrong), /another candidate/);
  const absent = review(w); absent.findings[0]!.evidenceIds = [];
  await assert.rejects(run(absent), /cite candidate evidence/);
});
test('changed artifact, evidence, or reference cannot inherit a review', async () => {
  for (const target of ['artifact', 'a', 'b'] as const) {
    const s = await setup(); const w = (await s.attach(s.workflow)).workflow;
    await writeFile(s[target], 'changed');
    await assert.rejects(s.store.review(w.id, w.revision, w.candidates.at(-1)!.id, review(w)), /Attached file changed/);
    if (target !== 'artifact') await assert.rejects(s.store.image(w.id, w.candidates.at(-1)!.evidence[target === 'a' ? 0 : 1]!.id), /changed/);
  }
});
test('stale and concurrent updates cannot overwrite revision history', async () => {
  const s = await setup();
  const result = await Promise.allSettled([s.attach(s.workflow), s.attach(s.workflow)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(s.store.revise(s.workflow.id, 1, s.brief), /Stale/);
  assert.equal((await s.store.read(s.workflow.id)).workflow.candidates.length, 1);
});
test('evidence requires real distinct files, views or times and can be delivered with its fingerprint', async () => {
  const s = await setup(); const w = s.workflow;
  await assert.rejects(s.store.candidate(w.id, w.revision, s.artifact, 'test', s.evidence.map(e => ({ ...e, view: 'front' }))), /two distinct views/);
  await writeFile(s.b, png);
  await assert.rejects(s.attach(w), /distinct content/);
  await writeFile(s.b, png2);
  const attached = (await s.attach(w)).workflow;
  const image = await s.store.image(w.id, attached.candidates[0]!.evidence[0]!.id);
  assert.equal(image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  assert.equal((await s.store.image(w.id, undefined, 0)).data, image.data);
  const a = await setup('animation');
  await assert.rejects(a.store.candidate(a.workflow.id, 1, a.artifact, 'test', a.evidence.map(e => ({ ...e, time: 0 }))), /distinct explicit sample times/);
});

test('animation workflow records exact recipe and acceptance-run provenance durably and idempotently', async () => {
  const s = await setup('animation');
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Candidate', duration: 1, loop: false,
    tracks: [{ joint: 'RightArm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [20, 0, 0] }] }], markers: [] };
  await writeFile(s.artifact, JSON.stringify(recipe));
  const w = (await s.attach(s.workflow)).workflow;
  assert.equal(w.candidates.at(-1)!.animationFingerprint, fingerprint(recipe));
  const candidateId = w.candidates.at(-1)!.id;
  const provenance = { workflowId: w.id, revision: w.revision, candidateId, assetId: randomUUID(), assetFingerprint: fingerprint(recipe),
    testPlanId: randomUUID(), testPlanRevision: 2, testRunId: randomUUID(), rigId: randomUUID(), rigSignature: 'r15-topology-v1' };
  const attached = await s.store.attachAnimationValidation(provenance);
  assert.equal(attached.idempotent, false);
  assert.deepEqual((await new Workflows(s.store.directory).read(w.id)).workflow.candidates.at(-1)!.animationValidation,
    { assetId: provenance.assetId, assetFingerprint: provenance.assetFingerprint, testPlanId: provenance.testPlanId,
      testPlanRevision: provenance.testPlanRevision, testRunId: provenance.testRunId, rigId: provenance.rigId,
      rigSignature: provenance.rigSignature, recordedAt: attached.validation.recordedAt });
  const retry = await s.store.attachAnimationValidation(provenance);
  assert.equal(retry.idempotent, true);
  await assert.rejects(s.store.attachAnimationValidation({ ...provenance, testRunId: randomUUID() }), /Stale workflow revision/);
});

test('animation workflow rejects non-recipe artifacts and binds validation to the attached recipe fingerprint', async () => {
  const s = await setup('animation');
  await writeFile(s.artifact, '{}');
  await assert.rejects(s.attach(s.workflow), /valid Motion Tools animation recipe JSON/);
  const vfx = { kind: 'vfx', name: 'Wrong kind', color: [1, 1, 1], size: 1, lifetime: 1, speed: 0, count: 1 };
  await writeFile(s.artifact, JSON.stringify(vfx));
  await assert.rejects(s.attach(s.workflow), /animation recipe, not another asset type/);

  const recipe = animationPreset('idle', 'Bound Recipe', 1, 1);
  await writeFile(s.artifact, JSON.stringify(recipe));
  const attached = (await s.attach(s.workflow)).workflow;
  const candidate = attached.candidates.at(-1)!;
  assert.equal(candidate.animationFingerprint, fingerprint(recipe));
  const provenance = { workflowId: attached.id, revision: attached.revision, candidateId: candidate.id, assetId: randomUUID(),
    assetFingerprint: fingerprint(animationPreset('walk', 'Different Recipe', 1, 1)), testPlanId: randomUUID(), testPlanRevision: 1,
    testRunId: randomUUID(), rigId: randomUUID(), rigSignature: 'rig-signature' };
  await assert.rejects(s.store.attachAnimationValidation(provenance), /does not match the exact recipe attached/);
});

test('workflow stores server-verified capture provenance with exact candidate recipe and rig identity', async () => {
  const s = await setup('animation');
  const recipe = animationPreset('walk', 'Captured Candidate', 1, 1);
  await writeFile(s.artifact, JSON.stringify(recipe));
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'active-rig-topology', captureBatchId = randomUUID();
  const captureBatchExpectedFrames = [{ time: 0, view: 'front' as const }, { time: 0.5, view: 'front' as const }];
  const captures = [
    { captureId: randomUUID(), captureBatchId, sessionId, source: 'candidate' as const,
      assetFingerprint: fingerprint(recipe), rigId, rigSignature, imageSha256: createHash('sha256').update(png).digest('hex'), time: 0, view: 'front' as const,
      captureBatchExpectedFrames, captureBatchStatus: 'complete' as const, png },
    { captureId: randomUUID(), captureBatchId, sessionId, source: 'candidate' as const,
      assetFingerprint: fingerprint(recipe), rigId, rigSignature, imageSha256: createHash('sha256').update(png2).digest('hex'), time: 0.5, view: 'front' as const,
      captureBatchExpectedFrames, captureBatchStatus: 'complete' as const, png: png2 },
  ];
  const attached = await s.store.candidateFromCaptures(s.workflow.id, s.workflow.revision, s.artifact,
    'Captured exact unsaved candidate', captures);
  const evidence = attached.workflow.candidates[0]!.evidence;
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]!.captureBinding?.assetFingerprint, fingerprint(recipe));
  assert.equal(evidence[0]!.captureBinding?.rigSignature, rigSignature);
  assert.equal(evidence[0]!.captureBinding?.imageSha256, evidence[0]!.sha256);
  assert.deepEqual(attached.workflow.candidates[0]!.captureCoverage, { status: 'complete', captureBatchCount: 1,
    expectedWholeBodyFrameCount: 2, capturedWholeBodyFrameCount: 2, missingWholeBodyFrames: [], omittedMissingFrameCount: 0,
    focusedFrameCount: 0, incompleteBatchCount: 0 });
  const image = await s.store.image(s.workflow.id, evidence[0]!.id);
  assert.equal(image.captureBinding?.captureId, captures[0]!.captureId);
  const reloaded = await new Workflows(s.store.directory).read(s.workflow.id);
  assert.equal(reloaded.workflow.candidates[0]!.evidence[1]!.captureBinding?.time, 0.5);

  const wrongRigCaptures = captures.map((capture, index) => ({ ...capture, captureId: randomUUID(),
    ...(index === 1 ? { rigSignature: 'different-topology' } : {}) }));
  await assert.rejects(s.store.candidateFromCaptures(s.workflow.id, s.workflow.revision, s.artifact,
    'Wrong rig binding', wrongRigCaptures), /one unchanged rig/);
  const mixedBatchCaptures = captures.map((capture, index) => ({ ...capture, captureId: randomUUID(),
    ...(index === 1 ? { captureBatchId: randomUUID() } : {}) }));
  await assert.rejects(s.store.candidateFromCaptures(s.workflow.id, s.workflow.revision, s.artifact,
    'Mixed capture batches', mixedBatchCaptures), /one batch/);
  const duplicateSchedule = captures.map(capture => ({ ...capture, captureId: randomUUID(),
    captureBatchExpectedFrames: [...captureBatchExpectedFrames, captureBatchExpectedFrames[0]!] }));
  await assert.rejects(s.store.candidateFromCaptures(s.workflow.id, s.workflow.revision, s.artifact,
    'Duplicate scheduled frames', duplicateSchedule), /Capture schedule frames must be unique/);
  await deliverCandidateImages(s.store, attached.workflow);
  const capturedCandidate = attached.workflow.candidates[0]!;
  const reviewed = await s.store.review(attached.workflow.id, attached.workflow.revision, capturedCandidate.id, review(attached.workflow));
  assert.equal(reviewed.next.stage, 'timing', 'complete exact-candidate Studio captures plus image delivery permit a passing AI review');
});

test('incomplete or close-up-only Studio evidence cannot advance an animation stage as fully passing', async () => {
  const partial = await setup('animation');
  const recipe = animationPreset('walk', 'Partial capture', 1, 1);
  await writeFile(partial.artifact, JSON.stringify(recipe));
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'partial-rig', captureBatchId = randomUUID();
  const expected = [{ time: 0, view: 'front' as const }, { time: 0.5, view: 'front' as const }, { time: 1, view: 'front' as const }];
  const partialCaptures = [png, png2].map((bytes, index) => ({ captureId: randomUUID(), captureBatchId, sessionId,
    source: 'candidate' as const, assetFingerprint: fingerprint(recipe), rigId, rigSignature,
    imageSha256: createHash('sha256').update(bytes).digest('hex'), time: index * 0.5, view: 'front' as const,
    captureBatchExpectedFrames: expected, captureBatchStatus: 'partial' as const, png: bytes }));
  const attached = await partial.store.candidateFromCaptures(partial.workflow.id, 1, partial.artifact, 'Only two of three frames returned', partialCaptures);
  const candidate = attached.workflow.candidates.at(-1)!;
  assert.equal(candidate.captureCoverage?.status, 'partial');
  assert.deepEqual(candidate.captureCoverage?.missingWholeBodyFrames, [{ captureBatchId, time: 1, view: 'front' }]);
  await assert.rejects(partial.store.review(attached.workflow.id, attached.workflow.revision, candidate.id, review(attached.workflow)),
    /Incomplete Studio capture coverage cannot advance/);
  const retryPng = Buffer.concat([png, Buffer.from('retry-frame')]);
  const retryBatchId = randomUUID();
  const supplementalPng = Buffer.concat([png, Buffer.from('supplemental-material-beat')]);
  const supplementalCapture: VerifiedWorkflowCapture = {
    captureId: randomUUID(), captureBatchId: randomUUID(), sessionId, source: 'candidate', assetFingerprint: fingerprint(recipe), rigId, rigSignature,
    imageSha256: createHash('sha256').update(supplementalPng).digest('hex'), time: 0.75, view: 'front',
    captureBatchExpectedFrames: [{ time: 0.75, view: 'front' }], captureBatchStatus: 'complete', png: supplementalPng,
  };
  const supplemental = await partial.store.appendCandidateCapturesFromStudio(attached.workflow.id, attached.workflow.revision, candidate.id, [supplementalCapture]);
  assert.equal(supplemental.workflow.candidates[0]!.id, candidate.id);
  assert.equal(supplemental.workflow.candidates[0]!.evidence.length, 3);
  assert.deepEqual(supplemental.workflow.candidates[0]!.captureCoverage, { status: 'partial', captureBatchCount: 2,
    expectedWholeBodyFrameCount: 3, capturedWholeBodyFrameCount: 2, missingWholeBodyFrames: [{ captureBatchId, time: 1, view: 'front' }],
    omittedMissingFrameCount: 0, focusedFrameCount: 0, incompleteBatchCount: 1 },
  'an unplanned supplemental moment adds review evidence without expanding or completing the original required schedule');
  await assert.rejects(partial.store.appendCandidateCapturesFromStudio(supplemental.workflow.id, supplemental.workflow.revision, candidate.id,
    [supplementalCapture]), /cannot reuse an attached capture ID or duplicate an already attached frame/);
  const outOfDurationPng = Buffer.concat([png2, Buffer.from('out-of-duration')]);
  await assert.rejects(partial.store.appendCandidateCapturesFromStudio(supplemental.workflow.id, supplemental.workflow.revision, candidate.id, [{
    captureId: randomUUID(), captureBatchId: randomUUID(), sessionId, source: 'candidate', assetFingerprint: fingerprint(recipe), rigId, rigSignature,
    imageSha256: createHash('sha256').update(outOfDurationPng).digest('hex'), time: 1.25, view: 'front',
    captureBatchExpectedFrames: [{ time: 1.25, view: 'front' }], captureBatchStatus: 'complete', png: outOfDurationPng,
  }]), /inside the exact candidate animation duration/);
  const retry = await partial.store.appendCandidateCapturesFromStudio(supplemental.workflow.id, supplemental.workflow.revision, candidate.id, [{
    captureId: randomUUID(), captureBatchId: retryBatchId, sessionId, source: 'candidate', assetFingerprint: fingerprint(recipe), rigId, rigSignature,
    imageSha256: createHash('sha256').update(retryPng).digest('hex'), time: 1, view: 'front',
    captureBatchExpectedFrames: [{ time: 1, view: 'front' }], captureBatchStatus: 'complete', png: retryPng,
  }]);
  assert.equal(retry.workflow.candidates[0]!.id, candidate.id, 'retry extends the same unreviewed candidate rather than regenerating it');
  assert.equal(retry.workflow.candidates[0]!.evidence.length, 4, 'existing and supplemental evidence is preserved as the missing frame is added');
  assert.deepEqual(retry.workflow.candidates[0]!.captureCoverage, { status: 'complete', captureBatchCount: 3,
    expectedWholeBodyFrameCount: 3, capturedWholeBodyFrameCount: 3, missingWholeBodyFrames: [], omittedMissingFrameCount: 0,
    focusedFrameCount: 0, incompleteBatchCount: 0 });
  assert.ok(retry.next.actions.some(action => action.tool === 'motion_workflow_append_candidate_captures'),
    'a fully covered but unreviewed candidate can still accept optional supplemental visual evidence');
  const focusedPng = Buffer.concat([png, Buffer.from('supplemental-focused-frame')]);
  const focusedSupplemental = await partial.store.appendCandidateCapturesFromStudio(retry.workflow.id, retry.workflow.revision, candidate.id, [{
    captureId: randomUUID(), captureBatchId: randomUUID(), sessionId, source: 'candidate', assetFingerprint: fingerprint(recipe), rigId, rigSignature,
    imageSha256: createHash('sha256').update(focusedPng).digest('hex'), time: 0.75, view: 'side', focusJoint: 'RightArm',
    captureBatchExpectedFrames: [{ time: 0.75, view: 'side', focusJoint: 'RightArm' }], captureBatchStatus: 'complete', png: focusedPng,
  }]);
  assert.equal(focusedSupplemental.workflow.candidates[0]!.id, candidate.id);
  assert.equal(focusedSupplemental.workflow.candidates[0]!.evidence.at(-1)!.captureBinding?.focusJoint, 'RightArm',
    'supplemental focused evidence keeps its exact rig-node identity');
  assert.deepEqual(focusedSupplemental.workflow.candidates[0]!.captureCoverage, { status: 'complete', captureBatchCount: 4,
    expectedWholeBodyFrameCount: 3, capturedWholeBodyFrameCount: 3, missingWholeBodyFrames: [], omittedMissingFrameCount: 0,
    focusedFrameCount: 1, incompleteBatchCount: 0 }, 'focused additions do not alter required whole-body coverage');
  await deliverCandidateImages(partial.store, focusedSupplemental.workflow);
  const passed = await partial.store.review(focusedSupplemental.workflow.id, focusedSupplemental.workflow.revision, candidate.id, review(focusedSupplemental.workflow));
  assert.equal(passed.next.stage, 'timing');

  const closeups = await setup('animation');
  const closeupRecipe = animationPreset('idle', 'Close-up only', 1, 1);
  await writeFile(closeups.artifact, JSON.stringify(closeupRecipe));
  const closeupBatchId = randomUUID(), closeupExpected = [0, 0.5].map(time => ({ time, view: 'front' as const, focusJoint: 'RightArm' }));
  const closeupCaptures = [png, png2].map((bytes, index) => ({ captureId: randomUUID(), captureBatchId: closeupBatchId,
    sessionId: randomUUID(), source: 'candidate' as const, assetFingerprint: fingerprint(closeupRecipe), rigId: randomUUID(), rigSignature: 'closeup-rig',
    imageSha256: createHash('sha256').update(bytes).digest('hex'), time: index * 0.5, view: 'front' as const, focusJoint: 'RightArm',
    captureBatchExpectedFrames: closeupExpected, captureBatchStatus: 'complete' as const, png: bytes }));
  closeupCaptures[1]!.sessionId = closeupCaptures[0]!.sessionId;
  closeupCaptures[1]!.rigId = closeupCaptures[0]!.rigId;
  const closeupAttached = await closeups.store.candidateFromCaptures(closeups.workflow.id, 1, closeups.artifact,
    'Only focused joint images', closeupCaptures);
  const closeupCandidate = closeupAttached.workflow.candidates.at(-1)!;
  assert.equal(closeupCandidate.captureCoverage?.status, 'missing_whole_body');
  assert.ok(closeupAttached.next.actions.some(action => action.tool === 'motion_workflow_append_candidate_captures'),
    'the AI handoff should offer an in-place evidence retry before the candidate is reviewed');
  await assert.rejects(closeups.store.review(closeups.workflow.id, closeupAttached.workflow.revision, closeupCandidate.id,
    review(closeupAttached.workflow)), /Incomplete Studio capture coverage cannot advance/);
});
