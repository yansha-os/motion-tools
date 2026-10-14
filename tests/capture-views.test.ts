import test from 'node:test';
import assert from 'node:assert/strict';
import { auditAnimation } from '../src/animation-quality.js';
import { animationPreset } from '../src/recipes.js';
import { candidateComparisonPlanRequestSchema, captureFramesSchema, captureRetryFramesSchema, capturePlanRequestSchema, capturePlanResultSchema, planAnimationCaptures, planCandidateComparisonCaptures, validateCaptureFrames } from '../src/capture-views.js';

test('multi-view capture sets require 2–8 unique, in-range named view/time pairs', () => {
  const frames = captureFramesSchema.parse([
    { view: 'front', time: 0 },
    { view: 'three_quarter', time: 0.75 },
    { view: 'overhead', time: 1 },
    { view: 'back', time: 1.5 },
  ]);
  validateCaptureFrames(frames, 2);
  assert.throws(() => captureFramesSchema.parse([{ view: 'front', time: 0 }]), /at least 2/);
  assert.deepEqual(captureRetryFramesSchema.parse([{ view: 'side', time: 0.5, focusJoint: 'RightHand' }]),
    [{ view: 'side', time: 0.5, focusJoint: 'RightHand' }], 'a one-frame batch must be valid for a targeted retry');
  assert.throws(() => captureRetryFramesSchema.parse([]), /at least 1/);
  assert.throws(() => captureFramesSchema.parse([{ view: 'front', time: 0 }, { view: 'front', time: 0 }]), /duplicate view\/time pair/);
  assert.throws(() => captureFramesSchema.parse([{ view: 'diagonal', time: 0 }, { view: 'side', time: 0 }]), /Invalid enum value/);
  assert.throws(() => validateCaptureFrames(frames, 1), /inside the animation/);
});

test('capture planner returns deterministic, diverse moments and paired review views', () => {
  const recipe = animationPreset('cast', 'Capture planner cast', 2, 1);
  recipe.markers = [{ name: 'Windup', time: 0.25 }, { name: 'Release', time: 1.5 }, { name: 'Recovery', time: 1.75 }];
  recipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.8, end: 1.4 }];
  const request = capturePlanRequestSchema.parse({ views: ['front', 'side'], maxFrames: 8 });
  const audit = auditAnimation(recipe);
  const planned = planAnimationCaptures(recipe, audit, request);
  const retried = planAnimationCaptures(recipe, audit, request);
  assert.deepEqual(retried, planned, 'the same recipe/evidence produces the same capture schedule');
  assert.equal(planned.frames.length, 8);
  assert.deepEqual([...new Set(planned.frames.map(frame => frame.view))], ['front', 'side']);
  assert.ok(planned.frames.some(frame => frame.time === 0));
  assert.ok(planned.frames.some(frame => frame.time === recipe.duration));
  for (const moment of planned.moments) assert.deepEqual(planned.frames.filter(frame => frame.time === moment.time).map(frame => frame.view), ['front', 'side']);
  assert.ok(planned.moments.some(moment => moment.reasons.some(reason => reason.startsWith('contact_'))));
  assert.ok(planned.moments.some(moment => moment.reasons.some(reason => reason.startsWith('measured_motion_peak:'))));
  assert.throws(() => capturePlanRequestSchema.parse({ views: ['front', 'side', 'back', 'overhead'], maxFrames: 7 }), /at least two distinct animation moments/i);
  assert.throws(() => capturePlanRequestSchema.parse({ views: ['front', 'front'], maxFrames: 8 }), /must be unique/i);
  assert.throws(() => capturePlanRequestSchema.parse({ views: ['side'], maxFrames: 8, focusJoints: ['RightHand', 'righthand'] }), /focused joint names must be unique/i);
});

