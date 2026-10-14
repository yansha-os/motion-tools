import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAnimationGraphBlendSpace2DReachability, animationGraphBlendSpace2DSchema,
  animationGraphBlendSpace2DTopology, sampleAnimationGraphBlendSpace2D } from '../src/animation-graph-blend-space-2d.js';

const triangle = { xParameter: 'moveX', yParameter: 'moveY', samples: [
  { x: 0, y: 0, stateId: 'idle' }, { x: 1, y: 0, stateId: 'right' }, { x: 0, y: 1, stateId: 'forward' },
] };

function weights(result: ReturnType<typeof sampleAnimationGraphBlendSpace2D>) {
  return Object.fromEntries(result.weights.map(sample => [sample.stateId, sample.weight]));
}

test('2D blend spaces use barycentric weights with normalized sums and preserve unselected sources at zero', () => {
  const result = sampleAnimationGraphBlendSpace2D(triangle, { x: 0.25, y: 0.5 });
  assert.equal(result.method, 'delaunay_barycentric');
  assert.equal(result.clamped, false);
  assert.deepEqual(weights(result), { idle: 0.25, right: 0.25, forward: 0.5 });
  assert.equal(result.totalWeight, 1);
});

test('2D blend spaces select exact samples and edges without numerical negative weights', () => {
  assert.deepEqual(weights(sampleAnimationGraphBlendSpace2D(triangle, { x: 0, y: 0 })), { idle: 1, right: 0, forward: 0 });
  assert.deepEqual(weights(sampleAnimationGraphBlendSpace2D(triangle, { x: 0.5, y: 0.5 })), { idle: 0, right: 0.5, forward: 0.5 });
});

test('2D triangulation and hull projection preserve clustered samples beside extreme finite outliers', () => {
  for (const scale of [1e9, 1e100, 1e300]) {
    const conditioned = { ...triangle, samples: [
      { x: 0, y: 0, stateId: 'idle' }, { x: 1, y: 0, stateId: 'right' },
      { x: 0, y: 1, stateId: 'forward' }, { x: 0.2, y: 0.2, stateId: 'nearby' },
      { x: scale, y: scale, stateId: 'outlier' },
    ] };
    const topology = animationGraphBlendSpace2DTopology(conditioned);
    assert.equal(topology.triangles.length, 4, `all five sites should remain in the triangulation at scale ${scale}`);
    const inside = sampleAnimationGraphBlendSpace2D(conditioned, { x: 0.1, y: 0.1 });
    assert.equal(inside.method, 'delaunay_barycentric');
    assert.deepEqual(weights(inside), { idle: 0.5, right: 0, forward: 0, nearby: 0.5, outlier: 0 });
    assert.equal(inside.totalWeight, 1);

    const reachability = analyzeAnimationGraphBlendSpace2DReachability(conditioned, {
      x: { min: 0.1, max: 0.2 }, y: { min: 0.1, max: 0.2 },
    });
    assert.deepEqual(reachability.map(source => [source.stateId, source.reachable]), [
      ['idle', true], ['right', true], ['forward', true], ['nearby', true], ['outlier', false],
    ], `exact range reachability must agree with local blend geometry at scale ${scale}`);
    for (const [index, source] of reachability.entries()) {
      assert.ok(Math.abs(source.maximumReachableWeight - [0.5, 0.1, 0.1, 1, 0][index]!) < 1e-12,
        `maximum source weight must be correct at scale ${scale}`);
      if (!source.witnessParameterValues) continue;
      const observed = sampleAnimationGraphBlendSpace2D(conditioned, source.witnessParameterValues)
        .weights.find(candidate => candidate.stateId === source.stateId)!.weight;
      assert.ok(Math.abs(observed - source.maximumReachableWeight) < 1e-12,
        `the ${source.stateId} reachability witness must reproduce its maximum at scale ${scale}`);
    }

    const outside = sampleAnimationGraphBlendSpace2D(conditioned, { x: -scale, y: 0 });
    assert.equal(outside.method, 'nearest_hull_edge_projection');
    assert.equal(outside.totalWeight, 1);
    assert.ok(outside.weights.every(source => Number.isFinite(source.weight) && source.weight >= 0),
      `extreme projection must produce finite normalized weights at scale ${scale}`);
    assert.equal(outside.weights.find(source => source.stateId === 'idle')!.weight, 1);

    const outsideReachability = analyzeAnimationGraphBlendSpace2DReachability(conditioned, {
      x: { min: -scale, max: -scale }, y: { min: 0, max: 0 },
    });
    assert.equal(outsideReachability.find(source => source.stateId === 'idle')!.maximumReachableWeight, 1);
    assert.ok(outsideReachability.every(source => source.witnessParameterValues === null
      || Math.abs(sampleAnimationGraphBlendSpace2D(conditioned, source.witnessParameterValues).weights
        .find(candidate => candidate.stateId === source.stateId)!.weight - source.maximumReachableWeight) < 1e-12),
    `nearest-hull reachability witnesses must agree at scale ${scale}`);
  }
});

