import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { AnimationGraphFadeCalibrationLibrary, assessAnimationGraphFadeCalibration, studioBuildIdentitySchema } from '../src/animation-graph-fade-calibrations.js';

const hash = 'a'.repeat(64);
const validDraft = {
  graphId: '00000000-0000-4000-8000-000000000001', graphFingerprint: hash,
  rigId: '00000000-0000-4000-8000-000000000002', rigSignature: 'fixture-rig-topology', stateId: 'idle',
  recipeFingerprint: hash, jointMapFingerprint: hash, fadeSeconds: 0.2, sampleRateHz: 10,
  playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
  stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }],
  limitation: 'Measured on a detached Studio rig clone.',
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

test('graph fade calibrations persist immutably, filter by graph/rig, and verify fingerprints on read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-graph-fade-calibrations-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  const saved = await library.record(validDraft);
  assert.deepEqual(saved.studioBuildIdentity, { status: 'unavailable', value: null, source: 'unavailable' },
    'new profiles must encode missing Studio-build provenance explicitly instead of omitting or guessing it');
  const buildBound = await library.record({ ...validDraft, graphId: '00000000-0000-4000-8000-000000000099', playRetrigger: {
    probeElapsedSeconds: 0.05, timePositionBefore: 0.05, timePositionImmediatelyAfter: 0.05, timePositionAfterStep: 0.1,
    weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1, weightTargetImmediatelyAfter: 1, observedClockBehavior: 'preserved' as const,
  }, studioBuildIdentity: {
    status: 'captured', value: 'studio-build-fixture', source: 'roblox_version_global_deprecated' } });
  assert.equal(buildBound.schemaVersion, 2);
  assert.deepEqual((await library.get(buildBound.id)).studioBuildIdentity, buildBound.studioBuildIdentity,
    'captured engine identity must survive persistence and integrity verification');
  assert.deepEqual((await library.get(buildBound.id)).playRetrigger, buildBound.playRetrigger,
    'the empirical repeated-Play clock and weight observation must survive integrity verification');
  const naturalCompletionBound = await library.record({ ...validDraft, graphId: '00000000-0000-4000-8000-000000000098',
    playRetrigger: buildBound.playRetrigger,
    naturalCompletion: { authoredDurationSeconds: 1, animationLengthSeconds: 1, playbackSpeed: 1,
      endedAfterStoppedSeconds: 0.2, samples: [
        { at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.5, weightTarget: 0 },
        { at: 0.2, weightCurrent: 0, weightTarget: 0 },
      ] },
  });
  assert.equal(naturalCompletionBound.schemaVersion, 3);
  assert.deepEqual((await library.get(naturalCompletionBound.id)).naturalCompletion, naturalCompletionBound.naturalCompletion,
    'natural-completion curve, measured length, speed and Ended delay must survive immutable persistence');
  assert.equal(assessAnimationGraphFadeCalibration(naturalCompletionBound).naturalCompletion?.coverage, 1);
  await assert.rejects(() => library.record({ ...validDraft, graphId: '00000000-0000-4000-8000-000000000095',
    playRetrigger: buildBound.playRetrigger,
    naturalCompletion: { ...naturalCompletionBound.naturalCompletion!, animationLengthSeconds: 0 },
  }), /greater than 0|> 0/i,
  'zero AnimationTrack.Length means Roblox has not finished loading the asset and cannot be persisted as measured playback duration');
  const adjustWeightBound = await library.record({ ...validDraft, graphId: '00000000-0000-4000-8000-000000000097',
    playRetrigger: buildBound.playRetrigger, naturalCompletion: naturalCompletionBound.naturalCompletion,
    adjustWeightIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.3, weightTarget: 1 },
      { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
    adjustWeightOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.7, weightTarget: 0 },
      { at: 0.2, weightCurrent: 0, weightTarget: 0 }],
  });
  assert.equal(adjustWeightBound.schemaVersion, 4);
  assert.deepEqual((await library.get(adjustWeightBound.id)).adjustWeightIn, adjustWeightBound.adjustWeightIn,
    'native AdjustWeight entry curves must persist under the immutable profile fingerprint');
  assert.deepEqual((await library.get(adjustWeightBound.id)).adjustWeightOut, adjustWeightBound.adjustWeightOut,
    'native AdjustWeight exit curves must persist under the immutable profile fingerprint');
  assert.equal(assessAnimationGraphFadeCalibration(adjustWeightBound).adjustWeightIn?.coverage, 1);
  await assert.rejects(() => library.record({ ...validDraft, graphId: '00000000-0000-4000-8000-000000000096',
    playRetrigger: buildBound.playRetrigger, naturalCompletion: naturalCompletionBound.naturalCompletion,
    adjustWeightIn: [{ at: 0, weightCurrent: 0, weightTarget: 0.5 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
    adjustWeightOut: validDraft.stopOut,
  }), /AdjustWeight curve must have ordered times and verified start\/end evidence/i);
  const recreated = new AnimationGraphFadeCalibrationLibrary(directory);
  assert.deepEqual(await recreated.get(saved.id), saved, 'calibration should be readable after library recreation');
  assert.deepEqual((await recreated.list({ graphId: validDraft.graphId })).map(profile => profile.id), [saved.id]);
  assert.deepEqual(await recreated.list({ rigId: '00000000-0000-4000-8000-000000000099' }), []);
  const path = join(directory, `${saved.id}.json`);
  const tampered = JSON.parse(await readFile(path, 'utf8')) as { playIn: { weightCurrent: number }[] };
  tampered.playIn[1]!.weightCurrent = 0.6;
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(recreated.get(saved.id), /fingerprint does not match/i);
});

