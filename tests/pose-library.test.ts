import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { animationPreset, type AnimationRecipe } from '../src/recipes.js';
import { applyPoseSequenceToAnimation, applyPoseToAnimation, PoseLibrary, poseTransitionOptionsSchema, transitionPosesInAnimation, type Pose } from '../src/pose-library.js';
import { analyzePoseSequenceTransitions } from '../src/pose-sequence-motion.js';
import { createComposedJointSampler } from '../src/animation-patch.js';
import { easeProgress } from '../src/easing.js';
import { quaternionToEulerXYZDegrees } from '../src/rotation.js';

function assertRotationNear(actual: number[], expected: number[], precision = 2) {
  assert.deepEqual(actual.map(value => Number(value.toFixed(precision))), expected.map(value => Number(value.toFixed(precision))));
}

test('pose library persists searchable immutable assets and filters for compatible rigs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-poses-'));
  try {
    const library = new PoseLibrary(directory);
    const pose = await library.save({
      name: 'Arcane Guard', description: 'One hand raised to defend', tags: ['combat', 'guard'], rigType: 'R15',
      transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-55, 12, 8] }],
    });
    assert.equal((await library.get(pose.id)).pose.name, 'Arcane Guard');
    const reopened = new PoseLibrary(directory);
    assert.equal((await reopened.get(pose.id)).pose.name, 'Arcane Guard');
    assert.equal((await reopened.list({ query: 'defend', rigType: 'R15' })).total, 1);
    assert.equal((await reopened.list({ tag: 'combat', rigType: 'R6' })).total, 0);
    assert.equal((await reopened.list({ query: 'missing' })).total, 0);
    const snapshot = await library.save({
      name: 'Full Body Guard', description: 'Snapshot', tags: ['combat'], rigType: 'R15', assetType: 'snapshot', rigSignature: 'R15|Root>Torso:Motor6D',
      transforms: [{ joint: 'UpperTorso', position: [0, 0, 0], rotation: [10, 0, 0] }, { joint: 'Head', position: [0, 0, 0], rotation: [0, 5, 0] }],
    });
    assert.equal((await reopened.list({ assetType: 'snapshot', rigType: 'R15' })).total, 1);
    assert.equal((await reopened.get(snapshot.id)).pose.rigSignature, 'R15|Root>Torso:Motor6D');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pose application inserts or blends matching keys and keeps source recipes unchanged', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const original = structuredClone(source);
  const pose = {
    name: 'Guard', description: '', tags: [], rigType: 'R15' as const, assetType: 'pose' as const,
    transforms: [
      { joint: 'RightUpperArm', position: [1, 0, 0] as [number, number, number], rotation: [-20, 0, 0] as [number, number, number] },
      { joint: 'UnmappedCustomJoint', position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    ],
  };
  const applied = applyPoseToAnimation(source, pose, 0.75, 0.5);
  assert.deepEqual(applied.applied, ['RightUpperArm']);
  assert.deepEqual(applied.skipped, ['UnmappedCustomJoint'], 'pose application must make unmapped joints visible to the caller');
  const track = applied.recipe.tracks.find(candidate => candidate.joint === 'RightUpperArm')!;
  const inserted = track.keys.find(key => key.time === 0.75)!;
  assertRotationNear(inserted.rotation, [-38.29, 7.16, 5.33]);
  assert.deepEqual(inserted.position, [0.5, 0, 0]);
  assert.deepEqual(source, original);
});

test('pose insertion and pose sequences preserve outgoing Bezier easing metadata from the original segment', () => {
  const curve = { outTime: 0.15, outValue: 0.05, inTime: 0.8, inValue: 0.95 } as const;
  const source: AnimationRecipe = { kind: 'animation', name: 'Bezier source', duration: 1, loop: false, markers: [],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier', easingDirection: 'InOut', curve },
      { time: 1, position: [2, 0, 0], rotation: [0, 90, 0] },
    ] }] };
  const pose: Pose = { name: 'Midpoint', description: '', tags: [], rigType: 'custom', assetType: 'pose',
    transforms: [{ joint: 'RightArm', position: [1, 0, 0], rotation: [0, 45, 0] }] };
  const single = applyPoseToAnimation(source, pose, 0.5);
  const sequence = applyPoseSequenceToAnimation(source, [{ poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.5 }], [pose]);
  for (const candidate of [single.recipe, sequence.recipe]) {
    const inserted = candidate.tracks[0]!.keys.find(key => key.time === 0.5)!;
    assert.equal(inserted.easingStyle, 'Bezier');
    assert.equal(inserted.easingDirection, 'InOut');
    assert.deepEqual(inserted.curve, curve);
  }
  assert.deepEqual(source.tracks[0]!.keys[0]!.curve, curve, 'inherited curve handles must be cloned and source data stay unchanged');
});