test('2D sampling and reachability stay finite when opposite-sign coordinates approach Number.MAX_VALUE', () => {
  const magnitude = Number.MAX_VALUE;
  const space = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: -magnitude, y: -magnitude, stateId: 'backLeft' },
    { x: magnitude, y: -magnitude, stateId: 'backRight' },
    { x: -magnitude, y: magnitude, stateId: 'frontLeft' },
    { x: magnitude, y: magnitude, stateId: 'frontRight' },
    { x: 0, y: 0, stateId: 'center' },
  ] };
  const topology = animationGraphBlendSpace2DTopology(space);
  assert.equal(topology.triangles.length, 4);
  assert.equal(topology.hullEdges.length, 4);
  for (const parameterValues of [
    { x: 0, y: 0 }, { x: magnitude / 2, y: -magnitude / 2 },
    { x: magnitude, y: magnitude }, { x: -magnitude, y: 0 }, { x: magnitude, y: 0 },
  ]) {
    const sample = sampleAnimationGraphBlendSpace2D(space, parameterValues);
    assert.equal(sample.totalWeight, 1);
    assert.ok(sample.weights.every(source => Number.isFinite(source.weight) && source.weight >= 0));
  }
  const reachability = analyzeAnimationGraphBlendSpace2DReachability(space, {
    x: { min: -magnitude, max: magnitude }, y: { min: -magnitude, max: magnitude },
  });
  assert.ok(reachability.every(source => source.maximumReachableWeight === 1 && source.reachable
    && source.witnessParameterValues !== null));
  for (const source of reachability) {
    const sampled = sampleAnimationGraphBlendSpace2D(space, source.witnessParameterValues!)
      .weights.find(candidate => candidate.stateId === source.stateId)!.weight;
    assert.ok(Math.abs(sampled - source.maximumReachableWeight) < 1e-12,
      `extreme-coordinate witness for ${source.stateId} should reproduce its maximum`);
  }
});

test('2D blend spaces project outside values to the nearest convex hull edge', () => {
  const result = sampleAnimationGraphBlendSpace2D(triangle, { x: 0.8, y: 0.8 });
  assert.equal(result.method, 'nearest_hull_edge_projection');
  assert.equal(result.clamped, true);
  assert.deepEqual(weights(result), { idle: 0, right: 0.5, forward: 0.5 });
  assert.equal(result.totalWeight, 1);
});

test('2D outside-hull projection preserves authored collinear edge samples', () => {
  const edgeSamples = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: 0, y: 0, stateId: 'idle' }, { x: 0.5, y: 0, stateId: 'mid' },
    { x: 1, y: 0, stateId: 'right' }, { x: 0, y: 1, stateId: 'forward' },
  ] };
  const topology = animationGraphBlendSpace2DTopology(edgeSamples);
  assert.ok(topology.hullEdges.some(([left, right]) => left === 'idle' && right === 'mid'));
  assert.ok(topology.hullEdges.some(([left, right]) => left === 'mid' && right === 'right'));
  assert.deepEqual(weights(sampleAnimationGraphBlendSpace2D(edgeSamples, { x: 0.5, y: -0.5 })),
    { idle: 0, mid: 1, right: 0, forward: 0 });
  assert.deepEqual(weights(sampleAnimationGraphBlendSpace2D(edgeSamples, { x: 0.25, y: -0.5 })),
    { idle: 0.5, mid: 0.5, right: 0, forward: 0 });
});

