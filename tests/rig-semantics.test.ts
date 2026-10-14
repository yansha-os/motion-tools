import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesRigLimbChainName, resolveRigSemanticRoles } from '../src/rig-semantics.js';

const basis: [number, number, number, number] = [0, 0, 0, 1];
function profile(rigType: 'R6' | 'R15' | 'custom', names: Array<{ name: string; parent?: string; driven?: boolean }>) {
  return { version: 1 as const, rigId: 'd5cf776d-9745-4d9e-90d3-1a0b58b9a6f8', rigName: 'Semantic fixture', rigType,
    rigSignature: `semantic-${rigType}`, joints: names.map(joint => ({ name: joint.name, parent: joint.parent ?? '', driven: joint.driven ?? true, basis, segmentLength: 1 })) };
}
function byRole(result: ReturnType<typeof resolveRigSemanticRoles>, role: string) {
  return result.resolutions.find(resolution => resolution.role === role)!;
}

test('semantic role resolver returns exact standard R15 joints without guessing axes or anatomy', () => {
  const result = resolveRigSemanticRoles(profile('R15', [
    { name: 'HumanoidRootPart', driven: false }, { name: 'LowerTorso' }, { name: 'UpperTorso', parent: 'LowerTorso' },
    { name: 'LeftUpperArm' }, { name: 'LeftLowerArm', parent: 'LeftUpperArm' }, { name: 'LeftHand', parent: 'LeftLowerArm' },
    { name: 'RightUpperLeg' }, { name: 'RightLowerLeg', parent: 'RightUpperLeg' }, { name: 'RightFoot', parent: 'RightLowerLeg' },
  ]));
  assert.equal(result.drivenJointCount, 8);
  assert.equal(byRole(result, 'root').status, 'unavailable', 'root part is not a driven animation joint');
  assert.deepEqual([byRole(result, 'pelvis').status, byRole(result, 'pelvis').joint], ['exact', 'LowerTorso']);
  assert.deepEqual([byRole(result, 'left_elbow').status, byRole(result, 'left_elbow').joint], ['exact', 'LeftLowerArm']);
  assert.deepEqual([byRole(result, 'right_foot').status, byRole(result, 'right_foot').joint], ['exact', 'RightFoot']);
  assert.match(result.limitations.join(' '), /not verified anatomy or motion quality/);
});

test('R6 endpoint roles disclose their coarse limb mapping and unavailable articulations', () => {
  const result = resolveRigSemanticRoles(profile('R6', [
    { name: 'HumanoidRootPart', driven: false }, { name: 'Torso' }, { name: 'Left Arm' }, { name: 'Right Arm' }, { name: 'Left Leg' }, { name: 'Right Leg' },
  ]), ['left_shoulder', 'left_hand', 'left_elbow', 'left_hip', 'left_foot']);
  assert.deepEqual([byRole(result, 'left_shoulder').status, byRole(result, 'left_shoulder').joint], ['exact', 'Left Arm']);
  assert.deepEqual([byRole(result, 'left_hand').status, byRole(result, 'left_hand').joint], ['exact', 'Left Arm']);
  assert.match(byRole(result, 'left_hand').evidence.join(' '), /one driven segment/);
  assert.equal(byRole(result, 'left_elbow').status, 'unavailable');
  assert.equal(byRole(result, 'left_foot').joint, 'Left Leg');
});

test('custom rig inference uses unique name tokens and leaves ambiguous matches unselected', () => {
  const result = resolveRigSemanticRoles(profile('custom', [
    { name: 'Root_control', driven: true }, { name: 'arm_L' }, { name: 'upper_arm_left' }, { name: 'forearm_L' }, { name: 'elbow_L' },
    { name: 'Foot_R' }, { name: 'RightFoot' }, { name: 'chest' }, { name: 'LeftHip' },
  ]), ['root', 'left_shoulder', 'left_elbow', 'right_foot', 'torso', 'pelvis']);
  assert.equal(byRole(result, 'root').status, 'inferred');
  assert.equal(byRole(result, 'left_shoulder').status, 'ambiguous');
  assert.equal(byRole(result, 'left_shoulder').joint, undefined);
  assert.deepEqual(byRole(result, 'left_shoulder').candidates, ['arm_L', 'upper_arm_left']);
  assert.deepEqual(byRole(result, 'left_shoulder').candidateContexts?.map(candidate => candidate.joint), ['arm_L', 'upper_arm_left']);
  assert.deepEqual(byRole(result, 'left_shoulder').candidateContexts?.[0]?.context.rootToJoint.map(joint => joint.name), ['arm_L']);
  assert.equal(byRole(result, 'left_elbow').status, 'ambiguous');
  assert.equal(byRole(result, 'right_foot').status, 'ambiguous');
  assert.equal(byRole(result, 'torso').joint, 'chest');
  assert.equal(byRole(result, 'pelvis').status, 'unavailable', 'a side-specific hip must not be mistaken for the central pelvis');
  assert.match(byRole(result, 'left_elbow').evidence.join(' '), /Multiple driven joints/);
});

