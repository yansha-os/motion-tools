import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Queue } from '../src/bridge.js';
import { Blender } from '../src/blender.js';
import { Library } from '../src/library.js';
import { createMcp } from '../src/server.js';
import { Authoring } from '../src/authoring.js';
import { Connections, providerClient, type Complete } from '../src/providers.js';
import { buildPoseEvidenceIndex, buildReviewVisualStoryboard, capturedFrameMetadataSchema, evaluateReviewCaptureCoverage, Reviews, type ReviewRecord } from '../src/reviews.js';
import { captureFramesSchema } from '../src/capture-views.js';
import { compareMotion, fingerprint, inspectMotion, sampleTimes, telemetrySchema, type Telemetry } from '../src/inspection.js';
import { animationPreset, vfxPreset } from '../src/recipes.js';
import { inspectPngVisualSignal } from '../src/png.js';
import { animationVisualContext } from '../src/animation-visual-context.js';

const recipe = () => animationPreset('walk', 'Weighted Walk', 1, 1);
function telemetry(assetId: string, rigId: string, variant: 'still' | 'moving' | 'jump' | 'seam' | 'rotated' = 'still'): Telemetry {
  return { version: 1, source: 'studio_pose_evaluator', assetId, rigId, duration: 1, loop: true, height: 6, groundSource: 'rest_foot_bounds', note: 'Test fixture',
    nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'LowerTorso', parent: 1, driven: true, foot: false }, { name: 'LeftFoot', parent: 2, driven: true, foot: true }, { name: 'RightFoot', parent: 2, driven: true, foot: true }],
    samples: [0, 0.25, 0.5, 0.75, 1].map((time, i) => {
      const x = variant === 'moving' ? time : variant === 'seam' ? [0, 0.1, 0.2, 2, 0][i]! : 0;
      const y = variant === 'jump' ? [0, 1.5, 3, 1.5, 0][i]! : 0;
      return { id: `s00${i}`, time, points: [[0, 3, 0], [x, 3 + y, 0], [x - 0.5, 0.5 + y, 0], [x + 0.5, 0.5 + y, 0]], bottoms: [2, 2 + y, y, y], orientations: [[0, 0, 0, 1], [0, 0, 0, 1], variant === 'rotated' ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 0, 1], [0, 0, 0, 1]] };
    }) };
}
const reply = () => ({ approach: 'Preserve the grounded gait and tune the requested timing.', checkpoints: ['Check contact timing', 'Check weight'], avoid: [], recipe: recipe() });
const critique = () => ({ summary: 'The sampled body height is stable; judge whether the weight feels right in Studio.', findings: [{ observation: 'The sampled pelvis remains at the same height.', source: 'pose_samples', evidenceIds: ['s000', 's004'], suggestion: 'Only add more compression if the user wants more weight.' }], questions: [{ id: 'impact', question: 'Would you like a stronger downward weight shift?', choices: ['Keep it', 'More weight'] }] });
const usage = { inputTokens: 20, outputTokens: 30 };
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const capturePngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
];

