import assert from 'node:assert/strict';
import test from 'node:test';
import { eulerXYZDegreesToQuaternion, quaternionToEulerXYZDegrees } from '../src/rotation.js';

test('Roblox XYZ Euler and quaternion conversion round-trips compound rotations', () => {
  for (const rotation of [[20, 30, 40], [-70, -10, -10], [10, -35, 170]] as const) {
    const original = eulerXYZDegreesToQuaternion([...rotation]);
    const recovered = eulerXYZDegreesToQuaternion(quaternionToEulerXYZDegrees(original));
    const dot = Math.abs(original.reduce((sum, value, index) => sum + value * recovered[index]!, 0));
    assert.ok(1 - dot < 1e-12, `rotation ${rotation.join(',')} changed through conversion; quaternion dot=${dot}`);
  }
});

test('Roblox XYZ Euler conversion maps each principal quarter-turn to its matching quaternion axis', () => {
  const halfRoot = Math.SQRT1_2;
  const expected = [[halfRoot, 0, 0, halfRoot], [0, halfRoot, 0, halfRoot], [0, 0, halfRoot, halfRoot]];
  const principalRotations: [number, number, number][] = [[90, 0, 0], [0, 90, 0], [0, 0, 90]];
  const actual = principalRotations.map(eulerXYZDegreesToQuaternion);
  for (const index of [0, 1, 2]) {
    assert.ok(actual[index]!.every((value, component) => Math.abs(value - expected[index]![component]!) < 1e-15));
  }
});