test('pose previews and sequences target an explicit animation layer without mutating base tracks', () => {
  const layerId = '11111111-1111-4111-8111-111111111111';
  const source: AnimationRecipe = { kind: 'animation', name: 'Layered pose source', duration: 1, loop: false, markers: [],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }],
    layers: [
      { id: layerId, name: 'Action overlay', blendMode: 'Override', weight: 1, enabled: true,
        tracks: [{ joint: 'RightArm', keys: [
          { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier', curve: { outTime: 0.2, outValue: 0.1, inTime: 0.8, inValue: 0.9 } },
          { time: 1, position: [0, 0, 0], rotation: [0, 0, 60] },
        ] }] },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Later overlay', blendMode: 'Override', weight: 0.5, enabled: true,
        tracks: [{ joint: 'RightArm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 30] }] }] },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Disabled overlay', blendMode: 'Additive', weight: 1, enabled: false,
        tracks: [{ joint: 'RightArm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] }] },
    ],
  };
  const originalBase = structuredClone(source.tracks);
  const pose: Pose = { name: 'Action pose', description: '', tags: [], rigType: 'custom', assetType: 'pose',
    transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 90] }] };
  const single = applyPoseToAnimation(source, pose, 0.5, 1, undefined, layerId);
  assert.deepEqual(single.recipe.tracks, originalBase, 'single-pose layer edits must leave base tracks untouched');
  const singleLayerKey = single.recipe.layers?.[0]?.tracks[0]?.keys.find(key => key.time === 0.5);
  assert.equal(singleLayerKey?.rotation[2], 90);
  assert.equal(singleLayerKey?.easingStyle, 'Bezier');
  assert.deepEqual(singleLayerKey?.curve, source.layers?.[0]?.tracks[0]?.keys[0]?.curve);
  assert.throws(() => applyPoseToAnimation(source, pose, 0.5, 1, undefined, '44444444-4444-4444-8444-444444444444'), /layer .* does not exist/i);

  const sequence = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.25, layerId },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.75, layerId },
    { poseId: 'd9a607cb-8c3a-44b6-a140-b88b7977a0f2', time: 0.8, layerId: '33333333-3333-4333-8333-333333333333' },
  ], [pose, { ...pose, name: 'Follow through', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 120] }] }, pose]);
  assert.deepEqual(sequence.recipe.tracks, originalBase, 'sequence layer edits must leave base tracks untouched');
  const sequenceLayerTrack = sequence.recipe.layers?.[0]?.tracks[0];
  assert.ok(sequenceLayerTrack?.keys.some(key => key.time === 0.25 && key.rotation[2] === 90));
  assert.ok(sequenceLayerTrack?.keys.some(key => key.time === 0.75 && key.rotation[2] === 120));
  assert.equal(sequence.applied[0]?.layerId, layerId);
  assert.equal(sequence.diagnostics.insertedKeyCount, 3);
  assert.deepEqual(sequence.diagnostics.transitionCoverage[0]?.motionDeltas[0]?.layerId, layerId);
  const activeLayerEffect = sequence.diagnostics.destinationLayerEffects.find(effect => effect.layerId === layerId)!;
  assert.equal(activeLayerEffect.status, 'active_weighted');
  assert.deepEqual(activeLayerEffect.laterActiveLayerOverlaps.map(effect => effect.name), ['Later overlay']);
  const disabledLayerEffect = sequence.diagnostics.destinationLayerEffects.find(effect => effect.layerId === '33333333-3333-4333-8333-333333333333')!;
  assert.equal(disabledLayerEffect.status, 'disabled');
  const activeCompositionEffect = sequence.diagnostics.placementCompositionEffects.find(effect => effect.layerId === layerId && effect.time === 0.25)!;
  assert.equal(activeCompositionEffect.compositionChanged, true);
  assert.ok(activeCompositionEffect.rotationDeltaDegrees > 0, 'the selected layer must measurably affect the composed local pose at the authored beat');
  const clonedCounterfactual = structuredClone(sequence.recipe);
  const restoredLayerKey = clonedCounterfactual.layers?.[0]?.tracks[0]?.keys.find(key => key.time === 0.25)!;
  restoredLayerKey.position = [0, 0, 0];
  restoredLayerKey.rotation = [0, 0, 60 * easeProgress('Bezier', 'InOut', 0.25, { outTime: 0.2, outValue: 0.1, inTime: 0.8, inValue: 0.9 })];
  const cloneOraclePose = createComposedJointSampler(clonedCounterfactual, 'RightArm')!(0.25);
  assert.deepEqual(activeCompositionEffect.restoredComposedPose.position.map(value => Number(value.toFixed(8))), cloneOraclePose.position.map(value => Number(value.toFixed(8))),
    'the sampler-level counterfactual must match restoring that channel in a cloned recipe');
  assert.deepEqual(activeCompositionEffect.restoredComposedPose.rotation.map(value => Number(value.toFixed(8))),
    quaternionToEulerXYZDegrees(cloneOraclePose.rotation).map(value => Number(value.toFixed(8))),
    'the sampler-level counterfactual must preserve the existing composed blend path');
  const disabledCompositionEffect = sequence.diagnostics.placementCompositionEffects.find(effect => effect.layerId === disabledLayerEffect.layerId && effect.time === 0.8)!;
  assert.equal(disabledCompositionEffect.rotationDeltaDegrees, 0, 'editing a disabled layer must not be reported as a composed-pose change');
});

test('pose sequences preserve distinct sub-millisecond beats and exact marker associations', () => {
  const firstTime = 0.5, secondTime = 0.50005;
  const source: AnimationRecipe = { kind: 'animation', name: 'Rapid action', duration: 1, loop: false,
    markers: [{ name: 'Impact', time: secondTime }],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] };
  const poses: Pose[] = [
    { name: 'Windup', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 20] }] },
    { name: 'Impact', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 100] }] },
  ];
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: firstTime },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: secondTime },
  ], poses);
  const keys = result.recipe.tracks[0]!.keys;
  const first = keys.find(key => key.time === firstTime);
  const second = keys.find(key => key.time === secondTime);
  assert.ok(first && second, 'both requested beats must remain separate authored keys');
  assert.equal(first.rotation[2], 20);
  assert.equal(second.rotation[2], 100);
  assert.deepEqual(result.diagnostics.markerBeatAssociations[0]?.beats.map(beat => beat.time), [secondTime],
    'an exact marker association must not absorb a distinct nearby beat');
  assert.equal(result.diagnostics.markerBeatAssociations[0]?.association, 'same_time');
  const delta = result.diagnostics.transitionCoverage[0]?.motionDeltas.find(entry => entry.joint === 'RightArm');
  assert.ok(delta && delta.angularDeltaDegrees > 79.99 && delta.angularDeltaDegrees < 80.01,
    'transition diagnostics must compare the exact adjacent keys, not resolve both times to one nearby key');
});

