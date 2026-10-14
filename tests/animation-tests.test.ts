import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { animationPreset } from '../src/recipes.js';
import { auditAnimation } from '../src/animation-quality.js';
import { fingerprint, inspectMotion, telemetrySchema } from '../src/inspection.js';
import { animationTestCaseSchema, buildContactRegressionContract, evaluateAnimationTestCase, suggestAnimationTestCase } from '../src/animation-tests.js';

function fixture() {
  const recipe = animationPreset('walk', 'Contract walk', 2, 1);
  recipe.markers = [{ name: 'Plant', time: 0.5 }];
  recipe.tracks.push({ joint: 'LeftFoot', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.5, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0.1, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] });
  recipe.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 }];
  const telemetry = telemetrySchema.parse({
    version: 1 as const, source: 'studio_pose_evaluator' as const, rigId: randomUUID(), assetId: randomUUID(), duration: 2, loop: true,
    height: 5, groundSource: 'rest_node_bounds' as const, note: 'test',
    nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'LeftFoot', parent: 1, driven: true, foot: true }],
    samples: [0, 0.5, 1, 1.5, 2].map((time, index) => ({ id: `s${String(index).padStart(3, '0')}`, time,
      points: [[0, 0, 0], [time < 1 ? 0 : 0.1, 0, 0]], bottoms: [0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1]] })),
  });
  return { recipe, telemetry };
}

test('explicit composed-loop pose limits detect endpoint jumps independently from velocity continuity', () => {
  const recipe = animationPreset('idle', 'Loop contract', 1, 1);
  recipe.loop = true;
  recipe.tracks = [{ joint: 'Head', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [1, 0, 0], rotation: [0, 90, 0] },
  ] }];
  const criteria = { assetId: randomUUID(), loop: true,
    maxLoopComposedPositionOffsetStuds: 0.5, maxLoopComposedAngularOffsetDegrees: 45 };
  const audit = auditAnimation(recipe), studio = inspectMotion(recipe).report;
  const result = evaluateAnimationTestCase(recipe, criteria, audit, studio);
  assert.equal(result.checks.find(check => check.id === 'max_loop_composed_position_offset')?.status, 'failed');
  assert.equal(result.checks.find(check => check.id === 'max_loop_composed_angular_offset')?.status, 'failed');
  const allowed = evaluateAnimationTestCase(recipe, { ...criteria, maxLoopComposedPositionOffsetStuds: 1,
    maxLoopComposedAngularOffsetDegrees: 90.000001 }, audit, studio);
  assert.equal(allowed.checks.find(check => check.id === 'max_loop_composed_position_offset')?.status, 'passed');
  assert.equal(allowed.checks.find(check => check.id === 'max_loop_composed_angular_offset')?.status, 'passed');
  const missing = evaluateAnimationTestCase(recipe, criteria, { ...audit, composedLoopSeam: [] }, studio);
  assert.equal(missing.checks.find(check => check.id === 'max_loop_composed_position_offset')?.status, 'unknown');
  assert.throws(() => animationTestCaseSchema.parse({ ...criteria, loop: false }), /require loop: true/);
});

test('joint-specific loop limits allow intentional root travel and keep missing or differently cased joints unknown', () => {
  const recipe = animationPreset('idle', 'Traveling loop', 1, 1);
  recipe.loop = true;
  recipe.tracks = [{ joint: 'Head', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 15, 0] },
  ] }];
  recipe.rootMotion = { joint: 'HumanoidRootPart', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [4, 0, 0], rotation: [0, 0, 0] },
  ] };
  const criteria = { assetId: randomUUID(), loop: true, jointLoopLimits: [
    { joint: 'Head', maxPositionOffsetStuds: 0, maxAngularOffsetDegrees: 5 },
    { joint: 'head', maxPositionOffsetStuds: 0 },
  ] };
  assert.throws(() => animationTestCaseSchema.parse(criteria), /unique joint names/);
  const valid = { ...criteria, jointLoopLimits: [criteria.jointLoopLimits[0]!, { joint: 'LeftFoot', maxPositionOffsetStuds: 0 }] };
  const audit = auditAnimation(recipe), studio = inspectMotion(recipe).report;
  const result = evaluateAnimationTestCase(recipe, valid, audit, studio);
  assert.equal(result.checks.find(check => check.id === 'loop-joint:Head:position')?.status, 'passed');
  assert.equal(result.checks.find(check => check.id === 'loop-joint:Head:angular')?.status, 'failed');
  assert.equal(result.checks.find(check => check.id === 'loop-joint:LeftFoot:position')?.status, 'unknown');
  assert.ok(!result.checks.some(check => check.id.includes('HumanoidRootPart')), 'unrequested root limits must not be invented');
  const differentCase = evaluateAnimationTestCase(recipe, { ...criteria, jointLoopLimits: [criteria.jointLoopLimits[1]!] }, audit, studio);
  assert.equal(differentCase.checks.find(check => check.id === 'loop-joint:head:position')?.status, 'unknown');
  assert.throws(() => animationTestCaseSchema.parse({ ...valid, loop: false }), /require loop: true/);
  assert.throws(() => animationTestCaseSchema.parse({ ...valid, jointLoopLimits: [{ joint: 'Head' }] }), /at least one endpoint limit/);
});