test('capture metadata rejects inconsistent chunk counts before image retrieval', () => {
  const valid = { captureId: randomUUID(), assetId: randomUUID(), assetFingerprint: 'a'.repeat(64), rigId: randomUUID(),
    rigSignature: 'capture-schema-rig-v1', time: 0, view: 'front', byteCount: 32769, chunks: 2, width: 1, height: 1 };
  assert.equal(capturedFrameMetadataSchema.safeParse(valid).success, true);
  assert.equal(capturedFrameMetadataSchema.safeParse({ ...valid, chunks: 1 }).success, false);
  assert.equal(capturedFrameMetadataSchema.safeParse({ ...valid, byteCount: 32768, chunks: 2 }).success, false);
});
test('AI review receives an explicit pose-sample to rig-node/time evidence index', async () => {
  let providerCalls = 0;
  const f = await setup(async (_credential, _system, prompt) => {
    providerCalls++;
    const request = JSON.parse(prompt) as { poseEvidenceIndex?: { sampleTimes: { sampleId: string; timeSeconds: number; normalizedProgress: number }[];
      nodeSlots: { slot: number; name: string; parentSlot: number | null; driven: boolean; foot: boolean }[];
      metricEvidence: { id: string; sampleIds: string[] }[] } };
    const index = request.poseEvidenceIndex;
    assert.ok(index, 'review prompt must include the derived evidence index');
    assert.deepEqual(index.sampleTimes[2], { sampleId: 's002', timeSeconds: 0.5, normalizedProgress: 0.5 });
    assert.deepEqual(index.nodeSlots[2], { slot: 2, name: 'LeftFoot', parentSlot: 1, driven: true, foot: true });
    assert.ok(index.metricEvidence.some(metric => metric.id === 'body-rise' && metric.sampleIds.includes('s000')));
    return { text: JSON.stringify(critique()), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    const pending = await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false });
    const inspected = await settled(f.reviews, pending.id);
    const critiquePending = await f.reviews.critique({ reviewId: inspected.id, revision: inspected.revision, provider: 'deepseek' });
    const review = await settled(f.reviews, critiquePending.id);
    assert.equal(providerCalls, 1);
    assert.equal(review.critique?.findings[0]?.interpretation, 'measured_issue');
  } finally { f.close(); }
});
async function setup(complete: Complete = async () => ({ text: JSON.stringify(critique()), usage })) {
  const root = await mkdtemp(join(tmpdir(), 'motion-review-')), library = new Library(join(root, 'artifacts/library')), queue = new Queue();
  const connections = new Connections(join(root, '.local/providers.json'), undefined, { DEEPSEEK_API_KEY: 'not-a-real-key' });
  const reviews = new Reviews(join(root, 'artifacts/reviews'), library, queue, connections, complete);
  const authoring = new Authoring(library, queue, connections, root, complete, reviews);
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'fixture-authoring-rig-v1';
  const retargetProfile = { version: 1, rigId, rigName: 'Fixture', rigType: 'R15', rigSignature,
    joints: [{ name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
      ...recipe().tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 }))] };
  const snapshot = { activeRig: { id: rigId, name: 'Fixture', rigSignature } };
  queue.heartbeat(sessionId, snapshot);
  const capturePngById = new Map<string, string>();
  let capturePngIndex = 0;
  const timer = setInterval(() => {
    queue.heartbeat(sessionId, snapshot);
    const job = queue.poll(sessionId); if (!job) return;
    const payload = job.payload as any;
    if (job.operation === 'sample_animation') queue.complete(sessionId, job.id, true, telemetry(payload.assetId, payload.rigId));
    else if (job.operation === 'capture_chunk') {
      const chunkRequest = job.payload as { captureId: string; index: number };
      const png = capturePngById.get(chunkRequest.captureId) ?? capturePngs[capturePngIndex++ % capturePngs.length]!;
      capturePngById.set(chunkRequest.captureId, png);
      const bytes = Buffer.from(png, 'base64');
      const chunk = bytes.subarray(chunkRequest.index * 32768, (chunkRequest.index + 1) * 32768);
      queue.complete(sessionId, job.id, true, { captureId: chunkRequest.captureId, index: chunkRequest.index, hex: chunk.toString('hex') });
    }
    else if (job.operation === 'inspect') queue.complete(sessionId, job.id, true, { id: rigId, rigSignature, retargetProfile, animatedNames: retargetProfile.joints.map(({ name, parent, driven }) => ({ name, parent, driven })) });
    else if (job.operation === 'preview') queue.complete(sessionId, job.id, true, { previewStarted: true });
    else throw new Error(`Unexpected fixture operation ${job.operation}`);
  }, 5);
  return { root, library, queue, connections, reviews, authoring, sessionId, rigId, rigSignature, close: () => { clearInterval(timer); reviews.close(); authoring.close(); } };
}
async function settled(reviews: Reviews, id: string) {
  for (let i = 0; i < 500; i++) { const record = await reviews.read(id); if (!['inspecting', 'critiquing', 'revising'].includes(record.status)) return record; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Review did not settle');
}
async function draftDone(authoring: Authoring, id: string) {
  for (let i = 0; i < 500; i++) { const job = authoring.get(id); if (job.status !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Draft did not settle');
}
test('visual capture coverage matches exact view/time evidence once and exposes missing pairs', () => {
  const plan = captureFramesSchema.parse([{ view: 'front', time: 0 }, { view: 'front', time: 0.02 }, { view: 'side', time: 0 }]);
  const images = [
    { id: 'front-near', view: 'front' as const, time: 0.01 },
    { id: 'side-at-start', view: 'side' as const, time: 0 },
    { id: 'front-last', view: 'front' as const, time: 1 },
    { id: 'unplanned', view: 'back' as const, time: 0.5 },
  ];
  const partial = evaluateReviewCaptureCoverage(plan, images);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingFrames, [{ view: 'front', time: 0.02 }], 'one evidence item cannot cover more than one planned frame');
  assert.deepEqual(partial.unplannedEvidenceIds, ['front-last', 'unplanned']);
  const complete = evaluateReviewCaptureCoverage(plan, [...images, { id: 'front-second', view: 'front' as const, time: 0.02 }]);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.coveredFrameCount, 3);
  const retryPlan = captureFramesSchema.parse([{ view: 'front', time: 0 }, { view: 'side', time: 0.5 }]);
  const recoveredAcrossBatches = evaluateReviewCaptureCoverage(retryPlan, [
    { id: 'first-batch-front', view: 'front', time: 0, captureBinding: { assetFingerprint: 'b'.repeat(64), rigId: 'rig', rigSignature: 'topology' } },
    { id: 'retry-batch-side', view: 'side', time: 0.5, captureBinding: { assetFingerprint: 'b'.repeat(64), rigId: 'rig', rigSignature: 'topology' } },
  ], 1 / 60, { assetFingerprint: 'b'.repeat(64), rigId: 'rig', rigSignature: 'topology' });
  assert.equal(recoveredAcrossBatches.status, 'complete', 'a successful targeted retry can combine with earlier exact-recipe/rig images to satisfy the original review plan');
  assert.deepEqual(recoveredAcrossBatches.missingFrames, []);
  const bound = evaluateReviewCaptureCoverage(plan, [{ id: 'manual', view: 'front', time: 0 },
    { id: 'native', view: 'front', time: 0, captureBinding: { assetFingerprint: 'a'.repeat(64), rigId: 'rig', rigSignature: 'topology' } }], 1 / 60,
    { assetFingerprint: 'a'.repeat(64), rigId: 'rig', rigSignature: 'topology' });
  assert.equal(bound.coveredFrameCount, 1, 'only evidence bound to this exact recipe and rig can satisfy a planned frame');
  assert.deepEqual(bound.unplannedEvidenceIds, ['manual']);

  const focusedPlan = captureFramesSchema.parse([{ view: 'front', time: 0.5, focusJoint: 'RightHand' }, { view: 'side', time: 0.5, focusJoint: 'RightHand' }]);
  const wrongFocus = evaluateReviewCaptureCoverage(focusedPlan, [{ id: 'wrong-focus', view: 'front', time: 0.5,
    captureBinding: { assetFingerprint: 'a'.repeat(64), rigId: 'rig', rigSignature: 'topology', focusJoint: 'LeftHand' } }]);
  assert.equal(wrongFocus.coveredFrameCount, 0, 'a screenshot of another focused segment must not satisfy the requested focused review');
  assert.deepEqual(wrongFocus.missingFrames, [{ view: 'front', time: 0.5, focusJoint: 'RightHand' }, { view: 'side', time: 0.5, focusJoint: 'RightHand' }]);
  const rightFocus = evaluateReviewCaptureCoverage(focusedPlan, [{ id: 'right-focus', view: 'front', time: 0.5,
    captureBinding: { assetFingerprint: 'a'.repeat(64), rigId: 'rig', rigSignature: 'topology', focusJoint: 'RightHand' } }]);
  assert.equal(rightFocus.coveredFrameCount, 1);
  assert.deepEqual(rightFocus.missingFrames, [{ view: 'side', time: 0.5, focusJoint: 'RightHand' }]);
});

test('visual storyboard orders only exact same-rig/view/focus frames and isolates manual or mismatched images', () => {
  const assetHash = 'a'.repeat(64);
  const bound = (rigId: string, rigSignature: string, focusJoint?: string, fingerprint = assetHash,
    captureBatchId = 'batch-a', captureSource: 'saved_animation' | 'candidate' | 'editor_draft' = 'saved_animation') => ({
    assetFingerprint: fingerprint, rigId, rigSignature, captureBatchId, captureSource, ...(focusJoint ? { focusJoint } : {}),
  });
  const storyboard = buildReviewVisualStoryboard(assetHash, [
    { id: 'front-late', view: 'front', time: 0.75, captureBinding: bound('rig-a', 'topology-a') },
    { id: 'front-early', view: 'front', time: 0.25, captureBinding: bound('rig-a', 'topology-a') },
    { id: 'front-other-rig', view: 'front', time: 0.5, captureBinding: bound('rig-b', 'topology-b') },
    { id: 'hand-closeup', view: 'front', time: 0.5, captureBinding: bound('rig-a', 'topology-a', 'RightHand') },
    { id: 'manual-reference', view: 'side', time: 0.1 },
    { id: 'stale-capture', view: 'back', time: 0.3, captureBinding: bound('rig-a', 'topology-a', undefined, 'b'.repeat(64)) },
  ]);
  assert.deepEqual(storyboard.sequences.map(sequence => sequence.frames.map(frame => frame.imageId)), [
    ['front-early', 'front-late'], ['front-other-rig'], ['hand-closeup'],
  ]);
  assert.equal(storyboard.sequences[0]?.frames[1]?.gapFromPreviousSeconds, 0.5);
  assert.deepEqual(storyboard.referenceImages, [{ imageId: 'manual-reference', view: 'side', timeLabelSeconds: 0.1, timeStatus: 'unverified_user_label' }]);
  assert.deepEqual(storyboard.excludedImageIds, ['stale-capture']);
  assert.match(storyboard.limitation, /do not establish interpolation/i);
});

test('visual storyboard never combines capture batches, sources, or legacy captures without batch provenance', () => {
  const assetHash = 'a'.repeat(64);
  const exact = (captureBatchId: string, captureSource: 'saved_animation' | 'candidate' = 'saved_animation') => ({
    assetFingerprint: assetHash, rigId: 'rig', rigSignature: 'topology', captureBatchId, captureSource,
  });
  const storyboard = buildReviewVisualStoryboard(assetHash, [
    { id: 'first-a', view: 'front', time: 0, captureBinding: exact('batch-a') },
    { id: 'second-a', view: 'front', time: 0.5, captureBinding: exact('batch-a') },
    { id: 'retry-b', view: 'front', time: 0.75, captureBinding: exact('batch-b') },
    { id: 'candidate-a', view: 'front', time: 0.25, captureBinding: exact('batch-a', 'candidate') },
    { id: 'legacy-exact', view: 'front', time: 0.9, captureBinding: { assetFingerprint: assetHash, rigId: 'rig', rigSignature: 'topology' } },
  ]);
  assert.deepEqual(storyboard.sequences.map(sequence => ({ batch: sequence.captureBatchId, source: sequence.captureSource,
    ids: sequence.frames.map(frame => frame.imageId) })), [
    { batch: 'batch-a', source: 'candidate', ids: ['candidate-a'] },
    { batch: 'batch-a', source: 'saved_animation', ids: ['first-a', 'second-a'] },
    { batch: 'batch-b', source: 'saved_animation', ids: ['retry-b'] },
  ]);
  assert.deepEqual(storyboard.unsequencedExactImageIds, ['legacy-exact']);
});

test('unplanned visual critique excludes recipe-mismatched captures and labels unbound references', async () => {
  let sentPrompt = '';
  let sentSystem = '';
  let sentImagePayloads: string[] = [];
  const f = await setup(async (_credential, system, prompt, _limit, _signal, images) => {
    sentSystem = system;
    sentPrompt = prompt;
    sentImagePayloads = images?.map(image => image.base64) ?? [];
    const input = JSON.parse(prompt) as { images: { id: string }[] };
    return { text: JSON.stringify({ summary: 'Only recipe-matched capture and user reference were considered.',
      findings: [], visualObservations: input.images.map(image => ({ imageId: image.id, assessment: 'inconclusive' as const,
        visibleEvidence: 'The pose detail is not reliably discernible in this frame.', limitation: 'A still cannot establish motion or reveal obscured details.' })), questions: [] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    const started = await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false });
    const record = await settled(f.reviews, started.id);
    const mismatch = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'front', time: 0.5, pngBase64: tinyPng }, {
      captureId: randomUUID(), assetFingerprint: '0'.repeat(64), rigId: f.rigId, rigSignature: 'fixture-authoring-rig-v1' });
    const reference = await f.reviews.attach({ reviewId: record.id, revision: mismatch.revision, view: 'side', time: 0.5, pngBase64: capturePngs[0]! });
    const exact = await f.reviews.attach({ reviewId: record.id, revision: reference.revision, view: 'front', time: 0.25, pngBase64: capturePngs[1]! }, {
      captureId: randomUUID(), assetFingerprint: fingerprint(asset.recipe), rigId: f.rigId, rigSignature: 'fixture-authoring-rig-v1' });
    const pending = await f.reviews.critique({ reviewId: record.id, revision: exact.revision, provider: 'deepseek' });
    const completed = await settled(f.reviews, pending.id);
    assert.equal(completed.images.length, 3);
    assert.deepEqual(sentImagePayloads, [capturePngs[0], capturePngs[1]], 'the mismatched native capture must not reach the vision model');
    assert.match(sentPrompt, /"recipeIdentityStatus":"unbound_user_image"/);
    assert.match(sentPrompt, /"recipeIdentityStatus":"matches_reviewed_recipe"/);
    assert.match(sentPrompt, /"visualStoryboard":\{"sequences":\[/);
    assert.match(sentPrompt, /Manual-reference time labels are unverified/);
    assert.match(sentSystem, /assessment \(observed or inconclusive\)/i);
    const providerRequest = JSON.parse(sentPrompt) as { images: { id: string; pixelSignal: { sampledPixelCount: number; warnings: string[]; limitation: string } }[] };
    assert.equal(providerRequest.images.length, 2);
    assert.ok(providerRequest.images.every(image => image.pixelSignal.sampledPixelCount > 0 && Array.isArray(image.pixelSignal.warnings)
      && /do not establish correct framing.*pose quality/i.test(image.pixelSignal.limitation)),
    'the model must receive conservative pixel-signal context alongside every PNG it sees');
    assert.match(sentSystem, /pixelSignal.*not a quality verdict.*no warnings do not prove.*readable/i);
    assert.doesNotMatch(sentPrompt, /mismatched_reviewed_recipe/);
    const audit = f.reviews.visualEvidenceAudit(completed);
    assert.ok(audit.storyboard.unsequencedExactImageIds.includes(exact.images.at(-1)!.id),
      'native-looking captures without server-verified batch provenance must not imply a temporal sequence');
    assert.ok(audit.storyboard.referenceImages.some(image => image.imageId === reference.images.at(-1)!.id));
    const mismatchAudit = audit.images.find(image => image.id === mismatch.images.at(-1)!.id);
    assert.equal(mismatchAudit?.recipeIdentityStatus, 'mismatched_reviewed_recipe');
    assert.equal(mismatchAudit?.eligibleForCritique, false);
    assert.equal(mismatchAudit?.assessmentStatus, 'excluded_from_critique');
    assert.deepEqual(audit.excludedImageIds, [mismatch.images.at(-1)!.id]);
    const referenceAudit = audit.images.find(image => image.id === reference.images.at(-1)!.id);
    assert.equal(referenceAudit?.recipeIdentityStatus, 'unbound_user_image');
    assert.equal(referenceAudit?.eligibleForCritique, true);
    assert.equal(referenceAudit?.visualAssessment, 'inconclusive', JSON.stringify({ status: completed.status, error: completed.error,
      observations: completed.critique?.visualObservations, referenceId: reference.images.at(-1)!.id, imageIds: audit.images.map(image => image.id) }));
    assert.deepEqual(referenceAudit?.pixelSignal, inspectPngVisualSignal(Buffer.from(capturePngs[0]!, 'base64')));
    assert.equal(referenceAudit?.pixelSignalGuidance, 'no_extreme_warning_does_not_prove_legibility');
    assert.equal(audit.images.find(image => image.id === exact.images.at(-1)!.id)?.visualAssessment, 'inconclusive');
    assert.ok(audit.limitations.some(limitation => /unbound user image may be a visual reference/i.test(limitation)));
  } finally { f.close(); }
});

test('an inconclusive screenshot is structured and cannot support a visual finding', async () => {
  let responseMode: 'inconclusive_finding' | 'unclassified' = 'inconclusive_finding';
  const f = await setup(async (_credential, _system, prompt) => {
    const request = JSON.parse(prompt) as { images: { id: string }[] };
    const imageId = request.images[0]?.id;
    assert.ok(imageId);
    return { text: JSON.stringify({ ...critique(), findings: responseMode === 'inconclusive_finding' ? [{ observation: 'A hand pose issue is visible.', source: 'user_image',
      evidenceIds: [imageId], suggestion: 'Move the hand into a clearer pose.' }] : [], visualObservations: [{ imageId,
      ...(responseMode === 'inconclusive_finding' ? { assessment: 'inconclusive' } : {}),
      visibleEvidence: 'The hand is occluded and its pose cannot be determined.', limitation: 'This frame cannot establish the hand orientation.' }] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    let review = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, preview: false })).id);
    review = await f.reviews.attach({ reviewId: review.id, revision: review.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    const pending = await f.reviews.critique({ reviewId: review.id, revision: review.revision, provider: 'deepseek' });
    review = await settled(f.reviews, pending.id);
    assert.equal(review.critique, undefined);
    assert.match(review.error ?? '', /inconclusive screenshot cannot support a visual finding/i);
    responseMode = 'unclassified';
    const unclassifiedPending = await f.reviews.critique({ reviewId: review.id, revision: review.revision, provider: 'deepseek' });
    review = await settled(f.reviews, unclassifiedPending.id);
    assert.equal(review.critique, undefined);
    assert.match(review.error ?? '', /must classify its screenshot as observed or inconclusive/i);
  } finally { f.close(); }
});

test('visual critique rejects reference-only images mislabeled as observed defects and stores their safe interpretation', async () => {
  let interpretation: 'observed_issue' | 'reference_target' = 'observed_issue';
  const f = await setup(async (_credential, _system, prompt) => {
    const request = JSON.parse(prompt) as { images: { id: string }[] };
    const imageId = request.images[0]?.id;
    assert.ok(imageId);
    return { text: JSON.stringify({ summary: 'Compare the pose to the user target.',
      findings: [{ observation: 'The target reference shows the intended arm angle.', source: 'user_image', evidenceIds: [imageId],
        suggestion: 'Use this as the target when shaping the arm.', interpretation }],
      visualObservations: [{ imageId, assessment: 'observed', visibleEvidence: 'The reference arm is raised.', limitation: 'This image is not bound to the reviewed source recipe.' }], questions: [] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    let review = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    review = await f.reviews.attach({ reviewId: review.id, revision: review.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    let pending = await f.reviews.critique({ reviewId: review.id, revision: review.revision, provider: 'deepseek' });
    review = await settled(f.reviews, pending.id);
    assert.equal(review.critique, undefined);
    assert.match(review.error ?? '', /interpretation is incompatible.*expected reference_target/i);

    interpretation = 'reference_target';
    pending = await f.reviews.critique({ reviewId: review.id, revision: review.revision, provider: 'deepseek' });
    review = await settled(f.reviews, pending.id);
    assert.equal(review.error, undefined);
    assert.equal(review.critique?.findings[0]?.interpretation, 'reference_target');
  } finally { f.close(); }
});

function feedback(record: ReviewRecord, overall: 'accept' | 'refine' = 'refine') {
  return { reviewId: record.id, revision: record.revision, feedback: { overall, watchedPreview: true, liked: 'Keep the arm swing and the loop length.', changes: overall === 'accept' ? '' : 'Add more weight by lowering the hips at contact.', answers: [] } };
}

test('pose inspection measures jump height, loop velocity changes, and in-place contact uncertainty', () => {
  const assetId = randomUUID(), rigId = randomUUID();
  const still = inspectMotion(recipe(), telemetry(assetId, rigId));
  assert.equal(still.report.source, 'studio_pose_evaluator');
  assert.equal(still.report.metrics.find(m => m.id === 'body-rise')?.value, 0);
  const jump = inspectMotion(recipe(), telemetry(assetId, rigId, 'jump'));
  assert.equal(jump.report.metrics.find(m => m.id === 'body-rise')?.value, 3);
  assert.equal(jump.report.metrics.find(m => m.id === 'clearance-2')?.value, 3);
  const seam = inspectMotion(recipe(), telemetry(assetId, rigId, 'seam'));
  assert.ok(seam.report.findings.some(f => f.id === 'loop-transition'));
  const inPlace = inspectMotion(recipe(), telemetry(assetId, rigId, 'moving'), 'in_place');
  assert.ok(!inPlace.report.findings.some(f => f.id === 'contact-2'));
  const stationary = inspectMotion(recipe(), telemetry(assetId, rigId, 'moving'), 'stationary');
  assert.ok(stationary.report.findings.some(f => f.id === 'contact-2'));
  assert.match(inPlace.report.metrics.find(m => m.id === 'contact-travel-2')!.detail, /not proof of sliding/);
});

test('revision trajectory comparison aligns by clip progress and rejects rig or topology mismatches', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId);
  const retimed = structuredClone(parent);
  retimed.assetId = randomUUID(); retimed.duration = 2;
  retimed.samples.forEach(sample => { sample.time *= 2; });
  const identical = compareMotion(parent, retimed);
  if (identical.status !== 'available') throw new Error(identical.reason);
  assert.equal(identical.status, 'available');
  assert.equal(identical.changedJointCount, 0);
  assert.equal(identical.largestDisplacement, 0);
  assert.equal(identical.positionFrame, 'ground_relative_legacy');
  assert.match(identical.limitation, /not whether it improved/);

  const changed = compareMotion(parent, telemetry(randomUUID(), rigId, 'moving'));
  if (changed.status !== 'available') throw new Error(changed.reason);
  assert.equal(changed.status, 'available');
  assert.ok(changed.changedJointCount > 0);
  assert.equal(changed.largestDisplacement, 1);
  assert.ok(changed.largestChanges.some(change => change.joint === 'LowerTorso'));
  assert.deepEqual(changed.largestChanges.find(change => change.joint === 'LowerTorso')?.candidateMinusSourceAtPeak, [1, 0, 0]);
  assert.ok(changed.largestChanges[0]?.parentSampleIds.length);
  assert.ok(changed.largestChanges[0]?.childSampleIds.length);

  const retimedMotion = telemetry(randomUUID(), rigId, 'moving');
  retimedMotion.duration = 2;
  retimedMotion.samples.forEach(sample => { sample.time *= 2; });
  const retimedComparison = compareMotion(parent, retimedMotion);
  if (retimedComparison.status !== 'available') throw new Error(retimedComparison.reason);
  assert.equal(retimedComparison.largestChanges[0]!.atProgress, 1);
  assert.equal(retimedComparison.largestChanges[0]!.parentTime, 1);
  assert.equal(retimedComparison.largestChanges[0]!.childTime, 2);

  const rotated = compareMotion(parent, telemetry(randomUUID(), rigId, 'rotated'));
  if (rotated.status !== 'available') throw new Error(rotated.reason);
  assert.equal(rotated.changedJointCount, 0);
  assert.equal(rotated.rotationStatus, 'available');
  assert.equal(rotated.changedRotationJointCount, 1);
  assert.equal(rotated.largestAngularDisplacement, 90);
  assert.equal(rotated.largestRotationChanges[0]?.joint, 'LeftFoot');
  assert.equal(rotated.rotationChangeIntervals[0]?.joints[0], 'LeftFoot');
  assert.equal(rotated.rotationChangeIntervals[0]?.peakAngularDisplacement, 90);

  const otherRig = compareMotion(parent, telemetry(randomUUID(), randomUUID(), 'moving'));
  assert.equal(otherRig.status, 'unavailable');
  const differentTopology = telemetry(randomUUID(), rigId, 'moving');
  differentTopology.nodes[2]!.name = 'UnexpectedFoot';
  const topologyResult = compareMotion(parent, differentTopology);
  assert.equal(topologyResult.status, 'unavailable');
  const caseChangedTopology = structuredClone(parent);
  caseChangedTopology.assetId = randomUUID();
  caseChangedTopology.nodes[2]!.name = 'leftfoot';
  const caseTopologyResult = compareMotion(parent, caseChangedTopology);
  assert.equal(caseTopologyResult.status, 'unavailable');
  assert.match(caseTopologyResult.reason, /missing node LeftFoot/,
    'Roblox joint names are case-sensitive; case-only topology changes must not be paired as the same node');
});

test('Studio inspection resolves exact joint names and refuses ambiguous case-insensitive root/contact matches', () => {
  const sourceTelemetry = telemetry(randomUUID(), randomUUID());
  const collidingTelemetry = telemetrySchema.parse({ ...sourceTelemetry,
    nodes: [...sourceTelemetry.nodes, { ...sourceTelemetry.nodes[1]!, name: 'lowertorso', parent: 1 }],
    samples: sourceTelemetry.samples.map(sample => ({ ...sample,
      points: [...sample.points, sample.points[1]!], bottoms: [...sample.bottoms, sample.bottoms[1]!],
      ...(sample.orientations ? { orientations: [...sample.orientations, sample.orientations[1]!] } : {}),
    })),
  });
  const exactRootMotion = { ...recipe(), rootMotion: { joint: 'LowerTorso', keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] } };
  assert.ok(inspectMotion(exactRootMotion, collidingTelemetry).report.metrics.some(metric => metric.id === 'root-motion-distance'),
    'an exact joint name must win even when a case-colliding node exists');
  const mappedRootMotion = { ...exactRootMotion, rootMotion: { ...exactRootMotion.rootMotion, joint: 'TravelAlias' } };
  assert.ok(inspectMotion(mappedRootMotion, collidingTelemetry, 'unknown', { TravelAlias: 'LowerTorso' }).report.metrics
    .some(metric => metric.id === 'root-motion-distance'), 'root-motion inspection must follow the exact caller-supplied joint map');
  const ambiguousRootMotion = { ...exactRootMotion, rootMotion: { ...exactRootMotion.rootMotion, joint: 'LOWERTORSO' } };
  assert.throws(() => inspectMotion(ambiguousRootMotion, collidingTelemetry), /ambiguous case-insensitive matches.*LowerTorso, lowertorso/i);
  const ambiguousContact = { ...recipe(), contacts: [{ effector: 'LOWERTORSO', kind: 'support' as const, start: 0.1, end: 0.9 }] };
  const contactReport = inspectMotion(ambiguousContact, collidingTelemetry).report;
  assert.ok(contactReport.findings.some(finding => finding.id === 'contact-ambiguous-0'
    && /multiple case-insensitive matches.*LowerTorso, lowertorso/i.test(finding.detail)));
  const mappedContact = { ...recipe(), contacts: [{ effector: 'FootAlias', kind: 'support' as const, start: 0.1, end: 0.9 }] };
  assert.ok(inspectMotion(mappedContact, sourceTelemetry, 'unknown', { FootAlias: 'LeftFoot' }).report.metrics
    .some(metric => metric.id === 'declared-contact-0'), 'contact inspection must use explicit caller mappings');
});

test('phase comparison aligns matching semantic windows independently and reports unmatched phases', () => {
  const rigId = randomUUID();
  const parent = telemetry(randomUUID(), rigId);
  const child = structuredClone(parent);
  child.assetId = randomUUID();
  child.duration = 2;
  child.samples.forEach(sample => { sample.time *= 2; });
  // Candidate LowerTorso diverges only during the normalized main action.
  for (const sample of child.samples) {
    const progress = sample.time / child.duration;
    if (progress >= 0.4 && progress <= 0.6) sample.points[1]![0] = 2;
  }
  const comparison = compareMotion(parent, child, 12, {
    parent: [
      { label: 'anticipation', occurrence: 1, startTime: 0, endTime: 0.4 },
      { label: 'main_action', occurrence: 1, startTime: 0.4, endTime: 0.6 },
      { label: 'recovery', occurrence: 1, startTime: 0.6, endTime: 1 },
    ],
    child: [
      { label: 'anticipation', occurrence: 1, startTime: 0, endTime: 0.8 },
      { label: 'main_action', occurrence: 1, startTime: 0.8, endTime: 1.2 },
      { label: 'recovery', occurrence: 1, startTime: 1.2, endTime: 2 },
      { label: 'follow_through', occurrence: 1, startTime: 1.5, endTime: 1.75 },
    ],
  });
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  const phases = comparison.actionPhaseComparison;
  assert.equal(phases.status, 'available');
  if (phases.status !== 'available') return;
  assert.equal(phases.matchedPhaseCount, 3);
  assert.equal(phases.unmatchedParentPhaseCount, 0);
  assert.equal(phases.unmatchedChildPhaseCount, 1);
  const action = phases.phases.find(phase => phase.label === 'main_action');
  assert.ok(action);
  assert.equal(action.parentStartTime, 0.4);
  assert.equal(action.parentEndTime, 0.6);
  assert.equal(action.childStartTime, 0.8);
  assert.equal(action.childEndTime, 1.2);
  assert.ok(action.position.peakDisplacement > 1.9);
  assert.ok(action.position.largestChanges.some(change => change.joint === 'LowerTorso'));
  assert.ok(action.position.largestChanges[0]!.parentSampleIds.length > 0);
  assert.ok(action.position.largestChanges[0]!.childSampleIds.length > 0);
  assert.equal(action.rotation.status, 'available');
});

test('phase comparison declines unsegmented and incompatible marker windows without changing whole-clip results', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  const unsegmented = compareMotion(parent, child);
  assert.equal(unsegmented.status, 'available');
  if (unsegmented.status === 'available') {
    assert.equal(unsegmented.actionPhaseComparison.status, 'unavailable');
    if (unsegmented.actionPhaseComparison.status === 'unavailable') assert.match(unsegmented.actionPhaseComparison.reason, /No marker-defined/);
  }
  const incompatible = compareMotion(parent, child, 12, {
    parent: [{ label: 'main_action', occurrence: 1, startTime: 0.2, endTime: 0.5 }],
    child: [{ label: 'recovery', occurrence: 1, startTime: 0.2, endTime: 0.5 }],
  });
  assert.equal(incompatible.status, 'available');
  if (incompatible.status === 'available') {
    assert.equal(incompatible.actionPhaseComparison.status, 'unavailable');
    if (incompatible.actionPhaseComparison.status === 'unavailable') {
      assert.equal(incompatible.actionPhaseComparison.unmatchedParentPhaseCount, 1);
      assert.equal(incompatible.actionPhaseComparison.unmatchedChildPhaseCount, 1);
    }
  }
});

test('phase angular comparison fails closed when legacy samples lack orientation evidence', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  for (const sample of parent.samples) delete sample.orientations;
  for (const sample of child.samples) delete sample.orientations;
  const comparison = compareMotion(parent, child, 12, {
    parent: [{ label: 'main_action', occurrence: 1, startTime: 0.25, endTime: 0.75 }],
    child: [{ label: 'main_action', occurrence: 1, startTime: 0.25, endTime: 0.75 }],
  });
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  const phaseComparison = comparison.actionPhaseComparison;
  assert.equal(phaseComparison.status, 'available');
  if (phaseComparison.status !== 'available') return;
  assert.equal(phaseComparison.phases[0]!.rotation.status, 'unavailable');
  assert.equal(phaseComparison.phases[0]!.rotation.rmsAngularDisplacement, 0);
  assert.deepEqual(phaseComparison.phases[0]!.rotation.largestChanges, []);
});

test('revision comparison exposes configurable full changed-joint detail and explicit truncation counts', () => {
  const rigId = randomUUID();
  const parent = telemetry(randomUUID(), rigId);
  const child = structuredClone(parent);
  for (let index = 0; index < 16; index++) {
    const name = `Joint${index.toString().padStart(2, '0')}`;
    parent.nodes.push({ name, parent: 1, driven: true, foot: false });
    child.nodes.push({ name, parent: 1, driven: true, foot: false });
    for (const sample of parent.samples) { sample.points.push([0, 3, 0]); sample.bottoms.push(2); sample.orientations?.push([0, 0, 0, 1]); }
    for (const sample of child.samples) { sample.points.push([index + 1, 3, 0]); sample.bottoms.push(2); sample.orientations?.push([0, 0, 0, 1]); }
  }
  const compact = compareMotion(parent, child, 3);
  assert.equal(compact.status, 'available');
  if (compact.status !== 'available') return;
  assert.equal(compact.changedJointCount, 16);
  assert.equal(compact.largestChanges.length, 3);
  assert.equal(compact.omittedPositionChangeCount, 13);
  const complete = compareMotion(parent, child, 96);
  assert.equal(complete.status, 'available');
  if (complete.status !== 'available') return;
  assert.equal(complete.largestChanges.length, 16);
  assert.equal(complete.omittedPositionChangeCount, 0);
  assert.equal(compareMotion(parent, child, 0).status, 'unavailable');
});

test('positional RMS comparison is time-weighted and invariant to clustered redundant samples', () => {
  const rigId = randomUUID();
  const makePair = (times: number[]) => {
    const parent = telemetry(randomUUID(), rigId), child = telemetry(randomUUID(), rigId);
    parent.samples = times.map((time, index) => {
      const sample = structuredClone(parent.samples[0]!);
      sample.id = `s${String(index).padStart(3, '0')}`;
      sample.time = time;
      return sample;
    });
    child.samples = times.map((time, index) => {
      const sample = structuredClone(child.samples[0]!);
      sample.id = `s${String(index).padStart(3, '0')}`;
      sample.time = time;
      sample.points[1] = [2 * time, 3, 0];
      return sample;
    });
    return [parent, child] as const;
  };
  const sparse = makePair([0, 1]);
  const dense = makePair([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.08, 0.1, 0.2, 0.5, 0.75, 1]);
  const sparseResult = compareMotion(...sparse), denseResult = compareMotion(...dense);
  if (sparseResult.status !== 'available' || denseResult.status !== 'available') throw new Error('Expected available comparisons.');
  const sparseRms = sparseResult.largestChanges.find(change => change.joint === 'LowerTorso')!.rmsDisplacement;
  const denseRms = denseResult.largestChanges.find(change => change.joint === 'LowerTorso')!.rmsDisplacement;
  assert.equal(sparseRms, 1.1547);
  assert.equal(denseRms, sparseRms);
});

test('angular RMS and peak include interior SLERP evaluations and resist clustered sample bias', () => {
  const rigId = randomUUID();
  const makePair = (times: number[]) => {
    const parent = telemetry(randomUUID(), rigId), child = telemetry(randomUUID(), rigId);
    parent.samples = times.map((time, index) => {
      const sample = structuredClone(parent.samples[0]!);
      sample.id = `s${String(index).padStart(3, '0')}`;
      sample.time = time;
      return sample;
    });
    child.samples = times.map((time, index) => {
      const sample = structuredClone(child.samples[0]!);
      sample.id = `s${String(index).padStart(3, '0')}`;
      sample.time = time;
      const halfAngle = 90 * time * Math.PI / 360;
      sample.orientations![2] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
      return sample;
    });
    return [parent, child] as const;
  };
  const sparseResult = compareMotion(...makePair([0, 1]));
  const denseResult = compareMotion(...makePair([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.08, 0.1, 0.2, 0.5, 0.75, 1]));
  if (sparseResult.status !== 'available' || denseResult.status !== 'available') throw new Error('Expected available comparisons.');
  const sparseRotation = sparseResult.largestRotationChanges.find(change => change.joint === 'LeftFoot')!;
  const denseRotation = denseResult.largestRotationChanges.find(change => change.joint === 'LeftFoot')!;
  assert.equal(sparseRotation.rmsAngularDisplacement, 51.9615);
  assert.equal(denseRotation.rmsAngularDisplacement, sparseRotation.rmsAngularDisplacement);
  assert.equal(sparseRotation.maxAngularDisplacement, 90);
  assert.ok(sparseResult.angularEvaluationSamples > sparseResult.normalizedSamples);
});

test('telemetry and sample-time contracts reject mismatched arrays, hierarchy and duplicate times', () => {
  const data = telemetry(randomUUID(), randomUUID());
  for (const corrupt of [
    (value: Telemetry) => { value.samples[0]!.points.pop(); },
    (value: Telemetry) => { value.samples[1]!.time = 0; },
    (value: Telemetry) => { value.nodes[1]!.parent = 4; },
    (value: Telemetry) => { value.samples[0]!.points[0]![0] = Infinity; },
    (value: Telemetry) => { value.restPose = { points: [[0, 0, 0]], orientations: [[0, 0, 0, 1]] }; },
  ]) { const changed = structuredClone(data); corrupt(changed); assert.equal(telemetrySchema.safeParse(changed).success, false); }
  const awkward = animationPreset('walk', 'Weighted Walk', 0.10000001, 1);
  awkward.markers = [{ name: 'Near start', time: 0.000001 }];
  const times = sampleTimes(awkward); assert.equal(times[0], 0); assert.equal(times.at(-1), awkward.duration); assert.ok(times.length <= 128); assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]!));
  for (const key of awkward.tracks[0]!.keys) assert.ok(times.includes(key.time), `Missing authored key time ${key.time}`);
});

test('revision comparison verifies a captured rest-pose baseline and rejects rig setup drift', () => {
  const rigId = randomUUID();
  const parent = telemetry(randomUUID(), rigId), child = telemetry(randomUUID(), rigId);
  parent.restPose = { points: parent.samples[0]!.points.map(point => [...point] as [number, number, number]), orientations: structuredClone(parent.samples[0]!.orientations!) };
  child.restPose = structuredClone(parent.restPose);
  const verified = compareMotion(parent, child);
  assert.equal(verified.status, 'available');
  if (verified.status !== 'available') return;
  assert.equal(verified.baselineStatus, 'verified');
  child.restPose.points[2]![0] += 0.1;
  const changedBaseline = compareMotion(parent, child);
  assert.equal(changedBaseline.status, 'unavailable');
  if (changedBaseline.status === 'unavailable') assert.match(changedBaseline.reason, /rest pose differs at LeftFoot/);
  const legacy = structuredClone(parent);
  delete legacy.restPose;
  const legacyComparison = compareMotion(legacy, child);
  assert.equal(legacyComparison.status, 'available');
  if (legacyComparison.status === 'available') assert.equal(legacyComparison.baselineStatus, 'not_recorded');
});

test('revision comparison prefers pivot-local samples when per-capture ground estimates differ', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  child.assetId = randomUUID();
  for (const sample of parent.samples) sample.pivotPoints = structuredClone(sample.points);
  for (const sample of child.samples) {
    sample.pivotPoints = structuredClone(sample.points);
    sample.points = sample.points.map(([x, y, z]) => [x, y + 12, z]);
  }
  const comparison = compareMotion(parent, child);
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  assert.equal(comparison.positionFrame, 'pivot_local');
  assert.equal(comparison.changedJointCount, 0);
  assert.equal(telemetrySchema.safeParse(parent).success, true);
  const mixedFrame = structuredClone(child);
  delete mixedFrame.samples[0]!.pivotPoints;
  assert.equal(telemetrySchema.safeParse(mixedFrame).success, false);
  assert.equal(compareMotion(parent, mixedFrame).status, 'unavailable');
});

test('revision comparison returns evidence-linked timeline intervals for localized changes', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  child.assetId = randomUUID();
  child.samples[1]!.points[1]![0] += 2;
  child.samples[2]!.points[1]![0] += 2;
  const comparison = compareMotion(parent, child);
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  const interval = comparison.positionChangeIntervals[0];
  assert.ok(interval);
  assert.equal(interval.joints[0], 'LowerTorso');
  assert.ok(interval.startProgress >= 0 && interval.startProgress < 0.25);
  assert.ok(interval.endProgress > 0.5 && interval.endProgress < 1);
  assert.ok(interval.peakDisplacement >= 2);
  assert.ok(interval.rmsDisplacement > 0);
  assert.ok(interval.parentSampleIds.includes('s001') && interval.childSampleIds.includes('s002'));
  assert.equal(interval.parentStartTime, interval.startProgress * parent.duration);
  assert.equal(interval.childEndTime, interval.endProgress * child.duration);
});

test('revision comparison preserves a captured beat less than one microsecond from its neighbor', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  child.assetId = randomUUID();
  const authoredBeat = 0.5000004;
  const peak = structuredClone(child.samples[2]!);
  peak.id = 's005';
  peak.time = authoredBeat;
  peak.points[1]![0] += 2;
  child.samples.splice(3, 0, peak);

  const comparison = compareMotion(parent, child);
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  const lowerTorsoChange = comparison.largestChanges.find(change => change.joint === 'LowerTorso');
  assert.equal(lowerTorsoChange?.atProgress, authoredBeat,
    'the exact captured beat must survive normalized-progress sampling and peak reporting');
  assert.equal(lowerTorsoChange?.childTime, authoredBeat);
});

