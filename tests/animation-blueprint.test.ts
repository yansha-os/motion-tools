import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAnimationBlueprintResponseSize, compileAnimationBlueprint, MAX_ANIMATION_BLUEPRINT_RESPONSE_BYTES } from '../src/animation-blueprint.js';
import { easeProgress } from '../src/easing.js';
import { extractActionPhaseWindows } from '../src/animation-phases.js';

const plan = {
  name: 'Grounded sword strike', duration: 1.6, phases: [
    { id: 'windup', label: 'anticipation', start: 0, end: 0.25 },
    { id: 'strike', label: 'main_action', start: 0.25, end: 0.5 },
    { id: 'follow', label: 'follow_through', start: 0.5, end: 0.72 },
    { id: 'recover', label: 'recovery', start: 0.72, end: 1 },
  ],
  poses: [
    { phaseId: 'windup', progress: 0.8, joint: 'RightUpperArm', rotation: [-35, 10, 15] },
    { phaseId: 'strike', progress: 0.5, joint: 'RightUpperArm', rotation: [-110, -5, -15], easingStyle: 'CubicV2' },
    { phaseId: 'follow', progress: 0.5, joint: 'RightUpperArm', rotation: [-45, -15, 0] },
    { phaseId: 'recover', progress: 0.8, joint: 'RightUpperArm', rotation: [0, 0, 0] },
    { phaseId: 'strike', progress: 0.5, joint: 'UpperTorso', rotation: [5, -25, 0] },
  ],
  contacts: [{ effector: 'LeftFoot', kind: 'support', phaseId: 'strike', startProgress: 0, endProgress: 1 }],
};

test('animation blueprint preview enforces the complete serialized 8 MiB response limit', () => {
  assertAnimationBlueprintResponseSize({ payload: 'é' });
  const exactLimitPayload = 'x'.repeat(MAX_ANIMATION_BLUEPRINT_RESPONSE_BYTES - Buffer.byteLength('{"payload":""}', 'utf8'));
  assertAnimationBlueprintResponseSize({ payload: exactLimitPayload });
  assert.throws(() => assertAnimationBlueprintResponseSize({ payload: `${exactLimitPayload}x` }), /serialized response.*safety limit/);
});

