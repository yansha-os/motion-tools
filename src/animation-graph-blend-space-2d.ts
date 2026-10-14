import { z } from 'zod';

const stateIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
export const animationGraphBlendSpace2DSampleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  stateId: stateIdSchema,
}).strict();

export const animationGraphBlendSpace2DSchema = z.object({
  xParameter: stateIdSchema,
  yParameter: stateIdSchema,
  samples: z.array(animationGraphBlendSpace2DSampleSchema).min(3).max(16),
}).strict().superRefine((blendSpace, context) => {
  if (blendSpace.xParameter === blendSpace.yParameter) context.addIssue({ code: 'custom', path: ['yParameter'],
    message: 'BlendSpace2D axes must use two different numeric parameters.' });
  if (new Set(blendSpace.samples.map(sample => sample.stateId)).size !== blendSpace.samples.length) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'BlendSpace2D source states must be unique.' });
  }
  const positions = new Set<string>();
  blendSpace.samples.forEach((sample, index) => {
    const position = `${sample.x}\u0000${sample.y}`;
    if (positions.has(position)) context.addIssue({ code: 'custom', path: ['samples', index],
      message: 'BlendSpace2D source positions must be unique.' });
    positions.add(position);
  });
  if (blendSpace.samples.length >= 3 && !hasNonCollinearTriple(blendSpace.samples)) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'BlendSpace2D samples must contain at least three non-collinear positions.' });
  }
});

export type AnimationGraphBlendSpace2D = z.infer<typeof animationGraphBlendSpace2DSchema>;
type Point = { x: number; y: number; stateId: string };
type Triangle = { a: number; b: number; c: number };
type ExactPoint = { x: bigint; y: bigint; stateId: string };
type Rational = { numerator: bigint; denominator: bigint };
type RationalPoint = { x: Rational; y: Rational };
type HalfPlane = { a: bigint; b: bigint; c: bigint };

const floatBitsBuffer = new ArrayBuffer(8);
const floatBitsView = new DataView(floatBitsBuffer);
const binaryCoordinateScale = 1n << 1074n;
const triangulationCache = new Map<string, Triangle[]>();

function bigintGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Error('Exact geometry produced a zero denominator.');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = bigintGcd(numerator, denominator);
  return { numerator: sign * numerator / divisor, denominator: sign * denominator / divisor };
}

