import { z } from 'zod';
import { label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { retargetProfileSchema } from './retarget.js';

type LimbSide = 'left' | 'right';
const axis = z.enum(['X', 'Y', 'Z']);
const jointMapSchema = z.object({
  leftHip: label,
  rightHip: label,
  leftFoot: label.optional(),
  rightFoot: label.optional(),
  leftKnee: label.optional(),
  rightKnee: label.optional(),
  leftAnkle: label.optional(),
  rightAnkle: label.optional(),
  leftArm: label.optional(),
  rightArm: label.optional(),
  torso: label.optional(),
}).strict().superRefine((joints, context) => {
  const paired = [
    ['knee', joints.leftKnee, joints.rightKnee],
    ['ankle', joints.leftAnkle, joints.rightAnkle],
    ['arm', joints.leftArm, joints.rightArm],
    ['foot', joints.leftFoot, joints.rightFoot],
  ] as const;
  for (const [name, left, right] of paired) {
    if (Boolean(left) !== Boolean(right)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['jointMap'], message: `Map both left and right ${name} joints, or omit both.` });
  }
  const names = Object.entries(joints).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const seen = new Map<string, string>();
  for (const [semantic, jointName] of names) {
    const normalized = jointName.toLocaleLowerCase('en-US');
    const prior = seen.get(normalized);
    const expectedSamePart = semantic === 'leftFoot' && (prior === 'leftHip' || prior === 'leftAnkle')
      || semantic === 'rightFoot' && (prior === 'rightHip' || prior === 'rightAnkle')
      || semantic === 'leftHip' && prior === 'leftFoot'
      || semantic === 'leftAnkle' && prior === 'leftFoot'
      || semantic === 'rightHip' && prior === 'rightFoot'
      || semantic === 'rightAnkle' && prior === 'rightFoot';
    if (prior && !expectedSamePart) context.addIssue({ code: z.ZodIssueCode.custom, path: ['jointMap', semantic], message: `${jointName} is mapped more than once; each driven joint must have one semantic role (same-side hip/foot may share one R6 limb).` });
    else seen.set(normalized, semantic);
  }
});

export const gaitShape = {
  name: label,
  duration: z.number().finite().min(0.1).max(30),
  cycles: z.number().int().min(1).max(7).default(2),
  samplesPerCycle: z.number().int().min(8).max(24).default(16),
  style: z.enum(['walk', 'run', 'sneak']).default('walk'),
  strideDegrees: z.number().finite().min(1).max(80).optional(),
  strideReachRatio: z.number().finite().min(0.05).max(0.75).optional()
    .describe('Dimensionless half-stride reach as a fraction of measured hip-to-foot chain length. If a fresh rig profile is provided, diagnostics report the estimated reach in studs. Mutually exclusive with strideDegrees.'),
  kneeFlexDegrees: z.number().finite().min(0).max(120).optional(),
  armSwingDegrees: z.number().finite().min(0).max(70).optional(),
  ankleDegrees: z.number().finite().min(0).max(60).optional(),
  torsoTwistDegrees: z.number().finite().min(0).max(30).optional(),
  torsoBobStuds: z.number().finite().min(0).max(0.5).optional(),
  stanceRatio: z.number().finite().min(0.35).max(0.75).optional(),
  jointMap: jointMapSchema,
  axes: z.object({
    hip: axis.default('X'),
    knee: axis.default('X'),
    ankle: axis.default('X'),
    arm: axis.default('X'),
    torso: axis.default('Y'),
    torsoBob: axis.default('Y'),
  }).strict().default({}),
} as const;

export const gaitSchema = z.object(gaitShape).strict().superRefine((input, context) => {
  if (input.cycles * input.samplesPerCycle > 127) context.addIssue({ code: z.ZodIssueCode.custom, path: ['samplesPerCycle'], message: 'A generated track is limited to 128 keys, including its loop endpoint.' });
  if (input.strideDegrees !== undefined && input.strideReachRatio !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['strideReachRatio'], message: 'Choose strideReachRatio or strideDegrees, not both.' });
});

export type GaitInput = z.infer<typeof gaitSchema>;

