export type BlendPhaseSynchronizationPair = { stateIds: [string, string]; circularDifference: number };
export type BlendPhaseSynchronizationResult = {
  maxCircularPhaseDifference: number | null;
  worstAt: number | null;
  worstPair: BlendPhaseSynchronizationPair | null;
  worstInterval: { startAt: number; endAt: number } | null;
  controllerActiveSampleCount: number;
  comparableSampleCount: number;
  incompleteSampleCount: number;
  controllerActiveIntervalCount: number;
  incompleteIntervalCount: number;
  unevaluableIntervalCount: number;
  interpolatedIntervalCount: number;
  coverageStatus: 'not_observed' | 'incomplete' | 'complete';
};

type BlendPhaseSource = { stateId: string; playback: { normalizedPhase: number; playbackSpeed: number; isPlaying: boolean } };
type BlendPhaseEvaluation = { controllerStateId: string; samples: BlendPhaseSource[] };
type BlendPhaseTimelineSample = { at: number; blendSpaceEvaluations: BlendPhaseEvaluation[] };
type IndexedBlendPhaseEvaluation = { samples: ReadonlyMap<string, BlendPhaseSource> };
type IndexedBlendPhaseTimelineSample = { at: number; evaluations: ReadonlyMap<string, IndexedBlendPhaseEvaluation> };
export type BlendPhaseSynchronizationRequest = { controllerStateId: string; sourceStateIds: readonly string[];
  sourceDurations: ReadonlyMap<string, number | undefined> };

const circularDistance = (difference: number): number => {
  const wrapped = ((difference % 1) + 1) % 1;
  return Math.min(wrapped, 1 - wrapped);
};
const isNormalizedPhase = (phase: number) => Number.isFinite(phase) && phase >= 0 && phase < 1;
const phaseClockMatchesPrediction = (startPhase: number, endPhase: number, phaseRate: number, intervalSeconds: number) => {
  const predictedEndPhase = startPhase + phaseRate * intervalSeconds;
  if (!Number.isFinite(predictedEndPhase)) return false;
  const numericalTolerance = 64 * Number.EPSILON * Math.max(1, Math.abs(predictedEndPhase), Math.abs(endPhase));
  return circularDistance(predictedEndPhase - endPhase) <= numericalTolerance;
};

function indexPhaseSamples(samples: readonly BlendPhaseTimelineSample[]): IndexedBlendPhaseTimelineSample[] {
  if (samples.some(sample => !Number.isFinite(sample.at))) throw new Error('Phase synchronization sample times must be finite.');
  const orderedSamples = [...samples].sort((left, right) => left.at - right.at);
  if (orderedSamples.some((sample, index) => index > 0 && sample.at === orderedSamples[index - 1]!.at)) {
    throw new Error('Phase synchronization sample times must be unique.');
  }
  return orderedSamples.map(sample => {
    const evaluations = new Map<string, IndexedBlendPhaseEvaluation>();
    for (const evaluation of sample.blendSpaceEvaluations) {
      if (evaluations.has(evaluation.controllerStateId)) {
        throw new Error(`Phase synchronization sample contains duplicate controller evaluation '${evaluation.controllerStateId}'.`);
      }
      const sources = new Map<string, BlendPhaseSource>();
      for (const source of evaluation.samples) {
        if (sources.has(source.stateId)) {
          throw new Error(`Phase synchronization evaluation '${evaluation.controllerStateId}' contains duplicate source state '${source.stateId}'.`);
        }
        sources.set(source.stateId, source);
      }
      evaluations.set(evaluation.controllerStateId, { samples: sources });
    }
    return { at: sample.at, evaluations };
  });
}

