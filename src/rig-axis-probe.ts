import { animationSchema, type AnimationRecipe } from './recipes.js';
import { telemetrySchema, type Telemetry } from './inspection.js';

const probeDuration = 1.2;
const probeStepSeconds = 0.1;
const axisNames = ['x', 'y', 'z'] as const;
type Quaternion = [number, number, number, number];
type Vector3 = [number, number, number];

/** Creates a disposable six-pulse clip; no library or editor state is changed. */
export function createRigAxisProbeRecipe(joint: string, probeDegrees = 5): AnimationRecipe {
  if (!Number.isFinite(probeDegrees) || probeDegrees < 1 || probeDegrees > 15) throw new Error('Axis probe angle must be between 1 and 15 degrees.');
  const zero: Vector3 = [0, 0, 0];
  const keys: AnimationRecipe['tracks'][number]['keys'] = [{ time: 0, position: zero, rotation: zero }];
  for (const [axisIndex] of axisNames.entries()) {
    const positiveTime = Number((probeStepSeconds + axisIndex * 4 * probeStepSeconds).toFixed(6));
    const positive: Vector3 = [0, 0, 0];
    positive[axisIndex] = probeDegrees;
    const negative: Vector3 = [0, 0, 0];
    negative[axisIndex] = -probeDegrees;
    keys.push(
      { time: positiveTime, position: zero, rotation: positive },
      { time: Number((positiveTime + probeStepSeconds).toFixed(6)), position: zero, rotation: zero },
      { time: Number((positiveTime + 2 * probeStepSeconds).toFixed(6)), position: zero, rotation: negative },
      { time: Number((positiveTime + 3 * probeStepSeconds).toFixed(6)), position: zero, rotation: zero },
    );
  }
  return animationSchema.parse({ kind: 'animation', name: 'Motion Tools Axis Probe', duration: probeDuration,
    loop: false, markers: [], tracks: [{ joint, keys }] });
}

export type AxisProbeSuggestionEvidence = {
  rigId: string;
  rigSignature: string | null;
  joint: string;
  calibrationStatus: 'locally_consistent' | 'review_required' | 'no_measurable_rotation_response';
  axes: { inputAxis: 'x' | 'y' | 'z'; responseDiagnostics: { status: 'usable_local_response' | 'unresponsive' | 'asymmetric_or_coupled' } }[];
  localRotationResponseJacobian: number[][];
};

function solveThreeByThree(matrix: number[][], vector: Vector3): Vector3 {
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    if (Math.abs(augmented[pivot]![column]!) < 1e-6) throw new Error('The measured axis response is rank-deficient; no reliable 3D rotation suggestion can be computed.');
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let index = column; index < 4; index++) augmented[column]![index] = augmented[column]![index]! / divisor;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let index = column; index < 4; index++) augmented[row]![index] = augmented[row]![index]! - factor * augmented[column]![index]!;
    }
  }
  return [augmented[0]![3]!, augmented[1]![3]!, augmented[2]![3]!];
}

