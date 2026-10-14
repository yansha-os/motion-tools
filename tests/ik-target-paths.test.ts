import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeIKTargetPath, IKTargetPathLibrary, ikTargetPathInputSchema, sampleIKTargetPath } from '../src/ik-target-paths.js';

test('IK target paths persist immutably, search by tags and verify their content fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-ik-paths-'));
  try {
    const library = new IKTargetPathLibrary(root);
    const saved = await library.save({
      name: 'Moving sword arc', description: 'Follow the held weapon through a swing', tags: ['combat', 'prop'],
      samples: [{ time: 0.2, position: [1, 2, 3] }, { time: 0.6, position: [2, 4, 3] }, { time: 1.1, position: [4, 3, 0] }],
    });
    const reopened = new IKTargetPathLibrary(root);
    assert.deepEqual((await reopened.get(saved.id)).path, saved.path);
    assert.equal((await reopened.get(saved.id)).fingerprint, saved.fingerprint);
    const listed = await reopened.list({ query: 'SWORD', tag: 'PROP' });
    assert.equal(listed.total, 1);
    assert.equal(listed.paths[0]!.sampleCount, 3);
    assert.match(listed.limitation, /same place\/world coordinate frame/i);

    const pathOnDisk = join(root, `${saved.id}.json`);
    const changed = JSON.parse(await readFile(pathOnDisk, 'utf8')) as { path: { samples: { position: number[] }[] } };
    changed.path.samples[1]!.position[0] = 99;
    await writeFile(pathOnDisk, JSON.stringify(changed));
    await assert.rejects(reopened.get(saved.id), /contents changed after save/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IK target-path schema rejects unordered points, duplicate tags and unsafe coordinate ranges', () => {
  const base = { name: 'Path', samples: [{ time: 0, position: [0, 0, 0] }, { time: 1, position: [1, 0, 0] }] };
  assert.equal(ikTargetPathInputSchema.parse(base).samples.length, 2);
  assert.throws(() => ikTargetPathInputSchema.parse({ ...base, samples: [...base.samples].reverse() }), /strictly increasing/i);
  assert.throws(() => ikTargetPathInputSchema.parse({ ...base, tags: ['prop', 'PROP'] }), /unique/i);
  assert.throws(() => ikTargetPathInputSchema.parse({ ...base, samples: [{ time: 0, position: [10001, 0, 0] }, base.samples[1]] }), /less than or equal to 10000/i);
});

test('target-path analysis measures motion and matches Studio centripetal interpolation', () => {
  const linear = analyzeIKTargetPath([
    { time: 0, position: [0, 0, 0] },
    { time: 1, position: [0, 2, 0] },
  ]);
  assert.equal(linear.interpolation, 'linear');
  assert.equal(linear.pathLengthStuds, 2);
  assert.equal(linear.averagePathSpeedStudsPerSecond, 2);
  assert.equal(linear.peakSampledSpeedStudsPerSecond, 2);
  assert.ok(linear.peakSampledAccelerationStudsPerSecondSquared < 1e-9);
  assert.equal(linear.maximumDeviationFromWaypointChordsStuds, 0);

  const curvedPath = [
    { time: 0, position: [0, 0, 0] },
    { time: 1, position: [1, 1, 0] },
    { time: 2, position: [2, 3, 0] },
    { time: 3, position: [3, 0, 0] },
  ];
  const midpoint = sampleIKTargetPath(curvedPath, 1.5, 'centripetal_catmull_rom');
  assert.ok(Math.abs(midpoint[0] - 1.5270089595073117) < 1e-9);
  assert.ok(Math.abs(midpoint[1] - 2.206534891917471) < 1e-9);
  const curved = analyzeIKTargetPath(curvedPath, 'centripetal_catmull_rom', 30);
  assert.ok(curved.pathLengthStuds > 0);
  assert.ok(curved.peakSampledSpeedStudsPerSecond > 0);
  assert.ok(curved.peakSampledAccelerationStudsPerSecondSquared > 0);
  assert.ok(curved.maximumDeviationFromWaypointChordsStuds > 0);
  assert.equal(curved.waypointSegments.length, curvedPath.length - 1);
  assert.ok(curved.maximumDeviationTime >= curved.startTime && curved.maximumDeviationTime <= curved.endTime);
  assert.ok(curved.maximumDeviationSegment);
  assert.ok(curved.waypointSegments.some(segment => segment.maximumDeviationFromChordStuds > 0 && segment.maximumDeviationTime >= segment.startTime && segment.maximumDeviationTime <= segment.endTime));
  assert.match(curved.limitation, /does not test limb reachability/i);
  assert.throws(() => analyzeIKTargetPath([{ time: 1, position: [0, 0, 0] }, { time: 1, position: [1, 0, 0] }]), /strictly increasing/i);
  assert.throws(() => analyzeIKTargetPath(curvedPath, 'unknown' as 'linear'), /Invalid enum value/i);
  assert.throws(() => analyzeIKTargetPath(curvedPath, 'linear', 29 as 30), /sampleRateHz must be 15, 30, or 60/i);
});
