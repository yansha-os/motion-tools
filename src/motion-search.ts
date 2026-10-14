import type { Asset } from './library.js';
import type { AnimationRecipe } from './recipes.js';
import { createComposedJointSampler } from './animation-patch.js';
import { retargetAnimation, suggestAnimationJointMap, type RetargetProfile } from './retarget.js';

const SAMPLE_COUNT = 33;
const MAX_SAMPLE_COUNT = 129;
const POSITION_NORMALIZATION_STUDS = 4;

function compareOrdinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function distance(left: readonly number[], right: readonly number[]) {
  return Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!);
}

function angularDistanceDegrees(left: readonly number[], right: readonly number[]) {
  const dot = Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0));
  return 2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function animationJoints(recipe: AnimationRecipe) {
  return [...new Set([
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ])].sort(compareOrdinal);
}

function composedAnimationJoints(recipe: AnimationRecipe) {
  return [...new Set([
    ...recipe.tracks.map(track => track.joint),
    ...(recipe.layers ?? []).filter(layer => layer.enabled && layer.weight > 0).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(recipe.rootMotion ? [recipe.rootMotion.joint] : []),
  ])].sort(compareOrdinal);
}

function authoredProgressTimes(recipe: AnimationRecipe, relevantJoints: Set<string>) {
  const keys = new Set<number>(), events = new Set<number>();
  const addTrackKeys = (track: AnimationRecipe['tracks'][number]) => {
    for (const key of track.keys) keys.add(key.time / recipe.duration);
  };
  for (const track of recipe.tracks) if (relevantJoints.has(track.joint)) addTrackKeys(track);
  if (recipe.rootMotion && relevantJoints.has(recipe.rootMotion.joint)) addTrackKeys(recipe.rootMotion);
  for (const layer of recipe.layers ?? []) if (layer.enabled && layer.weight > 0) {
    for (const track of layer.tracks) if (relevantJoints.has(track.joint)) addTrackKeys(track);
  }
  for (const marker of recipe.markers) events.add(marker.time / recipe.duration);
  for (const contact of recipe.contacts ?? []) {
    events.add(contact.start / recipe.duration);
    events.add(contact.end / recipe.duration);
  }
  return { keys, events };
}

function compareEventAlignment(query: AnimationRecipe, candidate: AnimationRecipe) {
  const queryMarkers = new Map<string, number[]>(), candidateMarkers = new Map<string, number[]>();
  const collectMarkers = (recipe: AnimationRecipe, groups: Map<string, number[]>) => {
    for (const marker of recipe.markers) {
      const identity = JSON.stringify([marker.name, marker.value ?? '', marker.phase ?? '']);
      const times = groups.get(identity) ?? [];
      times.push(marker.time / recipe.duration);
      groups.set(identity, times);
    }
    for (const times of groups.values()) times.sort((left, right) => left - right);
  };
  collectMarkers(query, queryMarkers);
  collectMarkers(candidate, candidateMarkers);
  const queryMarkerCount = query.markers.length, candidateMarkerCount = candidate.markers.length;
  const markerDenominator = Math.max(queryMarkerCount, candidateMarkerCount);
  let matchedMarkerCount = 0;
  let markerError = 0;
  for (const identity of new Set([...queryMarkers.keys(), ...candidateMarkers.keys()])) {
    const left = queryMarkers.get(identity) ?? [], right = candidateMarkers.get(identity) ?? [];
    const count = Math.min(left.length, right.length);
    matchedMarkerCount += count;
    for (let index = 0; index < count; index++) markerError += Math.min(1, Math.abs(left[index]! - right[index]!));
  }
  markerError += markerDenominator - matchedMarkerCount;

  type NormalizedContact = { start: number; end: number };
  const queryContacts = new Map<string, NormalizedContact[]>(), candidateContacts = new Map<string, NormalizedContact[]>();
  const collectContacts = (recipe: AnimationRecipe, groups: Map<string, NormalizedContact[]>) => {
    for (const contact of recipe.contacts ?? []) {
      const identity = JSON.stringify([contact.effector, contact.kind]);
      const windows = groups.get(identity) ?? [];
      windows.push({ start: contact.start / recipe.duration, end: contact.end / recipe.duration });
      groups.set(identity, windows);
    }
    for (const windows of groups.values()) windows.sort((left, right) => left.start - right.start || left.end - right.end);
  };
  collectContacts(query, queryContacts);
  collectContacts(candidate, candidateContacts);
  const queryContactCount = (query.contacts ?? []).length, candidateContactCount = (candidate.contacts ?? []).length;
  const contactDenominator = Math.max(queryContactCount, candidateContactCount);
  let matchedContactCount = 0;
  let contactError = 0;
  for (const identity of new Set([...queryContacts.keys(), ...candidateContacts.keys()])) {
    const left = queryContacts.get(identity) ?? [], right = candidateContacts.get(identity) ?? [];
    const count = Math.min(left.length, right.length);
    matchedContactCount += count;
    for (let index = 0; index < count; index++) {
      const a = left[index], b = right[index];
      if (!a || !b) continue;
      const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
      contactError += union > 0 ? 1 - intersection / union : 1;
    }
  }
  contactError += contactDenominator - matchedContactCount;
  const markerAlignmentPercent = markerDenominator ? Math.round((1 - markerError / markerDenominator) * 10_000) / 100 : null;
  const contactAlignmentPercent = contactDenominator ? Math.round((1 - contactError / contactDenominator) * 10_000) / 100 : null;
  const totalDenominator = markerDenominator + contactDenominator;
  const eventAlignmentPercent = totalDenominator
    ? Math.round((1 - (markerError + contactError) / totalDenominator) * 10_000) / 100
    : null;
  return {
    eventAlignmentPercent,
    markerAlignmentPercent,
    queryMarkerCount, candidateMarkerCount,
    contactAlignmentPercent,
    queryContactCount, candidateContactCount,
  };
}