test('revision comparison does not merge changed intervals across a distinct tiny unchanged beat', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  child.assetId = randomUUID();
  const times = [0, 0.5, 0.500000005, 0.50000001, 0.500000015, 1];
  parent.samples = times.map((time, index) => {
    const sample = structuredClone(parent.samples[0]!);
    sample.id = `s${String(index).padStart(3, '0')}`;
    sample.time = time;
    return sample;
  });
  child.samples = times.map((time, index) => {
    const sample = structuredClone(parent.samples[index]!);
    sample.id = `s${String(index).padStart(3, '0')}`;
    sample.time = time;
    if (index === 1 || index === 4) sample.points[1]![0] = 2;
    return sample;
  });

  const comparison = compareMotion(parent, child);
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  assert.equal(comparison.positionChangeIntervals.length, 2,
    'two changed windows must remain separate across the authored zero-change interval');
  assert.ok(comparison.positionChangeIntervals[0]!.endProgress < comparison.positionChangeIntervals[1]!.startProgress);
});

test('revision comparison localizes angular changes to their authored phase', () => {
  const rigId = randomUUID(), parent = telemetry(randomUUID(), rigId), child = structuredClone(parent);
  child.assetId = randomUUID();
  const halfAngle = 45 * Math.PI / 360;
  for (const index of [1, 2]) child.samples[index]!.orientations![2] = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
  const comparison = compareMotion(parent, child);
  assert.equal(comparison.status, 'available');
  if (comparison.status !== 'available') return;
  const interval = comparison.rotationChangeIntervals[0];
  assert.ok(interval);
  assert.equal(interval.joints[0], 'LeftFoot');
  assert.ok(interval.startProgress >= 0 && interval.startProgress < 0.25);
  assert.ok(interval.endProgress > 0.5 && interval.endProgress < 1);
  assert.ok(interval.peakAngularDisplacement >= 45);
  assert.ok(interval.rmsAngularDisplacement > 0);
  assert.ok(interval.parentSampleIds.includes('s001') && interval.childSampleIds.includes('s002'));
});

test('sample schedule prioritizes layer/root keyframes and contact evidence under the Studio sample cap', () => {
  const animation = recipe();
  for (const [trackIndex, track] of animation.tracks.entries()) track.keys = Array.from({ length: 120 }, (_, index) => ({
    time: index === 0 ? 0 : index === 119 ? 1 : index / 119 + trackIndex * 0.0002,
    position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  }));
  animation.layers = [{ id: randomUUID(), name: 'Fast layer', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [{ joint: 'LeftFoot', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 0.137, position: [0, 1, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] }];
  animation.rootMotion = { joint: 'LowerTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 0.239, position: [1, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] };
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.333, end: 0.667 }];
  const times = sampleTimes(animation);
  assert.equal(times.length, 128);
  assert.ok(times.includes(0.333) && times.includes(0.5) && times.includes(0.667));
  assert.ok(times.includes(0.137) && times.includes(0.239));
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]!));
});

test('required acceptance windows get dense, boundary-inclusive samples and fail instead of silently truncating', () => {
  const animation = recipe();
  const window = { start: 0.2, end: 0.8, maxSampleGapSeconds: 0.2 };
  const times = sampleTimes(animation, [window]);
  const inside = times.filter(time => time >= window.start - 1e-6 && time <= window.end + 1e-6);
  assert.equal(inside[0], window.start);
  assert.equal(inside.at(-1), window.end);
  assert.ok(inside.length >= 4);
  assert.ok(inside.slice(1).every((time, index) => time - inside[index]! <= window.maxSampleGapSeconds + 1e-6));
  assert.throws(() => sampleTimes(animation, [{ start: 0.01, end: 0.99, maxSampleGapSeconds: 0.001 }]), /128-sample Studio inspection limit/i);
  assert.throws(() => sampleTimes(animation, [{ start: 0.2, end: 0.8, maxSampleGapSeconds: Number.MIN_VALUE }]), /128-sample Studio inspection limit/i,
    'an extreme but finite sample-gap request must fail before iterating an unbounded subdivision count');
  assert.throws(() => sampleTimes(animation, [{ start: 0.8, end: 1.2, maxSampleGapSeconds: 0.1 }]), /inside the animation duration/i);
});

test('required sampling fails closed instead of dropping declared contact beats at the sample cap', () => {
  const animation = recipe();
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.333, end: 0.667 }];
  assert.throws(() => sampleTimes(animation, [{ start: 0.001, end: 0.999, maxSampleGapSeconds: 0.008 }]),
    /Declared contact boundaries and midpoints exceed the 128-sample Studio inspection limit/);
});