test('animation blueprint compiles phase-relative poses, semantic markers and declared contacts without saving', () => {
  const result = compileAnimationBlueprint(plan);
  assert.equal(result.recipe.name, 'Grounded sword strike');
  assert.equal(result.recipe.duration, 1.6);
  assert.equal(result.recipe.tracks.length, 2);
  assert.deepEqual(result.recipe.markers.map(marker => [marker.name, marker.time]), [
    ['Anticipation', 0], ['Action', 0.4], ['FollowThrough', 0.8], ['Recovery', 1.152],
  ]);
  assert.deepEqual(result.recipe.markers.map(marker => marker.phase), ['anticipation', 'main_action', 'follow_through', 'recovery']);
  assert.deepEqual(result.recipe.contacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.4, end: 0.8 }]);
  assert.deepEqual(result.blueprint.contacts, [{ effector: 'LeftFoot', kind: 'support', phaseId: 'strike', startProgress: 0, endProgress: 1, start: 0.4, end: 0.8 }],
    'blueprint readback retains phase-local contact coordinates alongside compiled clip times');
  const arm = result.recipe.tracks.find(track => track.joint === 'RightUpperArm')!;
  const expectedKeyTimes = [0, 0.32, 0.6, 0.976, 1.5104, 1.6];
  assert.equal(arm.keys.length, expectedKeyTimes.length);
  arm.keys.forEach((key, index) => assert.ok(Math.abs(key.time - expectedKeyTimes[index]!) < 1e-12));
  assert.deepEqual(arm.keys[2]!.rotation, [-110, -5, -15]);
  assert.equal(arm.keys[2]!.easingStyle, 'CubicV2');
  assert.equal(result.diagnostics.phaseCount, 4);
  assert.deepEqual(result.diagnostics.poseCoverage.phases.map(phase => [phase.phaseId, phase.authoredPoseCount, phase.distinctJointCount]), [
    ['windup', 1, 1], ['strike', 2, 2], ['follow', 1, 1], ['recover', 1, 1],
  ]);
  assert.deepEqual(result.diagnostics.poseCoverage.phases.map(phase => [phase.phaseId, phase.jointsWithSingleAuthoredPose, phase.jointsWithMultipleAuthoredPoses]), [
    ['windup', 1, 0], ['strike', 2, 0], ['follow', 1, 0], ['recover', 1, 0],
  ]);
  assert.deepEqual(result.diagnostics.poseCoverage.authoredPoseTimings.map(pose => [pose.phaseId, pose.progress, pose.time]), [
    ['windup', 0.8, 0.32000000000000006], ['strike', 0.5, 0.6000000000000001], ['strike', 0.5, 0.6000000000000001],
    ['follow', 0.5, 0.976], ['recover', 0.8, 1.5104],
  ]);
  assert.equal(result.diagnostics.poseCoverage.omittedAuthoredPoseTimingCount, 0);
  const armCoverage = result.diagnostics.poseCoverage.joints.find(joint => joint.joint === 'RightUpperArm')!;
  assert.equal(armCoverage.authoredPoseCount, 4);
  assert.deepEqual(armCoverage.phases.map(phase => [phase.phaseId, phase.authoredPoseCount, phase.progress]), [
    ['windup', 1, [0.8]], ['strike', 1, [0.5]], ['follow', 1, [0.5]], ['recover', 1, [0.8]],
  ]);
  const torsoCoverage = result.diagnostics.poseCoverage.joints.find(joint => joint.joint === 'UpperTorso')!;
  assert.deepEqual(torsoCoverage.phases.map(phase => [phase.phaseId, phase.authoredPoseCount]), [
    ['windup', 0], ['strike', 1], ['follow', 0], ['recover', 0],
  ], 'per-joint coverage must explicitly distinguish authored beats from interpolation-only phases');
  const armProgression = result.diagnostics.poseCoverage.progressionByJoint.find(joint => joint.joint === 'RightUpperArm')!;
  assert.equal(armProgression.authoredPoseCount, 4);
  assert.equal(armProgression.transitions.length, 3);
  assert.equal(armProgression.transitions[0]!.fromPhaseId, 'windup');
  assert.equal(armProgression.transitions[0]!.toPhaseId, 'strike');
  assert.ok(armProgression.transitions[0]!.rotationDeltaDegrees > 0);
  assert.ok(armProgression.transitions[0]!.angularRateDegreesPerSecond > 0);
  const sampledAction = result.diagnostics.poseCoverage.sampledMotionByPhase.find(phase => phase.phaseId === 'strike')!;
  const sampledArm = sampledAction.joints.find(joint => joint.joint === 'RightUpperArm')!;
  assert.equal(sampledArm.sampledIntervalCount, 8);
  assert.equal(sampledArm.authoredKeyTimeCount, 1, 'authored poses inside the phase must be included in addition to uniform samples');
  assert.equal(sampledArm.sampleCount, 9, 'uniform and authored timestamps that coincide are counted once');
  assert.ok(sampledArm.sampledAngularPathLengthDegrees > 0, 'phase-local evidence must sample the actual eased curve');
  assert.ok(sampledArm.peakAngularRate.degreesPerSecond > 0);
  const strikePhase = result.diagnostics.poseCoverage.phases.find(phase => phase.phaseId === 'strike')!;
  assert.ok(sampledArm.peakAngularRate.startTime >= strikePhase.startTime);
  assert.ok(sampledArm.peakAngularRate.endTime <= strikePhase.endTime);
  assert.match(result.diagnostics.poseCoverage.sampledMotionByPhaseLimitations, /not continuous extrema/);
  assert.match(result.diagnostics.poseCoverage.progressionLimitation, /not continuous-curve peaks/);
  assert.match(result.next, /diagnostics\.poseCoverage\.progressionByPhase.*sampledMotionByPhase.*Compare authoredBridge, withinPhaseAuthoredDelta, and sampled path\/rate cues/);
  assert.ok(result.diagnostics.warnings.some(warning => /not an IK solve/.test(warning)));
  assert.equal(result.recipe.loop, false);
});

test('blueprint contact summaries and recipe windows are stable under input reordering', () => {
  const contacts = [
    { effector: 'RightHand', kind: 'grip' as const, phaseId: 'strike', startProgress: 0.3, endProgress: 0.8 },
    { effector: 'LeftFoot', kind: 'support' as const, phaseId: 'windup', startProgress: 0.2, endProgress: 1 },
  ];
  const first = compileAnimationBlueprint({ ...plan, contacts });
  const second = compileAnimationBlueprint({ ...plan, contacts: [...contacts].reverse() });
  assert.deepEqual(first.blueprint.contacts, second.blueprint.contacts);
  assert.deepEqual(first.recipe.contacts, second.recipe.contacts);
  assert.deepEqual(first.blueprint.contacts.map(contact => contact.phaseId), ['windup', 'strike']);
});

test('phase intent stays available to AI diagnostics without changing Roblox marker semantics', () => {
  const input = { ...plan, phases: plan.phases.map((phase, index) => ({ ...phase,
    ...(index === 1 ? { intent: 'A committed bow release sends the arrow forward.' } : {}) })) };
  const result = compileAnimationBlueprint(input);
  assert.equal(result.blueprint.phases[1]!.intent, 'A committed bow release sends the arrow forward.');
  assert.equal(result.diagnostics.poseCoverage.phases[1]!.intent, 'A committed bow release sends the arrow forward.');
  assert.equal(result.recipe.markers[1]!.value, 'Blueprint phase: strike', 'free-form intent must not leak into Roblox marker values');
  assert.equal(result.recipe.markers[1]!.phase, 'main_action');
  assert.throws(() => compileAnimationBlueprint({ ...input, phases: input.phases.map((phase, index) => index === 0
    ? { ...phase, intent: 'x'.repeat(241) } : phase) }), /at most 240 character/i);
});

