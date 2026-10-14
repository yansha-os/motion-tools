import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { summarizeVisualCandidateAudit, VisualBakeoffHistory, visualBakeoffReportFingerprint, type VisualBakeoffRecordInput } from '../src/visual-bakeoff-history.js';
import { fingerprint, fingerprintUuid } from '../src/inspection.js';
import type { Telemetry } from '../src/inspection.js';
import { animationSchema } from '../src/recipes.js';

function input(): VisualBakeoffRecordInput {
  const captures = [randomUUID(), randomUUID()];
  const report = { jobId: randomUUID(), rigId: randomUUID(), rigSignature: 'rig-topology-v1',
    candidates: [{ label: 'Windup', candidateFingerprint: 'b'.repeat(64) }, { label: 'Direct', candidateFingerprint: 'c'.repeat(64) }],
    criteria: ['Readable anticipation'], assessments: [
      { candidateLabel: 'Windup', candidateFingerprint: 'b'.repeat(64), criterion: 'Readable anticipation', status: 'supported' as const,
        observation: 'The shoulder moves backward before the release.', evidence: [{ captureId: captures[0]!, time: 0.5, view: 'side', sha256: 'd'.repeat(64) }] },
      { candidateLabel: 'Direct', candidateFingerprint: 'c'.repeat(64), criterion: 'Readable anticipation', status: 'contradicted' as const,
        observation: 'No visible preparation appears before the release.', evidence: [{ captureId: captures[1]!, time: 0.5, view: 'side', sha256: 'e'.repeat(64) }] },
    ], limitation: 'Image citations were checked, but the agent-authored interpretation was not verified.' };
  return { ...report, reportFingerprint: visualBakeoffReportFingerprint(report) };
}

test('visual bake-off fingerprint binds each cited image to its joint-map provenance', () => {
  const baseline = input();
  const mapped = structuredClone(baseline);
  const evidence = mapped.assessments[0]!.evidence[0]!;
  mapped.assessments[0]!.evidence[0] = { ...evidence, jointMapping: { fingerprint: 'f'.repeat(64), renamedJointCount: 1,
    nameMapApplied: true, renamedJoints: [{ source: 'UpperTorso', target: 'Torso' }],
    limitation: 'Joint-name mapping only; it does not retarget local axes, solve IK, or validate semantic equivalence.' } };
  mapped.reportFingerprint = visualBakeoffReportFingerprint(mapped);
  assert.notEqual(mapped.reportFingerprint, baseline.reportFingerprint);
});