test('declared contact midpoint sampling and pose evidence preserve exact fractional time', () => {
  const animation = recipe();
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.1234561, end: 0.8765432 }];
  const midpoint = (animation.contacts[0]!.start + animation.contacts[0]!.end) / 2;
  const times = sampleTimes(animation);
  assert.ok(times.includes(midpoint), `exact contact midpoint ${midpoint} must be sampled rather than rounded`);
  assert.ok(times.includes(animation.contacts[0]!.start) && times.includes(animation.contacts[0]!.end));

  const raw = telemetry(randomUUID(), randomUUID());
  raw.duration = animation.duration;
  raw.samples = times.map((time, index) => ({ ...structuredClone(raw.samples[0]!), id: `s${String(index).padStart(3, '0')}`, time }));
  const poseEvidence = buildPoseEvidenceIndex(raw, inspectMotion(animation, raw).report, animation)!;
  const midpointEvidence = poseEvidence.samplingCoverage?.declaredContactMoments.entries.find(moment => moment.moment === 'midpoint');
  assert.equal(midpointEvidence?.timeSeconds, midpoint, 'the AI-facing coverage index must preserve the exact requested contact midpoint');
  assert.equal(midpointEvidence?.sampleId, raw.samples.find(sample => sample.time === midpoint)?.id,
    'the exact sampled contact midpoint must not be mislabeled as an unobserved beat');
});

test('contact inspection excludes nearby outside samples instead of treating them as boundary evidence', () => {
  const animation = recipe();
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5000001, end: 0.5000009 }];
  const raw = telemetry(randomUUID(), randomUUID());
  raw.samples = [0, 0.5, 0.5000002, 0.5000008, 0.75, 1].map((time, index) => ({
    ...structuredClone(raw.samples[0]!), id: `s${String(index).padStart(3, '0')}`, time,
  }));
  const report = inspectMotion(animation, raw).report;
  const metric = report.metrics.find(item => item.id === 'declared-contact-0');
  assert.deepEqual(metric?.contactSampling?.sampleTimes, [0.5000002, 0.5000008],
    'samples 0.4 microseconds outside the window must not contaminate its contact trace');
  assert.equal(metric?.contactSampling?.exactStart, false);
  assert.equal(metric?.contactSampling?.exactEnd, false);
});

test('sample scheduling preserves close authored beats and required-window gap guarantees', () => {
  const animation = recipe();
  animation.tracks[0]!.keys = [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.00005, position: [0, 1, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ];
  const authored = sampleTimes(animation);
  assert.ok(authored.includes(0.00005), 'a distinct authored fast beat must not merge into the start sample');

  const window = { start: 0.00005, end: 0.00015, maxSampleGapSeconds: 0.00005 };
  const required = sampleTimes(animation, [window]).filter(time => time >= window.start && time <= window.end);
  assert.equal(required.length, 3);
  assert.equal(required[0], window.start);
  assert.ok(Math.abs(required[1]! - 0.0001) < 1e-12);
  assert.equal(required[2], window.end);
  assert.ok(required.slice(1).every((time, index) => time - required[index]! <= window.maxSampleGapSeconds));
});

test('explicit Studio target times are mandatory, precision-distinct, duration-bounded, and fail closed at the sample cap', () => {
  const animation = recipe();
  const requested = [0.413, 0.41305];
  const times = sampleTimes(animation, [], requested);
  assert.ok(times.includes(requested[0]!));
  assert.ok(times.includes(requested[1]!), 'close but distinguishable target beats must both be sampled');
  assert.equal(sampleTimes(animation, [], [0.413, 0.413]).filter(time => time === 0.413).length, 1,
    'duplicate target requests should share one exact telemetry sample');
  assert.throws(() => sampleTimes(animation, [], [animation.duration + 0.01]), /inside the animation duration/i);
  assert.throws(() => sampleTimes(animation, [], Array.from({ length: 128 }, (_, index) => (index + 1) / 130)),
    /Explicit requested sample times exceed the 128-sample Studio inspection limit/i);
});

test('pose evidence index reports authored beats omitted by the sample cap', () => {
  const animation = recipe();
  for (const [trackIndex, track] of animation.tracks.entries()) track.keys = Array.from({ length: 120 }, (_, index) => ({
    time: index === 0 ? 0 : index === 119 ? 1 : index / 119 + trackIndex * 0.0002,
    position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  }));
  animation.markers = [{ name: 'Fast transition', time: 0.413 }];
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.2, end: 0.6 }];
  const times = sampleTimes(animation);
  assert.equal(times.length, 128);
  assert.ok(!times.includes(0.413), 'the crowded schedule fixture must leave this marker unsampled');
  const raw = telemetry(randomUUID(), randomUUID());
  raw.samples = times.map((time, index) => ({ ...structuredClone(raw.samples[0]!), id: `s${String(index).padStart(3, '0')}`, time }));
  const report = inspectMotion(animation, raw).report;
  const profile = { version: 1, rigId: raw.rigId, rigName: 'Pose Evidence R15', rigType: 'R15' as const, rigSignature: 'pose-evidence-rig-v1',
    joints: raw.nodes.map((node, index) => ({ name: node.name, parent: node.parent > 0 ? raw.nodes[node.parent - 1]?.name ?? '' : '',
      driven: node.driven, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: index ? 2 : 0 })) };
  const index = buildPoseEvidenceIndex(raw, report, animation, profile)!;
  assert.equal(index.semanticRoleIndex?.rig.type, 'R15');
  assert.ok(index.nodeSlots.find(node => node.name === 'LeftFoot')?.semanticRoles?.some(role => role.role === 'left_foot' && role.resolution === 'exact'));
  assert.ok(index.nodeSlots.find(node => node.name === 'LowerTorso')?.semanticRoles?.some(role => role.role === 'pelvis' && role.resolution === 'exact'));
  assert.match(index.semanticRoleIndex?.limitations.join(' ') ?? '', /not verified anatomy/i);
  assert.ok(index.samplingCoverage);
  assert.equal(index.samplingCoverage.markers.expectedCount, 1);
  assert.equal(index.samplingCoverage.markers.omittedCount, 1);
  assert.deepEqual(index.samplingCoverage.markers.entries[0], { name: 'Fast transition', timeSeconds: 0.413, sampleId: null });
  assert.equal(index.samplingCoverage.declaredContactMoments.omittedCount, 0);
  assert.ok(index.samplingCoverage.authoredKeyframes.omittedTimeCount > 0);
});

test('a missing rig and VFX stay explicitly recipe-only, with no claimed visual verdict', () => {
  const animation = inspectMotion(recipe()); assert.equal(animation.report.source, 'recipe_only'); assert.ok(animation.report.findings.some(f => f.severity === 'unknown')); assert.equal(animation.telemetry, undefined);
  const effect = inspectMotion(vfxPreset('impact', 'Impact')); assert.equal(effect.report.source, 'recipe_only'); assert.match(effect.report.limitations[0]!, /not simulated/);
});

test('inspection and AI critique never accept a version; acceptance requires explicit watched feedback', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save({ ...recipe(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 0.75 }] });
    const review = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, aiReview: true, provider: 'deepseek' })).id);
    assert.equal(review.status, 'needs_feedback'); assert.equal(review.preview?.status, 'confirmed'); assert.equal(review.critique?.source, 'pose_data'); assert.equal(review.feedback, undefined);
    const contactMetric = review.report.metrics.find(metric => metric.id === 'declared-contact-0');
    assert.deepEqual(contactMetric?.contactSampling, { status: 'complete', sampleTimes: [0.25, 0.5, 0.75], maximumSampleGapSeconds: 0.25,
      exactStart: true, exactMidpoint: true, exactEnd: true });
    await assert.rejects(f.reviews.feedback({ ...feedback(review), feedback: { ...feedback(review).feedback, watchedPreview: false } }));
    const accepted = await f.reviews.feedback(feedback(review, 'accept'));
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.feedback?.source, 'local_user_form');
    assert.equal(accepted.critique?.findings[0]?.interpretation, 'measured_issue');
    await assert.rejects(f.reviews.reserveRevision(accepted.id, accepted.revision), /Record what should change/);
    await assert.rejects(f.reviews.feedback(feedback(accepted)), /busy or complete/);
    const restarted = new Reviews(join(f.root, 'artifacts/reviews'), f.library, f.queue, f.connections);
    const { integrity: _acceptedIntegrity, snapshotVersion: _acceptedSnapshotVersion, ...legacyAccepted } = accepted;
    assert.equal((await restarted.latest(asset.id))?.status, 'accepted');
    assert.deepEqual((await restarted.read(accepted.id)).report.metrics.find(metric => metric.id === 'declared-contact-0')?.contactSampling,
      contactMetric?.contactSampling, 'persisted review records must retain exact contact sample coverage');
    const acceptedPath = join(f.root, 'artifacts/reviews', accepted.id, `${String(accepted.revision).padStart(6, '0')}.json`);
    const validAcceptedSnapshot = await readFile(acceptedPath, 'utf8');
    const { integrity: _removedIntegrity, ...missingIntegrity } = accepted;
    await writeFile(acceptedPath, JSON.stringify(missingIntegrity));
    await assert.rejects(restarted.read(accepted.id), /Versioned review snapshots must include their integrity digest/i,
      'removing only the checksum must not downgrade a versioned snapshot to the legacy format');
    await writeFile(acceptedPath, validAcceptedSnapshot);
    await writeFile(acceptedPath, JSON.stringify({ ...accepted, assetName: 'Edited on disk' }));
    await assert.rejects(restarted.read(accepted.id), /Review snapshot integrity check failed/i,
      'new snapshots must detect edits to otherwise schema-valid persisted review evidence');
    await writeFile(acceptedPath, validAcceptedSnapshot);
    await writeFile(acceptedPath, JSON.stringify({ ...legacyAccepted, parentAssetId: randomUUID() }));
    await assert.rejects(restarted.read(accepted.id), /lineage does not match the immutable animation library parent/,
      'review lineage must match the actual immutable asset ancestry');
    await writeFile(acceptedPath, JSON.stringify(accepted));
    assert.ok(accepted.critique?.findings[0]);
    await writeFile(acceptedPath, JSON.stringify({ ...legacyAccepted, critique: { ...accepted.critique!, findings: [
      { ...accepted.critique!.findings[0]!, interpretation: 'reference_target' }, ...accepted.critique!.findings.slice(1),
    ] } }));
    await assert.rejects(restarted.read(accepted.id), /interpretation contradicts its cited evidence identity/,
      'persisted finding interpretation must remain bound to its cited evidence');
    await writeFile(acceptedPath, JSON.stringify({ ...legacyAccepted, critique: { ...accepted.critique!, findings: accepted.critique!.findings.map(({ interpretation: _interpretation, ...finding }) => finding) } }));
    assert.equal((await restarted.read(accepted.id)).critique?.findings[0]?.interpretation, 'measured_issue',
      'legacy findings without the new classification should receive a safe evidence-derived value');
    await writeFile(acceptedPath, JSON.stringify(accepted));
    await writeFile(acceptedPath, JSON.stringify({ ...legacyAccepted, critique: { ...accepted.critique!, findings: [
      { ...accepted.critique!.findings[0]!, evidenceIds: ['foreign-sample'] },
      ...accepted.critique!.findings.slice(1),
    ] } }));
    await assert.rejects(restarted.read(accepted.id), /cites evidence outside this review/,
      'persisted critique citations must resolve to this review’s Studio samples or images');
    await writeFile(acceptedPath, JSON.stringify({ ...legacyAccepted, feedback: undefined }));
    await assert.rejects(restarted.read(accepted.id), /explicit watched-preview acceptance feedback/,
      'persisted state must not claim acceptance after its required feedback is removed');
  } finally { f.close(); }
});

test('review reads and inbox listing are side-effect free; interrupted work is recovered explicitly', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save(recipe());
    const settledRecord = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id })).id);
    const { integrity: _settledIntegrity, snapshotVersion: _settledSnapshotVersion, ...legacySettledRecord } = settledRecord;
    const interrupted = { ...legacySettledRecord, revision: settledRecord.revision + 1, status: 'critiquing' as const, owner: randomUUID() };
    const reviewPath = join(f.root, 'artifacts/reviews', interrupted.id, `${String(interrupted.revision).padStart(6, '0')}.json`);
    await writeFile(reviewPath, JSON.stringify(interrupted));
    const restarted = new Reviews(join(f.root, 'artifacts/reviews'), f.library, f.queue, f.connections);

    const read = await restarted.read(interrupted.id);
    assert.equal(read.status, 'critiquing');
    assert.equal(read.revision, interrupted.revision, 'read must not silently create a recovery revision');
    const reviewsDirectory = join(f.root, 'artifacts/reviews');
    const malformedFileId = randomUUID(), malformedJsonId = randomUUID();
    await writeFile(join(reviewsDirectory, malformedFileId), 'not a review directory');
    await mkdir(join(reviewsDirectory, malformedJsonId), { recursive: true });
    await writeFile(join(reviewsDirectory, malformedJsonId, '000001.json'), '{ malformed review');
    const inbox = await restarted.list({ offset: 0, limit: 10, invalidOffset: 0 });
    assert.equal(inbox.records.find(record => record.id === interrupted.id)?.recoveryRequired, true);
    assert.equal(inbox.invalidRecordCount, 2);
    assert.equal((await restarted.read(interrupted.id)).revision, interrupted.revision, 'listing must also be side-effect free');
    const firstDiagnostics = await restarted.list({ offset: 0, limit: 1, invalidOffset: 0 });
    assert.equal(firstDiagnostics.invalidRecords.length, 1);
    assert.equal(firstDiagnostics.nextInvalidOffset, 1);
    const secondDiagnostics = await restarted.list({ offset: 0, limit: 1, invalidOffset: firstDiagnostics.nextInvalidOffset! });
    assert.equal(secondDiagnostics.invalidRecords.length, 1);
    assert.equal(secondDiagnostics.nextInvalidOffset, null);
    assert.equal((await restarted.latest(asset.id))?.id, settledRecord.id,
      'latest lookup must validate records and remain resilient to malformed unrelated entries');

    const recovered = await restarted.recover(interrupted.id);
    assert.equal(recovered.status, 'needs_feedback');
    assert.equal(recovered.revision, interrupted.revision + 1);
    assert.match(recovered.error ?? '', /server restarted/);
  } finally { f.close(); }
});

test('stale and concurrent feedback cannot overwrite another response; edits invalidate evidence', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save(recipe()), record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id })).id);
    const results = await Promise.allSettled([f.reviews.feedback(feedback(record)), f.reviews.feedback(feedback(record, 'accept'))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await assert.rejects(f.reviews.feedback(feedback(record)), /changed/);
    await writeFile(join(f.library.directory, `${asset.id}.json`), JSON.stringify({ ...asset, recipe: { ...asset.recipe, name: 'Externally edited' } }));
    await assert.rejects(f.reviews.read(record.id), /changed outside/);
  } finally { f.close(); }
});

test('generation, inspection, user feedback and revision form a persistent loop that preserves liked qualities', async () => {
  const prompts: string[] = [];
  const f = await setup(async (_credential, system, prompt) => {
    prompts.push(prompt);
    if (system.includes('TARGETED ANIMATION REFINEMENT OUTPUT')) return { text: JSON.stringify({ approach: 'Lower the upper-arm pose at the requested contact beat without rebuilding the walk.',
      checkpoints: ['Confirm the arm changes at contact', 'Confirm all other tracks remain unchanged'], avoid: [],
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-65, 0, 0] }] }), usage };
    return { text: JSON.stringify(system.startsWith('Review a Motion') ? critique() : reply()), usage };
  });
  try {
    const first = await draftDone(f.authoring, f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Make a heavy grounded walk with a clear arm swing.', sessionId: f.sessionId, rigId: f.rigId, aiReview: true }).id);
    assert.equal(first.status, 'succeeded', first.error); assert.ok(first.reviewId);
    const inspected = await settled(f.reviews, first.reviewId!); assert.equal(inspected.status, 'needs_feedback');
    const answered = await f.reviews.feedback(feedback(inspected));
    const context = await f.reviews.reserveRevision(answered.id, answered.revision);
    await assert.rejects(f.reviews.reserveRevision(answered.id, answered.revision), /changed/);
    const second = await draftDone(f.authoring, f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: context.changes, parentId: context.assetId, sessionId: f.sessionId, rigId: f.rigId, aiReview: true }, context).id);
    assert.equal(second.status, 'succeeded', second.error); assert.notEqual(second.assetId, first.assetId);
    assert.equal((await f.library.get(second.assetId!)).parentId, first.assetId);
    const parentAnimation = (await f.library.get(first.assetId!)).recipe;
    const revisedAnimation = await f.library.get(second.assetId!);
    assert.equal(revisedAnimation.revisionProvenance?.kind, 'ai_candidate_patch');
    assert.deepEqual(revisedAnimation.revisionProvenance?.operations, [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-65, 0, 0] }]);
    if (parentAnimation.kind !== 'animation' || revisedAnimation.recipe.kind !== 'animation') assert.fail('Expected animation recipes.');
    assert.deepEqual(revisedAnimation.recipe.tracks.filter(track => track.joint !== 'LeftUpperArm'), parentAnimation.tracks.filter(track => track.joint !== 'LeftUpperArm'));
    assert.deepEqual(revisedAnimation.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.filter(key => key.time !== 0.5),
      parentAnimation.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.filter(key => key.time !== 0.5));
    assert.deepEqual((await f.library.get(second.assetId!)).revisionProvenance?.operations, revisedAnimation.revisionProvenance?.operations,
      'library read replays and verifies the persisted targeted patch lineage');
    assert.equal((await f.reviews.read(inspected.id)).childAssetId, second.assetId);
    assert.equal((await settled(f.reviews, second.reviewId!)).status, 'needs_feedback');
    const revisionPrompt = prompts.find(p => p.includes('userFeedback'))!;
    assert.match(revisionPrompt, /Keep the arm swing and the loop length/); assert.match(revisionPrompt, /Make a heavy grounded walk/); assert.match(revisionPrompt, /Add more weight/);
    assert.match(revisionPrompt, /keep the liked motion unchanged/i);
    const provenance = JSON.parse(await readFile(join(f.root, 'artifacts/generations', `${second.assetId}.json`), 'utf8'));
    assert.equal(provenance.feedbackReviewId, inspected.id); assert.equal(provenance.originalRequest, 'Make a heavy grounded walk with a clear arm swing.');
    assert.equal((await f.library.get(first.assetId!)).recipe.name, recipe().name);
  } finally { f.close(); }
});

