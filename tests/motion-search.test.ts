import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from '../src/library.js';
import { vfxPreset, type AnimationRecipe } from '../src/recipes.js';
import type { RetargetProfile } from '../src/retarget.js';
import { assessAnimationRetargetCompatibility, buildAnimationRetargetHandoff, rankMotionMatches } from '../src/motion-search.js';

function track(joint: string, duration: number, rotationEnd = 90) {
  return { joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: duration, position: [1, 0, 0] as [number, number, number], rotation: [0, 0, rotationEnd] as [number, number, number] },
  ] };
}

function asset(id: string, duration: number, options: { layer?: boolean; rightHand?: boolean; extraHead?: boolean } = {}): Asset {
  const recipe: AnimationRecipe = {
    kind: 'animation', name: id, duration, loop: false, markers: [],
    tracks: [track('Root', duration), ...(options.rightHand === false ? [] : [track('RightHand', duration)])],
    ...(options.layer ? { layers: [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Accent', blendMode: 'Additive' as const, weight: 0.5, enabled: true,
      tracks: [track('RightHand', duration)] }] } : {}),
    ...(options.extraHead ? { tracks: [track('Root', duration), ...(options.rightHand === false ? [] : [track('RightHand', duration)]), track('Head', duration)] } : {}),
  };
  return { id, createdAt: '2026-10-07T00:00:00.000Z', recipe };
}

function rigProfile(rigId: string, rigName: string, rigType: RetargetProfile['rigType'] = 'R15', rightBasis: [number, number, number, number] = [0, 0, 0, 1]): RetargetProfile {
  return { version: 1, rigId, rigName, rigType, rigSignature: `${rigName}|Root>RightHand`, joints: [
    { name: 'Root', parent: '', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 },
    { name: 'RightHand', parent: 'Root', driven: true, basis: rightBasis, segmentLength: 1 },
  ] };
}

test('motion search ranks equivalent normalized-progress clips above changed motion and reports duration separately', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1, { layer: true });
  const sameShapeLonger = asset('22222222-2222-4222-8222-222222222222', 2, { layer: true });
  const differentPose = asset('33333333-3333-4333-8333-333333333333', 1, { layer: false });
  const matches = rankMotionMatches(query, [differentPose, query, sameShapeLonger], 10);
  assert.deepEqual(matches.map(match => match.assetId), [sameShapeLonger.id, differentPose.id]);
  assert.equal(matches[0]!.motionShapeSimilarityPercent, 100);
  assert.equal(matches[0]!.durationRatio, 2);
  assert.equal(matches[0]!.durationDifferenceSeconds, 1);
  assert.equal(matches[0]!.evidenceQuality, 'limited');
  assert.ok(matches[0]!.evidenceLimitations.includes('rig_provenance_unavailable'));
  assert.ok(matches[1]!.motionShapeSimilarityPercent < 100);
  assert.equal(matches[0]!.matchedJointCount, 2);
});