test('test-case suggestions derive only authored facts and never fabricate contact tolerances', () => {
  const { recipe } = fixture();
  recipe.markers.push({ name: 'plant', time: 1.25 }, { name: 'Release', time: 1.75 });
  recipe.layers = [{ id: randomUUID(), name: 'Secondary', blendMode: 'Additive', weight: 0.5, enabled: true,
    tracks: [{ joint: 'LeftFoot', keys: recipe.tracks.find(track => track.joint === 'LeftFoot')!.keys }] }];
  const suggestion = suggestAnimationTestCase(randomUUID(), recipe, 'stationary');
  assert.deepEqual(suggestion.testCase.duration, { min: 2, max: 2 });
  assert.equal(suggestion.testCase.loop, true);
  assert.deepEqual(suggestion.testCase.requiredMarkers, ['Plant', 'Release'], 'case-insensitive duplicate marker labels collapse deterministically');
  assert.deepEqual(suggestion.testCase.requiredTracks, ['LeftFoot', ...recipe.tracks.filter(track => track.joint.toLowerCase() !== 'leftfoot').map(track => track.joint)]);
  assert.deepEqual(suggestion.prioritizedTrackNames, ['LeftFoot']);
  assert.deepEqual(suggestion.testCase.contacts, [], 'contact thresholds are never guessed from declared windows');
  assert.equal(suggestion.contactReviewCandidates.length, 1);
  assert.match(suggestion.contactReviewCandidates[0]!.nextStep, /explicit allowable margin/i);
  assert.equal(suggestion.omitted.markerNames.length, 0);
  assert.equal(suggestion.omitted.trackNames.length, 0);
});

test('test-case suggestions expose every marker and joint omitted by bounded acceptance schemas', () => {
  const { recipe } = fixture();
  recipe.markers = Array.from({ length: 100 }, (_, index) => ({ name: `marker-${index}`, time: 0 }));
  recipe.tracks = Array.from({ length: 256 }, (_, index) => ({ joint: `Joint-${index}`, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: recipe.duration, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] }));
  recipe.rootMotion = { joint: 'RootTravel', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: recipe.duration, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] };
  const suggestion = suggestAnimationTestCase(randomUUID(), recipe, 'unknown');
  assert.equal(suggestion.testCase.requiredMarkers.length, 32);
  assert.deepEqual(suggestion.omitted.markerNames, Array.from({ length: 68 }, (_, index) => `marker-${index + 32}`));
  assert.equal(suggestion.testCase.requiredTracks.length, 256);
  assert.deepEqual(suggestion.prioritizedTrackNames, ['LeftFoot', 'RootTravel']);
  assert.deepEqual(suggestion.omitted.trackNames, ['Joint-254', 'Joint-255']);
});