test('semantic role evidence includes the inspected root-to-joint chain and rest basis without claiming anatomical axes', () => {
  const result = resolveRigSemanticRoles(profile('R15', [
    { name: 'HumanoidRootPart', driven: false }, { name: 'LowerTorso', parent: 'HumanoidRootPart' },
    { name: 'UpperTorso', parent: 'LowerTorso' }, { name: 'LeftUpperArm', parent: 'UpperTorso' },
    { name: 'LeftLowerArm', parent: 'LeftUpperArm' }, { name: 'LeftHand', parent: 'LeftLowerArm' },
  ]), ['left_hand']);
  const hand = byRole(result, 'left_hand');
  assert.equal(hand.status, 'exact');
  assert.deepEqual(hand.jointContext?.rootToJoint.map(joint => joint.name),
    ['HumanoidRootPart', 'LowerTorso', 'UpperTorso', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand']);
  assert.deepEqual(hand.jointContext?.rootToJoint[0], { name: 'HumanoidRootPart', parent: '', driven: false,
    restBasisQuaternion: basis, segmentLengthStuds: 1 });
  assert.equal(hand.jointContext?.chainStatus, 'complete');
  assert.match(hand.jointContext?.limitation ?? '', /not an anatomical axis\/limit/i);
  assert.match(result.limitations.join(' '), /rest-basis quaternions.*do not establish anatomy/i);
});

test('semantic joint context reports incomplete/cyclic ancestry and bounds ambiguous custom-rig detail', () => {
  const missing = resolveRigSemanticRoles(profile('custom', [
    { name: 'hand_left', parent: 'MissingArm' },
  ]), ['left_hand']);
  assert.equal(byRole(missing, 'left_hand').jointContext?.chainStatus, 'parent_missing');

  const cyclic = resolveRigSemanticRoles(profile('custom', [
    { name: 'hand_left', parent: 'hand_left' },
  ]), ['left_hand']);
  assert.equal(byRole(cyclic, 'left_hand').jointContext?.chainStatus, 'cycle_detected');

  const manyCandidates = profile('custom', Array.from({ length: 10 }, (_, index) => ({ name: `hand_left_${index}` })));
  const ambiguous = byRole(resolveRigSemanticRoles(manyCandidates, ['left_hand']), 'left_hand');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidateContexts?.length, 8);
  assert.equal(ambiguous.omittedCandidateContextCount, 2);
});

test('semantic resolver rejects duplicate role requests and non-driven aliases', () => {
  const rig = profile('custom', [{ name: 'Root', driven: false }, { name: 'left_hand', driven: false }, { name: 'left_hand_joint' }]);
  assert.throws(() => resolveRigSemanticRoles(rig, ['head', 'head']), /must be unique/);
  assert.equal(byRole(resolveRigSemanticRoles(rig, ['left_hand']), 'left_hand').joint, 'left_hand_joint');
});

test('custom limb-chain matching supports side suffixes without crossing to the opposite side', () => {
  assert.equal(matchesRigLimbChainName('hand_L', 'left', 'arm'), true);
  assert.equal(matchesRigLimbChainName('forearmLeft', 'left', 'arm'), true);
  assert.equal(matchesRigLimbChainName('UpperArm_Right', 'right', 'arm'), true);
  assert.equal(matchesRigLimbChainName('RightUpperArm', 'left', 'arm'), false);
  assert.equal(matchesRigLimbChainName('foot_R', 'right', 'leg'), true);
  assert.equal(matchesRigLimbChainName('shinLeft', 'left', 'leg'), true);
  assert.equal(matchesRigLimbChainName('RightLeg', 'left', 'leg'), false);
  assert.equal(matchesRigLimbChainName('Root', 'left', 'arm'), false);
});
