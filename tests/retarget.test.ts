import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFocusEligibleJointNames, retargetAnimation, retargetProfileSchema, suggestAnimationJointMap, validatedInspectionNodes } from '../src/retarget.js';
import type { AnimationRecipe } from '../src/recipes.js';

const identity = [0, 0, 0, 1] as [number, number, number, number];
function profile(rigName: string, rootName: string, jointName: string, basis = identity, segmentLength = 2) {
  return retargetProfileSchema.parse({
    version: 1, rigId: rigName === 'Source' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    rigName, rigType: 'custom', rigSignature: `${rigName}-topology`,
    joints: [
      { name: rootName, parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: jointName, parent: rootName, driven: true, basis, segmentLength },
    ],
  });
}
function animation(): AnimationRecipe {
  return {
    kind: 'animation', name: 'Source move', duration: 1, loop: false,
    tracks: [{ joint: 'SourceArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [1, 0, 0], rotation: [90, 0, 0] },
    ] }],
    layers: [{ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Secondary', blendMode: 'Additive', weight: 1, enabled: true, tracks: [{ joint: 'SourceArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 10, 0] },
    ] }] }], markers: [],
    rootMotion: { joint: 'SourceArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0.5, 0, 0], rotation: [0, 0, 0] },
    ] },
  };
}

test('visual close-up targets require matching driven hierarchy and visible BasePart evidence', () => {
  const rig = profile('Target', 'HumanoidRootPart', 'Right Arm');
  const evidence = { source: 'BasePart.Size', dimensionsStuds: [1, 2, 1], partClass: 'Part', transparency: 0 };
  const node = { name: 'Right Arm', parent: 'HumanoidRootPart', driven: true, captureFocusEligible: true, visualGeometry: evidence };
  assert.deepEqual(captureFocusEligibleJointNames(rig, [node]), ['Right Arm']);
  assert.deepEqual(captureFocusEligibleJointNames(rig, [
    node,
    { ...node, parent: 'WrongParent' },
    { ...node, driven: false },
    { ...node, visualGeometry: { ...evidence, transparency: 1 } },
    { ...node, visualGeometry: { ...evidence, dimensionsStuds: [1, 0, 1] } },
    { ...node, name: 'HumanoidRootPart', parent: '', driven: false },
    node,
  ]), [], 'a duplicate name makes that target ambiguous; conflicting, invisible, malformed, and root-only evidence is rejected');
  assert.deepEqual(captureFocusEligibleJointNames(rig, [{ ...node, visualGeometry: undefined }]), []);
  const nodes = validatedInspectionNodes(rig, [node, { ...node, arbitraryPluginPayload: 'discard me' },
    { ...node, parent: 'WrongParent' }, { ...node, driven: false }, { ...node, visualGeometry: { ...evidence, dimensionsStuds: [0, 2, 1] } }]);
  assert.deepEqual(nodes, [], 'duplicate names are ambiguous and contradictory or malformed nodes are excluded');
  const sanitized = validatedInspectionNodes(rig, [{ ...node, arbitraryPluginPayload: 'discard me' }]);
  assert.deepEqual(sanitized, [{ ...node }], 'only allow-listed evidence fields are forwarded to the AI');
});

test('inspection binds supported Roblox driver kinds to exact hierarchy nodes and never treats Bones as part-backed close-ups', () => {
  const base = profile('Typed rig', 'Root', 'Hand');
  const boneProfile = retargetProfileSchema.parse({ ...base, joints: [base.joints[0]!, { ...base.joints[1]!, targetKind: 'Bone' }] });
  const boneNode = { name: 'Hand', parent: 'Root', driven: true, targetKind: 'Bone' as const, captureFocusEligible: true,
    visualGeometry: { source: 'BasePart.Size' as const, dimensionsStuds: [1, 1, 1] as [number, number, number], partClass: 'MeshPart', transparency: 0 } };
  assert.deepEqual(validatedInspectionNodes(boneProfile, [boneNode]), [boneNode]);
  assert.deepEqual(captureFocusEligibleJointNames(boneProfile, [boneNode]), [], 'Bone drivers cannot promise independently visible part close-ups');
  assert.deepEqual(validatedInspectionNodes(boneProfile, [{ ...boneNode, targetKind: 'Motor6D' }]), [], 'driver-class disagreement invalidates plugin node evidence');
  assert.throws(() => retargetProfileSchema.parse({ ...base, joints: [base.joints[0]!, { ...base.joints[1]!, targetKind: 'Weld' }] }), /targetKind/i);
});