test('blueprint authors phase-local event markers without splitting action phases', () => {
  const result = compileAnimationBlueprint({ ...plan, events: [
    { name: 'Impact', phaseId: 'strike', progress: 0.6, value: 'blade_contact' },
    { name: 'FootPlant', phaseId: 'windup', progress: 0.8 },
  ] });
  const impact = result.recipe.markers.find(marker => marker.name === 'Impact')!;
  assert.equal(impact.time, 1.6 * (0.25 + (0.5 - 0.25) * 0.6));
  assert.equal(impact.value, 'blade_contact');
  assert.equal(impact.phase, 'event');
  assert.equal(result.recipe.markers.find(marker => marker.name === 'FootPlant')!.phase, 'event');
  assert.deepEqual(result.blueprint.events, [
    { name: 'FootPlant', phaseId: 'windup', progress: 0.8, time: 1.6 * (0.25 * 0.8) },
    { name: 'Impact', phaseId: 'strike', progress: 0.6, value: 'blade_contact', time: 1.6 * (0.25 + 0.25 * 0.6) },
  ], 'readback retains phase-relative coordinates and resolved clip time in chronological order');
  const reordered = compileAnimationBlueprint({ ...plan, events: [
    { name: 'FootPlant', phaseId: 'windup', progress: 0.8 },
    { name: 'Impact', phaseId: 'strike', progress: 0.6, value: 'blade_contact' },
  ] });
  assert.deepEqual(reordered.recipe.markers, result.recipe.markers, 'event input order does not perturb compiled marker order');
  assert.deepEqual(reordered.blueprint.events, result.blueprint.events);
  const phaseWindows = extractActionPhaseWindows(result.recipe).phases;
  assert.deepEqual(phaseWindows.map(phase => phase.label), ['anticipation', 'main_action', 'follow_through', 'recovery']);
  assert.equal(phaseWindows.length, 4, 'event names must not create extra phase boundaries');
  assert.throws(() => compileAnimationBlueprint({ ...plan, events: [{ name: 'Impact', phaseId: 'missing', progress: 0.5 }] }), /Unknown phase id missing/);
  assert.throws(() => compileAnimationBlueprint({ ...plan, events: Array.from({ length: 85 }, (_, index) => ({ name: `Event${index}`, phaseId: 'strike', progress: 0.5 })) }), /84/);
});

test('phase motion sampling retains brief authored beats between uniform probe times', () => {
  const input = { name: 'Brief beat', duration: 1, phases: [{ id: 'action', label: 'main_action' as const, start: 0, end: 1 }],
    poses: [
      { phaseId: 'action', progress: 0.49, joint: 'RightHand', rotation: [0, 0, 0] as [number, number, number] },
      { phaseId: 'action', progress: 0.501, joint: 'RightHand', rotation: [0, 0, 120] as [number, number, number] },
      { phaseId: 'action', progress: 0.512, joint: 'RightHand', rotation: [0, 0, 0] as [number, number, number] },
    ] };
  const result = compileAnimationBlueprint(input);
  const phase = result.diagnostics.poseCoverage.sampledMotionByPhase[0]!;
  const hand = phase.joints.find(joint => joint.joint === 'RightHand')!;
  assert.equal(hand.authoredKeyTimeCount, 3);
  assert.ok(hand.sampledAngularPathLengthDegrees > 200, 'the narrow raised-and-returned pose must contribute to sampled path');
  assert.ok(hand.peakAngularRate.degreesPerSecond > 1000, 'the brief beat rate must be visible to the agent');
});


test('phase intent review plan emits bounded exact midpoint and internal-boundary sample times', () => {
  const phases = Array.from({ length: 16 }, (_, index) => ({ id: `phase_${index}`, label: 'main_action' as const,
    intent: `Beat ${index} should read clearly.`, start: index / 16, end: (index + 1) / 16 }));
  const poses = phases.map(phase => ({ phaseId: phase.id, progress: 0.5, joint: 'RightArm',
    rotation: [0, 20, 0] as [number, number, number] }));
  const reviewPlan = compileAnimationBlueprint({ name: 'Sixteen intent beats', duration: 2, phases, poses, contacts: [] }).diagnostics.phaseIntentReview;
  assert.equal(reviewPlan.phases.length, 16);
  assert.equal(reviewPlan.phases[0]!.evidenceTimes[0], 0);
  assert.equal(reviewPlan.phases[0]!.evidenceTimes[2], reviewPlan.phases[1]!.evidenceTimes[0], 'contiguous phases share one boundary sample');
  assert.equal(reviewPlan.targetTimes.length, 31, 'clip endpoints are implicit, leaving 31 unique internal samples');
  assert.deepEqual(reviewPlan.targetTimeBatches.map(batch => batch.length), [8, 8, 8, 7]);
  assert.deepEqual(reviewPlan.targetTimeBatches.flat(), reviewPlan.targetTimes);
  assert.ok(!reviewPlan.targetTimes.includes(0));
  assert.ok(!reviewPlan.targetTimes.includes(2));
  assert.ok(reviewPlan.targetTimes.includes(reviewPlan.phases[7]!.midpointTime));
  assert.match(reviewPlan.limitation, /does not interpret the intent.*automatically pass\/fail semantic quality/i);
});

