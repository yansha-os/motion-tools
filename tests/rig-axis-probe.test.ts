import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleTimes } from '../src/inspection.js';
import { analyzeRigAxisProbe, createRigAxisProbeRecipe, suggestLocalRotationFromAxisProbe } from '../src/rig-axis-probe.js';
import { telemetrySchema } from '../src/inspection.js';

const rigId = '3d2d5c5d-31fa-42a7-b1cb-bcb527d2a8b4';
function telemetryForProbe() {
  const recipe = createRigAxisProbeRecipe('Joint', 5);
  const samples = sampleTimes(recipe).map((time, index) => {
    const degrees = recipe.tracks[0]!.keys.find(key => Math.abs(key.time - time) < 0.000001)?.rotation ?? [0, 0, 0];
    const radians = degrees.map(value => value * Math.PI / 180);
    const x = radians[0]!, y = radians[1]!, z = radians[2]!;
    const half = Math.hypot(x, y, z) / 2;
    const scale = half === 0 ? 0 : Math.sin(half) / Math.hypot(x, y, z);
    const q: [number, number, number, number] = half === 0 ? [0, 0, 0, 1] : [x * scale, y * scale, z * scale, Math.cos(half)];
    const [qx, qy, qz, qw] = q;
    const rotatedPoint: [number, number, number] = [1 - 2 * (qy * qy + qz * qz) + 2 * (qx * qy - qz * qw) + 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw) + 1 - 2 * (qx * qx + qz * qz) + 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw) + 2 * (qy * qz + qx * qw) + 1 - 2 * (qx * qx + qy * qy)];
    return { id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 0, 0], rotatedPoint], jointPoints: [[0, 0, 0], rotatedPoint],
      bottoms: [0, 0], orientations: [q, [0, 0, 0, 1]] };
  });
  return telemetrySchema.parse({ version: 1, source: 'studio_pose_evaluator', rigId, rigSignature: 'fixture-rig', assetId: 'f135c9a5-84cf-4c94-b755-f7c1eeea171c',
    duration: recipe.duration, loop: false, height: 2, groundSource: 'rest_node_bounds', note: 'fixture',
    nodes: [{ name: 'Joint', parent: 0, driven: true, foot: false }, { name: 'Hand', parent: 1, driven: true, foot: false }],
    restPose: { points: [[0, 0, 0], [1, 1, 1]], orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] }, samples });
}

test('axis probe recipe is a bounded disposable six-pulse clip with exact neutral separators', () => {
  const recipe = createRigAxisProbeRecipe('RightHand', 7);
  assert.equal(recipe.duration, 1.2);
  assert.equal(recipe.tracks[0]!.keys.length, 13);
  const times = sampleTimes(recipe);
  assert.ok(times.length <= 128);
  for (const key of recipe.tracks[0]!.keys) assert.ok(times.some(time => Math.abs(time - key.time) < 0.000001));
  assert.deepEqual(recipe.tracks[0]!.keys.map(key => key.rotation), [
    [0, 0, 0], [7, 0, 0], [0, 0, 0], [-7, 0, 0], [0, 0, 0], [0, 7, 0], [0, 0, 0], [0, -7, 0], [0, 0, 0], [0, 0, 7], [0, 0, 0], [0, 0, -7], [0, 0, 0],
  ]);
  assert.throws(() => createRigAxisProbeRecipe('RightHand', 16), /between 1 and 15/);
});

test('axis probe reports measured local-axis responses and descendant pivot motion', () => {
  const telemetry = telemetryForProbe();
  const result = analyzeRigAxisProbe(telemetry, 'Joint', 5);
  assert.equal(result.status, 'measured');
  assert.equal(result.rigSignature, 'fixture-rig');
  assert.equal(result.sampleCount, sampleTimes(createRigAxisProbeRecipe('Joint', 5)).length);
  assert.deepEqual(result.axes.map(axis => axis.inputAxis), ['x', 'y', 'z']);
  assert.equal(result.localRotationResponseJacobian.length, 3);
  assert.equal(result.calibrationStatus, 'locally_consistent');
  for (const [rowIndex, row] of result.localRotationResponseJacobian.entries()) {
    for (const [columnIndex, value] of row.entries()) assert.ok(Math.abs(value - (rowIndex === columnIndex ? 1 : 0)) < 0.001);
  }
  for (const axis of result.axes) {
    assert.equal(axis.responseDiagnostics.status, 'usable_local_response');
    assert.ok(axis.responseDiagnostics.oddSymmetryErrorRatio < 0.001);
    assert.ok(Math.abs(axis.positive.measuredWorldRotationInRigPivot.angleDegrees - 5) < 0.001);
    assert.ok(Math.abs(axis.negative.measuredWorldRotationInRigPivot.angleDegrees - 5) < 0.001);
    assert.equal(axis.positive.mostMovedDescendants[0]?.joint, 'Hand');
    assert.notDeepEqual(axis.positive.mostMovedDescendants[0]?.displacementVectorStuds, [0, 0, 0]);
    assert.ok(axis.positive.maximumDescendantDisplacementStuds > 0);
    assert.ok(Math.abs(axis.positive.measuredRelativeRotationInJointFrame.angleDegrees - 5) < 0.001);
    assert.equal(axis.mostResponsiveDescendants[0]?.joint, 'Hand');
    assert.ok(axis.mostResponsiveDescendants[0]!.displacementResponseStudsPerInputDegree.every(Number.isFinite));
  }
  assert.match(result.limitations.join(' '), /No pose was saved or applied/);

  // The evaluator's zero-input recipe pose, not the source rig's rest pose, is
  // the correct frame for interpreting pulses on a detached clone.
  const posedSourceRest = telemetrySchema.parse({ ...telemetry, restPose: { ...telemetry.restPose,
    orientations: [[0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)], [0, 0, 0, 1]],
  } });
  const posedResult = analyzeRigAxisProbe(posedSourceRest, 'Joint', 5);
  for (const [rowIndex, row] of posedResult.localRotationResponseJacobian.entries()) {
    for (const [columnIndex, value] of row.entries()) assert.ok(Math.abs(value - (rowIndex === columnIndex ? 1 : 0)) < 0.001);
  }
  assert.ok(Math.abs(posedResult.axes[0]!.positive.measuredRelativeRotationInJointFrame.angleDegrees - 5) < 0.001);
});