test('motion search samples brief authored peaks missed by the uniform grid and reports time coverage', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  query.recipe.tracks = [{ joint: 'Root', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.503, position: [10, 0, 0], rotation: [0, 0, 0] },
    { time: 0.504, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  candidate.recipe.tracks = [{ joint: 'Root', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.ok(match.motionShapeSimilarityPercent < 100);
  assert.ok((match.positionRmseStuds ?? 0) > 0);
  assert.equal(match.authoredProgressPointCount, 4);
  assert.equal(match.sampledAuthoredProgressPointCount, 4);
  assert.equal(match.omittedAuthoredProgressPointCount, 0);
  assert.equal(match.sampledProgressPointCount, 35);
});

test('motion search bounds authored-time refinement and reports omitted authored progress points', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  const makeKeys = (offset: number) => Array.from({ length: 128 }, (_, index) => ({
    time: index === 0 ? 0 : index === 127 ? 1 : Math.min(0.999, (index + offset) / 128),
    position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
  }));
  query.recipe.tracks = [{ joint: 'Root', keys: makeKeys(0) }];
  candidate.recipe.tracks = [{ joint: 'Root', keys: makeKeys(0.5) }];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.ok(match.sampledProgressPointCount <= 129);
  assert.ok(match.omittedAuthoredProgressPointCount > 0);
  assert.ok(match.evidenceLimitations.includes('authored_pose_samples_omitted'));
  assert.equal(match.authoredProgressPointCount, match.sampledAuthoredProgressPointCount + match.omittedAuthoredProgressPointCount);
});

test('motion search prioritizes pose key times over marker/contact times when the sample cap is reached', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  query.recipe.tracks = [{ joint: 'Root', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 0.503, position: [10, 0, 0], rotation: [0, 0, 0] },
    { time: 0.504, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  candidate.recipe.tracks = [{ joint: 'Root', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }];
  query.recipe.markers = Array.from({ length: 100 }, (_, index) => ({ name: `QueryMarker${index}`, time: (index + 0.2) / 101 }));
  candidate.recipe.markers = Array.from({ length: 100 }, (_, index) => ({ name: `CandidateMarker${index}`, time: (index + 0.6) / 101 }));
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.ok(match.sampledProgressPointCount <= 129);
  assert.ok(match.omittedAuthoredProgressPointCount > 0);
  assert.ok(match.sampledAuthoredProgressPointCount >= 4);
  assert.equal(match.comparedKeyProgressPointCount, 4);
  assert.equal(match.sampledComparedKeyProgressPointCount, 4);
  assert.equal(match.omittedComparedKeyProgressPointCount, 0);
  assert.ok(match.omittedEventProgressPointCount > 0);
  assert.ok(match.motionShapeSimilarityPercent < 100);
  assert.equal(match.evidenceQuality, 'limited');
  assert.ok(match.evidenceLimitations.includes('event_samples_omitted'));
});

test('motion search excludes disabled and zero-weight layer-only joints from composed-pose score and key sampling', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  const inactiveTrack = (joint: string, time: number) => ({ joint, keys: [
    { time: 0, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time, position: [50, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
    { time: 1, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  ] });
  query.recipe.layers = [
    { id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Disabled', blendMode: 'Additive', weight: 1, enabled: false, tracks: [inactiveTrack('DisabledOnly', 0.503)] },
    { id: '7f4a7c8b-4a39-4e31-9a0d-2b54bc0f31a1', name: 'Muted', blendMode: 'Override', weight: 0, enabled: true, tracks: [inactiveTrack('MutedOnly', 0.607)] },
  ];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.motionShapeSimilarityPercent, 100);
  assert.equal(match.queryJointCount, 2);
  assert.deepEqual(match.queryOnlyJoints, []);
  assert.equal(match.comparedKeyProgressPointCount, 2);
  assert.equal(match.sampledProgressPointCount, 33);
});

test('motion search penalizes missing query joints and returns coverage evidence', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1, { layer: true });
  if (query.recipe.kind !== 'animation') throw new Error('Expected animation test fixture.');
  query.recipe.tracks.push(track('Head', query.recipe.duration));
  const missingHand = asset('22222222-2222-4222-8222-222222222222', 1, { layer: false, rightHand: false });
  const [match] = rankMotionMatches(query, [missingHand]);
  assert.ok(match);
  assert.equal(match.matchedJointCount, 1);
  assert.equal(match.jointCoverageFraction, 1 / 3);
  assert.deepEqual(match.queryOnlyJoints, ['Head', 'RightHand']);
  assert.deepEqual(match.candidateOnlyJoints, []);
  assert.ok(match.motionShapeSimilarityPercent < 100);
  assert.equal(match.evidenceQuality, 'weak');
  assert.ok(match.evidenceLimitations.includes('incomplete_joint_coverage'));
});

test('motion search results are stable across candidate and track ordering', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1, { layer: true });
  const queryReordered = structuredClone(query);
  if (queryReordered.recipe.kind === 'animation') queryReordered.recipe.tracks.reverse();
  const first = asset('22222222-2222-4222-8222-222222222222', 1, { layer: true });
  const second = asset('33333333-3333-4333-8333-333333333333', 1, { layer: true });
  first.recipe.name = 'Equivalent';
  second.recipe.name = 'Equivalent';
  if (second.recipe.kind === 'animation') second.recipe.tracks.reverse();

  const ordered = rankMotionMatches(query, [first, second]);
  const permuted = rankMotionMatches(queryReordered, [second, first]);
  assert.deepEqual(permuted, ordered);
});

test('motion search validates the query and requested result limit', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  assert.throws(() => rankMotionMatches({ ...query, recipe: vfxPreset('impact', 'Not an animation') }, []), /requires an animation query/);
  assert.throws(() => rankMotionMatches(query, [], 0), /limit must be an integer/);
});

