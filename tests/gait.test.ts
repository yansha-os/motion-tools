import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compileGait, gaitSchema } from '../src/gait.js';
import { retargetProfileSchema } from '../src/retarget.js';

const fullRigMap = {
  leftHip: 'LeftUpperLeg', rightHip: 'RightUpperLeg',
  leftFoot: 'LeftFoot', rightFoot: 'RightFoot',
  leftKnee: 'LeftLowerLeg', rightKnee: 'RightLowerLeg',
  leftAnkle: 'LeftFootJoint', rightAnkle: 'RightFootJoint',
  leftArm: 'LeftUpperArm', rightArm: 'RightUpperArm', torso: 'UpperTorso',
};

test('gait compiler creates a closed, editable multi-cycle walk with support windows and phase markers', () => {
  const result = compileGait({ name: 'Measured walk', duration: 2, cycles: 2, samplesPerCycle: 16, style: 'walk', jointMap: fullRigMap });
  assert.equal(result.recipe.loop, true);
  assert.equal(result.recipe.priority, 'Movement');
  assert.equal(result.recipe.tracks.length, 9);
  assert.equal(result.recipe.tracks[0]!.keys.length, 33);
  for (const track of result.recipe.tracks) {
    assert.deepEqual(track.keys[0]!.rotation, track.keys.at(-1)!.rotation, track.joint);
    assert.deepEqual(track.keys[0]!.position, track.keys.at(-1)!.position, track.joint);
    assert.equal(track.keys[0]!.time, 0);
    assert.equal(track.keys.at(-1)!.time, result.recipe.duration);
  }
  assert.equal(result.recipe.contacts?.length, 5);
  assert.equal(result.recipe.contacts?.every(contact => contact.kind === 'support' && contact.start < contact.end && contact.end <= result.recipe.duration), true);
  assert.equal(result.recipe.markers.length, 8);
  assert.equal(new Set(result.recipe.markers.map(marker => marker.name)).size, result.recipe.markers.length);
  assert.equal(result.diagnostics.footContactWrapsLoopBoundary, true);
  for (const effector of ['LeftFoot', 'RightFoot']) {
    const ranges = result.recipe.contacts!.filter(contact => contact.effector === effector).sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index]!.start >= ranges[index - 1]!.end);
  }
  assert.ok(result.diagnostics.limitations.some(note => /not IK locks/i.test(note)));
});

test('gait compiler supports minimal R6 legs and named style profiles without fabricating optional tracks', () => {
  const result = compileGait({ name: 'R6 run', duration: 1.2, cycles: 3, style: 'run', jointMap: { leftHip: 'Left Leg', rightHip: 'Right Leg' } });
  assert.deepEqual(result.recipe.tracks.map(track => track.joint), ['Left Leg', 'Right Leg']);
  assert.equal(result.recipe.contacts?.length, 6);
  assert.equal(result.recipe.contacts?.every(contact => contact.effector === 'Left Leg' || contact.effector === 'Right Leg'), true);
  assert.equal(result.diagnostics.style, 'run');
  assert.equal(result.diagnostics.cycleDurationSeconds, 0.4);
  assert.equal(result.diagnostics.peakHipSwingDegrees, 22);
  assert.equal(result.recipe.tracks[0]!.keys[0]!.rotation[0], result.recipe.tracks[0]!.keys.at(-1)!.rotation[0]);
});

test('gait input rejects unsafe maps, unpaired limbs, unsupported cycle counts and per-track key overflow', () => {
  assert.throws(() => gaitSchema.parse({ name: 'Bad map', duration: 2, jointMap: { leftHip: 'Leg', rightHip: 'RightLeg', leftKnee: 'Knee' } }), /Map both left and right knee/);
  assert.throws(() => gaitSchema.parse({ name: 'Duplicate map', duration: 2, jointMap: { leftHip: 'Leg', rightHip: 'RightLeg', leftArm: 'Leg', rightArm: 'RightArm' } }), /mapped more than once/);
  assert.throws(() => gaitSchema.parse({ name: 'Crossed map', duration: 2, jointMap: { leftHip: 'Leg', rightHip: 'RightLeg', leftFoot: 'RightLeg', rightFoot: 'RightFoot' } }), /mapped more than once/);
  assert.throws(() => gaitSchema.parse({ name: 'Too many cycles', duration: 2, cycles: 8, jointMap: { leftHip: 'Leg', rightHip: 'RightLeg' } }));
  assert.throws(() => gaitSchema.parse({ name: 'Too dense', duration: 2, cycles: 7, samplesPerCycle: 24, jointMap: { leftHip: 'Leg', rightHip: 'RightLeg' } }), /128 keys/);
});

