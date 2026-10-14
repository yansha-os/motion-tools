import { z } from 'zod';
import { identifier, label, recipeSchema, type AnimationRecipe } from './recipes.js';

const boundedVector = (limit: number) => z.tuple([
  z.number().finite().min(-limit).max(limit),
  z.number().finite().min(-limit).max(limit),
  z.number().finite().min(-limit).max(limit),
]);

export const secondaryMotionSchema = z.object({
  layerName: label,
  startTime: z.number().finite().min(0).max(30),
  endTime: z.number().finite().min(0).max(30),
  cycles: z.number().finite().min(0.25).max(12),
  samplesPerCycle: z.number().int().min(8).max(32).default(12),
  envelope: z.enum(['windowed', 'damped']).default('damped'),
  damping: z.number().finite().min(0).max(12).default(3),
  joints: z.array(z.object({
    joint: label,
    rotationAmplitude: boundedVector(180).default([0, 0, 0]),
    positionAmplitude: boundedVector(10).default([0, 0, 0]),
    phaseDegrees: z.number().finite().min(-360).max(360).default(0),
    gain: z.number().finite().min(0).max(2).default(1),
  }).strict()).min(1).max(64),
}).strict().superRefine((input, ctx) => {
  if (input.startTime >= input.endTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'Secondary-motion endTime must be after startTime.' });
  if (new Set(input.joints.map(item => item.joint.toLowerCase())).size !== input.joints.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['joints'], message: 'Secondary-motion joint names must be unique, ignoring case.' });
  for (const [index, item] of input.joints.entries()) {
    if (item.gain > 0 && item.positionAmplitude.every(value => value === 0) && item.rotationAmplitude.every(value => value === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['joints', index], message: 'Each active secondary-motion joint needs a non-zero position or rotation amplitude.' });
    }
  }
});

export const secondaryMotionShape = {
  layerName: label,
  startTime: z.number().finite().min(0).max(30),
  endTime: z.number().finite().min(0).max(30),
  cycles: z.number().finite().min(0.25).max(12),
  samplesPerCycle: z.number().int().min(8).max(32).default(12),
  envelope: z.enum(['windowed', 'damped']).default('damped'),
  damping: z.number().finite().min(0).max(12).default(3),
  joints: z.array(z.object({
    joint: label,
    rotationAmplitude: boundedVector(180).default([0, 0, 0]),
    positionAmplitude: boundedVector(10).default([0, 0, 0]),
    phaseDegrees: z.number().finite().min(-360).max(360).default(0),
    gain: z.number().finite().min(0).max(2).default(1),
  }).strict()).min(1).max(64),
};

export type SecondaryMotionInput = z.infer<typeof secondaryMotionSchema>;

