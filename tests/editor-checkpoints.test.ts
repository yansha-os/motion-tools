import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorCheckpointLibrary } from '../src/editor-checkpoints.js';
import { fingerprint } from '../src/inspection.js';
import { animationSchema } from '../src/recipes.js';

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'motion-checkpoints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recipe = animationSchema.parse({ kind: 'animation', name: 'Draft recovery', duration: 2, loop: false, markers: [],
    tracks: [{ joint: 'Head', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 0, 0], rotation: [0, 15, 0] }] }] });
  const input = { name: 'Before refinement', note: 'Keep the chosen pose.', sessionId: randomUUID(), readJobId: randomUUID(),
    readRequestedAt: new Date().toISOString(), draftFingerprint: fingerprint(recipe), draft: {
      rigId: randomUUID(), rigSignature: 'checkpoint-rig', assetId: randomUUID(), ephemeral: true, dirty: true, currentTime: 0.75, recipe,
    } };
  return { root, directory: join(root, 'checkpoints'), input };
}

test('editor checkpoint preserves a complete unsaved draft across library recreation without modifying the source', async t => {
  const f = await fixture(t), before = structuredClone(f.input);
  const created = await new EditorCheckpointLibrary(f.directory).create(f.input);
  const recovered = await new EditorCheckpointLibrary(f.directory).get(created.checkpoint.id);
  assert.deepEqual(recovered, created.checkpoint);
  assert.deepEqual(recovered.draft.recipe, f.input.draft.recipe);
  assert.equal(recovered.draft.dirty, true);
  assert.equal(recovered.draft.currentTime, 0.75);
  assert.deepEqual(f.input, before);
});

test('concurrent checkpoint retries are atomic and metadata conflicts cannot overwrite an existing snapshot', async t => {
  const f = await fixture(t), library = new EditorCheckpointLibrary(f.directory);
  const results = await Promise.all(Array.from({ length: 8 }, () => library.create(f.input)));
  assert.equal(results.filter(result => !result.alreadyRecorded).length, 1);
  assert.equal(new Set(results.map(result => result.checkpoint.id)).size, 1);
  assert.equal((await readdir(f.directory)).length, 1, 'temporary write files must be cleaned up');
  const saved = results[0]!.checkpoint;
  await assert.rejects(library.create({ ...f.input, note: 'Different metadata' }), /immutable checkpoint with different metadata/i);
  assert.deepEqual(await library.get(saved.id), saved);
});

test('checkpoint storage rejects contradictory fingerprints, invalid playheads, and corruption', async t => {
  const f = await fixture(t), library = new EditorCheckpointLibrary(f.directory);
  await assert.rejects(library.create({ ...f.input, draftFingerprint: '0'.repeat(64) }), /does not match its exact recipe/i);
  await assert.rejects(library.create({ ...f.input, draft: { ...f.input.draft, currentTime: 2.1 } }), /playhead must be inside/i);
  await assert.rejects(library.create({ ...f.input, draft: { ...f.input.draft, dirty: false, sourceFingerprint: '0'.repeat(64) } }), /marked the editor draft clean/i);
  const created = await library.create(f.input);
  const path = join(f.directory, `${created.checkpoint.id}.json`);
  const changed: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(typeof changed === 'object' && changed !== null);
  await writeFile(path, JSON.stringify({ ...changed, note: 'Edited on disk' }));
  await assert.rejects(library.get(created.checkpoint.id), /failed verification/i);
  await assert.rejects(library.get('../outside'), /uuid/i);
});

