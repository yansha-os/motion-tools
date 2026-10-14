import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Queue } from '../src/bridge.js';
import { Library } from '../src/library.js';
import { Blender } from '../src/blender.js';
import { createMcp } from '../src/server.js';
import { animationSchema, type AnimationRecipe } from '../src/recipes.js';
import { fingerprint } from '../src/inspection.js';
import type { EditorCheckpoint } from '../src/editor-checkpoints.js';

test('MCP draft checkpoints survive reconnect and restore only through an exact same-topology preview', async t => {
  const root = await mkdtemp(join(tmpdir(), 'motion-checkpoint-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(join(root, 'library'));
  const recipe = animationSchema.parse({ kind: 'animation', name: 'Checkpoint parent', duration: 2, loop: false, markers: [],
    tracks: [{ joint: 'Head', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 10, 0] }] }] });
  const parent = await library.save(recipe);
  const edited = structuredClone(recipe);
  edited.tracks[0]!.keys[1]!.rotation[1] = 25;
  const draftFingerprint = fingerprint(edited), rigSignature = 'checkpoint-topology-v1';
  const queue = new Queue(), sessionId = randomUUID(), rigId = randomUUID();
  const profile = (id: string, signature: string) => ({ version: 1, rigId: id, rigName: 'Checkpoint rig', rigType: 'R15', rigSignature: signature,
    joints: [{ name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
      { name: 'Head', parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 }] });
  const inspect = (targetQueue: Queue, session: string, rig: string, signature: string) => {
    targetQueue.heartbeat(session, { activeRig: { id: rig, rigSignature: signature } });
    const job = targetQueue.enqueue(session, 'inspect', { rigId: rig });
    assert.equal(targetQueue.poll(session)?.id, job.id);
    targetQueue.complete(session, job.id, true, { id: rig, retargetProfile: profile(rig, signature) });
  };
  inspect(queue, sessionId, rigId, rigSignature);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'checkpoint-capture-test', version: '1.0.0' });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  let checkpoint: EditorCheckpoint;
  try {
    await server.connect(serverTransport); await client.connect(transport);
    const requested = await client.callTool({ name: 'motion_studio_read_editor_draft', arguments: { sessionId, rigId } });
    assert.ok(!requested.isError, JSON.stringify(requested));
    const jobId = (requested.structuredContent as { result: { jobId: string } }).result.jobId;
    assert.equal(queue.poll(sessionId)?.operation, 'read_editor_draft');
    queue.complete(sessionId, jobId, true, { rigId, rigSignature, assetId: parent.id, ephemeral: false, dirty: true,
      sourceFingerprint: fingerprint(recipe), currentTime: 0.75, recipe: edited });
    const read = await client.callTool({ name: 'motion_studio_job', arguments: { jobId } });
    assert.ok(!read.isError, JSON.stringify(read));
    const handoff = (read.structuredContent as { result: { result: { checkpointHandoff: { tool: string; arguments: Record<string, unknown> } } } }).result.result.checkpointHandoff;
    assert.equal(handoff.tool, 'motion_editor_checkpoint_create');
    const beforeJobs = queue.listJobs(sessionId, 50, true).jobs.length;
    const saved = await client.callTool({ name: handoff.tool, arguments: handoff.arguments });
    assert.ok(!saved.isError, JSON.stringify(saved));
    checkpoint = (saved.structuredContent as { result: { checkpoint: EditorCheckpoint } }).result.checkpoint;
    assert.equal(checkpoint.draftFingerprint, draftFingerprint);
    const retry = await client.callTool({ name: handoff.tool, arguments: handoff.arguments });
    assert.equal((retry.structuredContent as { result: { alreadyRecorded: boolean } }).result.alreadyRecorded, true);
    const wrongSession = await client.callTool({ name: handoff.tool, arguments: { ...handoff.arguments, sessionId: randomUUID() } });
    assert.equal(wrongSession.isError, true);
    const wrongFingerprint = await client.callTool({ name: handoff.tool, arguments: { ...handoff.arguments, expectedDraftFingerprint: '0'.repeat(64) } });
    assert.equal(wrongFingerprint.isError, true);
    assert.equal(queue.listJobs(sessionId, 50, true).jobs.length, beforeJobs, 'checkpoint persistence must not queue a Studio mutation');
    assert.deepEqual((await library.get(parent.id)).recipe, recipe, 'the immutable animation parent remains unchanged');
    assert.equal((await library.list()).total, 1, 'a checkpoint is not a saved animation asset');
  } finally { await client.close(); await server.close(); }

  const reconnectedQueue = new Queue(), nextSessionId = randomUUID(), nextRigId = randomUUID();
  reconnectedQueue.heartbeat(nextSessionId, { activeRig: { id: nextRigId, rigSignature } });
  const reconnectedServer = createMcp(library, reconnectedQueue, new Blender(root, 'blender'));
  const reconnectedClient = new Client({ name: 'checkpoint-restore-test', version: '1.0.0' });
  const [nextTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await reconnectedServer.connect(nextServerTransport); await reconnectedClient.connect(nextTransport);
    const resume = await reconnectedClient.callTool({ name: 'motion_agent_resume', arguments: {} });
    const resumeSession = (resume.structuredContent as { result: { sessions: { checkpointDiscovery: {
      tool: string; arguments: Record<string, unknown>; basis: string } | null }[] } }).result.sessions[0]!;
    assert.equal(resumeSession.checkpointDiscovery?.tool, 'motion_editor_checkpoint_list');
    assert.deepEqual(resumeSession.checkpointDiscovery?.arguments, { rigSignature, limit: 5 });
    assert.match(resumeSession.checkpointDiscovery!.basis, /fresh inspection is still required/);
    reconnectedQueue.heartbeat(nextSessionId, { activeRig: { id: nextRigId } });
    const missingTopologyResume = await reconnectedClient.callTool({ name: 'motion_agent_resume', arguments: {} });
    assert.equal((missingTopologyResume.structuredContent as { result: { sessions: { checkpointDiscovery: unknown }[] } }).result.sessions[0]?.checkpointDiscovery, null);
    reconnectedQueue.heartbeat(nextSessionId, { activeRig: { id: nextRigId, rigSignature } });
    const resumed = (resume.structuredContent as { result: { editorCheckpoints: { entries: { id: string }[]; total: number } } }).result.editorCheckpoints;
    assert.equal(resumed.total, 1);
    assert.equal(resumed.entries[0]?.id, checkpoint!.id);
    assert.ok(!('draft' in resumed.entries[0]!));
    for (const [filters, expectedTotal] of [
      [{ rigSignature, dirty: true }, 1],
      [{ rigSignature, rigId }, 1],
      [{ rigSignature, rigId: nextRigId }, 0],
      [{ rigSignature: 'different-topology' }, 0],
      [{ dirty: false }, 0],
    ] as const) {
      const listed = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_list', arguments: { ...filters, limit: 1 } });
      assert.ok(!listed.isError, JSON.stringify(listed));
      const result = (listed.structuredContent as { result: { total: number; entries: { id: string; rigSignature: string }[] } }).result;
      assert.equal(result.total, expectedTotal);
      if (expectedTotal) {
        assert.equal(result.entries[0]?.id, checkpoint!.id);
        assert.equal(result.entries[0]?.rigSignature, rigSignature);
      }
    }
    assert.equal(reconnectedQueue.listJobs(nextSessionId, 50, true).jobs.length, 0, 'checkpoint discovery must not submit Studio work');
    const recovered = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_read', arguments: { checkpointId: checkpoint!.id } });
    assert.ok(!recovered.isError, JSON.stringify(recovered));
    assert.deepEqual((recovered.structuredContent as { result: EditorCheckpoint }).result, checkpoint!);
    const restoreArgs = { checkpointId: checkpoint!.id, expectedCheckpointFingerprint: checkpoint!.checkpointFingerprint,
      sessionId: nextSessionId, rigId: nextRigId };
    const uninspected = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_restore_preview', arguments: restoreArgs });
    assert.equal(uninspected.isError, true);
    inspect(reconnectedQueue, nextSessionId, nextRigId, rigSignature);
    const preview = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_restore_preview', arguments: restoreArgs });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const result = (preview.structuredContent as { result: { recipe: AnimationRecipe; candidateFingerprint: string; parentStatus: string;
      openPreviewRequest: { tool: string; arguments: Record<string, unknown> } } }).result;
    assert.deepEqual(result.recipe, edited);
    assert.equal(result.candidateFingerprint, draftFingerprint);
    assert.equal(result.parentStatus, 'available');
    assert.equal(result.openPreviewRequest.tool, 'motion_studio_open_candidate');
    assert.equal(result.openPreviewRequest.arguments.parentAssetId, parent.id);
    assert.equal(result.openPreviewRequest.arguments.initialTime, 0.75);
    assert.equal(reconnectedQueue.listJobs(nextSessionId).jobs.length, 0, 'restore preview must not open or apply anything');
    const outOfRange = await reconnectedClient.callTool({ name: 'motion_studio_open_candidate', arguments: { ...result.openPreviewRequest.arguments, initialTime: 2.1 } });
    assert.equal(outOfRange.isError, true);
    assert.equal(reconnectedQueue.listJobs(nextSessionId).jobs.length, 0, 'invalid recovery time must fail before queueing');
    const open = await reconnectedClient.callTool({ name: 'motion_studio_open_candidate', arguments: result.openPreviewRequest.arguments });
    assert.ok(!open.isError, JSON.stringify(open));
    const command = reconnectedQueue.poll(nextSessionId)!;
    assert.equal(command.operation, 'open_candidate');
    assert.equal((command.payload as { initialTime: number }).initialTime, 0.75);
    reconnectedQueue.complete(nextSessionId, command.id, true, { opened: true });
    const opened = await reconnectedClient.callTool({ name: 'motion_studio_job', arguments: { jobId: command.id } });
    assert.ok(!opened.isError, JSON.stringify(opened));
    const opening = (opened.structuredContent as { result: { requestedInitialTime: number;
      readbackHandoff: { tool: string; arguments: Record<string, unknown> } } }).result;
    assert.equal(opening.requestedInitialTime, 0.75);
    assert.deepEqual(opening.readbackHandoff, { tool: 'motion_studio_read_editor_draft', arguments: {
      sessionId: nextSessionId, rigId: nextRigId, expectedDraftFingerprint: draftFingerprint } });
    const staleHash = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_restore_preview', arguments: { ...restoreArgs, expectedCheckpointFingerprint: '0'.repeat(64) } });
    assert.equal(staleHash.isError, true);
    inspect(reconnectedQueue, nextSessionId, nextRigId, 'different-topology');
    const differentRig = await reconnectedClient.callTool({ name: 'motion_editor_checkpoint_restore_preview', arguments: restoreArgs });
    assert.equal(differentRig.isError, true);
    assert.match(JSON.stringify(differentRig), /topology/i);
    assert.equal((await library.list()).total, 1);
  } finally { await reconnectedClient.close(); await reconnectedServer.close(); }
});
