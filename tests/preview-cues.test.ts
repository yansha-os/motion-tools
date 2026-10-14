import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { animationPreset, animationSchema, vfxSchema } from '../src/recipes.js';
import { previewCueInputSchema, resolvePreviewCueTime } from '../src/preview-cues.js';
import { Queue } from '../src/bridge.js';
import { Blender } from '../src/blender.js';
import { Library } from '../src/library.js';
import { createMcp } from '../src/server.js';

const animation = animationSchema.parse({
  ...animationPreset('slash', 'Marker Cue Test', 2, 0.5),
  markers: [
    { name: 'Release', time: 0.75 },
    { name: 'Impact', time: 1.1 },
    { name: 'Release', time: 1.5 },
  ],
});

test('preview cue accepts legacy exact-time cues and resolves their time unchanged', () => {
  const cue = previewCueInputSchema.parse({ assetId: randomUUID(), part: 'RightHand', time: 1.25 });
  assert.equal(resolvePreviewCueTime(cue, animation, 2), 1.25);
});

test('preview cue resolves a marker occurrence and applies a signed offset', () => {
  const cue = previewCueInputSchema.parse({ assetId: randomUUID(), part: 'RightHand', marker: 'Release', occurrence: 2, offset: -0.2 });
  assert.equal(resolvePreviewCueTime(cue, animation, 2), 1.3);
});

test('preview cue defaults marker occurrence to the first matching marker', () => {
  const cue = previewCueInputSchema.parse({ assetId: randomUUID(), part: 'RightHand', marker: 'Release' });
  assert.equal(resolvePreviewCueTime(cue, animation, 2), 0.75);
});

test('preview cue rejects ambiguous timing, missing markers, missing animations, and out-of-range results', () => {
  const common = { assetId: randomUUID(), part: 'RightHand' };
  assert.equal(previewCueInputSchema.safeParse({ ...common, time: 0.5, marker: 'Release' }).success, false);
  assert.equal(previewCueInputSchema.safeParse({ ...common, occurrence: 2, time: 0.5 }).success, false);
  const absent = previewCueInputSchema.parse({ ...common, marker: 'Throw' });
  assert.throws(() => resolvePreviewCueTime(absent, animation, 2), /occurrence 1 was not found/);
  assert.throws(() => resolvePreviewCueTime(absent, undefined, 2), /requires an animationId/);
  const beforeStart = previewCueInputSchema.parse({ ...common, marker: 'Release', offset: -1 });
  assert.throws(() => resolvePreviewCueTime(beforeStart, animation, 2), /before the start/);
  const tooLate = previewCueInputSchema.parse({ ...common, marker: 'Impact', offset: 1 });
  assert.throws(() => resolvePreviewCueTime(tooLate, animation, 2), /earlier than the preview duration/);
  const beyondPreview = previewCueInputSchema.parse({ ...common, time: 1.5 });
  assert.throws(() => resolvePreviewCueTime(beyondPreview, animation, 1.5), /earlier than the preview duration/);
  const beyondClip = previewCueInputSchema.parse({ ...common, time: 2.1 });
  assert.throws(() => resolvePreviewCueTime(beyondClip, animation, 3), /inside the animation duration/);
});

test('MCP preview resolves marker-relative VFX cues into the exact queued Studio payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-marker-preview-'));
  const library = new Library(join(root, 'library'));
  const queue = new Queue();
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, { place: 'Marker preview fixture' });
  const animationAsset = await library.save(animation);
  const vfxAsset = await library.save(vfxSchema.parse({ kind: 'vfx', name: 'Release flash', color: [0.1, 0.8, 1], size: 0.4, lifetime: 0.3, speed: 1, count: 12 }));
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'marker-preview-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: 'motion_studio_preview', arguments: {
      sessionId, rigId: randomUUID(), animationId: animationAsset.id, seconds: 2,
      effects: [{ assetId: vfxAsset.id, part: 'RightHand', marker: 'Release', occurrence: 2, offset: -0.2 }],
    } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const jobId = (response.structuredContent as { result: { jobId: string } }).result.jobId;
    const payload = queue.get(jobId).payload as { animationId: string; effects: { time: number; part: string; sourceMarker: { name: string; occurrence: number; offset: number } }[] };
    assert.equal(payload.animationId, animationAsset.id);
    assert.equal(payload.effects[0]?.time, 1.3);
    assert.equal(payload.effects[0]?.part, 'RightHand');
    assert.deepEqual(payload.effects[0]?.sourceMarker, { name: 'Release', occurrence: 2, offset: -0.2 });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