const presets = {
  walk: { strideDegrees: 28, kneeFlexDegrees: 34, armSwingDegrees: 20, ankleDegrees: 8, torsoTwistDegrees: 5, torsoBobStuds: 0.035, stanceRatio: 0.62 },
  run: { strideDegrees: 44, kneeFlexDegrees: 68, armSwingDegrees: 34, ankleDegrees: 15, torsoTwistDegrees: 8, torsoBobStuds: 0.12, stanceRatio: 0.43 },
  sneak: { strideDegrees: 17, kneeFlexDegrees: 48, armSwingDegrees: 10, ankleDegrees: 5, torsoTwistDegrees: 3, torsoBobStuds: 0.015, stanceRatio: 0.7 },
} as const;

type Axis = 'X' | 'Y' | 'Z';
function vectorOnAxis(axisName: Axis, value: number): [number, number, number] {
  if (axisName === 'X') return [value, 0, 0];
  if (axisName === 'Y') return [0, value, 0];
  return [0, 0, value];
}
function smoothstep(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}
function phaseAt(time: number, period: number) {
  return ((time / period) % 1 + 1) % 1;
}
function normalizeTime(time: number, duration: number) {
  return Number(Math.max(0, Math.min(duration, time)).toFixed(6));
}
function measuredLegLength(profile: z.infer<typeof retargetProfileSchema>, hipName: string, footName: string) {
  const byName = new Map(profile.joints.map(joint => [joint.name, joint]));
  let current = byName.get(footName);
  let total = 0;
  const visited = new Set<string>();
  while (current && !visited.has(current.name)) {
    visited.add(current.name);
    total += current.segmentLength;
    if (current.name === hipName) return total > 0.001 ? total : null;
    current = current.parent ? byName.get(current.parent) : undefined;
  }
  return null;
}