test('draft cancellation refuses to imply rollback after the immutable asset has been saved', async () => {
  const f = await setup(async () => ({ text: JSON.stringify(reply()), usage }));
  const originalStart = f.reviews.start.bind(f.reviews);
  let signalReviewStarted = () => {};
  let releaseReviewStart = () => {};
  const reviewStarted = new Promise<void>(resolve => { signalReviewStarted = resolve; });
  const reviewGate = new Promise<void>(resolve => { releaseReviewStart = resolve; });
  f.reviews.start = async input => { signalReviewStarted(); await reviewGate; return originalStart(input); };
  try {
    const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Create a walk' });
    await reviewStarted;
    const running = f.authoring.get(job.id);
    assert.equal(running.status, 'running');
    assert.ok(running.assetId, 'the job must be past the durable library save boundary');
    assert.deepEqual(f.authoring.cancel(job.id), { requested: false, reason: 'draft_already_saved', assetId: running.assetId });
    assert.equal((await f.library.get(running.assetId)).id, running.assetId);
    releaseReviewStart();
    const finished = await draftDone(f.authoring, job.id);
    assert.equal(finished.status, 'succeeded', finished.error);
    assert.equal(finished.assetId, running.assetId);
  } finally { releaseReviewStart(); f.close(); }
});

test('AI evidence citations are validated and invalid critique does not trigger retries or acceptance', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; return { text: JSON.stringify({ ...critique(), findings: [{ ...critique().findings[0], source: 'user_image', evidenceIds: ['made-up-image'] }] }), usage }; });
  try {
    const asset = await f.library.save(recipe());
    const record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, aiReview: true, provider: 'deepseek' })).id);
    assert.equal(calls, 1); assert.equal(record.status, 'needs_feedback'); assert.equal(record.critique, undefined); assert.match(record.error!, /evidence that was not provided/);
    assert.ok(record.telemetry); assert.equal(record.feedback, undefined);
  } finally { f.close(); }
});

test('AI critique returns evidence-linked patch proposals that are dry-run validated and never auto-applied', async () => {
  const proposed = {
    id: 'stabilize-contact', findingIndex: 0, title: 'Soften the planted-leg transition', rationale: 'The sampled contact phase is the cited area to inspect.',
    evidence: [{ source: 'pose_samples', id: 's000' }], risk: 'low',
    operations: [{ operation: 'set_pose', joint: 'LeftUpperLeg', time: 0.5, rotation: [-30, 0, 0] }],
  };
  const groupedProposed = {
    id: 'coordinate-landing', findingIndex: 0, title: 'Coordinate the landing pose', rationale: 'The cited beat benefits from a matched change across both legs.',
    evidence: [{ source: 'pose_samples', id: 's000' }], risk: 'medium',
    operations: [{ operation: 'offset_pose_group', time: 0.5, targets: [
      { joint: 'LeftUpperLeg', rotationOffset: [-5, 0, 0] }, { joint: 'RightUpperLeg', rotationOffset: [-5, 0, 0] },
    ] }],
  };
  let prompt = '', instructions = '';
  const f = await setup(async (_credential, system, request) => {
    instructions = system; prompt = request;
    return { text: JSON.stringify({ ...critique(), proposals: [proposed, groupedProposed] }), usage };
  });
  try {
    const sourceRecipe = recipe();
    const blueprintAsset = await f.library.saveIdempotent(sourceRecipe, randomUUID(), undefined, undefined, undefined, undefined, {
      schemaVersion: 1, sourceRecipeFingerprint: fingerprint(sourceRecipe), phases: [
        { id: 'windup', label: 'anticipation', start: 0, end: 0.5, intent: 'Keep the torso loaded before the step.' },
        { id: 'step', label: 'main_action', start: 0.5, end: 1, intent: 'Land the step with a grounded weight shift.' },
      ],
      events: [{ name: 'FootPlant', phaseId: 'step', progress: 0.5, time: 0.75 }],
      contacts: [{ effector: 'LeftFoot', kind: 'support', phaseId: 'step', startProgress: 0.2, endProgress: 0.4, start: 0.6, end: 0.7 }],
    });
    const asset = await f.library.save({ ...sourceRecipe, name: 'Edited weighted walk' }, blueprintAsset.id);
    const original = await f.library.get(asset.id);
    const inspected = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId })).id);
    const critiquePending = await f.reviews.critique({ reviewId: inspected.id, revision: inspected.revision, provider: 'deepseek' });
    const reviewed = await settled(f.reviews, critiquePending.id);
    const result = reviewed.critique?.proposals[0];
    assert.ok(result, reviewed.error);
    const groupedResult = reviewed.critique?.proposals[1];
    assert.ok(groupedResult);
    assert.deepEqual(result.operations, proposed.operations);
    assert.equal(result.validation.sourceFingerprint, reviewed.assetHash);
    assert.notEqual(result.validation.candidateFingerprint, reviewed.assetHash);
    assert.equal(result.validation.changes.length, 1);
    const preview = await f.reviews.previewProposal({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: result.id });
    assert.equal(preview.candidateFingerprint, result.validation.candidateFingerprint);
    assert.equal(preview.findingIndex, 0);
    assert.deepEqual(preview.linkedFinding, reviewed.critique?.findings[0]);
    assert.deepEqual(preview.authoringIntent, blueprintAsset.authoringIntent);
    assert.equal(preview.authoringIntentTimingMatchesCurrentRecipe, false,
      'proposal preview should disclose that its inherited phase timing belongs to the prior recipe');
    assert.equal(preview.authoringIntentTimingRelation, 'historical_reference');
    assert.deepEqual(preview.preservationAudit.affectedWindow, { startTime: 0.25, endTime: 0.75 });
    assert.deepEqual(preview.preservationAudit.preservedIntervals.map(region => [region.startTime, region.endTime]), [[0, 0.25], [0.75, 1]]);
    assert.equal(preview.preservationAudit.otherRecipeData, 'exactly_unchanged_except_target_track');
    assert.equal(preview.preservationAudit.sourceFingerprint, reviewed.assetHash);
    assert.equal(preview.preservationAudit.candidateFingerprint, preview.candidateFingerprint);
    assert.deepEqual(preview.recipe.tracks.find(track => track.joint === 'LeftUpperLeg')?.keys.find(key => key.time === 0.5)?.rotation, [-30, 0, 0]);
    const groupedPreview = await f.reviews.previewProposal({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: groupedResult.id });
    assert.equal(groupedPreview.preservationAudit.mode, 'server_derived_grouped_pose_edit');
    assert.deepEqual(groupedPreview.preservationAudit.targetJoints, ['LeftUpperLeg', 'RightUpperLeg']);
    assert.deepEqual(groupedPreview.preservationAudit.affectedWindows, [
      { joint: 'LeftUpperLeg', startTime: 0.25, endTime: 0.75 }, { joint: 'RightUpperLeg', startTime: 0.25, endTime: 0.75 },
    ]);
    assert.deepEqual(groupedPreview.preservationAudit.preservedIntervals.map(region => [region.joint, region.startTime, region.endTime]), [
      ['LeftUpperLeg', 0, 0.25], ['LeftUpperLeg', 0.75, 1], ['RightUpperLeg', 0, 0.25], ['RightUpperLeg', 0.75, 1],
    ]);
    assert.equal(groupedPreview.preservationAudit.otherRecipeData, 'exactly_unchanged_except_target_tracks');
    const editorDraft = structuredClone(original.recipe);
    assert.equal(editorDraft.kind, 'animation');
    if (editorDraft.kind !== 'animation') throw new Error('Fixture must be an animation.');
    for (const key of editorDraft.tracks.find(track => track.joint === 'RightUpperArm')!.keys) key.rotation = [0, 12, 0];
    const editorDraftFingerprint = fingerprint(editorDraft);
    const rebased = await f.reviews.previewProposalOnEditorDraft({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: result.id,
      draftRecipe: editorDraft, expectedDraftFingerprint: editorDraftFingerprint, loadedSourceFingerprint: reviewed.assetHash });
    assert.equal(rebased.expectedDraftFingerprint, editorDraftFingerprint);
    assert.equal(rebased.loadedSourceFingerprint, reviewed.assetHash);
    assert.deepEqual(rebased.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys[0]?.rotation, [0, 12, 0], 'unrelated manual edits survive proposal rebase');
    assert.deepEqual(rebased.recipe.tracks.find(track => track.joint === 'LeftUpperLeg')?.keys.find(key => key.time === 0.5)?.rotation, [-30, 0, 0]);
    assert.equal(rebased.patchPreview.candidateFingerprint, createHash('sha256').update(JSON.stringify({ sourceFingerprint: editorDraftFingerprint,
      operations: rebased.operations, preserve: rebased.preserve, recipeFingerprint: rebased.candidateFingerprint })).digest('hex'));
    const groupedRebase = await f.reviews.previewProposalOnEditorDraft({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: groupedResult.id,
      draftRecipe: editorDraft, expectedDraftFingerprint: editorDraftFingerprint, loadedSourceFingerprint: reviewed.assetHash });
    for (const joint of ['LeftUpperLeg', 'RightUpperLeg']) {
      assert.deepEqual(groupedRebase.recipe.tracks.find(track => track.joint === joint)?.keys.find(key => key.time === 0.5)?.rotation,
        groupedPreview.recipe.tracks.find(track => track.joint === joint)?.keys.find(key => key.time === 0.5)?.rotation,
        `${joint} grouped edit should match the reviewed candidate exactly`);
    }
    assert.deepEqual(groupedRebase.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys[0]?.rotation, [0, 12, 0]);
    const targetEditedDraft = structuredClone(editorDraft);
    for (const key of targetEditedDraft.tracks.find(track => track.joint === 'LeftUpperLeg')!.keys) key.rotation = [1, 2, 3];
    await assert.rejects(f.reviews.previewProposalOnEditorDraft({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: result.id,
      draftRecipe: targetEditedDraft, expectedDraftFingerprint: fingerprint(targetEditedDraft), loadedSourceFingerprint: reviewed.assetHash }), /target track changed since review/);
    const secondTargetEditedDraft = structuredClone(editorDraft);
    for (const key of secondTargetEditedDraft.tracks.find(track => track.joint === 'RightUpperLeg')!.keys) key.rotation = [2, 3, 4];
    await assert.rejects(f.reviews.previewProposalOnEditorDraft({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: groupedResult.id,
      draftRecipe: secondTargetEditedDraft, expectedDraftFingerprint: fingerprint(secondTargetEditedDraft), loadedSourceFingerprint: reviewed.assetHash }), /RightUpperLeg target track changed since review/);
    await assert.rejects(f.reviews.previewProposalOnEditorDraft({ reviewId: reviewed.id, revision: reviewed.revision, proposalId: result.id,
      draftRecipe: editorDraft, expectedDraftFingerprint: editorDraftFingerprint, loadedSourceFingerprint: '0'.repeat(64) }), /not loaded from the exact animation reviewed/);
    await assert.rejects(f.reviews.previewProposal({ reviewId: reviewed.id, revision: reviewed.revision - 1, proposalId: result.id }), /changed/);
    assert.deepEqual((await f.library.get(asset.id)).recipe, original.recipe, 'AI proposals must not mutate the saved asset');
    assert.match(prompt, /"recipe":\{"kind":"animation"/);
    const critiqueRequest = JSON.parse(prompt) as { authoringIntent: { sourceRecipeFingerprint: string; timingMatchesCurrentRecipe: boolean;
      timingRelation: string;
      phases: { intent?: string }[]; events: { name: string; progress: number; time: number }[];
      contacts: { effector: string; startProgress: number; endProgress: number; start: number; end: number }[] } };
    assert.equal(critiqueRequest.authoringIntent.sourceRecipeFingerprint, fingerprint(sourceRecipe));
    assert.equal(critiqueRequest.authoringIntent.timingMatchesCurrentRecipe, false);
    assert.equal(critiqueRequest.authoringIntent.timingRelation, 'historical_reference');
    assert.ok(critiqueRequest.authoringIntent.phases.some(phase => phase.intent === 'Land the step with a grounded weight shift.'));
    assert.deepEqual(critiqueRequest.authoringIntent.events, [{ name: 'FootPlant', phaseId: 'step', progress: 0.5, time: 0.75 }]);
    assert.deepEqual(critiqueRequest.authoringIntent.contacts, [{ effector: 'LeftFoot', kind: 'support', phaseId: 'step',
      startProgress: 0.2, endProgress: 0.4, start: 0.6, end: 0.7 }]);
    assert.match(instructions, /machine-actionable proposals/);
    assert.match(instructions, /one atomic offset_pose_group/);
    assert.match(instructions, /phase\/event\/contact timing is current only when timingMatchesCurrentRecipe is true.*when false, treat those coordinates as historical and never reuse them as current recipe timestamps/i);
    assert.equal(reviewed.feedback, undefined);
    const snapshotPath = join(f.root, 'artifacts', 'reviews', reviewed.id, `${String(reviewed.revision).padStart(6, '0')}.json`);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { critique: { proposals: { findingIndex: number }[] } };
    snapshot.critique.proposals[0]!.findingIndex = 7;
    const { integrity: _snapshotIntegrity, snapshotVersion: _snapshotVersion, ...legacySnapshot } = snapshot as typeof snapshot & {
      integrity?: ReviewRecord['integrity']; snapshotVersion?: 1;
    };
    await writeFile(snapshotPath, JSON.stringify(legacySnapshot));
    await assert.rejects(f.reviews.read(reviewed.id), /Persisted proposal must point to an existing critique finding/i);
  } finally { f.close(); }
});

test('AI patch proposals are rejected when evidence or operations do not match the inspected asset', async () => {
  const invalidProposals = [
    { id: 'invented-evidence', findingIndex: 0, title: 'Change pose', rationale: 'Unsupported evidence.', evidence: [{ source: 'pose_samples', id: 'invented-sample' }], risk: 'low', operations: [{ operation: 'set_pose', joint: 'LeftUpperLeg', time: 0.5, rotation: [-30, 0, 0] }] },
    { id: 'unknown-joint', findingIndex: 0, title: 'Change pose', rationale: 'Unsupported track.', evidence: [{ source: 'pose_samples', id: 's000' }], risk: 'low', operations: [{ operation: 'set_pose', joint: 'NotOnRig', time: 0.5, rotation: [0, 0, 0] }] },
    { id: 'unlinked-evidence', findingIndex: 0, title: 'Change pose', rationale: 'Evidence belongs to another finding.', evidence: [{ source: 'pose_samples', id: 's002' }], risk: 'low', operations: [{ operation: 'set_pose', joint: 'LeftUpperLeg', time: 0.5, rotation: [-30, 0, 0] }] },
    { id: 'broad-rewrite', findingIndex: 0, title: 'Retiming the whole clip', rationale: 'Too broad for a local review proposal.', evidence: [{ source: 'pose_samples', id: 's000' }], risk: 'high', operations: [{ operation: 'retime_clip', duration: 2 }] },
  ];
  for (const [index, proposal] of invalidProposals.entries()) {
    const f = await setup(async () => ({ text: JSON.stringify({ ...critique(), proposals: [proposal] }), usage }));
    try {
      const asset = await f.library.save(recipe());
      const inspected = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId })).id);
      const pending = await f.reviews.critique({ reviewId: inspected.id, revision: inspected.revision, provider: 'deepseek' });
      const reviewed = await settled(f.reviews, pending.id);
      assert.equal(reviewed.critique, undefined);
      assert.match(reviewed.error!, index === 1 ? /No animation track for NotOnRig/ : index === 3 ? /one localized pose\/key edit or one atomic multi-joint/i : /evidence must be drawn from its linked finding/);
      assert.deepEqual((await f.library.get(asset.id)).recipe, recipe());
    } finally { f.close(); }
  }
});

