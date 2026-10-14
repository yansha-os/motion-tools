import { z } from 'zod';

export const contactBakeEffectorSchema = z.enum(['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']);
export const contactBakeRateSchema = z.union([z.literal(15), z.literal(30), z.literal(60)]);

const contactWindowSchema = z.object({
  effector: contactBakeEffectorSchema,
  kind: z.enum(['support', 'grip']),
  start: z.number().finite().min(0).max(30),
  end: z.number().finite().min(0).max(30),
  contactIndex: z.number().int().min(0).max(15).optional(),
}).strict();

export const contactBakePlanInputSchema = z.object({
  contacts: z.array(contactWindowSchema).min(1).max(16),
  sampleRateHz: contactBakeRateSchema,
  duration: z.number().finite().min(0.1).max(30),
  authoredTimes: z.array(z.number().finite().min(0).max(30)).max(4096).default([]),
  maximumSamples: z.number().int().min(1).max(128).default(128),
}).strict();

export type ContactBakePlanInput = z.input<typeof contactBakePlanInputSchema>;
export type ContactBakePlan = {
  windows: { index: number; effector: z.infer<typeof contactBakeEffectorSchema>; kind: 'support' | 'grip'; start: number; end: number }[];
  samples: { time: number; windowIndices: number[] }[];
  sampleRateHz: 15 | 30 | 60;
  maximumSamples: number;
};

const redundantGridToleranceSeconds = 0.0001;

/** Build a bounded, deterministic schedule for all selected contact windows. */
export function planContactBake(input: unknown): ContactBakePlan {
  const plan = contactBakePlanInputSchema.parse(input);
  const windows = plan.contacts.map((contact, index) => ({ ...contact, index: contact.contactIndex ?? index }));
  if (new Set(windows.map(window => window.index)).size !== windows.length) throw new Error('Contact indices must be unique within a bake request.');
  for (const window of windows) {
    if (window.start >= window.end || window.end > plan.duration) {
      throw new Error(`${window.effector} contact ${window.index + 1} must have positive duration inside the animation.`);
    }
  }

  for (const effector of new Set(windows.map(window => window.effector))) {
    const ordered = windows.filter(window => window.effector === effector).sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index]!.start < ordered[index - 1]!.end) {
        throw new Error(`${effector} contact windows overlap; one effector cannot be locked to two targets at once.`);
      }
    }
  }

  const requiredTimes = new Set<number>();
  const generatedTimes: number[] = [];
  for (const window of windows) {
    const steps = Math.ceil((window.end - window.start) * plan.sampleRateHz);
    if (steps + 1 > plan.maximumSamples) {
      throw new Error(`${window.effector} contact ${window.index + 1} exceeds the ${plan.maximumSamples}-sample limit; lower sampleRateHz or shorten the window.`);
    }
    requiredTimes.add(window.start);
    requiredTimes.add(window.end);
    for (const time of plan.authoredTimes) if (time > window.start && time < window.end) requiredTimes.add(time);
    for (let index = 1; index < steps; index++) generatedTimes.push(window.start + (window.end - window.start) * index / steps);
  }

  const orderedRequiredTimes = [...requiredTimes].sort((left, right) => left - right);
  const uniqueGridTimes: number[] = [];
  generatedTimes.sort((left, right) => left - right);
  for (const time of generatedTimes) {
    if (orderedRequiredTimes.some(required => Math.abs(required - time) <= redundantGridToleranceSeconds)) continue;
    if (!uniqueGridTimes.length || Math.abs(time - uniqueGridTimes.at(-1)!) > redundantGridToleranceSeconds) uniqueGridTimes.push(time);
  }
  const uniqueTimes = [...orderedRequiredTimes, ...uniqueGridTimes].sort((left, right) => left - right);
  if (uniqueTimes.length > plan.maximumSamples) {
    throw new Error(`The combined contact bake needs ${uniqueTimes.length} samples; maximum is ${plan.maximumSamples}. Lower sampleRateHz or select fewer contacts.`);
  }

  const samples = uniqueTimes.map(time => {
    const active = windows.filter(window => time >= window.start && time <= window.end);
    const byEffector = new Map<string, typeof active[number]>();
    for (const window of active) {
      const current = byEffector.get(window.effector);
      // At abutting windows, the new window owns the shared boundary. Its anchor
      // is captured from the already-solved pose, so the endpoint remains continuous.
      if (!current || window.start > current.start || (window.start === current.start && window.index > current.index)) {
        byEffector.set(window.effector, window);
      }
    }
    const windowIndices = [...byEffector.values()].map(window => window.index).sort((left, right) => left - right);
    if (windowIndices.length > 4) throw new Error(`The bake has ${windowIndices.length} simultaneous effectors at ${time}s; Studio supports at most four.`);
    return { time, windowIndices };
  });

  return { windows, samples, sampleRateHz: plan.sampleRateHz, maximumSamples: plan.maximumSamples };
}