test('2D reachability finds exact maximum weights and witnesses over parameter rectangles', () => {
  const result = analyzeAnimationGraphBlendSpace2DReachability(triangle, {
    x: { min: 0.2, max: 0.4 }, y: { min: 0.2, max: 0.3 },
  });
  assert.deepEqual(result.map(source => source.stateId), ['idle', 'right', 'forward']);
  assert.deepEqual(result.map(source => source.reachable), [true, true, true]);
  assert.deepEqual(result.map(source => source.witnessParameterValues), [
    { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.2, y: 0.3 },
  ]);
  result.forEach((source, index) => assert.ok(Math.abs(source.maximumReachableWeight - [0.6, 0.4, 0.3][index]!) < 1e-12));
  for (const source of result) {
    assert.ok(source.witnessParameterValues);
    const sampled = sampleAnimationGraphBlendSpace2D(triangle, source.witnessParameterValues);
    assert.ok(Math.abs(sampled.weights.find(weight => weight.stateId === source.stateId)!.weight - source.maximumReachableWeight) < 1e-10,
      `witness for ${source.stateId} should reproduce its optimized maximum in the production sampler`);
  }
});

test('2D reachability optimizes nearest-hull projection outside the authored mesh', () => {
  const result = analyzeAnimationGraphBlendSpace2DReachability(triangle, {
    x: { min: 0.5, max: 0.5 }, y: { min: -1, max: -0.5 },
  });
  assert.deepEqual(result.map(source => [source.stateId, source.maximumReachableWeight, source.witnessParameterValues]), [
    ['idle', 0.5, { x: 0.5, y: -1 }],
    ['right', 0.5, { x: 0.5, y: -1 }],
    ['forward', 0, null],
  ]);
});

test('2D reachability does not classify a narrow positive-weight region as unreachable', () => {
  const result = analyzeAnimationGraphBlendSpace2DReachability(triangle, {
    x: { min: 0.4999999999999, max: 0.5 }, y: { min: 0.5, max: 0.5 },
  });
  const idle = result.find(source => source.stateId === 'idle')!;
  assert.equal(idle.reachable, true);
  assert.ok(idle.maximumReachableWeight > 0 && idle.maximumReachableWeight < 1e-12);
  assert.ok(idle.witnessParameterValues);
  const observed = sampleAnimationGraphBlendSpace2D(triangle, idle.witnessParameterValues).weights.find(source => source.stateId === 'idle')!.weight;
  assert.ok(Math.abs(observed - idle.maximumReachableWeight) < 1e-14);
});

test('2D reachability remains finite and witness-valid at extreme coordinate magnitudes', () => {
  const scale = 1e308;
  const extremeSpace = { ...triangle, samples: triangle.samples.map(sample => ({ ...sample, x: sample.x * scale, y: sample.y * scale })) };
  const result = analyzeAnimationGraphBlendSpace2DReachability(extremeSpace, {
    x: { min: 0.2 * scale, max: 0.4 * scale }, y: { min: 0.2 * scale, max: 0.3 * scale },
  });
  assert.ok(result.every(source => Number.isFinite(source.maximumReachableWeight)));
  for (const source of result) {
    assert.ok(source.witnessParameterValues);
    assert.ok(Number.isFinite(source.witnessParameterValues.x) && Number.isFinite(source.witnessParameterValues.y));
    const sampled = sampleAnimationGraphBlendSpace2D(extremeSpace, source.witnessParameterValues);
    const observed = sampled.weights.find(weight => weight.stateId === source.stateId)!.weight;
    assert.ok(Math.abs(observed - source.maximumReachableWeight) < 1e-10,
      `extreme-scale witness for ${source.stateId} should reproduce its maximum`);
  }
});

