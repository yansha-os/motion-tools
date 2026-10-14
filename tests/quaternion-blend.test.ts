import assert from 'node:assert/strict';
import test from 'node:test';
import { quaternionAngularDistanceDegrees, quaternionAngularVelocityDegrees, transportVectorBetweenQuaternionFrames,
  weightedQuaternionMean, type Quaternion4, type WeightedQuaternion } from '../src/quaternion-blend.js';

function orientationDistance(left: Quaternion4, right: Quaternion4): number {
  const dot = Math.min(1, Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0)));
  return 2 * Math.acos(dot);
}

test('weighted quaternion mean handles empty, zero-weight, and equivalent antipodal inputs', () => {
  assert.deepEqual(weightedQuaternionMean([]), { rotation: [0, 0, 0, 1], confidence: 1 });
  assert.deepEqual(weightedQuaternionMean([{ rotation: [0, 0, 0, 1], weight: 0 }]), { rotation: [0, 0, 0, 1], confidence: 1 });
  const expected = weightedQuaternionMean([{ rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], weight: 1 }]);
  const antipodal = weightedQuaternionMean([
    { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], weight: 0.35 },
    { rotation: [0, -Math.SQRT1_2, 0, -Math.SQRT1_2], weight: 0.65 },
  ]);
  assert.ok(orientationDistance(expected.rotation, antipodal.rotation) < 1e-7);
  assert.equal(antipodal.confidence, 1);
});

test('weighted quaternion mean is invariant to extreme nonzero quaternion magnitudes', () => {
  const rotation: Quaternion4 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const expected = weightedQuaternionMean([{ rotation, weight: 1 }]);
  for (const scale of [Number.MIN_VALUE, 1e-300, 1e-200, 1e200, 1e300, 1e308]) {
    const scaled = weightedQuaternionMean([{ rotation: rotation.map(value => value * scale) as Quaternion4, weight: 1 }]);
    assert.ok(orientationDistance(expected.rotation, scaled.rotation) < 1e-7,
      `quaternion scale ${scale} must not change the represented orientation`);
    assert.ok(Math.abs(expected.confidence - scaled.confidence) < 1e-12,
      `quaternion scale ${scale} must not change blend confidence`);
  }
  const overflowLength = weightedQuaternionMean([{ rotation: [1e308, 1e308, 0, 0], weight: 1 }]);
  assert.ok(Math.abs(Math.hypot(...overflowLength.rotation) - 1) < 1e-12,
    'finite components whose unscaled magnitude exceeds Number.MAX_VALUE must still normalize');
  assert.ok(orientationDistance(overflowLength.rotation, [Math.SQRT1_2, Math.SQRT1_2, 0, 0]) < 1e-7);
});

test('weighted quaternion mean is stable under input permutation, quaternion sign, and weight scale', () => {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  for (let trial = 0; trial < 256; trial++) {
    const count = 2 + Math.floor(random() * 7);
    const samples: WeightedQuaternion[] = Array.from({ length: count }, () => {
      const raw = Array.from({ length: 4 }, () => random() * 2 - 1);
      const magnitude = Math.hypot(...raw);
      return { rotation: raw.map(value => value / magnitude) as Quaternion4, weight: 0.01 + random() * 5 };
    });
    const mean = weightedQuaternionMean(samples);
    const scale = trial % 2 === 0 ? 1e-200 : 1e200;
    const permuted = weightedQuaternionMean([...samples].reverse().map((sample, index) => ({
      rotation: (index % 2 === 0 ? sample.rotation : sample.rotation.map(value => -value)) as Quaternion4,
      weight: sample.weight * scale,
    })));
    assert.ok(Math.abs(Math.hypot(...mean.rotation) - 1) < 1e-12, `trial ${trial}: mean quaternion must be normalized`);
    assert.ok(mean.confidence >= 0 && mean.confidence <= 1, `trial ${trial}: confidence must be bounded`);
    assert.ok(orientationDistance(mean.rotation, permuted.rotation) < 1e-6, `trial ${trial}: equivalent input sets must yield the same orientation`);
    assert.ok(Math.abs(mean.confidence - permuted.confidence) < 1e-10, `trial ${trial}: confidence must be permutation/scale invariant`);
  }
});

