import type { AnimationRecipe } from './recipes.js';

export type AnimationPhaseLabel = 'unclassified' | 'anticipation' | 'main_action' | 'follow_through' | 'recovery' | 'unsegmented';
export type ActionPhaseWindow = {
  label: AnimationPhaseLabel;
  occurrence: number;
  startTime: number;
  endTime: number;
  boundaryMarkers: string[];
  endingMarkers: string[];
  boundaryLabels: Exclude<AnimationPhaseLabel, 'unclassified' | 'unsegmented'>[];
};

function phaseLabelForMarker(name: string): Exclude<AnimationPhaseLabel, 'unclassified' | 'unsegmented'> | null {
  if (/(^|[^a-z])(anticipation|wind.?up|preparation|prepare)([^a-z]|$)/i.test(name)) return 'anticipation';
  if (/(^|[^a-z])(main.?action|action|attack|strike|impact|release|cast)([^a-z]|$)/i.test(name)) return 'main_action';
  if (/(^|[^a-z])(follow.?through|followthrough)([^a-z]|$)/i.test(name)) return 'follow_through';
  if (/(^|[^a-z])(recovery|recover|settle|return)([^a-z]|$)/i.test(name)) return 'recovery';
  return null;
}

function phaseLabelForExplicitClassification(phase: AnimationRecipe['markers'][number]['phase']): Exclude<AnimationPhaseLabel, 'unclassified' | 'unsegmented'> | null | undefined {
  if (phase === undefined) return undefined;
  if (phase === 'event') return null;
  return phase;
}

export function extractActionPhaseWindows(recipe: Pick<AnimationRecipe, 'duration' | 'markers'>): { source: 'named_markers' | 'unsegmented'; phases: ActionPhaseWindow[] } {
  const phaseMarkers = recipe.markers.flatMap(marker => {
    const explicitLabel = phaseLabelForExplicitClassification(marker.phase);
    const label = explicitLabel === undefined ? phaseLabelForMarker(marker.name) : explicitLabel;
    return label ? [{ time: marker.time, label, name: marker.name }] : [];
  }).sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  if (!phaseMarkers.length) return { source: 'unsegmented', phases: [{ label: 'unsegmented', occurrence: 1, startTime: 0, endTime: recipe.duration, boundaryMarkers: [], endingMarkers: [], boundaryLabels: [] }] };
  const boundaryMap = new Map<number, { labels: AnimationPhaseLabel[]; markers: string[] }>();
  boundaryMap.set(0, { labels: [], markers: [] });
  boundaryMap.set(recipe.duration, { labels: [], markers: [] });
  for (const marker of phaseMarkers) {
    const boundary = boundaryMap.get(marker.time) ?? { labels: [], markers: [] };
    if (!boundary.labels.includes(marker.label)) boundary.labels.push(marker.label);
    boundary.markers.push(marker.name);
    boundaryMap.set(marker.time, boundary);
  }
  const occurrences = new Map<string, number>();
  const times = [...boundaryMap.keys()].sort((a, b) => a - b);
  const phases = times.slice(0, -1).flatMap((startTime, index) => {
    const endTime = times[index + 1]!;
    if (endTime <= startTime) return [];
    const startBoundary = boundaryMap.get(startTime)!;
    const endBoundary = boundaryMap.get(endTime)!;
    const labels = startBoundary.labels;
    const label = labels.length === 1 ? labels[0]! : 'unclassified' as const;
    const occurrence = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, occurrence);
    return [{ label, occurrence, startTime, endTime, boundaryMarkers: startBoundary.markers,
      endingMarkers: endBoundary.markers, boundaryLabels: labels as ActionPhaseWindow['boundaryLabels'] }];
  });
  return { source: 'named_markers', phases };
}
