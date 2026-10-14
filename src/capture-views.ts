import { z } from 'zod';
import type { AnimationRecipe } from './recipes.js';

export const captureView = z.enum(['front', 'side', 'back', 'three_quarter', 'overhead']);
export const captureFrameSchema = z.object({
  time: z.number().finite().min(0).max(30),
  view: captureView,
  focusJoint: z.string().trim().min(1).max(128).optional(),
}).strict();

function captureFrameSet(minimumFrames: 1 | 2) {
  return z.array(captureFrameSchema).min(minimumFrames).max(8).superRefine((frames, context) => {
  const seen = new Set<string>();
  frames.forEach((frame, index) => {
    const pair = `${frame.time}:${frame.view}:${frame.focusJoint ?? ''}`;
    if (seen.has(pair)) context.addIssue({ code: 'custom', path: [index], message: 'Capture set contains a duplicate view/time pair.' });
    seen.add(pair);
  });
  });
}

/** Standard planned/storyboard captures contain multiple frames; explicit retry batches may contain one missing frame. */
export const captureFramesSchema = captureFrameSet(2);
export const captureRetryFramesSchema = captureFrameSet(1);

export const capturePlanRequestShape = {
  views: z.array(captureView).min(1).max(4).default(['front', 'side']),
  maxFrames: z.number().int().min(2).max(8).default(8),
  priorityTimes: z.array(z.number().finite().min(0).max(30)).max(31).default([])
    .describe('Optional exact review moments ordered by importance, such as phase-intent boundaries and midpoints. Times outside the clip are rejected; any that do not fit the frame budget are reported in that priority order.'),
  focusJoints: z.array(z.string().trim().min(1).max(128)).max(4).default([])
    .describe('Optional exact animated rig-node names to include as close-up frames. The plan reserves frames for whole-rig context first.'),
  jointMap: z.record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)).refine(map => Object.keys(map).length <= 256,
    'A capture joint map may contain at most 256 source joints.').default({})
    .describe('Optional exact authored-joint to inspected-rig-joint mapping. Supply the same mapping later when capturing so planned focus targets match the rendered channels.'),
};
export const capturePlanRequestSchema = z.object(capturePlanRequestShape).strict().superRefine((request, context) => {
  if (new Set(request.views).size !== request.views.length) context.addIssue({ code: 'custom', path: ['views'], message: 'Capture-plan views must be unique.' });
  if (new Set(request.focusJoints.map(joint => joint.toLocaleLowerCase('en-US'))).size !== request.focusJoints.length) {
    context.addIssue({ code: 'custom', path: ['focusJoints'], message: 'Focused joint names must be unique.' });
  }
  if (new Set(request.priorityTimes).size !== request.priorityTimes.length) {
    context.addIssue({ code: 'custom', path: ['priorityTimes'], message: 'Priority review times must be unique.' });
  }
  if (Math.floor(request.maxFrames / request.views.length) < 2) context.addIssue({ code: 'custom', path: ['maxFrames'], message: 'Choose enough frames for at least two distinct animation moments per view.' });
});
export const capturePlanResultSchema = z.object({
  frames: captureFramesSchema,
  moments: z.array(z.object({ time: z.number().finite().min(0).max(30), reasons: z.array(z.string().min(1).max(240)).min(1).max(256) }).strict()).min(1).max(8),
  omittedMomentSummary: z.object({ candidateMomentCount: z.number().int().nonnegative(), selectedMomentCount: z.number().int().nonnegative(),
    omittedMomentCount: z.number().int().nonnegative(), samples: z.array(z.object({ time: z.number().finite().min(0).max(30),
      reasons: z.array(z.string().min(1).max(240)).max(8), additionalReasonCount: z.number().int().nonnegative() }).strict()).max(12) }).strict(),
  focusJointCoverage: z.object({ requested: z.array(z.string().min(1).max(128)).max(4), scheduled: z.array(z.string().min(1).max(128)).max(4),
    omitted: z.array(z.string().min(1).max(128)).max(4), omittedDetails: z.array(z.object({ joint: z.string().min(1).max(128),
      reason: z.enum(['not_in_recipe', 'inactive_channel', 'frame_budget', 'no_scheduleable_moment']) }).strict()).max(4) }).strict(),
  priorityTimeCoverage: z.object({ requested: z.array(z.number().finite().min(0).max(30)).max(31),
    scheduled: z.array(z.number().finite().min(0).max(30)).max(31), omitted: z.array(z.number().finite().min(0).max(30)).max(31),
    followUpBatches: z.array(captureRetryFramesSchema).max(16) }).strict(),
  jointMap: z.record(z.string().min(1).max(128), z.string().min(1).max(128)).refine(map => Object.keys(map).length <= 256),
  requestedViews: z.array(captureView).min(1).max(4),
  maxFrames: z.number().int().min(2).max(8),
  limitation: z.string().min(1).max(2000),
}).strict();