test('gait presets have bounded controls, preserve local source data, and produce deterministic recipes', () => {
  const input = { name: 'Sneak', duration: 3, cycles: 2, style: 'sneak', strideDegrees: 12, stanceRatio: 0.72,
    axes: { hip: 'Z', knee: 'Y', torso: 'X' }, jointMap: { leftHip: 'LHip', rightHip: 'RHip', leftKnee: 'LKnee', rightKnee: 'RKnee' } };
  const before = structuredClone(input);
  const first = compileGait(input);
  const second = compileGait(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first.recipe, second.recipe);
  assert.deepEqual(first.recipe.tracks[0]!.keys[3]!.rotation, [0, 0, first.recipe.tracks[0]!.keys[3]!.rotation[2]]);
  assert.equal(first.diagnostics.stanceRatio, 0.72);
});

test('every maximum-size gait style stays inside animation contact, marker, track and key budgets', () => {
  for (const style of ['walk', 'run', 'sneak'] as const) {
    const result = compileGait({ name: `Max ${style}`, duration: 30, cycles: 7, samplesPerCycle: 18, style,
      jointMap: { leftHip: 'LHip', rightHip: 'RHip', leftKnee: 'LKnee', rightKnee: 'RKnee', leftFoot: 'LFoot', rightFoot: 'RFoot' } });
    assert.ok(result.recipe.contacts!.length <= 16, style);
    assert.ok(result.recipe.markers.length <= 100, style);
    assert.ok(result.diagnostics.generatedKeyCount <= 4096, style);
    assert.ok(result.recipe.tracks.every(track => track.keys.length <= 128), style);
  }
});

test('stride reach ratios convert through inspected proportions and fail closed on a broken leg chain', () => {
  const profile = (scale: number) => retargetProfileSchema.parse({ version: 1, rigId: randomUUID(), rigName: 'Proportion fixture', rigType: 'custom', rigSignature: `leg-${scale}`,
    joints: [
      { name: 'Root', parent: '', driven: false, basis: [0, 0, 0, 1], segmentLength: 0 },
      { name: 'LeftHip', parent: 'Root', driven: true, basis: [0, 0, 0, 1], segmentLength: 0.5 * scale },
      { name: 'LeftKnee', parent: 'LeftHip', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 * scale },
      { name: 'LeftFoot', parent: 'LeftKnee', driven: true, basis: [0, 0, 0, 1], segmentLength: 1.5 * scale },
      { name: 'RightHip', parent: 'Root', driven: true, basis: [0, 0, 0, 1], segmentLength: 0.5 * scale },
      { name: 'RightKnee', parent: 'RightHip', driven: true, basis: [0, 0, 0, 1], segmentLength: 2 * scale },
      { name: 'RightFoot', parent: 'RightKnee', driven: true, basis: [0, 0, 0, 1], segmentLength: 1.5 * scale },
    ] });
  const input = { name: 'Proportion stride', duration: 1, style: 'walk', strideReachRatio: 0.25,
    jointMap: { leftHip: 'LeftHip', rightHip: 'RightHip', leftKnee: 'LeftKnee', rightKnee: 'RightKnee', leftFoot: 'LeftFoot', rightFoot: 'RightFoot' } };
  const normal = compileGait(input, profile(1));
  const tall = compileGait(input, profile(2));
  assert.equal(normal.diagnostics.strideCalibration.halfStrideReachRatio, 0.25);
  assert.deepEqual(normal.diagnostics.strideCalibration.measuredLegLengthStuds, { left: 4, right: 4 });
  assert.deepEqual(normal.diagnostics.strideCalibration.estimatedHalfStrideReachStuds, { left: 1, right: 1 });
  assert.deepEqual(tall.diagnostics.strideCalibration.measuredLegLengthStuds, { left: 8, right: 8 });
  assert.deepEqual(tall.diagnostics.strideCalibration.estimatedHalfStrideReachStuds, { left: 2, right: 2 });
  assert.deepEqual(normal.recipe.tracks[0]!.keys.map(key => key.rotation), tall.recipe.tracks[0]!.keys.map(key => key.rotation));
  assert.throws(() => gaitSchema.parse({ ...input, strideDegrees: 30 }), /Choose strideReachRatio or strideDegrees/);

  const broken = profile(1);
  broken.joints.find(joint => joint.name === 'LeftFoot')!.parent = 'Root';
  assert.throws(() => compileGait(input, broken), /each mapped foot must be a descendant/i);
  const withoutProfile = compileGait(input);
  assert.deepEqual(withoutProfile.diagnostics.strideCalibration.measuredLegLengthStuds, { left: null, right: null });
  assert.deepEqual(withoutProfile.diagnostics.strideCalibration.estimatedHalfStrideReachStuds, { left: null, right: null });
});
