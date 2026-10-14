import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnimationTime } from '../src/time-format.js';

test('animation time formatting preserves the exact round-trip value, including very close beats', () => {
  assert.equal(formatAnimationTime(0.5000000000001), '0.5000000000001');
  assert.equal(formatAnimationTime(0.50005), '0.50005');
  assert.equal(Number(formatAnimationTime(Number.MIN_VALUE)), Number.MIN_VALUE);
  assert.equal(Number(formatAnimationTime(Number.MAX_VALUE)), Number.MAX_VALUE);
  assert.equal(formatAnimationTime(-0), '0');
  assert.throws(() => formatAnimationTime(Number.NaN), /must be finite/);
  assert.throws(() => formatAnimationTime(Number.POSITIVE_INFINITY), /must be finite/);
});