test('visual proposal preview returns the exact cited screenshot assessment and capture metadata', async () => {
  const f = await setup(async (_credential, _system, prompt) => {
    const request = JSON.parse(prompt) as { images: { id: string }[] };
    const imageId = request.images[0]?.id;
    assert.ok(imageId);
    const visibleEvidence = 'The left foot appears offset from the planted stance in this frame.';
    const limitation = 'This still cannot establish whether the foot slides during motion.';
    return { text: JSON.stringify({ ...critique(), findings: [{ observation: visibleEvidence, source: 'user_image', evidenceIds: [imageId], suggestion: 'Check the foot path across adjacent frames.' }],
      visualObservations: [{ imageId, assessment: 'observed', visibleEvidence, limitation }],
      proposals: [{ id: 'adjust-leg', findingIndex: 0, title: 'Adjust the leg pose', rationale: 'Address the directly observed stance alignment.',
        evidence: [{ source: 'user_image', id: imageId }], risk: 'medium', operations: [{ operation: 'set_pose', joint: 'LeftUpperLeg', time: 0.5, rotation: [-20, 0, 0] }] }] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    let review = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId })).id);
    review = await f.reviews.attach({ reviewId: review.id, revision: review.revision, view: 'three_quarter', time: 0.5, pngBase64: tinyPng }, {
      assetFingerprint: review.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(), captureSource: 'saved_animation', captureBatchId: randomUUID(),
    });
    review = await settled(f.reviews, (await f.reviews.critique({ reviewId: review.id, revision: review.revision, provider: 'deepseek' })).id);
    const preview = await f.reviews.previewProposal({ reviewId: review.id, revision: review.revision, proposalId: 'adjust-leg' });
    assert.deepEqual(preview.citedImageEvidence, [{ imageId: review.images[0]!.id, sha256: review.images[0]!.sha256, view: 'three_quarter', time: 0.5,
      recipeIdentityStatus: 'matches_reviewed_recipe', eligibleForCritique: true, authoredContext: animationVisualContext(recipe(), 0.5),
      pixelSignal: inspectPngVisualSignal(Buffer.from(tinyPng, 'base64')),
      visualAssessment: 'observed', assessmentStatus: 'assessed', observation: { imageId: review.images[0]!.id, assessment: 'observed',
        visibleEvidence: 'The left foot appears offset from the planted stance in this frame.',
        limitation: 'This still cannot establish whether the foot slides during motion.' } }]);
    const screenshotPath = join(f.root, 'artifacts', 'reviews', review.id, `${review.images[0]!.id}.png`);
    await writeFile(screenshotPath, Buffer.from('tampered screenshot bytes'));
    await assert.rejects(f.reviews.previewProposal({ reviewId: review.id, revision: review.revision, proposalId: 'adjust-leg' }),
      /Attached screenshot changed\. Inspect again and attach the correct image\./,
      'proposal preview must revalidate the exact cited image bytes rather than trust old critique metadata');
    await rm(screenshotPath);
    await assert.rejects(f.reviews.imageData(review.id, review.images[0]!.id),
      /Attached screenshot is missing or unreadable\. Reattach the screenshot before using it as evidence\./,
      'missing evidence must fail with a path-safe diagnostic');
  } finally { f.close(); }
});

test('child reviews link exact user feedback and validate evidence for every prior finding before showing follow-ups', async () => {
  let calls = 0;
  const f = await setup(async (_credential, _system, prompt) => {
    calls++;
    const request = JSON.parse(prompt) as { images: { id: string }[]; comparison?: { parentReviewId: string; priorFindings: { id: string }[]; priorVisualEvidence?: { reviewId: string; reviewRevision: number; images: { imageId: string; sha256: string; view: string; time: number | null; visibleEvidence: string; limitation: string }[] }; motionDelta?: { status: string; positionChangeIntervals?: unknown[] } } };
    const visualObservations = request.images.map(image => ({ imageId: image.id, assessment: 'observed' as const,
      visibleEvidence: 'The parent still shows both arms angled outward.', limitation: 'One still cannot establish the transition or intent.' }));
    if (!request.comparison) return { text: JSON.stringify({ ...critique(), visualObservations }), usage };
    assert.equal(request.comparison.motionDelta?.status, 'available');
    assert.ok(Array.isArray(request.comparison.motionDelta?.positionChangeIntervals));
    assert.ok(request.comparison.priorVisualEvidence, 'child critique should retain historical visual context');
    assert.equal(request.comparison.priorVisualEvidence.reviewId, request.comparison.parentReviewId);
    assert.equal(request.comparison.priorVisualEvidence.images[0]?.view, 'front');
    assert.match(request.comparison.priorVisualEvidence.images[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    const priorFindingId = request.comparison.priorFindings[0]!.id;
    const followUps = [{ previousFindingId: calls === 2 ? 'invented-finding' : priorFindingId, status: 'addressed' as const,
      observation: 'The latest samples show a more pronounced hip drop.', source: 'pose_samples' as const, evidenceIds: ['s001'] }];
    return { text: JSON.stringify({ ...critique(), visualObservations, followUps }), usage };
  });
  try {
    const original = await f.library.save(recipe());
    let first = await settled(f.reviews, (await f.reviews.start({ assetId: original.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    first = await f.reviews.attach({ reviewId: first.id, revision: first.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    first = await settled(f.reviews, (await f.reviews.critique({ reviewId: first.id, revision: first.revision, provider: 'deepseek' })).id);
    assert.equal(first.critique?.visualObservations?.length, 1);
    const requested = await f.reviews.feedback(feedback(first));
    const context = await f.reviews.reserveRevision(requested.id, requested.revision);
    const child = await f.library.save({ ...original.recipe, name: 'Weighted Walk Revision' }, original.id);
    await f.reviews.finishRevision(context, child.id);
    const comparisonSource = await f.reviews.read(first.id);

    const unlinked = await f.library.save(recipe());
    await assert.rejects(f.reviews.start({ assetId: unlinked.id, compareReviewId: first.id, preview: false }), /exact parent review/);
    const second = await settled(f.reviews, (await f.reviews.start({ assetId: child.id, sessionId: f.sessionId, rigId: f.rigId, compareReviewId: first.id, preview: false })).id);
    assert.equal(second.comparison?.findings[0]?.id, 'ai-1');
    assert.equal(second.comparison?.motionDelta?.status, 'available');
    assert.deepEqual(second.comparison?.priorVisualEvidence, { reviewId: first.id, reviewRevision: comparisonSource.revision, images: [{
      imageId: first.images[0]!.id, sha256: first.images[0]!.sha256, view: 'front', time: 0.5,
      recipeIdentityStatus: 'unbound_user_image', assessment: 'observed',
      pixelSignal: inspectPngVisualSignal(Buffer.from(tinyPng, 'base64')),
      visibleEvidence: 'The parent still shows both arms angled outward.', limitation: 'One still cannot establish the transition or intent.',
    }] });
    const invalid = await f.reviews.critique({ reviewId: second.id, revision: second.revision, provider: 'deepseek' });
    const rejected = await settled(f.reviews, invalid.id);
    assert.equal(rejected.critique, undefined);
    assert.match(rejected.error!, /cover every prior finding exactly once/);
    const retry = await f.reviews.critique({ reviewId: rejected.id, revision: rejected.revision, provider: 'deepseek' });
    const verified = await settled(f.reviews, retry.id);
    assert.equal(verified.critique?.followUps?.[0]?.previousFindingId, 'ai-1');
    assert.equal(verified.critique?.followUps?.[0]?.status, 'addressed');
    assert.equal(verified.critique?.followUps?.[0]?.evidenceInterpretation, 'measured_change_only');
    assert.equal(verified.status, 'needs_feedback');
    assert.equal(verified.feedback, undefined);
  } finally { f.close(); }
});

test('matched revision image pairs are checksum-verified and require exact same-rig capture provenance', async () => {
  const providerBatches: { prompt: string; images: { base64: string; mimeType: string }[] }[] = [];
  const f = await setup(async (_credential, _system, prompt, _maxTokens, _signal, images = []) => {
    providerBatches.push({ prompt, images });
    const request = JSON.parse(prompt) as { images: { id: string }[]; comparison?: { priorFindings: { id: string }[] } };
    const response = { ...critique(), visualObservations: request.images.map(image => ({ imageId: image.id,
      assessment: 'observed' as const, visibleEvidence: 'The full-body pose is readable.', limitation: 'This still cannot establish motion between frames.' })) };
    if (request.comparison) Object.assign(response, { followUps: request.comparison.priorFindings.map(finding => ({
      previousFindingId: finding.id, status: 'addressed' as const, observation: 'Current pose samples show the measured change.',
      source: 'pose_samples' as const, evidenceIds: ['s001'], evidenceInterpretation: 'measured_change_only' as const,
    })) });
    return { text: JSON.stringify(response), usage };
  });
  try {
    const original = await f.library.save(recipe());
    let parent = await settled(f.reviews, (await f.reviews.start({ assetId: original.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    parent = await f.reviews.attach({ reviewId: parent.id, revision: parent.revision, view: 'front', time: 0.49, pngBase64: tinyPng }, {
      assetFingerprint: parent.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(),
      captureBatchId: randomUUID(), captureSource: 'saved_animation',
    });
    parent = await f.reviews.attach({ reviewId: parent.id, revision: parent.revision, view: 'front', time: 0.5, pngBase64: capturePngs[0]! }, {
      assetFingerprint: parent.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(),
      captureBatchId: randomUUID(), captureSource: 'saved_animation',
    });
    parent = await settled(f.reviews, (await f.reviews.critique({ reviewId: parent.id, revision: parent.revision, provider: 'deepseek' })).id);
    const requested = await f.reviews.feedback(feedback(parent));
    const context = await f.reviews.reserveRevision(requested.id, requested.revision);
    const childAsset = await f.library.save({ ...original.recipe, name: 'Matched Revision' }, original.id);
    await f.reviews.finishRevision(context, childAsset.id);
    let child = await settled(f.reviews, (await f.reviews.start({ assetId: childAsset.id, sessionId: f.sessionId, rigId: f.rigId,
      compareReviewId: parent.id, preview: false })).id);
    child = await f.reviews.attach({ reviewId: child.id, revision: child.revision, view: 'front', time: 0.5, pngBase64: capturePngs[1]! }, {
      assetFingerprint: child.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(),
      captureBatchId: randomUUID(), captureSource: 'candidate',
    });
    child = await f.reviews.attach({ reviewId: child.id, revision: child.revision, view: 'front', time: 0.515, pngBase64: capturePngs[2]! }, {
      assetFingerprint: child.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(),
      captureBatchId: randomUUID(), captureSource: 'candidate',
    });
    const compared = await f.reviews.comparisonImagePairs({ reviewId: child.id, revision: child.revision });
    assert.equal(compared.status, 'complete');
    if (compared.status !== 'complete') return;
    assert.equal(compared.imageCount, 4);
    assert.equal(compared.pairs.length, 2, 'assignment maximizes valid pairs even when the closest match alone would consume a needed child frame');
    assert.equal(compared.pairs[0]?.view, 'front');
    assert.ok(Math.abs((compared.pairs[0]?.normalizedProgressDelta ?? 1) - 0.01) < 1e-12);
    assert.ok(Math.abs((compared.pairs[1]?.normalizedProgressDelta ?? 1) - 0.015) < 1e-12);
    assert.equal(compared.imageBlocks[0]?.role, 'parent');
    assert.equal(compared.imageBlocks[1]?.role, 'child');
    assert.equal(compared.imageBlocks[0]?.data, tinyPng);
    assert.equal(compared.imageBlocks[1]?.data, capturePngs[1]);
    assert.equal(compared.imageBlocks[2]?.data, capturePngs[0]);
    assert.equal(compared.imageBlocks[3]?.data, capturePngs[2]);
    assert.ok(compared.images.every(image => image.checksumVerified && image.rigSignature === f.rigSignature));

    const server = createMcp(f.library, f.queue, new Blender(f.root, 'blender'), f.reviews);
    const client = new Client({ name: 'review-comparison-image-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const mcpResult = await client.callTool({ name: 'motion_review_read_comparison_images', arguments: { reviewId: child.id, revision: child.revision } });
      assert.ok(!mcpResult.isError, JSON.stringify(mcpResult));
      const mcpImages = (mcpResult.content as { type: string; data?: string; text?: string }[]).filter(block => block.type === 'image');
      assert.deepEqual(mcpImages.map(block => block.data), [tinyPng, capturePngs[1], capturePngs[0], capturePngs[2]]);
      const mcpSummary = (mcpResult.structuredContent as { result: { status: string; imageCount: number; pairs: { parentImageId: string; childImageId: string }[] } }).result;
      assert.equal(mcpSummary.status, 'complete');
      assert.equal(mcpSummary.imageCount, 4);
      assert.equal(mcpSummary.pairs.length, 2);
    } finally { await client.close(); await server.close(); }

    const childCritique = await f.reviews.critique({ reviewId: child.id, revision: child.revision, provider: 'deepseek', includeMatchedParentImages: true });
    child = await settled(f.reviews, childCritique.id);
    assert.equal(child.critique?.comparisonVisualEvidence?.status, 'included');
    const audit = child.critique?.comparisonVisualEvidence;
    assert.ok(audit);
    assert.deepEqual(audit.providerImageOrder.map(image => image.role), ['child_current', 'child_current', 'parent_historical', 'parent_historical']);
    assert.equal(audit.pairs.length, 2);
    assert.equal(audit.includedParentImageIds.length, 2);
    const childBatch = providerBatches.at(-1);
    assert.ok(childBatch);
    assert.deepEqual(childBatch.images.map(image => image.base64), [capturePngs[1], capturePngs[2], tinyPng, capturePngs[0]]);
    const childPrompt = JSON.parse(childBatch.prompt) as { images: { id: string }[]; comparison: { comparisonVisualEvidence: { providerImageOrder: { role: string; imageId: string }[] } } };
    assert.deepEqual(childPrompt.comparison.comparisonVisualEvidence.providerImageOrder.map(image => image.role), audit.providerImageOrder.map(image => image.role));
    assert.deepEqual(child.critique?.visualObservations?.map(observation => observation.imageId), childPrompt.images.map(image => image.id),
      'historical parent screenshots must never appear as current visual observations');
    const persisted = JSON.parse(await readFile(join(f.root, 'artifacts', 'reviews', child.id, `${String(child.revision).padStart(6, '0')}.json`), 'utf8')) as ReviewRecord;
    assert.deepEqual(persisted.critique?.comparisonVisualEvidence, audit, 'the image-order/provenance audit survives persistence');
  } finally { f.close(); }
});

test('an inconclusive child screenshot cannot resolve a prior measured finding', async () => {
  let calls = 0;
  const f = await setup(async (_credential, _system, prompt) => {
    calls++;
    const request = JSON.parse(prompt) as { images: { id: string }[]; comparison?: { priorFindings: { id: string }[] } };
    const visualObservations = request.images.map(image => ({ imageId: image.id, assessment: request.comparison ? 'inconclusive' as const : 'observed' as const,
      visibleEvidence: 'A frame of the pose.', limitation: 'The image is not bound to the child recipe.' }));
    const base = { ...critique(), visualObservations };
    if (!request.comparison) return { text: JSON.stringify(base), usage };
    const followUp = { previousFindingId: request.comparison.priorFindings[0]!.id, status: 'addressed' as const,
      observation: 'The pose appears resolved in the unbound frame.', source: 'user_image' as const, evidenceIds: [request.images[0]!.id] };
    return { text: JSON.stringify({ ...base, followUps: [followUp] }), usage };
  });
  try {
    const original = await f.library.save(recipe());
    let parent = await settled(f.reviews, (await f.reviews.start({ assetId: original.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    parent = await f.reviews.critique({ reviewId: parent.id, revision: parent.revision, provider: 'deepseek' }).then(result => settled(f.reviews, result.id));
    const requested = await f.reviews.feedback(feedback(parent));
    const context = await f.reviews.reserveRevision(requested.id, requested.revision);
    const childAsset = await f.library.save({ ...original.recipe, name: 'Measured Finding Child' }, original.id);
    await f.reviews.finishRevision(context, childAsset.id);
    let child = await settled(f.reviews, (await f.reviews.start({ assetId: childAsset.id, sessionId: f.sessionId, rigId: f.rigId,
      compareReviewId: parent.id, preview: false })).id);
    child = await f.reviews.attach({ reviewId: child.id, revision: child.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    const pending = await f.reviews.critique({ reviewId: child.id, revision: child.revision, provider: 'deepseek' });
    child = await settled(f.reviews, pending.id);
    assert.equal(calls, 2);
    assert.equal(child.critique, undefined);
    assert.match(child.error ?? '', /inconclusive screenshot cannot resolve a visual follow-up/i);
  } finally { f.close(); }
});

test('a child review cannot mark a reference-target finding addressed using an unbound image alone', async () => {
  let calls = 0;
  const f = await setup(async (_credential, _system, prompt) => {
    calls++;
    const request = JSON.parse(prompt) as { images: { id: string }[]; comparison?: { priorFindings: { id: string; interpretation?: string }[];
      priorVisualEvidence?: { images: { recipeIdentityStatus?: string }[] } } };
    const imageId = request.images[0]?.id;
    assert.ok(imageId);
    const visibleEvidence = request.comparison ? 'The child reference still shows the requested arm angle.' : 'The target reference shows the desired arm angle.';
    const limitation = 'This unbound image is not evidence of the reviewed animation pose.';
    const base = { ...critique(), visualObservations: [{ imageId, assessment: 'observed', visibleEvidence, limitation }] };
    if (!request.comparison) return { text: JSON.stringify({ ...base, findings: [{ observation: visibleEvidence, source: 'user_image', evidenceIds: [imageId],
      suggestion: 'Use this image only as the target pose.', interpretation: 'reference_target' }] }), usage };
    assert.equal(request.comparison.priorFindings[0]?.interpretation, 'reference_target');
    assert.equal(request.comparison.priorVisualEvidence?.images[0]?.recipeIdentityStatus, 'unbound_user_image');
    return { text: JSON.stringify({ ...base, followUps: [{ previousFindingId: request.comparison.priorFindings[0]!.id,
      status: calls === 2 ? 'addressed' : 'uncertain', observation: 'The unbound child image is the only cited evidence.',
      source: 'user_image', evidenceIds: [imageId] }] }), usage };
  });
  try {
    const original = await f.library.save(recipe());
    let parent = await settled(f.reviews, (await f.reviews.start({ assetId: original.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    parent = await f.reviews.attach({ reviewId: parent.id, revision: parent.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    parent = await settled(f.reviews, (await f.reviews.critique({ reviewId: parent.id, revision: parent.revision, provider: 'deepseek' })).id);
    assert.equal(parent.critique?.findings[0]?.interpretation, 'reference_target');
    const requested = await f.reviews.feedback(feedback(parent));
    const context = await f.reviews.reserveRevision(requested.id, requested.revision);
    const childAsset = await f.library.save({ ...original.recipe, name: 'Reference Target Child' }, original.id);
    await f.reviews.finishRevision(context, childAsset.id);
    let child = await settled(f.reviews, (await f.reviews.start({ assetId: childAsset.id, sessionId: f.sessionId, rigId: f.rigId,
      compareReviewId: parent.id, preview: false })).id);
    assert.equal(child.comparison?.findings[0]?.interpretation, 'reference_target');
    child = await f.reviews.attach({ reviewId: child.id, revision: child.revision, view: 'front', time: 0.5, pngBase64: capturePngs[0]! });
    let pending = await f.reviews.critique({ reviewId: child.id, revision: child.revision, provider: 'deepseek' });
    child = await settled(f.reviews, pending.id);
    assert.equal(child.critique, undefined);
    assert.match(child.error ?? '', /requires a fresh screenshot bound to the exact child recipe/i);

    pending = await f.reviews.critique({ reviewId: child.id, revision: child.revision, provider: 'deepseek' });
    child = await settled(f.reviews, pending.id);
    assert.equal(child.error, undefined);
    assert.equal(child.critique?.followUps?.[0]?.status, 'uncertain');
  } finally { f.close(); }
});

test('Studio capture attachment verifies exact recipe and rig topology before reassembling local PNG chunks', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save(recipe());
    const review = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId })).id);
    const bytes = Buffer.from(capturePngs[0]!, 'base64');
    const capture = { captureId: randomUUID(), assetId: asset.id, assetFingerprint: fingerprint(asset.recipe), rigId: f.rigId, rigSignature: 'fixture-authoring-rig-v1', time: 0.5, view: 'overhead' as const,
      byteCount: bytes.length, chunks: 1, width: 1, height: 1,
      jointMapping: { fingerprint: 'a'.repeat(64), renamedJointCount: 2, nameMapApplied: true,
        limitation: 'Name mapping only; axes and IK are not retargeted.' } };
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture: { ...capture, assetId: randomUUID() } }), /different animation asset/);
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture: { ...capture, assetFingerprint: '0'.repeat(64) } }), /different animation revision/);
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture: { ...capture, rigSignature: 'different-topology' } }), /rig topology/);
    const attached = await f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture });
    assert.equal(attached.images[0]?.view, 'overhead');
    assert.deepEqual(attached.images[0]?.captureBinding?.jointMapping, capture.jointMapping,
      'review persistence must retain mapped-preview limitations after the temporary capture expires');
    assert.equal((await f.reviews.imageData(review.id, attached.images[0]!.id)).base64, capturePngs[0]);
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: attached.revision, sessionId: f.sessionId,
      capture: { ...capture, captureId: randomUUID(), width: 960, height: 540 } }), /PNG dimensions 1x1 do not match capture metadata 960x540/i);
    const retried = await f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture });
    assert.equal(retried.revision, attached.revision, 'a lost-response retry returns the already attached review revision');
    assert.equal(retried.images.length, 1, 'retrying a captureId never duplicates the image');
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId, capture: { ...capture, view: 'front' } }), /already attached with different review metadata/);
    await assert.rejects(f.reviews.attachCapture({ reviewId: review.id, revision: review.revision, sessionId: f.sessionId,
      capture: { ...capture, jointMapping: { ...capture.jointMapping, fingerprint: 'b'.repeat(64) } } }), /already attached with different review metadata/);
  } finally { f.close(); }
});