test('capture planner reserves explicit intent times before optional close-ups and reports any omitted targets', () => {
  const recipe = animationPreset('cast', 'Intent-time capture plan', 2, 1);
  const joint = recipe.tracks[0]!.joint;
  const planned = capturePlanResultSchema.parse(planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({
    views: ['front'], maxFrames: 4, focusJoints: [joint], priorityTimes: [0.7, 1.3],
  })));
  assert.deepEqual(planned.moments.map(moment => moment.time), [0, 0.7, 1.3, 2]);
  assert.deepEqual(planned.priorityTimeCoverage, { requested: [0.7, 1.3], scheduled: [0.7, 1.3], omitted: [], followUpBatches: [] });
  assert.ok(planned.moments.filter(moment => moment.time === 0.7 || moment.time === 1.3)
    .every(moment => moment.reasons.includes('requested_review_time')));
  assert.deepEqual(planned.focusJointCoverage, { requested: [joint], scheduled: [], omitted: [joint],
    omittedDetails: [{ joint, reason: 'frame_budget' }] }, 'explicit intent evidence takes precedence over optional close-ups');

  const tight = capturePlanResultSchema.parse(planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({
    views: ['front'], maxFrames: 3, priorityTimes: [0.7, 1.3],
  })));
  assert.deepEqual(tight.priorityTimeCoverage, { requested: [0.7, 1.3], scheduled: [0.7], omitted: [1.3],
    followUpBatches: [[{ time: 1.3, view: 'front' }]] });
  assert.throws(() => capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 4, priorityTimes: [0.7, 0.7] }), /priority review times must be unique/i);
  assert.throws(() => planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({
    views: ['front'], maxFrames: 4, priorityTimes: [2.1],
  })), /inside the animation duration/i);

  const orderedIntentTimes = Array.from({ length: 31 }, (_, index) => (index + 1) / 16).reverse();
  const denseIntentPlan = capturePlanResultSchema.parse(planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({
    views: ['front'], maxFrames: 8, priorityTimes: orderedIntentTimes,
  })));
  assert.deepEqual(denseIntentPlan.priorityTimeCoverage.requested, orderedIntentTimes);
  assert.deepEqual(denseIntentPlan.priorityTimeCoverage.scheduled, orderedIntentTimes.slice(0, 6),
    'all 31 internal boundaries and midpoints from a 16-phase blueprint use AI-provided importance order, with six fitting the single-view budget');
  assert.deepEqual(denseIntentPlan.priorityTimeCoverage.omitted, orderedIntentTimes.slice(6),
    'every midpoint that cannot fit remains explicitly visible for later capture batches');
  assert.deepEqual(denseIntentPlan.priorityTimeCoverage.followUpBatches.flat().map(frame => frame.time), orderedIntentTimes.slice(6));
  assert.ok(denseIntentPlan.priorityTimeCoverage.followUpBatches.every(batch => batch.length > 0 && batch.length <= 8
    && batch.every(frame => frame.view === 'front')), 'follow-up frames preserve the planned view and MCP batch limit');
  assert.throws(() => capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 8,
    priorityTimes: [...orderedIntentTimes, 1.95] }), /at most 31/);
});