test('blueprint phase progression links authored beats without mistaking interpolation for authored poses', () => {
  const result = compileAnimationBlueprint({ name: 'Phase bridge', duration: 2, phases: [
    { id: 'windup', label: 'anticipation', start: 0, end: 0.4 },
    { id: 'strike', label: 'main_action', intent: 'A quick committed release.', start: 0.4, end: 0.7 },
    { id: 'recover', label: 'recovery', start: 0.7, end: 1 },
  ], poses: [
    { phaseId: 'windup', progress: 0.25, joint: 'RightArm', rotation: [0, -20, 0] },
    { phaseId: 'windup', progress: 0.75, joint: 'RightArm', rotation: [0, -80, 0] },
    { phaseId: 'strike', progress: 0.5, joint: 'RightArm', rotation: [0, 35, 0] },
  ], contacts: [] });
  const progression = result.diagnostics.poseCoverage.progressionByPhase;
  const windup = progression.find(phase => phase.phaseId === 'windup')!.joints[0]!;
  const strike = progression.find(phase => phase.phaseId === 'strike')!;
  const strikeArm = strike.joints[0]!;
  const recoveryArm = progression.find(phase => phase.phaseId === 'recover')!.joints[0]!;
  assert.equal(windup.authoredPoseCount, 2);
  assert.equal(windup.firstAuthoredPose!.progress, 0.25);
  assert.equal(windup.lastAuthoredPose!.progress, 0.75);
  assert.ok(Math.abs(windup.withinPhaseAuthoredDelta!.rotationDeltaDegrees - 60) < 1e-8);
  assert.equal(strike.intent, 'A quick committed release.');
  assert.equal(strikeArm.authoredPoseCount, 1);
  assert.equal(strikeArm.authoredBridge!.fromPhaseId, 'windup');
  assert.ok(strikeArm.authoredBridge!.rotationDeltaDegrees > 0);
  assert.equal(strikeArm.withinPhaseAuthoredDelta, undefined, 'one key does not imply an authored within-phase transition');
  assert.equal(recoveryArm.authoredPoseCount, 0);
  assert.equal(recoveryArm.authoredBridge, undefined, 'an interpolation-only phase must not fabricate an authored bridge');
  assert.match(result.diagnostics.poseCoverage.progressionLimitation, /interpolation can still animate it/);
});

test('blueprint pose progression measures shortest-path rotation and preserves explicit easing provenance', () => {
  const result = compileAnimationBlueprint({ name: 'Euler wrap progression', duration: 1, phases: [
    { id: 'start', label: 'anticipation', start: 0, end: 0.5 }, { id: 'end', label: 'main_action', start: 0.5, end: 1 },
  ], poses: [
    { phaseId: 'start', progress: 0.5, joint: 'RightArm', rotation: [0, 179, 0], easingStyle: 'CubicV2', easingDirection: 'InOut' },
    { phaseId: 'end', progress: 0.5, joint: 'RightArm', position: [3, 4, 0], rotation: [0, -179, 0] },
  ], contacts: [] });
  const progression = result.diagnostics.poseCoverage.progressionByJoint[0]!.transitions[0]!;
  assert.ok(Math.abs(progression.rotationDeltaDegrees - 2) < 1e-8, `expected shortest-path 2° delta, received ${progression.rotationDeltaDegrees}`);
  assert.equal(progression.positionDeltaStuds, 5);
  assert.equal(progression.elapsedSeconds, 0.5);
  assert.equal(progression.outgoingEasingStyle, 'CubicV2');
  assert.equal(progression.outgoingEasingDirection, 'InOut');
});

test('blueprint preserves custom Bezier handles through recipe and AI progression diagnostics', () => {
  const curve = { outTime: 0.1, outValue: 0.9, inTime: 0.9, inValue: 1 };
  const result = compileAnimationBlueprint({ name: 'Custom easing', duration: 1, phases: [
    { id: 'start', label: 'anticipation', start: 0, end: 0.5 }, { id: 'action', label: 'main_action', start: 0.5, end: 1 },
  ], poses: [
    { phaseId: 'start', progress: 0.5, joint: 'RightArm', rotation: [0, -20, 0], easingStyle: 'Bezier', curve },
    { phaseId: 'action', progress: 0.5, joint: 'RightArm', rotation: [0, 45, 0] },
  ], contacts: [] });
  const firstKey = result.recipe.tracks[0]!.keys.find(key => key.time === 0.25)!;
  assert.equal(firstKey.easingStyle, 'Bezier');
  assert.deepEqual(firstKey.curve, curve);
  const transition = result.diagnostics.poseCoverage.progressionByJoint[0]!.transitions[0]!;
  assert.deepEqual(transition.outgoingBezierCurve, curve);
  assert.notEqual(easeProgress('Bezier', 'Out', 0.5, curve), easeProgress('Bezier', 'Out', 0.5),
    'custom controls should shape the actual outgoing segment differently from the default curve');
  assert.throws(() => compileAnimationBlueprint({ name: 'Mismatched easing', duration: 1, phases: [
    { id: 'only', label: 'main_action', start: 0, end: 1 },
  ], poses: [{ phaseId: 'only', progress: 0.5, joint: 'RightArm', rotation: [0, 10, 0], easingStyle: 'Linear', curve }], contacts: [] }),
  /require easingStyle Bezier/);
  assert.throws(() => compileAnimationBlueprint({ name: 'Invalid handles', duration: 1, phases: [
    { id: 'only', label: 'main_action', start: 0, end: 1 },
  ], poses: [{ phaseId: 'only', progress: 0.5, joint: 'RightArm', rotation: [0, 10, 0], easingStyle: 'Bezier',
    curve: { outTime: 0.8, outValue: 0.1, inTime: 0.2, inValue: 0.9 } }], contacts: [] }), /handles must remain ordered/);
});