test('checkpoint listing is read-only, compact, paginated, and isolates corrupt records', async t => {
  const f = await fixture(t), library = new EditorCheckpointLibrary(f.directory);
  assert.equal((await library.list()).total, 0);
  assert.ok(!(await readdir(f.root)).includes('checkpoints'), 'read-only listing must not create its directory');
  const one = await library.create(f.input);
  const two = await library.create({ ...f.input, readJobId: randomUUID(), readRequestedAt: '2026-10-14T03:00:00.000Z' });
  const page = await library.list(0, 1);
  assert.equal(page.total, 2);
  assert.equal(page.entries.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.entries[0]?.sourceRigName, null);
  assert.ok(!('rigName' in page.entries[0]!), 'source metadata must not be presented as the current rig name');
  assert.ok(!('draft' in page.entries[0]!) && !('recipe' in page.entries[0]!), 'lists must omit full draft bodies');
  await writeFile(join(f.directory, `${one.checkpoint.id}.json`), '{malformed');
  const after = await library.list();
  assert.equal(after.total, 1);
  assert.equal(after.entries[0]?.id, two.checkpoint.id);
  assert.equal(after.invalidRecordCount, 1);
});

test('retargeted checkpoint summaries retain source lineage separately from the captured rig', async t => {
  const f = await fixture(t), library = new EditorCheckpointLibrary(f.directory);
  const sourceRigId = randomUUID();
  const sourceRigProfile = { version: 1 as const, rigId: sourceRigId, rigName: 'Original character', rigType: 'R15' as const,
    rigSignature: 'original-topology', joints: [{ name: 'Head', parent: '', driven: true,
      basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 }] };
  const saved = await library.create({ ...f.input, draft: { ...f.input.draft, sourceRigProfile } });
  const summary = (await new EditorCheckpointLibrary(f.directory).list()).entries[0]!;
  assert.equal(summary.rigId, f.input.draft.rigId);
  assert.notEqual(summary.rigId, sourceRigId);
  assert.equal(summary.sourceRigName, 'Original character');
  assert.ok(!('rigName' in summary));
  const recovered = await library.get(saved.checkpoint.id);
  assert.deepEqual(recovered.draft.sourceRigProfile, sourceRigProfile);
  assert.equal(recovered.draft.rigSignature, 'checkpoint-rig');
});

test('recovery filters use captured topology, combine predicates, and paginate matching records only', async t => {
  const f = await fixture(t), library = new EditorCheckpointLibrary(f.directory);
  const first = await library.create({ ...f.input, readRequestedAt: '2026-10-14T01:00:00.000Z' });
  const second = await library.create({ ...f.input, readJobId: randomUUID(), readRequestedAt: '2026-10-14T02:00:00.000Z',
    draft: { ...f.input.draft, rigId: randomUUID() } });
  await library.create({ ...f.input, readJobId: randomUUID(), readRequestedAt: '2026-10-14T03:00:00.000Z',
    draft: { ...f.input.draft, rigSignature: 'other-topology' } });
  await library.create({ ...f.input, readJobId: randomUUID(), draft: { ...f.input.draft, dirty: false } });
  const filter = { rigSignature: 'checkpoint-rig', dirty: true };
  const page = await library.list(0, 1, filter);
  assert.equal(page.total, 2);
  assert.equal(page.entries[0]?.id, second.checkpoint.id);
  assert.equal(page.entries[0]?.rigSignature, filter.rigSignature);
  assert.equal(page.nextOffset, 1);
  assert.equal((await library.list(1, 1, filter)).entries[0]?.id, first.checkpoint.id);
  const exactRig = await library.list(0, 20, { ...filter, rigId: f.input.draft.rigId });
  assert.equal(exactRig.total, 1);
  assert.equal(exactRig.entries[0]?.id, first.checkpoint.id);
  assert.equal((await library.list(0, 20, { rigSignature: 'missing' })).total, 0);
  await writeFile(join(f.directory, `${first.checkpoint.id}.json`), '{bad');
  const unmatched = await library.list(0, 20, { rigSignature: 'missing' });
  assert.equal(unmatched.invalidRecordCount, 1, 'corrupt records cannot safely be classified by filters');
  await assert.rejects(library.list(0, 20, { rigId: '../outside' }));
});
