import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { animationPreset, animationSchema, vfxSchema } from '../src/recipes.js';
import { Queue } from '../src/bridge.js';
import { Blender } from '../src/blender.js';
import { Library } from '../src/library.js';
import { VfxTimelineLibrary, vfxTimelineFingerprint, vfxTimelineSchema } from '../src/vfx-timeline.js';
import { createMcp } from '../src/server.js';
import { randomUUID } from 'node:crypto';

test('VFX cue sheets preview exact marker bindings and commit only the reviewed fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-vfx-timeline-'));
  try {
    const assets = new Library(join(root, 'assets'));
    const timelines = new VfxTimelineLibrary(join(root, 'timelines'), assets);
    const animation = await assets.save(animationSchema.parse({
      ...animationPreset('cast', 'Marker-bound cast', 2, 0.7),
      markers: [{ name: 'Release', time: 1.25 }],
    }));
    const impact = await assets.save(vfxSchema.parse({ kind: 'vfx', name: 'Impact flash', color: [0.2, 0.8, 1], size: 0.6, lifetime: 0.5, speed: 5, count: 24 }));
    const recipe = vfxTimelineSchema.parse({
      name: 'Cast release cue sheet', animationId: animation.id, seconds: 2,
      cues: [{ effectId: impact.id, part: 'RightHand', marker: 'Release', offset: 0.08 }],
    });

    const preview = await timelines.preview(recipe);
    assert.equal(preview.effects[0]?.time, 1.33);
    assert.deepEqual(preview.effects[0]?.sourceMarker, { name: 'Release', occurrence: 1, offset: 0.08 });
    assert.equal(preview.sourceFingerprints.length, 2);
    assert.equal(preview.candidateFingerprint, vfxTimelineFingerprint(recipe, preview.sourceFingerprints));
    await assert.rejects(() => timelines.save(recipe, '0'.repeat(64)), /changed since preview/);

    const saved = await timelines.save(recipe, preview.candidateFingerprint);
    const read = await timelines.get(saved.id);
    assert.equal(read.resolved.effects[0]?.time, 1.33);
    assert.equal((await timelines.list()).timelines[0]?.sourceIntegrity, 'verified');

    const animationPath = join(assets.directory, `${animation.id}.json`);
    const tampered = JSON.parse(await readFile(animationPath, 'utf8')) as { recipe: { markers: { name: string; time: number }[] } };
    tampered.recipe.markers[0]!.time = 1.4;
    await writeFile(animationPath, JSON.stringify(tampered));
    assert.equal((await timelines.list()).timelines[0]?.sourceIntegrity, 'stale');
    await assert.rejects(() => timelines.get(saved.id), /has stale sources/);

    const revisedPreview = await timelines.preview(recipe);
    assert.equal(revisedPreview.effects[0]?.time, 1.48);
    const child = await timelines.save(recipe, revisedPreview.candidateFingerprint, saved.id);
    assert.equal(child.parentId, saved.id);
    assert.equal((await timelines.get(child.id)).resolved.effects[0]?.time, 1.48);

    const childPath = join(timelines.directory, `${child.id}.json`);
    const tamperedCueSheet = JSON.parse(await readFile(childPath, 'utf8')) as { recipe: { cues: { offset: number }[] } };
    tamperedCueSheet.recipe.cues[0]!.offset = 0.2;
    await writeFile(childPath, JSON.stringify(tamperedCueSheet));
    const corruptEntry = (await timelines.list()).timelines.find(item => item.id === child.id);
    assert.equal(corruptEntry?.sourceIntegrity, 'corrupt');
    assert.match(corruptEntry?.sourceIntegrityIssue ?? '', /content fingerprint mismatch/);
    await assert.rejects(() => timelines.get(child.id), /content fingerprint mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VFX cue sheet validation rejects wrong asset kinds, missing markers and unsafe cue ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-vfx-timeline-invalid-'));
  try {
    const assets = new Library(join(root, 'assets'));
    const timelines = new VfxTimelineLibrary(join(root, 'timelines'), assets);
    const animation = await assets.save(animationSchema.parse({
      ...animationPreset('cast', 'Bounded cast', 2, 0.7), markers: [],
    }));
    const effect = await assets.save(vfxSchema.parse({ kind: 'vfx', name: 'Burst', color: [1, 0.4, 0.1], size: 0.5, lifetime: 0.4, speed: 3, count: 10 }));
    await assert.rejects(() => timelines.preview({ name: 'Bad marker', animationId: animation.id, seconds: 2,
      cues: [{ effectId: effect.id, part: 'RightHand', marker: 'Release' }] }), /occurrence 1 was not found/);
    await assert.rejects(() => timelines.preview({ name: 'Bad time', animationId: animation.id, seconds: 2,
      cues: [{ effectId: effect.id, part: 'RightHand', time: 2 }] }), /earlier than the preview duration/);
    await assert.rejects(() => timelines.preview({ name: 'Wrong effect', animationId: animation.id, seconds: 2,
      cues: [{ effectId: animation.id, part: 'RightHand', time: 1 }] }), /must reference a VFX asset/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP exposes the full VFX cue-sheet lifecycle and queues the pinned combined preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-vfx-timeline-mcp-'));
  const assets = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID();
  const rigId = randomUUID();
  const rigSignature = JSON.stringify({ type: 'R15', joints: ['Root', 'RightHand'] });
  queue.heartbeat(sessionId, { place: 'VFX timeline MCP fixture', activeRig: { id: rigId, rigSignature } });
  const animation = await assets.save(animationSchema.parse({
    ...animationPreset('cast', 'Timeline cast', 2, 0.7), markers: [{ name: 'Release', time: 1.1 }],
  }));
  const effect = await assets.save(vfxSchema.parse({ kind: 'vfx', name: 'Timeline spark', color: [0.2, 0.8, 1], size: 0.4, lifetime: 0.4, speed: 3, count: 18 }));
  const server = createMcp(assets, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'vfx-timeline-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const timeline = { name: 'Release spark', animationId: animation.id, seconds: 2,
      cues: [{ effectId: effect.id, part: 'RightHand', marker: 'Release', offset: 0.05 }] };
    const previewResponse = await client.callTool({ name: 'motion_vfx_timeline_preview', arguments: { timeline } });
    assert.equal(previewResponse.isError, undefined, JSON.stringify(previewResponse));
    const preview = (previewResponse.structuredContent as { result: { candidateFingerprint: string; effects: { time: number }[] } }).result;
    assert.equal(preview.effects[0]?.time, 1.15);

    const createResponse = await client.callTool({ name: 'motion_vfx_timeline_create', arguments: { timeline, expectedCandidateFingerprint: preview.candidateFingerprint } });
    assert.equal(createResponse.isError, undefined, JSON.stringify(createResponse));
    const saved = (createResponse.structuredContent as { result: { id: string; recipe: { animationId: string } } }).result;
    assert.equal(saved.recipe.animationId, animation.id);

    const readResponse = await client.callTool({ name: 'motion_vfx_timeline_read', arguments: { timelineId: saved.id } });
    assert.equal(readResponse.isError, undefined, JSON.stringify(readResponse));
    const listResponse = await client.callTool({ name: 'motion_vfx_timeline_list', arguments: {} });
    const listed = (listResponse.structuredContent as { result: { total: number; timelines: { id: string; sourceIntegrity: string }[] } }).result;
    assert.equal(listed.total, 1);
    assert.equal(listed.timelines[0]?.id, saved.id);
    assert.equal(listed.timelines[0]?.sourceIntegrity, 'verified');

    const preflightResponse = await client.callTool({ name: 'motion_studio_vfx_timeline_preflight', arguments: { sessionId, rigId, timelineId: saved.id } });
    assert.equal(preflightResponse.isError, undefined, JSON.stringify(preflightResponse));
    const preflightJobId = (preflightResponse.structuredContent as { result: { jobId: string } }).result.jobId;
    const preflightPayload = queue.get(preflightJobId).payload as { timelineId: string; timelineFingerprint: string; animationId: string; animation: { duration: number };
      rigId: string; rigSignature: string; effects: { part: string; time: number; sourceMarker?: { name: string; occurrence: number; offset: number } }[] };
    assert.equal(queue.poll(sessionId)?.id, preflightJobId);
    queue.complete(sessionId, preflightJobId, true, {
      valid: true, timelineId: preflightPayload.timelineId, timelineFingerprint: preflightPayload.timelineFingerprint,
      animationId: preflightPayload.animationId, rigId: preflightPayload.rigId, rigSignature: preflightPayload.rigSignature,
      duration: preflightPayload.animation.duration,
      cues: preflightPayload.effects.map((cue, index) => ({ index: index + 1, part: cue.part, partClass: 'Part', time: cue.time,
        sourceMarker: cue.sourceMarker, targetFound: true, effectConstructed: true })),
      temporaryCloneDestroyed: true, saved: false, note: 'Fixture preflight passed.',
    });
    const preflightJobResponse = await client.callTool({ name: 'motion_studio_job', arguments: { jobId: preflightJobId } });
    assert.equal(preflightJobResponse.isError, undefined, JSON.stringify(preflightJobResponse));
    const preflightFingerprint = (preflightJobResponse.structuredContent as { result: { result: { preflightFingerprint: string } } }).result.result.preflightFingerprint;

    const unvalidatedPlay = await client.callTool({ name: 'motion_studio_preview_vfx_timeline', arguments: { sessionId, rigId, timelineId: saved.id } });
    assert.equal(unvalidatedPlay.isError, true);

    const playResponse = await client.callTool({ name: 'motion_studio_preview_vfx_timeline', arguments: { sessionId, rigId, timelineId: saved.id, preflightFingerprint } });
    assert.equal(playResponse.isError, undefined, JSON.stringify(playResponse));
    const jobId = (playResponse.structuredContent as { result: { jobId: string } }).result.jobId;
    const payload = queue.get(jobId).payload as { animationId: string; rigSignature: string; effects: { part: string; time: number }[] };
    assert.equal(payload.animationId, animation.id);
    assert.equal(payload.rigSignature, rigSignature);
    assert.deepEqual(payload.effects.map(cue => ({ part: cue.part, time: cue.time })), [{ part: 'RightHand', time: 1.15 }]);

    const updatedTimeline = { ...timeline, name: 'Release spark revised', cues: [{ ...timeline.cues[0]!, offset: 0.1 }] };
    const updatedPreviewResponse = await client.callTool({ name: 'motion_vfx_timeline_preview', arguments: { timeline: updatedTimeline } });
    const updatedCandidate = (updatedPreviewResponse.structuredContent as { result: { candidateFingerprint: string } }).result.candidateFingerprint;
    const updateResponse = await client.callTool({ name: 'motion_vfx_timeline_update', arguments: {
      timelineId: saved.id, timeline: updatedTimeline, expectedCandidateFingerprint: updatedCandidate,
    } });
    assert.equal(updateResponse.isError, undefined, JSON.stringify(updateResponse));
    const child = (updateResponse.structuredContent as { result: { parentId: string } }).result;
    assert.equal(child.parentId, saved.id);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
