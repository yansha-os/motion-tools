import test from 'node:test';
import assert from 'node:assert/strict';
import { animationPreset, type AnimationRecipe } from '../src/recipes.js';
import { analyzeRigAnimationCoverage, analyzeRigSemanticRoleCoverage, analyzeViewportCandidateReadiness, auditAnimation, summarizeRootMotionPath } from '../src/animation-quality.js';

test('root-motion digest distinguishes net local travel from a curved authored key path', () => {
  const recipe = animationPreset('walk', 'Root path', 2, 1);
  recipe.rootMotion = { joint: 'HumanoidRootPart', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [3, 0, 0], rotation: [0, 45, 0] },
    { time: 2, position: [3, 0, 4], rotation: [0, 90, 0] },
  ] };
  const summary = summarizeRootMotionPath(recipe);
  assert.ok(summary);
  assert.deepEqual(summary.netLocalDisplacement, [3, 0, 4]);
  assert.equal(summary.netLocalDistance, 5);
  assert.equal(summary.authoredPolylineLength, 7);
  assert.equal(summary.straightnessRatio, 5 / 7);
  assert.equal(summary.keyCount, 3);
  assert.match(summary.basis, /local coordinates.*Not hierarchy-composed world-space/i);
  assert.match(summary.interpretation, /does not judge whether that path fits the action/i);
  assert.equal(summarizeRootMotionPath(animationPreset('idle', 'No root path', 1, 1)), null);
});

test('animation audit enforces its discrete sampling and bounded-detail contract for direct callers', () => {
  const recipe = animationPreset('idle', 'Audit input bounds', 1, 1);
  for (const sampleRateHz of [0, 29, 90, 241, Number.NaN]) {
    assert.throws(() => auditAnimation(recipe, sampleRateHz as 30), /sampleRateHz must be one of 30, 60, 120, or 240/);
  }
  for (const phaseDetailLimit of [-1, 0, 1.5, 17, Number.NaN]) {
    assert.throws(() => auditAnimation(recipe, 60, phaseDetailLimit), /phaseDetailLimit must be an integer between 1 and 16/);
  }
  assert.equal(auditAnimation(recipe, 30, 1).actionPhaseMap.detailLimitPerPhase, 1);
  assert.equal(auditAnimation(recipe, 240, 16).actionPhaseMap.detailLimitPerPhase, 16);
});

test('animation audit flags sparse tracks and synchronized timing without scoring artistry', () => {
  const recipe = animationPreset('walk', 'Walk', 2, 1);
  for (const track of recipe.tracks) track.keys = [track.keys[0]!, track.keys.at(-1)!];
  recipe.contacts = [{ effector: recipe.tracks[0]!.joint, kind: 'support', start: 0.2, end: 0.7 },
    { effector: 'DisabledEffector', kind: 'grip', start: 0.8, end: 1.2 },
    { effector: 'UntrackedEffector', kind: 'support', start: 1.3, end: 1.8 }];
  recipe.layers = [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Disabled contact pose', blendMode: 'Override', weight: 1,
    enabled: false, tracks: [{ joint: 'DisabledEffector', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] }];
  const result = auditAnimation(recipe);
  assert.ok(result.advisories.some(item => item.id === 'sparse-tracks'));
  assert.ok(result.advisories.some(item => item.id === 'synchronized-timing'));
  assert.ok(result.advisories.some(item => item.id === 'visual-review'));
  assert.deepEqual(result.contactTrackCoverage.map(contact => [contact.effector, contact.status]), [
    [recipe.tracks[0]!.joint, 'active_channel'], ['DisabledEffector', 'inactive_channels_only'], ['UntrackedEffector', 'no_matching_channel'],
  ]);
  assert.ok(result.advisories.some(item => item.id === 'contact-channel-coverage'));
  assert.match(result.advisories.find(item => item.id === 'contact-channel-coverage')!.detail,
    /missing\/disabled channel can still be intentional rest-pose contact.*does not prove/i);
  const coveredContacts = auditAnimation({ ...recipe, contacts: [{ effector: recipe.tracks[1]!.joint, kind: 'grip', start: 0.2, end: 0.8 }] });
  assert.deepEqual(coveredContacts.contactTrackCoverage.map(contact => contact.status), ['active_channel']);
  assert.equal(coveredContacts.advisories.some(item => item.id === 'contact-channel-coverage'), false,
    'fully channel-covered contact intent should not produce a missing-channel advisory');
  assert.match(result.limitation, /cannot certify/i);
  assert.equal(result.summary.keys, recipe.tracks.length * 2);
});

test('AI audit refinement, phase and coordination tie-breaks are stable across track order', () => {
  const recipe = animationPreset('slash', 'Stable audit', 1, 1);
  recipe.loop = true;
  const reordered = structuredClone(recipe);
  reordered.tracks.reverse();
  const first = auditAnimation(recipe);
  const second = auditAnimation(reordered);
  assert.deepEqual(second.refinementPlan, first.refinementPlan);
  assert.deepEqual(second.actionPhaseMap, first.actionPhaseMap);
  assert.deepEqual(second.coordination, first.coordination);
  assert.deepEqual(second.trackMotion, first.trackMotion);
  assert.deepEqual(second.curveMotion, first.curveMotion);
  assert.deepEqual(second.loopSeamVelocity, first.loopSeamVelocity);
});

