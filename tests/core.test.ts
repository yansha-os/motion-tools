import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { animationPreset, recipeSchema, vfxPreset } from '../src/recipes.js';
import { classifyAuthoringIntentTiming, Library } from '../src/library.js';
import { Queue } from '../src/bridge.js';
import { patchAnimation, patchLayerIdFactory } from '../src/animation-patch.js';
import { fingerprint } from '../src/inspection.js';

test('walk loops close and changing speed preserves normalized motion', () => {
  const a = animationPreset('walk', 'Walk', 2, 1);
  const b = animationPreset('walk', 'Fast walk', 1, 1);
  for (const track of a.tracks) {
    assert.deepEqual(track.keys[0]?.rotation, track.keys.at(-1)?.rotation);
    assert.equal(track.keys.at(-1)?.time, 2);
  }
  assert.equal(b.tracks[0]?.keys.at(-1)?.time, 1);
  assert.deepEqual(a.tracks[0]?.keys[1]?.rotation, b.tracks[0]?.keys[1]?.rotation);
});

test('laser recipes preserve particle compatibility and bound beam length', () => {
  const particle = vfxPreset('impact', 'Impact');
  assert.equal(recipeSchema.safeParse(particle).success, true);
  const laser = { ...particle, beam: { length: 15 } };
  assert.equal(recipeSchema.safeParse(laser).success, true);
  for (const length of [-1, 0, 101, Infinity, NaN]) {
    assert.equal(recipeSchema.safeParse({ ...laser, beam: { length } }).success, false);
  }
});

test('energy columns require bounded geometry and travel, hold, fade timing', () => {
  const column = { ...vfxPreset('impact', 'Column'), lifetime: 1.8, column: { length: 18, travelTime: 0.4, fadeTime: 0.3 } };
  assert.equal(recipeSchema.safeParse(column).success, true);
  assert.equal(recipeSchema.safeParse({ ...column, beam: { length: 18 } }).success, false);
  assert.equal(recipeSchema.safeParse({ ...column, lifetime: 0.7 }).success, false);
  for (const length of [0, 101, Infinity]) {
    assert.equal(recipeSchema.safeParse({ ...column, column: { ...column.column, length } }).success, false);
  }
});

test('rejects invalid timeline, duplicate joints, non-finite values, and discontinuous loops', () => {
  for (const change of [
    (r: any) => { r.tracks[0].keys[1].time = -1; },
    (r: any) => { r.tracks.push(r.tracks[0]); },
    (r: any) => { r.tracks[0].keys[0].rotation[0] = Infinity; },
    (r: any) => { r.tracks[0].keys.at(-1).rotation[0] = 44; },
  ]) {
    const recipe = animationPreset('walk', 'Walk', 1, 1);
    change(recipe);
    assert.equal(recipeSchema.safeParse(recipe).success, false);
  }
});

test('library creates immutable revisions and rejects path traversal', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'motion-library-')));
  const first = await library.save(animationPreset('idle', 'Idle', 2, 1));
  const second = await library.save(animationPreset('idle', 'Idle revised', 3, 1), first.id);
  assert.notEqual(first.id, second.id);
  assert.equal((await library.get(first.id)).recipe.name, 'Idle');
  assert.equal(second.parentId, first.id);
  await assert.rejects(library.get('../secrets'));
});

test('authoring-intent timing classification is explicit for current, stale, and absent provenance', () => {
  const intent = { schemaVersion: 1 as const, sourceRecipeFingerprint: 'a'.repeat(64),
    phases: [{ id: 'action', label: 'main_action' as const, start: 0, end: 1 }] };
  assert.equal(classifyAuthoringIntentTiming(intent, 'a'.repeat(64)), 'exact_current_recipe');
  assert.equal(classifyAuthoringIntentTiming(intent, 'b'.repeat(64)), 'historical_reference');
  assert.equal(classifyAuthoringIntentTiming(undefined, 'a'.repeat(64)), 'unavailable');
  assert.equal(classifyAuthoringIntentTiming(intent, undefined), 'unavailable');
});