test('capture planner prioritizes composed motion and ignores invisible disabled or zero-weight layer peaks', () => {
  const recipe = animationPreset('cast', 'Composed capture planner case', 2, 1);
  const layerId = '248b405e-cbd4-4c8e-a644-c76bb57277ad';
  recipe.layers = [{ id: layerId, name: 'Invisible flourish', blendMode: 'Additive', weight: 1, enabled: false,
    tracks: [{ joint: 'HiddenJoint', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 0.5, position: [0, 0, 0], rotation: [300, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [-300, 0, 0] },
      { time: 1.5, position: [0, 0, 0], rotation: [300, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] }];
  const audit = auditAnimation(recipe);
  assert.ok(audit.refinementPlan.some(target => target.channel === 'layer' && target.layerId === layerId),
    'the raw track audit should still disclose the authored disabled-layer peak');
  const planned = planAnimationCaptures(recipe, audit, capturePlanRequestSchema.parse({ views: ['front', 'side'], maxFrames: 8 }));
  assert.ok(planned.moments.some(moment => moment.reasons.some(reason => reason.startsWith('composed_pose_peak_'))),
    'capture planning should use composed pose extrema from the active base/layer/root stack');
  assert.equal(planned.moments.some(moment => moment.reasons.some(reason => reason.includes('HiddenJoint'))), false,
    'disabled-only motion must not steer visual capture timing');
});

test('capture planner spreads a tight interior storyboard across distinct moving joints', () => {
  const recipe = animationPreset('cast', 'Cross-joint visual coverage', 2, 1);
  recipe.markers = [];
  recipe.contacts = [];
  const times = [0, 0.5, 1, 1.5, 2];
  recipe.tracks = [
    { joint: 'ReviewJointA', keys: times.map((time, index) => ({ time, position: [0, 0, 0] as [number, number, number],
      rotation: [[0, 0, 0], [60, 0, 0], [-60, 0, 0], [60, 0, 0], [0, 0, 0]][index]! as [number, number, number] })) },
    { joint: 'ReviewJointB', keys: times.map((time, index) => ({ time, position: [0, 0, 0] as [number, number, number],
      rotation: [[0, 0, 0], [0, 0, 0], [0, 80, 0], [0, 0, 0], [0, 0, 0]][index]! as [number, number, number] })) },
  ];
  const audit = auditAnimation(recipe);
  audit.actionPhaseMap.phases.length = 0;
  const plan = capturePlanResultSchema.parse(planAnimationCaptures(recipe, audit,
    capturePlanRequestSchema.parse({ views: ['side'], maxFrames: 4 })));
  const selectedPeakJoints = new Set(plan.moments.flatMap(moment => moment.reasons
    .filter(reason => reason.startsWith('measured_motion_peak:'))
    .map(reason => reason.split(':').at(-2)!)));
  assert.ok(selectedPeakJoints.has('ReviewJointA'));
  assert.ok(selectedPeakJoints.has('ReviewJointB'),
    `the two interior frames should expose both moving joints; got ${[...selectedPeakJoints].join(', ')}`);
  assert.equal(plan.frames.length, 4, 'joint diversity must not exceed the original screenshot budget');
});

test('capture planner reserves exact joint close-ups without sacrificing whole-rig endpoints or exceeding budget', () => {
  const recipe = animationPreset('cast', 'Focused capture planner case', 2, 1);
  recipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.6, end: 1.2 }];
  const jointNames = recipe.tracks.slice(0, 2).map(track => track.joint);
  const audit = auditAnimation(recipe);
  const request = capturePlanRequestSchema.parse({ views: ['front', 'side'], maxFrames: 8, focusJoints: jointNames });
  const planned = capturePlanResultSchema.parse(planAnimationCaptures(recipe, audit, request));
  assert.ok(planned.frames.length <= request.maxFrames);
  assert.deepEqual(planned.focusJointCoverage, { requested: jointNames, scheduled: jointNames, omitted: [], omittedDetails: [] });
  assert.ok(planned.frames.some(frame => frame.focusJoint === jointNames[0]));
  assert.ok(planned.frames.some(frame => frame.focusJoint === jointNames[1]));
  const firstCloseup = planned.frames.find(frame => frame.focusJoint === jointNames[0]);
  const firstJointCueTimes = audit.refinementPlan.filter(target => target.joint === jointNames[0]
    && (target.channel !== 'layer' || recipe.layers?.some(layer => layer.id === target.layerId && layer.enabled && layer.weight > 0)))
    .map(target => target.eventTime);
  if (firstJointCueTimes.length) assert.ok(firstJointCueTimes.includes(firstCloseup!.time), 'close-ups should align to the target joint’s own measured cue when one exists');
  for (const endpoint of [0, recipe.duration]) {
    assert.deepEqual(planned.frames.filter(frame => frame.time === endpoint && !frame.focusJoint).map(frame => frame.view), ['front', 'side']);
  }
  assert.ok(planned.frames.filter(frame => !frame.focusJoint).length >= 4, 'full-rig context is reserved before close-ups');
  assert.ok(planned.moments.some(moment => moment.reasons.some(reason => reason.startsWith('focused_closeup:'))));
});

test('capture focus uses visible active channels and explains every omitted close-up', () => {
  const recipe = animationPreset('cast', 'Focus omission diagnostics', 2, 1);
  const visibleJoints = recipe.tracks.slice(0, 4).map(track => track.joint);
  recipe.layers = [{ id: '610b96f6-3a53-4827-b0db-519a5ba641dc', name: 'Disabled-only motion', blendMode: 'Additive', weight: 1, enabled: false,
    tracks: [{ joint: 'InactiveOnly', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [45, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }] }];
  const budgetPlan = planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 4, focusJoints: visibleJoints }));
  assert.deepEqual(budgetPlan.focusJointCoverage.scheduled, visibleJoints.slice(0, 2));
  assert.deepEqual(budgetPlan.focusJointCoverage.omitted, visibleJoints.slice(2));
  assert.deepEqual(budgetPlan.focusJointCoverage.omittedDetails, visibleJoints.slice(2).map(joint => ({ joint, reason: 'frame_budget' })));

  const noCapacityPlan = planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 2,
    focusJoints: ['InactiveOnly', 'MissingJoint'] }));
  assert.deepEqual(noCapacityPlan.focusJointCoverage.omittedDetails, [
    { joint: 'InactiveOnly', reason: 'inactive_channel' },
    { joint: 'MissingJoint', reason: 'not_in_recipe' },
  ], 'inactive-only channels are distinguished from channels absent from the recipe even when no close-up budget remains');

  recipe.rootMotion = { joint: 'RootTravel', keys: [
    { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 1, position: [2, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [4, 0, 0], rotation: [0, 0, 0] },
  ] };
  const rootAudit = auditAnimation(recipe);
  const rootPlan = planAnimationCaptures(recipe, rootAudit, capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 4, focusJoints: ['RootTravel'] }));
  assert.deepEqual(rootPlan.focusJointCoverage, { requested: ['RootTravel'], scheduled: ['RootTravel'], omitted: [], omittedDetails: [] });
  const rootFocusedFrame = rootPlan.frames.find(frame => frame.focusJoint === 'RootTravel');
  assert.ok(rootFocusedFrame && ([1, ...rootAudit.refinementPlan.filter(target => target.joint === 'RootTravel').map(target => target.eventTime)].includes(rootFocusedFrame.time)),
    'root-motion close-ups align to an authored key or a measured root-motion cue');

  const sourceJoint = visibleJoints[0]!;
  const explicitMap = { [sourceJoint]: 'InspectedRigArm' };
  const mappedPlan = capturePlanResultSchema.parse(planAnimationCaptures(recipe, auditAnimation(recipe), capturePlanRequestSchema.parse({
    views: ['front'], maxFrames: 4, focusJoints: ['InspectedRigArm'], jointMap: explicitMap,
  })));
  assert.deepEqual(mappedPlan.focusJointCoverage, { requested: ['InspectedRigArm'], scheduled: ['InspectedRigArm'], omitted: [], omittedDetails: [] });
  assert.deepEqual(mappedPlan.jointMap, explicitMap, 'the exact mapping used to schedule close-ups is returned for the capture handoff');
});

