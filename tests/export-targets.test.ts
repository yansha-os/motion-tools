import test from 'node:test';
import assert from 'node:assert/strict';
import { animationPreset } from '../src/recipes.js';
import { mappedAnimationTargets } from '../src/export-targets.js';

test('export target summary deduplicates mapped base, disabled-layer, and root-motion joints deterministically', () => {
  const recipe = animationPreset('idle', 'Target summary', 1, 1);
  recipe.layers = [{ id: '4d328ffa-c735-43c6-9f48-b757cf09b8b2', name: 'Disabled arm layer', blendMode: 'Additive', weight: 0,
    enabled: false, tracks: [{ ...recipe.tracks[0]!, joint: 'LayerArm' }] }];
  recipe.rootMotion = { ...recipe.tracks[0]!, joint: 'Root' };
  assert.deepEqual(mappedAnimationTargets(recipe, { UpperTorso: 'Torso', Head: 'Torso', LayerArm: 'Torso', Root: 'RootPart' }), ['RootPart', 'Torso']);
  assert.deepEqual(mappedAnimationTargets(recipe, {}), ['Head', 'LayerArm', 'Root', 'UpperTorso']);
});
