import { z } from 'zod';
import { identifier, label, recipeSchema, type AnimationRecipe } from './recipes.js';
import { eulerXYZDegreesToQuaternion, quaternionToEulerXYZDegrees, type Quaternion } from './rotation.js';

const quaternion = z.tuple([
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
]).refine(value => Math.abs(Math.hypot(...value) - 1) < 0.02, 'Joint rest basis must be a normalized quaternion.');
export const retargetProfileSchema = z.object({
  version: z.literal(1), rigId: identifier, rigName: label, rigType: z.enum(['R6', 'R15', 'custom']), rigSignature: z.string().min(1).max(30000),
  joints: z.array(z.object({ name: label, parent: z.string().max(80), driven: z.boolean(), targetKind: z.enum(['Motor6D', 'AnimationConstraint', 'Bone']).optional(),
    basis: quaternion, segmentLength: z.number().finite().min(0).max(1000) }).strict()).min(1).max(256),
}).strict().superRefine((profile, ctx) => {
  const names = new Set<string>();
  for (const [index, joint] of profile.joints.entries()) {
    if (names.has(joint.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['joints', index, 'name'], message: `Duplicate rig joint ${joint.name}.` });
    names.add(joint.name);
  }
});
const inspectedVisualGeometrySchema = z.object({
  source: z.literal('BasePart.Size'),
  dimensionsStuds: z.tuple([z.number().finite().positive(), z.number().finite().positive(), z.number().finite().positive()]),
  partClass: z.string().min(1).max(80),
  transparency: z.number().finite().min(0).max(1),
  shape: z.string().max(100).optional(),
}).strict();
const inspectedAnimatedNodeSchema = z.object({ name: label, parent: z.string().max(80), driven: z.boolean(),
  targetKind: z.enum(['Motor6D', 'AnimationConstraint', 'Bone']).optional(),
  captureFocusEligible: z.boolean().optional(), visualGeometry: inspectedVisualGeometrySchema.optional() }).passthrough();
export type ValidatedInspectionNode = { name: string; parent: string; driven: boolean; targetKind?: 'Motor6D' | 'AnimationConstraint' | 'Bone'; captureFocusEligible?: boolean;
  visualGeometry?: z.infer<typeof inspectedVisualGeometrySchema> };
/** Keep only unambiguous inspection nodes that agree with the validated rig profile; strip all unrecognized plugin fields. */
export function validatedInspectionNodes(profile: RetargetProfile, animatedNames: unknown): ValidatedInspectionNode[] {
  if (!Array.isArray(animatedNames)) return [];
  const rawNameCounts = new Map<string, number>();
  for (const value of animatedNames) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const name = (value as Record<string, unknown>).name;
    if (typeof name === 'string') rawNameCounts.set(name, (rawNameCounts.get(name) ?? 0) + 1);
  }
  const joints = new Map(profile.joints.map(joint => [joint.name, joint]));
  const validated: ValidatedInspectionNode[] = [];
  for (const candidate of animatedNames) {
    const parsed = inspectedAnimatedNodeSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const node = parsed.data;
    const joint = joints.get(node.name);
    if (rawNameCounts.get(node.name) !== 1 || !joint || joint.parent !== node.parent || joint.driven !== node.driven
      || node.targetKind !== joint.targetKind) continue;
    validated.push({ name: node.name, parent: node.parent, driven: node.driven,
      ...(node.targetKind === undefined ? {} : { targetKind: node.targetKind }),
      ...(node.captureFocusEligible === undefined ? {} : { captureFocusEligible: node.captureFocusEligible }),
      ...(node.visualGeometry === undefined ? {} : { visualGeometry: node.visualGeometry }) });
  }
  return validated;
}
/** Return close-up targets only when Studio's hint agrees with the validated hierarchy and part evidence. */
export function captureFocusEligibleJointNames(profile: RetargetProfile, animatedNames: unknown): string[] {
  return validatedInspectionNodes(profile, animatedNames)
    .filter(node => node.driven && node.targetKind !== 'Bone' && node.captureFocusEligible === true
      && node.visualGeometry !== undefined && node.visualGeometry.transparency < 1)
    .map(node => node.name);
}
export const retargetJointMapSchema = z.record(label, label).refine(map => Object.keys(map).length <= 256, 'A retarget map may contain at most 256 joints.');
export const retargetInputSchema = z.object({
  assetId: z.string().uuid(), sourceProfile: retargetProfileSchema, targetProfile: retargetProfileSchema,
  jointMap: retargetJointMapSchema.default({}), allowPartial: z.boolean().default(false), scaleTranslation: z.boolean().default(true),
}).strict();
export type RetargetProfile = z.infer<typeof retargetProfileSchema>;
type Vector = [number, number, number];