test('weighted quaternion mean rejects invalid weights and malformed orientations', () => {
  assert.throws(() => weightedQuaternionMean([{ rotation: [0, 0, 0, 1], weight: -1 }]), /finite and nonnegative/);
  assert.throws(() => weightedQuaternionMean([{ rotation: [0, 0, 0, 1], weight: Number.NaN }]), /finite and nonnegative/);
  assert.throws(() => weightedQuaternionMean([{ rotation: [0, 0, 0, 0], weight: 1 }]), /nonzero magnitude/);
  assert.throws(() => weightedQuaternionMean([{ rotation: [0, 0, Number.POSITIVE_INFINITY, 1], weight: 1 }]), /components must be finite/);
});

test('quaternion angular distance normalizes accepted noisy magnitudes before measuring orientation', () => {
  const orientation: Quaternion4 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const sameOrientation = orientation.map(component => component * 1.0005) as Quaternion4;
  assert.ok(quaternionAngularDistanceDegrees(orientation, sameOrientation) < 1e-4,
    'magnitude noise must not be misreported as angular error');
  const differentOrientation = [0, -Math.SQRT1_2, 0, Math.SQRT1_2] as Quaternion4;
  assert.ok(Math.abs(quaternionAngularDistanceDegrees(orientation, differentOrientation) - 180) < 1e-6);
  assert.throws(() => quaternionAngularDistanceDegrees([0, 0, 0, 0], orientation), /nonzero magnitude/);
});

test('quaternion angular velocity preserves axis direction across shortest-arc intervals', () => {
  const identity: Quaternion4 = [0, 0, 0, 1];
  const quarterTurnX: Quaternion4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const quarterTurnXThenY: Quaternion4 = [0.5, 0.5, 0.5, 0.5];
  const first = quaternionAngularVelocityDegrees(identity, quarterTurnX, 1);
  const second = quaternionAngularVelocityDegrees(quarterTurnX, quarterTurnXThenY, 1);
  assert.ok(Math.abs(first[0] - 90) < 1e-8 && Math.abs(first[1]) < 1e-8 && Math.abs(first[2]) < 1e-8);
  assert.ok(Math.abs(second[0]) < 1e-8 && Math.abs(second[1] - 90) < 1e-8 && Math.abs(second[2]) < 1e-8);
  assert.ok(Math.abs(Math.hypot(...first) - Math.hypot(...second)) < 1e-8,
    'both intervals must have equal angular speed so scalar speed-change diagnostics would miss the axis change');
  assert.ok(Math.abs(Math.hypot(...first.map((value, axis) => value - second[axis]!)) - 90 * Math.SQRT2) < 1e-8,
    'vector acceleration evidence must retain the direction change');
  assert.deepEqual(quaternionAngularVelocityDegrees(identity, identity, 0.5), [0, 0, 0]);
  assert.throws(() => quaternionAngularVelocityDegrees(identity, quarterTurnX, 0), /must be positive and finite/);
});

test('quaternion frame transport preserves world-space direction across changing joint frames', () => {
  const identity: Quaternion4 = [0, 0, 0, 1];
  const quarterTurnX: Quaternion4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const inNewFrame = transportVectorBetweenQuaternionFrames([0, 1, 0], identity, quarterTurnX);
  assert.ok(Math.abs(inNewFrame[0]) < 1e-8 && Math.abs(inNewFrame[1]) < 1e-8 && Math.abs(inNewFrame[2] + 1) < 1e-8);
  const backInOldFrame = transportVectorBetweenQuaternionFrames(inNewFrame, quarterTurnX, identity);
  assert.ok(Math.abs(backInOldFrame[0]) < 1e-8 && Math.abs(backInOldFrame[1] - 1) < 1e-8 && Math.abs(backInOldFrame[2]) < 1e-8);
});