test('motion search labels complete same-profile evidence as strong without implying probability', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  query.sourceRigProfile = rigProfile('33333333-3333-4333-8333-333333333333', 'Shared rig');
  candidate.sourceRigProfile = { ...query.sourceRigProfile, rigId: '44444444-4444-4444-8444-444444444444' };
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.evidenceQuality, 'strong');
  assert.deepEqual(match.evidenceLimitations, []);
  assert.equal(match.unmappedActiveCandidateJoints, null, 'same-profile comparison does not perform cross-rig unmapped classification');
  assert.equal(match.omittedUnmappedActiveJointCount, null);
});

test('motion search reports normalized marker and contact alignment separately from pose shape', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 2);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 4);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  query.recipe.markers = [{ name: 'Release', time: 1, value: 'hit', phase: 'main_action' }];
  candidate.recipe.markers = [{ name: 'Release', time: 2, value: 'hit', phase: 'main_action' }];
  query.recipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.5, end: 1.5 }];
  candidate.recipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 1, end: 3 }];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.motionShapeSimilarityPercent, 100);
  assert.equal(match.eventAlignmentPercent, 100);
  assert.equal(match.markerAlignmentPercent, 100);
  assert.equal(match.contactAlignmentPercent, 100);
  assert.equal(match.queryMarkerCount, 1);
  assert.equal(match.candidateContactCount, 1);

  candidate.recipe.markers[0]!.time = 4;
  candidate.recipe.contacts[0]!.end = 2;
  const [misaligned] = rankMotionMatches(query, [candidate]);
  assert.ok(misaligned);
  assert.equal(misaligned.motionShapeSimilarityPercent, 100);
  assert.equal(misaligned.markerAlignmentPercent, 50);
  assert.equal(misaligned.contactAlignmentPercent, 50);
  assert.equal(misaligned.eventAlignmentPercent, 50);
});

test('motion search reports absent declared events as null rather than perfect alignment', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.eventAlignmentPercent, null);
  assert.equal(match.markerAlignmentPercent, null);
  assert.equal(match.contactAlignmentPercent, null);
});

test('motion search penalizes mismatched event identities once and keeps alignment within zero to one hundred', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  query.recipe.markers = [{ name: 'Release', time: 0.5 }, { name: 'Impact', time: 0.8 }];
  candidate.recipe.markers = [{ name: 'Start', time: 0.2 }, { name: 'Recover', time: 0.9 }];
  query.recipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.1, end: 0.4 }];
  candidate.recipe.contacts = [{ effector: 'LeftHand', kind: 'grip', start: 0.1, end: 0.4 }];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.markerAlignmentPercent, 0);
  assert.equal(match.contactAlignmentPercent, 0);
  assert.equal(match.eventAlignmentPercent, 0);
  for (const score of [match.markerAlignmentPercent, match.contactAlignmentPercent, match.eventAlignmentPercent]) {
    assert.ok(score !== null && score >= 0 && score <= 100);
  }
});