test('batch capture attachment reports partial progress and resumes idempotently at the latest review revision', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save(recipe());
    const plannedCaptureFrames = [{ view: 'front' as const, time: 0.5 }, { view: 'side' as const, time: 0.5 }];
    const started = await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false, plannedCaptureFrames });
    const record = await settled(f.reviews, started.id);
    const createCapture = (view: 'front' | 'side', rigSignature = 'fixture-authoring-rig-v1') => ({ captureId: randomUUID(), assetId: asset.id,
      assetFingerprint: fingerprint(asset.recipe), rigId: f.rigId, rigSignature, time: 0.5, view, byteCount: Buffer.from(capturePngs[0]!, 'base64').length, chunks: 1, width: 1, height: 1 });
    const front = createCapture('front'), badSide = createCapture('side', 'stale-topology');
    const partial = await f.reviews.attachCaptureBatch({ reviewId: record.id, revision: record.revision, sessionId: f.sessionId, captures: [front, badSide] });
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.attachedCaptureIds, [front.captureId]);
    assert.equal(partial.failedCaptureId, badSide.captureId);
    assert.equal(partial.visualCaptureCoverage.status, 'partial');
    const side = { ...badSide, rigSignature: 'fixture-authoring-rig-v1' };
    const completed = await f.reviews.attachCaptureBatch({ reviewId: record.id, revision: partial.reviewRevision, sessionId: f.sessionId, captures: [side] });
    assert.equal(completed.status, 'complete');
    assert.equal(completed.visualCaptureCoverage.status, 'complete');
    assert.match(completed.next, /motion_review_read_images.*inspect every returned PNG.*motion_review_critique/i,
      'a completed capture batch must direct the agent to inspect images before critique');
    assert.match(completed.next, new RegExp(`revision=${completed.reviewRevision}`),
      'the critique handoff must use the latest revision after all captures are attached');
    const imageIdsMatch = completed.next.match(/imageIds=(\[[^\]]*\])/);
    assert.ok(imageIdsMatch, 'the next action must expose exact image IDs for retrieval');
    assert.deepEqual(JSON.parse(imageIdsMatch[1]!),
      completed.visualCaptureCoverage.frames.flatMap(frame => frame.evidenceId ? [frame.evidenceId] : []));
    const replayed = await f.reviews.attachCaptureBatch({ reviewId: record.id, revision: record.revision, sessionId: f.sessionId, captures: [front, side] });
    assert.equal(replayed.status, 'complete');
    assert.equal(replayed.reviewRevision, completed.reviewRevision);
    assert.equal((await f.reviews.read(record.id)).images.length, 2);
  } finally { f.close(); }
});

test('planned visual review tracks required views and blocks AI critique until coverage is complete', async () => {
  let calls = 0;
  let sentPrompt = '', sentSystem = '', sentImagePayloads: string[] = [];
  const f = await setup(async (_credential, system, prompt, _limit, _signal, images) => {
    calls++; sentSystem = system; sentPrompt = prompt; sentImagePayloads = images?.map(image => image.base64) ?? [];
    const input = JSON.parse(prompt) as { images: { id: string }[] };
    return { text: JSON.stringify({ summary: 'Images attached for every planned view and time.', findings: [],
      visualObservations: input.images.map(image => ({ imageId: image.id, assessment: 'observed' as const, visibleEvidence: 'The still shows the requested rig pose.', limitation: 'One still cannot establish motion between frames.' })), questions: [] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    const plannedCaptureFrames = [{ view: 'front' as const, time: 0.5 }, { view: 'side' as const, time: 0.5, focusJoint: 'RightHand' }];
    const started = await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false,
      aiReview: true, provider: 'deepseek', plannedCaptureFrames });
    const record = await settled(f.reviews, started.id);
    assert.equal(record.status, 'needs_feedback', 'automatic critique waits because the planned images are not attached yet');
    assert.equal(calls, 0);
    assert.equal(f.reviews.captureCoverage(record).status, 'awaiting_evidence');

    const firstBytes = Buffer.from(tinyPng, 'base64');
    const manual = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'front', time: 0.5, pngBase64: firstBytes.toString('base64') });
    assert.equal(f.reviews.captureCoverage(manual).status, 'awaiting_evidence', 'manual images are not fingerprint-bound capture evidence');
    const captureMeta = (view: 'front' | 'side', focusJoint?: string) => ({ captureId: randomUUID(), assetId: asset.id, assetFingerprint: fingerprint(asset.recipe),
      rigId: f.rigId, rigSignature: 'fixture-authoring-rig-v1', time: 0.5, view, ...(focusJoint ? { focusJoint } : {}),
      byteCount: Buffer.from(capturePngs[0]!, 'base64').length, chunks: 1, width: 1, height: 1,
      ...(view === 'front' ? { jointMapping: { fingerprint: 'c'.repeat(64), renamedJointCount: 1, nameMapApplied: true,
        limitation: 'Name mapping only; does not retarget axes.' } } : {}) });
    const first = await f.reviews.attachCapture({ reviewId: record.id, revision: manual.revision, sessionId: f.sessionId, capture: captureMeta('front') });
    const partial = await f.reviews.read(record.id);
    assert.equal(f.reviews.captureCoverage(partial).status, 'partial');
    await assert.rejects(f.reviews.critique({ reviewId: record.id, revision: partial.revision, provider: 'deepseek' }), /every planned view\/time\/focus target/i);
    assert.equal(calls, 0, 'incomplete visual evidence must not reach the provider');

    const wrongFocus = await f.reviews.attachCapture({ reviewId: record.id, revision: first.revision, sessionId: f.sessionId,
      capture: captureMeta('side', 'LeftHand') });
    assert.equal(f.reviews.captureCoverage(wrongFocus).status, 'partial', 'a close-up of another joint cannot satisfy the requested focus');
    await assert.rejects(f.reviews.critique({ reviewId: record.id, revision: wrongFocus.revision, provider: 'deepseek' }),
      /view\/time\/focus target.*side@0\.5s focused on RightHand/i);
    assert.match(wrongFocus.request.plannedCaptureFrames ? f.reviews.captureCoverage(wrongFocus).missingFrames.map(frame => `${frame.view}@${frame.time}s${frame.focusJoint ? ` focused on ${frame.focusJoint}` : ''}`).join(', ') : '',
      /side@0\.5s focused on RightHand/);

    const second = await f.reviews.attachCapture({ reviewId: record.id, revision: wrongFocus.revision, sessionId: f.sessionId, capture: captureMeta('side', 'RightHand') });
    assert.equal(f.reviews.captureCoverage(second).status, 'complete');
    const pending = await f.reviews.critique({ reviewId: record.id, revision: second.revision, provider: 'deepseek' });
    const completed = await settled(f.reviews, pending.id);
    assert.equal(completed.critique?.summary, 'Images attached for every planned view and time.');
    assert.deepEqual(completed.critique?.visualObservations?.map(observation => observation.imageId).sort(),
      f.reviews.captureCoverage(completed).frames.flatMap(frame => frame.evidenceId ? [frame.evidenceId] : []).sort());
    const evidenceAudit = f.reviews.visualEvidenceAudit(completed);
    assert.equal(evidenceAudit.status, 'assessed');
    assert.deepEqual(evidenceAudit.assessedImageIds.sort(), f.reviews.captureCoverage(completed).frames.flatMap(frame => frame.evidenceId ? [frame.evidenceId] : []).sort());
    assert.deepEqual(evidenceAudit.unassessedImageIds.sort(), [manual.images[0]!.id, wrongFocus.images.at(-1)!.id].sort());
    assert.deepEqual(evidenceAudit.captureCoverage.missingFrames, []);
    assert.ok(evidenceAudit.limitations.some(limitation => /do not establish motion/i.test(limitation)));
    assert.equal(calls, 1);
    assert.match(sentSystem, /Name-mapped joint provenance is approximate pose evidence only/);
    assert.match(sentPrompt, /nameMapApplied/);
    assert.match(sentPrompt, /"renamedJointCount":1/);
    assert.equal(sentImagePayloads.length, 2, 'only planned captures bound to this recipe and rig are sent for critique');
    assert.ok(!sentImagePayloads.includes(tinyPng), 'unbound manual screenshots are excluded from planned visual critique');
    assert.ok(sentPrompt.includes(manual.images[0]!.id), 'the report transparently labels the unplanned manual evidence as unused');
  } finally { f.close(); }
});

test('image critique requires one concise visual observation for each supplied screenshot', async () => {
  let responseMode: 'duplicate' | 'missing' | 'complete' = 'duplicate';
  let promptImageIds: string[] = [];
  let promptImages: { id: string; recipeIdentityStatus: string; authoredContext?: { normalizedProgress: number; nearbyMarkers: { name: string; phase?: string }[];
    activeDeclaredContacts: { effector: string; kind: string }[] } }[] = [];
  let critiqueSystemPrompt = '';
  let critiquePrompt = '';
  const f = await setup(async (_credential, system, prompt) => {
    critiqueSystemPrompt = system;
    critiquePrompt = prompt;
    const input = JSON.parse(prompt) as { images: typeof promptImages };
    promptImages = input.images;
    promptImageIds = input.images.map(image => image.id);
    const all = promptImageIds.map(imageId => ({ imageId, assessment: 'observed' as const,
      visibleEvidence: 'A block rig is visible in the frame.', limitation: 'A still cannot establish motion.' }));
    const visualObservations = responseMode === 'duplicate' ? [all[0]!, all[0]!]
      : responseMode === 'missing' ? all.slice(0, 1) : all;
    return { text: JSON.stringify({ ...critique(), findings: [], visualObservations }), usage };
  });
  try {
    const sourceRecipe = { ...recipe(), markers: [{ name: 'Impact', time: 0.5, phase: 'event' as const }],
      contacts: [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.25, end: 0.75 }] };
    const asset = await f.library.save(sourceRecipe);
    const record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId })).id);
    let current = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'front', time: 0, pngBase64: tinyPng });
    current = await f.reviews.attach({ reviewId: current.id, revision: current.revision, view: 'side', time: 0.5, pngBase64: capturePngs[0]! }, {
      assetFingerprint: record.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(), captureSource: 'saved_animation', captureBatchId: randomUUID(),
    });
    current = await f.reviews.attach({ reviewId: current.id, revision: current.revision, view: 'back', time: 0.5, pngBase64: capturePngs[1]! }, {
      assetFingerprint: record.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureSource: 'saved_animation', captureBatchId: randomUUID(),
    });

    let pending = await f.reviews.critique({ reviewId: current.id, revision: current.revision, provider: 'deepseek' });
    let completed = await settled(f.reviews, pending.id);
    assert.match(completed.error ?? '', /repeated a screenshot in visualObservations/i);
    assert.equal(completed.critique, undefined);
    assert.equal(promptImageIds.length, 3);

    responseMode = 'missing';
    pending = await f.reviews.critique({ reviewId: completed.id, revision: completed.revision, provider: 'deepseek' });
    completed = await settled(f.reviews, pending.id);
    assert.match(completed.error ?? '', /visualObservations must cover every screenshot supplied.*exactly once/i);

    responseMode = 'complete';
    pending = await f.reviews.critique({ reviewId: completed.id, revision: completed.revision, provider: 'deepseek' });
    completed = await settled(f.reviews, pending.id);
    assert.equal(completed.error, undefined);
    assert.match(critiqueSystemPrompt, /A single still cannot establish motion, timing, smoothness, transitions, or contact.*timestamped images in one exact-recipe, server-verified, same-rig\/view\/focus visualStoryboard sequence.*sparse stills, not continuous motion/i);
    assert.match(critiquePrompt, /visualStoryboard/);
    assert.equal(promptImages[0]?.authoredContext, undefined, 'unbound manual references must not inherit source animation timing/contacts');
    assert.equal(promptImages[1]?.authoredContext?.normalizedProgress, 0.5);
    assert.deepEqual(promptImages[1]?.authoredContext?.nearbyMarkers.map(marker => [marker.name, marker.phase]), [['Impact', 'event']]);
    assert.deepEqual(promptImages[1]?.authoredContext?.activeDeclaredContacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 0.75 }]);
    assert.equal(promptImages[2]?.recipeIdentityStatus, 'matches_reviewed_recipe');
    assert.equal(promptImages[2]?.authoredContext, undefined, 'a matching recipe hash without native capture identity must not borrow authored timing context');
    assert.match(critiqueSystemPrompt, /authoredContext.*timestamped author metadata.*never as proof that an event or contact is visible/i);
    assert.deepEqual(completed.critique?.visualObservations?.map(observation => observation.imageId).sort(), [...promptImageIds].sort());
    assert.ok(completed.critique?.visualObservations?.every(observation => observation.assessment === 'observed'
      && observation.visibleEvidence.length > 0 && observation.limitation.length > 0));
    const reviewDirectory = join(f.root, 'artifacts/reviews', completed.id);
    const latestSnapshot = (await readdir(reviewDirectory)).filter(name => /^\d{6}\.json$/.test(name)).sort().at(-1)!;
    const snapshotPath = join(reviewDirectory, latestSnapshot);
    const persisted = JSON.parse(await readFile(snapshotPath, 'utf8')) as { critique: { visualObservations: { imageId: string }[] } };
    persisted.critique.visualObservations[0]!.imageId = randomUUID();
    const { integrity: _persistedIntegrity, snapshotVersion: _persistedVersion, ...legacyPersisted } = persisted as typeof persisted & {
      integrity?: ReviewRecord['integrity']; snapshotVersion?: 1;
    };
    await writeFile(snapshotPath, JSON.stringify(legacyPersisted));
    await assert.rejects(f.reviews.read(completed.id), /Persisted visual observations must identify every critique-eligible screenshot exactly once/i);
  } finally { f.close(); }
});

