export type Quaternion4 = [number, number, number, number];
export type WeightedQuaternion = { rotation: Quaternion4; weight: number };

function normalizeQuaternion(rotation: Quaternion4): Quaternion4 {
  if (rotation.some(component => !Number.isFinite(component))) throw new Error('Quaternion components must be finite.');
  const scale = Math.max(...rotation.map(component => Math.abs(component)));
  if (scale === 0) throw new Error('Quaternions in a blend must have nonzero magnitude.');
  const scaledRotation = rotation.map(component => component / scale) as Quaternion4;
  const scaledLength = Math.hypot(...scaledRotation);
  return scaledRotation.map(component => component / scaledLength) as Quaternion4;
}

/** Returns the shortest angular distance between two quaternion orientations in degrees. */
export function quaternionAngularDistanceDegrees(left: Quaternion4, right: Quaternion4): number {
  const normalizedLeft = normalizeQuaternion(left);
  const normalizedRight = normalizeQuaternion(right);
  const dot = Math.abs(normalizedLeft.reduce((sum, value, index) => sum + value * normalizedRight[index]!, 0));
  return 2 * Math.acos(Math.max(0, Math.min(1, dot))) * 180 / Math.PI;
}

/** Returns the shortest-arc angular-velocity vector in the starting orientation's local frame. */
export function quaternionAngularVelocityDegrees(from: Quaternion4, to: Quaternion4, seconds: number): [number, number, number] {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Quaternion angular-velocity interval must be positive and finite.');
  const start = normalizeQuaternion(from);
  let target = normalizeQuaternion(to);
  const dot = start.reduce((sum, value, index) => sum + value * target[index]!, 0);
  if (dot < 0) target = target.map(value => -value) as Quaternion4;
  const [x, y, z, w] = start;
  const [a, b, c, d] = target;
  const relative: Quaternion4 = [
    w * a - x * d - y * c + z * b,
    w * b + x * c - y * d - z * a,
    w * c - x * b + y * a - z * d,
    w * d + x * a + y * b + z * c,
  ];
  const vectorLength = Math.hypot(relative[0], relative[1], relative[2]);
  if (vectorLength < 1e-12) return [0, 0, 0];
  const angleDegrees = 2 * Math.atan2(vectorLength, Math.max(0, relative[3])) * 180 / Math.PI;
  const scale = angleDegrees / (seconds * vectorLength);
  return [relative[0] * scale, relative[1] * scale, relative[2] * scale];
}

/** Transports a vector between local frames whose orientations map their local axes into a shared world basis. */
export function transportVectorBetweenQuaternionFrames(vector: [number, number, number], fromFrame: Quaternion4, toFrame: Quaternion4): [number, number, number] {
  const from = normalizeQuaternion(fromFrame);
  const to = normalizeQuaternion(toFrame);
  const [x, y, z, w] = to;
  const [a, b, c, d] = from;
  const frameDelta: Quaternion4 = [
    w * a - x * d - y * c + z * b,
    w * b + x * c - y * d - z * a,
    w * c - x * b + y * a - z * d,
    w * d + x * a + y * b + z * c,
  ];
  const [qx, qy, qz, qw] = normalizeQuaternion(frameDelta);
  const [vx, vy, vz] = vector;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx];
}

/** Computes the principal-eigenvector mean of weighted quaternion orientations (Markley method). */
export function weightedQuaternionMean(samples: readonly WeightedQuaternion[]): { rotation: Quaternion4; confidence: number } {
  let maxWeight = 0;
  const normalized = samples.map(({ rotation, weight }) => {
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Quaternion blend weights must be finite and nonnegative.');
    maxWeight = Math.max(maxWeight, weight);
    return { rotation: normalizeQuaternion(rotation), weight };
  });
  if (maxWeight === 0) return { rotation: [0, 0, 0, 1], confidence: 1 };

  const matrix: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (const { rotation, weight } of normalized) {
    if (weight <= 0) continue;
    const stableWeight = weight / maxWeight;
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      matrix[row]![column]! += stableWeight * rotation[row]! * rotation[column]!;
    }
  }
  const totalWeight = matrix.reduce((sum, row, index) => sum + row[index]!, 0);
  if (totalWeight < 1e-12) return { rotation: [0, 0, 0, 1], confidence: 1 };
  const eigenvectors: number[][] = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => row === column ? 1 : 0));
  for (let iteration = 0; iteration < 64; iteration++) {
    let p = 0, q = 1, largest = Math.abs(matrix[0]![1]!);
    for (let row = 0; row < 4; row++) for (let column = row + 1; column < 4; column++) {
      const magnitude = Math.abs(matrix[row]![column]!);
      if (magnitude > largest) { largest = magnitude; p = row; q = column; }
    }
    if (largest < 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * matrix[p]![q]!, matrix[q]![q]! - matrix[p]![p]!);
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const app = matrix[p]![p]!, aqq = matrix[q]![q]!, apq = matrix[p]![q]!;
    matrix[p]![p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    matrix[q]![q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    matrix[p]![q] = 0; matrix[q]![p] = 0;
    for (let index = 0; index < 4; index++) if (index !== p && index !== q) {
      const aip = matrix[index]![p]!, aiq = matrix[index]![q]!;
      matrix[index]![p] = cosine * aip - sine * aiq; matrix[p]![index] = matrix[index]![p]!;
      matrix[index]![q] = sine * aip + cosine * aiq; matrix[q]![index] = matrix[index]![q]!;
    }
    for (let row = 0; row < 4; row++) {
      const vip = eigenvectors[row]![p]!, viq = eigenvectors[row]![q]!;
      eigenvectors[row]![p] = cosine * vip - sine * viq;
      eigenvectors[row]![q] = sine * vip + cosine * viq;
    }
  }
  const eigenvalueOrder = [0, 1, 2, 3].sort((left, right) => matrix[right]![right]! - matrix[left]![left]!);
  const principal = eigenvalueOrder[0]!;
  const result = eigenvectors.map(row => row[principal]!) as Quaternion4;
  const length = Math.hypot(...result);
  if (length < 1e-12) return { rotation: [0, 0, 0, 1], confidence: 0 };
  const unit = result.map(value => value / length) as Quaternion4;
  const signComponent = unit.find(value => Math.abs(value) > 1e-12) ?? 1;
  return { rotation: signComponent < 0 ? unit.map(value => -value) as Quaternion4 : unit,
    confidence: Math.max(0, Math.min(1, (matrix[principal]![principal]! - matrix[eigenvalueOrder[1]!]![eigenvalueOrder[1]!]!) / totalWeight)) };
}