/** Solves a small local angular change through the measured Jacobian; never edits a recipe or rig. */
export function suggestLocalRotationFromAxisProbe(evidence: AxisProbeSuggestionEvidence, desiredRotationVectorDegrees: Vector3) {
  if (evidence.calibrationStatus !== 'locally_consistent' || evidence.axes.length !== 3
    || evidence.axes.some((axis, index) => axis.inputAxis !== axisNames[index] || axis.responseDiagnostics.status !== 'usable_local_response')) {
    throw new Error('Local rotation suggestion requires a locally consistent three-axis probe; rerun or review the axis probe first.');
  }
  if (desiredRotationVectorDegrees.some(value => !Number.isFinite(value) || Math.abs(value) > 15) || magnitude(desiredRotationVectorDegrees) > 15) {
    throw new Error('Requested local angular change must be finite and no greater than 15 degrees per component or in total.');
  }
  const matrix = evidence.localRotationResponseJacobian;
  if (matrix.length !== 3 || matrix.some(row => row.length !== 3 || row.some(value => !Number.isFinite(value) || Math.abs(value) > 10))) {
    throw new Error('Axis probe response Jacobian must be a finite, bounded 3×3 matrix.');
  }
  const rowNorm = (rows: number[][]) => Math.max(...rows.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  const inverseColumns = [0, 1, 2].map(column => solveThreeByThree(matrix, [Number(column === 0), Number(column === 1), Number(column === 2)]));
  const inverseRows = [0, 1, 2].map(row => inverseColumns.map(column => column[row]!));
  const conditionEstimateInfinity = rowNorm(matrix) * rowNorm(inverseRows);
  if (!Number.isFinite(conditionEstimateInfinity) || conditionEstimateInfinity > 50) {
    throw new Error(`Measured axis response is ill-conditioned (estimated infinity condition ${conditionEstimateInfinity.toFixed(2)}); no suggestion was produced.`);
  }
  const rawRotation = solveThreeByThree(matrix, desiredRotationVectorDegrees);
  if (rawRotation.some(value => !Number.isFinite(value) || Math.abs(value) > 15) || magnitude(rawRotation) > 15) {
    throw new Error('Requested change would require extrapolating beyond the 15-degree local probe envelope; use a smaller step and resample.');
  }
  const localEulerRotationDegrees = rawRotation.map(value => Number(value.toFixed(4))) as Vector3;
  const predictedRotationVectorDegrees = matrix.map(row => row.reduce((sum, value, index) => sum + value * localEulerRotationDegrees[index]!, 0)) as Vector3;
  return { status: 'suggestion_only' as const, rigId: evidence.rigId, rigSignature: evidence.rigSignature, joint: evidence.joint,
    desiredRotationVectorDegrees, localEulerRotationDegrees, predictedRotationVectorDegrees,
    residualDegrees: magnitude(subtract(predictedRotationVectorDegrees, desiredRotationVectorDegrees)), conditionEstimateInfinity,
    limitations: ['This solves only the measured near-rest local angular response; it does not target a world-space hand/foot position, solve a limb chain, or account for simultaneous changes on other joints.',
      'The result is a preview suggestion, not a recipe edit or rig mutation. Apply it only through normal preview/evaluation, then inspect visually.'] };
}

function multiplyQuaternion(left: Quaternion, right: Quaternion): Quaternion {
  const [x, y, z, w] = left, [a, b, c, d] = right;
  return [w * a + x * d + y * c - z * b, w * b - x * c + y * d + z * a,
    w * c + x * b - y * a + z * d, w * d - x * a - y * b - z * c];
}

function inverseQuaternion(value: Quaternion): Quaternion {
  const lengthSquared = value.reduce((sum, component) => sum + component * component, 0);
  if (lengthSquared < 1e-12) throw new Error('Studio returned a degenerate orientation quaternion for the axis probe.');
  return [-value[0] / lengthSquared, -value[1] / lengthSquared, -value[2] / lengthSquared, value[3] / lengthSquared];
}

function rotationVectorDegrees(value: Quaternion): { axis: Vector3; angleDegrees: number } {
  const length = Math.hypot(...value);
  if (length < 1e-9) throw new Error('Studio returned a degenerate orientation delta for the axis probe.');
  let [x, y, z, w] = value.map(component => component / length) as Quaternion;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const vectorLength = Math.hypot(x, y, z);
  if (vectorLength < 1e-9) return { axis: [0, 0, 0], angleDegrees: 0 };
  return { axis: [x / vectorLength, y / vectorLength, z / vectorLength], angleDegrees: 2 * Math.atan2(vectorLength, Math.max(-1, Math.min(1, w))) * 180 / Math.PI };
}

function distance(left: Vector3, right: Vector3) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}
function subtract(left: Vector3, right: Vector3): Vector3 { return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]; }
function add(left: Vector3, right: Vector3): Vector3 { return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]; }
function scale(value: Vector3, factor: number): Vector3 { return [value[0] * factor, value[1] * factor, value[2] * factor]; }
function rotationVector(value: { axis: Vector3; angleDegrees: number }): Vector3 { return scale(value.axis, value.angleDegrees); }
function magnitude(value: Vector3): number { return Math.hypot(...value); }

function descendantIndices(nodes: Telemetry['nodes'], ancestorIndex: number) {
  const result: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    let parent = nodes[index]!.parent;
    const visited = new Set<number>();
    while (parent > 0 && !visited.has(parent)) {
      if (parent - 1 === ancestorIndex) { result.push(index); break; }
      visited.add(parent);
      parent = nodes[parent - 1]?.parent ?? 0;
    }
  }
  return result;
}

