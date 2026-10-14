import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { animationPreset } from '../src/recipes.js';
import { addSecondaryMotionLayer, secondaryMotionSchema } from '../src/animation-synthesis.js';
import { Blender } from '../src/blender.js';
import { Queue } from '../src/bridge.js';
import { Library } from '../src/library.js';
import { createMcp } from '../src/server.js';

test('secondary motion creates a zero-bounded additive lane and preserves the source animation', () => {
  const source = animationPreset('cast', 'Primary action', 2, 1);
  const original = structuredClone(source);
  const generated = addSecondaryMotionLayer(source, randomUUID(), secondaryMotionSchema.parse({
    layerName: 'Arm follow-through', startTime: 0.4, endTime: 1.6, cycles: 2.5, samplesPerCycle: 12,
    envelope: 'damped', damping: 2.5,
    joints: [{ joint: 'RightUpperArm', rotationAmplitude: [18, 4, 0], positionAmplitude: [0.15, 0, 0], phaseDegrees: 20 }],
  }));
  assert.deepEqual(source, original);
  assert.equal(generated.recipe.layers?.length, 1);
  assert.equal(generated.recipe.layers?.[0]!.blendMode, 'Additive');
  assert.equal(generated.recipe.layers?.[0]!.weight, 1);
  assert.deepEqual(generated.recipe.tracks, source.tracks);
  assert.equal(generated.diagnostics.boundaryOffsetsAreZero, true);
  assert.equal(generated.diagnostics.generatedKeys, generated.diagnostics.intervals + 3);
  const track = generated.recipe.layers?.[0]!.tracks[0]!;
  for (const time of [0, 0.4, 1.6, 2]) {
    const key = track.keys.find(item => item.time === time)!;
    assert.deepEqual(key.position, [0, 0, 0]);
    assert.deepEqual(key.rotation, [0, 0, 0]);
  }
  assert.ok(track.keys.some(key => key.time > 0.4 && key.time < 1.6 && key.rotation.some(value => value !== 0)));
});

test('secondary motion validates uniqueness, key budgets, timing and layer capacity', () => {
  const base = { layerName: 'Follow through', startTime: 0.2, endTime: 1.8, cycles: 2, joints: [{ joint: 'RightUpperArm', rotationAmplitude: [8, 0, 0] }] };
  assert.throws(() => secondaryMotionSchema.parse({ ...base, joints: [...base.joints, { joint: 'rightupperarm' }] }), /unique/i);
  const highDensity = secondaryMotionSchema.parse({ ...base, cycles: 12, samplesPerCycle: 32 });
  assert.throws(() => addSecondaryMotionLayer(animationPreset('cast', 'Dense', 2, 1), randomUUID(), highDensity), /128-key track limit/i);
  assert.throws(() => secondaryMotionSchema.parse({ ...base, startTime: 1.5, endTime: 1 }), /after startTime/i);
  const saturated = animationPreset('cast', 'Saturated layers', 2, 1);
  saturated.layers = Array.from({ length: 32 }, (_, index) => ({ id: randomUUID(), name: `Layer ${index}`, blendMode: 'Additive' as const, weight: 1, enabled: true, tracks: [] }));
  assert.throws(() => addSecondaryMotionLayer(saturated, randomUUID(), secondaryMotionSchema.parse(base)), /maximum of 32 pose layers/i);
});

test('MCP secondary-motion preview and commit are rig-validated, preservation-guarded and fingerprint-bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-secondary-'));
  const library = new Library(join(root, 'artifacts', 'library'));
  const queue = new Queue();
  const rigId = randomUUID();
  const recipe = animationPreset('cast', 'Source cast', 2, 1);
  const profile = {
    version: 1 as const, rigId, rigName: 'Test R15', rigType: 'R15' as const, rigSignature: 'test-r15-secondary-v1',
    joints: recipe.tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 })),
  };
  const source = await library.save(recipe, undefined, profile);
  const server = createMcp(library, queue, new Blender(root, 'blender'));
  const client = new Client({ name: 'secondary-motion-integration', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'motion_animation_secondary_motion_preview'));
    assert.ok(tools.tools.some(tool => tool.name === 'motion_animation_secondary_motion_apply'));
    const request = {
      animationAssetId: source.id, layerName: 'Damped follow-through', startTime: 0.4, endTime: 1.5, cycles: 2.5,
      samplesPerCycle: 10, envelope: 'damped', damping: 2.5,
      joints: [{ joint: 'RightUpperArm', rotationAmplitude: [12, 0, 4], positionAmplitude: [0.1, 0, 0], phaseDegrees: 20 }],
      preserve: [{ joint: 'UpperTorso', startTime: 0, endTime: 2 }],
    };
    const preview = await client.callTool({ name: 'motion_animation_secondary_motion_preview', arguments: request });
    assert.ok(!preview.isError, JSON.stringify(preview));
    const candidate = (preview.structuredContent as { result: { candidateFingerprint: string; diagnostics: { boundaryOffsetsAreZero: boolean }; preservation: { verificationMethod: string }[] } }).result;
    assert.equal(candidate.diagnostics.boundaryOffsetsAreZero, true);
    assert.equal(candidate.preservation[0]!.verificationMethod, 'exact_channel_match');
    const rejectedGuard = await client.callTool({ name: 'motion_animation_secondary_motion_preview', arguments: { ...request, preserve: [{ joint: 'RightUpperArm', startTime: 0, endTime: 2 }] } });
    assert.equal(rejectedGuard.isError, true);
    assert.match(JSON.stringify(rejectedGuard), /Protected motion changed/i);
    const unknownJoint = await client.callTool({ name: 'motion_animation_secondary_motion_preview', arguments: { ...request, joints: [{ joint: 'UnknownControl', rotationAmplitude: [4, 0, 0] }] } });
    assert.equal(unknownJoint.isError, true);
    assert.match(JSON.stringify(unknownJoint), /not reported as driven/i);
    const stale = await client.callTool({ name: 'motion_animation_secondary_motion_apply', arguments: { ...request, preserve: [], expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /differs from its reviewed preview/i);
    const committed = await client.callTool({ name: 'motion_animation_secondary_motion_apply', arguments: { ...request, expectedCandidateFingerprint: candidate.candidateFingerprint } });
    assert.ok(!committed.isError, JSON.stringify(committed));
    const saved = (committed.structuredContent as { result: { parentId: string; recipe: typeof recipe } }).result;
    assert.equal(saved.parentId, source.id);
    assert.deepEqual(saved.recipe.tracks, recipe.tracks);
    assert.equal(saved.recipe.layers?.[0]!.blendMode, 'Additive');
    const original = await library.get(source.id);
    assert.equal(original.recipe.kind, 'animation');
    if (original.recipe.kind === 'animation') assert.equal(original.recipe.layers?.length ?? 0, 0);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