test('pose application preserves loop endpoints and rejects incompatible assets', () => {
  const source = animationPreset('idle', 'Idle', 2, 1);
  const pose = {
    name: 'Neutral', description: '', tags: [], rigType: 'R15' as const, assetType: 'pose' as const,
    transforms: [{ joint: 'UpperTorso', position: [0, 0, 0] as [number, number, number], rotation: [20, 0, 0] as [number, number, number] }],
  };
  const applied = applyPoseToAnimation(source, pose, 0, 0.5);
  const track = applied.recipe.tracks.find(candidate => candidate.joint === 'UpperTorso')!;
  assert.deepEqual(track.keys[0]!.rotation, track.keys.at(-1)!.rotation);
  assert.throws(() => applyPoseToAnimation(source, { ...pose, rigType: 'R6' }, 0.5, 1, 'R15'), /incompatible.*rig type/i);
  assert.throws(() => applyPoseToAnimation(source, { ...pose, transforms: [{ ...pose.transforms[0]!, joint: 'MissingJoint' }] }, 0.5), /no joints matching/i);
  assert.throws(() => applyPoseToAnimation(source, pose, 1, 0), /blend weight/i);
});

test('full-body snapshots add missing joint tracks and preserve interior timing', () => {
  const source = animationPreset('slash', 'Slash', 2, 1);
  const snapshot = {
    name: 'Impact Shape', description: '', tags: [], rigType: 'R15' as const, assetType: 'snapshot' as const, rigSignature: 'R15|root',
    transforms: [
      { joint: 'Head', position: [0, 0, 0] as [number, number, number], rotation: [8, 2, 0] as [number, number, number] },
      { joint: 'LeftFoot', position: [0.1, 0, 0] as [number, number, number], rotation: [-12, 0, 0] as [number, number, number] },
    ],
  };
  const result = applyPoseToAnimation(source, snapshot, 0.75);
  assert.deepEqual(result.applied, ['Head', 'LeftFoot']);
  assert.deepEqual(result.createdTracks, ['Head', 'LeftFoot'], 'new snapshot tracks must be disclosed for review');
  for (const joint of ['Head', 'LeftFoot']) {
    const track = result.recipe.tracks.find(candidate => candidate.joint === joint)!;
    assert.deepEqual(track.keys.map(key => key.time), [0, 0.75, 2]);
  }
  assert.equal(source.tracks.some(track => track.joint === 'Head'), false);
});

test('pose sequences are chronological, atomic, and sample every inserted key from the original animation', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const original = structuredClone(source);
  const poses: Pose[] = [
    { name: 'Early', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { name: 'Late', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-80, 0, 0] }] },
  ];
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.1, weight: 1 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.2, weight: 0.5 },
  ], poses);
  const keys = result.recipe.tracks.find(track => track.joint === 'RightUpperArm')!.keys;
  assert.deepEqual(keys.find(key => key.time === 0.1)?.rotation, [0, 0, 0]);
  assertRotationNear(keys.find(key => key.time === 0.2)!.rotation, [-48.65, 3.06, 3.26]);
  assert.deepEqual(source, original, 'later placements must blend from the original interpolated value, not the earlier edited key');
  assert.deepEqual(result.applied.map(placement => placement.time), [0.1, 0.2]);
  assert.deepEqual(source, original);
  assert.throws(() => applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.2 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.1 },
  ], poses), /chronological order/);
  assert.throws(() => applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.1 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 2.1 },
  ], poses), /beyond the 2s clip duration/);
  const overlap = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.5, weight: 0.5 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.5, weight: 0.5 },
  ], poses);
  const conflict = overlap.diagnostics.sameTimeConflicts[0]!;
  assert.equal(conflict.joint, 'RightUpperArm');
  assert.equal(conflict.time, 0.5);
  assert.equal(conflict.resolution, 'weighted_blend_in_listed_order');
  assert.deepEqual(conflict.contributors.map(contributor => ({ poseId: contributor.poseId, poseName: contributor.poseName, weight: contributor.weight })), [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', poseName: 'Early', weight: 0.5 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', poseName: 'Late', weight: 0.5 },
  ]);
  assert.deepEqual(conflict.contributors.map(contributor => contributor.target.rotation), [[0, 0, 0], [-80, 0, 0]],
    'diagnostics preserve each pose authored target in listed order');
  const firstStep = applyPoseToAnimation(source, poses[0]!, conflict.time, 0.5).recipe.tracks.find(track => track.joint === conflict.joint)!.keys.find(key => key.time === conflict.time)!;
  const secondStep = applyPoseToAnimation(applyPoseToAnimation(source, poses[0]!, conflict.time, 0.5).recipe, poses[1]!, conflict.time, 0.5)
    .recipe.tracks.find(track => track.joint === conflict.joint)!.keys.find(key => key.time === conflict.time)!;
  assert.deepEqual(conflict.contributors[0]!.resultAfter, { position: firstStep.position, rotation: firstStep.rotation });
  assert.deepEqual(conflict.contributors[1]!.resultAfter, { position: secondStep.position, rotation: secondStep.rotation });
  const blendedKey = overlap.recipe.tracks.find(track => track.joint === conflict.joint)!.keys.find(key => key.time === conflict.time)!;
  assert.deepEqual(conflict.result, { position: blendedKey.position, rotation: blendedKey.rotation },
    'diagnostic result must exactly match the final composed candidate key');
  const changingCoverage = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.4 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.4, weight: 0.5 },
    { poseId: 'd9a607cb-8c3a-44b6-a140-b88b7977a0f2', time: 1.2 },
  ], [
    { ...poses[0]!, transforms: [{ joint: 'LeftUpperArm', position: [0, 0, 0], rotation: [-30, 0, 0] }] },
    { ...poses[1]!, transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-20, 0, 0] }] },
    { ...poses[0]!, transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [-80, 0, 0] }] },
  ]);
  assert.equal(changingCoverage.diagnostics.transitionCoverage.length, 1);
  assert.deepEqual(changingCoverage.diagnostics.transitionCoverage[0]?.fromPoseNames, ['Early', 'Late']);
  assert.deepEqual(changingCoverage.diagnostics.transitionCoverage[0]?.leavingJoints, ['LeftUpperArm']);
  assert.deepEqual(changingCoverage.diagnostics.transitionCoverage[0]?.sharedJoints, ['RightUpperArm']);
  assert.deepEqual(changingCoverage.diagnostics.transitionCoverage[0]?.enteringJoints, []);
  assert.equal(changingCoverage.diagnostics.transitionCoverage[0]?.continuityCoverage, 0.5);
  const armDelta = changingCoverage.diagnostics.transitionCoverage[0]?.motionDeltas.find(delta => delta.joint === 'RightUpperArm');
  assert.ok(armDelta && armDelta.angularDeltaDegrees > 0);
  assert.ok(Math.abs(armDelta.averageAngularSpeedDegreesPerSecond - armDelta.angularDeltaDegrees / 0.8) < 1e-10);
  const partialPose: Pose = { ...poses[0]!, transforms: [...poses[0]!.transforms, { joint: 'MissingJoint', position: [0, 0, 0], rotation: [0, 0, 0] }] };
  const partial = applyPoseSequenceToAnimation(source, [{ poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.5 }], [partialPose]);
  assert.equal(partial.diagnostics.matchedJointContributions, 1);
  assert.equal(partial.diagnostics.skippedJointContributions, 1);
  assert.equal(partial.diagnostics.coverage, 0.5);
  assert.deepEqual(source, original, 'failed sequences must not modify the source');
});

