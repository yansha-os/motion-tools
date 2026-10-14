import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { runningBuildIdentity } from '../src/build-identity.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Queue, startBridge } from '../src/bridge.js';
import { Blender } from '../src/blender.js';
import { animationAuthoringIntentSchema, Library } from '../src/library.js';
import { MotionApp } from '../src/app.js';
import { createMcp } from '../src/server.js';
import { animationPreset, animationSchema, vfxPreset, type AnimationRecipe } from '../src/recipes.js';
import { AnimationTestPlanLibrary } from '../src/animation-test-plans.js';
import { sampleIKTargetPath } from '../src/ik-target-paths.js';
import { fingerprint, fingerprintUuid } from '../src/inspection.js';
import { animationBenchmarkRecipeFingerprint } from '../src/animation-benchmark.js';
import { mappedAnimationTargets } from '../src/export-targets.js';
import { patchAnimation, patchLayerIdFactory } from '../src/animation-patch.js';
import { Reviews, type ReviewRecord } from '../src/reviews.js';
import { Connections } from '../src/providers.js';
import { retargetProfileSchema, type RetargetProfile } from '../src/retarget.js';
import { animationVisualContext } from '../src/animation-visual-context.js';

function resolvedCaptureJointMap(recipe: AnimationRecipe, jointMap: Record<string, string>) {
  const joints = new Set([...recipe.tracks.map(track => track.joint), ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint))]);
  return Object.fromEntries([...joints].sort().map(joint => [joint, jointMap[joint] ?? joint]));
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
function pngWithText(png: Buffer, text: string) {
  return Buffer.concat([png.subarray(0, png.length - 12), pngChunk('tEXt', Buffer.from(`note\0${text}`)), png.subarray(png.length - 12)]);
}

function seedCaptureFocusInspection(queue: Queue, sessionId: string, rigId: string, rigSignature: string, eligibleNames: string[]) {
  const joints = [...new Set([...eligibleNames, 'HumanoidRootPart'])].map(name => ({ name,
    parent: name === 'HumanoidRootPart' ? '' : 'HumanoidRootPart', driven: name !== 'HumanoidRootPart',
    basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: name === 'HumanoidRootPart' ? 0 : 1 }));
  const job = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, job.id);
  queue.complete(sessionId, job.id, true, { id: rigId, rigSignature, animatedNames: joints.map(joint => ({ name: joint.name, parent: joint.parent, driven: joint.driven,
    captureFocusEligible: eligibleNames.includes(joint.name), ...(eligibleNames.includes(joint.name) ? { visualGeometry: {
      source: 'BasePart.Size', dimensionsStuds: [1, 2, 1], partClass: 'Part', transparency: 0, shape: 'Enum.PartType.Block' } } : {}) })),
    retargetProfile: { version: 1, rigId, rigName: 'Capture fixture', rigType: 'custom', rigSignature, joints } });
}

test('HTTP bridge requires local pairing, rejects browser origins, and routes results', async () => {
  const queue = new Queue();
  const bridge = await startBridge(queue, 'test-token', 0);
  const port = (bridge.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const sessionId = randomUUID();
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
  try {
    assert.equal((await fetch(`${url}/health`)).status, 403);
    assert.equal((await fetch(`${url}/health`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
    const health = await (await fetch(`${url}/health`, { headers })).json() as { buildIdentity?: unknown };
    assert.deepEqual(health.buildIdentity, runningBuildIdentity);
    const poll = () => fetch(`${url}/poll`, { method: 'POST', headers, body: JSON.stringify({ sessionId, snapshot: { place: 'Fixture' } }) });
    assert.deepEqual(await (await poll()).json(), { command: null });
    const job = queue.enqueue(sessionId, 'inspect', { rigId: 'fixture-rig' });
    const response = await (await poll()).json() as { command: { id: string } };
    assert.equal(response.command.id, job.id);
    const wrongSession = await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ sessionId: randomUUID(), id: job.id, ok: true, result: {} }) });
    assert.equal(wrongSession.status, 400);
    const largeEvidence = 'x'.repeat(600_000);
    const completed = await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ sessionId, id: job.id, ok: true, result: { joints: ['Head'], largeEvidence } }) });
    assert.equal(completed.status, 200);
    assert.equal(queue.get(job.id).status, 'succeeded');
    assert.equal((queue.get(job.id).result as { largeEvidence: string }).largeEvidence.length, largeEvidence.length);
  } finally { bridge.closeAllConnections(); await new Promise<void>(r => bridge.close(() => r())); }
});

test('MCP recent-job recovery resolves the sole online session and keeps payloads/results out of listings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-job-recovery-'));
  const queue = new Queue();
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, { place: 'Recovery fixture' });
  const job = queue.enqueue(sessionId, 'inspect', { rigId: randomUUID(), privatePayload: 'do not return' });
  assert.ok(queue.poll(sessionId));
  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'job-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.callTool({ name: 'motion_studio_jobs', arguments: {} });
    assert.ok(!listed.isError, JSON.stringify(listed));
    const result = (listed.structuredContent as { result: { sessionId: string; online: boolean; jobs: { id: string; status: string; operation: string; nextAction: string; payload?: unknown; result?: unknown }[] } }).result;
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.online, true);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]!.id, job.id);
    assert.equal(result.jobs[0]!.status, 'running');
    assert.match(result.jobs[0]!.nextAction, /poll this same job ID/i);
    assert.equal(result.jobs[0]!.operation, 'inspect');
    assert.equal('payload' in result.jobs[0]!, false);
    assert.equal('result' in result.jobs[0]!, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('motion_studio_sessions independently reports inconsistent editor availability without changing the heartbeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-editor-context-assessment-'));
  const queue = new Queue();
  const sessionId = randomUUID();
  const motionEditor = { schemaVersion: 1, viewportOpen: true, clipLoaded: true, durationSeconds: 2, playheadSeconds: 3,
    fieldAvailability: { playhead: 'available', viewportCamera: 'available' } };
  queue.heartbeat(sessionId, { motionEditor });
  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'editor-context-assessment-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: 'motion_studio_sessions', arguments: {} });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = (response.structuredContent as { result: { id: string; snapshot: { motionEditor: { fieldAvailability: { playhead: string } } };
      motionEditorContextAssessment: { status: string; freshness: { status: string; heartbeatAgeMs?: number; maximumAgeMs: number };
        contradictedAvailableFields: string[] } }[] }).result;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, sessionId);
    assert.equal(result[0]!.motionEditorContextAssessment.status, 'inconsistent');
    assert.equal(result[0]!.motionEditorContextAssessment.freshness.status, 'fresh');
    assert.equal(result[0]!.motionEditorContextAssessment.freshness.maximumAgeMs, 10_000);
    assert.ok((result[0]!.motionEditorContextAssessment.freshness.heartbeatAgeMs ?? Infinity) < 10_000);
    assert.deepEqual(result[0]!.motionEditorContextAssessment.contradictedAvailableFields, ['playhead', 'viewportCamera']);
    assert.equal(result[0]!.snapshot.motionEditor.fieldAvailability.playhead, 'available',
      'assessment is additive and never mutates the stored Studio heartbeat');
    assert.equal((queue.listSessions()[0]!.snapshot.motionEditor as typeof motionEditor).fieldAvailability.playhead, 'available');
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('agent resume retains actionable Studio job IDs while the plugin session is offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-offline-resume-'));
  let now = 1000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, { place: 'Offline resume fixture' });
  const delivered = queue.enqueue(sessionId, 'inspect', { rigId: randomUUID(), privatePayload: 'hidden' });
  assert.equal(queue.poll(sessionId)?.id, delivered.id);
  const queued = queue.enqueue(sessionId, 'sample', { privatePayload: 'hidden too' });
  now += 10001;

  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'offline-agent-resume-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const registered = await client.listTools();
    const resumeDescription = registered.tools.find(tool => tool.name === 'motion_agent_resume')?.description ?? '';
    assert.match(resumeDescription, /offline queued jobs have not been delivered.*same ID after reconnect/i);
    assert.match(resumeDescription, /delivered\/unknown jobs require reconnecting and reconciling Studio state before retry/i);
    const resumed = await client.callTool({ name: 'motion_agent_resume', arguments: { sessionId } });
    assert.ok(!resumed.isError, JSON.stringify(resumed));
    const sessions = (resumed.structuredContent as { result: { sessions: {
      online: boolean; pendingJobs: { id: string; status: string; nextAction: string; payload?: unknown; result?: unknown }[];
      motionEditorContextAssessment: { freshness: { status: string } };
    }[] } }).result.sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.online, false);
    assert.equal(sessions[0]?.motionEditorContextAssessment.freshness.status, 'stale');
    assert.deepEqual(sessions[0]?.pendingJobs.map(job => job.id).sort(), [delivered.id, queued.id].sort());
    assert.match(sessions[0]?.pendingJobs.find(job => job.id === delivered.id)?.nextAction ?? '', /reconnect Motion Tools, inspect Studio state, and reconcile this same job before any retry/i);
    assert.match(sessions[0]?.pendingJobs.find(job => job.id === queued.id)?.nextAction ?? '', /has not been delivered.*reconnect Motion Tools to continue this same job/i);
    const nextActions = (resumed.structuredContent as { result: { nextActions: string[] } }).result.nextActions;
    assert.ok(nextActions.some(action => /reconnect Motion Tools.*reconcile the returned job ID before retrying/i.test(action)));
    assert.ok(nextActions.some(action => /queued but has not been delivered.*continue that same job/i.test(action)));
    assert.equal(sessions[0]?.pendingJobs.some(job => 'payload' in job || 'result' in job), false);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('recovered editor-apply jobs require fingerprint reconciliation before any retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-editor-apply-recovery-'));
  const journalPath = join(root, 'artifacts', 'studio-jobs.json');
  const sessionId = randomUUID();
  const original = new Queue(Date.now, journalPath);
  original.heartbeat(sessionId, { place: 'Editor recovery fixture' });
  const delivered = original.enqueue(sessionId, 'apply_editor_candidate', { recipe: { private: true } });
  assert.equal(original.poll(sessionId)?.id, delivered.id);
  const notDelivered = original.enqueue(sessionId, 'apply_editor_candidate', { recipe: { private: true } });
  const recoveredQueue = new Queue(Date.now, journalPath);
  const server = createMcp(new Library(join(root, 'library')), recoveredQueue, new Blender(root, 'blender'));
  const client = new Client({ name: 'editor-apply-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const ambiguousCall = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: delivered.id } });
    assert.ok(!ambiguousCall.isError, JSON.stringify(ambiguousCall));
    const ambiguous = (ambiguousCall.structuredContent as { result: { status: string; resultAvailable: boolean;
      nextAction: string; editorApplyRecovery: { decision: string; candidateFingerprintAvailable: boolean; reconciliationTool: string; guidance: string } } }).result;
    assert.equal(ambiguous.status, 'unknown');
    assert.equal(ambiguous.resultAvailable, false);
    assert.match(ambiguous.nextAction, /may have been applied.*reconcile.*before any retry/i);
    assert.equal(ambiguous.editorApplyRecovery.decision, 'may_have_applied');
    assert.equal(ambiguous.editorApplyRecovery.candidateFingerprintAvailable, false);
    assert.equal(ambiguous.editorApplyRecovery.reconciliationTool, 'motion_studio_read_editor_draft');
    assert.match(ambiguous.editorApplyRecovery.guidance, /compare its draftFingerprint.*candidate recipe.*source fingerprint/i);
    assert.match(ambiguous.editorApplyRecovery.guidance, /Do not retry.*until the editor state has been reconciled/i);

    const queuedCall = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: notDelivered.id } });
    assert.ok(!queuedCall.isError, JSON.stringify(queuedCall));
    const queued = (queuedCall.structuredContent as { result: { status: string;
      nextAction: string; editorApplyRecovery: { decision: string; guidance: string } } }).result;
    assert.equal(queued.status, 'expired');
    assert.equal(queued.editorApplyRecovery.decision, 'not_delivered');
    assert.match(queued.nextAction, /had not been delivered/i);
    assert.match(queued.editorApplyRecovery.guidance, /had not been delivered.*fresh apply/i);

    const resumed = await client.callTool({ name: 'motion_agent_resume', arguments: {} });
    assert.ok(!resumed.isError, JSON.stringify(resumed));
    const recoveredJobs = (resumed.structuredContent as { result: { recoveredJobs: { jobs: { id: string; nextAction: string }[] } } }).result.recoveredJobs.jobs;
    assert.match(recoveredJobs.find(job => job.id === delivered.id)!.nextAction, /may have been applied.*reconcile.*before any retry/i);
    assert.match(recoveredJobs.find(job => job.id === notDelivered.id)!.nextAction, /had not been delivered/i);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cached rig profiles come only from recent successful inspections in the same live Studio session', () => {
  let now = 1000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID(), rigId = randomUUID();
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'rig-signature' } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  const profile = retargetProfileSchema.parse({ version: 1, rigId, rigName: 'Cache fixture', rigType: 'custom', rigSignature: 'rig-signature',
    joints: [{ name: 'Root', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 }] });
  queue.complete(sessionId, inspection.id, true, { id: rigId, rigSignature: profile.rigSignature, retargetProfile: profile });
  assert.deepEqual(queue.getInspectionProfile(sessionId, rigId).profile, profile);
  const newerProfile = { ...profile, rigSignature: 'newer-same-millisecond-signature' };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: newerProfile.rigSignature } });
  const sameTimestampInspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, sameTimestampInspection.id);
  queue.complete(sessionId, sameTimestampInspection.id, true, { id: rigId, rigSignature: newerProfile.rigSignature, retargetProfile: newerProfile });
  assert.deepEqual(queue.getInspectionProfile(sessionId, rigId).profile, newerProfile,
    'when inspection timestamps tie, the latest recorded profile must win');
  now += 5001;
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'rig-signature' } });
  assert.throws(() => queue.getInspectionProfile(sessionId, rigId, 5000), /within the last 5 seconds/);
  now += 10000;
  assert.throws(() => queue.getInspectionProfile(sessionId, rigId), /session is offline/);
});

test('MCP joint-axis probe samples the inspected active rig and returns the measured result without saving', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-axis-probe-'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'axis-probe-rig-signature';
  const profile: RetargetProfile = { version: 1, rigId, rigName: 'Axis probe fixture', rigType: 'custom', rigSignature,
    joints: [{ name: 'Hand', parent: 'Arm', driven: true, targetKind: 'Motor6D', basis: [0, 0, 0, 1], segmentLength: 1 }] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, name: profile.rigName, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: profile });
  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'axis-probe-integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let poller: NodeJS.Timeout | undefined;
  let sampled = false;
  let sampledPayload: { rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] } | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    poller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, name: profile.rigName, rigSignature } });
      const command = queue.poll(sessionId);
      if (!command || command.operation !== 'sample_animation') return;
      sampled = true;
      const payload = command.payload as { rigId: string; rigSignature: string; assetId: string; recipe: AnimationRecipe; times: number[] };
      sampledPayload = payload;
      const samples = payload.times.map((time, index) => {
        const key = payload.recipe.tracks[0]!.keys.find(candidate => Math.abs(candidate.time - time) < 0.000001);
        const rotation = key?.rotation ?? [0, 0, 0];
        const radians = rotation.map(value => value * Math.PI / 180);
        const length = Math.hypot(...radians);
        const half = length / 2;
        const orientation = length < 1e-10 ? [0, 0, 0, 1] : [
          radians[0]! / length * Math.sin(half), radians[1]! / length * Math.sin(half), radians[2]! / length * Math.sin(half), Math.cos(half),
        ];
        return { id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 0, 0]], jointPoints: [[0, 0, 0]], bottoms: [0], orientations: [orientation] };
      });
      queue.complete(sessionId, command.id, true, { version: 1, source: 'studio_pose_evaluator', rigId, rigSignature, assetId: payload.assetId,
        duration: payload.recipe.duration, loop: false, height: 1, groundSource: 'rest_node_bounds', note: 'axis probe integration fixture',
        nodes: [{ name: 'Hand', parent: 0, driven: true, foot: false }], restPose: { points: [[0, 0, 0]], orientations: [[0, 0, 0, 1]] }, samples });
    }, 2);
    const call = await client.callTool({ name: 'motion_studio_probe_joint_axes', arguments: { sessionId, rigId, jointName: 'Hand' } });
    assert.ok(!call.isError, JSON.stringify(call));
    const result = (call.structuredContent as { result: { status: string; joint: string; rigId: string; rigSignature: string | null; probeId: string;
      jointContext: { parent: string; targetKind: string | null; segmentLengthStuds: number };
      calibrationStatus: 'locally_consistent' | 'review_required' | 'no_measurable_rotation_response';
      axes: { inputAxis: 'x' | 'y' | 'z'; responseDiagnostics: { status: 'usable_local_response' | 'unresponsive' | 'asymmetric_or_coupled' };
        positive: { measuredRelativeRotationInJointFrame: { angleDegrees: number } } }[]; localRotationResponseJacobian: number[][] } }).result;
    assert.equal(sampled, true);
    assert.equal(sampledPayload?.rigId, rigId);
    assert.equal(sampledPayload?.rigSignature, rigSignature);
    assert.equal(sampledPayload?.recipe.name, 'Motion Tools Axis Probe');
    assert.equal(sampledPayload?.recipe.tracks[0]!.joint, 'Hand');
    assert.equal(sampledPayload?.recipe.tracks[0]!.keys.length, 13);
    assert.equal(result.status, 'measured');
    assert.equal(result.joint, 'Hand');
    assert.deepEqual(result.jointContext, { parent: 'Arm', targetKind: 'Motor6D', segmentLengthStuds: 1 });
    assert.equal(result.axes.length, 3);
    for (const axis of result.axes) assert.ok(Math.abs(axis.positive.measuredRelativeRotationInJointFrame.angleDegrees - 5) < 0.01);
    assert.equal(result.localRotationResponseJacobian.length, 3);
    assert.equal(result.calibrationStatus, 'locally_consistent');
    const sourceRecipe = animationSchema.parse({ kind: 'animation', name: 'Neutral source', duration: 1, loop: false, markers: [],
      tracks: [{ joint: 'Hand', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] }] });
    const sourceFingerprint = fingerprint(sourceRecipe);
    const suggestionCall = await client.callTool({ name: 'motion_studio_suggest_local_rotation', arguments: {
      sessionId, probeId: result.probeId, desiredRotationVectorDegrees: [0, 0, 4], recipe: sourceRecipe,
      expectedSourceFingerprint: sourceFingerprint, targetTime: 0,
    } });
    assert.ok(!suggestionCall.isError, JSON.stringify(suggestionCall));
    const suggestion = (suggestionCall.structuredContent as { result: { status: string; joint: string; localEulerRotationDegrees: number[];
      residualDegrees: number; rigSignature: string | null; sourceFingerprint: string; targetTime: number;
      jointContext: { parent: string; targetKind: string | null; segmentLengthStuds: number };
      patchPreviewRequest: { expectedSourceFingerprint: string; operations: { operation: string; joint: string; time: number; rotation: number[] }[]; preserve: unknown[] } } }).result;
    assert.equal(suggestion.status, 'suggestion_only');
    assert.equal(suggestion.joint, 'Hand');
    assert.deepEqual(suggestion.jointContext, result.jointContext);
    assert.deepEqual(suggestion.localEulerRotationDegrees, [0, 0, 4]);
    assert.ok(suggestion.residualDegrees < 0.001);
    assert.equal(suggestion.rigSignature, rigSignature);
    assert.equal(suggestion.sourceFingerprint, sourceFingerprint);
    assert.equal(suggestion.targetTime, 0, JSON.stringify(suggestion));
    assert.deepEqual(suggestion.patchPreviewRequest.operations, [{ operation: 'set_pose', joint: 'Hand', time: 0, rotation: [0, 0, 4] }]);
    const patchPreviewCall = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: sourceRecipe, ...suggestion.patchPreviewRequest,
    } });
    assert.ok(!patchPreviewCall.isError, JSON.stringify(patchPreviewCall));
    const patchPreview = (patchPreviewCall.structuredContent as { result: { saved: boolean; recipe: AnimationRecipe; sourceFingerprint: string; candidateFingerprint: string } }).result;
    assert.equal(patchPreview.saved, false);
    assert.equal(patchPreview.sourceFingerprint, sourceFingerprint);
    assert.match(patchPreview.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(patchPreview.recipe.tracks[0]!.keys[0]!.rotation, [0, 0, 4]);
    const incrementalPoseCall = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: sourceRecipe, expectedSourceFingerprint: sourceFingerprint,
      operations: [{ operation: 'offset_pose', joint: 'Hand', time: 0.5, rotationOffset: [0, 15, 0], insertIfMissing: true }],
    } });
    assert.ok(!incrementalPoseCall.isError, JSON.stringify(incrementalPoseCall));
    const incrementalPose = (incrementalPoseCall.structuredContent as { result: { saved: boolean; recipe: AnimationRecipe;
      changes: { operation: string; joint: string; time: number; insertedKey?: boolean;
        poseBefore?: { position: [number, number, number]; rotation: [number, number, number] };
        poseAfter?: { position: [number, number, number]; rotation: [number, number, number] };
        poseOffset?: { rotation?: [number, number, number] } }[]; candidateFingerprint: string } }).result;
    assert.equal(incrementalPose.saved, false);
    assert.match(incrementalPose.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(incrementalPose.recipe.tracks[0]!.keys.length, 3);
    assert.deepEqual(incrementalPose.changes[0], { operation: 'offset_pose', joint: 'Hand', time: 0.5, insertedKey: true,
      poseBefore: { position: [0, 0, 0], rotation: [0, 0, 0] }, poseAfter: { position: [0, 0, 0], rotation: [0, 15, 0] },
      poseOffset: { rotation: [0, 15, 0] } });
    assert.equal(sourceRecipe.tracks[0]!.keys.length, 2, 'candidate breakdown preview must leave the source recipe untouched');
    const coordinatedRecipe = animationSchema.parse({ ...sourceRecipe, tracks: [sourceRecipe.tracks[0]!, {
      joint: 'Arm', keys: structuredClone(sourceRecipe.tracks[0]!.keys),
    }] });
    const coordinatedFingerprint = fingerprint(coordinatedRecipe);
    const coordinatedPreviewCall = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: coordinatedRecipe, expectedSourceFingerprint: coordinatedFingerprint,
      operations: [{ operation: 'offset_pose_group', time: 0.5, insertIfMissing: true, targets: [
        { joint: 'Hand', rotationOffset: [0, 15, 0] }, { joint: 'Arm', positionOffset: [0.1, 0, 0] },
      ] }],
    } });
    assert.ok(!coordinatedPreviewCall.isError, JSON.stringify(coordinatedPreviewCall));
    const coordinatedPreview = (coordinatedPreviewCall.structuredContent as { result: { saved: boolean; sourceFingerprint: string;
      candidateFingerprint: string; recipe: AnimationRecipe; changes: { operation: string; joint: string; insertedKey?: boolean }[] } }).result;
    assert.equal(coordinatedPreview.saved, false);
    assert.equal(coordinatedPreview.sourceFingerprint, coordinatedFingerprint);
    assert.match(coordinatedPreview.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(coordinatedPreview.changes.map(change => change.joint), ['Hand', 'Arm']);
    assert.ok(coordinatedPreview.changes.every(change => change.operation === 'offset_pose_group' && change.insertedKey));
    assert.ok(coordinatedRecipe.tracks.every(track => track.keys.length === 2), 'multi-joint AI preview must not mutate its source recipe');
    const nonNeutralRecipe = animationSchema.parse({ ...sourceRecipe, tracks: [{ ...sourceRecipe.tracks[0]!, keys: [
      { ...sourceRecipe.tracks[0]!.keys[0]!, rotation: [0, 0, 10] }, sourceRecipe.tracks[0]!.keys[1]!,
    ] }] });
    const nonNeutralSuggestion = await client.callTool({ name: 'motion_studio_suggest_local_rotation', arguments: {
      sessionId, probeId: result.probeId, desiredRotationVectorDegrees: [0, 0, 4], recipe: nonNeutralRecipe,
      expectedSourceFingerprint: fingerprint(nonNeutralRecipe), targetTime: 0,
    } });
    assert.equal(nonNeutralSuggestion.isError, true);
    assert.match(JSON.stringify(nonNeutralSuggestion), /target key is not neutral/);
    queue.heartbeat(sessionId, { activeRig: { id: rigId, name: profile.rigName, rigSignature: 'changed-topology' } });
    const changedTopologySuggestion = await client.callTool({ name: 'motion_studio_suggest_local_rotation', arguments: {
      sessionId, probeId: result.probeId, desiredRotationVectorDegrees: [0, 0, 4], recipe: sourceRecipe,
      expectedSourceFingerprint: sourceFingerprint, targetTime: 0,
    } });
    assert.equal(changedTopologySuggestion.isError, true);
    assert.match(JSON.stringify(changedTopologySuggestion), /selected target rig changed after inspection/);
    queue.heartbeat(sessionId, { activeRig: { id: rigId, name: profile.rigName, rigSignature } });
    const foreignSessionSuggestion = await client.callTool({ name: 'motion_studio_suggest_local_rotation', arguments: {
      sessionId: randomUUID(), probeId: result.probeId, desiredRotationVectorDegrees: [0, 0, 4], recipe: sourceRecipe,
      expectedSourceFingerprint: sourceFingerprint, targetTime: 0,
    } });
    assert.equal(foreignSessionSuggestion.isError, true);
    assert.match(JSON.stringify(foreignSessionSuggestion), /different Studio session/);
    assert.equal(queue.listSessions()[0]?.online, true);
  } finally {
    if (poller) clearInterval(poller);
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('AI readiness preflight blocks missing Studio evidence and passes only a fresh matching rig inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-agent-readiness-'));
  const queue = new Queue();
  const rigId = randomUUID(), sessionId = randomUUID(), rigSignature = 'readiness-rig-signature-v1';
  const readyProfile = { version: 1 as const, rigId, rigName: 'Target R15', rigType: 'R15' as const, rigSignature, joints: [
    { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
    { name: 'LeftUpperArm', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'LeftLowerArm', parent: 'LeftUpperArm', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'LeftHand', parent: 'LeftLowerArm', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
  ] };
  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'agent-readiness-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const disconnected = await client.callTool({ name: 'motion_agent_readiness', arguments: {} });
    assert.ok(!disconnected.isError, JSON.stringify(disconnected));
    const disconnectedResult = (disconnected.structuredContent as { result: { status: string; checks: { id: string; status: string }[] } }).result;
    assert.equal(disconnectedResult.status, 'blocked');
    assert.equal(disconnectedResult.checks.find(check => check.id === 'studio_connection')?.status, 'blocked');

    const supportedOperations = { inspectRig: true, sampleAnimation: true, browseLocalAnimations: true, openAnimation: true, saveAnimation: true,
      validateAnimationExport: true, readEditorDraft: true, applyEditorCandidate: true, captureCandidateViews: true,
      captureEditorDraftViews: true, inverseKinematics: true };
    queue.heartbeat(sessionId, { pluginVersion: 'test-plugin', features: { poseSampling: true, animationLibrary: true, fullBodySnapshots: true, inverseKinematics: false, editorDraft: true },
      operations: supportedOperations,
      activeRig: { id: rigId, name: 'Target R15', rigSignature } });
    const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, inspection.id);
    queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: readyProfile });
    const ready = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId,
      requiredStudioFeatures: ['poseSampling', 'animationLibrary', 'editorDraft'],
      requiredStudioOperations: ['sampleAnimation', 'readEditorDraft', 'applyEditorCandidate'],
      requiredSemanticRoles: ['left_shoulder', 'left_elbow', 'left_hand'] } });
    assert.ok(!ready.isError, JSON.stringify(ready));
    const readyResult = (ready.structuredContent as { result: { status: string; checks: { id: string; status: string }[]; nextActions: string[]; studio: { pluginVersion: string }; limitations: string[] } }).result;
    assert.equal(readyResult.status, 'ready');
    assert.equal(readyResult.studio.pluginVersion, 'test-plugin');
    for (const checkId of ['studio_connection', 'active_rig', 'rig_inspection', 'studio_jobs']) {
      assert.equal(readyResult.checks.find(check => check.id === checkId)?.status, 'ready', checkId);
    }
    assert.equal(readyResult.checks.find(check => check.id === 'studio_capabilities')?.status, 'ready');
    assert.equal(readyResult.checks.find(check => check.id === 'studio_operations')?.status, 'ready');
    assert.equal(readyResult.checks.find(check => check.id === 'semantic_rig_roles')?.status, 'ready');
    assert.equal(readyResult.nextActions.some(action => /motion_studio_capture_preflight.*screenshot permission.*does not take an image/i.test(action)), true);
    assert.equal(readyResult.limitations.some(limitation => /Screenshot availability and permission are not checked by readiness.*motion_studio_capture_preflight/i.test(limitation)), true);

    const unsupported = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId, requiredStudioFeatures: ['inverseKinematics'] } });
    assert.ok(!unsupported.isError, JSON.stringify(unsupported));
    const unsupportedResult = (unsupported.structuredContent as { result: { status: string; checks: { id: string; status: string; detail: string }[] } }).result;
    assert.equal(unsupportedResult.status, 'blocked');
    assert.match(unsupportedResult.checks.find(check => check.id === 'studio_capabilities')?.detail ?? '', /inverseKinematics/);

    queue.heartbeat(sessionId, { pluginVersion: 'test-plugin', features: { poseSampling: true, animationLibrary: true,
      fullBodySnapshots: true, inverseKinematics: false, editorDraft: false },
      operations: { ...supportedOperations, applyEditorCandidate: false }, activeRig: { id: rigId, name: 'Target R15', rigSignature } });
    const editorDraftUnsupported = await client.callTool({ name: 'motion_agent_readiness', arguments: {
      sessionId, rigId, requiredStudioFeatures: ['editorDraft'],
    } });
    assert.ok(!editorDraftUnsupported.isError, JSON.stringify(editorDraftUnsupported));
    const editorDraftUnsupportedResult = (editorDraftUnsupported.structuredContent as {
      result: { status: string; checks: { id: string; status: string; detail: string }[] } }).result;
    assert.equal(editorDraftUnsupportedResult.status, 'blocked');
    assert.match(editorDraftUnsupportedResult.checks.find(check => check.id === 'studio_capabilities')?.detail ?? '', /editorDraft/);
    const applyUnsupported = await client.callTool({ name: 'motion_agent_readiness', arguments: {
      sessionId, rigId, requiredStudioOperations: ['applyEditorCandidate'],
    } });
    assert.ok(!applyUnsupported.isError, JSON.stringify(applyUnsupported));
    const applyUnsupportedResult = (applyUnsupported.structuredContent as {
      result: { status: string; checks: { id: string; status: string; detail: string }[] } }).result;
    assert.equal(applyUnsupportedResult.status, 'blocked');
    assert.match(applyUnsupportedResult.checks.find(check => check.id === 'studio_operations')?.detail ?? '', /applyEditorCandidate/);

    queue.heartbeat(sessionId, { activeRig: { id: rigId, name: 'Target R15', rigSignature } });
    const unreported = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId,
      requiredStudioFeatures: ['poseSampling'], requiredStudioOperations: ['readEditorDraft'] } });
    assert.ok(!unreported.isError, JSON.stringify(unreported));
    const unreportedResult = (unreported.structuredContent as { result: { status: string; checks: { id: string; status: string }[] } }).result;
    assert.equal(unreportedResult.checks.find(check => check.id === 'studio_capabilities')?.status, 'unknown');
    assert.equal(unreportedResult.checks.find(check => check.id === 'studio_operations')?.status, 'unknown');

    const partialOperations = { ...supportedOperations };
    delete (partialOperations as Partial<typeof supportedOperations>).applyEditorCandidate;
    queue.heartbeat(sessionId, { pluginVersion: 'test-plugin', features: { editorDraft: true },
      operations: partialOperations, activeRig: { id: rigId, name: 'Target R15', rigSignature } });
    const missingOperation = await client.callTool({ name: 'motion_agent_readiness', arguments: {
      sessionId, rigId, requiredStudioOperations: ['applyEditorCandidate'],
    } });
    assert.ok(!missingOperation.isError, JSON.stringify(missingOperation));
    const missingOperationResult = (missingOperation.structuredContent as {
      result: { status: string; checks: { id: string; status: string; detail: string }[] } }).result;
    assert.equal(missingOperationResult.status, 'unknown');
    assert.equal(missingOperationResult.checks.find(check => check.id === 'studio_operations')?.status, 'unknown');
    assert.match(missingOperationResult.checks.find(check => check.id === 'studio_operations')?.detail ?? '', /applyEditorCandidate/);

    const resume = await client.callTool({ name: 'motion_agent_resume', arguments: { sessionId } });
    assert.ok(!resume.isError, JSON.stringify(resume));
    const resumedSessions = (resume.structuredContent as { result: { sessions: {
      pluginVersion: string | null; features: Record<string, boolean> | null; operations: Record<string, boolean> | null;
      motionEditorContextAssessment: { status: string; freshness: { status: string; maximumAgeMs: number } };
    }[] } }).result.sessions;
    assert.equal(resumedSessions[0]?.pluginVersion, 'test-plugin');
    assert.equal(resumedSessions[0]?.features?.editorDraft, true);
    assert.equal(resumedSessions[0]?.operations?.readEditorDraft, true);
    assert.equal(resumedSessions[0]?.operations?.applyEditorCandidate, undefined);
    assert.equal(resumedSessions[0]?.motionEditorContextAssessment.status, 'absent');
    assert.equal(resumedSessions[0]?.motionEditorContextAssessment.freshness.status, 'fresh');
    assert.equal(resumedSessions[0]?.motionEditorContextAssessment.freshness.maximumAgeMs, 10_000);

    queue.heartbeat(sessionId, { pluginVersion: 'malformed-test-plugin', features: { editorDraft: true },
      operations: { applyEditorCandidate: 'yes' }, activeRig: { id: rigId, name: 'Target R15', rigSignature } });
    const malformedReadiness = await client.callTool({ name: 'motion_agent_readiness', arguments: {
      sessionId, rigId, requiredStudioOperations: ['applyEditorCandidate'],
    } });
    assert.ok(!malformedReadiness.isError, JSON.stringify(malformedReadiness));
    const malformedReadinessResult = (malformedReadiness.structuredContent as {
      result: { checks: { id: string; status: string }[] } }).result;
    assert.equal(malformedReadinessResult.checks.find(check => check.id === 'studio_operations')?.status, 'unknown');
    const malformedResume = await client.callTool({ name: 'motion_agent_resume', arguments: { sessionId } });
    assert.ok(!malformedResume.isError, JSON.stringify(malformedResume));
    const malformedResumeSessions = (malformedResume.structuredContent as { result: { sessions: {
      features: Record<string, boolean> | null; operations: Record<string, boolean> | null;
    }[] } }).result.sessions;
    assert.equal(malformedResumeSessions[0]?.features?.editorDraft, true);
    assert.equal(malformedResumeSessions[0]?.operations, null);

    const wrongRig = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId: randomUUID() } });
    assert.ok(!wrongRig.isError, JSON.stringify(wrongRig));
    const wrongRigResult = (wrongRig.structuredContent as { result: { status: string; checks: { id: string; status: string }[] } }).result;
    assert.equal(wrongRigResult.status, 'blocked');
    assert.equal(wrongRigResult.checks.find(check => check.id === 'active_rig')?.status, 'blocked');

    const inspectRoleProfile = (profile: RetargetProfile) => {
      queue.heartbeat(sessionId, { activeRig: { id: profile.rigId, name: profile.rigName, rigSignature: profile.rigSignature } });
      const job = queue.enqueue(sessionId, 'inspect', { rigId: profile.rigId });
      assert.equal(queue.poll(sessionId)?.id, job.id);
      queue.complete(sessionId, job.id, true, { id: profile.rigId, retargetProfile: profile });
    };
    const inferredProfile = { ...readyProfile, rigId: randomUUID(), rigName: 'Custom suffix rig', rigType: 'custom' as const,
      rigSignature: 'readiness-custom-inferred-v1', joints: [
        { name: 'hand_L', parent: 'forearm_L', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
        { name: 'forearm_L', parent: 'upper_arm_L', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
        { name: 'upper_arm_L', parent: 'torso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
      ] };
    inspectRoleProfile(inferredProfile);
    const inferredRoles = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId: inferredProfile.rigId, requiredSemanticRoles: ['left_hand'] } });
    assert.ok(!inferredRoles.isError, JSON.stringify(inferredRoles));
    const inferredResult = (inferredRoles.structuredContent as { result: { status: string; checks: { id: string; status: string; evidence?: { roles: { joint?: string; status: string }[] } }[] } }).result;
    assert.equal(inferredResult.status, 'unknown', 'name-only role matches are not treated as confirmed readiness');
    assert.equal(inferredResult.checks.find(check => check.id === 'semantic_rig_roles')?.evidence?.roles[0]?.joint, 'hand_L');

    const ambiguousProfile = { ...inferredProfile, rigId: randomUUID(), rigName: 'Ambiguous custom rig', rigSignature: 'readiness-custom-ambiguous-v1', joints: [
      ...inferredProfile.joints,
      { name: 'LeftHand', parent: 'forearm_L', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    ] };
    inspectRoleProfile(ambiguousProfile);
    const ambiguousRoles = await client.callTool({ name: 'motion_agent_readiness', arguments: { sessionId, rigId: ambiguousProfile.rigId, requiredSemanticRoles: ['left_hand'] } });
    assert.ok(!ambiguousRoles.isError, JSON.stringify(ambiguousRoles));
    const ambiguousResult = (ambiguousRoles.structuredContent as { result: { status: string; checks: { id: string; status: string; evidence?: { roles: { candidates: string[]; status: string }[] } }[] } }).result;
    assert.equal(ambiguousResult.status, 'blocked');
    assert.equal(ambiguousResult.checks.find(check => check.id === 'semantic_rig_roles')?.evidence?.roles[0]?.status, 'ambiguous');
    assert.deepEqual(ambiguousResult.checks.find(check => check.id === 'semantic_rig_roles')?.evidence?.roles[0]?.candidates, ['hand_L', 'LeftHand']);
  } finally { await client.close(); await server.close(); }
});

test('Studio capture preflight is session/rig-bound and rejects stale or inconsistent results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-capture-preflight-'));
  const queue = new Queue();
  const rigId = randomUUID(), sessionId = randomUUID(), rigSignature = 'capture-preflight-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  seedCaptureFocusInspection(queue, sessionId, rigId, rigSignature, ['UpperTorso', 'Head']);
  const server = createMcp(new Library(join(root, 'library')), queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'capture-preflight-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const submitted = await client.callTool({ name: 'motion_studio_capture_preflight', arguments: { sessionId, rigId } });
    assert.ok(!submitted.isError, JSON.stringify(submitted));
    const jobId = (submitted.structuredContent as { result: { jobId: string } }).result.jobId;
    const command = queue.poll(sessionId);
    assert.equal(command?.operation, 'capture_preflight');
    assert.deepEqual(command?.payload, { sessionId, rigId, rigSignature });
    queue.complete(sessionId, jobId, true, { status: 'ready', serviceAvailable: true, permissionGranted: true, canCapture: true,
      drawable: true, viewport: { width: 1920, height: 1080 }, sessionId, rigId, rigSignature,
      note: 'Studio reports that screenshot capture is currently available. This preflight did not take or validate an image.' });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    assert.equal((completed.structuredContent as { result: { result: { status: string }; next: string } }).result.result.status, 'ready');

    const checkPreflightResult = async (captureResult: Record<string, unknown>) => {
      const queued = await client.callTool({ name: 'motion_studio_capture_preflight', arguments: { sessionId, rigId } });
      assert.ok(!queued.isError, JSON.stringify(queued));
      const queuedJobId = (queued.structuredContent as { result: { jobId: string } }).result.jobId;
      assert.equal(queue.poll(sessionId)?.operation, 'capture_preflight');
      queue.complete(sessionId, queuedJobId, true, captureResult);
      return client.callTool({ name: 'motion_studio_job', arguments: { jobId: queuedJobId } });
    };
    const statusBase = { sessionId, rigId, rigSignature, note: 'Fixture preflight status.' };
    const nextFor = (response: Awaited<ReturnType<typeof client.callTool>>) =>
      (response.structuredContent as { result: { next: string } }).result.next;
    const unsupported = await checkPreflightResult({ ...statusBase, status: 'unsupported', serviceAvailable: false, permissionGranted: false, canCapture: false });
    assert.ok(!unsupported.isError, JSON.stringify(unsupported));
    assert.match(nextFor(unsupported), /does not support native screenshot capture.*Do not retry.*unbound reference evidence/i);
    const permissionDenied = await checkPreflightResult({ ...statusBase, status: 'permission_denied', serviceAvailable: true, permissionGranted: false, canCapture: false });
    assert.ok(!permissionDenied.isError, JSON.stringify(permissionDenied));
    assert.match(nextFor(permissionDenied), /permission was not granted.*Do not request permission again.*unless the user chooses/i);
    const unknown = await checkPreflightResult({ ...statusBase, status: 'unknown', serviceAvailable: true, permissionGranted: false,
      canCapture: false, error: 'Permission request failed.' });
    assert.ok(!unknown.isError, JSON.stringify(unknown));
    assert.match(nextFor(unknown), /preflight is unknown: Permission request failed.*restore\/reconnect the Studio plugin/i);
    const temporarilyUnavailable = await checkPreflightResult({ ...statusBase, status: 'temporarily_unavailable', serviceAvailable: true,
      permissionGranted: true, canCapture: false, drawable: true, viewport: { width: 1920, height: 1080 } });
    assert.ok(!temporarilyUnavailable.isError, JSON.stringify(temporarilyUnavailable));
    assert.match(nextFor(temporarilyUnavailable), /temporarily unavailable.*only after Studio\/viewport availability changes/i);
    const contradictoryUnavailable = await checkPreflightResult({ ...statusBase, status: 'temporarily_unavailable', serviceAvailable: true,
      permissionGranted: false, canCapture: false, drawable: false, viewport: { width: 0, height: 0 } });
    assert.equal(contradictoryUnavailable.isError, true);

    const staleSessionId = randomUUID();
    queue.heartbeat(staleSessionId, { activeRig: { id: rigId, rigSignature } });
    const staleSubmission = await client.callTool({ name: 'motion_studio_capture_preflight', arguments: { sessionId: staleSessionId, rigId } });
    assert.ok(!staleSubmission.isError, JSON.stringify(staleSubmission));
    const staleJobId = (staleSubmission.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(staleSessionId)?.operation, 'capture_preflight');
    queue.heartbeat(staleSessionId, { activeRig: { id: randomUUID(), rigSignature: 'different-topology' } });
    queue.complete(staleSessionId, staleJobId, true, { status: 'ready', serviceAvailable: true, permissionGranted: true, canCapture: true,
      drawable: true, viewport: { width: 1920, height: 1080 }, sessionId: staleSessionId, rigId, rigSignature,
      note: 'Ready fixture.' });
    const staleResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: staleJobId } });
    assert.equal(staleResult.isError, true);
    assert.match(JSON.stringify(staleResult), /rig or its topology changed/i);
  } finally { await client.close(); await server.close(); }
});

test('editor draft read/apply is rig-bound, fingerprint-guarded, undoable, and never saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-editor-draft-'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'editor-draft-rig-v1';
  const profile = { version: 1 as const, rigId, rigName: 'Editor draft fixture', rigType: 'R15' as const, rigSignature, joints: [
    { name: 'UpperTorso', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'Head', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
  ] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: profile });
  const baseRecipe = animationPreset('idle', 'Unsaved viewport draft', 2, 1);
  const assetId = fingerprintUuid(fingerprint(baseRecipe));
  const library = new Library(join(root, 'library'));
  await library.saveIdempotent(baseRecipe, assetId, undefined, undefined, undefined, undefined, {
    schemaVersion: 1, sourceRecipeFingerprint: fingerprint(baseRecipe),
    phases: [{ id: 'idle', label: 'main_action', start: 0, end: 1, intent: 'Hold a relaxed idle pose.' }],
    events: [{ name: 'Settle', phaseId: 'idle', progress: 0.5, time: 1, value: 'weight settles' }],
  });
  const reviews = new Reviews(join(root, 'artifacts', 'reviews'), library, queue, new Connections(join(root, '.local', 'providers.json')));
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  const client = new Client({ name: 'editor-draft-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const capturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  let captureChunkPoller: NodeJS.Timeout | undefined;
  const readLoadedSourceRelation = async (sourceFingerprint?: string) => {
    const pending = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!pending.isError, JSON.stringify(pending));
    const jobId = (pending.structuredContent as { result: { jobId: string } }).result.jobId;
    const command = queue.poll(sessionId);
    assert.equal(command?.operation, 'read_editor_draft');
    queue.complete(sessionId, jobId, true, { rigId, rigSignature, assetId, ephemeral: false, dirty: true,
      ...(sourceFingerprint ? { sourceFingerprint } : {}), currentTime: 0.75, recipe: baseRecipe });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    return ((completed.structuredContent as { result: { result: { loadedSourceRelation: string } } }).result.result).loadedSourceRelation;
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolCatalog = await client.listTools();
    const editorDraftToolDescription = toolCatalog.tools.find(tool => tool.name === 'motion_studio_read_editor_draft')?.description;
    assert.match(editorDraftToolDescription ?? '', /only `exact_current_draft` makes phase\/event\/contact coordinates current draft timing/i);
    const read = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!read.isError, JSON.stringify(read));
    const readJobId = (read.structuredContent as { result: { jobId: string } }).result.jobId;
    const readCommand = queue.poll(sessionId);
    assert.equal(readCommand?.operation, 'read_editor_draft');
    assert.deepEqual(readCommand?.payload, { rigId, rigSignature });
    queue.complete(sessionId, readJobId, true, { rigId, rigSignature, assetId, ephemeral: false, dirty: true,
      sourceFingerprint: 'f'.repeat(64), currentTime: 0.75, recipe: baseRecipe });
    const readResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: readJobId } });
    assert.ok(!readResult.isError, JSON.stringify(readResult));
    type EditorDraftResult = { result: { result: { recipe: AnimationRecipe; draftFingerprint: string; sourceFingerprint?: string;
      loadedSourceRelation: 'matches_loaded_source' | 'modified_since_loaded_source' | 'unknown'; dirty: boolean; next: string;
      authoringIntentTimingRelation: 'exact_current_recipe' | 'historical_reference' | 'unavailable';
      editorAuthoringIntent?: { sourceRecipeFingerprint: string; timingRelation: 'exact_current_draft' | 'loaded_source_only' | 'historical_only';
        phases: { intent?: string }[]; events?: { name: string; time: number }[]; limitation: string };
      editorInsights: { source: string; recipeFingerprint: string; summary: { tracks: number; keys: number }; phaseMap: { total: number; omittedCount: number; items: Array<{
          activeChannels: { joint: string }[]; contacts: unknown[]; poseProgression: { basis: string; sampleRateHz: number; jointCount: number;
            omittedJointCount: number; joints: { joint: string; peakRotationFromEntryDegrees: number; peakRotationTime: number }[] } }> };
        detailCoverage: Record<string, { included?: number; total?: number; omitted?: number; includedPerDimension?: number;
          totalPerDimension?: number; omittedPerDimension?: number } | null>; requiresExpandedEvaluation: boolean;
        topAngularMotion: { joint: string }[]; refinementCues: Array<{ signal: string; measurementProvenance: { sampleRateHz: number; derivativeOrder: number;
          sampleWindow: { startTime: number; endTime: number }; crossedBoundaries: unknown[] }; phaseContext: { label: string };
          interpretation: { issueStatus: string; requiresVisualDecision: boolean }; repairOptions: { operation: string }[] }>;
        coordination: { basis: string; sampleRateHz: number; phaseLagWindowSeconds: number; angular: { activeJointCount: number;
          synchronizedPeakGroups: { joints: string[] }[]; largestOnsetLags: { earlierJoint: string; laterJoint: string; lagSeconds: number }[];
          largestPeakLags: { earlierJoint: string; laterJoint: string; lagSeconds: number }[] }; interpretation: string };
        composedCoordination: { basis: string; sampleRateHz: number; uniformSampleCount: number; uniformSampleCapped: boolean;
          position: { activeJointCount: number }; angular: { activeJointCount: number }; interpretation: string };
        structuralAdvisories: { total: number; items: unknown[] }; limitations: string; targetedPatchApplyBinding: string } } } };
    const snapshot = (readResult.structuredContent as EditorDraftResult).result.result;
    assert.deepEqual(snapshot.recipe, baseRecipe);
    assert.equal(snapshot.draftFingerprint, fingerprint(baseRecipe));
    assert.equal(snapshot.sourceFingerprint, 'f'.repeat(64));
    assert.equal(snapshot.loadedSourceRelation, 'modified_since_loaded_source');
    assert.equal(snapshot.dirty, true);
    assert.equal(snapshot.authoringIntentTimingRelation, 'exact_current_recipe');
    assert.equal(snapshot.editorAuthoringIntent?.timingRelation, 'exact_current_draft');
    assert.equal(snapshot.editorAuthoringIntent?.events?.[0]?.time, 1);
    assert.match(snapshot.editorAuthoringIntent?.limitation ?? '', /only when timingRelation is exact_current_draft/i);
    assert.equal(await readLoadedSourceRelation(fingerprint(baseRecipe)), 'matches_loaded_source');
    assert.equal(await readLoadedSourceRelation('f'.repeat(64)), 'modified_since_loaded_source');
    assert.equal(await readLoadedSourceRelation(), 'unknown');
    const changedDraft = { ...baseRecipe, name: 'Manually revised idle' };
    const staleIntentRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!staleIntentRead.isError, JSON.stringify(staleIntentRead));
    const staleIntentJobId = (staleIntentRead.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, staleIntentJobId, true, { rigId, rigSignature, assetId: randomUUID(), parentAssetId: assetId,
      ephemeral: true, dirty: true, sourceFingerprint: fingerprint(baseRecipe), currentTime: 0.75, recipe: changedDraft });
    const staleIntentResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: staleIntentJobId } });
    assert.ok(!staleIntentResult.isError, JSON.stringify(staleIntentResult));
    const staleIntent = (staleIntentResult.structuredContent as EditorDraftResult).result.result.editorAuthoringIntent;
    assert.equal(staleIntent?.timingRelation, 'loaded_source_only');
    assert.equal((staleIntentResult.structuredContent as EditorDraftResult).result.result.authoringIntentTimingRelation, 'historical_reference');
    const historicalIntentRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!historicalIntentRead.isError, JSON.stringify(historicalIntentRead));
    const historicalIntentJobId = (historicalIntentRead.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, historicalIntentJobId, true, { rigId, rigSignature, assetId: randomUUID(), parentAssetId: assetId,
      ephemeral: true, dirty: true, sourceFingerprint: 'f'.repeat(64), currentTime: 0.75, recipe: changedDraft });
    const historicalIntentResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: historicalIntentJobId } });
    assert.ok(!historicalIntentResult.isError, JSON.stringify(historicalIntentResult));
    const historicalIntent = (historicalIntentResult.structuredContent as EditorDraftResult).result.result.editorAuthoringIntent;
    assert.equal(historicalIntent?.timingRelation, 'historical_only');
    assert.equal((historicalIntentResult.structuredContent as EditorDraftResult).result.result.authoringIntentTimingRelation, 'historical_reference');
    const noIntentRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!noIntentRead.isError, JSON.stringify(noIntentRead));
    const noIntentJobId = (noIntentRead.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, noIntentJobId, true, { rigId, rigSignature, assetId: randomUUID(), ephemeral: true, dirty: true,
      currentTime: 0.75, recipe: changedDraft });
    const noIntentResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: noIntentJobId } });
    assert.ok(!noIntentResult.isError, JSON.stringify(noIntentResult));
    const noIntentSnapshot = (noIntentResult.structuredContent as EditorDraftResult).result.result;
    assert.equal(noIntentSnapshot.authoringIntentTimingRelation, 'unavailable');
    assert.equal(noIntentSnapshot.editorAuthoringIntent, undefined);
    assert.match(snapshot.next, /viewport-only.*never saves or exports/i);
    assert.match(snapshot.next, /expectedLoadedSourceFingerprint=.*plugin rejects any changed editor recipe, loaded source, or rig/i);
    assert.match(snapshot.next, /candidate_patch_preview.*preserve guards.*apply_editor_candidate/i);
    assert.match(snapshot.editorInsights.targetedPatchApplyBinding, /patchPreview: \{ candidateFingerprint, operations, preserve \}.*copied unchanged/i);
    assert.equal(snapshot.editorInsights.source, 'recipe_only');
    assert.equal(snapshot.editorInsights.recipeFingerprint, snapshot.draftFingerprint);
    assert.equal(snapshot.editorInsights.summary.tracks, baseRecipe.tracks.length);
    assert.ok(snapshot.editorInsights.summary.keys > 0);
    assert.equal(snapshot.editorInsights.phaseMap.total, 1);
    assert.equal(snapshot.editorInsights.detailCoverage.phaseMap?.omitted, snapshot.editorInsights.phaseMap.omittedCount);
    assert.ok(snapshot.editorInsights.phaseMap.items.length <= 16);
    const phaseProgression = snapshot.editorInsights.phaseMap.items[0]!.poseProgression;
    assert.equal(phaseProgression.sampleRateHz, 30);
    assert.equal(phaseProgression.jointCount, 2);
    assert.equal(phaseProgression.omittedJointCount, 0);
    assert.deepEqual(new Set(phaseProgression.joints.map(joint => joint.joint)), new Set(['Head', 'UpperTorso']));
    assert.match(phaseProgression.basis, /Composed local joint transforms.*No parent hierarchy, world-space trajectory/i);
    assert.ok(phaseProgression.joints.every(joint => Number.isFinite(joint.peakRotationTime)
      && joint.peakRotationTime >= 0 && joint.peakRotationTime <= baseRecipe.duration));
    assert.ok(snapshot.editorInsights.topAngularMotion.some(item => item.joint === 'Head'));
    assert.ok(snapshot.editorInsights.refinementCues.length > 0);
    assert.ok(snapshot.editorInsights.refinementCues.every(cue => cue.measurementProvenance.sampleRateHz === 30
      && cue.measurementProvenance.derivativeOrder >= 1 && cue.measurementProvenance.derivativeOrder <= 3
      && cue.measurementProvenance.sampleWindow.startTime <= cue.measurementProvenance.sampleWindow.endTime
      && cue.interpretation.issueStatus === 'unclassified' && cue.interpretation.requiresVisualDecision
      && cue.repairOptions.length > 0));
    assert.match(snapshot.editorInsights.coordination.basis, /Independent base-track local channels only/);
    assert.equal(snapshot.editorInsights.coordination.sampleRateHz, 30);
    assert.equal(snapshot.editorInsights.coordination.angular.activeJointCount, 2);
    assert.ok(snapshot.editorInsights.coordination.angular.largestPeakLags.some(lag => lag.lagSeconds > 0),
      'the editor digest should expose measurable stagger between independently authored joints');
    assert.match(snapshot.editorInsights.coordination.interpretation, /do not infer hierarchy\/world motion, artistic intent, or whether synchronization is good or bad/i);
    assert.match(snapshot.editorInsights.composedCoordination.basis, /after base tracks, enabled weighted layers.*root-motion/i);
    assert.equal(snapshot.editorInsights.composedCoordination.sampleRateHz, 30);
    assert.equal(snapshot.editorInsights.composedCoordination.uniformSampleCount, 61);
    assert.equal(snapshot.editorInsights.composedCoordination.uniformSampleCapped, false);
    assert.ok(snapshot.editorInsights.composedCoordination.angular.activeJointCount > 0);
    assert.ok(snapshot.editorInsights.detailCoverage.composedCoordination);
    assert.match(snapshot.editorInsights.composedCoordination.interpretation, /resultant local trajectories/i);
    assert.ok(snapshot.editorInsights.structuralAdvisories.total >= snapshot.editorInsights.structuralAdvisories.items.length);
    assert.match(snapshot.editorInsights.limitations, /does not see rendered geometry/);
    const anyInsightOmissions = Object.values(snapshot.editorInsights.detailCoverage).some(coverage => coverage !== null
      && ((coverage.omitted ?? 0) > 0 || (coverage.omittedPerDimension ?? 0) > 0));
    assert.equal(snapshot.editorInsights.requiresExpandedEvaluation, anyInsightOmissions);

    const staleCapture = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: '0'.repeat(64), expectedDraftRecipe: snapshot.recipe, jointMap: {},
      frames: [{ time: 0, view: 'front' }, { time: 1, view: 'side' }],
    } });
    assert.equal(staleCapture.isError, true);
    assert.match(JSON.stringify(staleCapture), /does not match expectedDraftFingerprint/);
    const changedSourceCapture = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      expectedLoadedSourceFingerprint: snapshot.sourceFingerprint, jointMap: {}, frames: [{ time: 0, view: 'front' }],
    } });
    assert.ok(!changedSourceCapture.isError, JSON.stringify(changedSourceCapture));
    const changedSourceJobId = (changedSourceCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const changedSourceCommand = queue.poll(sessionId);
    assert.equal(changedSourceCommand?.operation, 'capture_editor_draft_views');
    const changedSourcePayload = changedSourceCommand?.payload as { assetId: string; assetFingerprint: string };
    queue.complete(sessionId, changedSourceJobId, true, { assetId: changedSourcePayload.assetId, rigId, sessionId, complete: true,
      loadedSourceFingerprint: 'e'.repeat(64), note: 'changed source fixture', frames: [{ captureId: randomUUID(), sessionId,
        assetId: changedSourcePayload.assetId, assetFingerprint: changedSourcePayload.assetFingerprint, rigId, rigSignature, time: 0,
        view: 'front', appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}), byteCount: 128, chunks: 1, width: 960, height: 540, note: 'fixture' }] });
    const changedSourceOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: changedSourceJobId } });
    assert.equal(changedSourceOutcome.isError, true);
    assert.match(JSON.stringify(changedSourceOutcome), /did not confirm the expected loaded animation source remained unchanged/i);

    const capture = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      expectedLoadedSourceFingerprint: snapshot.sourceFingerprint, jointMap: {},
      frames: [{ time: 0, view: 'front' }, { time: 1, view: 'side' }],
    } });
    assert.ok(!capture.isError, JSON.stringify(capture));
    const captureJobId = (capture.structuredContent as { result: { jobId: string } }).result.jobId;
    const captureCommand = queue.poll(sessionId);
    assert.equal(captureCommand?.operation, 'capture_editor_draft_views');
    const capturePayload = captureCommand?.payload as { assetId: string; editorAssetId: string; assetFingerprint: string; expectedDraftFingerprint: string;
      expectedLoadedSourceFingerprint: string;
      expectedDraftRecipe: AnimationRecipe; ephemeralCandidate: boolean };
    assert.equal(capturePayload.editorAssetId, assetId);
    assert.equal(capturePayload.assetFingerprint, snapshot.draftFingerprint);
    assert.equal(capturePayload.expectedDraftFingerprint, snapshot.draftFingerprint);
    assert.equal(capturePayload.expectedLoadedSourceFingerprint, snapshot.sourceFingerprint);
    assert.deepEqual(capturePayload.expectedDraftRecipe, snapshot.recipe);
    assert.equal(capturePayload.ephemeralCandidate, true);
    const captureId = randomUUID();
    const captureAssetId = capturePayload.assetId;
    queue.complete(sessionId, captureJobId, true, { assetId: captureAssetId, rigId, sessionId, complete: true,
      loadedSourceFingerprint: snapshot.sourceFingerprint, note: 'fixture capture', frames: [
      { captureId, sessionId, assetId: captureAssetId, assetFingerprint: snapshot.draftFingerprint, rigId, rigSignature, time: 0,
        view: 'front', appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}), byteCount: capturePng.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
      { captureId: randomUUID(), sessionId, assetId: captureAssetId, assetFingerprint: snapshot.draftFingerprint, rigId, rigSignature, time: 1,
        view: 'side', appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}), byteCount: capturePng.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
    ] });
    const captureOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: captureJobId } });
    assert.ok(!captureOutcome.isError, JSON.stringify(captureOutcome));
    const captured = (captureOutcome.structuredContent as { result: { result: { candidate: boolean; candidateFingerprint: string; frames: unknown[] } } }).result.result;
    assert.equal(captured.candidate, true);
    assert.equal(captured.candidateFingerprint, snapshot.draftFingerprint);
    assert.equal(captured.frames.length, 2);
    captureChunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const chunkCommand = queue.poll(sessionId);
      if (!chunkCommand || chunkCommand.operation !== 'capture_chunk') return;
      const chunkPayload = chunkCommand.payload as { captureId: string; index: number };
      queue.complete(sessionId, chunkCommand.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: capturePng.toString('hex') });
    }, 2);
    const draftImage = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId } });
    assert.ok(!draftImage.isError, JSON.stringify(draftImage));
    const draftImageReview = draftImage.structuredContent as { result: { editorDraftFingerprint?: string;
      editorLoadedSourceFingerprint?: string; loadedSourceRelation?: string };
      reviewCapture: { captureBatchId?: string; captureSource?: string; editorLoadedSourceFingerprint?: string; loadedSourceRelation?: string };
      visualReviewTemplate: { source: string; editorDraftFingerprint?: string; editorLoadedSourceFingerprint?: string;
        loadedSourceRelation?: string; nextStep: string; protocol: string } };
    assert.equal(draftImageReview.result.editorDraftFingerprint, snapshot.draftFingerprint);
    assert.equal(draftImageReview.result.editorLoadedSourceFingerprint, snapshot.sourceFingerprint);
    assert.equal(draftImageReview.result.loadedSourceRelation, 'modified_since_loaded_source');
    assert.equal(draftImageReview.reviewCapture.loadedSourceRelation, 'modified_since_loaded_source');
    assert.equal(draftImageReview.visualReviewTemplate.source, 'open_editor_draft');
    assert.equal(draftImageReview.visualReviewTemplate.editorDraftFingerprint, snapshot.draftFingerprint);
    assert.equal(draftImageReview.visualReviewTemplate.editorLoadedSourceFingerprint, snapshot.sourceFingerprint);
    assert.equal(draftImageReview.visualReviewTemplate.loadedSourceRelation, 'modified_since_loaded_source');
    assert.match(draftImageReview.visualReviewTemplate.protocol,
      /absence of warnings does not prove.*legible.*mark the observation unclear.*preflight.*never guess/i);
    assert.match(draftImageReview.visualReviewTemplate.nextStep, /read_editor_draft again.*candidate_patch_preview.*preserve guards.*apply_editor_candidate/i);
    const sourceReviewId = randomUUID();
    const sourceReview: ReviewRecord = { id: sourceReviewId, revision: 1, createdAt: new Date().toISOString(), assetId,
      assetHash: fingerprint(baseRecipe), assetName: baseRecipe.name, rigSignature,
      status: 'needs_feedback', request: { assetId, sessionId, rigId, motionMode: 'unknown', preview: false, aiReview: false },
      report: { source: 'recipe_only', metrics: [], findings: [], questions: [], limitations: [] }, images: [] };
    await mkdir(join(root, 'artifacts', 'reviews', sourceReviewId), { recursive: true });
    await writeFile(join(root, 'artifacts', 'reviews', sourceReviewId, '000001.json'), JSON.stringify(sourceReview));
    const attachedSourceCapture = await client.callTool({ name: 'motion_review_attach_capture', arguments: { reviewId: sourceReviewId, revision: 1,
      sessionId, capture: draftImageReview.reviewCapture } });
    assert.ok(!attachedSourceCapture.isError, JSON.stringify(attachedSourceCapture));
    const sourceReviewRead = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: sourceReviewId } });
    assert.ok(!sourceReviewRead.isError, JSON.stringify(sourceReviewRead));
    const sourceReviewEvidence = sourceReviewRead.structuredContent as { result: { images: { captureBinding?: {
      captureBatchId?: string; captureSource?: string; editorDraftFingerprint?: string; editorLoadedSourceFingerprint?: string; loadedSourceRelation?: string } }[];
      visualEvidenceAudit: { images: { captureBatchId?: string; captureSource?: string; editorDraftFingerprint?: string;
        editorLoadedSourceFingerprint?: string; loadedSourceRelation?: string }[] } } };
    const persistedCaptureBinding = sourceReviewEvidence.result.images[0]?.captureBinding;
    assert.equal(persistedCaptureBinding?.captureBatchId, draftImageReview.reviewCapture.captureBatchId);
    assert.equal(persistedCaptureBinding?.captureSource, 'editor_draft');
    assert.equal(sourceReviewEvidence.result.visualEvidenceAudit.images[0]?.captureBatchId, draftImageReview.reviewCapture.captureBatchId);
    assert.equal(sourceReviewEvidence.result.visualEvidenceAudit.images[0]?.captureSource, 'editor_draft');
    assert.equal(persistedCaptureBinding?.editorDraftFingerprint, snapshot.draftFingerprint);
    assert.equal(persistedCaptureBinding?.editorLoadedSourceFingerprint, snapshot.sourceFingerprint);
    assert.equal(persistedCaptureBinding?.loadedSourceRelation, 'modified_since_loaded_source');
    assert.equal(sourceReviewEvidence.result.visualEvidenceAudit.images[0]?.loadedSourceRelation, 'modified_since_loaded_source');
    const forgedLoadedSourceAttach = await client.callTool({ name: 'motion_review_attach_capture', arguments: { reviewId: randomUUID(), revision: 1, sessionId,
      capture: { ...draftImageReview.reviewCapture, editorLoadedSourceFingerprint: 'e'.repeat(64) } } });
    assert.equal(forgedLoadedSourceAttach.isError, true);
    assert.match(JSON.stringify(forgedLoadedSourceAttach), /server-verified captureId, loaded-source provenance/i);
    const forgedCaptureBatchAttach = await client.callTool({ name: 'motion_review_attach_capture', arguments: { reviewId: randomUUID(), revision: 1, sessionId,
      capture: { ...draftImageReview.reviewCapture, captureBatchId: randomUUID() } } });
    assert.equal(forgedCaptureBatchAttach.isError, true);
    assert.match(JSON.stringify(forgedCaptureBatchAttach), /server-verified captureId, loaded-source provenance/i);
    const forgedCaptureSourceAttach = await client.callTool({ name: 'motion_review_attach_capture', arguments: { reviewId: randomUUID(), revision: 1, sessionId,
      capture: { ...draftImageReview.reviewCapture, captureSource: 'candidate' } } });
    assert.equal(forgedCaptureSourceAttach.isError, true);
    assert.match(JSON.stringify(forgedCaptureSourceAttach), /server-verified captureId, loaded-source provenance/i);
    clearInterval(captureChunkPoller);
    captureChunkPoller = undefined;

    const autoCapture = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      expectedLoadedSourceFingerprint: snapshot.sourceFingerprint, jointMap: {}, views: ['front'], maxFrames: 4,
      priorityTimes: [0.15, 0.35, 0.65, 0.85].map(progress => snapshot.recipe.duration * progress),
    } });
    assert.ok(!autoCapture.isError, JSON.stringify(autoCapture));
    const autoCaptureJobId = (autoCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const autoCaptureCommand = queue.poll(sessionId);
    assert.equal(autoCaptureCommand?.operation, 'capture_editor_draft_views');
    const autoPayload = autoCaptureCommand?.payload as { assetId: string; assetFingerprint: string;
      frames: { time: number; view: 'front' | 'side' | 'back' | 'three_quarter' | 'overhead' }[];
      editorAssetId: string; expectedLoadedSourceFingerprint: string; rigSignature: string; jointMap: Record<string, string>;
      capturePlan: { frames: { time: number; view: string }[]; moments: { time: number; reasons: string[] }[];
        jointMapFingerprint: string; priorityTimeCoverage: { requested: number[]; scheduled: number[]; omitted: number[];
          followUpBatches: { time: number; view: string }[][] } } };
    assert.ok(autoPayload.capturePlan);
    assert.deepEqual(autoPayload.frames, autoPayload.capturePlan.frames);
    assert.ok(autoPayload.capturePlan.moments.length >= 2);
    assert.ok(autoPayload.capturePlan.moments.every(moment => moment.reasons.length > 0));
    assert.ok(autoPayload.capturePlan.priorityTimeCoverage.omitted.length > 0);
    assert.deepEqual(autoPayload.capturePlan.priorityTimeCoverage.followUpBatches.flat(),
      autoPayload.capturePlan.priorityTimeCoverage.omitted.map(time => ({ time, view: 'front' })));
    queue.complete(sessionId, autoCaptureJobId, true, { assetId: autoPayload.assetId, rigId, sessionId, complete: true,
      loadedSourceFingerprint: snapshot.sourceFingerprint,
      note: 'fixture auto-planned capture', frames: autoPayload.frames.map(frame => ({ captureId: randomUUID(), sessionId,
        assetId: autoPayload.assetId, assetFingerprint: autoPayload.assetFingerprint, rigId, rigSignature, time: frame.time,
        view: frame.view, appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}), byteCount: 128, chunks: 1, width: 960, height: 540, note: 'fixture' })) });
    const autoOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: autoCaptureJobId } });
    assert.ok(!autoOutcome.isError, JSON.stringify(autoOutcome));
    const autoCaptured = (autoOutcome.structuredContent as { result: { result: { capturePlan: typeof autoPayload.capturePlan;
      frames: { time: number; view: string }[]; complete: boolean; next: string } } }).result.result;
    assert.equal(autoCaptured.complete, true);
    assert.deepEqual(autoCaptured.capturePlan, autoPayload.capturePlan);
    assert.deepEqual(autoCaptured.frames.map(frame => ({ time: frame.time, view: frame.view })), autoPayload.frames);
    assert.match(autoCaptured.next, /priority intent frames remain.*priorityTimeCoverage\.followUpBatches.*expectedDraftFingerprint.*expectedLoadedSourceFingerprint.*expectedJointMapFingerprint.*expectedRigSignature/is,
      'AI handoff must carry the exact editor draft, source, map, and rig guards into omitted-intent retries');
    for (const followUpFrames of autoPayload.capturePlan.priorityTimeCoverage.followUpBatches) {
      const editorFollowUp = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
        sessionId, rigId, assetId: autoPayload.editorAssetId, expectedDraftFingerprint: snapshot.draftFingerprint,
        expectedDraftRecipe: snapshot.recipe, expectedLoadedSourceFingerprint: autoPayload.expectedLoadedSourceFingerprint,
        expectedJointMapFingerprint: autoPayload.capturePlan.jointMapFingerprint, expectedRigSignature: autoPayload.rigSignature,
        jointMap: autoPayload.jointMap, frames: followUpFrames,
      } });
      assert.ok(!editorFollowUp.isError, JSON.stringify(editorFollowUp));
      const editorFollowUpJobId = (editorFollowUp.structuredContent as { result: { jobId: string } }).result.jobId;
      const editorFollowUpCommand = queue.poll(sessionId);
      assert.equal(editorFollowUpCommand?.operation, 'capture_editor_draft_views');
      const editorFollowUpPayload = editorFollowUpCommand?.payload as { assetId: string; assetFingerprint: string; rigSignature: string;
        expectedLoadedSourceFingerprint: string; jointMap: Record<string, string>; frames: { time: number; view: string }[] };
      assert.deepEqual(editorFollowUpPayload.frames, followUpFrames);
      assert.equal(editorFollowUpPayload.assetFingerprint, snapshot.draftFingerprint);
      assert.equal(editorFollowUpPayload.expectedLoadedSourceFingerprint, snapshot.sourceFingerprint);
      assert.deepEqual(editorFollowUpPayload.jointMap, {});
      queue.complete(sessionId, editorFollowUpCommand!.id, true, { assetId: editorFollowUpPayload.assetId, rigId, sessionId, complete: true,
        loadedSourceFingerprint: snapshot.sourceFingerprint, note: 'fixture omitted-intent follow-up', frames: followUpFrames.map(frame => ({
          captureId: randomUUID(), sessionId, assetId: editorFollowUpPayload.assetId, assetFingerprint: snapshot.draftFingerprint,
          rigId, rigSignature: editorFollowUpPayload.rigSignature, ...frame, appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}),
          byteCount: 128, chunks: 1, width: 960, height: 540, note: 'fixture follow-up frame' })) });
      const editorFollowUpOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: editorFollowUpJobId } });
      assert.ok(!editorFollowUpOutcome.isError, JSON.stringify(editorFollowUpOutcome));
      const editorFollowUpResult = (editorFollowUpOutcome.structuredContent as { result: { result: { captureCoverage: {
        status: string; requestedFrames: { time: number; view: string }[] } } } }).result.result;
      assert.equal(editorFollowUpResult.captureCoverage.status, 'complete');
      assert.deepEqual(editorFollowUpResult.captureCoverage.requestedFrames, followUpFrames);
    }

    const partialEditorCapture = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      expectedLoadedSourceFingerprint: snapshot.sourceFingerprint, expectedRigSignature: rigSignature, jointMap: {},
      frames: [{ time: 0, view: 'front' }, { time: snapshot.recipe.duration, view: 'front' }],
    } });
    assert.ok(!partialEditorCapture.isError, JSON.stringify(partialEditorCapture));
    const partialEditorJobId = (partialEditorCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const partialEditorCommand = queue.poll(sessionId);
    assert.equal(partialEditorCommand?.operation, 'capture_editor_draft_views');
    const partialEditorPayload = partialEditorCommand?.payload as { assetId: string; assetFingerprint: string; rigSignature: string };
    queue.complete(sessionId, partialEditorCommand!.id, true, { assetId: partialEditorPayload.assetId, rigId, sessionId, complete: false,
      loadedSourceFingerprint: snapshot.sourceFingerprint, failedIndex: 2, error: 'fixture transient capture failure', note: 'partial editor capture',
      frames: [{ captureId: randomUUID(), sessionId, assetId: partialEditorPayload.assetId, assetFingerprint: snapshot.draftFingerprint,
        rigId, rigSignature: partialEditorPayload.rigSignature, time: 0, view: 'front', appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}),
        byteCount: 128, chunks: 1, width: 960, height: 540, note: 'first frame succeeded' }] });
    const partialEditorOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: partialEditorJobId } });
    assert.ok(!partialEditorOutcome.isError, JSON.stringify(partialEditorOutcome));
    const partialEditorResult = (partialEditorOutcome.structuredContent as { result: { result: { next: string;
      captureCoverage: { status: string; missingFrames: { time: number; view: string }[] } } } }).result.result;
    assert.equal(partialEditorResult.captureCoverage.status, 'partial');
    assert.match(partialEditorResult.next, /retry only captureCoverage\.missingFrames with motion_studio_capture_editor_draft_views.*expectedDraftFingerprint.*expectedLoadedSourceFingerprint.*expectedJointMapFingerprint.*expectedRigSignature/is,
      'partial editor retries must use the editor-draft endpoint and retain source/draft/map/rig guards');
    const editorRetryFrames = partialEditorResult.captureCoverage.missingFrames;
    const editorRetry = await client.callTool({ name: 'motion_studio_capture_editor_draft_views', arguments: {
      sessionId, rigId, assetId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      expectedLoadedSourceFingerprint: snapshot.sourceFingerprint, expectedJointMapFingerprint: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      expectedRigSignature: rigSignature, jointMap: {}, frames: editorRetryFrames,
    } });
    assert.ok(!editorRetry.isError, JSON.stringify(editorRetry));
    const editorRetryJobId = (editorRetry.structuredContent as { result: { jobId: string } }).result.jobId;
    const editorRetryCommand = queue.poll(sessionId);
    assert.equal(editorRetryCommand?.operation, 'capture_editor_draft_views');
    const editorRetryPayload = editorRetryCommand?.payload as { assetId: string; rigSignature: string };
    queue.complete(sessionId, editorRetryCommand!.id, true, { assetId: editorRetryPayload.assetId, rigId, sessionId, complete: true,
      loadedSourceFingerprint: snapshot.sourceFingerprint, note: 'editor retry succeeded', frames: editorRetryFrames.map(frame => ({
        captureId: randomUUID(), sessionId, assetId: editorRetryPayload.assetId, assetFingerprint: snapshot.draftFingerprint, rigId,
        rigSignature: editorRetryPayload.rigSignature, ...frame, appliedJointMap: resolvedCaptureJointMap(snapshot.recipe, {}),
        byteCount: 128, chunks: 1, width: 960, height: 540, note: 'retried frame' })) });
    const editorRetryOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: editorRetryJobId } });
    assert.ok(!editorRetryOutcome.isError, JSON.stringify(editorRetryOutcome));
    assert.equal(((editorRetryOutcome.structuredContent as { result: { result: { captureCoverage: { status: string } } } }).result.result).captureCoverage.status, 'complete');

    const patchOperations = [{ operation: 'insert_key' as const, joint: 'Head', time: 0.75, rotation: [0, 10, 0] as [number, number, number] }];
    const preserve = [{ joint: 'Head', startTime: 0, endTime: 0.5 }];
    const patchPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: snapshot.recipe, expectedSourceFingerprint: snapshot.draftFingerprint, operations: patchOperations, preserve,
    } });
    assert.ok(!patchPreview.isError, JSON.stringify(patchPreview));
    const patchedDraft = (patchPreview.structuredContent as { result: { saved: boolean; sourceFingerprint: string;
      candidateFingerprint: string; recipe: AnimationRecipe; changes: unknown[];
      channelImpact: { changedChannelCount: number; channels: { identity: { joint: string }; expectation: string; status: string }[];
        changedChannelsOutsidePatchTargets: unknown[] };
      preservation: { joint: string; maxPositionDrift: number; maxRotationDriftDegrees: number }[] } }).result;
    assert.equal(patchedDraft.saved, false);
    assert.equal(patchedDraft.sourceFingerprint, snapshot.draftFingerprint);
    assert.equal(patchedDraft.candidateFingerprint.length, 64);
    assert.equal(patchedDraft.changes.length, 1);
    assert.equal(patchedDraft.channelImpact.changedChannelCount, 1);
    assert.deepEqual(patchedDraft.channelImpact.channels.map(channel => ({ joint: channel.identity.joint, status: channel.status, expectation: channel.expectation })),
      [{ joint: 'Head', status: 'changed', expectation: 'targeted_by_patch' }]);
    assert.deepEqual(patchedDraft.channelImpact.changedChannelsOutsidePatchTargets, []);
    const rootMotionPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: snapshot.recipe, expectedSourceFingerprint: snapshot.draftFingerprint,
      operations: [{ operation: 'root_motion_set', track: snapshot.recipe.tracks[0] }],
    } });
    assert.ok(!rootMotionPreview.isError, JSON.stringify(rootMotionPreview));
    const rootMotionImpact = (rootMotionPreview.structuredContent as { result: { channelImpact: {
      channels: { identity: { channel: string; joint: string }; expectation: string }[]; changedChannelsOutsidePatchTargets: unknown[];
    } } }).result.channelImpact;
    assert.deepEqual(rootMotionImpact.channels.map(channel => ({ channel: channel.identity.channel, joint: channel.identity.joint, expectation: channel.expectation })),
      [{ channel: 'rootMotion', joint: snapshot.recipe.tracks[0]!.joint, expectation: 'targeted_by_patch' }]);
    assert.deepEqual(rootMotionImpact.changedChannelsOutsidePatchTargets, []);
    const seamRecipe = animationSchema.parse({ ...snapshot.recipe, loop: true, rootMotion: { joint: 'HumanoidRootPart', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.5, position: [0.25, 0, 0], rotation: [0, 0, 0] },
      { time: 1.5, position: [0.75, 0, 0], rotation: [0, 0, 0] },
      { time: snapshot.recipe.duration, position: [1, 0, 0], rotation: [0, 0, 0] },
    ] } });
    const seamPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: seamRecipe, expectedSourceFingerprint: fingerprint(seamRecipe),
      operations: [{ operation: 'smooth_loop_seam', joint: 'HumanoidRootPart' }],
    } });
    assert.ok(!seamPreview.isError, JSON.stringify(seamPreview));
    const seamImpact = (seamPreview.structuredContent as { result: { channelImpact: {
      channels: { identity: { channel: string; joint: string }; expectation: string }[]; changedChannelsOutsidePatchTargets: unknown[];
    } } }).result.channelImpact;
    assert.deepEqual(seamImpact.channels.map(channel => ({ channel: channel.identity.channel, joint: channel.identity.joint, expectation: channel.expectation })),
      [{ channel: 'rootMotion', joint: 'HumanoidRootPart', expectation: 'targeted_by_patch' }]);
    assert.deepEqual(seamImpact.changedChannelsOutsidePatchTargets, []);
    const layeredDraft = structuredClone(snapshot.recipe);
    const impactLayerId = randomUUID();
    layeredDraft.layers = [{ id: impactLayerId, name: 'Impact Layer', blendMode: 'Additive', weight: 1, enabled: true,
      tracks: [structuredClone(snapshot.recipe.tracks[0]!)] }];
    const normalizedLayeredDraft = animationSchema.parse(layeredDraft);
    const layerSettingsPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: normalizedLayeredDraft, expectedSourceFingerprint: fingerprint(normalizedLayeredDraft),
      operations: [{ operation: 'layer_set', layerId: impactLayerId, weight: 0.5 }],
    } });
    assert.ok(!layerSettingsPreview.isError, JSON.stringify(layerSettingsPreview));
    const layerSettingsImpact = (layerSettingsPreview.structuredContent as { result: { channelImpact: {
      changedChannelCount: number; changedLayerCount: number; layerChanges: { layerId: string; expectation: string; before: { weight: number }; after: { weight: number } }[];
    } } }).result.channelImpact;
    assert.equal(layerSettingsImpact.changedChannelCount, 0, 'a weight change should not be mislabeled as changed track key data');
    assert.equal(layerSettingsImpact.changedLayerCount, 1);
    assert.deepEqual(layerSettingsImpact.layerChanges.map(change => ({ layerId: change.layerId, expectation: change.expectation,
      beforeWeight: change.before.weight, afterWeight: change.after.weight })),
    [{ layerId: impactLayerId, expectation: 'targeted_by_patch', beforeWeight: 1, afterWeight: 0.5 }]);
    const firstLayerId = randomUUID(), secondLayerId = randomUUID();
    const stackedDraft = animationSchema.parse({ ...snapshot.recipe, layers: [
      { id: firstLayerId, name: 'First Layer', blendMode: 'Additive', weight: 1, enabled: true, tracks: [structuredClone(snapshot.recipe.tracks[0]!)] },
      { id: secondLayerId, name: 'Second Layer', blendMode: 'Override', weight: 0.75, enabled: true, tracks: [structuredClone(snapshot.recipe.tracks[0]!)] },
    ] });
    const layerMovePreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: stackedDraft, expectedSourceFingerprint: fingerprint(stackedDraft),
      operations: [{ operation: 'layer_move', layerId: secondLayerId, direction: 'up' }],
    } });
    assert.ok(!layerMovePreview.isError, JSON.stringify(layerMovePreview));
    const layerMoveImpact = (layerMovePreview.structuredContent as { result: { channelImpact: {
      layerChanges: { layerId: string; expectation: string; before: { stackIndex: number }; after: { stackIndex: number } }[];
    } } }).result.channelImpact;
    assert.deepEqual(layerMoveImpact.layerChanges.map(change => ({ layerId: change.layerId, expectation: change.expectation,
      beforeIndex: change.before.stackIndex, afterIndex: change.after.stackIndex })).sort((left, right) => left.beforeIndex - right.beforeIndex), [
      { layerId: firstLayerId, expectation: 'structural_consequence', beforeIndex: 0, afterIndex: 1 },
      { layerId: secondLayerId, expectation: 'targeted_by_patch', beforeIndex: 1, afterIndex: 0 },
    ]);
    const markerPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: snapshot.recipe, expectedSourceFingerprint: snapshot.draftFingerprint,
      operations: [{ operation: 'markers_set', markers: [{ name: 'Strike', time: 0.5 }] }],
    } });
    assert.ok(!markerPreview.isError, JSON.stringify(markerPreview));
    const markerImpact = (markerPreview.structuredContent as { result: { channelImpact: {
      changedChannelCount: number; changedMetadataCount: number; metadataChanges: { field: string; expectation: string }[];
    } } }).result.channelImpact;
    assert.equal(markerImpact.changedChannelCount, 0);
    assert.equal(markerImpact.changedMetadataCount, 1);
    assert.deepEqual(markerImpact.metadataChanges, [{ field: 'markers', before: [], after: [{ name: 'Strike', time: 0.5 }], expectation: 'targeted_by_patch' }]);
    assert.equal(patchedDraft.preservation.length, 1);
    assert.equal(patchedDraft.preservation[0]!.joint, 'Head');
    assert.ok(patchedDraft.preservation[0]!.maxPositionDrift <= 0.001);
    assert.ok(patchedDraft.preservation[0]!.maxRotationDriftDegrees <= 0.1);
    assert.match((patchPreview.structuredContent as { result: { next: string } }).result.next, /repeat this exact patch request with that sessionId and rigId.*not an artistic verdict/i);
    const candidate = patchedDraft.recipe;
    const stale = await client.callTool({ name: 'motion_studio_apply_editor_candidate', arguments: {
      sessionId, rigId, expectedDraftFingerprint: '0'.repeat(64), expectedDraftRecipe: baseRecipe, recipe: candidate,
    } });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /does not match expectedDraftFingerprint/);

    const alteredPatchCandidate = structuredClone(candidate);
    alteredPatchCandidate.name = `${alteredPatchCandidate.name} edited after preview`;
    const alteredPatchApply = await client.callTool({ name: 'motion_studio_apply_editor_candidate', arguments: {
      sessionId, rigId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      recipe: alteredPatchCandidate, patchPreview: { candidateFingerprint: patchedDraft.candidateFingerprint,
        operations: patchOperations, preserve },
    } });
    assert.equal(alteredPatchApply.isError, true);
    assert.match(JSON.stringify(alteredPatchApply), /do not match the reviewed patch preview fingerprint/i);
    const callerRecomputedPatchFingerprint = createHash('sha256').update(JSON.stringify({ sourceFingerprint: snapshot.draftFingerprint,
      operations: patchOperations, preserve, recipeFingerprint: fingerprint(alteredPatchCandidate) })).digest('hex');
    const forgedPatchApply = await client.callTool({ name: 'motion_studio_apply_editor_candidate', arguments: {
      sessionId, rigId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe,
      recipe: alteredPatchCandidate, patchPreview: { candidateFingerprint: callerRecomputedPatchFingerprint,
        operations: patchOperations, preserve },
    } });
    assert.equal(forgedPatchApply.isError, true);
    assert.match(JSON.stringify(forgedPatchApply), /do not match the reviewed patch preview fingerprint/i);

    const apply = await client.callTool({ name: 'motion_studio_apply_editor_candidate', arguments: {
      sessionId, rigId, expectedDraftFingerprint: snapshot.draftFingerprint, expectedDraftRecipe: snapshot.recipe, recipe: candidate,
      patchPreview: { candidateFingerprint: patchedDraft.candidateFingerprint, operations: patchOperations, preserve },
    } });
    assert.ok(!apply.isError, JSON.stringify(apply));
    const applyJobId = (apply.structuredContent as { result: { jobId: string } }).result.jobId;
    const applyCommand = queue.poll(sessionId);
    assert.equal(applyCommand?.operation, 'apply_editor_candidate');
    const applyPayload = applyCommand?.payload as { rigSignature: string; expectedDraftFingerprint: string; candidateFingerprint: string; recipe: AnimationRecipe };
    assert.equal(applyPayload.rigSignature, rigSignature);
    assert.equal(applyPayload.expectedDraftFingerprint, snapshot.draftFingerprint);
    assert.equal(applyPayload.candidateFingerprint, fingerprint(candidate));
    assert.deepEqual(applyPayload.recipe, candidate);
    queue.complete(sessionId, applyJobId, true, { applied: true, rigId, rigSignature,
      baseDraftFingerprint: snapshot.draftFingerprint, candidateFingerprint: fingerprint(candidate),
      recipeFingerprint: fingerprint(candidate), saved: false, exportAuthorized: false });
    const applied = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: applyJobId } });
    assert.ok(!applied.isError, JSON.stringify(applied));
    const ack = (applied.structuredContent as { result: { result: { saved: boolean; exportAuthorized: boolean }; next: string } }).result;
    assert.equal(ack.result.saved, false);
    assert.equal(ack.result.exportAuthorized, false);
    assert.match(ack.next, /unsaved, undoable viewport draft/i);
    assert.match(ack.next, /immediately call motion_studio_read_editor_draft.*expectedDraftFingerprint=.*require expectedCandidateRelation=matches_expected_candidate/i);
    assert.match(ack.next, /only after the readback matches.*motion_studio_capture_preflight.*user's choice/i);
    assert.match(ack.next, /motion_studio_capture_candidate_comparison_plan.*exact expectedDraftRecipe and recipe.*timingAlignment.*returned frames.*motion_studio_capture_candidate_comparison.*motion_studio_read_candidate_comparison/i);
    assert.match(ack.next, /user's stated request or brief.*only those exact criteria.*motion_studio_validate_candidate_comparison_review.*does not check the AI's interpretation.*do not invent a rubric/i);
    assert.match(ack.next, /criterion assessed contradicted on the After candidate.*motion_animation_candidate_patch_preview.*visualFinding.*Supported\/unclear criteria are not defects to patch/i);
    assert.match(ack.next, /reread the editor draft and apply only that patch preview's exact recipe\/operations\/preserve binding.*new matched comparison.*Every iteration remains unsaved/i);
    assert.match(ack.next, /motion_studio_capture_editor_draft_views.*isolated clone.*must not alter the live editor/i);
    assert.match(ack.next, /retrieve every comparison image.*inspect the matched PNGs side by side.*stills cannot prove transitions between sampled times/i);

    const verifyRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: {
      sessionId, rigId, expectedDraftFingerprint: fingerprint(candidate),
    } });
    assert.ok(!verifyRead.isError, JSON.stringify(verifyRead));
    const verifyReadJobId = (verifyRead.structuredContent as { result: { jobId: string } }).result.jobId;
    const verifyReadCommand = queue.poll(sessionId);
    assert.equal(verifyReadCommand?.operation, 'read_editor_draft');
    assert.equal((verifyReadCommand?.payload as { expectedDraftFingerprint: string }).expectedDraftFingerprint, fingerprint(candidate));
    queue.complete(sessionId, verifyReadJobId, true, { rigId, rigSignature, assetId, ephemeral: true, dirty: true,
      sourceFingerprint: fingerprint(baseRecipe), currentTime: 0.75, recipe: candidate });
    const verifyReadCompleted = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: verifyReadJobId } });
    assert.ok(!verifyReadCompleted.isError, JSON.stringify(verifyReadCompleted));
    const verifiedDraft = (verifyReadCompleted.structuredContent as { result: { result: {
      draftFingerprint: string; expectedDraftFingerprint: string; expectedCandidateRelation: string; next: string;
    } } }).result.result;
    assert.equal(verifiedDraft.draftFingerprint, fingerprint(candidate));
    assert.equal(verifiedDraft.expectedDraftFingerprint, fingerprint(candidate));
    assert.equal(verifiedDraft.expectedCandidateRelation, 'matches_expected_candidate');
    assert.match(verifiedDraft.next, /confirms exact recipe identity only, not visual quality/i);

    const divergedRecipe = animationSchema.parse({ ...candidate, name: `${candidate.name} newer edit` });
    const divergedRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: {
      sessionId, rigId, expectedDraftFingerprint: fingerprint(candidate),
    } });
    assert.ok(!divergedRead.isError, JSON.stringify(divergedRead));
    const divergedJobId = (divergedRead.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, divergedJobId, true, { rigId, rigSignature, assetId, ephemeral: true, dirty: true,
      sourceFingerprint: fingerprint(baseRecipe), currentTime: 0.75, recipe: divergedRecipe });
    const divergedCompleted = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: divergedJobId } });
    assert.ok(!divergedCompleted.isError, JSON.stringify(divergedCompleted));
    const divergedDraft = (divergedCompleted.structuredContent as { result: { result: {
      expectedCandidateRelation: string; next: string;
    } } }).result.result;
    assert.equal(divergedDraft.expectedCandidateRelation, 'differs_from_expected_candidate');
    assert.match(divergedDraft.next, /Readback verdict=differs_from_expected_candidate/);

    const denseRecipe = animationSchema.parse({ ...baseRecipe, tracks: [...baseRecipe.tracks,
      ...Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(baseRecipe.tracks[0]!), joint: `DigestProbe${index + 1}` }))] });
    const denseRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!denseRead.isError, JSON.stringify(denseRead));
    const denseJobId = (denseRead.structuredContent as { result: { jobId: string } }).result.jobId;
    const denseCommand = queue.poll(sessionId);
    assert.equal(denseCommand?.operation, 'read_editor_draft');
    queue.complete(sessionId, denseJobId, true, { rigId, rigSignature, assetId, ephemeral: false, dirty: true,
      sourceFingerprint: fingerprint(baseRecipe), currentTime: 0.75, recipe: denseRecipe });
    const denseOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: denseJobId } });
    assert.ok(!denseOutcome.isError, JSON.stringify(denseOutcome));
    const denseSnapshot = (denseOutcome.structuredContent as { result: { result: { draftFingerprint: string; next: string;
      editorInsights: { requiresExpandedEvaluation: boolean; detailCoverage: { phasePoseProgressionJoints: { included: number; total: number; omitted: number } } } } } }).result.result;
    assert.equal(denseSnapshot.draftFingerprint, fingerprint(denseRecipe));
    assert.deepEqual(denseSnapshot.editorInsights.detailCoverage.phasePoseProgressionJoints,
      { included: 4, total: 10, omitted: 6 });
    assert.equal(denseSnapshot.editorInsights.requiresExpandedEvaluation, true);
    assert.match(denseSnapshot.next, new RegExp(`motion_animation_candidate_evaluate.*expectedFingerprint=${denseSnapshot.draftFingerprint}.*phaseDetailLimit=16.*candidateFingerprint exactly equals draftFingerprint=${denseSnapshot.draftFingerprint}`));
    const staleExpandedEvaluation = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: denseRecipe, expectedFingerprint: '0'.repeat(64), sessionId, rigId,
    } });
    assert.equal(staleExpandedEvaluation.isError, true);
    assert.match(JSON.stringify(staleExpandedEvaluation), /does not match expectedFingerprint/i);
    assert.equal(queue.poll(sessionId), null, 'a stale expanded audit must fail before any Studio sampling is queued');

    const rootMotionRecipe = animationSchema.parse({ ...baseRecipe, rootMotion: { joint: 'HumanoidRootPart', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [3, 0, 0], rotation: [0, 45, 0] },
      { time: 2, position: [3, 0, 4], rotation: [0, 90, 0] },
    ] } });
    const rootRead = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!rootRead.isError, JSON.stringify(rootRead));
    const rootReadJobId = (rootRead.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, rootReadJobId, true, { rigId, rigSignature, assetId, ephemeral: false, dirty: true,
      sourceFingerprint: fingerprint(baseRecipe), currentTime: 0, recipe: rootMotionRecipe });
    const rootReadResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: rootReadJobId } });
    assert.ok(!rootReadResult.isError, JSON.stringify(rootReadResult));
    const rootInsights = (rootReadResult.structuredContent as { result: { result: { editorInsights: {
      rootMotionTrajectory: { netLocalDisplacement: number[]; authoredPolylineLength: number; straightnessRatio: number; basis: string };
      limitations: string;
    } } } }).result.result.editorInsights;
    assert.deepEqual(rootInsights.rootMotionTrajectory.netLocalDisplacement, [3, 0, 4]);
    assert.equal(rootInsights.rootMotionTrajectory.authoredPolylineLength, 7);
    assert.equal(rootInsights.rootMotionTrajectory.straightnessRatio, 5 / 7);
    assert.match(rootInsights.rootMotionTrajectory.basis, /Not hierarchy-composed world-space/i);
    assert.match(rootInsights.limitations, /rootMotionTrajectory.*not a hierarchy-composed world-space path/i);
  } finally { if (captureChunkPoller) clearInterval(captureChunkPoller); await client.close(); await server.close(); }
});

test('blueprint commit binds a live rig profile, validates driven joints, and retries idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-blueprint-rig-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'blueprint-target-rig-v1';
  const retargetProfile = { version: 1, rigId, rigName: 'Blueprint Fixture', rigType: 'R15' as const, rigSignature,
    joints: [
      { name: 'Root', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'RightUpperArm', parent: 'Root', driven: true, targetKind: 'Motor6D' as const,
        basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    ] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const saveApp = new MotionApp('a'.repeat(64), library, queue, new Connections(join(root, '.local', 'providers.json')), root);
  const bridge = await startBridge(queue, 'blueprint-save-token', 0, { library, app: saveApp, files: {} });
  const client = new Client({ name: 'blueprint-rig-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const blueprintInput = { name: 'Rig-bound blueprint', duration: 1, sessionId, rigId,
    phases: [{ id: 'action', label: 'main_action', start: 0, end: 1, intent: 'The arm winds up, then releases.' }],
    poses: [{ phaseId: 'action', progress: 0.5, joint: 'RightUpperArm', rotation: [-45, 0, 0] }] };
  const persistedBlueprintInput = { ...blueprintInput,
    events: [{ name: 'Release', phaseId: 'action', progress: 0.75, value: 'arrow_release' }],
    contacts: [{ effector: 'RightUpperArm', kind: 'grip' as const, phaseId: 'action', startProgress: 0.2, endProgress: 0.7 }] };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const preview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: persistedBlueprintInput });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const offlineReview = (preview.structuredContent as { result: { blueprint: { phases: { id: string; intent?: string }[] }; diagnostics: { phaseIntentReview: { phases: { phaseId: string; intent: string; evidenceTimes: number[] }[]; targetTimes: number[]; targetTimeBatches: number[][]; limitation: string } }; structural: { summary: { tracks: number }; advisories: unknown[] };
      reviewFocus: { structuralAdvisories: { total: number }; recipeMotionTargets: { total: number; evidenceSource: string }; mechanicalChecksNeedingReview: { criteriaProvided: boolean; criteriaStatus: string } };
      next: string } }).result;
    assert.equal(offlineReview.structural.summary.tracks, 1);
    assert.ok(Array.isArray(offlineReview.structural.advisories));
    assert.equal(offlineReview.reviewFocus.structuralAdvisories.total, offlineReview.structural.advisories.length);
    assert.equal(offlineReview.reviewFocus.mechanicalChecksNeedingReview.criteriaProvided, false);
    assert.equal(offlineReview.reviewFocus.mechanicalChecksNeedingReview.criteriaStatus, 'not_requested');
    assert.equal(offlineReview.blueprint.phases[0]?.intent, 'The arm winds up, then releases.');
    assert.equal(offlineReview.diagnostics.phaseIntentReview.phases[0]?.phaseId, 'action');
    assert.equal(offlineReview.diagnostics.phaseIntentReview.phases[0]?.intent, 'The arm winds up, then releases.');
    assert.deepEqual(offlineReview.diagnostics.phaseIntentReview.phases[0]?.evidenceTimes, [0, 0.5, 1]);
    assert.deepEqual(offlineReview.diagnostics.phaseIntentReview.targetTimes, [0.5], 'clip endpoints are already mandatory candidate samples');
    assert.deepEqual(offlineReview.diagnostics.phaseIntentReview.targetTimeBatches, [[0.5]]);
    assert.match(offlineReview.diagnostics.phaseIntentReview.limitation, /does not interpret the intent/);
    assert.match(offlineReview.next, /blueprint\.phases\[\]\.intent.*stated beat description.*compare it with that phase's authored pose coverage\/progression and rendered frames; report unclear/i,
      'the handoff should preserve intent for evidence-based pose and visual review');
    assert.match(offlineReview.next, /motion_animation_candidate_evaluate.*motion_studio_open_candidate.*candidateFingerprint.*motion_studio_capture_preflight.*poll motion_studio_job.*motion_studio_capture_candidate_plan.*motion_studio_capture_candidate_views.*motion_studio_read_candidate_capture/s,
      'a rig-bound blueprint should teach agents the exact evaluate, viewport and rendered-image review handoff');
    assert.match(offlineReview.next, /not this blueprint preview’s candidateFingerprint/,
      'the next-step guidance must distinguish the recipe fingerprint expected by viewport preview');
    assert.match(offlineReview.next, /targetTimeBatches entry.*expectedFingerprint=[a-f0-9]{64}.*eight exact times each/i,
      'the blueprint handoff should bind phase-intent samples to the compiled recipe and respect bounded batches');
    assert.match(offlineReview.next, /phase-intent evidence options.*Choose distinct times ordered from highest to lowest importance and pass them as priorityTimes.*do not select merely the first times chronologically.*views=\["front"\].*maxFrames=8.*priorityTimeCoverage\.followUpBatches.*same recipe.*rig signature/i,
      'the handoff should let the AI rank all intent beats and disclose which exact frames exceed the bounded storyboard');
    assert.match(offlineReview.next, /targetedPoseEvidence\.poseEvidenceIndex\.nodeSlots.*not as proof of.*For rendered review.*stills do not establish continuous motion/i,
      'the handoff should explain how to map measured poses and preserve the visual-review boundary');
    assert.ok(offlineReview.next.includes('If preflight or capture is unavailable or not granted, do not claim AI visual review'),
      'the handoff must not imply screenshot access or permission');
    assert.match(offlineReview.next, /structural\.curveMotion.*structural\.actionPhaseMap\.poseProgression\/peakEvents.*not defects/i,
      'the handoff should direct agents to easing-aware local motion evidence without presenting cues as quality judgments');
    assert.match(offlineReview.next, /correlate each exact target\.joint with rigValidation\.jointPoseGuides\[\]\.joint.*parent and measured segment length/i,
      'rig-bound guidance should connect motion peaks to exact hierarchy/proportion evidence');
    const sixteenIntentPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: {
      name: 'Sixteen intent midpoint options', duration: 1, sessionId, rigId,
      phases: Array.from({ length: 16 }, (_, index) => ({ id: `beat_${index}`, label: 'main_action',
        intent: `User-stated beat ${index}`, markerName: `Beat_${index}`, start: index / 16, end: (index + 1) / 16 })),
      poses: Array.from({ length: 16 }, (_, index) => ({ phaseId: `beat_${index}`, progress: 0.5,
        joint: 'RightUpperArm', rotation: [-45 + index, 0, 0] })),
    } });
    assert.ok(!sixteenIntentPreview.isError, JSON.stringify(sixteenIntentPreview));
    const sixteenIntentNext = (sixteenIntentPreview.structuredContent as { result: { next: string } }).result.next;
    assert.ok(sixteenIntentNext.includes('"phaseId":"beat_15"') && sixteenIntentNext.includes('"time":0.96875'),
      'the rendered-review handoff must expose intent evidence for the last phase, not silently truncate after the first six');
    assert.match(sixteenIntentNext, /Choose distinct times ordered from highest to lowest importance.*do not select merely the first times chronologically.*priorityTimeCoverage\.followUpBatches/s,
      'the AI should rank all intent boundaries/midpoints and receive explicit over-budget coverage');
    const candidateFingerprint = (preview.structuredContent as { result: { candidateFingerprint: string; rigEvidence: { rigSignature: string; profileFingerprint: string }; rigValidation: { semanticRoleCoverage: { summary: { activeRoleCount: number; notAuthoredRoleCount: number; unresolvedRoleCount: number }; roles: { role: string; state: string; joint?: string }[]; sharedJointRoles: { joint: string; roles: string[] }[]; limitation: string }; jointPoseGuides: { joint: string; parent: string; targetKind?: string; restBasisQuaternion: number[]; segmentLengthStuds: number;
      largestAuthoredLocalPositionOffset: { time: number; offsetStuds: number[]; magnitudeStuds: number; segmentLengthRatio: number | null };
      largestConsecutiveKeyPositionChange: { fromTime: number; toTime: number; deltaStuds: number[]; magnitudeStuds: number; segmentLengthRatio: number | null } }[] } } }).result;
    assert.equal(candidateFingerprint.rigEvidence.rigSignature, rigSignature);
    assert.match(candidateFingerprint.rigEvidence.profileFingerprint, /^[a-f0-9]{64}$/);
    const semanticCoverage = candidateFingerprint.rigValidation.semanticRoleCoverage;
    assert.equal(semanticCoverage.roles.find(role => role.role === 'right_shoulder')?.state, 'active');
    assert.equal(semanticCoverage.roles.find(role => role.role === 'left_shoulder')?.state, 'unresolved');
    assert.ok(semanticCoverage.summary.activeRoleCount > 0);
    assert.ok(semanticCoverage.summary.unresolvedRoleCount > 0);
    assert.match(semanticCoverage.limitation, /not a quality score or quota/);
    assert.deepEqual(candidateFingerprint.rigValidation.jointPoseGuides, [{ joint: 'RightUpperArm', parent: 'Root', targetKind: 'Motor6D', restBasisQuaternion: [0, 0, 0, 1], segmentLengthStuds: 2,
      largestAuthoredLocalPositionOffset: { time: 0, offsetStuds: [0, 0, 0], magnitudeStuds: 0, segmentLengthRatio: 0 },
      largestConsecutiveKeyPositionChange: { fromTime: 0, toTime: 0, deltaStuds: [0, 0, 0], magnitudeStuds: 0, segmentLengthRatio: 0 } }]);
    const positionalPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [{ phaseId: 'action', progress: 0.25, joint: 'RightUpperArm', position: [0.1, 0, 0] },
        { phaseId: 'action', progress: 0.75, joint: 'RightUpperArm', position: [0.7, 0, 0] }] } });
    assert.ok(!positionalPreview.isError, JSON.stringify(positionalPreview));
    const positionCue = (positionalPreview.structuredContent as { result: { rigValidation: { jointPoseGuides: { largestAuthoredLocalPositionOffset: { magnitudeStuds: number; segmentLengthRatio: number | null };
      largestConsecutiveKeyPositionChange: { fromTime: number; toTime: number; deltaStuds: number[]; magnitudeStuds: number; segmentLengthRatio: number | null } }[] } } }).result.rigValidation.jointPoseGuides[0]!;
    assert.deepEqual(positionCue.largestAuthoredLocalPositionOffset, { time: 0.75, offsetStuds: [0.7, 0, 0], magnitudeStuds: 0.7, segmentLengthRatio: 0.35 });
    assert.deepEqual(positionCue.largestConsecutiveKeyPositionChange, { fromTime: 0.25, toTime: 0.75, deltaStuds: [0.6, 0, 0], magnitudeStuds: 0.6, segmentLengthRatio: 0.3 });
    const zeroLengthProfile = { ...retargetProfile, rigSignature: 'blueprint-zero-length-segment-v1',
      joints: retargetProfile.joints.map(joint => joint.name === 'RightUpperArm' ? { ...joint, segmentLength: 0 } : joint) };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: zeroLengthProfile.rigSignature } });
    const zeroLengthInspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, zeroLengthInspection.id);
    queue.complete(sessionId, zeroLengthInspection.id, true, { id: rigId, retargetProfile: zeroLengthProfile });
    const zeroLengthPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [{ phaseId: 'action', progress: 0.25, joint: 'RightUpperArm', position: [0.1, 0, 0] },
        { phaseId: 'action', progress: 0.75, joint: 'RightUpperArm', position: [0.7, 0, 0] }] } });
    assert.ok(!zeroLengthPreview.isError, JSON.stringify(zeroLengthPreview));
    const zeroLengthGuide = (zeroLengthPreview.structuredContent as { result: { rigValidation: { jointPoseGuides: { segmentLengthStuds: number;
      largestAuthoredLocalPositionOffset: { segmentLengthRatio: number | null };
      largestConsecutiveKeyPositionChange: { segmentLengthRatio: number | null } }[] } } }).result.rigValidation.jointPoseGuides[0]!;
    assert.equal(zeroLengthGuide.segmentLengthStuds, 0);
    assert.equal(zeroLengthGuide.largestAuthoredLocalPositionOffset.segmentLengthRatio, null);
    assert.equal(zeroLengthGuide.largestConsecutiveKeyPositionChange.segmentLengthRatio, null);
    const parallelSessionId = randomUUID();
    queue.heartbeat(parallelSessionId, { activeRig: { id: rigId, rigSignature } });
    const parallelInspection = queue.enqueue(parallelSessionId, 'inspect', { rigId });
    assert.equal(queue.poll(parallelSessionId)?.id, parallelInspection.id);
    queue.complete(parallelSessionId, parallelInspection.id, true, { id: rigId, retargetProfile });
    const parallelSessionPreview = await client.callTool({ name: 'motion_animation_blueprint_preview',
      arguments: { ...blueprintInput, sessionId: parallelSessionId } });
    assert.ok(!parallelSessionPreview.isError, JSON.stringify(parallelSessionPreview));
    const parallelSessionFingerprint = (parallelSessionPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    assert.notEqual(parallelSessionFingerprint, candidateFingerprint.candidateFingerprint,
      'an otherwise identical blueprint and inspected rig in another Studio session need a distinct preview identity');
    const staleSessionCommit = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: {
      ...blueprintInput, sessionId: parallelSessionId, expectedCandidateFingerprint: candidateFingerprint.candidateFingerprint } });
    assert.equal(staleSessionCommit.isError, true);
    assert.match(JSON.stringify(staleSessionCommit), /differs from its reviewed preview/);
    const semanticPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_shoulder', rotation: [-45, 0, 0] }] } });
    assert.ok(!semanticPreview.isError, JSON.stringify(semanticPreview));
    const semanticResult = (semanticPreview.structuredContent as { result: { recipe: { tracks: { joint: string }[] }; rigValidation: { semanticRoleMappings: { role: string; joint: string; resolution: string; evidence: string[] }[] } } }).result;
    assert.deepEqual(semanticResult.recipe.tracks.map(track => track.joint), ['RightUpperArm']);
    assert.deepEqual(semanticResult.rigValidation.semanticRoleMappings, [{ role: 'right_shoulder', joint: 'RightUpperArm', resolution: 'exact',
      evidence: ['Exact R15 convention name matched a driven joint.'] }]);
    const customProfile = { ...retargetProfile, rigType: 'custom' as const, rigSignature: 'blueprint-custom-role-v1',
      joints: [{ ...retargetProfile.joints[0]! }, { ...retargetProfile.joints[1]!, name: 'upper_arm_R' }] };
    const customInspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, customInspection.id);
    queue.complete(sessionId, customInspection.id, true, { id: rigId, retargetProfile: customProfile });
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: customProfile.rigSignature } });
    const unconfirmedSemanticPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_shoulder', rotation: [-45, 0, 0] }] } });
    assert.equal(unconfirmedSemanticPreview.isError, true);
    assert.match(JSON.stringify(unconfirmedSemanticPreview), /does not have an exact standard-rig mapping.*explicitly map this role.*semanticRoleMap/i);
    const confirmedCustomSemanticPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      semanticRoleMap: [{ role: 'right_shoulder', joint: 'upper_arm_R' }],
      poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_shoulder', rotation: [-45, 0, 0] }] } });
    assert.ok(!confirmedCustomSemanticPreview.isError, JSON.stringify(confirmedCustomSemanticPreview));
    const confirmedCustomSemanticResult = (confirmedCustomSemanticPreview.structuredContent as { result: { candidateFingerprint: string;
      recipe: { tracks: { joint: string }[] }; rigValidation: { semanticRoleMappings: { role: string; joint: string; resolution: string; evidence: string[] }[];
        semanticRoleCoverage: { roles: { role: string; joint?: string; resolution: string; state: string; mappingEvidence?: string }[] } } } }).result;
    assert.deepEqual(confirmedCustomSemanticResult.recipe.tracks.map(track => track.joint), ['upper_arm_R']);
    assert.deepEqual(confirmedCustomSemanticResult.rigValidation.semanticRoleMappings.map(mapping => [mapping.role, mapping.joint, mapping.resolution]),
      [['right_shoulder', 'upper_arm_R', 'user_confirmed']]);
    assert.ok(confirmedCustomSemanticResult.rigValidation.semanticRoleMappings[0]!.evidence.some(evidence => /not verified anatomy/.test(evidence)));
    const confirmedRoleCoverage = confirmedCustomSemanticResult.rigValidation.semanticRoleCoverage.roles.find(role => role.role === 'right_shoulder')!;
    assert.deepEqual([confirmedRoleCoverage.joint, confirmedRoleCoverage.resolution, confirmedRoleCoverage.state], ['upper_arm_R', 'user_confirmed', 'active']);
    assert.match(confirmedRoleCoverage.mappingEvidence ?? '', /user-attested intent, not anatomical verification/);
    const invalidCustomRoleTarget = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      semanticRoleMap: [{ role: 'right_shoulder', joint: 'HumanoidRootPart' }],
      poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_shoulder', rotation: [-45, 0, 0] }] } });
    assert.equal(invalidCustomRoleTarget.isError, true);
    assert.match(JSON.stringify(invalidCustomRoleTarget), /not an exact driven joint/);
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const restoreInspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, restoreInspection.id);
    queue.complete(sessionId, restoreInspection.id, true, { id: rigId, retargetProfile });
    const r6Profile = { ...retargetProfile, rigType: 'R6' as const, rigSignature: 'blueprint-r6-role-v1',
      joints: [{ ...retargetProfile.joints[0]! }, { ...retargetProfile.joints[1]!, name: 'Right Arm' }] };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: r6Profile.rigSignature } });
    const r6Inspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, r6Inspection.id);
    queue.complete(sessionId, r6Inspection.id, true, { id: rigId, retargetProfile: r6Profile });
    const r6SemanticPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_hand', rotation: [-30, 0, 0] }] } });
    assert.ok(!r6SemanticPreview.isError, JSON.stringify(r6SemanticPreview));
    const r6SemanticMapping = (r6SemanticPreview.structuredContent as { result: { recipe: { tracks: { joint: string }[] };
      rigValidation: { semanticRoleMappings: { evidence: string[] }[] } } }).result;
    assert.deepEqual(r6SemanticMapping.recipe.tracks.map(track => track.joint), ['Right Arm']);
    assert.ok(r6SemanticMapping.rigValidation.semanticRoleMappings[0]?.evidence.some(evidence => /endpoint role, not a separate wrist\/ankle joint/.test(evidence)));
    const r6AliasedSemanticPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      poses: [
        { phaseId: 'action', progress: 0.25, semanticRole: 'right_shoulder', rotation: [-20, 0, 0] },
        { phaseId: 'action', progress: 0.75, semanticRole: 'right_hand', rotation: [-35, 0, 0] },
      ] } });
    assert.ok(!r6AliasedSemanticPreview.isError, JSON.stringify(r6AliasedSemanticPreview));
    const r6AliasValidation = (r6AliasedSemanticPreview.structuredContent as { result: { rigValidation: {
      semanticRoleAliases: { joint: string; roles: string[] }[]; warnings: string[];
    } } }).result.rigValidation;
    assert.deepEqual(r6AliasValidation.semanticRoleAliases, [{ joint: 'Right Arm', roles: ['right_hand', 'right_shoulder'] }]);
    assert.ok(r6AliasValidation.warnings.some(warning => /right_hand, right_shoulder.*same driven joint Right Arm.*cannot be posed independently/i.test(warning)));
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const restoreR15Inspection = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, restoreR15Inspection.id);
    queue.complete(sessionId, restoreR15Inspection.id, true, { id: rigId, retargetProfile });
    const badContactPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      contacts: [{ effector: 'UnknownFoot', kind: 'support', phaseId: 'action', startProgress: 0.1, endProgress: 0.9 }] } });
    assert.equal(badContactPreview.isError, true);
    assert.match(JSON.stringify(badContactPreview), /contact effectors do not exist in the inspected rig/i);
    const ambiguousSessionId = randomUUID();
    const ambiguousProfile = { ...retargetProfile, rigSignature: 'blueprint-case-ambiguous-v1', joints: [
      ...retargetProfile.joints,
      { ...retargetProfile.joints[0]!, name: 'root' },
    ] };
    queue.heartbeat(ambiguousSessionId, { activeRig: { id: rigId, rigSignature: ambiguousProfile.rigSignature } });
    const ambiguousInspection = queue.enqueue(ambiguousSessionId, 'inspect', { rigId });
    assert.equal(queue.poll(ambiguousSessionId)?.id, ambiguousInspection.id);
    queue.complete(ambiguousSessionId, ambiguousInspection.id, true, { id: rigId, retargetProfile: ambiguousProfile });
    const ambiguousContactPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      sessionId: ambiguousSessionId, contacts: [{ effector: 'ROOT', kind: 'support', phaseId: 'action', startProgress: 0.1, endProgress: 0.9 }] } });
    assert.equal(ambiguousContactPreview.isError, true);
    assert.match(JSON.stringify(ambiguousContactPreview), /ambiguous casing.*ROOT.*Root, root.*exact inspected joint name/i);
    const untrackedContactPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput,
      contacts: [{ effector: 'Root', kind: 'support', phaseId: 'action', startProgress: 0.1, endProgress: 0.9 }] } });
    assert.ok(!untrackedContactPreview.isError, JSON.stringify(untrackedContactPreview));
    const rigValidation = (untrackedContactPreview.structuredContent as { result: { rigValidation: { jointPoseGuides: { joint: string }[];
      contacts: { effector: string; rigJoint: string; kind: string; start: number; end: number; phaseId: string; phaseProgress: { start: number; end: number }; driven: boolean; authoredTrack: boolean; assessment: string }[]; warnings: string[] } } }).result.rigValidation;
    assert.deepEqual(rigValidation.jointPoseGuides.map(guide => guide.joint), ['RightUpperArm']);
    assert.deepEqual(rigValidation.contacts, [{ effector: 'Root', rigJoint: 'Root', kind: 'support', start: 0.1, end: 0.9,
      phaseId: 'action', phaseProgress: { start: 0.1, end: 0.9 }, driven: false, authoredTrack: false, assessment: 'declaration_only' }]);
    assert.ok(rigValidation.warnings.some(warning => /not mark as driven/.test(warning)));
    assert.ok(rigValidation.warnings.some(warning => /no authored animation track/.test(warning)));
    const badJointPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: { ...blueprintInput, poses: [{ ...blueprintInput.poses[0], joint: 'UnknownJoint' }] } });
    assert.equal(badJointPreview.isError, true);
    assert.match(JSON.stringify(badJointPreview), /do not match driven joints/);
    const revisedProfile = { ...retargetProfile, joints: retargetProfile.joints.map(joint => joint.name === 'RightUpperArm' ? { ...joint, segmentLength: 2.25 } : joint) };
    const reinspect = queue.enqueue(sessionId, 'inspect', { rigId });
    assert.equal(queue.poll(sessionId)?.id, reinspect.id);
    queue.complete(sessionId, reinspect.id, true, { id: rigId, retargetProfile: revisedProfile });
    const staleProfileCommit = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...persistedBlueprintInput, expectedCandidateFingerprint: candidateFingerprint.candidateFingerprint } });
    assert.equal(staleProfileCommit.isError, true);
    assert.match(JSON.stringify(staleProfileCommit), /differs from its reviewed preview/);
    const refreshedPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: persistedBlueprintInput });
    assert.ok(!refreshedPreview.isError, JSON.stringify(refreshedPreview));
    const refreshedFingerprint = (refreshedPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const committed = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...persistedBlueprintInput, expectedCandidateFingerprint: refreshedFingerprint } });
    assert.ok(!committed.isError, JSON.stringify(committed));
    const committedResult = (committed.structuredContent as { result: { assetId: string; authoringIntentTimingMatchesCurrentRecipe: boolean;
      authoringIntentTimingRelation: string; authoringIntent: { schemaVersion: number; sourceRecipeFingerprint: string; authoringIntentFingerprint: string;
      phases: { id: string; label: string; start: number; end: number; intent?: string }[];
      events?: { name: string; phaseId: string; progress: number; time: number; value?: string }[];
      contacts?: { effector: string; kind: 'support' | 'grip'; phaseId: string; startProgress: number; endProgress: number; start: number; end: number }[] } | null } }).result;
    const committedId = committedResult.assetId;
    assert.equal(committedResult.authoringIntentTimingRelation, 'exact_current_recipe');
    assert.equal(committedResult.authoringIntent?.phases.find(phase => phase.id === 'action')?.intent, 'The arm winds up, then releases.');
    assert.deepEqual(committedResult.authoringIntent?.events, [{ name: 'Release', phaseId: 'action', progress: 0.75, value: 'arrow_release', time: 0.75 }]);
    assert.deepEqual(committedResult.authoringIntent?.contacts, [{ effector: 'RightUpperArm', kind: 'grip', phaseId: 'action',
      startProgress: 0.2, endProgress: 0.7, start: 0.2, end: 0.7 }]);
    assert.match(committedResult.authoringIntent!.authoringIntentFingerprint, /^[a-f0-9]{64}$/);
    const saved = await library.get(committedId);
    assert.equal(saved.sourceRigProfile?.rigSignature, rigSignature);
    assert.deepEqual(saved.authoringIntent, committedResult.authoringIntent, 'the committed asset should persist its validated phase intent separately from its Roblox recipe');
    assert.equal(saved.authoringIntent?.sourceRecipeFingerprint, fingerprint(saved.recipe), 'phase boundaries should identify the recipe they were authored against');
    assert.equal(animationAuthoringIntentSchema.safeParse({ ...saved.authoringIntent!, events: [{ ...saved.authoringIntent!.events![0]!, value: 'tampered' }] }).success, false,
      'persisted intent edits must fail fingerprint verification on load');
    const { authoringIntentFingerprint: _savedIntentFingerprint, ...savedIntentBody } = saved.authoringIntent!;
    const unrelatedIntentBase = { ...savedIntentBody, sourceRecipeFingerprint: '0'.repeat(64) };
    const unrelatedIntent = { ...unrelatedIntentBase, authoringIntentFingerprint: createHash('sha256').update(JSON.stringify(unrelatedIntentBase)).digest('hex') };
    await assert.rejects(() => library.saveIdempotent(saved.recipe, randomUUID(), undefined, undefined, undefined, undefined, unrelatedIntent),
      /must identify the exact recipe being saved/i);
    const openedCandidate = await client.callTool({ name: 'motion_studio_open_candidate', arguments: { sessionId, rigId, recipe: saved.recipe,
      expectedFingerprint: fingerprint(saved.recipe), parentAssetId: saved.id } });
    assert.ok(!openedCandidate.isError, JSON.stringify(openedCandidate));
    const openJob = (openedCandidate.structuredContent as { result: { jobId: string; status: string } }).result;
    assert.equal(openJob.status, 'queued');
    const openCommand = queue.poll(sessionId);
    assert.equal(openCommand?.operation, 'open_candidate');
    const openPayload = openCommand?.payload as { candidateId: string; recipeFingerprint: string; rigSignature: string; parentAssetId: string; sourceRigProfile: { rigSignature: string }; recipe: unknown };
    assert.notEqual(openPayload.candidateId, saved.id);
    assert.equal(openPayload.recipeFingerprint, fingerprint(saved.recipe));
    assert.equal(openPayload.rigSignature, rigSignature);
    assert.equal(openPayload.sourceRigProfile.rigSignature, rigSignature);
    assert.equal(openPayload.parentAssetId, saved.id);
    queue.complete(sessionId, openCommand!.id, true, { opened: true, candidateId: openPayload.candidateId, rigId });
    const staleOpen = await client.callTool({ name: 'motion_studio_open_candidate', arguments: { sessionId, rigId, recipe: saved.recipe, expectedFingerprint: '0'.repeat(64) } });
    assert.equal(staleOpen.isError, true);
    const retry = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...persistedBlueprintInput, expectedCandidateFingerprint: refreshedFingerprint } });
    assert.equal((retry.structuredContent as { result: { assetId: string } }).result.assetId, committedId);
    assert.equal((await library.list()).total, 1);
    const port = (bridge.address() as { port: number }).port;
    const savedFromViewport = await fetch(`http://127.0.0.1:${port}/library/save`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token',
    }, body: JSON.stringify({ recipe: saved.recipe, parentId: saved.id, sourceRigProfile: revisedProfile }) });
    assert.equal(savedFromViewport.status, 200);
    const viewportAsset = await savedFromViewport.json() as { id: string; parentId: string; sourceRigProfile: { rigSignature: string } };
    assert.equal(viewportAsset.parentId, saved.id);
    assert.deepEqual((await library.get(viewportAsset.id)).authoringIntent, saved.authoringIntent,
      'ordinary child revisions should retain original beat intent while its source recipe fingerprint discloses the timing basis');
    assert.equal(viewportAsset.sourceRigProfile.rigSignature, rigSignature);
    assert.equal((await library.list()).total, 2);
    const importRequest = { recipe: saved.recipe, sourceRigProfile: revisedProfile, sourceIdentity: { kind: 'asset', assetId: '54321' } };
    const importEndpoint = `http://127.0.0.1:${port}/library/import-save`;
    const importOnce = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' }, body: JSON.stringify(importRequest) });
    assert.equal(importOnce.status, 200);
    const importAsset = await importOnce.json() as { id: string; sourceRigProfile: { rigSignature: string } };
    assert.equal(importAsset.sourceRigProfile.rigSignature, rigSignature);
    const importRetry = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' }, body: JSON.stringify(importRequest) });
    assert.equal(importRetry.status, 200);
    assert.equal((await importRetry.json() as { id: string }).id, importAsset.id, 'an exact import retry reuses the same asset');
    const reconnectRetry = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' },
      body: JSON.stringify({ ...importRequest, sourceRigProfile: { ...revisedProfile, rigId: randomUUID() } }) });
    assert.equal(reconnectRetry.status, 200);
    assert.equal((await reconnectRetry.json() as { id: string }).id, importAsset.id, 'a regenerated transient rig ID does not duplicate the same import');
    assert.equal((await library.list()).total, 3, 'the retry must not create a duplicate library row');
    const concurrentRetries = await Promise.all(Array.from({ length: 8 }, async () => fetch(importEndpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token',
    }, body: JSON.stringify({ ...importRequest, sourceRigProfile: { ...revisedProfile, rigId: randomUUID() } }) })));
    const concurrentAssets = await Promise.all(concurrentRetries.map(async response => {
      assert.equal(response.status, 200);
      return await response.json() as { id: string };
    }));
    assert.deepEqual(new Set(concurrentAssets.map(asset => asset.id)), new Set([importAsset.id]), 'simultaneous reconnect retries converge on one immutable asset');
    assert.equal((await library.list()).total, 3, 'concurrent retries do not create duplicate library rows');
    const localImportIdentity = { kind: 'anim_saves', sequenceName: 'ImportedSequence' };
    const localImport = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' },
      body: JSON.stringify({ recipe: saved.recipe, sourceRigProfile: { ...revisedProfile, rigId: randomUUID() }, sourceIdentity: localImportIdentity }) });
    assert.equal(localImport.status, 200);
    const localImportAsset = await localImport.json() as { id: string; importProvenance: { sourceIdentity: { kind: string; sequenceName?: string }; provenanceFingerprint: string } };
    assert.equal(localImportAsset.importProvenance.sourceIdentity.kind, 'anim_saves');
    assert.equal(localImportAsset.importProvenance.sourceIdentity.sequenceName, 'ImportedSequence');
    assert.match(localImportAsset.importProvenance.provenanceFingerprint, /^[a-f0-9]{64}$/);
    const localReconnectRetry = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' },
      body: JSON.stringify({ recipe: saved.recipe, sourceRigProfile: { ...revisedProfile, rigId: randomUUID() }, sourceIdentity: localImportIdentity }) });
    assert.equal(localReconnectRetry.status, 200);
    assert.equal((await localReconnectRetry.json() as { id: string }).id, localImportAsset.id, 'local AnimSaves provenance is stable across transient Studio rig IDs');
    assert.equal((await library.list()).total, 4, 'a local animation import remains one reusable asset across reconnects');
    const changedImport = await fetch(importEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer blueprint-save-token' },
      body: JSON.stringify({ ...importRequest, recipe: { ...saved.recipe, name: 'Changed imported content' } }) });
    assert.equal(changedImport.status, 200);
    assert.notEqual((await changedImport.json() as { id: string }).id, importAsset.id, 'changed imported content receives a distinct asset identity');
    assert.equal((await library.list()).total, 5);
    const intentPatchPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
      recipe: saved.recipe, expectedSourceFingerprint: fingerprint(saved.recipe),
      operations: [{ operation: 'insert_key', joint: 'RightUpperArm', time: 0.125, rotation: [0, 1, 0] }],
    } });
    assert.ok(!intentPatchPreview.isError, JSON.stringify(intentPatchPreview));
    const intentPatch = (intentPatchPreview.structuredContent as { result: { candidateFingerprint: string } }).result;
    const intentPatchCommit = await client.callTool({ name: 'motion_animation_candidate_patch_commit', arguments: {
      recipe: saved.recipe, expectedSourceFingerprint: fingerprint(saved.recipe),
      operations: [{ operation: 'insert_key', joint: 'RightUpperArm', time: 0.125, rotation: [0, 1, 0] }],
      expectedCandidateFingerprint: intentPatch.candidateFingerprint, parentAssetId: saved.id, userApproved: true,
    } });
    assert.ok(!intentPatchCommit.isError, JSON.stringify(intentPatchCommit));
    const intentPatchResult = (intentPatchCommit.structuredContent as { result: { assetId: string; parentId: string | null;
      authoringIntent: typeof saved.authoringIntent; authoringIntentTimingMatchesCurrentRecipe: boolean | null;
      authoringIntentTimingRelation: string } }).result;
    assert.equal(intentPatchResult.parentId, saved.id, 'a saved-asset patch should retain exact parent lineage');
    assert.deepEqual(intentPatchResult.authoringIntent, saved.authoringIntent, 'a saved-asset patch should preserve the original creative brief');
    assert.equal(intentPatchResult.authoringIntentTimingMatchesCurrentRecipe, false,
      'the commit should make stale original phase timings explicit to the AI author');
    assert.equal(intentPatchResult.authoringIntentTimingRelation, 'historical_reference');
    assert.deepEqual((await library.get(intentPatchResult.assetId)).authoringIntent,
      saved.authoringIntent, 'the persisted child should retain authoring intent, not only the immediate tool response');
    const importedAssetPath = join(root, 'library', `${importAsset.id}.json`);
    const persistedImport = JSON.parse(await readFile(importedAssetPath, 'utf8')) as { importProvenance: { recipeFingerprint: string } };
    persistedImport.importProvenance.recipeFingerprint = '0'.repeat(64);
    await writeFile(importedAssetPath, JSON.stringify(persistedImport, null, 2));
    await assert.rejects(() => library.get(importAsset.id), /import provenance failed/i);
  } finally {
    saveApp.authoring.close(); saveApp.reviews.close(); await client.close(); await server.close(); bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
  }
});

test('semantic blueprint commit requires its exact resolved-role preview and retries idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-blueprint-semantic-commit-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'semantic-blueprint-commit-rig-v1';
  const profile = { version: 1, rigId, rigName: 'Semantic commit R15', rigType: 'R15' as const, rigSignature, joints: [
    { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
    { name: 'RightUpperArm', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    { name: 'LeftUpperArm', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
  ] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: profile });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'semantic-blueprint-commit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const input = { name: 'Semantic shoulder pose', duration: 1, sessionId, rigId,
    phases: [{ id: 'action', label: 'main_action', start: 0, end: 1 }],
    poses: [{ phaseId: 'action', progress: 0.5, semanticRole: 'right_shoulder', rotation: [-45, 0, 0] }] };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await library.list()).total, 0);
    const preview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: input });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const previewResult = (preview.structuredContent as { result: { candidateFingerprint: string; recipe: { tracks: { joint: string }[] } } }).result;
    assert.deepEqual(previewResult.recipe.tracks.map(track => track.joint), ['RightUpperArm']);
    const alteredRole = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...input,
      poses: [{ ...input.poses[0], semanticRole: 'left_shoulder' }], expectedCandidateFingerprint: previewResult.candidateFingerprint } });
    assert.equal(alteredRole.isError, true);
    assert.match(JSON.stringify(alteredRole), /differs from its reviewed preview/i);
    assert.equal((await library.list()).total, 0, 'a role change must not save against the old preview fingerprint');
    const committed = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...input, expectedCandidateFingerprint: previewResult.candidateFingerprint } });
    assert.ok(!committed.isError, JSON.stringify(committed));
    assert.equal((committed.structuredContent as { result: { authoringIntentTimingMatchesCurrentRecipe: boolean;
      authoringIntentTimingRelation: string } }).result.authoringIntentTimingMatchesCurrentRecipe, true);
    assert.equal((committed.structuredContent as { result: { authoringIntentTimingRelation: string } }).result.authoringIntentTimingRelation, 'exact_current_recipe');
    const committedResult = (committed.structuredContent as { result: { assetId: string; candidateFingerprint: string; sourceRigSignature: string;
      rigValidation: { semanticRoleMappings: { role: string; joint: string }[] } } }).result;
    assert.equal(committedResult.candidateFingerprint, previewResult.candidateFingerprint);
    assert.equal(committedResult.sourceRigSignature, rigSignature);
    assert.deepEqual(committedResult.rigValidation.semanticRoleMappings.map(mapping => [mapping.role, mapping.joint]), [['right_shoulder', 'RightUpperArm']]);
    const savedSemanticAsset = await library.get(committedResult.assetId);
    assert.equal(savedSemanticAsset.recipe.kind, 'animation');
    if (savedSemanticAsset.recipe.kind !== 'animation') assert.fail('Semantic blueprint commit must persist an animation recipe.');
    assert.deepEqual(savedSemanticAsset.recipe.tracks.map(track => track.joint), ['RightUpperArm']);
    const retry = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...input, expectedCandidateFingerprint: previewResult.candidateFingerprint } });
    assert.equal((retry.structuredContent as { result: { assetId: string } }).result.assetId, committedResult.assetId);
    assert.equal((await library.list()).total, 1, 'retrying an exact semantic-role commit must not duplicate the asset');
  } finally {
    await client.close(); await server.close();
  }
});

test('phase-based animation goal preview maps waypoints to clip time without saving or applying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-blueprint-goals-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'blueprint-goal-rig-v1';
  const retargetProfile = { version: 1, rigId, rigName: 'Goal Fixture R6', rigType: 'R6' as const, rigSignature,
    joints: [
      { name: 'Root', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'Right Arm', parent: 'Root', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
      { name: 'Left Leg', parent: 'Root', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    ] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'blueprint-goals-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = { name: 'Goal-bound action', duration: 2, sessionId, rigId,
      phases: [
        { id: 'windup', label: 'anticipation', start: 0, end: 0.25 },
        { id: 'strike', label: 'main_action', start: 0.25, end: 0.75 },
        { id: 'settle', label: 'recovery', start: 0.75, end: 1 },
      ],
      poses: [{ phaseId: 'strike', progress: 0.5, joint: 'Right Arm', rotation: [-35, 0, 0] }],
      effectorPaths: [
        { effector: 'RightHand', goals: [
          { phaseId: 'windup', progress: 0, position: [0, 4, 0] },
          { phaseId: 'strike', progress: 0.5, position: [2, 3, -1] },
          { phaseId: 'settle', progress: 1, position: [0, 4, 0] },
        ], poleTarget: [1, 2, 1] },
        { effector: 'LeftFoot', goals: [
          { phaseId: 'windup', progress: 0, position: [-1, 0, 0] },
          { phaseId: 'settle', progress: 1, position: [-1, 0, 0] },
        ] },
      ], sampleRateHz: 30, toleranceStuds: 0.05 };
    const preview = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: request });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const result = (preview.structuredContent as { result: { jobId: string;
      applyRequest: { recipe: AnimationRecipe; constraints: { limb: string; targetPath: { time: number; position: number[] }[]; expectedTargetPathFingerprint: string; poleTarget?: number[] }[]; startTime: number; endTime: number };
      blueprint: { structural: { summary: { tracks: number } }; reviewFocus: { mechanicalChecksNeedingReview: { criteriaStatus: string } };
        diagnostics: { poseCoverage: { phasesWithAuthoredPoses: number; phasesWithoutAuthoredPoses: string[]; authoredPoseTimings: { phaseId: string; phaseLabel: string; joint: string; progress: number; time: number }[]; omittedAuthoredPoseTimingCount: number; phases: { phaseId: string; authoredPoseCount: number; distinctJointCount: number; joints: string[]; jointsWithSingleAuthoredPose: number; jointsWithMultipleAuthoredPoses: number }[] } } };
      goalPathMapping: { effector: string; rigJointName: string; waypoints: { time: number; phaseId: string; progress: number; sourceWaypoints: { phaseId: string; progress: number }[] }[] }[];
      next: string; rigTargetEvidence: { rigType: string; rigSignature: string; profileFingerprint: string; coordinateFrame: string;
        effectors: { effector: string; rigJointName: string; resolution: string; solverChain: { name: string; parent: string; segmentLengthStuds: number }[] }[] } } }).result;
    assert.ok(result.jobId);
    assert.match(result.next, /motion_studio_capture_preflight.*poll its job.*motion_studio_capture_candidate_plan.*motion_studio_capture_candidate_views.*motion_studio_read_candidate_captures/s,
      'the AI must get a permission-gated route to inspect rendered images of the exact unsaved IK result');
    assert.match(result.next, /without replacing or dirtying the editor draft/);
    assert.match(result.next, /rendered review remains unperformed/);
    assert.match(result.next, /If the user chooses to keep the solve/);
    assert.match(result.next, /plan’s candidateFingerprint as expectedFingerprint.*distinct from the IK job candidateFingerprint/);
    assert.equal(result.blueprint.structural.summary.tracks, 1);
    assert.equal(result.blueprint.reviewFocus.mechanicalChecksNeedingReview.criteriaStatus, 'not_requested');
    assert.equal(result.blueprint.diagnostics.poseCoverage.phasesWithAuthoredPoses, 1);
    assert.deepEqual(result.blueprint.diagnostics.poseCoverage.phasesWithoutAuthoredPoses, ['windup', 'settle']);
    assert.deepEqual(result.blueprint.diagnostics.poseCoverage.phases.map(phase => [phase.phaseId, phase.authoredPoseCount, phase.distinctJointCount, phase.joints]), [
      ['windup', 0, 0, []], ['strike', 1, 1, ['Right Arm']], ['settle', 0, 0, []],
    ]);
    assert.deepEqual(result.blueprint.diagnostics.poseCoverage.phases.map(phase => [phase.phaseId,
      phase.jointsWithSingleAuthoredPose, phase.jointsWithMultipleAuthoredPoses]), [
      ['windup', 0, 0], ['strike', 1, 0], ['settle', 0, 0],
    ]);
    assert.deepEqual(result.blueprint.diagnostics.poseCoverage.authoredPoseTimings.map(pose => [pose.phaseId, pose.phaseLabel, pose.joint, pose.progress, pose.time]), [
      ['strike', 'main_action', 'Right Arm', 0.5, 1],
    ]);
    assert.equal(result.blueprint.diagnostics.poseCoverage.omittedAuthoredPoseTimingCount, 0);
    assert.deepEqual(result.goalPathMapping[0]!.waypoints.map(point => point.time), [0, 1, 2]);
    assert.deepEqual(result.goalPathMapping[0]!.waypoints.map(point => point.sourceWaypoints), [
      [{ phaseId: 'windup', progress: 0 }], [{ phaseId: 'strike', progress: 0.5 }], [{ phaseId: 'settle', progress: 1 }],
    ], 'the AI-facing solved-goal map should retain the source phase/progress of each world-space waypoint');
    assert.deepEqual(result.goalPathMapping[1]!.waypoints.map(point => point.time), [0, 2]);
    assert.equal(result.rigTargetEvidence.rigType, 'R6');
    assert.equal(result.rigTargetEvidence.rigSignature, rigSignature);
    assert.match(result.rigTargetEvidence.profileFingerprint, /^[a-f0-9]{64}$/);
    assert.match(result.rigTargetEvidence.coordinateFrame, /Roblox world-space.*studs/);
    assert.deepEqual(result.rigTargetEvidence.effectors.map(effector => [effector.effector, effector.rigJointName, effector.resolution, effector.solverChain.map(joint => joint.name)]), [
      ['RightHand', 'Right Arm', 'R6_direct_alias', ['Right Arm']],
      ['LeftFoot', 'Left Leg', 'R6_direct_alias', ['Left Leg']],
    ]);
    assert.deepEqual(result.goalPathMapping.map(path => [path.effector, path.rigJointName]), [['RightHand', 'Right Arm'], ['LeftFoot', 'Left Leg']]);
    assert.equal(result.applyRequest.recipe.duration, 2);
    assert.equal(result.applyRequest.startTime, 0);
    assert.equal(result.applyRequest.endTime, 2);
    assert.equal(result.applyRequest.constraints.length, 2);
    assert.equal(result.applyRequest.constraints[0]!.limb, 'RightHand');
    assert.match(result.applyRequest.constraints[0]!.expectedTargetPathFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.applyRequest.constraints[0]!.poleTarget, [1, 2, 1]);
    assert.equal((await library.list()).total, 0, 'an unsaved blueprint goal preview must not create a library asset');
    const queued = queue.poll(sessionId);
    assert.equal(queued?.id, result.jobId);
    assert.equal(queued?.operation, 'ik_constraints_preview');
    const payload = queued?.payload as { recipe: AnimationRecipe; constraints: { limb: string; targetPath: { time: number }[]; targetPathFingerprint: string }[]; ephemeralRecipe: boolean };
    assert.equal(payload.ephemeralRecipe, true);
    const queuedHandPath = payload.constraints.find(constraint => constraint.limb === 'RightHand');
    assert.ok(queuedHandPath);
    assert.deepEqual(queuedHandPath.targetPath.map(point => point.time), [0, 1, 2]);
    assert.match(queuedHandPath.targetPathFingerprint, /^[a-f0-9]{64}$/);
    const preciseDuration = 0.123456789;
    const preciseTiming = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request,
      name: 'Sub-microsecond goal timing', duration: preciseDuration,
      phases: [{ id: 'windup', label: 'anticipation', start: 0, end: 0.5 }, { id: 'settle', label: 'recovery', start: 0.5, end: 1 }],
      poses: [{ phaseId: 'windup', progress: 0.5, joint: 'Right Arm', rotation: [-20, 0, 0] }],
      effectorPaths: [{ effector: 'RightHand', goals: [
        { phaseId: 'windup', progress: 0, position: [0, 4, 0] },
        { phaseId: 'windup', progress: 0.75, position: [1, 4, 0] },
        { phaseId: 'windup', progress: 0.750001, position: [1.1, 4, 0] },
        { phaseId: 'settle', progress: 1, position: [0, 4, 0] },
      ] }] } });
    assert.ok(!preciseTiming.isError, JSON.stringify(preciseTiming));
    const preciseResult = (preciseTiming.structuredContent as { result: { goalPathMapping: { waypoints: { time: number }[] }[] } }).result;
    assert.deepEqual(preciseResult.goalPathMapping[0]!.waypoints.map(point => point.time), [0, preciseDuration * 0.375,
      preciseDuration * (0.5 * 0.750001), preciseDuration],
    'phase-relative timing must preserve close intentional beats and exact sub-second clip endpoints');
    assert.ok(preciseResult.goalPathMapping[0]!.waypoints[2]!.time > preciseResult.goalPathMapping[0]!.waypoints[1]!.time,
      'close but distinct intent progress values must remain strictly ordered after conversion');
    assert.equal(queue.poll(sessionId)?.operation, 'ik_constraints_preview');
    const sharedBoundary = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request,
      effectorPaths: [{ effector: 'RightHand', goals: [
        { phaseId: 'windup', progress: 0, position: [0, 4, 0] },
        { phaseId: 'windup', progress: 1, position: [1, 4, 0] },
        { phaseId: 'strike', progress: 0, position: [1, 4, 0] },
        { phaseId: 'settle', progress: 1, position: [0, 4, 0] },
      ] }] } });
    assert.ok(!sharedBoundary.isError, JSON.stringify(sharedBoundary));
    const sharedResult = (sharedBoundary.structuredContent as { result: { goalPathMapping: { waypoints: { time: number; phaseId: string; progress: number; sourceWaypoints: { phaseId: string; progress: number }[] }[] }[] } }).result;
    assert.deepEqual(sharedResult.goalPathMapping[0]!.waypoints.map(point => point.time), [0, 0.5, 2]);
    assert.deepEqual(sharedResult.goalPathMapping[0]!.waypoints[1]!.sourceWaypoints, [
      { phaseId: 'windup', progress: 1 }, { phaseId: 'strike', progress: 0 },
    ], 'coalesced boundary target must retain both adjacent phase aliases for the AI');
    assert.deepEqual(sharedResult.goalPathMapping[0]!.waypoints[1] && [sharedResult.goalPathMapping[0]!.waypoints[1]!.phaseId,
      sharedResult.goalPathMapping[0]!.waypoints[1]!.progress], ['windup', 1], 'retain the legacy primary phase/progress fields');
    assert.deepEqual(queue.poll(sessionId)?.operation, 'ik_constraints_preview');
    const conflictingBoundary = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request,
      effectorPaths: [{ effector: 'RightHand', goals: [
        { phaseId: 'windup', progress: 0, position: [0, 4, 0] },
        { phaseId: 'windup', progress: 1, position: [1, 4, 0] },
        { phaseId: 'strike', progress: 0, position: [1.01, 4, 0] },
        { phaseId: 'settle', progress: 1, position: [0, 4, 0] },
      ] }] } });
    assert.equal(conflictingBoundary.isError, true);
    assert.match(JSON.stringify(conflictingBoundary), /conflicting positions at the shared phase boundary/i);
    assert.equal(queue.poll(sessionId), null, 'conflicting boundary goals must be rejected before queueing');
    const firstEffectorPath = request.effectorPaths[0]!;
    const incompletePath = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request,
      effectorPaths: [{ ...firstEffectorPath, goals: firstEffectorPath.goals.slice(1) }] } });
    assert.equal(incompletePath.isError, true);
    assert.match(JSON.stringify(incompletePath), /must begin at clip time 0/i);
    const outOfBoundsGoal = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request,
      effectorPaths: [{ ...firstEffectorPath, goals: firstEffectorPath.goals.map((goal, index) => index === 0 ? { ...goal, position: [10001, 0, 0] } : goal) }] } });
    assert.equal(outOfBoundsGoal.isError, true);
    assert.match(JSON.stringify(outOfBoundsGoal), /too big|10000/i);
    assert.equal(queue.poll(sessionId), null, 'invalid bounds must be rejected before another Studio command is queued');

    const customRigId = randomUUID(), customRigSignature = 'blueprint-goal-custom-rig-v1';
    const customProfile = { version: 1, rigId: customRigId, rigName: 'Custom suffix-side rig', rigType: 'custom' as const,
      rigSignature: customRigSignature, joints: [
        { name: 'RootControl', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
        { name: 'upper_arm_L', parent: 'RootControl', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
        { name: 'forearm_L', parent: 'upper_arm_L', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
        { name: 'hand_L', parent: 'forearm_L', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
        { name: 'thigh_R', parent: 'RootControl', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
        { name: 'shin_R', parent: 'thigh_R', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
        { name: 'foot_R', parent: 'shin_R', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
      ] };
    queue.heartbeat(sessionId, { activeRig: { id: customRigId, rigSignature: customRigSignature } });
    const inspectCustom = await client.callTool({ name: 'motion_studio_inspect', arguments: { sessionId, rigId: customRigId } });
    assert.ok(!inspectCustom.isError, JSON.stringify(inspectCustom));
    const inspectCustomJobId = (inspectCustom.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.id, inspectCustomJobId);
    queue.complete(sessionId, inspectCustomJobId, true, { id: customRigId, retargetProfile: customProfile });
    const customGoal = await client.callTool({ name: 'motion_animation_blueprint_goal_preview', arguments: { ...request, rigId: customRigId,
      semanticRoleMap: [{ role: 'left_shoulder', joint: 'upper_arm_L' }],
      poses: [{ phaseId: 'strike', progress: 0.5, semanticRole: 'left_shoulder', rotation: [-35, 0, 0] }],
      effectorPaths: [
        { effector: 'LeftHand', goals: [{ phaseId: 'windup', progress: 0, position: [0, 4, 0] }, { phaseId: 'settle', progress: 1, position: [1, 4, 0] }] },
        { effector: 'RightFoot', goals: [{ phaseId: 'windup', progress: 0, position: [0, 0, 0] }, { phaseId: 'settle', progress: 1, position: [1, 0, 0] }] },
      ] } });
    assert.ok(!customGoal.isError, JSON.stringify(customGoal));
    const customResult = (customGoal.structuredContent as { result: { recipe: AnimationRecipe; blueprint: { rigValidation: {
      semanticRoleMappings: { role: string; joint: string; resolution: string; evidence: string[] }[] } };
      rigTargetEvidence: { effectors: { effector: string; rigJointName: string; resolution: string; solverChain: { name: string }[] }[] } } }).result;
    assert.deepEqual(customResult.recipe.tracks.map(track => track.joint), ['upper_arm_L'],
      'goal preview must compile the caller-confirmed custom semantic role into its exact inspected joint');
    assert.deepEqual(customResult.blueprint.rigValidation.semanticRoleMappings.map(mapping => [mapping.role, mapping.joint, mapping.resolution]),
      [['left_shoulder', 'upper_arm_L', 'user_confirmed']],
      'goal preview must preserve explicit custom role mapping evidence in the AI-facing result');
    const customEvidence = customResult.rigTargetEvidence;
    assert.deepEqual(customEvidence.effectors.map(item => [item.effector, item.rigJointName, item.resolution, item.solverChain.map(joint => joint.name)]), [
      ['LeftHand', 'hand_L', 'unique_limb_name_match', ['hand_L', 'forearm_L', 'upper_arm_L']],
      ['RightFoot', 'foot_R', 'unique_limb_name_match', ['foot_R', 'shin_R', 'thigh_R']],
    ]);
    assert.equal(queue.poll(sessionId)?.operation, 'ik_constraints_preview');

  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP rig inspection gives AI an exact animatable-joint map and conservative capability cues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-ai-rig-inspection-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'ai-rig-summary-r6-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const profile = { version: 1 as const, rigId, rigName: 'AI Summary R6', rigType: 'R6' as const, rigSignature, joints: [
    { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
    { name: 'Right Arm', parent: 'HumanoidRootPart', driven: true, targetKind: 'Motor6D' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    { name: 'Left Leg', parent: 'HumanoidRootPart', driven: true, targetKind: 'Motor6D' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    { name: 'BoneHand', parent: 'Right Arm', driven: true, targetKind: 'Bone' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'PartWithoutGeometry', parent: 'HumanoidRootPart', driven: true, targetKind: 'Motor6D' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'TransparentPart', parent: 'HumanoidRootPart', driven: true, targetKind: 'Motor6D' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    { name: 'UnverifiedPart', parent: 'HumanoidRootPart', driven: true, targetKind: 'Motor6D' as const, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
  ] };
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'ai-rig-inspection-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inspect = await client.callTool({ name: 'motion_studio_inspect', arguments: { sessionId, rigId } });
    assert.ok(!inspect.isError, JSON.stringify(inspect));
    const inspectJobId = (inspect.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.id, inspectJobId);
    queue.complete(sessionId, inspectJobId, true, { id: rigId, rigSignature, retargetProfile: profile,
      animatedNames: profile.joints.filter(joint => joint.name !== 'UnverifiedPart').map(({ name, parent, driven, ...joint }) => ({ name, parent, driven, ...('targetKind' in joint ? { targetKind: joint.targetKind } : {}),
        captureFocusEligible: driven && name !== 'Left Leg', ...(name === 'Right Arm' ? { visualGeometry: {
          source: 'BasePart.Size', dimensionsStuds: [1, 2, 1], partClass: 'Part', transparency: 0 } } : {}),
        ...(name === 'TransparentPart' ? { visualGeometry: { source: 'BasePart.Size', dimensionsStuds: [1, 1, 1], partClass: 'Part', transparency: 1 } } : {}) })) });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: inspectJobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const inspection = (completed.structuredContent as { result: { result: { aiRigSummary: {
      directlyAnimatableJointNames: string[]; captureFocusEligibleJointNames: string[]; nonDrivenJointNames: string[];
      jointCapabilities: { name: string; animationChannelAllowed: boolean; visualCloseUpStatus: string }[];
      jointHierarchy: { name: string; targetKind?: string }[];
      semanticRoles: { role: string; status: string; joint?: string; candidates: string[]; evidence: string[];
        jointContext?: { chainStatus: string; rootToJoint: { name: string; parent: string; driven: boolean }[] };
        candidateContexts?: { joint: string; context: { chainStatus: string; rootToJoint: { name: string }[] } }[];
        omittedCandidateContextCount?: number }[];
      authoringRules: string[] } } } }).result.result.aiRigSummary;
    assert.deepEqual(inspection.directlyAnimatableJointNames, ['Right Arm', 'Left Leg', 'BoneHand', 'PartWithoutGeometry', 'TransparentPart', 'UnverifiedPart']);
    assert.deepEqual(inspection.captureFocusEligibleJointNames, ['Right Arm'], 'AI should receive only Studio-verified close-up eligible nodes');
    assert.deepEqual(inspection.nonDrivenJointNames, ['HumanoidRootPart']);
    assert.deepEqual(inspection.jointCapabilities.map(({ name, animationChannelAllowed, visualCloseUpStatus }) =>
      [name, animationChannelAllowed, visualCloseUpStatus]), [
      ['HumanoidRootPart', false, 'not_driven'],
      ['Right Arm', true, 'eligible'],
      ['Left Leg', true, 'studio_capture_not_eligible'],
      ['BoneHand', true, 'bone_without_independent_part'],
      ['PartWithoutGeometry', true, 'part_geometry_unavailable'],
      ['TransparentPart', true, 'fully_transparent'],
      ['UnverifiedPart', true, 'inspection_node_unverified'],
    ], 'AI should receive explicit per-joint authoring and rendered-close-up capabilities');
    assert.deepEqual(inspection.jointHierarchy.filter(joint => joint.targetKind).map(joint => [joint.name, joint.targetKind]),
      [['Right Arm', 'Motor6D'], ['Left Leg', 'Motor6D'], ['BoneHand', 'Bone'], ['PartWithoutGeometry', 'Motor6D'],
        ['TransparentPart', 'Motor6D'], ['UnverifiedPart', 'Motor6D']], 'AI should receive the verified per-node driver class');
    const role = (name: string) => inspection.semanticRoles.find(item => item.role === name)!;
    assert.deepEqual([role('right_shoulder').status, role('right_shoulder').joint], ['exact', 'Right Arm']);
    assert.deepEqual([role('right_hand').status, role('right_hand').joint], ['exact', 'Right Arm']);
    assert.equal(role('right_hand').jointContext?.chainStatus, 'complete',
      'AI rig inspection must preserve hierarchy completeness from the semantic resolver');
    assert.deepEqual(role('right_hand').jointContext?.rootToJoint.map(joint => [joint.name, joint.parent, joint.driven]), [
      ['HumanoidRootPart', '', false], ['Right Arm', 'HumanoidRootPart', true],
    ], 'role evidence must carry the exact inspected root-to-joint chain into the AI-facing summary');
    assert.ok(role('right_hand').evidence.some(item => /endpoint role, not a separate wrist\/ankle joint/i.test(item)));
    assert.equal(role('right_elbow').status, 'unavailable');
    assert.ok(inspection.authoringRules.some(rule => /only for exact names in directlyAnimatableJointNames/i.test(rule)));
    assert.ok(inspection.authoringRules.some(rule => /jointCapabilities combines per-joint authoring permission/i.test(rule)));
    assert.ok(inspection.authoringRules.some(rule => /not local animation axes, joint limits/i.test(rule)));
    assert.ok(inspection.authoringRules.some(rule => /require the chosen role jointContext\.chainStatus to be complete/i.test(rule)));

    const incompleteRigId = randomUUID(), incompleteSignature = 'ai-rig-summary-incomplete-parent-v1';
    queue.heartbeat(sessionId, { activeRig: { id: incompleteRigId, rigSignature: incompleteSignature } });
    const incompleteInspect = await client.callTool({ name: 'motion_studio_inspect', arguments: { sessionId, rigId: incompleteRigId } });
    assert.ok(!incompleteInspect.isError, JSON.stringify(incompleteInspect));
    const incompleteInspectJobId = (incompleteInspect.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.id, incompleteInspectJobId);
    const incompleteProfile = { version: 1 as const, rigId: incompleteRigId, rigName: 'Incomplete Ancestry', rigType: 'custom' as const,
      rigSignature: incompleteSignature, joints: [{ name: 'hand_left', parent: 'MissingArm', driven: true,
        basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 }] };
    queue.complete(sessionId, incompleteInspectJobId, true, { id: incompleteRigId, rigSignature: incompleteSignature, retargetProfile: incompleteProfile });
    const incompleteInspection = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: incompleteInspectJobId } });
    assert.ok(!incompleteInspection.isError, JSON.stringify(incompleteInspection));
    const incompleteRole = ((incompleteInspection.structuredContent as { result: { result: { aiRigSummary: {
      semanticRoles: { role: string; jointContext?: { chainStatus: string; rootToJoint: { name: string }[] } }[] } } } }).result.result.aiRigSummary)
      .semanticRoles.find(item => item.role === 'left_hand');
    assert.equal(incompleteRole?.jointContext?.chainStatus, 'parent_missing',
      'the AI must be warned when a resolved role does not have a complete inspected ancestor chain');
    assert.deepEqual(incompleteRole?.jointContext?.rootToJoint.map(joint => joint.name), ['hand_left']);
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });

    const roleAuditAsset = await library.save({ kind: 'animation', name: 'R6 role coverage', duration: 1, loop: false,
      tracks: [{ joint: 'Right Arm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [0, 15, 0] }] }], markers: [],
      contacts: [{ effector: 'Right Arm', kind: 'grip', start: 0.2, end: 0.8 },
        { effector: 'Left Leg', kind: 'support', start: 0.1, end: 0.9 }, { effector: 'UnknownHand', kind: 'grip', start: 0.3, end: 0.7 }] }, undefined, profile);
    const roleAudit = await client.callTool({ name: 'motion_animation_audit', arguments: { assetId: roleAuditAsset.id, sessionId, rigId } });
    assert.ok(!roleAudit.isError, JSON.stringify(roleAudit));
    const roleAuditResult = (roleAudit.structuredContent as { result: { rigCoverage: { contacts: {
      effector: string; rigJoint: string; rigStatus: string; channelStatus: string;
    }[]; semanticRoleCoverage: {
      summary: { activeRoleCount: number }; roles: { role: string; resolution: string; state: string; joint?: string }[]; limitation: string } } } }).result.rigCoverage.semanticRoleCoverage;
    const rigContactCoverage = (roleAudit.structuredContent as { result: { rigCoverage: { contacts: {
      effector: string; rigJoint: string; rigStatus: string; channelStatus: string;
    }[] } } }).result.rigCoverage.contacts;
    assert.deepEqual(rigContactCoverage.map(contact => [contact.effector, contact.rigJoint, contact.rigStatus, contact.channelStatus]), [
      ['Right Arm', 'Right Arm', 'driven', 'active_channel'],
      ['Left Leg', 'Left Leg', 'driven', 'no_matching_channel'],
      ['UnknownHand', 'UnknownHand', 'unresolved', 'no_matching_channel'],
    ]);
    const semanticCoverage = roleAuditResult;
    assert.equal(semanticCoverage.roles.find(item => item.role === 'right_shoulder')?.state, 'active');
    assert.equal(semanticCoverage.roles.find(item => item.role === 'right_hand')?.state, 'active');
    assert.equal(semanticCoverage.roles.find(item => item.role === 'left_foot')?.state, 'not_authored');
    assert.equal(semanticCoverage.roles.find(item => item.role === 'right_elbow')?.resolution, 'unavailable');
    assert.ok(semanticCoverage.summary.activeRoleCount > 0);
    assert.match(semanticCoverage.limitation, /not a quality score or quota/i);

    const mismatchedInspect = await client.callTool({ name: 'motion_studio_inspect', arguments: { sessionId, rigId } });
    const mismatchedJobId = (mismatchedInspect.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.id, mismatchedJobId);
    queue.complete(sessionId, mismatchedJobId, true, { id: randomUUID(), rigSignature, retargetProfile: profile });
    const rejected = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: mismatchedJobId } });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /different rig or inconsistent topology/i);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Studio local animation browser returns bounded verified metadata and refuses stale inventory results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-local-animation-browser-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'local-animation-browser-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'local-animation-browser-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const queued = await client.callTool({ name: 'motion_studio_list_local_animations', arguments: { sessionId, rigId } });
    assert.ok(!queued.isError, JSON.stringify(queued));
    const jobId = (queued.structuredContent as { result: { jobId: string } }).result.jobId;
    const job = queue.poll(sessionId);
    assert.equal(job?.id, jobId);
    assert.equal(job?.operation, 'list_local_animations');
    assert.deepEqual(job?.payload, { rigId });
    assert.equal((await library.list()).total, 0, 'browsing source clips is read-only');
    queue.complete(sessionId, jobId, true, { rigName: 'Rig', folderName: 'AnimSaves', totalCount: 3, returnedCount: 3,
      truncated: false, clips: [
        { sequenceName: 'Attack', className: 'KeyframeSequence', duration: 1.5, path: 'Rig.AnimSaves.Attack', sequenceLocator: '1', trackCount: 5, keyframeCount: 12, poseCount: 38, markerCount: 2, ambiguousName: false, nameMatchCount: 1 },
        { sequenceName: 'Idle', className: 'CurveAnimation', duration: 3, path: 'Rig.AnimSaves.Idle', sequenceLocator: '2', trackCount: 15, keyframeCount: 15, poseCount: 0, markerCount: 0, ambiguousName: true, nameMatchCount: 2 },
        { sequenceName: 'Idle', className: 'KeyframeSequence', duration: 2, path: 'Rig.AnimSaves.Folder.Idle', sequenceLocator: '3.1', trackCount: 6, keyframeCount: 8, poseCount: 40, markerCount: 1, ambiguousName: true, nameMatchCount: 2 },
      ], note: 'Read-only local inventory.' });
    const read = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!read.isError, JSON.stringify(read));
    const result = (read.structuredContent as { result: { result: { clips: { sequenceName: string; ambiguousName: boolean; nameMatchCount: number }[] } } }).result.result;
    assert.equal(result.clips.length, 3);
    assert.equal(result.clips[0]?.ambiguousName, false);
    assert.equal(result.clips[1]?.ambiguousName, true);
    assert.equal(result.clips[2]?.nameMatchCount, 2);

    const staleQueued = await client.callTool({ name: 'motion_studio_list_local_animations', arguments: { sessionId, rigId } });
    assert.ok(!staleQueued.isError, JSON.stringify(staleQueued));
    const staleJobId = (staleQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    queue.poll(sessionId);
    queue.complete(sessionId, staleJobId, true, { rigName: 'Rig', folderName: 'AnimSaves', totalCount: 0, returnedCount: 0,
      truncated: false, clips: [], note: 'Read-only local inventory.' });
    queue.heartbeat(sessionId, { activeRig: { id: randomUUID(), rigSignature: 'another-rig' } });
    const staleRead = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: staleJobId } });
    assert.equal(staleRead.isError, true);
    assert.match(JSON.stringify(staleRead), /selected rig changed/i);
  } finally {
    await client.close(); await server.close();
  }
});

test('batch import preview isolates clip failures and successful entries continue through exact export-gated commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-import-batch-preview-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'import-batch-rig-v1';
  const recipe = animationPreset('idle', 'Imported batch clip', 1, 1);
  const alternateRecipe = animationPreset('walk', 'Imported alternate clip', 1, 1);
  const sourceRigProfile = { version: 1 as const, rigId, rigName: 'Batch Source Rig', rigType: 'R15' as const, rigSignature,
    joints: recipe.tracks.map(track => ({ name: track.joint, parent: '', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 })) };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'import-batch-preview-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const sources = [
      { sequenceName: 'Duplicate Idle', sequenceLocator: '2.1' },
      { sequenceName: 'Duplicate Idle', sequenceLocator: '3.1' },
      { sourceAssetId: '987654', name: 'Forbidden Asset' },
    ];
    const queued = await client.callTool({ name: 'motion_studio_import_animation_batch_preview', arguments: { sessionId, rigId, sources } });
    assert.ok(!queued.isError, JSON.stringify(queued));
    const jobId = (queued.structuredContent as { result: { jobId: string } }).result.jobId;
    const delivered = queue.poll(sessionId);
    assert.equal(delivered?.id, jobId);
    assert.equal(delivered?.operation, 'import_animation_batch_preview');
    assert.deepEqual((delivered?.payload as { sources: unknown[] }).sources, sources);
    const duplicateBatch = await client.callTool({ name: 'motion_studio_import_animation_batch_preview',
      arguments: { sessionId, rigId, sources: [sources[0], sources[0]] } });
    assert.equal(duplicateBatch.isError, true);
    assert.match(JSON.stringify(duplicateBatch), /sources must be unique/i);
    assert.equal((await library.list()).total, 0);
    queue.complete(sessionId, jobId, true, { rigId, rigSignature, saved: false, note: 'Independent per-source outcomes.', results: [
      { index: 1, status: 'converted', source: sources[0], recipe, sourceRigProfile,
        sourceIdentity: { kind: 'anim_saves', sequenceName: 'Duplicate Idle', sequenceLocator: '2.1' },
        sourceType: 'KeyframeSequence', unmapped: [], diagnostics: { conversionMode: 'keyframe_sequence_pose_tracks',
          fidelity: 'source_keyframes_preserved', warnings: [] }, saved: false },
      { index: 2, status: 'converted', source: sources[1], recipe: alternateRecipe, sourceRigProfile,
        sourceIdentity: { kind: 'anim_saves', sequenceName: 'Duplicate Idle', sequenceLocator: '3.1' },
        sourceType: 'KeyframeSequence', unmapped: [], diagnostics: { conversionMode: 'keyframe_sequence_pose_tracks',
          fidelity: 'source_keyframes_preserved', warnings: [] }, saved: false },
      { index: 3, status: 'failed', source: sources[2], error: 'Studio could not load this asset.', saved: false },
    ] });
    const read = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!read.isError, JSON.stringify(read));
    const batch = (read.structuredContent as { result: { result: { succeededCount: number; failedCount: number;
      results: { status: string; candidateFingerprint?: string; qualityReport?: { recipeLimits: { nativeRobloxExport: string } } }[] } } }).result.result;
    assert.equal(batch.succeededCount, 2);
    assert.equal(batch.failedCount, 1);
    assert.equal(batch.results[0]?.status, 'converted');
    assert.equal(batch.results[0]?.qualityReport?.recipeLimits.nativeRobloxExport, 'not_tested');
    assert.equal(batch.results[2]?.status, 'failed');
    const candidateFingerprint = batch.results[0]?.candidateFingerprint;
    const failedPreflightCandidate = batch.results[1]?.candidateFingerprint;
    assert.ok(candidateFingerprint);
    assert.ok(failedPreflightCandidate);
    assert.equal((await library.list()).total, 0, 'batch preview does not persist converted candidates');

    const preflight = await client.callTool({ name: 'motion_studio_import_animation_validate_export_batch',
      arguments: { candidateFingerprints: [candidateFingerprint, failedPreflightCandidate] } });
    assert.ok(!preflight.isError, JSON.stringify(preflight));
    const preflightJobId = (preflight.structuredContent as { result: { jobId: string } }).result.jobId;
    const exportJob = queue.poll(sessionId);
    assert.equal(exportJob?.id, preflightJobId);
    const exportPayload = exportJob?.payload as { rigId: string; rigSignature: string; jointMap: Record<string, string>;
      candidates: { assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[] };
    assert.equal(exportJob?.operation, 'validate_animation_export_batch');
    queue.complete(sessionId, preflightJobId, true, { rigId: exportPayload.rigId, rigSignature: exportPayload.rigSignature, saved: false,
      note: 'Batch candidate conversion fixture.', candidates: [
        { status: 'valid', assetId: exportPayload.candidates[0]!.assetId, assetFingerprint: exportPayload.candidates[0]!.assetFingerprint,
          frameCount: 2, poseCount: 2, markerCount: 0,
          animatedTrackCount: mappedAnimationTargets(exportPayload.candidates[0]!.recipe, exportPayload.jointMap).length,
          mappedTargetJoints: mappedAnimationTargets(exportPayload.candidates[0]!.recipe, exportPayload.jointMap) },
        { status: 'invalid', assetId: exportPayload.candidates[1]!.assetId, assetFingerprint: exportPayload.candidates[1]!.assetFingerprint,
          error: 'Source track does not map to a target joint.' },
      ] });
    const preflightRead = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: preflightJobId } });
    assert.ok(!preflightRead.isError, JSON.stringify(preflightRead));
    const batchExportResult = (preflightRead.structuredContent as { result: { result: { summary: { valid: number; invalid: number };
      candidates: { status: string; importCandidateFingerprint?: string }[] } } }).result.result;
    assert.equal(batchExportResult.summary.valid, 1);
    assert.equal(batchExportResult.summary.invalid, 1);
    assert.equal(batchExportResult.candidates[0]?.importCandidateFingerprint, candidateFingerprint);
    assert.equal(batchExportResult.candidates[1]?.importCandidateFingerprint, failedPreflightCandidate);
    const retriedInvalid = await client.callTool({ name: 'motion_studio_import_animation_validate_export', arguments: { expectedCandidateFingerprint: failedPreflightCandidate } });
    assert.ok(!retriedInvalid.isError, JSON.stringify(retriedInvalid));
    const retryJobId = (retriedInvalid.structuredContent as { result: { jobId: string } }).result.jobId;
    const retryJob = queue.poll(sessionId);
    assert.equal(retryJob?.id, retryJobId);
    assert.equal(retryJob?.operation, 'validate_animation_export', 'failed batch members can be retried individually');
    const retryPayload = retryJob?.payload as { assetId: string; assetFingerprint: string; rigId: string; rigSignature: string; recipe: AnimationRecipe };
    const retryMappedTargets = mappedAnimationTargets(retryPayload.recipe, {});
    queue.complete(sessionId, retryJobId, true, { valid: true, assetId: retryPayload.assetId, assetFingerprint: retryPayload.assetFingerprint,
      rigId: retryPayload.rigId, rigSignature: retryPayload.rigSignature, frameCount: 2, poseCount: 3, markerCount: 0,
      animatedTrackCount: retryMappedTargets.length, mappedTargetJoints: retryMappedTargets,
      format: 'KeyframeSequence', saved: false, note: 'Retry candidate conversion fixture.' });
    const retryRead = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: retryJobId } });
    assert.ok(!retryRead.isError, JSON.stringify(retryRead));
    const recoveryQueue = new Queue();
    recoveryQueue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const recoveryServer = createMcp(library, recoveryQueue, new Blender(root, 'blender'));
    const recoveryClient = new Client({ name: 'import-batch-recovery-test', version: '1.0.0' });
    const [recoveryClientTransport, recoveryServerTransport] = InMemoryTransport.createLinkedPair();
    try {
      await recoveryServer.connect(recoveryServerTransport);
      await recoveryClient.connect(recoveryClientTransport);
      const recoveredList = await recoveryClient.callTool({ name: 'motion_studio_import_candidate_recover', arguments: {} });
      assert.ok(!recoveredList.isError, JSON.stringify(recoveredList));
      const listed = (recoveredList.structuredContent as { result: { candidates: { candidateFingerprint: string; exportValidated: boolean }[] } }).result;
      assert.equal(listed.candidates.length, 2);
      assert.equal(listed.candidates[0]?.candidateFingerprint, candidateFingerprint);
      assert.equal(listed.candidates[0]?.exportValidated, true);
      assert.equal(listed.candidates[1]?.candidateFingerprint, failedPreflightCandidate);
      assert.equal(listed.candidates[1]?.exportValidated, true);
      const recovered = await recoveryClient.callTool({ name: 'motion_studio_import_candidate_recover', arguments: { candidateFingerprint } });
      assert.ok(!recovered.isError, JSON.stringify(recovered));
      const recoveredResult = (recovered.structuredContent as { result: { recipe: AnimationRecipe; exportEvidence: { frameCount: number } } }).result;
      assert.equal(recoveredResult.recipe.name, recipe.name);
      assert.equal(recoveredResult.exportEvidence.frameCount, 2);
      const committed = await recoveryClient.callTool({ name: 'motion_studio_import_animation_commit', arguments: { expectedCandidateFingerprint: candidateFingerprint } });
      assert.ok(!committed.isError, JSON.stringify(committed));
      const imported = (committed.structuredContent as { result: { assetId: string; importProvenance: { sourceIdentity: { sequenceLocator?: string } } } }).result;
      assert.equal(imported.importProvenance.sourceIdentity.sequenceLocator, '2.1');
    } finally {
      await recoveryClient.close(); await recoveryServer.close();
    }
    assert.equal((await library.list()).total, 1);
  } finally {
    await client.close(); await server.close();
  }
});

test('Roblox animation import preview is non-persistent and commits only the exact live-rig candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-import-preview-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'import-preview-rig-v1';
  const recipe = animationPreset('idle', 'Imported preview fixture', 1, 1);
  const sourceRigProfile = { version: 1 as const, rigId, rigName: 'Import Preview Rig', rigType: 'R15' as const, rigSignature,
    joints: recipe.tracks.map(track => ({ name: track.joint, parent: '', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 })) };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'import-preview-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const previewQueued = await client.callTool({ name: 'motion_studio_import_animation_preview', arguments: { sessionId, rigId, sourceAssetId: '13579' } });
    assert.ok(!previewQueued.isError, JSON.stringify(previewQueued));
    const previewJobId = (previewQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal((await library.list()).total, 0, 'queuing a read-only import preview does not persist an asset');
    const delivered = queue.poll(sessionId);
    assert.equal(delivered?.operation, 'import_animation_preview');
    assert.equal((delivered?.payload as { previewOnly: boolean }).previewOnly, true);
    queue.complete(sessionId, previewJobId, true, { previewOnly: true, recipe, sourceRigProfile,
      sourceIdentity: { kind: 'asset', assetId: '13579' }, sourceType: 'KeyframeSequence', unmapped: [],
      diagnostics: { conversionMode: 'keyframe_sequence_pose_tracks', fidelity: 'source_keyframes_preserved', warnings: [] },
      saved: false, note: 'Preview only.' });
    const previewRead = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: previewJobId } });
    assert.ok(!previewRead.isError, JSON.stringify(previewRead));
    const preview = (previewRead.structuredContent as { result: { result: { candidateFingerprint: string; recipe: unknown; saved: boolean; qualityReport: {
      status: string; coverage: { percent: number; unmappedJoints: string[] }; structure: { totalKeys: number; easing: { segmentCount: number } };
      recipeLimits: { nativeRobloxExport: string }; findings: { id: string; status: string }[]; limitation: string;
    } } } }).result.result;
    assert.match(preview.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(preview.saved, false);
    assert.equal(preview.qualityReport.coverage.percent, 100);
    assert.deepEqual(preview.qualityReport.coverage.unmappedJoints, []);
    assert.equal(preview.qualityReport.structure.totalKeys, recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0));
    assert.ok(preview.qualityReport.structure.easing.segmentCount > 0);
    assert.equal(preview.qualityReport.recipeLimits.nativeRobloxExport, 'not_tested');
    assert.ok(preview.qualityReport.findings.some(finding => finding.id === 'native-export' && finding.status === 'not-tested'));
    assert.match(preview.qualityReport.limitation, /not an animation-quality score/i);
    assert.equal((await library.list()).total, 0, 'reading and inspecting the preview remains non-persistent');
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'changed-after-import-preview' } });
    const staleRigCommit = await client.callTool({ name: 'motion_studio_import_animation_commit', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.equal(staleRigCommit.isError, true);
    assert.match(JSON.stringify(staleRigCommit), /active Studio rig changed/i);
    assert.equal((await library.list()).total, 0, 'a stale-rig commit is rejected before creating an asset');
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const earlyCommit = await client.callTool({ name: 'motion_studio_import_animation_commit', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.equal(earlyCommit.isError, true);
    assert.match(JSON.stringify(earlyCommit), /export preflight has not succeeded/i);
    const preflightQueued = await client.callTool({ name: 'motion_studio_import_animation_validate_export', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.ok(!preflightQueued.isError, JSON.stringify(preflightQueued));
    const preflightJobId = (preflightQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const exportJob = queue.poll(sessionId);
    assert.equal(exportJob?.id, preflightJobId);
    assert.equal(exportJob?.operation, 'validate_animation_export');
    const exportPayload = exportJob?.payload as { assetId: string; assetFingerprint: string; rigId: string; rigSignature: string; recipe: AnimationRecipe };
    const importMappedTargets = mappedAnimationTargets(exportPayload.recipe, {});
    queue.complete(sessionId, preflightJobId, true, { valid: true, assetId: exportPayload.assetId, assetFingerprint: exportPayload.assetFingerprint,
      rigId: exportPayload.rigId, rigSignature: exportPayload.rigSignature, frameCount: 2, poseCount: 3, markerCount: 0,
      animatedTrackCount: importMappedTargets.length, mappedTargetJoints: importMappedTargets,
      format: 'KeyframeSequence', saved: false, note: 'Import export fixture.' });
    const preflightRead = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: preflightJobId } });
    assert.ok(!preflightRead.isError, JSON.stringify(preflightRead));
    const exportEvidence = (preflightRead.structuredContent as { result: { result: { candidate: boolean; saveAuthorized: boolean; importCandidateFingerprint: string } } }).result.result;
    assert.equal(exportEvidence.candidate, true);
    assert.equal(exportEvidence.saveAuthorized, false);
    assert.equal(exportEvidence.importCandidateFingerprint, preview.candidateFingerprint);
    const retriedPreflight = await client.callTool({ name: 'motion_studio_import_animation_validate_export', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.ok(!retriedPreflight.isError, JSON.stringify(retriedPreflight));
    assert.equal((retriedPreflight.structuredContent as { result: { jobId: string } }).result.jobId, preflightJobId,
      'repeated export validation reuses the same Studio conversion job');
    const committed = await client.callTool({ name: 'motion_studio_import_animation_commit', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.ok(!committed.isError, JSON.stringify(committed));
    const committedResult = (committed.structuredContent as { result: { assetId: string; jobId: string; importProvenance: { sourceIdentity: { kind: string; assetId?: string } };
      qualityReport: { coverage: { percent: number }; recipeLimits: { nativeRobloxExport: string }; nativeExportEvidence: { frameCount: number }; findings: { id: string; status: string }[] } } }).result;
    assert.equal(committedResult.importProvenance.sourceIdentity.kind, 'asset');
    assert.equal(committedResult.importProvenance.sourceIdentity.assetId, '13579');
    assert.equal(committedResult.qualityReport.coverage.percent, 100);
    assert.equal(committedResult.qualityReport.recipeLimits.nativeRobloxExport, 'passed');
    assert.equal(committedResult.qualityReport.nativeExportEvidence.frameCount, 2);
    assert.ok(committedResult.qualityReport.findings.some(finding => finding.id === 'native-export' && finding.status === 'passed'));
    assert.equal((await library.list()).total, 1);
    const opened = queue.poll(sessionId);
    assert.equal(opened?.operation, 'open_animation');
    const retriedCommit = await client.callTool({ name: 'motion_studio_import_animation_commit', arguments: { expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.ok(!retriedCommit.isError, JSON.stringify(retriedCommit));
    assert.equal((retriedCommit.structuredContent as { result: { assetId: string; jobId: string } }).result.assetId, committedResult.assetId);
    assert.equal((retriedCommit.structuredContent as { result: { assetId: string; jobId: string } }).result.jobId, committedResult.jobId);
    assert.equal((await library.list()).total, 1, 'a repeated commit reuses both the saved asset and the viewport-open job');
  } finally {
    await client.close(); await server.close();
  }
});

test('saved animation capture jobs return exact complete and partial review coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-saved-capture-coverage-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const asset = await library.save(animationPreset('idle', 'Saved visual review', 1, 1));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'saved-capture-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  seedCaptureFocusInspection(queue, sessionId, rigId, rigSignature, ['RightHand', 'Torso']);
  const reviews = new Reviews(join(root, 'artifacts', 'reviews'), library, queue, new Connections(join(root, '.local', 'providers.json')));
  const requestedFrames = [{ time: 0, view: 'front' as const }, { time: 0.5, view: 'side' as const, focusJoint: 'RightHand' }];
  const reviewId = randomUUID();
  const seededReview: ReviewRecord = { id: reviewId, revision: 1, createdAt: new Date().toISOString(), assetId: asset.id,
    assetHash: fingerprint(asset.recipe), assetName: asset.recipe.name, parentAssetId: asset.parentId, rigSignature,
    status: 'needs_feedback', request: { assetId: asset.id, sessionId, rigId, motionMode: 'unknown', preview: false, aiReview: false,
      plannedCaptureFrames: requestedFrames },
    report: { source: 'recipe_only', metrics: [], findings: [], questions: [], limitations: [] }, images: [] };
  await mkdir(join(root, 'artifacts', 'reviews', reviewId), { recursive: true });
  await writeFile(join(root, 'artifacts', 'reviews', reviewId, '000001.json'), JSON.stringify(seededReview));
  const client = new Client({ name: 'saved-capture-coverage-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const alternatePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const pngByCaptureId = new Map<string, Buffer>();
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  let chunkPoller: NodeJS.Timeout | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const captureJob = async (complete: boolean, wrongFrame = false, wrongFocusJoint = false,
      frameSchedule: typeof requestedFrames = requestedFrames, jointMap: Record<string, string> = { UpperTorso: 'Torso' }) => {
      const queued = await client.callTool({ name: 'motion_studio_capture_views', arguments: { sessionId, rigId, assetId: asset.id, jointMap,
        expectedFingerprint: fingerprint(asset.recipe), frames: frameSchedule } });
      assert.ok(!queued.isError, JSON.stringify(queued));
      const jobId = (queued.structuredContent as { result: { jobId: string } }).result.jobId;
      const command = queue.poll(sessionId);
      assert.ok(command);
      assert.equal(command.operation, 'capture_frames');
      const payload = command.payload as { assetId: string; assetFingerprint: string; rigSignature: string; recipe: AnimationRecipe; jointMap: Record<string, string> };
      const captureFrame = (index: number) => {
        const requested = frameSchedule[index]!;
        const captureId = randomUUID();
        const image = index % 2 === 0 ? png : alternatePng;
        pngByCaptureId.set(captureId, image);
        return { captureId, sessionId, assetId: payload.assetId, assetFingerprint: payload.assetFingerprint,
          rigId, rigSignature: payload.rigSignature, time: wrongFrame ? 0.25 : requested.time, view: requested.view,
          ...(requested.focusJoint ? { focusJoint: wrongFocusJoint ? 'Torso' : requested.focusJoint } : {}),
          appliedJointMap: resolvedCaptureJointMap(payload.recipe, payload.jointMap),
          byteCount: image.length, chunks: 1, width: 1, height: 1, note: 'saved capture fixture' };
      };
      const frameCount = complete ? frameSchedule.length : 1;
      queue.complete(sessionId, command.id, true, { assetId: payload.assetId, rigId, sessionId, complete,
        ...(!complete ? { failedIndex: 2, error: 'Fixture screenshot permission was revoked.' } : {}),
        frames: Array.from({ length: frameCount }, (_, index) => captureFrame(index)), note: 'saved capture fixture' });
      return client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    };

    const complete = await captureJob(true);
    assert.ok(!complete.isError, JSON.stringify(complete));
    const completeResult = (complete.structuredContent as { result: { result: { frames: { captureId: string; assetId: string; assetFingerprint: string; rigId: string;
      rigSignature: string; time: number; view: string; focusJoint?: string; byteCount: number; chunks: number; width: number; height: number;
      jointMapping: { fingerprint: string; renamedJointCount: number; nameMapApplied: boolean; limitation: string } }[]; captureCoverage: {
      status: string; requestedFrameCount: number; capturedFrameCount: number; missingFrameCount: number;
      requestedFrames: { time: number; view: string; focusJoint?: string }[]; capturedFrames: { captureId: string; time: number; view: string; focusJoint?: string }[]; missingFrames: unknown[];
    }; next: string } } }).result.result;
    assert.equal(completeResult.captureCoverage.status, 'complete');
    assert.equal(completeResult.captureCoverage.requestedFrameCount, 2);
    assert.equal(completeResult.captureCoverage.capturedFrameCount, 2);
    assert.equal(completeResult.captureCoverage.missingFrameCount, 0);
    assert.deepEqual(completeResult.captureCoverage.requestedFrames, requestedFrames);
    assert.equal(completeResult.frames[1]?.focusJoint, 'RightHand', 'Studio capture metadata must preserve the exact focused rig node');
    assert.deepEqual(completeResult.captureCoverage.capturedFrames.map(({ time, view, focusJoint }) => ({ time, view, ...(focusJoint ? { focusJoint } : {}) })), requestedFrames);
    assert.deepEqual(completeResult.captureCoverage.missingFrames, []);

    const mismatchedFocus = await captureJob(true, false, true);
    assert.equal(mismatchedFocus.isError, true, 'a capture for a different focused joint must not be accepted as requested visual evidence');
    assert.match(JSON.stringify(mismatchedFocus), /Mismatched field\(s\): focusJoint/i);

    const seededRead = await reviews.read(reviewId);
    assert.equal(seededRead.status, 'needs_feedback');
    assert.match(completeResult.next,
      /read_candidate_captures.*inspect every PNG.*motion_review_attach_captures.*visualCaptureCoverage/i);
    chunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const command = queue.poll(sessionId);
      if (!command) return;
      if (command.operation === 'capture_chunk') {
        const chunkPayload = command.payload as { captureId: string; index: number };
        const image = pngByCaptureId.get(chunkPayload.captureId);
        assert.ok(image, `missing test PNG for capture ${chunkPayload.captureId}`);
        queue.complete(sessionId, command.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: image.toString('hex') });
      }
    }, 2);
    const savedImages = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: completeResult.frames.map(frame => frame.captureId),
    } });
    assert.ok(!savedImages.isError, JSON.stringify(savedImages));
    const savedImageResult = (savedImages.structuredContent as { result: { imageCount: number;
      images: { metadata: { captureId: string; captureBatchId: string; source: string; assetFingerprint: string; rigSignature: string;
        visualSignal: { sampledPixelCount: number; warnings: string[]; limitation: string };
        jointMapping: { fingerprint: string; renamedJointCount: number; nameMapApplied: boolean } };
        reviewCapture: { captureId: string; assetId: string; assetFingerprint: string; captureBatchId: string; captureSource: string; rigId: string; rigSignature: string;
          time: number; view: string; focusJoint?: string; byteCount: number; chunks: number; width: number; height: number;
          jointMapping: { fingerprint: string; renamedJointCount: number; nameMapApplied: boolean } };
        visualReviewTemplate: { captureId: string; source: string; authoringIntentTimingRelation: 'exact_current_recipe' | 'historical_reference' | 'unavailable';
          pixelSignal: { warnings: string[] }; protocol: string } }[] } }).result;
    assert.equal(savedImageResult.imageCount, 2);
    assert.deepEqual(savedImageResult.images.map(image => [image.metadata.source, image.visualReviewTemplate.source,
      image.metadata.captureId, image.visualReviewTemplate.captureId]),
    completeResult.frames.map(frame => ['saved_animation', 'saved_animation', frame.captureId, frame.captureId]));
    assert.ok(savedImageResult.images.every(image => image.metadata.assetFingerprint === fingerprint(asset.recipe)
      && image.metadata.rigSignature === rigSignature && image.metadata.jointMapping.renamedJointCount === 1
      && image.metadata.jointMapping.nameMapApplied));
    assert.ok(savedImageResult.images.every(image => image.metadata.visualSignal.sampledPixelCount === 1
      && image.metadata.visualSignal.warnings.length === 0 && image.visualReviewTemplate.pixelSignal.warnings.length === 0));
    assert.ok(savedImageResult.images.every(image => /absence of warnings does not prove.*legible.*mark the observation unclear.*never guess/i
      .test(image.visualReviewTemplate.protocol)));
    assert.ok(savedImageResult.images.every(image => image.visualReviewTemplate.authoringIntentTimingRelation === 'unavailable'),
      'image templates should explicitly report absent optional authoring intent');
    assert.match(savedImageResult.images[0]!.metadata.visualSignal.limitation, /do not establish correct framing/i);
    for (const image of savedImageResult.images) {
      assert.equal(image.reviewCapture.captureId, image.metadata.captureId);
      assert.equal(image.reviewCapture.assetFingerprint, image.metadata.assetFingerprint);
      assert.equal(image.reviewCapture.captureBatchId, image.metadata.captureBatchId);
      assert.equal(image.reviewCapture.captureSource, image.metadata.source);
      assert.equal(image.reviewCapture.jointMapping.fingerprint, image.metadata.jointMapping.fingerprint);
    }
    assert.equal(savedImageResult.images[1]?.reviewCapture.focusJoint, 'RightHand', 'image retrieval must preserve the focused joint through review attachment metadata');
    const supplementalCapture = await captureJob(true, false, false, [{ time: 0.25, view: 'front' as const }]);
    assert.ok(!supplementalCapture.isError, JSON.stringify(supplementalCapture));
    const supplementalFrames = (supplementalCapture.structuredContent as { result: { result: { frames: { captureId: string }[] } } }).result.result.frames;
    const crossBatchRead = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: [completeResult.frames[0]!.captureId, supplementalFrames[0]!.captureId],
    } });
    assert.ok(!crossBatchRead.isError, JSON.stringify(crossBatchRead));
    const crossBatchResult = (crossBatchRead.structuredContent as { result: { sequenceGroups: { captureBatchId: string }[];
      temporalContinuityGroups: { source: string; assetFingerprint: string; rigSignature: string; view: string; captureBatchIds: string[];
        frameCount: number; distinctSampleTimeCount: number; temporalSampling: { firstSampleTime: number; lastSampleTime: number;
          largestGap: { seconds: number; fromTime: number; toTime: number; suggestedTime: number | null } | null };
        frames: { time: number; captureBatchId: string }[] }[] } }).result;
    assert.equal(crossBatchResult.sequenceGroups.length, 2, 'strict batch storyboards remain separate');
    assert.equal(crossBatchResult.temporalContinuityGroups.length, 1, 'exact-identity captures from distinct batches form one continuity timeline');
    assert.equal(crossBatchResult.temporalContinuityGroups[0]!.frameCount, 2);
    assert.equal(crossBatchResult.temporalContinuityGroups[0]!.distinctSampleTimeCount, 2);
    assert.equal(crossBatchResult.temporalContinuityGroups[0]!.temporalSampling.largestGap?.seconds, 0.25);
    assert.equal(crossBatchResult.temporalContinuityGroups[0]!.temporalSampling.largestGap?.suggestedTime, 0.125);
    assert.equal(new Set(crossBatchResult.temporalContinuityGroups[0]!.frames.map(frame => frame.captureBatchId)).size, 2,
      'each frame retains the batch that produced it');
    const remappedCapture = await captureJob(true, false, false, [{ time: 0.25, view: 'front' as const }], { UpperTorso: 'RightHand' });
    assert.ok(!remappedCapture.isError, JSON.stringify(remappedCapture));
    const remappedFrame = (remappedCapture.structuredContent as { result: { result: { frames: { captureId: string }[] } } }).result.result.frames[0]!;
    const mappingSeparatedRead = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: [completeResult.frames[0]!.captureId, remappedFrame.captureId],
    } });
    assert.ok(!mappingSeparatedRead.isError, JSON.stringify(mappingSeparatedRead));
    const mappingSeparatedResult = (mappingSeparatedRead.structuredContent as { result: { temporalContinuityGroups: {
      appliedJointMapFingerprint: string; frames: { captureBatchId: string }[] }[] } }).result;
    assert.equal(mappingSeparatedResult.temporalContinuityGroups.length, 2,
      'cross-batch visual timelines must not merge captures rendered with different applied joint maps');
    assert.equal(new Set(mappingSeparatedResult.temporalContinuityGroups.map(group => group.appliedJointMapFingerprint)).size, 2);
    const readyReview = await client.callTool({ name: 'motion_review_read', arguments: { reviewId } });
    assert.ok(!readyReview.isError, JSON.stringify(readyReview));
    const readyReviewRecord = (readyReview.structuredContent as { result: { id: string; revision: number; rigSignature: string } }).result;
    assert.equal(readyReviewRecord.rigSignature, rigSignature);
    const attached = await client.callTool({ name: 'motion_review_attach_captures', arguments: {
      reviewId: readyReviewRecord.id, revision: readyReviewRecord.revision, sessionId,
      captures: savedImageResult.images.map(image => image.reviewCapture),
    } });
    assert.ok(!attached.isError, JSON.stringify(attached));
    const attachmentResult = (attached.structuredContent as { result: { status: string; attachedCaptureIds: string[];
      reviewRevision: number; visualCaptureCoverage: { status: string; plannedFrameCount: number;
        coveredFrameCount: number; missingFrames: unknown[] }; next: string } }).result;
    assert.equal(attachmentResult.status, 'complete', JSON.stringify(attached));
    assert.deepEqual(attachmentResult.attachedCaptureIds, savedImageResult.images.map(image => image.metadata.captureId));
    assert.equal(attachmentResult.visualCaptureCoverage.status, 'complete');
    assert.equal(attachmentResult.visualCaptureCoverage.plannedFrameCount, requestedFrames.length);
    assert.equal(attachmentResult.visualCaptureCoverage.coveredFrameCount, requestedFrames.length);
    assert.deepEqual(attachmentResult.visualCaptureCoverage.missingFrames, []);
    assert.match(attachmentResult.next, /motion_review_read_images.*inspect every returned PNG.*motion_review_critique/i);
    assert.match(attachmentResult.next, new RegExp(`revision=${attachmentResult.reviewRevision}`));
    clearInterval(chunkPoller);
    chunkPoller = undefined;

    const partial = await captureJob(false);
    assert.ok(!partial.isError, JSON.stringify(partial));
    const partialResult = (partial.structuredContent as { result: { result: { captureCoverage: {
      status: string; capturedFrameCount: number; missingFrameCount: number; missingFrames: { time: number; view: string; focusJoint?: string }[]; failure: string;
    }; frames: { captureId: string }[] } } }).result.result;
    assert.equal(partialResult.captureCoverage.status, 'partial');
    assert.equal(partialResult.captureCoverage.capturedFrameCount, 1);
    assert.equal(partialResult.captureCoverage.missingFrameCount, 1);
    assert.deepEqual(partialResult.captureCoverage.missingFrames, [{ time: 0.5, view: 'side', focusJoint: 'RightHand' }]);
    assert.equal(partialResult.captureCoverage.failure, 'Fixture screenshot permission was revoked.');

    const retryReviewId = randomUUID();
    await mkdir(join(root, 'artifacts', 'reviews', retryReviewId), { recursive: true });
    await writeFile(join(root, 'artifacts', 'reviews', retryReviewId, '000001.json'), JSON.stringify({ ...seededReview, id: retryReviewId }));
    chunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const command = queue.poll(sessionId);
      if (!command || command.operation !== 'capture_chunk') return;
      const chunkPayload = command.payload as { captureId: string; index: number };
      const image = pngByCaptureId.get(chunkPayload.captureId);
      assert.ok(image, `missing test PNG for capture ${chunkPayload.captureId}`);
      queue.complete(sessionId, command.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: image.toString('hex') });
    }, 2);
    const readPartialImage = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: {
      sessionId, captureId: partialResult.frames[0]!.captureId,
    } });
    assert.ok(!readPartialImage.isError, JSON.stringify(readPartialImage));
    const partialReviewCapture = (readPartialImage.structuredContent as { reviewCapture: Record<string, unknown> }).reviewCapture;
    const partialAttach = await client.callTool({ name: 'motion_review_attach_captures', arguments: {
      reviewId: retryReviewId, revision: 1, sessionId, captures: [partialReviewCapture],
    } });
    assert.ok(!partialAttach.isError, JSON.stringify(partialAttach));
    const partialAttachResult = (partialAttach.structuredContent as { result: { reviewRevision: number; next: string; visualCaptureCoverage: {
      status: string; missingFrames: { time: number; view: string; focusJoint?: string }[] }; visualCaptureRetry: {
        status: string; arguments?: { sessionId: string; rigId: string; assetId: string; expectedFingerprint: string; expectedJointMapFingerprint: string;
          expectedRigSignature: string; jointMap: Record<string, string>; frames: { time: number; view: string; focusJoint?: string }[] } } } }).result;
    assert.equal(partialAttachResult.visualCaptureCoverage.status, 'partial');
    assert.deepEqual(partialAttachResult.visualCaptureCoverage.missingFrames, [{ time: 0.5, view: 'side', focusJoint: 'RightHand' }]);
    assert.match(partialAttachResult.next, /motion_library_read.*assetHash=.*motion_studio_capture_preflight.*visualCaptureRetry.*motion_studio_capture_views.*motion_review_attach_captures/i);
    assert.match(partialAttachResult.next, /visualCaptureRetry.*reviewed rig signature and assetHash/i);
    assert.equal(partialAttachResult.visualCaptureRetry.status, 'ready');
    assert.deepEqual(partialAttachResult.visualCaptureRetry.arguments, { sessionId, rigId, assetId: asset.id,
      expectedFingerprint: fingerprint(asset.recipe), expectedJointMapFingerprint: createHash('sha256').update(JSON.stringify([['UpperTorso', 'Torso']])).digest('hex'),
      expectedRigSignature: rigSignature, jointMap: { UpperTorso: 'Torso' },
      frames: [{ time: 0.5, view: 'side', focusJoint: 'RightHand' }] });
    const recoveryRead = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: retryReviewId } });
    assert.ok(!recoveryRead.isError, JSON.stringify(recoveryRead));
    const recoveryReadResult = (recoveryRead.structuredContent as { result: { next: string; visualCaptureRetry: typeof partialAttachResult.visualCaptureRetry } }).result;
    const recoveryNext = recoveryReadResult.next;
    assert.deepEqual(recoveryReadResult.visualCaptureRetry, partialAttachResult.visualCaptureRetry);
    assert.match(recoveryNext, /motion_library_read.*motion_studio_capture_preflight.*motion_studio_capture_views/i);
    assert.match(recoveryNext, /current revision=\d+.*motion_review_critique only after visualCaptureCoverage\.status is complete/i);

    const exactMissingFrame = partialResult.captureCoverage.missingFrames[0]!;
    const staleRigRetry = await client.callTool({ name: 'motion_studio_capture_views', arguments: {
      ...partialAttachResult.visualCaptureRetry.arguments!, expectedRigSignature: 'changed-topology',
    } });
    assert.equal(staleRigRetry.isError, true);
    assert.match(JSON.stringify(staleRigRetry), /differs from expectedRigSignature/i);
    const retryQueued = await client.callTool({ name: 'motion_studio_capture_views', arguments: partialAttachResult.visualCaptureRetry.arguments });
    assert.ok(!retryQueued.isError, JSON.stringify(retryQueued));
    const retryJobId = (retryQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const retryCommand = queue.poll(sessionId);
    assert.ok(retryCommand);
    const retryPayload = retryCommand.payload as { assetId: string; assetFingerprint: string; rigSignature: string; recipe: AnimationRecipe; jointMap: Record<string, string> };
    const retryCaptureId = randomUUID();
    pngByCaptureId.set(retryCaptureId, alternatePng);
    queue.complete(sessionId, retryCommand.id, true, { assetId: retryPayload.assetId, rigId, sessionId, complete: true, note: 'targeted retry fixture', frames: [
      { captureId: retryCaptureId, sessionId, assetId: retryPayload.assetId, assetFingerprint: retryPayload.assetFingerprint, rigId, rigSignature: retryPayload.rigSignature,
        ...exactMissingFrame, appliedJointMap: resolvedCaptureJointMap(retryPayload.recipe, retryPayload.jointMap),
        byteCount: alternatePng.length, chunks: 1, width: 1, height: 1, note: 'single-frame retry fixture' },
    ] });
    const retryJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: retryJobId } });
    assert.ok(!retryJob.isError, JSON.stringify(retryJob));
    const retryImage = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId: retryCaptureId } });
    assert.ok(!retryImage.isError, JSON.stringify(retryImage));
    const retryReviewCapture = (retryImage.structuredContent as { reviewCapture: Record<string, unknown> }).reviewCapture;
    const retryAttach = await client.callTool({ name: 'motion_review_attach_captures', arguments: {
      reviewId: retryReviewId, revision: partialAttachResult.reviewRevision, sessionId, captures: [retryReviewCapture],
    } });
    assert.ok(!retryAttach.isError, JSON.stringify(retryAttach));
    const recoveredCoverage = (retryAttach.structuredContent as { result: { visualCaptureCoverage: {
      status: string; plannedFrameCount: number; coveredFrameCount: number; missingFrames: unknown[] } } }).result.visualCaptureCoverage;
    assert.equal(recoveredCoverage.status, 'complete', 'original and retry batches for the exact saved animation/rig must jointly clear review coverage');
    assert.equal(recoveredCoverage.plannedFrameCount, requestedFrames.length);
    assert.equal(recoveredCoverage.coveredFrameCount, requestedFrames.length);
    assert.deepEqual(recoveredCoverage.missingFrames, []);
    clearInterval(chunkPoller);
    chunkPoller = undefined;

    const malformed = await captureJob(true, true);
    assert.equal(malformed.isError, true);
    assert.match(JSON.stringify(malformed), /Mismatched field\(s\): time/i);
  } finally {
    if (chunkPoller) clearInterval(chunkPoller);
    await client.close();
    await server.close();
  }
});

test('AI can retrieve verified rendered images for an unsaved animation candidate without saving it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-candidate-capture-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'candidate-capture-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  seedCaptureFocusInspection(queue, sessionId, rigId, rigSignature, ['UpperTorso', 'Torso']);
  const recipe: AnimationRecipe = animationSchema.parse({ ...animationPreset('idle', 'Unsaved visual candidate', 1, 1),
    markers: [{ name: 'Windup', time: 0.25, phase: 'anticipation' }, { name: 'Release', time: 0.75, phase: 'main_action' }],
    contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.4, end: 0.6 }] });
  const intentReferenceAsset = await library.saveIdempotent(recipe, randomUUID(), undefined, undefined, undefined, undefined, {
    schemaVersion: 1, sourceRecipeFingerprint: fingerprint(recipe), phases: [
      { id: 'windup', label: 'anticipation', start: 0, end: 0.5, intent: 'Build tension before the release.' },
      { id: 'release', label: 'main_action', start: 0.5, end: 1, intent: 'Release with a clear silhouette.' },
    ],
    events: [{ name: 'Release', phaseId: 'release', progress: 0.5, time: 0.75 }],
    contacts: [
      { effector: 'LeftFoot', kind: 'support', phaseId: 'windup', startProgress: 0.8, endProgress: 1, start: 0.4, end: 0.5 },
      { effector: 'LeftFoot', kind: 'support', phaseId: 'release', startProgress: 0, endProgress: 0.2, start: 0.5, end: 0.6 },
    ],
  });
  const editedIntentReferenceAsset = await library.save({ ...recipe, name: 'Later revised animation' }, intentReferenceAsset.id);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'candidate-capture-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const captureImages = new Map<string, Buffer>();
  let captureId = '';
  let chunkPoller: NodeJS.Timeout | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invalidFocusedPlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, focusJoints: ['HumanoidRootPart'], expectedRigSignature: rigSignature,
    } });
    assert.equal(invalidFocusedPlan.isError, true);
    assert.match(JSON.stringify(invalidFocusedPlan), /not exact driven part-backed nodes/i);
    const staleTopologyPlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, expectedRigSignature: 'stale-topology',
    } });
    assert.equal(staleTopologyPlan.isError, true);
    assert.match(JSON.stringify(staleTopologyPlan), /differs from expectedRigSignature/i);
    const autoFocusPlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, jointMap: { UpperTorso: 'Torso' }, expectedRigSignature: rigSignature,
    } });
    assert.ok(!autoFocusPlan.isError, JSON.stringify(autoFocusPlan));
    const autoFocusResult = (autoFocusPlan.structuredContent as { result: { next: string; frames: { time: number; view: string; focusJoint?: string }[];
      focusJointSuggestions: { joint: string; scheduledByDefault: boolean; evidenceTime?: number }[] } }).result;
    assert.match(autoFocusResult.next, /omittedMomentSummary\.samples.*exact followUpBatches.*separate motion_studio_capture_candidate_views calls.*do not reconstruct.*identical recipe.*expectedFingerprint.*expectedJointMapFingerprint.*expectedRigSignature/i,
      'the AI handoff should execute exact omitted-beat batches with the original recipe and identity guards');
    assert.ok(autoFocusResult.frames.some(frame => frame.focusJoint === 'Torso'), 'rig-bound plans automatically add an evidence-based target close-up');
    assert.ok(autoFocusResult.frames.length <= 4, 'automatic close-ups remain inside the requested frame cap');
    assert.ok(autoFocusResult.focusJointSuggestions.some(item => item.joint === 'Torso' && item.scheduledByDefault));
    const prioritizedIntentTimes = [0.2, 0.4, 0.6, 0.8].map(progress => recipe.duration * progress);
    const intentTimePlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, priorityTimes: prioritizedIntentTimes,
      jointMap: { UpperTorso: 'Torso' }, expectedRigSignature: rigSignature,
    } });
    assert.ok(!intentTimePlan.isError, JSON.stringify(intentTimePlan));
    const intentTimeResult = (intentTimePlan.structuredContent as { result: { priorityTimeCoverage: { requested: number[]; scheduled: number[]; omitted: number[];
      followUpBatches: { time: number; view: string }[][] }; jointMapFingerprint: string; expectedRigSignature: string;
      frames: { time: number; focusJoint?: string }[] } }).result;
    assert.deepEqual(intentTimeResult.priorityTimeCoverage.requested, prioritizedIntentTimes);
    assert.ok(intentTimeResult.priorityTimeCoverage.omitted.length > 0, 'a tight capture budget should expose unshown intent beats');
    assert.deepEqual(intentTimeResult.priorityTimeCoverage.followUpBatches.flat(), intentTimeResult.priorityTimeCoverage.omitted.map(time => ({ time, view: 'front' })));
    assert.ok(intentTimeResult.priorityTimeCoverage.followUpBatches.every(batch => batch.length > 0 && batch.length <= 8));
    assert.ok(intentTimeResult.frames.some(frame => frame.time === intentTimeResult.priorityTimeCoverage.scheduled[0]),
      'MCP planning must retain the highest-priority exact requested intent timestamp');
    assert.ok(intentTimeResult.frames.length <= 4, 'priority intent capture stays inside the MCP frame budget');
    for (const followUpFrames of intentTimeResult.priorityTimeCoverage.followUpBatches) {
      const followUpQueued = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
        sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), expectedJointMapFingerprint: intentTimeResult.jointMapFingerprint,
        expectedRigSignature: intentTimeResult.expectedRigSignature, jointMap: { UpperTorso: 'Torso' }, frames: followUpFrames,
      } });
      assert.ok(!followUpQueued.isError, JSON.stringify(followUpQueued));
      const followUpJobId = (followUpQueued.structuredContent as { result: { jobId: string } }).result.jobId;
      const followUpCommand = queue.poll(sessionId);
      assert.ok(followUpCommand);
      assert.equal(followUpCommand.operation, 'capture_frames');
      const followUpPayload = followUpCommand.payload as { assetId: string; rigSignature: string; recipe: AnimationRecipe;
        jointMap: Record<string, string>; frames: { time: number; view: string }[] };
      assert.deepEqual(followUpPayload.frames, followUpFrames, 'the exact planned batch reaches Studio unchanged');
      assert.deepEqual(followUpPayload.jointMap, { UpperTorso: 'Torso' });
      assert.deepEqual(followUpPayload.recipe, recipe);
      const followUpReceipts = followUpFrames.map(frame => {
        const id = randomUUID();
        captureImages.set(id, png);
        return { captureId: id, sessionId, assetId: followUpPayload.assetId, assetFingerprint: fingerprint(recipe), rigId,
          rigSignature: followUpPayload.rigSignature, ...frame, appliedJointMap: resolvedCaptureJointMap(recipe, followUpPayload.jointMap),
          byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'follow-up fixture' };
      });
      queue.complete(sessionId, followUpCommand.id, true, { assetId: followUpPayload.assetId, rigId, sessionId, complete: true,
        note: 'exact planned follow-up batch fixture', frames: followUpReceipts });
      const followUpJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: followUpJobId } });
      assert.ok(!followUpJob.isError, JSON.stringify(followUpJob));
      const followUpResult = (followUpJob.structuredContent as { result: { result: { captureCoverage: { status: string;
        requestedFrames: { time: number; view: string }[] } } } }).result.result;
      assert.equal(followUpResult.captureCoverage.status, 'complete');
      assert.deepEqual(followUpResult.captureCoverage.requestedFrames, followUpFrames);
    }
    const validFocusedPlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, focusJoints: ['UpperTorso'], expectedRigSignature: rigSignature,
    } });
    assert.ok(!validFocusedPlan.isError, JSON.stringify(validFocusedPlan));
    const boundPlan = (validFocusedPlan.structuredContent as { result: { expectedRigSignature: string; jointMapFingerprint: string; focusJointCoverage: { scheduled: string[] } } }).result;
    assert.deepEqual(boundPlan.focusJointCoverage.scheduled, ['UpperTorso']);
    assert.equal(boundPlan.expectedRigSignature, rigSignature, 'a rig-bound plan must return the exact inspected topology signature');
    assert.match(boundPlan.jointMapFingerprint, /^[a-f0-9]{64}$/);
    const mappedFocusPlan = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: {
      sessionId, rigId, recipe, views: ['front'], maxFrames: 4, focusJoints: ['Torso'], jointMap: { UpperTorso: 'Torso' },
      expectedRigSignature: rigSignature,
    } });
    assert.ok(!mappedFocusPlan.isError, JSON.stringify(mappedFocusPlan));
    const mappedPlanResult = (mappedFocusPlan.structuredContent as { result: { focusJointCoverage: { scheduled: string[] }; jointMap: Record<string, string>;
      focusJointSuggestions: { joint: string; authoredJoints: string[]; reasons: string[] }[] } }).result;
    assert.deepEqual(mappedPlanResult.focusJointCoverage.scheduled, ['Torso'], 'authored source channels can schedule a close-up by their inspected rig target');
    assert.deepEqual(mappedPlanResult.jointMap, { UpperTorso: 'Torso' }, 'the mapping used for planning is returned unchanged for capture');
    assert.ok(mappedPlanResult.focusJointSuggestions.some(item => item.joint === 'Torso' && item.authoredJoints.includes('UpperTorso')),
      'rig-bound plans suggest only an inspected eligible target that is active in the mapped recipe');
    assert.ok(mappedPlanResult.focusJointSuggestions.every(item => ['UpperTorso', 'Torso'].includes(item.joint)));
    const mappedPlanFingerprint = (mappedFocusPlan.structuredContent as { result: { jointMapFingerprint: string } }).result.jointMapFingerprint;
    assert.match(mappedPlanFingerprint, /^[a-f0-9]{64}$/);
    const invalidMappedCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), jointMap: { UpperTorso: 'UninspectedRigJoint' },
      frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }],
    } });
    assert.equal(invalidMappedCapture.isError, true);
    assert.match(JSON.stringify(invalidMappedCapture), /jointMap target.*not exact driven joints/i);
    assert.equal(queue.poll(sessionId), null, 'an invalid source-to-rig map must fail before Studio work is queued');
    const conflictingCapturePlan = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), priorityTimes: [0.5],
      frames: [{ time: 0, view: 'front' }, { time: 1, view: 'front' }],
    } });
    assert.equal(conflictingCapturePlan.isError, true);
    assert.match(JSON.stringify(conflictingCapturePlan), /priorityTimes apply only when frames are omitted/i);
    assert.equal(queue.poll(sessionId), null, 'ambiguous explicit-frame and planner-priority inputs must fail before queueing');
    const stalePlanFingerprint = '0'.repeat(64);
    const stalePlanCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: stalePlanFingerprint, jointMap: { UpperTorso: 'Torso' },
      frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }, { time: 0.5, view: 'front', focusJoint: 'UpperTorso' }],
    } });
    assert.equal(stalePlanCapture.isError, true);
    assert.match(JSON.stringify(stalePlanCapture), /differs from the planned expectedFingerprint/i);
    const staleJointMapCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), expectedJointMapFingerprint: mappedPlanFingerprint,
      jointMap: { UpperTorso: 'UpperTorso' }, frames: [{ time: 0, view: 'front' }],
    } });
    assert.match(JSON.stringify(staleJointMapCapture), /differs from the planned expectedJointMapFingerprint/i);
    assert.equal(queue.poll(sessionId), null, 'stale planned-capture fingerprints must fail before queueing a Studio job');
    const rejectedRootFocus = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), jointMap: {},
      frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'side', focusJoint: 'HumanoidRootPart' }],
    } });
    assert.equal(rejectedRootFocus.isError, true);
    assert.match(JSON.stringify(rejectedRootFocus), /not exact driven part-backed nodes/i);
    assert.equal(queue.poll(sessionId), null, 'ineligible close-up targets must fail before queueing Studio work');
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'changed-topology-after-planning' } });
    const staleTopologyCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), expectedRigSignature: boundPlan.expectedRigSignature, jointMap: {},
      frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'side' }],
    } });
    assert.equal(staleTopologyCapture.isError, true);
    assert.match(JSON.stringify(staleTopologyCapture), /differs from expectedRigSignature/i);
    assert.equal(queue.poll(sessionId), null, 'a rig changed since planning must be rejected before queueing Studio work');
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const queued = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: fingerprint(recipe), expectedJointMapFingerprint: mappedPlanFingerprint,
      expectedRigSignature: boundPlan.expectedRigSignature, jointMap: { UpperTorso: 'Torso' },
      frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }, { time: 0.5, view: 'front', focusJoint: 'UpperTorso' }],
    } });
    assert.ok(!queued.isError, JSON.stringify(queued));
    const queuedResult = (queued.structuredContent as { result: { jobId: string; status: string } }).result;
    assert.equal(queuedResult.status, 'queued');
    const command = queue.poll(sessionId);
    assert.ok(command);
    assert.equal(command.operation, 'capture_frames');
    const payload = command.payload as { assetId: string; assetFingerprint: string; rigSignature: string; ephemeralCandidate: boolean; recipe: AnimationRecipe; jointMap: Record<string, string> };
    assert.equal(payload.ephemeralCandidate, true);
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.recipe, recipe);
    assert.deepEqual(new Set((await library.list()).assets.map(asset => asset.id)),
      new Set([intentReferenceAsset.id, editedIntentReferenceAsset.id]),
      'queuing the unsaved capture must not persist the candidate beyond the explicitly saved reference assets');
    const captureFingerprint = fingerprint(recipe);
    captureId = randomUUID();
    const secondCaptureId = randomUUID(), focusedCaptureId = randomUUID();
    captureImages.set(captureId, png);
    captureImages.set(secondCaptureId, pngWithText(png, 'second-frame'));
    captureImages.set(focusedCaptureId, pngWithText(png, 'focused-frame'));
    queue.complete(sessionId, command.id, true, { assetId: payload.assetId, rigId, sessionId, complete: true, note: 'fixture only', frames: [
      { captureId, sessionId, assetId: payload.assetId, assetFingerprint: captureFingerprint, rigId, rigSignature, time: 0, view: 'front', appliedJointMap: resolvedCaptureJointMap(recipe, payload.jointMap), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
      { captureId: secondCaptureId, sessionId, assetId: payload.assetId, assetFingerprint: captureFingerprint, rigId, rigSignature, time: 0.5, view: 'front', appliedJointMap: resolvedCaptureJointMap(recipe, payload.jointMap), byteCount: captureImages.get(secondCaptureId)!.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
      { captureId: focusedCaptureId, sessionId, assetId: payload.assetId, assetFingerprint: captureFingerprint, rigId, rigSignature, time: 0.5, view: 'front', focusJoint: 'UpperTorso', appliedJointMap: resolvedCaptureJointMap(recipe, payload.jointMap), byteCount: captureImages.get(focusedCaptureId)!.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
    ] });
    const outcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: queuedResult.jobId } });
    assert.ok(!outcome.isError, JSON.stringify(outcome));
    const frames = (outcome.structuredContent as { result: { result: { candidate: boolean; frames: { captureId: string; time: number; view: string }[];
      captureCoverage: { status: string; requestedFrameCount: number; capturedFrameCount: number; missingFrameCount: number;
        requestedFrames: { time: number; view: string }[]; capturedFrames: { captureId: string; time: number; view: string }[]; missingFrames: unknown[] } } } }).result.result;
    assert.equal(frames.candidate, true);
    assert.equal(frames.frames.length, 3);
    assert.equal(frames.captureCoverage.status, 'complete');
    assert.equal(frames.captureCoverage.requestedFrameCount, 3);
    assert.equal(frames.captureCoverage.capturedFrameCount, 3);
    assert.equal(frames.captureCoverage.missingFrameCount, 0);
    assert.deepEqual(frames.captureCoverage.requestedFrames, [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' },
      { time: 0.5, view: 'front', focusJoint: 'UpperTorso' }]);
    assert.deepEqual(frames.captureCoverage.capturedFrames.map(({ captureId, time, view }) => ({ captureId, time, view })),
      frames.frames.map(({ captureId, time, view }) => ({ captureId, time, view })));
    assert.deepEqual(frames.captureCoverage.missingFrames, []);
    assert.ok((frames.frames[0] as { jointMapping?: { appliedFingerprint?: string } }).jointMapping?.appliedFingerprint,
      'verified screenshot provenance should expose the resolved authored-channel map fingerprint');
    assert.match((outcome.structuredContent as { result: { result: { next: string } } }).result.result.next,
      /coverage is complete.*images are not yet AI-visible.*captureIds.*motion_studio_read_candidate_captures/i);

    const mismatchedReceipt = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: captureFingerprint, jointMap: { UpperTorso: 'Torso' }, frames: [{ time: 0, view: 'front' }],
    } });
    assert.ok(!mismatchedReceipt.isError, JSON.stringify(mismatchedReceipt));
    const mismatchJobId = (mismatchedReceipt.structuredContent as { result: { jobId: string } }).result.jobId;
    const mismatchCommand = queue.poll(sessionId);
    assert.ok(mismatchCommand);
    const mismatchPayload = mismatchCommand.payload as { assetId: string; assetFingerprint: string; rigSignature: string; recipe: AnimationRecipe };
    const mismatchCaptureId = randomUUID();
    queue.complete(sessionId, mismatchCommand.id, true, { assetId: mismatchPayload.assetId, rigId, sessionId, complete: true, note: 'incorrect applied-map receipt fixture', frames: [
      { captureId: mismatchCaptureId, sessionId, assetId: mismatchPayload.assetId, assetFingerprint: mismatchPayload.assetFingerprint,
        rigId, rigSignature: mismatchPayload.rigSignature, time: 0, view: 'front', appliedJointMap: resolvedCaptureJointMap(mismatchPayload.recipe, {}),
        byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture' },
    ] });
    const mismatchResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: mismatchJobId } });
    assert.equal(mismatchResult.isError, true);
    assert.match(JSON.stringify(mismatchResult), /different resolved joint map/i);
    const discardedMismatch = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId: mismatchCaptureId } });
    assert.equal(discardedMismatch.isError, true, 'a screenshot with a mismatched applied-map receipt must never enter the image cache');

    const retryFrame = { time: 0.75, view: 'side' as const, focusJoint: 'UpperTorso' };
    const retryQueued = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: captureFingerprint, jointMap: { UpperTorso: 'Torso' }, frames: [retryFrame],
    } });
    assert.ok(!retryQueued.isError, JSON.stringify(retryQueued));
    const retryJobId = (retryQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const retryCommand = queue.poll(sessionId);
    assert.ok(retryCommand);
    const retryPayload = retryCommand.payload as { assetId: string; assetFingerprint: string; rigSignature: string; recipe: AnimationRecipe; jointMap: Record<string, string> };
    assert.equal(retryPayload.assetFingerprint, captureFingerprint);
    assert.deepEqual(retryPayload.recipe, recipe, 'a one-frame retry remains bound to the exact same animation recipe');
    const retryCaptureId = randomUUID();
    const retryPng = pngWithText(png, 'supplemental-focused-frame');
    queue.complete(sessionId, retryCommand.id, true, { assetId: retryPayload.assetId, rigId, sessionId, complete: true, note: 'single-frame retry fixture', frames: [
      { captureId: retryCaptureId, sessionId, assetId: retryPayload.assetId, assetFingerprint: retryPayload.assetFingerprint, rigId, rigSignature,
        ...retryFrame, appliedJointMap: resolvedCaptureJointMap(retryPayload.recipe, retryPayload.jointMap), byteCount: retryPng.length, chunks: 1, width: 1, height: 1, note: 'fixture retry' },
    ] });
    const retryOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: retryJobId } });
    assert.ok(!retryOutcome.isError, JSON.stringify(retryOutcome));
    const retryResult = (retryOutcome.structuredContent as { result: { result: { complete: boolean; captureCoverage: {
      status: string; requestedFrames: { time: number; view: string; focusJoint?: string }[]; missingFrames: unknown[] } } } }).result.result;
    assert.equal(retryResult.complete, true);
    assert.equal(retryResult.captureCoverage.status, 'complete');
    assert.deepEqual(retryResult.captureCoverage.requestedFrames, [retryFrame]);
    assert.deepEqual(retryResult.captureCoverage.missingFrames, []);

    chunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const chunkCommand = queue.poll(sessionId);
      if (!chunkCommand || chunkCommand.operation !== 'capture_chunk') return;
      const chunkPayload = chunkCommand.payload as { captureId: string; index: number };
      const bytes = captureImages.get(chunkPayload.captureId) ?? png;
      queue.complete(sessionId, chunkCommand.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: bytes.toString('hex') });
    }, 2);
    const image = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId } });
    assert.ok(!image.isError, JSON.stringify(image));
    const imageContent = image.content as { type: string; data?: string; mimeType?: string }[];
    const imageBlock = imageContent.find(block => block.type === 'image');
    assert.equal(imageBlock?.type, 'image');
    if (imageBlock?.type === 'image') {
      assert.equal(imageBlock.mimeType, 'image/png');
      assert.equal(imageBlock.data, png.toString('base64'));
    }
    const imageReview = image.structuredContent as { result: { semanticRoleIndex?: { rig: { signature: string }; roles: { role: string; status: string; joint?: string }[]; limitations: string[] };
      jointMapping: { fingerprint: string; jointMap: Record<string, string>; renamedJointCount: number; nameMapApplied: boolean;
      renamedJoints: { source: string; target: string }[]; limitation: string } };
      visualReviewTemplate: { captureId: string; assetFingerprint: string; source: string;
      authoringIntentTimingRelation: 'exact_current_recipe' | 'historical_reference' | 'unavailable';
      time: number; view: string; protocol: string; semanticRoleIndex?: { rig: { signature: string }; roles: { role: string; status: string; joint?: string }[] };
      authoredContext: { normalizedProgress: number;
        nearbyMarkers: { name: string; offsetSeconds: number; phase?: string }[]; activeDeclaredContacts: { effector: string; kind: string }[];
        interpretation: string }; captureCoverage: { status: string; expectedFrameCount: number; receivedFrameCount: number;
        missingFrameCount: number; expectedFrames: { time: number; view: string }[]; missingFrames: { time: number; view: string }[] };
      observationShape: { status: string; captureId: string }; nextStep: string } };
    assert.equal(imageReview.result.jointMapping.renamedJointCount, 1);
    assert.equal(imageReview.result.jointMapping.nameMapApplied, true);
    assert.deepEqual(imageReview.result.jointMapping.jointMap, { UpperTorso: 'Torso' });
    assert.deepEqual(imageReview.result.jointMapping.renamedJoints, [{ source: 'UpperTorso', target: 'Torso' }]);
    assert.match(imageReview.result.jointMapping.limitation, /does not retarget local axes/i);
    assert.equal(imageReview.result.semanticRoleIndex?.rig.signature, rigSignature);
    assert.deepEqual(imageReview.result.semanticRoleIndex?.roles.find(role => role.role === 'torso'),
      { role: 'torso', status: 'inferred', joint: 'UpperTorso', candidates: ['UpperTorso'], evidence: ['Unique joint-name token match only; no positional, axis, or anatomical-limit evidence is available.'] });
    const forgedMappingAttach = await client.callTool({ name: 'motion_review_attach_capture', arguments: { reviewId: randomUUID(), revision: 1, sessionId,
      capture: { captureId, assetId: payload.assetId, assetFingerprint: captureFingerprint, rigId, rigSignature, time: 0, view: 'front',
        byteCount: png.length, chunks: 1, width: 1, height: 1,
        jointMapping: { ...imageReview.result.jointMapping, fingerprint: 'd'.repeat(64) } } } });
    assert.equal(forgedMappingAttach.isError, true);
    assert.match(JSON.stringify(forgedMappingAttach), /differs from the server-verified capture|Exact joint map must match the recorded fingerprint/i,
      'review attachment must not trust a caller-forged joint map fingerprint');
    assert.equal(imageReview.visualReviewTemplate.captureId, captureId);
    assert.equal(imageReview.visualReviewTemplate.assetFingerprint, captureFingerprint);
    assert.equal(imageReview.visualReviewTemplate.source, 'candidate_capture');
    assert.equal(imageReview.visualReviewTemplate.authoringIntentTimingRelation, 'unavailable');
    assert.equal(imageReview.visualReviewTemplate.time, 0);
    assert.equal(imageReview.visualReviewTemplate.view, 'front');
    assert.equal(imageReview.visualReviewTemplate.semanticRoleIndex?.rig.signature, rigSignature);
    assert.match(imageReview.visualReviewTemplate.protocol, /not proof of visible anatomy, pose, or motion/i);
    assert.equal(imageReview.visualReviewTemplate.authoredContext.normalizedProgress, 0);
    assert.deepEqual(imageReview.visualReviewTemplate.authoredContext.nearbyMarkers.map(marker => [marker.name, marker.offsetSeconds]), [['Windup', 0.25]]);
    assert.deepEqual(imageReview.visualReviewTemplate.authoredContext.activeDeclaredContacts, []);
    assert.match(imageReview.visualReviewTemplate.authoredContext.interpretation, /not proof of visible pose.*actual contact/i);
    assert.match(imageReview.visualReviewTemplate.protocol, /describe a visible cue.*unclear/i);
    assert.equal(imageReview.visualReviewTemplate.observationShape.status, 'supported | contradicted | unclear');
    assert.equal(imageReview.visualReviewTemplate.observationShape.captureId, captureId);
    assert.deepEqual(imageReview.visualReviewTemplate.captureCoverage, { status: 'selected_subset', view: 'front',
      expectedFrameCount: 2, receivedFrameCount: 1, missingFrameCount: 1,
      expectedFrames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }], missingFrames: [{ time: 0.5, view: 'front' }] });
    assert.equal(imageContent[0]?.type, 'text', 'single-image review metadata must precede its PNG for unambiguous visual grounding');
    assert.equal(imageContent[1]?.type, 'image');
    assert.match(imageReview.visualReviewTemplate.nextStep, /candidate evidence.*read_editor_draft.*undoable and unsaved/i);
    const batchCaptureIds = frames.frames.map(frame => frame.captureId);
    const batch = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: { sessionId, captureIds: batchCaptureIds,
      intentAssetId: editedIntentReferenceAsset.id } });
    assert.ok(!batch.isError, JSON.stringify(batch));
    const batchBlocks = batch.content as { type: string; data?: string; mimeType?: string }[];
    assert.equal(batchBlocks.filter(block => block.type === 'image').length, 3);
    assert.deepEqual(batchBlocks.filter(block => block.type === 'image').map(block => block.data),
      batchCaptureIds.map(id => captureImages.get(id)!.toString('base64')));
    const batchResult = (batch.structuredContent as { result: { status: string; imageCount: number; captureCoverage: { status: string; completeGroupCount: number; groupCount: number; limitation: string };
      images: { metadata: { captureId: string; assetFingerprint: string; rigSignature: string; time: number; view: string; focusJoint?: string;
        jointMapping: { renamedJointCount: number; nameMapApplied: boolean } };
        visualReviewTemplate: { captureId: string; source: string; observationShape: { captureId: string };
          authoringIntentTimingRelation: 'exact_current_recipe' | 'historical_reference' | 'unavailable';
          referenceAuthoringIntent: { assetId: string; referenceRecipeFingerprint: string; sourceRecipeFingerprint: string;
            authoringIntentFingerprint?: string;
            authoringIntentTimingRelation: 'exact_current_recipe' | 'historical_reference';
            captureMatchesReferenceRecipe: boolean; captureMatchesIntentSourceRecipe: boolean; referenceRecipeMatchesIntentSourceRecipe: boolean;
            intentRelationToCapture: 'exact_capture_source' | 'reference_recipe_only' | 'historical_only'; phases: { id: string; intent?: string }[];
            events: { name: string; phaseId: string; progress: number; time: number; value?: string }[];
            contacts: { effector: string; kind: string; phaseId: string; startProgress: number; endProgress: number; start: number; end: number }[];
            limitation: string };
          authoredContext: { activeDeclaredContacts: { effector: string; kind: string; start: number; end: number }[] }; protocol: string } }[];
      sequenceGroups: { captureBatchId: string; source: string; view: string; focusJoint?: string; frameCount: number; frameOrder: string;
        coverage: { status: string; expectedFrameCount: number; receivedFrameCount: number; missingFrameCount: number;
          expectedFrames: { time: number; view: string }[]; missingFrames: { time: number; view: string }[] };
        temporalSampling: { distinctSampleTimeCount: number; firstSampleTime: number; lastSampleTime: number;
          largestGapSeconds: number; largestGapInterval: { seconds: number; fromCaptureId: string; toCaptureId: string;
            startTime: number; endTime: number; suggestedTime: number | null; normalizedProgress: [number, number] } | null;
          sampledProgressRange: [number, number]; interpretation: string };
        frames: { captureId: string; time: number; secondsFromPrevious: number | null }[];
        interpretation: string }[] } }).result;
    assert.equal(batchResult.status, 'complete');
    assert.equal(batchResult.imageCount, 3);
    assert.deepEqual(batchResult.captureCoverage, { status: 'complete', completeGroupCount: 2, groupCount: 2,
      limitation: 'This reports requested-frame coverage only. It does not mean the AI has inspected or accepted the animation.' });
    assert.deepEqual(batchResult.images.map(({ metadata }) => ({ captureId: metadata.captureId, time: metadata.time, view: metadata.view,
      ...(metadata.focusJoint ? { focusJoint: metadata.focusJoint } : {}) })),
      frames.frames.map(({ captureId: id, time, view, ...metadata }) => ({ captureId: id, time, view, ...('focusJoint' in metadata && metadata.focusJoint
        ? { focusJoint: metadata.focusJoint } : {}) })));
    assert.deepEqual(batchResult.images[1]!.visualReviewTemplate.authoredContext.activeDeclaredContacts,
      [{ effector: 'LeftFoot', kind: 'support', start: 0.4, end: 0.6 }]);
    assert.deepEqual(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.phases.map(phase => phase.intent),
      ['Build tension before the release.', 'Release with a clear silhouette.']);
    assert.deepEqual(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.events,
      [{ name: 'Release', phaseId: 'release', progress: 0.5, time: 0.75 }]);
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.authoringIntentFingerprint, undefined,
      'legacy phase-only reference metadata remains readable without a self-fingerprint');
    assert.deepEqual(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.contacts, [
      { effector: 'LeftFoot', kind: 'support', phaseId: 'windup', startProgress: 0.8, endProgress: 1, start: 0.4, end: 0.5 },
      { effector: 'LeftFoot', kind: 'support', phaseId: 'release', startProgress: 0, endProgress: 0.2, start: 0.5, end: 0.6 },
    ]);
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.captureMatchesReferenceRecipe, false,
      'the capture should be distinguished from the caller-selected child asset recipe');
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.captureMatchesIntentSourceRecipe, true);
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.authoringIntentTimingRelation, 'exact_current_recipe');
    assert.equal(batchResult.images[0]!.visualReviewTemplate.authoringIntentTimingRelation, 'exact_current_recipe');
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.referenceRecipeMatchesIntentSourceRecipe, false);
    assert.equal(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.intentRelationToCapture, 'exact_capture_source',
      'intent timing remains usable for the exact source capture even when the selected reference asset is a renamed child');
    assert.match(batchResult.images[0]!.visualReviewTemplate.protocol,
      /only authoringIntentTimingRelation exact_current_recipe permits matching.*historical_reference.*use this capture'?s? time and authoredContext/i);
    assert.match(batchResult.images[0]!.visualReviewTemplate.referenceAuthoringIntent.limitation, /not image evidence/i);
    assert.equal(batchResult.sequenceGroups.length, 2, 'whole-body and focused images must have separate coverage groups');
    const wholeBodyGroup = batchResult.sequenceGroups.find(group => group.focusJoint === undefined)!;
    const focusedGroup = batchResult.sequenceGroups.find(group => group.focusJoint === 'UpperTorso')!;
    assert.equal(wholeBodyGroup.captureBatchId, queuedResult.jobId);
    assert.equal(wholeBodyGroup.source, 'candidate');
    assert.deepEqual(wholeBodyGroup.coverage, { status: 'complete', expectedFrameCount: 2, receivedFrameCount: 2,
      missingFrameCount: 0, expectedFrames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }], missingFrames: [] });
    assert.deepEqual(focusedGroup.coverage, { status: 'complete', expectedFrameCount: 1, receivedFrameCount: 1,
      missingFrameCount: 0, expectedFrames: [{ time: 0.5, view: 'front', focusJoint: 'UpperTorso' }], missingFrames: [] });
    assert.equal(wholeBodyGroup.frameOrder, 'ascending_animation_time');
    assert.deepEqual(wholeBodyGroup.frames.map(frame => [frame.time, frame.secondsFromPrevious]), [[0, null], [0.5, 0.5]]);
    assert.deepEqual(wholeBodyGroup.temporalSampling, { distinctSampleTimeCount: 2, firstSampleTime: 0, lastSampleTime: 0.5,
      largestGapSeconds: 0.5, largestGapInterval: { seconds: 0.5, fromCaptureId: frames.frames[0]!.captureId,
        toCaptureId: frames.frames[1]!.captureId, startTime: 0, endTime: 0.5, suggestedTime: 0.25, normalizedProgress: [0, 0.5] },
      sampledProgressRange: [0, 0.5], interpretation: 'largestGapInterval identifies the exact adjacent captured frames with the widest unobserved interval. Its suggestedTime is the arithmetic midpoint for an optional targeted recapture in this same view/focus; null means floating-point precision leaves no representable interior time. This summarizes only captured still timestamps; a small gap still does not establish continuous motion.' });
    assert.deepEqual(focusedGroup.temporalSampling.sampledProgressRange, [0.5, 0.5]);
    assert.match(wholeBodyGroup.interpretation, /does not show continuous motion/i);
    assert.ok(batchResult.images.every(image => image.metadata.assetFingerprint === captureFingerprint && image.metadata.rigSignature === rigSignature
      && image.metadata.jointMapping.renamedJointCount === 1 && image.metadata.jointMapping.nameMapApplied
      && image.visualReviewTemplate.source === 'candidate_capture' && image.visualReviewTemplate.captureId === image.metadata.captureId
      && image.visualReviewTemplate.observationShape.captureId === image.metadata.captureId));
    const batchImageBlocks = batch.content as { type: string; text?: string; data?: string }[];
    const imageIndices = batchImageBlocks.flatMap((block, index) => block.type === 'image' ? [index] : []);
    assert.equal(imageIndices.length, 3);
    for (const [index, imageIndex] of imageIndices.entries()) {
      assert.equal(batchImageBlocks[imageIndex - 1]?.type, 'text', 'each image must be preceded by its own metadata and review template');
      assert.match(batchImageBlocks[imageIndex - 1]?.text ?? '', new RegExp(batchResult.images[index]!.metadata.captureId));
    }
    const singleFrameBatch = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: [batchCaptureIds[0]!],
    } });
    assert.ok(!singleFrameBatch.isError, JSON.stringify(singleFrameBatch));
    const singleFrameBatchResult = (singleFrameBatch.structuredContent as { result: { status: string; imageCount: number;
      captureCoverage: { status: string; completeGroupCount: number; groupCount: number; limitation: string };
      sequenceGroups: { coverage: { status: string; expectedFrameCount: number; receivedFrameCount: number;
        missingFrameCount: number; expectedFrames: { time: number; view: string }[]; missingFrames: { time: number; view: string }[] } }[] } }).result;
    assert.equal(singleFrameBatchResult.status, 'complete');
    assert.equal(singleFrameBatchResult.imageCount, 1,
      'a single surviving frame from a partial capture schedule must still be AI-readable');
    assert.deepEqual(singleFrameBatchResult.captureCoverage, { status: 'partial', completeGroupCount: 0, groupCount: 1,
      limitation: 'This reports requested-frame coverage only. It does not mean the AI has inspected or accepted the animation.' });
    assert.deepEqual(singleFrameBatchResult.sequenceGroups[0]!.coverage, { status: 'selected_subset', expectedFrameCount: 2,
      receivedFrameCount: 1, missingFrameCount: 1, expectedFrames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'front' }],
      missingFrames: [{ time: 0.5, view: 'front' }] });
    const workflowArtifactPath = join(root, 'workflow-candidate.json');
    await writeFile(workflowArtifactPath, JSON.stringify(recipe));
    const workflowStart = await client.callTool({ name: 'motion_workflow_start', arguments: { brief: {
      name: 'Exact capture handoff', kind: 'animation', request: 'Review this unsaved candidate', approach: 'Bind rendered evidence to the exact recipe',
      requirements: [{ id: 'readable', description: 'The action reads clearly at two times' }], avoid: [], references: [],
    } } });
    assert.ok(!workflowStart.isError, JSON.stringify(workflowStart));
    const workflowId = (workflowStart.structuredContent as { result: { workflow: { id: string } } }).result.workflow.id;
    const wrongWorkflowArtifactPath = join(root, 'wrong-workflow-candidate.json');
    await writeFile(wrongWorkflowArtifactPath, JSON.stringify({ ...recipe, name: 'Different fingerprint' }));
    const mismatchedWorkflowAttach = await client.callTool({ name: 'motion_workflow_attach_candidate_captures', arguments: {
      workflowId, revision: 1, artifactPath: wrongWorkflowArtifactPath, changes: 'wrong recipe fixture', sessionId,
      captureIds: batchCaptureIds.slice(0, 2),
    } });
    assert.equal(mismatchedWorkflowAttach.isError, true);
    assert.match(JSON.stringify(mismatchedWorkflowAttach), /do not match the exact animation candidate fingerprint/i);
    const workflowAttach = await client.callTool({ name: 'motion_workflow_attach_candidate_captures', arguments: {
      workflowId, revision: 1, artifactPath: workflowArtifactPath, changes: 'Attach exact Studio candidate frames', sessionId,
      captureIds: [batchCaptureIds[0], batchCaptureIds[2]],
    } });
    assert.ok(!workflowAttach.isError, JSON.stringify(workflowAttach));
    const workflowAttached = (workflowAttach.structuredContent as { result: { workflow: { revision: number; candidates: { id: string; captureCoverage?: {
      status: string; captureBatchCount: number; expectedWholeBodyFrameCount: number; capturedWholeBodyFrameCount: number;
      missingWholeBodyFrames: unknown[]; omittedMissingFrameCount: number; focusedFrameCount: number; incompleteBatchCount: number };
      evidence: {
      id: string; captureBinding?: { captureId: string; assetFingerprint: string; sessionId: string; rigId: string; rigSignature: string;
        time: number; view: string; imageSha256: string } }[] }[] } } }).result.workflow;
    const boundEvidence = workflowAttached.candidates[0]!.evidence;
    assert.equal(boundEvidence.length, 2);
    assert.deepEqual(workflowAttached.candidates[0]!.captureCoverage, { status: 'partial', captureBatchCount: 1,
      expectedWholeBodyFrameCount: 2, capturedWholeBodyFrameCount: 1, missingWholeBodyFrames: [{ captureBatchId: queuedResult.jobId, time: 0.5, view: 'front' }],
      omittedMissingFrameCount: 0, focusedFrameCount: 1, incompleteBatchCount: 1 });
    assert.equal(boundEvidence[0]!.captureBinding?.captureId, batchCaptureIds[0]);
    assert.equal(boundEvidence[0]!.captureBinding?.assetFingerprint, captureFingerprint);
    assert.equal(boundEvidence[0]!.captureBinding?.sessionId, sessionId);
    assert.equal(boundEvidence[0]!.captureBinding?.rigId, rigId);
    assert.equal(boundEvidence[0]!.captureBinding?.rigSignature, rigSignature);
    assert.equal(boundEvidence[0]!.captureBinding?.imageSha256, createHash('sha256').update(png).digest('hex'));
    const retryActions = workflowAttach.structuredContent as { result: { next: { actions: { tool: string }[] } } };
    assert.ok(retryActions.result.next.actions.some(action => action.tool === 'motion_workflow_append_candidate_captures'));
    const retryAttach = await client.callTool({ name: 'motion_workflow_append_candidate_captures', arguments: {
      workflowId, revision: workflowAttached.revision, candidateId: workflowAttached.candidates[0]!.id, sessionId,
      captureIds: [batchCaptureIds[1]],
    } });
    assert.ok(!retryAttach.isError, JSON.stringify(retryAttach));
    const retried = (retryAttach.structuredContent as { result: { workflow: { revision: number; candidates: { id: string; evidence: unknown[];
      captureCoverage: { status: string; expectedWholeBodyFrameCount: number; capturedWholeBodyFrameCount: number; missingWholeBodyFrames: unknown[] } }[] } } }).result.workflow;
    assert.equal(retried.candidates[0]!.id, workflowAttached.candidates[0]!.id);
    assert.equal(retried.candidates[0]!.evidence.length, 3);
    assert.deepEqual(retried.candidates[0]!.captureCoverage, { status: 'complete', captureBatchCount: 1,
      expectedWholeBodyFrameCount: 2, capturedWholeBodyFrameCount: 2, missingWholeBodyFrames: [], omittedMissingFrameCount: 0,
      focusedFrameCount: 1, incompleteBatchCount: 0 });
    captureImages.set(retryCaptureId, retryPng);
    const supplementalFocusAppend = await client.callTool({ name: 'motion_workflow_append_candidate_captures', arguments: {
      workflowId, revision: retried.revision, candidateId: retried.candidates[0]!.id, sessionId, captureIds: [retryCaptureId],
    } });
    assert.ok(!supplementalFocusAppend.isError, JSON.stringify(supplementalFocusAppend));
    const supplementalWorkflow = (supplementalFocusAppend.structuredContent as { result: { workflow: { revision: number; candidates: { evidence: {
      captureBinding?: { captureId: string; focusJoint?: string; assetFingerprint: string; rigId: string; rigSignature: string } }[];
      captureCoverage: { status: string; captureBatchCount: number; expectedWholeBodyFrameCount: number; capturedWholeBodyFrameCount: number;
        missingWholeBodyFrames: unknown[]; focusedFrameCount: number; incompleteBatchCount: number } }[] } } }).result.workflow;
    const supplementalEvidence = supplementalWorkflow.candidates[0]!.evidence.at(-1)!;
    assert.equal(supplementalEvidence.captureBinding?.captureId, retryCaptureId);
    assert.equal(supplementalEvidence.captureBinding?.focusJoint, 'UpperTorso', 'the inspected focus target must survive capture retrieval and workflow append');
    assert.equal(supplementalEvidence.captureBinding?.assetFingerprint, captureFingerprint);
    assert.equal(supplementalEvidence.captureBinding?.rigId, rigId);
    assert.equal(supplementalEvidence.captureBinding?.rigSignature, rigSignature);
    assert.deepEqual(supplementalWorkflow.candidates[0]!.captureCoverage, { status: 'complete', captureBatchCount: 2,
      expectedWholeBodyFrameCount: 2, capturedWholeBodyFrameCount: 2, missingWholeBodyFrames: [], omittedMissingFrameCount: 0,
      focusedFrameCount: 2, incompleteBatchCount: 0 },
    'a supplemental focused screenshot enriches visual evidence without changing whole-body coverage');
    const workflowEvidence = await client.callTool({ name: 'motion_workflow_read_evidence', arguments: {
      workflowId, evidenceId: boundEvidence[1]!.id,
    } });
    assert.ok(!workflowEvidence.isError, JSON.stringify(workflowEvidence));
    const workflowEvidenceBlocks = workflowEvidence.content as { type: string; text?: string; data?: string }[];
    assert.equal(workflowEvidenceBlocks[0]?.type, 'text');
    assert.match(workflowEvidenceBlocks[0]?.text ?? '', new RegExp(batchCaptureIds[2]!));
    assert.equal(workflowEvidenceBlocks[1]?.type, 'text');
    assert.match(workflowEvidenceBlocks[1]?.text ?? '', /included_in_server_response/);
    assert.match(workflowEvidenceBlocks[1]?.text ?? '', /does not confirm client receipt/);
    assert.match(workflowEvidenceBlocks[1]?.text ?? '', new RegExp(boundEvidence[1]!.id));
    assert.equal(workflowEvidenceBlocks[2]?.type, 'image');
    assert.equal(workflowEvidenceBlocks[2]?.data, captureImages.get(batchCaptureIds[2]!)!.toString('base64'));
    const overBudgetBatch = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: batchCaptureIds, maxBytes: 1,
    } });
    assert.equal((overBudgetBatch.structuredContent as { result: { status: string; imageCount: number } }).result.status, 'over_budget');
    assert.equal((overBudgetBatch.structuredContent as { result: { imageCount: number } }).result.imageCount, 0);
    assert.equal((overBudgetBatch.content as { type: string }[]).some(block => block.type === 'image'), false,
      'over-budget batch must not return a misleading subset of frames');
    const unavailableBatch = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
      sessionId, captureIds: [batchCaptureIds[0]!, randomUUID()],
    } });
    assert.equal((unavailableBatch.structuredContent as { result: { status: string; imageCount: number } }).result.status, 'image_read_failed');
    assert.equal((unavailableBatch.structuredContent as { result: { imageCount: number } }).result.imageCount, 0);
    assert.equal((unavailableBatch.content as { type: string }[]).some(block => block.type === 'image'), false);
    assert.deepEqual(new Set((await library.list()).assets.map(asset => asset.id)),
      new Set([intentReferenceAsset.id, editedIntentReferenceAsset.id]),
      'reading captures may reference existing assets but must not persist the unsaved candidate');
    clearInterval(chunkPoller);
    chunkPoller = undefined;
    const malformedCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, jointMap: { UpperTorso: 'Torso' }, frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'side' }],
    } });
    assert.ok(!malformedCapture.isError, JSON.stringify(malformedCapture));
    const malformedJobId = (malformedCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const malformedCommand = queue.poll(sessionId);
    assert.ok(malformedCommand);
    const malformedPayload = malformedCommand.payload as { assetId: string; assetFingerprint: string };
    const orphanCaptureId = randomUUID();
    const malformedMetadata = (time: number, view: 'front' | 'side') => ({ captureId: orphanCaptureId, sessionId,
      assetId: malformedPayload.assetId, assetFingerprint: malformedPayload.assetFingerprint, rigId, rigSignature,
      time, view, appliedJointMap: resolvedCaptureJointMap(recipe, { UpperTorso: 'Torso' }), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'malformed repeated-ID fixture' });
    queue.complete(sessionId, malformedCommand.id, true, { assetId: malformedPayload.assetId, rigId, sessionId, complete: true,
      note: 'malformed repeated capture ID', frames: [malformedMetadata(0, 'front'), malformedMetadata(0.5, 'side')] });
    const malformedOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: malformedJobId } });
    assert.equal(malformedOutcome.isError, true);
    assert.match(JSON.stringify(malformedOutcome), /reused a capture ID/i);
    const orphanRead = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId: orphanCaptureId } });
    assert.equal(orphanRead.isError, true);
    assert.match(JSON.stringify(orphanRead), /expired or unknown/i, 'failed batch validation must not publish an earlier frame as an orphan capture');
    const partialQueued = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, jointMap: { UpperTorso: 'Torso' }, frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'side' }],
    } });
    assert.ok(!partialQueued.isError, JSON.stringify(partialQueued));
    const partialJobId = (partialQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const partialCommand = queue.poll(sessionId);
    assert.ok(partialCommand);
    const partialPayload = partialCommand.payload as { assetId: string; assetFingerprint: string };
    const partialCaptureId = randomUUID();
    queue.complete(sessionId, partialCommand.id, true, { assetId: partialPayload.assetId, rigId, sessionId, complete: false, failedIndex: 2,
      error: 'Fixture screenshot permission was revoked.', note: 'Capture set stopped after one frame.', frames: [
        { captureId: partialCaptureId, sessionId, assetId: partialPayload.assetId, assetFingerprint: partialPayload.assetFingerprint,
          rigId, rigSignature, time: 0, view: 'front', appliedJointMap: resolvedCaptureJointMap(recipe, { UpperTorso: 'Torso' }), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture partial' },
      ] });
    const partialOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: partialJobId } });
    assert.ok(!partialOutcome.isError, JSON.stringify(partialOutcome));
    const partialResult = (partialOutcome.structuredContent as { result: { result: { complete: boolean; failedIndex: number; frames: unknown[]; next: string;
      captureCoverage: { status: string; requestedFrameCount: number; capturedFrameCount: number; missingFrameCount: number;
        requestedFrames: { time: number; view: string }[]; capturedFrames: { time: number; view: string }[]; missingFrames: { time: number; view: string }[];
        failedFrameIndex: number; failure: string } } } }).result.result;
    assert.equal(partialResult.complete, false);
    assert.equal(partialResult.failedIndex, 2);
    assert.equal(partialResult.frames.length, 1);
    assert.equal(partialResult.captureCoverage.status, 'partial');
    assert.equal(partialResult.captureCoverage.requestedFrameCount, 2);
    assert.equal(partialResult.captureCoverage.capturedFrameCount, 1);
    assert.equal(partialResult.captureCoverage.missingFrameCount, 1);
    assert.deepEqual(partialResult.captureCoverage.requestedFrames, [{ time: 0, view: 'front' }, { time: 0.5, view: 'side' }]);
    assert.deepEqual(partialResult.captureCoverage.capturedFrames.map(({ time, view }) => ({ time, view })), [{ time: 0, view: 'front' }]);
    assert.deepEqual(partialResult.captureCoverage.missingFrames, [{ time: 0.5, view: 'side' }]);
    assert.equal(partialResult.captureCoverage.failedFrameIndex, 2);
    assert.equal(partialResult.captureCoverage.failure, 'Fixture screenshot permission was revoked.');
    assert.match(partialResult.next, /retry only captureCoverage\.missingFrames/i);
    assert.match(partialResult.next, /expectedFingerprint equal to candidateFingerprint/i);
    assert.match(partialResult.next, /attach retry captures together with earlier (?:successful )?captures/i);
    const invalidFailureQueued = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, jointMap: { UpperTorso: 'Torso' }, frames: [{ time: 0, view: 'front' }, { time: 0.5, view: 'side' }],
    } });
    assert.ok(!invalidFailureQueued.isError, JSON.stringify(invalidFailureQueued));
    const invalidFailureJobId = (invalidFailureQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const invalidFailureCommand = queue.poll(sessionId);
    assert.ok(invalidFailureCommand);
    const invalidFailurePayload = invalidFailureCommand.payload as { assetId: string; assetFingerprint: string };
    const invalidFailureCaptureId = randomUUID();
    queue.complete(sessionId, invalidFailureCommand.id, true, { assetId: invalidFailurePayload.assetId, rigId, sessionId, complete: false,
      failedIndex: 3, error: 'Impossible failure after the requested schedule.', note: 'Malformed failure-index fixture.', frames: [
        { captureId: invalidFailureCaptureId, sessionId, assetId: invalidFailurePayload.assetId, assetFingerprint: invalidFailurePayload.assetFingerprint,
          rigId, rigSignature, time: 0, view: 'front', appliedJointMap: resolvedCaptureJointMap(recipe, { UpperTorso: 'Torso' }), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'malformed partial' },
      ] });
    const invalidFailureOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: invalidFailureJobId } });
    assert.equal(invalidFailureOutcome.isError, true);
    assert.match(JSON.stringify(invalidFailureOutcome), /mismatched or incomplete visual candidate capture/i);
    const invalidFailureOrphan = await client.callTool({ name: 'motion_studio_read_candidate_capture', arguments: { sessionId, captureId: invalidFailureCaptureId } });
    assert.equal(invalidFailureOrphan.isError, true);
    assert.match(JSON.stringify(invalidFailureOrphan), /expired or unknown/i);
  } finally {
    if (chunkPoller) clearInterval(chunkPoller);
    await client.close();
    await server.close();
  }
});

test('AI visual bake-off stays non-mutating and approved candidate patches retain visual provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-candidate-bakeoff-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'visual-bakeoff-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const candidates = [
    { label: 'Anticipation', recipe: animationSchema.parse({ ...animationPreset('cast', 'Candidate A', 1, 1),
      markers: [{ name: 'Windup', time: 0.25, phase: 'anticipation' as const }],
      contacts: [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.4, end: 0.6 }] }) },
    { label: 'Direct', recipe: animationSchema.parse({ ...animationPreset('slash', 'Candidate B', 1, 1),
      markers: [{ name: 'Impact', time: 0.5, phase: 'event' as const }] }) },
  ];
  const frames = [{ time: 0, view: 'front' as const }, { time: 0.5, view: 'front' as const }];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'candidate-bakeoff-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let chunkPoller: NodeJS.Timeout | undefined;
  let samplePoller: NodeJS.Timeout | undefined;
  let committedVisualAssetId: string | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const maximumComparison = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: {
      sessionId, rigId, candidates: [...candidates,
        { label: 'Extra C', recipe: animationPreset('idle', 'Candidate C', 1, 1) },
        { label: 'Extra D', recipe: animationPreset('walk', 'Candidate D', 1, 1) }],
      jointMap: {}, frames: [...frames, { time: 0.25, view: 'back' }, { time: 0.75, view: 'three_quarter' }],
    } });
    assert.ok(!maximumComparison.isError, JSON.stringify(maximumComparison));
    const maximumJobId = (maximumComparison.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.cancelQueued(maximumJobId), true, '4 candidates × 4 matched views should fit the bounded comparison budget');
    const duplicateLabels = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: {
      sessionId, rigId, candidates: [{ ...candidates[0]!, label: 'same' }, { ...candidates[1]!, label: 'SAME' }], jointMap: {}, frames,
    } });
    assert.ok(duplicateLabels.isError);
    assert.match(JSON.stringify(duplicateLabels), /labels must be unique/i);
    const duplicateFrames = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: {
      sessionId, rigId, candidates, jointMap: {}, frames: [frames[0], frames[0]],
    } });
    assert.ok(duplicateFrames.isError);
    assert.match(JSON.stringify(duplicateFrames), /distinct time\/view pairs/i);
    const queued = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: { sessionId, rigId, candidates, jointMap: {}, frames, expectedRigSignature: rigSignature } });
    assert.ok(!queued.isError, JSON.stringify(queued));
    const queuedResult = (queued.structuredContent as { result: { jobId: string; status: string } }).result;
    assert.equal(queuedResult.status, 'queued');
    const command = queue.poll(sessionId);
    assert.ok(command);
    assert.equal(command.operation, 'capture_candidate_comparison');
    const payload = command.payload as { rigSignature: string; candidates: { label: string; assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[]; frames: typeof frames };
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.frames, frames);
    queue.complete(sessionId, command.id, true, { sessionId, rigId, complete: true, note: 'matched synthetic viewport capture', candidates: payload.candidates.map(candidate => ({
      label: candidate.label, assetId: candidate.assetId, assetFingerprint: candidate.assetFingerprint,
      frames: frames.map(frame => ({ captureId: randomUUID(), sessionId, assetId: candidate.assetId, assetFingerprint: candidate.assetFingerprint,
        rigId, rigSignature, time: frame.time, view: frame.view, appliedJointMap: resolvedCaptureJointMap(candidate.recipe, {}), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture' })),
    })) });
    const outcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: queuedResult.jobId } });
    assert.ok(!outcome.isError, JSON.stringify(outcome));
    const comparison = (outcome.structuredContent as { result: { result: { complete: boolean; candidates: { label: string; candidateFingerprint: string; frames: { time: number; view: string; captureId: string }[] }[]; next: string } } }).result.result;
    assert.equal(comparison.complete, true);
    assert.deepEqual(comparison.candidates.map(candidate => candidate.label), ['Anticipation', 'Direct']);
    assert.deepEqual(comparison.candidates[0]!.frames.map(({ time, view }) => ({ time, view })), comparison.candidates[1]!.frames.map(({ time, view }) => ({ time, view })));
    assert.notEqual(comparison.candidates[0]!.candidateFingerprint, comparison.candidates[1]!.candidateFingerprint);
    assert.match(comparison.next, /does not choose or save a winner/i);
    const oversizedBundle = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: { jobId: queuedResult.jobId, maxBytes: 100 } });
    assert.equal(oversizedBundle.isError, undefined);
    const oversizedResult = (oversizedBundle.structuredContent as { result: { status: string; imageCount: number; estimatedBytes: number; maxBytes: number;
      readPlan: { captureId: string; label: string; time: number; view: string }[]; next: string } }).result;
    assert.equal(oversizedResult.status, 'over_budget');
    assert.equal(oversizedResult.imageCount, 0);
    assert.ok(oversizedResult.estimatedBytes > oversizedResult.maxBytes);
    assert.equal(oversizedResult.readPlan.length, 4);
    assert.ok(oversizedResult.readPlan.every(frame => frame.captureId && frame.label && typeof frame.time === 'number' && frame.view));
    assert.match(oversizedResult.next, /Do not claim visual inspection/i);
    const duplicateCriteria = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: {
      jobId: queuedResult.jobId, criteria: ['Readable anticipation', ' readable ANTICIPATION '],
    } });
    assert.ok(duplicateCriteria.isError);
    assert.match(JSON.stringify(duplicateCriteria), /criteria must be unique/i);
    const aliasedCapture = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: {
      sessionId, rigId, candidates, jointMap: {}, frames,
    } });
    assert.ok(!aliasedCapture.isError, JSON.stringify(aliasedCapture));
    const aliasedJobId = (aliasedCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const aliasedCommand = queue.poll(sessionId);
    assert.ok(aliasedCommand);
    const aliasedPayload = aliasedCommand.payload as { candidates: { label: string; assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[] };
    const reusedCaptureId = randomUUID();
    queue.complete(sessionId, aliasedCommand.id, true, { sessionId, rigId, complete: true, note: 'malformed duplicate capture IDs',
      candidates: aliasedPayload.candidates.map(candidate => ({ label: candidate.label, assetId: candidate.assetId,
        assetFingerprint: candidate.assetFingerprint, frames: frames.map(frame => ({ captureId: reusedCaptureId, sessionId,
          assetId: candidate.assetId, assetFingerprint: candidate.assetFingerprint, rigId, rigSignature, time: frame.time,
          view: frame.view, appliedJointMap: resolvedCaptureJointMap(candidate.recipe, {}), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture' })) })) });
    const aliasedResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: aliasedJobId } });
    assert.equal(aliasedResult.isError, true);
    assert.match(JSON.stringify(aliasedResult), /reused a capture ID/i);
    chunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const chunkCommand = queue.poll(sessionId);
      if (!chunkCommand || chunkCommand.operation !== 'capture_chunk') return;
      const chunkPayload = chunkCommand.payload as { captureId: string; index: number };
      queue.complete(sessionId, chunkCommand.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: png.toString('hex') });
    }, 2);
    try {
      const criteria = ['Clear anticipation before release', 'Hands remain readable during the strike'];
      const bundle = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: { jobId: queuedResult.jobId, criteria } });
      assert.ok(!bundle.isError, JSON.stringify(bundle));
      const bundleResult = (bundle.structuredContent as { result: { complete: boolean; imageCount: number; reviewGuidance: { criteria: string[]; protocol: string };
        coverage: { label: string; expectedFrameCount: number; receivedFrameCount: number; missingFrameCount: number; status: string; missingFrames: unknown[] }[];
        images: { label: string; time: number; view: string; authoredContext: { nearbyMarkers: { name: string }[];
          activeDeclaredContacts: { effector: string; kind: string }[]; interpretation: string } }[];
        sequenceGroups: { captureBatchId: string; source: string; candidateLabel: string; view: string; frameCount: number;
          coverage: { status: string; expectedFrameCount: number; receivedFrameCount: number; missingFrameCount: number };
          frames: { time: number; secondsFromPrevious: number | null }[] }[] } }).result;
      assert.equal(bundleResult.complete, true);
      assert.equal(bundleResult.imageCount, 4);
      assert.deepEqual(bundleResult.coverage.map(item => ({ status: item.status, expected: item.expectedFrameCount,
        received: item.receivedFrameCount, missing: item.missingFrameCount })), [
        { status: 'complete', expected: 2, received: 2, missing: 0 }, { status: 'complete', expected: 2, received: 2, missing: 0 },
      ]);
      assert.deepEqual(bundleResult.reviewGuidance.criteria, criteria);
      assert.match(bundleResult.reviewGuidance.protocol, /cite the exact captureId/i);
      assert.match(bundleResult.reviewGuidance.protocol, /sparse storyboard/i);
      assert.match(bundleResult.reviewGuidance.protocol, /exact capture batch/i);
      const guidanceBlock = (bundle.content as { type: string; text?: string }[]).find(block => block.type === 'text');
      assert.ok(guidanceBlock?.text?.includes('Clear anticipation before release'));
      assert.deepEqual(bundleResult.images.map(image => image.label), ['Anticipation', 'Anticipation', 'Direct', 'Direct']);
      assert.deepEqual(bundleResult.images.map(({ time, view }) => ({ time, view })), [frames, frames].flat());
      assert.deepEqual(bundleResult.sequenceGroups.map(group => [group.candidateLabel, group.view, group.frameCount]),
        [['Anticipation', 'front', 2], ['Direct', 'front', 2]]);
      assert.ok(bundleResult.sequenceGroups.every(group => group.captureBatchId === queuedResult.jobId && group.source === 'candidate'));
      assert.ok(bundleResult.sequenceGroups.every(group => group.coverage.status === 'complete' && group.coverage.expectedFrameCount === 2
        && group.coverage.receivedFrameCount === 2 && group.coverage.missingFrameCount === 0));
      assert.ok(bundleResult.sequenceGroups.every(group => group.frames.map(frame => [frame.time, frame.secondsFromPrevious])
        .every((entry, index) => entry[0] === (index === 0 ? 0 : 0.5) && entry[1] === (index === 0 ? null : 0.5))));
      assert.deepEqual(bundleResult.images[1]!.authoredContext.activeDeclaredContacts,
        [{ effector: 'LeftFoot', kind: 'support', start: 0.4, end: 0.6 }]);
      assert.deepEqual(bundleResult.images[2]!.authoredContext.nearbyMarkers.map(marker => marker.name), ['Impact']);
      assert.match(bundleResult.images[2]!.authoredContext.interpretation, /not proof of visible pose.*actual contact/i);
      const imageBlocks = (bundle.content as { type: string; data?: string }[]).filter(block => block.type === 'image');
      assert.equal(imageBlocks.length, 4);
      assert.ok(imageBlocks.every(block => block.data === png.toString('base64')));
      const assessmentInput = { jobId: queuedResult.jobId, criteria, assessments: [
        { candidateLabel: 'Anticipation', criterion: criteria[0]!, status: 'supported', observation: 'The first view clearly shows a preparatory arm movement before the strike.', evidenceCaptureIds: [comparison.candidates[0]!.frames[0]!.captureId] },
        { candidateLabel: 'Anticipation', criterion: criteria[1]!, status: 'unclear', observation: 'The still frames do not establish hand readability throughout the complete strike.', evidenceCaptureIds: [] },
        { candidateLabel: 'Direct', criterion: criteria[0]!, status: 'contradicted', observation: 'The captured start pose proceeds directly into the strike without a visible windup.', evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
        { candidateLabel: 'Direct', criterion: criteria[1]!, status: 'supported', observation: 'The later front view keeps both hands visually separated at the sampled strike time.', evidenceCaptureIds: [comparison.candidates[1]!.frames[1]!.captureId] },
      ] };
      const historyRoot = join(root, 'artifacts', 'visual-bakeoff-runs');
      await mkdir(historyRoot, { recursive: true });
      const imageDirectoryBlocker = join(historyRoot, 'images');
      await writeFile(imageDirectoryBlocker, 'intentional persistence failure fixture');
      const failedPersistence = await client.callTool({ name: 'motion_studio_validate_candidate_comparison_review', arguments: assessmentInput });
      assert.equal(failedPersistence.isError, true);
      const uncommittedReviewPatch = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: candidates[1]!.recipe, expectedSourceFingerprint: fingerprint(candidates[1]!.recipe),
        operations: [{ operation: 'set_pose', joint: candidates[1]!.recipe.tracks[0]!.joint,
          time: candidates[1]!.recipe.tracks[0]!.keys[0]!.time, rotation: [0, 5, 0] }],
        visualFinding: { jobId: queuedResult.jobId, reportFingerprint: '0'.repeat(64), candidateFingerprint: fingerprint(candidates[1]!.recipe),
          criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
        changeIntent: 'Test that failed report persistence does not authorize a visual-finding patch.',
      } });
      assert.equal(uncommittedReviewPatch.isError, true);
      assert.match(JSON.stringify(uncommittedReviewPatch), /report is missing, incomplete, or has a different fingerprint/i);
      await rm(imageDirectoryBlocker);
      const validatedReport = await client.callTool({ name: 'motion_studio_validate_candidate_comparison_review', arguments: assessmentInput });
      assert.ok(!validatedReport.isError, JSON.stringify(validatedReport));
      const report = (validatedReport.structuredContent as { result: { valid: boolean; reportFingerprint: string; interpretationVerified: boolean;
        historyRecordId: string; technicalAudits: { candidateLabel: string; peaks: { localAngularSpeed: number } }[];
        assessments: { evidence: { captureId: string; sha256: string; normalizedProgress: number;
          jointMapping: { fingerprint: string; renamedJointCount: number; nameMapApplied: boolean; limitation: string } }[] }[]; note: string } }).result;
      assert.equal(report.valid, true);
      assert.match(report.reportFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(report.interpretationVerified, false);
      assert.equal(report.assessments.length, 4);
      assert.equal(report.technicalAudits.length, 2);
      assert.match(report.assessments[0]!.evidence[0]!.sha256, /^[0-9a-f]{64}$/);
      assert.match(report.assessments[0]!.evidence[0]!.jointMapping.fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(report.assessments[0]!.evidence[0]!.jointMapping.renamedJointCount, 0);
      assert.ok(report.assessments[0]!.evidence[0]!.normalizedProgress >= 0 && report.assessments[0]!.evidence[0]!.normalizedProgress <= 1);
      assert.match(report.note, /did not verify the visual observations/i);
      assert.match(report.historyRecordId, /^[0-9a-f-]{36}$/i);
      const visualHistory = await client.callTool({ name: 'motion_studio_visual_bakeoff_history', arguments: { limit: 10 } });
      assert.ok(!visualHistory.isError, JSON.stringify(visualHistory));
      const visualRun = (visualHistory.structuredContent as { result: { total: number; records: { id: string; reportFingerprint: string }[] } }).result.records
        .find(record => record.id === report.historyRecordId);
      assert.equal(visualRun?.reportFingerprint, report.reportFingerprint);
      const visualRead = await client.callTool({ name: 'motion_studio_visual_bakeoff_read', arguments: { historyRecordId: report.historyRecordId } });
      assert.ok(!visualRead.isError, JSON.stringify(visualRead));
      assert.equal((visualRead.structuredContent as { result: { assessments: unknown[] } }).result.assessments.length, 4);
      const citedCaptureId = report.assessments[0]!.evidence[0]!.captureId;
      const historicalImage = await client.callTool({ name: 'motion_studio_visual_bakeoff_evidence_image_read', arguments: {
        historyRecordId: report.historyRecordId, captureId: citedCaptureId,
      } });
      assert.ok(!historicalImage.isError, JSON.stringify(historicalImage));
      assert.equal((historicalImage.content as { type: string; data?: string }[]).find(block => block.type === 'image')?.data, png.toString('base64'));
      const recoveredRecipe = await client.callTool({ name: 'motion_studio_visual_bakeoff_recipe_read', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: candidates[0]!.label,
      } });
      assert.ok(!recoveredRecipe.isError, JSON.stringify(recoveredRecipe));
      const recipeHandoff = (recoveredRecipe.structuredContent as { result: { candidate: { candidateFingerprint: string }; recipe: { kind: string }; persistence: string } }).result;
      assert.equal(recipeHandoff.candidate.candidateFingerprint, fingerprint(candidates[0]!.recipe));
      assert.equal(recipeHandoff.recipe.kind, 'animation');
      assert.match(recipeHandoff.persistence, /still unsaved/i);
      const refinementContextResult = await client.callTool({ name: 'motion_studio_visual_bakeoff_refinement_context', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: 'Direct', criterion: criteria[0],
      } });
      assert.ok(!refinementContextResult.isError, JSON.stringify(refinementContextResult));
      const refinementContext = (refinementContextResult.structuredContent as { result: { sourceFingerprint: string;
        findings: { status: string; imageBytesAvailable: boolean; evidence: { jointMapping?: { fingerprint: string; renamedJointCount: number; nameMapApplied: boolean } }[];
          patchPreviewBinding?: { candidateFingerprint: string; criterion: string; evidenceCaptureIds: string[] } }[];
        limitation: string; next: string; imageDelivery: { requested: boolean; returned: number; totalBytes: number } } }).result;
      assert.equal(refinementContext.sourceFingerprint, fingerprint(candidates[1]!.recipe));
      assert.equal(refinementContext.findings[0]!.status, 'contradicted');
      assert.equal(refinementContext.findings[0]!.imageBytesAvailable, true);
      assert.match(refinementContext.findings[0]!.evidence[0]!.jointMapping!.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(refinementContext.findings[0]!.evidence[0]!.jointMapping!.nameMapApplied, false);
      assert.equal(refinementContext.findings[0]!.patchPreviewBinding?.candidateFingerprint, fingerprint(candidates[1]!.recipe));
      assert.equal(refinementContext.findings[0]!.patchPreviewBinding?.criterion, criteria[0]);
      assert.equal(refinementContext.findings[0]!.patchPreviewBinding?.evidenceCaptureIds.length, 1);
      assert.match(refinementContext.limitation, /historical context/i);
      assert.match(refinementContext.next, /Inspect the inline historical image blocks/);
      assert.match(refinementContext.next, /If images were not requested, retrieve cited frames/);
      assert.match(refinementContext.next, /If a cited image is unavailable or fails integrity checks, do not claim visual inspection/);
      assert.deepEqual(refinementContext.imageDelivery, { requested: true, returned: 1, totalBytes: png.length, maximumBytes: 4_000_000 });
      const refinementImageBlocks = (refinementContextResult.content as { type: string; data?: string }[]).filter(block => block.type === 'image');
      assert.equal(refinementImageBlocks.length, 1);
      assert.equal(refinementImageBlocks[0]!.data, png.toString('base64'));
      const oversizedRefinementContext = await client.callTool({ name: 'motion_studio_visual_bakeoff_refinement_context', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: 'Direct', criterion: criteria[0], maxImageBytes: 1,
      } });
      assert.equal(oversizedRefinementContext.isError, true);
      assert.match((oversizedRefinementContext.content as { type: string; text?: string }[])[0]!.text!, /Narrow the request with criterion or raise maxImageBytes/);
      const visualCompare = await client.callTool({ name: 'motion_studio_visual_bakeoff_compare', arguments: {
        beforeRecordId: report.historyRecordId, afterRecordId: report.historyRecordId,
      } });
      assert.ok(!visualCompare.isError, JSON.stringify(visualCompare));
      const visualComparison = (visualCompare.structuredContent as { result: { assessmentChanges: { change: string }[];
        regressionSummary: { coverage: string; reportedOutcome: string; interpretationVerified: boolean };
        evidenceTiming: { matchedAssessmentCount: number; comparisons: { evidenceByView: { normalizedProgressDeltaByOrder: (number | null)[] }[] }[] } } }).result;
      assert.ok(visualComparison.assessmentChanges.every(change => change.change === 'unchanged'));
      assert.equal(visualComparison.regressionSummary.coverage, 'complete');
      assert.equal(visualComparison.regressionSummary.reportedOutcome, 'inconclusive');
      assert.equal(visualComparison.regressionSummary.interpretationVerified, false);
      assert.equal(visualComparison.evidenceTiming.matchedAssessmentCount, 4);
      assert.ok(visualComparison.evidenceTiming.comparisons.flatMap(item => item.evidenceByView).flatMap(item => item.normalizedProgressDeltaByOrder).every(delta => delta === 0));
      const recheckPlanResult = await client.callTool({ name: 'motion_studio_visual_bakeoff_recheck_plan', arguments: {
        historyRecordId: report.historyRecordId, candidates, views: ['side'], maxFrames: 4,
      } });
      assert.ok(!recheckPlanResult.isError, JSON.stringify(recheckPlanResult));
      const recheckPlan = (recheckPlanResult.structuredContent as { result: { baseline: { criteria: string[]; rigSignature: string };
        candidateMapping: { label: string; duration: number; priorCandidate: { recipeChanged: boolean; durationChanged: boolean } | null; priorFindings: { criterion: string; status: string }[] }[];
        capturePlan: { frames: { time: number; view: string }[] } } }).result;
      assert.deepEqual(recheckPlan.baseline.criteria, criteria);
      assert.equal(recheckPlan.candidateMapping[0]!.priorCandidate?.recipeChanged, false);
      assert.equal(recheckPlan.candidateMapping[0]!.priorCandidate?.durationChanged, false);
      assert.equal(recheckPlan.candidateMapping[0]!.priorFindings.length, criteria.length);
      assert.equal(recheckPlan.capturePlan.frames.length, 4);
      const mismatchedRecheckCapture = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: {
        sessionId, rigId, candidates, frames: recheckPlan.capturePlan.frames, expectedRigSignature: 'different-rig-topology',
      } });
      assert.equal(mismatchedRecheckCapture.isError, true);
      assert.match(JSON.stringify(mismatchedRecheckCapture), /differs from expectedRigSignature/i);
      const recoveredCandidate = await client.callTool({ name: 'motion_studio_read_candidate_recipe', arguments: {
        jobId: queuedResult.jobId, candidateFingerprint: comparison.candidates[0]!.candidateFingerprint,
      } });
      assert.ok(!recoveredCandidate.isError, JSON.stringify(recoveredCandidate));
      const recovered = (recoveredCandidate.structuredContent as { result: { candidateLabel: string; candidateFingerprint: string;
        recipe: AnimationRecipe; visualReview: { interpretationVerified: boolean; assessments: { criterion: string; evidence: { captureId: string; sha256: string }[] }[] } } }).result;
      assert.equal(recovered.candidateLabel, 'Anticipation');
      assert.equal(recovered.candidateFingerprint, comparison.candidates[0]!.candidateFingerprint);
      assert.deepEqual(recovered.recipe, candidates[0]!.recipe);
      assert.equal(recovered.visualReview.interpretationVerified, false);
      assert.equal(recovered.visualReview.assessments.length, 2);
      assert.ok(recovered.visualReview.assessments.flatMap(item => item.evidence).every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
      const patchPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recovered.recipe, expectedSourceFingerprint: recovered.candidateFingerprint,
        operations: [{ operation: 'insert_key', joint: recovered.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(!patchPreview.isError, JSON.stringify(patchPreview));
      const previewed = (patchPreview.structuredContent as { result: { saved: boolean; sourceFingerprint: string; candidateFingerprint: string;
        recipeFingerprint: string; recipe: AnimationRecipe; changes: unknown[] } }).result;
      assert.equal(previewed.saved, false);
      assert.equal(previewed.sourceFingerprint, recovered.candidateFingerprint);
      assert.equal(previewed.recipeFingerprint, fingerprint(previewed.recipe));
      assert.notEqual(previewed.recipeFingerprint, previewed.sourceFingerprint);
      assert.ok(previewed.candidateFingerprint.length === 64 && previewed.changes.length === 1);
      const supportedAsDefect = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recovered.recipe, expectedSourceFingerprint: recovered.candidateFingerprint,
        visualFinding: { jobId: queuedResult.jobId, candidateFingerprint: recovered.candidateFingerprint,
          reportFingerprint: report.reportFingerprint, criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[0]!.frames[0]!.captureId] },
        changeIntent: 'Increase windup because the visual report says it is present.',
        operations: [{ operation: 'insert_key', joint: recovered.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(supportedAsDefect.isError);
      assert.match(JSON.stringify(supportedAsDefect), /must cite an exact contradicted criterion/i);
      const recoveredDirectResult = await client.callTool({ name: 'motion_studio_read_candidate_recipe', arguments: {
        jobId: queuedResult.jobId, candidateFingerprint: comparison.candidates[1]!.candidateFingerprint,
      } });
      assert.ok(!recoveredDirectResult.isError, JSON.stringify(recoveredDirectResult));
      const recoveredDirect = (recoveredDirectResult.structuredContent as { result: { candidateFingerprint: string; recipe: AnimationRecipe } }).result;
      const persistedFindingPatch = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recoveredDirect.recipe, expectedSourceFingerprint: recoveredDirect.candidateFingerprint,
        visualFinding: { historyRecordId: report.historyRecordId, candidateFingerprint: recoveredDirect.candidateFingerprint,
          criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
        changeIntent: 'Add a visible preparatory wrist and upper-arm pose before the release.',
        operations: [{ operation: 'insert_key', joint: recoveredDirect.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(!persistedFindingPatch.isError, JSON.stringify(persistedFindingPatch));
      const persistedFinding = (persistedFindingPatch.structuredContent as { result: { saved: boolean; candidateFingerprint: string; refinement: {
        visualFinding: { historyRecordId: string; reportFingerprint: string };
        reviewPlan: { status: string; citedFrames: { captureId: string; time: number; view: string; authoredContext: { normalizedProgress: number;
          nearbyMarkers: { name: string }[] } }[]; proposedChanges: { operation: string }[]; preservationGuards: unknown[];
          requiredChecks: string[]; limitation: string } } } }).result;
      assert.equal(persistedFinding.saved, false);
      assert.equal(persistedFinding.refinement.visualFinding.historyRecordId, report.historyRecordId);
      assert.equal(persistedFinding.refinement.visualFinding.reportFingerprint, report.reportFingerprint);
      assert.equal(persistedFinding.refinement.reviewPlan.status, 'agent_review_required');
      assert.deepEqual(persistedFinding.refinement.reviewPlan.citedFrames.map(frame => [frame.captureId, frame.time, frame.view]),
        [{ captureId: comparison.candidates[1]!.frames[0]!.captureId, time: 0, view: 'front' }].map(frame => [frame.captureId, frame.time, frame.view]));
      assert.deepEqual(persistedFinding.refinement.reviewPlan.citedFrames[0]!.authoredContext.nearbyMarkers.map(marker => marker.name), ['Impact']);
      assert.equal(persistedFinding.refinement.reviewPlan.proposedChanges[0]!.operation, 'insert_key');
      assert.equal(persistedFinding.refinement.reviewPlan.preservationGuards.length, 0);
      assert.match(persistedFinding.refinement.reviewPlan.requiredChecks.join(' '), /add guards for accepted surrounding motion/i);
      assert.match(persistedFinding.refinement.reviewPlan.limitation, /does not prove that edits affect the cited visual cue/i);
      const unapprovedCommit = await client.callTool({ name: 'motion_animation_candidate_patch_commit', arguments: {
        recipe: recoveredDirect.recipe, expectedSourceFingerprint: recoveredDirect.candidateFingerprint,
        operations: [{ operation: 'insert_key', joint: recoveredDirect.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
        expectedCandidateFingerprint: persistedFinding.candidateFingerprint, userApproved: false,
        changeIntent: 'Add a visible preparatory wrist and upper-arm pose before the release.',
        visualFinding: { historyRecordId: report.historyRecordId, candidateFingerprint: recoveredDirect.candidateFingerprint,
          criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
      } });
      assert.equal(unapprovedCommit.isError, true);
      const visualPatchCommitArguments = {
        recipe: recoveredDirect.recipe, expectedSourceFingerprint: recoveredDirect.candidateFingerprint,
        operations: [{ operation: 'insert_key', joint: recoveredDirect.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
        expectedCandidateFingerprint: (persistedFindingPatch.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint,
        userApproved: true,
        visualFinding: { historyRecordId: report.historyRecordId, candidateFingerprint: recoveredDirect.candidateFingerprint,
          criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
        changeIntent: 'Add a visible preparatory wrist and upper-arm pose before the release.',
      };
      const committedVisualPatch = await client.callTool({ name: 'motion_animation_candidate_patch_commit', arguments: visualPatchCommitArguments });
      assert.ok(!committedVisualPatch.isError, JSON.stringify(committedVisualPatch));
      const committedVisual = (committedVisualPatch.structuredContent as { result: { assetId: string; parentId: string | null; idempotentIdentity: boolean; revisionProvenance: { visualFinding: { historyRecordId: string; criterion: string }; changeIntent: string } } }).result;
      committedVisualAssetId = committedVisual.assetId;
      assert.equal(committedVisual.idempotentIdentity, true);
      const retriedVisualPatch = await client.callTool({ name: 'motion_animation_candidate_patch_commit', arguments: visualPatchCommitArguments });
      assert.ok(!retriedVisualPatch.isError, JSON.stringify(retriedVisualPatch));
      assert.equal((retriedVisualPatch.structuredContent as { result: { assetId: string } }).result.assetId, committedVisual.assetId);
      assert.equal(committedVisual.parentId, null);
      assert.equal(committedVisual.revisionProvenance.visualFinding.historyRecordId, report.historyRecordId);
      assert.equal(committedVisual.revisionProvenance.visualFinding.criterion, criteria[0]);
      assert.equal(committedVisual.revisionProvenance.changeIntent, 'Add a visible preparatory wrist and upper-arm pose before the release.');
      const reloadedVisualAsset = await library.get(committedVisual.assetId);
      assert.equal(reloadedVisualAsset.revisionProvenance?.candidateFingerprint,
        (persistedFindingPatch.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint);
      const lineageRead = await client.callTool({ name: 'motion_library_read', arguments: { assetId: committedVisual.assetId } });
      assert.ok(!lineageRead.isError, JSON.stringify(lineageRead));
      const lineageAsset = (lineageRead.structuredContent as { result: { revisionProvenance?: { visualFinding?: { reportFingerprint: string }; changeIntent?: string } } }).result;
      assert.equal(lineageAsset.revisionProvenance?.visualFinding?.reportFingerprint, report.reportFingerprint);
      assert.equal(lineageAsset.revisionProvenance?.changeIntent, 'Add a visible preparatory wrist and upper-arm pose before the release.');
      const visibleMetadata = await library.list();
      assert.equal(Object.hasOwn(visibleMetadata.assets[0]!, 'revisionProvenance'), false, 'Library listings should stay compact; full provenance is available from library_read.');
      const traceablePatch = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recoveredDirect.recipe, expectedSourceFingerprint: recoveredDirect.candidateFingerprint,
        visualFinding: { jobId: queuedResult.jobId, candidateFingerprint: recoveredDirect.candidateFingerprint,
          reportFingerprint: report.reportFingerprint, criterion: criteria[0]!, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] },
        changeIntent: 'Add a visible preparatory wrist and upper-arm pose before the release.',
        operations: [{ operation: 'insert_key', joint: recoveredDirect.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(!traceablePatch.isError, JSON.stringify(traceablePatch));
      const traceable = (traceablePatch.structuredContent as { result: { refinement: { visualFinding: { status: string; criterion: string;
        evidence: { captureId: string; sha256: string }[] }; changeIntent: string; provenanceFingerprint: string } } }).result;
      assert.equal(traceable.refinement.visualFinding.status, 'contradicted');
      assert.equal(traceable.refinement.visualFinding.criterion, criteria[0]);
      assert.equal(traceable.refinement.visualFinding.evidence[0]!.captureId, comparison.candidates[1]!.frames[0]!.captureId);
      assert.match(traceable.refinement.visualFinding.evidence[0]!.sha256, /^[0-9a-f]{64}$/);
      assert.equal(traceable.refinement.changeIntent, 'Add a visible preparatory wrist and upper-arm pose before the release.');
      assert.match(traceable.refinement.provenanceFingerprint, /^[0-9a-f]{64}$/);
      if (chunkPoller) clearInterval(chunkPoller);
      chunkPoller = undefined;
      let sampledCandidateCount = 0;
      let corruptNextSampleSchedule = true;
      samplePoller = setInterval(() => {
        queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
        const sampleJob = queue.poll(sessionId);
        if (!sampleJob || sampleJob.operation !== 'sample_animation') return;
        const payload = sampleJob.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
        sampledCandidateCount += 1;
        const nodes = [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, ...payload.recipe.tracks.map(track => ({
          name: track.joint, parent: 1, driven: true, foot: false,
        }))];
        queue.complete(sessionId, sampleJob.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
          duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'candidate patch preview fixture', nodes,
          samples: payload.times.map((requestedTime, sampleIndex) => ({ id: `s${String(sampleIndex).padStart(3, '0')}`,
            time: corruptNextSampleSchedule && sampledCandidateCount === 1 && sampleIndex === 1 ? requestedTime + 0.001 : requestedTime,
            points: nodes.map((_, nodeIndex) => [0, requestedTime / 10, nodeIndex / 10]), pivotPoints: nodes.map((_, nodeIndex) => [0, requestedTime / 10, nodeIndex / 10]),
            bottoms: nodes.map(() => 0), orientations: nodes.map(() => [0, 0, 0, 1]) })),
        });
      }, 2);
      const alteredSchedulePreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recovered.recipe, expectedSourceFingerprint: recovered.candidateFingerprint, sessionId, rigId,
        operations: [{ operation: 'insert_key', joint: recovered.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.equal(alteredSchedulePreview.isError, true);
      assert.match(JSON.stringify(alteredSchedulePreview), /sample schedule at index 1.*partial Studio samples cannot support/i);
      assert.equal(sampledCandidateCount, 1, 'a mismatched source sample schedule must fail before sampling the patched candidate');
      sampledCandidateCount = 0;
      corruptNextSampleSchedule = false;
      const livePatchPreview = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recovered.recipe, expectedSourceFingerprint: recovered.candidateFingerprint, sessionId, rigId,
        operations: [{ operation: 'insert_key', joint: recovered.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(!livePatchPreview.isError, JSON.stringify(livePatchPreview));
      const livePreviewResult = (livePatchPreview.structuredContent as { result: { studioComparison: { rigSignature: string };
        liveRigComparison: { status: string; positionFrame: string }; next: string } }).result;
      assert.equal(livePreviewResult.studioComparison.rigSignature, rigSignature);
      assert.equal(livePreviewResult.liveRigComparison.status, 'available');
      assert.match(livePreviewResult.next, /same-rig source-versus-candidate.*not an artistic verdict/i);
      assert.equal(sampledCandidateCount, 2, 'source and revised unsaved recipes are sampled sequentially on the same live rig');
      sampledCandidateCount = 0;
      const persistedRecheck = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: 'Direct', revisedRecipe: animationPreset('slash', 'Candidate B revision', 1, 1),
        sessionId, rigId, acceptance: { requiredTracks: ['UpperTorso'] },
      } });
      assert.ok(!persistedRecheck.isError, JSON.stringify(persistedRecheck));
      const recheck = (persistedRecheck.structuredContent as { result: { recheckRecordId: string; comparison: { status: string };
        baselineRigSignature: string; measuredRigSignature: string; sameRigTopologyAsBaseline: boolean;
        baseline: { fingerprint: string; acceptance: { status: string } }; revision: { acceptance: { status: string } };
        limitations: string[] } }).result;
      assert.match(recheck.recheckRecordId, /^[0-9a-f-]{36}$/i);
      assert.equal(recheck.comparison.status, 'available');
      assert.equal(recheck.baselineRigSignature, rigSignature);
      assert.equal(recheck.measuredRigSignature, rigSignature);
      assert.equal(recheck.sameRigTopologyAsBaseline, true);
      assert.equal(recheck.baseline.fingerprint, recoveredDirect.candidateFingerprint);
      assert.equal(recheck.baseline.acceptance.status, 'passed');
      assert.equal(recheck.revision.acceptance.status, 'passed');
      assert.equal(sampledCandidateCount, 2, 'persisted baseline and unsaved revision are re-sampled sequentially');
      assert.ok(recheck.limitations.some(item => /historical screenshots are not re-captured/i.test(item)));
      const recheckReadResult = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck_read', arguments: { recheckRecordId: recheck.recheckRecordId } });
      assert.ok(!recheckReadResult.isError, JSON.stringify(recheckReadResult));
      const recheckRead = (recheckReadResult.structuredContent as { result: { recheckRecordId: string; comparison: { status: string }; revision: { acceptance: { status: string } } } }).result;
      assert.equal(recheckRead.recheckRecordId, recheck.recheckRecordId);
      assert.equal(recheckRead.comparison.status, 'available');
      assert.equal(recheckRead.revision.acceptance.status, 'passed');
      const secondRecheck = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: 'Direct', revisedRecipe: animationPreset('slash', 'Candidate B revision 2', 1, 1),
        sessionId, rigId, acceptance: { requiredTracks: ['UpperTorso'] },
      } });
      assert.ok(!secondRecheck.isError, JSON.stringify(secondRecheck));
      const secondRecheckId = (secondRecheck.structuredContent as { result: { recheckRecordId: string } }).result.recheckRecordId;
      const recheckList = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck_history', arguments: { historyRecordId: report.historyRecordId } });
      assert.ok(!recheckList.isError, JSON.stringify(recheckList));
      const recheckListResult = (recheckList.structuredContent as { result: { total: number; records: { id: string }[] } }).result;
      assert.equal(recheckListResult.total, 2);
      assert.ok(recheckListResult.records.some(item => item.id === recheck.recheckRecordId));
      assert.ok(recheckListResult.records.some(item => item.id === secondRecheckId));
      const recheckCompare = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck_compare', arguments: {
        beforeRecheckRecordId: recheck.recheckRecordId, afterRecheckRecordId: secondRecheckId,
      } });
      assert.ok(!recheckCompare.isError, JSON.stringify(recheckCompare));
      const recheckCompareResult = (recheckCompare.structuredContent as { result: { sameRigIdentityAndTopology: boolean; revisionRecipe: { changed: boolean }; interpretationVerified: boolean } }).result;
      assert.equal(recheckCompareResult.sameRigIdentityAndTopology, true);
      assert.equal(recheckCompareResult.revisionRecipe.changed, true);
      assert.equal(recheckCompareResult.interpretationVerified, false);
      sampledCandidateCount = 0;
      clearInterval(samplePoller);
      samplePoller = undefined;
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'changed-visual-bakeoff-rig-v1' } });
      const topologyMismatch = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck', arguments: {
        historyRecordId: report.historyRecordId, candidateLabel: 'Direct', revisedRecipe: animationPreset('slash', 'Candidate B revision', 1, 1),
        sessionId, rigId,
      } });
      assert.equal(topologyMismatch.isError, true);
      assert.match(JSON.stringify(topologyMismatch), /rig topology differs from the persisted visual bake-off baseline/i);
      assert.equal(sampledCandidateCount, 0, 'a topology mismatch must fail before sampling either animation');
      const afterMismatchList = await client.callTool({ name: 'motion_studio_visual_bakeoff_candidate_recheck_history', arguments: { historyRecordId: report.historyRecordId } });
      assert.equal((afterMismatchList.structuredContent as { result: { total: number } }).result.total, 2,
        'a rejected rig-topology recheck must not create a history record');
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      chunkPoller = setInterval(() => {
        queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
        const chunkCommand = queue.poll(sessionId);
        if (!chunkCommand || chunkCommand.operation !== 'capture_chunk') return;
        const chunkPayload = chunkCommand.payload as { captureId: string; index: number };
        queue.complete(sessionId, chunkCommand.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: png.toString('hex') });
      }, 2);
      const stalePatch = await client.callTool({ name: 'motion_animation_candidate_patch_preview', arguments: {
        recipe: recovered.recipe, expectedSourceFingerprint: '0'.repeat(64),
        operations: [{ operation: 'insert_key', joint: recovered.recipe.tracks[0]!.joint, time: 0.125, rotation: [0, 10, 0] }],
      } });
      assert.ok(stalePatch.isError);
      assert.match(JSON.stringify(stalePatch), /content changed/i);
      const wrongCandidate = await client.callTool({ name: 'motion_studio_read_candidate_recipe', arguments: {
        jobId: queuedResult.jobId, candidateFingerprint: '0'.repeat(64),
      } });
      assert.ok(wrongCandidate.isError);
      assert.match(JSON.stringify(wrongCandidate), /not part of this bake-off/i);
      const wrongEvidence = await client.callTool({ name: 'motion_studio_validate_candidate_comparison_review', arguments: {
        ...assessmentInput, assessments: assessmentInput.assessments.map((assessment, index) => index === 0
          ? { ...assessment, evidenceCaptureIds: [comparison.candidates[1]!.frames[0]!.captureId] } : assessment),
      } });
      assert.ok(wrongEvidence.isError);
      assert.match(JSON.stringify(wrongEvidence), /does not belong to candidate/i);
    } finally { clearInterval(chunkPoller); }
    chunkPoller = undefined;

    const partialQueued = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: { sessionId, rigId, candidates, jointMap: {}, frames } });
    assert.ok(!partialQueued.isError, JSON.stringify(partialQueued));
    const partialJobId = (partialQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const partialCommand = queue.poll(sessionId);
    assert.ok(partialCommand);
    const partialPayload = partialCommand.payload as { candidates: { label: string; assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[] };
    const metadata = (candidate: typeof partialPayload.candidates[number], frame: typeof frames[number]) => ({
      captureId: randomUUID(), sessionId, assetId: candidate.assetId, assetFingerprint: candidate.assetFingerprint, rigId, rigSignature,
      time: frame.time, view: frame.view, appliedJointMap: resolvedCaptureJointMap(candidate.recipe, {}), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'fixture partial',
    });
    queue.complete(sessionId, partialCommand.id, true, { sessionId, rigId, complete: false, failedCandidateIndex: 2, failedFrameIndex: 2,
      error: 'Fixture screenshot failed on the second alternative.', note: 'Partial visual comparison.', candidates: [
        { label: partialPayload.candidates[0]!.label, assetId: partialPayload.candidates[0]!.assetId, assetFingerprint: partialPayload.candidates[0]!.assetFingerprint,
          frames: frames.map(frame => metadata(partialPayload.candidates[0]!, frame)) },
        { label: partialPayload.candidates[1]!.label, assetId: partialPayload.candidates[1]!.assetId, assetFingerprint: partialPayload.candidates[1]!.assetFingerprint,
          frames: [metadata(partialPayload.candidates[1]!, frames[0]!)] },
      ] });
    const partialOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: partialJobId } });
    assert.ok(!partialOutcome.isError, JSON.stringify(partialOutcome));
    const partial = (partialOutcome.structuredContent as { result: { result: { complete: boolean; failedCandidateIndex: number; failedFrameIndex: number; candidates: { frames: unknown[] }[]; next: string } } }).result.result;
    assert.equal(partial.complete, false);
    assert.equal(partial.failedCandidateIndex, 2);
    assert.equal(partial.failedFrameIndex, 2);
    assert.deepEqual(partial.candidates.map(candidate => candidate.frames.length), [2, 1]);
    assert.match(partial.next, /must not be treated as a complete A\/B review/i);
    const refusedPartialBundle = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: { jobId: partialJobId } });
    assert.ok(refusedPartialBundle.isError);
    assert.match(JSON.stringify(refusedPartialBundle), /comparison is incomplete/i);
    let failFirstImageChunk = true;
    chunkPoller = setInterval(() => {
      queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
      const chunkCommand = queue.poll(sessionId);
      if (!chunkCommand || chunkCommand.operation !== 'capture_chunk') return;
      const chunkPayload = chunkCommand.payload as { captureId: string; index: number };
      if (failFirstImageChunk) {
        failFirstImageChunk = false;
        queue.complete(sessionId, chunkCommand.id, false, 'Fixture image chunk read failure.');
        return;
      }
      queue.complete(sessionId, chunkCommand.id, true, { captureId: chunkPayload.captureId, index: chunkPayload.index, hex: png.toString('hex') });
    }, 2);
    try {
      const failedImageRead = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: { jobId: partialJobId, includePartial: true } });
      assert.equal(failedImageRead.isError, undefined);
      const failedImageReadResult = (failedImageRead.structuredContent as { result: { status: string; imageCount: number;
        readPlan: { captureId: string }[]; imageReadFailure: { captureId: string; error: string }; next: string } }).result;
      assert.equal(failedImageReadResult.status, 'image_read_failed');
      assert.equal(failedImageReadResult.imageCount, 0);
      assert.equal(failedImageReadResult.readPlan.length, 3);
      assert.equal(failedImageReadResult.imageReadFailure.captureId, failedImageReadResult.readPlan[0]!.captureId);
      assert.match(failedImageReadResult.imageReadFailure.error, /capture chunk failed/i);
      assert.match(failedImageReadResult.next, /Retry the failed captureId individually/i);
      const partialBundle = await client.callTool({ name: 'motion_studio_read_candidate_comparison', arguments: { jobId: partialJobId, includePartial: true } });
      assert.ok(!partialBundle.isError, JSON.stringify(partialBundle));
      const partialBundleResult = (partialBundle.structuredContent as { result: { complete: boolean; imageCount: number;
        failure: { candidateIndex: number; frameIndex: number; error: string };
        coverage: { label: string; expectedFrameCount: number; receivedFrameCount: number; missingFrameCount: number; status: string;
          missingFrames: { time: number; view: string }[] }[] } }).result;
      assert.equal(partialBundleResult.complete, false);
      assert.equal(partialBundleResult.imageCount, 3);
      assert.deepEqual(partialBundleResult.failure, { candidateIndex: 2, frameIndex: 2, error: 'Fixture screenshot failed on the second alternative.' });
      assert.deepEqual(partialBundleResult.coverage.map(item => ({ status: item.status, expected: item.expectedFrameCount,
        received: item.receivedFrameCount, missing: item.missingFrameCount })), [
        { status: 'complete', expected: 2, received: 2, missing: 0 }, { status: 'partial', expected: 2, received: 1, missing: 1 },
      ]);
      assert.deepEqual(partialBundleResult.coverage[1]!.missingFrames, [{ time: 0.5, view: 'front' }]);
    } finally { clearInterval(chunkPoller); }
    chunkPoller = undefined;
      const invalidFailureLocationQueued = await client.callTool({ name: 'motion_studio_capture_candidate_comparison', arguments: { sessionId, rigId, candidates, jointMap: {}, frames } });
      assert.ok(!invalidFailureLocationQueued.isError, JSON.stringify(invalidFailureLocationQueued));
      const invalidFailureLocationJobId = (invalidFailureLocationQueued.structuredContent as { result: { jobId: string } }).result.jobId;
      const invalidFailureLocationCommand = queue.poll(sessionId);
      assert.ok(invalidFailureLocationCommand);
      const invalidFailureLocationPayload = invalidFailureLocationCommand.payload as { candidates: { label: string; assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[] };
      queue.complete(sessionId, invalidFailureLocationCommand.id, true, { sessionId, rigId, complete: false, failedCandidateIndex: 2,
        failedFrameIndex: 3, error: 'Impossible failure after the requested comparison schedule.', note: 'Malformed comparison failure-index fixture.',
        candidates: invalidFailureLocationPayload.candidates.map(candidate => ({ label: candidate.label, assetId: candidate.assetId,
          assetFingerprint: candidate.assetFingerprint, frames: frames.map(frame => ({ captureId: randomUUID(), sessionId,
            assetId: candidate.assetId, assetFingerprint: candidate.assetFingerprint, rigId, rigSignature, time: frame.time, view: frame.view,
            appliedJointMap: resolvedCaptureJointMap(candidate.recipe, {}), byteCount: png.length, chunks: 1, width: 1, height: 1, note: 'malformed failure location' })) })) });
      const invalidFailureLocationOutcome = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: invalidFailureLocationJobId } });
      assert.equal(invalidFailureLocationOutcome.isError, true);
      assert.match(JSON.stringify(invalidFailureLocationOutcome), /outside the requested frame schedule/i);
      const persistedBakeoffAssets = await library.list();
    assert.equal(persistedBakeoffAssets.total, 1, 'Only the explicitly approved exact patch commit should create an asset; visual capture and review stay non-mutating.');
    assert.equal(persistedBakeoffAssets.assets[0]!.id, committedVisualAssetId);
  } finally {
    if (chunkPoller) clearInterval(chunkPoller);
    if (samplePoller) clearInterval(samplePoller);
    await client.close();
    await server.close();
  }
});

test('unsaved candidate capture auto-plans bounded visual moments and binds them to the exact recipe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-candidate-auto-capture-plan-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'candidate-auto-capture-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const recipe: AnimationRecipe = animationSchema.parse({ ...animationPreset('cast', 'Auto-planned candidate', 1.7, 1),
    markers: [{ name: 'Release', time: 1.1, phase: 'main_action' }, ...Array.from({ length: 14 }, (_, index) => ({
      name: `Planned beat ${index + 1}`, time: (index + 1) / 15 * 1.7, phase: 'main_action' as const }))],
    contacts: [{ effector: 'RightHand', kind: 'grip', start: 0.65, end: 0.9 }] });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'candidate-auto-capture-plan-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const capture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, views: ['front', 'side'], maxFrames: 8,
    } });
    assert.ok(!capture.isError, JSON.stringify(capture));
    const queued = (capture.structuredContent as { result: { jobId: string; status: string } }).result;
    assert.equal(queued.status, 'queued');
    const command = queue.poll(sessionId);
    assert.ok(command);
    const payload = command.payload as { recipe: AnimationRecipe; assetId: string; assetFingerprint: string; ephemeralCandidate: boolean;
      frames: { time: number; view: string }[]; capturePlan: { frames: { time: number; view: string }[];
        moments: { time: number; reasons: string[] }[]; omittedMomentSummary: { omittedMomentCount: number; samples: { time: number; reasons: string[] }[] }; limitation: string } };
    assert.equal(payload.assetFingerprint, fingerprint(recipe));
    assert.equal(payload.ephemeralCandidate, true);
    assert.deepEqual(payload.recipe, recipe);
    assert.equal(payload.frames.length, 8);
    assert.deepEqual(payload.frames, payload.capturePlan.frames);
    assert.ok(payload.capturePlan.moments.some(moment => moment.reasons.some(reason => reason.startsWith('contact_'))));
    assert.ok([...payload.capturePlan.moments, ...payload.capturePlan.omittedMomentSummary.samples]
      .some(moment => moment.reasons.some(reason => reason.startsWith('authored_marker:'))),
    'at least one authored marker must be selected or explicitly disclosed as omitted');
    assert.ok(payload.capturePlan.omittedMomentSummary.omittedMomentCount > 0);
    assert.match(payload.capturePlan.limitation, /does not know camera framing/i);
    assert.equal((await library.list()).assets.length, 0, 'automatic planning and capture queueing must not save the candidate');

    const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    queue.complete(sessionId, command.id, true, { assetId: payload.assetId, rigId, sessionId, complete: true, note: 'auto-plan screenshot fixture',
      frames: payload.frames.map((frame, index) => ({ captureId: randomUUID(), sessionId, assetId: payload.assetId, assetFingerprint: payload.assetFingerprint,
        rigId, rigSignature, ...frame, appliedJointMap: resolvedCaptureJointMap(recipe, {}), byteCount: screenshot.length, chunks: 1,
        width: 1, height: 1, note: `frame ${index + 1}` })) });
    const capturedJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: queued.jobId } });
    assert.ok(!capturedJob.isError, JSON.stringify(capturedJob));
    const capturedResult = (capturedJob.structuredContent as { result: { result: { frames: { captureId: string }[]; capturePlan: { omittedMomentSummary: { omittedMomentCount: number } } } } }).result.result;
    assert.equal(capturedResult.capturePlan.omittedMomentSummary.omittedMomentCount, payload.capturePlan.omittedMomentSummary.omittedMomentCount);
    const chunkPoller = setInterval(() => {
      const chunk = queue.poll(sessionId);
      if (!chunk || chunk.operation !== 'capture_chunk') return;
      const requested = chunk.payload as { captureId: string; index: number };
      queue.complete(sessionId, chunk.id, true, { captureId: requested.captureId, index: requested.index, hex: screenshot.toString('hex') });
    }, 2);
    try {
      const imageRead = await client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: {
        sessionId, captureIds: capturedResult.frames.map(frame => frame.captureId),
      } });
      assert.ok(!imageRead.isError, JSON.stringify(imageRead));
      const readResult = (imageRead.structuredContent as { result: { sequenceGroups: { view: string; focusJoint?: string;
        frames: { time: number }[]; plannedMomentOmissions?: { time: number; view: string; reasons: string[] }[];
        recaptureSuggestions?: { time: number; view: string }[] }[] } }).result;
      const wholeRigGroups = readResult.sequenceGroups.filter(group => !group.focusJoint);
      assert.ok(wholeRigGroups.some(group => group.plannedMomentOmissions?.some(moment => moment.reasons.some(reason => reason.startsWith('authored_marker:')))),
        'the AI image-read should retain omitted authored action beats from the exact auto-generated capture plan');
      for (const group of wholeRigGroups) {
        for (const omission of group.plannedMomentOmissions ?? []) {
          assert.ok(!group.frames.some(frame => frame.time === omission.time), 'reported omitted times must not already appear in this view');
          assert.ok(group.recaptureSuggestions?.some(suggestion => suggestion.time === omission.time && suggestion.view === group.view));
        }
      }
    } finally { clearInterval(chunkPoller); }

    const mismatchedFingerprint = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe, expectedFingerprint: '0'.repeat(64), views: ['side'], maxFrames: 2,
    } });
    assert.equal(mismatchedFingerprint.isError, true);
    assert.match(JSON.stringify(mismatchedFingerprint), /differs from the planned expectedFingerprint/i);
    assert.equal(queue.poll(sessionId), null, 'stale expected fingerprints must fail before another capture is queued');
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('declared-contact IK preview derives one coordinated solve without mutating the saved animation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-contact-ik-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID();
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'contact-rig-v1' } });
  const animation = await library.save({ kind: 'animation', name: 'Two-foot hold', duration: 2, loop: false, tracks: [
    { joint: 'LeftFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'RightFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ], markers: [], contacts: [
    { effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 },
    { effector: 'RightFoot', kind: 'support', start: 0.5, end: 1.5 },
  ] });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'contact-ik-preview-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_studio_ik_declared_contacts_preview', arguments: {
      sessionId, rigId, assetId: animation.id, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 30,
    } });
    assert.ok(!result.isError, JSON.stringify(result));
    const response = result.structuredContent as { result: { jobId: string; status: string; applyRequest: { assetId: string; startTime: number; endTime: number; constraints: { limb: string }[] } } };
    assert.equal(response.result.status, 'queued');
    assert.deepEqual(response.result.applyRequest.constraints.map(constraint => constraint.limb), ['LeftFoot', 'RightFoot']);
    const job = queue.get(response.result.jobId);
    assert.equal(job.operation, 'ik_constraints_preview');
    const payload = job.payload as { startTime: number; endTime: number; sampleRateHz: number; constraints: { limb: string; offset: number[]; targetPath?: unknown }[] };
    assert.equal(payload.startTime, 0.5);
    assert.equal(payload.endTime, 1.5);
    assert.equal(payload.sampleRateHz, 30);
    assert.deepEqual(payload.constraints.map(constraint => constraint.limb), ['LeftFoot', 'RightFoot']);
    assert.equal(response.result.applyRequest.assetId, animation.id);
    assert.equal(response.result.applyRequest.startTime, payload.startTime);
    assert.equal(response.result.applyRequest.endTime, payload.endTime);
    assert.ok(payload.constraints.every(constraint => constraint.offset.every(value => value === 0) && !constraint.targetPath));
    const after = await library.get(animation.id);
    assert.equal(after.recipe.kind, 'animation');
    if (after.recipe.kind === 'animation' && animation.recipe.kind === 'animation') assert.deepEqual(after.recipe.contacts, animation.recipe.contacts, 'preview preparation must not rewrite the source asset');

    const mismatch = await library.save({ kind: 'animation', name: 'Mismatched contacts', duration: 2, loop: false, markers: [], tracks: animation.recipe.kind === 'animation' ? animation.recipe.tracks : [], contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 },
      { effector: 'RightFoot', kind: 'support', start: 0.75, end: 1.5 },
    ] });
    const rejected = await client.callTool({ name: 'motion_studio_ik_declared_contacts_preview', arguments: {
      sessionId, rigId, assetId: mismatch.id, effectors: ['LeftFoot', 'RightFoot'],
    } });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /share the same start and end times/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('whole-clip contact-bake preview schedules alternating windows and fingerprint-guards Studio apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-contact-bake-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'contact-bake-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const asset = await library.save({ kind: 'animation', name: 'Alternating contact walk', duration: 2, loop: false, markers: [], tracks: [
    { joint: 'LeftFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 0.5, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'RightFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ], contacts: [
    { effector: 'LeftFoot', kind: 'support', start: 0.1, end: 0.7 },
    { effector: 'RightFoot', kind: 'support', start: 0.7, end: 1.3 },
    { effector: 'LeftFoot', kind: 'support', start: 1.3, end: 1.9 },
  ] });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'contact-bake-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const preview = await client.callTool({ name: 'motion_studio_ik_contact_bake_preview', arguments: {
      sessionId, rigId, assetId: asset.id, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 15,
    } });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const previewJobId = (preview.structuredContent as { result: { jobId: string } }).result.jobId;
    const previewJob = queue.get(previewJobId);
    assert.equal(previewJob.operation, 'ik_contact_bake_preview');
    assert.equal(queue.poll(sessionId)?.id, previewJobId, 'deliver the preview command to the simulated Studio client');
    const payload = previewJob.payload as {
      effectors: string[]; sampleRateHz: number; toleranceStuds: number; rigSignature: string;
      expectedWindows: { contactIndex: number; effector: string; kind: string; startTime: number; endTime: number }[];
      expectedSamples: { time: number; windowIndices: number[] }[]; recipe: AnimationRecipe;
    };
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.expectedWindows.map(window => window.contactIndex), [0, 1, 2]);
    assert.ok(payload.expectedSamples.some(sample => sample.windowIndices.length === 2), 'abutting opposite-foot contacts must be coordinated at their shared boundary');
    assert.ok(payload.expectedSamples.some(sample => sample.time === 0.5 && sample.windowIndices.includes(0)), 'authored breakdown time inside a support interval must be sampled');
    assert.equal((await library.get(asset.id)).recipe.kind, 'animation', 'preview preparation never changes the saved library asset');

    const windows = payload.expectedWindows.map(window => {
      const samples = payload.expectedSamples.filter(sample => sample.windowIndices.includes(window.contactIndex)).map(sample => ({ time: sample.time, residual: 0.01 }));
      assert.ok(samples.length > 1);
      return { contactIndex: window.contactIndex, effector: window.effector, kind: window.kind, startTime: window.startTime, endTime: window.endTime,
        targetWorldPosition: [0, 0, 0], couplingMode: 'shared_joint_alternating_ccd', sharedJoints: ['HumanoidRootPart'],
        solve: { status: 'converged', toleranceStuds: payload.toleranceStuds, sampleCount: samples.length, samplesWithinTolerance: samples.length,
          withinToleranceRatio: 1, maximumResidualStuds: 0.01, rmsResidualStuds: 0.01, unmetSampleTimes: [], limitation: 'Mock Studio evidence.' }, samples };
    });
    queue.complete(sessionId, previewJobId, true, { assetId: asset.id, parentId: asset.id, rigId, sampleCount: payload.expectedSamples.length,
      windows, recipe: asset.recipe, previewOnly: true });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: previewJobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const completedResult = (completed.structuredContent as { result: { result: { candidateFingerprint: string; candidateExpiresInSeconds: number; windows: unknown[] } } }).result.result;
    assert.match(completedResult.candidateFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(completedResult.candidateExpiresInSeconds, 300);
    assert.equal(completedResult.windows.length, 3);

    const mistimedPreview = await client.callTool({ name: 'motion_studio_ik_contact_bake_preview', arguments: {
      sessionId, rigId, assetId: asset.id, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 15,
    } });
    assert.ok(!mistimedPreview.isError, JSON.stringify(mistimedPreview));
    const mistimedJobId = (mistimedPreview.structuredContent as { result: { jobId: string } }).result.jobId;
    const mistimedJob = queue.get(mistimedJobId);
    assert.equal(queue.poll(sessionId)?.id, mistimedJobId);
    const mistimedPayload = mistimedJob.payload as {
      expectedWindows: typeof payload.expectedWindows; expectedSamples: typeof payload.expectedSamples;
      recipe: AnimationRecipe; rigSignature: string; toleranceStuds: number;
    };
    const mistimedWindows = mistimedPayload.expectedWindows.map(window => {
      const samples = mistimedPayload.expectedSamples.filter(sample => sample.windowIndices.includes(window.contactIndex))
        .map((sample, index) => ({ time: sample.time + (index === 1 ? 0.00005 : 0), residual: 0.01 }));
      return { contactIndex: window.contactIndex, effector: window.effector, kind: window.kind, startTime: window.startTime, endTime: window.endTime,
        targetWorldPosition: [0, 0, 0], couplingMode: 'independent_ccd', sharedJoints: [],
        solve: { status: 'converged', toleranceStuds: mistimedPayload.toleranceStuds, sampleCount: samples.length, samplesWithinTolerance: samples.length,
          withinToleranceRatio: 1, maximumResidualStuds: 0.01, rmsResidualStuds: 0.01, unmetSampleTimes: [], limitation: 'Mock Studio evidence.' }, samples };
    });
    queue.complete(sessionId, mistimedJobId, true, { assetId: asset.id, parentId: asset.id, rigId, sampleCount: mistimedPayload.expectedSamples.length,
      windows: mistimedWindows, recipe: mistimedPayload.recipe, previewOnly: true });
    const rejectedMistimed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: mistimedJobId } });
    assert.equal(rejectedMistimed.isError, true, 'The MCP boundary must reject even a 50-microsecond schedule mismatch');
    assert.match(JSON.stringify(rejectedMistimed), /incomplete or reordered residual samples/i);

    const changedRequest = await client.callTool({ name: 'motion_studio_ik_contact_bake_apply', arguments: {
      sessionId, rigId, assetId: asset.id, effectors: ['RightFoot', 'LeftFoot'], sampleRateHz: 15,
      expectedCandidateFingerprint: completedResult.candidateFingerprint,
    } });
    assert.equal(changedRequest.isError, true);
    assert.match(JSON.stringify(changedRequest), /changed since preview/i);

    const apply = await client.callTool({ name: 'motion_studio_ik_contact_bake_apply', arguments: {
      sessionId, rigId, assetId: asset.id, effectors: payload.effectors, sampleRateHz: payload.sampleRateHz,
      expectedCandidateFingerprint: completedResult.candidateFingerprint,
    } });
    assert.ok(!apply.isError, JSON.stringify(apply));
    const applyJobId = (apply.structuredContent as { result: { jobId: string } }).result.jobId;
    const applyJob = queue.get(applyJobId);
    assert.equal(applyJob.operation, 'ik_contact_bake_apply');
    const applyPayload = applyJob.payload as { expectedCandidateRecipe: unknown; expectedCandidateSolves: unknown[]; expectedCandidateFingerprint: string; expectedWindows: unknown[] };
    assert.deepEqual(applyPayload.expectedCandidateRecipe, asset.recipe);
    assert.deepEqual(applyPayload.expectedCandidateSolves, windows);
    assert.equal(applyPayload.expectedCandidateFingerprint, completedResult.candidateFingerprint);
    assert.deepEqual(applyPayload.expectedWindows, payload.expectedWindows);
  } finally {
    await client.close();
    await server.close();
  }
});

test('whole-clip contact bake accepts an unsaved rig-bound recipe and applies only its exact fingerprinted candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-unsaved-contact-bake-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'unsaved-contact-bake-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const profile = { version: 1, rigId, rigName: 'Unsaved Contact Fixture', rigType: 'R15', rigSignature, joints: [
    { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
    { name: 'LeftFoot', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 },
    { name: 'RightFoot', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 },
  ] };
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: profile });
  const source: AnimationRecipe = { kind: 'animation', name: 'Unsaved blueprint walk', duration: 1, loop: false, markers: [], tracks: [
    { joint: 'LeftFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'RightFoot', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ], contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.1, end: 0.6 }, { effector: 'RightFoot', kind: 'support', start: 0.6, end: 0.9 }] };
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'unsaved-contact-bake-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const preview = await client.callTool({ name: 'motion_studio_ik_contact_bake_preview', arguments: {
      sessionId, rigId, recipe: source, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 15,
    } });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const previewResult = (preview.structuredContent as { result: { jobId: string; applyRequest: Record<string, unknown> } }).result;
    assert.deepEqual(previewResult.applyRequest, { sessionId, rigId, recipe: source, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 15, toleranceStuds: 0.05 });
    const previewJob = queue.get(previewResult.jobId);
    assert.equal(previewJob.operation, 'ik_contact_bake_preview');
    assert.equal(queue.poll(sessionId)?.id, previewResult.jobId, 'deliver the unsaved recipe bake command to Studio');
    const payload = previewJob.payload as { assetId: string; ephemeralRecipe: boolean; sourceRigProfile: { rigSignature: string };
      rigSignature: string; requestFingerprint: string; expectedWindows: { contactIndex: number; effector: string; kind: string; startTime: number; endTime: number }[];
      expectedSamples: { time: number; windowIndices: number[] }[]; recipe: AnimationRecipe; toleranceStuds: number };
    assert.equal(payload.assetId, fingerprintUuid(fingerprint(payload.recipe)));
    assert.equal(payload.ephemeralRecipe, true);
    assert.equal(payload.rigSignature, rigSignature);
    assert.equal(payload.sourceRigProfile.rigSignature, rigSignature);
    assert.equal(payload.recipe.name, source.name);
    assert.ok(payload.requestFingerprint.length === 64);
    const windows = payload.expectedWindows.map(window => {
      const samples = payload.expectedSamples.filter(sample => sample.windowIndices.includes(window.contactIndex)).map(sample => ({ time: sample.time, residual: 0.01 }));
      return { contactIndex: window.contactIndex, effector: window.effector, kind: window.kind, startTime: window.startTime, endTime: window.endTime,
        targetWorldPosition: [0, 0, 0], couplingMode: 'independent_ccd', sharedJoints: [],
        solve: { status: 'converged', toleranceStuds: payload.toleranceStuds, sampleCount: samples.length, samplesWithinTolerance: samples.length,
          withinToleranceRatio: 1, maximumResidualStuds: 0.01, rmsResidualStuds: 0.01, unmetSampleTimes: [], limitation: 'Mock Studio evidence.' }, samples };
    });
    queue.complete(sessionId, previewResult.jobId, true, { assetId: payload.assetId, parentId: payload.assetId, rigId, sampleCount: payload.expectedSamples.length,
      windows, recipe: source, previewOnly: true });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: previewResult.jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const candidate = (completed.structuredContent as { result: { result: { candidateFingerprint: string } } }).result.result;
    assert.match(candidate.candidateFingerprint, /^[0-9a-f]{64}$/);
    assert.equal((await library.list()).total, 0, 'unsaved preview must not create a library asset');
    const changed = await client.callTool({ name: 'motion_studio_ik_contact_bake_apply', arguments: {
      ...previewResult.applyRequest, recipe: { ...source, name: 'Changed after preview' }, expectedCandidateFingerprint: candidate.candidateFingerprint,
    } });
    assert.equal(changed.isError, true);
    assert.match(JSON.stringify(changed), /identity is invalid|changed since preview/i);
    const applied = await client.callTool({ name: 'motion_studio_ik_contact_bake_apply', arguments: {
      ...previewResult.applyRequest, expectedCandidateFingerprint: candidate.candidateFingerprint,
    } });
    assert.ok(!applied.isError, JSON.stringify(applied));
    const applyJobId = (applied.structuredContent as { result: { jobId: string } }).result.jobId;
    const applyPayload = queue.get(applyJobId).payload as { assetId: string; recipe: AnimationRecipe; ephemeralRecipe: boolean;
      expectedCandidateRecipe: AnimationRecipe; expectedCandidateFingerprint: string };
    assert.equal(applyPayload.assetId, payload.assetId);
    assert.equal(applyPayload.ephemeralRecipe, true);
    assert.deepEqual(applyPayload.recipe, source);
    assert.deepEqual(applyPayload.expectedCandidateRecipe, source);
    assert.equal(applyPayload.expectedCandidateFingerprint, candidate.candidateFingerprint);
    assert.equal((await library.list()).total, 0, 'apply only updates the Studio draft, never the library');
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retarget plus contact-bake previews one ephemeral target-rig candidate and applies only its exact recipe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-retarget-contact-bake-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), sourceRigId = randomUUID();
  const rigSignature = 'retarget-contact-target-v1';
  const profile = (id: string, name: string, signature: string) => ({ version: 1 as const, rigId: id, rigName: name,
    rigType: 'R15' as const, rigSignature: signature, joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'LeftFoot', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
      { name: 'RightFoot', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
    ] });
  const sourceProfile = { ...profile(sourceRigId, 'Source R15', 'retarget-contact-source-v1'),
    joints: profile(sourceRigId, 'Source R15', 'retarget-contact-source-v1').joints.map(joint => ({
      ...joint, name: joint.name === 'LeftFoot' ? 'LeftSole' : joint.name === 'RightFoot' ? 'RightSole' : joint.name,
    })) };
  const targetProfile = profile(rigId, 'Target R15', rigSignature);
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: targetProfile });
  const source = await library.save({ kind: 'animation', name: 'Source contact walk', duration: 1, loop: false, markers: [], tracks: [
    { joint: 'LeftSole', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'RightSole', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ], contacts: [
    { effector: 'LeftSole', kind: 'support', start: 0.1, end: 0.55 },
    { effector: 'RightSole', kind: 'support', start: 0.55, end: 0.9 },
  ] }, undefined, sourceProfile);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'retarget-contact-bake-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const beforeCount = (await library.list()).total;
    const request = { assetId: source.id, sessionId, rigId, effectors: ['LeftFoot', 'RightFoot'], sampleRateHz: 15,
      jointMap: { LeftSole: 'LeftFoot', RightSole: 'RightFoot' } };
    const preview = await client.callTool({ name: 'motion_animation_retarget_contact_bake_preview', arguments: request });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const jobId = (preview.structuredContent as { result: { jobId: string } }).result.jobId;
    const job = queue.get(jobId);
    assert.equal(job.operation, 'ik_retarget_contact_bake_preview');
    assert.equal(queue.poll(sessionId)?.id, jobId);
    const payload = job.payload as { assetId: string; candidateId: string; parentAssetId: string; candidateRecipeFingerprint: string;
      rigSignature: string; retargetFingerprint: string; recipe: AnimationRecipe; expectedWindows: { contactIndex: number; effector: string }[];
      expectedSamples: { time: number; windowIndices: number[] }[] };
    assert.equal(payload.assetId, source.id);
    assert.equal(payload.parentAssetId, source.id);
    assert.notEqual(payload.candidateId, source.id);
    assert.equal(payload.candidateRecipeFingerprint, fingerprint(payload.recipe));
    assert.deepEqual(payload.recipe.contacts?.map(contact => contact.effector), ['LeftFoot', 'RightFoot'], 'contact effectors must follow the explicit retarget map');
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.expectedWindows.map(window => window.contactIndex), [0, 1]);
    assert.ok(payload.expectedSamples.some(sample => sample.windowIndices.length === 2));
    assert.equal((await library.list()).total, beforeCount, 'combined preview must not persist the retargeted intermediate or bake');

    const windows = payload.expectedWindows.map(window => {
      const samples = payload.expectedSamples.filter(sample => sample.windowIndices.includes(window.contactIndex)).map(sample => ({ time: sample.time, residual: 0.01 }));
      return { contactIndex: window.contactIndex, effector: window.effector, kind: 'support', startTime: samples[0]!.time,
        endTime: samples.at(-1)!.time, targetWorldPosition: [0, 0, 0], couplingMode: 'independent_ccd', sharedJoints: [],
        solve: { status: 'converged', toleranceStuds: 0.05, sampleCount: samples.length, samplesWithinTolerance: samples.length,
          withinToleranceRatio: 1, maximumResidualStuds: 0.01, rmsResidualStuds: 0.01, unmetSampleTimes: [], limitation: 'Mock Studio evidence.' }, samples };
    });
    queue.complete(sessionId, jobId, true, { assetId: source.id, candidateId: payload.candidateId, parentId: source.id, rigId,
      sampleCount: payload.expectedSamples.length, windows, recipe: payload.recipe, previewOnly: true });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const result = (completed.structuredContent as { result: { result: { candidateFingerprint: string; recipeFingerprint: string; next: string } } }).result.result;
    assert.match(result.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.recipeFingerprint, fingerprint(payload.recipe));
    assert.match(result.next, /loaded in the Animation Studio viewport/i);

    const changed = await client.callTool({ name: 'motion_animation_retarget_contact_bake_apply', arguments: { ...request,
      scaleTranslation: false, expectedCandidateFingerprint: result.candidateFingerprint } });
    assert.equal(changed.isError, true);
    const applied = await client.callTool({ name: 'motion_animation_retarget_contact_bake_apply', arguments: { ...request,
      expectedCandidateFingerprint: result.candidateFingerprint } });
    assert.ok(!applied.isError, JSON.stringify(applied));
    const applyJobId = (applied.structuredContent as { result: { jobId: string } }).result.jobId;
    const applyPayload = queue.get(applyJobId).payload as { candidateId: string; parentAssetId: string; expectedCandidateRecipe: AnimationRecipe;
      expectedCandidateSolves: unknown[]; expectedCandidateFingerprint: string; recipe: AnimationRecipe };
    assert.equal(queue.get(applyJobId).operation, 'ik_retarget_contact_bake_apply');
    assert.equal(applyPayload.candidateId, payload.candidateId);
    assert.equal(applyPayload.parentAssetId, source.id);
    assert.deepEqual(applyPayload.expectedCandidateRecipe, payload.recipe);
    assert.deepEqual(applyPayload.recipe, payload.recipe);
    assert.equal(applyPayload.expectedCandidateFingerprint, result.candidateFingerprint);
    assert.equal((await library.list()).total, beforeCount, 'apply modifies only the viewport draft, not the library');
  } finally {
    await client.close();
    await server.close();
  }
});

test('AI review proposals can be evaluated on one live rig and duplicate candidates share sampled evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-review-proposals-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), reviewId = randomUUID();
  const rigSignature = 'proposal-evaluation-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  seedCaptureFocusInspection(queue, sessionId, rigId, rigSignature, ['UpperTorso', 'Head']);
  const detailEvidenceId = randomUUID();
  const mappedEvidenceId = randomUUID();
  const referenceEvidenceId = randomUUID();
  const source = await library.save({ kind: 'animation', name: 'Proposal source', duration: 1, loop: false, markers: [], contacts: [], tracks: [
    { joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'Head', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ] });
  assert.equal(source.recipe.kind, 'animation');
  if (source.recipe.kind !== 'animation') throw new Error('Fixture must be an animation.');
  const operations = [{ operation: 'insert_key' as const, joint: 'UpperTorso', time: 0.5, rotation: [0, 25, 0] as [number, number, number] }];
  const preserve: NonNullable<ReviewRecord['critique']>['proposals'][number]['preserve'] = [];
  const patched = patchAnimation(source.recipe, operations, patchLayerIdFactory(source.id, fingerprint(source.recipe), operations));
  const groupedOperations = [{ operation: 'offset_pose_group' as const, time: 0.5, insertIfMissing: true, targets: [
    { joint: 'UpperTorso', rotationOffset: [0, 10, 0] as [number, number, number] },
    { joint: 'Head', rotationOffset: [0, 5, 0] as [number, number, number] },
  ] }];
  const groupedPatched = patchAnimation(source.recipe, groupedOperations, patchLayerIdFactory(source.id, fingerprint(source.recipe), groupedOperations));
  const evidenceId = randomUUID();
  const screenshots = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
  ].map(encoded => {
    const bytes = Buffer.from(encoded, 'base64');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const [screenshot, detailScreenshot, mappedScreenshot, referenceScreenshot] = screenshots;
  const proposal = (id: string, findingIndex: number, citedImageId: string, grouped = false) => ({ id, findingIndex, title: grouped ? 'Coordinate torso and head' : 'Turn the torso', rationale: 'Preview this evidence-linked change.', evidence: [{ source: 'user_image' as const, id: citedImageId }], risk: 'low' as const,
    operations: grouped ? groupedOperations : operations, preserve, validation: { sourceFingerprint: fingerprint(source.recipe), candidateFingerprint: fingerprint((grouped ? groupedPatched : patched).recipe), changes: (grouped ? groupedPatched : patched).changes } });
  const review: ReviewRecord = {
    id: reviewId, revision: 1, createdAt: new Date().toISOString(), assetId: source.id, assetHash: fingerprint(source.recipe), assetName: 'Proposal source',
    rigSignature, status: 'needs_feedback', request: { assetId: source.id, sessionId, rigId, motionMode: 'unknown', preview: false, aiReview: false },
    report: { source: 'recipe_only', metrics: [], findings: [], questions: [], limitations: [] },
    images: [{ id: evidenceId, sha256: screenshot!.sha256, bytes: screenshot!.bytes.length, view: 'front', time: 0.5, width: 64, height: 64,
      captureBinding: { assetFingerprint: fingerprint(source.recipe), rigId, rigSignature } },
      { id: detailEvidenceId, sha256: detailScreenshot!.sha256, bytes: detailScreenshot!.bytes.length, view: 'detail', time: 0.5, width: 64, height: 64 },
      { id: mappedEvidenceId, sha256: mappedScreenshot!.sha256, bytes: mappedScreenshot!.bytes.length, view: 'front', time: 0.5, width: 64, height: 64,
        captureBinding: { assetFingerprint: fingerprint(source.recipe), rigId, rigSignature, jointMapping: { fingerprint: 'd'.repeat(64), renamedJointCount: 1,
          nameMapApplied: true, renamedJoints: [{ source: 'Torso', target: 'UpperTorso' }], limitation: 'Name-only mapping; local axes are not retargeted.' } } },
      { id: referenceEvidenceId, sha256: referenceScreenshot!.sha256, bytes: referenceScreenshot!.bytes.length, view: 'front', time: 0.75, width: 64, height: 64 }],
    critique: { summary: 'Two equivalent edit options.', findings: [
      { observation: 'The torso appears turned away from the intended facing.', source: 'user_image', evidenceIds: [evidenceId], suggestion: 'Confirm the desired facing before adjusting the torso.' },
      { observation: 'The joint is tightly framed in the detail image.', source: 'user_image', evidenceIds: [detailEvidenceId], suggestion: 'Check this close-up manually.' },
      { observation: 'The torso is name-mapped from a different source naming scheme.', source: 'user_image', evidenceIds: [mappedEvidenceId], suggestion: 'Preserve the same name map before comparing screenshots.' },
      { observation: 'The target reference shows the desired torso turn.', source: 'user_image', evidenceIds: [referenceEvidenceId], suggestion: 'Compare the candidate against this user-provided target reference.' }],
      visualObservations: [{ imageId: evidenceId, assessment: 'observed', visibleEvidence: 'The torso appears turned away from the intended facing.', limitation: 'This still cannot show the transition or confirm intended direction.' },
        { imageId: detailEvidenceId, assessment: 'observed', visibleEvidence: 'A joint is tightly framed.', limitation: 'This manual detail camera is not reproduced by the standard multi-view capture API.' },
        { imageId: mappedEvidenceId, assessment: 'observed', visibleEvidence: 'The torso appears under a name-only joint map.', limitation: 'This still does not establish equivalent local axes or semantic mapping.' },
        { imageId: referenceEvidenceId, assessment: 'observed', visibleEvidence: 'The target reference shows a torso turn.', limitation: 'This user-provided image is not bound to the reviewed source recipe.' }],
      proposals: [proposal('turn-a', 0, evidenceId), proposal('turn-b', 1, detailEvidenceId), proposal('turn-c', 2, mappedEvidenceId, true)],
      questions: [], provider: 'deepseek', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, source: 'images' },
  };
  const reviewDirectory = join(root, 'artifacts', 'reviews');
  await mkdir(join(reviewDirectory, reviewId), { recursive: true });
  await writeFile(join(reviewDirectory, reviewId, '000001.json'), JSON.stringify(review));
  for (const [imageId, image] of [[evidenceId, screenshot!], [detailEvidenceId, detailScreenshot!],
    [mappedEvidenceId, mappedScreenshot!], [referenceEvidenceId, referenceScreenshot!]] as const) {
    await writeFile(join(reviewDirectory, reviewId, `${imageId}.png`), image.bytes);
  }
  const reviews = new Reviews(reviewDirectory, library, queue, new Connections(join(root, '.local', 'providers.json')));
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  const client = new Client({ name: 'review-proposal-evaluation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sampled: Array<{ assetId: string; recipe: AnimationRecipe }> = [];
  let reviewRevisionToChangeDuringNextSample: string | undefined;
  let omitOrientationForNextSamples = 0;
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { assetId: string; rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    sampled.push({ assetId: payload.assetId, recipe: payload.recipe });
    const omitOrientation = omitOrientationForNextSamples > 0;
    if (omitOrientation) omitOrientationForNextSamples--;
    if (reviewRevisionToChangeDuringNextSample) {
      const changedReviewId = reviewRevisionToChangeDuringNextSample;
      reviewRevisionToChangeDuringNextSample = undefined;
      const changedReview = { ...review, id: changedReviewId, revision: 2, createdAt: new Date().toISOString() };
      writeFileSync(join(reviewDirectory, changedReviewId, '000002.json'), JSON.stringify(changedReview));
    }
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'proposal fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperTorso', parent: 1, driven: true, foot: false }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [!omitOrientation && payload.recipe.tracks.find(track => track.joint === 'UpperTorso')?.keys.some(key => key.time === 0.5 && key.rotation[1] !== 0) ? 0.1 : 0, 2, 0]],
        bottoms: [0, 0], ...(!omitOrientation ? { orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] } : {}) })) });
  }, 10);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = await library.list(0, 20, 'animation');
    const proposalPreview = await client.callTool({ name: 'motion_review_proposal_preview', arguments: { reviewId, revision: 1, proposalId: 'turn-a' } });
    assert.ok(!proposalPreview.isError, JSON.stringify(proposalPreview));
    const preview = (proposalPreview.structuredContent as { result: { preserve: { joint: string; startTime?: number; endTime?: number }[] } }).result;
    assert.deepEqual(preview.preserve, preserve);
    const invalidReviewId = randomUUID();
    const invalidReview: ReviewRecord = { ...review, id: invalidReviewId, critique: { ...review.critique!, proposals: [
      { ...proposal('unguarded-turn', 0, evidenceId), preserve: [{ joint: 'UpperTorso', scope: 'composed', startTime: 0, endTime: 1,
        sampleRateHz: 120, positionTolerance: 0.001, rotationToleranceDegrees: 0.1 }] },
    ] } };
    await mkdir(join(reviewDirectory, invalidReviewId), { recursive: true });
    await writeFile(join(reviewDirectory, invalidReviewId, '000001.json'), JSON.stringify(invalidReview));
    await writeFile(join(reviewDirectory, invalidReviewId, `${evidenceId}.png`), screenshot!.bytes);
    const rejectedPreview = await client.callTool({ name: 'motion_review_proposal_preview', arguments: { reviewId: invalidReviewId, revision: 1, proposalId: 'unguarded-turn' } });
    assert.ok(rejectedPreview.isError, 'a proposal that changes its supposedly protected torso motion must fail closed');
    assert.match(JSON.stringify(rejectedPreview), /preservation contract no longer matches/i);
    const result = await client.callTool({ name: 'motion_review_proposals_evaluate', arguments: { reviewId, revision: 1,
      proposalIds: ['turn-a', 'turn-b', 'turn-c'], sessionId, rigId, acceptance: { duration: { min: 0.5, max: 2 }, loop: false,
        requiredTracks: ['UpperTorso'], maxPeakAngularSpeedDegreesPerSecond: 1000 } } });
    assert.ok(!result.isError, JSON.stringify(result));
    const evaluation = (result.structuredContent as { result: { status: string; results: { proposalId: string; candidateFingerprint: string; comparison: { status: string };
      linkedFinding: { observation: string; evidenceIds: string[] }; citedImageEvidence: { imageId: string; sha256: string; view: string; time: number | null;
        recipeIdentityStatus: string; eligibleForCritique: boolean; authoredContext?: unknown;
        visualAssessment: string | null; assessmentStatus: string; observation: { assessment?: string; visibleEvidence: string; limitation: string } | null }[];
      visualFollowUp: { status: string; sourceImageIds: string[]; recipeMatchedImageIds: string[]; referenceImageIds: string[];
        frames: { time: number; view: string; focusJoint?: string }[]; expectedFingerprint?: string; comparisonInstruction?: string;
        unmatchedImageIds?: string[]; mappingMismatchImageIds?: string[]; reason?: string };
      preservationAudit: { mode: string; sourceFingerprint: string; candidateFingerprint: string; targetJoint: string; targetJoints: string[]; affectedWindow: { startTime: number; endTime: number };
        affectedWindows: { joint: string; startTime: number; endTime: number }[];
        preservedIntervals: unknown[]; otherRecipeData: string };
      acceptance?: { status: string; checks: { id: string; status: string }[] }; identicalToProposalId?: string }[] } }).result;
    assert.equal(evaluation.status, 'sampled');
    assert.equal(evaluation.results.length, 3);
    assert.equal(evaluation.results[0]?.comparison.status, 'available');
    assert.deepEqual(evaluation.results[0]?.preservationAudit, { mode: 'server_derived_single_joint_edit', sourceFingerprint: fingerprint(source.recipe),
      candidateFingerprint: evaluation.results[0]!.candidateFingerprint, targetJoint: 'UpperTorso', targetJoints: ['UpperTorso'],
      affectedWindow: { startTime: 0, endTime: 1 }, affectedWindows: [{ joint: 'UpperTorso', startTime: 0, endTime: 1 }],
      preservedIntervals: [], otherRecipeData: 'exactly_unchanged_except_target_track',
      note: 'The edit spans the target joint’s full affected timeline; the server verified exact structural identity of all other recipe data.' });
    assert.equal(evaluation.results[2]?.preservationAudit.mode, 'server_derived_grouped_pose_edit');
    assert.deepEqual(evaluation.results[2]?.preservationAudit.targetJoints, ['UpperTorso', 'Head']);
    assert.deepEqual(evaluation.results[2]?.preservationAudit.affectedWindows, [
      { joint: 'UpperTorso', startTime: 0, endTime: 1 }, { joint: 'Head', startTime: 0, endTime: 1 },
    ]);
    assert.deepEqual(evaluation.results[0]?.linkedFinding.evidenceIds, [evidenceId]);
    assert.deepEqual(evaluation.results[0]?.citedImageEvidence, [{ imageId: evidenceId, sha256: screenshot!.sha256, view: 'front', time: 0.5,
      recipeIdentityStatus: 'matches_reviewed_recipe', eligibleForCritique: true,
      pixelSignal: null, visualAssessment: 'observed', assessmentStatus: 'assessed', observation: { imageId: evidenceId, assessment: 'observed', visibleEvidence: 'The torso appears turned away from the intended facing.',
        limitation: 'This still cannot show the transition or confirm intended direction.' } }]);
    assert.deepEqual(evaluation.results[0]?.visualFollowUp, { status: 'matched_frames_ready', sourceImageIds: [evidenceId],
      recipeMatchedImageIds: [evidenceId], referenceImageIds: [], frames: [{ time: 0.5, view: 'front' }], expectedFingerprint: evaluation.results[0]!.candidateFingerprint });
    assert.deepEqual(evaluation.results[1]?.visualFollowUp, { status: 'manual_match_required', sourceImageIds: [detailEvidenceId],
      recipeMatchedImageIds: [], referenceImageIds: [detailEvidenceId], frames: [], unmatchedImageIds: [detailEvidenceId], mappingMismatchImageIds: [], reason: 'One or more cited screenshots lack a usable candidate time or use a view that Studio cannot reproduce automatically.' });
    assert.deepEqual(evaluation.results[2]?.visualFollowUp, { status: 'manual_match_required', sourceImageIds: [mappedEvidenceId], frames: [],
      recipeMatchedImageIds: [mappedEvidenceId], referenceImageIds: [], unmatchedImageIds: [mappedEvidenceId], mappingMismatchImageIds: [mappedEvidenceId],
      reason: 'The live evaluation joint map differs from the name-map fingerprint recorded for one or more cited screenshots; do not compare these as the same rig mapping.' });
    assert.equal(evaluation.results[0]?.acceptance?.status, 'passed');
    assert.equal(evaluation.results[0]?.acceptance?.checks.find(check => check.id === 'track:UpperTorso')?.status, 'passed');
    assert.equal(evaluation.results[1]?.identicalToProposalId, 'turn-a');
    assert.equal(evaluation.results[0]?.candidateFingerprint, evaluation.results[1]?.candidateFingerprint);
    assert.equal(sampled.length, 3, 'source, the shared single-joint candidate and grouped candidate are each sampled once');
    assert.equal(sampled[0]?.assetId, source.id);
    assert.deepEqual(sampled[1]?.recipe.tracks[0]?.keys.find(key => key.time === 0.5)?.rotation, [0, 25, 0]);
    assert.deepEqual(sampled[2]?.recipe.tracks.find(track => track.joint === 'UpperTorso')?.keys.find(key => key.time === 0.5)?.rotation, [0, 10, 0]);
    assert.deepEqual(sampled[2]?.recipe.tracks.find(track => track.joint === 'Head')?.keys.find(key => key.time === 0.5)?.rotation, [0, 5, 0]);
    const editorPreview = await client.callTool({ name: 'motion_review_proposal_editor_preview', arguments: { reviewId, revision: 1, proposalId: 'turn-a',
      draftRecipe: source.recipe, expectedDraftFingerprint: fingerprint(source.recipe), loadedSourceFingerprint: fingerprint(source.recipe), sessionId, rigId,
      acceptance: { duration: { min: 0.5, max: 2 }, requiredTracks: ['UpperTorso'] } } });
    assert.ok(!editorPreview.isError, JSON.stringify(editorPreview));
    const editorCandidate = (editorPreview.structuredContent as { result: { candidateFingerprint: string; expectedDraftFingerprint: string; patchPreview: { candidateFingerprint: string };
      studioComparison: { sourceFingerprint: string; candidateFingerprint: string; motion: { status: string } }; structuralAudit: { summary: { tracks: number; keys: number } };
      impactMap: { status: string; coordinateFrame: string; changedPositionJointCount: number;
        editScope: { targetJoint: string; affectedWindow: { startTime: number; endTime: number }; preservedTargetIntervals: unknown[];
          targetPositionChange: { status: string }; targetOrientationChange: { status: string };
          targetTimeline: { positionCoverage: string; positionIntervals: { startProgress: number; endProgress: number; peakProgress: number;
            sourceSampleIds: string[]; candidateSampleIds: string[] }[]; orientationCoverage: string; orientationIntervals: unknown[] };
          nonTargetRecipeData: string; limitation: string };
        position: { joint: string; maximumDisplacementStuds: number; candidateMinusSourceStudsAtPeak: { x: number; y: number; z: number };
          normalizedProgress: number; sourceSampleIds: string[]; candidateSampleIds: string[] }[];
        orientation: { status: string }; limitation: string };
      renderedReviewSuggestion: { status: string; targetJoint: string; sourceDraftFingerprint: string; candidateFingerprint: string;
        expectedLoadedSourceFingerprint?: string; expectedRigSignature: string; jointMap: Record<string, string>; preflightTool: string;
        view: string; viewBasis: string; temporalBasis: string; temporalCoverage: string; focusStatus: string;
        sourceDuration: number; candidateDuration: number; matchedMoments: { normalizedProgress: number; sourceTime: number; candidateTime: number }[];
        frames: { time: number; view: string; focusJoint?: string }[];
        sourceCaptureTool: string; candidateCaptureTool: string; next: string };
      acceptance?: { status: string; checks: { id: string; status: string }[] } } }).result;
    assert.equal(editorCandidate.expectedDraftFingerprint, fingerprint(source.recipe));
    assert.notEqual(editorCandidate.patchPreview.candidateFingerprint, editorCandidate.candidateFingerprint,
      'patchPreview.candidateFingerprint is the binding hash over the candidate and exact patch contract');
    assert.equal(editorCandidate.studioComparison.sourceFingerprint, fingerprint(source.recipe));
    assert.equal(editorCandidate.studioComparison.candidateFingerprint, editorCandidate.candidateFingerprint);
    assert.equal(editorCandidate.studioComparison.motion.status, 'available');
    assert.equal(editorCandidate.structuralAudit.summary.tracks, source.recipe.tracks.length);
    assert.ok(editorCandidate.structuralAudit.summary.keys > 0);
    assert.equal(editorCandidate.acceptance?.status, 'passed');
    assert.equal(editorCandidate.acceptance?.checks.find(check => check.id === 'track:UpperTorso')?.status, 'passed');
    assert.equal(editorCandidate.impactMap.status, 'available');
    assert.equal(editorCandidate.impactMap.coordinateFrame, 'ground_relative_legacy');
    assert.equal(editorCandidate.impactMap.editScope.targetJoint, 'UpperTorso');
    assert.deepEqual(editorCandidate.impactMap.editScope.affectedWindow, { startTime: 0, endTime: 1 });
    assert.equal(editorCandidate.impactMap.editScope.targetPositionChange.status, 'observed', JSON.stringify(editorCandidate.impactMap));
    assert.equal(editorCandidate.impactMap.editScope.targetOrientationChange.status, 'no_change_above_report_threshold');
    assert.equal(editorCandidate.impactMap.editScope.targetTimeline.positionCoverage, 'complete_within_reported_thresholds');
    assert.equal(editorCandidate.impactMap.editScope.targetTimeline.positionIntervals.length, 1);
    assert.equal(editorCandidate.impactMap.editScope.targetTimeline.positionIntervals[0]?.startProgress, 0);
    assert.equal(editorCandidate.impactMap.editScope.targetTimeline.positionIntervals[0]?.endProgress, 1);
    assert.ok(editorCandidate.impactMap.editScope.targetTimeline.positionIntervals[0]?.sourceSampleIds.length);
    assert.equal(editorCandidate.impactMap.editScope.targetTimeline.orientationCoverage, 'complete_within_reported_thresholds');
    assert.deepEqual(editorCandidate.impactMap.editScope.targetTimeline.orientationIntervals, []);
    assert.equal(editorCandidate.impactMap.editScope.nonTargetRecipeData, 'exactly_unchanged_except_target_track');
    assert.match(editorCandidate.impactMap.editScope.limitation, /Descendant\/world-space positions may change/);
    assert.ok(editorCandidate.impactMap.changedPositionJointCount > 0);
    assert.equal(editorCandidate.impactMap.position[0]?.joint, 'UpperTorso');
    assert.equal(editorCandidate.impactMap.position[0]?.maximumDisplacementStuds, 0.1);
    assert.deepEqual(editorCandidate.impactMap.position[0]?.candidateMinusSourceStudsAtPeak, { x: 0.1, y: 0, z: 0 });
    assert.ok(editorCandidate.impactMap.position[0]?.sourceSampleIds.length);
    assert.ok(editorCandidate.impactMap.position[0]?.candidateSampleIds.length);
    assert.equal(editorCandidate.impactMap.orientation.status, 'available');
    assert.match(editorCandidate.impactMap.limitation, /not an artistic verdict/);
    assert.equal(editorCandidate.renderedReviewSuggestion.status, 'ready');
    assert.equal(editorCandidate.renderedReviewSuggestion.targetJoint, 'UpperTorso');
    assert.equal(editorCandidate.renderedReviewSuggestion.sourceDraftFingerprint, fingerprint(source.recipe));
    assert.equal(editorCandidate.renderedReviewSuggestion.candidateFingerprint, editorCandidate.candidateFingerprint);
    assert.equal(editorCandidate.renderedReviewSuggestion.expectedLoadedSourceFingerprint, fingerprint(source.recipe));
    assert.equal(editorCandidate.renderedReviewSuggestion.expectedRigSignature, rigSignature);
    assert.deepEqual(editorCandidate.renderedReviewSuggestion.jointMap, {});
    assert.equal(editorCandidate.renderedReviewSuggestion.preflightTool, 'motion_studio_capture_preflight');
    assert.equal(editorCandidate.renderedReviewSuggestion.viewBasis, 'matched_reviewed_source_capture_view');
    assert.equal(editorCandidate.renderedReviewSuggestion.temporalBasis, 'matched_change_interval');
    assert.equal(editorCandidate.renderedReviewSuggestion.temporalCoverage, 'complete_within_reported_thresholds');
    assert.equal(editorCandidate.renderedReviewSuggestion.sourceDuration, source.recipe.duration);
    assert.equal(editorCandidate.renderedReviewSuggestion.candidateDuration, source.recipe.duration);
    assert.equal(editorCandidate.renderedReviewSuggestion.focusStatus, 'part_backed_target_focus');
    assert.equal(editorCandidate.renderedReviewSuggestion.frames.length, 2);
    assert.ok(editorCandidate.renderedReviewSuggestion.frames.every(frame => frame.view === 'front' && frame.focusJoint === 'UpperTorso'));
    const suggestedTimes = editorCandidate.renderedReviewSuggestion.frames.map(frame => frame.time);
    assert.deepEqual(suggestedTimes, [...suggestedTimes].sort((left, right) => left - right));
    assert.equal(new Set(suggestedTimes).size, suggestedTimes.length);
    assert.ok(suggestedTimes.every(time => time >= 0 && time <= editorCandidate.renderedReviewSuggestion.sourceDuration
      && time <= editorCandidate.renderedReviewSuggestion.candidateDuration));
    assert.deepEqual(editorCandidate.renderedReviewSuggestion.matchedMoments.map(({ normalizedProgress, sourceTime, candidateTime }) => ({ normalizedProgress, sourceTime, candidateTime })),
      suggestedTimes.map(time => ({ normalizedProgress: time / editorCandidate.renderedReviewSuggestion.sourceDuration, sourceTime: time, candidateTime: time })));
    assert.equal(editorCandidate.renderedReviewSuggestion.sourceCaptureTool, 'motion_studio_capture_editor_draft_views');
    assert.equal(editorCandidate.renderedReviewSuggestion.candidateCaptureTool, 'motion_studio_capture_candidate_views');
    assert.match(editorCandidate.renderedReviewSuggestion.next, /screenshot permission/);
    assert.equal(sampled.length, 5, 'proposal evaluation samples source plus two distinct candidates, then editor preview samples its exact draft and candidate');
    assert.deepEqual(sampled[4]?.recipe.tracks[0]?.keys.find(key => key.time === 0.5)?.rotation, [0, 25, 0]);
    const groupedEditorPreview = await client.callTool({ name: 'motion_review_proposal_editor_preview', arguments: { reviewId, revision: 1, proposalId: 'turn-c',
      draftRecipe: source.recipe, expectedDraftFingerprint: fingerprint(source.recipe), loadedSourceFingerprint: fingerprint(source.recipe), sessionId, rigId } });
    assert.ok(!groupedEditorPreview.isError, JSON.stringify(groupedEditorPreview));
    const groupedEditorCandidate = (groupedEditorPreview.structuredContent as { result: {
      impactMap: { editScope: { targetJoints: string[]; targetPositionChanges: { joint: string; status: string }[] } };
      renderedReviewSuggestion: { status: string; targetJoints: string[]; focusStatus: string; frames: { focusJoint?: string }[] } } }).result;
    assert.deepEqual(groupedEditorCandidate.impactMap.editScope.targetJoints, ['UpperTorso', 'Head']);
    assert.deepEqual(groupedEditorCandidate.impactMap.editScope.targetPositionChanges.map(change => change.joint), ['UpperTorso', 'Head']);
    assert.deepEqual(groupedEditorCandidate.renderedReviewSuggestion.targetJoints, ['UpperTorso', 'Head']);
    assert.equal(groupedEditorCandidate.renderedReviewSuggestion.focusStatus, 'whole_rig_group_targets');
    assert.ok(groupedEditorCandidate.renderedReviewSuggestion.frames.every(frame => frame.focusJoint === undefined));
    const referenceViewPreview = await client.callTool({ name: 'motion_review_proposal_editor_preview', arguments: { reviewId, revision: 1,
      proposalId: 'turn-b', draftRecipe: source.recipe, expectedDraftFingerprint: fingerprint(source.recipe),
      loadedSourceFingerprint: fingerprint(source.recipe), sessionId, rigId } });
    assert.ok(!referenceViewPreview.isError, JSON.stringify(referenceViewPreview));
    const referenceViewSuggestion = (referenceViewPreview.structuredContent as { result: { renderedReviewSuggestion: {
      status: string; view: string; viewBasis: string } } }).result.renderedReviewSuggestion;
    assert.equal(referenceViewSuggestion.status, 'ready');
    assert.equal(referenceViewSuggestion.view, 'three_quarter', 'an unbound reference/detail image must not choose or claim the reviewed-source camera view');
    assert.equal(referenceViewSuggestion.viewBasis, 'recommended_three_quarter_default');
    assert.equal(sampled.length, 9, 'each distinct draft preview samples its source and candidate sequentially on the same rig');
    omitOrientationForNextSamples = 2;
    const orientationUnavailablePreview = await client.callTool({ name: 'motion_review_proposal_editor_preview', arguments: { reviewId, revision: 1,
      proposalId: 'turn-c', draftRecipe: source.recipe, expectedDraftFingerprint: fingerprint(source.recipe),
      loadedSourceFingerprint: fingerprint(source.recipe), sessionId, rigId } });
    assert.ok(!orientationUnavailablePreview.isError, JSON.stringify(orientationUnavailablePreview));
    const orientationUnavailableSuggestion = (orientationUnavailablePreview.structuredContent as { result: { renderedReviewSuggestion: {
      status: string; reason: string } } }).result.renderedReviewSuggestion;
    assert.equal(orientationUnavailableSuggestion.status, 'orientation_unavailable');
    assert.match(orientationUnavailableSuggestion.reason, /not evidence that the target pose is unchanged/);
    assert.equal(sampled.length, 11, 'rotation-incomplete comparison still samples source and candidate, but cannot claim no target change');
    const staleDuringSamplingReviewId = randomUUID();
    await mkdir(join(reviewDirectory, staleDuringSamplingReviewId), { recursive: true });
    await writeFile(join(reviewDirectory, staleDuringSamplingReviewId, '000001.json'), JSON.stringify({ ...review, id: staleDuringSamplingReviewId }));
    await writeFile(join(reviewDirectory, staleDuringSamplingReviewId, `${evidenceId}.png`), screenshot!.bytes);
    reviewRevisionToChangeDuringNextSample = staleDuringSamplingReviewId;
    const staleDuringSampling = await client.callTool({ name: 'motion_review_proposal_editor_preview', arguments: { reviewId: staleDuringSamplingReviewId,
      revision: 1, proposalId: 'turn-a', draftRecipe: source.recipe, expectedDraftFingerprint: fingerprint(source.recipe),
      loadedSourceFingerprint: fingerprint(source.recipe), sessionId, rigId } });
    assert.equal(staleDuringSampling.isError, true, 'a review revision change during Studio sampling must invalidate the returned comparison');
    assert.match(JSON.stringify(staleDuringSampling), /review changed while sampling the editor draft/i);
    const referenceReviewId = randomUUID();
    const referenceReview: ReviewRecord = { ...review, id: referenceReviewId, images: [review.images[3]!], critique: { ...review.critique!,
      findings: [review.critique!.findings[3]!], visualObservations: [review.critique!.visualObservations![3]!],
      proposals: [proposal('turn-reference', 0, referenceEvidenceId)] } };
    await mkdir(join(reviewDirectory, referenceReviewId), { recursive: true });
    await writeFile(join(reviewDirectory, referenceReviewId, '000001.json'), JSON.stringify(referenceReview));
    await writeFile(join(reviewDirectory, referenceReviewId, `${referenceEvidenceId}.png`), referenceScreenshot!.bytes);
    const referenceResult = await client.callTool({ name: 'motion_review_proposals_evaluate', arguments: { reviewId: referenceReviewId, revision: 1,
      proposalIds: ['turn-reference'], sessionId, rigId } });
    assert.ok(!referenceResult.isError, JSON.stringify(referenceResult));
    const referenceEvaluation = (referenceResult.structuredContent as { result: { results: { visualFollowUp: typeof evaluation.results[number]['visualFollowUp'] }[] } }).result;
    assert.equal(referenceEvaluation.results[0]?.visualFollowUp.status, 'reference_only');
    assert.deepEqual(referenceEvaluation.results[0]?.visualFollowUp.recipeMatchedImageIds, []);
    assert.deepEqual(referenceEvaluation.results[0]?.visualFollowUp.referenceImageIds, [referenceEvidenceId]);
    assert.deepEqual(referenceEvaluation.results[0]?.visualFollowUp.frames, [{ time: 0.75, view: 'front' }]);
    assert.match(referenceEvaluation.results[0]?.visualFollowUp.comparisonInstruction ?? '', /not call this a before\/after comparison/i);
    const strict = await client.callTool({ name: 'motion_review_proposals_evaluate', arguments: { reviewId, revision: 1,
      proposalIds: ['turn-a'], sessionId, rigId, acceptance: { maxPeakAngularSpeedDegreesPerSecond: 10 } } });
    assert.ok(!strict.isError, JSON.stringify(strict));
    const strictEvaluation = (strict.structuredContent as { result: { results: { acceptance?: { status: string; checks: { id: string; status: string }[] } }[] } }).result;
    assert.equal(strictEvaluation.results[0]?.acceptance?.status, 'failed');
    assert.equal(strictEvaluation.results[0]?.acceptance?.checks.find(check => check.id === 'max_peak_angular_speed')?.status, 'failed');
    assert.equal((await library.list(0, 20, 'animation')).total, before.total, 'proposal evaluation must not save a child animation');
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('unsaved animation candidates receive live Studio acceptance evidence without entering the library', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-unsaved-candidate-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'unsaved-candidate-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const poseRigProfile = { version: 1, rigId, rigName: 'Unsaved Candidate R15', rigType: 'R15' as const, rigSignature,
    joints: [{ name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'UpperTorso', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 },
      { name: 'RightUpperArm', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 }] };
  const poseRigInspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, poseRigInspection.id);
  queue.complete(sessionId, poseRigInspection.id, true, { id: rigId, retargetProfile: poseRigProfile });
  const candidate: AnimationRecipe = { kind: 'animation', name: 'Unsaved candidate', duration: 1, loop: false, markers: [],
    contacts: [
      { effector: 'RightUpperArm', kind: 'grip', start: 0.25, end: 0.75 },
      { effector: 'UnmappedGrip', kind: 'grip', start: 0.0000004, end: 0.0000005 },
    ], tracks: [
    { joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.5, position: [0, 0, 0], rotation: [0, 90, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] },
    { joint: 'RightUpperArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.5, position: [1, 0, 0], rotation: [0, 45, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] },
  ], rootMotion: { joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 1], rotation: [0, 0, 0] },
  ] } };
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'unsaved-animation-candidate-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sampled: Array<{ assetId: string; recipe: AnimationRecipe }> = [];
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { assetId: string; rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    sampled.push({ assetId: payload.assetId, recipe: payload.recipe });
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'candidate fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperTorso', parent: 1, driven: true, foot: false },
        { name: 'RightUpperArm', parent: 2, driven: true, foot: false }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [0, 2 + time, 0], [0.5 + time, 2, 0]],
        pivotPoints: [[0, 0, 0], [0, 2 + time, 0], [0.5 + time, 2, 0]],
        jointPoints: [[0, 0, 0], [0, 2 + time, 0], [0.5 + time, 2, 0]],
        bottoms: [0, 0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]] })) });
  }, 10);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = await library.list(0, 20, 'animation');
    const staleFingerprintResult = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: candidate, sessionId, rigId, expectedFingerprint: '0'.repeat(64), targetTimes: [0.5] } });
    assert.ok(staleFingerprintResult.isError, 'a stale expected recipe hash must be rejected');
    assert.match(JSON.stringify(staleFingerprintResult), /does not match expectedFingerprint/);
    assert.equal(sampled.length, 0, 'a stale recipe must be rejected before queuing Studio sampling');
    const unboundedPoseRequest = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: candidate, sessionId, rigId, includeTargetPoseEvidence: true } });
    assert.ok(unboundedPoseRequest.isError, 'raw pose evidence requires explicit target times');
    assert.match(JSON.stringify(unboundedPoseRequest), /requires between one and eight targetTimes/);
    assert.equal(sampled.length, 0, 'invalid raw-pose requests must not enqueue Studio work');
    const result = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: { recipe: candidate, sessionId, rigId,
      expectedFingerprint: fingerprint(animationSchema.parse(candidate)),
      acceptance: { duration: { min: 0.8, max: 1.2 }, loop: false, requiredTracks: ['UpperTorso'], maxPeakAngularSpeedDegreesPerSecond: 100 } } });
    assert.ok(!result.isError, JSON.stringify(result));
    const evaluation = (result.structuredContent as { result: { status: string; candidateFingerprint: string; next: string;
      acceptance: { status: string; checks: { id: string; status: string }[] };
      rigCoverage: { rigId: string; rigSignature: string; drivenJointCount: number; authoredJointCount: number; coveredDrivenJointCount: number;
        unresolvedTrackJoints: string[]; rootMotion: { sourceJoint: string; joint: string; keyCount: number; status: string } | null;
        joints: { name: string; active: boolean; channels: { source: string }[] }[] };
      studioSampling: { evidenceSource: string; sampleCount: number; sampleTimes: number[]; durationSeconds: number;
        largestSampleGap: { start: number; end: number; seconds: number }; authoredKeyTimes: { expected: number; sampled: number; unsampled: number };
        markerTimes: { expected: number; sampled: number; unsampled: number }; contactMoments: { expected: number; sampled: number; unsampled: number };
        unsampledMoments: { kind: string; time: number; label?: string }[]; omittedUnsampledMomentCount: number; limitation: string };
      spatialTrajectoryEvidence: { source: string; coordinateFrame: string; trajectories: { joint: string; parent: string | null;
        pointSource: string; orientationFrame: string; sampleCount: number; netDisplacement: number[]; pathLength: number;
        trace: { sampleId: string; time: number; position: number[]; orientation?: number[] }[];
        traceSelection: { strategy: string; peakSpeedIntervalSampleIds: { startSampleId: string; endSampleId: string } | null;
          positionExtremaSampleIds: { axis: string; minimumSampleId: string; maximumSampleId: string }[];
          orientationEvidence: { referenceSampleId: string; maximumDriftSampleId: string; maximumDriftDegrees: number;
            peakAngularSpeedDegreesPerSecond: number | null;
            peakAngularSpeedIntervalSampleIds: { startSampleId: string; endSampleId: string } | null;
            maximumRestDeviation: { sampleId: string; degrees: number } | null } | null } }[];
        unavailable: { requestedJoint: string; status: string }[];
        limitation: string };
      declaredContactEvidence: { contacts: { effector: string; joint?: string; kind: string; startTime: number; endTime: number; status: string;
        sampleCount: number; startBoundary: { requestedTime: number; sampleId: string; sampledTime: number } | null;
        midpointBoundary: { requestedTime: number; sampleId: string; sampledTime: number } | null;
        endBoundary: { requestedTime: number; sampleId: string; sampledTime: number } | null; maximumSampleGapSeconds: number;
        maxDriftFromFirstObservedStuds: number | null; cumulativePathLengthStuds: number | null;
        peakSampledSpeed: { studsPerSecond: number; startTime: number; endTime: number } | null }[]; limitation: string };
      viewportReadiness: { status: string; unresolvedTrackJoints: string[] };
      reviewFocus: { reviewState: { mechanicalCriteria: string; renderedVisualReview: string; librarySave: string; userApprovalForSave: string };
        recipeMotionTargets: { total: number; evidenceSource: string; basis: string; items: { joint: string; signal: string; rankWithinSignal: number; eventTime: number; suggestedNextStep: string;
          measurementProvenance: { sampleRateHz: number; derivativeOrder: number; sampleWindow: { startTime: number; endTime: number };
            crossedBoundaries: { kind: string; leftSegmentStartKeyIndex: number; rightSegmentStartKeyIndex: number }[] } }[] };
        mechanicalChecksNeedingReview: { criteriaProvided: boolean; criteriaStatus: string; criteriaSummary: { total: number; passed: number; failed: number; unknown: number } | null;
          total: number; items: { id: string; status: string }[] } } } }).result;
    assert.equal(evaluation.status, 'sampled');
    assert.match(evaluation.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(evaluation.rigCoverage.rigId, rigId);
    assert.equal(evaluation.rigCoverage.rigSignature, rigSignature);
    assert.equal(evaluation.rigCoverage.drivenJointCount, 2);
    assert.equal(evaluation.rigCoverage.authoredJointCount, 2);
    assert.equal(evaluation.rigCoverage.coveredDrivenJointCount, 2);
    assert.deepEqual(evaluation.rigCoverage.unresolvedTrackJoints, []);
    assert.deepEqual(evaluation.rigCoverage.rootMotion, { sourceJoint: 'UpperTorso', joint: 'UpperTorso', keyCount: 2, status: 'resolved' });
    assert.ok(evaluation.rigCoverage.joints.find(joint => joint.name === 'UpperTorso')?.channels.some(channel => channel.source === 'rootMotion'));
    assert.equal(evaluation.viewportReadiness.status, 'ready');
    assert.deepEqual(evaluation.viewportReadiness.unresolvedTrackJoints, []);
    assert.equal(evaluation.studioSampling.evidenceSource, 'studio_pose_evaluator');
    assert.equal(evaluation.studioSampling.sampleCount, evaluation.studioSampling.sampleTimes.length);
    assert.equal(evaluation.studioSampling.sampleTimes[0], 0);
    assert.equal(evaluation.studioSampling.sampleTimes.at(-1), candidate.duration);
    assert.ok(evaluation.studioSampling.largestSampleGap.seconds > 0);
    assert.equal(evaluation.studioSampling.authoredKeyTimes.expected, 3);
    assert.equal(evaluation.studioSampling.authoredKeyTimes.unsampled, 0);
    assert.equal(evaluation.studioSampling.contactMoments.unsampled, 0,
      'fractional declared contact midpoints must be sampled exactly and not reported as blind spots');
    assert.ok(evaluation.studioSampling.sampleTimes.includes((candidate.contacts![0]!.start + candidate.contacts![0]!.end) / 2));
    assert.match(evaluation.studioSampling.limitation, /not continuous video/i);
    assert.equal(evaluation.spatialTrajectoryEvidence.source, 'studio_pose_evaluator');
    assert.equal(evaluation.spatialTrajectoryEvidence.coordinateFrame, 'rig_pivot_space');
    assert.deepEqual(evaluation.spatialTrajectoryEvidence.trajectories.map(path => path.joint), ['UpperTorso', 'RightUpperArm']);
    const torsoPath = evaluation.spatialTrajectoryEvidence.trajectories[0]!;
    const armPath = evaluation.spatialTrajectoryEvidence.trajectories[1]!;
    assert.equal(armPath.orientationFrame, 'rig_pivot_composed');
    assert.equal(torsoPath.parent, 'HumanoidRootPart');
    assert.equal(torsoPath.pointSource, 'joint_pivot_or_node_pivot');
    assert.deepEqual(torsoPath.netDisplacement, [0, 1, 0]);
    assert.deepEqual(armPath.netDisplacement, [1, 0, 0]);
    assert.equal(armPath.sampleCount, evaluation.studioSampling.sampleCount);
    assert.equal(armPath.trace[0]?.time, 0);
    assert.equal(armPath.trace.at(-1)?.time, candidate.duration);
    assert.match(armPath.traceSelection.strategy, /endpoints_peak_speed_interval_axis_extrema/);
    assert.ok(armPath.traceSelection.peakSpeedIntervalSampleIds);
    assert.equal(armPath.traceSelection.positionExtremaSampleIds.length, 3);
    assert.deepEqual(armPath.traceSelection.orientationEvidence, { referenceSampleId: 's000', maximumDriftSampleId: 's000', maximumDriftDegrees: 0,
      peakAngularSpeedDegreesPerSecond: 0, peakAngularSpeedIntervalSampleIds: { startSampleId: 's000', endSampleId: 's001' },
      maximumRestDeviation: null });
    assert.deepEqual(armPath.trace[0]?.orientation, [0, 0, 0, 1]);
    assert.match(evaluation.spatialTrajectoryEvidence.limitation, /not literal world coordinates.*not continuous paths/i);
    assert.equal(evaluation.declaredContactEvidence.contacts.length, 2);
    const contactPath = evaluation.declaredContactEvidence.contacts.find(contact => contact.effector === 'RightUpperArm')!;
    assert.equal(contactPath.effector, 'RightUpperArm');
    assert.equal(contactPath.joint, 'RightUpperArm');
    assert.equal(contactPath.kind, 'grip');
    assert.equal(contactPath.status, 'sampled_full_window');
    assert.ok(contactPath.sampleCount >= 3, 'contact analysis should preserve all available in-window Studio samples');
    assert.deepEqual([contactPath.startBoundary?.requestedTime, contactPath.midpointBoundary?.requestedTime, contactPath.endBoundary?.requestedTime],
      [candidate.contacts![0]!.start, (candidate.contacts![0]!.start + candidate.contacts![0]!.end) / 2, candidate.contacts![0]!.end]);
    const contactTravel = candidate.contacts![0]!.end - candidate.contacts![0]!.start;
    assert.ok(Math.abs((contactPath.maxDriftFromFirstObservedStuds ?? 0) - contactTravel) < 1e-12);
    assert.ok(Math.abs((contactPath.cumulativePathLengthStuds ?? 0) - contactTravel) < 1e-12);
    assert.ok(Math.abs((contactPath.peakSampledSpeed?.studsPerSecond ?? 0) - 1) < 1e-10);
    assert.match(evaluation.declaredContactEvidence.limitation, /numeric stability does not prove visible or physical contact/i);
    assert.match(evaluation.next, /motion_studio_open_candidate.*motion_studio_capture_preflight.*poll motion_studio_job.*motion_studio_capture_candidate_plan.*motion_studio_capture_candidate_views.*motion_studio_job.*motion_studio_read_candidate_capture/s,
      'single-candidate evaluation should give the exact human and AI-visible review sequence');
    assert.match(evaluation.next, /studioSampling\.unsampledMoments.*manually authored 2–8 frame list.*expectedFingerprint=candidateFingerprint.*explicit user approval/s,
      'the evaluation handoff should route important missed beats to fingerprint-bound targeted captures');
    assert.ok(evaluation.next.includes('If preflight or capture fails or permission is unavailable/not granted, do not claim AI visual review.'),
      'the review handoff must fail closed when preflight or screenshots are unavailable');
    assert.equal(evaluation.acceptance.status, 'failed');
    assert.deepEqual(evaluation.reviewFocus.reviewState, { mechanicalCriteria: 'failed', renderedVisualReview: 'not_performed',
      librarySave: 'not_saved', userApprovalForSave: 'required' });
    assert.equal(evaluation.acceptance.checks.find(check => check.id === 'track:UpperTorso')?.status, 'passed');
    assert.ok(evaluation.reviewFocus.recipeMotionTargets.total > 0);
    assert.equal(evaluation.reviewFocus.recipeMotionTargets.evidenceSource, 'authored_recipe_analysis');
    assert.match(evaluation.reviewFocus.recipeMotionTargets.basis, /not observed from Studio telemetry or rendered images/);
    assert.ok(evaluation.reviewFocus.recipeMotionTargets.items.some(target => target.joint === 'UpperTorso'
      && target.eventTime >= 0 && target.eventTime <= candidate.duration && target.suggestedNextStep.length > 0));
    assert.ok(evaluation.reviewFocus.recipeMotionTargets.items.every(target => target.measurementProvenance.sampleRateHz === 60
      && target.measurementProvenance.derivativeOrder >= 1 && target.measurementProvenance.derivativeOrder <= 3
      && target.measurementProvenance.sampleWindow.startTime <= target.eventTime
      && target.measurementProvenance.sampleWindow.endTime >= target.eventTime));
    assert.equal(evaluation.reviewFocus.recipeMotionTargets.items.length, 8);
    assert.equal(new Set(evaluation.reviewFocus.recipeMotionTargets.items.slice(0, 6).map(target => target.signal)).size, 6,
      'first-pass review targets should cover all six available motion signals');
    assert.ok(evaluation.reviewFocus.recipeMotionTargets.items.slice(0, 6).every(target => target.rankWithinSignal === 1));
    assert.ok(evaluation.reviewFocus.recipeMotionTargets.items.slice(6).every(target => target.rankWithinSignal === 2),
      'remaining review budget should be spent on the second-ranked target per signal');
    assert.ok(evaluation.reviewFocus.mechanicalChecksNeedingReview.items.some(check => check.id === 'max_peak_angular_speed' && check.status === 'failed'));
    assert.equal(evaluation.reviewFocus.mechanicalChecksNeedingReview.criteriaProvided, true);
    assert.equal(evaluation.reviewFocus.mechanicalChecksNeedingReview.criteriaStatus, 'failed');
    assert.equal(evaluation.reviewFocus.mechanicalChecksNeedingReview.criteriaSummary?.failed, 1);
    assert.match(evaluation.next, /Caller-declared mechanical criteria failed \(max_peak_angular_speed\).*same criteria unchanged.*Do not.*weaken the threshold/i);
    const noCriteriaResult = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: { recipe: candidate, sessionId, rigId } });
    assert.ok(!noCriteriaResult.isError, JSON.stringify(noCriteriaResult));
    const noCriteria = (noCriteriaResult.structuredContent as { result: { next: string; rigCoverage: { coveredDrivenJointCount: number }; reviewFocus: { reviewState: { mechanicalCriteria: string; renderedVisualReview: string; librarySave: string; userApprovalForSave: string }; mechanicalChecksNeedingReview:
      { criteriaProvided: boolean; criteriaStatus: string; criteriaSummary: { total: number; passed: number; failed: number; unknown: number } | null; total: number } } } }).result;
    assert.equal(noCriteria.reviewFocus.mechanicalChecksNeedingReview.criteriaProvided, false);
    assert.equal(noCriteria.reviewFocus.mechanicalChecksNeedingReview.criteriaStatus, 'not_requested');
    assert.equal(noCriteria.reviewFocus.mechanicalChecksNeedingReview.criteriaSummary, null);
    assert.equal(noCriteria.reviewFocus.mechanicalChecksNeedingReview.total, 0);
    assert.match(noCriteria.next, /No caller-declared mechanical acceptance criteria.*not a pass or a failure.*no universal quality threshold/i);
    assert.equal(noCriteria.rigCoverage.coveredDrivenJointCount, 2);
    assert.deepEqual(noCriteria.reviewFocus.reviewState, { mechanicalCriteria: 'not_requested', renderedVisualReview: 'not_performed',
      librarySave: 'not_saved', userApprovalForSave: 'required' });
    const passingCriteriaResult = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: candidate, sessionId, rigId, acceptance: { requiredTracks: ['UpperTorso'] } } });
    assert.ok(!passingCriteriaResult.isError, JSON.stringify(passingCriteriaResult));
    const passingCriteria = (passingCriteriaResult.structuredContent as { result: { next: string; acceptance: { status: string } } }).result;
    assert.equal(passingCriteria.acceptance.status, 'passed');
    assert.match(passingCriteria.next, /All caller-declared mechanical criteria passed.*does not establish artistic quality.*Continue with visual review/i);
    const denseRecipe = structuredClone(candidate);
    denseRecipe.tracks[0]!.keys = Array.from({ length: 128 }, (_, index) => ({ time: index / 127,
      position: [0, 0, 0] as [number, number, number], rotation: [0, index % 45, 0] as [number, number, number] }));
    denseRecipe.markers = Array.from({ length: 100 }, (_, index) => ({ name: `Beat ${index + 1}`, time: (index + 0.5) / 100 }));
    denseRecipe.markers[40] = { name: 'Precision target neighbor', time: 0.413 };
    denseRecipe.contacts = Array.from({ length: 16 }, (_, index) => ({ effector: `Effector ${index + 1}`, kind: 'support' as const,
      start: index * 0.04, end: index * 0.04 + 0.02 }));
    const requestedTargetTimes = [0.41305, 0.41307];
    const denseResult = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: { recipe: denseRecipe, sessionId, rigId,
      expectedFingerprint: fingerprint(animationSchema.parse(denseRecipe)), targetTimes: requestedTargetTimes, includeTargetPoseEvidence: true } });
    assert.ok(!denseResult.isError, JSON.stringify(denseResult));
    const denseEvaluation = (denseResult.structuredContent as { result: { studioSampling: {
      sampleCount: number; sampleTimes: number[]; authoredKeyTimes: { expected: number; sampled: number; unsampled: number };
      markerTimes: { expected: number; sampled: number; unsampled: number };
      unsampledMoments: { kind: string; time: number }[]; omittedUnsampledMomentCount: number };
      targetedTimeEvidence: { requestedTime: number; sampledTime: number; sampleId: string }[];
      targetedPoseEvidence: { poseEvidenceIndex: { nodeSlots: { slot: number; name: string; semanticRoles?: { role: string; resolution: string }[] }[];
        semanticRoleIndex?: { rig: { type: string }; roles: { role: string; status: string; joint?: string }[] } };
        samples: { id: string; time: number; points: number[][]; orientations?: number[][] }[]; limitation: string } } }).result;
    const denseSampling = denseEvaluation.studioSampling;
    assert.ok(denseSampling.sampleCount <= 128);
    assert.equal(denseSampling.authoredKeyTimes.expected, 129);
    assert.ok(denseSampling.authoredKeyTimes.unsampled > 0, 'the report must disclose authored key times that exceed the Studio sample budget');
    assert.ok(denseSampling.unsampledMoments.some(moment => moment.kind === 'authored_key'));
    assert.deepEqual(denseEvaluation.targetedTimeEvidence.map(evidence => evidence.requestedTime), requestedTargetTimes);
    assert.deepEqual(denseEvaluation.targetedTimeEvidence.map(evidence => evidence.sampledTime), requestedTargetTimes);
    const targetedPoseSamples = denseEvaluation.targetedPoseEvidence.samples;
    assert.equal(targetedPoseSamples.length, 4);
    assert.equal(targetedPoseSamples[0]!.time, 0);
    assert.deepEqual(targetedPoseSamples.slice(1, -1).map(sample => sample.time), requestedTargetTimes);
    assert.equal(targetedPoseSamples.at(-1)!.time, denseRecipe.duration);
    assert.deepEqual(targetedPoseSamples.slice(1, -1).map(sample => sample.id),
      denseEvaluation.targetedTimeEvidence.map(evidence => evidence.sampleId));
    assert.ok(denseEvaluation.targetedPoseEvidence.poseEvidenceIndex.nodeSlots.some(node => node.name === 'RightUpperArm'));
    assert.equal(denseEvaluation.targetedPoseEvidence.poseEvidenceIndex.semanticRoleIndex?.rig.type, 'R15');
    assert.ok(denseEvaluation.targetedPoseEvidence.poseEvidenceIndex.nodeSlots.find(node => node.name === 'RightUpperArm')?.semanticRoles
      ?.some(role => role.role === 'right_shoulder' && role.resolution === 'exact'));
    assert.match(denseEvaluation.targetedPoseEvidence.limitation, /not a rendered image/);
    const exactSampledMarkerCount = denseRecipe.markers.filter(marker => denseSampling.sampleTimes.some(sampleTime =>
      Math.abs(sampleTime - marker.time) <= Number.EPSILON * Math.max(1, Math.abs(sampleTime), Math.abs(marker.time)) * 4)).length;
    assert.equal(denseSampling.markerTimes.sampled, exactSampledMarkerCount,
      'nearby requested samples must not be reported as exact marker evidence');
    assert.equal(sampled.length, 4, 'base candidate, missing-criteria handoff, passing-criteria handoff, and dense targeted candidate are all sampled');
    assert.equal(sampled[0]?.recipe.name, candidate.name);
    assert.notEqual(sampled[0]?.assetId, '');
    assert.equal((await library.list(0, 20, 'animation')).total, before.total, 'candidate evaluation must not create a library asset');
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('full-recipe AI alternatives are sampled once per distinct fingerprint and compared without saving', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-candidate-set-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'candidate-set-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  const profile: RetargetProfile = { version: 1, rigId, rigName: 'Candidate comparison R15', rigType: 'R15', rigSignature, joints: [
    { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
    { name: 'UpperTorso', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 },
    { name: 'LeftUpperArm', parent: 'UpperTorso', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 },
  ] };
  queue.complete(sessionId, inspection.id, true, { id: rigId, rigSignature, retargetProfile: profile });
  const first: AnimationRecipe = { kind: 'animation', name: 'Baseline', duration: 1, loop: false, markers: [], contacts: [], tracks: [
    { joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { joint: 'LegacyLeftArm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 10, 0] }] },
  ] };
  const second: AnimationRecipe = { ...first, name: 'Alternative', tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 0.5, position: [0, 0, 0], rotation: [0, 25, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }, first.tracks[1]!] };
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'animation-candidate-set-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sampled: string[] = [];
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { assetId: string; rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    sampled.push(payload.assetId);
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'candidate-set fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperTorso', parent: 1, driven: true, foot: false },
        { name: 'LeftUpperArm', parent: 2, driven: true, foot: false }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [0, 2, 0], [0, 2.5, 0]], bottoms: [0, 0, 0],
        orientations: [[0, 0, 0, 1], [0, 0, Math.sin((payload.recipe.tracks[0]!.keys.find(key => key.time === time)?.rotation[1] ?? 0) * Math.PI / 360), Math.cos((payload.recipe.tracks[0]!.keys.find(key => key.time === time)?.rotation[1] ?? 0) * Math.PI / 360)], [0, 0, 0, 1]] })) });
  }, 10);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_animation_candidates_evaluate', arguments: { sessionId, rigId, jointMap: { LegacyLeftArm: 'LeftUpperArm' },
      candidates: [{ id: 'base', recipe: first }, { id: 'alt', recipe: second }, { id: 'base-copy', recipe: first }],
      acceptance: { requiredTracks: ['UpperTorso'] } } });
    assert.ok(!result.isError, JSON.stringify(result));
    const evaluated = (result.structuredContent as { result: { baselineCandidateId: string; next: string; results: { id: string;
      rigCoverage: { drivenJointCount: number; coveredDrivenJointCount: number; rigSignature?: string };
      semanticRoleCoverage?: { rig: { signature: string }; roles: { role: string; state: string; resolution: string }[] };
      studioSampling: { evidenceSource: string; sampleTimes: number[]; authoredKeyTimes: { expected: number; sampled: number; unsampled: number } };
      viewportReadiness: { status: string; unresolvedTrackJoints: string[] };
      acceptance?: { status: string };
      comparisonToFirst?: { status: string }; identicalTo?: string;
      reviewFocus: { reviewState: { renderedVisualReview: string; librarySave: string; userApprovalForSave: string };
        recipeMotionTargets: { total: number; evidenceSource: string }; mechanicalChecksNeedingReview: { total: number; basis: string } } }[] } }).result;
    assert.equal(evaluated.baselineCandidateId, 'base');
    assert.match(evaluated.next, /name-mapped temporary poses.*capture preflight.*motion_studio_capture_candidate_comparison/s,
      'mapped alternatives may be visually compared, but must be labeled as approximate rather than exact viewport candidates');
    assert.match(evaluated.next, /Use only caller-stated success criteria/,
      'visual comparison must not invent success criteria');
    assert.equal(evaluated.results.length, 3);
    assert.ok(evaluated.results.every(item => item.rigCoverage.drivenJointCount === 2 && item.rigCoverage.coveredDrivenJointCount === 2),
      'each alternative receives rig coverage from the exact sampled rig');
    assert.ok(evaluated.results.every(item => item.semanticRoleCoverage?.rig.signature === rigSignature),
      'each alternative receives semantic role context only from the inspected matching rig profile');
    assert.ok(evaluated.results.every(item => item.semanticRoleCoverage?.roles.some(role => role.role === 'torso' && role.state === 'active')),
      'role coverage identifies the body region animated by each alternative without scoring it');
    assert.ok(evaluated.results.every(item => item.semanticRoleCoverage?.roles.some(role => role.role === 'left_shoulder' && role.state === 'active')),
      'semantic role coverage must honor the same explicit joint map as numeric rig coverage');
    assert.equal(evaluated.results[0]?.studioSampling.evidenceSource, 'studio_pose_evaluator');
    assert.equal(evaluated.results[0]?.studioSampling.authoredKeyTimes.unsampled, 0);
    assert.equal(evaluated.results[1]?.studioSampling.authoredKeyTimes.expected, 3);
    assert.equal(evaluated.results[1]?.studioSampling.authoredKeyTimes.unsampled, 0);
    assert.ok(evaluated.results[1]?.studioSampling.sampleTimes.includes(0.5), 'candidate-specific breakdown beats must be covered or disclosed');
    assert.ok(evaluated.results.every(item => item.viewportReadiness.status === 'needs_joint_resolution'
      && item.viewportReadiness.unresolvedTrackJoints.includes('LegacyLeftArm')),
    'the sampling map must not silently rewrite exact-name viewport-readiness checks');
    assert.equal(evaluated.results[1]?.comparisonToFirst?.status, 'available');
    assert.equal(evaluated.results[1]?.acceptance?.status, 'passed');
    assert.ok(evaluated.results.every(item => item.reviewFocus.recipeMotionTargets.evidenceSource === 'authored_recipe_analysis'));
    assert.ok(evaluated.results.every(item => item.reviewFocus.reviewState.renderedVisualReview === 'not_performed'
      && item.reviewFocus.reviewState.librarySave === 'not_saved' && item.reviewFocus.reviewState.userApprovalForSave === 'required'));
    assert.match(evaluated.results[0]!.reviewFocus.mechanicalChecksNeedingReview.basis, /caller-declared criteria/i);
    assert.equal(evaluated.results[2]?.identicalTo, 'base');
    assert.equal(sampled.length, 2, 'identical full recipes reuse one Studio sample');
    assert.equal((await library.list(0, 20, 'animation')).total, 0, 'evaluating full-recipe alternatives must not save them');
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('unsaved Roblox export preflight converts in Studio but cannot authorize a KeyframeSequence save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-export-candidate-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'export-candidate-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Export candidate', duration: 1, loop: false, markers: [], contacts: [], tracks: [
    { joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  ] };
  const saved = await library.save(recipe);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'animation-export-candidate-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const preflight = await client.callTool({ name: 'motion_studio_validate_animation_candidate', arguments: { sessionId, rigId, recipe } });
    assert.ok(!preflight.isError, JSON.stringify(preflight));
    const queued = (preflight.structuredContent as { result: { jobId: string } }).result;
    const job = queue.poll(sessionId);
    assert.equal(job?.id, queued.jobId);
    const payload = job?.payload as { assetId: string; assetFingerprint: string; rigSignature: string; ephemeralCandidate: boolean; recipe: AnimationRecipe };
    assert.equal(payload.ephemeralCandidate, true);
    const candidateMappedTargets = mappedAnimationTargets(payload.recipe, {});
    queue.complete(sessionId, queued.jobId, true, { valid: true, assetId: payload.assetId, assetFingerprint: payload.assetFingerprint,
      rigId, rigSignature: payload.rigSignature, frameCount: 2, poseCount: 2, markerCount: 0,
      animatedTrackCount: candidateMappedTargets.length, mappedTargetJoints: candidateMappedTargets,
      format: 'KeyframeSequence', saved: false, note: 'Conversion fixture.' });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: queued.jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const evidence = (completed.structuredContent as { result: { result: { candidate: boolean; candidateFingerprint?: string; assetFingerprint: string;
      rigId: string; rigSignature: string; saveAuthorized: boolean; preflightFingerprint?: string } } }).result.result;
    assert.equal(evidence.candidate, true);
    assert.equal(evidence.candidateFingerprint, payload.assetFingerprint, 'conversion evidence should name the exact normalized queued recipe using the candidate vocabulary');
    assert.equal(evidence.assetFingerprint, payload.assetFingerprint);
    assert.equal(evidence.rigId, rigId);
    assert.equal(evidence.rigSignature, rigSignature);
    assert.equal(evidence.saveAuthorized, false);
    assert.equal(evidence.preflightFingerprint, undefined);
    const deniedSave = await client.callTool({ name: 'motion_studio_save_animation', arguments: { sessionId, rigId, assetId: saved.id, jointMap: {},
      expectedFingerprint: fingerprint(saved.recipe), userApprovedFingerprint: fingerprint(saved.recipe), expectedPreflightFingerprint: 'a'.repeat(64) } });
    assert.equal(deniedSave.isError, true);
    assert.match(JSON.stringify(deniedSave), /preflight is missing or expired/i);
    const mismatchedApproval = await client.callTool({ name: 'motion_studio_save_animation', arguments: { sessionId, rigId, assetId: saved.id, jointMap: {},
      expectedFingerprint: fingerprint(saved.recipe), userApprovedFingerprint: 'b'.repeat(64), expectedPreflightFingerprint: 'a'.repeat(64) } });
    assert.equal(mismatchedApproval.isError, true);
    assert.match(JSON.stringify(mismatchedApproval), /user approval fingerprint does not match/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('animation export batch preserves per-clip outcomes and cannot authorize saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-export-batch-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'export-batch-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const first = await library.save(animationPreset('idle', 'Batch valid', 1, 1));
  const second = await library.save(animationPreset('walk', 'Batch invalid', 1, 1));
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'animation-export-batch-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const duplicate = await client.callTool({ name: 'motion_studio_validate_animation_export_batch',
      arguments: { sessionId, rigId, assetIds: [first.id, first.id], jointMap: {} } });
    assert.equal(duplicate.isError, true);
    assert.match(JSON.stringify(duplicate), /assetIds must be unique/i);

    const queued = await client.callTool({ name: 'motion_studio_validate_animation_export_batch',
      arguments: { sessionId, rigId, assetIds: [first.id, second.id], jointMap: {} } });
    assert.ok(!queued.isError, JSON.stringify(queued));
    const { jobId } = (queued.structuredContent as { result: { jobId: string } }).result;
    const job = queue.poll(sessionId);
    assert.equal(job?.id, jobId);
    assert.equal(job?.operation, 'validate_animation_export_batch');
    const payload = job?.payload as { rigSignature: string; jointMap: Record<string, string>;
      candidates: { assetId: string; assetFingerprint: string; recipe: AnimationRecipe }[] };
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.candidates.map(candidate => candidate.assetId), [first.id, second.id]);
    assert.equal(payload.candidates[0]?.assetFingerprint, fingerprint(first.recipe));
    assert.equal(payload.candidates[1]?.assetFingerprint, fingerprint(second.recipe));

    const firstRecipe = first.recipe;
    const secondRecipe = second.recipe;
    if (firstRecipe.kind !== 'animation' || secondRecipe.kind !== 'animation') throw new Error('Fixtures should be animations.');
    const firstMappedTargets = mappedAnimationTargets(firstRecipe, payload.jointMap);
    queue.complete(sessionId, jobId, true, { rigId, rigSignature, saved: false, note: 'Batch fixture.', candidates: [
      { status: 'valid', assetId: first.id, assetFingerprint: fingerprint(firstRecipe), frameCount: 2, poseCount: 3, markerCount: 0,
        animatedTrackCount: firstMappedTargets.length, mappedTargetJoints: firstMappedTargets },
      { status: 'invalid', assetId: second.id, assetFingerprint: fingerprint(secondRecipe), error: 'Fixture conversion failed for this clip.' },
    ] });
    const completed = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!completed.isError, JSON.stringify(completed));
    const report = (completed.structuredContent as { result: { result: { saved: boolean; candidates: { status: string }[]; summary: { status: string; valid: number; invalid: number } } } }).result.result;
    assert.equal(report.saved, false);
    assert.deepEqual(report.candidates.map(candidate => candidate.status), ['valid', 'invalid']);
    assert.deepEqual(report.summary, { requested: 2, valid: 1, invalid: 1, status: 'partial' });

    const deniedSave = await client.callTool({ name: 'motion_studio_save_animation', arguments: { sessionId, rigId, assetId: first.id,
      jointMap: {}, expectedFingerprint: fingerprint(first.recipe), userApprovedFingerprint: fingerprint(first.recipe), expectedPreflightFingerprint: 'a'.repeat(64) } });
    assert.equal(deniedSave.isError, true);
    assert.match(JSON.stringify(deniedSave), /preflight is missing or expired/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP animation graph authors a pinned state machine and compiles only an explicitly reviewed route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-animation-graph-mcp-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const idle = await library.save(animationPreset('idle', 'Graph Idle', 1.5, 0.4));
  const slash = await library.save(animationPreset('slash', 'Graph Strike', 0.8, 0.7));
  const graph = { kind: 'animation_graph', name: 'Combat Graph', entryState: 'idle', sampleRate: 30, states: [
    { id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 },
    { id: 'strike', name: 'Strike', animationId: slash.id, speed: 1 },
  ], transitions: [{ id: 'attack', from: 'idle', to: 'strike', trigger: 'AttackPressed', blendSeconds: 0.1 }] };
  const server = createMcp(library, new Queue(), new Blender(root, 'blender'));
  const client = new Client({ name: 'animation-graph-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const graphPreview = await client.callTool({ name: 'motion_animation_graph_preview', arguments: { graph } });
    assert.ok(!graphPreview.isError, JSON.stringify(graphPreview));
    const graphDraft = (graphPreview.structuredContent as { result: { diagnostics: { unreachableStateIds: string[] }; graphFingerprint: string } }).result;
    assert.deepEqual(graphDraft.diagnostics.unreachableStateIds, []);
    const unreachableBlendGraph = {
      ...graph, parameters: [{ name: 'speed', type: 'number', defaultValue: 0, min: 0, max: 5 }],
      states: [{ id: 'idle', name: 'Locomotion', animationId: idle.id, speed: 1,
        blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 5, stateId: 'alternate' },
          { value: 12, stateId: 'unused' }] } },
      { id: 'strike', name: 'Strike', animationId: slash.id, speed: 1 },
      { id: 'alternate', name: 'Alternate', animationId: idle.id, speed: 1 },
      { id: 'unused', name: 'Out of range source', animationId: idle.id, speed: 1 }],
    };
    const unreachableBlendPreview = await client.callTool({ name: 'motion_animation_graph_preview', arguments: { graph: unreachableBlendGraph } });
    assert.ok(!unreachableBlendPreview.isError, JSON.stringify(unreachableBlendPreview));
    const blendDiagnostics = (unreachableBlendPreview.structuredContent as { result: { diagnostics: {
      blendSpaceDiagnostics: Array<{ stateId: string; unreachableSourceStateIds: string[]; sources: Array<{ stateId: string; witnessParameterValues: number[] }> }>;
    } } }).result.diagnostics.blendSpaceDiagnostics[0]!;
    assert.deepEqual(blendDiagnostics.unreachableSourceStateIds, ['unused']);
    assert.deepEqual(blendDiagnostics.sources.find(source => source.stateId === 'alternate')?.witnessParameterValues, [5]);
    const unreachableBlendCreated = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph: unreachableBlendGraph } });
    assert.ok(!unreachableBlendCreated.isError, JSON.stringify(unreachableBlendCreated));
    const unreachableBlendId = (unreachableBlendCreated.structuredContent as { result: { id: string } }).result.id;
    const unreachableBlendRead = await client.callTool({ name: 'motion_animation_graph_read', arguments: { graphId: unreachableBlendId } });
    assert.ok(!unreachableBlendRead.isError, JSON.stringify(unreachableBlendRead));
    const unreachableBlendReadResult = unreachableBlendRead.structuredContent as { result: { diagnostics: {
      blendSpaceDiagnostics: Array<{ unreachableSourceStateIds: string[] }>;
    } } };
    const readDiagnostics = unreachableBlendReadResult.result.diagnostics;
    assert.deepEqual(readDiagnostics.blendSpaceDiagnostics[0]!.unreachableSourceStateIds, ['unused'],
      'the diagnostic must be recomputed when the immutable graph is read, not only shown in an unsaved preview');
    const unreachableBlendList = await client.callTool({ name: 'motion_animation_graph_list', arguments: {} });
    assert.ok(!unreachableBlendList.isError, JSON.stringify(unreachableBlendList));
    const listedBlendGraph = (unreachableBlendList.structuredContent as { result: { graphs: Array<{ id: string;
      blendSpaceDiagnostics: Array<{ unreachableSourceStateIds: string[] }> }> } }).result.graphs.find(item => item.id === unreachableBlendId);
    assert.deepEqual(listedBlendGraph?.blendSpaceDiagnostics[0]?.unreachableSourceStateIds, ['unused'],
      'graph listings should surface blend reachability without forcing an agent to open every revision');
    const blendRamp = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: unreachableBlendId, duration: 0.2, sampleRateHz: 10, includePoseSamples: false,
      initialParameters: { speed: 0 },
      events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 5 }, duration: 0.2, easing: 'linear' }],
    } });
    assert.ok(!blendRamp.isError, JSON.stringify(blendRamp));
    const blendRampResult = (blendRamp.structuredContent as { result: { blendSamples: Array<{ at: number;
      blendSpaceEvaluations: Array<{ samples: Array<{ stateId: string; weight: number }> }> }> } }).result;
    const halfwayRamp = blendRampResult.blendSamples.find(sample => sample.at === 0.1)!.blendSpaceEvaluations[0]!;
    assert.deepEqual(halfwayRamp.samples.map(sample => [sample.stateId, sample.weight]), [['idle', 0.5], ['alternate', 0.5], ['unused', 0]],
      'the MCP timeline tool should pass ramp inputs through to BlendSpace evaluation');
    const partialRamp = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: unreachableBlendId, duration: 0.15, sampleRateHz: 10, includePoseSamples: false,
      initialParameters: { speed: 0 },
      events: [{ at: 0, kind: 'ramp_parameters', values: { speed: 5 }, duration: 0.2, easing: 'smoothstep' }],
    } });
    assert.ok(!partialRamp.isError, JSON.stringify(partialRamp));
    const partialRampResult = (partialRamp.structuredContent as { result: { incompleteParameterRamps: Array<{
      simulatedProgress: number; easedProgress: number; remainingSecondsAtHorizon: number;
      parameters: Array<{ name: string; currentValue: number; targetValue: number }> }> } }).result;
    assert.equal(partialRampResult.incompleteParameterRamps.length, 1);
    const partialRampSummary = partialRampResult.incompleteParameterRamps[0]!;
    assert.ok(Math.abs(partialRampSummary.simulatedProgress - 0.75) < 1e-12);
    assert.ok(Math.abs(partialRampSummary.easedProgress - 0.84375) < 1e-12);
    assert.ok(Math.abs(partialRampSummary.remainingSecondsAtHorizon - 0.05) < 1e-12);
    assert.equal(partialRampSummary.parameters[0]?.name, 'speed');
    assert.ok(Math.abs(partialRampSummary.parameters[0]!.currentValue - 4.21875) < 1e-12);
    assert.equal(partialRampSummary.parameters[0]?.targetValue, 5,
      'the MCP boundary should preserve explicit partial-ramp progress and current/target values');
    const created = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph } });
    assert.ok(!created.isError, JSON.stringify(created));
    const saved = (created.structuredContent as { result: { id: string } }).result;
    const runtimeExport = await client.callTool({ name: 'motion_animation_graph_runtime_export', arguments: {
      graphId: saved.id, animationAssetIds: { idle: '123456', strike: 'rbxassetid://987654' },
    } });
    assert.ok(!runtimeExport.isError, JSON.stringify(runtimeExport));
    const runtime = (runtimeExport.structuredContent as { result: { moduleSource: string; assetSetFingerprint: string; contract: { constructor: string; methods: string[]; diagnostics: string; playerBinding: string }; animationAssetIds: Record<string, { animationId: string }> } }).result;
    assert.match(runtime.moduleSource, /function Controller:Trigger/);
    assert.match(runtime.moduleSource, /GetMarkerReachedSignal/);
    assert.match(runtime.moduleSource, /function Controller:ConnectMarker/);
    assert.match(runtime.moduleSource, /function Controller.BindToPlayer/);
    assert.match(runtime.moduleSource, /function Controller:Preload/);
    assert.match(runtime.moduleSource, /function Controller:GetLoadedStateIds/);
    assert.match(runtime.moduleSource, /function Controller:EvaluateTrigger/);
    assert.match(runtime.moduleSource, /function Controller:GetAvailableTriggers/);
    assert.match(runtime.moduleSource, /function Controller:TriggerWithParameters/);
    assert.equal(runtime.contract.constructor, 'Controller.new(animator, options?)');
    assert.equal(runtime.contract.methods.includes('TriggerWithParameters(name, updates, expectedTransitionId?)'), true);
    assert.match(runtime.contract.diagnostics, /commits only if a transition successfully starts/);
    assert.match(runtime.contract.playerBinding, /TriggerWithParameters/);
    assert.match(runtime.contract.playerBinding, /GetAvailableTriggers/);
    assert.equal(runtime.contract.methods.includes('Preload(stateIds?)'), true);
    assert.equal(runtime.animationAssetIds.idle!.animationId, 'rbxassetid://123456');
    assert.match(runtime.assetSetFingerprint, /^[a-f0-9]{64}$/);
    const missingRuntimeAsset = await client.callTool({ name: 'motion_animation_graph_runtime_export', arguments: {
      graphId: saved.id, animationAssetIds: { idle: '123456' },
    } });
    assert.equal(missingRuntimeAsset.isError, true);
    assert.match(JSON.stringify(missingRuntimeAsset), /Missing published animation IDs.*strike/);
    const step = await client.callTool({ name: 'motion_animation_graph_evaluate_transition',
      arguments: { graphId: saved.id, currentState: 'idle', trigger: 'AttackPressed' } });
    assert.ok(!step.isError, JSON.stringify(step));
    assert.equal((step.structuredContent as { result: { selectedTransition: { id: string } } }).result.selectedTransition.id, 'attack');
    const scenarioArguments = { graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint, scenarios: [
      { id: 'attack-path', name: 'Reach the strike', steps: [{ trigger: 'AttackPressed', expect: { kind: 'transition', transitionId: 'attack' } }] },
      { id: 'negative-path', name: 'Unknown input stays idle', steps: [{ trigger: 'UnknownInput', expect: { kind: 'no_transition' } }] },
    ] };
    const scenarioSuite = await client.callTool({ name: 'motion_animation_graph_scenario_test', arguments: scenarioArguments });
    assert.ok(!scenarioSuite.isError, JSON.stringify(scenarioSuite));
    const scenarioResult = (scenarioSuite.structuredContent as { result: { status: string; graphFingerprint: string; suiteFingerprint: string; reportFingerprint: string; summary: { passed: number; coveredTransitions: number } } }).result;
    assert.equal(scenarioResult.status, 'passed');
    assert.equal(scenarioResult.graphFingerprint, graphDraft.graphFingerprint);
    assert.equal(scenarioResult.summary.passed, 2);
    assert.equal(scenarioResult.summary.coveredTransitions, 1);
    assert.match(scenarioResult.suiteFingerprint, /^[a-f0-9]{64}$/);
    assert.match(scenarioResult.reportFingerprint, /^[a-f0-9]{64}$/);
    const scenarioReplay = await client.callTool({ name: 'motion_animation_graph_scenario_test', arguments: scenarioArguments });
    assert.equal((scenarioReplay.structuredContent as { result: { reportFingerprint: string } }).result.reportFingerprint, scenarioResult.reportFingerprint);
    const staleScenario = await client.callTool({ name: 'motion_animation_graph_scenario_test', arguments: {
      ...scenarioArguments, expectedGraphFingerprint: '0'.repeat(64),
    } });
    assert.equal(staleScenario.isError, true);
    assert.match(JSON.stringify(staleScenario), /differs from the reviewed expectation/i);
    const timeline = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint, duration: 1.2,
      sampleTimes: [0.13], poseJoints: ['UpperTorso'],
      events: [{ at: 0, kind: 'trigger', trigger: 'AttackPressed', expectTransitionId: 'attack' }],
    } });
    assert.ok(!timeline.isError, JSON.stringify(timeline));
    const timelineResult = (timeline.structuredContent as { result: { finalState: string; transitionIds: string[]; triggeredMarkers: Array<{ at: number; marker: string }>;
      timeline: Array<{ event: string; at: number; transitionId?: string; guardEvaluation?: { detailStatus: string; selectedTransition?: { id: string } | null } }>;
      blendModel: { kind: string }; poseModel: { algorithmVersion: number; kind: string; sampleCount: number; compositionSourceCount: number }; composedPoseSamples: Array<{ at: number; joints: Array<{ joint: string; rotationBlendConfidence: number; rotationInfluence: number; residualWeight: number; contributors: Array<{ stateId: string; effectiveWeight: number; recipeComposition: Array<{ kind: string; applied: boolean }> }> }> }>;
      blendSamples: Array<{ at: number; activeTracks: Array<{ stateId: string; weight: number }> }> } }).result;
    assert.equal(timelineResult.finalState, 'strike');
    assert.deepEqual(timelineResult.transitionIds, ['attack']);
    const triggerDecision = timelineResult.timeline.find(event => event.transitionId === 'attack');
    assert.equal(triggerDecision?.guardEvaluation?.detailStatus, 'complete');
    assert.equal(triggerDecision?.guardEvaluation?.selectedTransition?.id, 'attack');
    assert.deepEqual(timelineResult.triggeredMarkers.map(marker => [marker.at, marker.marker]), [[0.4, 'Release']]);
    assert.ok(timelineResult.timeline.some(event => event.event === 'animation_end' && event.at === 0.8));
    assert.equal(timelineResult.blendModel.kind, 'linear_per_track_weight_estimate');
    assert.equal(timelineResult.poseModel.algorithmVersion, 2);
    assert.equal(timelineResult.poseModel.kind, 'priority_weighted_local_pose_estimate');
    assert.equal(timelineResult.poseModel.sampleCount, 1);
    assert.ok(timelineResult.poseModel.compositionSourceCount > 0);
    assert.deepEqual(timelineResult.composedPoseSamples.map(sample => [sample.at, sample.joints.map(joint => joint.joint)]), [[0.13, ['UpperTorso']]]);
    const composedJoint = timelineResult.composedPoseSamples[0]!.joints[0]!;
    assert.ok(composedJoint.contributors.some(contributor => contributor.recipeComposition.some(source => source.kind === 'base' && source.applied)));
    assert.ok(composedJoint.rotationBlendConfidence >= 0 && composedJoint.rotationBlendConfidence <= 1);
    assert.ok(composedJoint.rotationInfluence >= 0 && composedJoint.rotationInfluence <= 1);
    assert.ok(Math.abs(composedJoint.rotationInfluence + composedJoint.residualWeight - 1) < 1e-12);
    assert.ok(timelineResult.blendSamples.some(sample => sample.at === 0.13), 'requested non-frame sample times are returned');
    const blendSample = timelineResult.blendSamples.find(sample => sample.at === 2 / 30)!;
    assert.deepEqual(blendSample.activeTracks.map(track => track.stateId), ['idle', 'strike']);
    assert.ok(Math.abs(blendSample.activeTracks[0]!.weight - 1 / 3) < 1e-12);
    assert.ok(Math.abs(blendSample.activeTracks[1]!.weight - 2 / 3) < 1e-12);
    const weightsOnlyTimeline = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint, duration: 0.2,
      sampleTimes: [0.13], includePoseSamples: false,
    } });
    assert.ok(!weightsOnlyTimeline.isError, JSON.stringify(weightsOnlyTimeline));
    const weightsOnlyResult = (weightsOnlyTimeline.structuredContent as { result: { poseModel: { sampleCount: number; jointSampleCount: number };
      composedPoseSamples: unknown[]; blendSamples: Array<{ at: number }> } }).result;
    assert.equal(weightsOnlyResult.poseModel.sampleCount, 0, 'includePoseSamples=false must skip pose evaluation through the MCP handler');
    assert.equal(weightsOnlyResult.poseModel.jointSampleCount, 0);
    assert.deepEqual(weightsOnlyResult.composedPoseSamples, []);
    assert.ok(weightsOnlyResult.blendSamples.some(sample => sample.at === 0.13), 'weights-only mode must retain requested track-weight timestamps');
    const staleTimeline = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, expectedGraphFingerprint: '0'.repeat(64), duration: 1,
    } });
    assert.equal(staleTimeline.isError, true);
    assert.match(JSON.stringify(staleTimeline), /differs from the reviewed expectation/i);
    const failedDestinationTimeline = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint, duration: 0.3,
      unavailableStateIds: ['strike'], events: [{ at: 0.1, kind: 'trigger', trigger: 'AttackPressed', expectTransitionId: 'attack' }],
    } });
    assert.ok(!failedDestinationTimeline.isError, JSON.stringify(failedDestinationTimeline));
    const failedDestinationResult = (failedDestinationTimeline.structuredContent as { result: {
      finalState: string; transitionIds: string[]; loadFailureSimulation: { count: number };
      timeline: { event: string; failureReason?: string; selectedTransitionId?: string; stateBefore: string; stateAfter: string }[];
    } }).result;
    assert.equal(failedDestinationResult.finalState, 'idle');
    assert.deepEqual(failedDestinationResult.transitionIds, []);
    assert.equal(failedDestinationResult.loadFailureSimulation.count, 1);
    assert.ok(failedDestinationResult.timeline.some(event => event.event === 'transition_failed'
      && event.failureReason === 'destination_animation_unavailable' && event.selectedTransitionId === 'attack'
      && event.stateBefore === 'idle' && event.stateAfter === 'idle'));
    const timelineCases = [{
        id: 'strike-window', name: 'Strike timing and authored release marker', duration: 1,
        events: [{ at: 0, kind: 'trigger', trigger: 'AttackPressed' }], expect: {
          finalState: 'strike', transitionIds: { mode: 'exact', ids: ['attack'] },
          markers: [{ name: 'Release', minCount: 1, maxCount: 1, window: { start: 0.3, end: 0.5 } }],
          blends: [
            { at: 0.05, stateId: 'idle', weight: { min: 0.5, max: 0.5 }, isPlaying: false, isAffectingPose: true },
            { at: 0.05, stateId: 'strike', weight: { min: 0.5, max: 0.5 }, isPlaying: true, isAffectingPose: true },
          ],
          poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 0,
            rotationBlendConfidence: { min: 0, max: 1 }, rotationInfluence: { min: 1, max: 1 },
            throughout: { start: 0, end: 0.05, sampleRateHz: 30, maxLinearAccelerationStudsPerSecondSquared: 100000 } }],
          stateAt: [{ at: 0.2, stateId: 'strike' }],
          transitionTimes: [{ transitionId: 'attack', minAt: 0, maxAt: 0 }],
        },
      }];
    const timelineSuite = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint, cases: timelineCases,
    } });
    assert.ok(!timelineSuite.isError, JSON.stringify(timelineSuite));
    const timelineSuiteResult = (timelineSuite.structuredContent as { result: { status: string; summary: { passed: number }; reportFingerprint: string;
      cases: Array<{ blendChecks: Array<{ status: string }>; poseChecks: Array<{ status: string; joint: string; checks: Array<{ property: string; passed: boolean }> }> }> } }).result;
    assert.equal(timelineSuiteResult.status, 'passed');
    assert.equal(timelineSuiteResult.summary.passed, 1);
    assert.deepEqual(timelineSuiteResult.cases[0]!.blendChecks.map(check => check.status), ['passed', 'passed']);
    assert.deepEqual(timelineSuiteResult.cases[0]!.poseChecks.map(check => [check.status, check.joint]), [['passed', 'UpperTorso']]);
    assert.deepEqual(timelineSuiteResult.cases[0]!.poseChecks[0]!.checks.map(check => [check.property, check.passed]), [
      ['positionErrorStuds', true], ['rotationBlendConfidence', true], ['rotationInfluence', true],
    ]);
    assert.match(timelineSuiteResult.reportFingerprint, /^[a-f0-9]{64}$/);
    const blendAlternate = await library.save(animationPreset('idle', 'Graph Blend Alternate', 1.5, 0.4));
    const blendGraph = { kind: 'animation_graph' as const, name: 'Combat Blend Graph', entryState: 'strike', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 }],
      states: [
        { id: 'idle', name: 'Locomotion Blend', animationId: idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'alternate' }] } },
        { id: 'strike', name: 'Strike', animationId: slash.id, speed: 1 },
        { id: 'alternate', name: 'Alternate Locomotion', animationId: blendAlternate.id, speed: 1 },
      ], transitions: [{ id: 'enterBlend', from: 'strike', to: 'idle', trigger: 'EnterBlend', blendSeconds: 0.2 }] };
    const blendCreated = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph: blendGraph } });
    assert.ok(!blendCreated.isError, JSON.stringify(blendCreated));
    const savedBlendGraph = (blendCreated.structuredContent as { result: { id: string; graphFingerprint: string } }).result;
    const blendTimelineSuite = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: savedBlendGraph.id, expectedGraphFingerprint: savedBlendGraph.graphFingerprint,
      cases: [{ id: 'independent-channel-weights', name: 'Gate current and target source contributions separately', duration: 0.2,
        events: [{ at: 0, kind: 'trigger', trigger: 'EnterBlend' }], expect: { blends: [
          { at: 0.1, stateId: 'idle', blendSpace: { parameterValue: { min: 0.5, max: 0.5 }, clips: [
            { stateId: 'idle', weight: { min: 0.5, max: 0.5 }, poseContributionWeight: { min: 0.25, max: 0.25 },
              targetPoseContributionWeight: { min: 0.5, max: 0.5 } },
            { stateId: 'alternate', weight: { min: 0.5, max: 0.5 }, poseContributionWeight: { min: 0.25, max: 0.25 },
              targetPoseContributionWeight: { min: 0.5, max: 0.5 } },
          ] } },
        ] } }],
    } });
    assert.ok(!blendTimelineSuite.isError, JSON.stringify(blendTimelineSuite));
    const blendTimelineResult = (blendTimelineSuite.structuredContent as { result: { status: string;
      cases: Array<{ blendChecks: Array<{ status: string; blendSpace: { samples: Array<{ stateId: string;
        poseContributionWeight: number; targetPoseContributionWeight: number;
        playback: { timeSeconds: number; normalizedPhase: number; playbackSpeed: number; authoredStateSpeed: number; isPlaying: boolean } }> } }> }> } }).result;
    assert.equal(blendTimelineResult.status, 'passed');
    assert.deepEqual(blendTimelineResult.cases[0]!.blendChecks[0]!.blendSpace.samples.map(sample => [sample.stateId,
      sample.poseContributionWeight, sample.targetPoseContributionWeight]), [['idle', 0.25, 0.5], ['alternate', 0.25, 0.5]]);
    assert.deepEqual(blendTimelineResult.cases[0]!.blendChecks[0]!.blendSpace.samples.map(sample => [sample.stateId,
      sample.playback.timeSeconds, sample.playback.normalizedPhase, sample.playback.playbackSpeed,
      sample.playback.authoredStateSpeed, sample.playback.isPlaying]),
    [['idle', 0.1, 0.06666666666666667, 1, 1, true], ['alternate', 0.1, 0.06666666666666667, 1, 1, true]],
    'MCP timeline assertions should expose normalized playback clocks and effective/authored speeds for each blended source channel');
    const missingTorsoSource = await library.save({ ...animationPreset('idle', 'Graph Source Missing Torso', 1.5, 0.4),
      tracks: animationPreset('idle', 'Temporary Source', 1.5, 0.4).tracks.filter(track => track.joint !== 'UpperTorso') });
    const channelGraph = { kind: 'animation_graph' as const, name: 'MCP Missing Joint Channel', entryState: 'blend', sampleRate: 30,
      parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0.25, min: 0, max: 1 }], states: [
        { id: 'idle', name: 'Idle Source', animationId: idle.id, speed: 1 },
        { id: 'alternate', name: 'Alternate Missing Torso', animationId: missingTorsoSource.id, speed: 1 },
        { id: 'blend', name: 'Blend Controller', animationId: idle.id, speed: 1,
          blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: 'idle' }, { value: 0.5, stateId: 'alternate' }, { value: 1, stateId: 'blend' }] } },
      ], transitions: [] };
    const channelGraphCreated = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph: channelGraph } });
    assert.ok(!channelGraphCreated.isError, JSON.stringify(channelGraphCreated));
    const savedChannelGraph = (channelGraphCreated.structuredContent as { result: { id: string; graphFingerprint: string } }).result;
    const channelGateCases = [{ id: 'torso-channel', name: 'Pin BlendSpace torso channel', duration: 0.2,
      initialParameters: { speed: 0.25 }, expect: { poses: [{ at: 0.1, joint: 'UpperTorso',
        missingBlendChannels: [{ controllerStateId: 'blend', sourceStateId: 'alternate' }] }] } }];
    const channelGate = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: savedChannelGraph.id, expectedGraphFingerprint: savedChannelGraph.graphFingerprint, cases: channelGateCases,
    } });
    assert.ok(!channelGate.isError, JSON.stringify(channelGate));
    const channelGateResult = (channelGate.structuredContent as { result: { status: string; cases: Array<{
      poseChecks: Array<{ status: string; checks: Array<{ property: string; expected: unknown; observed: unknown; passed: boolean }> }>;
    }> } }).result;
    assert.equal(channelGateResult.status, 'passed');
    assert.deepEqual(channelGateResult.cases[0]!.poseChecks[0]!.checks.map(check => [check.property, check.expected, check.observed, check.passed]), [
      ['missingBlendChannels', [{ controllerStateId: 'blend', sourceStateId: 'alternate' }],
        [{ controllerStateId: 'blend', sourceStateId: 'alternate' }], true],
    ], 'the public MCP schema and result must preserve exact source-channel gate evidence');
    const rejectedChannelGate = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: savedChannelGraph.id, expectedGraphFingerprint: savedChannelGraph.graphFingerprint,
      cases: [{ ...channelGateCases[0]!, id: 'no-channel-gaps', name: 'Require every source to animate torso',
        expect: { poses: [{ at: 0.1, joint: 'UpperTorso', missingBlendChannels: [] }] } }],
    } });
    assert.ok(!rejectedChannelGate.isError, JSON.stringify(rejectedChannelGate));
    const rejectedChannelResult = (rejectedChannelGate.structuredContent as { result: { status: string; cases: Array<{
      failures: Array<{ expectation: string; diagnosis?: { missingBlendChannels: Array<{ controllerStateId: string; sourceStateId: string;
        trackWeight: number; targetTrackWeight: number }> } }>;
    }> } }).result;
    assert.equal(rejectedChannelResult.status, 'failed');
    const channelCoverageFailure = rejectedChannelResult.cases[0]!.failures.find(failure => failure.expectation.endsWith(':missingBlendChannels'))!;
    assert.deepEqual(channelCoverageFailure.diagnosis!.missingBlendChannels.map(source => [source.controllerStateId, source.sourceStateId,
      source.trackWeight, source.targetTrackWeight]), [['blend', 'alternate', 0.5, 0.5]],
    'the MCP failure response must give the AI the exact missing source and current/target weight evidence');
    const failedPoseSuite = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: saved.id, expectedGraphFingerprint: graphDraft.graphFingerprint,
      cases: [{ ...timelineCases[0]!, id: 'diagnose-pose-mismatch', name: 'Explain pose regression',
        expect: { poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [100, 0, 0], positionToleranceStuds: 0,
          expectedRotation: [0, 0, 180], rotationToleranceDegrees: 0,
          throughout: { start: 0, end: 0.1, sampleRateHz: 10 } }] } }],
    } });
    assert.ok(!failedPoseSuite.isError, JSON.stringify(failedPoseSuite));
    const failedPoseResult = (failedPoseSuite.structuredContent as {
      result: {
        status: string;
        cases: Array<{
          poseChecks: Array<{ status: string; throughoutChecks?: Array<{ property: string; passed: boolean; observed?: {
            blendContext?: { currentState: string | null; activeTracks: Array<{ stateId: string; weight: number; drivesJoint: boolean }>;
              lastTransition: { transitionId: string; phase: string; blendProgress: number | null } | null };
          } | null }> }>;
          failures: Array<{
            expectation: string;
            diagnosis?: {
              dominantContributors: Array<{
                stateId: string;
                effectiveWeight: number;
                recipeChannels: Array<{ kind: string; applied: boolean }>;
              }>;
              positionErrorAttribution?: {
                errorVector: [number, number, number];
                accountingErrorStuds: number;
                contributors: Array<{ stateId: string; signedErrorStuds: number; role: string }>;
                neutralAnimationPose: { basis: string; signedErrorStuds: number; role: string };
              };
              rotationTargetComparison?: {
                composedErrorDegrees: number;
                contributors: Array<{ stateId: string; weightedTargetErrorScore: number }>;
                rankingLimitation: string;
              };
            };
          }>;
        }>;
      };
    }).result;
    assert.equal(failedPoseResult.status, 'failed');
    const poseMismatch = failedPoseResult.cases[0]!.failures.find(failure => failure.expectation.endsWith(':position'))!;
    assert.ok(poseMismatch.diagnosis!.dominantContributors.length > 0);
    assert.ok(poseMismatch.diagnosis!.dominantContributors[0]!.effectiveWeight > 0);
    assert.ok(poseMismatch.diagnosis!.dominantContributors[0]!.recipeChannels.some(channel => channel.kind === 'base' && channel.applied));
    assert.ok(poseMismatch.diagnosis!.positionErrorAttribution!.accountingErrorStuds < 1e-12);
    assert.equal(poseMismatch.diagnosis!.positionErrorAttribution!.neutralAnimationPose.basis, 'identity_local_animation_delta');
    assert.ok(poseMismatch.diagnosis!.positionErrorAttribution!.contributors.some(contributor => contributor.role === 'pushes_toward_mismatch'));
    const throughoutFailure = failedPoseResult.cases[0]!.poseChecks[0]!.throughoutChecks!.find(check => check.property === 'maximumPositionErrorStuds' && !check.passed)!;
    assert.ok(throughoutFailure.observed!.blendContext!.activeTracks.length > 0);
    assert.ok(throughoutFailure.observed!.blendContext!.activeTracks.some(track => track.drivesJoint));
    assert.ok(throughoutFailure.observed!.blendContext!.lastTransition);
    const rotationMismatch = failedPoseResult.cases[0]!.failures.find(failure => failure.expectation.endsWith(':rotation'))!;
    assert.ok(rotationMismatch.diagnosis!.rotationTargetComparison!.composedErrorDegrees > 0);
    assert.match(rotationMismatch.diagnosis!.rotationTargetComparison!.rankingLimitation, /not additive/);
    const staleTimelineSuite = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: saved.id, expectedGraphFingerprint: '0'.repeat(64), cases: [{ id: 'stale', name: 'Stale suite', duration: 1,
        events: [], expect: { finalState: 'idle' } }],
    } });
    assert.equal(staleTimelineSuite.isError, true);
    assert.match(JSON.stringify(staleTimelineSuite), /differs from the reviewed expectation/i);
    const timelinePlanPreview = await client.callTool({ name: 'motion_animation_graph_timeline_plan_preview', arguments: {
      name: 'Strike temporal regression', graphId: saved.id, cases: timelineCases,
    } });
    assert.ok(!timelinePlanPreview.isError, JSON.stringify(timelinePlanPreview));
    const timelineDraft = (timelinePlanPreview.structuredContent as { result: { draftFingerprint: string; proposedPlanId: string;
      coveragePreview: { poseCoverage: { diagnosticAssertions: { rotationBlendConfidence: number; rotationInfluence: number } } } } }).result;
    assert.deepEqual(timelineDraft.coveragePreview.poseCoverage.diagnosticAssertions, { rotationBlendConfidence: 1, rotationInfluence: 1 });
    const timelinePlanCreate = await client.callTool({ name: 'motion_animation_graph_timeline_plan_create', arguments: {
      name: 'Strike temporal regression', graphId: saved.id, cases: timelineCases, expectedDraftFingerprint: timelineDraft.draftFingerprint,
    } });
    assert.ok(!timelinePlanCreate.isError, JSON.stringify(timelinePlanCreate));
    const temporalPlan = (timelinePlanCreate.structuredContent as { result: { id: string; planFingerprint: string } }).result;
    assert.equal(temporalPlan.id, timelineDraft.proposedPlanId);
    const temporalRun = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: {
      planId: temporalPlan.id, expectedPlanFingerprint: temporalPlan.planFingerprint,
    } });
    assert.ok(!temporalRun.isError, JSON.stringify(temporalRun));
    const temporalRunResult = (temporalRun.structuredContent as { result: { id: string; report: { status: string; reportFingerprint: string }; next: string;
      nextAction: { status: string; action: string; samePlanRetryRecommended: boolean; userProvidedThresholdRequired: boolean;
        planId: string; planFingerprint: string; evidencePaths: string[] } } }).result;
    assert.equal(temporalRunResult.report.status, 'passed');
    assert.match(temporalRunResult.next, /no native Animator blend samples were collected.*same immutable plan.*connected Studio sessionId and selected rigId/i);
    assert.deepEqual([temporalRunResult.nextAction.status, temporalRunResult.nextAction.action,
      temporalRunResult.nextAction.samePlanRetryRecommended, temporalRunResult.nextAction.userProvidedThresholdRequired],
    ['native_evidence_unrequested', 'optionally_collect_native_samples', false, false]);
    assert.equal(temporalRunResult.nextAction.planId, temporalPlan.id);
    assert.equal(temporalRunResult.nextAction.planFingerprint, temporalPlan.planFingerprint);
    assert.ok(temporalRunResult.nextAction.evidencePaths.includes('report'));
    const temporalRunAgain = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId: temporalPlan.id } });
    assert.ok(!temporalRunAgain.isError, JSON.stringify(temporalRunAgain));
    const temporalRunAgainResult = (temporalRunAgain.structuredContent as { result: { id: string; report: { reportFingerprint: string } } }).result;
    assert.equal(temporalRunAgainResult.report.reportFingerprint, temporalRunResult.report.reportFingerprint);
    const temporalHistory = await client.callTool({ name: 'motion_animation_graph_timeline_plan_history', arguments: { planId: temporalPlan.id } });
    const temporalHistoryResult = (temporalHistory.structuredContent as { result: { total: number; runs: { next: string;
      nextAction: { status: string; planId: string; planFingerprint: string } }[] } }).result;
    assert.equal(temporalHistoryResult.total, 2);
    assert.ok(temporalHistoryResult.runs.every(run => /no native Animator blend samples were collected/i.test(run.next)),
      'history must reconstruct AI next-step guidance without changing the integrity-protected run');
    assert.ok(temporalHistoryResult.runs.every(run => run.nextAction.status === 'native_evidence_unrequested'
      && run.nextAction.planId === temporalPlan.id && run.nextAction.planFingerprint === temporalPlan.planFingerprint),
    'history must reconstruct structured guidance from immutable run evidence');
    const temporalCompare = await client.callTool({ name: 'motion_animation_graph_timeline_plan_compare', arguments: {
      beforeRunId: temporalRunResult.id, afterRunId: temporalRunAgainResult.id,
    } });
    const temporalCompareResult = (temporalCompare.structuredContent as { result: { comparability: string; summary: { stablePasses: number };
      cases: Array<{ checkChanges: Array<{ expectation: string; kind: string; status: string; before: { observed: unknown } | null; after: { observed: unknown } | null }> }> } }).result;
    assert.equal(temporalCompareResult.comparability, 'same_contract');
    assert.equal(temporalCompareResult.summary.stablePasses, 1);
    const poseComparison = temporalCompareResult.cases[0]!.checkChanges.find(check => check.expectation === 'pose:UpperTorso@0.05:positionErrorStuds');
    assert.deepEqual([poseComparison?.kind, poseComparison?.status, poseComparison?.before?.observed, poseComparison?.after?.observed], ['pose', 'stable', 0, 0]);
    const motionWindowComparison = temporalCompareResult.cases[0]!.checkChanges.find(check =>
      check.expectation === 'pose:UpperTorso@0.05:maximumSampledLinearAccelerationStudsPerSecondSquared');
    assert.equal(motionWindowComparison?.status, 'stable', 'the public timeline-plan comparator must retain sampled acceleration window gates');
    assert.deepEqual(motionWindowComparison?.before?.observed, motionWindowComparison?.after?.observed);
    const scenarioPlanPreview = await client.callTool({ name: 'motion_animation_graph_scenario_plan_preview', arguments: {
      name: 'Combat trigger regression', graphId: saved.id, scenarios: scenarioArguments.scenarios,
    } });
    assert.ok(!scenarioPlanPreview.isError, JSON.stringify(scenarioPlanPreview));
    const reviewedPlan = (scenarioPlanPreview.structuredContent as { result: { draftFingerprint: string; proposedPlanId: string } }).result;
    const scenarioPlanCreate = await client.callTool({ name: 'motion_animation_graph_scenario_plan_create', arguments: {
      name: 'Combat trigger regression', graphId: saved.id, scenarios: scenarioArguments.scenarios,
      expectedDraftFingerprint: reviewedPlan.draftFingerprint,
    } });
    assert.ok(!scenarioPlanCreate.isError, JSON.stringify(scenarioPlanCreate));
    const scenarioPlan = (scenarioPlanCreate.structuredContent as { result: { id: string; planFingerprint: string } }).result;
    assert.equal(scenarioPlan.id, reviewedPlan.proposedPlanId);
    const scenarioRun = await client.callTool({ name: 'motion_animation_graph_scenario_plan_run', arguments: {
      planId: scenarioPlan.id, expectedPlanFingerprint: scenarioPlan.planFingerprint,
    } });
    assert.ok(!scenarioRun.isError, JSON.stringify(scenarioRun));
    const scenarioRunResult = (scenarioRun.structuredContent as { result: { id: string; report: { status: string; reportFingerprint: string } } }).result;
    assert.equal(scenarioRunResult.report.status, 'passed');
    const scenarioRunAgain = await client.callTool({ name: 'motion_animation_graph_scenario_plan_run', arguments: { planId: scenarioPlan.id } });
    assert.ok(!scenarioRunAgain.isError, JSON.stringify(scenarioRunAgain));
    const scenarioRunAgainResult = (scenarioRunAgain.structuredContent as { result: { id: string; report: { reportFingerprint: string } } }).result;
    assert.equal(scenarioRunAgainResult.report.reportFingerprint, scenarioRunResult.report.reportFingerprint);
    const scenarioHistory = await client.callTool({ name: 'motion_animation_graph_scenario_plan_history', arguments: { planId: scenarioPlan.id } });
    assert.equal((scenarioHistory.structuredContent as { result: { total: number } }).result.total, 2);
    const scenarioComparison = await client.callTool({ name: 'motion_animation_graph_scenario_plan_compare', arguments: {
      beforeRunId: scenarioRunResult.id, afterRunId: scenarioRunAgainResult.id,
    } });
    assert.equal((scenarioComparison.structuredContent as { result: { comparability: string; summary: { stablePasses: number } } }).result.comparability, 'same_contract');
    assert.equal((scenarioComparison.structuredContent as { result: { summary: { stablePasses: number } } }).result.summary.stablePasses, 2);
    const pathPreview = await client.callTool({ name: 'motion_animation_graph_path_preview', arguments: { graphId: saved.id, transitionIds: ['attack'] } });
    assert.ok(!pathPreview.isError, JSON.stringify(pathPreview));
    const route = (pathPreview.structuredContent as { result: { statePath: string[]; candidateFingerprint: string } }).result;
    assert.deepEqual(route.statePath, ['idle', 'strike']);
    const compile = await client.callTool({ name: 'motion_animation_graph_path_compile', arguments: {
      graphId: saved.id, transitionIds: ['attack'], expectedCandidateFingerprint: route.candidateFingerprint,
    } });
    assert.ok(!compile.isError, JSON.stringify(compile));
    const compiled = (compile.structuredContent as { result: { assetId: string; recipe: AnimationRecipe } }).result;
    assert.equal((await library.get(compiled.assetId)).recipe.kind, 'animation');
    assert.ok(Math.abs(compiled.recipe.duration - 2.2) < 1e-9);
    const retry = await client.callTool({ name: 'motion_animation_graph_path_compile', arguments: {
      graphId: saved.id, transitionIds: ['attack'], expectedCandidateFingerprint: route.candidateFingerprint,
    } });
    assert.ok(!retry.isError, JSON.stringify(retry));
    assert.equal((retry.structuredContent as { result: { assetId: string } }).result.assetId, compiled.assetId,
      'retrying an acknowledged-or-lost route compile must reuse its deterministic asset');
    const rejected = await client.callTool({ name: 'motion_animation_graph_path_compile', arguments: {
      graphId: saved.id, transitionIds: ['attack'], expectedCandidateFingerprint: '0'.repeat(64),
    } });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /changed after preview/i);
    const graphList = await client.callTool({ name: 'motion_animation_graph_list', arguments: {} });
    assert.equal((graphList.structuredContent as { result: { total: number } }).result.total, 4,
      'the saved BlendSpace and missing-channel fixtures are retained as immutable graph revisions');
    assert.equal((await library.list(0, 20, 'animation')).total, 5, 'only the explicitly compiled path and the authored missing-channel fixture add animation assets');
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP fade calibration archives exact Studio curves and timeline simulation applies only live matching profiles', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-graph-fade-mcp-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const idle = await library.save(animationPreset('idle', 'Calibrated Idle', 2, 0.4));
  const strike = await library.save(animationPreset('slash', 'Calibrated Strike', 1, 0.8));
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'fade-calibration-rig-v1';
  const queue = new Queue();
  let studioBuildIdentity: { status: 'captured'; value: string; source: 'roblox_version_global_deprecated' }
    | { status: 'unavailable'; value: null; source: 'unavailable' }
    = { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'graph-fade-calibration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
    const job = queue.poll(sessionId);
    if (!job) return;
    if (job.operation === 'sample_animation_graph_fade') {
      const payload = job.payload as { rigId: string; rigSignature: string; graphFingerprint: string; stateId: string; fadeSeconds: number;
        sampleRateHz: number; playbackSpeed: number; recipe: AnimationRecipe };
      const midpoint = payload.stateId === 'idle' ? 0.25 : 0.7;
      const halfFade = payload.fadeSeconds / 2;
      const playIn = payload.stateId === 'strike'
        ? [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: halfFade, weightCurrent: midpoint, weightTarget: 1 },
          { at: payload.fadeSeconds * 0.75, weightCurrent: midpoint - 0.01, weightTarget: 1 },
          { at: payload.fadeSeconds, weightCurrent: 1, weightTarget: 1 }]
        : [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: halfFade, weightCurrent: midpoint, weightTarget: 1 },
          { at: payload.fadeSeconds, weightCurrent: 1, weightTarget: 1 }];
      queue.complete(sessionId, job.id, true, { source: 'studio_animator_fade_calibration', rigId: payload.rigId,
        rigSignature: payload.rigSignature, graphFingerprint: payload.graphFingerprint, stateId: payload.stateId,
        fadeSeconds: payload.fadeSeconds, sampleRateHz: payload.sampleRateHz,
        studioBuildIdentity: { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' },
        playIn,
        stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: halfFade, weightCurrent: 0.25, weightTarget: 0 }, { at: payload.fadeSeconds, weightCurrent: 0, weightTarget: 0 }],
        adjustWeightIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: halfFade, weightCurrent: 0.4, weightTarget: 1 },
          { at: payload.fadeSeconds, weightCurrent: 1, weightTarget: 1 }],
        adjustWeightOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: halfFade, weightCurrent: 0.6, weightTarget: 0 },
          { at: payload.fadeSeconds, weightCurrent: 0, weightTarget: 0 }],
        playRetrigger: { probeElapsedSeconds: 0.05, timePositionBefore: 0.05, timePositionImmediatelyAfter: 0.05,
          timePositionAfterStep: 0.1, weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1,
          observedClockBehavior: 'preserved' },
        naturalCompletion: { authoredDurationSeconds: payload.recipe.duration, animationLengthSeconds: payload.recipe.duration,
          playbackSpeed: payload.playbackSpeed, endedAfterStoppedSeconds: 0.2,
          samples: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.5, weightTarget: 0 },
            { at: 0.2, weightCurrent: 0, weightTarget: 0 }] },
        limitation: 'Fake Studio fixture returning fade samples.' });
      return;
    }
    if (job.operation === 'sample_animation') {
      const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
      queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId,
        rigSignature: payload.rigSignature, assetId: payload.assetId, duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5,
        groundSource: 'rest_node_bounds', note: 'Fake Studio rig sample for persisted calibrated-plan test.',
        nodes: [{ name: 'UpperTorso', parent: 0, driven: true, foot: false }],
        samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 2, 0]],
          bottoms: [0], orientations: [[0, 0, 0, 1]] })) });
      return;
    }
    queue.complete(sessionId, job.id, false, `Unexpected operation in fade calibration fixture: ${job.operation}.`);
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const graph = { kind: 'animation_graph', name: 'Calibrated graph', entryState: 'idle', sampleRate: 30,
      states: [{ id: 'idle', name: 'Idle', animationId: idle.id }, { id: 'strike', name: 'Strike', animationId: strike.id }],
      transitions: [{ id: 'attack', from: 'idle', to: 'strike', trigger: 'Attack', blendSeconds: 0.2 }] };
    const created = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph } });
    assert.ok(!created.isError, JSON.stringify(created));
    const saved = (created.structuredContent as { result: { id: string; graphFingerprint: string } }).result;
    const profiles = [] as { id: string }[];
    for (const stateId of ['idle', 'strike']) {
      const calibrated = await client.callTool({ name: 'motion_animation_graph_fade_calibrate', arguments: {
        sessionId, rigId, graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, stateId, fadeSeconds: 0.2, sampleRateHz: 10,
      } });
      assert.ok(!calibrated.isError, JSON.stringify(calibrated));
      const calibratedResult = (calibrated.structuredContent as { result: { id: string; schemaVersion: number;
        adjustWeightIn: Array<{ at: number; weightCurrent: number }>; adjustWeightOut: Array<{ at: number; weightCurrent: number }>;
        playRetrigger: { observedClockBehavior: string; timePositionBefore: number; timePositionImmediatelyAfter: number } } }).result;
      assert.equal(calibratedResult.schemaVersion, 4);
      assert.equal(calibratedResult.adjustWeightIn[1]?.weightCurrent, 0.4);
      assert.equal(calibratedResult.adjustWeightOut[1]?.weightCurrent, 0.6);
      assert.equal(calibratedResult.playRetrigger.observedClockBehavior, 'preserved');
      assert.equal(calibratedResult.playRetrigger.timePositionImmediatelyAfter, calibratedResult.playRetrigger.timePositionBefore);
      profiles.push(calibratedResult);
    }
    const unusedDurationCalibration = await client.callTool({ name: 'motion_animation_graph_fade_calibrate', arguments: {
      sessionId, rigId, graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, stateId: 'idle', fadeSeconds: 0.5, sampleRateHz: 10,
    } });
    assert.ok(!unusedDurationCalibration.isError, JSON.stringify(unusedDurationCalibration));
    const unusedDurationProfileId = (unusedDurationCalibration.structuredContent as { result: { id: string } }).result.id;
    const candidates = await client.callTool({ name: 'motion_animation_graph_fade_calibration_candidates', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
    } });
    assert.ok(!candidates.isError, JSON.stringify(candidates));
    const candidateResult = (candidates.structuredContent as { result: { eligibleProfileIds: string[]; recommendedProfileIds: string[];
      qualityReviewProfileIds: string[]; candidates: { id: string; eligible: boolean; recommended: boolean; qualityStatus: string;
        naturalCompletion: { animationLengthSeconds: number; playbackSpeed: number; endedAfterStoppedSeconds: number;
          sampleCount: number; compatibleWithCurrentState: boolean } | null;
        exclusionReasons: string[]; buildCompatibility: 'match' | 'mismatch' | 'unknown'; transitionMatches: { direction: string }[] }[];
      selectionGroups: { stateId: string; fadeSeconds: number; eligibleProfileIds: string[]; recommendedProfileIds: string[];
        suggestedProfileId: string | null; selectionRequired: boolean }[];
      invalidRecordCount: number; invalidRecords: { id: string; error: string }[]; invalidRecordsTruncated: boolean;
      buildCompatibility: 'match' | 'mismatch' | 'unknown'; studioBuildIdentity: { status: string; value: string | null; source: string };
      invalidRecordScanComplete: boolean;
      limitation: string } }).result;
    assert.deepEqual(candidateResult.eligibleProfileIds, [...profiles.map(profile => profile.id), unusedDurationProfileId].sort());
    assert.deepEqual(candidateResult.recommendedProfileIds, [profiles[0]!.id]);
    assert.ok(candidateResult.candidates.every(candidate => candidate.buildCompatibility === 'match'));
    assert.deepEqual(candidateResult.qualityReviewProfileIds, [profiles[1]!.id, unusedDurationProfileId].sort());
    assert.equal(candidateResult.candidates.length, 3);
    assert.ok(candidateResult.candidates.filter(candidate => candidate.eligible && candidate.transitionMatches.length > 0)
      .every(candidate => candidate.transitionMatches.length === 1));
    assert.equal(candidateResult.candidates.find(candidate => candidate.id === profiles[1]!.id)?.recommended, false);
    assert.equal(candidateResult.candidates.find(candidate => candidate.id === profiles[1]!.id)?.qualityStatus, 'review');
    assert.equal(candidateResult.invalidRecordCount, 0);
    assert.equal(candidateResult.invalidRecordsTruncated, false);
    assert.equal(candidateResult.invalidRecordScanComplete, true, 'the initial catalog migration performs a full archive check');
    const naturalCompletionOnlyCandidate = candidateResult.candidates.find(candidate => candidate.id === unusedDurationProfileId)!;
    assert.equal(naturalCompletionOnlyCandidate.eligible, true, 'natural-completion evidence remains discoverable without an exact transition fade match');
    assert.equal(naturalCompletionOnlyCandidate.naturalCompletion?.compatibleWithCurrentState, true);
    assert.equal(naturalCompletionOnlyCandidate.naturalCompletion?.endedAfterStoppedSeconds, 0.2);
    assert.deepEqual(naturalCompletionOnlyCandidate.exclusionReasons, []);
    assert.match(candidateResult.limitation, /build identity matches the active session/i);
    studioBuildIdentity = { status: 'captured', value: 'studio-different-build-456', source: 'roblox_version_global_deprecated' };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
    const mismatchedCandidates = await client.callTool({ name: 'motion_animation_graph_fade_calibration_candidates', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
    } });
    assert.ok(!mismatchedCandidates.isError, JSON.stringify(mismatchedCandidates));
    const mismatchedCandidate = (mismatchedCandidates.structuredContent as { result: typeof candidateResult }).result
      .candidates.find(candidate => candidate.id === profiles[0]!.id)!;
    assert.equal(mismatchedCandidate.buildCompatibility, 'mismatch');
    assert.equal(mismatchedCandidate.eligible, false);
    const crossBuildSimulation = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, sessionId, rigId, fadeCalibrationIds: [profiles[0]!.id], duration: 0.1,
    } });
    assert.equal(crossBuildSimulation.isError, true);
    assert.match(JSON.stringify(crossBuildSimulation), /recalibrate on the active build/i);
    studioBuildIdentity = { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
    studioBuildIdentity = { status: 'unavailable', value: null, source: 'unavailable' };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
    const unknownBuildCandidates = await client.callTool({ name: 'motion_animation_graph_fade_calibration_candidates', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
    } });
    assert.ok(!unknownBuildCandidates.isError, JSON.stringify(unknownBuildCandidates));
    const unknownBuildResult = (unknownBuildCandidates.structuredContent as { result: typeof candidateResult }).result;
    const unknownBuildCandidate = unknownBuildResult.candidates.find(candidate => candidate.id === profiles[0]!.id)!;
    assert.equal(unknownBuildCandidate.buildCompatibility, 'unknown');
    assert.equal(unknownBuildCandidate.eligible, true, 'unknown build identity remains available for explicit review');
    assert.equal(unknownBuildCandidate.recommended, false, 'unknown build identity must never be recommended');
    studioBuildIdentity = { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' };
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, studioBuildIdentity });
    const idleSelection = candidateResult.selectionGroups.find(group => group.stateId === 'idle' && group.fadeSeconds === 0.2)!;
    assert.deepEqual(idleSelection.eligibleProfileIds, [profiles[0]!.id]);
    assert.equal(idleSelection.selectionRequired, false);
    const corruptCalibrationId = randomUUID();
    await writeFile(join(root, 'artifacts', 'animation-graph-fade-calibrations', `${corruptCalibrationId}.json`), '{corrupt calibration');
    const competingIdleCalibration = await client.callTool({ name: 'motion_animation_graph_fade_calibrate', arguments: {
      sessionId, rigId, graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, stateId: 'idle', fadeSeconds: 0.2, sampleRateHz: 120,
    } });
    assert.ok(!competingIdleCalibration.isError, JSON.stringify(competingIdleCalibration));
    const competingIdleProfileId = (competingIdleCalibration.structuredContent as { result: { id: string } }).result.id;
    const competingCandidates = await client.callTool({ name: 'motion_animation_graph_fade_calibration_candidates', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
    } });
    assert.ok(!competingCandidates.isError, JSON.stringify(competingCandidates));
    const competingIdleSelection = ((competingCandidates.structuredContent as { result: typeof candidateResult }).result)
      .selectionGroups.find(group => group.stateId === 'idle' && group.fadeSeconds === 0.2)!;
    const competingCandidateResult = (competingCandidates.structuredContent as { result: typeof candidateResult }).result;
    assert.equal(competingCandidateResult.invalidRecordScanComplete, false,
      'indexed candidate pages must disclose that they do not rescan older, unindexed damage');
    assert.deepEqual(competingIdleSelection.eligibleProfileIds, [profiles[0]!.id, competingIdleProfileId].sort());
    assert.equal(competingIdleSelection.selectionRequired, true);
    assert.equal(competingIdleSelection.suggestedProfileId, profiles[0]!.id,
      'one clean profile may be suggested, but MCP still requires the agent to explicitly choose one ID');
    const ambiguousSimulation = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, sessionId, rigId, fadeCalibrationIds: [...profiles.map(profile => profile.id), competingIdleProfileId], duration: 0.2,
      events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }],
    } });
    assert.equal(ambiguousSimulation.isError, true);
    assert.match(JSON.stringify(ambiguousSimulation), /Multiple fade calibrations were supplied for state idle at 0\.2 seconds/i);
    const simulation = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, sessionId, rigId, fadeCalibrationIds: profiles.map(profile => profile.id), duration: 0.2,
      events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], sampleTimes: [0.1],
    } });
    assert.ok(!simulation.isError, JSON.stringify(simulation));
    const report = (simulation.structuredContent as { result: { blendModel: { kind: string; calibrationProfileIds: string[] };
      playbackRetriggerModel: { measuredPreservedClockTransitions: number; unmeasuredAssumedResetTransitions: number };
      blendSamples: { at: number; activeTracks: { stateId: string; weight: number }[] }[];
      fadeCalibrationEvidence: { id: string; used: boolean; qualityStatus: string; qualityWarnings: string[];
        playRetrigger: { observedClockBehavior: string } }[] } }).result;
    assert.equal(report.blendModel.kind, 'studio_calibrated_curve_per_track_estimate');
    assert.deepEqual(report.blendModel.calibrationProfileIds, profiles.map(profile => profile.id).sort());
    assert.ok(report.fadeCalibrationEvidence.every(profile => profile.used));
    assert.ok(report.fadeCalibrationEvidence.every(profile => profile.playRetrigger.observedClockBehavior === 'preserved'));
    assert.equal(report.fadeCalibrationEvidence.find(profile => profile.id === profiles[0]!.id)?.qualityStatus, 'clean');
    assert.deepEqual(report.fadeCalibrationEvidence.find(profile => profile.id === profiles[0]!.id)?.qualityWarnings, []);
    assert.equal(report.fadeCalibrationEvidence.find(profile => profile.id === profiles[1]!.id)?.qualityStatus, 'review');
    assert.ok(report.fadeCalibrationEvidence.find(profile => profile.id === profiles[1]!.id)!.qualityWarnings.length > 0,
      'the simulation result must retain why a selected empirical curve is marked for review');
    const qualityGatedSimulation = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, sessionId, rigId, fadeCalibrationIds: profiles.map(profile => profile.id),
      requireCleanFadeCalibrations: true, duration: 0.2,
    } });
    assert.equal(qualityGatedSimulation.isError, true);
    assert.match(JSON.stringify(qualityGatedSimulation), /did not pass the required clean-quality gate/i);
    assert.match(JSON.stringify(qualityGatedSimulation), /weight_current_reversed_direction/i);
    assert.equal(report.playbackRetriggerModel.measuredPreservedClockTransitions, 0,
      'the current attack route does not replay a destination already playing');
    assert.equal(report.playbackRetriggerModel.unmeasuredAssumedResetTransitions, 0);
    const midpoint = report.blendSamples.find(sample => sample.at === 0.1)!;
    assert.equal(midpoint.activeTracks.find(track => track.stateId === 'idle')?.weight, 0.25);
    assert.equal(midpoint.activeTracks.find(track => track.stateId === 'strike')?.weight, 0.7);
    const cases = [{ id: 'calibrated-crossfade', name: 'Measured graph crossfade', duration: 0.2,
      events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }], expect: { finalState: 'strike',
        transitionIds: { mode: 'exact', ids: ['attack'] }, blends: [
          { at: 0.1, stateId: 'idle', weight: { min: 0.25, max: 0.25 } },
          { at: 0.1, stateId: 'strike', weight: { min: 0.7, max: 0.7 } },
        ] } }];
    const regression = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
      fadeCalibrationIds: profiles.map(profile => profile.id), cases,
    } });
    assert.ok(!regression.isError, JSON.stringify(regression));
    const regressionReport = (regression.structuredContent as { result: { status: string; blendModel: { kind: string; calibrationProfileIds: string[] };
      playbackRetriggerModel: { measuredPreservedClockTransitions: number };
      fadeCalibrationEvidence: { id: string; rigSignature: string; playRetrigger: { observedClockBehavior: string } }[]; reportFingerprint: string } }).result;
    assert.equal(regressionReport.status, 'passed');
    assert.equal(regressionReport.blendModel.kind, 'studio_calibrated_curve_per_track_estimate');
    assert.deepEqual(regressionReport.blendModel.calibrationProfileIds, profiles.map(profile => profile.id).sort());
    assert.ok(regressionReport.fadeCalibrationEvidence.every(profile => profile.rigSignature === rigSignature));
    assert.ok(regressionReport.fadeCalibrationEvidence.every(profile => profile.playRetrigger.observedClockBehavior === 'preserved'));
    const qualityGatedRegression = await client.callTool({ name: 'motion_animation_graph_timeline_test', arguments: {
      graphId: saved.id, expectedGraphFingerprint: saved.graphFingerprint, sessionId, rigId,
      fadeCalibrationIds: profiles.map(profile => profile.id), requireCleanFadeCalibrations: true, cases,
    } });
    assert.equal(qualityGatedRegression.isError, true);
    assert.match(JSON.stringify(qualityGatedRegression), /did not pass the required clean-quality gate/i);
    const planDraft = await client.callTool({ name: 'motion_animation_graph_timeline_plan_preview', arguments: {
      name: 'Measured crossfade plan', graphId: saved.id, cases,
    } });
    assert.ok(!planDraft.isError, JSON.stringify(planDraft));
    const draft = (planDraft.structuredContent as { result: { draftFingerprint: string } }).result;
    const createdPlan = await client.callTool({ name: 'motion_animation_graph_timeline_plan_create', arguments: {
      name: 'Measured crossfade plan', graphId: saved.id, cases, expectedDraftFingerprint: draft.draftFingerprint,
    } });
    assert.ok(!createdPlan.isError, JSON.stringify(createdPlan));
    const plan = (createdPlan.structuredContent as { result: { id: string } }).result;
    const qualityGatedPlanRun = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: {
      planId: plan.id, sessionId, rigId, fadeCalibrationIds: profiles.map(profile => profile.id), requireCleanFadeCalibrations: true,
    } });
    assert.equal(qualityGatedPlanRun.isError, true);
    assert.match(JSON.stringify(qualityGatedPlanRun), /did not pass the required clean-quality gate/i);
    const planRun = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: {
      planId: plan.id, sessionId, rigId, fadeCalibrationIds: profiles.map(profile => profile.id),
    } });
    assert.ok(!planRun.isError, JSON.stringify(planRun));
    const persistedReport = (planRun.structuredContent as { result: { report: { blendModel: { kind: string; calibrationProfileIds: string[] };
      playbackRetriggerModel: { measuredPreservedClockTransitions: number; unmeasuredAssumedResetTransitions: number };
      fadeCalibrationEvidence: { profileFingerprint: string; playRetrigger: { observedClockBehavior: string } }[] } } }).result;
    assert.equal(persistedReport.report.blendModel.kind, 'studio_calibrated_curve_per_track_estimate');
    assert.deepEqual(persistedReport.report.blendModel.calibrationProfileIds, profiles.map(profile => profile.id).sort());
    assert.equal(persistedReport.report.fadeCalibrationEvidence.length, 2);
    assert.ok(persistedReport.report.fadeCalibrationEvidence.every(profile => profile.playRetrigger.observedClockBehavior === 'preserved'));
    assert.equal(persistedReport.report.playbackRetriggerModel.measuredPreservedClockTransitions, 0);
    assert.equal(persistedReport.report.playbackRetriggerModel.unmeasuredAssumedResetTransitions, 0);
    const planHistory = await client.callTool({ name: 'motion_animation_graph_timeline_plan_history', arguments: { planId: plan.id } });
    const historyRuns = (planHistory.structuredContent as { result: { runs: { report: { blendModel: { calibrationProfileIds: string[] };
      playbackRetriggerModel: { measuredPreservedClockTransitions: number };
      fadeCalibrationEvidence: { playRetrigger: { observedClockBehavior: string } }[] } }[] } }).result.runs;
    assert.deepEqual(historyRuns[0]?.report.blendModel.calibrationProfileIds, profiles.map(profile => profile.id).sort());
    assert.equal(historyRuns[0]?.report.playbackRetriggerModel.measuredPreservedClockTransitions, 0);
    assert.ok(historyRuns[0]?.report.fadeCalibrationEvidence.every(profile => profile.playRetrigger.observedClockBehavior === 'preserved'));
    const listed = await client.callTool({ name: 'motion_animation_graph_fade_calibration_list', arguments: { graphId: saved.id } });
    const calibrationList = (listed.structuredContent as { result: { profiles: unknown[]; invalidRecordCount: number;
      invalidRecords: { id: string }[]; invalidRecordScanComplete: boolean } }).result;
    assert.equal(calibrationList.profiles.length, 4,
      'calibration listing must retain the additional competing profile rather than silently collapsing captures');
    assert.equal(calibrationList.invalidRecordCount, 1);
    assert.equal(calibrationList.invalidRecords[0]?.id, corruptCalibrationId);
    assert.equal(calibrationList.invalidRecordScanComplete, true);
    const wrongRig = await client.callTool({ name: 'motion_animation_graph_timeline_simulate', arguments: {
      graphId: saved.id, sessionId, rigId: randomUUID(), fadeCalibrationIds: profiles.map(profile => profile.id), duration: 0.2,
    } });
    assert.equal(wrongRig.isError, true);
    assert.match(JSON.stringify(wrongRig), /active Motion Tools rig changed/i);
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('MCP temporal plan run can bind authored timeline tests to fingerprinted Studio rig-pose evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-graph-timeline-studio-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const idle = await library.save(animationPreset('idle', 'Studio Timeline Idle', 1, 0.2));
  const strike = await library.save(animationPreset('slash', 'Studio Timeline Strike', 0.8, 0.7));
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'studio-timeline-rig-v1';
  const queue = new Queue();
  const nativeBlendRequests: Array<{ caseId: string; at: number; tracks: { stateId: string; weight: number; playbackTimeSeconds: number }[] }> = [];
  let tamperNativeTrackEcho = false;
  const nativeWeightReadbackOffset = 0.00005;
  const nativeTimeReadbackOffset = 0.0005;
  let offsetNativeBlendPose = false;
  let calibrationProtocol = 'identity_local_animation_delta_v1';
  let corruptNativeSample: 'timestamp' | 'joint' | null = null;
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'graph-timeline-studio-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature },
      studioBuildIdentity: { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' } });
    const job = queue.poll(sessionId);
    if (!job) return;
    if (job.operation === 'sample_animation_graph_blend') {
      const payload = job.payload as { rigId: string; rigSignature: string; graphFingerprint: string;
        samples: { caseId: string; at: number; joints: string[]; tracks: { stateId: string; weight: number; playbackTimeSeconds: number }[] }[] };
      nativeBlendRequests.push(...payload.samples);
      queue.complete(sessionId, job.id, true, { source: 'studio_animator_native_blend', calibrationProtocol, rigId: payload.rigId,
        rigSignature: payload.rigSignature, studioBuildIdentity: { status: 'captured', value: 'studio-test-build-123', source: 'roblox_version_global_deprecated' },
        graphFingerprint: payload.graphFingerprint, sampleCount: payload.samples.length,
        samples: payload.samples.map((sample, sampleIndex) => ({ caseId: sample.caseId,
          at: corruptNativeSample === 'timestamp' && sampleIndex === 0 ? sample.at + 0.001 : sample.at,
          tracks: sample.tracks.map((track, index) => ({ ...track,
            weight: tamperNativeTrackEcho && index === 0 ? Math.max(0, track.weight - 0.01)
              : Math.min(1, track.weight + nativeWeightReadbackOffset),
            playbackTimeSeconds: Math.min(30, track.playbackTimeSeconds + nativeTimeReadbackOffset) })),
          joints: Object.fromEntries(sample.joints.map(joint => [corruptNativeSample === 'joint' && sampleIndex === 0 ? 'UnplannedJoint' : joint,
            { position: [offsetNativeBlendPose ? 101 : 0, 0, 0], rotationQuaternion: [0, 0, 0, 1] }])) })),
        limitation: 'Joint Transform is sampled after resetting it to CFrame.identity; results are identity-relative local animation deltas, not world transforms or the rig\'s authored rest CFrames. The harness assigns exact weights immediately with AdjustWeight(weight, 0); this validates fixed-weight pose composition, not Roblox Play/Stop fade trajectories or runtime crossfade timing.' });
      return;
    }
    if (job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'detached Studio pose-evaluator fixture',
      nodes: [{ name: 'UpperTorso', parent: 0, driven: true, foot: false }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 2 + Math.sin(time), 0]],
        bottoms: [0], orientations: [[0, 0, 0, 1]] })) });
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const graph = { kind: 'animation_graph', name: 'Studio Timeline Graph', entryState: 'idle', sampleRate: 30,
      states: [{ id: 'idle', name: 'Idle', animationId: idle.id, speed: 1 }, { id: 'strike', name: 'Strike', animationId: strike.id, speed: 1 }],
      transitions: [{ id: 'attack', from: 'idle', to: 'strike', trigger: 'Attack', blendSeconds: 0.1 }] };
    const createdGraph = await client.callTool({ name: 'motion_animation_graph_create', arguments: { graph } });
    assert.ok(!createdGraph.isError, JSON.stringify(createdGraph));
    const graphId = (createdGraph.structuredContent as { result: { id: string; graphFingerprint: string } }).result.id;
    const cases = [{ id: 'attack-path', name: 'Attack reaches strike', duration: 0.8, events: [{ at: 0, kind: 'trigger', trigger: 'Attack' }],
      expect: { finalState: 'strike', transitionIds: { mode: 'exact', ids: ['attack'] },
        poses: [{ at: 0.05, joint: 'UpperTorso', expectedPosition: [0, 0, 0], positionToleranceStuds: 100,
          studioCalibrationTolerance: { maxPositionErrorStuds: 100, maxRotationErrorDegrees: 180 },
          throughout: { start: 0.05, end: 0.15, sampleRateHz: 10 } }] } }];
    const draft = await client.callTool({ name: 'motion_animation_graph_timeline_plan_preview', arguments: {
      name: 'Live Studio graph smoke test', graphId, cases,
    } });
    assert.ok(!draft.isError, JSON.stringify(draft));
    const draftResult = (draft.structuredContent as { result: { draftFingerprint: string; proposedPlanId: string } }).result;
    const plan = await client.callTool({ name: 'motion_animation_graph_timeline_plan_create', arguments: {
      name: 'Live Studio graph smoke test', graphId, cases, expectedDraftFingerprint: draftResult.draftFingerprint,
    } });
    assert.ok(!plan.isError, JSON.stringify(plan));
    const planDetails = (plan.structuredContent as { result: { id: string; planFingerprint: string } }).result;
    const planId = planDetails.id;
    const run = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: {
      planId, expectedPlanFingerprint: planDetails.planFingerprint, sessionId, rigId,
    } });
    assert.ok(!run.isError, JSON.stringify(run));
    const result = (run.structuredContent as { result: { report: { status: string }; releaseStatus: string; next: string;
      studioCalibrationGate: { status: string; checks: { status: string; expectedSampleCount: number; actualSampleCount: number }[] };
      studioBlendEvidence: {
      schemaVersion: number; source: string; calibrationProtocol: string; jointMap: Record<string, string>; jointMapFingerprint: string;
      rigId: string; rigSignature: string; limitation: string; fingerprint: string; samples: { caseId: string; at: number; joint: string;
        activeTracks: { stateId: string; weight: number; playbackTimeSeconds: number }[];
        requestedTracks: { stateId: string; weight: number; playbackTimeSeconds: number }[];
        simulatedResidualBasis: 'identity_local_animation_delta';
        simulatedContributors: { stateId: string; priority: string; trackWeight: number; effectiveWeight: number;
          contributionStatus: string; position: number[]; rotationQuaternion: number[] }[];
        simulatedPriorityLayers: { priority: string; priorityRank: number; stateIds: string[]; requestedWeight: number;
          availableWeightBefore: number; effectiveBudget: number; remainingWeightAfter: number }[];
        simulatedResidualWeight: number;
        simulatedTimelineContext: { mostRecentTransition: { transitionId: string; fromState: string; toState: string; startedAt: number; blendSeconds: number; progress: number;
          sourceWeightAtTransition: number; destinationWeightAtTransition: number; destinationFadeStartWeight: number } | null;
          markersAtSample: { stateId: string; name: string; value: string }[] }; positionErrorStuds: number }[];
    }; studioEvidence: {
      rigId: string; rigSignature: string; fingerprint: string; samples: { stateId: string; inspection: { source: string } }[]; uncoveredExpectedStateIds: string[];
    } } }).result;
    assert.equal(result.report.status, 'passed');
    assert.equal(result.studioCalibrationGate.status, 'passed');
    assert.equal(result.studioCalibrationGate.checks[0]!.expectedSampleCount, 3);
    assert.equal(result.studioCalibrationGate.checks[0]!.actualSampleCount, 3);
    assert.equal(result.releaseStatus, 'passed');
    assert.match(result.next, /timeline checks and requested native fixed-weight pose gate passed.*does not validate unsampled fades/i);
    assert.equal(result.studioEvidence.rigId, rigId);
    assert.equal(result.studioEvidence.rigSignature, rigSignature);
    assert.match(result.studioEvidence.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.studioEvidence.samples.map(sample => sample.stateId), ['idle', 'strike']);
    assert.ok(result.studioEvidence.samples.every(sample => sample.inspection.source === 'studio_pose_evaluator'));
    assert.deepEqual(result.studioEvidence.uncoveredExpectedStateIds, []);
    assert.equal(result.studioBlendEvidence.source, 'studio_animator_native_blend');
    assert.equal(result.studioBlendEvidence.schemaVersion, 12);
    assert.equal(result.studioBlendEvidence.calibrationProtocol, 'identity_local_animation_delta_v1');
    assert.deepEqual(result.studioBlendEvidence.jointMap, {});
    assert.match(result.studioBlendEvidence.jointMapFingerprint, /^[a-f0-9]{64}$/);
    assert.match(result.studioBlendEvidence.limitation, /not Roblox Play\/Stop fade trajectories/,
      'immutable Studio blend evidence must retain the fixed-weight calibration limitation');
    assert.equal(result.studioBlendEvidence.rigId, rigId);
    assert.equal(result.studioBlendEvidence.rigSignature, rigSignature);
    assert.match(result.studioBlendEvidence.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.studioBlendEvidence.samples.map(sample => [sample.caseId, sample.at, sample.joint]), [
      ['attack-path', 0.05, 'UpperTorso'], ['attack-path', 0.1, 'UpperTorso'], ['attack-path', 0.15, 'UpperTorso'],
    ]);
    assert.deepEqual(result.studioBlendEvidence.samples[0]!.activeTracks.map(track => track.stateId), ['idle', 'strike']);
    assert.ok(result.studioBlendEvidence.samples[0]!.activeTracks.every(track => Math.abs(track.weight - 0.50005) < 1e-10));
    assert.ok(result.studioBlendEvidence.samples[0]!.activeTracks.every(track => Math.abs(track.playbackTimeSeconds - 0.0505) < 1e-10));
    assert.ok(result.studioBlendEvidence.samples[0]!.requestedTracks.every(track => track.weight === 0.5 && track.playbackTimeSeconds === 0.05));
    const contributors = result.studioBlendEvidence.samples[0]!.simulatedContributors;
    assert.equal(result.studioBlendEvidence.schemaVersion, 12);
    assert.equal(result.studioBlendEvidence.samples[0]!.simulatedResidualBasis, 'identity_local_animation_delta');
    assert.match(result.studioBlendEvidence.limitation, /identity-relative local animation deltas.*not world transforms or the rig's authored rest CFrames/i);
    assert.ok(contributors.length > 0, 'native blend evidence must preserve the simulator contributors for each measured joint');
    assert.ok(result.studioBlendEvidence.samples[0]!.simulatedPriorityLayers.length > 0,
      'immutable native-blend evidence must preserve the simulator priority-layer explanation');
    assert.ok(Math.abs(result.studioBlendEvidence.samples[0]!.simulatedPriorityLayers.at(-1)!.remainingWeightAfter
      - result.studioBlendEvidence.samples[0]!.simulatedResidualWeight) < 1e-6,
    'persisted priority layers must reconcile with the neutral local-animation residual');
    assert.ok(Math.abs(contributors.reduce((sum, contributor) => sum + contributor.effectiveWeight, result.studioBlendEvidence.samples[0]!.simulatedResidualWeight) - 1) < 1e-6,
      'simulated contributors plus neutral local-animation residual weight must account for the complete predicted joint pose');
    assert.deepEqual(result.studioBlendEvidence.samples[0]!.simulatedTimelineContext.mostRecentTransition, {
      transitionId: 'attack', fromState: 'idle', toState: 'strike', startedAt: 0, blendSeconds: 0.1, progress: 0.5,
      sourceWeightAtTransition: 1, destinationWeightAtTransition: 0, destinationFadeStartWeight: 0,
    });
    assert.deepEqual(result.studioBlendEvidence.samples[0]!.simulatedTimelineContext.markersAtSample, []);
    const transitionSample = nativeBlendRequests.find(sample => sample.caseId === 'attack-path' && sample.at === 0.05)!;
    assert.equal(transitionSample.tracks.length, 2);
    assert.deepEqual(transitionSample.tracks.map(track => track.stateId), ['idle', 'strike']);
    assert.ok(transitionSample.tracks.every(track => Math.abs(track.weight - 0.5) < 1e-12));
    const secondRun = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.ok(!secondRun.isError, JSON.stringify(secondRun));
    const secondRunId = (secondRun.structuredContent as { result: { id: string } }).result.id;
    const history = await client.callTool({ name: 'motion_animation_graph_timeline_plan_history', arguments: { planId } });
    assert.equal((history.structuredContent as { result: { total: number } }).result.total, 2);
    const comparison = await client.callTool({ name: 'motion_animation_graph_timeline_plan_compare', arguments: {
      beforeRunId: (run.structuredContent as { result: { id: string } }).result.id, afterRunId: secondRunId,
    } });
    const comparisonResult = (comparison.structuredContent as { result: { studioEvidenceComparability: string; studioBlendEvidenceComparability: string;
      studioBlendProtocolComparability: string; studioBlendJointMapComparability: string;
      studioBlendSampleChanges: { before: { simulatedResidualBasis?: string; simulatedContributors?: { stateId: string; effectiveWeight: number }[]; simulatedResidualWeight?: number;
          simulatedPriorityLayers?: { priority: string; effectiveBudget: number }[] } | null;
        after: { simulatedResidualBasis?: string; simulatedContributors?: { stateId: string; effectiveWeight: number }[]; simulatedResidualWeight?: number;
          simulatedPriorityLayers?: { priority: string; effectiveBudget: number }[] } | null }[];
      before: { studioBlendCalibration: { sampleCount: number; compositionStrata: { byObservedActiveTrackCount: { value: number | null; sampleCount: number }[];
        bySimulatedPriorityLayerCount: { value: number | null; sampleCount: number }[]; bySimulatedSamePriorityOverlapCount: { value: number | null; sampleCount: number }[]; limitation: string }; errorDistribution: { method: string;
        positionErrorStuds: { p50: number | null; p95: number | null };
        rotationErrorDegrees: { p50: number | null; p95: number | null } };
        byCaseAndJoint: { caseId: string; joint: string; sampleCount: number;
          positionErrorStuds: { p50: number | null; p95: number | null };
          rotationErrorDegrees: { p50: number | null; p95: number | null } }[] } | null };
      after: { studioBlendCalibration: { sampleCount: number; compositionStrata: { byObservedActiveTrackCount: { value: number | null; sampleCount: number }[];
        bySimulatedPriorityLayerCount: { value: number | null; sampleCount: number }[]; bySimulatedSamePriorityOverlapCount: { value: number | null; sampleCount: number }[]; limitation: string }; errorDistribution: { method: string;
        positionErrorStuds: { p50: number | null; p95: number | null };
        rotationErrorDegrees: { p50: number | null; p95: number | null } };
        byCaseAndJoint: { caseId: string; joint: string; sampleCount: number;
          positionErrorStuds: { p50: number | null; p95: number | null };
          rotationErrorDegrees: { p50: number | null; p95: number | null } }[] } | null };
      studioBlendCalibrationDelta: { status: 'comparable'; method: string; beforeSampleCount: number; afterSampleCount: number;
        positionErrorStuds: { p50: number; p95: number }; rotationErrorDegrees: { p50: number; p95: number };
        byCaseAndJoint: { caseId: string; joint: string; sampleCount: number; positionErrorStuds: { p50: number; p95: number };
          rotationErrorDegrees: { p50: number; p95: number } }[] } | { status: 'not_comparable'; reason: string };
      summary: { stablePasses: number; changedStudioMetrics: number; changedStudioBlendSamples: number } } }).result;
    assert.equal(comparisonResult.studioEvidenceComparability, 'same_rig');
    assert.equal(comparisonResult.studioBlendEvidenceComparability, 'same_rig_same_contract_same_studio_build');
    assert.equal(comparisonResult.studioBlendProtocolComparability, 'match');
    assert.equal(comparisonResult.studioBlendJointMapComparability, 'match');
    assert.equal(comparisonResult.summary.stablePasses, 1);
    assert.equal(comparisonResult.summary.changedStudioMetrics, 0);
    assert.equal(comparisonResult.summary.changedStudioBlendSamples, 0);
    assert.equal(comparisonResult.before.studioBlendCalibration?.sampleCount, 3);
    assert.equal(comparisonResult.after.studioBlendCalibration?.errorDistribution.method, 'nearest_rank_percentile');
    assert.deepEqual(comparisonResult.after.studioBlendCalibration?.compositionStrata.byObservedActiveTrackCount.map(group => [group.value, group.sampleCount]), [[1, 2], [2, 1]],
      'native blend error should remain separated across the single-track sample and two-track transition samples');
    assert.ok(comparisonResult.after.studioBlendCalibration?.compositionStrata.bySimulatedPriorityLayerCount.every(group => group.value !== null),
      'current native calibration evidence should retain simulated priority context for stratification');
    assert.match(comparisonResult.after.studioBlendCalibration?.compositionStrata.limitation ?? '', /not causal attribution/);
    const calibrationDistribution = comparisonResult.after.studioBlendCalibration!.errorDistribution;
    assert.ok(calibrationDistribution.positionErrorStuds.p50 !== null
      && calibrationDistribution.positionErrorStuds.p95 !== null
      && calibrationDistribution.positionErrorStuds.p50 <= calibrationDistribution.positionErrorStuds.p95);
    assert.ok(calibrationDistribution.rotationErrorDegrees.p50 !== null
      && calibrationDistribution.rotationErrorDegrees.p95 !== null
      && calibrationDistribution.rotationErrorDegrees.p50 <= calibrationDistribution.rotationErrorDegrees.p95);
    assert.deepEqual(comparisonResult.after.studioBlendCalibration!.byCaseAndJoint.map(group => [group.caseId, group.joint, group.sampleCount]), [
      ['attack-path', 'UpperTorso', 3],
    ], 'whole-trace calibration summaries must retain case/joint locality');
    assert.deepEqual(comparisonResult.before.studioBlendCalibration, comparisonResult.after.studioBlendCalibration,
      'identical native-vs-estimated samples must produce identical distribution summaries');
    assert.equal(comparisonResult.studioBlendCalibrationDelta.status, 'comparable');
    if (comparisonResult.studioBlendCalibrationDelta.status === 'comparable') {
      assert.deepEqual(comparisonResult.studioBlendCalibrationDelta.positionErrorStuds, { p50: 0, p95: 0 });
      assert.deepEqual(comparisonResult.studioBlendCalibrationDelta.rotationErrorDegrees, { p50: 0, p95: 0 });
      assert.deepEqual(comparisonResult.studioBlendCalibrationDelta.byCaseAndJoint.map(group => [group.caseId, group.joint, group.sampleCount]), [
        ['attack-path', 'UpperTorso', 3],
      ]);
    }
    assert.deepEqual(comparisonResult.studioBlendSampleChanges[0]!.before?.simulatedContributors,
      comparisonResult.studioBlendSampleChanges[0]!.after?.simulatedContributors,
      'integrity-checked history comparison must preserve stable per-joint blend contributors');
    assert.equal(comparisonResult.studioBlendSampleChanges[0]!.before?.simulatedResidualWeight,
      comparisonResult.studioBlendSampleChanges[0]!.after?.simulatedResidualWeight);
    assert.equal(comparisonResult.studioBlendSampleChanges[0]!.before?.simulatedResidualBasis, 'identity_local_animation_delta');
    assert.deepEqual(comparisonResult.studioBlendSampleChanges[0]!.before?.simulatedPriorityLayers,
      comparisonResult.studioBlendSampleChanges[0]!.after?.simulatedPriorityLayers,
      'run comparisons must retain stable priority-layer budgets from immutable history');
    tamperNativeTrackEcho = true;
    const mismatchedBlend = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.equal(mismatchedBlend.isError, true);
    assert.match(JSON.stringify(mismatchedBlend), /measured different active states, blend weights, or playback positions/i);
    tamperNativeTrackEcho = false;
    corruptNativeSample = 'timestamp';
    const shiftedCalibrationTime = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.equal(shiftedCalibrationTime.isError, true,
      'a Studio response that substitutes a requested calibration timestamp must fail closed');
    assert.match(JSON.stringify(shiftedCalibrationTime), /omitted native blend sample/i);
    corruptNativeSample = 'joint';
    const substitutedCalibrationJoint = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.equal(substitutedCalibrationJoint.isError, true,
      'a Studio response that replaces a requested joint must fail closed');
    assert.match(JSON.stringify(substitutedCalibrationJoint), /omitted native blend joint/i);
    corruptNativeSample = null;
    calibrationProtocol = 'stale_unknown_protocol';
    const stalePluginCalibration = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.equal(stalePluginCalibration.isError, true,
      'a Studio plugin using an unknown native-blend sampling protocol must fail closed');
    assert.match(JSON.stringify(stalePluginCalibration), /identity_local_animation_delta_v1/i);
    calibrationProtocol = 'identity_local_animation_delta_v1';
    const unchangedHistory = await client.callTool({ name: 'motion_animation_graph_timeline_plan_history', arguments: { planId } });
    assert.equal((unchangedHistory.structuredContent as { result: { total: number } }).result.total, 2);
    offsetNativeBlendPose = true;
    const outOfTolerance = await client.callTool({ name: 'motion_animation_graph_timeline_plan_run', arguments: { planId, sessionId, rigId } });
    assert.ok(!outOfTolerance.isError, JSON.stringify(outOfTolerance));
    const gatedRun = (outOfTolerance.structuredContent as { result: { id: string; report: { status: string }; releaseStatus: string; next: string;
      nextAction: { status: string; action: string; samePlanRetryRecommended: boolean; failedCalibrationChecks: { caseId: string; joint: string; failedTimes: number[] }[] };
      studioCalibrationGate: { status: string; checks: { status: string; observedMaxPositionErrorStuds?: number }[] } } }).result;
    assert.equal(gatedRun.report.status, 'passed');
    assert.equal(gatedRun.studioCalibrationGate.status, 'failed');
    assert.equal(gatedRun.studioCalibrationGate.checks[0]!.status, 'failed');
    assert.ok((gatedRun.studioCalibrationGate.checks[0]!.observedMaxPositionErrorStuds ?? 0) > 100);
    assert.equal(gatedRun.releaseStatus, 'failed');
    assert.match(gatedRun.next, /did not pass all requested checks.*exact times and errors.*Keep the plan and user-stated tolerances unchanged/i);
    assert.deepEqual([gatedRun.nextAction.status, gatedRun.nextAction.action, gatedRun.nextAction.samePlanRetryRecommended],
      ['failed', 'inspect_failed_assertions', false]);
    assert.deepEqual(gatedRun.nextAction.failedCalibrationChecks, [{ caseId: 'attack-path', joint: 'UpperTorso', failedTimes: [0.05, 0.1, 0.15] }]);
    const changedCalibration = await client.callTool({ name: 'motion_animation_graph_timeline_plan_compare', arguments: {
      beforeRunId: (run.structuredContent as { result: { id: string } }).result.id, afterRunId: gatedRun.id,
    } });
    assert.ok(!changedCalibration.isError, JSON.stringify(changedCalibration));
    const changedCalibrationDelta = (changedCalibration.structuredContent as { result: { studioBlendCalibrationDelta:
      { status: 'comparable'; positionErrorStuds: { p50: number; p95: number }; byCaseAndJoint: { positionErrorStuds: { p95: number } }[] }
      | { status: 'not_comparable'; reason: string } } }).result.studioBlendCalibrationDelta;
    assert.equal(changedCalibrationDelta.status, 'comparable');
    if (changedCalibrationDelta.status === 'comparable') {
      assert.ok(changedCalibrationDelta.positionErrorStuds.p95 > 100,
        'matching-contract calibration comparison should quantify the increase in whole-trace 95th-percentile position error');
      assert.ok(changedCalibrationDelta.byCaseAndJoint[0]!.positionErrorStuds.p95 > 100);
    }
    offsetNativeBlendPose = false;
  } finally {
    clearInterval(poller);
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP animation comparison samples both revisions on one live rig and returns a measured change map', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-compare-mcp-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID();
  let rigSignature = 'fixture-rig-v1';
  let changeSignatureOnNextSample = false;
  const sampledRecipes: Array<{ assetId: string; recipe: AnimationRecipe }> = [];
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const parent = await library.save({ kind: 'animation', name: 'Parent', duration: 1, loop: false, tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }], markers: [{ name: 'Windup', time: 0.2 }, { name: 'Strike', time: 0.6 }, { name: 'Recovery', time: 0.8 }],
    contacts: [{ effector: 'UpperTorso', kind: 'grip', start: 0, end: 1 }] });
  const candidate = await library.save({ kind: 'animation', name: 'Candidate', duration: 1, loop: false, tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [1, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [1, 0, 0], rotation: [0, 0, 0] },
  ] }], markers: [{ name: 'Windup', time: 0.2 }, { name: 'Strike', time: 0.6 }, { name: 'Recovery', time: 0.8 }] });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'animation-compare-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    sampledRecipes.push({ assetId: payload.assetId, recipe: payload.recipe });
    const sampleX = (time: number) => {
      const keys = payload.recipe.tracks[0]!.keys;
      for (let index = 1; index < keys.length; index++) {
        const left = keys[index - 1]!, right = keys[index]!;
        if (time <= right.time) { const alpha = (time - left.time) / (right.time - left.time); return left.position[0] + (right.position[0] - left.position[0]) * alpha; }
      }
      return keys.at(-1)!.position[0];
    };
    queue.complete(sessionId, job.id, true, {
      version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'fixture samples',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperTorso', parent: 1, driven: true, foot: false }],
      samples: payload.times.map((time, index) => { const x = sampleX(time); return { id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 0, 0], [x, 0, 0]], bottoms: [0, 0], orientations: [[0, 0, 0, 1], [0, 0, x === 0 ? 0 : Math.SQRT1_2, x === 0 ? 1 : Math.SQRT1_2]] }; }),
    });
    if (changeSignatureOnNextSample) { changeSignatureOnNextSample = false; rigSignature = 'fixture-rig-v2'; }
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const compared = await client.callTool({ name: 'motion_animation_compare', arguments: { sessionId, rigId, parentAssetId: parent.id, candidateAssetId: candidate.id } });
    assert.ok(!compared.isError, JSON.stringify(compared));
    const result = (compared.structuredContent as { result: { comparison: { status: string; changedJointCount: number; largestDisplacement: number; largestAngularDisplacement: number; largestChanges: { joint: string }[]; largestRotationChanges: { joint: string }[]; actionPhaseComparison: { status: string; matchedPhaseCount: number; phases: { label: string }[] } } } }).result;
    assert.equal(result.comparison.status, 'available');
    assert.equal(result.comparison.changedJointCount, 1);
    assert.equal(result.comparison.largestDisplacement, 1);
    assert.equal(result.comparison.largestChanges[0]!.joint, 'UpperTorso');
    assert.equal(result.comparison.largestAngularDisplacement, 90);
    assert.equal(result.comparison.largestRotationChanges[0]!.joint, 'UpperTorso');
    assert.equal(result.comparison.actionPhaseComparison.status, 'available');
    assert.equal(result.comparison.actionPhaseComparison.matchedPhaseCount, 3);
    assert.deepEqual(result.comparison.actionPhaseComparison.phases.map(phase => phase.label), ['anticipation', 'main_action', 'recovery']);
    const pose = await client.callTool({ name: 'motion_pose_save', arguments: { name: 'Evaluation Pose', rigType: 'R15', transforms: [{ joint: 'UpperTorso', position: [1, 0, 0], rotation: [0, 30, 0] }] } });
    assert.ok(!pose.isError, JSON.stringify(pose));
    const poseId = (pose.structuredContent as { result: { id: string } }).result.id;
    const libraryBeforeEvaluation = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const firstEvaluationSampleIndex = sampledRecipes.length;
    const evaluated = await client.callTool({ name: 'motion_pose_sequence_evaluate', arguments: { sessionId, rigId, animationAssetId: parent.id,
      placements: [{ poseId, time: 0.5 }], alternatives: [
        { name: 'later pose', placements: [{ poseId, time: 0.75 }] },
        { name: 'duplicate primary', placements: [{ poseId, time: 0.5 }] },
      ] } });
    assert.ok(!evaluated.isError, JSON.stringify(evaluated));
    const evaluation = (evaluated.structuredContent as { result: { status: string; candidateFingerprint: string; rigSignature: string; next: string; studio: unknown; structural: unknown; comparison: { status: string; changedJointCount: number }; contactComparison: { id: string; status: string; delta: number }[]; alternatives: { name: string; candidateFingerprint: string; comparison: { status: string }; contactComparison: { status: string }[]; identicalTo?: string }[]; recipe: AnimationRecipe } }).result;
    assert.equal(evaluation.status, 'sampled');
    assert.equal(evaluation.rigSignature, 'fixture-rig-v1');
    assert.match(evaluation.next, /motion_pose_sequence_preview.*motion_studio_open_candidate.*capture_preflight.*inspect every PNG.*do not claim AI visual review/i);
    assert.ok(evaluation.studio && evaluation.structural);
    assert.equal(evaluation.comparison.status, 'available');
    assert.equal(evaluation.comparison.changedJointCount, 1);
    assert.equal(evaluation.contactComparison[0]?.id, 'declared-contact-0');
    assert.equal(evaluation.contactComparison[0]?.status, 'worsened');
    assert.ok(evaluation.contactComparison[0]!.delta > 0);
    const evaluationSamples = sampledRecipes.slice(firstEvaluationSampleIndex);
    assert.equal(evaluationSamples.length, 3, 'evaluation samples source once and each distinct candidate once');
    assert.equal(evaluationSamples[0]!.assetId, parent.id, 'source baseline must be sampled first');
    assert.ok(evaluationSamples[1]!.recipe.tracks[0]?.keys.some(key => key.time === 0.5), 'candidate must be sampled second');
    assert.ok(evaluationSamples[2]!.recipe.tracks[0]?.keys.some(key => key.time === 0.75), 'alternative must be sampled after primary');
    assert.equal(evaluation.alternatives[0]?.name, 'later pose');
    assert.equal(evaluation.alternatives[0]?.comparison.status, 'available');
    assert.equal(evaluation.alternatives[0]?.contactComparison[0]?.status, 'worsened');
    assert.equal(evaluation.alternatives[1]?.identicalTo, 'primary', 'identical alternatives should reuse sampled evidence');
    assert.equal(evaluation.alternatives[1]?.candidateFingerprint, evaluation.candidateFingerprint);
    assert.ok(evaluation.recipe.tracks.find(track => track.joint === 'UpperTorso')?.keys.some(key => key.time === 0.5));
    assert.ok(sampledRecipes.some(sample => sample.assetId !== parent.id && sample.recipe.tracks[0]?.keys.some(key => key.time === 0.5)),
      'Studio must sample the exact unsaved pose-sequence candidate, not the source animation');
    const libraryAfterEvaluation = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryAfterEvaluation.structuredContent as { result: { total: number } }).result.total,
      (libraryBeforeEvaluation.structuredContent as { result: { total: number } }).result.total, 'evaluation must not create a persistent animation revision');
    const beforeRigChange = sampledRecipes.length;
    changeSignatureOnNextSample = true;
    const changedRigEvaluation = await client.callTool({ name: 'motion_pose_sequence_evaluate', arguments: { sessionId, rigId, animationAssetId: parent.id,
      placements: [{ poseId, time: 0.5 }] } });
    assert.equal(changedRigEvaluation.isError, true, 'a topology change between samples must reject the combined evaluation');
    assert.match(JSON.stringify(changedRigEvaluation), /topology changed during comparison/i);
    assert.ok(sampledRecipes.length <= beforeRigChange + 2, 'a changed-rig evaluation must not run beyond the paired samples');
    rigSignature = 'fixture-rig-v1';
    const phaseGuardPreview = await client.callTool({ name: 'motion_animation_patch', arguments: {
      assetId: parent.id, dryRun: true, operations: [{ operation: 'retime_clip', duration: 2 }],
      preserve: [{ joint: 'UpperTorso', phase: { label: 'recovery' } }],
    } });
    assert.ok(!phaseGuardPreview.isError, JSON.stringify(phaseGuardPreview));
    const guarded = (phaseGuardPreview.structuredContent as { result: { dryRun: boolean; preservation: { verificationMethod: string; sourceStartTime: number; sourceEndTime: number; candidateStartTime: number; candidateEndTime: number; maxPositionDrift: number }[] } }).result;
    assert.equal(guarded.dryRun, true);
    assert.equal(guarded.preservation[0]!.verificationMethod, 'sampled_normalized_phase_progress');
    assert.equal(guarded.preservation[0]!.sourceStartTime, 0.8);
    assert.equal(guarded.preservation[0]!.candidateStartTime, 1.6);
    assert.equal(guarded.preservation[0]!.candidateEndTime, 2);
    assert.equal(guarded.preservation[0]!.maxPositionDrift, 0);
    rigSignature = 'fixture-rig-v1';
    changeSignatureOnNextSample = true;
    const changedRig = await client.callTool({ name: 'motion_animation_compare', arguments: { sessionId, rigId, parentAssetId: parent.id, candidateAssetId: candidate.id } });
    assert.equal(changedRig.isError, true);
    assert.match(JSON.stringify(changedRig), /topology changed during comparison/i);
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('MCP contact-contract builder samples the active rig and returns explicit baseline-plus-margin gates', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-contact-contract-mcp-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'contact-baseline-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const animation = animationPreset('walk', 'Contact baseline', 2, 1);
  animation.loop = false;
  animation.tracks = [{ joint: 'LeftFoot', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0.1, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  ] }];
  animation.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 }];
  const baseline = await library.save(animation);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'contact-contract-builder-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    queue.complete(sessionId, job.id, true, {
      version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'contact contract fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'LeftFoot', parent: 1, driven: true, foot: true }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [time / 10, 0, 0]], pivotPoints: [[0, 0, 0], [time / 10, 0, 0]], bottoms: [0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] })),
    });
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_animation_contact_contract_build', arguments: { sessionId, rigId, assetId: baseline.id,
      contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, allowedDriftIncreaseStuds: 0.05,
        allowedTravelIncreaseStuds: 0.1, allowedStepSpeedIncreaseStudsPerSecond: 0.2, minSamples: 3, maxSampleGapSeconds: 0.5 }] } });
    assert.ok(!result.isError, JSON.stringify(result));
    const built = (result.structuredContent as { result: { testCase: { assetId: string; contacts: { maxDriftStuds: number; maxCumulativeTravelStuds: number; maxStepSpeedStudsPerSecond: number }[] }; baseline: { fingerprint: string; rigSignature: string; contacts: { driftStuds: number; worstSegment: { startSampleId: string; endSampleId: string } }[] } } }).result;
    assert.equal(built.testCase.assetId, baseline.id);
    assert.ok(Math.abs(built.testCase.contacts[0]!.maxDriftStuds - 0.15) < 1e-9);
    assert.ok(Math.abs(built.testCase.contacts[0]!.maxCumulativeTravelStuds - 0.2) < 1e-9);
    assert.ok(Math.abs(built.testCase.contacts[0]!.maxStepSpeedStudsPerSecond - 0.3) < 1e-9);
    assert.equal(built.baseline.fingerprint.length, 64);
    assert.equal(built.baseline.rigSignature, rigSignature);
    assert.ok(Math.abs(built.baseline.contacts[0]!.driftStuds - 0.1) < 1e-9);
    assert.ok(built.baseline.contacts[0]!.worstSegment.startSampleId && built.baseline.contacts[0]!.worstSegment.endSampleId);
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('MCP contact repair context revalidates pinned runs and returns fresh same-rig effector samples', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-contact-repair-context-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'repair-context-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const baselineRecipe = animationPreset('walk', 'Planted baseline', 2, 1);
  baselineRecipe.loop = false;
  baselineRecipe.tracks = [{ joint: 'LeftFoot', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  baselineRecipe.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 }];
  const baseline = await library.save(baselineRecipe);
  const candidate = await library.save({ ...baselineRecipe, name: 'Planted candidate' }, baseline.id);
  const plans = new AnimationTestPlanLibrary(join(root, 'artifacts', 'animation-test-plans'), join(root, 'artifacts', 'animation-test-runs'), library);
  const contact = { effector: 'LeftFoot', kind: 'support' as const, start: 0.5, end: 1.5, maxDriftStuds: 0.2,
    maxStepSpeedStudsPerSecond: 0.03, minSamples: 3, maxSampleGapSeconds: 0.25 };
  const parentPlan = await plans.create('Planted foot regression', [{ assetId: baseline.id, contacts: [contact] }]);
  const childPlan = await plans.create('Planted foot regression', [{ assetId: candidate.id, contacts: [contact] }], parentPlan.id);
  const checkId = 'contact:LeftFoot:1:step-speed';
  const record = (plan: typeof parentPlan, assetId: string, speed: number, failed: boolean) => plans.recordRun({
    planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId, rigSignature,
    status: failed ? 'failed' : 'passed', summary: { requested: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, incomplete: 0 },
    results: [{ assetId, fingerprint: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe), status: failed ? 'failed' : 'passed', checks: [
      { id: 'asset_fingerprint', status: 'passed', detail: 'Pinned recipe matches.', observed: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe), expected: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe) },
      { id: 'contact:LeftFoot:1', status: 'passed', detail: 'Drift remains within threshold.', observed: 0.01, expected: 0.2, unit: 'studs', sampleIds: ['s001', 's002', 's003'] },
      { id: checkId, status: failed ? 'failed' : 'passed', detail: 'Adjacent step speed measured.', observed: speed, expected: 0.03, unit: 'studs/second',
        sampleIds: ['s001', 's002'], segment: { startTime: 0.5, endTime: 0.75, startSampleId: 's001', endSampleId: 's002', displacementStuds: speed * 0.25 } },
    ] }],
  });
  const baselineRun = await record(parentPlan, baseline.id, 0.02, false);
  const candidateRun = await record(childPlan, candidate.id, 0.04, true);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'contact-repair-context-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    const scale = payload.recipe.name === 'Planted baseline' ? 100 : 25;
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'contact repair-context fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'LeftFoot', parent: 1, driven: true, foot: true }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [time / scale, 0, 0]], pivotPoints: [[0, 0, 0], [time / scale, 0, 0]], bottoms: [0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] })),
    });
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_animation_contact_repair_context', arguments: {
      parentPlanId: parentPlan.id, childPlanId: childPlan.id, baselineRunId: baselineRun.id, candidateRunId: candidateRun.id,
      candidateAssetId: candidate.id, checkId, sessionId, rigId,
    } });
    assert.ok(!result.isError, JSON.stringify(result));
    const context = (result.structuredContent as { result: { checkId: string; rigSignature: string; criterion: { effector: string; start: number; end: number };
      historicalComparison: { classification: string; baselineRunId: string; candidateRunId: string; baselineObserved: number; candidateObserved: number; candidateSegment: { startSampleId: string; endSampleId: string } };
      freshEvaluation: { source: string; baseline: { status: string; observed: number; expected: number; unit: string; sampleIds: string[]; contractStatus: string };
        candidate: { status: string; observed: number; expected: number; unit: string; sampleIds: string[]; segment: { startSampleId: string; endSampleId: string; startTime: number; endTime: number; displacementStuds: number }; contractStatus: string } };
      baseline: { fingerprint: string; contactEvidence: { joint: string; samples: { sampleId: string; time: number; groundRelativePosition: number[] }[] } };
      candidate: { assetId: string; fingerprint: string; contactEvidence: { joint: string; samples: { sampleId: string; time: number; groundRelativePosition: number[]; pivotLocalPosition?: number[]; soleGroundOffset?: number }[] } };
      next: string } }).result;
    assert.equal(context.checkId, checkId);
    assert.equal(context.rigSignature, rigSignature);
    assert.deepEqual(context.criterion, contact);
    assert.equal(context.historicalComparison.classification, 'regression');
    assert.equal(context.historicalComparison.baselineRunId, baselineRun.id);
    assert.equal(context.historicalComparison.candidateRunId, candidateRun.id);
    assert.equal(context.historicalComparison.baselineObserved, 0.02);
    assert.equal(context.historicalComparison.candidateObserved, 0.04);
    assert.deepEqual(context.historicalComparison.candidateSegment, { startSampleId: 's001', endSampleId: 's002', startTime: 0.5, endTime: 0.75, displacementStuds: 0.01 });
    assert.equal(context.freshEvaluation.source, 'fresh_studio_samples');
    assert.ok(Math.abs(context.freshEvaluation.baseline.observed - 0.01) < 1e-9);
    assert.equal(context.freshEvaluation.baseline.status, 'passed');
    assert.equal(context.freshEvaluation.baseline.contractStatus, 'passed');
    assert.ok(Math.abs(context.freshEvaluation.candidate.observed - 0.04) < 1e-9);
    assert.equal(context.freshEvaluation.candidate.status, 'failed');
    assert.equal(context.freshEvaluation.candidate.contractStatus, 'failed');
    assert.equal(context.freshEvaluation.candidate.sampleIds.length, 2);
    assert.deepEqual(context.freshEvaluation.candidate.sampleIds, [context.freshEvaluation.candidate.segment.startSampleId, context.freshEvaluation.candidate.segment.endSampleId]);
    assert.ok(context.candidate.contactEvidence.samples.some(sample => sample.sampleId === context.freshEvaluation.candidate.segment.startSampleId));
    assert.ok(context.candidate.contactEvidence.samples.some(sample => sample.sampleId === context.freshEvaluation.candidate.segment.endSampleId));
    assert.ok(Math.abs(context.freshEvaluation.candidate.segment.displacementStuds / (context.freshEvaluation.candidate.segment.endTime - context.freshEvaluation.candidate.segment.startTime) - context.freshEvaluation.candidate.observed) < 1e-9);
    assert.equal(context.baseline.fingerprint, fingerprint(baseline.recipe));
    assert.equal(context.candidate.fingerprint, fingerprint(candidate.recipe));
    assert.match(context.next, new RegExp(`motion_library_read.*${candidate.id}.*${fingerprint(candidate.recipe)}.*motion_animation_candidate_patch_preview.*expectedSourceFingerprint=${fingerprint(candidate.recipe)}.*sessionId=${sessionId}.*rigId=${rigId}`));
    assert.match(context.next, /historicalComparison is historical only.*same-rig source-versus-candidate measurements.*preview saves nothing.*do not force a contact lock or invent a tolerance/i);
    assert.match(context.next, new RegExp(`motion_animation_candidate_patch_commit.*parentAssetId=${candidate.id}.*userApproved=true`));
    assert.equal(context.baseline.contactEvidence.joint, 'LeftFoot');
    assert.equal(context.candidate.contactEvidence.joint, 'LeftFoot');
    assert.ok(context.candidate.contactEvidence.samples.length >= 3);
    assert.ok(context.candidate.contactEvidence.samples.every(sample => sample.time >= 0.5 && sample.time <= 1.5 && sample.pivotLocalPosition && sample.soleGroundOffset === 0));
    assert.ok(context.candidate.contactEvidence.samples.at(-1)!.groundRelativePosition[0]! > context.baseline.contactEvidence.samples.at(-1)!.groundRelativePosition[0]!);
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('MCP repair context returns fresh same-rig joint-pivot evidence for bend-plane regressions', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-bend-repair-context-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'bend-repair-context-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const baselineRecipe = animationPreset('walk', 'Bend baseline', 2, 1);
  baselineRecipe.loop = false;
  baselineRecipe.tracks = ['UpperArm', 'LowerArm', 'Hand'].map(joint => ({ joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 2, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] }));
  const baseline = await library.save(baselineRecipe);
  const candidate = await library.save({ ...baselineRecipe, name: 'Bend candidate' }, baseline.id);
  const plans = new AnimationTestPlanLibrary(join(root, 'artifacts', 'animation-test-plans'), join(root, 'artifacts', 'animation-test-runs'), library);
  const bendPlane = { rootJoint: 'UpperArm', middleJoint: 'LowerArm', effector: 'Hand', start: 0.5, end: 1.5,
    poleTarget: [0, 1, 0] as [number, number, number], maxDeviationDegrees: 30, minSamples: 3, maxSampleGapSeconds: 0.25 };
  const parentPlan = await plans.create('Bend-side regression', [{ assetId: baseline.id, bendPlanes: [bendPlane] }]);
  const childPlan = await plans.create('Bend-side regression', [{ assetId: candidate.id, bendPlanes: [bendPlane] }], parentPlan.id);
  const checkId = 'bend-plane:Hand:1';
  const record = (plan: typeof parentPlan, assetId: string, observed: number, failed: boolean) => plans.recordRun({
    planId: plan.id, planRevision: plan.revision, runAt: new Date().toISOString(), rigId, rigSignature,
    status: failed ? 'failed' : 'passed', summary: { requested: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, incomplete: 0 },
    results: [{ assetId, fingerprint: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe), status: failed ? 'failed' : 'passed', checks: [
      { id: 'asset_fingerprint', status: 'passed', detail: 'Pinned recipe matches.', observed: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe), expected: fingerprint(assetId === baseline.id ? baseline.recipe : candidate.recipe) },
      { id: checkId, status: failed ? 'failed' : 'passed', detail: 'Bend plane measured.', observed, expected: 30, unit: 'degrees', sampleIds: ['s001', 's002', 's003'] },
    ] }],
  });
  const baselineRun = await record(parentPlan, baseline.id, 0, false);
  const candidateRun = await record(childPlan, candidate.id, 180, true);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'bend-repair-context-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    const bend = payload.recipe.name === 'Bend baseline' ? 1 : -1;
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'bend repair-context fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'UpperArm', parent: 1, driven: true, foot: false },
        { name: 'LowerArm', parent: 2, driven: true, foot: false }, { name: 'Hand', parent: 3, driven: true, foot: false }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]], pivotPoints: [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]],
        jointPoints: [[0, 0, 0], [0, 0, 0], [1, bend, 0], [2, 0, 0]], bottoms: [0, 0, 0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]] })),
    });
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_animation_contact_repair_context', arguments: {
      parentPlanId: parentPlan.id, childPlanId: childPlan.id, baselineRunId: baselineRun.id, candidateRunId: candidateRun.id,
      candidateAssetId: candidate.id, checkId, sessionId, rigId,
    } });
    assert.ok(!result.isError, JSON.stringify(result));
    const context = (result.structuredContent as { result: { criterion: { rootJoint: string; middleJoint: string; effector: string };
      freshEvaluation: { baseline: { status: string }; candidate: { status: string } };
      baseline: { bendPlaneEvidence: { joints: { root: string; middle: string; effector: string }; samples: { sampleId: string; deviationDegrees: number | null }[] } };
      candidate: { bendPlaneEvidence: { samples: { sampleId: string; deviationDegrees: number | null }[] } } } }).result;
    assert.deepEqual(context.criterion, bendPlane);
    assert.equal(context.freshEvaluation.baseline.status, 'passed');
    assert.equal(context.freshEvaluation.candidate.status, 'failed');
    assert.deepEqual(context.baseline.bendPlaneEvidence.joints, { root: 'UpperArm', middle: 'LowerArm', effector: 'Hand' });
    assert.ok(context.baseline.bendPlaneEvidence.samples.length >= bendPlane.minSamples);
    assert.ok(context.baseline.bendPlaneEvidence.samples.every(sample => sample.deviationDegrees !== null && sample.deviationDegrees < 1e-6));
    assert.ok(context.candidate.bendPlaneEvidence.samples.every(sample => sample.deviationDegrees !== null && sample.deviationDegrees > 179.99));
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

test('MCP batch animation audit samples multiple clips on one unchanged rig and preserves per-clip evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-batch-audit-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'batch-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const first = await library.save(animationPreset('cast', 'Batch Cast', 2, 1));
  const secondRecipe = animationPreset('slash', 'Batch Slash', 2, 1);
  secondRecipe.contacts = [{ effector: 'RightUpperArm', kind: 'grip', start: 0.321, end: 0.987 }];
  const second = await library.save(secondRecipe);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'batch-audit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let trackingSuiteQueue = false, pendingSuiteSamples = 0, maxPendingSuiteSamples = 0, bendWindowTimes: number[] = [], contactWindowTimes: number[] = [], omittedSampleTime: number | undefined;
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (targetSessionId, operation, payload) => {
    const job = enqueue(targetSessionId, operation, payload);
    if (trackingSuiteQueue && operation === 'sample_animation') {
      pendingSuiteSamples++;
      maxPendingSuiteSamples = Math.max(maxPendingSuiteSamples, pendingSuiteSamples);
    }
    return job;
  };
  const complete = queue.complete.bind(queue);
  queue.complete = (targetSessionId, jobId, ok, result) => {
    const job = queue.get(jobId);
    complete(targetSessionId, jobId, ok, result);
    if (trackingSuiteQueue && job.operation === 'sample_animation' && job.status === 'running') pendingSuiteSamples--;
  };
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { rigId: string; assetId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] };
    if (trackingSuiteQueue && payload.assetId === first.id) bendWindowTimes = payload.times;
    if (trackingSuiteQueue && payload.assetId === second.id) contactWindowTimes = payload.times;
    const drivenNames = [...new Set([...payload.recipe.tracks.map(track => track.joint), ...(payload.recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint))])];
    const nodes = [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, ...drivenNames.map(name => ({ name, parent: 0, driven: true, foot: name.toLowerCase().includes('foot') }))];
    const samples = payload.times.filter(time => omittedSampleTime === undefined || Math.abs(time - omittedSampleTime) > 1e-12).map((time, index) => ({
      id: `s${String(index).padStart(3, '0')}`, time, points: nodes.map((_, nodeIndex) => [0, nodeIndex, 0]), pivotPoints: nodes.map((_, nodeIndex) => [0, nodeIndex, 0]),
      bottoms: nodes.map(() => 0), orientations: nodes.map(() => [0, 0, 0, 1]),
    }));
    queue.complete(sessionId, job.id, true, {
      version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId, rigSignature: payload.rigSignature, assetId: payload.assetId,
      duration: payload.recipe.duration, loop: payload.recipe.loop, height: 5, groundSource: 'rest_node_bounds', note: 'batch fixture',
      nodes,
      restPose: { points: nodes.map((_, nodeIndex) => [0, nodeIndex, 0]), orientations: nodes.map(() => [0, 0, 0, 1]) }, samples,
    });
  }, 2);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const suggestionResult = await client.callTool({ name: 'motion_animation_test_case_suggest', arguments: { assetId: first.id, motionMode: 'stationary', planName: 'Suggested batch gate' } });
    assert.ok(!suggestionResult.isError, JSON.stringify(suggestionResult));
    const suggestion = (suggestionResult.structuredContent as { result: { currentFingerprint: string; testCase: { duration: { min: number; max: number }; loop: boolean; requiredTracks: string[] }; contactReviewCandidates: unknown[]; planPreview: { willWrite: boolean; draftFingerprint: string; review: { currentFingerprint: string }[] } } }).result;
    assert.match(suggestion.currentFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(suggestion.testCase.duration, { min: 2, max: 2 });
    assert.equal(suggestion.testCase.loop, false);
    assert.ok(suggestion.testCase.requiredTracks.length > 0);
    assert.deepEqual(suggestion.contactReviewCandidates, []);
    assert.equal(suggestion.planPreview.willWrite, false);
    assert.match(suggestion.planPreview.draftFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(suggestion.planPreview.review[0]!.currentFingerprint, suggestion.currentFingerprint);
    const invalidChildSuggestion = await client.callTool({ name: 'motion_animation_test_case_suggest', arguments: { assetId: first.id, parentPlanId: randomUUID() } });
    assert.ok(invalidChildSuggestion.isError);
    assert.match(JSON.stringify(invalidChildSuggestion), /planName is required/i);
    const capturePlanResult = await client.callTool({ name: 'motion_studio_capture_plan', arguments: { assetId: first.id, views: ['front', 'side'], maxFrames: 8 } });
    assert.ok(!capturePlanResult.isError, JSON.stringify(capturePlanResult));
    const capturePlan = (capturePlanResult.structuredContent as { result: { animationFingerprint: string; frames: { time: number; view: string }[] } }).result;
    assert.match(capturePlan.animationFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(capturePlan.frames.length, 8);
    const inlineDraft = animationPreset('cast', 'Unsaved visual plan draft', 1.7, 1);
    const draftPlanResult = await client.callTool({ name: 'motion_studio_capture_candidate_plan', arguments: { recipe: inlineDraft, views: ['front', 'side'], maxFrames: 8 } });
    assert.ok(!draftPlanResult.isError, JSON.stringify(draftPlanResult));
    const draftPlan = (draftPlanResult.structuredContent as { result: { candidateFingerprint: string; frames: { time: number; view: string }[]; moments: { time: number; reasons: string[] }[]; limitation: string } }).result;
    assert.equal(draftPlan.candidateFingerprint, fingerprint(inlineDraft));
    assert.equal(draftPlan.frames.length, 8);
    assert.ok(draftPlan.frames.every(frame => frame.time >= 0 && frame.time <= inlineDraft.duration && ['front', 'side'].includes(frame.view)));
    assert.ok(draftPlan.moments.some(moment => moment.reasons.some(reason => reason.startsWith('phase_'))));
    assert.match(draftPlan.limitation, /does not know camera framing/i);
    const comparisonAlternative = animationPreset('cast', 'Unsaved comparison alternative', 1.7, 1);
    comparisonAlternative.markers = [{ name: 'Release', time: 1.1 }];
    comparisonAlternative.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.65, end: 0.9 }];
    const comparisonPlanResult = await client.callTool({ name: 'motion_studio_capture_candidate_comparison_plan', arguments: {
      candidates: [{ label: 'Original', recipe: inlineDraft }, { label: 'Alternative', recipe: comparisonAlternative }], views: ['side'], maxFrames: 4,
    } });
    assert.ok(!comparisonPlanResult.isError, JSON.stringify(comparisonPlanResult));
    const comparisonPlan = (comparisonPlanResult.structuredContent as { result: { candidates: { label: string; candidateFingerprint: string }[]; frames: { time: number; view: string }[];
      moments: { time: number; contributions: { candidateLabel: string; reasons: string[] }[] }[]; timingAlignment: { status: string; warnings: string[] }; limitation: string } }).result;
    assert.deepEqual(comparisonPlan.candidates.map(candidate => candidate.label), ['Original', 'Alternative']);
    assert.equal(comparisonPlan.frames.length, 4);
    assert.ok(comparisonPlan.frames.every(frame => frame.view === 'side'));
    assert.equal(comparisonPlan.frames[0]!.time, 0);
    assert.equal(comparisonPlan.frames.at(-1)!.time, inlineDraft.duration);
    assert.ok(comparisonPlan.moments.some(moment => moment.contributions.some(item => item.candidateLabel === 'Alternative' && item.reasons.some(reason => reason.startsWith('contact_')))));
    assert.equal(comparisonPlan.timingAlignment.status, 'semantic_mismatch');
    assert.ok(comparisonPlan.timingAlignment.warnings.some(warning => warning.includes('different semantic beats')));
    assert.match(comparisonPlan.limitation, /may miss candidate-specific events/i);
    assert.equal((await library.list()).total, 2, 'planning an inline visual review must not save the candidate');
    const staleCapture = await client.callTool({ name: 'motion_studio_capture_views', arguments: { sessionId, rigId, assetId: first.id,
      expectedFingerprint: '0'.repeat(64), frames: capturePlan.frames } });
    assert.ok(staleCapture.isError);
    assert.match(JSON.stringify(staleCapture), /changed after capture planning/i);
    const result = await client.callTool({ name: 'motion_animation_batch_audit', arguments: { sessionId, rigId, assetIds: [first.id, second.id], motionMode: 'stationary' } });
    assert.ok(!result.isError, JSON.stringify(result));
    const batch = (result.structuredContent as { result: { status: string; summary: { requested: number; sampled: number; failed: number; possibleIssue: number; unknown: number; note: number; structuralChecks: number }; clips: { status: string; assetId: string; structural: { summary: { tracks: number } }; studio: { source: string } }[] } }).result;
    assert.equal(batch.status, 'sampled');
    assert.equal(batch.summary.requested, 2);
    assert.equal(batch.summary.sampled, 2);
    assert.equal(batch.summary.failed, 0);
    assert.ok(batch.summary.possibleIssue >= 0 && batch.summary.unknown >= 0 && batch.summary.structuralChecks >= 0);
    assert.equal(batch.clips.length, 2);
    assert.deepEqual(batch.clips.map(clip => clip.assetId), [first.id, second.id]);
    assert.ok(batch.clips.every(clip => clip.status === 'sampled' && clip.structural.summary.tracks > 0 && clip.studio.source === 'studio_pose_evaluator'));

    trackingSuiteQueue = true;
    const suite = await client.callTool({ name: 'motion_animation_test_suite', arguments: { sessionId, rigId, testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'], maxPeakAngularSpeedDegreesPerSecond: 10000,
      bendPlanes: [{ rootJoint: 'HumanoidRootPart', middleJoint: 'LeftUpperArm', effector: 'RightUpperArm', start: 0.35, end: 0.85,
      poleTarget: [0, 2, 0], maxDeviationDegrees: 15, maxSampleGapSeconds: 0.15 }],
    }, { assetId: second.id, loop: false, contacts: [{ effector: 'RightUpperArm', kind: 'grip', start: 0.321, end: 0.987,
      maxDriftStuds: 0.1, maxSampleGapSeconds: 0.07 }] }] } });
    trackingSuiteQueue = false;
    assert.ok(!suite.isError, JSON.stringify(suite));
    const suiteResult = (suite.structuredContent as { result: { status: string; summary: { requested: number; passed: number; failed: number; incomplete: number };
      results: { assetId: string; checks: { id: string; status: string; sampleIds?: string[] }[];
        samplingEvidence: { status: string; requiredWindows: { start: number; end: number; maxSampleGapSeconds: number }[];
          plannedSampleTimes: number[] | null; verifiedSampleTimes: number[] } }[] } }).result;
    assert.equal(suiteResult.status, 'failed', 'the declared chain must fail because the fixture reports arm siblings rather than the required hierarchy');
    assert.deepEqual(suiteResult.summary, { requested: 2, passed: 1, failed: 1, incomplete: 0 });
    assert.equal(maxPendingSuiteSamples, 1, 'the single Studio viewport should receive no more than one outstanding suite sample');
    assert.ok(suiteResult.results[0]!.checks.length >= 6);
    assert.equal(suiteResult.results[0]!.checks.find(check => check.id === 'bend-plane:RightUpperArm:1')?.status, 'failed');
    const denseWindowTimes = bendWindowTimes.filter(time => time >= 0.35 - 1e-6 && time <= 0.85 + 1e-6);
    assert.equal(denseWindowTimes[0], 0.35);
    assert.equal(denseWindowTimes.at(-1), 0.85);
    assert.ok(denseWindowTimes.slice(1).every((time, index) => time - denseWindowTimes[index]! <= 0.15 + 1e-6));
    const contactWindowSamples = contactWindowTimes.filter(time => time >= 0.321 - 1e-9 && time <= 0.987 + 1e-9);
    assert.equal(contactWindowSamples[0], 0.321);
    assert.equal(contactWindowSamples.at(-1), 0.987);
    assert.ok(contactWindowSamples.some(time => Math.abs(time - 0.654) <= 1e-12), 'the exact contact midpoint must be sampled');
    assert.ok(contactWindowSamples.slice(1).every((time, index) => time - contactWindowSamples[index]! <= 0.07 + 1e-9));
    const contactResult = suiteResult.results.find(result => result.assetId === second.id)!;
    assert.equal(contactResult.checks.find(check => check.id === 'contact:RightUpperArm:1')?.status, 'passed');
    assert.equal(contactResult.samplingEvidence.status, 'complete');
    assert.deepEqual(contactResult.samplingEvidence.plannedSampleTimes, contactResult.samplingEvidence.verifiedSampleTimes);
    assert.equal(contactResult.samplingEvidence.requiredWindows[0]?.maxSampleGapSeconds, 0.07);

    omittedSampleTime = 0.654;
    trackingSuiteQueue = true;
    const partialSuite = await client.callTool({ name: 'motion_animation_test_suite', arguments: { sessionId, rigId, testCases: [{
      assetId: second.id, contacts: [{ effector: 'RightUpperArm', kind: 'grip', start: 0.321, end: 0.987, maxDriftStuds: 0.1, maxSampleGapSeconds: 0.07 }],
    }] } });
    trackingSuiteQueue = false;
    omittedSampleTime = undefined;
    assert.ok(!partialSuite.isError, JSON.stringify(partialSuite));
    const partialResult = (partialSuite.structuredContent as { result: { status: string; results: { status: string; samplingError: string;
      samplingEvidence: { status: string; plannedSampleTimes: number[]; verifiedSampleTimes: number[]; detail: string } }[] } }).result;
    assert.equal(partialResult.status, 'incomplete');
    assert.equal(partialResult.results[0]!.samplingEvidence.status, 'incomplete');
    assert.ok(partialResult.results[0]!.samplingEvidence.plannedSampleTimes.some(time => Math.abs(time - 0.654) <= 1e-12));
    assert.deepEqual(partialResult.results[0]!.samplingEvidence.verifiedSampleTimes, [], 'partial schedules must not be presented as verified telemetry');
    assert.match(partialResult.results[0]!.samplingEvidence.detail, /expected 0\.65/i);
    assert.match(partialResult.results[0]!.samplingEvidence.detail, /received 0\.666667/i);

    const proposedPlan = await client.callTool({ name: 'motion_animation_test_plan_preview', arguments: { name: 'Batch animation gate', testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'],
    }] } });
    assert.ok(!proposedPlan.isError, JSON.stringify(proposedPlan));
    const proposal = (proposedPlan.structuredContent as { result: { willWrite: boolean; draftFingerprint: string; cases: unknown[]; review: { currentFingerprint: string; declaredCheckIds: string[] }[] } }).result;
    assert.equal(proposal.willWrite, false);
    assert.match(proposal.draftFingerprint, /^[0-9a-f]{64}$/);
    assert.match(proposal.review[0]!.currentFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(proposal.review[0]!.declaredCheckIds.includes('track:LeftUpperArm'));
    const createdPlan = await client.callTool({ name: 'motion_animation_test_plan_create', arguments: { name: 'Batch animation gate', expectedDraftFingerprint: proposal.draftFingerprint, testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'],
    }] } });
    assert.ok(!createdPlan.isError, JSON.stringify(createdPlan));
    const plan = (createdPlan.structuredContent as { result: { id: string; revision: number; cases: { expectedFingerprint: string }[] } }).result;
    assert.equal(plan.revision, 1);
    assert.match(plan.cases[0]!.expectedFingerprint, /^[0-9a-f]{64}$/);
    const planRetry = await client.callTool({ name: 'motion_animation_test_plan_create', arguments: { name: 'Batch animation gate', expectedDraftFingerprint: proposal.draftFingerprint, testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'],
    }] } });
    assert.ok(!planRetry.isError, JSON.stringify(planRetry));
    assert.equal((planRetry.structuredContent as { result: { id: string } }).result.id, plan.id, 'retry should return the existing immutable plan');
    const planRun = await client.callTool({ name: 'motion_animation_test_plan_run', arguments: { planId: plan.id, sessionId, rigId } });
    assert.ok(!planRun.isError, JSON.stringify(planRun));
    const planRunResult = (planRun.structuredContent as { result: { status: string; persistedRunId: string; testPlan: { id: string; revision: number } } }).result;
    assert.equal(planRunResult.status, 'passed');
    assert.equal(planRunResult.testPlan.id, plan.id);
    assert.equal(planRunResult.testPlan.revision, 1);
    const history = await client.callTool({ name: 'motion_animation_test_plan_history', arguments: { planId: plan.id } });
    assert.ok(!history.isError, JSON.stringify(history));
    const historyResult = (history.structuredContent as { result: { total: number; runs: { id: string; rigSignature: string }[] } }).result;
    assert.equal(historyResult.total, 1);
    assert.equal(historyResult.runs[0]!.id, planRunResult.persistedRunId);
    assert.equal(historyResult.runs[0]!.rigSignature, rigSignature);

    const animationPath = join(root, 'artifacts', 'library', `${first.id}.json`);
    const externallyChanged = JSON.parse(await readFile(animationPath, 'utf8')) as typeof first;
    externallyChanged.recipe.name = 'Changed after the test plan was pinned';
    await writeFile(animationPath, JSON.stringify(externallyChanged, null, 2));
    const stalePlanRun = await client.callTool({ name: 'motion_animation_test_plan_run', arguments: { planId: plan.id, sessionId, rigId } });
    assert.ok(!stalePlanRun.isError, JSON.stringify(stalePlanRun));
    const stalePlanResult = (stalePlanRun.structuredContent as { result: { status: string; persistedRunId: string; results: { samplingSkipped?: string }[] } }).result;
    assert.equal(stalePlanResult.status, 'failed');
    assert.match(stalePlanResult.results[0]!.samplingSkipped ?? '', /fingerprint mismatch/i);
    const staleHistory = await client.callTool({ name: 'motion_animation_test_plan_history', arguments: { planId: plan.id } });
    const staleHistoryResult = (staleHistory.structuredContent as { result: { total: number; runs: { status: string }[] } }).result;
    assert.equal(staleHistoryResult.total, 2);
    assert.equal(staleHistoryResult.runs[0]!.status, 'failed');

    const childProposalResult = await client.callTool({ name: 'motion_animation_test_plan_preview', arguments: { name: 'Batch animation gate', parentPlanId: plan.id, testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'],
    }] } });
    assert.ok(!childProposalResult.isError, JSON.stringify(childProposalResult));
    const childProposal = (childProposalResult.structuredContent as { result: { draftFingerprint: string } }).result;
    const childPlanResult = await client.callTool({ name: 'motion_animation_test_plan_create', arguments: { name: 'Batch animation gate', parentPlanId: plan.id, expectedDraftFingerprint: childProposal.draftFingerprint, testCases: [{
      assetId: first.id, loop: false, duration: { min: 2, max: 2 }, requiredMarkers: ['release'], requiredTracks: ['LeftUpperArm'],
    }] } });
    assert.ok(!childPlanResult.isError, JSON.stringify(childPlanResult));
    const childPlan = (childPlanResult.structuredContent as { result: { id: string; revision: number } }).result;
    assert.equal(childPlan.revision, 2);
    const childRunResult = await client.callTool({ name: 'motion_animation_test_plan_run', arguments: { planId: childPlan.id, sessionId, rigId } });
    assert.ok(!childRunResult.isError, JSON.stringify(childRunResult));
    const childRun = (childRunResult.structuredContent as { result: { status: string; persistedRunId: string } }).result;
    assert.equal(childRun.status, 'passed');
    const comparison = await client.callTool({ name: 'motion_animation_test_plan_compare', arguments: { parentPlanId: plan.id, childPlanId: childPlan.id, baselineRunId: stalePlanResult.persistedRunId, candidateRunId: childRun.persistedRunId } });
    assert.ok(!comparison.isError, JSON.stringify(comparison));
    const comparisonResult = (comparison.structuredContent as { result: { summary: { improvements: number; regressions: number }; rigSignature: string } }).result;
    assert.ok(comparisonResult.summary.improvements > 0);
    assert.equal(comparisonResult.summary.regressions, 0);
    assert.equal(comparisonResult.rigSignature, rigSignature);

    const staleBaseline = await client.callTool({ name: 'motion_animation_test_suite', arguments: { sessionId, rigId, testCases: [{
      assetId: first.id, expectedFingerprint: '0'.repeat(64), loop: false,
    }] } });
    assert.ok(!staleBaseline.isError, JSON.stringify(staleBaseline));
    const staleResult = (staleBaseline.structuredContent as { result: { status: string; results: { status: string; samplingSkipped: string; checks: { id: string; status: string }[] }[] } }).result;
    assert.equal(staleResult.status, 'failed');
    assert.match(staleResult.results[0]!.samplingSkipped, /fingerprint mismatch/i);
    assert.equal(staleResult.results[0]!.checks.find(check => check.id === 'asset_fingerprint')?.status, 'failed');

    const duplicateIds = await client.callTool({ name: 'motion_animation_batch_audit', arguments: { sessionId, rigId, assetIds: [first.id, first.id] } });
    assert.equal(duplicateIds.isError, true);
    const tooMany = await client.callTool({ name: 'motion_animation_batch_audit', arguments: { sessionId, rigId, assetIds: Array.from({ length: 9 }, () => randomUUID()) } });
    assert.equal(tooMany.isError, true);
  } finally {
    clearInterval(poller);
    await client.close();
    await server.close();
  }
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

test('MCP gait compiler validates the inspected rig and fingerprint-guards an idempotent animation commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-gait-mcp-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'gait-target-r15-v1';
  const jointMap = { leftHip: 'LeftUpperLeg', rightHip: 'RightUpperLeg', leftFoot: 'LeftFoot', rightFoot: 'RightFoot',
    leftKnee: 'LeftLowerLeg', rightKnee: 'RightLowerLeg', leftAnkle: 'LeftFoot', rightAnkle: 'RightFoot',
    leftArm: 'LeftUpperArm', rightArm: 'RightUpperArm', torso: 'UpperTorso' };
  const parents = new Map([['LeftUpperLeg', 'HumanoidRootPart'], ['LeftLowerLeg', 'LeftUpperLeg'], ['LeftFoot', 'LeftLowerLeg'],
    ['RightUpperLeg', 'HumanoidRootPart'], ['RightLowerLeg', 'RightUpperLeg'], ['RightFoot', 'RightLowerLeg']]);
  const profile = { version: 1, rigId, rigName: 'Gait fixture R15', rigType: 'R15' as const, rigSignature,
    joints: [{ name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      ...[...new Set(Object.values(jointMap))].map(name => ({ name, parent: parents.get(name) ?? 'HumanoidRootPart', driven: true,
        basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: name.endsWith('UpperLeg') ? 1 : 2 }))] };
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const inspection = queue.enqueue(sessionId, 'inspect', { rigId });
  assert.equal(queue.poll(sessionId)?.id, inspection.id);
  queue.complete(sessionId, inspection.id, true, { id: rigId, retargetProfile: profile });
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'gait-compiler-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const gaitInput = { name: 'MCP Walk Cycle', duration: 2, cycles: 2, style: 'walk', strideReachRatio: 0.3, jointMap, sessionId, rigId };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invalidJoint = await client.callTool({ name: 'motion_animation_gait_preview', arguments: { ...gaitInput, jointMap: { ...jointMap, leftHip: 'NotDriven' } } });
    assert.equal(invalidJoint.isError, true);
    assert.match(JSON.stringify(invalidJoint), /not driven by the inspected rig/);

    const preview = await client.callTool({ name: 'motion_animation_gait_preview', arguments: gaitInput });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const candidate = (preview.structuredContent as { result: { candidateFingerprint: string; recipe: { loop: boolean; contacts: unknown[] }; rigEvidence: { rigSignature: string }; diagnostics: { generatedKeyCount: number; strideCalibration: { measuredLegLengthStuds: { left: number | null }; estimatedHalfStrideReachStuds: { left: number | null } } } } }).result;
    assert.match(candidate.candidateFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(candidate.recipe.loop, true);
    assert.equal(candidate.recipe.contacts.length, 5);
    assert.equal(candidate.rigEvidence.rigSignature, rigSignature);
    assert.equal(candidate.diagnostics.generatedKeyCount, 9 * 33);
    assert.equal(candidate.diagnostics.strideCalibration.measuredLegLengthStuds.left, 5);
    assert.equal(candidate.diagnostics.strideCalibration.estimatedHalfStrideReachStuds.left, 1.5);

    const changedDraft = await client.callTool({ name: 'motion_animation_gait_commit', arguments: { ...gaitInput, strideReachRatio: 0.31, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.equal(changedDraft.isError, true);
    assert.match(JSON.stringify(changedDraft), /differs from its reviewed preview/);

    const committed = await client.callTool({ name: 'motion_animation_gait_commit', arguments: { ...gaitInput, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.ok(!committed.isError, JSON.stringify(committed));
    const saved = (committed.structuredContent as { result: { assetId: string; sourceRigId: string; sourceRigSignature: string } }).result;
    assert.equal(saved.sourceRigId, rigId);
    assert.equal(saved.sourceRigSignature, rigSignature);
    const repeated = await client.callTool({ name: 'motion_animation_gait_commit', arguments: { ...gaitInput, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.equal((repeated.structuredContent as { result: { assetId: string } }).result.assetId, saved.assetId);

    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'changed-topology' } });
    const staleRig = await client.callTool({ name: 'motion_animation_gait_commit', arguments: { ...gaitInput, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.equal(staleRig.isError, true);
    assert.match(JSON.stringify(staleRig), /changed after inspection/i);
  } finally { await client.close(); await server.close(); }
});

test('MCP returns checksum-verified review screenshots as images and rejects foreign or tampered evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-review-image-mcp-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const connections = new Connections(join(root, '.local', 'providers.json'));
  const reviewDirectory = join(root, 'artifacts', 'reviews');
  const reviews = new Reviews(reviewDirectory, library, queue, connections);
  const asset = await library.save(animationPreset('idle', 'Review image fixture', 2, 1));
  const started = await reviews.start({ assetId: asset.id, preview: false, aiReview: false });
  let review = started;
  for (let attempt = 0; attempt < 50 && review.status === 'inspecting'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    review = await reviews.read(started.id);
  }
  assert.equal(review.status, 'needs_feedback');
  review = await reviews.attach({ reviewId: review.id, revision: review.revision, view: 'front', time: 0.5,
    pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=' });
  const imageMetadata = review.images[0]!;
  review = await reviews.attach({ reviewId: review.id, revision: review.revision, view: 'side', time: 1,
    pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' });
  const secondImageMetadata = review.images[1]!;
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  const client = new Client({ name: 'review-image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'motion_review_read_image', arguments: { reviewId: review.id, imageId: imageMetadata.id } });
    assert.ok(!result.isError, JSON.stringify(result));
    const imageBlock = (result.content as ({ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string })[])
      .find(block => block.type === 'image');
    assert.ok(imageBlock && imageBlock.type === 'image');
    const singleImageContent = result.content as ({ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string })[];
    assert.equal(singleImageContent.findIndex(block => block.type === 'text') < singleImageContent.findIndex(block => block.type === 'image'), true,
      'identity guidance must arrive before the screenshot it qualifies');
    assert.match(singleImageContent.find(block => block.type === 'text')?.type === 'text'
      ? singleImageContent.find(block => block.type === 'text')!.text : '', /"recipeIdentity":\{"status":"unbound_user_image","eligibleForCritique":true\}/);
    assert.equal(imageBlock.mimeType, 'image/png');
    assert.equal(imageBlock.data, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=');
    const singlePixelSignal = (result.structuredContent as { result: { reviewId: string; revision: number; image: { id: string };
      recipeIdentity: { status: string; eligibleForCritique: boolean };
      pixelSignal: { sampledPixelCount: number; warnings: string[]; limitation: string }; checksumVerified: boolean } }).result;
    assert.deepEqual(singlePixelSignal, { reviewId: review.id, revision: review.revision, image: imageMetadata,
      recipeIdentity: { status: 'unbound_user_image', eligibleForCritique: true },
      pixelSignal: { sampledPixelCount: 1, distinctColorBuckets: 1, dominantColorShare: 1, luminanceStandardDeviation: 0,
        transparentPixelShare: 1, warnings: [], limitation: 'Pixel statistics flag only extreme uniformity/transparency. They do not establish correct framing, visible anatomy, pose quality, contact, deformation, or animation intent; inspect the actual PNG.' },
      checksumVerified: true });

    const reviewRead = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id } });
    assert.ok(!reviewRead.isError, JSON.stringify(reviewRead));
    const reviewReadResult = (reviewRead.structuredContent as { result: { visualEvidenceNext: string; next: string; visualEvidenceAudit: {
      status: string; assessedImageIds: string[]; unassessedImageIds: string[]; images: { id: string; assessmentStatus: string; pixelSignalGuidance: string }[]; limitations: string[] } } }).result;
    assert.match(reviewReadResult.visualEvidenceNext,
      /motion_review_read_images.*inspect every returned PNG/i);
    assert.match(reviewReadResult.next, /motion_review_read_images.*inspect every returned PNG.*motion_review_critique/i,
      'the primary next action must inspect eligible screenshots before requesting critique');
    assert.match(reviewReadResult.next, new RegExp(`revision=${review.revision}`),
      'the critique handoff must use the exact screenshot-read revision');
    assert.doesNotMatch(reviewReadResult.next, /Ask the user what to keep and change/,
      'unassessed screenshots must not be handed off as if visual review were already complete');
    assert.equal(reviewReadResult.visualEvidenceAudit.status, 'awaiting_visual_critique');
    assert.deepEqual(reviewReadResult.visualEvidenceAudit.assessedImageIds, []);
    assert.deepEqual(reviewReadResult.visualEvidenceAudit.unassessedImageIds.sort(), [imageMetadata.id, secondImageMetadata.id].sort());
    assert.ok(reviewReadResult.visualEvidenceAudit.images.every(image => image.assessmentStatus === 'not_yet_assessed'));
    assert.ok(reviewReadResult.visualEvidenceAudit.images.every(image => image.pixelSignalGuidance === 'no_extreme_warning_does_not_prove_legibility'));
    assert.ok(reviewReadResult.visualEvidenceAudit.limitations.length > 0);
    const images = await client.callTool({ name: 'motion_review_read_images', arguments: {
      reviewId: review.id, imageIds: [imageMetadata.id, secondImageMetadata.id],
    } });
    assert.ok(!images.isError, JSON.stringify(images));
    const imageResult = (images.structuredContent as { result: { status: string; reviewId: string; revision: number; imageCount: number;
      images: { image: { id: string; view: string; sha256: string }; pixelSignal: { warnings: string[] };
        checksumVerified: boolean; visualReviewTemplate: { reviewId: string; revision: number; imageId: string; pixelSignal: { warnings: string[] };
          recipeIdentity: { status: string; eligibleForCritique: boolean }; observationShape: { imageId: string } } }[] } }).result;
    assert.equal(imageResult.status, 'complete');
    assert.equal(imageResult.reviewId, review.id);
    assert.equal(imageResult.revision, review.revision);
    assert.equal(imageResult.imageCount, 2);
    assert.ok(imageResult.images.every(entry => entry.pixelSignal.warnings.length === 0
      && entry.visualReviewTemplate.pixelSignal.warnings.length === 0
      && entry.visualReviewTemplate.recipeIdentity.status === 'unbound_user_image'
      && entry.visualReviewTemplate.recipeIdentity.eligibleForCritique));
    assert.deepEqual(imageResult.images.map(entry => [entry.visualReviewTemplate.reviewId, entry.visualReviewTemplate.revision, entry.image.id, entry.visualReviewTemplate.imageId,
      entry.visualReviewTemplate.observationShape.imageId, entry.checksumVerified]),
    [[review.id, review.revision, imageMetadata.id, imageMetadata.id, imageMetadata.id, true],
      [review.id, review.revision, secondImageMetadata.id, secondImageMetadata.id, secondImageMetadata.id, true]]);
    const imageBlocks = images.content as { type: string; text?: string; data?: string }[];
    assert.equal(imageBlocks.filter(block => block.type === 'image').length, 2);
    const blockIndexes = imageBlocks.flatMap((block, index) => block.type === 'image' ? [index] : []);
    for (const [index, blockIndex] of blockIndexes.entries()) {
      assert.equal(imageBlocks[blockIndex - 1]?.type, 'text');
      assert.match(imageBlocks[blockIndex - 1]?.text ?? '', new RegExp(imageResult.images[index]!.image.id));
    }
    const oversizedImages = await client.callTool({ name: 'motion_review_read_images', arguments: {
      reviewId: review.id, imageIds: [imageMetadata.id, secondImageMetadata.id], maxBytes: 1,
    } });
    assert.equal((oversizedImages.structuredContent as { result: { status: string; reviewId: string; revision: number; imageCount: number } }).result.status, 'over_budget');
    assert.equal((oversizedImages.structuredContent as { result: { reviewId: string; revision: number } }).result.reviewId, review.id);
    assert.equal((oversizedImages.structuredContent as { result: { revision: number } }).result.revision, review.revision);
    assert.equal((oversizedImages.structuredContent as { result: { imageCount: number } }).result.imageCount, 0);
    assert.equal((oversizedImages.content as { type: string }[]).some(block => block.type === 'image'), false);

    const foreignImage = await client.callTool({ name: 'motion_review_read_image', arguments: { reviewId: review.id, imageId: randomUUID() } });
    assert.equal(foreignImage.isError, true);
    assert.match(JSON.stringify(foreignImage), /does not belong to the requested review/i);

    const imagePath = join(reviewDirectory, review.id, `${imageMetadata.id}.png`);
    const corrupted = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    corrupted[corrupted.length - 1] = corrupted.at(-1)! ^ 1;
    await writeFile(imagePath, corrupted);
    const tamperedImage = await client.callTool({ name: 'motion_review_read_image', arguments: { reviewId: review.id, imageId: imageMetadata.id } });
    assert.equal(tamperedImage.isError, true);
    assert.match(JSON.stringify(tamperedImage), /screenshot changed/i);
    const tamperedBatch = await client.callTool({ name: 'motion_review_read_images', arguments: {
      reviewId: review.id, imageIds: [imageMetadata.id, secondImageMetadata.id],
    } });
    assert.equal((tamperedBatch.structuredContent as { result: { status: string; imageCount: number; imageReadFailure: { imageId: string } } }).result.status, 'image_read_failed');
    assert.equal((tamperedBatch.structuredContent as { result: { imageCount: number } }).result.imageCount, 0);
    assert.equal((tamperedBatch.content as { type: string }[]).some(block => block.type === 'image'), false,
      'a checksum failure must not return a misleading partial screenshot set');
  } finally {
    await client.close();
    await server.close();
    reviews.close();
  }
});

test('MCP attaches a manual PNG as an unbound review reference without impersonating a Studio capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-manual-review-image-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const connections = new Connections(join(root, '.local', 'providers.json'));
  const reviews = new Reviews(join(root, 'artifacts', 'reviews'), library, queue, connections);
  const asset = await library.save(animationPreset('idle', 'Manual screenshot reference', 2, 1));
  const started = await reviews.start({ assetId: asset.id, preview: false, aiReview: false });
  let review = started;
  for (let attempt = 0; attempt < 50 && review.status === 'inspecting'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    review = await reviews.read(started.id);
  }
  assert.equal(review.status, 'needs_feedback');
  const imagePath = join(root, 'manual-reference.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64'));
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  const client = new Client({ name: 'manual-review-image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const attached = await client.callTool({ name: 'motion_review_attach_manual_image', arguments: {
      reviewId: review.id, revision: review.revision, view: 'front', time: 0.5, imagePath,
    } });
    assert.ok(!attached.isError, JSON.stringify(attached));
    const attachedResult = (attached.structuredContent as { result: ReviewRecord & {
      visualCaptureCoverage: { status: string; plannedFrameCount: number; coveredFrameCount: number };
      visualEvidenceAudit: { images: { id: string; recipeIdentityStatus: string; eligibleForCritique: boolean }[] };
      next: string;
    } }).result;
    const attachedReview = attachedResult;
    assert.equal(attachedReview.revision, review.revision + 1);
    assert.equal(attachedReview.images.length, 1);
    assert.equal(attachedReview.images[0]?.captureBinding, undefined);
    assert.equal(attachedResult.visualCaptureCoverage.status, 'not_requested');
    assert.equal(attachedResult.visualCaptureCoverage.plannedFrameCount, 0);
    assert.deepEqual(attachedResult.visualEvidenceAudit.images.map(image => [image.id, image.recipeIdentityStatus, image.eligibleForCritique]),
      [[attachedReview.images[0]!.id, 'unbound_user_image', true]]);
    assert.match(attachedResult.next, /reference target/i);
    assert.match(attachedResult.next, /not proof/i);
    const image = await client.callTool({ name: 'motion_review_read_image', arguments: {
      reviewId: review.id, imageId: attachedReview.images[0]!.id,
    } });
    assert.ok(!image.isError, JSON.stringify(image));
    const imageText = (image.content as ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[])
      .find(block => block.type === 'text');
    assert.ok(imageText?.type === 'text');
    assert.match(imageText.text, /"recipeIdentity":\{"status":"unbound_user_image","eligibleForCritique":true\}/);
    assert.match(imageText.text, /reference target|unbound/i);
  } finally { await client.close(); await server.close(); }
});

test('motion_review_read returns the pose evidence index when samples are requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-review-pose-index-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'pose-index-rig-v1';
  queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const fixtureRecipe = animationPreset('idle', 'Pose index fixture', 1, 1);
  fixtureRecipe.contacts = [{ effector: 'Torso', kind: 'support', start: 0.2, end: 0.8 }];
  for (const [trackIndex, track] of fixtureRecipe.tracks.entries()) track.keys = Array.from({ length: 120 }, (_, index) => ({
    time: index === 0 ? 0 : index === 119 ? 1 : index / 119 + trackIndex * 0.0002,
    position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  }));
  fixtureRecipe.markers = [{ name: 'Fast transition', time: 0.413 }];
  const asset = await library.save(fixtureRecipe);
  assert.equal(asset.recipe.kind, 'animation');
  if (asset.recipe.kind !== 'animation') throw new Error('Fixture requires an animation recipe.');
  const reviews = new Reviews(join(root, 'reviews'), library, queue, new Connections(join(root, '.local', 'providers.json')));
  const server = createMcp(library, queue, new Blender(root, 'blender'), reviews);
  const client = new Client({ name: 'review-pose-index-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const poller = setInterval(() => {
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = queue.poll(sessionId);
    if (!job || job.operation !== 'sample_animation') return;
    const payload = job.payload as { assetId: string; rigId: string; rigSignature?: string; recipe: AnimationRecipe; times: number[] };
    queue.complete(sessionId, job.id, true, { version: 1, source: 'studio_pose_evaluator', rigId: payload.rigId,
      rigSignature: payload.rigSignature, assetId: payload.assetId, duration: payload.recipe.duration, loop: payload.recipe.loop,
      height: 5, groundSource: 'rest_node_bounds', note: 'pose index fixture',
      nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false },
        { name: 'Torso', parent: 1, driven: true, foot: false, targetKind: 'Motor6D' }],
      samples: payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
        points: [[0, 0, 0], [0, 2, 0]], jointPoints: [[0, 0, 0], [0, 2, 0]],
        bottoms: [0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] })) });
  }, 5);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const started = await reviews.start({ assetId: asset.id, sessionId, rigId, preview: false });
    let review = started;
    for (let attempt = 0; attempt < 100 && review.status === 'inspecting'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      review = await reviews.read(started.id);
    }
    assert.equal(review.status, 'needs_feedback');
    const compactResponse = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id } });
    assert.ok(!compactResponse.isError, JSON.stringify(compactResponse));
    const compactResult = (compactResponse.structuredContent as { result: { telemetry?: unknown; poseSamplingCoverage: {
      unobservedMomentCount: number; unobservedUniqueTimestampCount: number;
      unobservedMoments: { timeSeconds: number; kind: string; name?: string }[];
      unobservedMomentPage: { offset: number; limit: number; totalUniqueTimestampCount: number; nextOffset: number | null; times: number[] };
      suggestedCaptureFrames: { time: number; view: string }[];
      suggestedEvaluationTimes: number[];
    }; declaredContactEvidence?: { coordinateFrame: string; pointSource: string; contacts: {
      effector: string; kind: string; status: string; sampleCount: number; maximumSampleGapSeconds: number;
      startBoundary: unknown; midpointBoundary: unknown; endBoundary: unknown; maxDriftFromFirstObservedStuds: number | null;
      cumulativePathLengthStuds: number | null; peakSampledSpeed: { studsPerSecond: number } | null;
      maxOrientationDriftDegrees: number | null; trace: { sampleId: string; time: number }[]; omittedTraceSampleCount: number;
    }[]; limitation: string }; declaredContactWindows?: { source: string; contacts: { contactIndex: number; effector: string; kind: string;
      startTime: number; endTime: number; evaluationStatus: string }[]; limitation: string }; recommendedActions: {
      id: string; tool?: string; preflightTool?: string; captureTool?: string; readiness: string;
      arguments?: { assetId: string; expectedFingerprint: string; targetTimes: number[]; includeTargetPoseEvidence: boolean };
      captureArguments?: { assetId: string; expectedFingerprint: string; frames: { time: number; view: string }[] };
      requiresExplicitStudioScreenshotPermission?: boolean; safety: string;
    }[]; next: string } }).result;
    assert.equal(compactResult.telemetry, undefined, 'default review reads must stay compact');
    assert.ok(compactResult.poseSamplingCoverage.unobservedMomentCount > 0);
    assert.ok(compactResult.declaredContactEvidence);
    assert.deepEqual(compactResult.declaredContactWindows?.contacts, [{ contactIndex: 0, effector: 'Torso', kind: 'support',
      startTime: 0.2, endTime: 0.8, evaluationStatus: 'sampled_full_window' }]);
    assert.match(compactResult.declaredContactWindows?.limitation ?? '', /author-declared contact intent.*does not prove visible or physical contact/i);
    assert.equal(compactResult.declaredContactEvidence.coordinateFrame, 'rig_pivot_space');
    assert.equal(compactResult.declaredContactEvidence.pointSource, 'joint_pivot_or_node_pivot');
    assert.equal(compactResult.declaredContactEvidence.contacts.length, 1);
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.effector, 'Torso');
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.kind, 'support');
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.status, 'sampled_full_window');
    assert.ok(compactResult.declaredContactEvidence.contacts[0]!.sampleCount >= 2);
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.maxDriftFromFirstObservedStuds, 0);
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.cumulativePathLengthStuds, 0);
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.peakSampledSpeed?.studsPerSecond, 0);
    assert.equal(compactResult.declaredContactEvidence.contacts[0]?.maxOrientationDriftDegrees, 0);
    assert.ok(compactResult.declaredContactEvidence.contacts[0]!.trace.length <= 24);
    assert.match(compactResult.declaredContactEvidence.limitation, /not prove visible or physical contact.*no allowable threshold is inferred/i);
    assert.equal(compactResult.poseSamplingCoverage.unobservedMomentPage.offset, 0);
    assert.equal(compactResult.poseSamplingCoverage.unobservedMomentPage.limit, 8);
    assert.equal(compactResult.poseSamplingCoverage.unobservedMomentPage.totalUniqueTimestampCount,
      compactResult.poseSamplingCoverage.unobservedUniqueTimestampCount);
    assert.ok(compactResult.poseSamplingCoverage.unobservedMomentPage.times.length <= 8);
    const evaluateAction = compactResult.recommendedActions.find(action => action.id === 'evaluate_omitted_pose_times');
    assert.ok(evaluateAction);
    assert.equal(evaluateAction.tool, 'motion_animation_candidate_evaluate');
    assert.equal(evaluateAction.readiness, 'ready_after_joint_map');
    assert.equal(evaluateAction.arguments?.assetId, asset.id);
    assert.equal(evaluateAction.arguments?.expectedFingerprint, review.assetHash);
    assert.deepEqual(evaluateAction.arguments?.targetTimes, compactResult.poseSamplingCoverage.suggestedEvaluationTimes);
    assert.equal(evaluateAction.arguments?.includeTargetPoseEvidence, true);
    assert.match(evaluateAction.safety, /Read-only.*does not apply, save, or export/i);
    const captureAction = compactResult.recommendedActions.find(action => action.id === 'capture_omitted_poses_for_ai_vision');
    assert.ok(captureAction);
    assert.equal(captureAction.preflightTool, 'motion_studio_capture_preflight');
    assert.equal(captureAction.captureTool, 'motion_studio_capture_views');
    assert.equal(captureAction.readiness, 'ready_after_preflight_and_user_permission');
    assert.deepEqual(captureAction.captureArguments?.frames, compactResult.poseSamplingCoverage.suggestedCaptureFrames);
    assert.equal(captureAction.captureArguments?.expectedFingerprint, review.assetHash);
    assert.equal(captureAction.requiresExplicitStudioScreenshotPermission, true);
    assert.match(captureAction.safety, /only after preflight is ready.*user grants permission/i);
    const pagedTimes = [...compactResult.poseSamplingCoverage.unobservedMomentPage.times];
    let foundOmittedMarker = compactResult.poseSamplingCoverage.unobservedMoments.some(moment => moment.kind === 'marker' && moment.name === 'Fast transition');
    let foundMarkerTimeInActions = foundOmittedMarker
      ? compactResult.recommendedActions.some(action => action.arguments?.targetTimes.includes(0.413)) : false;
    let nextOffset = compactResult.poseSamplingCoverage.unobservedMomentPage.nextOffset;
    let finalPage = compactResult.poseSamplingCoverage.unobservedMomentPage;
    for (let pageIndex = 0; nextOffset !== null && pageIndex < 100; pageIndex++) {
      const nextPageResponse = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id, omittedMomentOffset: nextOffset } });
      assert.ok(!nextPageResponse.isError, JSON.stringify(nextPageResponse));
      const nextPageResult = (nextPageResponse.structuredContent as { result: { poseSamplingCoverage: {
        unobservedMoments: { timeSeconds: number; kind: string; name?: string }[];
        unobservedMomentPage: { offset: number; limit: number; nextOffset: number | null; times: number[]; totalUniqueTimestampCount: number };
        suggestedEvaluationTimes: number[];
      }; recommendedActions: { id: string; arguments?: { targetTimes: number[] } }[] } }).result;
      finalPage = nextPageResult.poseSamplingCoverage.unobservedMomentPage;
      assert.equal(finalPage.offset, nextOffset);
      assert.equal(finalPage.totalUniqueTimestampCount, compactResult.poseSamplingCoverage.unobservedMomentPage.totalUniqueTimestampCount);
      assert.ok(finalPage.times.length > 0 && finalPage.times.length <= 8);
      assert.ok(finalPage.times.every(time => !pagedTimes.includes(time)), 'Omitted-time pages must not overlap.');
      pagedTimes.push(...finalPage.times);
      const pageHasOmittedMarker = nextPageResult.poseSamplingCoverage.unobservedMoments.some(moment => moment.kind === 'marker' && moment.name === 'Fast transition');
      foundOmittedMarker ||= pageHasOmittedMarker;
      foundMarkerTimeInActions ||= pageHasOmittedMarker
        && nextPageResult.recommendedActions.some(action => action.arguments?.targetTimes.includes(0.413));
      assert.deepEqual(nextPageResult.poseSamplingCoverage.suggestedEvaluationTimes, finalPage.times);
      assert.deepEqual(nextPageResult.recommendedActions.find(action => action.id === 'evaluate_omitted_pose_times')?.arguments?.targetTimes, finalPage.times);
      nextOffset = finalPage.nextOffset;
    }
    assert.equal(nextOffset, null, 'Pagination should terminate within the documented bound.');
    assert.equal(pagedTimes.length, compactResult.poseSamplingCoverage.unobservedMomentPage.totalUniqueTimestampCount);
    assert.equal(new Set(pagedTimes).size, pagedTimes.length);
    assert.ok(foundOmittedMarker, 'Later pages must preserve authored marker evidence rather than hiding it behind dense keyframes.');
    assert.ok(foundMarkerTimeInActions, 'The marker timestamp must have an exact-time recommended follow-up on its page.');
    const beyondLastPage = await client.callTool({ name: 'motion_review_read', arguments: {
      reviewId: review.id, omittedMomentOffset: finalPage.totalUniqueTimestampCount,
    } });
    assert.ok(beyondLastPage.isError, 'A null nextOffset must stop pagination rather than produce an empty action page.');
    clearInterval(poller);
    queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: 'different-active-rig' } });
    const staleTopologyResponse = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id } });
    assert.ok(!staleTopologyResponse.isError, JSON.stringify(staleTopologyResponse));
    const staleTopologyActions = (staleTopologyResponse.structuredContent as { result: { recommendedActions: { id: string; readiness: string }[] } })
      .result.recommendedActions;
    assert.equal(staleTopologyActions.find(action => action.id === 'evaluate_omitted_pose_times')?.readiness,
      'requires_matching_live_rig');
    assert.equal(staleTopologyActions.find(action => action.id === 'capture_omitted_poses_for_ai_vision')?.readiness,
      'requires_matching_live_rig');
    queue.heartbeat(sessionId, { activeRig: { id: randomUUID(), rigSignature: 'different-active-rig' } });
    const staleRigResponse = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id } });
    assert.ok(!staleRigResponse.isError, JSON.stringify(staleRigResponse));
    const staleRigActions = (staleRigResponse.structuredContent as { result: { recommendedActions: { id: string; readiness: string }[] } })
      .result.recommendedActions;
    assert.ok(staleRigActions.every(action => action.readiness === 'requires_matching_live_rig'));
    assert.match(compactResult.next, /unobserved, not proven smooth or correct/);
    assert.match(compactResult.next, /motion_animation_candidate_evaluate.*targetTimes=/);
    assert.match(compactResult.next, /motion_studio_capture_views/);
    const response = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: review.id, includeSamples: true } });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = (response.structuredContent as { result: { telemetry: { samples: { id: string; time: number }[] };
      poseEvidenceIndex: { sampleTimes: { sampleId: string; timeSeconds: number }[];
        nodeSlots: { slot: number; name: string; parentSlot: number | null; targetKind?: string }[]; nodeSlotLimitation: string;
        metricEvidence: { id: string; sampleIds: string[] }[] } } }).result;
    assert.equal(result.poseEvidenceIndex.sampleTimes.length, result.telemetry.samples.length);
    assert.deepEqual(result.poseEvidenceIndex.sampleTimes[3], { sampleId: result.telemetry.samples[3]!.id,
      timeSeconds: result.telemetry.samples[3]!.time, normalizedProgress: result.telemetry.samples[3]!.time / asset.recipe.duration });
    assert.deepEqual(result.poseEvidenceIndex.nodeSlots[1], { slot: 1, name: 'Torso', parentSlot: 0, driven: true, foot: false, targetKind: 'Motor6D' });
    assert.match(result.poseEvidenceIndex.nodeSlotLimitation, /driver object class.*not establish local axes.*skinning/i);
    assert.ok(result.poseEvidenceIndex.metricEvidence.some(metric => metric.id === 'body-rise'));
    const unsampledReview = await reviews.start({ assetId: asset.id, preview: false });
    const unsampledRead = await client.callTool({ name: 'motion_review_read', arguments: { reviewId: unsampledReview.id } });
    assert.ok(!unsampledRead.isError, JSON.stringify(unsampledRead));
    const unsampledResult = (unsampledRead.structuredContent as { result: { declaredContactWindows?: {
      contacts: { contactIndex: number; effector: string; kind: string; startTime: number; endTime: number; evaluationStatus: string }[];
      limitation: string; declaredContactEvidence?: unknown;
    } } }).result;
    assert.deepEqual(unsampledResult.declaredContactWindows?.contacts, [{ contactIndex: 0, effector: 'Torso', kind: 'support',
      startTime: 0.2, endTime: 0.8, evaluationStatus: 'not_sampled' }]);
    assert.equal(unsampledResult.declaredContactWindows?.declaredContactEvidence, undefined);
    assert.match(unsampledResult.declaredContactWindows?.limitation ?? '', /no Studio trajectory evidence is available/i);
  } finally {
    clearInterval(poller);
    await client.close(); await server.close(); reviews.close();
  }
});

test('real MCP stdio client discovers tools, authors revisions, and reports offline Studio honestly', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-mcp-'));
  const port = await freePort();
  const client = new Client({ name: 'motion-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/index.js')], env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), MOTION_PROJECT_ROOT: directory, MOTION_PORT: String(port) }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const agentInstructions = client.getInstructions() ?? '';
    assert.match(agentInstructions, /Preserve open animation recipe\/fingerprint and unsaved edits/i);
    assert.match(agentInstructions, /motion_studio_capture_editor_draft_views/);
    assert.match(agentInstructions, /motion_studio_apply_editor_candidate/);
    assert.match(agentInstructions, /Keep drafts unsaved until approval/i);
    assert.match(agentInstructions, /Telemetry isn't rendered vision/i,
      'the handoff must distinguish a human viewport preview from AI-visible rendered evidence');
    assert.match(agentInstructions, /Before export claims.*motion_studio_validate_animation_candidate.*motion_studio_validate_animation_export/s,
      'the agent must run native Roblox conversion on the exact recipe before claiming export readiness');
    assert.match(agentInstructions, /Conversion proves KeyframeSequence representability, not quality/i,
      'native conversion must not be presented as visual or gameplay validation');
    assert.match(agentInstructions, /Visual review: front\+side, maxFrames 8/i);
    assert.match(agentInstructions, /AI workflow pass requires exact-candidate Studio captures, reading every image via motion_workflow_read_evidence this run, and each passed requirement\/exclusion citing 2\+ whole-body times.*Unbound screenshots don't prove appearance/i,
      'shared guidance must prevent visual passes without exact candidate capture and image review');
    assert.match(agentInstructions, /Keep drafts unsaved until approval/i);
    assert.match(agentInstructions, /capturePlan\.omittedMomentSummary/i);
    assert.doesNotMatch(agentInstructions, /save the full recipe with motion_library_save\. Then call motion_studio_open_animation/i,
      'the agent handoff must not require persisting a draft before visual review');
    const tools = await client.listTools();
    const discoveredToolNames = tools.tools.map(tool => tool.name);
    assert.equal(new Set(discoveredToolNames).size, discoveredToolNames.length, 'MCP tool names must be unique');
    const workflowReviewTool = tools.tools.find(tool => tool.name === 'motion_workflow_review');
    assert.ok(workflowReviewTool);
    assert.match(workflowReviewTool.description ?? '', /all-pass AI animation review requires complete Studio captures bound to the exact candidate recipe, every candidate image returned by motion_workflow_read_evidence in the current server process, and each passed requirement\/exclusion citing whole-body captures at two or more distinct times.*unbound manual images.*unknown/i,
      'AI tool discovery must prevent unbound screenshots from supporting an all-pass animation review');
    const capabilityResult = await client.callTool({ name: 'motion_capabilities', arguments: {} });
    const capabilityCatalog = (capabilityResult.structuredContent as { result: { toolCatalog: { source: string; toolNames: string[] } } }).result.toolCatalog;
    assert.equal(capabilityCatalog.source, 'local_mcp_server_registration');
    assert.deepEqual(capabilityCatalog.toolNames, [...discoveredToolNames].sort(), 'capability catalog must match every locally registered MCP tool');
    const capabilityResultData = (capabilityResult.structuredContent as { result: { authoring: string[]; review: { features: string[] } } }).result;
    const authoringCapabilities = capabilityResultData.authoring;
    assert.match(authoringCapabilities.join(' '), /AI-first observe-act-verify workflow.*opening the viewport alone does not give the AI rendered evidence.*validate the exact recipe with Roblox Studio KeyframeSequence conversion.*save\/export only the exact fingerprint after explicit user approval/i,
      'capability discovery must explain the AI eyes, native export verification, and approval boundaries');
    assert.match(authoringCapabilities.join(' '), /caller supplies clip-spanning world-space hand\/foot waypoints.*coordinated non-mutating IK preview.*never invent poses or targets/i,
      'AI capability discovery must expose the grounded blueprint-to-IK workflow without implying autonomous target invention');
    assert.match(capabilityResultData.review.features.join(' '), /rendered-image retrieval for the connected MCP AI client without a separate Motion Tools critique-provider key/i,
      'the connected coding agent must be able to discover that it can inspect captures without a second model credential');
    assert.match(capabilityResultData.review.features.join(' '), /optional provider-backed image and pose critique using a separately configured API key/i,
      'provider-backed critique must remain clearly optional and separate from MCP image access');
    for (const toolName of ['motion_studio_capture_candidate_views', 'motion_studio_capture_editor_draft_views']) {
      const captureTool = tools.tools.find(tool => tool.name === toolName);
      assert.ok(captureTool);
      assert.match(captureTool.description ?? '', /eight-frame budget is divided across requested views/i);
      assert.match(captureTool.description ?? '', /phase-composed pose extrema/i);
      assert.match(captureTool.description ?? '', /disabled\/zero-weight layer peaks are excluded/i);
      assert.match(captureTool.description ?? '', /capturePlan\.omittedMomentSummary/i);
    }
    assert.ok(tools.tools.some(t => t.name === 'motion_ik_target_path_analyze'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_audit'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_audit_recipe'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_search_similar'));
    const reviewReadTool = tools.tools.find(t => t.name === 'motion_review_read');
    assert.match(reviewReadTool?.description ?? '', /poseEvidenceIndex.nodeSlots.*optional exact targetKind.*nodeSlotLimitation.*not establish local axes/i);
    const blueprintPreviewTool = tools.tools.find(t => t.name === 'motion_animation_blueprint_preview');
    assert.match(blueprintPreviewTool?.description ?? '', /jointPoseGuides.*exact parent.*targetKind.*Motor6D.*AnimationConstraint.*Bone.*not evidence of axes/i,
      'AI guidance must expose the same exact rig-driver context in authored pose guides');
    const similarityTool = tools.tools.find(t => t.name === 'motion_animation_search_similar');
    assert.ok(similarityTool?.description?.includes('mappingNextStep'));
    assert.ok(similarityTool?.description?.includes('retargetHandoff'));
    assert.ok(similarityTool?.description?.includes('targetRigNextStep'));
    const candidateEvaluateTool = tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate');
    assert.ok(candidateEvaluateTool?.description?.includes('retargetPreview'));
    assert.ok(candidateEvaluateTool?.description?.includes('non-identical recipe'));
    assert.match(candidateEvaluateTool?.description ?? '', /studioSampling.*exact evaluated times.*largest sample gap.*moments the schedule could not include/i,
      'AI guidance must expose the exact numeric inspection schedule and uncovered authored beats');
    assert.match(candidateEvaluateTool?.description ?? '', /spatialTrajectoryEvidence.*hierarchy-composed joint-pivot paths.*bounded to 12 trajectories.*retains sampled endpoints.*per-axis position extrema/i,
      'AI guidance must expose the bounded hierarchy-aware trajectory evidence and its limits');
    assert.match(candidateEvaluateTool?.description ?? '', /maximum sampled orientation drift in degrees.*peak angular speed in degrees per second.*exact sample interval.*sampled quaternions/i,
      'AI guidance must expose bounded, unit-labeled rotation measurements alongside position traces');
    assert.match(candidateEvaluateTool?.description ?? '', /omittedTrajectoryCount.*omittedJoints.*omittedJointListTruncatedCount/i,
      'AI guidance must identify which requested joints did not receive bounded spatial traces');
    assert.match(candidateEvaluateTool?.description ?? '', /exact `targetKind` driver class.*Motor6D.*AnimationConstraint.*Bone.*not establish axes.*Older telemetry may omit/i,
      'AI guidance must connect spatial evidence to rig driver classes without claiming anatomical or axis knowledge');
    assert.match(candidateEvaluateTool?.description ?? '', /declaredContactEvidence.*peak linear\/angular interval boundaries.*maximum orientation drift.*inspect traceSelection/i,
      'AI guidance must disclose which sampled contact slips and twists survive bounded trace reduction');
    const candidateComparisonTool = tools.tools.find(t => t.name === 'motion_animation_candidates_evaluate');
    assert.match(candidateComparisonTool?.description ?? '', /declared-contact improvement comparisons are coverage-gated.*exact start\/midpoint\/end.*candidate omits any source sample time.*denser candidate schedules/i,
      'AI guidance must prevent contact improvement claims from sparser candidate sampling');
    assert.ok(similarityTool?.description?.includes('motion_animation_suggest_joint_map'));
    assert.ok(similarityTool?.description?.includes('unmappedActiveCandidateJoints'));
    assert.ok(similarityTool?.description?.includes('unmappedInactiveCandidateJoints'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_reuse_evidence'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_compare'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_batch_audit'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_test_suite'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_test_case_suggest'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_test_plan_preview'));
    assert.match(tools.tools.find(t => t.name === 'motion_animation_test_plan_preview')?.description ?? '',
      /contact result is accepted only when Studio captured distinct exact start, midpoint, and end poses.*unknown even if count and gap limits pass/i,
      'AI guidance must explain exact-time contact evidence requirements');
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_contact_repair_context'));
    assert.match(tools.tools.find(t => t.name === 'motion_animation_test_plan_compare')?.description ?? '',
      /contact or bend-plane regression\/unresolved check.*motion_animation_contact_repair_context.*fresh same-rig evidence.*historical run values distinct/i,
      'plan comparisons should route failing declared-contact checks to fresh evidence without confusing it with history');
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_contact_contract_build'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_candidate_evaluate'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_candidates_evaluate'));
    const axisProbeTool = tools.tools.find(t => t.name === 'motion_studio_probe_joint_axes');
    assert.ok(axisProbeTool, 'agents must discover rig-specific measured axis response support');
    assert.match(axisProbeTool.description ?? '', /detached evaluator clone.*never saves or applies/i);
    const localRotationSuggestionTool = tools.tools.find(t => t.name === 'motion_studio_suggest_local_rotation');
    assert.ok(localRotationSuggestionTool, 'agents must discover the guarded preview-only local rotation solver');
    assert.match(localRotationSuggestionTool.description ?? '', /never edits.*refuses non-neutral.*weak\/asymmetric.*ill-conditioned/i);
    assert.match(tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate')?.description ?? '',
      /rig-signature-bound driven-joint coverage.*inactive layers separately/i);
    assert.match(tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate')?.description ?? '',
      /targetTimes.*mandatory.*128-sample limit/i);
    assert.match(tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate')?.description ?? '',
      /expectedFingerprint.*reject stale recipe content before Studio sampling/i);
    assert.match(tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate')?.description ?? '',
      /includeTargetPoseEvidence=true.*1–8 targetTimes.*poseEvidenceIndex.*not rendered appearance or semantic proof/i);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_candidate_evaluate')?.inputSchema),
      /fresh matching inspected rig profile.*name-based context, not observed anatomy or semantic proof/i);
    assert.match(tools.tools.find(t => t.name === 'motion_animation_candidates_evaluate')?.description ?? '',
      /each candidate.*exact rig-signature-bound driven-joint coverage/i);
    const animationAuditTool = tools.tools.find(tool => tool.name === 'motion_animation_audit');
    assert.ok(animationAuditTool);
    assert.match(animationAuditTool.description ?? '', /explicit `marker\.phase` metadata/);
    assert.match(animationAuditTool.description ?? '', /ordinary event named Impact, Release, or Cast/);
    assert.match(animationAuditTool.description ?? '', /Motion Tools-only and is not preserved by native Roblox keyframe markers/);
    assert.match(animationAuditTool.description ?? '', /fresh target-rig coverage.*unused joints are inspection cues, never failures/i);
    assert.match(animationAuditTool.description ?? '', /`semanticRoleCoverage` maps recognized body roles.*never a pose quota/i);
    assert.match(JSON.stringify(animationAuditTool.inputSchema), /sessionId.*rigId/);
    const blueprintTool = tools.tools.find(tool => tool.name === 'motion_animation_blueprint_preview');
    assert.ok(blueprintTool);
    assert.match(JSON.stringify(blueprintTool.inputSchema), /intent.*user-intended visible beat.*not converted into a Roblox marker/i,
      'MCP agents should discover that phase intent is explanatory metadata rather than a runtime event');
    assert.match(blueprintTool.description ?? '', /Recommended first structured authoring step for a new animation/i);
    assert.match(blueprintTool.description ?? '', /omitted position or rotation carries forward/i);
    assert.match(blueprintTool.description ?? '', /Generated clip-boundary keys hold the first\/last authored transform/i);
    assert.match(blueprintTool.description ?? '', /Easing belongs to the outgoing segment/i);
    assert.match(blueprintTool.description ?? '', /custom curve handles \(outTime\/outValue\/inTime\/inValue\).*preserved in the recipe and progression diagnostics/i,
      'MCP agents should discover that custom Bezier timing survives blueprint compilation');
    assert.match(blueprintTool.description ?? '', /do not commit merely because compilation succeeded/i);
    assert.match(blueprintTool.description ?? '', /plan action-specific silhouette beats/i);
    assert.match(blueprintTool.description ?? '', /coordinate proximal joints.*acting hand or foot/i);
    assert.match(blueprintTool.description ?? '', /There is no fixed pose count/i);
    assert.match(blueprintTool.description ?? '', /offline structural audit and bounded reviewFocus/i);
    assert.match(blueprintTool.description ?? '', /up to 32 chronological phase-local timing cues/i);
    assert.match(blueprintTool.description ?? '', /both phase-first and per-joint phase coverage/i);
    assert.match(blueprintTool.description ?? '', /not as a request to add keys/i);
    assert.match(blueprintTool.description ?? '', /not as a target number of poses/i);
    assert.match(blueprintTool.description ?? '', /rigValidation\.semanticRoleCoverage.*never a motion quota or quality verdict/i);
    assert.match(blueprintTool.description ?? '', /track presence does not prove the contact is held or visually achieved/i);
    assert.match(blueprintTool.description ?? '', /fingerprints include the Studio session ID/i);
    const blueprintSchema = JSON.stringify(blueprintTool.inputSchema);
    assert.match(blueprintSchema, /previous authored position/i);
    assert.match(blueprintSchema, /Outgoing interpolation for the segment/i);
    assert.match(blueprintSchema, /normalized cubic Bezier handles for the outgoing segment/i,
      'the structured pose schema should expose custom easing controls to MCP clients');
    const blueprintGoalTool = tools.tools.find(tool => tool.name === 'motion_animation_blueprint_goal_preview');
    assert.ok(blueprintGoalTool, 'goal-based phase authoring must be discoverable by MCP clients');
    assert.match(blueprintGoalTool.description ?? '', /Prefer this for a new action.*world-space hand\/foot waypoints/i);
    assert.match(blueprintGoalTool.description ?? '', /Never invent arbitrary world-space goals/i);
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_gait_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_gait_commit'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_open_candidate'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_read_editor_draft'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_apply_editor_candidate'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_capture_editor_draft_views'));
    const animationSuiteTool = tools.tools.find(tool => tool.name === 'motion_animation_test_suite');
    assert.ok(animationSuiteTool);
    assert.match(animationSuiteTool.description ?? '', /Contact and bend-plane windows both schedule exact boundaries.{1}midpoints plus enough intermediate poses for each declared maximum sample gap/i);
    assert.match(animationSuiteTool.description ?? '', /exact planned.{1}verified sample times.*skipped.{1}incomplete sampling record/i);
    assert.match(JSON.stringify(animationSuiteTool.inputSchema), /maxCumulativeTravelStuds/);
    assert.match(JSON.stringify(animationSuiteTool.inputSchema), /maxStepSpeedStudsPerSecond/);
    assert.ok(tools.tools.some(t => t.name === 'motion_review_start'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_read_image'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_read_images'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_read_comparison_images'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_critique'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_proposal_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_proposals_evaluate'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_attach_capture'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_attach_captures'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_validate_animation_export'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_import_animation_validate_export'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_validate_animation_export_batch'));
    for (const name of ['motion_animation_graph_preview', 'motion_animation_graph_create', 'motion_animation_graph_update', 'motion_animation_graph_read', 'motion_animation_graph_list', 'motion_animation_graph_evaluate_transition', 'motion_animation_graph_scenario_test', 'motion_animation_graph_timeline_simulate', 'motion_animation_graph_fade_calibrate', 'motion_animation_graph_fade_calibration_list', 'motion_animation_graph_fade_calibration_candidates', 'motion_animation_graph_fade_calibration_read', 'motion_animation_graph_timeline_test', 'motion_animation_graph_scenario_plan_preview', 'motion_animation_graph_scenario_plan_create', 'motion_animation_graph_scenario_plan_read', 'motion_animation_graph_scenario_plan_list', 'motion_animation_graph_scenario_plan_run', 'motion_animation_graph_scenario_plan_history', 'motion_animation_graph_scenario_plan_compare', 'motion_animation_graph_timeline_plan_preview', 'motion_animation_graph_timeline_plan_create', 'motion_animation_graph_timeline_plan_read', 'motion_animation_graph_timeline_plan_list', 'motion_animation_graph_timeline_plan_run', 'motion_animation_graph_timeline_plan_history', 'motion_animation_graph_timeline_plan_compare', 'motion_animation_graph_path_preview', 'motion_animation_graph_path_compile']) {
      assert.ok(tools.tools.some(tool => tool.name === name), `missing MCP graph tool ${name}`);
    }
    const fadeCalibrationTool = tools.tools.find(tool => tool.name === 'motion_animation_graph_fade_calibrate');
    assert.ok(fadeCalibrationTool);
    assert.match(fadeCalibrationTool.description ?? '', /invisible detached clone.*immutable local calibration records/i);
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_preview')?.description ?? '', /AnimationConstraint rigs/i,
      'the AI-facing temporal-plan contract must document native calibration support for attachment-driven rigs');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_run')?.description ?? '', /AnimationConstraint rigs/i,
      'the AI-facing temporal-plan runner must document native calibration support for attachment-driven rigs');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_preview')?.description ?? '', /does not validate Roblox Play\/Stop fade trajectories/i,
      'the AI-facing temporal-plan preview must distinguish fixed-weight pose checks from runtime fades');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_preview')?.description ?? '',
      /numeric parameter ramps.*authored and simulated time bounds.*potential overlapping update interruptions.*1D\/2D BlendSpace/i,
      'the AI-facing plan preview must document ramp and two-dimensional blend coverage');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_run')?.description ?? '', /AdjustWeight\(weight, 0\).*not Roblox Play\/Stop fade trajectories/i,
      'the AI-facing temporal-plan runner must disclose that fade behavior remains estimated');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_run')?.description ?? '',
      /Run and history responses include derived `next` prose and structured `nextAction` guidance.*track-snapshot mismatches direct reconciliation before retry.*historical runs without gate metadata are not mislabeled/i,
      'the AI-facing timeline runner must explain structured status-specific recovery and historical compatibility without mutating immutable history');
    const timelineSimulationTool = tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_simulate');
    assert.ok(timelineSimulationTool);
    assert.doesNotMatch(timelineSimulationTool.description ?? '', /Blend weights are independent linear envelopes/,
      'the AI-facing simulator contract must not contradict calibrated fade-curve support');
    assert.match(timelineSimulationTool.description ?? '', /Without matching calibration profiles.*independent linear envelopes.*matching profiles use their measured piecewise-linear curves/i,
      'the AI-facing simulator contract must distinguish its fallback from empirical fade curves');
    assert.match(timelineSimulationTool.description ?? '', /interrupted calibrated fade.*normalized measured curve shape is rebased.*fadeCalibrationRebased/i,
      'the AI-facing simulator contract must disclose how measured fade curves are adapted after interruption');
    assert.match(timelineSimulationTool.description ?? '', /includePoseSamples=false/);
    assert.match(timelineSimulationTool.description ?? '', /complete serialized response has an additional 8 MiB safety limit/i);
    assert.match(timelineSimulationTool.description ?? '', /4 MiB of serialized pose provenance/i);
    assert.match(timelineSimulationTool.description ?? '', /sampleRateHz overrides the graph’s uniform sample grid from 10–120 Hz.*leaves modeled events at exact timestamps.*10,000 blend-sample/i,
      'the AI-facing simulator must disclose its bounded denser sampling override and event-time behavior');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /maxPoseSampleGapSeconds.*includePoseSamples=true.*temporal coverage only/i,
      'the AI-facing simulator schema must expose a bounded pose-trace sampling-density gate and its limitation');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /includeBlendSamplePoses.*4 MiB serialized recipe-provenance limit.*8 MiB result limit/i,
      'the AI-facing simulator schema must document incremental pose-provenance and final-result byte limits');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /ramp_parameters.*smoothstep/i,
      'the AI-facing simulator schema must expose numeric parameter ramps and their easing choices');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /saved graph sample rate.*not the optional output observation rate.*final target is applied exactly when ramp completion falls within the simulation horizon.*If the horizon ends first, the ramp remains partial/i,
      'the AI-facing ramp contract must distinguish graph updates, observation sampling, and horizon-clipped ramps');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /Equal-time inputs retain authored order/i,
      'the AI-facing simulator schema must state the baseline ordering rule for tied authored inputs');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /cancel overlapping ramp channels/i,
      'the AI-facing simulator schema must explain ramp interruption behavior');
    assert.match(timelineSimulationTool.description ?? '', /includeBlendSamplePoses=true.*every generated blend sample/i,
      'the AI-facing simulator must explain full generated-timeline pose tracing');
    assert.match(timelineSimulationTool.description ?? '', /GetBlendState\(\)\.simulationTimingCalibration returns these exact maps.*assetSetFingerprint.*mismatches are rejected.*observed speeds and optional initial normalized phases/i,
      'the simulator contract must bind live lengths and speeds to the runtime snapshot and expected export assets');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_runtime_export')?.description ?? '',
      /simulationTimingCalibration emits complete observedBlendAnimationLengths and observedBlendAnimationPlaybackSpeeds.*assetSetFingerprint.*animationIdsByStateId/i,
      'the runtime export contract must document how to collect, fingerprint, and cross-check simulator-ready measurements');
    assert.match(timelineSimulationTool.description ?? '', /poseMotionDiagnostics reports.*finite-difference local translation and angular speed/i,
      'the AI-facing simulator must describe its sampled joint-motion diagnostics and their measurement basis');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /poseMotionDiagnostics.*translation acceleration.*change in sampled local velocity.*not continuous-time/i,
      'the AI-facing simulator schema must explain acceleration evidence and its sampled basis');
    assert.match(timelineSimulationTool.description ?? '', /analyzeEventOrderSensitivity=true.*two explicit deterministic policies diverge/i,
      'the AI-facing simulator must explain optional alternate callback-order sensitivity analysis');
    assert.match(timelineSimulationTool.description ?? '', /eventOrderingDiagnostics.*scheduled runtime marker\/AnimationEnded events and modeled natural-completion fade starts.*Roblox runtime callback ordering is not guaranteed/i,
      'the AI-facing simulator contract must disclose exact timestamp collisions and the deterministic ordering limitation');
    assert.match(timelineSimulationTool.description ?? '',
      /BlendSpace1D or BlendSpace2D.*ramp_parameters.*linear or smoothstep.*cancel only overlapping ramp channels.*sampled deterministic inputs/i,
      'the AI-facing simulator contract must explain blend-aware ramp behavior and its sampling limitation');
    assert.match(timelineSimulationTool.description ?? '', /naturalCompletionFadeSeconds.*explicit assumption.*not a Studio-measured natural-completion calibration.*AnimationTrack\.Ended/i,
      'the AI-facing simulator contract must disclose caller-supplied natural-completion fade assumptions');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_run')?.description ?? '',
      /Each case preserves eventOrderingDiagnostics and animationEndedTiming.*even when all assertions pass/i,
      'the AI-facing saved-plan runner must retain simulator caveats in passing case reports');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_preview')?.description ?? '',
      /maxAmbiguousEventOrderingCollisions.*previews show every pinned gate/i,
      'the AI-facing plan preview must disclose the opt-in event-order regression gate');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_compare')?.description ?? '',
      /eventOrdering diagnostics stability.*threshold direction \(tightened\/relaxed\) separately from outcome/i,
      'the AI-facing plan comparison must make event-order sensitivity changes explicit');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_compare')?.description ?? '',
      /full fingerprints.*repeated-Play probe evidence.*same profiles, changed profiles, and incomplete provenance/i,
      'the AI-facing plan comparison must explain calibration identity and incomplete evidence semantics');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_compare')?.description ?? '',
      /after-minus-before percentile deltas only when exact case\/joint coverage, rig, graph\/test contract, source content, Studio build and calibration protocol, joint mapping, and model provenance match/i,
      'the AI-facing plan comparison must disclose the comparability requirements for calibration error deltas');
    assert.match(tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_plan_compare')?.description ?? '',
      /median and 95th-percentile translation\/rotation model errors overall and by case\/joint.*fixed-weight poses/i,
      'the AI-facing comparison must explain whole-trace error distributions and their calibration scope');
    assert.match(timelineSimulationTool.description ?? '', /priorityLayers.*available budget before application.*remaining neutral\/lower-priority animation weight/i,
      'the AI-facing simulator contract must explain how each per-joint priority layer consumes weight');
    assert.match(timelineSimulationTool.description ?? '', /unavailableStateIds.*does not try a lower-priority fallback.*rolls back parameter updates/i,
      'the AI-facing simulator contract must describe atomic selected-destination load failures');
    assert.match(timelineSimulationTool.description ?? '', /incompleteParameterRamps.*progress.*remaining time.*current\/target values.*outOfWindowEvents/i,
      'the AI-facing simulator contract must distinguish active partial ramps from events that never ran');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /unavailableStateIds.*failing AnimationTrack loading/i,
      'known destination load failures must be an explicit simulator input');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /skip per-joint local pose composition/i,
      'the AI must see that weights-only mode avoids local-pose composition work');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /analyzeEventOrderSensitivity.*second deterministic simulation/i,
      'the AI must see the opt-in cost and semantics of alternate callback-order simulation');
    assert.match(JSON.stringify(timelineSimulationTool.inputSchema), /maxEventOrderDivergences.*pass\/fail gate.*Requires analyzeEventOrderSensitivity/i,
      'the AI must see the optional strict divergence gate and its prerequisite');
    const timelineTestTool = tools.tools.find(tool => tool.name === 'motion_animation_graph_timeline_test');
    assert.ok(timelineTestTool);
    assert.match(timelineSimulationTool.description ?? '', /parameterRampLifecycle.*per-channel active\/completed\/interrupted outcomes.*partially overridden multi-parameter ramps/i,
      'the simulation MCP contract must describe ramp completion and cancellation evidence');
    assert.match(JSON.stringify(timelineTestTool.inputSchema), /maxEventOrderDivergences.*Optional regression gate across final state.*callback.*tied timestamps/i,
      'saved temporal test plans must expose the persisted callback-order divergence gate');
    assert.match(JSON.stringify(timelineTestTool.inputSchema), /incompleteParameterRamps.*inputIndex.*simulatedProgress.*remainingSecondsAtHorizon/i,
      'saved temporal tests must expose parameter-ramp endpoint assertions to AI agents');
    assert.match(JSON.stringify(timelineTestTool.inputSchema), /parameterRampLifecycle.*partially_interrupted/i,
      'saved temporal tests must expose the partial-interruption lifecycle status to AI agents');
    assert.match(timelineTestTool.description ?? '', /parameterRampLifecycle.*active, completed, interrupted, or partially interrupted.*interruption\/completion times/i,
      'the temporal-test contract must explain lifecycle outcomes and per-channel timing gates');
    assert.match(timelineTestTool.description ?? '', /incompleteParameterRamps.*must still be active at the simulation horizon/i,
      'the AI-facing contract must explain that endpoint checks gate ramps active at the horizon');
    assert.match(JSON.stringify(timelineTestTool.inputSchema), /maxLinearSpeedStudsPerSecond.*maxAngularSpeedDegreesPerSecond.*maxLinearAccelerationStudsPerSecondSquared.*maxAngularAccelerationDegreesPerSecondSquared.*maxLinearStepStuds.*maxAngularStepDegrees/i,
      'saved temporal test plans must expose sampled local-motion speed, acceleration, and step gates');
    assert.match(JSON.stringify(timelineTestTool.inputSchema), /maxSampleGapSeconds.*maximum time between adjacent composed-pose samples.*temporal coverage, not motion accuracy/i,
      'saved temporal test plans must expose the per-window trace-density gate and distinguish it from accuracy');
    assert.match(timelineTestTool.description ?? '', /Motion gates can be used alone without a target pose.*finite-difference local-pose limits/i,
      'the AI-facing test contract must explain standalone speed/step gates and their sampled-local limitation');
    assert.match(timelineTestTool.description ?? '', /epsilon samples immediately before\/after authored key and transition\/fade boundaries.*quarter\/mid\/three-quarter probes inside authored key segments.*midpoint probes inside fades/i,
      'the AI-facing test contract must disclose extra bounded probes used for sampled speed and step gates');
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_validate_animation_candidate'));
    const candidateEvaluationTool = tools.tools.find(tool => tool.name === 'motion_animation_candidate_evaluate');
    assert.ok(candidateEvaluationTool);
    assert.match(candidateEvaluationTool.description ?? '', /recipeMotionTargets are not observed Studio measurements.*explicitly distinguishes criteria not requested/i,
      'AI tool discovery must explain signal diversity and distinguish omitted acceptance criteria');
    assert.match(candidateEvaluationTool.description ?? '', /exact-candidate handoff.*AI-visible screenshot capture.*job polling.*image retrieval/i,
      'AI tool discovery must explain how measured candidate evaluation leads to actual rendered evidence');
    const alternativesEvaluationTool = tools.tools.find(tool => tool.name === 'motion_animation_candidates_evaluate');
    assert.ok(alternativesEvaluationTool);
    assert.match(alternativesEvaluationTool.description ?? '', /signal-diverse reviewFocus summary.*criteria were not requested/i,
      'AI alternative-evaluation discovery must explain its review summary');
    assert.match(alternativesEvaluationTool.description ?? '', /matched-timestamp visual capture.*capture reader/i,
      'AI alternative-evaluation discovery must explain how to retrieve matched rendered comparisons');
    const findAnimationExportTool = tools.tools.find(t => t.name === 'motion_studio_find_animation_export');
    assert.ok(findAnimationExportTool);
    assert.match(JSON.stringify(findAnimationExportTool.description), /related_candidates/);
    assert.match(JSON.stringify(findAnimationExportTool.description), /matchesTruncated/);
    const nativeAnimationSaveTool = tools.tools.find(tool => tool.name === 'motion_studio_save_animation');
    assert.ok(nativeAnimationSaveTool);
    assert.match(JSON.stringify(nativeAnimationSaveTool.inputSchema), /expectedFingerprint/);
    assert.match(JSON.stringify(nativeAnimationSaveTool.inputSchema), /userApprovedFingerprint.*Must equal expectedFingerprint/);
    assert.match(JSON.stringify(nativeAnimationSaveTool.inputSchema), /expectedPreflightFingerprint/);
    assert.match(nativeAnimationSaveTool.description ?? '', /explicitly approves the exact asset revision.*caller attestation.*not independently authenticated/i);
    const editorApplyTool = tools.tools.find(tool => tool.name === 'motion_studio_apply_editor_candidate');
    assert.ok(editorApplyTool);
    assert.match(editorApplyTool.description ?? '', /unknown apply job.*read the current editor draft.*already applied.*expected base/i,
      'AI apply discovery must explain lost-ack reconciliation before a retry');
    assert.ok(tools.tools.some(t => t.name === 'motion_workflow_start'));
    assert.ok(tools.tools.some(t => t.name === 'motion_agent_resume'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_list'));
    assert.ok(tools.tools.some(t => t.name === 'motion_review_recover'));
    const capturePreflightTool = tools.tools.find(t => t.name === 'motion_studio_capture_preflight');
    assert.ok(capturePreflightTool);
    assert.match(JSON.stringify(capturePreflightTool.description), /does not take an image/i);
    const candidateCaptureReader = tools.tools.find(t => t.name === 'motion_studio_read_candidate_capture');
    assert.ok(candidateCaptureReader);
    assert.match(JSON.stringify(candidateCaptureReader.inputSchema), /intentAssetId/,
      'single-image review should optionally retrieve its saved original phase brief');
    assert.match(candidateCaptureReader.description ?? '', /motion_studio_capture_editor_draft_views/i);
    assert.match(candidateCaptureReader.description ?? '', /cite captureId\/time\/view.*only visible evidence/i,
      'AI image retrieval must explain evidence attribution and limits on visual claims');
    const candidateCaptureBatchReader = tools.tools.find(t => t.name === 'motion_studio_read_candidate_captures');
    assert.ok(candidateCaptureBatchReader);
    assert.match(JSON.stringify(candidateCaptureBatchReader.inputSchema), /intentAssetId/,
      'multi-image review should optionally retrieve its saved original phase brief');
    assert.match(candidateCaptureBatchReader.description ?? '', /1–8.*single MCP response.*no images are returned/i,
      'AI agents should discover fail-closed batch retrieval for multi-frame review');
    const singleFrameCaptureTool = tools.tools.find(t => t.name === 'motion_studio_capture_frame');
    assert.ok(singleFrameCaptureTool);
    assert.match(singleFrameCaptureTool.description ?? '', /does not stop the shared interactive preview/i);
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_capture_plan'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_capture_candidate_plan'));
    const candidateCaptureTool = tools.tools.find(t => t.name === 'motion_studio_capture_candidate_views');
    assert.ok(candidateCaptureTool);
    assert.match(candidateCaptureTool.description ?? '', /motion_studio_capture_preflight.*continue only when ready.*permission/i,
      'candidate capture discovery must require the explicit permission/capability preflight');
    assert.match(candidateCaptureTool.description ?? '', /omit them.*bounded deterministic plan.*views\/maxFrames/i,
      'candidate capture discovery should explain the automatic plan for unsaved recipes');
    assert.match(candidateCaptureTool.description ?? '', /candidateFingerprint as expectedFingerprint.*bind capture to the exact recipe/i,
      'candidate capture discovery should encourage binding explicit planned frames to the exact recipe fingerprint');
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_capture_candidate_comparison_plan'));
    const candidateComparisonCaptureTool = tools.tools.find(t => t.name === 'motion_studio_capture_candidate_comparison');
    assert.ok(candidateComparisonCaptureTool);
    assert.match(candidateComparisonCaptureTool.description ?? '', /motion_studio_capture_preflight.*continue only when ready.*permission/i,
      'candidate comparison discovery must require the explicit permission/capability preflight');
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_read_candidate_comparison'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_validate_candidate_comparison_review'));
    const savedCaptureTool = tools.tools.find(t => t.name === 'motion_studio_capture_views');
    assert.ok(savedCaptureTool);
    assert.match(savedCaptureTool.description ?? '', /read_candidate_captures.*inspect the actual images.*motion_review_attach_captures/i,
      'saved-animation review should give the calling AI the rendered evidence before attaching it to a separate review provider');
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_capture_chunk'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_patch'));
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /compress_track/);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /adjust_phase/);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /offset_pose/);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /offset_pose_group.*Atomically sculpt one coordinated multi-joint pose/s);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /joint-local XYZ translation in studs/);
    assert.match(JSON.stringify(tools.tools.find(t => t.name === 'motion_animation_patch')?.inputSchema), /rotation offset in degrees/);
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_benchmark'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_benchmark_record'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_benchmark_history'));
    assert.ok(tools.tools.some(t => t.name === 'motion_sequence_create'));
    assert.ok(tools.tools.some(t => t.name === 'motion_sequence_compile'));
    assert.ok(tools.tools.some(t => t.name === 'motion_sequence_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_retarget'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_retarget_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_suggest_joint_map'));
    assert.ok(tools.tools.some(t => t.name === 'motion_animation_resolve_rig_semantics'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_import_animation'));
    assert.ok(tools.tools.some(t => t.name === 'motion_pose_apply'));
    assert.ok(tools.tools.some(t => t.name === 'motion_pose_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_pose_sequence_apply'));
    const poseSequencePreviewTool = tools.tools.find(t => t.name === 'motion_pose_sequence_preview');
    assert.ok(poseSequencePreviewTool);
    assert.match(poseSequencePreviewTool.description ?? '', /each placement may set layerId.*exact animation layer/i);
    assert.match(poseSequencePreviewTool.description ?? '', /destinationLayerEffects.*disabled\/zero-weight destinations.*later active layers/i);
    assert.match(JSON.stringify(poseSequencePreviewTool.inputSchema), /restoring this destination channel to its original sample/i);
    const posePreviewTool = tools.tools.find(t => t.name === 'motion_pose_preview');
    assert.ok(posePreviewTool);
    assert.match(posePreviewTool.description ?? '', /omit layerId to target base tracks.*exact existing layer ID/i);
    assert.match(poseSequencePreviewTool.description ?? '', /authored local target.*exact intermediate local transform after that contribution.*final composed local transform/i);
    assert.match(poseSequencePreviewTool.description ?? '', /interior keys.*inherit its outgoing easing style\/direction and Bezier handles/i);
    assert.match(poseSequencePreviewTool.description ?? '', /markers within 0\.25 seconds.*signed offsets.*contacts overlapping the refinement window/i);
    assert.match(poseSequencePreviewTool.description ?? '', /markerBeatAssociations.*exact\/nearest beat.*markers are never moved or removed/i);
    assert.match(poseSequencePreviewTool.description ?? '', /sampled one-sided position\/angular velocity gaps.*entering\/leaving\/shared authored-coverage labels.*not pass\/fail thresholds/i);
    const poseSequenceEvaluationTool = tools.tools.find(t => t.name === 'motion_pose_sequence_evaluate');
    assert.ok(poseSequenceEvaluationTool);
    assert.match(poseSequenceEvaluationTool.description ?? '', /open the exact preview candidate.*screenshot preflight.*inspect every PNG.*do not claim AI visual review/i);
    assert.ok(tools.tools.some(t => t.name === 'motion_pose_transition_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_pose_transition_apply'));
    const poseTransitionTool = tools.tools.find(t => t.name === 'motion_pose_transition_preview');
    assert.ok(poseTransitionTool);
    assert.match(poseTransitionTool.description ?? '', /adaptiveRefinement=true.*positionToleranceStuds.*rotationToleranceDegrees/i);
    assert.match(JSON.stringify(poseTransitionTool.inputSchema), /maxAdaptiveDepth/);
    assert.ok(tools.tools.some(t => t.name === 'motion_snapshot_apply'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_pose'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_contact'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_declared_contacts_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_constraints_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_constraints_apply'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_constraints_visualize'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_constraints_clear_preview'));
    assert.ok(tools.tools.some(t => t.name === 'motion_studio_ik_constraints'));
    assert.ok(tools.tools.some(t => t.name === 'motion_ik_target_path_save'));
    assert.ok(tools.tools.some(t => t.name === 'motion_ik_target_path_list'));
    assert.ok(tools.tools.some(t => t.name === 'motion_ik_target_path_read'));
    const offlineAnimationComparison = await client.callTool({ name: 'motion_animation_compare', arguments: { sessionId: randomUUID(), rigId: randomUUID(), parentAssetId: randomUUID(), candidateAssetId: randomUUID() } });
    const offlineComparisonResult = offlineAnimationComparison as { isError?: boolean; content: { type: string; text?: string }[] };
    assert.equal(offlineComparisonResult.isError, true);
    assert.match(offlineComparisonResult.content[0]?.text ?? '', /session is offline|Studio disconnected/i);
    const invalidIkOffset = await client.callTool({ name: 'motion_studio_ik_pose', arguments: { rigId: randomUUID(), assetId: randomUUID(), limb: 'RightHand', time: 1, offset: [21, 0, 0] } });
    assert.equal(invalidIkOffset.isError, true);
    const invalidImportSource = await client.callTool({ name: 'motion_studio_import_animation', arguments: { rigId: randomUUID() } });
    assert.equal(invalidImportSource.isError, true);
    const savedPose = await client.callTool({ name: 'motion_pose_save', arguments: { name: 'Agent Guard', description: 'Test saved pose', tags: ['combat'], rigType: 'R15', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-50, 10, 5] }] } });
    assert.ok(!savedPose.isError, JSON.stringify(savedPose));
    const poseId = (savedPose.structuredContent as { result: { id: string } }).result.id;
    const poseSearch = await client.callTool({ name: 'motion_pose_list', arguments: { query: 'agent guard', rigType: 'R15' } });
    assert.equal((poseSearch.structuredContent as { result: { total: number } }).result.total, 1);
    const savedSnapshot = await client.callTool({ name: 'motion_snapshot_save', arguments: { name: 'Full Cast Snapshot', description: 'Full body test', tags: ['cast'], rigType: 'R15', rigSignature: 'R15|Root>UpperTorso:Motor6D', transforms: [{ joint: 'Head', position: [0, 0, 0], rotation: [12, 0, 0] }, { joint: 'LeftFoot', position: [0, 0, 0], rotation: [4, 0, 0] }] } });
    assert.ok(!savedSnapshot.isError, JSON.stringify(savedSnapshot));
    const snapshotId = (savedSnapshot.structuredContent as { result: { id: string } }).result.id;
    const snapshots = await client.callTool({ name: 'motion_snapshot_list', arguments: { query: 'cast', rigType: 'R15' } });
    assert.equal((snapshots.structuredContent as { result: { total: number } }).result.total, 1);
    const libraryBeforeBlueprint = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 10 } });
    assert.equal((libraryBeforeBlueprint.structuredContent as { result: { total: number } }).result.total, 0);
    const blueprintInput = {
      name: 'Blueprint MCP test', duration: 1, phases: [{ id: 'action', label: 'main_action', intent: 'A clear committed release.', start: 0, end: 1 }],
      poses: [{ phaseId: 'action', progress: 0.5, joint: 'RightUpperArm', rotation: [-70, 0, 0] }],
    };
    const blueprint = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: blueprintInput });
    assert.ok(!blueprint.isError, JSON.stringify(blueprint));
    const blueprintResult = (blueprint.structuredContent as { result: { candidateFingerprint: string; recipe: { name: string; markers: { name: string }[] }; diagnostics: { authoredPoseCount: number }; next: string } }).result;
    assert.equal(blueprintResult.recipe.name, 'Blueprint MCP test');
    assert.equal(blueprintResult.recipe.markers[0]!.name, 'Action');
    assert.equal(blueprintResult.diagnostics.authoredPoseCount, 1);
    assert.match(blueprintResult.next, /offline draft.*select and inspect the target rig.*motion_animation_candidate_evaluate.*motion_studio_open_candidate.*motion_studio_capture_preflight.*motion_studio_capture_candidate_plan.*motion_studio_read_candidate_capture/s,
      'an unbound blueprint should explain how to bind, evaluate, and retrieve AI-visible images');
    assert.match(blueprintResult.next, /not bound to an inspected Studio rig.*use the newly returned recipe fingerprint\/sessionId\/rigId/i,
      'an offline intent-bearing blueprint must not fabricate IDs for targeted pose or screenshot evidence');
    const libraryAfterBlueprint = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 10 } });
    assert.equal((libraryAfterBlueprint.structuredContent as { result: { total: number } }).result.total, 0);
    const staleBlueprintCommit = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...blueprintInput, name: 'Altered after preview', expectedCandidateFingerprint: blueprintResult.candidateFingerprint } });
    assert.equal(staleBlueprintCommit.isError, true);
    const committedBlueprint = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...blueprintInput, expectedCandidateFingerprint: blueprintResult.candidateFingerprint } });
    assert.ok(!committedBlueprint.isError, JSON.stringify(committedBlueprint));
    const committedResult = (committedBlueprint.structuredContent as { result: { assetId: string; parentId: string | null } }).result;
    assert.equal(committedResult.parentId, null);
    const retriedBlueprint = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...blueprintInput, expectedCandidateFingerprint: blueprintResult.candidateFingerprint } });
    assert.equal((retriedBlueprint.structuredContent as { result: { assetId: string } }).result.assetId, committedResult.assetId);
    const libraryAfterCommit = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 10 } });
    assert.equal((libraryAfterCommit.structuredContent as { result: { total: number } }).result.total, 1);
    const created = await client.callTool({ name: 'motion_animation_create', arguments: { preset: 'cast', name: 'Test Cast', duration: 2 } });
    assert.ok(!created.isError, JSON.stringify(created));
    const asset = (created.structuredContent as { result: { id: string; recipe: { name: string; duration: number; tracks: { joint: string; keys: { time: number; position: number[]; rotation: number[] }[] }[] } } }).result;
    assert.equal(asset.recipe.duration, 2);
    const childBlueprintInput = { ...blueprintInput, name: 'Blueprint child', parentAssetId: asset.id };
    const childBlueprintPreview = await client.callTool({ name: 'motion_animation_blueprint_preview', arguments: childBlueprintInput });
    assert.ok(!childBlueprintPreview.isError, JSON.stringify(childBlueprintPreview));
    const childCandidateFingerprint = (childBlueprintPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const childBlueprintCommit = await client.callTool({ name: 'motion_animation_blueprint_commit', arguments: { ...childBlueprintInput, expectedCandidateFingerprint: childCandidateFingerprint } });
    assert.ok(!childBlueprintCommit.isError, JSON.stringify(childBlueprintCommit));
    assert.equal((childBlueprintCommit.structuredContent as { result: { parentId: string } }).result.parentId, asset.id);
    const similarCreated = await client.callTool({ name: 'motion_animation_create', arguments: { preset: 'cast', name: 'Similar Cast', duration: 4 } });
    assert.ok(!similarCreated.isError, JSON.stringify(similarCreated));
    const similarAssetId = (similarCreated.structuredContent as { result: { id: string } }).result.id;
    const similarSearch = await client.callTool({ name: 'motion_animation_search_similar', arguments: { queryAssetId: asset.id, limit: 5, scanLimit: 50 } });
    assert.ok(!similarSearch.isError, JSON.stringify(similarSearch));
    const similarResult = (similarSearch.structuredContent as { result: { targetRigNextStep: { tool: string; arguments: Record<string, never>; instruction: string } | null; similarityMethod: { uniformProgressSamples: number; maximumProgressSamples: number; timeWeighting: string; eventAlignment: string }; matches: { assetId: string; motionShapeSimilarityPercent: number; durationRatio: number; eventAlignmentPercent: number | null; markerAlignmentPercent: number | null; queryMarkerCount: number; candidateMarkerCount: number; contactAlignmentPercent: number | null; sampledProgressPointCount: number; omittedAuthoredProgressPointCount: number; comparedKeyProgressPointCount: number; sampledComparedKeyProgressPointCount: number; omittedEventProgressPointCount: number; unmappedActiveCandidateJoints: string[] | null; omittedUnmappedActiveJointCount: number | null; unmappedInactiveCandidateJoints: string[] | null; omittedUnmappedInactiveJointCount: number | null }[] } }).result;
    assert.equal(similarResult.similarityMethod.uniformProgressSamples, 33);
    assert.equal(similarResult.targetRigNextStep?.tool, 'motion_studio_sessions');
    assert.deepEqual(similarResult.targetRigNextStep?.arguments, {});
    assert.match(similarResult.targetRigNextStep?.instruction ?? '', /Motion Tools Rig Library/);
    assert.equal(similarResult.similarityMethod.maximumProgressSamples, 129);
    assert.match(similarResult.similarityMethod.timeWeighting, /trapezoidal/);
    assert.match(similarResult.similarityMethod.eventAlignment, /separate from pose shape/i);
    assert.equal(similarResult.matches[0]!.assetId, similarAssetId);
    assert.equal(similarResult.matches[0]!.motionShapeSimilarityPercent, 100);
    assert.equal(similarResult.matches[0]!.eventAlignmentPercent, 100);
    assert.equal(similarResult.matches[0]!.markerAlignmentPercent, 100);
    assert.equal(similarResult.matches[0]!.queryMarkerCount, 1);
    assert.equal(similarResult.matches[0]!.candidateMarkerCount, 1);
    assert.equal(similarResult.matches[0]!.contactAlignmentPercent, null);
    assert.equal(similarResult.matches[0]!.durationRatio, 2);
    assert.equal(similarResult.matches[0]!.unmappedActiveCandidateJoints, null, 'missing rig provenance must be explicit as not assessed over MCP');
    assert.equal(similarResult.matches[0]!.omittedUnmappedActiveJointCount, null);
    assert.equal(similarResult.matches[0]!.unmappedInactiveCandidateJoints, null);
    assert.equal(similarResult.matches[0]!.omittedUnmappedInactiveJointCount, null);
    assert.ok(similarResult.matches[0]!.sampledProgressPointCount >= 33);
    assert.equal(similarResult.matches[0]!.omittedAuthoredProgressPointCount, 0);
    assert.ok(similarResult.matches[0]!.comparedKeyProgressPointCount > 0);
    assert.equal(similarResult.matches[0]!.sampledComparedKeyProgressPointCount, similarResult.matches[0]!.comparedKeyProgressPointCount);
    assert.equal(similarResult.matches[0]!.omittedEventProgressPointCount, 0);
    const reuseEvidence = await client.callTool({ name: 'motion_animation_reuse_evidence', arguments: { assetIds: [similarAssetId] } });
    assert.ok(!reuseEvidence.isError, JSON.stringify(reuseEvidence));
    const reuseEvidenceResult = (reuseEvidence.structuredContent as { result: { results: { assetId: string; exactRevisionEvidence: { evidenceStatus: string; latestApplicableRun: unknown }; ancestors: unknown[] }[] } }).result;
    assert.equal(reuseEvidenceResult.results[0]!.assetId, similarAssetId);
    assert.equal(reuseEvidenceResult.results[0]!.exactRevisionEvidence.evidenceStatus, 'no_recorded_runs');
    assert.equal(reuseEvidenceResult.results[0]!.exactRevisionEvidence.latestApplicableRun, null);
    assert.equal(reuseEvidenceResult.results[0]!.ancestors.length, 0);
    const incompleteTargetRigSearch = await client.callTool({ name: 'motion_animation_search_similar', arguments: { queryAssetId: asset.id, targetRigId: randomUUID() } });
    assert.equal(incompleteTargetRigSearch.isError, true);
    assert.match(JSON.stringify(incompleteTargetRigSearch), /provide both sessionId and targetRigId/i);
    const secondPose = await client.callTool({ name: 'motion_pose_save', arguments: { name: 'Agent Release', description: 'Transition target', tags: ['combat'], rigType: 'R15', transforms: [{ joint: 'RightUpperArm', position: [0.5, 0, 0], rotation: [-80, 0, 0] }] } });
    const secondPoseId = (secondPose.structuredContent as { result: { id: string } }).result.id;
    const transitionInput = { animationAssetId: asset.id, fromPoseId: poseId, toPoseId: secondPoseId, startTime: 0.2, endTime: 0.4, steps: 4, easingStyle: 'CubicV2', easingDirection: 'InOut', preserve: [{ joint: 'UpperTorso', startTime: 0, endTime: 2 }] };
    const transitionPreview = await client.callTool({ name: 'motion_pose_transition_preview', arguments: transitionInput });
    assert.ok(!transitionPreview.isError, JSON.stringify(transitionPreview));
    const transitionCandidate = (transitionPreview.structuredContent as { result: { candidateFingerprint: string;
      diagnostics: { generatedKeys: number; addedTracks: string[] }; poseRigCompatibility: { status: string }[];
      preservation: { verificationMethod: string }[] } }).result;
    assert.equal(transitionCandidate.diagnostics.generatedKeys, 5);
    assert.ok(Array.isArray(transitionCandidate.diagnostics.addedTracks), 'transition preview must disclose snapshot-created tracks');
    assert.ok(transitionCandidate.poseRigCompatibility.every(item => item.status === 'unknown'),
      'transition preview must not assume rig compatibility without source provenance');
    assert.equal(transitionCandidate.preservation[0]!.verificationMethod, 'exact_channel_match');
    const adaptiveTransitionInput = { ...transitionInput, steps: 2, adaptiveRefinement: true,
      positionToleranceStuds: 0.001, rotationToleranceDegrees: 0.1, maxAdaptiveDepth: 4 };
    const adaptiveTransitionPreview = await client.callTool({ name: 'motion_pose_transition_preview', arguments: adaptiveTransitionInput });
    assert.ok(!adaptiveTransitionPreview.isError, JSON.stringify(adaptiveTransitionPreview));
    const adaptiveTransition = (adaptiveTransitionPreview.structuredContent as { result: { candidateFingerprint: string;
      diagnostics: { generatedKeys: number; adaptiveRefinement: { enabled: boolean; curveSampleCount: number; joints: { adaptiveKeyCount: number; toleranceMet: boolean | null }[] } } } }).result;
    assert.equal(adaptiveTransition.diagnostics.adaptiveRefinement.enabled, true);
    assert.ok(adaptiveTransition.diagnostics.adaptiveRefinement.curveSampleCount > 0);
    assert.ok(adaptiveTransition.diagnostics.generatedKeys > 3,
      'adaptive options sent through MCP must reach the compiler and add breakdown keys for the curved transition');
    assert.ok(adaptiveTransition.diagnostics.adaptiveRefinement.joints.every(joint => joint.toleranceMet !== null));
    const alteredAdaptiveCommit = await client.callTool({ name: 'motion_pose_transition_apply', arguments: {
      ...adaptiveTransitionInput, rotationToleranceDegrees: 0.2, expectedCandidateFingerprint: adaptiveTransition.candidateFingerprint } });
    assert.equal(alteredAdaptiveCommit.isError, true);
    assert.match(JSON.stringify(alteredAdaptiveCommit), /differs from its reviewed preview/i);
    const rejectedTransitionGuard = await client.callTool({ name: 'motion_pose_transition_preview', arguments: { ...transitionInput, preserve: [{ joint: 'RightUpperArm', startTime: 0, endTime: 0.1 }] } });
    assert.equal(rejectedTransitionGuard.isError, true);
    assert.match(JSON.stringify(rejectedTransitionGuard), /Protected motion changed/i);
    const rejectedTransitionCommit = await client.callTool({ name: 'motion_pose_transition_apply', arguments: { ...transitionInput, preserve: [], expectedCandidateFingerprint: transitionCandidate.candidateFingerprint } });
    assert.equal(rejectedTransitionCommit.isError, true);
    assert.match(JSON.stringify(rejectedTransitionCommit), /differs from its reviewed preview/i);
    const transitionCommit = await client.callTool({ name: 'motion_pose_transition_apply', arguments: { ...transitionInput, expectedCandidateFingerprint: transitionCandidate.candidateFingerprint } });
    assert.ok(!transitionCommit.isError, JSON.stringify(transitionCommit));
    assert.equal((transitionCommit.structuredContent as { result: { parentId: string } }).result.parentId, asset.id);
    const phaseOperations = [
      { operation: 'markers_set', markers: [{ name: 'Windup', time: 0.5 }, { name: 'Strike', time: 1 }, { name: 'Recovery', time: 1.5 }] },
      { operation: 'retime_phase', startMarker: 'windup', endMarker: 'STRIKE', newDuration: 0.25 },
    ];
    const phasePreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: phaseOperations, dryRun: true } });
    assert.ok(!phasePreview.isError, JSON.stringify(phasePreview));
    const phaseCandidate = (phasePreview.structuredContent as { result: { candidateFingerprint: string; recipe: { duration: number; markers: { time: number }[] }; changes: { operation: string; timeMap?: { mode: string }[]; affected?: { baseKeys: number; layerKeys: number; rootMotionKeys: number; contactIntervals: number; markers: number } }[] } }).result;
    assert.equal(phaseCandidate.recipe.duration, 1.75);
    assert.deepEqual(phaseCandidate.recipe.markers.map(marker => marker.time), [0.5, 0.75, 1.25]);
    assert.deepEqual(phaseCandidate.changes[1]!.timeMap?.map(segment => segment.mode), ['unchanged', 'scaled', 'shifted']);
    assert.ok(phaseCandidate.changes[1]!.affected);
    const phaseCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: phaseOperations, expectedCandidateFingerprint: phaseCandidate.candidateFingerprint } });
    assert.ok(!phaseCommit.isError, JSON.stringify(phaseCommit));
    const phaseChild = (phaseCommit.structuredContent as { result: { assetId: string; parentId: string; recipe: { duration: number } } }).result;
    assert.equal(phaseChild.recipe.duration, 1.75);
    assert.equal(phaseChild.parentId, asset.id);
    const sculptPreserve = [{ joint: 'LeftUpperArm', startTime: 0, endTime: 0.5 }];
    const sculptOperations = [
      { operation: 'markers_set', markers: [{ name: 'Windup', time: 0.5 }, { name: 'Recovery', time: 1.75 }] },
      { operation: 'adjust_phase', startMarker: 'Windup', endMarker: 'Recovery', joints: ['LeftUpperArm', 'RightUpperArm'],
        positionOffset: [0.1, 0, 0], rotationOffset: [0, 12, 0], fadeInProgress: 0.2, fadeOutProgress: 0.2, easingStyle: 'CubicV2' },
    ];
    const libraryBeforeSculpt = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const sculptPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: phaseChild.assetId, operations: sculptOperations, preserve: sculptPreserve, dryRun: true } });
    assert.ok(!sculptPreview.isError, JSON.stringify(sculptPreview));
    const sculptCandidate = (sculptPreview.structuredContent as { result: { candidateFingerprint: string; changes: { operation: string; joint: string; phaseAdjustment?: { changedKeys: number; startTime: number; endTime: number } }[]; preservation: { maxPositionDrift: number; maxRotationDriftDegrees: number }[] } }).result;
    const sculptChanges = sculptCandidate.changes.filter(change => change.operation === 'adjust_phase');
    assert.deepEqual(sculptChanges.map(change => change.joint), ['LeftUpperArm', 'RightUpperArm']);
    assert.ok(sculptChanges.every(change => change.phaseAdjustment && change.phaseAdjustment.changedKeys > 0 && change.phaseAdjustment.startTime === 0.5 && change.phaseAdjustment.endTime === 1.75));
    assert.ok(sculptCandidate.preservation.every(region => region.maxPositionDrift <= 0.001 && region.maxRotationDriftDegrees <= 0.1));
    const libraryAfterSculptPreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryBeforeSculpt.structuredContent as { result: { total: number } }).result.total,
      (libraryAfterSculptPreview.structuredContent as { result: { total: number } }).result.total, 'phase sculpt preview must not save a revision');
    const changedSculptCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: phaseChild.assetId,
      operations: [{ ...sculptOperations[0] }, { ...sculptOperations[1]!, positionOffset: [0.2, 0, 0] }], preserve: sculptPreserve,
      expectedCandidateFingerprint: sculptCandidate.candidateFingerprint } });
    assert.equal(changedSculptCommit.isError, true, 'changed phase edits must not reuse a reviewed fingerprint');
    const sculptCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: phaseChild.assetId, operations: sculptOperations,
      preserve: sculptPreserve, expectedCandidateFingerprint: sculptCandidate.candidateFingerprint } });
    assert.ok(!sculptCommit.isError, JSON.stringify(sculptCommit));
    assert.equal((sculptCommit.structuredContent as { result: { parentId: string } }).result.parentId, phaseChild.assetId);
    const timelineInput = { name: 'Preview Combo', sampleRate: 30, loop: false, clips: [{ animationId: asset.id, start: 0.25, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 }] };
    const sequenceCountBeforePreview = await client.callTool({ name: 'motion_sequence_list', arguments: { offset: 0, limit: 100 } });
    const timelinePreview = await client.callTool({ name: 'motion_sequence_preview', arguments: timelineInput });
    assert.ok(!timelinePreview.isError, JSON.stringify(timelinePreview));
    const timelineCandidate = (timelinePreview.structuredContent as { result: { candidateFingerprint: string; diagnostics: { clipCount: number; gaps: { start: number; end: number }[]; samplingFidelity: { method: string; samplingStrategy: string; jointProbeCount: number; maximumPositionErrorStuds: number; actualKeyCountPerTrack: number; expectedUniformKeyCount: number; keyBudgetPerTrack: number; maximumOutputIntervalSeconds: number } }; animation: { duration: number }; next: string } }).result;
    assert.equal(timelineCandidate.diagnostics.clipCount, 1);
    assert.deepEqual(timelineCandidate.diagnostics.gaps, [{ start: 0, end: 0.25, duration: 0.25 }]);
    assert.equal(timelineCandidate.animation.duration, 1.25);
    assert.match(timelineCandidate.diagnostics.samplingFidelity.method, /exact source-clip composition/);
    assert.match(timelineCandidate.diagnostics.samplingFidelity.samplingStrategy, /splitting the interval/);
    assert.ok(timelineCandidate.diagnostics.samplingFidelity.jointProbeCount > 0);
    assert.ok(Number.isFinite(timelineCandidate.diagnostics.samplingFidelity.maximumPositionErrorStuds));
    assert.ok(timelineCandidate.diagnostics.samplingFidelity.actualKeyCountPerTrack > 1);
    assert.ok(timelineCandidate.diagnostics.samplingFidelity.keyBudgetPerTrack >= timelineCandidate.diagnostics.samplingFidelity.actualKeyCountPerTrack);
    assert.ok(timelineCandidate.diagnostics.samplingFidelity.maximumOutputIntervalSeconds > 0);
    assert.match(timelineCandidate.next, /motion_animation_candidate_evaluate/);
    assert.match(timelineCandidate.next, /motion_studio_open_candidate/);
    assert.match(timelineCandidate.next, /unsaved/);
    const sequenceCountAfterPreview = await client.callTool({ name: 'motion_sequence_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((sequenceCountBeforePreview.structuredContent as { result: { total: number } }).result.total, (sequenceCountAfterPreview.structuredContent as { result: { total: number } }).result.total);
    const createdSequence = await client.callTool({ name: 'motion_sequence_create', arguments: timelineInput });
    assert.ok(!createdSequence.isError, JSON.stringify(createdSequence));
    const sequenceId = (createdSequence.structuredContent as { result: { id: string } }).result.id;
    const compiledSequence = await client.callTool({ name: 'motion_sequence_compile', arguments: { sequenceId } });
    assert.ok(!compiledSequence.isError, JSON.stringify(compiledSequence));
    assert.equal((compiledSequence.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint, timelineCandidate.candidateFingerprint);
    const sourcePath = join(directory, 'artifacts', 'library', `${asset.id}.json`);
    const changedSource = JSON.parse(await readFile(sourcePath, 'utf8')) as { recipe: { name: string } };
    changedSource.recipe.name = 'Externally changed source';
    await writeFile(sourcePath, JSON.stringify(changedSource, null, 2));
    const staleSequenceList = await client.callTool({ name: 'motion_sequence_list', arguments: { offset: 0, limit: 100 } });
    const staleSequence = (staleSequenceList.structuredContent as { result: { sequences: { id: string; sourceIntegrity: string }[] } }).result.sequences.find(item => item.id === sequenceId);
    assert.equal(staleSequence?.sourceIntegrity, 'stale');
    const staleRead = await client.callTool({ name: 'motion_sequence_read', arguments: { sequenceId } });
    assert.equal(staleRead.isError, true);
    const staleCompile = await client.callTool({ name: 'motion_sequence_compile', arguments: { sequenceId } });
    assert.equal(staleCompile.isError, true);
    const adoptedSequence = await client.callTool({ name: 'motion_sequence_update', arguments: { sequenceId, ...timelineInput } });
    assert.ok(!adoptedSequence.isError, JSON.stringify(adoptedSequence));
    const adoptedSequenceId = (adoptedSequence.structuredContent as { result: { id: string; parentId: string } }).result;
    assert.equal(adoptedSequenceId.parentId, sequenceId);
    const adoptedCompile = await client.callTool({ name: 'motion_sequence_compile', arguments: { sequenceId: adoptedSequenceId.id } });
    assert.ok(!adoptedCompile.isError, JSON.stringify(adoptedCompile));
    const sequenceInput = { animationAssetId: asset.id, placements: [{ poseId, time: 0.25 }, { poseId, time: 0.75, weight: 0.5 }] };
    const beforeSequencePreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const poseSequencePreview = await client.callTool({ name: 'motion_pose_sequence_preview', arguments: sequenceInput });
    assert.ok(!poseSequencePreview.isError, JSON.stringify(poseSequencePreview));
    const previewCandidate = (poseSequencePreview.structuredContent as { result: { candidateFingerprint: string; diagnostics: { coverage: number;
      placementCompositionEffects: { joint: string; time: number; compositionChanged: boolean; positionDeltaStuds: number; rotationDeltaDegrees: number }[];
      transitionMotion: { effectiveSampleRateHz: number; intervals: { peaks: { angularSpeedDegreesPerSecond: { coarseValue: number; value: number; refinement: { status: string; resolvedWithinFivePercent: boolean | null } }[] } }[] } };
      recipe: { tracks: { joint: string; keys: { time: number }[] }[] } } }).result;
    assert.equal(previewCandidate.diagnostics.coverage, 1);
    assert.equal(previewCandidate.diagnostics.transitionMotion.effectiveSampleRateHz, 60);
    assert.equal(previewCandidate.diagnostics.placementCompositionEffects.length, 2,
      'each pose placement reports bounded composed-channel impact at the authored joints and time');
    assert.ok(previewCandidate.diagnostics.placementCompositionEffects.some(effect => effect.compositionChanged),
      'candidate-vs-restored-channel comparison should detect composed pose changes');
    assert.equal(previewCandidate.diagnostics.transitionMotion.intervals[0]?.peaks.angularSpeedDegreesPerSecond[0]?.refinement.status, 'sampled');
    assert.ok(previewCandidate.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.some(key => key.time === 0.25));
    const overlapPreview = await client.callTool({ name: 'motion_pose_sequence_preview', arguments: { animationAssetId: asset.id,
      placements: [{ poseId, time: 0.5, weight: 0.5 }, { poseId: secondPoseId, time: 0.5, weight: 0.5 }] } });
    assert.ok(!overlapPreview.isError, JSON.stringify(overlapPreview));
    const overlapCandidate = (overlapPreview.structuredContent as { result: { recipe: { tracks: { joint: string; keys: { time: number; position: number[]; rotation: number[] }[] }[] };
      diagnostics: { sameTimeConflicts: { joint: string; time: number; contributors: { poseId: string; resultAfter: { position: number[]; rotation: number[] } }[];
        result: { position: number[]; rotation: number[] } }[] } } }).result;
    const overlapTrace = overlapCandidate.diagnostics.sameTimeConflicts.find(conflict => conflict.joint === 'RightUpperArm' && conflict.time === 0.5);
    assert.deepEqual(overlapTrace?.contributors.map(contributor => contributor.poseId), [poseId, secondPoseId]);
    assert.equal(overlapTrace?.contributors.length, 2);
    assert.notDeepEqual(overlapTrace?.contributors[0]?.resultAfter, overlapTrace?.contributors[1]?.resultAfter,
      'MCP preview must expose each intermediate blend result, not only the final transform');
    const overlapRecipeKey = overlapCandidate.recipe.tracks.find(track => track.joint === 'RightUpperArm')!.keys.find(key => key.time === 0.5)!;
    assert.deepEqual(overlapTrace?.result, { position: overlapRecipeKey.position, rotation: overlapRecipeKey.rotation });
    const boundaryPose = await client.callTool({ name: 'motion_pose_save', arguments: { name: 'Boundary Release', rigType: 'R15',
      transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-25, 0, 0] }] } });
    assert.ok(!boundaryPose.isError, JSON.stringify(boundaryPose));
    const boundaryPoseId = (boundaryPose.structuredContent as { result: { id: string } }).result.id;
    const boundaryPreview = await client.callTool({ name: 'motion_pose_sequence_preview', arguments: { animationAssetId: asset.id,
      placements: [{ poseId, time: 0.25 }, { poseId: secondPoseId, time: 0.5 }, { poseId: boundaryPoseId, time: 0.75 }] } });
    assert.ok(!boundaryPreview.isError, JSON.stringify(boundaryPreview));
    type BoundaryDiagnosticsResult = { result: { diagnostics: { transitionMotion: { boundaryContinuity: {
      boundaryCount: number; evaluationCount: number; angularVelocityDiscontinuities: Array<{ time: number; value: number;
        curveContext: Array<{ source: string; keyAtBoundary: number | null; previousKeyTime: number | null; nextKeyTime: number | null;
          incomingEasing: { style: string; direction: string } | null; outgoingEasing: { style: string; direction: string } | null }> }> } } } } };
    const boundaryDiagnostics = (boundaryPreview.structuredContent as BoundaryDiagnosticsResult).result.diagnostics.transitionMotion.boundaryContinuity;
    assert.equal(boundaryDiagnostics.boundaryCount, 1);
    assert.ok(boundaryDiagnostics.evaluationCount > 0);
    assert.ok(boundaryDiagnostics.angularVelocityDiscontinuities.some(signal => signal.time === 0.5 && Number.isFinite(signal.value)));
    const boundaryCurve = boundaryDiagnostics.angularVelocityDiscontinuities.find(signal => signal.time === 0.5)?.curveContext.find(channel => channel.source === 'base');
    assert.equal(boundaryCurve?.keyAtBoundary, 0.5);
    assert.ok(boundaryCurve?.incomingEasing && boundaryCurve.outgoingEasing,
      'MCP preview must deliver nearby keys and easing context with beat-boundary metrics');
    const afterSequencePreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((beforeSequencePreview.structuredContent as { result: { total: number } }).result.total, (afterSequencePreview.structuredContent as { result: { total: number } }).result.total);
    const stalePoseSequence = await client.callTool({ name: 'motion_pose_sequence_apply', arguments: { ...sequenceInput, placements: [{ poseId, time: 0.25 }, { poseId, time: 0.8, weight: 0.5 }], expectedCandidateFingerprint: previewCandidate.candidateFingerprint } });
    assert.equal(stalePoseSequence.isError, true);
    assert.match(JSON.stringify(stalePoseSequence), /differs from its reviewed preview/i);
    const poseSequence = await client.callTool({ name: 'motion_pose_sequence_apply', arguments: { ...sequenceInput, expectedCandidateFingerprint: previewCandidate.candidateFingerprint } });
    assert.ok(!poseSequence.isError, JSON.stringify(poseSequence));
    const assembled = (poseSequence.structuredContent as { result: { parentId: string; assetId: string; placements: { time: number }[]; recipe: { tracks: { joint: string; keys: { time: number }[] }[] } } }).result;
    assert.equal(assembled.parentId, asset.id);
    assert.equal((poseSequence.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint, previewCandidate.candidateFingerprint);
    assert.equal(assembled.placements.length, 2);
    assert.ok(assembled.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.some(key => key.time === 0.25));
    assert.ok(assembled.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.some(key => key.time === 0.75));
    const sourceProfile = { version: 1, rigId: randomUUID(), rigName: 'Source rig', rigType: 'R15', rigSignature: 'source-rig-signature', joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
      ...((created.structuredContent as { result: { recipe: { tracks: { joint: string }[] } } }).result.recipe.tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 }))),
    ] };
    const targetProfile = { ...sourceProfile, rigId: randomUUID(), rigName: 'Target rig', rigSignature: 'target-rig-signature', joints: sourceProfile.joints.map(joint => ({ ...joint, segmentLength: joint.driven ? 3 : 0 })) };
    const libraryBeforeMapping = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const mappingSuggestions = await client.callTool({ name: 'motion_animation_suggest_joint_map', arguments: { assetId: asset.id, sourceProfile, targetProfile } });
    assert.ok(!mappingSuggestions.isError, JSON.stringify(mappingSuggestions));
    const mappingReport = (mappingSuggestions.structuredContent as { result: { suggestedJointMap: Record<string, string>; suggestions: { source: string; status: string }[]; limitation: string } }).result;
    assert.deepEqual(mappingReport.suggestedJointMap, Object.fromEntries(sourceProfile.joints.filter(joint => joint.driven).map(joint => [joint.name, joint.name])));
    const createdRecipe = (created.structuredContent as { result: { recipe: { tracks: { joint: string }[] } } }).result.recipe;
    assert.equal(mappingReport.suggestions.length, createdRecipe.tracks.length);
    assert.match(mappingReport.limitation, /never applied automatically/);
    const libraryAfterMapping = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryAfterMapping.structuredContent as { result: { total: number } }).result.total, (libraryBeforeMapping.structuredContent as { result: { total: number } }).result.total);
    const retargetInput = { assetId: asset.id, sourceProfile, targetProfile, jointMap: mappingReport.suggestedJointMap };
    const beforeRetargetPreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const retargetPreview = await client.callTool({ name: 'motion_animation_retarget_preview', arguments: retargetInput });
    assert.ok(!retargetPreview.isError, JSON.stringify(retargetPreview));
    const retargetCandidate = (retargetPreview.structuredContent as { result: { candidateFingerprint: string; sourceFingerprint: string; recipe: { kind: string }; report: unknown; next: string } }).result;
    assert.match(retargetCandidate.candidateFingerprint, /^[0-9a-f]{64}$/);
    assert.match(retargetCandidate.sourceFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(retargetCandidate.recipe.kind, 'animation');
    assert.ok(retargetCandidate.report);
    assert.match(retargetCandidate.next, /not bound to a fresh live target-rig inspection/i);
    assert.match(retargetCandidate.next, /motion_animation_candidate_evaluate/);
    assert.match(retargetCandidate.next, /retargetPreview/);
    assert.match(retargetCandidate.next, /candidateFingerprint/);
    const staleBoundEvaluation = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: retargetCandidate.recipe, sessionId: randomUUID(), rigId: randomUUID(),
      retargetPreview: { ...retargetInput, expectedCandidateFingerprint: '0'.repeat(64) },
    } });
    assert.equal(staleBoundEvaluation.isError, true);
    assert.match(JSON.stringify(staleBoundEvaluation), /Retarget preview fingerprint is stale/i);
    const alteredBoundEvaluation = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: { ...retargetCandidate.recipe, name: 'Altered after retarget preview' }, sessionId: randomUUID(), rigId: randomUUID(),
      retargetPreview: { ...retargetInput, expectedCandidateFingerprint: retargetCandidate.candidateFingerprint },
    } });
    assert.equal(alteredBoundEvaluation.isError, true);
    assert.match(JSON.stringify(alteredBoundEvaluation), /does not exactly match the fingerprint-verified retarget preview recipe/i);
    const reorderedPreview = await client.callTool({ name: 'motion_animation_retarget_preview', arguments: {
      ...retargetInput,
      sourceProfile: { ...sourceProfile, joints: [...sourceProfile.joints].reverse() },
      targetProfile: { ...targetProfile, joints: [...targetProfile.joints].reverse() },
      jointMap: Object.fromEntries(Object.entries(retargetInput.jointMap).reverse()),
    } });
    assert.ok(!reorderedPreview.isError, JSON.stringify(reorderedPreview));
    assert.equal((reorderedPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint, retargetCandidate.candidateFingerprint);
    const afterRetargetPreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((afterRetargetPreview.structuredContent as { result: { total: number } }).result.total, (beforeRetargetPreview.structuredContent as { result: { total: number } }).result.total);
    const unconfirmedRetargetCommit = await client.callTool({ name: 'motion_animation_retarget', arguments: retargetInput });
    assert.equal(unconfirmedRetargetCommit.isError, true);
    const staleRetargetCommit = await client.callTool({ name: 'motion_animation_retarget', arguments: { ...retargetInput, expectedCandidateFingerprint: '0'.repeat(64) } });
    assert.equal(staleRetargetCommit.isError, true);
    const retargeted = await client.callTool({ name: 'motion_animation_retarget', arguments: { ...retargetInput, expectedCandidateFingerprint: retargetCandidate.candidateFingerprint } });
    assert.equal(retargeted.isError, true, 'a preview fingerprint alone must not authorize a retarget write');
    assert.match(JSON.stringify(retargeted), /No fresh exact retarget evaluation receipt/i);
    const read = await client.callTool({ name: 'motion_library_read', arguments: { assetId: asset.id } });
    assert.equal((read.structuredContent as { result: { id: string } }).result.id, asset.id);
    const unsavedAuditRecipe = animationPreset('slash', 'Unsaved audit candidate', 1.1, 1);
    const savedCountBeforeUnsavedAudit = ((await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 1 } })).structuredContent as { result: { total: number } }).result.total;
    const unsavedAudit = await client.callTool({ name: 'motion_animation_audit_recipe', arguments: { recipe: unsavedAuditRecipe } });
    assert.ok(!unsavedAudit.isError, JSON.stringify(unsavedAudit));
    const unsavedAuditResult = (unsavedAudit.structuredContent as { result: { saved: boolean; candidateFingerprint: string;
      summary: { tracks: number }; refinementPlan: unknown[]; limitation: string; next: string; assetId?: string } }).result;
    assert.equal(unsavedAuditResult.saved, false);
    assert.equal(unsavedAuditResult.candidateFingerprint, fingerprint(unsavedAuditRecipe));
    assert.equal(unsavedAuditResult.summary.tracks, unsavedAuditRecipe.tracks.length);
    assert.ok(Array.isArray(unsavedAuditResult.refinementPlan));
    assert.match(unsavedAuditResult.limitation, /cannot certify an artistic result/i);
    assert.match(unsavedAuditResult.next, /motion_animation_candidate_evaluate with this exact recipe.*candidateFingerprint=.*as expectedFingerprint.*verify the evaluator returns the same candidateFingerprint/i);
    assert.match(unsavedAuditResult.next, /motion_studio_open_candidate with that exact recipe and evaluator candidateFingerprint as expectedFingerprint.*poll motion_studio_job/i);
    assert.equal(unsavedAuditResult.assetId, undefined);
    const savedCountAfterUnsavedAudit = ((await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 1 } })).structuredContent as { result: { total: number } }).result.total;
    assert.equal(savedCountAfterUnsavedAudit, savedCountBeforeUnsavedAudit, 'auditing an unsaved recipe must never create a saved asset');
    const vfxUnsavedAudit = await client.callTool({ name: 'motion_animation_audit_recipe', arguments: { recipe: vfxPreset('impact', 'Not animation') } });
    assert.equal(vfxUnsavedAudit.isError, true, 'the animation-only audit must reject VFX recipes clearly');
    const audit = await client.callTool({ name: 'motion_animation_audit', arguments: { assetId: asset.id } });
    assert.ok(!audit.isError, JSON.stringify(audit));
    assert.match(JSON.stringify(audit.structuredContent), /curveMotion samples the authored easing/i);
    assert.match(JSON.stringify(audit.structuredContent), /peakLocalAngularSpeed/i);
    assert.equal((audit.structuredContent as { result: { rigCoverage?: unknown } }).result.rigCoverage, undefined,
      'offline audits must not claim rig coverage without a fresh inspected Studio rig');
    const contactAuditRecipe = animationPreset('idle', 'Contact channel audit', 1, 1);
    contactAuditRecipe.contacts = [{ effector: contactAuditRecipe.tracks[0]!.joint, kind: 'support', start: 0.2, end: 0.8 },
      { effector: 'NoAuthoredEffector', kind: 'grip', start: 0.2, end: 0.8 }];
    const contactAuditSave = await client.callTool({ name: 'motion_library_save', arguments: { recipe: contactAuditRecipe } });
    assert.ok(!contactAuditSave.isError, JSON.stringify(contactAuditSave));
    const contactAuditAssetId = (contactAuditSave.structuredContent as { result: { id: string } }).result.id;
    const contactAuditResponse = await client.callTool({ name: 'motion_animation_audit', arguments: { assetId: contactAuditAssetId } });
    assert.ok(!contactAuditResponse.isError, JSON.stringify(contactAuditResponse));
    const contactAuditResult = (contactAuditResponse.structuredContent as { result: {
      contactTrackCoverage: { effector: string; status: string }[]; advisories: { id: string }[]; next: string;
    } }).result;
    assert.deepEqual(contactAuditResult.contactTrackCoverage.map(contact => [contact.effector, contact.status]), [
      [contactAuditRecipe.tracks[0]!.joint, 'active_channel'], ['NoAuthoredEffector', 'no_matching_channel'],
    ]);
    assert.ok(contactAuditResult.advisories.some(advisory => advisory.id === 'contact-channel-coverage'));
    assert.match(contactAuditResult.next, /no_matching_channel.*not automatic failures.*does not prove contact/i);
    const incompleteRigCoverage = await client.callTool({ name: 'motion_animation_audit', arguments: { assetId: asset.id, rigId: randomUUID() } });
    assert.equal(incompleteRigCoverage.isError, true, 'rig-aware coverage must require both sessionId and rigId');
    const benchmark = await client.callTool({ name: 'motion_animation_benchmark', arguments: { suite: {
      schemaVersion: 1, cases: [{ id: 'mcp-smoke', name: 'MCP animation smoke', recipe: asset.recipe, expectations: [] }],
    } } });
    assert.ok(!benchmark.isError, JSON.stringify(benchmark));
    assert.match(JSON.stringify(benchmark.structuredContent), /mcp-smoke/);
    assert.match(JSON.stringify(benchmark.structuredContent), /recipe-only analysis/i);
    const currentAssetRead = await client.callTool({ name: 'motion_library_read', arguments: { assetId: asset.id } });
    assert.ok(!currentAssetRead.isError, JSON.stringify(currentAssetRead));
    const currentSavedRecipe = (currentAssetRead.structuredContent as { result: { recipe: unknown } }).result.recipe;
    const benchmarkRun = await client.callTool({ name: 'motion_animation_benchmark_record', arguments: { suite: {
      schemaVersion: 1, cases: [{ id: 'persisted-smoke', name: 'Persisted MCP smoke', recipe: currentSavedRecipe,
        expectations: [{ id: 'recipe-valid', description: 'Recipe validates.', outcome: 'pass', evidence: 'Strict recipe validation.' }] }],
    }, releaseGate: { failOnWarnings: false, requireExpectationsPerCase: true } } });
    assert.ok(!benchmarkRun.isError, JSON.stringify(benchmarkRun));
    const savedBenchmark = (benchmarkRun.structuredContent as { result: { id: string; report: { suiteFingerprint: string }; releaseGate: { gateFingerprint: string } } }).result;
    assert.match(savedBenchmark.releaseGate.gateFingerprint, /^[0-9a-f]{64}$/);
    const benchmarkHistory = await client.callTool({ name: 'motion_animation_benchmark_history', arguments: { limit: 10, suiteFingerprint: savedBenchmark.report.suiteFingerprint } });
    assert.ok(!benchmarkHistory.isError, JSON.stringify(benchmarkHistory));
    assert.ok(JSON.stringify(benchmarkHistory.structuredContent).includes(savedBenchmark.id));
    const benchmarkRead = await client.callTool({ name: 'motion_animation_benchmark_read', arguments: { runId: savedBenchmark.id } });
    assert.ok(!benchmarkRead.isError, JSON.stringify(benchmarkRead));
    const benchmarkCaseFingerprint = (benchmarkRead.structuredContent as { result: { report: { cases: { fingerprint: string | null }[] } } }).result.report.cases[0]!.fingerprint;
    assert.equal(benchmarkCaseFingerprint, animationBenchmarkRecipeFingerprint(currentSavedRecipe));
    const dossier = await client.callTool({ name: 'motion_animation_release_dossier', arguments: { assetId: asset.id, benchmarkRunId: savedBenchmark.id } });
    assert.ok(!dossier.isError, JSON.stringify(dossier));
    const dossierResult = (dossier.structuredContent as { result: { technical: { technicalStatus: string; humanApproval: string; canPublish: boolean };
      checks: { id: string; status: string }[]; asset: { fingerprint: string } } }).result;
    assert.equal(dossierResult.technical.technicalStatus, 'incomplete');
    assert.equal(dossierResult.technical.humanApproval, 'required');
    assert.equal(dossierResult.technical.canPublish, false);
    assert.match(dossierResult.asset.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(dossierResult.checks.find(check => check.id === 'offline_benchmark')?.status, 'unknown', JSON.stringify(dossierResult.checks.find(check => check.id === 'offline_benchmark')));
    const cleanRecipe = { kind: 'animation', name: 'Passing benchmark fixture', duration: 1, loop: false,
      markers: [{ name: 'Action', time: 0.5 }], contacts: [{ effector: 'Arm', kind: 'grip', start: 0, end: 1 }],
      tracks: [{ joint: 'Arm', keys: [{ time: 0, rotation: [0, 0, 0] }, { time: 0.5, rotation: [10, 0, 0] }, { time: 1, rotation: [0, 0, 0] }] }] };
    const cleanAssetResult = await client.callTool({ name: 'motion_library_save', arguments: { recipe: cleanRecipe } });
    assert.ok(!cleanAssetResult.isError, JSON.stringify(cleanAssetResult));
    const cleanAsset = (cleanAssetResult.structuredContent as { result: { id: string; recipe: unknown } }).result;
    const blockedGateRun = await client.callTool({ name: 'motion_animation_benchmark_record', arguments: { suite: {
      schemaVersion: 1, cases: [
        { id: 'matching-pass', name: 'Matching recipe passes', recipe: cleanAsset.recipe,
          expectations: [{ id: 'recipe-valid', description: 'Recipe validates.', outcome: 'pass', evidence: 'Strict recipe validation.' }] },
        { id: 'unrelated-fail', name: 'An unrelated recipe fails its declared expectation', recipe: asset.recipe,
          expectations: [{ id: 'intentionally-unmatched', description: 'An absent finding is expected to pass.', outcome: 'pass', evidence: 'Regression fixture.' }] },
      ],
    }, releaseGate: { requireExpectationsPerCase: true } } });
    assert.ok(!blockedGateRun.isError, JSON.stringify(blockedGateRun));
    const blockedGate = (blockedGateRun.structuredContent as { result: { id: string; report: { cases: { status: string; fingerprint: string | null }[] }; releaseGate: { decision: string } } }).result;
    const cleanBenchmarkFingerprint = animationBenchmarkRecipeFingerprint(cleanAsset.recipe);
    const matchingPassingCase = blockedGate.report.cases.find(item => item.fingerprint === cleanBenchmarkFingerprint);
    assert.equal(matchingPassingCase?.status, 'pass', 'the current recipe case passes even though another suite case blocks the release gate');
    assert.equal(blockedGate.releaseGate.decision, 'blocked');
    const blockedDossier = await client.callTool({ name: 'motion_animation_release_dossier', arguments: { assetId: cleanAsset.id, benchmarkRunId: blockedGate.id } });
    assert.ok(!blockedDossier.isError, JSON.stringify(blockedDossier));
    const blockedDossierCheck = (blockedDossier.structuredContent as { result: { checks: { id: string; status: string; detail: string }[] } }).result.checks.find(check => check.id === 'offline_benchmark');
    assert.equal(blockedDossierCheck?.status, 'unknown');
    assert.match(blockedDossierCheck?.detail ?? '', /release gate is blocked/i);
    const benchmarkComparison = await client.callTool({ name: 'motion_animation_benchmark_compare', arguments: { beforeRunId: savedBenchmark.id, afterRunId: savedBenchmark.id } });
    assert.equal(benchmarkComparison.isError, true);
    const patchOperations = [
      { operation: 'set_pose', joint: 'LeftUpperArm', time: 1.5, rotation: [-105, 0, 0] },
      { operation: 'insert_key', joint: 'RightUpperArm', time: 0.75, rotation: [-55, 12, 12] },
      { operation: 'set_easing', joint: 'RightUpperArm', time: 0.5, easingStyle: 'CubicV2', easingDirection: 'InOut' },
    ];
    const libraryBeforePreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const countBeforePreview = (libraryBeforePreview.structuredContent as { result: { total: number } }).result.total;
    const rejectedProtectedEdit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, dryRun: true,
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 1.5, rotation: [-125, 0, 0] }],
      preserve: [{ joint: 'LeftUpperArm', startTime: 1.25, endTime: 1.75 }] } });
    assert.equal(rejectedProtectedEdit.isError, true);
    assert.match(JSON.stringify(rejectedProtectedEdit), /Protected motion changed for LeftUpperArm/);
    const protectedPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, dryRun: true,
      operations: [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-78, -8, -8] }],
      preserve: [{ joint: 'LeftUpperArm', startTime: 1, endTime: 1.5 }] } });
    assert.ok(!protectedPreview.isError, JSON.stringify(protectedPreview));
    const protectedResult = (protectedPreview.structuredContent as { result: { preservation: { maxPositionDrift: number; maxRotationDriftDegrees: number }[] } }).result;
    assert.ok(protectedResult.preservation[0]!.maxPositionDrift <= 0.001);
    assert.ok(protectedResult.preservation[0]!.maxRotationDriftDegrees <= 0.1);
    const libraryAfterProtectedReject = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryAfterProtectedReject.structuredContent as { result: { total: number } }).result.total, countBeforePreview);
    const dryRun = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: patchOperations, dryRun: true, includeAudit: true } });
    assert.ok(!dryRun.isError, JSON.stringify(dryRun));
    const candidate = (dryRun.structuredContent as { result: { dryRun: boolean; baseAssetId: string; candidateFingerprint: string; recipe: { tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[] }; summary: { operationCount: number; affectedTargets: string[] };
      auditImpact: { sampleRateHz: number; changedChannels: { identity: { channel: string; joint: string }; status: string; expectation: string; before?: { angularSpeed: { value: number } }; after?: { angularSpeed: { value: number } }; delta?: { angularSpeed: number } }[];
        unintendedChannelChanges: { channel: string; joint: string }[]; refinementTargetOutcomes: Array<{ status: string; interpretation: string;
          sourceTarget: { measurementProvenance: { sampleWindow: { startTime: number; endTime: number }; crossedBoundaries: unknown[] } };
          candidateTarget?: { measurementProvenance: { sampleWindow: { startTime: number; endTime: number }; crossedBoundaries: unknown[] } };
          measurementComparability?: { status: string; mappedSourceWindow: { startTime: number; endTime: number };
            candidateWindow: { startTime: number; endTime: number }; sourceCrossedBoundaries: unknown[]; candidateCrossedBoundaries: unknown[] } }>;
        advisoryChanges: { added: { id: string }[]; removed: { id: string }[] }; limitation: string } } }).result;
    assert.equal(candidate.dryRun, true);
    assert.equal(candidate.baseAssetId, asset.id);
    assert.equal(candidate.summary.operationCount, patchOperations.length);
    assert.ok(candidate.summary.affectedTargets.includes('LeftUpperArm'));
    assert.equal(candidate.auditImpact.sampleRateHz, 60);
    const leftArmImpact = candidate.auditImpact.changedChannels.find(channel => channel.identity.channel === 'base' && channel.identity.joint === 'LeftUpperArm');
    assert.ok(leftArmImpact?.before && leftArmImpact.after && typeof leftArmImpact.delta?.angularSpeed === 'number');
    assert.equal(leftArmImpact.expectation, 'targeted_by_patch');
    assert.deepEqual(candidate.auditImpact.unintendedChannelChanges, []);
    assert.ok(candidate.auditImpact.refinementTargetOutcomes.every(outcome => outcome.status !== 'resolved' && outcome.interpretation.length > 0));
    assert.ok(candidate.auditImpact.refinementTargetOutcomes.filter(outcome => outcome.candidateTarget).every(outcome =>
      outcome.measurementComparability !== undefined && outcome.candidateTarget?.measurementProvenance.sampleWindow.startTime
        === outcome.measurementComparability.candidateWindow.startTime));
    assert.match(candidate.auditImpact.limitation, /not automatically better/);
    const metricInvariantRecipe: AnimationRecipe = { kind: 'animation', name: 'Metric-invariant direction change', duration: 2, loop: false,
      tracks: [{ joint: 'RightUpperArm', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [10, 0, 0] },
        { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
      ] }], markers: [] };
    const metricInvariantAsset = await new Library(join(directory, 'artifacts', 'library')).save(metricInvariantRecipe);
    const libraryAfterAuditFixture = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const countAfterAuditFixture = (libraryAfterAuditFixture.structuredContent as { result: { total: number } }).result.total;
    assert.equal(countAfterAuditFixture, countBeforePreview + 1);
    const directionPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: metricInvariantAsset.id, dryRun: true, includeAudit: true,
      operations: [{ operation: 'set_pose', joint: 'RightUpperArm', time: 1, rotation: [-10, 0, 0] }] } });
    assert.ok(!directionPreview.isError, JSON.stringify(directionPreview));
    const directionImpact = (directionPreview.structuredContent as { result: { auditImpact: { changedChannels: unknown[]; authoredChannelChanges: { identity: { channel: string; joint: string }; patchTarget: string; beforeFingerprint?: string; afterFingerprint?: string }[]; authoredChannelChangesOutsidePatchTargets: unknown[] } } }).result.auditImpact;
    assert.equal(directionImpact.changedChannels.length, 0);
    assert.equal(directionImpact.authoredChannelChanges.length, 1);
    assert.deepEqual(directionImpact.authoredChannelChanges[0]!.identity, { channel: 'base', joint: 'RightUpperArm' });
    assert.equal(directionImpact.authoredChannelChanges[0]!.patchTarget, 'inside_patch_targets');
    assert.notEqual(directionImpact.authoredChannelChanges[0]!.beforeFingerprint, directionImpact.authoredChannelChanges[0]!.afterFingerprint);
    assert.deepEqual(directionImpact.authoredChannelChangesOutsidePatchTargets, []);
    assert.deepEqual(candidate.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.find(key => key.time === 1.5)?.rotation, [-105, 0, 0]);
    const libraryAfterPreview = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryAfterPreview.structuredContent as { result: { total: number } }).result.total, countAfterAuditFixture);
    const rejectedBatch = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, dryRun: true, operations: [
      { operation: 'set_pose', joint: 'LeftUpperArm', time: 1.5, rotation: [-120, 0, 0] },
      { operation: 'set_pose', joint: 'MissingJoint', time: 1.5, rotation: [0, 0, 0] },
    ] } });
    assert.equal(rejectedBatch.isError, true);
    const libraryAfterRejectedBatch = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((libraryAfterRejectedBatch.structuredContent as { result: { total: number } }).result.total, countAfterAuditFixture);
    const unboundCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: patchOperations } });
    assert.equal(unboundCommit.isError, true);
    assert.match(JSON.stringify(unboundCommit), /require expectedCandidateFingerprint/i);
    const staleCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: patchOperations, expectedCandidateFingerprint: '0'.repeat(64) } });
    assert.equal(staleCommit.isError, true);
    assert.match(JSON.stringify(staleCommit), /candidate differs/i);
    const deterministicLayerOps = [{ operation: 'layer_create', name: 'Preview Bound Layer', blendMode: 'Additive', weight: 0.5 }];
    const deterministicPreviewA = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: deterministicLayerOps, dryRun: true } });
    const deterministicPreviewB = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: deterministicLayerOps, dryRun: true } });
    assert.ok(!deterministicPreviewA.isError && !deterministicPreviewB.isError);
    const layerCandidateA = (deterministicPreviewA.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const layerCandidateB = (deterministicPreviewB.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    assert.equal(layerCandidateA, layerCandidateB);
    const layerCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: deterministicLayerOps, expectedCandidateFingerprint: layerCandidateA } });
    assert.ok(!layerCommit.isError, JSON.stringify(layerCommit));
    const layerAsset = (layerCommit.structuredContent as { result: { assetId: string; recipe: { layers: { id: string }[] } } }).result;
    const createdLayerId = layerAsset.recipe.layers[0]!.id;
    const composedLayerPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: layerAsset.assetId, dryRun: true, includeAudit: true,
      operations: [{ operation: 'layer_set_track', layerId: createdLayerId, track: asset.recipe.tracks[0] }, { operation: 'layer_set', layerId: createdLayerId, weight: 0.25 }] } });
    assert.ok(!composedLayerPreview.isError, JSON.stringify(composedLayerPreview));
    const composedLayerImpact = (composedLayerPreview.structuredContent as { result: { auditImpact: { unmeasuredCompositionChanges: { operation: string; layerId?: string }[] } } }).result.auditImpact;
    assert.ok(composedLayerImpact.unmeasuredCompositionChanges.some(change => change.operation === 'layer_set_track' && change.layerId === createdLayerId));
    assert.ok(composedLayerImpact.unmeasuredCompositionChanges.some(change => change.operation === 'layer_set' && change.layerId === createdLayerId));
    const patched = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: patchOperations, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.ok(!patched.isError, JSON.stringify(patched));
    const child = (patched.structuredContent as { result: { assetId: string; parentId: string; recipe: { tracks: { joint: string; keys: { time: number; rotation: number[]; easingStyle?: string; easingDirection?: string }[] }[] } } }).result;
    assert.notEqual(child.assetId, asset.id);
    assert.equal(child.parentId, asset.id);
    assert.deepEqual(child.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.find(key => key.time === 1.5)?.rotation, [-105, 0, 0]);
    assert.ok(child.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.some(key => key.time === 0.75));
    assert.equal(child.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.find(key => key.time === 0.5)?.easingStyle, 'CubicV2');
    assert.equal(child.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys.find(key => key.time === 0.5)?.easingDirection, 'InOut');
    const retimeOperations = [
      { operation: 'retime_clip', duration: 4 },
    ];
    const retimePreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: retimeOperations, dryRun: true, includeAudit: true } });
    const retimeCandidate = (retimePreview.structuredContent as { result: { candidateFingerprint: string; auditImpact: { refinementTargetOutcomes: Array<{
      status: string; sourceTarget: { keySegment: { startTime: number; endTime: number } };
      candidateRegion: { startTime: number; endTime: number };
      measurementComparability?: { status: string; mappedSourceWindow: { startTime: number; endTime: number }; candidateWindow: { startTime: number; endTime: number } } }>;
      unmeasuredCompositionChanges: unknown[] } } }).result;
    const retimeCandidateFingerprint = retimeCandidate.candidateFingerprint;
    const retimeScale = 4 / asset.recipe.duration;
    assert.deepEqual(retimeCandidate.auditImpact.unmeasuredCompositionChanges, []);
    assert.ok(retimeCandidate.auditImpact.refinementTargetOutcomes.some(outcome => outcome.status === 'still_ranked_in_region'
      && Math.abs(outcome.candidateRegion.startTime - outcome.sourceTarget.keySegment.startTime * retimeScale) < 1e-8
      && Math.abs(outcome.candidateRegion.endTime - outcome.sourceTarget.keySegment.endTime * retimeScale) < 1e-8));
    assert.ok(retimeCandidate.auditImpact.refinementTargetOutcomes.some(outcome => outcome.measurementComparability?.status === 'changed_stencil'
      && Math.abs((outcome.measurementComparability.mappedSourceWindow.endTime - outcome.measurementComparability.mappedSourceWindow.startTime)
        - 2 * (outcome.measurementComparability.candidateWindow.endTime - outcome.measurementComparability.candidateWindow.startTime)) < 1e-8));
    const retimed = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: retimeOperations, expectedCandidateFingerprint: retimeCandidateFingerprint } });
    assert.ok(!retimed.isError, JSON.stringify(retimed));
    const retimedChild = (retimed.structuredContent as { result: { assetId: string; parentId: string; recipe: { duration: number; tracks: { joint: string; keys: { time: number }[] }[] } } }).result;
    assert.notEqual(retimedChild.assetId, asset.id);
    assert.equal(retimedChild.parentId, asset.id);
    assert.equal(retimedChild.recipe.duration, 4);
    assert.ok(retimedChild.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.some(key => key.time === 1));
    const mirrorOperations = [
      { operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', time: 0.5, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] },
    ];
    const mirrorPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: mirrorOperations, dryRun: true } });
    const mirrorCandidateFingerprint = (mirrorPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const mirrored = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: mirrorOperations, expectedCandidateFingerprint: mirrorCandidateFingerprint } });
    assert.ok(!mirrored.isError, JSON.stringify(mirrored));
    const mirroredRecipe = (mirrored.structuredContent as { result: { recipe: { tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[] } } }).result.recipe;
    const sourcePose = mirroredRecipe.tracks.find(track => track.joint === 'RightUpperArm')!.keys.find(key => key.time === 0.5)!;
    const targetPose = mirroredRecipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.5)!;
    assert.deepEqual(targetPose.rotation, sourcePose.rotation.map((value, axis) => value * [1, -1, -1][axis]!));
    const mirrorTracksOperations = [{ operation: 'mirror_tracks', replaceExisting: true, mappings: [
      { sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] },
      { sourceJoint: 'LeftUpperArm', targetJoint: 'RightUpperArm', positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] },
    ] }];
    const mirrorTracksPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: mirrorTracksOperations, dryRun: true } });
    assert.ok(!mirrorTracksPreview.isError, JSON.stringify(mirrorTracksPreview));
    const mirrorTracksCandidate = (mirrorTracksPreview.structuredContent as { result: { candidateFingerprint: string; changes: { operation: string; sourceJoint?: string; joint: string }[] } }).result;
    assert.equal(mirrorTracksCandidate.changes.filter(change => change.operation === 'mirror_tracks').length, 2);
    const mirrorTracksCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: mirrorTracksOperations, expectedCandidateFingerprint: mirrorTracksCandidate.candidateFingerprint } });
    assert.ok(!mirrorTracksCommit.isError, JSON.stringify(mirrorTracksCommit));
    const transformOperations = [
      { operation: 'transform_track', joint: 'LeftUpperArm', sourceJoint: 'RightUpperArm', positionScale: [-1, 1, 1], rotationScale: [1, -1, -1], replaceExisting: true },
    ];
    const transformPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: transformOperations, dryRun: true } });
    const transformCandidateFingerprint = (transformPreview.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const transformedTrack = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: transformOperations, expectedCandidateFingerprint: transformCandidateFingerprint } });
    assert.ok(!transformedTrack.isError, JSON.stringify(transformedTrack));
    const transformedRecipe = (transformedTrack.structuredContent as { result: { recipe: { tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[] } } }).result.recipe;
    const transformedSource = transformedRecipe.tracks.find(track => track.joint === 'RightUpperArm')!;
    const transformedTarget = transformedRecipe.tracks.find(track => track.joint === 'LeftUpperArm')!;
    assert.deepEqual(transformedTarget.keys.map(key => key.time), transformedSource.keys.map(key => key.time));
    assert.deepEqual(transformedTarget.keys[2]!.rotation, transformedSource.keys[2]!.rotation.map((value, axis) => value * [1, -1, -1][axis]!));
    const wrongRigPose = await client.callTool({ name: 'motion_pose_save', arguments: { name: 'R6 Only', rigType: 'R6', transforms: [{ joint: 'RightUpperArm', rotation: [-20, 0, 0] }] } });
    const wrongRigPoseId = (wrongRigPose.structuredContent as { result: { id: string } }).result.id;
    const unknownRigPreview = await client.callTool({ name: 'motion_pose_preview', arguments: { poseId: wrongRigPoseId, animationAssetId: asset.id, time: 0.5 } });
    assert.ok(!unknownRigPreview.isError, JSON.stringify(unknownRigPreview));
    assert.equal((unknownRigPreview.structuredContent as { result: { rigCompatibility: { status: string } } }).result.rigCompatibility.status, 'unknown',
      'assets without verified source-rig provenance must not be labeled compatible or incompatible');
    const unboundSnapshotPreview = await client.callTool({ name: 'motion_pose_preview', arguments: { poseId: snapshotId, animationAssetId: asset.id, time: 0.5 } });
    assert.equal(unboundSnapshotPreview.isError, true);
    assert.match(JSON.stringify(unboundSnapshotPreview.content), /require sessionId and rigId for live topology validation/i);
    const poseApplyArgs = { poseId, animationAssetId: asset.id, time: 0.5, weight: 0.5 };
    const poseApplyPreview = await client.callTool({ name: 'motion_pose_preview', arguments: poseApplyArgs });
    assert.ok(!poseApplyPreview.isError, JSON.stringify(poseApplyPreview));
    const poseApplyCandidate = (poseApplyPreview.structuredContent as { result: { candidateFingerprint: string; appliedJoints: string[] } }).result;
    assert.ok(poseApplyCandidate.appliedJoints.includes('RightUpperArm'));
    const stalePoseApply = await client.callTool({ name: 'motion_pose_apply', arguments: { ...poseApplyArgs, expectedCandidateFingerprint: '0'.repeat(64) } });
    assert.equal(stalePoseApply.isError, true);
    assert.match(JSON.stringify(stalePoseApply.content), /does not match the reviewed fingerprint/i);
    const poseApplied = await client.callTool({ name: 'motion_pose_apply', arguments: { ...poseApplyArgs, expectedCandidateFingerprint: poseApplyCandidate.candidateFingerprint } });
    assert.ok(!poseApplied.isError, JSON.stringify(poseApplied));
    assert.ok((poseApplied.structuredContent as { result: { appliedJoints: string[] } }).result.appliedJoints.includes('RightUpperArm'));
    const layerCreateOperations = [{ operation: 'layer_create', name: 'Pose MCP Layer', blendMode: 'Override', weight: 1 }];
    const layerCreatePreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: layerCreateOperations, dryRun: true } });
    assert.ok(!layerCreatePreview.isError, JSON.stringify(layerCreatePreview));
    const layerCreateCandidate = (layerCreatePreview.structuredContent as { result: { candidateFingerprint: string; recipe: { layers: { id: string }[] } } }).result;
    const poseLayerId = layerCreateCandidate.recipe.layers[0]!.id;
    const layerCreateCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: layerCreateOperations, expectedCandidateFingerprint: layerCreateCandidate.candidateFingerprint } });
    assert.ok(!layerCreateCommit.isError, JSON.stringify(layerCreateCommit));
    const layerAssetId = (layerCreateCommit.structuredContent as { result: { assetId: string } }).result.assetId;
    const layerTrackOperations = [{ operation: 'layer_set_track', layerId: poseLayerId, track: { joint: 'RightUpperArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] } }];
    const layerTrackPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: layerAssetId, operations: layerTrackOperations, dryRun: true } });
    assert.ok(!layerTrackPreview.isError, JSON.stringify(layerTrackPreview));
    const layerTrackCandidate = (layerTrackPreview.structuredContent as { result: { candidateFingerprint: string } }).result;
    const layerTrackCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: layerAssetId, operations: layerTrackOperations, expectedCandidateFingerprint: layerTrackCandidate.candidateFingerprint } });
    assert.ok(!layerTrackCommit.isError, JSON.stringify(layerTrackCommit));
    const layeredAssetId = (layerTrackCommit.structuredContent as { result: { assetId: string } }).result.assetId;
    const layerPoseArgs = { poseId, animationAssetId: layeredAssetId, time: 0.5, layerId: poseLayerId };
    const layerPosePreview = await client.callTool({ name: 'motion_pose_preview', arguments: layerPoseArgs });
    assert.ok(!layerPosePreview.isError, JSON.stringify(layerPosePreview));
    const layerPoseCandidate = (layerPosePreview.structuredContent as { result: { candidateFingerprint: string; layerId: string; recipe: { tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[]; layers: { id: string; tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[] }[] } } }).result;
    assert.equal(layerPoseCandidate.layerId, poseLayerId);
    assert.deepEqual(layerPoseCandidate.recipe.tracks, (layerTrackPreview.structuredContent as { result: { recipe: { tracks: unknown[] } } }).result.recipe.tracks,
      'layer-targeted pose preview must not alter base channels');
    assert.ok(layerPoseCandidate.recipe.layers[0]?.tracks[0]?.keys.some(key => key.time === 0.5));
    const wrongLayerCommit = await client.callTool({ name: 'motion_pose_apply', arguments: { ...layerPoseArgs, layerId: undefined,
      expectedCandidateFingerprint: layerPoseCandidate.candidateFingerprint } });
    assert.equal(wrongLayerCommit.isError, true, 'the reviewed destination layer must be bound into the pose fingerprint');
    const layerPoseCommit = await client.callTool({ name: 'motion_pose_apply', arguments: { ...layerPoseArgs, expectedCandidateFingerprint: layerPoseCandidate.candidateFingerprint } });
    assert.ok(!layerPoseCommit.isError, JSON.stringify(layerPoseCommit));
    const savedLayerPose = (layerPoseCommit.structuredContent as { result: { recipe: { layers: { id: string; tracks: { joint: string; keys: { time: number }[] }[] }[] } } }).result.recipe;
    assert.ok(savedLayerPose.layers.find(layer => layer.id === poseLayerId)?.tracks[0]?.keys.some(key => key.time === 0.5));
    const offline = await client.callTool({ name: 'motion_studio_inspect', arguments: { rigId: randomUUID() } });
    assert.equal(offline.isError, true);
    assert.match(JSON.stringify(offline.content), /Connect one Studio plugin/);
    const connection = JSON.parse(await readFile(join(directory, '.local', 'connection.json'), 'utf8')) as { token: string };
    const sessionId = randomUUID(), rigId = randomUUID();
    const rigSignature = 'R15|Root>UpperTorso:Motor6D';
    const heartbeat = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    assert.equal(heartbeat.status, 200);
    const snapshotApplyArgs = { poseId: snapshotId, animationAssetId: asset.id, time: 0.5, sessionId, rigId };
    const snapshotPreview = await client.callTool({ name: 'motion_pose_preview', arguments: snapshotApplyArgs });
    assert.ok(!snapshotPreview.isError, JSON.stringify(snapshotPreview));
    const snapshotCandidate = (snapshotPreview.structuredContent as { result: { candidateFingerprint: string; rigSignature: string; rigCompatibility: { status: string }; createdTracks: string[] } }).result;
    assert.equal(snapshotCandidate.rigSignature, rigSignature);
    assert.equal(snapshotCandidate.rigCompatibility.status, 'unknown', 'matching topology does not establish source animation rig provenance');
    assert.ok(Array.isArray(snapshotCandidate.createdTracks), 'snapshot preview should disclose every track added to the source animation');
    const snapshotCommit = await client.callTool({ name: 'motion_pose_apply', arguments: { ...snapshotApplyArgs, expectedCandidateFingerprint: snapshotCandidate.candidateFingerprint } });
    assert.ok(!snapshotCommit.isError, JSON.stringify(snapshotCommit));
    const changedTopology = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature: 'R15|Root>DifferentTorso:Motor6D' } } }) });
    assert.equal(changedTopology.status, 200);
    const staleTopologyPreview = await client.callTool({ name: 'motion_pose_preview', arguments: snapshotApplyArgs });
    assert.equal(staleTopologyPreview.isError, true);
    assert.match(JSON.stringify(staleTopologyPreview.content), /topology does not match the active Studio rig/i);
    const restoreTopology = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    assert.equal(restoreTopology.status, 200);
    const boundTransitionInput = { ...transitionInput, sessionId, rigId };
    const boundTransitionPreview = await client.callTool({ name: 'motion_pose_transition_preview', arguments: boundTransitionInput });
    assert.ok(!boundTransitionPreview.isError, JSON.stringify(boundTransitionPreview));
    const boundTransitionCandidate = (boundTransitionPreview.structuredContent as { result: { candidateFingerprint: string;
      rigId: string; rigSignature: string | null; sourceRigProfileFingerprint: string; poseRigCompatibility: { status: string }[] } }).result;
    assert.equal(boundTransitionCandidate.rigId, rigId);
    assert.equal(boundTransitionCandidate.rigSignature, rigSignature);
    assert.equal(boundTransitionCandidate.poseRigCompatibility[0]?.status, 'unknown');
    const sameRigOtherSessionId = randomUUID();
    const sameRigOtherSessionHeartbeat = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId: sameRigOtherSessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    assert.equal(sameRigOtherSessionHeartbeat.status, 200);
    const reboundTransitionCommit = await client.callTool({ name: 'motion_pose_transition_apply', arguments: {
      ...boundTransitionInput, sessionId: sameRigOtherSessionId, expectedCandidateFingerprint: boundTransitionCandidate.candidateFingerprint } });
    assert.equal(reboundTransitionCommit.isError, true);
    assert.match(JSON.stringify(reboundTransitionCommit.content), /differs from its reviewed preview/i,
      'the same topology and rig ID in a different Studio session must not inherit the preview fingerprint');
    const targetProfileForSession = { ...targetProfile, rigId, rigName: 'Live target rig', rigSignature };
    const inspectThroughBridge = async (inspectedProfile: typeof sourceProfile) => {
      const selected = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: inspectedProfile.rigId, rigSignature: inspectedProfile.rigSignature } } }) });
      assert.equal(selected.status, 200);
      const inspectionRequest = await client.callTool({ name: 'motion_studio_inspect', arguments: { sessionId, rigId: inspectedProfile.rigId } });
      assert.ok(!inspectionRequest.isError, JSON.stringify(inspectionRequest));
      const inspectionJobId = (inspectionRequest.structuredContent as { result: { jobId: string } }).result.jobId;
      const inspectionPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: inspectedProfile.rigId, rigSignature: inspectedProfile.rigSignature } } }) });
      const inspectionCommand = (await inspectionPoll.json() as { command: { id: string; operation: string; payload: { rigId: string } } }).command;
      assert.equal(inspectionCommand.id, inspectionJobId);
      assert.equal(inspectionCommand.operation, 'inspect');
      assert.equal(inspectionCommand.payload.rigId, inspectedProfile.rigId);
      const inspectionCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: inspectionJobId, ok: true, result: { id: inspectedProfile.rigId, retargetProfile: inspectedProfile } }) });
      assert.equal(inspectionCompletion.status, 200);
    };
    await inspectThroughBridge(sourceProfile);
    await inspectThroughBridge(targetProfileForSession);
    const semanticResolution = await client.callTool({ name: 'motion_animation_resolve_rig_semantics', arguments: {
      sessionId, rigId, roles: ['left_shoulder', 'right_shoulder', 'left_hand'],
    } });
    assert.ok(!semanticResolution.isError, JSON.stringify(semanticResolution));
    const semanticResult = (semanticResolution.structuredContent as { result: { inspection: { profileFingerprint: string }; resolutions: { role: string; status: string; joint?: string }[]; limitations: string[] } }).result;
    assert.match(semanticResult.inspection.profileFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(semanticResult.resolutions.map(item => [item.role, item.status, item.joint]), [
      ['left_shoulder', 'exact', 'LeftUpperArm'], ['right_shoulder', 'exact', 'RightUpperArm'], ['left_hand', 'unavailable', undefined],
    ]);
    assert.match(semanticResult.limitations.join(' '), /Exact indicates a recognized R6\/R15 joint-name convention/);
    const cachedMapping = await client.callTool({ name: 'motion_animation_suggest_joint_map', arguments: { assetId: asset.id, sessionId, sourceRigId: sourceProfile.rigId, targetRigId: rigId } });
    assert.ok(!cachedMapping.isError, JSON.stringify(cachedMapping));
    const cachedMappingResult = (cachedMapping.structuredContent as { result: { inspection: { sourceAgeMs: number; targetAgeMs: number }; suggestedJointMap: Record<string, string> } }).result;
    assert.ok(cachedMappingResult.inspection.sourceAgeMs >= 0 && cachedMappingResult.inspection.targetAgeMs >= 0);
    assert.equal(cachedMappingResult.suggestedJointMap.LeftUpperArm, 'LeftUpperArm');
    const provenanceAssetCall = await client.callTool({ name: 'motion_library_save', arguments: { recipe: asset.recipe, parentId: asset.id, sessionId, rigId } });
    assert.ok(!provenanceAssetCall.isError, JSON.stringify(provenanceAssetCall));
    const provenanceAsset = (provenanceAssetCall.structuredContent as { result: { id: string; sourceRigProfile: { rigId: string; rigSignature: string } } }).result;
    assert.equal(provenanceAsset.sourceRigProfile.rigId, rigId);
    assert.equal(provenanceAsset.sourceRigProfile.rigSignature, rigSignature);
    const provenanceMapping = await client.callTool({ name: 'motion_animation_suggest_joint_map', arguments: { assetId: provenanceAsset.id, sessionId, targetRigId: rigId } });
    assert.ok(!provenanceMapping.isError, JSON.stringify(provenanceMapping));
    assert.equal((provenanceMapping.structuredContent as { result: { suggestedJointMap: Record<string, string> } }).result.suggestedJointMap.RightUpperArm, 'RightUpperArm');
    const provenanceRetargetInput = { assetId: provenanceAsset.id, sessionId, targetRigId: rigId };
    const provenanceRetargetPreview = await client.callTool({ name: 'motion_animation_retarget_preview', arguments: provenanceRetargetInput });
    assert.ok(!provenanceRetargetPreview.isError, JSON.stringify(provenanceRetargetPreview));
    const provenanceRetargetCandidate = (provenanceRetargetPreview.structuredContent as { result: { candidateFingerprint: string } }).result;
    const provenanceRetarget = await client.callTool({ name: 'motion_animation_retarget', arguments: { ...provenanceRetargetInput, expectedCandidateFingerprint: provenanceRetargetCandidate.candidateFingerprint } });
    assert.equal(provenanceRetarget.isError, true, 'a live profile inspection alone must not authorize a retarget write');
    assert.match(JSON.stringify(provenanceRetarget), /No fresh exact retarget evaluation receipt/i);
    const mappedRetargetEvaluation = await client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: (provenanceRetargetPreview.structuredContent as { result: { recipe: AnimationRecipe } }).result.recipe,
      sessionId, rigId, jointMap: { RightUpperArm: 'LeftUpperArm' },
      retargetPreview: { ...provenanceRetargetInput, expectedCandidateFingerprint: provenanceRetargetCandidate.candidateFingerprint },
    } });
    assert.equal(mappedRetargetEvaluation.isError, true, 'the post-retarget evaluation must not silently apply another channel map');
    assert.match(JSON.stringify(mappedRetargetEvaluation), /without an additional jointMap/i);
    const boundRetargetEvaluationPending = client.callTool({ name: 'motion_animation_candidate_evaluate', arguments: {
      recipe: (provenanceRetargetPreview.structuredContent as { result: { recipe: AnimationRecipe } }).result.recipe,
      sessionId, rigId, retargetPreview: { ...provenanceRetargetInput, expectedCandidateFingerprint: provenanceRetargetCandidate.candidateFingerprint },
    } });
    let sampleCommand: { id: string; payload: { assetId: string; rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] } } | undefined;
    for (let attempt = 0; attempt < 100 && !sampleCommand; attempt++) {
      const samplePoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
      const samplePollBody = await samplePoll.json() as { command?: { id: string; operation: string; payload: { assetId: string; rigId: string; rigSignature: string; recipe: AnimationRecipe; times: number[] } } };
      if (samplePollBody.command?.operation === 'sample_animation') sampleCommand = samplePollBody.command;
      else await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(sampleCommand, 'the bound exact candidate evaluation must request live Studio sampling');
    const evaluationNodes = targetProfileForSession.joints.map(joint => ({ name: joint.name,
      parent: joint.parent ? targetProfileForSession.joints.findIndex(candidate => candidate.name === joint.parent) + 1 : 0,
      driven: joint.driven, foot: false }));
    const sampleCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, id: sampleCommand.id, ok: true, result: {
        version: 1, source: 'studio_pose_evaluator', rigId: sampleCommand.payload.rigId, rigSignature: sampleCommand.payload.rigSignature,
        assetId: sampleCommand.payload.assetId, duration: sampleCommand.payload.recipe.duration, loop: sampleCommand.payload.recipe.loop,
        height: 5, groundSource: 'rest_node_bounds', note: 'bound retarget receipt fixture', nodes: evaluationNodes,
        samples: sampleCommand.payload.times.map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
          points: evaluationNodes.map(() => [0, 0, 0]), bottoms: evaluationNodes.map(() => 0), orientations: evaluationNodes.map(() => [0, 0, 0, 1]) })),
      } }) });
    assert.equal(sampleCompletion.status, 200);
    const boundRetargetEvaluation = await boundRetargetEvaluationPending;
    assert.ok(!boundRetargetEvaluation.isError, JSON.stringify(boundRetargetEvaluation));
    const boundEvaluationResult = (boundRetargetEvaluation.structuredContent as { result: { viewportReadiness: { status: string }; retargetPreviewEvidence: { candidateFingerprint: string } | null } }).result;
    assert.equal(boundEvaluationResult.viewportReadiness.status, 'ready');
    assert.equal(boundEvaluationResult.retargetPreviewEvidence?.candidateFingerprint, provenanceRetargetCandidate.candidateFingerprint);
    const retargetCountBeforeCommit = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    const retargetCountBefore = (retargetCountBeforeCommit.structuredContent as { result: { total: number } }).result.total;
    const evaluatedRetargetCommit = await client.callTool({ name: 'motion_animation_retarget', arguments: {
      ...provenanceRetargetInput, expectedCandidateFingerprint: provenanceRetargetCandidate.candidateFingerprint,
    } });
    assert.ok(!evaluatedRetargetCommit.isError, JSON.stringify(evaluatedRetargetCommit));
    const evaluatedRetargetResult = (evaluatedRetargetCommit.structuredContent as { result: { assetId: string; parentId: string; candidateFingerprint: string; sourceRigProfile: { rigId: string; rigSignature: string } } }).result;
    assert.equal(evaluatedRetargetResult.parentId, provenanceAsset.id);
    assert.equal(evaluatedRetargetResult.candidateFingerprint, provenanceRetargetCandidate.candidateFingerprint);
    assert.equal(evaluatedRetargetResult.sourceRigProfile.rigId, rigId);
    assert.equal(evaluatedRetargetResult.sourceRigProfile.rigSignature, rigSignature);
    assert.equal((evaluatedRetargetCommit.structuredContent as { result: { idempotentIdentity: boolean } }).result.idempotentIdentity, true);
    const retriedRetargetCommit = await client.callTool({ name: 'motion_animation_retarget', arguments: {
      ...provenanceRetargetInput, expectedCandidateFingerprint: provenanceRetargetCandidate.candidateFingerprint,
    } });
    assert.ok(!retriedRetargetCommit.isError, JSON.stringify(retriedRetargetCommit));
    assert.equal((retriedRetargetCommit.structuredContent as { result: { assetId: string } }).result.assetId, evaluatedRetargetResult.assetId,
      'retrying an exact retarget commit must return the same immutable child');
    const retargetCountAfterRetry = await client.callTool({ name: 'motion_library_list', arguments: { offset: 0, limit: 100 } });
    assert.equal((retargetCountAfterRetry.structuredContent as { result: { total: number } }).result.total, retargetCountBefore + 1,
      'an exact retarget commit retry must not create a duplicate library asset');
    const ikOutsideClip = await client.callTool({ name: 'motion_studio_ik_pose', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightHand', time: 2.01, offset: [0, 0, 0] } });
    assert.equal(ikOutsideClip.isError, true);
    const ikQueued = await client.callTool({ name: 'motion_studio_ik_pose', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightHand', time: 1, offset: [0.2, 0.8, -0.1] } });
    assert.ok(!ikQueued.isError, JSON.stringify(ikQueued));
    const ikJobId = (ikQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const ikPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const ikCommand = (await ikPoll.json() as { command: { id: string; operation: string; payload: { limb: string; time: number; offset: number[]; recipe: unknown } } }).command;
    assert.equal(ikCommand.id, ikJobId);
    assert.equal(ikCommand.operation, 'ik_pose');
    assert.equal(ikCommand.payload.limb, 'RightHand');
    assert.deepEqual(ikCommand.payload.offset, [0.2, 0.8, -0.1]);
    assert.ok(ikCommand.payload.recipe);
    const ikResultPayload = { assetId: asset.id, parentId: asset.id, limb: 'RightHand', joint: 'RightHand', time: 1, offset: [0.2, 0.8, -0.1], residual: 0.02, recipe: asset.recipe };
    const ikCompleted = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: ikJobId, ok: true, result: ikResultPayload }) });
    assert.equal(ikCompleted.status, 200);
    const ikJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: ikJobId } });
    assert.equal((ikJob.structuredContent as { result: { status: string; result: { residual: number } } }).result.status, 'succeeded');
    assert.equal((ikJob.structuredContent as { result: { result: { residual: number } } }).result.result.residual, 0.02);
    const ikChild = await client.callTool({ name: 'motion_library_save', arguments: { parentId: asset.id, recipe: ikResultPayload.recipe } });
    assert.ok(!ikChild.isError, JSON.stringify(ikChild));
    assert.equal((ikChild.structuredContent as { result: { parentId: string } }).result.parentId, asset.id);
    const invalidContactRange = await client.callTool({ name: 'motion_studio_ik_contact', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightFoot', startTime: 1, endTime: 1 } });
    assert.equal(invalidContactRange.isError, true);
    const invalidPoleTarget = await client.callTool({ name: 'motion_studio_ik_contact', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightFoot', startTime: 0.5, endTime: 1.5, poleTarget: [10001, 0, 0] } });
    assert.equal(invalidPoleTarget.isError, true, 'Pole targets outside the bounded Studio world range are rejected before queueing');
    const invalidTargetPath = await client.callTool({ name: 'motion_studio_ik_contact', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightFoot', startTime: 0.5, endTime: 1.5, targetPath: [{ time: 0.5, position: [0, 0, 0] }, { time: 1.4, position: [1, 0, 0] }] } });
    assert.equal(invalidTargetPath.isError, true);
    assert.match(JSON.stringify(invalidTargetPath), /cover the complete contact interval/i);
    const targetPath = [{ time: 0.5, position: [0, 0, 0] }, { time: 1, position: [0.5, 1, 0] }, { time: 1.5, position: [1, 0, 0] }];
    const savedTargetPath = await client.callTool({ name: 'motion_ik_target_path_save', arguments: { name: 'Moving platform test', description: 'Path for the integration fixture', tags: ['test', 'platform'], samples: targetPath } });
    assert.ok(!savedTargetPath.isError, JSON.stringify(savedTargetPath));
    const targetPathAssetId = (savedTargetPath.structuredContent as { result: { id: string; fingerprint: string } }).result.id;
    const listedTargetPaths = await client.callTool({ name: 'motion_ik_target_path_list', arguments: { tag: 'PLATFORM' } });
    assert.equal((listedTargetPaths.structuredContent as { result: { total: number } }).result.total, 1);
    const readTargetPath = await client.callTool({ name: 'motion_ik_target_path_read', arguments: { assetId: targetPathAssetId } });
    assert.deepEqual((readTargetPath.structuredContent as { result: { path: { samples: unknown[] } } }).result.path.samples, targetPath);
    const analyzedTargetPath = await client.callTool({ name: 'motion_ik_target_path_analyze', arguments: { assetId: targetPathAssetId, interpolation: 'centripetal_catmull_rom', sampleRateHz: 30,
      maxPeakSpeedStudsPerSecond: 0, maxDeviationFromWaypointChordsStuds: 0 } });
    assert.ok(!analyzedTargetPath.isError, JSON.stringify(analyzedTargetPath));
    const pathAnalysis = (analyzedTargetPath.structuredContent as { result: { assetId: string; fingerprint: string; targetPathFingerprint: string; interpolation: string; sampleRateHz: number; waypointCount: number; sampleCount: number; pathLengthStuds: number; maximumDeviationFromWaypointChordsStuds: number; maximumDeviationTime: number; status: string; checks: { metric: string; status: string }[]; warnings: { metric: string }[] } }).result;
    assert.equal(pathAnalysis.assetId, targetPathAssetId);
    assert.match(pathAnalysis.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(pathAnalysis.targetPathFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(pathAnalysis.interpolation, 'centripetal_catmull_rom');
    assert.equal(pathAnalysis.sampleRateHz, 30);
    assert.equal(pathAnalysis.waypointCount, targetPath.length);
    assert.ok(pathAnalysis.sampleCount >= targetPath.length);
    assert.ok(pathAnalysis.pathLengthStuds > 0);
    assert.ok(pathAnalysis.maximumDeviationFromWaypointChordsStuds > 0);
    assert.ok(pathAnalysis.maximumDeviationTime >= 0.5 && pathAnalysis.maximumDeviationTime <= 1.5);
    assert.equal(pathAnalysis.status, 'limits_exceeded');
    assert.ok(pathAnalysis.checks.every(check => check.status === 'exceeded'));
    assert.equal(pathAnalysis.warnings.length, 2);
    const inlinePathAnalysis = await client.callTool({ name: 'motion_ik_target_path_analyze', arguments: { samples: targetPath, interpolation: 'centripetal_catmull_rom', sampleRateHz: 30 } });
    assert.ok(!inlinePathAnalysis.isError, JSON.stringify(inlinePathAnalysis));
    assert.equal((inlinePathAnalysis.structuredContent as { result: { targetPathFingerprint: string } }).result.targetPathFingerprint, pathAnalysis.targetPathFingerprint);
    const changedTargetPath = targetPath.map((sample, index) => index === 0 ? { ...sample, position: [sample.position[0]! + 0.1, sample.position[1]!, sample.position[2]!] } : sample);
    const changedPathGuard = await client.callTool({ name: 'motion_studio_ik_contact', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightFoot', startTime: 0.5, endTime: 1.5,
      targetPath: changedTargetPath, expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint } });
    assert.equal(changedPathGuard.isError, true);
    assert.match(JSON.stringify(changedPathGuard), /changed since analysis/i);
    const contactQueued = await client.callTool({ name: 'motion_studio_ik_contact', arguments: { sessionId, rigId, assetId: asset.id, limb: 'RightFoot', startTime: 0.5, endTime: 1.5, sampleRateHz: 30, toleranceStuds: 0.08, targetPathAssetId, targetPathInterpolation: 'centripetal_catmull_rom', expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint, poleTarget: [2, 3, 4] } });
    assert.ok(!contactQueued.isError, JSON.stringify(contactQueued));
    const contactJobId = (contactQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const contactPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const contactCommand = (await contactPoll.json() as { command: { id: string; operation: string; payload: { limb: string; startTime: number; endTime: number; sampleRateHz: number; toleranceStuds: number; offset: number[]; poleTarget: number[]; targetPath: { time: number; position: number[] }[]; targetPathAssetId?: string; targetPathFingerprint: string; targetPathInterpolation: string; recipe: unknown } } }).command;
    assert.equal(contactCommand.id, contactJobId);
    assert.equal(contactCommand.operation, 'ik_contact');
    assert.equal(contactCommand.payload.limb, 'RightFoot');
    assert.equal(contactCommand.payload.startTime, 0.5);
    assert.equal(contactCommand.payload.endTime, 1.5);
    assert.equal(contactCommand.payload.sampleRateHz, 30);
    assert.equal(contactCommand.payload.toleranceStuds, 0.08);
    assert.deepEqual(contactCommand.payload.offset, [0, 0, 0]);
    assert.deepEqual(contactCommand.payload.poleTarget, [2, 3, 4]);
    assert.deepEqual(contactCommand.payload.targetPath, targetPath);
    assert.equal(contactCommand.payload.targetPathAssetId, targetPathAssetId);
    assert.equal(contactCommand.payload.targetPathInterpolation, 'centripetal_catmull_rom');
    assert.equal(contactCommand.payload.targetPathFingerprint, pathAnalysis.targetPathFingerprint);
    assert.ok(contactCommand.payload.recipe);
    const contactResultPayload = { assetId: asset.id, parentId: asset.id, rigId, limb: 'RightFoot', joint: 'RightFoot', startTime: 0.5, endTime: 1.5,
      targetWorldPosition: [0, 0, 0], poleTargetWorldPosition: [2, 3, 4],
      bendPlane: { status: 'measured', sampleCount: 2, measuredSampleCount: 2, maximumErrorDegrees: 4, rmsErrorDegrees: 3, maximumErrorTime: 1.5,
        unmeasuredTimes: [], samples: [{ time: 0.5, errorDegrees: 2 }, { time: 1.5, errorDegrees: 4 }], limitation: 'Projected bend-plane deviation only.' },
      sampleRateHz: 30, sampleCount: 2, maxResidual: 0.02, rmsResidual: 0.015,
      samples: [{ time: 0.5, residual: 0.01 }, { time: 1.5, residual: 0.02 }], recipe: asset.recipe };
    const contactCompleted = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: contactJobId, ok: true, result: contactResultPayload }) });
    assert.equal(contactCompleted.status, 200);
    const contactJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: contactJobId } });
    assert.equal((contactJob.structuredContent as { result: { status: string; result: { sampleCount: number; maxResidual: number } } }).result.status, 'succeeded');
    assert.equal((contactJob.structuredContent as { result: { result: { sampleCount: number; maxResidual: number } } }).result.result.sampleCount, 2);
    assert.equal((contactJob.structuredContent as { result: { result: { sampleCount: number; maxResidual: number } } }).result.result.maxResidual, 0.02);
    assert.equal((contactJob.structuredContent as { result: { result: { bendPlane: { status: string; maximumErrorDegrees: number } } } }).result.result.bendPlane.status, 'measured');
    assert.equal((contactJob.structuredContent as { result: { result: { bendPlane: { status: string; maximumErrorDegrees: number } } } }).result.result.bendPlane.maximumErrorDegrees, 4);
    const coordinatedInput = { sessionId, rigId, assetId: asset.id, startTime: 0.5, endTime: 1.5, sampleRateHz: 30, toleranceStuds: 0.06, orientationToleranceDegrees: 5,
      constraints: [
        { limb: 'RightFoot', offset: [0.1, 0, 0], poleTarget: [2, 3, 4], targetOrientationPath: [
          { time: 0.5, orientationDegrees: [0, 350, 0] }, { time: 1, orientationDegrees: [0, 10, 0] }, { time: 1.5, orientationDegrees: [0, 90, 0] },
        ] },
        { limb: 'LeftHand', targetPathAssetId, expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint, targetPathInterpolation: 'centripetal_catmull_rom' as const,
          targetOrientationDegrees: [0, 90, 0] as [number, number, number] },
      ] };
    const invalidCoordinatedOrientation = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput,
      constraints: [{ limb: 'LeftHand', targetOrientationDegrees: [0, 361, 0] }] } });
    assert.equal(invalidCoordinatedOrientation.isError, true, 'World orientation targets must stay inside the finite XYZ degree range');
    const invalidOrientationTolerance = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput, orientationToleranceDegrees: 181 } });
    assert.equal(invalidOrientationTolerance.isError, true, 'Angular tolerances must not exceed the maximum orientation error');
    const incompleteOrientationPath = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput,
      constraints: [{ limb: 'LeftHand', targetOrientationPath: [{ time: 0.6, orientationDegrees: [0, 0, 0] }, { time: 1.5, orientationDegrees: [0, 90, 0] }] }] } });
    assert.equal(incompleteOrientationPath.isError, true, 'Orientation waypoint paths must cover the complete requested interval before Studio work is queued');
    const duplicateCoordinatedLimb = await client.callTool({ name: 'motion_studio_ik_constraints', arguments: { ...coordinatedInput, constraints: [{ limb: 'LeftHand', targetPathAssetId }, { limb: 'LeftHand' }] } });
    assert.equal(duplicateCoordinatedLimb.isError, true);
    assert.match(JSON.stringify(duplicateCoordinatedLimb), /each limb only once/i);
    const coordinatedPathGuard = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput, constraints: [
      { limb: 'RightFoot' },
      { limb: 'LeftHand', targetPath: changedTargetPath, expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint },
    ] } });
    assert.equal(coordinatedPathGuard.isError, true);
    assert.match(JSON.stringify(coordinatedPathGuard), /changed since analysis/i);
    const coordinatedJob = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: coordinatedInput });
    assert.ok(!coordinatedJob.isError, JSON.stringify(coordinatedJob));
    const coordinatedJobId = (coordinatedJob.structuredContent as { result: { jobId: string } }).result.jobId;
    const coordinatedPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const coordinatedResponse = await coordinatedPoll.json() as { command: { id: string; operation: string; payload: { orientationToleranceDegrees: number; constraints: Array<{ limb: string; poleTarget?: number[]; targetPath?: { time: number; position: number[] }[]; targetPathAssetId?: string; targetPathFingerprint?: string; targetPathInterpolation: string; targetOrientationDegrees?: number[]; targetOrientationPath?: { time: number; orientationDegrees: number[] }[] }>; recipe: unknown; rigSignature: string } } };
    const coordinatedCommand = coordinatedResponse.command;
    assert.equal(coordinatedCommand.id, coordinatedJobId);
    assert.equal(coordinatedCommand.operation, 'ik_constraints_preview');
    assert.equal(coordinatedCommand.payload.constraints.length, 2);
    assert.equal(coordinatedCommand.payload.constraints[0]!.limb, 'LeftHand', 'server normalizes independent constraint order');
    assert.equal(coordinatedCommand.payload.constraints[1]!.limb, 'RightFoot');
    assert.equal(coordinatedCommand.payload.orientationToleranceDegrees, 5);
    assert.deepEqual(coordinatedCommand.payload.constraints[1]!.poleTarget, [2, 3, 4]);
    assert.deepEqual(coordinatedCommand.payload.constraints[1]!.targetOrientationPath, coordinatedInput.constraints[0]!.targetOrientationPath);
    assert.equal(coordinatedCommand.payload.constraints[0]!.targetPathAssetId, targetPathAssetId);
    assert.equal(coordinatedCommand.payload.constraints[0]!.targetPathFingerprint, pathAnalysis.targetPathFingerprint);
    assert.equal(coordinatedCommand.payload.constraints[0]!.targetPathInterpolation, 'centripetal_catmull_rom');
    assert.deepEqual(coordinatedCommand.payload.constraints[0]!.targetPath, targetPath);
    assert.deepEqual(coordinatedCommand.payload.constraints[0]!.targetOrientationDegrees, [0, 90, 0]);
    assert.ok(coordinatedCommand.payload.recipe);
    assert.equal(coordinatedCommand.payload.rigSignature, rigSignature);
    const coordinatedSolves = [
      { limb: 'LeftHand', joint: 'LeftHand', targetMode: 'interpolated_world_path', targetWorldPath: targetPath, targetPathAssetId, targetPathInterpolation: 'centripetal_catmull_rom', offset: [0, 0, 0],
        targetOrientationDegrees: [0, 90, 0], orientationEvidence: { status: 'unmet', toleranceDegrees: 5, sampleCount: 2,
          samplesWithinTolerance: 0, withinToleranceRatio: 0, unmetSampleTimes: [0.5, 1.5], maximumErrorDegrees: 20,
          rmsErrorDegrees: Math.sqrt(250), maximumErrorTime: 1.5,
          limitation: 'Status classifies sampled angular residuals against the caller-supplied mechanical tolerance only.' },
        couplingMode: 'shared_joint_alternating_ccd', sharedJoints: ['HumanoidRootPart'],
        solve: { status: 'converged', toleranceStuds: 0.06, sampleCount: 2, samplesWithinTolerance: 2, withinToleranceRatio: 1, maximumResidualStuds: 0.01,
          rmsResidualStuds: 0.01, unmetSampleTimes: [], limitation: 'Fixture residual classification.' }, samples: [{ time: 0.5, residual: 0.01, orientationResidualDegrees: 10, orientationWithinTolerance: false }, { time: 1.5, residual: 0.01, orientationResidualDegrees: 20, orientationWithinTolerance: false }] },
      { limb: 'RightFoot', joint: 'RightFoot', targetMode: 'fixed_world_position', targetWorldPosition: [0, 0, 0], targetPathInterpolation: 'linear', poleTargetWorldPosition: [2, 3, 4],
        targetOrientationPath: coordinatedInput.constraints[0]!.targetOrientationPath,
        orientationEvidence: { status: 'partial', toleranceDegrees: 5, sampleCount: 2, samplesWithinTolerance: 1, withinToleranceRatio: 0.5,
          unmetSampleTimes: [1.5], maximumErrorDegrees: 8, rmsErrorDegrees: Math.sqrt(40), maximumErrorTime: 1.5,
          limitation: 'Status classifies sampled angular residuals against the caller-supplied mechanical tolerance only.' },
        bendPlane: { status: 'measured', sampleCount: 2, measuredSampleCount: 2, maximumErrorDegrees: 4, rmsErrorDegrees: 3, maximumErrorTime: 1.5,
          unmeasuredTimes: [], samples: [{ time: 0.5, errorDegrees: 2 }, { time: 1.5, errorDegrees: 4 }], limitation: 'Projected bend-plane deviation only.' }, offset: [0.1, 0, 0],
        couplingMode: 'shared_joint_alternating_ccd', sharedJoints: ['HumanoidRootPart'],
        solve: { status: 'partial', toleranceStuds: 0.06, sampleCount: 2, samplesWithinTolerance: 1, withinToleranceRatio: 0.5, maximumResidualStuds: 0.05,
          rmsResidualStuds: Math.sqrt((0.03 ** 2 + 0.05 ** 2) / 2), unmetSampleTimes: [1.5], limitation: 'Fixture residual classification.' }, samples: [
          { time: 0.5, residual: 0.03, orientationResidualDegrees: 4, orientationWithinTolerance: true },
          { time: 1.5, residual: 0.05, orientationResidualDegrees: 8, orientationWithinTolerance: false },
        ] },
    ];
    const coordinatedPreviewResult = { assetId: asset.id, parentId: asset.id, rigId, startTime: 0.5, endTime: 1.5, sampleRateHz: 30,
      toleranceStuds: 0.06, sampleCount: 2, solves: coordinatedSolves, recipe: asset.recipe, previewOnly: true };
    const coordinatedComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: coordinatedJobId, ok: true, result: coordinatedPreviewResult }) });
    assert.equal(coordinatedComplete.status, 200);
    const coordinatedPreview = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: coordinatedJobId } });
    const coordinatedJobResult = (coordinatedPreview.structuredContent as { result: { status: string; result: { candidateFingerprint: string; recipe: unknown; solves: unknown[]; candidateExpiresInSeconds: number } } }).result;
    assert.equal(coordinatedJobResult.status, 'succeeded');
    assert.match(coordinatedJobResult.result.candidateFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(coordinatedJobResult.result.candidateExpiresInSeconds, 300);
    assert.deepEqual(coordinatedJobResult.result.solves, coordinatedSolves);
    const coordinatedVisualize = await client.callTool({ name: 'motion_studio_ik_constraints_visualize', arguments: { expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint, time: 0.75, play: true, loop: false, playbackSpeed: 1.25 } });
    assert.ok(!coordinatedVisualize.isError, JSON.stringify(coordinatedVisualize));
    const coordinatedVisualizeJobId = (coordinatedVisualize.structuredContent as { result: { jobId: string } }).result.jobId;
    const coordinatedVisualizePoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const coordinatedVisualizeCommand = (await coordinatedVisualizePoll.json() as { command: { id: string; operation: string; payload: { candidateFingerprint: string; time: number; play: boolean; loop: boolean; playbackSpeed: number; recipe: unknown; targets: { limb: string; startTime: number; endTime: number; targetWorldPosition?: number[]; targetWorldPath?: { time: number; position: number[] }[]; targetPathInterpolation: string; offset: number[] }[] } } }).command;
    assert.equal(coordinatedVisualizeCommand.id, coordinatedVisualizeJobId);
    assert.equal(coordinatedVisualizeCommand.operation, 'ik_constraints_visualize');
    assert.equal(coordinatedVisualizeCommand.payload.candidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.equal(coordinatedVisualizeCommand.payload.time, 0.75);
    assert.equal(coordinatedVisualizeCommand.payload.play, true);
    assert.equal(coordinatedVisualizeCommand.payload.loop, false);
    assert.equal(coordinatedVisualizeCommand.payload.playbackSpeed, 1.25);
    assert.deepEqual(coordinatedVisualizeCommand.payload.recipe, asset.recipe);
    assert.deepEqual(coordinatedVisualizeCommand.payload.targets.map(target => ({ limb: target.limb, startTime: target.startTime, endTime: target.endTime,
      targetWorldPosition: target.targetWorldPosition, targetWorldPath: target.targetWorldPath })), [
      { limb: 'LeftHand', startTime: 0.5, endTime: 1.5, targetWorldPosition: undefined, targetWorldPath: targetPath },
      { limb: 'RightFoot', startTime: 0.5, endTime: 1.5, targetWorldPosition: [0, 0, 0], targetWorldPath: undefined },
    ]);
    const coordinatedVisualizeComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: coordinatedVisualizeJobId, ok: true, result: { shown: true, visualOnly: true, candidateFingerprint: coordinatedJobResult.result.candidateFingerprint, time: 0.75, playing: true } }) });
    assert.equal(coordinatedVisualizeComplete.status, 200);
    const captureRecipe = coordinatedJobResult.result.recipe as AnimationRecipe;
    const changedCaptureRecipe: AnimationRecipe = { ...captureRecipe, name: 'Different candidate' };
    const mismatchedIKCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe: changedCaptureRecipe, expectedFingerprint: fingerprint(changedCaptureRecipe),
      ikCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint, jointMap: {}, frames: [{ time: 0.75, view: 'front' }, { time: 1, view: 'side' }],
    } });
    assert.equal(mismatchedIKCapture.isError, true);
    assert.match(JSON.stringify(mismatchedIKCapture), /does not match this capture recipe/i);
    const targetGuidedCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe: captureRecipe, expectedFingerprint: fingerprint(captureRecipe), expectedRigSignature: rigSignature,
      ikCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint, jointMap: {}, frames: [{ time: 0.75, view: 'front' }, { time: 1, view: 'side' }],
    } });
    assert.ok(!targetGuidedCapture.isError, JSON.stringify(targetGuidedCapture));
    const targetGuidedJobId = (targetGuidedCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const targetGuidedPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const targetGuidedCommand = (await targetGuidedPoll.json() as { command: { id: string; payload: { ikCandidateFingerprint: string; assetId: string; assetFingerprint: string;
      rigSignature: string; ikTargetGuides: { limb: string; startTime: number; endTime: number; targetWorldPosition?: number[]; targetWorldPath?: { time: number; position: number[] }[] }[] } } }).command;
    assert.equal(targetGuidedCommand.id, targetGuidedJobId);
    assert.equal(targetGuidedCommand.payload.ikCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(targetGuidedCommand.payload.ikTargetGuides.map(guide => ({ limb: guide.limb,
      targetWorldPosition: guide.targetWorldPosition, targetWorldPath: guide.targetWorldPath })), [
      { limb: 'LeftHand', targetWorldPosition: undefined, targetWorldPath: targetPath },
      { limb: 'RightFoot', targetWorldPosition: [0, 0, 0], targetWorldPath: undefined },
    ]);
    const targetGuidedFrames = [{ time: 0.75, view: 'front' as const }, { time: 1, view: 'side' as const }];
    const targetGuidedCaptureIds = targetGuidedFrames.map(() => randomUUID());
    const targetGuidedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    const targetGuidedCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({
      sessionId, id: targetGuidedJobId, ok: true, result: { assetId: targetGuidedCommand.payload.assetId, rigId, sessionId, complete: false, failedIndex: 2, error: 'fixture second camera failed',
        frames: [targetGuidedFrames[0]!].map((frame, index) => ({ captureId: targetGuidedCaptureIds[index]!, sessionId, assetId: targetGuidedCommand.payload.assetId,
          assetFingerprint: targetGuidedCommand.payload.assetFingerprint, rigId, rigSignature: targetGuidedCommand.payload.rigSignature,
          ...frame, appliedJointMap: resolvedCaptureJointMap(captureRecipe, {}), byteCount: targetGuidedPng.length, chunks: 1, width: 1, height: 1, note: 'LeftHand=amber; RightFoot=mint' })),
        note: 'Fixture target-guided screenshots partially complete.' } }) });
    assert.equal(targetGuidedCompletion.status, 200);
    const targetGuidedResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: targetGuidedJobId } });
    assert.ok(!targetGuidedResult.isError, JSON.stringify(targetGuidedResult));
    const targetGuidedOutput = (targetGuidedResult.structuredContent as { result: { result: { ikCandidateFingerprint: string;
      ikTargetGuideLegend: Record<string, string>; ikTargetGuideCoverage: { time: number; view: string; limbs: string[];
        captureId: string; targets: { limb: string; targetWorldPosition: number[] }[] }[];
      captureCoverage: { status: string; capturedFrameCount: number; missingFrameCount: number; missingFrames: { time: number; view: string }[] };
      next: string } } }).result.result;
    assert.equal(targetGuidedOutput.ikCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(targetGuidedOutput.ikTargetGuideLegend, { LeftHand: 'amber', RightHand: 'coral', LeftFoot: 'violet', RightFoot: 'mint' });
    assert.equal(targetGuidedOutput.captureCoverage.status, 'partial');
    assert.equal(targetGuidedOutput.captureCoverage.capturedFrameCount, 1);
    assert.equal(targetGuidedOutput.captureCoverage.missingFrameCount, 1);
    assert.deepEqual(targetGuidedOutput.captureCoverage.missingFrames, [targetGuidedFrames[1]]);
    assert.match(targetGuidedOutput.next, new RegExp(`retry only captureCoverage\\.missingFrames[\\s\\S]*ikCandidateFingerprint=${coordinatedJobResult.result.candidateFingerprint}`),
      'partial IK capture guidance must preserve the exact target-guide candidate when retrying only missing frames');
    assert.deepEqual(targetGuidedOutput.ikTargetGuideCoverage, [
      { captureId: targetGuidedCaptureIds[0]!, time: 0.75, view: 'front', limbs: ['LeftHand', 'RightFoot'], targets: [
        { limb: 'LeftHand', targetWorldPosition: sampleIKTargetPath(targetPath, 0.75, 'centripetal_catmull_rom') },
        { limb: 'RightFoot', targetWorldPosition: [0.1, 0, 0] },
      ] },
    ]);
    const readTargetGuidedImages = async (captureIds: string[]) => {
      const imagePromise = client.callTool({ name: 'motion_studio_read_candidate_captures', arguments: { sessionId, captureIds } });
      const pendingCaptureIds = new Set(captureIds);
      for (let attempt = 0; attempt < 100 && pendingCaptureIds.size > 0; attempt++) {
        const chunkPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
          body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
        const chunkPollBody = await chunkPoll.json() as { command?: { id: string; operation: string; payload: { captureId: string; index: number } } };
        if (chunkPollBody.command?.operation === 'capture_chunk') {
          assert.equal(pendingCaptureIds.has(chunkPollBody.command.payload.captureId), true, 'image chunks must remain bound to a requested capture ID');
          const chunkResult = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
            body: JSON.stringify({ sessionId, id: chunkPollBody.command.id, ok: true, result: { captureId: chunkPollBody.command.payload.captureId,
              index: chunkPollBody.command.payload.index, hex: targetGuidedPng.toString('hex') } }) });
          assert.equal(chunkResult.status, 200);
          pendingCaptureIds.delete(chunkPollBody.command.payload.captureId);
        } else await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(pendingCaptureIds.size, 0, 'AI image read must retrieve each screenshot through the normal verified chunk path');
      return imagePromise;
    };
    const readTargetGuidedImage = (captureId: string) => readTargetGuidedImages([captureId]);
    const targetGuideImageRead = await readTargetGuidedImage(targetGuidedCaptureIds[0]!);
    assert.ok(!targetGuideImageRead.isError, JSON.stringify(targetGuideImageRead));
    const targetGuideReadback = (targetGuideImageRead.structuredContent as { result: { images: { visualReviewTemplate: {
      ikTargetGuideEvidence?: { candidateFingerprint: string; legend: Record<string, string>; frame: { time: number; limbs: string[];
        targets: { limb: string; targetWorldPosition: number[] }[] } };
      protocol: string;
    } }[] } }).result.images[0]!.visualReviewTemplate;
    assert.equal(targetGuideReadback.ikTargetGuideEvidence?.candidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(targetGuideReadback.ikTargetGuideEvidence?.frame.targets, targetGuidedOutput.ikTargetGuideCoverage[0]!.targets);
    assert.match(targetGuideReadback.protocol, /not measured limb endpoints.*occluded/i,
      'the image-side prompt must distinguish requested goals from observed pose and disclose occlusion uncertainty');
    const retryTargetGuidedCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe: captureRecipe, expectedFingerprint: fingerprint(captureRecipe), expectedRigSignature: rigSignature,
      ikCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint, jointMap: {}, frames: [targetGuidedFrames[1]!],
    } });
    assert.ok(!retryTargetGuidedCapture.isError, JSON.stringify(retryTargetGuidedCapture));
    const retryTargetGuidedJobId = (retryTargetGuidedCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const retryTargetGuidedPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const retryTargetGuidedCommand = (await retryTargetGuidedPoll.json() as { command: { id: string; payload: { ikCandidateFingerprint: string;
      ikTargetGuides: { limb: string; targetWorldPosition?: number[]; targetWorldPath?: { time: number; position: number[] }[] }[] } } }).command;
    assert.equal(retryTargetGuidedCommand.id, retryTargetGuidedJobId);
    assert.equal(retryTargetGuidedCommand.payload.ikCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(retryTargetGuidedCommand.payload.ikTargetGuides, targetGuidedCommand.payload.ikTargetGuides);
    const retryTargetGuidedCaptureId = randomUUID();
    const retryTargetGuidedCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, id: retryTargetGuidedJobId, ok: true, result: { assetId: targetGuidedCommand.payload.assetId, rigId, sessionId, complete: true,
        frames: [{ captureId: retryTargetGuidedCaptureId, sessionId, assetId: targetGuidedCommand.payload.assetId, assetFingerprint: targetGuidedCommand.payload.assetFingerprint,
          rigId, rigSignature: targetGuidedCommand.payload.rigSignature, ...targetGuidedFrames[1]!, appliedJointMap: resolvedCaptureJointMap(captureRecipe, {}),
          byteCount: targetGuidedPng.length, chunks: 1, width: 1, height: 1, note: 'LeftHand=amber; RightFoot=mint' }], note: 'Fixture retry screenshot complete.' } }) });
    assert.equal(retryTargetGuidedCompletion.status, 200);
    const retryTargetGuidedResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: retryTargetGuidedJobId } });
    assert.ok(!retryTargetGuidedResult.isError, JSON.stringify(retryTargetGuidedResult));
    const retryTargetGuidedOutput = (retryTargetGuidedResult.structuredContent as { result: { result: { ikCandidateFingerprint: string;
      ikTargetGuideCoverage: { captureId: string; time: number; view: string; targets: { limb: string; targetWorldPosition: number[] }[] }[] } } }).result.result;
    assert.equal(retryTargetGuidedOutput.ikCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(retryTargetGuidedOutput.ikTargetGuideCoverage, [{ captureId: retryTargetGuidedCaptureId, time: 1, view: 'side', limbs: ['LeftHand', 'RightFoot'], targets: [
      { limb: 'LeftHand', targetWorldPosition: sampleIKTargetPath(targetPath, 1, 'centripetal_catmull_rom') },
      { limb: 'RightFoot', targetWorldPosition: [0.1, 0, 0] },
    ] }]);
    const retryTargetGuideImageRead = await readTargetGuidedImage(retryTargetGuidedCaptureId);
    assert.ok(!retryTargetGuideImageRead.isError, JSON.stringify(retryTargetGuideImageRead));
    const retryTargetGuideReadback = (retryTargetGuideImageRead.structuredContent as { result: { images: { metadata: { captureId: string; time: number; view: string };
      visualReviewTemplate: { ikTargetGuideEvidence?: { candidateFingerprint: string; frame: { time: number; targets: { limb: string; targetWorldPosition: number[] }[] } } } }[] } }).result.images[0]!;
    assert.equal(retryTargetGuideReadback.metadata.captureId, retryTargetGuidedCaptureId);
    assert.equal(retryTargetGuideReadback.metadata.time, 1);
    assert.equal(retryTargetGuideReadback.metadata.view, 'side');
    assert.equal(retryTargetGuideReadback.visualReviewTemplate.ikTargetGuideEvidence?.candidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(retryTargetGuideReadback.visualReviewTemplate.ikTargetGuideEvidence?.frame.targets, retryTargetGuidedOutput.ikTargetGuideCoverage[0]!.targets);
    const alternateIkInput = { ...coordinatedInput, constraints: coordinatedInput.constraints.map(constraint => constraint.limb === 'RightFoot'
      ? { ...constraint, offset: [0.2, 0, 0] } : constraint) };
    const alternateIkPreviewQueued = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: alternateIkInput });
    assert.ok(!alternateIkPreviewQueued.isError, JSON.stringify(alternateIkPreviewQueued));
    const alternateIkPreviewJobId = (alternateIkPreviewQueued.structuredContent as { result: { jobId: string } }).result.jobId;
    const alternateIkPreviewPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const alternateIkPreviewCommand = (await alternateIkPreviewPoll.json() as { command: { id: string; operation: string } }).command;
    assert.equal(alternateIkPreviewCommand.id, alternateIkPreviewJobId);
    assert.equal(alternateIkPreviewCommand.operation, 'ik_constraints_preview');
    const alternateIkSolves = coordinatedSolves.map(solve => solve.limb === 'RightFoot' ? { ...solve, offset: [0.2, 0, 0] } : solve);
    const alternateIkPreviewCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, id: alternateIkPreviewJobId, ok: true, result: { ...coordinatedPreviewResult, solves: alternateIkSolves } }) });
    assert.equal(alternateIkPreviewCompletion.status, 200);
    const alternateIkPreview = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: alternateIkPreviewJobId } });
    assert.ok(!alternateIkPreview.isError, JSON.stringify(alternateIkPreview));
    const alternateIkCandidateFingerprint = (alternateIkPreview.structuredContent as { result: { result: { candidateFingerprint: string } } }).result.result.candidateFingerprint;
    assert.notEqual(alternateIkCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    const alternateCandidateCapture = await client.callTool({ name: 'motion_studio_capture_candidate_views', arguments: {
      sessionId, rigId, recipe: captureRecipe, expectedFingerprint: fingerprint(captureRecipe), expectedRigSignature: rigSignature,
      ikCandidateFingerprint: alternateIkCandidateFingerprint, jointMap: {}, frames: [targetGuidedFrames[0]!],
    } });
    assert.ok(!alternateCandidateCapture.isError, JSON.stringify(alternateCandidateCapture));
    const alternateCandidateCaptureJobId = (alternateCandidateCapture.structuredContent as { result: { jobId: string } }).result.jobId;
    const alternateCandidateCapturePoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const alternateCandidateCaptureCommand = (await alternateCandidateCapturePoll.json() as { command: { id: string; payload: { assetId: string;
      assetFingerprint: string; rigSignature: string } } }).command;
    assert.equal(alternateCandidateCaptureCommand.id, alternateCandidateCaptureJobId);
    const alternateCandidateCaptureId = randomUUID();
    const alternateCandidateCaptureCompletion = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ sessionId, id: alternateCandidateCaptureJobId, ok: true, result: { assetId: alternateCandidateCaptureCommand.payload.assetId, rigId, sessionId, complete: true,
        frames: [{ captureId: alternateCandidateCaptureId, sessionId, assetId: alternateCandidateCaptureCommand.payload.assetId,
          assetFingerprint: alternateCandidateCaptureCommand.payload.assetFingerprint, rigId, rigSignature: alternateCandidateCaptureCommand.payload.rigSignature,
          ...targetGuidedFrames[0]!, appliedJointMap: resolvedCaptureJointMap(captureRecipe, {}), byteCount: targetGuidedPng.length, chunks: 1, width: 1, height: 1,
          note: 'Alternate IK target candidate screenshot.' }], note: 'Fixture alternate target candidate screenshot complete.' } }) });
    assert.equal(alternateCandidateCaptureCompletion.status, 200);
    const alternateCandidateCaptureResult = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: alternateCandidateCaptureJobId } });
    assert.ok(!alternateCandidateCaptureResult.isError, JSON.stringify(alternateCandidateCaptureResult));
    const alternateGuidedTimeline = await readTargetGuidedImages([targetGuidedCaptureIds[0]!, alternateCandidateCaptureId]);
    assert.ok(!alternateGuidedTimeline.isError, JSON.stringify(alternateGuidedTimeline));
    const alternateGuidedGroups = (alternateGuidedTimeline.structuredContent as { result: { temporalContinuityGroups: {
      ikCandidateFingerprint?: string; appliedJointMapFingerprint: string; frames: { captureId: string }[] }[] } }).result.temporalContinuityGroups;
    assert.equal(alternateGuidedGroups.length, 2, 'screenshots from different IK goal candidates must remain separate visual timelines');
    assert.deepEqual(new Set(alternateGuidedGroups.map(group => group.ikCandidateFingerprint)),
      new Set([coordinatedJobResult.result.candidateFingerprint, alternateIkCandidateFingerprint]));
    assert.ok(alternateGuidedGroups.every(group => group.frames.length === 1));
    const clearCoordinatedVisual = await client.callTool({ name: 'motion_studio_ik_constraints_clear_preview', arguments: { sessionId } });
    assert.ok(!clearCoordinatedVisual.isError, JSON.stringify(clearCoordinatedVisual));
    const clearCoordinatedVisualJobId = (clearCoordinatedVisual.structuredContent as { result: { jobId: string } }).result.jobId;
    const clearCoordinatedVisualPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const clearCoordinatedVisualCommand = (await clearCoordinatedVisualPoll.json() as { command: { id: string; operation: string } }).command;
    assert.equal(clearCoordinatedVisualCommand.id, clearCoordinatedVisualJobId);
    assert.equal(clearCoordinatedVisualCommand.operation, 'ik_constraints_clear_preview');
    const clearCoordinatedVisualComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: clearCoordinatedVisualJobId, ok: true, result: { cleared: true, visualOnly: true } }) });
    assert.equal(clearCoordinatedVisualComplete.status, 200);
    const invalidCoordinatedFingerprint = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: { ...coordinatedInput, expectedCandidateFingerprint: '0'.repeat(64) } });
    assert.equal(invalidCoordinatedFingerprint.isError, true);
    assert.match(JSON.stringify(invalidCoordinatedFingerprint), /no live coordinated ik preview/i);
    const changedCoordinatedInput = { ...coordinatedInput, constraints: [
      { limb: 'RightFoot', offset: [0.2, 0, 0] }, { limb: 'LeftHand', targetPathAssetId },
    ] };
    const staleCoordinatedPreview = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: { ...changedCoordinatedInput, expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint } });
    assert.equal(staleCoordinatedPreview.isError, true);
    assert.match(JSON.stringify(staleCoordinatedPreview), /changed since preview/i);
    const changedCoordinatedOrientation = { ...coordinatedInput, constraints: [
      { limb: 'RightFoot', offset: [0.1, 0, 0], poleTarget: [2, 3, 4], targetOrientationPath: [
        { time: 0.5, orientationDegrees: [0, 350, 0] }, { time: 1, orientationDegrees: [0, 10, 0] }, { time: 1.5, orientationDegrees: [0, 80, 0] },
      ] },
      { limb: 'LeftHand', targetPathAssetId, expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint,
        targetPathInterpolation: 'centripetal_catmull_rom' as const, targetOrientationDegrees: [0, 90, 0] as [number, number, number] },
    ] };
    const staleOrientationPreview = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: { ...changedCoordinatedOrientation,
      expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint } });
    assert.equal(staleOrientationPreview.isError, true, 'Changing the endpoint orientation must invalidate the reviewed IK candidate');
    assert.match(JSON.stringify(staleOrientationPreview), /changed since preview/i);
    const changedFixedOrientation = { ...coordinatedInput, constraints: [
      coordinatedInput.constraints[0]!,
      { ...coordinatedInput.constraints[1]!, targetOrientationDegrees: [0, 80, 0] as [number, number, number] },
    ] };
    const staleFixedOrientationPreview = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: { ...changedFixedOrientation,
      expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint } });
    assert.equal(staleFixedOrientationPreview.isError, true, 'Changing the fixed endpoint orientation must invalidate the reviewed IK candidate');
    assert.match(JSON.stringify(staleFixedOrientationPreview), /changed since preview/i);
    const staleOrientationTolerance = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: {
      ...coordinatedInput, orientationToleranceDegrees: 6, expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint,
    } });
    assert.equal(staleOrientationTolerance.isError, true, 'Changing the mechanical orientation tolerance must invalidate the reviewed IK candidate');
    assert.match(JSON.stringify(staleOrientationTolerance), /changed since preview/i);
    const coordinatedApply = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: { ...coordinatedInput, expectedCandidateFingerprint: coordinatedJobResult.result.candidateFingerprint } });
    assert.ok(!coordinatedApply.isError, JSON.stringify(coordinatedApply));
    const coordinatedApplyJobId = (coordinatedApply.structuredContent as { result: { jobId: string } }).result.jobId;
    const coordinatedApplyPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const coordinatedApplyCommand = (await coordinatedApplyPoll.json() as { command: { id: string; operation: string; payload: { expectedCandidateFingerprint: string; expectedCandidateRecipe: unknown; expectedCandidateSolves: unknown[]; rigSignature: string } } }).command;
    assert.equal(coordinatedApplyCommand.id, coordinatedApplyJobId);
    assert.equal(coordinatedApplyCommand.operation, 'ik_constraints_apply');
    assert.equal(coordinatedApplyCommand.payload.expectedCandidateFingerprint, coordinatedJobResult.result.candidateFingerprint);
    assert.deepEqual(coordinatedApplyCommand.payload.expectedCandidateRecipe, asset.recipe);
    assert.deepEqual(coordinatedApplyCommand.payload.expectedCandidateSolves, coordinatedSolves);
    assert.equal(coordinatedApplyCommand.payload.rigSignature, rigSignature);
    const coordinatedApplyComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: coordinatedApplyJobId, ok: true, result: { applied: true, assetId: asset.id, rigId } }) });
    assert.equal(coordinatedApplyComplete.status, 200);
    const coordinatedApplyJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: coordinatedApplyJobId } });
    assert.equal((coordinatedApplyJob.structuredContent as { result: { status: string } }).result.status, 'succeeded');
    const missingIKSource = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput, assetId: undefined } });
    assert.equal(missingIKSource.isError, true);
    assert.match(JSON.stringify(missingIKSource), /exactly one of assetId or an unsaved animation recipe/i);
    const conflictingIKSources = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: { ...coordinatedInput, recipe: asset.recipe } });
    assert.equal(conflictingIKSources.isError, true);
    assert.match(JSON.stringify(conflictingIKSources), /exactly one of assetId or an unsaved animation recipe/i);
    const singleEffectorInput = { sessionId, rigId, recipe: asset.recipe, parentAssetId: asset.id, startTime: coordinatedInput.startTime,
      endTime: coordinatedInput.endTime, sampleRateHz: coordinatedInput.sampleRateHz, toleranceStuds: coordinatedInput.toleranceStuds, constraints: [
      { limb: 'LeftHand', targetPathAssetId, expectedTargetPathFingerprint: pathAnalysis.targetPathFingerprint },
    ] };
    const singleEffectorPreview = await client.callTool({ name: 'motion_studio_ik_constraints_preview', arguments: singleEffectorInput });
    assert.ok(!singleEffectorPreview.isError, JSON.stringify(singleEffectorPreview));
    const singleEffectorJobId = (singleEffectorPreview.structuredContent as { result: { jobId: string } }).result.jobId;
    const singleEffectorPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const singleEffectorCommand = (await singleEffectorPoll.json() as { command: { id: string; operation: string; payload: { assetId: string; ephemeralRecipe: boolean; parentAssetId: string; sourceRigProfile: { rigId: string; rigSignature: string }; recipeFingerprint: string; constraints: { limb: string }[] } } }).command;
    assert.equal(singleEffectorCommand.id, singleEffectorJobId);
    assert.equal(singleEffectorCommand.operation, 'ik_constraints_preview');
    assert.equal(singleEffectorCommand.payload.constraints.length, 1);
    assert.equal(singleEffectorCommand.payload.constraints[0]!.limb, 'LeftHand');
    assert.notEqual(singleEffectorCommand.payload.assetId, asset.id, 'unsaved recipes receive a deterministic ephemeral Studio identity');
    assert.equal(singleEffectorCommand.payload.ephemeralRecipe, true);
    assert.equal(singleEffectorCommand.payload.parentAssetId, asset.id);
    assert.equal(singleEffectorCommand.payload.sourceRigProfile.rigId, rigId);
    assert.equal(singleEffectorCommand.payload.sourceRigProfile.rigSignature, rigSignature);
    assert.match(singleEffectorCommand.payload.recipeFingerprint, /^[0-9a-f]{64}$/);
    const singleEffectorSolve: Record<string, unknown> = { ...coordinatedSolves[0]!, couplingMode: 'independent_ccd', sharedJoints: [] };
    delete singleEffectorSolve.targetOrientationDegrees;
    delete singleEffectorSolve.targetOrientationPath;
    delete singleEffectorSolve.orientationEvidence;
    singleEffectorSolve.samples = (singleEffectorSolve.samples as Array<Record<string, unknown>>).map(sample => {
      const { orientationResidualDegrees: _orientationResidualDegrees, orientationWithinTolerance: _orientationWithinTolerance, ...positionOnlySample } = sample;
      return positionOnlySample;
    });
    const singleEffectorComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: singleEffectorJobId, ok: true, result: {
      assetId: singleEffectorCommand.payload.assetId, parentId: singleEffectorCommand.payload.assetId, rigId, startTime: singleEffectorInput.startTime, endTime: singleEffectorInput.endTime,
      sampleRateHz: singleEffectorInput.sampleRateHz, toleranceStuds: singleEffectorInput.toleranceStuds,
      sampleCount: 2, solves: [singleEffectorSolve], recipe: asset.recipe, previewOnly: true,
    } }) });
    assert.equal(singleEffectorComplete.status, 200);
    const singleEffectorJob = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: singleEffectorJobId } });
    const singleEffectorResult = (singleEffectorJob.structuredContent as { result: { status: string; result: { candidateFingerprint: string; solves: { limb: string }[] } } }).result;
    assert.equal(singleEffectorResult.status, 'succeeded');
    assert.equal(singleEffectorResult.result.solves.length, 1);
    assert.equal(singleEffectorResult.result.solves[0]!.limb, 'LeftHand');
    const singleEffectorApply = await client.callTool({ name: 'motion_studio_ik_constraints_apply', arguments: {
      ...singleEffectorInput, expectedCandidateFingerprint: singleEffectorResult.result.candidateFingerprint,
    } });
    assert.ok(!singleEffectorApply.isError, JSON.stringify(singleEffectorApply));
    const singleEffectorApplyJobId = (singleEffectorApply.structuredContent as { result: { jobId: string } }).result.jobId;
    const singleEffectorApplyPoll = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature } } }) });
    const singleEffectorApplyCommand = (await singleEffectorApplyPoll.json() as { command: { id: string; operation: string; payload: { assetId: string; ephemeralRecipe: boolean; parentAssetId: string; recipe: unknown; expectedCandidateFingerprint: string } } }).command;
    assert.equal(singleEffectorApplyCommand.id, singleEffectorApplyJobId);
    assert.equal(singleEffectorApplyCommand.operation, 'ik_constraints_apply');
    assert.equal(singleEffectorApplyCommand.payload.assetId, singleEffectorCommand.payload.assetId);
    assert.equal(singleEffectorApplyCommand.payload.ephemeralRecipe, true);
    assert.equal(singleEffectorApplyCommand.payload.parentAssetId, asset.id);
    assert.deepEqual(singleEffectorApplyCommand.payload.recipe, asset.recipe);
    assert.equal(singleEffectorApplyCommand.payload.expectedCandidateFingerprint, singleEffectorResult.result.candidateFingerprint);
    const singleEffectorApplyComplete = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, id: singleEffectorApplyJobId, ok: true, result: { applied: true, assetId: singleEffectorCommand.payload.assetId, rigId } }) });
    assert.equal(singleEffectorApplyComplete.status, 200);
    const singleEffectorApplied = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: singleEffectorApplyJobId } });
    assert.equal((singleEffectorApplied.structuredContent as { result: { status: string } }).result.status, 'succeeded');
    const snapshotCommitArgs = { snapshotId, animationAssetId: asset.id, sessionId, rigId, time: 0.75, weight: 0.5 };
    const snapshotApplyPreview = await client.callTool({ name: 'motion_pose_preview', arguments: { poseId: snapshotId, animationAssetId: asset.id, sessionId, rigId, time: 0.75, weight: 0.5 } });
    assert.ok(!snapshotApplyPreview.isError, JSON.stringify(snapshotApplyPreview));
    const snapshotApplyCandidate = (snapshotApplyPreview.structuredContent as { result: { candidateFingerprint: string; sessionId: string; rigId: string } }).result;
    assert.equal(snapshotApplyCandidate.sessionId, sessionId);
    assert.equal(snapshotApplyCandidate.rigId, rigId);
    const missingSnapshotFingerprint = await client.callTool({ name: 'motion_snapshot_apply', arguments: snapshotCommitArgs });
    assert.equal(missingSnapshotFingerprint.isError, true, 'snapshot commit must not be available without the reviewed preview fingerprint');
    const staleSnapshotCommit = await client.callTool({ name: 'motion_snapshot_apply', arguments: { ...snapshotCommitArgs, expectedCandidateFingerprint: '0'.repeat(64) } });
    assert.equal(staleSnapshotCommit.isError, true);
    assert.match(JSON.stringify(staleSnapshotCommit.content), /differs from its reviewed preview/i);
    const snapshotApplied = await client.callTool({ name: 'motion_snapshot_apply', arguments: { ...snapshotCommitArgs, expectedCandidateFingerprint: snapshotApplyCandidate.candidateFingerprint } });
    assert.ok(!snapshotApplied.isError, JSON.stringify(snapshotApplied));
    const crossSessionSnapshotCommit = await client.callTool({ name: 'motion_snapshot_apply', arguments: {
      ...snapshotCommitArgs, sessionId: sameRigOtherSessionId, expectedCandidateFingerprint: snapshotApplyCandidate.candidateFingerprint } });
    assert.equal(crossSessionSnapshotCommit.isError, true);
    assert.match(JSON.stringify(crossSessionSnapshotCommit.content), /differs from its reviewed preview/i);
    const snapshotResult = (snapshotApplied.structuredContent as { result: { appliedJoints: string[]; recipe: { tracks: { joint: string }[] } } }).result;
    assert.ok(snapshotResult.appliedJoints.includes('Head'));
    assert.ok(snapshotResult.recipe.tracks.some(track => track.joint === 'Head'));
    const snapshotSequenceWithoutRig = await client.callTool({ name: 'motion_pose_sequence_apply', arguments: { animationAssetId: asset.id, placements: [{ poseId: snapshotId, time: 0.75 }] } });
    assert.ok(snapshotSequenceWithoutRig.isError);
    const snapshotSequenceInput = { animationAssetId: asset.id, sessionId, rigId, placements: [
      { poseId: snapshotId, time: 0.75 }, { poseId, time: 1 },
    ] };
    const snapshotSequencePreview = await client.callTool({ name: 'motion_pose_sequence_preview', arguments: snapshotSequenceInput });
    assert.ok(!snapshotSequencePreview.isError, JSON.stringify(snapshotSequencePreview));
    const snapshotSequenceResult = (snapshotSequencePreview.structuredContent as { result: { candidateFingerprint: string;
      poseRigCompatibility: { poseId: string; status: string }[]; diagnostics: { addedTracks: string[] } } }).result;
    assert.ok(snapshotSequenceResult.poseRigCompatibility.every(item => item.status === 'unknown'),
      'missing source-rig provenance must remain unknown for sequence members');
    assert.ok(Array.isArray(snapshotSequenceResult.diagnostics.addedTracks), 'sequence preview must disclose all snapshot-created tracks');
    const snapshotSequenceFingerprint = snapshotSequenceResult.candidateFingerprint;
    const assembledSnapshots = await client.callTool({ name: 'motion_pose_sequence_apply', arguments: { ...snapshotSequenceInput, expectedCandidateFingerprint: snapshotSequenceFingerprint } });
    assert.ok(!assembledSnapshots.isError, JSON.stringify(assembledSnapshots));
    const sequenceReboundCommit = await client.callTool({ name: 'motion_pose_sequence_apply', arguments: {
      ...snapshotSequenceInput, sessionId: sameRigOtherSessionId, expectedCandidateFingerprint: snapshotSequenceFingerprint } });
    assert.equal(sequenceReboundCommit.isError, true);
    assert.match(JSON.stringify(sequenceReboundCommit.content), /differs from its reviewed preview/i,
      'a sequence preview must not be reusable from another Studio session even when rig ID and topology match');
    const assembledResult = (assembledSnapshots.structuredContent as { result: { placements: { poseId: string; time: number }[]; recipe: { tracks: { joint: string }[] } } }).result;
    assert.equal(assembledResult.placements.length, 2);
    assert.ok(assembledResult.recipe.tracks.some(track => track.joint === 'Head'));
    assert.ok(assembledResult.recipe.tracks.some(track => track.joint === 'RightUpperArm'));
    const wrongTopology = await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ sessionId, snapshot: { activeRig: { id: rigId, rigSignature: 'R6|different' } } }) });
    assert.equal(wrongTopology.status, 200);
    const mismatch = await client.callTool({ name: 'motion_snapshot_apply', arguments: { ...snapshotCommitArgs, expectedCandidateFingerprint: snapshotApplyCandidate.candidateFingerprint } });
    assert.ok(mismatch.isError, JSON.stringify(mismatch));
    assert.match(JSON.stringify(mismatch.content), /topology does not match/i);
    const sequenceMismatch = await client.callTool({ name: 'motion_pose_sequence_preview', arguments: { animationAssetId: asset.id, sessionId, rigId, placements: [{ poseId: snapshotId, time: 0.75 }] } });
    assert.ok(sequenceMismatch.isError);
    assert.match(JSON.stringify(sequenceMismatch.content), /topology does not match/i);
    const originalAfterPatch = await client.callTool({ name: 'motion_library_read', arguments: { assetId: asset.id } });
    assert.deepEqual((originalAfterPatch.structuredContent as { result: { recipe: { tracks: { joint: string; keys: { time: number; rotation: number[] }[] }[] } } }).result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys.find(key => key.time === 1.5)?.rotation, [-95, 0, 0]);
    const loopOperations = [
      { operation: 'set_pose', joint: 'LeftUpperArm', time: 2, rotation: [-25, 12, 4] },
      { operation: 'close_loop', windowSeconds: 0.8, samples: 8 },
    ];
    const loopPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: loopOperations, dryRun: true } });
    assert.ok(!loopPreview.isError, JSON.stringify(loopPreview));
    const loopCandidate = (loopPreview.structuredContent as { result: { candidateFingerprint: string; recipe: { loop: boolean }; changes: { loopClosure?: { maxAngularGapBeforeDegrees: number; maxAngularGapAfterDegrees: number } }[] } }).result;
    assert.equal(loopCandidate.recipe.loop, true);
    const loopChange = loopCandidate.changes.find(change => change.loopClosure);
    assert.ok(loopChange?.loopClosure);
    assert.ok(loopChange.loopClosure.maxAngularGapBeforeDegrees > 0);
    assert.ok(loopChange.loopClosure.maxAngularGapAfterDegrees < 1e-6);
    const loopCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: asset.id, operations: loopOperations,
      expectedCandidateFingerprint: loopCandidate.candidateFingerprint } });
    assert.ok(!loopCommit.isError, JSON.stringify(loopCommit));
    const loopChild = (loopCommit.structuredContent as { result: { assetId: string; parentId: string; recipe: { loop: boolean } } }).result;
    assert.equal(loopChild.parentId, asset.id);
    assert.equal(loopChild.recipe.loop, true);
    const compressionOperations = [{ operation: 'compress_track', joint: 'LeftUpperArm', maxPositionErrorStuds: 0.05,
      maxRotationErrorDegrees: 5, sampleRateHz: 120 }];
    const compressionPreview = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: loopChild.assetId,
      operations: compressionOperations, dryRun: true } });
    assert.ok(!compressionPreview.isError, JSON.stringify(compressionPreview));
    const compressionCandidate = (compressionPreview.structuredContent as { result: { candidateFingerprint: string; changes: { compression: { sampleCount: number; maxPositionErrorStuds: number; maxRotationErrorDegrees: number; toleranceSatisfiedAtSamples: boolean } }[] } }).result;
    assert.ok(compressionCandidate.changes[0]!.compression.sampleCount > 120);
    assert.equal(compressionCandidate.changes[0]!.compression.toleranceSatisfiedAtSamples, true);
    assert.ok(compressionCandidate.changes[0]!.compression.maxPositionErrorStuds <= 0.05);
    assert.ok(compressionCandidate.changes[0]!.compression.maxRotationErrorDegrees <= 5);
    const compressionCommit = await client.callTool({ name: 'motion_animation_patch', arguments: { assetId: loopChild.assetId,
      operations: compressionOperations, expectedCandidateFingerprint: compressionCandidate.candidateFingerprint } });
    assert.ok(!compressionCommit.isError, JSON.stringify(compressionCommit));
    assert.equal((compressionCommit.structuredContent as { result: { parentId: string } }).result.parentId, loopChild.assetId);
    const invalid = await client.callTool({ name: 'motion_animation_create', arguments: { preset: 'walk', name: 'Invalid', duration: -1 } });
    assert.equal(invalid.isError, true);
    const revised = await client.callTool({ name: 'motion_library_save', arguments: { parentId: asset.id, recipe: { ...asset.recipe, name: 'Revised Cast' } } });
    assert.ok(!revised.isError, JSON.stringify(revised));
    const referencePath = join(directory, 'reference.png');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    await writeFile(referencePath, imageBytes);
    const started = await client.callTool({ name: 'motion_workflow_start', arguments: { brief: {
      name: 'Reference test', kind: 'animation', request: 'A grounded fighting stance', approach: 'Review key poses before timing',
      requirements: [{ id: 'feet', description: 'Feet remain planted' }], avoid: ['Foot sliding'], references: [{ path: referencePath, useFor: 'Test transport only' }],
    } } });
    assert.ok(!started.isError, JSON.stringify(started));
    const workflow = (started.structuredContent as { result: { workflow: { id: string }; next: { stage: string;
      actions: { tool: string; optional?: boolean; when: string }[] } } }).result;
    assert.equal(workflow.next.stage, 'key_poses');
    assert.ok(workflow.next.actions.every(action => discoveredToolNames.includes(action.tool)),
      'every AI workflow recommendation must exist in this server’s registered MCP tool list');
    assert.equal(workflow.next.actions.find(action => action.tool === 'motion_animation_blueprint_goal_preview')?.optional, true);
    assert.ok(workflow.next.actions.some(action => action.tool === 'motion_workflow_attach_candidate_captures'),
      'the animation playbook must use the server-verified capture handoff');
    const resume = await client.callTool({ name: 'motion_agent_resume', arguments: { workflowId: workflow.workflow.id } });
    assert.ok(!resume.isError, JSON.stringify(resume));
    const resumeResult = (resume.structuredContent as { result: { workflow: { selected: { workflow: { id: string }; next: { stage: string; actions: { tool: string }[] } } }; sessions: unknown[]; nextActions: string[]; reviewInbox: { total: number; records: unknown[]; invalidRecordCount: number } } }).result;
    assert.equal(resumeResult.workflow.selected.workflow.id, workflow.workflow.id);
    assert.equal(resumeResult.workflow.selected.next.stage, 'key_poses');
    assert.ok(resumeResult.workflow.selected.next.actions.some(action => action.tool === 'motion_animation_blueprint_preview'));
    assert.ok(resumeResult.sessions.length > 0);
    assert.equal(typeof resumeResult.reviewInbox.total, 'number');
    assert.ok(Array.isArray(resumeResult.reviewInbox.records));
    assert.ok(resumeResult.nextActions.some(action => /Workflow/.test(action)));
    const evidence = await client.callTool({ name: 'motion_workflow_read_evidence', arguments: { workflowId: workflow.workflow.id, referenceIndex: 0 } });
    const content = evidence.content as { type: string; data?: string; mimeType?: string }[];
    assert.equal(content[0]!.type, 'image'); assert.equal(content[0]!.mimeType, 'image/png');
    assert.equal(content[0]!.data, imageBytes.toString('base64'));
  } finally { await client.close(); await transport.close(); }
});
