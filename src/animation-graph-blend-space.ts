import { z } from 'zod';

export const animationGraphBlendSpace1DSampleSchema = z.object({
  value: z.number().finite(),
  stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
}).strict();

export const animationGraphBlendSpace1DSchema = z.object({
  parameter: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  samples: z.array(animationGraphBlendSpace1DSampleSchema).min(2).max(16),
}).strict().superRefine((blendSpace, context) => {
  for (let index = 1; index < blendSpace.samples.length; index++) {
    if (blendSpace.samples[index]!.value <= blendSpace.samples[index - 1]!.value) {
      context.addIssue({ code: 'custom', path: ['samples', index, 'value'],
        message: 'BlendSpace1D sample values must be strictly increasing; reorder the samples and remove duplicate values.' });
    }
  }
});

export type AnimationGraphBlendSpace1D = z.infer<typeof animationGraphBlendSpace1DSchema>;

type BlendWeight = { stateId: string; value: number; weight: number };

function interpolationAlpha(value: number, left: number, right: number): number {
  const span = right - left;
  if (Number.isFinite(span)) return (value - left) / span;
  const scale = Math.max(Math.abs(value), Math.abs(left), Math.abs(right));
  return (value / scale - left / scale) / (right / scale - left / scale);
}

/** Returns the adjacent-clip linear weights for a parameter, clamping outside the authored range. */
export function sampleAnimationGraphBlendSpace1D(blendSpaceInput: unknown, parameterValueInput: unknown) {
  const blendSpace = animationGraphBlendSpace1DSchema.parse(blendSpaceInput);
  const parameterValue = z.number().finite().parse(parameterValueInput);
  const samples = blendSpace.samples;
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const clampedValue = Math.max(first.value, Math.min(last.value, parameterValue));
  const clamped = clampedValue !== parameterValue;
  const weights: BlendWeight[] = samples.map(sample => ({ stateId: sample.stateId, value: sample.value, weight: 0 }));

  if (clampedValue === first.value) weights[0]!.weight = 1;
  else if (clampedValue === last.value) weights[weights.length - 1]!.weight = 1;
  else {
    let upperIndex = 1;
    while (upperIndex < samples.length && samples[upperIndex]!.value < clampedValue) upperIndex++;
    const upper = samples[upperIndex]!;
    if (upper.value === clampedValue) weights[upperIndex]!.weight = 1;
    else {
      const lowerIndex = upperIndex - 1;
      const lower = samples[lowerIndex]!;
      const upperWeight = Math.max(0, Math.min(1, interpolationAlpha(clampedValue, lower.value, upper.value)));
      weights[lowerIndex]!.weight = 1 - upperWeight;
      weights[upperIndex]!.weight = upperWeight;
    }
  }

  return { parameter: blendSpace.parameter, parameterValue, sampledValue: clampedValue, clamped,
    lowerSample: weights.find(sample => sample.weight > 0)?.stateId ?? first.stateId,
    upperSample: [...weights].reverse().find(sample => sample.weight > 0)?.stateId ?? first.stateId,
    weights, totalWeight: weights.reduce((sum, sample) => sum + sample.weight, 0),
    method: 'adjacent_linear_interpolation' as const,
    limitation: 'This computes parameter-to-clip weights only. It does not sample animation time, compose local poses, apply AnimationPriority, or reproduce Roblox runtime blend-space behavior.' };
}