/** Compile an editable in-place locomotion loop. Contact intervals describe intent; no IK or root travel is authored. */
export function compileGait(input: unknown, profileInput?: unknown) {
  const gait = gaitSchema.parse(input);
  const profile = profileInput === undefined ? undefined : retargetProfileSchema.parse(profileInput);
  const preset = presets[gait.style];
  const leftFoot = gait.jointMap.leftFoot ?? gait.jointMap.leftAnkle ?? gait.jointMap.leftHip;
  const rightFoot = gait.jointMap.rightFoot ?? gait.jointMap.rightAnkle ?? gait.jointMap.rightHip;
  const leftLegLengthStuds = profile ? measuredLegLength(profile, gait.jointMap.leftHip, leftFoot) : null;
  const rightLegLengthStuds = profile ? measuredLegLength(profile, gait.jointMap.rightHip, rightFoot) : null;
  if (gait.strideReachRatio !== undefined && profile && (leftLegLengthStuds === null || rightLegLengthStuds === null)) {
    throw new Error('Cannot compute strideReachRatio from the inspected rig: each mapped foot must be a descendant of its mapped hip with measurable segment lengths. Correct the joint map or use strideDegrees.');
  }
  const defaultStrideReachRatio = Math.sin((preset.strideDegrees / 2) * Math.PI / 180);
  const strideReachRatio = gait.strideReachRatio ?? Math.sin(((gait.strideDegrees ?? preset.strideDegrees) / 2) * Math.PI / 180);
  const strideDegrees = gait.strideReachRatio !== undefined
    ? 2 * Math.asin(gait.strideReachRatio) * 180 / Math.PI
    : gait.strideDegrees ?? preset.strideDegrees;
  const kneeFlexDegrees = gait.kneeFlexDegrees ?? preset.kneeFlexDegrees;
  const armSwingDegrees = gait.armSwingDegrees ?? preset.armSwingDegrees;
  const ankleDegrees = gait.ankleDegrees ?? preset.ankleDegrees;
  const torsoTwistDegrees = gait.torsoTwistDegrees ?? preset.torsoTwistDegrees;
  const torsoBobStuds = gait.torsoBobStuds ?? preset.torsoBobStuds;
  const stanceRatio = gait.stanceRatio ?? preset.stanceRatio;
  const period = gait.duration / gait.cycles;
  const sampleCount = gait.cycles * gait.samplesPerCycle;
  const joints = gait.jointMap;
  const tracks: AnimationRecipe['tracks'] = [];

  const addTrack = (joint: string, axisName: Axis, positionAt?: (phase: number, side: LimbSide) => number) => {
    const keys: AnimationRecipe['tracks'][number]['keys'] = [];
    for (let index = 0; index <= sampleCount; index++) {
      const time = index === sampleCount ? gait.duration : normalizeTime(gait.duration * index / sampleCount, gait.duration);
      const sampleSide = joint === joints.torso || joint === joints.leftHip || joint === joints.leftKnee || joint === joints.leftAnkle || joint === joints.leftArm
        ? 'left' as const : 'right' as const;
      const phase = phaseAt(time, period) + (sampleSide === 'right' ? 0.5 : 0);
      const wrappedPhase = phaseAt(phase, 1);
      const wrappedPhaseRadians = 2 * Math.PI * wrappedPhase;
      const stanceProgress = wrappedPhase < stanceRatio ? wrappedPhase / stanceRatio : 1;
      const swingProgress = wrappedPhase >= stanceRatio ? (wrappedPhase - stanceRatio) / (1 - stanceRatio) : 0;
      const hipAngle = wrappedPhase < stanceRatio
        ? strideDegrees / 2 - strideDegrees * smoothstep(stanceProgress)
        : -strideDegrees / 2 + strideDegrees * smoothstep(swingProgress);
      const swingAmount = wrappedPhase >= stanceRatio ? Math.sin(Math.PI * swingProgress) : 0;
      const isHip = joint === joints.leftHip || joint === joints.rightHip;
      const isKnee = joint === joints.leftKnee || joint === joints.rightKnee;
      const isAnkle = joint === joints.leftAnkle || joint === joints.rightAnkle;
      const isArm = joint === joints.leftArm || joint === joints.rightArm;
      const isTorso = joint === joints.torso;
      const rotation = isHip ? hipAngle
        : isKnee ? kneeFlexDegrees * swingAmount
          : isAnkle ? -hipAngle * (ankleDegrees / Math.max(strideDegrees, 1))
            : isArm ? -armSwingDegrees * Math.sin(wrappedPhaseRadians)
                : isTorso ? torsoTwistDegrees * Math.sin(wrappedPhaseRadians + Math.PI)
                  : 0;
      const position = isTorso && positionAt
        ? vectorOnAxis(gait.axes.torsoBob, positionAt(wrappedPhase, sampleSide))
        : [0, 0, 0] as [number, number, number];
      keys.push({ time, position, rotation: vectorOnAxis(axisName, rotation), easingStyle: 'Linear', easingDirection: 'Out' });
    }
    tracks.push({ joint, keys });
  };

  addTrack(joints.leftHip, gait.axes.hip);
  addTrack(joints.rightHip, gait.axes.hip);
  if (joints.leftKnee && joints.rightKnee) {
    addTrack(joints.leftKnee, gait.axes.knee);
    addTrack(joints.rightKnee, gait.axes.knee);
  }
  if (joints.leftAnkle && joints.rightAnkle) {
    addTrack(joints.leftAnkle, gait.axes.ankle);
    addTrack(joints.rightAnkle, gait.axes.ankle);
  }
  if (joints.leftArm && joints.rightArm) {
    addTrack(joints.leftArm, gait.axes.arm);
    addTrack(joints.rightArm, gait.axes.arm);
  }
  if (joints.torso) addTrack(joints.torso, gait.axes.torso,
    phase => torsoBobStuds * (1 - Math.cos(4 * Math.PI * phase)) / 2);

  const contacts: NonNullable<AnimationRecipe['contacts']> = [];
  const markers: AnimationRecipe['markers'] = [];
  const addFootCycle = (foot: string, which: LimbSide, offset: number) => {
    for (let cycle = 0; cycle < gait.cycles; cycle++) {
      const unwrappedStart = (cycle + offset) * period;
      const start = normalizeTime(unwrappedStart % gait.duration, gait.duration);
      const unwrappedEnd = unwrappedStart + stanceRatio * period;
      if (unwrappedEnd <= gait.duration + 1e-8) {
        const end = normalizeTime(Math.min(unwrappedEnd, gait.duration), gait.duration);
        if (end > start) contacts.push({ effector: foot, kind: 'support', start, end });
      } else {
        contacts.push({ effector: foot, kind: 'support', start, end: gait.duration });
        const wrappedEnd = normalizeTime(unwrappedEnd - gait.duration, gait.duration);
        if (wrappedEnd > 0) contacts.push({ effector: foot, kind: 'support', start: 0, end: wrappedEnd });
      }
      const plantTime = start;
      const liftPhase = (cycle + offset + stanceRatio) % gait.cycles;
      const liftTime = normalizeTime(liftPhase * period, gait.duration);
      const cycleNumber = cycle + 1;
      markers.push({ name: `${which}_plant_${cycleNumber}`, time: plantTime, value: `${which} support begins; declared contact is not an IK lock.` });
      markers.push({ name: `${which}_lift_${cycleNumber}`, time: liftTime, value: `${which} support ends; inspect toe-off on the target rig.` });
    }
  };
  addFootCycle(leftFoot, 'left', 0);
  addFootCycle(rightFoot, 'right', 0.5);
  contacts.sort((left, right) => left.start - right.start || left.effector.localeCompare(right.effector));
  markers.sort((left, right) => left.time - right.time || left.name.localeCompare(right.name));

  const recipe = recipeSchema.parse({ kind: 'animation', name: gait.name, duration: gait.duration, loop: true,
    priority: 'Movement', tracks, contacts, markers }) as AnimationRecipe;
  const diagnostics = {
    style: gait.style,
    cycleCount: gait.cycles,
    cycleDurationSeconds: Number(period.toFixed(6)),
    stanceRatio,
    generatedTrackCount: tracks.length,
    generatedKeyCount: tracks.reduce((sum, track) => sum + track.keys.length, 0),
    declaredContactCount: contacts.length,
    markerCount: markers.length,
    peakHipSwingDegrees: strideDegrees / 2,
    strideCalibration: {
      source: gait.strideReachRatio !== undefined ? 'caller_ratio' as const : gait.strideDegrees !== undefined ? 'caller_degrees' as const : 'style_default' as const,
      halfStrideReachRatio: Number(strideReachRatio.toFixed(4)),
      styleDefaultHalfStrideReachRatio: Number(defaultStrideReachRatio.toFixed(4)),
      measuredLegLengthStuds: { left: leftLegLengthStuds === null ? null : Number(leftLegLengthStuds.toFixed(3)),
        right: rightLegLengthStuds === null ? null : Number(rightLegLengthStuds.toFixed(3)) },
      estimatedHalfStrideReachStuds: { left: leftLegLengthStuds === null ? null : Number((leftLegLengthStuds * strideReachRatio).toFixed(3)),
        right: rightLegLengthStuds === null ? null : Number((rightLegLengthStuds * strideReachRatio).toFixed(3)) },
      measurementNote: profile ? 'Approximate sum of inspected part-center segment lengths from each mapped hip through its mapped foot; it does not include collision geometry, joint limits, skinning, or ground clearance.' : 'No inspected rig profile was supplied, so stud-space stride reach is unknown.',
    },
    peakKneeFlexDegrees: kneeFlexDegrees,
    peakTorsoBobStuds: torsoBobStuds,
    footContactWrapsLoopBoundary: contacts.some(contact => contact.start === 0) && contacts.some(contact => contact.end === gait.duration),
    limitations: [
      'This is a deterministic in-place gait scaffold, not a learned motion or a guarantee of natural movement.',
      'Foot support intervals and plant/lift markers are authored intent only; they are not IK locks, ground collision, root travel, or foot locking.',
      'Rotation channels are local XYZ Euler degrees. Verify axis direction and amplitude on the inspected target rig before export.',
      'Optional foot/ankle/arm/torso tracks are emitted only when explicitly mapped; the required left/right hip tracks alone support R6-style rigs.',
      'Stride reach is a geometric estimate derived from part-center segment lengths; always verify the resulting stride on the rendered rig.',
    ],
  };
  return { recipe, diagnostics,
    next: 'Inspect the generated loop on the target rig with motion_animation_candidate_evaluate. Adjust the explicit joint map or axes if needed, then preview it in the Studio viewport; the preview compiler does not save or auto-approve the gait.' };
}