test('pose-sequence diagnostics sample composed motion between pose beats and localize peak changes', () => {
  const source: AnimationRecipe = { kind: 'animation', name: 'Two-beat action', duration: 1, loop: false,
    markers: [{ name: 'Release', time: 0.500001, phase: 'event', value: 'Arrow leaves bow' },
      { name: 'Beyond association window', time: 0.01 }],
    contacts: [{ effector: 'RightHand', kind: 'grip', start: 0.499999, end: 0.500003 },
      { effector: 'LeftFoot', kind: 'support', start: 0.8, end: 0.9 }],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
      { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    ] }] };
  const poses: Pose[] = [
    { name: 'Windup', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { name: 'Release', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [2, 0, 0], rotation: [0, 0, 90] }] },
  ];
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.25 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.75 },
  ], poses);
  assert.equal(result.diagnostics.markerAssociationWindowSeconds, 0.25);
  assert.equal(result.diagnostics.markerPolicy, 'unchanged_advisory_associations');
  assert.deepEqual(result.diagnostics.markerBeatAssociations, [
    { markerIndex: 0, name: 'Release', time: 0.500001, phase: 'event',
      association: 'nearby', beats: [{ time: 0.75, offsetSeconds: 0.249999, poseIds: ['7c91b72c-0b3e-46e8-99a2-0312641c313e'], poseNames: ['Release'] }], tieCount: 1 },
    { markerIndex: 1, name: 'Beyond association window', time: 0.01, phase: null,
      association: 'nearby', beats: [{ time: 0.25, offsetSeconds: 0.24, poseIds: ['c44a4b76-f99d-4ef1-98a8-3656685fb360'], poseNames: ['Windup'] }], tieCount: 1 }]);
  const motion = result.diagnostics.transitionMotion;
  assert.equal(motion.effectiveSampleRateHz, 60);
  assert.equal(motion.intervals.length, 1);
  const interval = motion.intervals[0]!;
  assert.equal(interval.fromPoseNames[0], 'Windup');
  assert.equal(interval.toPoseNames[0], 'Release');
  assert.equal(interval.peaks.positionSpeedStudsPerSecond[0]?.joint, 'RightArm');
  assert.ok(Math.abs(interval.peaks.positionSpeedStudsPerSecond[0]!.value - 4) < 1e-8);
  assert.ok(Math.abs(interval.peaks.angularSpeedDegreesPerSecond[0]!.value - 180) < 1e-6);
  assert.equal(motion.coarseEvaluationCount, 31);
  assert.ok(motion.refinementEvaluationCount > 0);
  assert.equal(motion.evaluationCount, motion.coarseEvaluationCount + motion.refinementEvaluationCount);
  assert.equal(interval.peaks.positionSpeedStudsPerSecond[0]!.refinement.resolvedWithinFivePercent, true);
  const positionPeak = interval.peaks.positionSpeedStudsPerSecond[0]!;
  assert.deepEqual(positionPeak.eventContext.markers, [
    { name: 'Beyond association window', time: 0.01, offsetSeconds: -0.242083 },
    { name: 'Release', time: 0.500001, offsetSeconds: 0.247918, phase: 'event', value: 'Arrow leaves bow' },
  ]);
  assert.deepEqual(positionPeak.eventContext.contacts, []);
  assert.equal(positionPeak.eventContext.markerWindowSeconds, 0.25);
  const angularPeak = interval.peaks.angularSpeedDegreesPerSecond[0]!;
  assert.deepEqual(angularPeak.eventContext.markers, [{ name: 'Release', time: 0.500001, offsetSeconds: -0.002082, phase: 'event', value: 'Arrow leaves bow' }]);
  assert.deepEqual(angularPeak.eventContext.contacts, [{ effector: 'RightHand', kind: 'grip', start: 0.499999, end: 0.500003, relation: 'overlaps_peak_window' }]);
  assert.equal(positionPeak.eventContext.omittedMarkerCount, 0);
  assert.equal(positionPeak.eventContext.omittedContactCount, 0);
});

