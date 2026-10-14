import { z } from 'zod';
import type { AnimationRecipe, VfxRecipe } from './recipes.js';

const markerName = z.string().min(1).max(80).refine(value => value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), 'Names cannot be blank or contain control characters.');

export const previewCueInputSchema = z.object({
  assetId: z.string().uuid(),
  part: markerName,
  time: z.number().finite().min(0).max(30).optional(),
  marker: markerName.optional(),
  occurrence: z.number().int().min(1).max(100).optional(),
  offset: z.number().finite().min(-30).max(30).optional(),
}).strict().superRefine((cue, context) => {
  const hasTime = cue.time !== undefined;
  const hasMarker = cue.marker !== undefined;
  if (hasTime === hasMarker) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Specify exactly one cue time or marker name.' });
  if (hasTime && (cue.occurrence !== undefined || cue.offset !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Occurrence and offset are valid only for marker-relative cues.' });
  }
});

export type PreviewCueInput = z.infer<typeof previewCueInputSchema>;

export type ResolvedPreviewCue = {
  part: string;
  time: number;
  recipe: VfxRecipe;
  sourceMarker?: { name: string; occurrence: number; offset: number };
};

export function resolvePreviewCueTime(cue: PreviewCueInput, animation: AnimationRecipe | undefined, seconds: number): number {
  let time: number;
  if (cue.time !== undefined) {
    time = cue.time;
  } else {
    if (!animation) throw new Error(`VFX cue marker "${cue.marker}" requires an animationId.`);
    const occurrence = cue.occurrence ?? 1;
    const matches = animation.markers.filter(marker => marker.name === cue.marker);
    const marker = matches[occurrence - 1];
    if (!marker) throw new Error(`Animation marker "${cue.marker}" occurrence ${occurrence} was not found.`);
    time = Math.round((marker.time + (cue.offset ?? 0)) * 1_000_000) / 1_000_000;
    if (time < 0) throw new Error(`VFX cue relative to marker "${cue.marker}" resolves before the start of the animation.`);
  }
  if (time >= seconds) throw new Error(`Effect cue time ${time} must be earlier than the preview duration (${seconds}s).`);
  if (animation && time >= animation.duration) throw new Error(`Effect cue time ${time} must fall inside the animation duration (${animation.duration}s).`);
  return time;
}