export const candidateComparisonPlanRequestShape = {
  views: z.array(captureView).min(1).max(2).default(['side']),
  maxFrames: z.number().int().min(2).max(4).default(4),
};
export const candidateComparisonPlanRequestSchema = z.object(candidateComparisonPlanRequestShape).strict().superRefine((request, context) => {
  if (new Set(request.views).size !== request.views.length) context.addIssue({ code: 'custom', path: ['views'], message: 'Comparison-plan views must be unique.' });
  if (Math.floor(request.maxFrames / request.views.length) < 2) context.addIssue({ code: 'custom', path: ['maxFrames'], message: 'Choose enough frames for at least two distinct animation moments per view.' });
});

const comparisonAlignmentTolerance = 0.01;

function analyzeCandidateTimingAlignment(candidates: { label: string; recipe: AnimationRecipe }[]) {
  const loopModes = candidates.map(candidate => ({ candidateLabel: candidate.label, loop: candidate.recipe.loop }));
  const loopMismatch = new Set(loopModes.map(item => item.loop)).size > 1;
  const markerSlots = new Map<string, Map<string, number>>();
  const contactSlots = new Map<string, Map<string, { start: number; end: number }>>();
  for (const candidate of candidates) {
    const candidateMarkers = new Map<string, number>();
    const markerCounts = new Map<string, number>();
    for (const marker of [...candidate.recipe.markers].sort((left, right) => left.time - right.time || left.name.localeCompare(right.name))) {
      const name = marker.name.trim().toLocaleLowerCase('en-US');
      const occurrence = (markerCounts.get(name) ?? 0) + 1;
      markerCounts.set(name, occurrence);
      candidateMarkers.set(`${name}#${occurrence}`, marker.time / candidate.recipe.duration);
    }
    for (const [key, progress] of candidateMarkers) {
      const slot = markerSlots.get(key) ?? new Map<string, number>();
      slot.set(candidate.label, progress);
      markerSlots.set(key, slot);
    }

    const candidateContacts = new Map<string, { start: number; end: number }>();
    const contactCounts = new Map<string, number>();
    for (const contact of [...(candidate.recipe.contacts ?? [])].sort((left, right) => left.start - right.start || left.effector.localeCompare(right.effector))) {
      const base = `${contact.effector.trim().toLocaleLowerCase('en-US')}|${contact.kind}`;
      const occurrence = (contactCounts.get(base) ?? 0) + 1;
      contactCounts.set(base, occurrence);
      candidateContacts.set(`${base}#${occurrence}`, { start: contact.start / candidate.recipe.duration, end: contact.end / candidate.recipe.duration });
    }
    for (const [key, interval] of candidateContacts) {
      const slot = contactSlots.get(key) ?? new Map<string, { start: number; end: number }>();
      slot.set(candidate.label, interval);
      contactSlots.set(key, slot);
    }
  }

  const markers = [...markerSlots].sort(([left], [right]) => left.localeCompare(right)).map(([event, candidateProgress]) => {
    const times = candidates.map(candidate => candidateProgress.get(candidate.label) ?? null);
    const present = times.filter((time): time is number => time !== null);
    const spread = present.length === candidates.length ? Math.max(...present) - Math.min(...present) : null;
    return { event, candidateProgress: candidates.map((candidate, index) => ({ candidateLabel: candidate.label, normalizedTime: times[index] })),
      status: present.length !== candidates.length ? 'missing_in_candidate' as const
        : spread! > comparisonAlignmentTolerance ? 'timing_variant' as const : 'aligned' as const,
      spread };
  });
  const contacts = [...contactSlots].sort(([left], [right]) => left.localeCompare(right)).map(([effectorWindow, candidateIntervals]) => {
    const intervals = candidates.map(candidate => candidateIntervals.get(candidate.label) ?? null);
    const present = intervals.filter((interval): interval is { start: number; end: number } => interval !== null);
    const startSpread = present.length === candidates.length ? Math.max(...present.map(interval => interval.start)) - Math.min(...present.map(interval => interval.start)) : null;
    const endSpread = present.length === candidates.length ? Math.max(...present.map(interval => interval.end)) - Math.min(...present.map(interval => interval.end)) : null;
    return { effectorWindow, candidateIntervals: candidates.map((candidate, index) => ({ candidateLabel: candidate.label, normalizedInterval: intervals[index] })),
      status: present.length !== candidates.length ? 'missing_in_candidate' as const
        : startSpread! > comparisonAlignmentTolerance || endSpread! > comparisonAlignmentTolerance ? 'timing_variant' as const : 'aligned' as const,
      startSpread, endSpread };
  });
  const semanticMismatch = loopMismatch || markers.some(item => item.status === 'missing_in_candidate') || contacts.some(item => item.status === 'missing_in_candidate');
  const timingVariant = markers.some(item => item.status === 'timing_variant') || contacts.some(item => item.status === 'timing_variant');
  const status = semanticMismatch ? 'semantic_mismatch' as const : timingVariant ? 'timing_variants' as const : 'aligned' as const;
  const warnings = [
    ...(loopMismatch ? ['Candidates disagree on loop versus one-shot behavior.'] : []),
    ...(markers.some(item => item.status === 'missing_in_candidate') ? ['Named marker events are missing from one or more candidates.'] : []),
    ...(markers.some(item => item.status === 'timing_variant') ? ['One or more same-named marker events occur at different normalized times.'] : []),
    ...(contacts.some(item => item.status === 'missing_in_candidate') ? ['Declared effector/contact-kind windows differ across candidates.'] : []),
    ...(contacts.some(item => item.status === 'timing_variant') ? ['One or more declared contact windows start or end at different normalized times.'] : []),
    ...(status !== 'aligned' ? ['Shared absolute timestamps may show different semantic beats; separate timing changes from pose/style changes when interpreting the images.'] : []),
  ];
  return { status, normalizedProgressTolerance: comparisonAlignmentTolerance, loopModes, markers, contacts, warnings };
}