test('motion search event alignment is invariant to repeated marker and contact input order', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 2);
  const candidate = asset('22222222-2222-4222-8222-222222222222', 3);
  if (query.recipe.kind !== 'animation' || candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixtures.');
  query.recipe.markers = [
    { name: 'Footstep', time: 1.5, value: 'left', phase: 'event' },
    { name: 'Footstep', time: 0.5, value: 'left', phase: 'event' },
    { name: 'Release', time: 1, phase: 'main_action' },
  ];
  candidate.recipe.markers = [
    { name: 'Release', time: 1.5, phase: 'main_action' },
    { name: 'Footstep', time: 2.25, value: 'left', phase: 'event' },
    { name: 'Footstep', time: 0.75, value: 'left', phase: 'event' },
  ];
  query.recipe.contacts = [
    { effector: 'LeftFoot', kind: 'support', start: 1, end: 1.5 },
    { effector: 'LeftFoot', kind: 'support', start: 0, end: 0.5 },
  ];
  candidate.recipe.contacts = [
    { effector: 'LeftFoot', kind: 'support', start: 1.5, end: 2.25 },
    { effector: 'LeftFoot', kind: 'support', start: 0, end: 0.75 },
  ];
  const baseline = rankMotionMatches(query, [candidate]);
  query.recipe.markers.reverse();
  candidate.recipe.markers.reverse();
  query.recipe.contacts.reverse();
  candidate.recipe.contacts.reverse();
  assert.deepEqual(rankMotionMatches(query, [candidate]), baseline);
});

test('retarget readiness reuses the conservative rig-map advisor and stays unknown without provenance', () => {
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1, { layer: true });
  const targetProfile = rigProfile('33333333-3333-4333-8333-333333333333', 'Target');
  const unknown = assessAnimationRetargetCompatibility(candidate, targetProfile);
  assert.equal(unknown.status, 'unknown');
  candidate.sourceRigProfile = rigProfile('44444444-4444-4444-8444-444444444444', 'Source');
  const compatible = assessAnimationRetargetCompatibility(candidate, targetProfile);
  assert.equal(compatible.status, 'strong_mapping_available');
  assert.equal(compatible.mappingCoverageFraction, 1);
  assert.deepEqual(compatible.suggestedJointMap, { Root: 'Root', RightHand: 'RightHand' });
  assert.deepEqual(buildAnimationRetargetHandoff(candidate, targetProfile, 'session-a', targetProfile.rigId), {
    status: 'preview_ready', tool: 'motion_animation_retarget_preview',
    arguments: { assetId: candidate.id, sessionId: 'session-a', targetRigId: targetProfile.rigId,
      jointMap: { Root: 'Root', RightHand: 'RightHand' }, allowPartial: false, scaleTranslation: true },
    reason: 'All authored joints have a strong one-to-one suggested mapping. Review the read-only preview recipe and diagnostics before any commit.',
  });
  candidate.sourceRigProfile = undefined;
  assert.equal(buildAnimationRetargetHandoff(candidate, targetProfile, 'session-a', targetProfile.rigId).status, 'source_profile_required');
});

test('motion search retargets cross-rig candidates into the query basis before measuring shape', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  query.sourceRigProfile = rigProfile('33333333-3333-4333-8333-333333333333', 'Query R15');
  const queryHand = query.recipe.kind === 'animation' ? query.recipe.tracks.find(item => item.joint === 'RightHand')! : undefined;
  assert.ok(queryHand);
  queryHand.keys[1]!.position = [1, 0, 0];
  queryHand.keys[1]!.rotation = [0, 90, 0];

  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  candidate.sourceRigProfile = rigProfile('44444444-4444-4444-8444-444444444444', 'Source R6', 'R6', [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  const sourceHand = candidate.recipe.kind === 'animation' ? candidate.recipe.tracks.find(item => item.joint === 'RightHand')! : undefined;
  assert.ok(sourceHand);
  sourceHand.keys[1]!.position = [0, -1, 0];
  sourceHand.keys[1]!.rotation = [90, 0, 0];

  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.comparisonMode, 'retargeted_to_query_rig');
  assert.equal(match.motionShapeSimilarityPercent, 100);
  assert.equal(match.retargetedJointCoverageFraction, 1);
  assert.deepEqual(match.mappedJointPairs, [{ source: 'RightHand', target: 'RightHand' }, { source: 'Root', target: 'Root' }]);
});

