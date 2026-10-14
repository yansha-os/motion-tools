/** Format animation timeline positions without rounding authored beats to display precision. */
export function formatAnimationTime(time: number) {
  if (!Number.isFinite(time)) throw new RangeError('Animation timeline time must be finite.');
  return Object.is(time, -0) ? '0' : time.toString();
}

/** Compare timeline values while tolerating only floating-point representation noise. */
export function sameAnimationTime(left: number, right: number) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 4;
}