test('rig-aware animation coverage distinguishes driven, unresolved, inactive, and intentionally still joints', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Rig coverage', duration: 1, loop: false,
    tracks: [
      { joint: 'UpperTorso', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [0, 12, 0] },
      ] },
      { joint: 'UnknownArm', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [0, 10, 0] },
      ] },
    ],
    layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Disabled flourish', blendMode: 'Additive', weight: 0.8,
      enabled: false, tracks: [{ joint: 'RightUpperArm', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [0, 20, 0] },
      ] }] }], markers: [], contacts: [
    { effector: 'UpperTorso', kind: 'support', start: 0.1, end: 0.8 },
    { effector: 'RightUpperArm', kind: 'grip', start: 0.2, end: 0.5 },
    { effector: 'HumanoidRootPart', kind: 'support', start: 0.5, end: 0.9 },
    { effector: 'UnknownFoot', kind: 'support', start: 0.1, end: 0.9 },
  ],
  };
  const report = analyzeRigAnimationCoverage(recipe, [
    { name: 'UpperTorso', parent: 'LowerTorso', driven: true },
    { name: 'RightUpperArm', parent: 'UpperTorso', driven: true },
    { name: 'RightLowerArm', parent: 'RightUpperArm', driven: true },
    { name: 'HumanoidRootPart', parent: '', driven: false },
  ]);
  assert.equal(report.drivenJointCount, 3);
  assert.equal(report.authoredJointCount, 3);
  assert.equal(report.coveredDrivenJointCount, 1);
  assert.deepEqual(report.unresolvedTrackJoints, ['UnknownArm']);
  assert.deepEqual(report.contacts.map(contact => [contact.effector, contact.rigJoint, contact.rigStatus, contact.channelStatus]), [
    ['UpperTorso', 'UpperTorso', 'driven', 'active_channel'],
    ['RightUpperArm', 'RightUpperArm', 'driven', 'inactive_channels_only'],
    ['HumanoidRootPart', 'HumanoidRootPart', 'not_driven', 'no_matching_channel'],
    ['UnknownFoot', 'UnknownFoot', 'unresolved', 'no_matching_channel'],
  ]);
  assert.equal(report.joints.find(joint => joint.name === 'UpperTorso')?.active, true);
  assert.equal(report.joints.find(joint => joint.name === 'RightUpperArm')?.active, false);
  assert.match(report.joints.find(joint => joint.name === 'RightLowerArm')?.note ?? '', /intentional stillness is valid/i);
  assert.deepEqual(report.excludedChannels.map(channel => [channel.joint, channel.source, channel.reason]), [
    ['RightUpperArm', 'layer', 'Layer disabled or weight is zero; not part of active coverage.'],
  ]);
  assert.match(report.limitation, /exact target names.*does not infer semantic body roles/i);
  const mapped = analyzeRigAnimationCoverage({ ...recipe, tracks: [recipe.tracks[1]!], layers: [], contacts: [
    { effector: 'UnknownArm', kind: 'grip', start: 0.1, end: 0.9 },
  ] }, [
    { name: 'RightLowerArm', parent: 'RightUpperArm', driven: true },
  ], { UnknownArm: 'RightLowerArm' });
  assert.deepEqual(mapped.unresolvedTrackJoints, []);
  assert.equal(mapped.coveredDrivenJointCount, 1);
  assert.equal(mapped.joints[0]?.channels[0]?.sourceJoint, 'UnknownArm');
  assert.deepEqual(mapped.contacts.map(contact => [contact.rigJoint, contact.rigStatus, contact.channelStatus]), [
    ['RightLowerArm', 'driven', 'active_channel'],
  ]);
  const rootMotionRecipe: AnimationRecipe = { ...recipe, rootMotion: { joint: 'UpperTorso', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 2], rotation: [0, 0, 0] },
  ] } };
  const rootMotionCoverage = analyzeRigAnimationCoverage(rootMotionRecipe, [
    { name: 'UpperTorso', parent: 'LowerTorso', driven: true },
    { name: 'RightUpperArm', parent: 'UpperTorso', driven: true },
    { name: 'RightLowerArm', parent: 'RightUpperArm', driven: true },
  ]);
  assert.equal(rootMotionCoverage.joints.find(joint => joint.name === 'UpperTorso')?.channels
    .some(channel => channel.source === 'rootMotion' && channel.sourceJoint === 'UpperTorso' && channel.active), true);
  assert.deepEqual(rootMotionCoverage.rootMotion, { sourceJoint: 'UpperTorso', joint: 'UpperTorso', keyCount: 2, status: 'resolved' });
  assert.equal(rootMotionCoverage.coveredDrivenJointCount, 1,
    'a root-motion channel covers its driven joint without counting the same joint twice');
  const mappedRootMotion = analyzeRigAnimationCoverage({ ...recipe, rootMotion: { ...rootMotionRecipe.rootMotion!, joint: 'TravelRoot' } }, [
    { name: 'MappedTravelRoot', parent: 'UpperTorso', driven: true },
  ], { TravelRoot: 'MappedTravelRoot' });
  assert.deepEqual(mappedRootMotion.rootMotion, { sourceJoint: 'TravelRoot', joint: 'MappedTravelRoot', keyCount: 2, status: 'resolved' });
  const unresolvedRootMotion = analyzeRigAnimationCoverage({ ...recipe, rootMotion: { ...rootMotionRecipe.rootMotion!, joint: 'MissingRoot' } }, []);
  assert.deepEqual(unresolvedRootMotion.rootMotion, { sourceJoint: 'MissingRoot', joint: 'MissingRoot', keyCount: 2, status: 'unresolved' });
  const viewport = analyzeViewportCandidateReadiness(recipe, new Set(['UpperTorso', 'RightUpperArm', 'RightLowerArm']));
  assert.equal(viewport.status, 'needs_joint_resolution');
  assert.deepEqual(viewport.unresolvedTrackJoints, ['UnknownArm']);
  assert.match(viewport.limitation, /jointMap affects Studio sampling.*does not rename or retarget/i);
  const readyViewport = analyzeViewportCandidateReadiness({ ...recipe, tracks: [recipe.tracks[0]!], layers: [] }, new Set(['UpperTorso']));
  assert.equal(readyViewport.status, 'ready');
  assert.deepEqual(readyViewport.unresolvedTrackJoints, []);
});