test('pose-sequence peak event context ranks exact-window markers first and reports bounded nearby-event truncation', () => {
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Marker context', duration: 1, loop: false,
    markers: [
      { name: 'Near later', time: 0.15 }, { name: 'Exact B', time: 0.000001 },
      { name: 'Far outside', time: 0.2501 }, { name: 'Exact A', time: 0 },
      { name: 'Near earlier', time: 0.05 }, { name: 'Near tie', time: 0.1 },
    ],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [1, 0, 0], rotation: [0, 0, 0] },
    ] }] };
  const result = analyzePoseSequenceTransitions(recipe, [{ startTime: 0, endTime: 1, fromPoseNames: ['Start'], toPoseNames: ['End'] }]);
  const eventContext = result.intervals[0]!.peaks.positionSpeedStudsPerSecond[0]!.eventContext;
  assert.deepEqual(eventContext.markers.slice(0, 2).map(marker => marker.name), ['Exact B', 'Exact A'],
    'exact-window events rank first, ordered by distance then time/name');
  assert.equal(eventContext.markers.length, 4);
  assert.equal(eventContext.omittedMarkerCount, 2, 'only the two in-window markers beyond the four-item cap are counted as omitted');
  assert.equal(eventContext.markerWindowSeconds, 0.25);
});

test('pose-sequence marker-to-beat associations are advisory, deterministic for ties, and ignore distant markers', () => {
  const source: AnimationRecipe = { kind: 'animation', name: 'Marker beat ties', duration: 1, loop: false,
    markers: [{ name: 'Far marker', time: 0.01 }, { name: 'Tie marker', time: 0.5 }],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] };
  const poses: Pose[] = ['First', 'Second'].map(name => ({ name, description: '', tags: [], rigType: 'custom', assetType: 'pose',
    transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 0] }] }));
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.4 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.6 },
  ], poses);
  assert.deepEqual(result.diagnostics.markerBeatAssociations, [{ markerIndex: 1, name: 'Tie marker', time: 0.5, phase: null,
    association: 'nearby', beats: [
      { time: 0.4, offsetSeconds: -0.1, poseIds: ['c44a4b76-f99d-4ef1-98a8-3656685fb360'], poseNames: ['First'] },
      { time: 0.6, offsetSeconds: 0.1, poseIds: ['7c91b72c-0b3e-46e8-99a2-0312641c313e'], poseNames: ['Second'] },
    ], tieCount: 2 }]);
  assert.deepEqual(result.recipe.markers, source.markers, 'the advisory must never retime or remove authored marker events');
});

test('pose-sequence diagnostics localize sampled velocity gaps at beat boundaries and label entering/leaving joints', () => {
  const source: AnimationRecipe = { kind: 'animation', name: 'Coverage change', duration: 1, loop: false, markers: [], tracks: [
    { joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] },
    { joint: 'LeftArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] },
  ] };
  const poses: Pose[] = [
    { name: 'Right windup', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, -60] }] },
    { name: 'Left contact', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'LeftArm', position: [0, 0, 0], rotation: [0, 0, -20] }] },
    { name: 'Left release', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'LeftArm', position: [0, 0, 0], rotation: [0, 0, -90] }] },
  ];
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.25 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.5 },
    { poseId: 'd9a607cb-8c3a-44b6-a140-b88b7977a0f2', time: 0.75 },
  ], poses);
  const boundary = result.diagnostics.transitionMotion.boundaryContinuity;
  assert.equal(boundary.boundaryCount, 1);
  assert.equal(boundary.evaluationCount, 6, 'one center and two one-sided samples per measured joint');
  assert.ok(boundary.positionVelocityDiscontinuities.every(signal => Number.isFinite(signal.value)));
  assert.ok(boundary.angularVelocityDiscontinuities.every(signal => Number.isFinite(signal.value)));
  assert.equal(boundary.angularVelocityDiscontinuities.find(signal => signal.joint === 'RightArm')?.authoredCoverage, 'leaving');
  assert.equal(boundary.angularVelocityDiscontinuities.find(signal => signal.joint === 'LeftArm')?.authoredCoverage, 'entering');
  assert.ok(boundary.angularVelocityDiscontinuities.some(signal => signal.value > 0), 'a sharp beat-rate change should be visible in diagnostics');
  const leftBoundarySignal = boundary.angularVelocityDiscontinuities.find(signal => signal.joint === 'LeftArm')!;
  const leftBaseContext = leftBoundarySignal.curveContext.find(channel => channel.source === 'base')!;
  assert.equal(leftBaseContext.keyAtBoundary, 0.5, 'reported signal should identify the authored key at the beat');
  assert.equal(leftBaseContext.previousKeyTime, 0);
  assert.equal(leftBaseContext.nextKeyTime, 0.75);
  assert.deepEqual(leftBaseContext.incomingEasing, { style: 'Linear', direction: 'Out' }, 'omitted legacy easing uses the project Linear/Out defaults');
  assert.deepEqual(leftBaseContext.outgoingEasing, { style: 'Linear', direction: 'Out' }, 'the diagnostic must match the actual interpolation defaults');
  const rightBoundarySignal = boundary.angularVelocityDiscontinuities.find(signal => signal.joint === 'RightArm')!;
  const rightBaseContext = rightBoundarySignal.curveContext.find(channel => channel.source === 'base')!;
  assert.equal(rightBaseContext.keyAtBoundary, null, 'a leaving authored pose need not create a candidate key at the next beat');
  assert.equal(rightBaseContext.previousKeyTime, 0.25);
  assert.equal(rightBaseContext.nextKeyTime, 1);
  assert.match(boundary.limitation, /offsets capped at 1\/60s.*closer beats therefore use shorter windows.*not thresholds.*proof of a visible pop/i);
});