/** Deterministically proposes rendered-review times from authored and measured motion evidence. */
function planAnimationCapturesDetailed(recipe: AnimationRecipe, audit: ReturnType<typeof import('./animation-quality.js').auditAnimation>, request: z.infer<typeof capturePlanRequestSchema>) {
  if (request.priorityTimes.some(time => time > recipe.duration)) throw new Error('Every priority review time must be inside the animation duration.');
  const interiorPriorityTimes = request.priorityTimes.filter(time => time > 0 && time < recipe.duration);
  const wholeRigMomentLimit = Math.floor(request.maxFrames / request.views.length);
  const reservablePriorityCount = Math.min(interiorPriorityTimes.length, Math.max(0, wholeRigMomentLimit - 2));
  const focusCapacity = Math.max(0, request.maxFrames - (2 + reservablePriorityCount) * request.views.length);
  const resolveTargetJoint = (sourceJoint: string) => request.jointMap[sourceJoint] ?? sourceJoint;
  const activeTracks = [...recipe.tracks, ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks)];
  const activeFocusNames = new Set(activeTracks.map(track => resolveTargetJoint(track.joint)));
  if (recipe.rootMotion) activeFocusNames.add(resolveTargetJoint(recipe.rootMotion.joint));
  const authoredFocusNames = new Set([...recipe.tracks, ...(recipe.layers ?? []).flatMap(layer => layer.tracks)]
    .map(track => resolveTargetJoint(track.joint)));
  if (recipe.rootMotion) authoredFocusNames.add(resolveTargetJoint(recipe.rootMotion.joint));
  const activeRequestedJoints = request.focusJoints.filter(joint => activeFocusNames.has(joint));
  const focusedJoints = activeRequestedJoints.slice(0, focusCapacity);
  const momentLimit = Math.floor((request.maxFrames - focusedJoints.length) / request.views.length);
  const moments = new Map<number, { time: number; priority: number; reasons: string[] }>();
  const motionJointsByTime = new Map<number, Set<string>>();
  const noteMotionJoint = (time: number, joint: string) => {
    const exactTime = Math.max(0, Math.min(recipe.duration, time));
    const joints = motionJointsByTime.get(exactTime) ?? new Set<string>();
    joints.add(joint);
    motionJointsByTime.set(exactTime, joints);
  };
  const add = (time: number, reason: string, priority: number) => {
    if (!Number.isFinite(time) || time < -1e-6 || time > recipe.duration + 1e-6) return;
    const exactTime = Math.max(0, Math.min(recipe.duration, time));
    const current = moments.get(exactTime);
    if (current) {
      current.priority = Math.max(current.priority, priority);
      if (!current.reasons.includes(reason)) current.reasons.push(reason);
    } else moments.set(exactTime, { time: exactTime, priority, reasons: [reason] });
  };
  add(0, 'clip_start', 100);
  add(recipe.duration, recipe.loop ? 'loop_seam_end' : 'clip_end', 100);
  for (const time of request.priorityTimes) add(time, 'requested_review_time', 120);
  for (const phase of audit.actionPhaseMap.phases) {
    add(phase.startTime, `phase_start:${phase.label}:${phase.occurrence}`, phase.label === 'unsegmented' ? 0 : 90);
    if (phase.endTime < recipe.duration - 0.001) add(phase.endTime, `phase_end:${phase.label}:${phase.occurrence}`, 90);
    for (const joint of phase.poseProgression.joints) {
      if (joint.peakTranslationFromEntryStuds > 0) add(joint.peakTranslationTime,
        `composed_pose_peak_translation:${phase.label}:${joint.joint}`, 98);
      if (joint.peakRotationFromEntryDegrees > 0) add(joint.peakRotationTime,
        `composed_pose_peak_rotation:${phase.label}:${joint.joint}`, 98);
      if (joint.peakTranslationFromEntryStuds > 0) noteMotionJoint(joint.peakTranslationTime, resolveTargetJoint(joint.joint));
      if (joint.peakRotationFromEntryDegrees > 0) noteMotionJoint(joint.peakRotationTime, resolveTargetJoint(joint.joint));
    }
  }
  for (const contact of recipe.contacts ?? []) {
    add(contact.start, `contact_start:${contact.effector}:${contact.kind}`, 95);
    add((contact.start + contact.end) / 2, `contact_midpoint:${contact.effector}:${contact.kind}`, 70);
    add(contact.end, `contact_end:${contact.effector}:${contact.kind}`, 95);
  }
  for (const [index, target] of audit.refinementPlan.entries()) {
    if (target.channel === 'layer') {
      const sourceLayer = recipe.layers?.find(layer => layer.id === target.layerId);
      if (!sourceLayer?.enabled || sourceLayer.weight <= 0) continue;
    }
    add(target.eventTime, `measured_motion_peak:${target.signal}:${target.joint}:${index + 1}`, 100 - index / 100);
    noteMotionJoint(target.eventTime, resolveTargetJoint(target.joint));
  }
  for (const joint of focusedJoints) {
    const matchingTracks = activeTracks.filter(track => resolveTargetJoint(track.joint) === joint);
    for (const track of matchingTracks) for (const key of track.keys.slice(1, -1)) {
      add(key.time, `focused_joint_key:${joint}`, 88);
    }
    if (recipe.rootMotion && resolveTargetJoint(recipe.rootMotion.joint) === joint) for (const key of recipe.rootMotion.keys.slice(1, -1)) {
      add(key.time, `focused_joint_key:${joint}`, 88);
    }
    for (const target of audit.refinementPlan) {
      if (resolveTargetJoint(target.joint) !== joint) continue;
      if (target.channel === 'layer') {
        const sourceLayer = recipe.layers?.find(layer => layer.id === target.layerId);
        if (!sourceLayer?.enabled || sourceLayer.weight <= 0) continue;
      }
      add(target.eventTime, `focused_joint_evidence:${joint}:${target.signal}`, 99 - Math.min(40, target.rankWithinSignal));
      noteMotionJoint(target.eventTime, joint);
    }
  }
  for (const marker of recipe.markers) add(marker.time, `authored_marker:${marker.name}`, 55);
  for (let index = 1; index < momentLimit * 4; index++) {
    add(recipe.duration * index / (momentLimit - 1), 'uniform_coverage', 10);
  }
  const categories = (moment: { time: number; reasons: string[] }) => new Set([
    ...moment.reasons.map(reason => {
    if (reason.startsWith('contact_')) return 'contact';
    if (reason.startsWith('phase_') && !reason.includes(':unsegmented:') && !reason.includes(':unclassified:')) return 'phase';
    if (reason.startsWith('measured_motion_peak:') || reason.startsWith('composed_pose_peak_')) return 'motion_peak';
    if (reason.startsWith('authored_marker:')) return 'authored_marker';
    if (reason === 'uniform_coverage') return 'uniform_coverage';
    return 'endpoint';
    }),
    ...[...(motionJointsByTime.get(moment.time) ?? [])].map(joint => `motion_peak_joint:${joint}`),
  ]);
  const motionJointCategoryPriority = [...new Set([...motionJointsByTime.values()].flatMap(joints => [...joints]))]
    .map(joint => `motion_peak_joint:${joint}`);
  const categoryPriority = ['motion_peak', 'contact', 'phase', 'authored_marker', ...motionJointCategoryPriority, 'uniform_coverage'];
  const start = moments.get(0)!;
  const end = moments.get(recipe.duration)!;
  const selected = start === end ? [start] : [start, end];
  const selectedTimes = new Set(selected.map(moment => moment.time));
  // Clip endpoints are mandatory framing anchors, not evidence that an interior beat category is covered.
  const selectedCategories = new Set<string>();
  const scheduledPriorityTimes: number[] = [];
  const omittedPriorityTimes: number[] = [];
  for (const time of request.priorityTimes) {
    if (selectedTimes.has(time)) { scheduledPriorityTimes.push(time); continue; }
    if (selected.length >= momentLimit) { omittedPriorityTimes.push(time); continue; }
    const requestedMoment = moments.get(time)!;
    selected.push(requestedMoment);
    selectedTimes.add(time);
    scheduledPriorityTimes.push(time);
    for (const category of categories(requestedMoment)) selectedCategories.add(category);
  }
  while (selected.length < momentLimit) {
    const remaining = [...moments.values()].filter(moment => !selectedTimes.has(moment.time));
    if (!remaining.length) break;
    const nextCategory = categoryPriority.find(category => !selectedCategories.has(category)
      && remaining.some(moment => categories(moment).has(category)));
    const candidates = nextCategory ? remaining.filter(moment => categories(moment).has(nextCategory)) : remaining;
    candidates.sort((left, right) => {
      const score = (moment: typeof left) => moment.priority
        + Math.min(...selected.map(item => Math.abs(item.time - moment.time))) / recipe.duration * 8;
      return score(right) - score(left) || left.time - right.time;
    });
    const next = candidates[0]!;
    selected.push(next);
    selectedTimes.add(next.time);
    for (const category of categories(next)) selectedCategories.add(category);
  }
  selected.sort((left, right) => left.time - right.time);
  const frames: z.infer<typeof captureFramesSchema> = selected.flatMap(moment => request.views.map(view => ({ time: moment.time, view })));
  const focusedMoments = new Map<number, { time: number; reasons: string[] }>();
  for (const [index, joint] of focusedJoints.entries()) {
    const evidenceMoments = [...moments.values()].filter(moment => moment.time > 0 && moment.time < recipe.duration
      && moment.reasons.some(reason => reason.startsWith(`focused_joint_evidence:${joint}:`)));
    const trackMoments = [...moments.values()].filter(moment => moment.time > 0 && moment.time < recipe.duration
      && moment.reasons.includes(`focused_joint_key:${joint}`));
    const contactMoments = [...moments.values()].filter(moment => moment.time > 0 && moment.time < recipe.duration
      && moment.reasons.some(reason => reason.toLocaleLowerCase('en-US').includes(joint.toLocaleLowerCase('en-US'))));
    const fallbackMoments = [...moments.values()].filter(moment => moment.time > 0 && moment.time < recipe.duration);
    let candidates = evidenceMoments.length ? evidenceMoments : trackMoments.length ? trackMoments : contactMoments.length ? contactMoments : fallbackMoments;
    if (!candidates.length) {
      add(recipe.duration / 2, `focused_joint_fallback:${joint}`, 65);
      candidates = [...moments.values()].filter(moment => moment.time > 0 && moment.time < recipe.duration);
    }
    const candidate = candidates.sort((left, right) => right.priority - left.priority || left.time - right.time)[index % Math.max(1, candidates.length)];
    if (!candidate) continue;
    const frameView = request.views[index % request.views.length]!;
    frames.push({ time: candidate.time, view: frameView, focusJoint: joint });
    const chosen = focusedMoments.get(candidate.time) ?? { time: candidate.time, reasons: [...candidate.reasons] };
    const reason = `focused_closeup:${joint}:${frameView}`;
    if (!chosen.reasons.includes(reason)) chosen.reasons.push(reason);
    focusedMoments.set(candidate.time, chosen);
  }
  const selectedMomentMap = new Map([...selected.map(moment => [moment.time, { time: moment.time, reasons: [...moment.reasons] }] as const), ...focusedMoments]);
  // A focused close-up is not whole-rig temporal coverage; only the paired-view moments count as selected here.
  const omitted = [...moments.values()].filter(moment => !selectedTimes.has(moment.time))
    .sort((left, right) => right.priority - left.priority || left.time - right.time);
  const omittedSummarySamples = new Map<number, (typeof omitted)[number]>();
  for (const category of categoryPriority) {
    const representative = omitted.find(moment => categories(moment).has(category));
    if (representative) omittedSummarySamples.set(representative.time, representative);
  }
  for (const moment of omitted) {
    if (omittedSummarySamples.size >= 12) break;
    omittedSummarySamples.set(moment.time, moment);
  }
  const plan = { frames: captureFramesSchema.parse(frames), moments: [...selectedMomentMap.values()].sort((left, right) => left.time - right.time),
    omittedMomentSummary: { candidateMomentCount: moments.size, selectedMomentCount: selected.length, omittedMomentCount: omitted.length,
      samples: [...omittedSummarySamples.values()].sort((left, right) => left.time - right.time).map(moment => ({ time: moment.time, reasons: moment.reasons.slice(0, 8),
        additionalReasonCount: Math.max(0, moment.reasons.length - 8) })) },
    priorityTimeCoverage: { requested: request.priorityTimes, scheduled: scheduledPriorityTimes, omitted: omittedPriorityTimes,
      followUpBatches: Array.from({ length: Math.ceil(omittedPriorityTimes.length / Math.max(1, Math.floor(8 / request.views.length))) }, (_, index) =>
        omittedPriorityTimes.slice(index * Math.max(1, Math.floor(8 / request.views.length)), (index + 1) * Math.max(1, Math.floor(8 / request.views.length)))
          .flatMap(time => request.views.map(view => ({ time, view })))) },
    focusJointCoverage: { requested: request.focusJoints, scheduled: focusedJoints.filter(joint => frames.some(frame => frame.focusJoint === joint)),
      omitted: request.focusJoints.filter(joint => !focusedJoints.includes(joint) || !frames.some(frame => frame.focusJoint === joint)),
      omittedDetails: request.focusJoints.flatMap(joint => {
        if (frames.some(frame => frame.focusJoint === joint)) return [];
        const reason = !authoredFocusNames.has(joint) ? 'not_in_recipe' as const
          : !activeFocusNames.has(joint) ? 'inactive_channel' as const
            : !focusedJoints.includes(joint) ? 'frame_budget' as const : 'no_scheduleable_moment' as const;
        return [{ joint, reason }];
      }) }, jointMap: request.jointMap,
    requestedViews: request.views, maxFrames: request.maxFrames,
    limitation: 'This deterministic plan prioritizes authored boundaries and measured motion extrema, and may reserve remaining frames for exact requested joint close-ups. It does not know camera framing, verify that a requested joint is a visible BasePart in the active rig, evaluate rendered deformation, or determine artistic quality. Inspect the actual images and adjust times/views as needed.' };
  return { plan, candidateMoments: [...moments.values()] };
}