test('semantic role coverage exposes rig-aware authored/active body channels without imposing quotas', () => {
  const profile = { version: 1 as const, rigId: 'a0718e72-425c-4915-8f91-41d0cd693bf1', rigName: 'R6 fixture', rigType: 'R6' as const,
    rigSignature: 'r6-role-coverage-fixture', joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      ...['Torso', 'Left Arm', 'Right Arm', 'Left Leg', 'Right Leg'].map(name => ({ name, parent: 'HumanoidRootPart', driven: true,
        basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 })),
    ] };
  const recipe: AnimationRecipe = { kind: 'animation', name: 'R6 arm action', duration: 1, loop: false,
    tracks: [{ joint: 'Left Arm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 15, 0] }] }],
    layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Disabled right arm', blendMode: 'Additive', weight: 0.8,
      enabled: false, tracks: [{ joint: 'Right Arm', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [0, 0, 0], rotation: [0, 10, 0] }] }] }], markers: [],
  };
  const coverage = analyzeRigSemanticRoleCoverage(recipe, profile);
  assert.equal(coverage.rig.type, 'R6');
  assert.equal(coverage.roles.find(role => role.role === 'left_shoulder')?.state, 'active');
  assert.equal(coverage.roles.find(role => role.role === 'left_hand')?.state, 'active', 'R6 hand is an endpoint alias for its one driven arm segment');
  assert.equal(coverage.roles.find(role => role.role === 'right_shoulder')?.state, 'inactive_only');
  assert.equal(coverage.roles.find(role => role.role === 'right_hand')?.state, 'inactive_only');
  assert.equal(coverage.roles.find(role => role.role === 'left_foot')?.state, 'not_authored');
  assert.equal(coverage.roles.find(role => role.role === 'left_elbow')?.resolution, 'unavailable');
  assert.ok(coverage.sharedJointRoles.some(item => item.joint === 'Left Arm' && item.roles.includes('left_hand') && item.roles.includes('left_shoulder')));
  assert.equal(coverage.summary.activeRoleCount, 2, 'role counts intentionally expose R6 alias duplication rather than claiming distinct joint count');
  assert.match(coverage.limitation, /not a quality score or quota/i);

  const mappedRecipe: AnimationRecipe = { ...recipe, tracks: [{ joint: 'LegacyLeftArm', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 15, 0] },
  ] }], layers: [] };
  const mappedCoverage = analyzeRigSemanticRoleCoverage(mappedRecipe, profile, { LegacyLeftArm: 'Left Arm' });
  assert.equal(mappedCoverage.roles.find(role => role.role === 'left_shoulder')?.state, 'active',
    'semantic coverage must resolve explicitly mapped source names onto the inspected target rig');
  assert.equal(mappedCoverage.roles.find(role => role.role === 'left_shoulder')?.channels[0]?.sourceJoint, 'LegacyLeftArm');
});

test('animation audit catches possible angular loop seam and excessive key density', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Loop seam', duration: 1, loop: true,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.1, position: [0, 0, 0], rotation: [50, 0, 0] },
      { time: 0.9, position: [0, 0, 0], rotation: [-100, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }], markers: [],
  };
  recipe.tracks.push({ joint: 'Head', keys: Array.from({ length: 33 }, (_, index) => ({ time: index / 32, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] })) });
  const result = auditAnimation(recipe);
  assert.ok(result.advisories.some(item => item.id === 'dense-tracks'));
  assert.ok(result.advisories.some(item => item.id === 'loop-angular-seam'));
});

test('animation audit does not report a loop seam from equivalent wrapped Euler angles', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Wrapped loop', duration: 1, loop: true,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [179, 0, 0] },
      { time: 0.1, position: [0, 0, 0], rotation: [-179, 0, 0] },
      { time: 0.9, position: [0, 0, 0], rotation: [177, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [179, 0, 0] },
    ] }], markers: [],
  };
  const result = auditAnimation(recipe);
  assert.ok(!result.advisories.some(item => item.id === 'loop-angular-seam'));
  assert.ok(result.loopSeamVelocity[0]!.endpointAngularOffsetDegrees < 1e-6);
});

test('angular seam advisory respects eased boundary velocity instead of raw key slopes', () => {
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Eased loop', duration: 1, loop: true, markers: [],
    tracks: [{ joint: 'Head', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'CubicV2', easingDirection: 'InOut' },
      { time: 0.1, position: [0, 0, 0], rotation: [50, 0, 0] },
      { time: 0.9, position: [0, 0, 0], rotation: [-100, 0, 0], easingStyle: 'CubicV2', easingDirection: 'InOut' },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] };
  const audit = auditAnimation(recipe);
  assert.ok(audit.loopSeamVelocity[0]!.angularDiscontinuityDegreesPerSecond < 360);
  assert.ok(!audit.advisories.some(item => item.id === 'loop-angular-seam'));
  recipe.tracks[0]!.keys[0]!.easingStyle = 'Linear';
  recipe.tracks[0]!.keys[2]!.easingStyle = 'Linear';
  assert.ok(auditAnimation(recipe).advisories.some(item => item.id === 'loop-angular-seam'));
});

test('loop endpoint jumps remain visible when incoming and outgoing velocities match', () => {
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Steady loop with a jump', duration: 1, loop: true, markers: [],
    tracks: [{ joint: 'Head', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [1, 0, 0], rotation: [0, 90, 0] },
    ] }] };
  const metric = auditAnimation(recipe).loopSeamVelocity[0]!;
  assert.equal(metric.endpointPositionOffsetStuds, 1);
  assert.ok(Math.abs(metric.endpointAngularOffsetDegrees - 90) < 1e-6);
  assert.ok(metric.positionDiscontinuityStudsPerSecond < 1e-6);
  assert.ok(metric.angularDiscontinuityDegreesPerSecond < 1e-5);
  assert.equal(metric.velocitySampleStepSeconds, 0.001);
  assert.match(metric.interpretation, /before layer composition or rig hierarchy/);
});