test('capture-plan result validation preserves dense marker and contact reasons at shared timestamps', () => {
  const recipe = animationPreset('cast', 'Dense capture planner case', 2, 1);
  recipe.markers = Array.from({ length: 100 }, (_, index) => ({ name: `Cue_${String(index + 1).padStart(3, '0')}`, time: 0.5, phase: 'event' as const }));
  recipe.contacts = Array.from({ length: 16 }, (_, index) => ({ effector: `Effector_${String(index + 1).padStart(2, '0')}`,
    kind: 'support' as const, start: 0.5, end: 0.5 }));
  const request = capturePlanRequestSchema.parse({ views: ['front', 'side'], maxFrames: 8 });
  const planned = planAnimationCaptures(recipe, auditAnimation(recipe), request);
  const validated = capturePlanResultSchema.parse(planned);
  const crowdedMoment = validated.moments.find(moment => moment.time === 0.5);
  assert.ok(crowdedMoment);
  assert.ok(crowdedMoment.reasons.length > 128, `expected dense shared reasons, got ${crowdedMoment.reasons.length}`);
  assert.equal(validated.frames.length, 8);
});

test('capture planner preserves distinct sub-millisecond authored beats and exact clip endpoints', () => {
  const recipe = animationPreset('cast', 'Precision capture planner case', 1.2345, 1);
  recipe.markers = [{ name: 'ReleaseA', time: 0.5004 }, { name: 'ReleaseB', time: 0.5005 }];
  const audit = auditAnimation(recipe);
  audit.refinementPlan.length = 0;
  audit.actionPhaseMap.phases.length = 0;
  const planned = planAnimationCaptures(recipe, audit, capturePlanRequestSchema.parse({ views: ['side'], maxFrames: 8 }));
  assert.ok(planned.moments.some(moment => moment.time === 0.5004 && moment.reasons.includes('authored_marker:ReleaseA')));
  assert.ok(planned.moments.some(moment => moment.time === 0.5005 && moment.reasons.includes('authored_marker:ReleaseB')));
  assert.ok(planned.moments.some(moment => moment.time === recipe.duration));
  assert.ok(planned.frames.some(frame => frame.time === recipe.duration));
  assert.equal(new Set(planned.moments.map(moment => moment.time)).size, planned.moments.length);
});