test('retarget converts local rotations through source and target rest bases and scales offsets by limb proportion', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'TargetRoot', 'TargetArm', [0, Math.SQRT1_2, 0, Math.SQRT1_2], 4);
  const result = retargetAnimation(animation(), source, target, { SourceRoot: 'TargetRoot', SourceArm: 'TargetArm' });
  assert.equal(result.recipe.tracks[0]!.joint, 'TargetArm');
  const endpoint = result.recipe.tracks[0]!.keys[1]!;
  assert.ok(Math.abs(endpoint.position[0]) < 1e-6);
  assert.ok(Math.abs(endpoint.position[2] - 2) < 1e-6);
  assert.ok(Math.abs(endpoint.rotation[0]) < 1e-5);
  assert.ok(Math.abs(endpoint.rotation[2] - 90) < 1e-5);
  assert.equal(result.recipe.layers?.[0]?.tracks[0]?.joint, 'TargetArm');
  assert.equal(result.recipe.rootMotion?.joint, 'TargetArm');
  assert.ok(Math.abs(result.recipe.rootMotion!.keys[1]!.position[2] - 1) < 1e-6);
  assert.deepEqual(result.report.mapped, [{ source: 'SourceArm', target: 'TargetArm' }]);
  assert.deepEqual(result.report.jointDiagnostics[0], {
    source: 'SourceArm', target: 'TargetArm', sourceSegmentLength: 2, targetSegmentLength: 4,
    rawLengthRatio: 2, appliedTranslationScale: 2, translationScaleClamped: false, basisDifferenceDegrees: 90,
  });
});

test('retarget preserves compound XYZ Euler rotations when source and target rest bases match', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'TargetRoot', 'TargetArm');
  const input = animation();
  const expected: [number, number, number] = [20, 30, 40];
  input.tracks[0]!.keys.forEach(key => { key.rotation = [...expected]; });
  const result = retargetAnimation(input, source, target, { SourceRoot: 'TargetRoot', SourceArm: 'TargetArm' });
  const rotations = result.recipe.tracks[0]!.keys.map(key => key.rotation);
  assert.ok(rotations.every(rotation => rotation.every((value, axis) => Math.abs(value - expected[axis]!) < 1e-8)),
    `identity-basis retargeting must preserve compound rotations, got ${JSON.stringify(rotations)}`);
});

test('retarget requires explicit complete mappings, rejects ancestry mismatch and duplicate targets', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'TargetRoot', 'TargetArm');
  assert.throws(() => retargetAnimation(animation(), source, target, {}), /No safe target mapping/);
  assert.throws(() => retargetAnimation(animation(), source, target, { SourceArm: 'TargetArm' }), /map the source parent SourceRoot/);
  assert.throws(() => retargetAnimation(animation(), source, target, { SourceRoot: 'TargetRoot', SourceArm: 'Missing' }, true), /No source animation joints/);
  const mismatched = profile('Target', 'DifferentRoot', 'TargetArm');
  assert.throws(() => retargetAnimation(animation(), source, mismatched, { SourceRoot: 'TargetArm', SourceArm: 'TargetArm' }), /Hierarchy mismatch/);
  const twoSourceJoints = retargetProfileSchema.parse({ ...source, joints: [...source.joints, { ...source.joints[1]!, name: 'SourceArm2' }] });
  const twoTrackAnimation = animation();
  twoTrackAnimation.tracks.push({ ...structuredClone(twoTrackAnimation.tracks[0]!), joint: 'SourceArm2' });
  assert.throws(() => retargetAnimation(twoTrackAnimation, twoSourceJoints, target, { SourceRoot: 'TargetRoot', SourceArm: 'TargetArm', SourceArm2: 'TargetArm' }), /Multiple source tracks map/);
});

test('retarget validates inspected profiles, keeps source immutable, and reports explicitly skipped tracks', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'SourceRoot', 'SourceArm');
  const input = animation();
  const before = structuredClone(input);
  const result = retargetAnimation(input, source, target, {}, true);
  assert.deepEqual(input, before);
  assert.deepEqual(result.report.skipped, []);
  assert.equal(result.recipe.name, input.name);
  assert.throws(() => retargetProfileSchema.parse({ ...source, joints: [{ ...source.joints[0]!, basis: [0, 0, 0, 0] }] }), /normalized quaternion/);
});