export function planAnimationCaptures(recipe: AnimationRecipe, audit: ReturnType<typeof import('./animation-quality.js').auditAnimation>, request: z.infer<typeof capturePlanRequestSchema>) {
  return planAnimationCapturesDetailed(recipe, audit, request).plan;
}

/** Plans matched visual-review timestamps across distinct, equal-duration animation alternatives. */
export function planCandidateComparisonCaptures(
  candidates: { label: string; candidateFingerprint: string; recipe: AnimationRecipe; audit: ReturnType<typeof import('./animation-quality.js').auditAnimation> }[],
  request: z.infer<typeof candidateComparisonPlanRequestSchema>,
) {
  if (candidates.length < 2 || candidates.length > 4) throw new Error('Candidate comparison planning requires 2–4 animation alternatives.');
  if (new Set(candidates.map(candidate => candidate.label.trim().toLocaleLowerCase('en-US'))).size !== candidates.length) throw new Error('Candidate labels must be unique.');
  if (new Set(candidates.map(candidate => candidate.candidateFingerprint)).size !== candidates.length) throw new Error('Candidate recipes must be distinct.');
  const duration = candidates[0]!.recipe.duration;
  if (candidates.some(candidate => candidate.recipe.duration !== duration)) throw new Error('All comparison candidates must have the same duration.');

  const momentLimit = Math.floor(request.maxFrames / request.views.length);
  const proposals = candidates.map(candidate => ({ candidate, ...planAnimationCapturesDetailed(candidate.recipe, candidate.audit,
    capturePlanRequestSchema.parse({ views: ['side'], maxFrames: momentLimit })) }));
  const pooled = new Map<number, { time: number; priority: number; contributions: Map<string, string[]> }>();
  const priorityOf = (reason: string) => reason.startsWith('measured_motion_peak:') ? 100
    : reason.startsWith('contact_') ? 95
      : reason.startsWith('phase_') ? 90
        : reason.startsWith('composed_pose_peak_') ? 85
        : reason.startsWith('authored_marker:') ? 55
          : reason === 'uniform_coverage' ? 10 : 100;
  for (const { candidate, candidateMoments } of proposals) for (const moment of candidateMoments) {
    let entry = pooled.get(moment.time);
    if (!entry) { entry = { time: moment.time, priority: 0, contributions: new Map() }; pooled.set(moment.time, entry); }
    entry.contributions.set(candidate.label, moment.reasons);
    entry.priority = Math.max(entry.priority, ...moment.reasons.map(priorityOf));
  }

  const selected = new Set<number>([0, duration]);
  const hasExclusiveAuthoredMoment = (candidateLabel: string, moment: typeof proposals[number]['candidateMoments'][number]) => {
    const authoredReasons = moment.reasons.filter(reason => reason.startsWith('contact_') || reason.startsWith('authored_marker:'));
    return authoredReasons.some(reason => !proposals.some(other => other.candidate.label !== candidateLabel
      && other.candidateMoments.some(otherMoment => otherMoment.time === moment.time && otherMoment.reasons.includes(reason))));
  };
  const candidateQueues = proposals.map(({ candidate, candidateMoments }) => {
    const prioritySorted = (left: typeof candidateMoments[number], right: typeof candidateMoments[number]) => {
      const score = (reasons: string[]) => Math.max(...reasons.map(priorityOf));
      return Number(hasExclusiveAuthoredMoment(candidate.label, right)) - Number(hasExclusiveAuthoredMoment(candidate.label, left))
        || score(right.reasons) - score(left.reasons) || left.time - right.time;
    };
    const inside = candidateMoments.filter(moment => moment.time > 0 && moment.time < duration);
    return { label: candidate.label, moments: inside.sort(prioritySorted) };
  });
  const cursors = candidateQueues.map(() => 0);
  while (selected.size < momentLimit) {
    let added = false;
    for (let index = 0; index < candidateQueues.length && selected.size < momentLimit; index++) {
      const queue = candidateQueues[index]!;
      while (cursors[index]! < queue.moments.length) {
        const cursor = cursors[index]!;
        const moment = queue.moments[cursor]!;
        cursors[index] = cursor + 1;
        if (!selected.has(moment.time)) { selected.add(moment.time); added = true; break; }
      }
    }
    if (added) continue;
    const remaining = [...pooled.values()].filter(moment => !selected.has(moment.time));
    if (!remaining.length) break;
    remaining.sort((left, right) => {
      const score = (moment: typeof left) => moment.priority + Math.min(...[...selected].map(time => Math.abs(time - moment.time))) / duration * 8;
      return score(right) - score(left) || left.time - right.time;
    });
    selected.add(remaining[0]!.time);
  }

  const moments = [...selected].sort((left, right) => left - right).map(time => ({ time,
    contributions: [...(pooled.get(time)?.contributions ?? new Map<string, string[]>())].map(([candidateLabel, reasons]) => ({ candidateLabel, reasons })),
  }));
  const frames = moments.flatMap(moment => request.views.map(view => ({ time: moment.time, view })));
  const candidateCoverage = proposals.map(({ candidate, candidateMoments }) => {
    const omitted = candidateMoments.filter(moment => !selected.has(moment.time)).sort((left, right) =>
      Number(hasExclusiveAuthoredMoment(candidate.label, right)) - Number(hasExclusiveAuthoredMoment(candidate.label, left))
      || right.priority - left.priority || left.time - right.time);
    return { candidateLabel: candidate.label, candidateMomentCount: candidateMoments.length,
      selectedMomentCount: candidateMoments.length - omitted.length, omittedMomentCount: omitted.length,
      samples: omitted.slice(0, 12).map(moment => ({ time: moment.time, reasons: moment.reasons.slice(0, 8),
        additionalReasonCount: Math.max(0, moment.reasons.length - 8) })) };
  });
  return {
    frames: captureFramesSchema.parse(frames),
    moments,
    candidateCoverage,
    candidates: candidates.map(candidate => ({ label: candidate.label, candidateFingerprint: candidate.candidateFingerprint })),
    timingAlignment: analyzeCandidateTimingAlignment(candidates),
    requestedViews: request.views,
    maxFrames: request.maxFrames,
    limitation: 'The shared schedule prioritizes endpoints and a balanced union of each candidate’s authored phases, contacts, markers, and measured motion peaks. Equal timestamps enable fair comparison but may miss candidate-specific events between selected moments; inspect the full motion in Studio before deciding.',
  };
}

export function validateCaptureFrames(frames: z.infer<typeof captureFramesSchema>, duration: number) {
  if (frames.some(frame => frame.time > duration)) throw new Error('Every capture time must be inside the animation.');
}