test('motion search grades retarget coverage on active contributors but still reports unmapped inactive authored tracks', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  query.sourceRigProfile = rigProfile('33333333-3333-4333-8333-333333333333', 'Target R15');
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  const sourceProfile = rigProfile('44444444-4444-4444-8444-444444444444', 'Source R6', 'R6');
  candidate.sourceRigProfile = {
    ...sourceProfile,
    rigSignature: `${sourceProfile.rigSignature}|InactiveOnly`,
    joints: [...sourceProfile.joints, { name: 'InactiveOnly', parent: 'Root', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 }],
  };
  if (candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixture.');
  candidate.recipe.layers = [{ id: '248b405e-cbd4-4c8e-a644-c76bb57277ad', name: 'Dormant', blendMode: 'Additive', weight: 1, enabled: false,
    tracks: [track('InactiveOnly', 1)] }];
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.comparisonMode, 'retargeted_to_query_rig');
  assert.equal(match.motionShapeSimilarityPercent, 100);
  assert.equal(match.retargetedJointCoverageFraction, 1);
  assert.equal(match.retargetedAuthoredJointCoverageFraction, 2 / 3);
  assert.deepEqual(match.unmappedCandidateJoints, ['InactiveOnly']);
  assert.deepEqual(match.unmappedActiveCandidateJoints, []);
  assert.equal(match.omittedUnmappedActiveJointCount, 0);
  assert.deepEqual(match.unmappedInactiveCandidateJoints, ['InactiveOnly']);
  assert.equal(match.omittedUnmappedInactiveJointCount, 0);
  assert.equal(match.evidenceQuality, 'strong');
  assert.deepEqual(match.evidenceLimitations, []);
  assert.equal(match.mappingNextStep, undefined);
});

test('motion search gives a safe next step when active cross-rig joints are unmapped', () => {
  const query = asset('11111111-1111-4111-8111-111111111111', 1);
  query.sourceRigProfile = rigProfile('33333333-3333-4333-8333-333333333333', 'Target R15');
  const candidate = asset('22222222-2222-4222-8222-222222222222', 1);
  const sourceProfile = rigProfile('44444444-4444-4444-8444-444444444444', 'Source R6', 'R6');
  candidate.sourceRigProfile = {
    ...sourceProfile,
    rigSignature: `${sourceProfile.rigSignature}|UnmappedActive`,
    joints: [...sourceProfile.joints, { name: 'UnmappedActive', parent: 'Root', driven: true, basis: [0, 0, 0, 1], segmentLength: 1 }],
  };
  if (candidate.recipe.kind !== 'animation') throw new Error('Expected animation test fixture.');
  candidate.recipe.tracks.push(track('UnmappedActive', 1));
  const [match] = rankMotionMatches(query, [candidate]);
  assert.ok(match);
  assert.equal(match.retargetedJointCoverageFraction, 2 / 3);
  assert.ok(match.evidenceLimitations.includes('retarget_mapping_incomplete'));
  assert.match(match.mappingNextStep ?? '', /motion_animation_suggest_joint_map/);
  assert.match(match.mappingNextStep ?? '', /provisional/);
  assert.deepEqual(match.unmappedCandidateJoints, ['UnmappedActive']);
  assert.deepEqual(match.unmappedActiveCandidateJoints, ['UnmappedActive']);
  assert.equal(match.omittedUnmappedActiveJointCount, 0);
  assert.deepEqual(match.unmappedInactiveCandidateJoints, []);
  const handoff = buildAnimationRetargetHandoff(candidate, query.sourceRigProfile!, 'session-b', query.sourceRigProfile!.rigId);
  assert.equal(handoff.status, 'mapping_review_required');
  assert.equal(handoff.tool, 'motion_animation_suggest_joint_map');
  assert.deepEqual(handoff.arguments, { assetId: candidate.id, sessionId: 'session-b', targetRigId: query.sourceRigProfile!.rigId });
});