export interface JointMapSuggestion {
  source: string;
  status: 'suggested' | 'ambiguous' | 'unmapped' | 'conflict';
  confidence: number | null;
  suggestedTarget?: string;
  candidates: { target: string; confidence: number; evidence: string[]; hierarchy: 'consistent' | 'mismatch' | 'unknown' }[];
  reason: string;
}

const jointTokenAliases: Record<string, string> = {
  chest: 'uppertorso', torso: 'uppertorso', uppertorso: 'uppertorso', torsoupper: 'uppertorso',
  pelvis: 'lowertorso', hips: 'lowertorso', hip: 'lowertorso', lowertorso: 'lowertorso', torsolower: 'lowertorso',
  forearm: 'lowerarm', armlower: 'lowerarm', upperarm: 'upperarm', armupper: 'upperarm',
  thigh: 'upperleg', legupper: 'upperleg', shin: 'lowerleg', leglower: 'lowerleg',
  humanoidrootpart: 'root', rootpart: 'root',
};
const ignoredJointTokens = new Set(['bone', 'joint', 'motor', 'motor6d', 'part', 'rig', 'control', 'ctrl']);

function jointNameFeatures(name: string) {
  const split = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0 && !ignoredJointTokens.has(token));
  const sideTokens = new Set(['left', 'right', 'l', 'r']);
  const sides = split.filter(token => sideTokens.has(token));
  const side = sides.some(token => token === 'left' || token === 'l') && !sides.some(token => token === 'right' || token === 'r')
    ? 'left'
    : sides.some(token => token === 'right' || token === 'r') && !sides.some(token => token === 'left' || token === 'l') ? 'right' : null;
  let tokens = split.filter(token => !sideTokens.has(token));
  const compounds: [string, string, string][] = [
    ['upper', 'arm', 'upperarm'], ['lower', 'arm', 'lowerarm'], ['upper', 'leg', 'upperleg'], ['lower', 'leg', 'lowerleg'],
    ['upper', 'torso', 'uppertorso'], ['lower', 'torso', 'lowertorso'],
  ];
  for (const [first, second, canonical] of compounds) {
    if (tokens.includes(first) && tokens.includes(second)) tokens = [...tokens.filter(token => token !== first && token !== second), canonical];
  }
  tokens = [...new Set(tokens.map(token => jointTokenAliases[token] ?? token))].sort();
  return { side, tokens, normalized: `${side ?? ''}:${tokens.join('|')}` };
}

function tokenSimilarity(left: string, right: string) {
  if (!left || !right) return null;
  const expand = (tokens: string[]) => {
    const expanded = new Set<string>();
    for (const token of tokens) {
      const compound = /^(upper|lower)(arm|leg|torso)$/.exec(token);
      if (compound) { expanded.add(compound[2]!); expanded.add(`${compound[1]}?`); }
      else expanded.add(token);
    }
    return expanded;
  };
  const a = expand(jointNameFeatures(left).tokens), b = expand(jointNameFeatures(right).tokens);
  if (!a.size || !b.size) return null;
  const weight = (token: string) => token.endsWith('?') ? 0.6 : 1;
  const union = new Set([...a, ...b]);
  const intersection = [...a].filter(token => b.has(token));
  return intersection.reduce((sum, token) => sum + weight(token), 0) / [...union].reduce((sum, token) => sum + weight(token), 0);
}

function profileDepth(profile: RetargetProfile, jointName: string) {
  const joints = new Map(profile.joints.map(joint => [joint.name, joint]));
  let joint = joints.get(jointName), depth = 0;
  const visited = new Set<string>();
  while (joint?.parent && !visited.has(joint.name)) {
    visited.add(joint.name);
    depth++;
    joint = joints.get(joint.parent);
  }
  return depth;
}

