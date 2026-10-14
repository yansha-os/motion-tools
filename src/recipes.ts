import { z } from 'zod';

export const label = z.string().min(1).max(80).refine(s => s.trim().length > 0 && !/[\u0000-\u001f]/.test(s), 'Names cannot be blank or contain control characters.');
export const identifier = z.string().uuid();
export const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const poseEasingStyle = z.enum(['Linear', 'Constant', 'CubicV2', 'Bounce', 'Elastic', 'Bezier']);
export const poseEasingDirection = z.enum(['In', 'Out', 'InOut']);
export const bezierCurve = z.object({
  outTime: z.number().finite().min(0).max(1), outValue: z.number().finite().min(-1).max(2),
  inTime: z.number().finite().min(0).max(1), inValue: z.number().finite().min(-1).max(2),
}).strict().refine(curve => curve.outTime <= curve.inTime, 'Bezier time handles must remain ordered.');
const boundedVector = (limit: number) => z.tuple([0, 1, 2].map(() => z.number().finite().min(-limit).max(limit)) as [z.ZodNumber, z.ZodNumber, z.ZodNumber]);
const key = z.object({
  time: z.number().finite().min(0).max(30), position: boundedVector(100).default([0, 0, 0]), rotation: boundedVector(720),
  easingStyle: poseEasingStyle.optional().describe('Outgoing segment interpolation. Omitted means Linear for legacy recipe compatibility.'),
  easingDirection: poseEasingDirection.optional().describe('Pose easing direction for the outgoing segment. Omitted means Out.'),
  curve: bezierCurve.optional().describe('Optional normalized cubic Bezier control points for the outgoing segment. X is time progress and Y is pose progress; used when easingStyle is Bezier.'),
}).strict();
export const animationTrack = z.object({ joint: label, keys: z.array(key).min(2).max(128) }).strict();
export const contactConstraint = z.object({
  effector: label,
  kind: z.enum(['support', 'grip']),
  start: z.number().finite().min(0).max(30),
  end: z.number().finite().min(0).max(30),
}).strict();
export const animationMarker = z.object({
  name: label,
  time: z.number().finite().min(0).max(30),
  value: z.string().max(500).optional(),
  phase: z.enum(['anticipation', 'main_action', 'follow_through', 'recovery', 'event']).optional()
    .describe('Motion Tools-only phase classification. Use event to prevent a marker named Impact/Release/etc. from being treated as a phase boundary. Omitted retains legacy name inference. This metadata is not written to native Roblox KeyframeMarker objects.'),
}).strict();
export const animationLayer = z.object({
  id: identifier,
  name: label,
  blendMode: z.enum(['Override', 'Additive']),
  weight: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  tracks: z.array(animationTrack).max(256),
}).strict();
export const animationSchema = z.object({
  kind: z.literal('animation'), name: label, duration: z.number().finite().min(0.1).max(30), loop: z.boolean(),
  priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']).optional(),
  tracks: z.array(animationTrack).min(1).max(256),
  rootMotion: animationTrack.optional().describe('Dedicated authored root travel channel. It composes additively with the matching base pose track and is measured separately from limb articulation.'),
  contacts: z.array(contactConstraint).max(16).optional().describe('Declared planted-foot/support or hand/grip intervals. These are review constraints, not automatic IK locks.'),
  layers: z.array(animationLayer).max(32).optional().describe('Ordered, non-destructive pose layers. Additive layers apply weighted local offsets; Override layers blend toward their sampled local pose.'),
  markers: z.array(animationMarker).max(100).default([]),
}).strict();
export const vfxSchema = z.object({
  kind: z.literal('vfx'), name: label,
  color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  size: z.number().finite().min(0.05).max(10), lifetime: z.number().finite().min(0.05).max(10),
  speed: z.number().finite().min(0).max(50), count: z.number().int().min(1).max(500),
  rate: z.number().finite().min(0).max(200).default(0),
  spread: z.number().finite().min(0).max(180).default(30),
  lightEmission: z.number().finite().min(0).max(1).default(0.7),
  offset: boundedVector(20).default([0, 0, 0]),
  texture: z.string().regex(/^rbxassetid:\/\/\d+$/).optional(),
  beam: z.object({ length: z.number().finite().min(0.1).max(100) }).strict().optional()
    .describe('Render a straight laser along local -Z instead of particles. Size is width and lifetime is preview duration.'),
  column: z.object({
    length: z.number().finite().min(0.1).max(100),
    travelTime: z.number().finite().min(0.05).max(5),
    fadeTime: z.number().finite().min(0.05).max(2).default(0.25),
    origin: z.enum(['attachment', 'hands']).default('attachment'),
  }).strict().optional().describe('Growing 3D energy column along local -Z. Size is diameter; lifetime includes travel, hold, and fade.'),
}).strict();
export const recipeSchema = z.discriminatedUnion('kind', [animationSchema, vfxSchema]).superRefine((recipe, ctx) => {
  if (recipe.kind === 'vfx') {
    if (recipe.beam && recipe.column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose beam or column, not both.' });
    if (recipe.column && recipe.column.travelTime + recipe.column.fadeTime >= recipe.lifetime) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Column lifetime must leave a hold interval after travel and before fade.' });
    return;
  }
  if (recipe.kind !== 'animation') return;
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (recipe.tracks.length > 256) issue('At most 256 joint tracks.');
  if (new Set(recipe.tracks.map(t => t.joint)).size !== recipe.tracks.length) issue('Each joint must have exactly one track.');
  const allTracks = [...recipe.tracks, ...(recipe.layers ?? []).flatMap(layer => layer.tracks)];
  if (allTracks.reduce((n, t) => n + t.keys.length, 0) + (recipe.rootMotion?.keys.length ?? 0) > 4096) issue('At most 4096 total keys across base tracks, layers and root motion.');
  if (allTracks.length + (recipe.rootMotion ? 1 : 0) > 1024) issue('At most 1024 total joint tracks across the base animation, layers and root motion.');
  if (new Set((recipe.layers ?? []).map(layer => layer.id)).size !== (recipe.layers ?? []).length) issue('Layer IDs must be unique.');
  for (const layer of recipe.layers ?? []) {
    if (new Set(layer.tracks.map(t => t.joint)).size !== layer.tracks.length) issue(`${layer.name}: each layer may have only one track per joint.`);
    if (layer.tracks.length > 256) issue(`${layer.name}: at most 256 joint tracks per layer.`);
  }
  for (const track of allTracks) {
    if (track.keys[0]!.time !== 0 || track.keys.at(-1)!.time !== recipe.duration) issue(`${track.joint}: keys must span 0 to duration.`);
    for (let i = 1; i < track.keys.length; i++) if (track.keys[i]!.time <= track.keys[i - 1]!.time) issue(`${track.joint}: times must increase strictly.`);
    if (recipe.loop && (JSON.stringify(track.keys[0]!.rotation) !== JSON.stringify(track.keys.at(-1)!.rotation) || JSON.stringify(track.keys[0]!.position) !== JSON.stringify(track.keys.at(-1)!.position))) issue(`${track.joint}: loop end pose must match its start.`);
  }
  if (recipe.rootMotion) {
    const root = recipe.rootMotion;
    if (root.keys[0]!.time !== 0 || root.keys.at(-1)!.time !== recipe.duration) issue(`${root.joint}: root-motion keys must span 0 to duration.`);
    for (let i = 1; i < root.keys.length; i++) if (root.keys[i]!.time <= root.keys[i - 1]!.time) issue(`${root.joint}: root-motion times must increase strictly.`);
    if (root.keys.some(entry => entry.position.some(value => Math.abs(value) > 100))) issue('Root-motion position components cannot exceed 100 studs.');
  }
  const contacts = recipe.contacts ?? [];
  for (const contact of contacts) if (contact.start >= contact.end || contact.end > recipe.duration) issue(`${contact.effector}: contact interval must increase and stay within the animation.`);
  for (const effector of new Set(contacts.map(contact => contact.effector))) {
    const ranges = contacts.filter(contact => contact.effector === effector).sort((a, b) => a.start - b.start);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) issue(`${effector}: contact intervals cannot overlap.`);
  }
  if (recipe.markers.some(m => m.time > recipe.duration)) issue('Markers must fall within the animation duration.');
});
export type AnimationRecipe = z.infer<typeof animationSchema>;
export type VfxRecipe = z.infer<typeof vfxSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export const motionPreset = z.enum(['idle', 'walk', 'cast', 'slash']);
export const effectPreset = z.enum(['charge', 'impact', 'heal']);
type Triple = [number, number, number];