test('animation acceptance contract combines static requirements with Studio-measured contact limits', () => {
  const { recipe, telemetry } = fixture();
  const testCase = { assetId: randomUUID(), duration: { min: 1.5, max: 2 }, loop: true, requiredMarkers: ['plant'], requiredTracks: ['leftfoot'],
    maxPeakAngularSpeedDegreesPerSecond: 100, contacts: [{ effector: 'leftfoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2, maxSampleGapSeconds: 0.5 }] };
  const structural = auditAnimation(recipe);
  const studio = inspectMotion(recipe, telemetry, 'stationary').report;
  const result = evaluateAnimationTestCase(recipe, testCase, structural, studio, telemetry);
  assert.equal(result.status, 'passed');
  assert.equal(result.summary.total, 6);
  assert.ok(result.checks.every(check => check.status === 'passed'));
  assert.equal(result.checks.find(check => check.id.startsWith('contact:'))?.observed, 0.1);

  const stricter = evaluateAnimationTestCase(recipe, { ...testCase, contacts: [{ ...testCase.contacts[0]!, maxDriftStuds: 0.05 }] }, structural, studio, telemetry);
  assert.equal(stricter.status, 'failed');
  assert.equal(stricter.checks.find(check => check.id.startsWith('contact:'))?.status, 'failed');
  assert.match(stricter.limitation, /does not certify artistic quality/i);

  const subPrecisionDrift = { ...telemetry, samples: telemetry.samples.map(sample => ({
    ...sample,
    points: sample.points.map((point, nodeIndex) => nodeIndex === 1 && sample.time >= 1
      ? [0.10004, point[1], point[2]] as [number, number, number] : point),
  })) };
  const precisionResult = evaluateAnimationTestCase(recipe,
    { ...testCase, contacts: [{ ...testCase.contacts[0]!, maxDriftStuds: 0.10002 }] }, structural,
    inspectMotion(recipe, subPrecisionDrift, 'stationary').report, subPrecisionDrift);
  assert.equal(precisionResult.checks.find(check => check.id.startsWith('contact:'))?.status, 'failed');
  assert.ok(Number(precisionResult.checks.find(check => check.id.startsWith('contact:'))?.observed) > 0.10002);
});

test('contact acceptance requires exact start, midpoint, and end samples even when count and gap limits pass', () => {
  const { recipe, telemetry } = fixture();
  // Four samples satisfy minSamples=3 and the 0.5s gap limit, but none lands at
  // the exact midpoint (1.0s) of this contact window.
  const samples = telemetry.samples.filter(sample => sample.time !== 1);
  samples.push(
    { ...telemetry.samples[0]!, id: 's010', time: 0.75 },
    { ...telemetry.samples[0]!, id: 's011', time: 1.25 },
  );
  const gapCompliantTelemetry = telemetrySchema.parse({ ...telemetry, samples: samples.sort((left, right) => left.time - right.time) });
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5,
    maxDriftStuds: 1, minSamples: 3, maxSampleGapSeconds: 0.5 }] };
  const studio = inspectMotion(recipe, gapCompliantTelemetry, 'stationary').report;
  const result = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), studio, gapCompliantTelemetry);
  const contact = result.checks.find(check => check.id.startsWith('contact:'))!;
  assert.equal(contact.status, 'unknown');
  assert.equal(contact.observed, 'start=true, midpoint=false, end=true');
  assert.equal(contact.expected, 'start=true, midpoint=true, end=true');
  assert.deepEqual(contact.sampleIds, ['s001', 's010', 's011', 's003']);
});

test('contact acceptance can constrain angular drift and fails closed without orientation samples', () => {
  const { recipe, telemetry } = fixture();
  const rotated = { ...telemetry, samples: telemetry.samples.map(sample => ({
    ...sample,
    orientations: sample.orientations!.map((orientation, nodeIndex) => nodeIndex === 1 && sample.time >= 1
      ? [0, 0, Math.sin(10 * Math.PI / 180), Math.cos(10 * Math.PI / 180)] as [number, number, number, number] : orientation),
  })) };
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2, maxAngularDriftDegrees: 10,
    targetOrientation: [0, 0, 0, 1] as [number, number, number, number], maxAngularTargetErrorDegrees: 10, maxSampleGapSeconds: 0.5 }] };
  const rotatedStudio = inspectMotion(recipe, rotated, 'stationary').report;
  const measured = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), rotatedStudio, rotated);
  const angularCheck = measured.checks.find(check => check.id.endsWith(':rotation'))!;
  assert.equal(measured.status, 'failed');
  assert.equal(angularCheck.status, 'failed');
  assert.ok(Number(angularCheck.observed) > 19.9 && Number(angularCheck.observed) < 20.1);
  const orientationTargetCheck = measured.checks.find(check => check.id.endsWith(':orientation-target'))!;
  assert.equal(orientationTargetCheck.status, 'failed');
  assert.deepEqual(orientationTargetCheck.sampleIds, ['s001', 's002', 's003']);

  const withoutOrientations = { ...telemetry, samples: telemetry.samples.map(({ orientations: _orientations, ...sample }) => sample) };
  const noOrientationStudio = inspectMotion(recipe, withoutOrientations, 'stationary').report;
  const unknown = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), noOrientationStudio, withoutOrientations);
  assert.equal(unknown.status, 'incomplete');
  assert.equal(unknown.checks.find(check => check.id.endsWith(':rotation'))?.status, 'unknown');
  assert.equal(unknown.checks.find(check => check.id.endsWith(':orientation-target'))?.status, 'unknown');
});