test('retarget report identifies every dropped channel and explains bounded translation scaling', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'TargetRoot', 'TargetArm', identity, 20);
  const input = animation();
  input.layers![0]!.tracks.push({ joint: 'MissingLayerJoint', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] });
  const partial = retargetAnimation(input, source, target, { SourceRoot: 'TargetRoot', SourceArm: 'TargetArm' }, true);
  assert.deepEqual(partial.report.skipped, ['MissingLayerJoint']);
  assert.deepEqual(partial.report.skippedChannels, [{
    joint: 'MissingLayerJoint', channel: 'layer', layerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', layerName: 'Secondary', reason: 'source_joint_missing',
  }]);
  assert.deepEqual(partial.report.jointDiagnostics[0], {
    source: 'SourceArm', target: 'TargetArm', sourceSegmentLength: 2, targetSegmentLength: 20,
    rawLengthRatio: 10, appliedTranslationScale: 4, translationScaleClamped: true, basisDifferenceDegrees: 0,
  });
  assert.throws(() => retargetAnimation(input, source, target, { SourceRoot: 'TargetRoot', SourceArm: 'TargetArm' }), /MissingLayerJoint \(layer: Secondary\)/);
});

test('retarget refuses ambiguous case-insensitive target names but honors exact and explicit mappings', () => {
  const sourceBase = profile('Source', 'SourceRoot', 'SourceArm');
  const source = retargetProfileSchema.parse({
    ...sourceBase,
    joints: [
      ...sourceBase.joints,
      { ...sourceBase.joints[1]!, name: 'SourceLeg' },
      { ...sourceBase.joints[1]!, name: 'UnanimatedExtra' },
    ],
  });
  const target = retargetProfileSchema.parse({
    version: 1, rigId: '22222222-2222-4222-8222-222222222222', rigName: 'Target', rigType: 'custom', rigSignature: 'Target-collision',
    joints: [
      { name: 'SourceRoot', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'sourcearm', parent: 'SourceRoot', driven: true, basis: identity, segmentLength: 2 },
      { name: 'SOURCEARM', parent: 'SourceRoot', driven: true, basis: identity, segmentLength: 2 },
      { name: 'TargetLeg', parent: 'SourceRoot', driven: true, basis: identity, segmentLength: 2 },
      { name: 'unanimatedextra', parent: 'SourceRoot', driven: true, basis: identity, segmentLength: 2 },
      { name: 'UNANIMATEDEXTRA', parent: 'SourceRoot', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const input = animation();
  input.tracks.push({ ...structuredClone(input.tracks[0]!), joint: 'SourceLeg' });

  const partial = retargetAnimation(input, source, target, { SourceLeg: 'TargetLeg' }, true);
  assert.deepEqual(partial.report.ambiguousTargetMappings, [{ source: 'SourceArm', candidates: ['SOURCEARM', 'sourcearm'] }]);
  assert.deepEqual(partial.report.skippedChannels.map(item => [item.joint, item.channel, item.reason]), [
    ['SourceArm', 'base', 'ambiguous_target_mapping'],
    ['SourceArm', 'rootMotion', 'ambiguous_target_mapping'],
    ['SourceArm', 'layer', 'ambiguous_target_mapping'],
  ]);
  assert.deepEqual(partial.recipe.tracks.map(track => track.joint), ['TargetLeg']);
  assert.throws(() => retargetAnimation(input, source, target, { SourceLeg: 'TargetLeg' }), /SourceArm \(base\)/);

  const explicit = retargetAnimation(input, source, target, { SourceArm: 'sourcearm', SourceLeg: 'TargetLeg' });
  assert.equal(explicit.recipe.tracks[0]!.joint, 'sourcearm');
  assert.equal(explicit.report.ambiguousTargetMappings.length, 0);

  const exactTarget = retargetProfileSchema.parse({
    ...target,
    joints: [...target.joints, { ...target.joints[1]!, name: 'SourceArm' }],
  });
  const exact = retargetAnimation(input, source, exactTarget, { SourceLeg: 'TargetLeg' });
  assert.equal(exact.recipe.tracks[0]!.joint, 'SourceArm');
  assert.equal(exact.report.ambiguousTargetMappings.length, 0);
});

test('mapping advisor ranks custom joint aliases with parent and segment evidence without applying them', () => {
  const source = retargetProfileSchema.parse({
    version: 1, rigId: '11111111-1111-4111-8111-111111111111', rigName: 'Source', rigType: 'custom', rigSignature: 'source-custom',
    joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'UpperTorso', parent: 'HumanoidRootPart', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftUpperArm', parent: 'UpperTorso', driven: true, basis: identity, segmentLength: 2 },
      { name: 'RightUpperArm', parent: 'UpperTorso', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const target = retargetProfileSchema.parse({
    version: 1, rigId: '22222222-2222-4222-8222-222222222222', rigName: 'Target', rigType: 'custom', rigSignature: 'target-custom',
    joints: [
      { name: 'Root', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'Chest', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
      { name: 'Arm_L', parent: 'Chest', driven: true, basis: identity, segmentLength: 2 },
      { name: 'Arm_R', parent: 'Chest', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const result = suggestAnimationJointMap(source, target, ['UpperTorso', 'LeftUpperArm', 'RightUpperArm', 'MissingTrack']);
  assert.deepEqual(result.suggestedJointMap, { UpperTorso: 'Chest' });
  const leftArm = result.suggestions.find(item => item.source === 'LeftUpperArm')!;
  assert.equal(leftArm.status, 'ambiguous');
  assert.equal(leftArm.candidates[0]?.target, 'Arm_L');
  assert.ok(leftArm.candidates[0]?.evidence.some(item => item.includes('parent')));
  assert.equal(result.suggestions.find(item => item.source === 'RightUpperArm')?.status, 'ambiguous');
  assert.equal(result.suggestions.find(item => item.source === 'MissingTrack')?.status, 'unmapped');
  assert.match(result.limitation, /never applied automatically/);
  assert.match(result.limitation, /heuristic ranking scores, not calibrated probabilities/);
  assert.match(result.limitation, /do not establish anatomical correctness/);
});

test('mapping advisor exposes ambiguity and refuses hierarchy conflicts and one-to-one collisions', () => {
  const source = retargetProfileSchema.parse({
    version: 1, rigId: '11111111-1111-4111-8111-111111111111', rigName: 'Source', rigType: 'custom', rigSignature: 'source-custom',
    joints: [
      { name: 'Root', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'Torso', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftArm', parent: 'Torso', driven: true, basis: identity, segmentLength: 2 },
      { name: 'ArmLeft', parent: 'Torso', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftUpperArm', parent: 'Torso', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const target = retargetProfileSchema.parse({
    version: 1, rigId: '22222222-2222-4222-8222-222222222222', rigName: 'Target', rigType: 'custom', rigSignature: 'target-custom',
    joints: [
      { name: 'Root', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'Torso', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftArm', parent: 'Torso', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftArmUpper', parent: 'Torso', driven: true, basis: identity, segmentLength: 2 },
      { name: 'LeftUpperArm', parent: 'LeftArm', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const result = suggestAnimationJointMap(source, target, ['LeftArm', 'ArmLeft', 'LeftUpperArm']);
  assert.equal(result.suggestedJointMap.LeftArm, undefined);
  assert.equal(result.suggestedJointMap.ArmLeft, undefined);
  assert.equal(result.suggestions.find(item => item.source === 'LeftArm')?.status, 'conflict');
  assert.equal(result.suggestions.find(item => item.source === 'ArmLeft')?.status, 'conflict');
  const upperArm = result.suggestions.find(item => item.source === 'LeftUpperArm')!;
  assert.equal(upperArm.status, 'suggested');
  assert.equal(upperArm.suggestedTarget, 'LeftArmUpper');
  assert.ok(upperArm.candidates.some(candidate => candidate.target === 'LeftUpperArm' && candidate.hierarchy === 'mismatch'));
});

test('mapping advisor output is stable across profile and request ordering when candidates tie', () => {
  const source = retargetProfileSchema.parse({
    version: 1, rigId: '11111111-1111-4111-8111-111111111111', rigName: 'Source', rigType: 'custom', rigSignature: 'source-order',
    joints: [
      { name: 'Root', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'Torso', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const target = retargetProfileSchema.parse({
    version: 1, rigId: '22222222-2222-4222-8222-222222222222', rigName: 'Target', rigType: 'custom', rigSignature: 'target-order',
    joints: [
      { name: 'Root', parent: '', driven: false, basis: identity, segmentLength: 0 },
      { name: 'Chest', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
      { name: 'chest', parent: 'Root', driven: true, basis: identity, segmentLength: 2 },
    ],
  });
  const first = suggestAnimationJointMap(source, target, ['UnknownJoint', 'Torso']);
  const permuted = suggestAnimationJointMap(
    { ...source, joints: [...source.joints].reverse() },
    { ...target, joints: [...target.joints].reverse() },
    ['Torso', 'UnknownJoint'],
  );
  assert.deepEqual(permuted, first);
  assert.deepEqual(first.suggestions.find(item => item.source === 'Torso')?.candidates.map(candidate => candidate.target), ['Chest', 'chest']);
});

test('mapping advisor rejects empty or oversized requests', () => {
  const source = profile('Source', 'SourceRoot', 'SourceArm');
  const target = profile('Target', 'TargetRoot', 'TargetArm');
  assert.throws(() => suggestAnimationJointMap(source, target, []), /at least one/);
  assert.throws(() => suggestAnimationJointMap(source, target, Array.from({ length: 257 }, (_, index) => `Joint${index}`)), /At most 256/);
});