test('pose-sequence local refinement flags nonlinear peaks that the coarse sample did not resolve', () => {
  const source: AnimationRecipe = { kind: 'animation', name: 'Elastic release', duration: 1, loop: false, markers: [],
    tracks: [{ joint: 'RightArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.25, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Elastic', easingDirection: 'InOut' },
      { time: 0.75, position: [2, 0, 0], rotation: [0, 0, 90] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] };
  const poses: Pose[] = [
    { name: 'Windup', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [0, 0, 0], rotation: [0, 0, 0] }] },
    { name: 'Release', description: '', tags: [], rigType: 'custom', assetType: 'pose', transforms: [{ joint: 'RightArm', position: [2, 0, 0], rotation: [0, 0, 90] }] },
  ];
  const result = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 0.25 },
    { poseId: '7c91b72c-0b3e-46e8-99a2-0312641c313e', time: 0.75 },
  ], poses);
  const peak = result.diagnostics.transitionMotion.intervals[0]!.peaks.angularSpeedDegreesPerSecond[0]!;
  assert.ok(peak.value > peak.coarseValue, `expected refinement to reveal a stronger local peak (${peak.value} vs ${peak.coarseValue})`);
  assert.equal(peak.refinement.resolvedWithinFivePercent, false);
  assert.ok(peak.refinement.windowStart < peak.refinement.windowEnd);
});

test('pose-sequence analyzer accounts for per-interval ceiling and refinement work stays within its global budget', () => {
  const makeTrack = (index: number) => ({ joint: `RigJoint${index}`,
    keys: [
      { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], easingStyle: 'Elastic' as const, easingDirection: 'InOut' as const },
      { time: 30, position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] },
    ] });
  const allTracks = Array.from({ length: 1024 }, (_unused, index) => makeTrack(index));
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Budget stress', duration: 30, loop: false, markers: [],
    tracks: allTracks.slice(0, 256), layers: [0, 1, 2].map(layerIndex => ({
      id: `11111111-1111-4111-8111-${String(layerIndex + 1).padStart(12, '0')}`,
      name: `Layer ${layerIndex}`, blendMode: 'Additive' as const, weight: 1, enabled: true,
      tracks: allTracks.slice(256 + layerIndex * 256, 512 + layerIndex * 256),
    })) };
  const intervals = Array.from({ length: 30 }, (_unused, index) => ({ startTime: index, endTime: index + 1,
    fromPoseNames: [`Pose ${index}`], toPoseNames: [`Pose ${index + 1}`] }));
  const result = analyzePoseSequenceTransitions(recipe, intervals);
  assert.ok(result.coarseEvaluationCount + result.boundaryEvaluationCount <= result.coarseEvaluationBudget);
  assert.ok(result.evaluationCount <= result.totalEvaluationBudget);
  assert.ok(result.boundaryEvaluationCount <= result.coarseEvaluationBudget);
  assert.equal(result.boundaryEvaluationCount, 29 * 1024 * 3, 'budget stress fixture must reserve every internal boundary probe');
  assert.equal(result.evaluationCount, result.coarseEvaluationCount + result.boundaryEvaluationCount + result.refinementEvaluationCount);
  assert.equal(result.intervals.length, 30);
  assert.ok(result.refinementEvaluationCount > 0);
  assert.ok(result.effectiveSampleRateHz < result.sampleRateHz,
    'rate must account for ceiling overhead from each interval, not just total duration');
});