function rationalAdd(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function rationalSubtract(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function rationalMultiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function rationalDivide(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function rationalSign(value: Rational): number {
  return value.numerator < 0n ? -1 : value.numerator > 0n ? 1 : 0;
}

function rationalCompare(left: Rational, right: Rational): number {
  return rationalSign({ numerator: left.numerator * right.denominator - right.numerator * left.denominator, denominator: 1n });
}

function rationalCoordinate(value: number): Rational {
  return rational(exactInteger(value));
}

function rationalPoint(point: Point): RationalPoint {
  return { x: rationalCoordinate(point.x), y: rationalCoordinate(point.y) };
}

function rationalPointToNumbers(point: RationalPoint): BlendPoint {
  return { x: bigintRatio(point.x.numerator, point.x.denominator * binaryCoordinateScale),
    y: bigintRatio(point.y.numerator, point.y.denominator * binaryCoordinateScale) };
}

function halfPlaneForEdge(left: ExactPoint, right: ExactPoint, keepLeft: boolean): HalfPlane {
  const dx = right.x - left.x, dy = right.y - left.y;
  const sign = keepLeft ? 1n : -1n;
  return { a: -dy * sign, b: dx * sign, c: (dy * left.x - dx * left.y) * sign };
}

function clipRationalPolygon(polygon: RationalPoint[], halfPlane: HalfPlane): RationalPoint[] {
  if (polygon.length === 0) return [];
  const distance = (point: RationalPoint) => rationalAdd(rationalAdd(
    rationalMultiply(rational(halfPlane.a), point.x), rationalMultiply(rational(halfPlane.b), point.y)), rational(halfPlane.c));
  const output: RationalPoint[] = [];
  let previous = polygon.at(-1)!;
  let previousDistance = distance(previous);
  let previousInside = rationalSign(previousDistance) >= 0;
  for (const current of polygon) {
    const currentDistance = distance(current);
    const currentInside = rationalSign(currentDistance) >= 0;
    if (previousInside !== currentInside) {
      const amount = rationalDivide(previousDistance, rationalSubtract(previousDistance, currentDistance));
      output.push({
        x: rationalAdd(previous.x, rationalMultiply(amount, rationalSubtract(current.x, previous.x))),
        y: rationalAdd(previous.y, rationalMultiply(amount, rationalSubtract(current.y, previous.y))),
      });
    }
    if (currentInside) output.push(current);
    previous = current;
    previousDistance = currentDistance;
    previousInside = currentInside;
  }
  return output;
}

function rationalOrientation(point: RationalPoint, a: ExactPoint, b: ExactPoint): Rational {
  const dx = b.x - a.x, dy = b.y - a.y;
  return rationalSubtract(rationalMultiply(rational(dx), rationalSubtract(point.y, rational(a.y))),
    rationalMultiply(rational(dy), rationalSubtract(point.x, rational(a.x))));
}

function rationalBarycentric(point: RationalPoint, a: ExactPoint, b: ExactPoint, c: ExactPoint): [number, number, number] | null {
  const denominator = exactOrientation(a, b, c);
  if (denominator === 0n) return null;
  const exactWeights = [rationalOrientation(point, b, c), rationalOrientation(point, c, a), rationalOrientation(point, a, b)];
  const denominatorSign = denominator < 0n ? -1 : 1;
  if (exactWeights.some(weight => rationalSign(weight) * denominatorSign < 0)) return null;
  const raw = exactWeights.map(weight => bigintRatio(weight.numerator, weight.denominator * denominator));
  const clamped = raw.map(weight => Math.max(0, weight));
  const total = clamped[0]! + clamped[1]! + clamped[2]!;
  return clamped.map(weight => weight / total) as [number, number, number];
}

function exactInteger(value: number): bigint {
  floatBitsView.setFloat64(0, value, false);
  const bits = floatBitsView.getBigUint64(0, false);
  const negative = (bits >> 63n) !== 0n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  if (exponent === 0 && fraction === 0n) return 0n;
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const scaled = exponent === 0 ? significand : significand << BigInt(exponent - 1);
  return negative ? -scaled : scaled;
}

function exactPoint(point: Point): ExactPoint {
  return { x: exactInteger(point.x), y: exactInteger(point.y), stateId: point.stateId };
}

function exactOrientation(a: ExactPoint, b: ExactPoint, c: ExactPoint): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function exactOrientationSign(a: Point, b: Point, c: Point): number {
  const determinant = exactOrientation(exactPoint(a), exactPoint(b), exactPoint(c));
  return determinant < 0n ? -1 : determinant > 0n ? 1 : 0;
}

function exactSquaredDistanceFraction(point: ExactPoint, left: ExactPoint, right: ExactPoint) {
  const dx = right.x - left.x, dy = right.y - left.y;
  const px = point.x - left.x, py = point.y - left.y;
  const denominator = dx * dx + dy * dy;
  const dot = px * dx + py * dy;
  if (dot <= 0n) return { numerator: px * px + py * py, denominator: 1n };
  if (dot >= denominator) {
    const qx = point.x - right.x, qy = point.y - right.y;
    return { numerator: qx * qx + qy * qy, denominator: 1n };
  }
  const cross = px * dy - py * dx;
  return { numerator: cross * cross, denominator };
}

function compareFractions(left: { numerator: bigint; denominator: bigint }, right: { numerator: bigint; denominator: bigint }): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return Number.NaN;
  if (numerator === 0n) return 0;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const top = numerator < 0n ? -numerator : numerator;
  const bottom = denominator < 0n ? -denominator : denominator;
  const topBits = top.toString(2).length;
  const bottomBits = bottom.toString(2).length;
  const topShift = Math.max(0, topBits - 53);
  const bottomShift = Math.max(0, bottomBits - 53);
  const mantissa = Number(top >> BigInt(topShift)) / Number(bottom >> BigInt(bottomShift));
  const exponent = topShift - bottomShift;
  const ratio = exponent < -1074 ? 0 : mantissa * 2 ** exponent;
  return negative ? -ratio : ratio;
}

function hasNonCollinearTriple(input: readonly Point[]): boolean {
  const points = input.map(exactPoint);
  const anchor = points[0]!;
  for (let left = 1; left < points.length; left++) for (let right = left + 1; right < points.length; right++) {
    if (exactOrientation(anchor, points[left]!, points[right]!) !== 0n) return true;
  }
  return false;
}

function circumcircleContains(a: ExactPoint, b: ExactPoint, c: ExactPoint, point: ExactPoint): boolean {
  const ax = a.x - point.x, ay = a.y - point.y;
  const bx = b.x - point.x, by = b.y - point.y;
  const cx = c.x - point.x, cy = c.y - point.y;
  const determinant = (ax * ax + ay * ay) * (bx * cy - cx * by)
    - (bx * bx + by * by) * (ax * cy - cx * ay)
    + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return exactOrientation(a, b, c) > 0n ? determinant > 0n : determinant < 0n;
}

function triangulate(points: readonly Point[]): Triangle[] {
  const cacheKey = JSON.stringify([...points].sort((left, right) => left.stateId.localeCompare(right.stateId))
    .map(point => [point.stateId, point.x, point.y]));
  const cached = triangulationCache.get(cacheKey);
  if (cached) return cached;
  const vertices = [...points].sort((left, right) => left.x - right.x || left.y - right.y || left.stateId.localeCompare(right.stateId))
    .map(exactPoint);
  const minX = vertices.reduce((value, point) => point.x < value ? point.x : value, vertices[0]!.x);
  const maxX = vertices.reduce((value, point) => point.x > value ? point.x : value, vertices[0]!.x);
  const minY = vertices.reduce((value, point) => point.y < value ? point.y : value, vertices[0]!.y);
  const maxY = vertices.reduce((value, point) => point.y > value ? point.y : value, vertices[0]!.y);
  const span = [maxX - minX, maxY - minY].reduce((value, candidate) => candidate > value ? candidate : value, 1n);
  const centerX = (minX + maxX) / 2n, centerY = (minY + maxY) / 2n;
  const firstSuper = vertices.length;
  vertices.push({ x: centerX - 64n * span, y: centerY - 32n * span, stateId: '' },
    { x: centerX + 64n * span, y: centerY - 32n * span, stateId: '' },
    { x: centerX, y: centerY + 64n * span, stateId: '' });
  let triangles: Triangle[] = [{ a: firstSuper, b: firstSuper + 1, c: firstSuper + 2 }];

  for (let pointIndex = 0; pointIndex < firstSuper; pointIndex++) {
    const point = vertices[pointIndex]!;
    const bad = triangles.filter(triangle => circumcircleContains(vertices[triangle.a]!, vertices[triangle.b]!, vertices[triangle.c]!, point));
    const boundary = new Map<string, [number, number]>();
    for (const triangle of bad) for (const [left, right] of [[triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]] as [number, number][]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      const existing = boundary.get(key);
      if (existing) boundary.delete(key);
      else boundary.set(key, [left, right]);
    }
    const badSet = new Set(bad);
    triangles = triangles.filter(triangle => !badSet.has(triangle));
    for (const [left, right] of boundary.values()) {
      if (exactOrientation(vertices[left]!, vertices[right]!, point) > 0n) triangles.push({ a: left, b: right, c: pointIndex });
      else triangles.push({ a: right, b: left, c: pointIndex });
    }
  }
  const result = triangles.filter(triangle => triangle.a < firstSuper && triangle.b < firstSuper && triangle.c < firstSuper)
    .sort((left, right) => triangleKey(left, vertices).localeCompare(triangleKey(right, vertices)));
  if (triangulationCache.size >= 128) triangulationCache.delete(triangulationCache.keys().next().value!);
  triangulationCache.set(cacheKey, result);
  return result;
}

function triangleKey(triangle: Triangle, points: readonly ExactPoint[]): string {
  return [points[triangle.a]!.stateId, points[triangle.b]!.stateId, points[triangle.c]!.stateId].sort().join('\u0000');
}

function exactBarycentric(point: Point, a: Point, b: Point, c: Point): [number, number, number] | null {
  const exactQuery = exactPoint(point), exactA = exactPoint(a), exactB = exactPoint(b), exactC = exactPoint(c);
  const denominator = exactOrientation(exactA, exactB, exactC);
  if (denominator === 0n) return null;
  const exactWeights = [exactOrientation(exactQuery, exactB, exactC), exactOrientation(exactA, exactQuery, exactC),
    exactOrientation(exactA, exactB, exactQuery)];
  const denominatorSign = denominator < 0n ? -1n : 1n;
  if (exactWeights.some(weight => weight * denominatorSign < 0n)) return null;
  const raw = exactWeights.map(weight => bigintRatio(weight, denominator));
  const clamped = raw.map(weight => Math.max(0, weight));
  const total = clamped[0]! + clamped[1]! + clamped[2]!;
  return clamped.map(weight => weight / total) as [number, number, number];
}

function polygonCentroid(polygon: readonly RationalPoint[]): RationalPoint {
  const total = polygon.reduce((sum, point) => ({ x: rationalAdd(sum.x, point.x), y: rationalAdd(sum.y, point.y) }),
    { x: rational(0n), y: rational(0n) });
  return { x: rationalDivide(total.x, rational(BigInt(polygon.length))),
    y: rationalDivide(total.y, rational(BigInt(polygon.length))) };
}

function feasibleRoundedTriangleSample(witness: RationalPoint, interior: RationalPoint, triangle: readonly ExactPoint[]) {
  const asPoints = triangle.map(point => ({ x: bigintRatio(point.x, binaryCoordinateScale),
    y: bigintRatio(point.y, binaryCoordinateScale), stateId: point.stateId }));
  const toSample = (point: RationalPoint) => {
    const coordinates = rationalPointToNumbers(point);
    const candidate = { ...coordinates, stateId: '' };
    const weights = exactBarycentric(candidate, asPoints[0]!, asPoints[1]!, asPoints[2]!);
    return weights ? { coordinates, weights } : null;
  };
  const direct = toSample(witness);
  if (direct) return direct;
  for (let exponent = 15; exponent >= 6; exponent--) {
    const amount = rational(1n, 10n ** BigInt(exponent));
    const inward = {
      x: rationalAdd(rationalMultiply(rationalSubtract(rational(1n), amount), witness.x), rationalMultiply(amount, interior.x)),
      y: rationalAdd(rationalMultiply(rationalSubtract(rational(1n), amount), witness.y), rationalMultiply(amount, interior.y)),
    };
    const adjusted = toSample(inward);
    if (adjusted) return adjusted;
  }
  return null;
}

function closestEdgeWeights(point: Point, points: readonly Point[]): { indices: [number, number]; weights: [number, number] } {
  const hull = points.map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => left.candidate.x - right.candidate.x || left.candidate.y - right.candidate.y
      || left.candidate.stateId.localeCompare(right.candidate.stateId));
  const lower: typeof hull = [];
  for (const entry of hull) {
    while (lower.length >= 2 && exactOrientationSign(lower.at(-2)!.candidate, lower.at(-1)!.candidate, entry.candidate) < 0) lower.pop();
    lower.push(entry);
  }
  const upper: typeof hull = [];
  for (const entry of [...hull].reverse()) {
    while (upper.length >= 2 && exactOrientationSign(upper.at(-2)!.candidate, upper.at(-1)!.candidate, entry.candidate) < 0) upper.pop();
    upper.push(entry);
  }
  const boundary = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let best: { indices: [number, number]; weights: [number, number]; distance: { numerator: bigint; denominator: bigint }; tieKey: string } | null = null;
  const exactQuery = exactPoint(point);
  for (let index = 0; index < boundary.length; index++) {
    const left = boundary[index]!;
    const right = boundary[(index + 1) % boundary.length]!;
    const exactLeft = exactPoint(left.candidate), exactRight = exactPoint(right.candidate);
    const dx = exactRight.x - exactLeft.x, dy = exactRight.y - exactLeft.y;
    const px = exactQuery.x - exactLeft.x, py = exactQuery.y - exactLeft.y;
    const lengthSquared = dx * dx + dy * dy;
    const dot = px * dx + py * dy;
    const alpha = dot <= 0n ? 0 : dot >= lengthSquared ? 1 : bigintRatio(dot, lengthSquared);
    const candidate = { indices: [left.index, right.index] as [number, number], weights: [1 - alpha, alpha] as [number, number],
      distance: exactSquaredDistanceFraction(exactQuery, exactLeft, exactRight),
      tieKey: `${left.candidate.stateId}\u0000${right.candidate.stateId}` };
    const distanceOrder = best ? compareFractions(candidate.distance, best.distance) : -1;
    if (!best || distanceOrder < 0 || (distanceOrder === 0 && candidate.tieKey < best.tieKey)) best = candidate;
  }
  if (!best) throw new Error('BlendSpace2D convex hull could not be constructed.');
  return { indices: best.indices, weights: best.weights };
}

/** Returns deterministic, source-ID-addressed Delaunay triangles and convex-hull edges for runtime evaluation. */
export function animationGraphBlendSpace2DTopology(blendSpaceInput: unknown) {
  const blendSpace = animationGraphBlendSpace2DSchema.parse(blendSpaceInput);
  const sorted = [...blendSpace.samples].sort((left, right) => left.x - right.x || left.y - right.y || left.stateId.localeCompare(right.stateId));
  const triangles = triangulate(blendSpace.samples).map(triangle => [sorted[triangle.a]!.stateId,
    sorted[triangle.b]!.stateId, sorted[triangle.c]!.stateId] as [string, string, string]);
  const hull = blendSpace.samples.map((sample, index) => ({ sample, index }))
    .sort((left, right) => left.sample.x - right.sample.x || left.sample.y - right.sample.y || left.sample.stateId.localeCompare(right.sample.stateId));
  const lower: typeof hull = [];
  for (const entry of hull) {
    while (lower.length >= 2 && exactOrientationSign(lower.at(-2)!.sample, lower.at(-1)!.sample, entry.sample) < 0) lower.pop();
    lower.push(entry);
  }
  const upper: typeof hull = [];
  for (const entry of [...hull].reverse()) {
    while (upper.length >= 2 && exactOrientationSign(upper.at(-2)!.sample, upper.at(-1)!.sample, entry.sample) < 0) upper.pop();
    upper.push(entry);
  }
  const boundary = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const hullEdges = boundary.map((entry, index) => [entry.sample.stateId,
    boundary[(index + 1) % boundary.length]!.sample.stateId] as [string, string]);
  return { triangles, hullEdges };
}

type BlendPoint = { x: number; y: number };

function rationalRectangle(minX: number, maxX: number, minY: number, maxY: number): RationalPoint[] {
  const x0 = rationalCoordinate(minX), x1 = rationalCoordinate(maxX);
  const y0 = rationalCoordinate(minY), y1 = rationalCoordinate(maxY);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

function clampUnitInterval(value: Rational): Rational {
  if (rationalSign(value) <= 0) return rational(0n);
  if (rationalCompare(value, rational(1n)) >= 0) return rational(1n);
  return value;
}

/** Computes exact maximum source weights over a finite parameter rectangle for the piecewise-linear 2D sampler. */
export function analyzeAnimationGraphBlendSpace2DReachability(blendSpaceInput: unknown,
  rangeInput: unknown) {
  const blendSpace = animationGraphBlendSpace2DSchema.parse(blendSpaceInput);
  const ranges = z.object({ x: z.object({ min: z.number().finite(), max: z.number().finite() }).strict(),
    y: z.object({ min: z.number().finite(), max: z.number().finite() }).strict() }).strict().superRefine((value, context) => {
      if (value.x.min > value.x.max) context.addIssue({ code: 'custom', path: ['x', 'min'], message: 'Minimum must not exceed maximum.' });
      if (value.y.min > value.y.max) context.addIssue({ code: 'custom', path: ['y', 'min'], message: 'Minimum must not exceed maximum.' });
    }).parse(rangeInput);
  const points = blendSpace.samples;
  const pointById = new Map(points.map(point => [point.stateId, exactPoint(point)]));
  const topology = animationGraphBlendSpace2DTopology(blendSpace);
  const maximumById = new Map(points.map(point => [point.stateId, { maximumWeight: 0, witness: null as BlendPoint | null }]));
  const record = (stateId: string, weight: number, exactWitness: RationalPoint, roundedWitness?: BlendPoint) => {
    const witness = roundedWitness ?? rationalPointToNumbers(exactWitness);
    const evidence = maximumById.get(stateId)!;
    const clampedWeight = Math.max(0, Math.min(1, weight));
    const previousMaximum = evidence.maximumWeight;
    const tiedWithinPrecision = Math.abs(clampedWeight - previousMaximum) <= Number.EPSILON * 32;
    const witnessIsEarlier = evidence.witness !== null
      && (witness.x < evidence.witness.x || (witness.x === evidence.witness.x && witness.y < evidence.witness.y));
    if (evidence.witness === null && clampedWeight > 0) {
      evidence.maximumWeight = clampedWeight;
      evidence.witness = witness;
    } else if (clampedWeight > previousMaximum) {
      evidence.maximumWeight = clampedWeight;
      if (!tiedWithinPrecision || witnessIsEarlier) evidence.witness = witness;
    } else if (tiedWithinPrecision && witnessIsEarlier) {
      evidence.witness = witness;
    }
  };
  const rectangle = rationalRectangle(ranges.x.min, ranges.x.max, ranges.y.min, ranges.y.max);
  for (const triangleIds of topology.triangles) {
    const triangle = triangleIds.map(stateId => pointById.get(stateId)!);
    const direction = exactOrientation(triangle[0]!, triangle[1]!, triangle[2]!);
    if (direction === 0n) continue;
    const keepLeft = direction > 0n;
    const intersection = [
      halfPlaneForEdge(triangle[0]!, triangle[1]!, keepLeft),
      halfPlaneForEdge(triangle[1]!, triangle[2]!, keepLeft),
      halfPlaneForEdge(triangle[2]!, triangle[0]!, keepLeft),
    ].reduce((polygon, halfPlane) => clipRationalPolygon(polygon, halfPlane), rectangle);
    if (intersection.length === 0) continue;
    const interior = polygonCentroid(intersection);
    for (const witness of intersection) {
      const weights = rationalBarycentric(witness, triangle[0]!, triangle[1]!, triangle[2]!);
      const rounded = feasibleRoundedTriangleSample(witness, interior, triangle);
      if (weights && rounded) triangleIds.forEach((stateId, index) => record(stateId, weights[index]!, witness, rounded.coordinates));
    }
  }
  for (const [leftId, rightId] of topology.hullEdges) {
    const left = pointById.get(leftId)!;
    const right = pointById.get(rightId)!;
    const dx = right.x - left.x, dy = right.y - left.y;
    const lengthSquared = dx * dx + dy * dy;
    const projectionStart = { a: dx, b: dy, c: -dx * left.x - dy * left.y };
    const projectionEnd = { a: -dx, b: -dy, c: dx * left.x + dy * left.y + lengthSquared };
    const outsideHull = halfPlaneForEdge(left, right, false);
    const polygon = [outsideHull, projectionStart, projectionEnd]
      .reduce((current, halfPlane) => clipRationalPolygon(current, halfPlane), rectangle);
    for (const witness of polygon) {
      const dot = rationalAdd(rationalMultiply(rational(dx), rationalSubtract(witness.x, rational(left.x))),
        rationalMultiply(rational(dy), rationalSubtract(witness.y, rational(left.y))));
      const alpha = clampUnitInterval(rationalDivide(dot, rational(lengthSquared)));
      const weight = bigintRatio(alpha.numerator, alpha.denominator);
      record(leftId, 1 - weight, witness);
      record(rightId, weight, witness);
    }
  }
  return points.map(point => {
    const evidence = maximumById.get(point.stateId)!;
    const witness = evidence.witness;
    return { stateId: point.stateId, maximumReachableWeight: evidence.maximumWeight,
      reachable: evidence.maximumWeight > 0,
      witnessParameterValues: witness };
  });
}

/** Samples a deterministic Delaunay-triangulated 2D blend space; outside points project to the nearest convex-hull edge. */
export function sampleAnimationGraphBlendSpace2D(blendSpaceInput: unknown, parameterValuesInput: unknown) {
  const blendSpace = animationGraphBlendSpace2DSchema.parse(blendSpaceInput);
  const parameterValues = z.object({ x: z.number().finite(), y: z.number().finite() }).strict().parse(parameterValuesInput);
  const query = { ...parameterValues, stateId: '' };
  const triangulatedSamples = [...blendSpace.samples].sort((left, right) => left.x - right.x || left.y - right.y || left.stateId.localeCompare(right.stateId));
  const triangles = triangulate(blendSpace.samples);
  let selected: { triangle: Triangle; weights: [number, number, number] } | null = null;
  for (const triangle of triangles) {
    const weights = exactBarycentric(query, triangulatedSamples[triangle.a]!, triangulatedSamples[triangle.b]!, triangulatedSamples[triangle.c]!);
    if (weights) { selected = { triangle, weights }; break; }
  }
  const weights = blendSpace.samples.map(sample => ({ stateId: sample.stateId, x: sample.x, y: sample.y, weight: 0 }));
  let method: 'delaunay_barycentric' | 'nearest_hull_edge_projection';
  let clamped: boolean;
  if (selected) {
    const indices = [selected.triangle.a, selected.triangle.b, selected.triangle.c];
    indices.forEach((sampleIndex, index) => {
      const stateId = triangulatedSamples[sampleIndex]!.stateId;
      weights.find(sample => sample.stateId === stateId)!.weight = selected!.weights[index]!;
    });
    method = 'delaunay_barycentric';
    clamped = false;
  } else {
    const projected = closestEdgeWeights(query, blendSpace.samples);
    weights[projected.indices[0]]!.weight = projected.weights[0];
    weights[projected.indices[1]]!.weight = projected.weights[1];
    method = 'nearest_hull_edge_projection';
    clamped = true;
  }
  return { xParameter: blendSpace.xParameter, yParameter: blendSpace.yParameter, parameterValues,
    clamped, weights, totalWeight: weights.reduce((sum, sample) => sum + sample.weight, 0), method,
    limitation: 'This computes parameter-to-clip weights only. It does not sample animation time, compose local poses, apply AnimationPriority, or reproduce Roblox runtime blend-space behavior.' };
}