test('2D reachability is invariant to sample input ordering', () => {
  const result = analyzeAnimationGraphBlendSpace2DReachability({
    ...triangle, samples: [...triangle.samples, { x: 0.2, y: 0.1, stateId: 'interior' }],
  }, { x: { min: -0.3, max: 0.6 }, y: { min: -0.2, max: 0.7 } });
  const permuted = analyzeAnimationGraphBlendSpace2DReachability({
    ...triangle, samples: [...triangle.samples, { x: 0.2, y: 0.1, stateId: 'interior' }].reverse(),
  }, { x: { min: -0.3, max: 0.6 }, y: { min: -0.2, max: 0.7 } });
  const byState = (sources: typeof result) => Object.fromEntries(sources.map(source => [source.stateId,
    { maximumReachableWeight: source.maximumReachableWeight, reachable: source.reachable,
      witnessParameterValues: source.witnessParameterValues }]));
  assert.deepEqual(byState(result), byState(permuted));
});

test('2D continuous reachability bounds randomized dense parameter sweeps and validates every witness', () => {
  const space = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: -1, y: -1, stateId: 'backLeft' }, { x: 1, y: -1, stateId: 'backRight' },
    { x: -1, y: 1, stateId: 'forwardLeft' }, { x: 1, y: 1, stateId: 'forwardRight' },
    { x: 0, y: 0, stateId: 'center' }, { x: 0.2, y: -0.1, stateId: 'offset' },
  ] };
  let seed = 0x2d5eed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  for (let rectangleIndex = 0; rectangleIndex < 32; rectangleIndex++) {
    const xA = random() * 2.4 - 1.2, xB = random() * 2.4 - 1.2;
    const yA = random() * 2.4 - 1.2, yB = random() * 2.4 - 1.2;
    const range = { x: { min: Math.min(xA, xB), max: Math.max(xA, xB) },
      y: { min: Math.min(yA, yB), max: Math.max(yA, yB) } };
    const exact = analyzeAnimationGraphBlendSpace2DReachability(space, range);
    const denseMaxima = new Map(space.samples.map(sample => [sample.stateId, 0]));
    for (let xIndex = 0; xIndex <= 12; xIndex++) for (let yIndex = 0; yIndex <= 12; yIndex++) {
      const query = { x: range.x.min + (range.x.max - range.x.min) * xIndex / 12,
        y: range.y.min + (range.y.max - range.y.min) * yIndex / 12 };
      for (const sample of sampleAnimationGraphBlendSpace2D(space, query).weights) {
        denseMaxima.set(sample.stateId, Math.max(denseMaxima.get(sample.stateId)!, sample.weight));
      }
    }
    for (const source of exact) {
      assert.ok(source.maximumReachableWeight + 1e-9 >= denseMaxima.get(source.stateId)!,
        `continuous maximum for ${source.stateId} was below dense probe ${rectangleIndex}`);
      if (source.witnessParameterValues) {
        const actualWeight = sampleAnimationGraphBlendSpace2D(space, source.witnessParameterValues).weights
          .find(sample => sample.stateId === source.stateId)!.weight;
        assert.ok(Math.abs(actualWeight - source.maximumReachableWeight) < 1e-8,
          `reported witness did not reproduce maximum for ${source.stateId} in rectangle ${rectangleIndex}: ${JSON.stringify({ range, source, actualWeight })}`);
      } else assert.equal(source.maximumReachableWeight, 0);
    }
  }
});

