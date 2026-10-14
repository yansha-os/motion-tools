import test from 'node:test';
import assert from 'node:assert/strict';
import { animationPreset, recipeSchema, type AnimationRecipe } from '../src/recipes.js';
import { patchAnimation } from '../src/animation-patch.js';

test('layer recipes validate loop boundaries, unique joints, and bounded blend values', () => {
  const recipe = animationPreset('idle', 'Layered idle', 2, 1);
  const layer: NonNullable<AnimationRecipe['layers']>[number] = {
    id: '2af22ca2-813e-4b38-8950-617b4094783a', name: 'Breathing', blendMode: 'Additive', weight: 0.45, enabled: true,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0.08, 0], rotation: [0, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] }],
  };
  recipe.layers = [layer];
  assert.equal(recipeSchema.parse(recipe).kind, 'animation');
  assert.throws(() => recipeSchema.parse({ ...recipe, layers: [{ ...layer, weight: 1.1 }] }), /less than or equal to 1/);
  assert.throws(() => recipeSchema.parse({ ...recipe, layers: [{ ...layer, tracks: [...layer.tracks, layer.tracks[0]!] }] }), /one track per joint/);
  assert.throws(() => recipeSchema.parse({ ...recipe, layers: [{ ...layer, tracks: [{ joint: 'UpperTorso', keys: [
    { time: 0.1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
  ] }] }] }), /keys must span 0 to duration/);
});

test('MCP layer patches create, edit, reorder, and remove isolated layer content', () => {
  const source = animationPreset('idle', 'Layered idle', 2, 1);
  const baseBefore = structuredClone(source.tracks);
  const created = patchAnimation(source, [
    { operation: 'layer_create', name: 'Breathing', blendMode: 'Additive', weight: 0.5 },
    { operation: 'layer_create', name: 'Arm polish', blendMode: 'Override', weight: 0.75 },
  ]);
  const breathing = created.recipe.layers![0]!;
  const arms = created.recipe.layers![1]!;
  const updated = patchAnimation(created.recipe, [
    { operation: 'layer_set_track', layerId: breathing.id, track: { joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { time: 1, position: [0, 0.1, 0], rotation: [0, 0, 0] },
      { time: 2, position: [0, 0, 0], rotation: [0, 0, 0] },
    ] } },
    { operation: 'set_pose', layerId: breathing.id, joint: 'UpperTorso', time: 1, position: [0, 0.2, 0] },
    { operation: 'layer_set', layerId: breathing.id, weight: 0.35, enabled: false },
    { operation: 'layer_move', layerId: arms.id, direction: 'up' },
  ]);

  assert.deepEqual(updated.recipe.tracks, baseBefore);
  assert.equal(updated.recipe.layers![0]!.id, arms.id);
  assert.equal(updated.recipe.layers![1]!.enabled, false);
  assert.equal(updated.recipe.layers![1]!.weight, 0.35);
  assert.equal(updated.recipe.layers![1]!.tracks[0]!.joint, 'UpperTorso');
  assert.deepEqual(updated.recipe.layers![1]!.tracks[0]!.keys[1]!.position, [0, 0.2, 0]);
  assert.deepEqual(updated.recipe.tracks, baseBefore);

  const deleted = patchAnimation(updated.recipe, [{ operation: 'layer_delete_track', layerId: breathing.id, joint: 'UpperTorso' }]);
  assert.equal(deleted.recipe.layers!.find(layer => layer.id === breathing.id)!.tracks.length, 0);
  assert.throws(() => patchAnimation(source, [{ operation: 'layer_set', layerId: breathing.id, weight: 0.5 }]), /No animation layer/);
});