function roundedConfidence(score: number) { return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000; }

/** Produces ranked, explainable mapping suggestions; it never applies the returned map. */
export function suggestAnimationJointMap(sourceProfileInput: unknown, targetProfileInput: unknown, animatedJointsInput: string[]) {
  const sourceProfile = retargetProfileSchema.parse(sourceProfileInput), targetProfile = retargetProfileSchema.parse(targetProfileInput);
  const animatedJoints = [...new Set(animatedJointsInput)].sort();
  if (animatedJoints.length === 0) throw new Error('Provide at least one animated source joint to map.');
  if (animatedJoints.length > 256) throw new Error('At most 256 animated source joints can be mapped in one request.');
  const sourceByName = new Map(sourceProfile.joints.map(joint => [joint.name, joint]));
  const targets = targetProfile.joints.filter(joint => joint.driven);
  const suggestions: JointMapSuggestion[] = animatedJoints.map(sourceName => {
    const source = sourceByName.get(sourceName);
    if (!source?.driven) return { source: sourceName, status: 'unmapped', confidence: null, candidates: [], reason: 'The source profile does not contain this animated joint as a driven joint.' };
    const sourceFeatures = jointNameFeatures(source.name);
    const candidates = targets.map(target => {
      const targetFeatures = jointNameFeatures(target.name);
      const semanticSimilarity = tokenSimilarity(source.name, target.name) ?? 0;
      const sameName = sourceFeatures.normalized === targetFeatures.normalized;
      const sideConflict = sourceFeatures.side !== null && targetFeatures.side !== null && sourceFeatures.side !== targetFeatures.side;
      const sourceParent = source.parent ? sourceByName.get(source.parent) : undefined;
      const targetParent = target.parent ? targetProfile.joints.find(joint => joint.name === target.parent) : undefined;
      const parentSimilarity = sourceParent && targetParent ? tokenSimilarity(sourceParent.name, targetParent.name) : null;
      const bothRoots = !source.parent && !target.parent;
      const hierarchy: 'consistent' | 'mismatch' | 'unknown' = bothRoots || (parentSimilarity !== null && parentSimilarity >= 0.5)
        ? 'consistent'
        : source.parent && target.parent && parentSimilarity === 0 ? 'mismatch' : 'unknown';
      if (semanticSimilarity === 0 && !sameName) return null;
      let score = semanticSimilarity * 0.68 + (sameName ? 0.17 : 0);
      const evidence = [sameName ? 'normalized joint name matches' : `anatomical name tokens overlap (${Math.round(semanticSimilarity * 100)}%)`];
      if (sourceFeatures.side && sourceFeatures.side === targetFeatures.side) { score += 0.12; evidence.push(`same ${sourceFeatures.side} side`); }
      else if (!sourceFeatures.side && !targetFeatures.side) { score += 0.05; evidence.push('neither name specifies a side'); }
      if (hierarchy === 'consistent') { score += 0.1; evidence.push('parent names are compatible'); }
      else if (hierarchy === 'mismatch') { score -= 0.2; evidence.push('parent names conflict'); }
      else evidence.push('parent compatibility is unknown');
      if (profileDepth(sourceProfile, source.name) === profileDepth(targetProfile, target.name)) { score += 0.04; evidence.push('same hierarchy depth'); }
      if (source.segmentLength > 0.001 && target.segmentLength > 0.001) {
        const ratio = Math.min(source.segmentLength, target.segmentLength) / Math.max(source.segmentLength, target.segmentLength);
        score += ratio * 0.04;
        evidence.push(`segment lengths are ${Math.round(ratio * 100)}% similar`);
      }
      if (sideConflict) { score -= 0.4; evidence.push('left/right side conflicts'); }
      return { target: target.name, confidence: roundedConfidence(score), evidence, hierarchy };
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => b.confidence - a.confidence || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
      .slice(0, 3);
    const best = candidates[0], runnerUp = candidates[1];
    if (!best) return { source: sourceName, status: 'unmapped' as const, confidence: null, candidates, reason: 'No target joint has overlapping anatomical-name evidence.' };
    if (best.hierarchy === 'mismatch' || best.evidence.includes('left/right side conflicts')) return { source: sourceName, status: 'ambiguous' as const, confidence: best.confidence, candidates, reason: 'The leading name match conflicts with laterality or parent hierarchy; choose an explicit mapping after inspecting both rigs.' };
    if (best.confidence < 0.45) return { source: sourceName, status: 'unmapped' as const, confidence: best.confidence, candidates, reason: 'No target joint has enough anatomical-name evidence to recommend a mapping.' };
    if (best.confidence < 0.78 || (runnerUp && best.confidence - runnerUp.confidence < 0.12)) return { source: sourceName, status: 'ambiguous' as const, confidence: best.confidence, candidates, reason: 'The leading match is weak or too close to another candidate; choose an explicit mapping.' };
    return { source: sourceName, status: 'suggested' as const, confidence: best.confidence, suggestedTarget: best.target, candidates, reason: 'Strong, distinct name match with no detected hierarchy conflict. Verify the mapping before retargeting.' };
  });
  const suggestedByTarget = new Map<string, JointMapSuggestion[]>();
  for (const suggestion of suggestions) if (suggestion.status === 'suggested' && suggestion.suggestedTarget) {
    const group = suggestedByTarget.get(suggestion.suggestedTarget) ?? [];
    group.push(suggestion);
    suggestedByTarget.set(suggestion.suggestedTarget, group);
  }
  for (const [target, group] of suggestedByTarget) if (group.length > 1) for (const suggestion of group) {
    suggestion.status = 'conflict';
    delete suggestion.suggestedTarget;
    suggestion.reason = `Multiple source joints recommend ${target}; resolve the one-to-one mapping explicitly.`;
  }
  const suggestedJointMap = Object.fromEntries(suggestions.filter((suggestion): suggestion is JointMapSuggestion & { status: 'suggested'; suggestedTarget: string } => suggestion.status === 'suggested' && Boolean(suggestion.suggestedTarget)).map(suggestion => [suggestion.source, suggestion.suggestedTarget]));
  return {
    sourceRig: sourceProfile.rigName, targetRig: targetProfile.rigName,
    sourceSignature: sourceProfile.rigSignature, targetSignature: targetProfile.rigSignature,
    suggestedJointMap, suggestions,
    limitation: 'Candidate confidence values are heuristic ranking scores, not calibrated probabilities. Suggestions use names, parent-name compatibility, hierarchy depth and segment lengths only; they do not establish anatomical correctness, skinning, local axes, or artistic suitability. The map is advisory and is never applied automatically; inspect both rigs and candidates, then pass an explicitly reviewed jointMap to motion_animation_retarget.',
  };
}

function normalize([x, y, z, w]: Quaternion): Quaternion {
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-10) throw new Error('Invalid zero-length orientation quaternion.');
  return [x / length, y / length, z / length, w / length];
}
function inverse([x, y, z, w]: Quaternion): Quaternion { return [-x, -y, -z, w]; }
function multiply(a: Quaternion, b: Quaternion): Quaternion {
  const [x, y, z, w] = a, [u, v, s, t] = b;
  return normalize([w * u + x * t + y * s - z * v, w * v - x * s + y * t + z * u, w * s + x * v - y * u + z * t, w * t - x * u - y * v - z * s]);
}
function rotate(q: Quaternion, [x, y, z]: Vector): Vector {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}
function retargetTransform(position: Vector, rotation: Vector, source: RetargetProfile['joints'][number], target: RetargetProfile['joints'][number], scaleTranslation: boolean) {
  const sourceBasis = source.basis as Quaternion, targetBasis = target.basis as Quaternion;
  const delta = eulerXYZDegreesToQuaternion(rotation);
  const worldDelta = multiply(multiply(sourceBasis, delta), inverse(sourceBasis));
  const localDelta = multiply(multiply(inverse(targetBasis), worldDelta), targetBasis);
  const worldPosition = rotate(sourceBasis, position);
  const targetPosition = rotate(inverse(targetBasis), worldPosition);
  const lengthScale = scaleTranslation && source.segmentLength > 0.001 && target.segmentLength > 0.001
    ? Math.max(0.25, Math.min(4, target.segmentLength / source.segmentLength)) : 1;
  return { position: targetPosition.map(value => value * lengthScale) as Vector, rotation: quaternionToEulerXYZDegrees(localDelta) };
}

export function retargetAnimation(sourceInput: AnimationRecipe, sourceProfileInput: unknown, targetProfileInput: unknown, jointMapInput: Record<string, string> = {}, allowPartial = false, scaleTranslation = true) {
  const source = recipeSchema.parse(structuredClone(sourceInput));
  if (source.kind !== 'animation') throw new Error('Only animation assets can be retargeted.');
  const sourceProfile = retargetProfileSchema.parse(sourceProfileInput), targetProfile = retargetProfileSchema.parse(targetProfileInput);
  const jointMap = retargetJointMapSchema.parse(jointMapInput);
  const sourceJoints = new Map(sourceProfile.joints.map(joint => [joint.name, joint]));
  const targetJoints = new Map(targetProfile.joints.map(joint => [joint.name, joint]));
  const relevantSourceJoints = new Set<string>();
  const pendingRelevantJoints = [
    ...source.tracks.map(track => track.joint),
    ...(source.rootMotion ? [source.rootMotion.joint] : []),
    ...(source.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint)),
  ];
  while (pendingRelevantJoints.length) {
    const name = pendingRelevantJoints.pop()!;
    if (relevantSourceJoints.has(name)) continue;
    relevantSourceJoints.add(name);
    const parent = sourceJoints.get(name)?.parent;
    if (parent) pendingRelevantJoints.push(parent);
  }
  const inferred = new Map<string, string>();
  const ambiguousTargetMappings = new Map<string, string[]>();
  for (const sourceJoint of sourceProfile.joints) {
    const explicit = jointMap[sourceJoint.name];
    const exact = targetJoints.has(sourceJoint.name) ? sourceJoint.name : undefined;
    const candidates = exact || explicit
      ? []
      : [...targetJoints.keys()].filter(name => name.toLowerCase() === sourceJoint.name.toLowerCase()).sort();
    const mapped = explicit ?? exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (mapped && targetJoints.has(mapped)) inferred.set(sourceJoint.name, mapped);
    else if (!explicit && !exact && candidates.length > 1 && relevantSourceJoints.has(sourceJoint.name)) ambiguousTargetMappings.set(sourceJoint.name, candidates);
  }
  const mappedOutput = new Map<string, string>();
  const skipped: string[] = [];
  const skippedChannels: { joint: string; channel: 'base' | 'rootMotion' | 'layer'; layerId?: string; layerName?: string; reason: 'source_joint_missing' | 'source_joint_not_driven' | 'no_target_mapping' | 'ambiguous_target_mapping' | 'target_joint_missing' | 'target_joint_not_driven' }[] = [];
  const jointDiagnostics: { source: string; target: string; sourceSegmentLength: number; targetSegmentLength: number; rawLengthRatio: number | null; appliedTranslationScale: number; translationScaleClamped: boolean; basisDifferenceDegrees: number }[] = [];
  const retargetTrack = (track: AnimationRecipe['tracks'][number], channel: 'base' | 'rootMotion' | 'layer', layer?: { id: string; name: string }) => {
    const sourceJoint = sourceJoints.get(track.joint);
    const targetName = jointMap[track.joint] ?? inferred.get(track.joint);
    const targetJoint = targetName ? targetJoints.get(targetName) : undefined;
    const reason = !sourceJoint ? 'source_joint_missing'
      : !sourceJoint.driven ? 'source_joint_not_driven'
        : !targetName ? ambiguousTargetMappings.has(track.joint) ? 'ambiguous_target_mapping' : 'no_target_mapping'
          : !targetJoint ? 'target_joint_missing'
            : !targetJoint.driven ? 'target_joint_not_driven' : undefined;
    if (reason) {
      skipped.push(track.joint);
      skippedChannels.push({ joint: track.joint, channel, ...(layer ? { layerId: layer.id, layerName: layer.name } : {}), reason });
      return null;
    }
    if (!sourceJoint || !targetName || !targetJoint) throw new Error('Retarget mapping validation lost a required joint profile.');
    const mappedParent = sourceJoint.parent ? jointMap[sourceJoint.parent] ?? inferred.get(sourceJoint.parent) : undefined;
    if (sourceJoint.parent && mappedParent && targetJoint.parent !== mappedParent) {
      throw new Error(`Hierarchy mismatch for ${track.joint} → ${targetName}: its parent maps to ${mappedParent}, but the target parent is ${targetJoint.parent || '(root)'}.`);
    }
    if (sourceJoint.parent && !mappedParent && targetJoint.parent !== sourceJoint.parent) {
      throw new Error(`Cannot validate parent chain for ${track.joint} → ${targetName}; map the source parent ${sourceJoint.parent} to the corresponding target parent.`);
    }
    mappedOutput.set(targetName, track.joint);
    if (!jointDiagnostics.some(item => item.source === track.joint && item.target === targetName)) {
      const hasLengths = sourceJoint.segmentLength > 0.001 && targetJoint.segmentLength > 0.001;
      const rawLengthRatio = hasLengths ? targetJoint.segmentLength / sourceJoint.segmentLength : null;
      const appliedTranslationScale = scaleTranslation && rawLengthRatio !== null ? Math.max(0.25, Math.min(4, rawLengthRatio)) : 1;
      const basisDot = Math.min(1, Math.abs(sourceJoint.basis.reduce((sum, component, index) => sum + component * targetJoint.basis[index]!, 0)));
      jointDiagnostics.push({
        source: track.joint, target: targetName, sourceSegmentLength: sourceJoint.segmentLength, targetSegmentLength: targetJoint.segmentLength,
        rawLengthRatio, appliedTranslationScale,
        translationScaleClamped: scaleTranslation && rawLengthRatio !== null && Math.abs(appliedTranslationScale - rawLengthRatio) > 1e-10,
        basisDifferenceDegrees: Math.round(2 * Math.acos(basisDot) * 180 / Math.PI * 10000) / 10000,
      });
    }
    return {
      joint: targetName,
      keys: track.keys.map(key => ({
        ...key,
        ...retargetTransform(key.position, key.rotation, sourceJoint, targetJoint, scaleTranslation),
      })),
    };
  };
  const retargetCollection = (items: AnimationRecipe['tracks'], channel: 'base' | 'layer', layer?: { id: string; name: string }) => {
    const targets = new Set<string>();
    return items.map(track => retargetTrack(track, channel, layer)).filter((track): track is NonNullable<typeof track> => {
      if (!track) return false;
      if (targets.has(track.joint)) throw new Error(`Multiple source tracks map to target joint ${track.joint}.`);
      targets.add(track.joint);
      return true;
    });
  };
  const tracks = retargetCollection(source.tracks, 'base');
  const rootMotion = source.rootMotion ? retargetTrack(source.rootMotion, 'rootMotion') ?? undefined : undefined;
  const layers = (source.layers ?? []).map(layer => ({
    ...layer,
    tracks: retargetCollection(layer.tracks, 'layer', { id: layer.id, name: layer.name }),
  }));
  if (skipped.length && !allowPartial) throw new Error(`No safe target mapping for animated joints: ${[...new Set(skippedChannels.map(item => `${item.joint} (${item.channel}${item.layerName ? `: ${item.layerName}` : ''})`))].join(', ')}. Supply explicit jointMap entries or set allowPartial only if dropping those tracks is intended.`);
  if (tracks.length === 0) throw new Error('No source animation joints could be mapped to driven target joints.');
  const recipe = recipeSchema.parse({ ...source, tracks, ...(rootMotion ? { rootMotion } : {}), layers }) as AnimationRecipe;
  return { recipe, report: { sourceRig: sourceProfile.rigName, targetRig: targetProfile.rigName, sourceSignature: sourceProfile.rigSignature, targetSignature: targetProfile.rigSignature, mapped: [...mappedOutput].map(([target, sourceJoint]) => ({ source: sourceJoint, target })), jointDiagnostics, skipped, skippedChannels, ambiguousTargetMappings: [...ambiguousTargetMappings].map(([source, candidates]) => ({ source, candidates })), scaleTranslation } };
}