test('visual bake-off reports persist append-only and remain readable after recreation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const first = await history.record(input());
    const second = await new VisualBakeoffHistory(root).record(input());
    assert.notEqual(first.id, second.id);
    const reopened = new VisualBakeoffHistory(root);
    assert.equal((await reopened.read(first.id)).reportFingerprint, first.reportFingerprint);
    const listed = await reopened.list(10);
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.records.map(record => record.id), [second.id, first.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cited visual bake-off screenshots persist by content hash and are verified after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-images-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const report = input();
    const makeRecipe = (name: string, rotation: number) => animationSchema.parse({ kind: 'animation' as const, name, duration: 1, loop: false,
      tracks: [{ joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [rotation, 0, 0] as [number, number, number] },
      ] }], markers: [{ name: 'Windup', time: 0.25, phase: 'anticipation' as const }],
      contacts: [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.4, end: 0.6 }] });
    const recipes = [
      { candidateLabel: 'Windup', candidateFingerprint: fingerprint(makeRecipe('Windup', 20)), recipe: makeRecipe('Windup', 20) },
      { candidateLabel: 'Direct', candidateFingerprint: fingerprint(makeRecipe('Direct', 30)), recipe: makeRecipe('Direct', 30) },
    ];
    report.candidates = recipes.map(item => ({ label: item.candidateLabel, candidateFingerprint: item.candidateFingerprint, duration: item.recipe.duration }));
    report.assessments = report.assessments.map(assessment => ({ ...assessment, candidateFingerprint:
      recipes.find(item => item.candidateLabel === assessment.candidateLabel)!.candidateFingerprint }));
    report.candidates = report.candidates.map(candidate => ({ ...candidate, duration: 1 }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    const sha256 = createHash('sha256').update(png).digest('hex');
    report.assessments = report.assessments.map(assessment => ({ ...assessment,
      evidence: assessment.evidence.map(evidence => ({ ...evidence, normalizedProgress: evidence.time, sha256 })) }));
    report.reportFingerprint = visualBakeoffReportFingerprint(report);
    const evidenceImages = report.assessments.flatMap(assessment => assessment.evidence.map(evidence => ({
      ...evidence, candidateLabel: assessment.candidateLabel, candidateFingerprint: assessment.candidateFingerprint,
      bytes: png.length, width: 1, height: 1, png,
    })));
    const invalidSnapshots = [recipes[0]!, { ...recipes[1]!, candidateFingerprint: 'f'.repeat(64) }];
    await assert.rejects(history.record({ ...report, candidateRecipes: invalidSnapshots, evidenceImages }), /does not match its exact recorded candidate fingerprint/i);
    await assert.rejects(readdir(join(root, 'images')), { code: 'ENOENT' }, 'invalid later recipe snapshots must fail before any screenshot bytes are written');
    const saved = await history.record({ ...report, candidateRecipes: recipes, evidenceImages });
    assert.equal(saved.evidenceImages?.length, 2);
    assert.ok(saved.evidenceImages?.every(image => image.sha256 === sha256));

    const reopened = new VisualBakeoffHistory(root);
    const recovered = await reopened.readEvidenceImage(saved.id, evidenceImages[0]!.captureId);
    assert.equal(recovered.sha256, sha256);
    assert.equal(recovered.pngBase64, png.toString('base64'));
    assert.equal(recovered.width, 1);
    assert.equal((await reopened.read(saved.id)).evidenceImages?.length, 2);

    const contextBeforeTampering = await reopened.readRefinementContext(saved.id, 'Windup');
    assert.equal(contextBeforeTampering.findings[0]!.imageBytesAvailable, true);
    assert.deepEqual(contextBeforeTampering.findings[0]!.evidence[0]!.authoredContext.nearbyMarkers.map(marker => marker.name), ['Windup']);
    assert.deepEqual(contextBeforeTampering.findings[0]!.evidence[0]!.authoredContext.activeDeclaredContacts,
      [{ effector: 'LeftFoot', kind: 'support', start: 0.4, end: 0.6 }]);
    assert.match(contextBeforeTampering.findings[0]!.evidence[0]!.authoredContext.interpretation, /not proof of visible pose.*actual contact/i);

    const imagePath = join(root, 'images', `${sha256}.png`);
    const tampered = Buffer.from(png);
    tampered[40] = tampered[40]! ^ 1;
    await writeFile(imagePath, tampered);
    await assert.rejects(reopened.readEvidenceImage(saved.id, evidenceImages[0]!.captureId), /SHA-256 integrity check/i);
    const contextAfterTampering = await reopened.readRefinementContext(saved.id, 'Windup');
    assert.equal(contextAfterTampering.findings[0]!.imageBytesAvailable, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off comparison reports normalized evidence-time changes without calling them event motion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-timing-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const makeRecord = (progress: number) => {
      const source = input();
      const record = { ...source,
        candidates: source.candidates.map(candidate => ({ ...candidate, duration: 2 })),
        assessments: source.assessments.map(assessment => ({ ...assessment, evidence: assessment.evidence.map(evidence => ({ ...evidence, normalizedProgress: progress })) })),
      };
      record.reportFingerprint = visualBakeoffReportFingerprint(record);
      return record;
    };
    const before = await history.record(makeRecord(0.25));
    const after = await history.record(makeRecord(0.4));
    const compared = await history.compareEvidenceTiming(before.id, after.id);
    assert.equal(compared.matchedAssessmentCount, 2);
    assert.equal(compared.regressionSummary.coverage, 'complete');
    assert.equal(compared.regressionSummary.reportedOutcome, 'no_reported_status_regression');
    assert.equal(compared.regressionSummary.interpretationVerified, false);
    const firstEvidence = compared.comparisons[0]!.evidenceByView[0]!;
    assert.equal(firstEvidence.before[0]!.normalizedProgress, 0.25);
    assert.equal(firstEvidence.after[0]!.normalizedProgress, 0.4);
    assert.ok(Math.abs(firstEvidence.normalizedProgressDeltaByOrder[0]! - 0.15) < 1e-9);
    assert.match(compared.interpretation, /does not measure the underlying motion event/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off comparison flags reported status regressions and incomplete rubric/candidate coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-regression-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const beforeInput = input();
    const afterInput = input();
    afterInput.assessments = afterInput.assessments.map(assessment => assessment.candidateLabel === 'Windup'
      ? { ...assessment, status: 'contradicted' as const, observation: 'The shoulder does not move backward before the release.' }
      : assessment);
    afterInput.reportFingerprint = visualBakeoffReportFingerprint(afterInput);
    const before = await history.record(beforeInput);
    const after = await history.record(afterInput);
    const compared = await history.compareEvidenceTiming(before.id, after.id);
    assert.equal(compared.regressionSummary.reportedOutcome, 'reported_regressions');
    assert.equal(compared.regressionSummary.reportedRegressions, 1);
    assert.equal(compared.regressionSummary.statusTransitions.find(item => item.candidateLabel === 'Windup')?.transition, 'reported_regressed');

    const changed = input();
    changed.criteria = ['Readable anticipation', 'Stable landing'];
    changed.assessments = [...changed.assessments, ...changed.assessments.map(assessment => ({ ...assessment,
      criterion: 'Stable landing', observation: 'The character settles into a balanced final pose.' }))];
    changed.reportFingerprint = visualBakeoffReportFingerprint(changed);
    const changedRecord = await history.record(changed);
    const incomplete = await history.compareEvidenceTiming(before.id, changedRecord.id);
    assert.equal(incomplete.regressionSummary.coverage, 'incomplete');
    assert.equal(incomplete.regressionSummary.reportedOutcome, 'inconclusive');
    assert.equal(incomplete.rubric.changed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off rechecks retain complete matched-label coverage when candidate recipes intentionally change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-recipe-change-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const beforeInput = input();
    const afterInput = input();
    afterInput.candidates = afterInput.candidates.map(candidate => ({ ...candidate,
      candidateFingerprint: candidate.label === 'Windup' ? 'f'.repeat(64) : candidate.candidateFingerprint }));
    afterInput.assessments = afterInput.assessments.map(assessment => assessment.candidateLabel === 'Windup'
      ? { ...assessment, candidateFingerprint: 'f'.repeat(64), observation: 'The revised recipe keeps the preparation before the release.' }
      : assessment);
    afterInput.reportFingerprint = visualBakeoffReportFingerprint(afterInput);
    const before = await history.record(beforeInput);
    const after = await history.record(afterInput);
    const compared = await history.compareEvidenceTiming(before.id, after.id);
    assert.equal(compared.regressionSummary.coverage, 'complete');
    assert.equal(compared.candidateChanges.find(item => item.label === 'Windup')?.change, 'recipe_changed');
    assert.equal(compared.regressionSummary.reportedOutcome, 'no_reported_status_regression');
    const windup = compared.candidateSummaries.find(item => item.label === 'Windup')!;
    assert.equal(windup.statusCounts.before.supported, 1);
    assert.equal(windup.statusCounts.after.supported, 1);
    assert.equal(windup.evidenceCoverage.before.citations, 1);
    assert.deepEqual(windup.evidenceCoverage.after.views, ['side']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off history persists fingerprint-bound deterministic recipe audit snapshots and compares raw deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-technical-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const beforeInput = input();
    const afterInput = input();
    const candidate = (name: string, rotation: number) => ({ kind: 'animation' as const, name, duration: 1, loop: false,
      tracks: [{ joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [rotation, 0, 0] as [number, number, number] },
      ] }], markers: [] });
    beforeInput.technicalAudits = [summarizeVisualCandidateAudit('Windup', 'b'.repeat(64), candidate('Windup', 20)),
      summarizeVisualCandidateAudit('Direct', 'c'.repeat(64), candidate('Direct', 30))];
    afterInput.technicalAudits = [summarizeVisualCandidateAudit('Windup', 'b'.repeat(64), candidate('Windup', 40)),
      summarizeVisualCandidateAudit('Direct', 'c'.repeat(64), candidate('Direct', 30))];
    beforeInput.reportFingerprint = visualBakeoffReportFingerprint(beforeInput);
    afterInput.reportFingerprint = visualBakeoffReportFingerprint(afterInput);
    const duplicateAudit = { ...beforeInput, technicalAudits: [beforeInput.technicalAudits[0]!, beforeInput.technicalAudits[0]!] };
    duplicateAudit.reportFingerprint = visualBakeoffReportFingerprint(duplicateAudit);
    await assert.rejects(history.record(duplicateAudit), /match every recorded candidate exactly once/i);
    const before = await history.record(beforeInput);
    const after = await history.record(afterInput);
    const compared = await history.compareEvidenceTiming(before.id, after.id);
    const windup = compared.technicalAuditComparison.find(item => item.candidateLabel === 'Windup')!;
    assert.equal(windup.available, true);
    if (!windup.available) return;
    assert.ok(Math.abs(windup.peakMetricDeltas.localAngularSpeed!.delta - 20) < 1e-9);
    assert.equal(windup.summary.keys.delta, 0);
    assert.match(windup.limitation, /not rendered world motion/i);
    const reopened = await new VisualBakeoffHistory(root).read(before.id);
    assert.equal(reopened.technicalAudits?.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off recipe snapshots survive restart, remain unsaved, and fail closed when tampered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-recipe-snapshots-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const report = input();
    const makeRecipe = (name: string, rotation: number) => ({ kind: 'animation' as const, name, duration: 1, loop: false,
      tracks: [{ joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [rotation, 0, 0] as [number, number, number] },
      ] }], markers: [] });
    const windup = makeRecipe('Windup', 25);
    const direct = makeRecipe('Direct', 40);
    const recipes = [
      { candidateLabel: 'Windup', candidateFingerprint: fingerprint(windup), recipe: windup },
      { candidateLabel: 'Direct', candidateFingerprint: fingerprint(direct), recipe: direct },
    ];
    report.candidates = recipes.map(item => ({ label: item.candidateLabel, candidateFingerprint: item.candidateFingerprint, duration: item.recipe.duration }));
    report.assessments = report.assessments.map(assessment => ({ ...assessment, candidateFingerprint:
      recipes.find(item => item.candidateLabel === assessment.candidateLabel)!.candidateFingerprint }));
    report.reportFingerprint = visualBakeoffReportFingerprint(report);
    const mismatchedAudits = recipes.map(item => summarizeVisualCandidateAudit(item.candidateLabel, item.candidateFingerprint, item.recipe));
    mismatchedAudits[0] = { ...mismatchedAudits[0]!, peaks: { ...mismatchedAudits[0]!.peaks,
      localAngularSpeed: mismatchedAudits[0]!.peaks.localAngularSpeed + 1 } };
    const inconsistentReport = { ...report, technicalAudits: mismatchedAudits };
    inconsistentReport.reportFingerprint = visualBakeoffReportFingerprint(inconsistentReport);
    await assert.rejects(history.record({ ...inconsistentReport, candidateRecipes: recipes }), /does not match the exact candidate recipe/i);
    const saved = await history.record({ ...report, candidateRecipes: recipes });
    assert.equal(saved.candidateRecipesPersisted, true);
    const recovered = await new VisualBakeoffHistory(root).readCandidateRecipe(saved.id, 'windup');
    assert.deepEqual(recovered.recipe, windup);
    assert.equal(recovered.candidate.candidateFingerprint, fingerprint(recovered.recipe));
    assert.match(recovered.persistence, /still unsaved/i);
    await assert.rejects(history.record({ ...input(), candidateRecipes: recipes }), /does not match its exact recorded candidate fingerprint/i);
    const snapshotPath = join(root, 'recipes', `${recipes[0]!.candidateFingerprint}.json`);
    const stored = JSON.parse(await readFile(snapshotPath, 'utf8')) as { candidateFingerprint: string; recipe: { name: string } };
    stored.recipe.name = 'tampered';
    await writeFile(snapshotPath, JSON.stringify(stored));
    await assert.rejects(history.readCandidateRecipe(saved.id, 'Windup'), /fingerprint integrity check/i);
    await assert.rejects(history.read(saved.id), /fingerprint integrity check/i);
    await assert.rejects(history.list(), /fingerprint integrity check/i);
    const legacy = await history.record(input());
    await assert.rejects(history.readCandidateRecipe(legacy.id, 'Windup'), /no persisted recipe snapshot/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate recheck history is append-only, recomputable after restart, comparable on one rig, and tamper-evident', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-rechecks-'));
  try {
    const history = new VisualBakeoffHistory(root);
    const report = input();
    const makeRecipe = (name: string, rotation: number) => ({ kind: 'animation' as const, name, duration: 1, loop: false,
      tracks: [{ joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [rotation, 0, 0] as [number, number, number] },
      ] }], markers: [] });
    const baselineRecipe = makeRecipe('Windup', 25);
    const directRecipe = makeRecipe('Direct', 40);
    const candidates = [baselineRecipe, directRecipe].map(recipe => ({ candidateLabel: recipe.name,
      candidateFingerprint: fingerprint(recipe), recipe }));
    report.candidates = candidates.map(item => ({ label: item.candidateLabel, candidateFingerprint: item.candidateFingerprint, duration: item.recipe.duration }));
    report.assessments = report.assessments.map(assessment => ({ ...assessment, candidateFingerprint:
      candidates.find(item => item.candidateLabel === assessment.candidateLabel)!.candidateFingerprint }));
    report.reportFingerprint = visualBakeoffReportFingerprint(report);
    const parent = await history.record({ ...report, candidateRecipes: candidates });
    const rigId = parent.rigId;
    const telemetryFor = (recipe: typeof baselineRecipe, assetId: string, displacement: number): Telemetry => ({
      version: 1, source: 'studio_pose_evaluator', rigId, assetId, duration: recipe.duration, loop: recipe.loop,
      height: 6, groundSource: 'rest_foot_bounds', note: 'Measured candidate-recheck test fixture.',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperTorso', parent: 1, driven: true, foot: false }],
      samples: [0, 0.5, 1].map((time, index) => ({ id: `s00${index}`, time,
        points: [[0, 0, 0], [0, 3 + displacement * time, 0]], bottoms: [2, 2],
        orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] })),
    });
    const makeRunInput = (revisionRecipe: typeof baselineRecipe, displacement: number) => {
      const baselineAssetId = fingerprintUuid(fingerprint(baselineRecipe)), revisionAssetId = fingerprintUuid(fingerprint(revisionRecipe));
      return { parentHistoryRecordId: parent.id, parentReportFingerprint: parent.reportFingerprint,
        candidateLabel: 'Windup', baselineRecipeFingerprint: candidates[0]!.candidateFingerprint,
        revisionRecipeFingerprint: fingerprint(revisionRecipe), revisionRecipe, baselineSourceRigId: parent.rigId,
        rigId, rigSignature: parent.rigSignature, motionMode: 'stationary' as const, jointMap: {}, sampleRateHz: 60 as const,
        phaseDetailLimit: 6, comparisonDetailLimit: 12, acceptance: { requiredTracks: ['UpperTorso'], requiredMarkers: [], contacts: [], bendPlanes: [] },
        baselineAssetId, baselineTelemetry: telemetryFor(baselineRecipe, baselineAssetId, 0.1),
        revisionAssetId, revisionTelemetry: telemetryFor(revisionRecipe, revisionAssetId, displacement) };
    };
    const persistRun = async (revisionRecipe: typeof baselineRecipe, displacement: number) => history.recordCandidateRecheck(makeRunInput(revisionRecipe, displacement));
    const revisionA = makeRecipe('Windup revision A', 30), revisionB = makeRecipe('Windup revision B', 50);
    await assert.rejects(history.recordCandidateRecheck({ ...makeRunInput(revisionA, 0.2), revisionAssetId: randomUUID() }), /asset identity|asset ID must be derived/i);
    const first = await persistRun(revisionA, 0.2);
    const second = await persistRun(revisionB, 0.4);
    assert.notEqual(first.id, second.id);
    const reopened = new VisualBakeoffHistory(root);
    const recovered = await reopened.readCandidateRecheck(first.id);
    assert.equal(recovered.recheckRecordId, first.id);
    assert.equal(recovered.parentHistoryRecordId, parent.id);
    assert.equal(recovered.baseline.fingerprint, candidates[0]!.candidateFingerprint);
    assert.equal(recovered.revision.fingerprint, fingerprint(revisionA));
    assert.equal(recovered.revision.acceptance?.status, 'passed');
    assert.equal(recovered.sameRigTopologyAsBaseline, true);
    assert.ok(recovered.comparison.status === 'available');
    const listed = await reopened.listCandidateRechecks(10, 0, parent.id);
    assert.equal(listed.total, 2);
    assert.deepEqual(new Set(listed.records.map(item => item.id)), new Set([first.id, second.id]));
    const comparison = await reopened.compareCandidateRechecks(first.id, second.id);
    assert.equal(comparison.sameRigIdentityAndTopology, true);
    assert.equal(comparison.revisionRecipe.changed, true);
    assert.equal(comparison.acceptanceCriteriaChanged, false);
    assert.equal(comparison.interpretationVerified, false);
    await assert.rejects(reopened.compareCandidateRechecks(first.id, first.id), /two distinct recheck record IDs/i);

    const recheckDirectory = join(root, 'rechecks');
    const recheckFile = (await readdir(recheckDirectory)).find(name => name.endsWith(`-${first.id}.json`))!;
    const storedPath = join(recheckDirectory, recheckFile);
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { record: { comparisonDetailLimit: number }; recordDigest: string };
    stored.record.comparisonDetailLimit = 13;
    await writeFile(storedPath, JSON.stringify(stored));
    await assert.rejects(reopened.readCandidateRecheck(first.id), /integrity check/i);
    await assert.rejects(reopened.listCandidateRechecks(), /integrity check/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visual bake-off history rejects tampered reports and incomplete matrices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-integrity-'));
  try {
    const history = new VisualBakeoffHistory(root);
    await assert.rejects(history.record({ ...input(), assessments: input().assessments.slice(0, 1) }), /cover every candidate and criterion/i);
    await assert.rejects(history.record({ ...input(), reportFingerprint: 'f'.repeat(64) }), /fingerprint does not match/i);
    const saved = await history.record(input());
    const file = (await readdir(root))[0]!;
    const stored = JSON.parse(await readFile(join(root, file), 'utf8')) as { record: { limitation: string }; recordDigest: string };
    stored.record.limitation = 'tampered';
    await writeFile(join(root, file), JSON.stringify(stored));
    await assert.rejects(history.read(saved.id), /integrity check/i);
    await assert.rejects(history.list(), /integrity check/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent visual bake-off records remain unique and complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-visual-bakeoff-concurrent-'));
  try {
    const histories = Array.from({ length: 12 }, () => new VisualBakeoffHistory(root));
    const records = await Promise.all(histories.map(history => history.record(input())));
    assert.equal(new Set(records.map(record => record.id)).size, records.length);
    const listed = await new VisualBakeoffHistory(root).list(20);
    assert.equal(listed.total, records.length);
    assert.deepEqual(new Set(listed.records.map(record => record.id)), new Set(records.map(record => record.id)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