test('contact acceptance measures cumulative sampled travel and identifies the exact worst adjacent-pose speed segment', () => {
  const { recipe, telemetry } = fixture();
  const times = [0.5, 0.75, 1, 1.25, 1.5];
  const positions = [0, 0.08, 0.16, 0.08, 0];
  const samples = telemetry.samples.filter(sample => sample.time < 0.5 || sample.time > 1.5);
  const contactSamples = times.map((time, index) => ({ ...telemetry.samples[0]!, id: `s${String(index + 10).padStart(3, '0')}`, time,
    points: [[0, 0, 0], [positions[index]!, 0, 0]] as [[number, number, number], [number, number, number]] }));
  const denseTelemetry = telemetrySchema.parse({ ...telemetry, samples: [...samples, ...contactSamples].sort((left, right) => left.time - right.time) });
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5,
    maxDriftStuds: 0.2, maxCumulativeTravelStuds: 0.2, maxStepSpeedStudsPerSecond: 0.3, maxSampleGapSeconds: 0.25 }] };
  const studio = inspectMotion(recipe, denseTelemetry, 'stationary').report;
  const result = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), studio, denseTelemetry);
  const travel = result.checks.find(check => check.id.endsWith(':travel'))!;
  const speed = result.checks.find(check => check.id.endsWith(':step-speed'))!;
  assert.equal(travel.status, 'failed');
  assert.ok(Math.abs(Number(travel.observed) - 0.32) < 1e-8);
  assert.deepEqual(travel.sampleIds, ['s010', 's011', 's012', 's013', 's014']);
  assert.equal(speed.status, 'failed');
  assert.ok(Math.abs(Number(speed.observed) - 0.32) < 1e-8);
  assert.deepEqual(speed.sampleIds, ['s010', 's011']);
  assert.deepEqual(speed.segment, { startTime: 0.5, endTime: 0.75, startSampleId: 's010', endSampleId: 's011', displacementStuds: 0.08 });
  assert.match(speed.detail, /0\.5–0\.75s \(s010 → s011\)/);
});

test('contact regression contract derives explicit limits from measured baseline plus caller margins', () => {
  const { recipe, telemetry } = fixture();
  const result = buildContactRegressionContract(randomUUID(), 'same-rig-topology', recipe, [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5,
    allowedDriftIncreaseStuds: 0.05, allowedTravelIncreaseStuds: 0.1, allowedStepSpeedIncreaseStudsPerSecond: 0.2,
    minSamples: 3, maxSampleGapSeconds: 0.5 }], auditAnimation(recipe), inspectMotion(recipe, telemetry, 'stationary').report, telemetry);
  assert.equal(result.testCase.contacts[0]!.maxDriftStuds, 0.15000000000000002);
  assert.equal(result.testCase.contacts[0]!.maxCumulativeTravelStuds, 0.2);
  assert.equal(result.testCase.contacts[0]!.maxStepSpeedStudsPerSecond, 0.4);
  assert.equal(result.baseline.fingerprint, fingerprint(recipe));
  assert.equal(result.baseline.rigSignature, 'same-rig-topology');
  assert.equal(result.baseline.contacts[0]!.driftStuds, 0.1);
  assert.equal(result.baseline.contacts[0]!.worstSegment?.startSampleId, 's001');
  assert.match(result.limitation, /does not certify that baseline/i);

  const sparse = { ...telemetry, samples: [telemetry.samples[0]!, telemetry.samples.at(-1)!] };
  assert.throws(() => buildContactRegressionContract(randomUUID(), 'same-rig-topology', recipe,
    [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, allowedDriftIncreaseStuds: 0.05 }], auditAnimation(recipe), inspectMotion(recipe, sparse).report, sparse), /incomplete baseline evidence/i);
});

test('support contracts constrain sole height and grip contracts can constrain pivot-local target regions', () => {
  const { recipe, telemetry } = fixture();
  const contactTelemetry = { ...telemetry, samples: telemetry.samples.map(sample => ({
    ...sample,
    pivotPoints: structuredClone(sample.points),
    bottoms: sample.bottoms.map((bottom, nodeIndex) => nodeIndex === 1 && sample.time >= 1 ? 0.2 : bottom),
  })) };
  const supportCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5,
    maxDriftStuds: 0.2, maxGroundOffsetStuds: 0.1, targetPosition: [0, 0, 0], maxTargetDistanceStuds: 0.2, maxSampleGapSeconds: 0.5 }] };
  const studio = inspectMotion(recipe, contactTelemetry, 'stationary').report;
  const support = evaluateAnimationTestCase(recipe, supportCase, auditAnimation(recipe), studio, contactTelemetry);
  const groundCheck = support.checks.find(check => check.id.endsWith(':ground'))!;
  const targetCheck = support.checks.find(check => check.id.endsWith(':target'))!;
  assert.equal(groundCheck.status, 'failed');
  assert.equal(targetCheck.status, 'passed');
  assert.deepEqual(groundCheck.sampleIds, ['s001', 's002', 's003']);
  assert.deepEqual(targetCheck.sampleIds, ['s001', 's002', 's003']);

  const outsideTarget = evaluateAnimationTestCase(recipe, { ...supportCase, contacts: [{ ...supportCase.contacts[0]!,
    maxGroundOffsetStuds: 0.3, targetPosition: [0.2, 0, 0], maxTargetDistanceStuds: 0.05 }] }, auditAnimation(recipe), studio, contactTelemetry);
  assert.equal(outsideTarget.checks.find(check => check.id.endsWith(':ground'))?.status, 'passed');
  assert.equal(outsideTarget.checks.find(check => check.id.endsWith(':target'))?.status, 'failed');

  const legacyTelemetry = { ...telemetry, samples: telemetry.samples.map(({ pivotPoints: _pivotPoints, ...sample }) => sample) };
  const noPivot = evaluateAnimationTestCase(recipe, supportCase, auditAnimation(recipe), inspectMotion(recipe, legacyTelemetry).report, legacyTelemetry);
  assert.equal(noPivot.checks.find(check => check.id.endsWith(':target'))?.status, 'unknown');
  assert.throws(() => animationTestCaseSchema.parse({ assetId: randomUUID(), contacts: [{ ...supportCase.contacts[0]!, targetPosition: undefined }] }), /must be supplied together/i);
  assert.throws(() => animationTestCaseSchema.parse({ assetId: randomUUID(), contacts: [{ ...supportCase.contacts[0]!, kind: 'grip' }] }), /only to support contacts/i);
});