export function animationPreset(preset: z.infer<typeof motionPreset>, name: string, duration: number, intensity: number): AnimationRecipe {
  const tracks: AnimationRecipe['tracks'] = [];
  const track = (joint: string, poses: Triple[]) => tracks.push({ joint, keys: poses.map((r, i) => ({ time: duration * i / (poses.length - 1), position: [0, 0, 0], rotation: r.map(n => n * intensity) as Triple })) });
  const x = (values: number[]): Triple[] => values.map(n => [n, 0, 0]);
  if (preset === 'idle') {
    track('UpperTorso', x([0, 1.5, 0, -1, 0]));
    track('Head', x([0, -1, 0, 0.5, 0]));
  } else if (preset === 'walk') {
    track('LeftUpperLeg', x([25, 0, -25, 0, 25]));
    track('RightUpperLeg', x([-25, 0, 25, 0, -25]));
    track('LeftLowerLeg', x([0, 25, 8, 0, 0]));
    track('RightLowerLeg', x([8, 0, 0, 25, 8]));
    track('LeftUpperArm', x([-20, 0, 20, 0, -20]));
    track('RightUpperArm', x([20, 0, -20, 0, 20]));
  } else if (preset === 'cast') {
    track('LeftUpperArm', [[0, 0, 0], [-45, -15, -15], [-70, -10, -10], [-95, 0, 0], [0, 0, 0]]);
    track('RightUpperArm', [[0, 0, 0], [-45, 15, 15], [-70, 10, 10], [-95, 0, 0], [0, 0, 0]]);
    track('UpperTorso', x([0, 8, 10, -8, 0]));
  } else {
    track('RightUpperArm', [[0, 0, 0], [-110, 0, 35], [-40, -35, -25], [10, 0, -30], [0, 0, 0]]);
    track('UpperTorso', [[0, 0, 0], [0, 25, 0], [5, -30, 0], [0, -15, 0], [0, 0, 0]]);
  }
  return recipeSchema.parse({ kind: 'animation', name, duration, loop: preset === 'idle' || preset === 'walk', tracks, markers: preset === 'cast' || preset === 'slash' ? [{ name: 'Release', time: duration * (preset === 'cast' ? 0.75 : 0.5) }] : [] }) as AnimationRecipe;
}

export function vfxPreset(preset: z.infer<typeof effectPreset>, name: string): VfxRecipe {
  const settings = {
    charge: { color: [1, 0.35, 0.05], size: 0.6, lifetime: 0.6, speed: 1, count: 20, rate: 25, spread: 180 },
    impact: { color: [1, 0.65, 0.12], size: 1, lifetime: 0.4, speed: 12, count: 50, rate: 0, spread: 180 },
    heal: { color: [0.2, 1, 0.5], size: 0.4, lifetime: 1.4, speed: 2, count: 25, rate: 20, spread: 30 },
  };
  return vfxSchema.parse({ kind: 'vfx', name, ...settings[preset] });
}