/** Measures the largest wrap-safe phase drift at sampled points and across constant-speed clock intervals. */
function analyzeIndexedBlendSpacePhaseSynchronization(samples: readonly IndexedBlendPhaseTimelineSample[], controllerStateId: string,
  sourceStateIds: readonly string[], sourceDurations: ReadonlyMap<string, number | undefined>): BlendPhaseSynchronizationResult {
  if (sourceStateIds.length < 2 || new Set(sourceStateIds).size !== sourceStateIds.length) {
    throw new Error('Phase synchronization analysis requires at least two unique source state IDs.');
  }
  const orderedSourceStateIds = [...sourceStateIds].sort();
  const orderedSamples = samples;
  let maxCircularPhaseDifference: number | null = null;
  let worstAt: number | null = null;
  let worstPair: BlendPhaseSynchronizationPair | null = null;
  let worstInterval: { startAt: number; endAt: number } | null = null;
  let controllerActiveSampleCount = 0;
  let comparableSampleCount = 0;
  let incompleteSampleCount = 0;
  let controllerActiveIntervalCount = 0;
  let incompleteIntervalCount = 0;
  let unevaluableIntervalCount = 0;
  let interpolatedIntervalCount = 0;
  const recordWorst = (difference: number, at: number, pair: BlendPhaseSynchronizationPair,
    interval: { startAt: number; endAt: number } | null) => {
    const pairKey = pair.stateIds.join('\u0000');
    const currentPairKey = worstPair?.stateIds.join('\u0000');
    const isGreater = maxCircularPhaseDifference === null || difference > maxCircularPhaseDifference;
    const isEarlierTie = difference === maxCircularPhaseDifference && (worstAt === null || at < worstAt
      || (at === worstAt && currentPairKey !== undefined && pairKey < currentPairKey));
    if (!isGreater && !isEarlierTie) return;
    maxCircularPhaseDifference = difference;
    worstAt = at;
    worstPair = pair;
    worstInterval = interval;
  };

  for (const sample of orderedSamples) {
    const evaluation = sample.evaluations.get(controllerStateId);
    if (!evaluation) continue;
    controllerActiveSampleCount++;
    const sources = orderedSourceStateIds.map(stateId => evaluation.samples.get(stateId));
    if (sources.some(source => !source || !source.playback.isPlaying || !isNormalizedPhase(source.playback.normalizedPhase))) {
      incompleteSampleCount++;
      continue;
    }
    comparableSampleCount++;
    let sampleMaximum = 0;
    let sampleWorstPair: BlendPhaseSynchronizationPair | null = null;
    for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
      const circularDifference = circularDistance(sources[left]!.playback.normalizedPhase - sources[right]!.playback.normalizedPhase);
      if (sampleWorstPair === null || circularDifference > sampleMaximum) {
        sampleMaximum = circularDifference;
        sampleWorstPair = { stateIds: [orderedSourceStateIds[left]!, orderedSourceStateIds[right]!], circularDifference };
      }
    }
    if (sampleWorstPair) recordWorst(sampleMaximum, sample.at, sampleWorstPair, null);
  }

  for (let index = 1; index < orderedSamples.length; index++) {
    const start = orderedSamples[index - 1]!;
    const end = orderedSamples[index]!;
    const intervalSeconds = end.at - start.at;
    if (intervalSeconds <= 0) continue;
    const startEvaluation = start.evaluations.get(controllerStateId);
    const endEvaluation = end.evaluations.get(controllerStateId);
    if (!startEvaluation || !endEvaluation) continue;
    controllerActiveIntervalCount++;
    const startSources = orderedSourceStateIds.map(stateId => startEvaluation.samples.get(stateId));
    const endSources = orderedSourceStateIds.map(stateId => endEvaluation.samples.get(stateId));
    const validClock = (source: BlendPhaseSource | undefined) => source !== undefined
      && source.playback.isPlaying && isNormalizedPhase(source.playback.normalizedPhase)
      && Number.isFinite(source.playback.playbackSpeed);
    if (startSources.some(source => !validClock(source)) || endSources.some(source => !validClock(source))) {
      incompleteIntervalCount++;
      continue;
    }
    const durations = orderedSourceStateIds.map(stateId => sourceDurations.get(stateId));
    if (durations.some(duration => duration === undefined || !Number.isFinite(duration) || duration <= 0)) {
      unevaluableIntervalCount++;
      continue;
    }
    const phaseClocksMatch = orderedSourceStateIds.every((_, sourceIndex) => {
      const startSource = startSources[sourceIndex]!;
      const endSource = endSources[sourceIndex]!;
      return phaseClockMatchesPrediction(startSource.playback.normalizedPhase, endSource.playback.normalizedPhase,
        startSource.playback.playbackSpeed / durations[sourceIndex]!, intervalSeconds);
    });
    if (!phaseClocksMatch) {
      unevaluableIntervalCount++;
      continue;
    }
    let intervalUnevaluable = false;
    for (let left = 0; left < orderedSourceStateIds.length; left++) for (let right = left + 1; right < orderedSourceStateIds.length; right++) {
      const leftStart = startSources[left]!;
      const rightStart = startSources[right]!;
      const relativePhaseRate = leftStart.playback.playbackSpeed / durations[left]!
        - rightStart.playback.playbackSpeed / durations[right]!;
      if (!Number.isFinite(relativePhaseRate)) {
        intervalUnevaluable = true;
        continue;
      }
      const initialDifference = leftStart.playback.normalizedPhase - rightStart.playback.normalizedPhase;
      const finalDifference = initialDifference + relativePhaseRate * intervalSeconds;
      if (!Number.isFinite(finalDifference)) {
        intervalUnevaluable = true;
        continue;
      }
      const endpointDifferences = [circularDistance(initialDifference), circularDistance(finalDifference)];
      let intervalMaximum = Math.max(...endpointDifferences);
      let intervalWorstAt = intervalMaximum === endpointDifferences[0] ? start.at : end.at;
      const lowerDifference = Math.min(initialDifference, finalDifference);
      const upperDifference = Math.max(initialDifference, finalDifference);
      const halfCycleDifference = Math.ceil(lowerDifference - 0.5) + 0.5;
      if (relativePhaseRate !== 0 && halfCycleDifference >= lowerDifference - 1e-12
        && halfCycleDifference <= upperDifference + 1e-12) {
        intervalMaximum = 0.5;
        const crossingAt = start.at + (halfCycleDifference - initialDifference) / relativePhaseRate;
        intervalWorstAt = Math.max(start.at, Math.min(end.at, crossingAt));
      }
      recordWorst(intervalMaximum, intervalWorstAt,
        { stateIds: [orderedSourceStateIds[left]!, orderedSourceStateIds[right]!], circularDifference: intervalMaximum },
        { startAt: start.at, endAt: end.at });
    }
    if (intervalUnevaluable) unevaluableIntervalCount++;
    else interpolatedIntervalCount++;
  }

  const coverageStatus = controllerActiveSampleCount === 0 ? 'not_observed'
    : incompleteSampleCount > 0 || incompleteIntervalCount > 0 || unevaluableIntervalCount > 0
      || interpolatedIntervalCount === 0 || interpolatedIntervalCount !== controllerActiveIntervalCount ? 'incomplete' : 'complete';
  return { maxCircularPhaseDifference, worstAt, worstPair, worstInterval,
    controllerActiveSampleCount, comparableSampleCount, incompleteSampleCount,
    controllerActiveIntervalCount, incompleteIntervalCount, unevaluableIntervalCount, interpolatedIntervalCount, coverageStatus };
}

/** Indexes and sorts one shared simulator trace once, then analyzes every controller against it. */
export function analyzeBlendSpacePhaseSynchronizationBatch(samples: readonly BlendPhaseTimelineSample[],
  requests: readonly BlendPhaseSynchronizationRequest[]): BlendPhaseSynchronizationResult[] {
  if (requests.length === 0) return [];
  const indexedSamples = indexPhaseSamples(samples);
  return requests.map(request => analyzeIndexedBlendSpacePhaseSynchronization(indexedSamples, request.controllerStateId,
    request.sourceStateIds, request.sourceDurations));
}

export function analyzeBlendSpacePhaseSynchronization(samples: readonly BlendPhaseTimelineSample[], controllerStateId: string,
  sourceStateIds: readonly string[], sourceDurations: ReadonlyMap<string, number | undefined>): BlendPhaseSynchronizationResult {
  return analyzeBlendSpacePhaseSynchronizationBatch(samples, [{ controllerStateId, sourceStateIds, sourceDurations }])[0]!;
}