test('capture planner reports high-priority moments omitted by a tight screenshot budget', () => {
  const recipe = animationPreset('cast', 'Capture budget visibility case', 2, 1);
  recipe.markers = Array.from({ length: 9 }, (_, index) => ({ name: `Beat_${index + 1}`, time: (index + 1) / 5, phase: 'event' as const }));
  const audit = auditAnimation(recipe);
  audit.refinementPlan.length = 0;
  audit.actionPhaseMap.phases.length = 0;
  const planned = planAnimationCaptures(recipe, audit, capturePlanRequestSchema.parse({ views: ['side'], maxFrames: 2 }));
  const validated = capturePlanResultSchema.parse(planned);
  assert.equal(validated.omittedMomentSummary.candidateMomentCount, 11);
  assert.equal(validated.omittedMomentSummary.selectedMomentCount, 2);
  assert.equal(validated.omittedMomentSummary.omittedMomentCount, 9);
  assert.ok(validated.omittedMomentSummary.samples.some(moment => moment.reasons.includes('authored_marker:Beat_1')));
  assert.ok(validated.omittedMomentSummary.samples.some(moment => moment.reasons.includes('authored_marker:Beat_9')));
});

test('mandatory clip endpoints do not mask an interior contact beat in a tight storyboard', () => {
  const recipe = animationPreset('cast', 'Endpoint contact coverage case', 2, 1);
  recipe.contacts = [
    { effector: 'LeftFoot', kind: 'support', start: 0, end: 0.2 },
    { effector: 'RightFoot', kind: 'support', start: 0.7, end: 1.1 },
  ];
  recipe.markers = [];
  const audit = auditAnimation(recipe);
  audit.refinementPlan.length = 0;
  audit.actionPhaseMap.phases.length = 0;
  const planned = capturePlanResultSchema.parse(planAnimationCaptures(recipe, audit,
    capturePlanRequestSchema.parse({ views: ['side'], maxFrames: 3 })));

  const interiorContactBeat = planned.moments.find(moment => moment.time === 0.7 || moment.time === 1.1);
  assert.ok(interiorContactBeat, `the only interior frame should show a later contact boundary, got ${planned.frames.map(frame => frame.time)}`);
  assert.ok(interiorContactBeat.reasons.some(reason => reason === 'contact_start:RightFoot:support' || reason === 'contact_end:RightFoot:support'));
});

test('focused close-ups do not count as selected whole-rig moments in omitted-moment diagnostics', () => {
  const recipe = animationPreset('cast', 'Close-up coverage separation', 2, 1);
  recipe.markers = [];
  const audit = auditAnimation(recipe);
  audit.refinementPlan.length = 0;
  audit.actionPhaseMap.phases.length = 0;
  const joint = recipe.tracks[0]!.joint;
  const planned = capturePlanResultSchema.parse(planAnimationCaptures(recipe, audit,
    capturePlanRequestSchema.parse({ views: ['front'], maxFrames: 3, focusJoints: [joint] })));
  const closeup = planned.frames.find(frame => frame.focusJoint === joint)!;
  assert.ok(closeup);
  assert.equal(planned.frames.some(frame => frame.time === closeup.time && frame.focusJoint === undefined), false,
    'the tight budget leaves only endpoints in whole-rig coverage');
  assert.equal(planned.omittedMomentSummary.selectedMomentCount, 2,
    'only whole-rig sample times count as selected moments');
  assert.equal(planned.omittedMomentSummary.candidateMomentCount,
    planned.omittedMomentSummary.selectedMomentCount + planned.omittedMomentSummary.omittedMomentCount);
  assert.ok(planned.omittedMomentSummary.samples.some(moment => moment.time === closeup.time),
    'the close-up timestamp remains disclosed as omitted whole-rig evidence');
});