test('pose insertion and blending take the shortest quaternion path across Euler wraparound', () => {
  const source = animationPreset('idle', 'Rotation wraparound', 2, 1);
  source.loop = false;
  const track = source.tracks.find(candidate => candidate.joint === 'UpperTorso')!;
  track.keys = [
    { time: 0, position: [0, 0, 0], rotation: [170, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [-170, 0, 0] },
  ];
  const pose: Pose = { name: 'Neutral', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [
    { joint: 'UpperTorso', position: [0, 0, 0], rotation: [-170, 0, 0] },
  ] };
  const blendedExisting = applyPoseToAnimation(source, pose, 0, 0.5).recipe.tracks.find(candidate => candidate.joint === 'UpperTorso')!.keys[0]!;
  assert.ok(Math.abs(Math.abs(blendedExisting.rotation[0]!) - 180) < 0.01, `expected a short-path midpoint near 180°, got ${blendedExisting.rotation[0]}°`);

  const inserted = applyPoseSequenceToAnimation(source, [
    { poseId: 'c44a4b76-f99d-4ef1-98a8-3656685fb360', time: 1, weight: 0.5 },
  ], [{ ...pose, transforms: [{ ...pose.transforms[0]!, rotation: [0, 0, 0] }] }]);
  const insertedRotation = inserted.recipe.tracks.find(candidate => candidate.joint === 'UpperTorso')!.keys.find(key => key.time === 1)!.rotation;
  assert.ok(Math.abs(Math.abs(insertedRotation[0]!) - 90) < 0.01, `expected a blend from the sampled 180° pose toward 0°, got ${insertedRotation[0]}°`);
});

test('pose blending preserves compound XYZ Euler rotations when blending an identical pose', () => {
  const source = animationPreset('idle', 'Compound rotation', 2, 1);
  source.loop = false;
  const expected: [number, number, number] = [20, 30, 40];
  const track = source.tracks.find(candidate => candidate.joint === 'UpperTorso')!;
  track.keys.forEach(key => { key.rotation = [...expected]; });
  const pose: Pose = { name: 'Same pose', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [
    { joint: 'UpperTorso', position: [0, 0, 0], rotation: [...expected] },
  ] };
  const blended = applyPoseToAnimation(source, pose, 0, 0.5).recipe.tracks.find(candidate => candidate.joint === 'UpperTorso')!.keys[0]!;
  assert.ok(blended.rotation.every((value, axis) => Math.abs(value - expected[axis]!) < 1e-8),
    `an unchanged compound rotation must survive quaternion conversion, got ${blended.rotation}`);
});

test('pose transitions sample eased local motion with shortest-path quaternion rotations without mutating the source', () => {
  const source = animationPreset('cast', 'Transition source', 2, 1);
  const original = structuredClone(source);
  const from: Pose = { name: 'Start', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [170, 0, 0] }] };
  const to: Pose = { ...from, name: 'Finish', transforms: [{ joint: 'RightUpperArm', position: [2, 0, 0], rotation: [-170, 0, 0] }] };
  const result = transitionPosesInAnimation(source, from, to, poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75, steps: 4, easingStyle: 'Linear', easingDirection: 'InOut', replaceExistingKeys: true }));
  const track = result.recipe.tracks.find(candidate => candidate.joint === 'RightUpperArm')!;
  const transitionTimes = [0.25, 0.625, 1, 1.375, 1.75];
  const transitionKeys = track.keys.filter(key => transitionTimes.includes(key.time));
  assert.equal(transitionKeys.length, 5);
  assert.equal(transitionKeys[2]!.position[0], 1);
  assert.ok(Math.abs(Math.abs(transitionKeys[2]!.rotation[0]!) - 180) < 1e-6, 'the midpoint takes the short 20-degree path rather than rotating through zero');
  assert.deepEqual(result.diagnostics.matchedJoints, ['RightUpperArm']);
  assert.equal(result.diagnostics.generatedKeys, 5);
  assert.equal(result.diagnostics.overwrittenKeyCount, 3, 'all authored interior keys in the interval are removed by the explicit overwrite');
  assert.deepEqual(source, original);
});

test('adaptive pose transitions subdivide the most curved segments and report bounded local chord error', () => {
  const source = animationPreset('cast', 'Adaptive transition', 2, 1);
  const from: Pose = { name: 'Start', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [
    { joint: 'RightUpperArm', position: [0, 0, 0], rotation: [0, 0, 0] },
  ] };
  const to: Pose = { ...from, name: 'Finish', transforms: [
    { joint: 'RightUpperArm', position: [4, 0, 0], rotation: [100, 20, 0] },
  ] };
  const result = transitionPosesInAnimation(source, from, to, poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75,
    steps: 2, easingStyle: 'CubicV2', easingDirection: 'InOut', adaptiveRefinement: true,
    positionToleranceStuds: 0.02, rotationToleranceDegrees: 1, maxAdaptiveDepth: 4, replaceExistingKeys: true }));
  const report = result.diagnostics.adaptiveRefinement.joints[0]!;
  assert.equal(report.joint, 'RightUpperArm');
  assert.ok(report.adaptiveKeyCount > 3, 'the two base intervals should gain breakdown keys where eased curvature exceeds tolerance');
  assert.equal(report.toleranceMet, true);
  assert.equal(report.depthLimitHit, false);
  assert.ok(report.maximumPositionChordErrorStuds <= 0.02);
  assert.ok(report.maximumRotationChordErrorDegrees <= 1);
  assert.equal(result.diagnostics.generatedKeys, report.adaptiveKeyCount);
  assert.ok(report.intervalMeasurementCount <= report.adaptiveKeyCount * 3,
    'the priority queue should measure each generated interval a bounded number of times, without rescanning all prior intervals per split');
  assert.equal(report.curveSampleCount, report.intervalMeasurementCount * 31);
  assert.equal(result.diagnostics.adaptiveRefinement.curveSampleCount, report.curveSampleCount);
  const sample = createComposedJointSampler(result.recipe, 'RightUpperArm')!;
  let maximumDenseGridPositionError = 0;
  for (let index = 0; index <= 1000; index++) {
    const progress = index / 1000;
    const time = 0.25 + 1.5 * progress;
    const expected = 4 * easeProgress('CubicV2', 'InOut', progress);
    maximumDenseGridPositionError = Math.max(maximumDenseGridPositionError, Math.abs(sample(time).position[0] - expected));
  }
  assert.ok(maximumDenseGridPositionError <= 0.02,
    `dense independent playback samples exceeded the requested local position tolerance: ${maximumDenseGridPositionError}`);
});

