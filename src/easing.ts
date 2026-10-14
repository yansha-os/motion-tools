import type { z } from 'zod';
import type { bezierCurve, poseEasingDirection, poseEasingStyle } from './recipes.js';

export type PoseEasingStyle = z.infer<typeof poseEasingStyle>;
export type PoseEasingDirection = z.infer<typeof poseEasingDirection>;
export type BezierCurve = z.infer<typeof bezierCurve>;

export function easeBezier(curve: BezierCurve | undefined, progress: number) {
  const control = curve ?? { outTime: 0.25, outValue: 0.1, inTime: 0.75, inValue: 0.9 };
  const t = Math.max(0, Math.min(1, progress));
  if (t === 0 || t === 1) return t;
  const cubic = (value: number, first: number, second: number) => 3 * (1 - value) ** 2 * value * first + 3 * (1 - value) * value ** 2 * second + value ** 3;
  let low = 0, high = 1, parameter = t;
  for (let iteration = 0; iteration < 24; iteration++) {
    parameter = (low + high) / 2;
    if (cubic(parameter, control.outTime, control.inTime) < t) low = parameter;
    else high = parameter;
  }
  return cubic(parameter, control.outValue, control.inValue);
}

function cubicIn(t: number) { return t * t * t; }
function cubicOut(t: number) { return 1 - cubicIn(1 - t); }
function cubicInOut(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function bounceOut(t: number) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * Math.pow(t - 1.5 / d, 2) + 0.75;
  if (t < 2.5 / d) return n * Math.pow(t - 2.25 / d, 2) + 0.9375;
  return n * Math.pow(t - 2.625 / d, 2) + 0.984375;
}

function elasticIn(t: number) {
  if (t === 0 || t === 1) return t;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3));
}
function elasticOut(t: number) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}
function elasticInOut(t: number) {
  if (t === 0 || t === 1) return t;
  const sine = Math.sin((20 * t - 11.125) * (2 * Math.PI / 4.5));
  return t < 0.5
    ? -(Math.pow(2, 20 * t - 10) * sine) / 2
    : (Math.pow(2, -20 * t + 10) * sine) / 2 + 1;
}

export function easeProgress(style: PoseEasingStyle | undefined, direction: PoseEasingDirection | undefined, progress: number, curve?: BezierCurve) {
  const t = Math.max(0, Math.min(1, progress));
  const easingStyle = style ?? 'Linear';
  if (easingStyle === 'Bezier') return easeBezier(curve, t);
  // PoseEasingDirection In/Out are reversed relative to the usual animation-tool convention.
  const easingDirection = direction === 'In' ? 'Out' : direction === 'Out' || direction === undefined ? 'In' : 'InOut';
  if (easingStyle === 'Constant') return t < 1 ? 0 : 1;
  if (easingStyle === 'Linear') return t;
  if (easingStyle === 'CubicV2') {
    if (easingDirection === 'Out') return cubicOut(t);
    if (easingDirection === 'InOut') return cubicInOut(t);
    return cubicIn(t);
  }
  if (easingStyle === 'Bounce') {
    const out = bounceOut(t);
    if (easingDirection === 'Out') return out;
    if (easingDirection === 'In') return 1 - bounceOut(1 - t);
    return t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2;
  }
  if (easingDirection === 'Out') return elasticOut(t);
  if (easingDirection === 'In') return elasticIn(t);
  return elasticInOut(t);
}