test('candidate comparison planner balances candidate-specific events into one matched frame schedule', () => {
  const windup = animationPreset('cast', 'Windup alternative', 2, 1);
  windup.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.55, end: 0.8 }];
  windup.markers = [{ name: 'Windup', time: 0.4 }, { name: 'Release', time: 1.25 }];
  const direct = animationPreset('cast', 'Direct alternative', 2, 1);
  direct.contacts = [{ effector: 'LeftHand', kind: 'grip', start: 1.1, end: 1.35 }];
  direct.markers = [{ name: 'Windup', time: 0.85 }, { name: 'Release', time: 1.55 }];
  const candidates = [windup, direct].map((recipe, index) => ({ label: index === 0 ? 'Windup' : 'Direct', recipe,
    candidateFingerprint: `${index === 0 ? 'a' : 'b'}`.repeat(64), audit: auditAnimation(recipe) }));
  const request = candidateComparisonPlanRequestSchema.parse({ views: ['side'], maxFrames: 4 });
  const planned = planCandidateComparisonCaptures(candidates, request);
  const repeated = planCandidateComparisonCaptures(candidates, request);
  assert.deepEqual(repeated, planned, 'the same alternatives produce a stable shared schedule');
  assert.equal(planned.frames.length, 4);
  assert.equal(planned.moments.length, 4);
  assert.deepEqual(planned.frames.map(frame => frame.time), planned.moments.map(moment => moment.time));
  assert.ok(planned.frames.every(frame => frame.view === 'side'));
  assert.equal(planned.frames[0]!.time, 0);
  assert.equal(planned.frames.at(-1)!.time, 2);
  for (const candidate of candidates) {
    assert.ok(planned.moments.some(moment => moment.contributions.some(contribution => contribution.candidateLabel === candidate.label)),
      `schedule should disclose why ${candidate.label} contributed moments`);
  }
  assert.equal(planned.candidateCoverage.length, candidates.length);
  for (const coverage of planned.candidateCoverage) {
    assert.equal(coverage.candidateMomentCount, coverage.selectedMomentCount + coverage.omittedMomentCount);
    assert.ok(coverage.omittedMomentCount > 0, `the tight shared budget should expose omitted moments for ${coverage.candidateLabel}`);
    assert.ok(coverage.samples.length > 0);
  }
  assert.deepEqual(planned.candidates.map(candidate => candidate.candidateFingerprint), candidates.map(candidate => candidate.candidateFingerprint));
  assert.equal(planned.timingAlignment.status, 'semantic_mismatch');
  assert.ok(planned.timingAlignment.markers.some(marker => marker.status === 'timing_variant'));
  assert.ok(planned.timingAlignment.contacts.some(contact => contact.status === 'missing_in_candidate'));
  assert.ok(planned.timingAlignment.warnings.some(warning => warning.includes('different semantic beats')));
  assert.match(planned.limitation, /may miss candidate-specific events/i);
  assert.throws(() => candidateComparisonPlanRequestSchema.parse({ views: ['front', 'side', 'back'], maxFrames: 4 }), /at most 2/i);
  assert.throws(() => candidateComparisonPlanRequestSchema.parse({ views: ['side', 'side'], maxFrames: 4 }), /must be unique/i);
});

test('candidate omission examples keep exclusive authored beats ahead of redundant motion peaks', () => {
  const authored = animationPreset('cast', 'Authored alternative', 2, 1);
  authored.markers = [
    { name: 'UniqueBeatA', time: 0.2 },
    { name: 'UniqueBeatB', time: 0.4 },
    { name: 'UniqueBeatC', time: 0.6 },
  ];
  const competing = animationPreset('cast', 'Competing alternative', 2, 1);
  competing.markers = [{ name: 'OtherBeat', time: 0.8 }];
  const authoredAudit = auditAnimation(authored);
  const motionPeak = authoredAudit.refinementPlan[0]!;
  authoredAudit.refinementPlan = Array.from({ length: 16 }, (_, index) => ({
    ...motionPeak,
    eventTime: 0.9 + index * 0.01,
    rankWithinSignal: index + 1,
  }));
  const candidates = [
    { label: 'Authored', recipe: authored, candidateFingerprint: 'a'.repeat(64), audit: authoredAudit },
    { label: 'Competing', recipe: competing, candidateFingerprint: 'b'.repeat(64), audit: auditAnimation(competing) },
  ];
  const planned = planCandidateComparisonCaptures(candidates, candidateComparisonPlanRequestSchema.parse({ views: ['side'], maxFrames: 4 }));
  const authoredCoverage = planned.candidateCoverage.find(coverage => coverage.candidateLabel === 'Authored')!;
  assert.ok(planned.moments.some(moment => moment.time === 0.2), 'the first exclusive authored beat should be selected for its candidate');
  assert.ok(authoredCoverage.samples.some(moment => moment.time === 0.4 || moment.time === 0.6),
    'omission diagnostics should surface another missed unique authored beat before numerous high-priority measured peaks');
});