test('composed loop boundaries expose layer cancellation and omit inactive-only channels', () => {
  const track = (joint: string, offset: number) => ({ joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [offset, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] });
  const recipe: AnimationRecipe = { kind: 'animation', name: 'Layer cancellation', duration: 1, loop: true, markers: [],
    tracks: [track('Head', 1)], layers: [
      { id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Cancel', enabled: true, weight: 1, blendMode: 'Additive', tracks: [track('Head', -1)] },
      { id: '248b405e-cbd4-4c8e-a644-c76bb57277ae', name: 'Disabled', enabled: false, weight: 1, blendMode: 'Additive', tracks: [track('RightHand', 9)] },
    ] };
  const audit = auditAnimation(recipe);
  assert.deepEqual(audit.composedLoopSeam.map(metric => metric.joint), ['Head']);
  assert.equal(audit.composedLoopSeam[0]?.endpointPositionOffsetStuds, 0);
  assert.equal(audit.loopSeamVelocity.filter(metric => metric.joint === 'Head').length, 2);
  recipe.layers![0]!.weight = 0.5;
  assert.equal(auditAnimation(recipe).composedLoopSeam[0]?.endpointPositionOffsetStuds, 0.5);
  recipe.loop = false;
  assert.deepEqual(auditAnimation(recipe).composedLoopSeam, []);
});

test('animation audit checks angular loop seams on the separate root-motion channel', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Turning root loop', duration: 1, loop: true,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }],
    rootMotion: { joint: 'HumanoidRootPart', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.1, position: [0, 0, 0], rotation: [0, 0, 90] },
      { time: 0.9, position: [0, 0, 0], rotation: [0, 0, -30] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }, markers: [],
  };
  const result = auditAnimation(recipe);
  const advisory = result.advisories.find(item => item.id === 'loop-angular-seam');
  assert.match(advisory?.detail ?? '', /HumanoidRootPart \(root motion\)/);
  assert.ok(result.loopSeamVelocity.find(metric => metric.channel === 'rootMotion')!.angularDiscontinuityDegreesPerSecond > 360);
});

test('animation audit explains intentional root-motion travel across a loop boundary', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Traveling root loop', duration: 1, loop: true,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }],
    rootMotion: { joint: 'HumanoidRootPart', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [2, 0, 0], rotation: [0, 0, 0] },
    ] }, markers: [],
  };
  const result = auditAnimation(recipe);
  const advisory = result.advisories.find(item => item.id === 'root-motion-loop-travel');
  assert.match(advisory?.detail ?? '', /endpoint offset of 2\.000 studs/);
  assert.match(advisory?.detail ?? '', /Different root-motion endpoints can be intentional/);
  assert.match(advisory?.detail ?? '', /preserve intended displacement rather than forcing endpoint transforms to match/);
  assert.ok(result.loopSeamVelocity.find(metric => metric.channel === 'rootMotion')!.positionDiscontinuityStudsPerSecond < 1e-6);
  assert.ok(!result.advisories.some(item => item.id === 'loop-angular-seam'));
});

test('animation audit does not flag a sparse two-key single-track clip as synchronized', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Simple motion', duration: 1, loop: false,
    tracks: [{ joint: 'Head', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [20, 0, 0] },
    ] }], markers: [],
  };
  const result = auditAnimation(recipe);
  assert.ok(result.advisories.some(item => item.id === 'sparse-tracks'));
  assert.ok(!result.advisories.some(item => item.id === 'synchronized-timing'));
});

test('synchronized-timing advisory preserves close authored offsets but tolerates floating-point noise', () => {
  const recipe = animationPreset('walk', 'Timing distinction', 1, 1);
  for (const track of recipe.tracks) track.keys = [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.3, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ];
  recipe.tracks[1]!.keys[1]!.time = 0.30005;
  assert.ok(!auditAnimation(recipe).advisories.some(item => item.id === 'synchronized-timing'),
    'a deliberate 50-microsecond stagger must not be rounded into a synchronized schedule');

  recipe.tracks[1]!.keys[1]!.time = 0.1 + 0.2;
  assert.ok(auditAnimation(recipe).advisories.some(item => item.id === 'synchronized-timing'),
    'floating-point representation noise must not hide a shared schedule');
  recipe.tracks[1]!.keys.pop();
  assert.ok(!auditAnimation(recipe).advisories.some(item => item.id === 'synchronized-timing'),
    'tracks with different key counts do not share a complete schedule');
});

test('animation audit returns per-track local speed and velocity-change evidence with wrapped Euler deltas', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Motion metrics', duration: 2, loop: false,
    tracks: [{ joint: 'RightHand', keys: [
      { time: 0, position: [0, 0, 0], rotation: [179, 0, 0] },
      { time: 1, position: [2, 0, 0], rotation: [-179, 0, 0] },
      { time: 2, position: [8, 0, 0], rotation: [-169, 0, 0] },
    ] }], markers: [],
  };
  const result = auditAnimation(recipe);
  assert.deepEqual(result.trackMotion, [{
    channel: 'base',
    joint: 'RightHand',
    peakLocalPositionSpeed: { unitsPerSecond: 6, startTime: 1, endTime: 2, startKeyIndex: 1, endKeyIndex: 2 },
    peakLocalAngularSpeed: { degreesPerSecond: 10, startTime: 1, endTime: 2, startKeyIndex: 1, endKeyIndex: 2 },
    largestLocalPositionVelocityChange: { unitsPerSecondSquared: 4, time: 1, keyIndex: 1 },
    largestLocalAngularVelocityChange: { degreesPerSecondSquared: 8, time: 1, keyIndex: 1 },
  }]);
  assert.match(result.limitation, /curveMotion samples the authored easing/);
});

