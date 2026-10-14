import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleAnimationGraphBlendSpace1D } from '../src/animation-graph-blend-space.js';

const sample = (value: number, suffix: string) => ({ value, stateId: `clip${suffix}` });

test('BlendSpace1D interpolates only adjacent clips with normalized deterministic weights', () => {
  const blendSpace = { parameter: 'speed', samples: [sample(0, '1'), sample(4, '2'), sample(10, '3')] };
  const result = sampleAnimationGraphBlendSpace1D(blendSpace, 2);
  assert.equal(result.parameter, 'speed');
  assert.equal(result.parameterValue, 2);
  assert.equal(result.sampledValue, 2);
  assert.equal(result.clamped, false);
  assert.equal(result.lowerSample, sample(0, '1').stateId);
  assert.equal(result.upperSample, sample(4, '2').stateId);
  assert.deepEqual(result.weights.map(({ weight }) => weight), [0.5, 0.5, 0]);
  assert.equal(result.totalWeight, 1);
  assert.equal(result.method, 'adjacent_linear_interpolation');
});

test('BlendSpace1D selects exact samples and clamps values beyond the authored range', () => {
  const blendSpace = { parameter: 'speed', samples: [sample(-2, '1'), sample(0, '2'), sample(3, '3')] };
  const exact = sampleAnimationGraphBlendSpace1D(blendSpace, 0);
  assert.deepEqual(exact.weights.map(({ weight }) => weight), [0, 1, 0]);
  assert.equal(exact.lowerSample, sample(0, '2').stateId);
  assert.equal(exact.upperSample, sample(0, '2').stateId);

  const below = sampleAnimationGraphBlendSpace1D(blendSpace, -9);
  assert.equal(below.sampledValue, -2);
  assert.equal(below.clamped, true);
  assert.deepEqual(below.weights.map(({ weight }) => weight), [1, 0, 0]);

  const above = sampleAnimationGraphBlendSpace1D(blendSpace, 9);
  assert.equal(above.sampledValue, 3);
  assert.equal(above.clamped, true);
  assert.deepEqual(above.weights.map(({ weight }) => weight), [0, 0, 1]);
});

test('BlendSpace1D rejects unordered, duplicate, malformed, and non-finite inputs', () => {
  const first = sample(0, '1');
  const second = sample(1, '2');
  assert.throws(() => sampleAnimationGraphBlendSpace1D({ parameter: 'speed', samples: [second, first] }, 0.5), /strictly increasing/i);
  assert.throws(() => sampleAnimationGraphBlendSpace1D({ parameter: 'speed', samples: [first, first] }, 0.5), /strictly increasing/i);
  assert.throws(() => sampleAnimationGraphBlendSpace1D({ parameter: 'speed', samples: [first] }, 0.5), /at least 2/i);
  assert.throws(() => sampleAnimationGraphBlendSpace1D({ parameter: 'speed', samples: [first, second] }, Number.NaN), /Expected number/i);
  assert.throws(() => sampleAnimationGraphBlendSpace1D({ parameter: 'speed', samples: [first, second] }, Number.POSITIVE_INFINITY), /finite/i);
});

test('BlendSpace1D keeps interpolation stable across the full finite-number range', () => {
  const blendSpace = { parameter: 'speed', samples: [sample(-Number.MAX_VALUE, '1'), sample(Number.MAX_VALUE, '2')] };
  const result = sampleAnimationGraphBlendSpace1D(blendSpace, 0);
  assert.deepEqual(result.weights.map(({ weight }) => weight), [0.5, 0.5]);
  assert.equal(result.totalWeight, 1);
});

test('BlendSpace1D preserves normalization, adjacency and clamping across deterministic parameter sweeps', () => {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return ((seed ^ (seed >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  for (let graphIndex = 0; graphIndex < 96; graphIndex++) {
    const count = 2 + Math.floor(random() * 15);
    const offset = (random() - 0.5) * 1e8;
    const spacing = 0.01 + random() * 100;
    const samples = Array.from({ length: count }, (_, index) => sample(offset + index * spacing, `${graphIndex}_${index}`));
    const blendSpace = { parameter: 'speed', samples };
    const minimum = samples[0]!.value;
    const maximum = samples.at(-1)!.value;
    const inputs = [minimum - spacing, maximum + spacing, ...samples.map(item => item.value)];
    for (let query = 0; query < 24; query++) inputs.push(minimum - spacing + random() * (maximum - minimum + spacing * 2));

    for (const value of inputs) {
      const result = sampleAnimationGraphBlendSpace1D(blendSpace, value);
      const positive = result.weights.flatMap((item, index) => item.weight > 0 ? [index] : []);
      assert.ok(result.weights.every(item => Number.isFinite(item.weight) && item.weight >= 0 && item.weight <= 1));
      assert.ok(Math.abs(result.totalWeight - 1) <= Number.EPSILON * 2,
        `weights should sum to one for graph ${graphIndex} at parameter ${value}`);
      assert.ok(positive.length >= 1 && positive.length <= 2,
        `at most two adjacent clips should contribute for graph ${graphIndex} at parameter ${value}`);
      if (positive.length === 2) assert.equal(positive[1]! - positive[0]!, 1,
        'linear interpolation may only activate neighboring samples');
      assert.equal(result.clamped, value < minimum || value > maximum);
      assert.ok(result.sampledValue >= minimum && result.sampledValue <= maximum);
      assert.equal(result.lowerSample, result.weights[positive[0]!]!.stateId);
      assert.equal(result.upperSample, result.weights[positive.at(-1)!]!.stateId);
    }
  }
});
