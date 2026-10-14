import { randomUUID } from 'node:crypto';
import { animationPreset, type AnimationRecipe } from '../../../src/recipes.js';
import type { Telemetry } from '../../../src/inspection.js';

export type PilotCaseId = 'idle-control' | 'idle-flawed' | 'run-control' | 'run-flawed' | 'guard-control' | 'guard-flawed';
export type PilotCase = { id: PilotCaseId; recipe: AnimationRecipe; telemetry: Telemetry; expectedDefect: 'loop_snap' | 'foot_slide' | 'grip_separation' | null };

const key = (time: number, position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0]) => ({ time, position, rotation });
const track = (joint: string, poses: ReturnType<typeof key>[]) => ({ joint, keys: poses });
const baseRigNodes = [
  { name: 'HumanoidRootPart', parent: 0, driven: false, foot: false },
  { name: 'UpperTorso', parent: 1, driven: true, foot: false },
  { name: 'LeftFoot', parent: 1, driven: true, foot: true },
  { name: 'RightFoot', parent: 1, driven: true, foot: true },
  { name: 'LeftHand', parent: 1, driven: true, foot: false },
  { name: 'RightHand', parent: 1, driven: true, foot: false },
];

function telemetry(recipe: AnimationRecipe, samples: { time: number; footX: number; handX: number }[]): Telemetry {
  const rigId = randomUUID();
  const assetId = randomUUID();
  return {
    version: 1, source: 'studio_pose_evaluator', rigId, assetId, duration: recipe.duration, loop: recipe.loop,
    height: 6, groundSource: 'rest_foot_bounds', note: 'Deterministic synthetic detector-sensitivity fixture; not a live Studio capture.',
    nodes: baseRigNodes,
    samples: samples.map((sample, index) => ({
      id: `s${String(index).padStart(3, '0')}`, time: sample.time,
      points: [
        [0, 3, 0], [0, 3, 0], [sample.footX, 0.5, 0], [-0.5, 0.5, 0],
        [sample.handX, 4, 0], [0.5, 4, 0],
      ],
      pivotPoints: [
        [0, 0, 0], [0, 0, 0], [sample.footX, -2.5, 0], [-0.5, -2.5, 0],
        [sample.handX, 1, 0], [0.5, 1, 0],
      ],
      bottoms: [2, 2, 0, 0, 3.5, 3.5],
      orientations: baseRigNodes.map(() => [0, 0, 0, 1] as [number, number, number, number]),
    })),
  };
}

function idlePair(): [AnimationRecipe, AnimationRecipe] {
  const control = animationPreset('idle', 'Pilot idle control', 2, 1);
  control.tracks.push(track('LeftFoot', [key(0), key(2)]), track('RightFoot', [key(0), key(2)]));
  const flawed = structuredClone(control);
  flawed.name = 'Pilot idle loop-snap injection';
  const torso = flawed.tracks.find(item => item.joint === 'UpperTorso')!;
  const poseAtInjection = -1 + (0 - -1) * ((1.966666667 - 1.5) / (2 - 1.5));
  torso.keys.splice(4, 0, key(1.966666667, [0, 0, 0], [poseAtInjection + 25, 0, 0]));
  return [control, flawed];
}

function runPair(): [AnimationRecipe, AnimationRecipe] {
  const common = { kind: 'animation' as const, name: '', duration: 1, loop: true, markers: [],
    contacts: [{ effector: 'LeftFoot', kind: 'support' as const, start: 0.1, end: 0.3 }] };
  const control = { ...common, name: 'Pilot run control', tracks: [
    track('LeftFoot', [key(0), key(0.1), key(0.3), key(0.65), key(1)]),
    track('RightFoot', [key(0), key(1)]),
  ] };
  const flawed = structuredClone(control);
  flawed.name = 'Pilot run planted-foot slide injection';
  flawed.tracks[0]!.keys = [key(0), key(0.1), key(0.2, [0.2, 0, 0]), key(0.3, [0.4, 0, 0]), key(1)];
  return [control, flawed];
}

function guardPair(): [AnimationRecipe, AnimationRecipe] {
  const common = { kind: 'animation' as const, name: '', duration: 3.2, loop: true, markers: [],
    contacts: [
      { effector: 'LeftHand', kind: 'grip' as const, start: 0, end: 3.2 },
      { effector: 'RightHand', kind: 'grip' as const, start: 0, end: 3.2 },
    ] };
  const control = { ...common, name: 'Pilot two-handed guard control', tracks: [
    track('LeftHand', [key(0), key(1.6), key(3.2)]),
    track('RightHand', [key(0), key(1.6), key(3.2)]),
  ] };
  const flawed = structuredClone(control);
  flawed.name = 'Pilot guard grip-separation injection';
  flawed.tracks[0]!.keys[1] = key(1.6, [0.5, 0, 0]);
  return [control, flawed];
}

const times = (duration: number, step: number) => Array.from({ length: Math.round(duration / step) + 1 }, (_, index) => Number((index * step).toFixed(9)));
const idleSamples = (flawed: boolean) => times(2, 1 / 30).map(time => ({ time, footX: 0, handX: 0 })).map(sample => ({
  ...sample,
  // The synthetic geometry is deliberately stationary; loop snap is measured from the recipe curve, not sparse frames.
  handX: flawed ? 0 : 0,
}));
const runSamples = (flawed: boolean) => times(1, 1 / 30).map(time => ({
  time,
  footX: time < 0.1 || time > 0.3 ? 0 : flawed ? 0.4 * ((time - 0.1) / 0.2) : 0,
  handX: 0,
}));
const guardSamples = (flawed: boolean) => times(3.2, 0.1).map(time => ({
  time, footX: 0, handX: flawed && time >= 1.6 ? 0.5 * Math.max(0, 1 - Math.abs(time - 1.6) / 1.6) : 0,
}));

export function createReviewPilotCases(): PilotCase[] {
  const [idleControl, idleFlawed] = idlePair();
  const [runControl, runFlawed] = runPair();
  const [guardControl, guardFlawed] = guardPair();
  return [
    { id: 'idle-control', recipe: idleControl, telemetry: telemetry(idleControl, idleSamples(false)), expectedDefect: null },
    { id: 'idle-flawed', recipe: idleFlawed, telemetry: telemetry(idleFlawed, idleSamples(true)), expectedDefect: 'loop_snap' },
    { id: 'run-control', recipe: runControl, telemetry: telemetry(runControl, runSamples(false)), expectedDefect: null },
    { id: 'run-flawed', recipe: runFlawed, telemetry: telemetry(runFlawed, runSamples(true)), expectedDefect: 'foot_slide' },
    { id: 'guard-control', recipe: guardControl, telemetry: telemetry(guardControl, guardSamples(false)), expectedDefect: null },
    { id: 'guard-flawed', recipe: guardFlawed, telemetry: telemetry(guardFlawed, guardSamples(true)), expectedDefect: 'grip_separation' },
  ];
}