/** Interprets Studio's measured world-pivot orientations and descendant displacement for each local Euler pulse. */
export function analyzeRigAxisProbe(telemetryInput: Telemetry, jointName: string, probeDegrees: number) {
  const telemetry = telemetrySchema.parse(telemetryInput);
  if (!Number.isFinite(probeDegrees) || probeDegrees < 1 || probeDegrees > 15) throw new Error('Axis probe angle must be between 1 and 15 degrees.');
  const jointIndex = telemetry.nodes.findIndex(node => node.name === jointName);
  if (jointIndex < 0 || !telemetry.nodes[jointIndex]!.driven) throw new Error(`Axis probe target ${jointName} is not an exact driven joint in the sampled rig.`);
  const baseline = telemetry.samples.find(sample => sample.time === 0);
  if (!baseline?.orientations || !baseline.jointPoints) throw new Error('Studio axis-probe telemetry needs zero-input baseline orientations and joint-pivot positions.');
  const neutralOrientation = baseline.orientations[jointIndex] as Quaternion;
  const descendants = descendantIndices(telemetry.nodes, jointIndex);
  const times = axisNames.map((_, axisIndex) => ({
    positive: Number((probeStepSeconds + axisIndex * 4 * probeStepSeconds).toFixed(6)),
    negative: Number((probeStepSeconds + (axisIndex * 4 + 2) * probeStepSeconds).toFixed(6)),
  }));
  const sampleAt = (time: number) => {
    const sample = telemetry.samples.find(candidate => Math.abs(candidate.time - time) < 0.000001);
    if (!sample?.orientations || !sample.jointPoints) throw new Error(`Studio axis-probe sample at ${time}s is missing orientation or joint-position telemetry.`);
    return sample;
  };
  const frame = (time: number) => {
    const sample = sampleAt(time);
    const current = sample.orientations![jointIndex] as Quaternion;
    const worldPivotDelta = multiplyQuaternion(current, inverseQuaternion(neutralOrientation));
    const jointRestDelta = multiplyQuaternion(inverseQuaternion(neutralOrientation), current);
    const worldPivot = rotationVectorDegrees(worldPivotDelta);
    const jointRest = rotationVectorDegrees(jointRestDelta);
    const movedDescendants = descendants.map(index => {
      const displacementVectorStuds = subtract(sample.jointPoints![index] as Vector3, baseline.jointPoints![index] as Vector3);
      return { joint: telemetry.nodes[index]!.name, displacementVectorStuds, displacementStuds: distance(sample.jointPoints![index] as Vector3, baseline.jointPoints![index] as Vector3) };
    })
      .sort((left, right) => right.displacementStuds - left.displacementStuds || left.joint.localeCompare(right.joint));
    return { time, measuredWorldRotationInRigPivot: worldPivot, measuredRelativeRotationInJointFrame: jointRest,
      maximumDescendantDisplacementStuds: movedDescendants[0]?.displacementStuds ?? 0,
      mostMovedDescendants: movedDescendants.slice(0, 8), _allDescendantDisplacements: movedDescendants };
  };
  const axes = axisNames.map((axis, index) => {
    const positive = frame(times[index]!.positive), negative = frame(times[index]!.negative);
    const { _allDescendantDisplacements: positiveDisplacements, ...positiveEvidence } = positive;
    const { _allDescendantDisplacements: negativeDisplacements, ...negativeEvidence } = negative;
    const positiveRotation = rotationVector(positive.measuredRelativeRotationInJointFrame);
    const negativeRotation = rotationVector(negative.measuredRelativeRotationInJointFrame);
    const centralRotationResponse = scale(subtract(positiveRotation, negativeRotation), 1 / (2 * probeDegrees));
    const oddSymmetryErrorDegrees = scale(add(positiveRotation, negativeRotation), 0.5);
    const responseGainDegreesPerInputDegree = magnitude(centralRotationResponse);
    const oddSymmetryErrorRatio = magnitude(oddSymmetryErrorDegrees) / Math.max(responseGainDegreesPerInputDegree * probeDegrees, 1e-6);
    const responseStatus: 'unresponsive' | 'asymmetric_or_coupled' | 'usable_local_response' = responseGainDegreesPerInputDegree < 0.05 ? 'unresponsive'
      : oddSymmetryErrorRatio > 0.15 ? 'asymmetric_or_coupled' : 'usable_local_response';
    const movedByName = new Map<string, { positive: Vector3; negative: Vector3 }>();
    for (const moved of positiveDisplacements) movedByName.set(moved.joint, { positive: moved.displacementVectorStuds, negative: [0, 0, 0] });
    for (const moved of negativeDisplacements) {
      const entry = movedByName.get(moved.joint) ?? { positive: [0, 0, 0] as Vector3, negative: [0, 0, 0] as Vector3 };
      entry.negative = moved.displacementVectorStuds;
      movedByName.set(moved.joint, entry);
    }
    const descendantResponses = [...movedByName].map(([joint, pair]) => ({ joint,
      displacementResponseStudsPerInputDegree: scale(subtract(pair.positive, pair.negative), 1 / (2 * probeDegrees)),
      evenDisplacementStuds: scale(add(pair.positive, pair.negative), 0.5),
    })).sort((left, right) => Math.hypot(...right.displacementResponseStudsPerInputDegree) - Math.hypot(...left.displacementResponseStudsPerInputDegree) || left.joint.localeCompare(right.joint));
    return { inputAxis: axis, inputAngleDegrees: probeDegrees, positive: positiveEvidence, negative: negativeEvidence,
      responseDiagnostics: { status: responseStatus, responseGainDegreesPerInputDegree, oddSymmetryErrorRatio,
        guidance: responseStatus === 'unresponsive' ? 'The measured angular response is near the telemetry resolution; do not infer a useful axis mapping from this probe.'
          : responseStatus === 'asymmetric_or_coupled' ? 'Positive and negative pulses disagree beyond the local symmetry threshold; treat this finite-difference column as uncertain and inspect the rig/pose before using it.'
            : 'The measured positive/negative response is locally consistent around rest; it is still only a near-rest approximation.' },
      localRotationResponseDegreesPerInputDegree: centralRotationResponse,
      localRotationOddSymmetryErrorDegrees: oddSymmetryErrorDegrees,
      mostResponsiveDescendants: descendantResponses.slice(0, 8),
      limitations: ['Responses are measured on a detached Studio rig clone using this exact current topology. They describe small local Euler pulses, not anatomy, safe range, or artistic quality.',
        'Descendant displacement is sampled joint-pivot motion; it is not mesh deformation, collision, contact, or rendered silhouette.'] };
  });
  const localRotationResponseJacobian = [0, 1, 2].map(outputAxis => axes.map(axis => axis.localRotationResponseDegreesPerInputDegree[outputAxis]!));
  const calibrationStatus: 'locally_consistent' | 'review_required' | 'no_measurable_rotation_response' = axes.every(axis => axis.responseDiagnostics.status === 'usable_local_response') ? 'locally_consistent'
    : axes.every(axis => axis.responseDiagnostics.status === 'unresponsive') ? 'no_measurable_rotation_response' : 'review_required';
  return { status: 'measured' as const, rigId: telemetry.rigId, rigSignature: telemetry.rigSignature ?? null,
    joint: jointName, probeDegrees, sampleCount: telemetry.samples.length, calibrationStatus, axes, localRotationResponseJacobian,
    responseJacobianInterpretation: 'Rows are measured zero-input recipe-baseline-relative angular-vector X/Y/Z degrees; columns are recipe local Euler input X/Y/Z degrees. The baseline is the detached clone sampled at time zero, not the original rig rest orientation. This is a central finite difference around that zero-input pose, not a global or nonlinear inverse solver.',
    coordinateFrames: { measuredWorldRotationInRigPivot: 'rig-pivot-local', measuredRelativeRotationInJointFrame: 'zero-input recipe baseline relative',
      displacementVectors: 'rig-pivot-local studs from the baseline joint pivot', input: 'recipe local XYZ Euler degrees' },
    limitations: ['This is a finite-difference probe around the detached clone’s zero-input recipe pose; it does not use or characterize the original rig’s potentially posed rest orientation, and response may differ at a posed configuration.',
      'Use the measured vectors to form an initial hypothesis, then visually inspect the result on the target rig. No pose was saved or applied to the editor.'] };
}
