import test from 'node:test';
import assert from 'node:assert/strict';
import { animationPreset } from '../src/recipes.js';
import { createComposedJointSampler, patchAnimation, verifyMotionPreservation } from '../src/animation-patch.js';
import { auditAnimation } from '../src/animation-quality.js';

test('exact channel overrides match clone-based composition through additive layers, later layers, and root motion', () => {
  const source = animationPreset('cast', 'Override compositor parity', 1, 1);
  const joint = 'LeftUpperArm';
  const layerId = '11111111-1111-4111-8111-111111111111';
  const keys = (rotation: [number, number, number], endRotation: [number, number, number]) => [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 0.5, position: [0.1, 0.2, 0] as [number, number, number], rotation },
    { time: 1, position: [0, 0, 0] as [number, number, number], rotation: endRotation },
  ];
  source.tracks = [{ joint, keys: keys([10, 0, 0], [0, 0, 20]) }];
  source.layers = [
    { id: layerId, name: 'Additive target', blendMode: 'Additive', weight: 0.65, enabled: true,
      tracks: [{ joint, keys: keys([0, 18, 0], [0, 0, 0]) }] },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Later override', blendMode: 'Override', weight: 0.3, enabled: true,
      tracks: [{ joint, keys: keys([0, 0, 12], [0, 0, 0]) }] },
  ];
  source.rootMotion = { joint, keys: keys([0, 5, 0], [0, 0, 0]) };

  const override = { layerId, time: 0.5, position: [0.35, -0.1, 0.2] as [number, number, number], rotation: [-24, 33, 8] as [number, number, number] };
  const clone = structuredClone(source);
  const clonedTarget = clone.layers![0]!.tracks[0]!.keys[1]!;
  clonedTarget.position = [...override.position];
  clonedTarget.rotation = [...override.rotation];

  const optimizedPose = createComposedJointSampler(source, joint, override)!(override.time);
  const clonedPose = createComposedJointSampler(clone, joint)!(override.time);
  const baselinePose = createComposedJointSampler(source, joint)!(0.25);
  const optimizedBaselinePose = createComposedJointSampler(source, joint, override)!(0.25);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(optimizedPose.position[axis]! - clonedPose.position[axis]!) < 1e-12, `position axis ${axis} must match cloned composition`);
    assert.ok(Math.abs(baselinePose.position[axis]! - optimizedBaselinePose.position[axis]!) < 1e-12, `off-time override must not affect position axis ${axis}`);
  }
  for (let axis = 0; axis < 4; axis++) {
    assert.ok(Math.abs(optimizedPose.rotation[axis]! - clonedPose.rotation[axis]!) < 1e-12, `rotation component ${axis} must match cloned composition`);
    assert.ok(Math.abs(baselinePose.rotation[axis]! - optimizedBaselinePose.rotation[axis]!) < 1e-12, `off-time override must not affect rotation component ${axis}`);
  }
});

test('animation patch key selection preserves authored beats 50 microseconds apart', () => {
  const makeSource = () => {
    const source = animationPreset('cast', 'Precise key targeting', 1, 1);
    for (const joint of ['LeftUpperArm', 'RightUpperArm']) {
      const track = source.tracks.find(candidate => candidate.joint === joint)!;
      track.keys = [0, 0.5, 1].map(time => ({ time, position: [time, 0, 0] as [number, number, number], rotation: [0, 0, time * 10] as [number, number, number] }));
    }
    return source;
  };
  const nearTime = 0.50005;
  const selectors = [
    { operation: 'set_pose', joint: 'LeftUpperArm', time: nearTime, rotation: [0, 0, 90] },
    { operation: 'offset_pose', joint: 'LeftUpperArm', time: nearTime, rotationOffset: [0, 0, 5] },
    { operation: 'offset_pose_group', time: nearTime, targets: [
      { joint: 'LeftUpperArm', rotationOffset: [0, 0, 5] }, { joint: 'RightUpperArm', rotationOffset: [0, 0, 5] },
    ] },
    { operation: 'set_easing', joint: 'LeftUpperArm', time: nearTime, easingStyle: 'Linear' },
    { operation: 'set_curve', joint: 'LeftUpperArm', time: nearTime, curve: { outTime: 0.2, outValue: 0.1, inTime: 0.8, inValue: 0.9 } },
    { operation: 'delete_key', joint: 'LeftUpperArm', time: nearTime },
    { operation: 'retime_key', joint: 'LeftUpperArm', time: nearTime, newTime: 0.6 },
    { operation: 'mirror_pose', sourceJoint: 'LeftUpperArm', targetJoint: 'RightUpperArm', time: nearTime, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] },
  ] as const;
  for (const operation of selectors) {
    assert.throws(() => patchAnimation(makeSource(), [operation]), /No key on LeftUpperArm at .*Read the recipe/,
      `${operation.operation} must reject an inexact beat instead of editing the nearby key`);
  }

  const inserted = patchAnimation(makeSource(), [{ operation: 'insert_key', joint: 'LeftUpperArm', time: nearTime, position: [2, 0, 0] }]);
  assert.deepEqual(inserted.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.map(key => key.time), [0, 0.5, nearTime, 1]);
  assert.equal(inserted.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.5)!.position[0], 0.5,
    'inserting a nearby beat must leave the original key intact');

  const moved = patchAnimation(makeSource(), [{ operation: 'retime_key', joint: 'LeftUpperArm', time: 0.5, newTime: nearTime }]);
  assert.deepEqual(moved.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.map(key => key.time), [0, nearTime, 1],
    'retiming by 50 microseconds is a real timing change, not a no-op');

  const arithmeticSource = makeSource();
  arithmeticSource.tracks.find(track => track.joint === 'LeftUpperArm')!.keys[1]!.time = 0.3;
  const arithmeticMatch = patchAnimation(arithmeticSource, [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.1 + 0.2, rotation: [0, 0, 25] }]);
  assert.equal(arithmeticMatch.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys[1]!.rotation[2], 25,
    'key matching may absorb floating-point representation noise without merging authored beats');
});

test('protected motion guard accepts unrelated edits and reports measured preservation margins', () => {
  const source = animationPreset('cast', 'Protected cast', 2, 1);
  const candidate = patchAnimation(source, [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 0.5, rotation: [-83, -12, -8] }]).recipe;
  const verified = verifyMotionPreservation(source, candidate, [{ joint: 'LeftUpperArm', startTime: 1, endTime: 1.5, sampleRateHz: 240 }]);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.joint, 'LeftUpperArm');
  assert.equal(verified[0]!.sampleRateHz, 240);
  assert.ok(verified[0]!.sampleCount >= 121);
  assert.ok(verified[0]!.maxPositionDrift <= verified[0]!.positionTolerance);
  assert.ok(verified[0]!.maxRotationDriftDegrees <= verified[0]!.rotationToleranceDegrees);
  assert.throws(() => verifyMotionPreservation(source, candidate, [{ joint: 'LeftUpperArm', startTime: 0.5, endTime: 1 }]), /Protected motion changed for LeftUpperArm/);

  const untouched = verifyMotionPreservation(source, candidate, [{ joint: 'RightUpperArm', startTime: 0.5, endTime: 1 }]);
  assert.equal(untouched[0]!.verificationMethod, 'exact_channel_match');
  assert.equal(untouched[0]!.sampleCount, 0);
  assert.throws(() => verifyMotionPreservation(source, candidate, [
    { joint: 'LeftUpperArm', startTime: 0, endTime: 1 },
    { joint: 'LeftUpperArm', startTime: 0.5, endTime: 1.5 },
  ]), /overlap for LeftUpperArm/);
});