test('axis probe labels unresponsive and asymmetric evidence instead of treating it as a calibration', () => {
  const telemetry = telemetryForProbe();
  const unresponsive = telemetrySchema.parse({ ...telemetry, samples: telemetry.samples.map(sample => ({ ...sample,
    orientations: [[0, 0, 0, 1], [0, 0, 0, 1]], jointPoints: [[0, 0, 0], [1, 1, 1]],
  })) });
  const noSignal = analyzeRigAxisProbe(unresponsive, 'Joint', 5);
  assert.equal(noSignal.calibrationStatus, 'no_measurable_rotation_response');
  assert.ok(noSignal.axes.every(axis => axis.responseDiagnostics.status === 'unresponsive'));

  const asymmetricTelemetry = telemetrySchema.parse({ ...telemetry, samples: telemetry.samples.map(sample =>
    [0.3, 0.7, 1.1].some(time => Math.abs(sample.time - time) < 0.000001)
      ? { ...sample, orientations: [[0, 0, 0, 1], sample.orientations![1]] } : sample) });
  const asymmetric = analyzeRigAxisProbe(asymmetricTelemetry, 'Joint', 5);
  assert.equal(asymmetric.calibrationStatus, 'review_required');
  assert.ok(asymmetric.axes.every(axis => axis.responseDiagnostics.status === 'asymmetric_or_coupled'));
  assert.ok(asymmetric.axes.every(axis => axis.responseDiagnostics.oddSymmetryErrorRatio > 0.9));
});

test('local rotation suggestion solves a small vector and rejects unsafe calibration or extrapolation', () => {
  const probe = analyzeRigAxisProbe(telemetryForProbe(), 'Joint', 5);
  const suggestion = suggestLocalRotationFromAxisProbe(probe, [2, -3, 4]);
  assert.equal(suggestion.status, 'suggestion_only');
  assert.deepEqual(suggestion.localEulerRotationDegrees, [2, -3, 4]);
  assert.ok(suggestion.residualDegrees < 0.001);
  assert.equal(suggestion.rigSignature, 'fixture-rig');
  assert.throws(() => suggestLocalRotationFromAxisProbe({ ...probe, calibrationStatus: 'review_required' }, [1, 0, 0]), /requires a locally consistent/);
  assert.throws(() => suggestLocalRotationFromAxisProbe({ ...probe, localRotationResponseJacobian: [[1, 0, 0], [0, 1, 0], [0, 0, 0]] }, [1, 0, 0]), /rank-deficient/);
  assert.throws(() => suggestLocalRotationFromAxisProbe({ ...probe, localRotationResponseJacobian: [[1, 0, 0], [0, 1, 0], [0, 0, 0.001]] }, [1, 0, 0]), /ill-conditioned/);
  assert.throws(() => suggestLocalRotationFromAxisProbe(probe, [16, 0, 0]), /no greater than 15 degrees/);
  assert.throws(() => suggestLocalRotationFromAxisProbe({ ...probe, localRotationResponseJacobian: [[0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]] }, [10, 0, 0]), /extrapolating beyond/);
});

test('axis probe fails closed when exact driven-joint evidence is absent or incomplete', () => {
  const telemetry = telemetryForProbe();
  assert.throws(() => analyzeRigAxisProbe(telemetry, 'Missing', 5), /not an exact driven joint/);
  const withoutJointPoints = telemetrySchema.parse({ ...telemetry, samples: telemetry.samples.map(({ jointPoints: _jointPoints, ...sample }) => sample) });
  assert.throws(() => analyzeRigAxisProbe(withoutJointPoints, 'Joint', 5), /zero-input baseline orientations and joint-pivot positions/);
  assert.throws(() => analyzeRigAxisProbe(telemetry, 'Joint', 0.5), /between 1 and 15/);
});