test('targeted animation revisions receive verified source screenshots and fallible visual notes without overriding user intent', async () => {
  let authoringPrompt = '';
  let authoringRequest = '';
  let authoringImages: { base64: string; mimeType: 'image/png' }[] = [];
  const authoringImageBatches: { base64: string; mimeType: 'image/png' }[][] = [];
  let authoringCalls = 0;
  const f = await setup(async (_credential, system, prompt, _maxTokens, _signal, images = []) => {
    if (system.startsWith('Review a Motion')) {
      const input = JSON.parse(prompt) as { images: { id: string }[] };
      return { text: JSON.stringify({ ...critique(), findings: [], visualObservations: input.images.map(image => ({ imageId: image.id, assessment: 'observed' as const,
        visibleEvidence: 'The arms appear near the torso in this still.', limitation: 'The still does not establish motion or whether the pose is intended.' })), questions: [] }), usage };
    }
    authoringRequest = prompt;
    authoringPrompt = prompt.split('\nThe previous targeted patch failed validation:')[0] ?? prompt;
    authoringImages = images;
    authoringImageBatches.push(images);
    authoringCalls++;
    if (authoringCalls === 1) return { text: 'malformed first response', usage };
    return { text: JSON.stringify({ approach: 'Clarify the requested upper-arm silhouette at contact while preserving the rest of the walk.',
      checkpoints: ['Verify the arm changes only at contact'], avoid: [],
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-35, 0, 0] }] }), usage };
  });
  try {
    const sourceRecipe = { ...recipe(), markers: [{ name: 'Impact', time: 0.5, phase: 'event' as const }],
      contacts: [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.25, end: 0.75 }] };
    const asset = await f.library.save(sourceRecipe);
    const record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, preview: false })).id);
    const attached = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'front', time: 0.5, pngBase64: tinyPng }, {
      assetFingerprint: record.assetHash, rigId: f.rigId, rigSignature: f.rigSignature, captureId: randomUUID(), captureSource: 'saved_animation', captureBatchId: randomUUID(),
    });
    const pendingCritique = await f.reviews.critique({ reviewId: attached.id, revision: attached.revision, provider: 'deepseek' });
    const reviewed = await settled(f.reviews, pendingCritique.id);
    assert.equal(reviewed.critique?.visualObservations?.length, 1);
    const requestedFeedback = feedback(reviewed);
    const feedbackSaved = await f.reviews.feedback({ ...requestedFeedback, feedback: { ...requestedFeedback.feedback,
      changes: 'Clarify the LeftUpperArm silhouette at contact by rotating it forward.' } });
    const context = await f.reviews.reserveRevision(feedbackSaved.id, feedbackSaved.revision);
    assert.deepEqual(context.visualObservations, reviewed.critique?.visualObservations);
    assert.equal(context.sourceReviewRevision, feedbackSaved.revision);
    assert.deepEqual(context.visualEvidence, { reviewId: reviewed.id, reviewRevision: feedbackSaved.revision, provider: 'deepseek', model: 'deepseek-v4-flash', images: [{
      imageId: reviewed.images[0]!.id, sha256: reviewed.images[0]!.sha256, view: 'front', time: 0.5,
      authoredContext: animationVisualContext(sourceRecipe, 0.5),
      pixelSignal: inspectPngVisualSignal(Buffer.from(tinyPng, 'base64')),
      assessment: 'observed',
      visibleEvidence: 'The arms appear near the torso in this still.', limitation: 'The still does not establish motion or whether the pose is intended.',
    }] });

    const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: context.changes, parentId: asset.id, inspectAfter: false, repair: true }, context);
    const finished = await draftDone(f.authoring, job.id);
    assert.equal(finished.status, 'succeeded', finished.error);
    const promptPayload = JSON.parse(authoringPrompt) as { userFeedback: { changes: string }; visualEvidenceSource: { reviewId: string; reviewRevision: number;
      critiqueProvider: string; critiqueModel: string }; visualEvidenceImageHandoff: { status: string; imageCount: number; limitation: string };
      visualEvidenceNotes: { imageId: string; sha256: string; view: string; time: number | null; authoredContext?: { normalizedProgress: number;
        activeDeclaredContacts: { effector: string; kind: string }[] }; assessment?: string; visibleEvidence: string; limitation: string }[]; revisionRules: string };
    assert.equal(promptPayload.userFeedback.changes, context.changes);
    assert.deepEqual(promptPayload.visualEvidenceSource, { reviewId: context.reviewId, reviewRevision: context.sourceReviewRevision,
      critiqueProvider: 'deepseek', critiqueModel: 'deepseek-v4-flash' });
    assert.deepEqual(promptPayload.visualEvidenceImageHandoff, { status: 'included', imageCount: 1,
      limitation: 'These are the exact hash-verified review screenshots, sent only to the same provider and model that performed the critique.' });
    assert.equal(promptPayload.visualEvidenceNotes[0]?.assessment, 'observed');
    assert.equal(promptPayload.visualEvidenceNotes[0]?.authoredContext?.normalizedProgress, 0.5);
    assert.deepEqual(promptPayload.visualEvidenceNotes[0]?.authoredContext?.activeDeclaredContacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 0.75 }]);
    assert.deepEqual(authoringImages, [{ base64: tinyPng, mimeType: 'image/png' }],
      'the same provider/model should receive the exact image bytes it critiqued, not just its fallible text description');
    assert.equal(authoringCalls, 2, 'the malformed first response should use exactly one bounded repair request');
    assert.deepEqual(authoringImageBatches, [authoringImages, authoringImages],
      'the repair request must receive the same complete verified image set, not silently become notes-only');
    assert.match(authoringRequest, /previous targeted patch failed validation/i, 'the second request should include the bounded repair context');
    assert.deepEqual(promptPayload.visualEvidenceNotes, context.visualEvidence?.images);
    assert.match(promptPayload.revisionRules, /user’s requested change is authoritative/i);
    assert.match(promptPayload.revisionRules, /inspect the supplied original screenshots directly/i);
    assert.match(promptPayload.revisionRules, /assessment=inconclusive is unresolved/i);
    assert.match(promptPayload.revisionRules, /authoredContext.*recipe-bound timing\/intent metadata, not proof/i);
    assert.equal((await f.library.get(asset.id)).recipe.name, recipe().name, 'the visual notes must not mutate the reviewed source');
    const generationProvenance = JSON.parse(await readFile(join(f.root, 'artifacts/generations', `${finished.assetId}.json`), 'utf8')) as {
      feedbackReviewId: string; feedbackReviewRevision: number; visualEvidence: typeof context.visualEvidence;
      visualEvidenceImageHandoff: { status: string; imageCount: number } };
    assert.equal(generationProvenance.feedbackReviewId, reviewed.id);
    assert.equal(generationProvenance.feedbackReviewRevision, feedbackSaved.revision);
    assert.deepEqual(generationProvenance.visualEvidence, context.visualEvidence);
    assert.deepEqual(generationProvenance.visualEvidenceImageHandoff, { status: 'included', imageCount: 1 });
  } finally { f.close(); }
});

test('visual animation revision never forwards reviewed screenshots to a different model', async () => {
  let authoringPrompt = '';
  let authoringImages: { base64: string; mimeType: 'image/png' }[] = [];
  const f = await setup(async (_credential, system, prompt, _maxTokens, _signal, images = []) => {
    if (system.startsWith('Review a Motion')) {
      const request = JSON.parse(prompt) as { images: { id: string }[] };
      return { text: JSON.stringify({ ...critique(), findings: [], visualObservations: request.images.map(image => ({ imageId: image.id, assessment: 'observed' as const,
        visibleEvidence: 'A still shows the requested pose.', limitation: 'One still does not show the transition.' })), questions: [] }), usage };
    }
    authoringPrompt = prompt;
    authoringImages = images;
    return { text: JSON.stringify({ approach: 'Preserve the walk while changing the upper-arm silhouette.',
      checkpoints: ['Check the arm pose at contact'], avoid: [],
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-35, 0, 0] }] }), usage };
  });
  try {
    const asset = await f.library.save(recipe());
    const record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, preview: false })).id);
    const attached = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'front', time: 0.5, pngBase64: tinyPng });
    const pendingCritique = await f.reviews.critique({ reviewId: record.id, revision: attached.revision, provider: 'deepseek' });
    const reviewed = await settled(f.reviews, pendingCritique.id);
    const requestedFeedback = feedback(reviewed);
    const feedbackSaved = await f.reviews.feedback({ ...requestedFeedback, feedback: { ...requestedFeedback.feedback,
      changes: 'Adjust the left upper-arm silhouette at contact.' } });
    const context = await f.reviews.reserveRevision(feedbackSaved.id, feedbackSaved.revision);
    await f.connections.save({ provider: 'deepseek', model: 'different-vision-model', apiKey: 'not-a-real-key', remember: false });
    const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: context.changes, parentId: asset.id, inspectAfter: false }, context);
    const finished = await draftDone(f.authoring, job.id);
    assert.equal(finished.status, 'succeeded', finished.error);
    assert.deepEqual(authoringImages, [], 'same provider with a different model must not receive the critique screenshots');
    const promptPayload = JSON.parse(authoringPrompt) as { visualEvidenceImageHandoff: { status: string; imageCount: number; limitation: string };
      revisionRules: string };
    assert.deepEqual(promptPayload.visualEvidenceImageHandoff, { status: 'model_mismatch', imageCount: 0,
      limitation: 'No review screenshots are attached to this generation request; use text notes only and do not imply direct visual inspection.' });
    assert.match(promptPayload.revisionRules, /use the notes only and do not claim direct visual inspection/i);
  } finally { f.close(); }
});

test('screenshots are bounded, tied to the exact review, and fingerprinted before provider transmission', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; return { text: JSON.stringify(critique()), usage }; });
  try {
    const asset = await f.library.save(recipe()), record = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id })).id);
    const png = tinyPng;
    const attached = await f.reviews.attach({ reviewId: record.id, revision: record.revision, view: 'three_quarter', time: 0.5, pngBase64: png });
    assert.equal(attached.images.length, 1); assert.equal(attached.images[0]!.view, 'three_quarter'); assert.equal(calls, 0);
    await assert.rejects(f.reviews.attach({ reviewId: record.id, revision: attached.revision, view: 'side', pngBase64: png }), /already attached/);
    assert.equal((await f.reviews.imageData(record.id, attached.images[0]!.id)).base64, png);
    await writeFile(join(f.root, 'artifacts/reviews', record.id, `${attached.images[0]!.id}.png`), 'changed');
    const critiquing = await f.reviews.critique({ reviewId: record.id, revision: attached.revision, provider: 'deepseek' });
    const failed = await settled(f.reviews, critiquing.id); assert.match(failed.error!, /screenshot changed/); assert.equal(calls, 0);
  } finally { f.close(); }
});

test('image provider adapters encode native Claude blocks and compatible image URLs without leaking keys into prompts', async () => {
  for (const provider of ['claude', 'deepseek', 'glm'] as const) {
    const client = providerClient(async (_url, init) => {
      const body = JSON.parse(init!.body as string); assert.equal((init!.body as string).includes('fixture-secret-key'), false);
      if (provider === 'claude') assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-png' } });
      else assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,fixture-png');
      return Response.json(provider === 'claude' ? { content: [{ type: 'text', text: '{}' }] } : { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    });
    await client({ provider, model: 'fixture-model', workspace: '', apiKey: 'fixture-secret-key' }, 'system', 'prompt', 2000, new AbortController().signal, [{ base64: 'fixture-png', mimeType: 'image/png' }]);
  }
});

test('cancelling a pending inspection prevents its undelivered Studio command from running later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-cancel-review-')), library = new Library(join(root, 'library')), queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(); queue.heartbeat(sessionId, {});
  const reviews = new Reviews(join(root, 'reviews'), library, queue, new Connections(join(root, 'connections.json')));
  const asset = await library.save(recipe()), record = await reviews.start({ assetId: asset.id, sessionId, rigId });
  await reviews.cancel(record.id);
  const done = await settled(reviews, record.id); assert.equal(done.status, 'needs_feedback'); assert.equal(done.feedback, undefined); assert.match(done.error!, /cancel/i); assert.equal(queue.poll(sessionId), null);
});

test('saved answers retain the original question after a screenshot invalidates the earlier critique', async () => {
  const f = await setup();
  try {
    const asset = await f.library.save(recipe());
    const inspected = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, sessionId: f.sessionId, rigId: f.rigId, aiReview: true, provider: 'deepseek' })).id);
    const input = feedback(inspected);
    const saved = await f.reviews.feedback({ ...input, feedback: { ...input.feedback, answers: [{ questionId: 'ai-impact', answer: 'More weight, please.' }] } });
    const png = tinyPng;
    const attached = await f.reviews.attach({ reviewId: saved.id, revision: saved.revision, view: 'front', pngBase64: png });
    assert.equal(attached.critique, undefined);
    const context = await f.reviews.reserveRevision(attached.id, attached.revision);
    assert.deepEqual(context.answers, [{ question: 'Would you like a stronger downward weight shift?', answer: 'More weight, please.' }]);
  } finally { f.close(); }
});

test('a provenance write failure reports the saved child and releases its feedback reservation', async () => {
  const f = await setup(async (_credential, system) => ({ text: JSON.stringify(system.includes('TARGETED ANIMATION REFINEMENT OUTPUT')
    ? { approach: 'Adjust one arm key without regenerating the rest.', checkpoints: ['Inspect the changed arm key'], avoid: [],
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-60, 0, 0] }] }
    : reply()), usage }));
  try {
    const asset = await f.library.save(recipe());
    const reviewed = await settled(f.reviews, (await f.reviews.start({ assetId: asset.id, preview: false })).id);
    const saved = await f.reviews.feedback(feedback(reviewed));
    const context = await f.reviews.reserveRevision(saved.id, saved.revision);
    await mkdir(join(f.root, 'artifacts'), { recursive: true });
    await writeFile(join(f.root, 'artifacts/generations'), 'fixture blocks the provenance directory');
    const result = await draftDone(f.authoring, f.authoring.start({ provider: 'deepseek', kind: 'animation', parentId: asset.id, prompt: context.changes, inspectAfter: false }, context).id);
    assert.equal(result.status, 'failed'); assert.ok(result.assetId); assert.match(result.error!, /Draft saved/);
    // Background error handling releases the reservation after reporting the failure.
    const record = await settled(f.reviews, saved.id);
    assert.equal(record.childAssetId, result.assetId); assert.equal(record.reservation, undefined);
    assert.equal((await f.library.get(result.assetId!)).parentId, asset.id);
  } finally { f.close(); }
});