test('curve-motion audit measures eased quaternion motion and its higher derivatives at the requested rate', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Eased motion', duration: 1, loop: false,
    tracks: [{ joint: 'RightHand', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Linear' },
      { time: 1, position: [1, 0, 0], rotation: [0, 90, 0] },
    ] }], markers: [],
  };
  const linear = auditAnimation(recipe, 60).curveMotion[0]!;
  assert.equal(linear.evaluationCount, 61);
  assert.ok(Math.abs(linear.peakLocalPositionSpeed.unitsPerSecond - 1) < 1e-8);
  assert.ok(Math.abs(linear.peakLocalAngularSpeed.degreesPerSecond - 90) < 1e-6);
  assert.ok(linear.peakLocalPositionAcceleration.unitsPerSecondSquared < 1e-8);

  recipe.tracks[0]!.keys[0]!.easingStyle = 'CubicV2';
  recipe.tracks[0]!.keys[0]!.easingDirection = 'Out';
  const eased = auditAnimation(recipe, 120);
  const curve = eased.curveMotion[0]!;
  assert.equal(eased.curveMotionSampleRateHz, 120);
  assert.equal(curve.evaluationCount, 121);
  assert.ok(curve.peakLocalPositionSpeed.unitsPerSecond > 2.8);
  assert.ok(curve.peakLocalAngularSpeed.degreesPerSecond > 250);
  assert.ok(curve.peakLocalPositionAcceleration.unitsPerSecondSquared > 2);
  assert.ok(curve.peakLocalPositionJerk.unitsPerSecondCubed > 1);
  const angularJerkTarget = eased.refinementPlan.find(target => target.signal === 'peakLocalAngularJerk')!;
  assert.equal(angularJerkTarget.joint, 'RightHand');
  assert.deepEqual(angularJerkTarget.keySegment, {
    startKeyIndex: 0, endKeyIndex: 1, startTime: 0, endTime: 1,
    easingStyle: 'CubicV2', easingDirection: 'Out',
  });
  assert.deepEqual(angularJerkTarget.patchFocus.availableOperations, ['set_easing', 'set_curve', 'insert_key']);
  assert.equal(angularJerkTarget.interpretation.issueStatus, 'unclassified');
  assert.equal(angularJerkTarget.interpretation.requiresVisualDecision, true);
  assert.equal(angularJerkTarget.measurementProvenance.sampleRateHz, 120);
  assert.equal(angularJerkTarget.measurementProvenance.derivativeOrder, 3);
  assert.equal(angularJerkTarget.measurementProvenance.segmentAttribution, 'segment_containing_event_time');
  assert.deepEqual(angularJerkTarget.measurementProvenance.crossedBoundaries, []);
  assert.ok(Math.abs(angularJerkTarget.measurementProvenance.sampleWindow.endTime
    - angularJerkTarget.measurementProvenance.sampleWindow.startTime - 3 / 120) < 1e-8);
  assert.ok(angularJerkTarget.eventTime >= angularJerkTarget.measurementProvenance.sampleWindow.startTime
    && angularJerkTarget.eventTime <= angularJerkTarget.measurementProvenance.sampleWindow.endTime);
  assert.match(angularJerkTarget.interpretation.signalMeaning, /change in local pose acceleration/i);
  assert.match(angularJerkTarget.interpretation.evidenceScope, /excludes rig hierarchy.*rendered appearance/i);
  assert.deepEqual(angularJerkTarget.repairOptions.map(option => option.operation), ['set_easing', 'set_curve', 'insert_key']);
  assert.match(angularJerkTarget.repairOptions[0]!.whenToUse, /endpoint poses are right/i);
  assert.match(angularJerkTarget.repairOptions[0]!.risk, /contact timing/i);
  assert.match(angularJerkTarget.suggestedNextStep, /Preview the (.* phase|unsegmented clip) around/);
  assert.match(angularJerkTarget.suggestedNextStep, /measurement is not itself a defect/i);
  assert.match(angularJerkTarget.suggestedNextStep, /dry-run set_easing first/i);
});

test('curve-motion quaternion sampling follows the short rotational path across wrapped Euler values', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Wrapped turn', duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 179, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, -179, 0] },
    ] }], markers: [],
  };
  const metric = auditAnimation(recipe).curveMotion[0]!;
  assert.ok(Math.abs(metric.peakLocalAngularSpeed.degreesPerSecond - 2) < 0.001);
});

test('animation coordination reports onset, peak lag, movement windows, and synchronized base-track phases', () => {
  const track = (joint: string, keys: [number, number][]) => ({
    joint,
    keys: keys.map(([time, x]) => ({ time, position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] })),
  });
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Staggered action', duration: 1, loop: false,
    tracks: [
      track('LeftUpperArm', [[0, 0], [0.25, 1], [1, 0.2]]),
      track('RightUpperArm', [[0, 0], [0.5, 0], [0.75, 1], [1, 0]]),
    ], markers: [],
  };
  const result = auditAnimation(recipe, 60);
  const left = result.curveMotion.find(item => item.joint === 'LeftUpperArm')!.phaseTiming.position;
  const right = result.curveMotion.find(item => item.joint === 'RightUpperArm')!.phaseTiming.position;
  assert.equal(left.status, 'active');
  assert.equal(right.status, 'active');
  assert.equal(left.onsetTime, 0);
  assert.ok(Math.abs(right.onsetTime! - 0.5) < 1e-8);
  assert.ok(left.activeCoverageFraction > 0 && left.activeCoverageFraction <= 1);
  assert.equal(result.coordination.position.activeJointCount, 2);
  assert.equal(result.coordination.position.synchronizedPeakGroups.length, 0);
  const onsetLag = result.coordination.position.largestOnsetLags[0]!;
  assert.equal(onsetLag.earlierJoint, 'LeftUpperArm');
  assert.equal(onsetLag.laterJoint, 'RightUpperArm');
  assert.ok(Math.abs(onsetLag.lagSeconds - 0.5) < 1e-8);
  assert.ok(Math.abs(onsetLag.overlapSeconds - 0.5) < 1e-8);
  const peakLag = result.coordination.position.largestPeakLags[0]!;
  assert.equal(peakLag.earlierJoint, 'LeftUpperArm');
  assert.equal(peakLag.laterJoint, 'RightUpperArm');
  assert.ok(Math.abs(peakLag.lagSeconds - 0.5) < 1e-8);
  assert.ok(Math.abs(peakLag.overlapSeconds - 0.5) < 1e-8);

  recipe.tracks[1]!.keys = structuredClone(recipe.tracks[0]!.keys).map(key => ({ ...key, position: [key.position[0] * 0.5, 0, 0] }));
  const synchronized = auditAnimation(recipe, 60);
  const synchronizedGroup = synchronized.coordination.position.synchronizedPeakGroups[0]!;
  assert.deepEqual(synchronizedGroup.joints, ['LeftUpperArm', 'RightUpperArm']);
  assert.ok(Math.abs(synchronizedGroup.startTime - synchronizedGroup.endTime) < 1e-8);
  assert.equal(synchronizedGroup.spreadSeconds, 0);
});