function stratifiedSubset(values: number[], count: number) {
  if (values.length <= count) return values;
  return Array.from({ length: count }, (_, index) => values[Math.floor((index + 0.5) * values.length / count)]!);
}

function progressSchedule(query: AnimationRecipe, candidate: AnimationRecipe, relevantJoints: Set<string>) {
  const uniform = Array.from({ length: SAMPLE_COUNT }, (_, index) => index / (SAMPLE_COUNT - 1));
  const uniformSet = new Set(uniform);
  const queryAuthored = authoredProgressTimes(query, relevantJoints), candidateAuthored = authoredProgressTimes(candidate, relevantJoints);
  const keyTimes = [...new Set([...queryAuthored.keys, ...candidateAuthored.keys])].sort((a, b) => a - b);
  const eventTimes = [...new Set([...queryAuthored.events, ...candidateAuthored.events])].sort((a, b) => a - b);
  const keyTimeSet = new Set(keyTimes);
  const authored = [...new Set([...keyTimes, ...eventTimes])].sort((a, b) => a - b);
  const keyExtras = keyTimes.filter(time => !uniformSet.has(time));
  const eventExtras = eventTimes.filter(time => !uniformSet.has(time) && !keyTimeSet.has(time));
  const slots = MAX_SAMPLE_COUNT - uniform.length;
  const selectedKeyExtras = stratifiedSubset(keyExtras, slots);
  const selectedEventExtras = stratifiedSubset(eventExtras, Math.max(0, slots - selectedKeyExtras.length));
  const selectedExtras = [...selectedKeyExtras, ...selectedEventExtras];
  const progress = [...new Set([...uniform, ...selectedExtras])].sort((a, b) => a - b);
  const progressSet = new Set(progress);
  const sampledAuthoredCount = authored.filter(time => progressSet.has(time)).length;
  const weights = progress.map(() => 0);
  for (let index = 1; index < progress.length; index++) {
    const halfInterval = (progress[index]! - progress[index - 1]!) / 2;
    weights[index - 1]! += halfInterval;
    weights[index]! += halfInterval;
  }
  return {
    progress, weights, totalWeight: weights.reduce((sum, weight) => sum + weight, 0),
    authoredProgressPointCount: authored.length, sampledAuthoredProgressPointCount: sampledAuthoredCount,
    omittedAuthoredProgressPointCount: authored.length - sampledAuthoredCount,
    comparedKeyProgressPointCount: keyTimes.length,
    sampledComparedKeyProgressPointCount: keyTimes.filter(time => progressSet.has(time)).length,
    omittedComparedKeyProgressPointCount: keyTimes.filter(time => !progressSet.has(time)).length,
    eventProgressPointCount: eventTimes.length,
    sampledEventProgressPointCount: eventTimes.filter(time => progressSet.has(time)).length,
    omittedEventProgressPointCount: eventTimes.filter(time => !progressSet.has(time)).length,
  };
}