test('library replays patch provenance and rejects self-consistent hashes for mismatched operations', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'motion-patch-provenance-')));
  const sourceRecipe = animationPreset('idle', 'Audited idle', 2, 1);
  const sourceFingerprint = fingerprint(sourceRecipe);
  const actualOperations = [{ operation: 'insert_key' as const, joint: sourceRecipe.tracks[0]!.joint, time: 0.25, rotation: [0, 10, 0] }];
  const forgedOperations = [{ operation: 'insert_key' as const, joint: sourceRecipe.tracks[0]!.joint, time: 0.25, rotation: [0, 20, 0] }];
  const preserve: never[] = [];
  const candidate = patchAnimation(sourceRecipe, actualOperations,
    patchLayerIdFactory('unsaved-candidate', sourceFingerprint, actualOperations, preserve)).recipe;
  const candidateRecipeFingerprint = fingerprint(candidate);
  const candidateFingerprint = createHash('sha256').update(JSON.stringify({ sourceFingerprint, operations: forgedOperations, preserve,
    recipeFingerprint: candidateRecipeFingerprint })).digest('hex');
  const provenanceBase = { schemaVersion: 1 as const, kind: 'ai_candidate_patch' as const, sourceFingerprint, sourceRecipe,
    candidateFingerprint, candidateRecipeFingerprint, operations: forgedOperations, preserve };
  const revisionProvenance = { ...provenanceBase,
    provenanceFingerprint: createHash('sha256').update(JSON.stringify(provenanceBase)).digest('hex') };
  await assert.rejects(library.save(candidate, undefined, undefined, revisionProvenance), /do not reproduce the saved candidate/i);
});

test('animation source-rig provenance persists, inherits through children, and can be replaced on retarget', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'motion-rig-provenance-')));
  const recipe = animationPreset('idle', 'Rigged idle', 2, 1);
  const sourceRigProfile = {
    version: 1 as const, rigId: '11111111-1111-4111-8111-111111111111', rigName: 'Source R15', rigType: 'R15' as const, rigSignature: 'source-signature',
    joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      ...recipe.tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 })),
    ],
  };
  const first = await library.save(recipe, undefined, sourceRigProfile);
  const loaded = await new Library(library.directory).get(first.id);
  assert.deepEqual(loaded.sourceRigProfile, sourceRigProfile);

  const ordinaryChild = await library.save({ ...recipe, name: 'Adjusted idle' }, first.id);
  assert.deepEqual(ordinaryChild.sourceRigProfile, sourceRigProfile);
  const unknownJointChild = { ...recipe, name: 'Invalid added joint', tracks: [...recipe.tracks,
    { ...recipe.tracks[0]!, joint: 'UnmappedJoint' }] };
  await assert.rejects(library.save(unknownJointChild, first.id), /Source rig profile Source R15 does not contain these animation joints as driven: UnmappedJoint/,
    'normal child saves must validate newly authored joints against inherited provenance');
  await assert.rejects(library.saveIdempotent(unknownJointChild, '33333333-3333-4333-8333-333333333333', first.id),
    /Source rig profile Source R15 does not contain these animation joints as driven: UnmappedJoint/,
    'idempotent child saves must apply the same inherited-provenance validation');

  const targetRigProfile = { ...sourceRigProfile, rigId: '22222222-2222-4222-8222-222222222222', rigName: 'Target R15', rigSignature: 'target-signature' };
  const retargetedChild = await library.save({ ...recipe, name: 'Retargeted idle' }, ordinaryChild.id, targetRigProfile);
  assert.deepEqual(retargetedChild.sourceRigProfile, targetRigProfile);
  assert.equal(retargetedChild.parentId, ordinaryChild.id);

  const metadata = await library.list(0, 10);
  const summary = metadata.assets.find(asset => asset.id === first.id)!;
  assert.equal(summary.sourceRigName, 'Source R15');
  assert.equal('sourceRigProfile' in summary, false);
  await assert.rejects(library.save(recipe, undefined, { ...sourceRigProfile, joints: sourceRigProfile.joints.slice(0, 1) }), /not contain these animation joints as driven/);
  await assert.rejects(library.save(vfxPreset('impact', 'VFX'), undefined, sourceRigProfile), /Only animation assets/);
  const legacy = await library.save(animationPreset('idle', 'Legacy recipe', 1, 1));
  assert.equal((await library.get(legacy.id)).sourceRigProfile, undefined);
});

test('queue binds to a session, delivers only once, and checks result ownership', () => {
  let now = 1000;
  const queue = new Queue(() => now);
  queue.heartbeat('a', { place: 'A' });
  queue.heartbeat('b', { place: 'B' });
  assert.throws(() => queue.enqueue(undefined, 'inspect', {}), /session/i);
  const job = queue.enqueue('a', 'inspect', {});
  assert.equal(queue.poll('b'), null);
  assert.equal(queue.poll('a')?.id, job.id);
  assert.equal(queue.poll('a'), null);
  assert.throws(() => queue.complete('b', job.id, true, {}), /session/i);
  now += 61000;
  assert.equal(queue.get(job.id).status, 'unknown');
  assert.equal(queue.poll('a'), null);
  queue.complete('a', job.id, true, { inspected: true });
  assert.equal(queue.get(job.id).status, 'succeeded');
});

test('queued commands expire without running after a disconnect', () => {
  let now = 1000;
  const queue = new Queue(() => now);
  queue.heartbeat('a', {});
  const job = queue.enqueue('a', 'save_animation', {});
  now += 31000;
  assert.equal(queue.poll('a'), null);
  assert.equal(queue.get(job.id).status, 'expired');
});