test('composed coordination reflects weighted layers and root motion instead of treating source tracks as the final pose', () => {
  const track = (joint: string, values: [number, number][]) => ({ joint, keys: values.map(([time, x]) => ({
    time, position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  })) });
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Layered timing', duration: 1, loop: false,
    tracks: [
      track('LeftArm', [[0, 0], [1, 2]]),
      track('RightArm', [[0, 0], [0.5, 0], [1, 1]]),
    ],
    rootMotion: track('HumanoidRootPart', [[0, 0], [1, 2]]),
    layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Cancel arm base', blendMode: 'Additive', weight: 0.5, enabled: true,
      tracks: [track('LeftArm', [[0, 0], [1, -4]])] }],
    markers: [],
  };
  const result = auditAnimation(recipe, 60);
  assert.equal(result.coordination.position.activeJointCount, 2, 'base coordination describes the two independently authored base tracks');
  assert.equal(result.composedCoordination.position.activeJointCount, 2, 'the canceled LeftArm contribution disappears while root travel remains active');
  const composedLag = result.composedCoordination.position.largestOnsetLags[0];
  assert.ok(composedLag);
  assert.equal(composedLag.earlierJoint, 'HumanoidRootPart');
  assert.equal(composedLag.laterJoint, 'RightArm');
  assert.ok(Math.abs(composedLag.lagSeconds - 0.5) <= 1 / 30, 'the composed timing identifies the later arm contribution');
  assert.match(result.composedCoordination.basis, /after base tracks, enabled weighted layers.*root-motion/i);
  assert.equal(result.composedCoordination.uniformSampleCapped, false);
});

test('action phase map segments only on named phase markers and attaches motion/contact evidence', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Marked strike', duration: 1, loop: false,
    tracks: [{ joint: 'RightHand', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.25, position: [1, 0, 0], rotation: [0, 20, 0] },
      { time: 0.5, position: [0, 0, 0], rotation: [0, 40, 0] },
      { time: 0.75, position: [1, 0, 0], rotation: [0, 20, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }],
    contacts: [{ effector: 'LeftHand', kind: 'grip', start: 0.3, end: 0.8 }],
    markers: [
      { name: 'Footstep', time: 0.1 },
      { name: 'Windup', time: 0.2 },
      { name: 'Impact', time: 0.5 },
      { name: 'FollowThrough', time: 0.75 },
      { name: 'Recovery', time: 0.9 },
    ],
  };
  const result = auditAnimation(recipe);
  const phaseMap = result.actionPhaseMap;
  assert.equal(phaseMap.source, 'named_markers');
  assert.equal(phaseMap.detailLimitPerPhase, 6);
  assert.deepEqual(phaseMap.phases.map(phase => [phase.label, phase.startTime, phase.endTime]), [
    ['unclassified', 0, 0.2], ['anticipation', 0.2, 0.5], ['main_action', 0.5, 0.75],
    ['follow_through', 0.75, 0.9], ['recovery', 0.9, 1],
  ]);
  assert.deepEqual(phaseMap.phases[1]!.boundaryMarkers, ['Windup']);
  assert.deepEqual(phaseMap.phases[1]!.endingMarkers, ['Impact']);
  assert.deepEqual(phaseMap.phases[1]!.boundaryLabels, ['anticipation']);
  assert.ok(phaseMap.phases[1]!.activeChannelCount > 0);
  assert.deepEqual(phaseMap.phases[1]!.contacts, [{ effector: 'LeftHand', kind: 'grip', start: 0.3, end: 0.5 }]);
  assert.ok(phaseMap.phases[2]!.peakEvents.some(event => event.joint === 'RightHand'));
  assert.match(phaseMap.markerRule, /intent is not inferred/);
});

test('phase pose progression samples composed additive layers and root motion', () => {
  const track = (rotation: number, position = 0) => ({ joint: 'Root', keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [position, 0, 0] as [number, number, number], rotation: [0, 0, rotation] as [number, number, number] },
  ] });
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Composed phase pose', duration: 1, loop: false,
    tracks: [track(90, 1)],
    layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Additive accent', blendMode: 'Additive', weight: 0.5, enabled: true, tracks: [track(90)] }],
    rootMotion: track(0, 1), markers: [{ name: 'Windup', time: 0 }],
  };
  const phase = auditAnimation(recipe, 60).actionPhaseMap.phases[0]!;
  const root = phase.poseProgression.joints[0]!;
  assert.equal(phase.poseProgression.jointCount, 1);
  assert.equal(phase.poseProgression.omittedJointCount, 0);
  assert.ok(Math.abs(root.netRotationDegrees - 135) < 0.01);
  assert.ok(root.netTranslationStuds > 0);
  assert.ok(root.peakRotationFromEntryDegrees >= root.netRotationDegrees);
  assert.ok(root.evaluationCount >= 61);
  assert.match(phase.poseProgression.basis, /Composed local joint transforms/);
});