test('fade calibration build identity rejects internally inconsistent provenance', async () => {
  assert.throws(() => studioBuildIdentitySchema.parse({ status: 'captured', value: null,
    source: 'roblox_version_global_deprecated' }), /expected string/i);
  assert.throws(() => studioBuildIdentitySchema.parse({ status: 'unavailable', value: 'invented-build',
    source: 'unavailable' }), /expected null/i);
});

test('fade calibration Play-retrigger probe rejects behavior labels inconsistent with observed TimePosition', async () => {
  const library = new AnimationGraphFadeCalibrationLibrary(await mkdtemp(join(tmpdir(), 'motion-retrigger-probe-')));
  await assert.rejects(() => library.record({ ...validDraft, playRetrigger: {
    probeElapsedSeconds: 0.05, timePositionBefore: 0.05, timePositionImmediatelyAfter: 0,
    timePositionAfterStep: 0.01, weightCurrentBefore: 1, weightCurrentImmediatelyAfter: 1,
    weightTargetImmediatelyAfter: 1, observedClockBehavior: 'preserved',
  } }), /must agree with the immediate pre\/post Play time-position samples/i);
});

test('pre-build-identity calibration records remain fingerprint-valid and explicitly legacy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-legacy-fade-build-identity-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  const current = await library.record(validDraft);
  const legacyPath = join(directory, `${current.id}.json`);
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as Record<string, unknown>;
  delete legacy.studioBuildIdentity;
  delete legacy.profileFingerprint;
  legacy.profileFingerprint = createHash('sha256').update(canonical(legacy)).digest('hex');
  await writeFile(legacyPath, JSON.stringify(legacy));

  const loaded = await library.get(current.id);
  assert.equal(loaded.id, current.id);
  assert.equal(loaded.studioBuildIdentity, undefined,
    'legacy data must stay distinguishable from new profiles that explicitly recorded identity unavailable');
});

test('fade calibration listings isolate malformed records and retain healthy profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-corrupt-graph-fade-calibrations-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  const healthy = await library.record(validDraft);
  const damagedId = randomUUID();
  await writeFile(join(directory, `${damagedId}.json`), '{not valid json');

  const listing = await library.listDetailed({ graphId: validDraft.graphId });
  assert.deepEqual(listing.profiles.map(profile => profile.id), [healthy.id]);
  assert.equal(listing.invalidRecordCount, 1);
  assert.equal(listing.invalidRecords[0]?.id, damagedId);
  assert.equal(listing.invalidRecords[0]?.error, 'malformed_json');
  assert.equal(JSON.stringify(listing.invalidRecords).includes('{not valid json'), false,
    'corruption diagnostics must not echo malformed file contents');
  assert.equal(listing.invalidRecordsTruncated, false);
  assert.deepEqual(await library.list({ graphId: validDraft.graphId }), [healthy],
    'the compatibility list API should remain usable when one unrelated profile is damaged');
});