test('2D continuous reachability stays valid across randomized meshes and parameter rectangles', () => {
  let seed = 0x71a9c3;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  for (let meshIndex = 0; meshIndex < 24; meshIndex++) {
    const samples = Array.from({ length: 9 }, (_, index) => ({
      x: random() * 4 - 2, y: random() * 4 - 2, stateId: `source${index}`,
    }));
    const space = { xParameter: 'moveX', yParameter: 'moveY', samples };
    const rangeValues = Array.from({ length: 4 }, () => random() * 5 - 2.5);
    const range = { x: { min: Math.min(rangeValues[0]!, rangeValues[1]!), max: Math.max(rangeValues[0]!, rangeValues[1]!) },
      y: { min: Math.min(rangeValues[2]!, rangeValues[3]!), max: Math.max(rangeValues[2]!, rangeValues[3]!) } };
    const optimized = analyzeAnimationGraphBlendSpace2DReachability(space, range);
    const denseMaxima = new Map(samples.map(sample => [sample.stateId, 0]));
    for (let xIndex = 0; xIndex <= 8; xIndex++) for (let yIndex = 0; yIndex <= 8; yIndex++) {
      const query = { x: range.x.min + (range.x.max - range.x.min) * xIndex / 8,
        y: range.y.min + (range.y.max - range.y.min) * yIndex / 8 };
      for (const sample of sampleAnimationGraphBlendSpace2D(space, query).weights) {
        denseMaxima.set(sample.stateId, Math.max(denseMaxima.get(sample.stateId)!, sample.weight));
      }
    }
    for (const source of optimized) {
      assert.ok(source.maximumReachableWeight + 1e-9 >= denseMaxima.get(source.stateId)!,
        `optimizer underreported ${source.stateId} on randomized mesh ${meshIndex}`);
      if (!source.witnessParameterValues) {
        assert.equal(source.maximumReachableWeight, 0);
        continue;
      }
      const witness = source.witnessParameterValues;
      assert.ok(witness.x >= range.x.min && witness.x <= range.x.max
        && witness.y >= range.y.min && witness.y <= range.y.max,
      `witness escaped the allowed rectangle on mesh ${meshIndex}`);
      const sampledWeight = sampleAnimationGraphBlendSpace2D(space, witness).weights
        .find(sample => sample.stateId === source.stateId)!.weight;
      assert.ok(Math.abs(sampledWeight - source.maximumReachableWeight) < 1e-8,
        `witness disagrees with the optimizer for ${source.stateId} on randomized mesh ${meshIndex}`);
    }
  }
});

test('2D blend spaces deterministically triangulate a square and remain invariant to input order', () => {
  const square = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: -1, y: -1, stateId: 'backLeft' }, { x: 1, y: -1, stateId: 'backRight' },
    { x: -1, y: 1, stateId: 'forwardLeft' }, { x: 1, y: 1, stateId: 'forwardRight' },
  ] };
  const first = sampleAnimationGraphBlendSpace2D(square, { x: 0.2, y: -0.1 });
  const permuted = sampleAnimationGraphBlendSpace2D({ ...square, samples: [...square.samples].reverse() }, { x: 0.2, y: -0.1 });
  assert.deepEqual(weights(first), weights(permuted));
  assert.ok(Math.abs(first.totalWeight - 1) < 1e-12);
  assert.ok(first.weights.every(sample => sample.weight >= 0));
});