test('refinement targets diversify marked phases and identify overlapping declared contacts', () => {
  const track = (joint: string, start: number, end: number) => ({ joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: start, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: end, position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] });
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Phase-aware refinement', duration: 1, loop: false,
    tracks: [track('LeftHand', 0.05, 0.15), track('RightHand', 0.35, 0.45), track('RightFoot', 0.85, 0.95)],
    markers: [{ name: 'Windup', time: 0.25 }, { name: 'Impact', time: 0.6 }, { name: 'Recovery', time: 0.8 }],
    contacts: [{ effector: 'RightHand', kind: 'grip', start: 0.3, end: 0.55 }],
  };
  const targets = auditAnimation(recipe).refinementPlan.filter(target => target.signal === 'peakLocalPositionSpeed');
  assert.equal(targets.length, 3);
  assert.equal(new Set(targets.map(target => target.phaseContext.label)).size, 3);
  const gripTarget = targets.find(target => target.joint === 'RightHand')!;
  assert.deepEqual(gripTarget.overlappingContacts, [{ effector: 'RightHand', kind: 'grip', start: 0.3, end: 0.55 }]);
  assert.match(gripTarget.suggestedNextStep, /overlaps declared grip contact/);
});

test('acceleration and jerk refinement retain per-segment peaks across action phases', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Distributed curve peaks', duration: 1, loop: false,
    tracks: [{ joint: 'RightHand', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.2, position: [0, 0, 0], rotation: [0, 1, 0] },
      { time: 0.4, position: [0, 0, 0], rotation: [0, 3, 0] },
      { time: 0.6, position: [0, 0, 0], rotation: [0, 4, 0] },
      { time: 0.8, position: [0, 0, 0], rotation: [0, 10, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 11, 0] },
    ] }],
    markers: [{ name: 'WindUp', time: 0 }, { name: 'Action', time: 0.3 }, { name: 'FollowThrough', time: 0.7 }, { name: 'Recovery', time: 0.9 }],
  };
  const audit = auditAnimation(recipe, 120);
  for (const signal of ['peakLocalAngularAcceleration', 'peakLocalAngularJerk']) {
    const targets = audit.refinementPlan.filter(target => target.signal === signal);
    assert.equal(targets.length, 3);
    assert.deepEqual(targets.map(target => target.rankWithinSignal), [1, 2, 3]);
    assert.ok(new Set(targets.map(target => target.keySegment.startKeyIndex)).size > 1,
      `${signal} should retain multiple distinct key segments`);
    assert.ok(new Set(targets.map(target => `${target.phaseContext.label}:${target.phaseContext.startTime}`)).size > 1,
      `${signal} should retain peaks from multiple action phases`);
  }
});

test('boundary derivative targets expose their sample stencil and both adjoining key segments', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Boundary impulse', duration: 1, loop: false,
    tracks: [{ joint: 'RightHand', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.50005, position: [0, 0, 0], rotation: [0, 25, 0] },
      { time: 1, position: [0, 0, 0], rotation: [0, 25, 0] },
    ] }],
    markers: [{ name: 'WindUp', time: 0 }, { name: 'Action', time: 0.50005 }],
  };
  const target = auditAnimation(recipe, 60).refinementPlan.find(item => item.signal === 'peakLocalAngularAcceleration')!;
  assert.equal(target.measurementProvenance.derivativeOrder, 2);
  assert.deepEqual(target.measurementProvenance.sampleWindow, { startTime: 0.4839193548387097, endTime: 0.516715 });
  assert.deepEqual(target.measurementProvenance.crossedBoundaries, [
    { kind: 'authored_key', time: 0.50005, leftSegmentStartKeyIndex: 0, rightSegmentStartKeyIndex: 1 },
    { kind: 'phase_marker', time: 0.50005, leftSegmentStartKeyIndex: 0, rightSegmentStartKeyIndex: 1 },
  ]);
  assert.match(target.suggestedNextStep, /around 0\.50005s/i);
  assert.match(target.suggestedNextStep, /sample window crosses key boundary at 0\.50005s, phase boundary at 0\.50005s/i);
  assert.match(target.suggestedNextStep, /inspect both sides before editing/i);
});

test('ordinary event markers do not get misclassified as action-phase boundaries', () => {
  const recipe = animationPreset('slash', 'Event markers only', 1, 1);
  recipe.markers = [{ name: 'Footstep', time: 0.25 }, { name: 'Whoosh', time: 0.6 }];
  const phaseMap = auditAnimation(recipe).actionPhaseMap;
  assert.equal(phaseMap.source, 'unsegmented');
  assert.deepEqual(phaseMap.phases.map(phase => [phase.label, phase.startTime, phase.endTime]), [['unsegmented', 0, 1]]);
});

test('AI-authoring semantic marker vocabulary maps to analyzer phases and permits omitted phases', () => {
  const recipe = animationPreset('slash', 'AI-marked action', 1, 1);
  recipe.markers = [
    { name: 'Preparation', time: 0 },
    { name: 'Action', time: 0.25 },
    { name: 'FollowThrough', time: 0.6 },
    { name: 'Return', time: 0.8 },
  ];
  const phases = auditAnimation(recipe).actionPhaseMap.phases;
  assert.deepEqual(phases.map(phase => [phase.label, phase.startTime, phase.endTime]), [
    ['anticipation', 0, 0.25], ['main_action', 0.25, 0.6], ['follow_through', 0.6, 0.8], ['recovery', 0.8, 1],
  ]);

  recipe.markers = [{ name: 'Cast', time: 0 }, { name: 'Settle', time: 0.7 }];
  const compactPhases = auditAnimation(recipe).actionPhaseMap.phases;
  assert.deepEqual(compactPhases.map(phase => [phase.label, phase.startTime, phase.endTime]), [
    ['main_action', 0, 0.7], ['recovery', 0.7, 1],
  ]);
});

