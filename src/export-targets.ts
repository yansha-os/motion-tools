import { Buffer } from 'node:buffer';
import type { AnimationRecipe } from './recipes.js';

export function compareRobloxNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function areCanonicalMappedTargets(joints: readonly string[]): boolean {
  return new Set(joints).size === joints.length && joints.every((joint, index) => index === 0 || compareRobloxNames(joints[index - 1]!, joint) < 0);
}

/** Distinct Roblox rig joints named by the recipe after applying the caller's exact export map. */
export function mappedAnimationTargets(recipe: AnimationRecipe, jointMap: Record<string, string>): string[] {
  const targets = new Set<string>();
  for (const track of recipe.tracks) targets.add(jointMap[track.joint] ?? track.joint);
  for (const layer of recipe.layers ?? []) {
    for (const track of layer.tracks) targets.add(jointMap[track.joint] ?? track.joint);
  }
  if (recipe.rootMotion) targets.add(jointMap[recipe.rootMotion.joint] ?? recipe.rootMotion.joint);
  return [...targets].sort(compareRobloxNames);
}