test('fade calibration listing keeps only the newest page and bounded corruption diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-bounded-graph-fade-calibrations-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  for (let index = 0; index < 4; index++) await library.record({ ...validDraft, rigSignature: `rig-${index}` });
  const damagedIds = Array.from({ length: 4 }, () => randomUUID()).sort();
  for (const id of damagedIds) await writeFile(join(directory, `${id}.json`), '{invalid');

  const full = await library.listDetailed({ limit: 10 });
  const page = await library.listDetailed({ limit: 2 });
  assert.deepEqual(page.profiles, full.profiles.slice(0, 2));
  assert.equal(page.profilesTruncated, true);
  assert.equal(page.invalidRecordCount, 4);
  assert.deepEqual(page.invalidRecords.map(record => record.id), damagedIds.slice(0, 2));
  assert.equal(page.invalidRecordsTruncated, true);
});

test('exact graph-and-rig listings migrate to the catalog and backfill around a damaged newest profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-indexed-graph-fade-calibrations-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  for (let index = 0; index < 3; index++) await library.record({ ...validDraft, rigSignature: `catalog-rig-${index}` });

  const migrated = await library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId, limit: 3 });
  assert.equal(migrated.profiles.length, 3);
  assert.equal(migrated.invalidRecordScanComplete, true);
  const newest = migrated.profiles[0]!;
  const tampered = JSON.parse(await readFile(join(directory, `${newest.id}.json`), 'utf8')) as Record<string, unknown>;
  tampered.limitation = 'tampered after catalog creation';
  await writeFile(join(directory, `${newest.id}.json`), JSON.stringify(tampered));

  const indexed = await library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId, limit: 1 });
  assert.deepEqual(indexed.profiles.map(profile => profile.id), [migrated.profiles[1]!.id]);
  assert.equal(indexed.profilesTruncated, true);
  assert.equal(indexed.invalidRecordCount, 1);
  assert.deepEqual(indexed.invalidRecords, [{ id: newest.id, error: 'schema_or_fingerprint_validation_failed' }]);
  assert.equal(indexed.invalidRecordScanComplete, false,
    'catalog pages validate returned profile contents but do not claim a full scan of older profile files');
  const recovered = await library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId, limit: 3 });
  assert.equal(recovered.invalidRecordScanComplete, true,
    'a damaged indexed profile invalidates the ready marker so the next request performs a complete archive scan');
  assert.equal(recovered.invalidRecordCount, 1);
  assert.equal(recovered.invalidRecords[0]?.id, newest.id);
});

test('corrupt catalog metadata invalidates the ready marker and is repaired from verified profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-repair-fade-catalog-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  const profile = await library.record(validDraft);
  await library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId });
  const sortableTime = profile.createdAt.replace(/[-:.]/g, '');
  const indexPath = join(directory, 'catalog', profile.graphId, profile.rigId, `${sortableTime}_${profile.id}.json`);
  await writeFile(indexPath, '{broken catalog entry');

  const damagedIndex = await library.listDetailed({ graphId: profile.graphId, rigId: profile.rigId });
  assert.equal(damagedIndex.invalidRecords[0]?.error, 'malformed_json');
  assert.equal(damagedIndex.invalidRecordScanComplete, false);
  const rebuilt = await library.listDetailed({ graphId: profile.graphId, rigId: profile.rigId });
  assert.deepEqual(rebuilt.profiles.map(item => item.id), [profile.id]);
  assert.equal(rebuilt.invalidRecordCount, 0);
  assert.equal(rebuilt.invalidRecordScanComplete, true);
});