test('blueprint pose coverage preserves repeated phase labels and bounds detailed timing cues', () => {
  const phases = Array.from({ length: 16 }, (_, index) => ({ id: `beat_${index}`, label: 'main_action' as const,
    start: index / 16, end: (index + 1) / 16 }));
  const poses = Array.from({ length: 40 }, (_, index) => ({ phaseId: `beat_${Math.floor(index / 3)}`,
    progress: (index % 3) / 4, joint: 'RightArm', rotation: [0, index, 0] as [number, number, number] }));
  const result = compileAnimationBlueprint({ name: 'Repeated beats', duration: 4, phases, poses, contacts: [] });
  const coverage = result.diagnostics.poseCoverage;
  assert.equal(coverage.phases.length, 16);
  assert.ok(coverage.phases.every(phase => phase.label === 'main_action'));
  assert.equal(coverage.phasesWithAuthoredPoses, 14);
  assert.deepEqual(coverage.phasesWithoutAuthoredPoses, ['beat_14', 'beat_15']);
  assert.equal(coverage.phases.find(phase => phase.phaseId === 'beat_0')!.jointsWithMultipleAuthoredPoses, 1);
  assert.equal(coverage.phases.find(phase => phase.phaseId === 'beat_14')!.jointsWithSingleAuthoredPose, 0);
  assert.equal(coverage.progressionByJoint[0]!.authoredPoseCount, 40);
  assert.equal(coverage.progressionByJoint[0]!.transitions.length, 16);
  assert.equal(coverage.progressionByJoint[0]!.omittedTransitionCount, 23);
  assert.equal(coverage.authoredPoseTimings.length, 32);
  assert.equal(coverage.omittedAuthoredPoseTimingCount, 8);
  assert.deepEqual(coverage.authoredPoseTimings.slice(0, 4).map(pose => [pose.phaseId, pose.progress, pose.time]), [
    ['beat_0', 0, 0], ['beat_0', 0.25, 0.0625], ['beat_0', 0.5, 0.125], ['beat_1', 0, 0.25],
  ]);
});

test('blueprint per-joint phase coverage is deterministic and bounded without imposing pose quotas', () => {
  const phases = [{ id: 'first', label: 'anticipation' as const, start: 0, end: 0.5 },
    { id: 'last', label: 'recovery' as const, start: 0.5, end: 1 }];
  const poses = Array.from({ length: 66 }, (_, index) => ({ phaseId: index % 2 === 0 ? 'first' : 'last', progress: 0.5,
    joint: `Joint${index.toString().padStart(2, '0')}`, rotation: [0, index, 0] as [number, number, number] }));
  const input = { name: 'Bounded joint coverage', duration: 1, phases, poses, contacts: [] };
  const forward = compileAnimationBlueprint(input).diagnostics.poseCoverage;
  const reversed = compileAnimationBlueprint({ ...input, poses: [...poses].reverse() }).diagnostics.poseCoverage;
  assert.deepEqual(forward.joints, reversed.joints, 'coverage ordering must not depend on directive input order');
  assert.equal(forward.joints.length, 64);
  assert.equal(forward.omittedJointCount, 2);
  assert.equal(forward.progressionByJoint.length, 64);
  assert.equal(forward.omittedProgressionJointCount, 2);
  assert.deepEqual(forward.progressionByJoint, reversed.progressionByJoint, 'pose-change summaries must not depend on directive input order');
  assert.ok(forward.joints.every(joint => joint.phases.length === 2 && joint.phases.reduce((sum, phase) => sum + phase.authoredPoseCount, 0) === 1));
  assert.match(forward.limitation, /not that a pose is required/);
});

test('animation blueprint rejects gaps, overlaps, unknown phases, and duplicate joint times', () => {
  assert.throws(() => compileAnimationBlueprint({ ...plan, phases: [plan.phases[0], { ...plan.phases[1], start: 0.3 }, ...plan.phases.slice(2)] }), /contiguous/);
  assert.throws(() => compileAnimationBlueprint({ ...plan, poses: [...plan.poses, { ...plan.poses[0]!, phaseId: 'missing' }] }), /Unknown phase/);
  assert.throws(() => compileAnimationBlueprint({ ...plan, poses: [...plan.poses, { ...plan.poses[0]!, phaseId: 'windup', progress: 0.8 }] }), /conflicting blueprint poses/);
});