test('protected motion guard detects easing drift from a key before the protected interval and handles layers', () => {
  const source = animationPreset('cast', 'Protected curve', 2, 1);
  const curveEdit = patchAnimation(source, [{ operation: 'set_easing', joint: 'LeftUpperArm', time: 0.5, easingStyle: 'CubicV2', easingDirection: 'In' }]).recipe;
  assert.throws(() => verifyMotionPreservation(source, curveEdit, [{ joint: 'LeftUpperArm', startTime: 0.6, endTime: 0.9 }]), /Protected motion changed for LeftUpperArm/);

  const protectedLayerId = '11111111-1111-4111-8111-111111111111';
  source.layers = [{ id: protectedLayerId, name: 'Secondary', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [structuredClone(source.tracks.find(track => track.joint === 'LeftUpperArm')!)] }];
  const changedLayer = patchAnimation(source, [{ operation: 'set_pose', joint: 'LeftUpperArm', layerId: protectedLayerId, time: 1, rotation: [15, 5, 2] }]).recipe;
  assert.throws(() => verifyMotionPreservation(source, changedLayer, [{ joint: 'LeftUpperArm', scope: 'track', layerId: protectedLayerId, startTime: 0.9, endTime: 1.1 }]), /Protected motion changed for LeftUpperArm in layer/);
  assert.throws(() => verifyMotionPreservation(source, changedLayer, [{ joint: 'LeftUpperArm', startTime: 0.9, endTime: 1.1 }]), /Protected motion changed for LeftUpperArm/);
  const withRootMotion = patchAnimation(source, [{ operation: 'root_motion_set', track: { joint: 'LeftUpperArm', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] } }]).recipe;
  assert.throws(() => verifyMotionPreservation(source, withRootMotion, [{ joint: 'LeftUpperArm', startTime: 0.9, endTime: 1.1 }]), /Protected motion changed for LeftUpperArm/);
  assert.throws(() => verifyMotionPreservation(source, source, [{ joint: 'LeftUpperArm', startTime: 1, endTime: 1 }]), /non-empty time interval/);
  assert.throws(() => verifyMotionPreservation(source, source, [{ joint: 'MissingJoint', startTime: 1, endTime: 1.5 }]), /cannot find any track for MissingJoint/);
  assert.throws(() => verifyMotionPreservation(source, source, [{ joint: 'LeftUpperArm', startTime: 1, endTime: 1.5, sampleRateHz: 90 }]), /Invalid input/);
});

test('track-scoped preservation reports raw-track sampling rather than composed-pose evidence', () => {
  const source = animationPreset('cast', 'Track scope label', 2, 1);
  const torso = source.tracks.find(track => track.joint === 'UpperTorso')!;
  torso.keys = torso.keys.map(key => ({ ...key, position: [0, 0, 0], rotation: [0, 0, 0] }));
  const retimed = patchAnimation(source, [{ operation: 'retime_clip', duration: 4 }]).recipe;
  const result = verifyMotionPreservation(source, retimed, [{ joint: 'UpperTorso', scope: 'track', startTime: 0, endTime: 0.5 }]);
  assert.equal(result[0]!.verificationMethod, 'sampled_track');
  assert.ok(result[0]!.sampleCount > 0);
  assert.equal(result[0]!.maxPositionDrift, 0);
  assert.equal(result[0]!.maxRotationDriftDegrees, 0);
});