test('explicit event markers override phase-like names while explicit phase metadata can use event names', () => {
  const recipe = animationPreset('slash', 'Marker type disambiguation', 1, 1);
  recipe.markers = [
    { name: 'Anticipation', time: 0, phase: 'event' },
    { name: 'Impact', time: 0.25, phase: 'event' },
    { name: 'Release', time: 0.5, phase: 'main_action' },
    { name: 'Footstep', time: 0.75, phase: 'recovery' },
  ];
  const phaseMap = auditAnimation(recipe).actionPhaseMap;
  assert.equal(phaseMap.source, 'named_markers');
  assert.deepEqual(phaseMap.phases.map(phase => [phase.label, phase.startTime, phase.endTime]), [
    ['unclassified', 0, 0.5], ['main_action', 0.5, 0.75], ['recovery', 0.75, 1],
  ]);
  assert.deepEqual(phaseMap.phases[0]!.endingMarkers, ['Release']);

  recipe.markers = [{ name: 'Impact', time: 0.4, phase: 'event' }];
  assert.equal(auditAnimation(recipe).actionPhaseMap.source, 'unsegmented');
});

test('phase map retains endpoint markers and refuses arbitrary labels for conflicting boundaries', () => {
  const recipe = animationPreset('cast', 'Conflicting phase labels', 1, 1);
  recipe.markers = [
    { name: 'Windup', time: 0 },
    { name: 'Impact', time: 0.5 },
    { name: 'Recovery', time: 0.5 },
    { name: 'Settle', time: 1 },
  ];
  const phases = auditAnimation(recipe).actionPhaseMap.phases;
  assert.equal(phases[0]!.label, 'anticipation');
  assert.deepEqual(phases[0]!.boundaryMarkers, ['Windup']);
  assert.deepEqual(phases[0]!.endingMarkers, ['Impact', 'Recovery']);
  assert.equal(phases[1]!.label, 'unclassified');
  assert.deepEqual(phases[1]!.boundaryLabels, ['main_action', 'recovery']);
  assert.deepEqual(phases[1]!.endingMarkers, ['Settle']);
});

test('phase-map detail limit bounds returned channels and peak events while preserving total counts', () => {
  const recipe = animationPreset('walk', 'Compact phase evidence', 2, 1);
  const map = auditAnimation(recipe, 60, 1).actionPhaseMap;
  assert.equal(map.detailLimitPerPhase, 1);
  const phase = map.phases[0]!;
  assert.ok(phase.activeChannelCount > phase.activeChannels.length);
  assert.equal(phase.activeChannels.length, 1);
  assert.ok(phase.omittedActiveChannelCount > 0);
  assert.ok(phase.peakEvents.length <= 2);
  assert.ok(phase.omittedPeakEventCount > 0);
});

test('animation audit keeps layered and root-motion evidence separate and identifies layer blend state', () => {
  const track = (joint: string) => ({ joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [0, 1, 0] as [number, number, number], rotation: [0, 20, 0] as [number, number, number] },
  ] });
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Layered clip', duration: 1, loop: false,
    tracks: [track('UpperTorso')],
    layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Windup', blendMode: 'Additive', weight: 0.5, enabled: false, tracks: [track('RightUpperArm')] }],
    rootMotion: track('HumanoidRootPart'), markers: [],
  };
  const result = auditAnimation(recipe);
  assert.deepEqual(result.trackMotion.map(metric => ({ channel: metric.channel, joint: metric.joint, layerId: metric.layerId, layerName: metric.layerName, enabled: metric.enabled, blendMode: metric.blendMode, weight: metric.weight })), [
    { channel: 'rootMotion', joint: 'HumanoidRootPart', layerId: undefined, layerName: undefined, enabled: undefined, blendMode: undefined, weight: undefined },
    { channel: 'layer', joint: 'RightUpperArm', layerId: '248b405e-cbd4-4c8e-a644-c76bb57277ad', layerName: 'Windup', enabled: false, blendMode: 'Additive', weight: 0.5 },
    { channel: 'base', joint: 'UpperTorso', layerId: undefined, layerName: undefined, enabled: undefined, blendMode: undefined, weight: undefined },
  ]);
  assert.deepEqual({ layerTracks: result.summary.layerTracks, rootMotionTracks: result.summary.rootMotionTracks, analyzedTracks: result.summary.analyzedTracks, analyzedKeys: result.summary.analyzedKeys }, { layerTracks: 1, rootMotionTracks: 1, analyzedTracks: 3, analyzedKeys: 6 });
  assert.ok(result.advisories.some(item => item.id === 'sparse-tracks' && item.detail.includes('layer Windup, disabled')));
  const rootTarget = result.refinementPlan.find(target => target.channel === 'rootMotion');
  assert.deepEqual(rootTarget?.patchFocus.availableOperations, ['root_motion_set']);
  assert.deepEqual(rootTarget?.repairOptions.map(option => option.operation), ['root_motion_set']);
  assert.match(rootTarget?.repairOptions[0]?.risk ?? '', /entire root-motion channel/i);
  assert.match(rootTarget?.suggestedNextStep ?? '', /whole-track replacement/i);
});

test('animation audit normalizes velocity change by the actual spacing of uneven keys', () => {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: 'Uneven timing', duration: 1.25, loop: false,
    tracks: [{ joint: 'RightFoot', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.25, position: [1, 0, 0], rotation: [0, 0, 0] },
      { time: 1.25, position: [3, 0, 0], rotation: [0, 0, 0] },
    ] }], markers: [],
  };
  const metric = auditAnimation(recipe).trackMotion[0]!;
  assert.deepEqual(metric.peakLocalPositionSpeed, { unitsPerSecond: 4, startTime: 0, endTime: 0.25, startKeyIndex: 0, endKeyIndex: 1 });
  assert.deepEqual(metric.largestLocalPositionVelocityChange, { unitsPerSecondSquared: 3.2, time: 0.25, keyIndex: 1 });
});