test('bend-plane acceptance measures elbow/knee pole direction from sampled joint pivots and fails closed', () => {
  const { recipe, telemetry } = fixture();
  const chain = {
    nodes: [
      { name: 'UpperArm', parent: 0, driven: true, foot: false },
      { name: 'LowerArm', parent: 1, driven: true, foot: false },
      { name: 'Hand', parent: 2, driven: true, foot: false },
    ],
    restPose: undefined,
  };
  const withBend = (middlePoint: [number, number, number]) => telemetrySchema.parse({ ...telemetry, ...chain,
    restPose: undefined,
    samples: telemetry.samples.map(sample => ({ ...sample,
      points: [[0, 0, 0], middlePoint, [2, 0, 0]], pivotPoints: [[0, 0, 0], middlePoint, [2, 0, 0]],
      bottoms: [0, 0, 0], orientations: [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]],
      jointPoints: [[0, 0, 0], middlePoint, [2, 0, 0]],
    })),
  });
  const requirement = { rootJoint: 'UpperArm', middleJoint: 'LowerArm', effector: 'Hand', start: 0.5, end: 1.5,
    poleTarget: [0, 3, 0] as [number, number, number], maxDeviationDegrees: 5, minSamples: 3, maxSampleGapSeconds: 0.5 };
  const criteria = { assetId: randomUUID(), bendPlanes: [requirement] };
  const evaluate = (sampled: ReturnType<typeof withBend>, testCase: typeof criteria = criteria) => evaluateAnimationTestCase(
    recipe, testCase, auditAnimation(recipe), inspectMotion(recipe, sampled, 'stationary').report, sampled,
  );

  const pass = evaluate(withBend([0, 1, 0]));
  assert.equal(pass.status, 'passed');
  assert.equal(pass.checks[0]!.id, 'bend-plane:Hand:1');
  assert.equal(pass.checks[0]!.observed, 0);
  assert.deepEqual(pass.checks[0]!.sampleIds, ['s001', 's002', 's003']);

  const opposite = evaluate(withBend([0, -1, 0]));
  assert.equal(opposite.checks[0]!.status, 'failed');
  assert.equal(opposite.checks[0]!.observed, 180);

  const straight = evaluate(withBend([1, 0, 0]));
  assert.equal(straight.checks[0]!.status, 'unknown', 'collinear limb geometry has no measurable bend plane');
  const sparse = evaluate(withBend([0, 1, 0]), { ...criteria, bendPlanes: [{ ...requirement, maxSampleGapSeconds: 0.25 }] });
  assert.equal(sparse.checks[0]!.status, 'unknown');

  const measured = withBend([0, 1, 0]);
  const legacy = telemetrySchema.parse({ ...measured, samples: measured.samples.map(({ jointPoints: _jointPoints, ...sample }) => sample) });
  assert.equal(evaluate(legacy).checks[0]!.status, 'unknown');
  const wrongParent = telemetrySchema.parse({ ...withBend([0, 1, 0]), nodes: [chain.nodes[0], { ...chain.nodes[1], parent: 0 }, chain.nodes[2]] });
  assert.equal(evaluate(wrongParent).checks[0]!.status, 'failed');
  assert.throws(() => animationTestCaseSchema.parse({ assetId: randomUUID(), bendPlanes: [{ ...requirement, effector: 'UpperArm' }] }), /three distinct names/i);
});

test('missing Studio telemetry makes sampled acceptance criteria unknown, not passed', () => {
  const { recipe } = fixture();
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2 }] };
  const result = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), inspectMotion(recipe).report);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.checks[0]!.status, 'unknown');
});