test('semantic blueprint roles require live rig resolution before offline compilation', () => {
  const semanticPlan = { ...plan, poses: [{ phaseId: 'strike', progress: 0.5, semanticRole: 'right_shoulder' as const, rotation: [-80, 0, 0] as [number, number, number] }] };
  assert.throws(() => compileAnimationBlueprint(semanticPlan), /must be resolved against a freshly inspected standard R6\/R15 rig/);
  assert.throws(() => compileAnimationBlueprint({ ...plan, poses: [{ ...plan.poses[0]!, semanticRole: 'right_hand' }] }), /exactly one of joint or semanticRole/);
});

test('animation blueprint collision errors identify both directives and are input-order deterministic', () => {
  const blueprint = {
    name: 'Boundary key collision', duration: 2,
    phases: [
      { id: 'windup', label: 'anticipation', start: 0, end: 0.5 },
      { id: 'action', label: 'main_action', start: 0.5, end: 1 },
    ],
    poses: [
      { phaseId: 'windup', progress: 1, joint: 'RightHand', rotation: [0, 20, 0] },
      { phaseId: 'action', progress: 0, joint: 'RightHand', rotation: [0, 40, 0] },
    ],
    contacts: [],
  };
  const getMessage = (input: unknown) => {
    try { compileAnimationBlueprint(input); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    assert.fail('Expected colliding phase-boundary directives to be rejected.');
  };
  const message = getMessage(blueprint);
  assert.match(message, /RightHand.*1s.*phase action progress 0.*phase windup progress 1/);
  assert.match(message, /Merge their position\/rotation into one directive or move one to a distinct time/);
  assert.equal(getMessage({ ...blueprint, poses: [...blueprint.poses].reverse() }), message);
});

test('animation blueprint reports tolerated phase-boundary normalization in normalized and clip time', () => {
  const result = compileAnimationBlueprint({
    name: 'Canonical phase boundaries', duration: 2,
    phases: [
      { id: 'windup', label: 'anticipation', start: 0, end: 0.5 },
      { id: 'action', label: 'main_action', start: 0.5000005, end: 0.9999995 },
    ],
    poses: [
      { phaseId: 'windup', progress: 0.5, joint: 'RightHand', rotation: [0, 0, 0] },
      { phaseId: 'action', progress: 0.5, joint: 'RightHand', rotation: [0, 90, 0] },
    ],
    contacts: [],
  });
  const normalizations = result.diagnostics.phaseBoundaryNormalizations;
  assert.deepEqual(normalizations.map(({ phaseId, boundary, authoredNormalizedTime, compiledNormalizedTime }) =>
    ({ phaseId, boundary, authoredNormalizedTime, compiledNormalizedTime })), [
    { phaseId: 'action', boundary: 'start', authoredNormalizedTime: 0.5000005, compiledNormalizedTime: 0.5 },
    { phaseId: 'action', boundary: 'end', authoredNormalizedTime: 0.9999995, compiledNormalizedTime: 1 },
  ]);
  assert.ok(Math.abs(normalizations[0]!.normalizedDelta + 5e-7) < 1e-15);
  assert.ok(Math.abs(normalizations[0]!.secondsDelta + 1e-6) < 1e-15);
  assert.ok(Math.abs(normalizations[1]!.normalizedDelta - 5e-7) < 1e-15);
  assert.ok(Math.abs(normalizations[1]!.secondsDelta - 1e-6) < 1e-15);
  assert.equal(result.blueprint.phases[1]!.start, 0.5);
  assert.equal(result.blueprint.phases[1]!.end, 1);
  assert.equal(result.blueprint.phases[1]!.startTime, 1);
  assert.equal(result.blueprint.phases[1]!.endTime, 2);
  assert.ok(result.diagnostics.warnings.some(warning => /canonicalized/.test(warning)));
});

test('animation blueprint emits no phase normalization diagnostics for exact boundaries', () => {
  const result = compileAnimationBlueprint(plan);
  assert.deepEqual(result.diagnostics.phaseBoundaryNormalizations, []);
});

test('animation blueprint ordering is deterministic for simultaneous poses regardless of input order', () => {
  const simultaneous = {
    name: 'Deterministic pose order', duration: 1, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0.5, joint: 'rightHand', rotation: [0, 30, 0] as [number, number, number] },
      { phaseId: 'cycle', progress: 0.5, joint: 'LeftHand', rotation: [0, -30, 0] as [number, number, number] },
      { phaseId: 'cycle', progress: 0.5, joint: 'UpperTorso', rotation: [0, 10, 0] as [number, number, number] },
    ],
    contacts: [],
  };
  const forward = compileAnimationBlueprint(simultaneous);
  const reversed = compileAnimationBlueprint({ ...simultaneous, poses: [...simultaneous.poses].reverse() });
  assert.deepEqual(forward.recipe, reversed.recipe);
  assert.deepEqual(forward.blueprint.poses, reversed.blueprint.poses);
});

test('animation blueprint builds loop-safe endpoints and warns that constraints are declarations', () => {
  const result = compileAnimationBlueprint({ ...plan, loop: true, contacts: [] });
  const arm = result.recipe.tracks.find(track => track.joint === 'RightUpperArm')!;
  assert.deepEqual(arm.keys.at(-1)!.rotation, arm.keys[0]!.rotation);
  assert.ok(result.diagnostics.warnings.some(warning => /Loop endpoint/.test(warning)));
  assert.ok(result.diagnostics.warnings.some(warning => /Support\/grip windows are declarations/.test(warning)));
});