test('adaptive pose transitions report unmet tolerances instead of exceeding per-track key limits', () => {
  const source = animationPreset('cast', 'Bounded adaptive transition', 2, 1);
  const from: Pose = { name: 'Start', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [
    { joint: 'RightUpperArm', position: [0, 0, 0], rotation: [0, 0, 0] },
  ] };
  const to: Pose = { ...from, name: 'Finish', transforms: [
    { joint: 'RightUpperArm', position: [5, 0, 0], rotation: [160, 30, 0] },
  ] };
  const result = transitionPosesInAnimation(source, from, to, poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75,
    steps: 2, easingStyle: 'Elastic', easingDirection: 'Out', adaptiveRefinement: true,
    positionToleranceStuds: 0.0001, rotationToleranceDegrees: 0.01, maxAdaptiveDepth: 6, replaceExistingKeys: true }));
  const report = result.diagnostics.adaptiveRefinement.joints[0]!;
  const track = result.recipe.tracks.find(candidate => candidate.joint === 'RightUpperArm')!;
  assert.ok(track.keys.length <= 128);
  assert.ok(report.adaptiveKeyCount <= 128);
  assert.equal(report.toleranceMet, false);
  assert.ok(report.depthLimitHit || report.keyBudgetLimited);
  assert.ok(report.intervalMeasurementCount <= report.adaptiveKeyCount * 3);
  assert.equal(report.curveSampleCount, report.intervalMeasurementCount * 31);
});

test('adaptive pose transitions remain within tolerance across a dense Bounce and Elastic easing sweep', () => {
  const source = animationPreset('cast', 'Oscillating easing sweep', 2, 1);
  const from: Pose = { name: 'Start', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [
    { joint: 'RightUpperArm', position: [0, 0, 0], rotation: [0, 0, 0] },
  ] };
  const to: Pose = { ...from, name: 'Finish', transforms: [
    { joint: 'RightUpperArm', position: [5, 0, 0], rotation: [0, 0, 0] },
  ] };
  let passingCases = 0;
  for (const easingStyle of ['Bounce', 'Elastic'] as const) {
    for (const easingDirection of ['In', 'Out', 'InOut'] as const) {
      for (const steps of [2, 3, 4, 5, 6, 8]) {
        for (const tolerance of [0.01, 0.03, 0.1, 0.2, 0.4, 0.7]) {
          const result = transitionPosesInAnimation(source, from, to, poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75,
            steps, easingStyle, easingDirection, adaptiveRefinement: true, positionToleranceStuds: tolerance,
            rotationToleranceDegrees: 45, maxAdaptiveDepth: 4, replaceExistingKeys: true }));
          const report = result.diagnostics.adaptiveRefinement.joints[0]!;
          assert.equal(report.curveSampleCount, report.intervalMeasurementCount * 31);
          if (!report.toleranceMet) continue;
          passingCases++;
          const sample = createComposedJointSampler(result.recipe, 'RightUpperArm')!;
          let maximumDenseGridPositionError = 0;
          for (let index = 0; index <= 10000; index++) {
            const progress = index / 10000;
            const time = 0.25 + 1.5 * progress;
            const expected = 5 * easeProgress(easingStyle, easingDirection, progress);
            maximumDenseGridPositionError = Math.max(maximumDenseGridPositionError, Math.abs(sample(time).position[0] - expected));
          }
          assert.ok(maximumDenseGridPositionError <= tolerance + 0.005,
            `${easingStyle} ${easingDirection}, ${steps} steps, ${tolerance} stud tolerance: dense playback error was ${maximumDenseGridPositionError}`);
        }
      }
    }
  }
  assert.ok(passingCases > 0, 'the easing sweep must exercise transitions whose reported sampled tolerance is met');
});

test('pose transitions reject key overwrites without explicit consent and reject incompatible snapshots', () => {
  const source = animationPreset('cast', 'Transition safety', 2, 1);
  const from: Pose = { name: 'Start', description: '', tags: [], rigType: 'R15', assetType: 'pose', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [0, 0, 0] }] };
  const to: Pose = { ...from, name: 'Finish', transforms: [{ joint: 'RightUpperArm', position: [0, 0, 0], rotation: [10, 0, 0] }] };
  assert.throws(() => transitionPosesInAnimation(source, from, to, poseTransitionOptionsSchema.parse({ startTime: 0.5, endTime: 1.5, steps: 2 })), /already has .*authored key/i);
  const leftSnapshot: Pose = { ...from, assetType: 'snapshot', rigSignature: 'R15|root' };
  const rightSnapshot: Pose = { ...to, assetType: 'snapshot', rigSignature: 'R15|different' };
  assert.throws(() => transitionPosesInAnimation(source, leftSnapshot, rightSnapshot, poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75, steps: 2 })), /signatures differ/i);
  const newTrackStart: Pose = { ...leftSnapshot, rigSignature: 'R15|root', transforms: [{ joint: 'LeftFoot', position: [0, 0, 0], rotation: [0, 0, 0] }] };
  const newTrackEnd: Pose = { ...newTrackStart, name: 'Foot planted', transforms: [{ joint: 'LeftFoot', position: [0.2, 0, 0], rotation: [-12, 0, 0] }] };
  const createdTrackTransition = transitionPosesInAnimation(source, newTrackStart, newTrackEnd,
    poseTransitionOptionsSchema.parse({ startTime: 0.25, endTime: 1.75, steps: 2, replaceExistingKeys: true }));
  assert.deepEqual(createdTrackTransition.diagnostics.addedTracks, ['LeftFoot']);
  const createdTrack = createdTrackTransition.recipe.tracks.find(track => track.joint === 'LeftFoot')!;
  assert.deepEqual(createdTrack.keys[0]!.rotation, [0, 0, 0], 'new snapshot tracks use a neutral start boundary');
  assert.deepEqual(createdTrack.keys.at(-1)!.rotation, [0, 0, 0], 'new snapshot tracks use a neutral end boundary');
  assert.throws(() => poseTransitionOptionsSchema.parse({ startTime: 1, endTime: 1, steps: 4 }), /after startTime/i);
});
