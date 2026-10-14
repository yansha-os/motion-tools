import test from 'node:test';
import assert from 'node:assert/strict';
import { easeBezier, easeProgress } from '../src/easing.js';
import { animationPreset, recipeSchema } from '../src/recipes.js';
import { patchAnimation } from '../src/animation-patch.js';

test('legacy recipes remain linear and omit easing metadata when parsed', () => {
  const recipe = animationPreset('idle', 'Legacy Idle', 2, 1);
  const parsed = recipeSchema.parse(recipe);
  assert.equal(parsed.kind, 'animation');
  if (parsed.kind !== 'animation') return;
  assert.equal(parsed.tracks[0]!.keys[0]!.easingStyle, undefined);
  assert.equal(parsed.tracks[0]!.keys[0]!.easingDirection, undefined);
});

test('pose directions map to Roblox PoseEasingDirection semantics', () => {
  assert.equal(easeProgress('Linear', 'In', 0.3), 0.3);
  assert.equal(easeProgress('Constant', 'Out', 0.5), 0);
  assert.equal(easeProgress('Constant', 'InOut', 1), 1);
  assert.equal(easeProgress('CubicV2', 'Out', 0.5), 0.125);
  assert.equal(easeProgress('CubicV2', 'In', 0.5), 0.875);
  assert.equal(easeProgress('CubicV2', 'InOut', 0.5), 0.5);
  for (const style of ['Bounce', 'Elastic'] as const) {
    assert.equal(easeProgress(style, 'InOut', 0), 0);
    assert.equal(easeProgress(style, 'InOut', 1), 1);
  }
});

test('custom Bezier curves preserve endpoints and change normalized segment timing', () => {
  const curve = { outTime: 0.05, outValue: 1.2, inTime: 0.2, inValue: 1.2 };
  assert.equal(easeBezier(curve, 0), 0);
  assert.equal(easeBezier(curve, 1), 1);
  assert.notEqual(easeBezier(curve, 0.5), easeBezier(undefined, 0.5));
  assert.throws(() => recipeSchema.parse({
    kind: 'animation', name: 'Bad handles', duration: 1, loop: false,
    tracks: [{ joint: 'Root', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bezier', curve: { outTime: 0.8, outValue: 0.2, inTime: 0.2, inValue: 0.8 } },
      { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }], markers: [],
  }), /time handles must remain ordered/);
});

test('set_curve is patchable, selects Bezier, and affects breakdown interpolation', () => {
  const source = animationPreset('cast', 'Curve', 2, 1);
  const result = patchAnimation(source, [{
    operation: 'set_curve', joint: 'LeftUpperArm', time: 0,
    curve: { outTime: 0.05, outValue: 1.2, inTime: 0.2, inValue: 1.2 },
  }]);
  const revisedTrack = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!;
  assert.equal(revisedTrack.keys[0]!.easingStyle, 'Bezier');
  assert.deepEqual(revisedTrack.keys[0]!.curve, { outTime: 0.05, outValue: 1.2, inTime: 0.2, inValue: 1.2 });
  const linear = patchAnimation(source, [{ operation: 'insert_key', joint: 'LeftUpperArm', time: 0.25, position: [0, 0, 0] }]);
  const curved = patchAnimation(result.recipe, [{ operation: 'insert_key', joint: 'LeftUpperArm', time: 0.25, position: [0, 0, 0] }]);
  assert.notDeepEqual(
    curved.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.25)!.rotation,
    linear.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.25)!.rotation,
  );
});

test('inserted breakdowns sample the source segment using its outgoing easing', () => {
  const source = animationPreset('cast', 'Cast', 2, 1);
  const leftArm = source.tracks.find(track => track.joint === 'LeftUpperArm')!;
  leftArm.keys[0]!.easingStyle = 'CubicV2';
  leftArm.keys[0]!.easingDirection = 'Out';
  const result = patchAnimation(source, [{ operation: 'insert_key', joint: 'LeftUpperArm', time: 0.25, position: [1, 0, 0] }]);
  const inserted = result.recipe.tracks.find(track => track.joint === 'LeftUpperArm')!.keys.find(key => key.time === 0.25)!;

  assert.deepEqual(inserted.rotation, [-5.625, -1.875, -1.875]);
  assert.deepEqual(inserted.position, [1, 0, 0]);
  assert.equal(inserted.easingStyle, 'CubicV2');
  assert.equal(inserted.easingDirection, 'Out');
});

test('targeted patches can change a key easing mode without changing its pose', () => {
  const source = animationPreset('slash', 'Slash', 2, 1);
  const result = patchAnimation(source, [{ operation: 'set_easing', joint: 'RightUpperArm', time: 0.5, easingStyle: 'Elastic', easingDirection: 'InOut' }]);
  const originalKey = source.tracks.find(track => track.joint === 'RightUpperArm')!.keys[1]!;
  const revisedKey = result.recipe.tracks.find(track => track.joint === 'RightUpperArm')!.keys[1]!;

  assert.deepEqual(revisedKey.position, originalKey.position);
  assert.deepEqual(revisedKey.rotation, originalKey.rotation);
  assert.equal(revisedKey.easingStyle, 'Elastic');
  assert.equal(revisedKey.easingDirection, 'InOut');
});
