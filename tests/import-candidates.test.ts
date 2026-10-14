import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportCandidateStore, type PersistedImportCandidate } from '../src/import-candidates.js';

function fixture(expiresAt: number): PersistedImportCandidate {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const rigId = '22222222-2222-4222-8222-222222222222';
  return { expiresAt, jobId: '33333333-3333-4333-8333-333333333333', sessionId, rigId,
    recipe: { kind: 'animation', name: 'Recovered import', duration: 1, loop: false, markers: [], contacts: [], tracks: [
      { joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
    ] },
    sourceRigProfile: { version: 1, rigId, rigName: 'Recovery rig', rigType: 'R15', rigSignature: 'recovery-rig-v1',
      joints: [{ name: 'UpperTorso', parent: '', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 }] },
    sourceIdentity: { kind: 'anim_saves', sequenceName: 'Idle', sequenceLocator: '1.2' }, sourceType: 'KeyframeSequence',
    unmapped: [], diagnostics: { conversionMode: 'keyframe_sequence_pose_tracks', fidelity: 'source_keyframes_preserved', warnings: [] },
    exportPreflightJobId: '44444444-4444-4444-8444-444444444444',
    exportEvidence: { frameCount: 2, poseCount: 2, markerCount: 0, animatedTrackCount: 1 } };
}

test('reviewed import candidates and export evidence survive server restart with expiry and integrity checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-import-candidate-store-'));
  const path = join(directory, 'import-candidates.json');
  try {
    let now = 1000;
    const store = new ImportCandidateStore(path, () => now);
    const candidateFingerprint = 'a'.repeat(64);
    const candidate = fixture(5000);
    store.set(candidateFingerprint, candidate);
    candidate.recipe.name = 'Mutated caller copy';
    const reloaded = new ImportCandidateStore(path, () => now);
    const restored = reloaded.get(candidateFingerprint);
    assert.ok(restored);
    assert.equal(restored.recipe.name, 'Recovered import', 'the store copies candidate data on write');
    assert.equal(restored.sourceIdentity.kind, 'anim_saves');
    assert.equal(restored.exportEvidence?.frameCount, 2);

    now = 5000;
    assert.equal(new ImportCandidateStore(path, () => now).get(candidateFingerprint), undefined, 'expired candidates are not recovered');

    const tamperedFingerprint = 'b'.repeat(64);
    new ImportCandidateStore(path, () => now).set(tamperedFingerprint, fixture(10000));
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { entries: { candidate: { recipe: { name: string } } }[] };
    persisted.entries[0]!.candidate.recipe.name = 'tampered without updating integrity';
    await writeFile(path, JSON.stringify(persisted));
    assert.throws(() => new ImportCandidateStore(path, () => now), /failed its integrity check/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