test('contact acceptance requires the exact declared window and excludes nearby outside samples', () => {
  const { recipe, telemetry } = fixture();
  const criteria = auditAnimation(recipe);
  const mismatch = evaluateAnimationTestCase(recipe,
    { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.50005, end: 1.5, maxDriftStuds: 0.2 }] },
    criteria, inspectMotion(recipe, telemetry).report, telemetry);
  assert.equal(mismatch.checks[0]!.status, 'failed');
  assert.match(mismatch.checks[0]!.detail, /contact window is not declared/i,
    'a 50 µs interval mismatch must not bind to the recipe contact');

  const nearBoundaryTelemetry = { ...telemetry, samples: [
    ...telemetry.samples.filter(sample => sample.time === 0 || sample.time === 2),
    ...[0.4999995, 1, 1.5000005].map((time, index) => ({ ...telemetry.samples[2]!, id: `s00${index + 1}`, time })),
  ].sort((left, right) => left.time - right.time) };
  const nearBoundary = evaluateAnimationTestCase(recipe,
    { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2 }] },
    criteria, inspectMotion(recipe, nearBoundaryTelemetry).report, nearBoundaryTelemetry);
  assert.equal(nearBoundary.checks[0]!.status, 'unknown');
  assert.match(nearBoundary.checks[0]!.detail, /only 1 poses inside the contact window/i,
    'samples half a microsecond outside both ends must not satisfy the minimum sample count');
});

test('contact contracts fail closed when the interval is undersampled or sample spacing is too wide', () => {
  const { recipe, telemetry } = fixture();
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2 }] };
  const sparseTelemetry = { ...telemetry, samples: [telemetry.samples[0]!, telemetry.samples.at(-1)!] };
  const sparseStudio = inspectMotion(recipe, sparseTelemetry, 'stationary').report;
  const sparse = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), sparseStudio, sparseTelemetry);
  assert.equal(sparse.status, 'incomplete');
  assert.match(sparse.checks[0]!.detail, /only 0 poses inside the contact window/i);

  const denseButWide = evaluateAnimationTestCase(recipe, { ...testCase, contacts: [{ ...testCase.contacts[0]!, maxSampleGapSeconds: 0.1 }] }, auditAnimation(recipe), inspectMotion(recipe, telemetry, 'stationary').report, telemetry);
  assert.equal(denseButWide.status, 'incomplete');
  assert.match(denseButWide.checks[0]!.detail, /sample coverage of the contact window is too sparse/i);

  const missingBoundarySamples = { ...telemetry, samples: [
    ...telemetry.samples.filter(sample => sample.time === 0 || sample.time === 2),
    ...[0.8, 1, 1.2].map((time, index) => ({ ...telemetry.samples[2]!, id: `s00${index + 1}`, time })),
  ].sort((left, right) => left.time - right.time) };
  const boundaryStudio = inspectMotion(recipe, missingBoundarySamples, 'stationary').report;
  const boundaryGap = evaluateAnimationTestCase(recipe, { ...testCase, contacts: [{ ...testCase.contacts[0]!, maxSampleGapSeconds: 0.25 }] }, auditAnimation(recipe), boundaryStudio, missingBoundarySamples);
  assert.equal(boundaryGap.status, 'incomplete');
  assert.ok(Math.abs(Number(boundaryGap.checks[0]!.observed) - 0.3) < 1e-8);
  assert.match(boundaryGap.checks[0]!.detail, /including both boundaries/i);
});

test('contact checks require a driven sampled effector and resolve mapped effector names', () => {
  const { recipe, telemetry } = fixture();
  const testCase = { assetId: randomUUID(), contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2, maxSampleGapSeconds: 0.5 }] };
  const nonDriven = { ...telemetry, nodes: telemetry.nodes.map(node => node.name === 'LeftFoot' ? { ...node, driven: false } : node) };
  const rejected = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), inspectMotion(recipe, nonDriven).report, nonDriven);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.checks[0]!.detail, /does not resolve to a driven joint/i);

  const mappedTelemetry = { ...telemetry, nodes: telemetry.nodes.map(node => node.name === 'LeftFoot' ? { ...node, name: 'Foot_L' } : node) };
  const mappedRecipe = { ...recipe, contacts: recipe.contacts!.map(contact => ({ ...contact, effector: 'Foot_L' })) };
  const mappedStudio = inspectMotion(mappedRecipe, mappedTelemetry).report;
  const accepted = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), mappedStudio, mappedTelemetry, { LeftFoot: 'Foot_L' });
  assert.equal(accepted.status, 'passed');
  assert.match(accepted.checks[0]!.detail, /Joint: Foot_L/i);

  const lowerCaseRequirement = evaluateAnimationTestCase(recipe,
    { assetId: randomUUID(), contacts: [{ ...testCase.contacts[0]!, effector: 'leftfoot' }] }, auditAnimation(recipe), mappedStudio, mappedTelemetry, { LeftFoot: 'Foot_L' });
  assert.equal(lowerCaseRequirement.status, 'passed', 'jointMap source names resolve case-insensitively, matching track/contact name validation');

  const ambiguousMap = evaluateAnimationTestCase(recipe,
    { assetId: randomUUID(), contacts: [{ ...testCase.contacts[0]!, effector: 'leftfoot' }] }, auditAnimation(recipe), mappedStudio, mappedTelemetry,
    { LeftFoot: 'Foot_L', leftfoot: 'OtherFoot' });
  assert.equal(ambiguousMap.status, 'failed');
  assert.match(ambiguousMap.checks[0]!.detail, /multiple case-insensitive jointMap entries/i);
});