test('animation blueprint reports authored terminal poses that loop closure replaces', () => {
  const result = compileAnimationBlueprint({
    name: 'Loop endpoint review', duration: 1, loop: true,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0, joint: 'RightHand', rotation: [0, 0, 0] },
      { phaseId: 'cycle', progress: 1, joint: 'RightHand', rotation: [0, 90, 0] },
    ],
    contacts: [],
  });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(hand.keys.at(-1)!.rotation, [0, 0, 0], 'the compiled loop endpoint must still match its start');
  assert.equal(result.diagnostics.loopEndpointOverrideCount, 1);
  assert.deepEqual(result.diagnostics.loopEndpointOverrides, [{ joint: 'RightHand', time: 1,
    authoredPosition: [0, 0, 0], authoredRotation: [0, 90, 0], loopPosition: [0, 0, 0], loopRotation: [0, 0, 0] }]);
  assert.deepEqual(result.diagnostics.poseCoverage.progressionByJoint[0]!.terminalPoseOverride, { time: 1,
    authoredPosition: [0, 0, 0], authoredRotation: [0, 90, 0], compiledLoopPosition: [0, 0, 0], compiledLoopRotation: [0, 0, 0] });
  assert.match(result.diagnostics.poseCoverage.progressionLimitation, /inspect terminalPoseOverride/);
  assert.ok(result.diagnostics.warnings.some(warning => /Explicit terminal poses.*RightHand/.test(warning)));
});

test('animation blueprint inherits omitted transform channels in chronological order', () => {
  const result = compileAnimationBlueprint({
    name: 'Independent pose channels', duration: 1, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0.75, joint: 'RightHand', rotation: [0, 90, 0] },
      { phaseId: 'cycle', progress: 0.625, joint: 'RightHand', position: [4, 5, 6] },
      { phaseId: 'cycle', progress: 0.25, joint: 'RightHand', position: [1, 2, 3] },
      { phaseId: 'cycle', progress: 0.5, joint: 'RightHand', rotation: [0, 45, 0] },
    ],
    contacts: [],
  });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(hand.keys.map(key => [key.time, key.position, key.rotation]), [
    [0, [1, 2, 3], [0, 0, 0]],
    [0.25, [1, 2, 3], [0, 0, 0]],
    [0.5, [1, 2, 3], [0, 45, 0]],
    [0.625, [4, 5, 6], [0, 45, 0]],
    [0.75, [4, 5, 6], [0, 90, 0]],
    [1, [4, 5, 6], [0, 90, 0]],
  ]);
});

test('animation blueprint holds first and last authored poses at un-authored clip boundaries', () => {
  const result = compileAnimationBlueprint({
    name: 'Boundary holds', duration: 2, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0.25, joint: 'RightHand', rotation: [0, 30, 0] },
      { phaseId: 'cycle', progress: 0.75, joint: 'RightHand', rotation: [0, 90, 0] },
    ],
    contacts: [],
  });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(hand.keys[0], { time: 0, position: [0, 0, 0], rotation: [0, 30, 0] });
  assert.deepEqual(hand.keys.at(-1), { time: 2, position: [0, 0, 0], rotation: [0, 90, 0] });
});

test('animation blueprint does not copy interior easing onto generated boundary segments', () => {
  const result = compileAnimationBlueprint({
    name: 'Boundary easing isolation', duration: 2, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0.25, joint: 'RightHand', rotation: [0, 30, 0], easingStyle: 'Constant', easingDirection: 'In' },
      { phaseId: 'cycle', progress: 0.75, joint: 'RightHand', rotation: [0, 90, 0], easingStyle: 'Elastic', easingDirection: 'InOut' },
    ],
    contacts: [],
  });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.equal(hand.keys[0]!.easingStyle, undefined, 'generated start key uses default easing toward the first authored beat');
  assert.equal(hand.keys[0]!.easingDirection, undefined);
  assert.equal(hand.keys[1]!.easingStyle, 'Constant', 'the authored easing remains on its original beat');
  assert.equal(hand.keys[2]!.easingStyle, 'Elastic');
  assert.equal(hand.keys[3]!.easingStyle, undefined, 'generated end key does not reuse the last interior key easing');
  assert.equal(hand.keys[3]!.easingDirection, undefined);
});

test('animation blueprint preserves explicitly authored boundary easing and strips easing from loop closure', () => {
  const explicit = compileAnimationBlueprint({
    name: 'Explicit boundary easing', duration: 1, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0, joint: 'RightHand', rotation: [0, 0, 0], easingStyle: 'CubicV2', easingDirection: 'Out' },
      { phaseId: 'cycle', progress: 1, joint: 'RightHand', rotation: [0, 90, 0], easingStyle: 'Constant', easingDirection: 'In' },
    ],
    contacts: [],
  });
  const explicitHand = explicit.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.equal(explicitHand.keys[0]!.easingStyle, 'CubicV2');
  assert.equal(explicitHand.keys.at(-1)!.easingStyle, 'Constant');

  const loop = compileAnimationBlueprint({
    name: 'Loop boundary easing', duration: 1, loop: true,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0, joint: 'RightHand', rotation: [0, 0, 0], easingStyle: 'CubicV2', easingDirection: 'Out' },
      { phaseId: 'cycle', progress: 0.5, joint: 'RightHand', rotation: [0, 90, 0], easingStyle: 'Elastic', easingDirection: 'InOut' },
    ],
    contacts: [],
  });
  const loopHand = loop.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(loopHand.keys.at(-1), { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] });
});