test('2D cocircular radial topology has deterministic tie-breaking and manifold edge incidence', () => {
  const radial = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: 5, y: 0, stateId: 'east' }, { x: 3, y: 4, stateId: 'northEast' },
    { x: 0, y: 5, stateId: 'north' }, { x: -3, y: 4, stateId: 'northWest' },
    { x: -5, y: 0, stateId: 'west' }, { x: -3, y: -4, stateId: 'southWest' },
    { x: 0, y: -5, stateId: 'south' }, { x: 3, y: -4, stateId: 'southEast' },
  ] };
  const topology = animationGraphBlendSpace2DTopology(radial);
  assert.equal(topology.triangles.length, radial.samples.length - 2);
  assert.equal(topology.hullEdges.length, radial.samples.length);
  const edgeIncidence = new Map<string, number>();
  for (const triangle of topology.triangles) {
    for (const [left, right] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = [left, right].sort().join(':');
      edgeIncidence.set(key, (edgeIncidence.get(key) ?? 0) + 1);
    }
  }
  const hullEdges = new Set(topology.hullEdges.map(edge => [...edge].sort().join(':')));
  assert.ok([...edgeIncidence].every(([edge, count]) => count === (hullEdges.has(edge) ? 1 : 2)),
    'each hull edge must appear once and each internal diagonal exactly twice');

  for (const permutation of [
    [...radial.samples].reverse(), [...radial.samples.slice(3), ...radial.samples.slice(0, 3)],
    [...radial.samples].sort((left, right) => left.stateId.localeCompare(right.stateId)),
  ]) {
    const permuted = { ...radial, samples: permutation };
    assert.deepEqual(animationGraphBlendSpace2DTopology(permuted), topology,
      'cocircular Delaunay ties must not depend on the caller’s sample order');
    assert.deepEqual(weights(sampleAnimationGraphBlendSpace2D(permuted, { x: 0, y: 0 })),
      weights(sampleAnimationGraphBlendSpace2D(radial, { x: 0, y: 0 })));
  }
});

test('2D blend spaces reject duplicate, collinear, non-finite, and same-axis inputs', () => {
  assert.throws(() => animationGraphBlendSpace2DSchema.parse({ ...triangle, yParameter: 'moveX' }), /different numeric parameters/);
  assert.throws(() => animationGraphBlendSpace2DSchema.parse({ ...triangle, samples: [...triangle.samples, { x: 0, y: 0, stateId: 'duplicatePosition' }] }), /positions must be unique/);
  assert.throws(() => animationGraphBlendSpace2DSchema.parse({ ...triangle, samples: triangle.samples.map(sample => ({ ...sample, y: 0 })) }), /non-collinear/);
  assert.throws(() => animationGraphBlendSpace2DSchema.parse({ ...triangle, samples: triangle.samples.map(sample => ({ ...sample, stateId: 'idle' })) }), /source states must be unique/);
  assert.throws(() => sampleAnimationGraphBlendSpace2D(triangle, { x: Number.NaN, y: 0 }), /number|finite/);
});

test('2D blend-space weights preserve positions and remain stable over seeded randomized queries and sample order', () => {
  const space = { xParameter: 'moveX', yParameter: 'moveY', samples: [
    { x: -1, y: -1, stateId: 'backLeft' }, { x: 1, y: -1, stateId: 'backRight' },
    { x: -1, y: 1, stateId: 'forwardLeft' }, { x: 1, y: 1, stateId: 'forwardRight' },
    { x: 0, y: 0, stateId: 'center' }, { x: 0.2, y: -0.1, stateId: 'offset' },
  ] };
  let seed = 0x51a7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  for (let index = 0; index < 128; index++) {
    const query = { x: random() * 1.8 - 0.9, y: random() * 1.8 - 0.9 };
    const result = sampleAnimationGraphBlendSpace2D(space, query);
    const permuted = sampleAnimationGraphBlendSpace2D({ ...space, samples: [...space.samples].sort(() => random() - 0.5) }, query);
    assert.deepEqual(weights(result), weights(permuted), `input order changed output for deterministic sample ${index}`);
    assert.ok(Math.abs(result.totalWeight - 1) < 1e-12);
    assert.ok(result.weights.every(sample => sample.weight >= 0 && Number.isFinite(sample.weight)));
    assert.ok(result.weights.filter(sample => sample.weight > 1e-12).length <= 3);
    const reconstructed = result.weights.reduce((value, sample) => ({
      x: value.x + sample.x * sample.weight,
      y: value.y + sample.y * sample.weight,
    }), { x: 0, y: 0 });
    assert.ok(Math.abs(reconstructed.x - query.x) < 1e-10, `x reconstruction failed at sample ${index}`);
    assert.ok(Math.abs(reconstructed.y - query.y) < 1e-10, `y reconstruction failed at sample ${index}`);
  }
});