test('required animation tracks need evidence of a driven joint on the sampled rig and honor explicit mappings', () => {
  const { recipe, telemetry } = fixture();
  const testCase = { assetId: randomUUID(), requiredTracks: ['LeftFoot'] };
  const structural = auditAnimation(recipe);
  const studio = inspectMotion(recipe, telemetry).report;
  const missingTarget = { ...telemetry, nodes: telemetry.nodes.map(node => ({ ...node, driven: false })) };
  const missing = evaluateAnimationTestCase(recipe, testCase, structural, studio, missingTarget);
  assert.equal(missing.status, 'failed');
  assert.match(missing.checks[0]!.detail, /does not map to a driven target joint/i);

  const mappedRecipe = { ...recipe, tracks: recipe.tracks.map(track => track.joint === 'LeftFoot' ? { ...track, joint: 'Foot_L' } : track) };
  const mapped = evaluateAnimationTestCase(mappedRecipe, { assetId: randomUUID(), requiredTracks: ['Foot_L'] }, auditAnimation(mappedRecipe), studio, telemetry, { Foot_L: 'LeftFoot' });
  assert.equal(mapped.status, 'passed');
  assert.match(mapped.checks[0]!.detail, /maps to driven target joint LeftFoot/i);

  const caseInsensitiveMap = evaluateAnimationTestCase(recipe, { assetId: randomUUID(), requiredTracks: ['leftfoot'] }, structural, studio, telemetry, { LeftFoot: 'LeftFoot' });
  assert.equal(caseInsensitiveMap.status, 'passed');

  const ambiguousMap = evaluateAnimationTestCase(recipe, { assetId: randomUUID(), requiredTracks: ['leftfoot'] }, structural, studio, telemetry,
    { LeftFoot: 'LeftFoot', leftfoot: 'DifferentFoot' });
  assert.equal(ambiguousMap.status, 'failed');
  assert.match(ambiguousMap.checks[0]!.detail, /multiple case-insensitive jointMap entries/i);

  const collidingTelemetry = telemetrySchema.parse({ ...telemetry,
    nodes: [...telemetry.nodes, { ...telemetry.nodes[1]!, name: 'leftfoot', parent: 1 }],
    samples: telemetry.samples.map(sample => ({ ...sample,
      points: [...sample.points, sample.points[1]!], bottoms: [...sample.bottoms, sample.bottoms[1]!],
      ...(sample.orientations ? { orientations: [...sample.orientations, sample.orientations[1]!] } : {}),
    })),
  });
  const exactCollision = evaluateAnimationTestCase(recipe, testCase, structural, studio, collidingTelemetry);
  assert.equal(exactCollision.checks[0]!.status, 'passed', 'an exact name must remain valid even if another node differs only by case');
  const ambiguousRigName = evaluateAnimationTestCase(recipe, { assetId: randomUUID(), requiredTracks: ['LEFTFOOT'] }, structural, studio, collidingTelemetry);
  assert.equal(ambiguousRigName.checks[0]!.status, 'failed');
  assert.match(ambiguousRigName.checks[0]!.detail, /ambiguous case-insensitive rig joints.*LeftFoot, leftfoot/i);
  const ambiguousContact = evaluateAnimationTestCase(recipe, { assetId: randomUUID(), contacts: [{ effector: 'LEFTFOOT', kind: 'support', start: 0.5, end: 1.5, maxDriftStuds: 0.2 }] }, structural, studio, collidingTelemetry);
  assert.equal(ambiguousContact.checks[0]!.status, 'failed');
  assert.match(ambiguousContact.checks[0]!.detail, /ambiguous case-insensitive rig joints.*LeftFoot, leftfoot/i);

  const unverified = evaluateAnimationTestCase(recipe, testCase, structural, inspectMotion(recipe).report);
  assert.equal(unverified.status, 'incomplete');
  assert.equal(unverified.checks[0]!.status, 'unknown');
});