test('simultaneous catalog migrations and profile writes converge without losing indexed profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-concurrent-fade-catalog-'));
  const library = new AnimationGraphFadeCalibrationLibrary(directory);
  const initial = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    library.record({ ...validDraft, rigSignature: `initial-${index}` })));

  await Promise.all([
    ...Array.from({ length: 5 }, () => library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId, limit: 100 })),
    ...Array.from({ length: 8 }, (_, index) =>
      library.record({ ...validDraft, rigSignature: `concurrent-${index}` })),
  ]);

  const final = await library.listDetailed({ graphId: validDraft.graphId, rigId: validDraft.rigId, limit: 100 });
  assert.equal(final.invalidRecordScanComplete, false,
    'the converged catalog provides exact matches without claiming a full corruption scan');
  assert.equal(final.profilesTruncated, false);
  assert.equal(final.profiles.length, 14);
  assert.equal(new Set(final.profiles.map(profile => profile.id)).size, final.profiles.length);
  for (const profile of initial) assert.ok(final.profiles.some(item => item.id === profile.id));
});

test('calibration catalog filters reject path-like identifiers before filesystem access', async () => {
  const library = new AnimationGraphFadeCalibrationLibrary(await mkdtemp(join(tmpdir(), 'motion-invalid-fade-filter-')));
  await assert.rejects(library.listDetailed({ graphId: '../outside', rigId: validDraft.rigId }), /Invalid uuid/i);
  await assert.rejects(library.listDetailed({ graphId: validDraft.graphId, rigId: '../outside' }), /Invalid uuid/i);
});

test('graph fade calibration rejects unordered or endpoint-incomplete curves', async () => {
  const library = new AnimationGraphFadeCalibrationLibrary(await mkdtemp(join(tmpdir(), 'motion-invalid-fade-calibrations-')));
  await assert.rejects(library.record({ ...validDraft,
    playIn: [{ at: 0.2, weightCurrent: 1, weightTarget: 1 }, { at: 0, weightCurrent: 0, weightTarget: 1 }],
  }), /ordered times and verified expected endpoints/i);
});

test('fade calibration quality review detects sparse, unstable and reversed measurements without rejecting them', () => {
  const clean = assessAnimationGraphFadeCalibration({ ...validDraft, fadeSeconds: 0.2, sampleRateHz: 10,
    playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.45, weightTarget: 1 }, { at: 0.2, weightCurrent: 1, weightTarget: 1 }],
    stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.1, weightCurrent: 0.55, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }] });
  assert.equal(clean.status, 'clean');
  assert.equal(clean.playIn.coverage, 1);
  assert.equal(clean.playIn.reversalCount, 0);

  const review = assessAnimationGraphFadeCalibration({ ...validDraft,
    playIn: [{ at: 0, weightCurrent: 0, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.8, weightTarget: 0.9 },
      { at: 0.2, weightCurrent: 0.7, weightTarget: 1 }],
    stopOut: [{ at: 0, weightCurrent: 1, weightTarget: 0 }, { at: 0.2, weightCurrent: 0, weightTarget: 0 }] });
  assert.equal(review.status, 'review');
  assert.deepEqual(review.playIn.warnings, ['weight_target_changed_during_fade', 'weight_current_reversed_direction', 'incomplete_endpoint_weight']);
  assert.deepEqual(review.stopOut.warnings, ['sample_coverage_below_requested_rate', 'large_sample_time_gap']);
  assert.ok(Math.abs(review.playIn.maximumReversal - 0.1) < 1e-12);
});

test('fade calibration quality review catches incorrect starting weights and truncated captures', () => {
  const review = assessAnimationGraphFadeCalibration({ ...validDraft,
    playIn: [{ at: 0, weightCurrent: 0.2, weightTarget: 1 }, { at: 0.1, weightCurrent: 0.55, weightTarget: 1 }],
    stopOut: [{ at: 0.02, weightCurrent: 0.85, weightTarget: 0 }, { at: 0.18, weightCurrent: 0.2, weightTarget: 0 }],
  });
  assert.equal(review.status, 'review');
  assert.ok(review.playIn.warnings.includes('unexpected_start_weight'));
  assert.ok(review.playIn.warnings.includes('incomplete_endpoint_weight'));
  assert.ok(review.playIn.warnings.includes('incomplete_fade_time_span'));
  assert.equal(review.playIn.startWeightError, 0.2);
  assert.equal(review.playIn.endWeightError, 0.44999999999999996);
  assert.ok(review.stopOut.warnings.includes('unexpected_start_weight'));
  assert.ok(review.stopOut.warnings.includes('incomplete_endpoint_weight'));
  assert.ok(review.stopOut.warnings.includes('incomplete_fade_time_span'));
});