export type MotionSearchMatch = {
  assetId: string;
  name: string;
  parentId?: string;
  sourceRigType?: 'R6' | 'R15' | 'custom';
  motionShapeSimilarityPercent: number;
  /** Declared marker/contact timing alignment, kept separate from local-pose shape. */
  eventAlignmentPercent: number | null;
  markerAlignmentPercent: number | null;
  queryMarkerCount: number;
  candidateMarkerCount: number;
  contactAlignmentPercent: number | null;
  queryContactCount: number;
  candidateContactCount: number;
  /** Explainable evidence grade; this is not a probability or an artistic-quality score. */
  evidenceQuality: 'strong' | 'limited' | 'weak';
  evidenceLimitations: ('incomplete_joint_coverage' | 'retarget_mapping_incomplete' | 'mapping_fallback' | 'rig_provenance_unavailable' | 'authored_pose_samples_omitted' | 'event_samples_omitted')[];
  matchedJointCount: number;
  queryJointCount: number;
  candidateJointCount: number;
  jointCoverageFraction: number;
  queryOnlyJoints: string[];
  candidateOnlyJoints: string[];
  positionRmseStuds: number | null;
  rotationRmseDegrees: number | null;
  durationRatio: number;
  durationDifferenceSeconds: number;
  comparisonMode: 'same_rig_profile' | 'retargeted_to_query_rig' | 'joint_name_only' | 'joint_name_fallback_after_mapping_error';
  sampledProgressPointCount: number;
  authoredProgressPointCount: number;
  sampledAuthoredProgressPointCount: number;
  omittedAuthoredProgressPointCount: number;
  comparedKeyProgressPointCount: number;
  sampledComparedKeyProgressPointCount: number;
  omittedComparedKeyProgressPointCount: number;
  eventProgressPointCount: number;
  sampledEventProgressPointCount: number;
  omittedEventProgressPointCount: number;
  candidateSourceJointCount: number;
  mappedJointPairs: { source: string; target: string }[];
  omittedMappedJointCount: number;
  unmappedCandidateJoints: string[];
  omittedUnmappedJointCount: number;
  unmappedActiveCandidateJoints: string[] | null;
  omittedUnmappedActiveJointCount: number | null;
  unmappedInactiveCandidateJoints: string[] | null;
  omittedUnmappedInactiveJointCount: number | null;
  retargetedJointCoverageFraction: number | null;
  retargetedAuthoredJointCoverageFraction: number | null;
  mappingWarning?: string;
  /** Next safe action when active pose channels could not be mapped. */
  mappingNextStep?: string;
};