test('acceptance contracts pin exact recipe content and fail on same-ID content drift', () => {
  const { recipe } = fixture();
  const expectedFingerprint = fingerprint(recipe);
  const testCase = { assetId: randomUUID(), expectedFingerprint };
  const unchanged = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), inspectMotion(recipe).report);
  assert.equal(unchanged.status, 'passed');
  assert.equal(unchanged.checks[0]!.id, 'asset_fingerprint');

  const changedRecipe = { ...recipe, name: 'Modified without changing asset ID' };
  const changed = evaluateAnimationTestCase(changedRecipe, testCase, auditAnimation(changedRecipe), inspectMotion(changedRecipe).report);
  assert.equal(changed.status, 'failed');
  assert.equal(changed.checks[0]!.status, 'failed');
  assert.match(changed.checks[0]!.detail, /differs from the pinned test baseline/i);
});

test('angular-speed limits ignore disabled and zero-weight layers', () => {
  const { recipe } = fixture();
  recipe.layers = [{ id: randomUUID(), name: 'Disabled spike', blendMode: 'Override', weight: 1, enabled: false, tracks: [{ joint: 'Head', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.01, position: [0, 0, 0], rotation: [90, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] }];
  const structural = auditAnimation(recipe);
  const activePeak = Math.max(...structural.curveMotion.filter(metric => metric.channel !== 'layer' || (metric.enabled && (metric.weight ?? 0) > 0)).map(metric => metric.peakLocalAngularSpeed.degreesPerSecond));
  const authoredPeak = Math.max(...structural.curveMotion.map(metric => metric.peakLocalAngularSpeed.degreesPerSecond));
  assert.ok(authoredPeak > activePeak);
  const testCase = { assetId: randomUUID(), maxPeakAngularSpeedDegreesPerSecond: activePeak + 0.01 };
  const result = evaluateAnimationTestCase(recipe, testCase, structural, inspectMotion(recipe).report);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0]!.observed, activePeak);
});

test('loop seam velocity contracts measure position and angular discontinuity and ignore inactive layers', () => {
  const { recipe } = fixture();
  const foot = recipe.tracks.find(track => track.joint === 'LeftFoot')!;
  foot.keys = [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.5, position: [1, 0, 0], rotation: [60, 0, 0] },
    { time: 1.5, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ];
  recipe.layers = [{ id: randomUUID(), name: 'Disabled seam spike', blendMode: 'Additive', weight: 1, enabled: false,
    tracks: [{ joint: 'Head', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.01, position: [100, 0, 0], rotation: [180, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] }];
  const structural = auditAnimation(recipe);
  const footSeam = structural.loopSeamVelocity.find(metric => metric.joint === 'LeftFoot')!;
  assert.ok(footSeam.positionDiscontinuityStudsPerSecond > 1.9);
  assert.ok(footSeam.angularDiscontinuityDegreesPerSecond > 100);
  assert.ok(structural.loopSeamVelocity.find(metric => metric.joint === 'Head')!.positionDiscontinuityStudsPerSecond > 1000);
  const result = evaluateAnimationTestCase(recipe, {
    assetId: randomUUID(), loop: true,
    maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond: 2.1,
    maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: 130,
  }, structural, inspectMotion(recipe).report);
  assert.equal(result.checks.find(check => check.id === 'max_loop_seam_position_velocity_discontinuity')?.observed, footSeam.positionDiscontinuityStudsPerSecond);
  assert.equal(result.checks.find(check => check.id === 'max_loop_seam_position_velocity_discontinuity')?.status, 'passed');
  assert.equal(result.checks.find(check => check.id === 'max_loop_seam_angular_velocity_discontinuity')?.status, 'passed');
});

test('acceptance contract rejects empty, duplicate and inverted requirements', () => {
  const assetId = randomUUID();
  assert.throws(() => animationTestCaseSchema.parse({ assetId }), /at least one animation acceptance requirement/i);
  assert.throws(() => animationTestCaseSchema.parse({ assetId, requiredMarkers: ['Plant', 'plant'] }), /unique, ignoring case/i);
  assert.throws(() => animationTestCaseSchema.parse({ assetId, duration: { min: 3, max: 1 } }), /minimum must not exceed maximum/i);
  assert.throws(() => animationTestCaseSchema.parse({ assetId, contacts: [{ effector: 'LeftFoot', kind: 'support', start: 1, end: 1, maxDriftStuds: 0.1 }] }), /non-empty interval/i);
  assert.throws(() => animationTestCaseSchema.parse({ assetId, maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond: 10 }), /require loop: true/i);
});

test('acceptance contract fails explicit recipe mismatches and does not treat a clean heuristic audit as a gate', () => {
  const { recipe } = fixture();
  const testCase = { assetId: randomUUID(), loop: false, requiredMarkers: ['Strike'], requiredTracks: ['Tail'], maxPeakAngularSpeedDegreesPerSecond: 0.001 };
  const result = evaluateAnimationTestCase(recipe, testCase, auditAnimation(recipe), inspectMotion(recipe).report);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.checks.map(check => check.status), ['failed', 'failed', 'failed', 'failed']);
});