test('semantic preservation guards align named phase progress across retimed revisions', () => {
  const source = animationPreset('cast', 'Phase protected cast', 2, 1);
  source.markers = [
    { name: 'Anticipation', time: 0.5 },
    { name: 'Strike', time: 1 },
    { name: 'Recovery', time: 1.5 },
  ];
  const guard = [{ joint: 'LeftUpperArm', phase: { label: 'recovery', occurrence: 1 }, sampleRateHz: 120 }];
  const retimed = patchAnimation(source, [{ operation: 'retime_clip', duration: 4 }]).recipe;
  const verified = verifyMotionPreservation(source, retimed, guard);
  assert.equal(verified[0]!.verificationMethod, 'sampled_normalized_phase_progress');
  assert.equal(verified[0]!.sourceStartTime, 1.5);
  assert.equal(verified[0]!.sourceEndTime, 2);
  assert.equal(verified[0]!.candidateStartTime, 3);
  assert.equal(verified[0]!.candidateEndTime, 4);
  assert.ok(verified[0]!.maxRotationDriftDegrees <= verified[0]!.rotationToleranceDegrees);
  assert.equal(verified[0]!.positionAt, 1.5);
  assert.equal(verified[0]!.candidatePositionAt, 3);

  const shiftedRecoveryMarker = structuredClone(source);
  shiftedRecoveryMarker.markers.find(marker => marker.name === 'Recovery')!.time = 1.7;
  assert.throws(() => verifyMotionPreservation(source, shiftedRecoveryMarker, guard),
    /Protected motion changed for LeftUpperArm in recovery #1/,
    'unchanged key data is not an exact phase match when the semantic marker shifts the protected time range');

  const editedRecovery = patchAnimation(source, [
    { operation: 'retime_clip', duration: 4 },
    { operation: 'set_pose', joint: 'LeftUpperArm', time: 3, rotation: [-30, 0, 0] },
  ]).recipe;
  assert.throws(() => verifyMotionPreservation(source, editedRecovery, guard), /Protected motion changed for LeftUpperArm in recovery #1/);
  assert.throws(() => verifyMotionPreservation(source, retimed, [{ joint: 'LeftUpperArm', phase: { label: 'follow_through', occurrence: 1 } }]), /Protected phase follow_through #1 was not found/);
  assert.throws(() => verifyMotionPreservation(source, retimed, [{ joint: 'LeftUpperArm', startTime: 0, endTime: 1, phase: { label: 'recovery' } }]), /either phase progress or both absolute/);
  assert.throws(() => verifyMotionPreservation(source, retimed, [{ joint: 'LeftUpperArm', phase: { label: 'recovery', startProgress: 0.7, endProgress: 0.3 } }]), /non-empty interval/);
});

test('protected motion verification fails closed when dense layered tracks exceed the evaluation budget', () => {
  const source = animationPreset('walk', 'Dense protected motion', 2, 1);
  const layerCount = 32, keysPerTrack = 128, interiorKeys = layerCount * (keysPerTrack - 2);
  source.layers = Array.from({ length: layerCount }, (_, layerIndex) => ({
    id: `${String(layerIndex + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    name: `Layer ${layerIndex + 1}`, blendMode: 'Additive' as const, weight: 0.5, enabled: true,
    tracks: [{ joint: 'LeftUpperArm', keys: Array.from({ length: keysPerTrack }, (_, keyIndex) => ({
      time: keyIndex === 0 ? 0 : keyIndex === keysPerTrack - 1 ? source.duration : 2 * (layerIndex * (keysPerTrack - 2) + keyIndex) / (interiorKeys + 1),
      position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
    })) }],
  }));
  const candidate = structuredClone(source);
  candidate.layers![0]!.tracks[0]!.keys[1]!.position = [0.01, 0, 0];
  assert.throws(() => verifyMotionPreservation(source, candidate, [{ joint: 'LeftUpperArm', startTime: 0, endTime: 2 }]), /limit 8192/);
});

test('loop closure eases every pose lane to its exact start while preserving earlier keys and root travel', () => {
  const source = animationPreset('cast', 'Loop closure', 2, 1);
  source.loop = false;
  const arm = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  arm.keys.at(-1)!.position = [0.35, 0.1, 0];
  arm.keys.at(-1)!.rotation = [88, -24, 18];
  const layerId = '11111111-1111-4111-8111-111111111111';
  source.layers = [{ id: layerId, name: 'Secondary', blendMode: 'Additive', weight: 0.4, enabled: true,
    tracks: [{ joint: 'Head', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 179, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 2, position: [0.2, 0, 0], rotation: [0, -179, 0] },
    ] }] }];
  source.rootMotion = { joint: 'LowerTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [4, 0, 0], rotation: [0, 0, 0] },
  ] };
  source.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.2, end: 0.6 }];
  source.markers = [{ name: 'Action', time: 1.4 }];
  const original = structuredClone(source);

  const result = patchAnimation(source, [{ operation: 'close_loop', windowSeconds: 0.8, samples: 8 }]);

  assert.equal(result.recipe.loop, true);
  assert.deepEqual(source, original, 'the source remains immutable');
  assert.deepEqual(result.recipe.rootMotion, original.rootMotion, 'traveling root motion is not forced to zero');
  assert.deepEqual(result.recipe.contacts, original.contacts);
  assert.deepEqual(result.recipe.markers, original.markers);
  const allPoseTracks = [...result.recipe.tracks, ...result.recipe.layers!.flatMap(layer => layer.tracks)];
  for (const track of allPoseTracks) {
    assert.deepEqual(track.keys.at(-1)!.position, track.keys[0]!.position);
    assert.deepEqual(track.keys.at(-1)!.rotation, track.keys[0]!.rotation);
    assert.ok(track.keys.every((key, index) => index === 0 || key.time > track.keys[index - 1]!.time));
    assert.deepEqual(track.keys.filter(key => key.time < 1.2), original.tracks.find(sourceTrack => sourceTrack.joint === track.joint)?.keys.filter(key => key.time < 1.2)
      ?? original.layers?.[0]?.tracks.find(sourceTrack => sourceTrack.joint === track.joint)?.keys.filter(key => key.time < 1.2));
  }
  const closure = result.changes[0]!.loopClosure!;
  assert.equal(closure.tracks, allPoseTracks.length);
  assert.ok(closure.maxPositionGapBefore > 0);
  assert.ok(closure.maxAngularGapBeforeDegrees > 0);
  assert.equal(closure.maxPositionGapAfter, 0);
  assert.ok(closure.maxAngularGapAfterDegrees < 1e-6);
  assert.ok(closure.generatedKeys > 0);
  const originalPoseTracks = [...original.tracks, ...original.layers!.flatMap(layer => layer.tracks)];
  for (const [index, track] of allPoseTracks.entries()) {
    assert.deepEqual(track.keys.filter(key => key.time < 1.2), originalPoseTracks[index]!.keys.filter(key => key.time < 1.2),
      'keys before the closure window are preserved exactly, including same-joint tracks on different layers');
  }
  assert.throws(() => patchAnimation(result.recipe, [{ operation: 'close_loop', windowSeconds: 0.5 }]), /already marked as looping/);
});

test('loop closure retains distinct authored keys immediately around its window boundary', () => {
  const source = animationPreset('walk', 'Precise loop closure', 2, 1);
  source.loop = false;
  const track = source.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!;
  track.keys = [0, 0.99995, 1, 1.00005, 1.5, 1.99995, 2].map(time => ({
    time, position: [time, 0, 0] as [number, number, number], rotation: [0, 0, time * 10] as [number, number, number],
  }));

  const result = patchAnimation(source, [{ operation: 'close_loop', windowSeconds: 1, samples: 4 }]);
  const outputTimes = result.recipe.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!.keys.map(key => key.time);
  for (const authoredTime of [0.99995, 1.00005, 1.99995]) {
    assert.ok(outputTimes.includes(authoredTime), `loop closure must retain the authored key at ${authoredTime}s`);
  }
  assert.deepEqual(outputTimes.slice(0, 4), [0, 0.99995, 1, 1.00005], 'a key just before the window stays outside it and a nearby key inside it remains distinct');
});

test('loop closure refuses key-budget overflow before changing any candidate track', () => {
  const source = animationPreset('walk', 'Dense loop close', 2, 1);
  source.loop = false;
  source.tracks[0]!.keys = Array.from({ length: 128 }, (_, index) => ({
    time: 2 * index / 127, position: [index / 127, 0, 0] as [number, number, number], rotation: [0, index, 0] as [number, number, number],
  }));
  const original = structuredClone(source);
  assert.throws(() => patchAnimation(source, [{ operation: 'close_loop', windowSeconds: 0.1, samples: 64 }]), /limit 128/);
  assert.deepEqual(source, original, 'failed preview must not mutate the source');
});

test('loop seam smoothing equalizes endpoint velocities and reports protected contacts', () => {
  const source = animationPreset('idle', 'Seam smoothing', 2, 1);
  source.loop = true;
  source.tracks = [{ joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.5, position: [1, 0, 0], rotation: [60, 0, 0] },
    { time: 1.5, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  const original = structuredClone(source);
  const before = auditAnimation(source).loopSeamVelocity[0]!;
  const repaired = patchAnimation(source, [{ operation: 'smooth_loop_seam', strength: 1 }]);
  const report = repaired.changes[0]!.loopSeamSmoothing!;
  const after = auditAnimation(repaired.recipe).loopSeamVelocity[0]!;
  assert.deepEqual(source, original, 'preview never mutates the source');
  assert.equal(report.tracksChanged, 1);
  assert.equal(report.tracksSkipped.length, 0);
  assert.ok(before.positionDiscontinuityStudsPerSecond > 1.9);
  assert.ok(after.positionDiscontinuityStudsPerSecond < 0.001);
  assert.ok(before.angularDiscontinuityDegreesPerSecond > 100);
  assert.ok(after.angularDiscontinuityDegreesPerSecond < 0.1);
  assert.deepEqual(repaired.recipe.tracks[0]!.keys[0]!.position, [0, 0, 0]);
  assert.deepEqual(repaired.recipe.tracks[0]!.keys.at(-1)!.position, [0, 0, 0]);
  assert.equal(repaired.recipe.loop, true);

  const protectedSource = structuredClone(source);
  protectedSource.contacts = [{ effector: 'UpperTorso', kind: 'grip', start: 0.1, end: 0.2 }];
  assert.throws(() => patchAnimation(protectedSource, [{ operation: 'smooth_loop_seam' }]), /No loop tracks could be smoothed.*overlaps a seam handle/i);
  const explicitlyAllowed = patchAnimation(protectedSource, [{ operation: 'smooth_loop_seam', protectContacts: false }]);
  assert.equal(explicitlyAllowed.changes[0]!.loopSeamSmoothing!.tracksChanged, 1);
});

test('curve-aware key compression honors sampled error budgets and protects contact and marker keys', () => {
  const source = animationPreset('idle', 'Dense smooth curve', 2, 1);
  source.loop = false;
  source.tracks = [{ joint: 'UpperTorso', keys: Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32;
    const time = source.duration * progress;
    const pose = index === 0 || index === 32 ? 0 : Math.sin(progress * Math.PI * 2);
    return { time, position: [0.2 * pose, 0, 0] as [number, number, number], rotation: [24 * pose, 0, 0] as [number, number, number], easingStyle: 'Linear' as const, easingDirection: 'Out' as const };
  }) }];
  source.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 1.5 }];
  source.markers = [{ name: 'Impact', time: 1 }];
  const original = structuredClone(source);

  const result = patchAnimation(source, [{ operation: 'compress_track', joint: 'UpperTorso', maxPositionErrorStuds: 0.005,
    maxRotationErrorDegrees: 0.25, sampleRateHz: 120 }]);

  const compressed = result.recipe.tracks[0]!;
  const report = result.changes[0]!.compression!;
  assert.deepEqual(source, original, 'compression is non-destructive');
  assert.ok(report.removedKeys > 0);
  assert.equal(report.originalKeys, 33);
  assert.equal(report.retainedKeys, compressed.keys.length);
  assert.ok(report.maxPositionErrorStuds <= report.positionToleranceStuds);
  assert.ok(report.maxRotationErrorDegrees <= report.rotationToleranceDegrees);
  assert.equal(report.toleranceSatisfiedAtSamples, true);
  assert.ok(report.sampleCount > 240);
  assert.ok(compressed.keys.some(key => key.time === 1), 'a key at an authored marker is protected');
  for (let index = 8; index <= 24; index++) assert.ok(compressed.keys.some(key => Math.abs(key.time - index * 0.0625) < 1e-10), 'keys inside a declared contact window are protected');
  assert.deepEqual(compressed.keys[0], original.tracks[0]!.keys[0]);
  assert.deepEqual(compressed.keys.at(-1), original.tracks[0]!.keys.at(-1));
});

test('key compression handles additive layers and the maximum supported validation sample rate', () => {
  const source = animationPreset('idle', 'Layer compression', 1, 1);
  source.loop = false;
  const layerId = '11111111-1111-4111-8111-111111111111';
  source.layers = [{ id: layerId, name: 'Secondary', blendMode: 'Additive', weight: 0.5, enabled: true,
    tracks: [{ joint: 'Head', keys: Array.from({ length: 17 }, (_, index) => ({ time: index / 16, position: [0, 0, 0] as [number, number, number], rotation: [index * 2, 0, 0] as [number, number, number] })) }] }];
  const result = patchAnimation(source, [{ operation: 'compress_track', joint: 'Head', layerId, maxPositionErrorStuds: 0, maxRotationErrorDegrees: 0.01 }]);
  assert.ok(result.changes[0]!.compression!.removedKeys > 0);
  assert.equal(result.recipe.layers![0]!.tracks[0]!.keys[0]!.rotation[0], 0);
  assert.equal(result.recipe.layers![0]!.tracks[0]!.keys.at(-1)!.rotation[0], 32);
  const dense = animationPreset('walk', 'Maximum sample rate', 30, 1);
  const sampled = patchAnimation(dense, [{ operation: 'compress_track', joint: dense.tracks[0]!.joint, sampleRateHz: 240 }]);
  assert.ok(sampled.changes[0]!.compression!.sampleCount > 7000);
  assert.ok(sampled.changes[0]!.compression!.sampleCount <= 8192);
});

test('targeted pose patches preserve the source and every untouched joint', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const originalArm = structuredClone(source.tracks.find(track => track.joint === 'RightUpperArm'));
  const result = patchAnimation(source, [{ operation: 'set_pose', joint: 'LeftUpperArm', time: 1, rotation: [-82, -12, -8] }]);

  assert.deepEqual(source.tracks.find(track => track.joint === 'LeftUpperArm')?.keys[2]?.rotation, [-70, -10, -10]);
  assert.deepEqual(result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')?.keys[2]?.rotation, [-82, -12, -8]);
  assert.deepEqual(result.recipe.tracks.find(track => track.joint === 'RightUpperArm'), originalArm);
  assert.equal(result.changes.length, 1);
});

test('offset_pose incrementally edits an existing keyed pose without replacing its authored transform', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const sourceTrack = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const sourceKey = structuredClone(sourceTrack.keys.find(key => key.time === 1)!);
  const originalSource = structuredClone(sourceKey);
  const result = patchAnimation(source, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 1,
    positionOffset: [0.1, -0.2, 0], rotationOffset: [0, 15, 0] }]);
  const changedKey = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 1)!;

  assert.deepEqual(source.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 1), originalSource);
  assert.deepEqual(changedKey.position, sourceKey.position.map((value, axis) => value + [0.1, -0.2, 0][axis]!));
  assert.notDeepEqual(changedKey.rotation, sourceKey.rotation);
  assert.deepEqual(result.changes[0], { operation: 'offset_pose', joint: 'LeftUpperArm', time: 1,
    poseBefore: { position: sourceKey.position, rotation: sourceKey.rotation },
    poseAfter: { position: changedKey.position, rotation: changedKey.rotation },
    poseOffset: { position: [0.1, -0.2, 0], rotation: [0, 15, 0] } });

  const restored = patchAnimation(result.recipe, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 1,
    positionOffset: [-0.1, 0.2, 0], rotationOffset: [0, -15, 0] }]).recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 1)!;
  assert.ok(restored.rotation.every((value, axis) => Math.abs(value - sourceKey.rotation[axis]!) < 1e-8));
  assert.deepEqual(restored.position, sourceKey.position);
  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 0.75, rotationOffset: [0, 10, 0] }]), /No key.*at 0.75s/);
  const breakdown = patchAnimation(source, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 0.75,
    positionOffset: [0.2, 0, 0], insertIfMissing: true }]);
  const inserted = breakdown.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.75)!;
  assert.equal(breakdown.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.length, sourceTrack.keys.length + 1);
  assert.deepEqual(inserted.position, [0.2, 0, 0]);
  assert.equal(breakdown.changes[0]!.insertedKey, true);
  assert.deepEqual(breakdown.changes[0]!.poseBefore, { position: [0, 0, 0], rotation: inserted.rotation });
  assert.deepEqual(breakdown.changes[0]!.poseAfter, { position: inserted.position, rotation: inserted.rotation });
  assert.deepEqual(breakdown.changes[0]!.poseOffset, { position: [0.2, 0, 0] });
  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 0.0002,
    rotationOffset: [0, 5, 0] }]), /No key.*at 0.0002s/);
  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose', joint: 'LeftUpperArm', time: 1, positionOffset: [0, 0, 0] }]), /identity operation/);
});

test('offset_pose_group atomically sculpts multiple joints and reports each joint pose delta', () => {
  const source = animationPreset('cast', 'Coordinated pose', 2, 1);
  const original = structuredClone(source);
  const result = patchAnimation(source, [{ operation: 'offset_pose_group', time: 0.75, insertIfMissing: true, targets: [
    { joint: 'LeftUpperArm', positionOffset: [0.1, 0, 0] },
    { joint: 'RightUpperArm', rotationOffset: [0, 15, 0] },
  ] }]);

  assert.deepEqual(source, original);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(result.changes.map(change => change.joint), ['LeftUpperArm', 'RightUpperArm']);
  for (const change of result.changes) {
    assert.equal(change.operation, 'offset_pose_group');
    assert.equal(change.time, 0.75);
    assert.equal(change.insertedKey, true);
    const track = result.recipe.tracks.find(candidate => candidate.joint === change.joint)!;
    const key = track.keys.find(candidate => candidate.time === 0.75)!;
    assert.deepEqual(change.poseAfter, { position: key.position, rotation: key.rotation });
  }
  assert.deepEqual(result.changes[0]!.poseOffset, { position: [0.1, 0, 0] });
  assert.deepEqual(result.changes[1]!.poseOffset, { rotation: [0, 15, 0] });

  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose_group', time: 0.75, targets: [
    { joint: 'LeftUpperArm', rotationOffset: [0, 5, 0] },
    { joint: 'MissingJoint', positionOffset: [0.1, 0, 0] },
  ] }]), /No animation track for MissingJoint/);
  assert.deepEqual(source, original, 'a failed group preflight must leave its source recipe unchanged');
  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose_group', time: 1, targets: [
    { joint: 'LeftUpperArm', rotationOffset: [0, 5, 0] },
    { joint: 'leftupperarm', positionOffset: [0.1, 0, 0] },
  ] }]), /unique, ignoring case/);
  assert.throws(() => patchAnimation(source, [{ operation: 'offset_pose_group', time: 0.5, targets: [
    { joint: 'leftupperarm', rotationOffset: [0, 5, 0] },
    { joint: 'RightUpperArm', positionOffset: [0.1, 0, 0] },
  ] }]), /exact case-sensitive joint name/);
});

test('breakdown insertion interpolates unspecified transforms and stays ordered', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const result = patchAnimation(source, [{ operation: 'insert_key', joint: 'LeftUpperArm', time: 0.75, rotation: [-60, -8, -9] }]);
  const keys = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys;
  const inserted = keys.find(key => key.time === 0.75)!;

  assert.equal(keys.length, 6);
  assert.deepEqual(inserted.position, [0, 0, 0]);
  assert.deepEqual(inserted.rotation, [-60, -8, -9]);
  assert.ok(keys.every((key, index) => index === 0 || key.time > keys[index - 1]!.time));
});

test('mirror_pose copies a keyed transform with explicit signs and leaves source data untouched', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const sourceTrack = source.tracks.find(track => track.joint === 'RightUpperArm')!;
  const sourceKey = sourceTrack.keys.find(key => key.time === 0.5)!;
  sourceKey.position = [1, 2, 3]; sourceKey.rotation = [30, 45, 60];
  const originalSource = structuredClone(sourceKey);

  const result = patchAnimation(source, [{ operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', time: 0.5, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] }]);

  const target = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.5)!;
  assert.deepEqual(target.position, [-1, 2, 3]);
  assert.deepEqual(target.rotation, [30, -45, -60]);
  assert.deepEqual(sourceTrack.keys.find(key => key.time === 0.5), originalSource);
  assert.deepEqual(result.changes[0], { operation: 'mirror_pose', joint: 'LeftUpperArm', sourceJoint: 'RightUpperArm', time: 0.5 });
});

test('mirror_pose inserts a missing interior target key and rejects unsafe mappings', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const targetTrack = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  targetTrack.keys = targetTrack.keys.filter(key => key.time !== 0.5);
  const result = patchAnimation(source, [{ operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', time: 0.5, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] }]);
  const inserted = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.5)!;
  assert.deepEqual(inserted.rotation, source.tracks.find(track => track.joint === 'RightUpperArm')!.keys.find(key => key.time === 0.5)!.rotation.map((value, axis) => value * [1, -1, -1][axis]!));
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'MissingJoint', time: 0.5, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] }]), /No animation track/);
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'RightUpperArm', time: 0.5, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] }]), /must be different/);
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_pose', sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', time: 0.4, positionSigns: [-1, 1, 1], rotationSigns: [1, -1, -1] }]), /No key/);
});

test('mirror_tracks swaps bilateral motion from an immutable source snapshot with explicit mappings', () => {
  const source = animationPreset('cast', 'Bilateral mirror', 2, 1);
  const left = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const right = source.tracks.find(track => track.joint === 'RightUpperArm')!;
  left.keys[2]!.position = [1, 2, 3]; left.keys[2]!.rotation = [25, 40, 60]; left.keys[2]!.easingStyle = 'CubicV2';
  right.keys[2]!.position = [4, 5, 6]; right.keys[2]!.rotation = [-30, -45, -70]; right.keys[2]!.easingDirection = 'In';
  const original = structuredClone(source);
  const mappings = [
    { sourceJoint: 'RightUpperArm', targetJoint: 'LeftUpperArm', positionSigns: [-1, 1, 1] as [number, number, number], rotationSigns: [1, -1, -1] as [number, number, number] },
    { sourceJoint: 'LeftUpperArm', targetJoint: 'RightUpperArm', positionSigns: [-1, 1, 1] as [number, number, number], rotationSigns: [1, -1, -1] as [number, number, number] },
  ];

  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_tracks', mappings }]), /Set replaceExisting=true/);
  const result = patchAnimation(source, [{ operation: 'mirror_tracks', mappings, replaceExisting: true }]);
  const mirroredLeft = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const mirroredRight = result.recipe.tracks.find(track => track.joint === 'RightUpperArm')!;
  assert.deepEqual(mirroredLeft.keys.map(key => key.position), original.tracks.find(track => track.joint === 'RightUpperArm')!.keys.map(key => key.position.map((value, axis) => value === 0 ? 0 : value * [-1, 1, 1][axis]!)));
  assert.deepEqual(mirroredLeft.keys.map(key => key.rotation), original.tracks.find(track => track.joint === 'RightUpperArm')!.keys.map(key => key.rotation.map((value, axis) => value === 0 ? 0 : value * [1, -1, -1][axis]!)));
  assert.deepEqual(mirroredRight.keys.map(key => key.rotation), original.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.map(key => key.rotation.map((value, axis) => value === 0 ? 0 : value * [1, -1, -1][axis]!)));
  assert.equal(mirroredLeft.keys[2]!.easingDirection, 'In');
  assert.equal(mirroredRight.keys[2]!.easingStyle, 'CubicV2');
  assert.deepEqual(source, original, 'mirroring must not mutate the source asset');
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0]!.keyCount, right.keys.length);
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_tracks', mappings: [mappings[0]!, { ...mappings[1]!, targetJoint: 'LeftUpperArm' }], replaceExisting: true }]), /unique target joint/i);
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_tracks', mappings: [{ ...mappings[0]!, targetJoint: 'rightupperarm' }] }]), /different, ignoring case/i);
  assert.throws(() => patchAnimation(source, [{ operation: 'mirror_tracks', mappings: [{ ...mappings[0]!, sourceJoint: 'MissingJoint' }] }]), /No source animation track/);
});

test('transform_track scales and offsets every key while preserving timing, easing and its source', () => {
  const source = animationPreset('cast', 'Track shaping', 2, 1);
  const sourceTrack = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const sourceKey = sourceTrack.keys.find(key => key.time === 0.5)!;
  sourceKey.position = [1, 2, 3]; sourceKey.rotation = [20, 40, 60]; sourceKey.easingStyle = 'CubicV2'; sourceKey.easingDirection = 'In';
  const original = structuredClone(source);

  const result = patchAnimation(source, [{ operation: 'transform_track', joint: 'LeftUpperArm', positionScale: [2, 1, 1], positionOffset: [0, 0.5, 0], rotationScale: [1, 0.5, 1], rotationOffset: [0, 5, 0] }]);

  const transformed = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const key = transformed.keys.find(item => item.time === 0.5)!;
  assert.equal(transformed.keys.length, sourceTrack.keys.length);
  assert.deepEqual(key.position, [2, 2.5, 3]);
  assert.deepEqual(key.rotation, [20, 25, 60]);
  assert.equal(key.easingStyle, 'CubicV2');
  assert.equal(key.easingDirection, 'In');
  assert.deepEqual(transformed.keys.map(item => item.time), original.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.map(item => item.time));
  assert.deepEqual(source, original);
});

test('transform_track mirrors a whole joint track only with explicit overwrite consent', () => {
  const source = animationPreset('cast', 'Track mirror', 2, 1);
  const sourceTrack = source.tracks.find(track => track.joint === 'RightUpperArm')!;
  const originalSource = structuredClone(sourceTrack);
  const operation = { operation: 'transform_track' as const, joint: 'LeftUpperArm', sourceJoint: 'RightUpperArm', positionScale: [-1, 1, 1] as [number, number, number], rotationScale: [1, -1, -1] as [number, number, number] };

  assert.throws(() => patchAnimation(source, [operation]), /replaceExisting=true/);
  const result = patchAnimation(source, [{ ...operation, replaceExisting: true }]);
  const mirrored = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!;
  assert.deepEqual(mirrored.keys.map(key => key.time), sourceTrack.keys.map(key => key.time));
  assert.deepEqual(mirrored.keys.map(key => key.rotation), sourceTrack.keys.map(key => key.rotation.map((value, axis) => value === 0 ? 0 : value * [1, -1, -1][axis]!)));
  assert.deepEqual(source.tracks.find(track => track.joint === 'RightUpperArm'), originalSource);

  const withoutTarget = animationPreset('cast', 'Track copy', 2, 1);
  withoutTarget.tracks = withoutTarget.tracks.filter(track => track.joint !== 'LeftUpperArm');
  const copied = patchAnimation(withoutTarget, [operation]);
  assert.ok(copied.recipe.tracks.some(track => track.joint === 'LeftUpperArm'));
  assert.throws(() => patchAnimation(source, [{ operation: 'transform_track', joint: 'LeftUpperArm', positionScale: [1, 1, 1] }]), /identity operation/);
  assert.throws(() => patchAnimation(source, [{ operation: 'transform_track', joint: 'LeftUpperArm', rotationScale: [5, 1, 1] }]), /too_big|less than or equal to 4/i);
});

test('retiming and deleting preserve clip endpoints and produce a valid child recipe', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const result = patchAnimation(source, [
    { operation: 'retime_key', joint: 'LeftUpperArm', time: 0.5, newTime: 0.6 },
    { operation: 'delete_key', joint: 'LeftUpperArm', time: 1 },
  ]);
  const keys = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys;

  assert.equal(keys.length, 4);
  assert.equal(keys[0]!.time, 0);
  assert.equal(keys.at(-1)!.time, 2);
  assert.equal(keys[1]!.time, 0.6);
});

test('clip retiming scales every timeline channel without changing pose data or source', () => {
  const source = animationPreset('walk', 'Timed walk', 2, 1);
  source.rootMotion = { joint: 'LowerTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [1, 0, 0], rotation: [0, 10, 0], easingStyle: 'CubicV2' },
    { time: 2, position: [2, 0, 0], rotation: [0, 0, 0] },
  ] };
  source.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 1.25 }];
  source.markers = [{ name: 'Footstep', time: 0.75, value: 'left' }];
  source.layers = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Follow through', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [{ joint: 'LeftUpperArm', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] }];
  const original = structuredClone(source);

  const result = patchAnimation(source, [{ operation: 'retime_clip', duration: 4 }]);

  assert.equal(result.recipe.duration, 4);
  assert.equal(result.recipe.tracks.find(track => track.joint === 'LeftUpperLeg')!.keys[1]!.time, 1);
  assert.deepEqual(result.recipe.tracks.find(track => track.joint === 'LeftUpperLeg')!.keys[1]!.rotation, original.tracks.find(track => track.joint === 'LeftUpperLeg')!.keys[1]!.rotation);
  assert.equal(result.recipe.rootMotion!.keys[1]!.time, 2);
  assert.deepEqual(result.recipe.rootMotion!.keys[1]!.rotation, [0, 10, 0]);
  assert.equal(result.recipe.rootMotion!.keys[1]!.easingStyle, 'CubicV2');
  assert.deepEqual(result.recipe.contacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.5, end: 2.5 }]);
  assert.equal(result.recipe.markers[0]!.time, 1.5);
  assert.equal(result.recipe.layers![0]!.tracks[0]!.keys.at(-1)!.time, 4);
  assert.deepEqual(source, original);
  assert.deepEqual(result.changes[0], { operation: 'retime_clip', joint: 'timeline', time: 2, previousDuration: 2, newDuration: 4 });
});

test('clip retiming is sequential and rejects no-op or invalid durations', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const result = patchAnimation(source, [
    { operation: 'retime_clip', duration: 4 },
    { operation: 'set_pose', joint: 'LeftUpperArm', time: 2, rotation: [-91, -3, -4] },
  ]);
  assert.deepEqual(result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys[2]!.rotation, [-91, -3, -4]);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_clip', duration: 2 }]), /already has a duration/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_clip', duration: 31 }]), /too_big|less than or equal to 30/i);
});

test('phase retiming scales the named interval and shifts every later animation channel together', () => {
  const source = animationPreset('cast', 'Phase retime', 2, 1);
  source.markers = [
    { name: 'Anticipation', time: 0.5 },
    { name: 'Strike', time: 1 },
    { name: 'Recovery', time: 1.5 },
  ];
  source.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 1.25 }];
  source.rootMotion = { joint: 'HumanoidRootPart', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.75, position: [0, 0, 1], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 2], rotation: [0, 0, 0] },
  ] };
  const layerId = '11111111-1111-4111-8111-111111111111';
  source.layers = [{ id: layerId, name: 'Accent', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [structuredClone(source.tracks[0]!)] }];
  const original = structuredClone(source);

  const patched = patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'anticipation', endMarker: 'STRIKE', newDuration: 0.25 }]);
  const candidate = patched.recipe;
  assert.equal(candidate.duration, 1.75);
  assert.deepEqual(candidate.markers.map(marker => marker.time), [0.5, 0.75, 1.25]);
  assert.deepEqual(candidate.tracks[0]!.keys.map(key => key.time), [0, 0.5, 0.75, 1.25, 1.75]);
  assert.deepEqual(candidate.tracks[0]!.keys.map(key => key.rotation), original.tracks[0]!.keys.map(key => key.rotation));
  assert.deepEqual(candidate.layers![0]!.tracks[0]!.keys.map(key => key.time), [0, 0.5, 0.75, 1.25, 1.75]);
  assert.deepEqual(candidate.rootMotion!.keys.map(key => key.time), [0, 0.625, 1.75]);
  assert.deepEqual(candidate.contacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 1 }]);
  assert.deepEqual(source, original, 'phase retiming must not mutate the source recipe');
  assert.equal(patched.changes[0]!.previousPhaseDuration, 0.5);
  assert.equal(patched.changes[0]!.newPhaseDuration, 0.25);
  assert.deepEqual(patched.changes[0]!.timeMap, [
    { sourceStart: 0, sourceEnd: 0.5, candidateStart: 0, candidateEnd: 0.5, mode: 'unchanged', scale: 1, offset: 0 },
    { sourceStart: 0.5, sourceEnd: 1, candidateStart: 0.5, candidateEnd: 0.75, mode: 'scaled', scale: 0.5, offset: 0.25 },
    { sourceStart: 1, sourceEnd: 2, candidateStart: 0.75, candidateEnd: 1.75, mode: 'shifted', scale: 1, offset: -0.25 },
  ]);
  assert.deepEqual(patched.changes[0]!.affected, {
    baseKeys: original.tracks.reduce((count, track) => count + track.keys.filter(key => key.time > 0.5).length, 0),
    layerKeys: 3,
    rootMotionKeys: 2,
    contactIntervals: 1,
    markers: 2,
  });
  assert.ok(verifyMotionPreservation(source, candidate, [{ joint: 'LeftUpperArm', phase: { label: 'recovery' } }])[0]!.maxRotationDriftDegrees <= 0.1);
});

test('phase adjustment shapes selected tracks with a smooth envelope and leaves boundary/outside keys exact', () => {
  const source = animationPreset('cast', 'Phase sculpt', 2, 1);
  const track = source.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!;
  track.keys = [0, 0.5, 0.625, 0.75, 1, 1.25, 1.375, 1.5, 2].map(time => ({
    time,
    position: [0, 0, 0],
    rotation: [0, time === 1 ? 170 : 0, 0],
  }));
  source.markers = [{ name: 'Anticipation', time: 0.5 }, { name: 'Impact', time: 1.5 }];
  const original = structuredClone(source);
  const originalTrack = original.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!;
  const patched = patchAnimation(source, [{ operation: 'adjust_phase', startMarker: 'anticipation', endMarker: 'IMPACT', joints: ['LeftUpperArm'],
    positionOffset: [1, 0, 0], rotationOffset: [0, 30, 0], fadeInProgress: 0.25, fadeOutProgress: 0.25, easingStyle: 'Linear' }]);
  const candidate = patched.recipe.tracks.find(item => item.joint === 'LeftUpperArm')!;
  assert.deepEqual(source, original, 'phase sculpting must never mutate its source recipe');
  assert.deepEqual(candidate.keys.filter(key => key.time <= 0.5 || key.time >= 1.5), originalTrack.keys.filter(key => key.time <= 0.5 || key.time >= 1.5));
  assert.equal(candidate.keys.find(key => key.time === 0.625)!.position[0], 0.5, 'first fade should apply half the requested translation');
  assert.equal(candidate.keys.find(key => key.time === 0.75)!.position[0], 1, 'the interior plateau should apply the full translation');
  assert.equal(candidate.keys.find(key => key.time === 1.375)!.position[0], 0.5, 'last fade should return smoothly toward the original pose');
  assert.ok(Math.abs(candidate.keys.find(key => key.time === 1)!.rotation[1]! - 200) < 1e-6, 'rotation offset should compose in quaternion space while preserving the nearest Euler winding');
  assert.equal(patched.changes.length, 1);
  assert.equal(patched.changes[0]!.phaseAdjustment?.changedKeys, 5);
  assert.equal(patched.changes[0]!.phaseStartTime, 0.5);
  assert.equal(patched.changes[0]!.phaseEndTime, 1.5);
});

test('phase adjustment uses explicit marker occurrences and fails closed on missing boundaries, tracks, contacts, and interior keys', () => {
  const source = animationPreset('cast', 'Phase sculpt guards', 2, 1);
  source.markers = [{ name: 'Beat', time: 0.5 }, { name: 'Beat', time: 1.5 }];
  source.contacts = [{ effector: 'LeftUpperArm', kind: 'grip', start: 0.75, end: 1.25 }];
  const request = { operation: 'adjust_phase' as const, startMarker: 'Beat', startOccurrence: 1, endMarker: 'beat', endOccurrence: 2,
    joints: ['LeftUpperArm'], rotationOffset: [0, 10, 0] as [number, number, number] };
  assert.throws(() => patchAnimation(source, [{ ...request, startMarker: 'Missing' }]), /Start marker Missing occurrence 1 was not found/);
  assert.throws(() => patchAnimation(source, [{ ...request, endOccurrence: 1 }]), /endOccurrence must be after startOccurrence/);
  const sameTimeBoundaries = structuredClone(source);
  sameTimeBoundaries.markers = [{ name: 'Start', time: 0.5 }, { name: 'End', time: 0.5 }];
  assert.throws(() => patchAnimation(sameTimeBoundaries, [{ ...request, startMarker: 'Start', endMarker: 'End', endOccurrence: 1, allowDeclaredContactOverlap: true }]), /positive time interval/);
  assert.throws(() => patchAnimation(source, [{ ...request, joints: ['MissingJoint'] }]), /No animation track for MissingJoint/);
  assert.throws(() => patchAnimation(source, [{ ...request, joints: ['LeftUpperArm', 'leftupperarm'] }]), /unique, ignoring case/);
  assert.throws(() => patchAnimation(source, [{ ...request, fadeInProgress: 0.6, fadeOutProgress: 0.5 }]), /must not overlap/);
  assert.throws(() => patchAnimation(source, [{ ...request, positionOffset: [0, 0, 0], rotationOffset: [0, 0, 0] }]), /identity operation/);
  assert.throws(() => patchAnimation(source, [request]), /overlaps declared contact/);
  const allowed = patchAnimation(source, [{ ...request, allowDeclaredContactOverlap: true }]);
  assert.deepEqual(allowed.changes[0]!.phaseAdjustment?.overlappingDeclaredContacts, ['grip:LeftUpperArm@0.75-1.25']);

  const missingBoundary = structuredClone(source);
  missingBoundary.tracks.find(item => item.joint === 'LeftUpperArm')!.keys = missingBoundary.tracks.find(item => item.joint === 'LeftUpperArm')!.keys.filter(key => key.time !== 0.5);
  assert.throws(() => patchAnimation(missingBoundary, [{ ...request, allowDeclaredContactOverlap: true }]), /No key on LeftUpperArm at 0.5s/);
  const noInterior = structuredClone(source);
  const noInteriorTrack = noInterior.tracks.find(item => item.joint === 'LeftUpperArm')!;
  noInteriorTrack.keys = noInteriorTrack.keys.filter(key => key.time === 0 || key.time === 0.5 || key.time === 1.5 || key.time === 2);
  assert.throws(() => patchAnimation(noInterior, [{ ...request, allowDeclaredContactOverlap: true }]), /No interior key on LeftUpperArm/);
});

test('phase adjustment can target an animation layer without changing the base track', () => {
  const source = animationPreset('cast', 'Layered phase sculpt', 2, 1);
  source.markers = [{ name: 'Anticipation', time: 0.5 }, { name: 'Recovery', time: 1.5 }];
  const sourceTrack = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  const layerId = '11111111-1111-4111-8111-111111111111';
  source.layers = [{ id: layerId, name: 'Gesture', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [structuredClone(sourceTrack)] }];
  const originalBase = structuredClone(sourceTrack);
  const originalLayer = structuredClone(source.layers[0]!.tracks[0]!);
  const patched = patchAnimation(source, [{ operation: 'adjust_phase', startMarker: 'Anticipation', endMarker: 'Recovery',
    joints: ['LeftUpperArm'], layerId, rotationOffset: [0, 25, 0] }]);
  assert.deepEqual(patched.recipe.tracks.find(track => track.joint === 'LeftUpperArm'), originalBase);
  assert.notDeepEqual(patched.recipe.layers![0]!.tracks[0], originalLayer);
  assert.equal(patched.changes[0]!.layerId, layerId);
  assert.deepEqual(source.layers[0]!.tracks[0], originalLayer, 'layer adjustment must not mutate source data');
});

test('phase adjustment accepts distinct 50-microsecond marker boundaries', () => {
  const source = animationPreset('cast', 'Sub-millisecond phase', 2, 1);
  source.markers = [{ name: 'Start', time: 0.5 }, { name: 'End', time: 0.50005 }];
  const track = source.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!;
  track.keys = [0, 0.5, 0.500025, 0.50005, 2].map(time => ({
    time, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  }));

  const result = patchAnimation(source, [{ operation: 'adjust_phase', startMarker: 'Start', endMarker: 'End', joints: ['LeftUpperArm'],
    positionOffset: [1, 0, 0], fadeInProgress: 0.1, fadeOutProgress: 0.1 }]);
  assert.equal(result.recipe.tracks.find(candidate => candidate.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.500025)!.position[0], 1);
  assert.equal(result.changes[0]!.phaseAdjustment?.changedKeys, 1);
});

test('phase retiming requires ordered existing boundaries, a changed interval, and a valid total duration', () => {
  const source = animationPreset('cast', 'Phase retime guards', 2, 1);
  source.markers = [{ name: 'Beat', time: 0.5 }, { name: 'Beat', time: 1 }, { name: 'End', time: 1.5 }];
  const repeated = patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Beat', startOccurrence: 1, endMarker: 'beat', endOccurrence: 2, newDuration: 0.75 }]).recipe;
  assert.equal(repeated.markers[1]!.time, 1.25);
  assert.equal(repeated.duration, 2.25);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Missing', endMarker: 'End', newDuration: 1 }]), /Start marker Missing occurrence 1 was not found/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'End', endMarker: 'Beat', newDuration: 1 }]), /positive time interval/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Beat', startOccurrence: 1, endMarker: 'Beat', endOccurrence: 1, newDuration: 1 }]), /endOccurrence must be after startOccurrence/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Beat', endMarker: 'End', newDuration: 1 }]), /already has a duration/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Beat', endMarker: 'End', newDuration: 30 }]), /total duration must stay between 0.1 and 30s/);
});

test('phase retiming preserves a 50-microsecond duration change and reports affected channels', () => {
  const source = animationPreset('idle', 'Precise phase retime', 2, 1);
  source.markers = [{ name: 'Start', time: 0.5 }, { name: 'End', time: 0.516 }];
  source.contacts = [{ effector: 'LeftFoot', kind: 'support', start: 0.505, end: 0.51 }];
  const result = patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Start', endMarker: 'End', newDuration: 0.01605 }]);
  const change = result.changes[0]!;
  assert.equal(result.recipe.markers.find(marker => marker.name === 'End')!.time, 0.51605);
  assert.ok(Math.abs(result.recipe.duration - (source.duration + 0.00005)) < 1e-12);
  assert.ok(change.affected!.baseKeys > 0, 'small key shifts must be reflected in the affected-channel count');
  assert.equal(change.affected!.contactIntervals, 1, 'small contact-boundary shifts must be reported');
  assert.equal(change.affected!.markers, 1, 'the moved phase marker must not disappear under a broad diagnostic threshold');
});

test('phase retiming fails with a precise track diagnostic if floating-point mapping collapses keys', () => {
  const source = animationPreset('cast', 'Phase key collision', 2, 1);
  source.markers = [{ name: 'Start', time: 0.5 }, { name: 'End', time: 1 }];
  const track = source.tracks[0]!;
  track.keys.splice(2, 0, { time: 0.5000000000000001, position: [0, 0, 0], rotation: [0, 0, 0] });
  const original = structuredClone(source);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_phase', startMarker: 'Start', endMarker: 'End', newDuration: 0.016 }]), /collapse or reorder base track .*source keys at .*map to non-increasing candidate times.*no revision was saved/i);
  assert.deepEqual(source, original, 'a failed retiming preflight must leave the source recipe untouched');
});

test('patches reject endpoint edits, missing joints, invalid ordering and loop discontinuities', () => {
  const source = animationPreset('walk', 'Walk', 2, 1);

  assert.throws(() => patchAnimation(source, [{ operation: 'delete_key', joint: 'LeftUpperLeg', time: 0 }]), /endpoint keys are fixed/);
  assert.throws(() => patchAnimation(source, [{ operation: 'retime_key', joint: 'LeftUpperLeg', time: 0.5, newTime: 2 }]), /strictly between neighboring keys/);
  assert.throws(() => patchAnimation(source, [{ operation: 'set_pose', joint: 'UnknownJoint', time: 0.5, rotation: [0, 0, 0] }]), /No animation track/);
  assert.throws(() => patchAnimation(source, [{ operation: 'set_pose', joint: 'LeftUpperLeg', time: 0, rotation: [30, 0, 0] }]), /loop end pose must match its start/);
  assert.throws(() => patchAnimation(source, [{ operation: 'insert_key', joint: 'LeftUpperLeg', time: 2, rotation: [0, 0, 0] }]), /strictly inside the clip/);
});

test('root-motion and contact patch operations create immutable semantic authoring channels', () => {
  const source = animationPreset('walk', 'Walk with travel', 2, 1);
  const rootMotion = { joint: 'LowerTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [4, 0, 0], rotation: [0, 90, 0] },
  ] };
  const contacts = [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.2, end: 0.8 }];
  const markers = [{ name: 'Footstep', value: 'left', time: 0.4 }];
  const result = patchAnimation(source, [
    { operation: 'root_motion_set', track: rootMotion },
    { operation: 'contacts_set', contacts },
    { operation: 'markers_set', markers },
  ]);
  assert.deepEqual(result.recipe.rootMotion, rootMotion);
  assert.deepEqual(result.recipe.contacts, contacts);
  assert.deepEqual(result.recipe.markers, markers);
  assert.equal(source.rootMotion, undefined);
  assert.equal(result.changes.length, 3);
  const cleared = patchAnimation(result.recipe, [
    { operation: 'root_motion_clear' }, { operation: 'contacts_set', contacts: [] }, { operation: 'markers_set', markers: [] },
  ]);
  assert.equal(cleared.recipe.rootMotion, undefined);
  assert.deepEqual(cleared.recipe.contacts, []);
  assert.deepEqual(cleared.recipe.markers, []);
  assert.throws(() => patchAnimation(source, [{ operation: 'root_motion_set', track: { ...rootMotion, keys: [rootMotion.keys[0]!, { ...rootMotion.keys[1]!, time: 1 }] } }]), /root-motion keys must span/);
});