export function assessAnimationRetargetCompatibility(asset: Asset, targetProfileInput: RetargetProfile) {
  if (asset.recipe.kind !== 'animation') throw new Error('Retarget compatibility requires an animation asset.');
  if (!asset.sourceRigProfile) return {
    status: 'unknown' as const, sourceRig: null, targetRig: targetProfileInput.rigName,
    mappedJointCount: 0, unresolvedJointCount: 0, animatedJointCount: 0, mappingCoverageFraction: 0,
    suggestedJointMap: {}, unresolved: [],
    limitation: 'The animation has no saved source rig profile; inspect its source rig or provide provenance before compatibility can be assessed.',
  };
  const animatedJoints = [...new Set([
    ...asset.recipe.tracks.map(track => track.joint),
    ...(asset.recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
    ...(asset.recipe.rootMotion ? [asset.recipe.rootMotion.joint] : []),
  ])];
  const mapping = suggestAnimationJointMap(asset.sourceRigProfile, targetProfileInput, animatedJoints);
  const mappedJointCount = Object.keys(mapping.suggestedJointMap).length;
  const unresolved = mapping.suggestions.filter(suggestion => suggestion.status !== 'suggested');
  return {
    status: unresolved.length === 0 ? 'strong_mapping_available' as const : mappedJointCount > 0 ? 'partial_mapping' as const : 'no_strong_mapping' as const,
    sourceRig: mapping.sourceRig, targetRig: mapping.targetRig,
    mappedJointCount, unresolvedJointCount: unresolved.length, animatedJointCount: animatedJoints.length,
    mappingCoverageFraction: animatedJoints.length ? mappedJointCount / animatedJoints.length : 0,
    suggestedJointMap: mapping.suggestedJointMap,
    unresolved: unresolved.slice(0, 32).map(suggestion => ({ source: suggestion.source, status: suggestion.status, reason: suggestion.reason, candidates: suggestion.candidates })),
    omittedUnresolvedCount: Math.max(0, unresolved.length - 32),
    limitation: mapping.limitation,
  };
}

/** Return the next safe MCP call for a saved candidate and an inspected target. This only describes a request; it never runs or commits it. */
export function buildAnimationRetargetHandoff(asset: Asset, targetProfile: RetargetProfile, sessionId: string, targetRigId: string) {
  const compatibility = assessAnimationRetargetCompatibility(asset, targetProfile);
  if (compatibility.status === 'unknown') return {
    status: 'source_profile_required' as const, tool: null, arguments: null,
    reason: compatibility.limitation,
  };
  if (compatibility.status === 'strong_mapping_available' && asset.sourceRigProfile) return {
    status: 'preview_ready' as const, tool: 'motion_animation_retarget_preview' as const,
    arguments: { assetId: asset.id, sessionId, targetRigId, jointMap: compatibility.suggestedJointMap, allowPartial: false, scaleTranslation: true },
    reason: 'All authored joints have a strong one-to-one suggested mapping. Review the read-only preview recipe and diagnostics before any commit.',
  };
  return {
    status: 'mapping_review_required' as const, tool: 'motion_animation_suggest_joint_map' as const,
    arguments: { assetId: asset.id, sessionId, targetRigId },
    reason: compatibility.limitation,
  };
}

/** Rank saved clips by normalized-progress composed local-pose similarity, not semantics or artistry. */
export function rankMotionMatches(queryAsset: Asset, candidateAssets: Asset[], limit = 10): MotionSearchMatch[] {
  if (queryAsset.recipe.kind !== 'animation') throw new Error('Motion similarity search requires an animation query asset.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Motion similarity result limit must be an integer from 1 to 100.');
  const query = queryAsset.recipe;
  const queryJoints = composedAnimationJoints(query);
  if (!queryJoints.length) throw new Error('Motion similarity search requires at least one animated joint in the query recipe.');
  const querySamplers = new Map(queryJoints.flatMap(joint => {
    const sampler = createComposedJointSampler(query, joint);
    return sampler ? [[joint, sampler] as const] : [];
  }));
  const matches: MotionSearchMatch[] = [];

  for (const candidateAsset of candidateAssets) {
    if (candidateAsset.id === queryAsset.id || candidateAsset.recipe.kind !== 'animation') continue;
    const candidate = candidateAsset.recipe;
    let comparisonRecipe = candidate;
    let comparisonMode: MotionSearchMatch['comparisonMode'] = 'joint_name_only';
    let mappedJointPairs: { source: string; target: string }[] = [];
    let unmappedCandidateJoints: string[] = [];
    let unmappedActiveCandidateJoints: string[] | null = null;
    let unmappedInactiveCandidateJoints: string[] | null = null;
    let retargetedJointCoverageFraction: number | null = null;
    let retargetedAuthoredJointCoverageFraction: number | null = null;
    let mappingWarning: string | undefined;
    let mappingNextStep: string | undefined;
    if (queryAsset.sourceRigProfile && candidateAsset.sourceRigProfile) {
      if (queryAsset.sourceRigProfile.rigSignature === candidateAsset.sourceRigProfile.rigSignature) {
        comparisonMode = 'same_rig_profile';
      } else {
        const sourceJoints = animationJoints(candidate);
        const mapping = suggestAnimationJointMap(candidateAsset.sourceRigProfile, queryAsset.sourceRigProfile, sourceJoints);
        const strongJointMap = mapping.suggestedJointMap;
        if (Object.keys(strongJointMap).length > 0) {
          try {
            const retargeted = retargetAnimation(candidate, candidateAsset.sourceRigProfile, queryAsset.sourceRigProfile, strongJointMap, true, true);
            comparisonRecipe = retargeted.recipe;
            comparisonMode = 'retargeted_to_query_rig';
            mappedJointPairs = [...retargeted.report.mapped].sort((left, right) => compareOrdinal(left.source, right.source) || compareOrdinal(left.target, right.target));
            unmappedCandidateJoints = [...new Set(retargeted.report.skipped)].sort(compareOrdinal);
            const mappedSources = new Set(mappedJointPairs.map(pair => pair.source));
            const activeSourceJoints = composedAnimationJoints(candidate);
            const activeSourceJointSet = new Set(activeSourceJoints);
            unmappedActiveCandidateJoints = activeSourceJoints.filter(joint => !mappedSources.has(joint));
            unmappedInactiveCandidateJoints = sourceJoints.filter(joint => !activeSourceJointSet.has(joint) && !mappedSources.has(joint));
            retargetedJointCoverageFraction = activeSourceJoints.length
              ? activeSourceJoints.filter(joint => mappedSources.has(joint)).length / activeSourceJoints.length : 0;
            retargetedAuthoredJointCoverageFraction = sourceJoints.length
              ? sourceJoints.filter(joint => mappedSources.has(joint)).length / sourceJoints.length : 0;
            if (retargetedJointCoverageFraction < 1) {
              mappingNextStep = 'Treat this cross-rig score as provisional. Call motion_animation_suggest_joint_map with this assetId plus the current sessionId and targetRigId; resolve unmapped active joints, then preview the candidate on the target rig before reuse.';
            }
          } catch (error) {
            comparisonMode = 'joint_name_fallback_after_mapping_error';
            mappingWarning = error instanceof Error ? error.message : String(error);
            mappingNextStep = 'Treat this as exact-joint-name fallback, not verified cross-rig alignment. Call motion_animation_suggest_joint_map with this assetId plus the current sessionId and targetRigId, then preview the candidate on the target rig before reuse.';
          }
        } else {
          mappingWarning = 'No strong one-to-one joint map was available; this candidate is compared by exact joint names only.';
          mappingNextStep = 'Treat this as exact-joint-name comparison, not verified cross-rig alignment. Call motion_animation_suggest_joint_map with this assetId plus the current sessionId and targetRigId, then preview the candidate on the target rig before reuse.';
        }
      }
    }
    const candidateJoints = composedAnimationJoints(comparisonRecipe);
    const candidateJointSet = new Set(candidateJoints);
    const candidateSamplers = new Map(candidateJoints.flatMap(joint => {
      const sampler = createComposedJointSampler(comparisonRecipe, joint);
      return sampler ? [[joint, sampler] as const] : [];
    }));
    const matchedJoints = queryJoints.filter(joint => candidateSamplers.has(joint));
    const schedule = progressSchedule(query, comparisonRecipe, new Set(matchedJoints));
    const missingJointCount = queryJoints.length - matchedJoints.length;
    let positionSquaredSum = 0, rotationSquaredSum = 0, normalizedSquaredSum = missingJointCount * schedule.totalWeight;
    for (const joint of matchedJoints) {
      const querySampler = querySamplers.get(joint)!;
      const candidateSampler = candidateSamplers.get(joint)!;
      for (const [sampleIndex, normalizedTime] of schedule.progress.entries()) {
        const timeWeight = schedule.weights[sampleIndex]!;
        const left = querySampler(normalizedTime * query.duration);
        const right = candidateSampler(normalizedTime * candidate.duration);
        const positionError = distance(left.position, right.position);
        const rotationError = angularDistanceDegrees(left.rotation, right.rotation);
        positionSquaredSum += positionError ** 2 * timeWeight;
        rotationSquaredSum += rotationError ** 2 * timeWeight;
        const normalizedPosition = Math.min(positionError / POSITION_NORMALIZATION_STUDS, 1);
        const normalizedRotation = Math.min(rotationError / 180, 1);
        normalizedSquaredSum += (normalizedPosition ** 2 + normalizedRotation ** 2) / 2 * timeWeight;
      }
    }
    const evidenceCount = matchedJoints.length * schedule.totalWeight;
    const scoredCount = queryJoints.length * schedule.totalWeight;
    const normalizedRmse = Math.sqrt(normalizedSquaredSum / scoredCount);
    const eventAlignment = compareEventAlignment(query, comparisonRecipe);
    const evidenceLimitations: MotionSearchMatch['evidenceLimitations'] = [];
    if (matchedJoints.length < queryJoints.length) evidenceLimitations.push('incomplete_joint_coverage');
    if (comparisonMode === 'joint_name_fallback_after_mapping_error') evidenceLimitations.push('mapping_fallback');
    if (retargetedJointCoverageFraction !== null && retargetedJointCoverageFraction < 1) evidenceLimitations.push('retarget_mapping_incomplete');
    if (comparisonMode === 'joint_name_only') evidenceLimitations.push('rig_provenance_unavailable');
    if (schedule.omittedComparedKeyProgressPointCount > 0) evidenceLimitations.push('authored_pose_samples_omitted');
    if (schedule.omittedEventProgressPointCount > 0) evidenceLimitations.push('event_samples_omitted');
    const evidenceQuality: MotionSearchMatch['evidenceQuality'] =
      matchedJoints.length / queryJoints.length < 0.5 || comparisonMode === 'joint_name_fallback_after_mapping_error' ||
      (retargetedJointCoverageFraction !== null && retargetedJointCoverageFraction < 0.5)
        ? 'weak'
        : evidenceLimitations.length > 0 ? 'limited' : 'strong';
    matches.push({
      assetId: candidateAsset.id, name: candidate.name,
      ...(candidateAsset.parentId ? { parentId: candidateAsset.parentId } : {}),
      ...(candidateAsset.sourceRigProfile ? { sourceRigType: candidateAsset.sourceRigProfile.rigType } : {}),
      motionShapeSimilarityPercent: Math.round((1 - normalizedRmse) * 10_000) / 100,
      ...eventAlignment,
      evidenceQuality, evidenceLimitations,
      matchedJointCount: matchedJoints.length, queryJointCount: queryJoints.length, candidateJointCount: candidateJoints.length,
      jointCoverageFraction: matchedJoints.length / queryJoints.length,
      queryOnlyJoints: queryJoints.filter(joint => !candidateJointSet.has(joint)).slice(0, 64),
      candidateOnlyJoints: candidateJoints.filter(joint => !querySamplers.has(joint)).slice(0, 64),
      positionRmseStuds: evidenceCount ? Math.sqrt(positionSquaredSum / evidenceCount) : null,
      rotationRmseDegrees: evidenceCount ? Math.sqrt(rotationSquaredSum / evidenceCount) : null,
      durationRatio: candidate.duration / query.duration,
      durationDifferenceSeconds: Number((candidate.duration - query.duration).toFixed(4)),
      comparisonMode,
      sampledProgressPointCount: schedule.progress.length,
      authoredProgressPointCount: schedule.authoredProgressPointCount,
      sampledAuthoredProgressPointCount: schedule.sampledAuthoredProgressPointCount,
      omittedAuthoredProgressPointCount: schedule.omittedAuthoredProgressPointCount,
      comparedKeyProgressPointCount: schedule.comparedKeyProgressPointCount,
      sampledComparedKeyProgressPointCount: schedule.sampledComparedKeyProgressPointCount,
      omittedComparedKeyProgressPointCount: schedule.omittedComparedKeyProgressPointCount,
      eventProgressPointCount: schedule.eventProgressPointCount,
      sampledEventProgressPointCount: schedule.sampledEventProgressPointCount,
      omittedEventProgressPointCount: schedule.omittedEventProgressPointCount,
      candidateSourceJointCount: animationJoints(candidate).length,
      mappedJointPairs: mappedJointPairs.slice(0, 64), omittedMappedJointCount: Math.max(0, mappedJointPairs.length - 64),
      unmappedCandidateJoints: unmappedCandidateJoints.slice(0, 64), omittedUnmappedJointCount: Math.max(0, unmappedCandidateJoints.length - 64),
      unmappedActiveCandidateJoints: unmappedActiveCandidateJoints?.slice(0, 64) ?? null,
      omittedUnmappedActiveJointCount: unmappedActiveCandidateJoints ? Math.max(0, unmappedActiveCandidateJoints.length - 64) : null,
      unmappedInactiveCandidateJoints: unmappedInactiveCandidateJoints?.slice(0, 64) ?? null,
      omittedUnmappedInactiveJointCount: unmappedInactiveCandidateJoints ? Math.max(0, unmappedInactiveCandidateJoints.length - 64) : null,
      retargetedJointCoverageFraction,
      retargetedAuthoredJointCoverageFraction,
      ...(mappingWarning ? { mappingWarning } : {}),
      ...(mappingNextStep ? { mappingNextStep } : {}),
    });
  }
  return matches.sort((left, right) => right.motionShapeSimilarityPercent - left.motionShapeSimilarityPercent
    || right.jointCoverageFraction - left.jointCoverageFraction || compareOrdinal(left.name, right.name) || compareOrdinal(left.assetId, right.assetId)).slice(0, limit);
}