/** Create an additive, zero-at-boundaries motion layer without changing any source track. */
export function addSecondaryMotionLayer(source: AnimationRecipe, layerId: string, rawInput: unknown) {
  const recipe = recipeSchema.parse(structuredClone(source));
  if (recipe.kind !== 'animation') throw new Error('Secondary motion can only be added to an animation.');
  const input = secondaryMotionSchema.parse(rawInput);
  identifier.parse(layerId);
  if (input.endTime > recipe.duration) throw new Error(`Secondary-motion window ends at ${input.endTime}s, beyond the ${recipe.duration}s clip.`);
  if (input.startTime > 0 && input.startTime < 0.0001) throw new Error('Secondary-motion startTime is too close to the clip start to create distinct keys.');
  if (recipe.duration - input.endTime > 0 && recipe.duration - input.endTime < 0.0001) throw new Error('Secondary-motion endTime is too close to the clip end to create distinct keys.');
  if ((recipe.layers?.length ?? 0) >= 32) throw new Error('Animation already has the maximum of 32 pose layers.');
  if ((recipe.layers ?? []).some(layer => layer.id === layerId)) throw new Error(`Pose layer ${layerId} already exists in the source animation.`);

  const intervals = Math.max(2, Math.ceil(input.cycles * input.samplesPerCycle));
  const windowDuration = input.endTime - input.startTime;
  if (windowDuration / intervals <= 0.0001) throw new Error('Secondary-motion sample times would collide. Widen the time window or reduce cycles/samplesPerCycle.');
  const localTimes = Array.from({ length: intervals + 1 }, (_, index) => index === 0 ? input.startTime : index === intervals ? input.endTime : input.startTime + windowDuration * index / intervals);
  const layerTracks = input.joints.map(jointInput => {
    const times = [...new Set([0, recipe.duration, ...localTimes])].sort((left, right) => left - right);
    const phase = jointInput.phaseDegrees * Math.PI / 180;
    const keys = times.map(time => {
      const normalized = Math.max(0, Math.min(1, (time - input.startTime) / windowDuration));
      const inside = time >= input.startTime && time <= input.endTime;
      const envelope = !inside || normalized <= 0 || normalized >= 1 ? 0 : input.envelope === 'windowed'
        ? Math.sin(Math.PI * normalized) ** 2
        : Math.sin(Math.PI * normalized) * Math.exp(-input.damping * normalized);
      const wave = inside ? Math.sin(2 * Math.PI * input.cycles * normalized + phase) : 0;
      const scale = envelope * wave * jointInput.gain;
      const offset = (value: number) => { const result = value * scale; return result === 0 ? 0 : result; };
      return {
        time,
        position: jointInput.positionAmplitude.map(offset) as [number, number, number],
        rotation: jointInput.rotationAmplitude.map(offset) as [number, number, number],
        easingStyle: 'Linear' as const,
        easingDirection: 'Out' as const,
      };
    });
    if (keys.length > 128) throw new Error(`${jointInput.joint} secondary-motion lane would exceed the 128-key track limit.`);
    return { joint: jointInput.joint, keys };
  });

  const totalTracks = recipe.tracks.length + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.length, 0) + (recipe.rootMotion ? 1 : 0);
  const totalKeys = recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0)
    + (recipe.layers ?? []).reduce((sum, layer) => sum + layer.tracks.reduce((layerSum, track) => layerSum + track.keys.length, 0), 0)
    + (recipe.rootMotion?.keys.length ?? 0);
  if (totalTracks + layerTracks.length > 1024) throw new Error('Secondary motion would exceed the 1024-track animation limit.');
  if (totalKeys + layerTracks.reduce((sum, track) => sum + track.keys.length, 0) > 4096) throw new Error('Secondary motion would exceed the 4096-key animation limit.');

  recipe.layers ??= [];
  recipe.layers.push({ id: layerId, name: input.layerName, blendMode: 'Additive', weight: 1, enabled: true, tracks: layerTracks });
  const validated = recipeSchema.parse(recipe);
  if (validated.kind !== 'animation') throw new Error('Secondary-motion synthesis unexpectedly produced a non-animation recipe.');
  const peakPositionOffset = Math.max(0, ...layerTracks.flatMap(track => track.keys.map(key => Math.hypot(...key.position))));
  const peakRotationOffsetDegrees = Math.max(0, ...layerTracks.flatMap(track => track.keys.map(key => Math.hypot(...key.rotation))));
  return {
    recipe: validated,
    diagnostics: {
      layerId, layerName: input.layerName, blendMode: 'Additive' as const,
      startTime: input.startTime, endTime: input.endTime, cycles: input.cycles, intervals,
      envelope: input.envelope, damping: input.envelope === 'damped' ? input.damping : null,
      joints: input.joints.map(item => item.joint), generatedTracks: layerTracks.length,
      generatedKeys: layerTracks.reduce((sum, track) => sum + track.keys.length, 0),
      peakLocalPositionOffsetStuds: Math.round(peakPositionOffset * 1e6) / 1e6,
      peakLocalRotationOffsetDegrees: Math.round(peakRotationOffsetDegrees * 1e6) / 1e6,
      boundaryOffsetsAreZero: layerTracks.every(track => track.keys.filter(key => key.time === input.startTime || key.time === input.endTime || key.time === 0 || key.time === recipe.duration).every(key => key.position.every(value => value === 0) && key.rotation.every(value => value === 0))),
      notes: ['The additive layer preserves the base animation tracks and is zero outside its authored time window.', 'Motion is synthesized in local joint coordinates; amplitude axes and rig-specific visual quality require a Studio preview.'],
    },
  };
}