test('animation blueprint preserves explicitly authored start and terminal poses', () => {
  const result = compileAnimationBlueprint({
    name: 'Explicit boundaries', duration: 1, loop: false,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0, joint: 'RightHand', rotation: [0, 10, 0] },
      { phaseId: 'cycle', progress: 1, joint: 'RightHand', rotation: [0, 100, 0] },
    ],
    contacts: [],
  });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(hand.keys[0]!.rotation, [0, 10, 0]);
  assert.deepEqual(hand.keys.at(-1)!.rotation, [0, 100, 0]);
});

test('animation blueprint loop closure diagnostics compare resolved channel values', () => {
  const result = compileAnimationBlueprint({
    name: 'Resolved loop channels', duration: 1, loop: true,
    phases: [{ id: 'cycle', label: 'main_action', start: 0, end: 1 }],
    poses: [
      { phaseId: 'cycle', progress: 0, joint: 'RightHand', position: [1, 0, 0], rotation: [0, 0, 0] },
      { phaseId: 'cycle', progress: 0.5, joint: 'RightHand', rotation: [0, 45, 0] },
      { phaseId: 'cycle', progress: 1, joint: 'RightHand', position: [1, 0, 0] },
    ],
    contacts: [],
  });
  assert.equal(result.diagnostics.loopEndpointOverrideCount, 1);
  assert.deepEqual(result.diagnostics.loopEndpointOverrides[0], { joint: 'RightHand', time: 1,
    authoredPosition: [1, 0, 0], authoredRotation: [0, 45, 0], loopPosition: [1, 0, 0], loopRotation: [0, 0, 0] });
  const hand = result.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.deepEqual(hand.keys.at(-1), { time: 1, position: [1, 0, 0], rotation: [0, 0, 0] });
});

test('animation blueprint supports authored semantic event marker names while preserving defaults', () => {
  const custom = compileAnimationBlueprint({ ...plan, phases: plan.phases.map(phase =>
    phase.id === 'strike' ? { ...phase, markerName: 'WeaponRelease', markerProgress: 0.6 } : phase) });
  assert.deepEqual(custom.recipe.markers.map(marker => [marker.name, marker.value]), [
    ['Anticipation', 'Blueprint phase: windup'],
    ['WeaponRelease', 'Blueprint phase: strike'],
    ['FollowThrough', 'Blueprint phase: follow'],
    ['Recovery', 'Blueprint phase: recover'],
  ]);
  assert.deepEqual(custom.recipe.markers.map(marker => marker.phase), ['anticipation', 'main_action', 'follow_through', 'recovery']);
  const expectedMarkerTimes = [0, 0.64, 0.8, 1.152];
  custom.recipe.markers.forEach((marker, index) => assert.ok(Math.abs(marker.time - expectedMarkerTimes[index]!) < 1e-12));
  const markerAtPhaseStart = compileAnimationBlueprint({ ...plan, phases: plan.phases.map(phase =>
    phase.id === 'strike' ? { ...phase, markerName: 'WeaponRelease' } : phase) });
  assert.equal(markerAtPhaseStart.recipe.markers[1]!.time, 0.4,
    'markerProgress defaults to phase start to preserve existing behavior');
});

test('animation blueprint preserves distinct sub-microsecond phase timing instead of rounding authored beats together', () => {
  const precise = compileAnimationBlueprint({
    name: 'Precise strike', duration: 0.1, loop: false,
    phases: [
      { id: 'windup', label: 'anticipation', start: 0, end: 0.5 },
      { id: 'strike', label: 'main_action', start: 0.5, end: 1 },
    ],
    poses: [
      { phaseId: 'windup', progress: 0.5, joint: 'RightHand', rotation: [0, 0, 0] },
      { phaseId: 'strike', progress: 0.5, joint: 'RightHand', rotation: [0, 10, 0] },
      { phaseId: 'strike', progress: 0.50001, joint: 'RightHand', rotation: [0, 20, 0] },
    ],
    contacts: [{ effector: 'RightHand', kind: 'grip', phaseId: 'strike', startProgress: 0.5, endProgress: 0.50001 }],
  });
  const hand = precise.recipe.tracks.find(track => track.joint === 'RightHand')!;
  assert.equal(hand.keys[1]!.time, 0.025);
  assert.ok(hand.keys[3]!.time > hand.keys[2]!.time);
  assert.ok(Math.abs(hand.keys[3]!.time - hand.keys[2]!.time - 5e-7) < 1e-12);
  assert.ok(Math.abs(precise.recipe.contacts![0]!.end - precise.recipe.contacts![0]!.start - 5e-7) < 1e-12);
  assert.equal(precise.recipe.markers[1]!.time, 0.05);
});
