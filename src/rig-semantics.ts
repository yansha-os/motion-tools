import { z } from 'zod';
import { retargetProfileSchema } from './retarget.js';

export const rigSemanticRoleSchema = z.enum([
  'root', 'pelvis', 'torso', 'head',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_hand', 'right_hand',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_foot', 'right_foot',
]);
export type RigSemanticRole = z.infer<typeof rigSemanticRoleSchema>;

type Resolution = {
  role: RigSemanticRole;
  status: 'exact' | 'inferred' | 'ambiguous' | 'unavailable';
  joint?: string;
  candidates: string[];
  evidence: string[];
  jointContext?: JointContext;
  candidateContexts?: JointCandidateContext[];
  omittedCandidateContextCount?: number;
};

type JointContextNode = { name: string; parent: string; driven: boolean; restBasisQuaternion: [number, number, number, number]; segmentLengthStuds: number };
type JointContext = { rootToJoint: JointContextNode[]; chainStatus: 'complete' | 'parent_missing' | 'cycle_detected' | 'depth_capped'; limitation: string };
type JointCandidateContext = { joint: string; context: JointContext };
const maxContextChainDepth = 12;
const maxCandidateContexts = 8;

function jointContext(profile: z.infer<typeof retargetProfileSchema>, jointName: string): JointContext {
  const byName = new Map(profile.joints.map(joint => [joint.name, joint]));
  let current = byName.get(jointName);
  const reverseChain: JointContextNode[] = [];
  const visited = new Set<string>();
  let chainStatus: JointContext['chainStatus'] = 'complete';
  while (current) {
    if (visited.has(current.name)) { chainStatus = 'cycle_detected'; break; }
    if (reverseChain.length >= maxContextChainDepth) { chainStatus = 'depth_capped'; break; }
    visited.add(current.name);
    reverseChain.push({ name: current.name, parent: current.parent, driven: current.driven,
      restBasisQuaternion: current.basis, segmentLengthStuds: current.segmentLength });
    if (!current.parent) break;
    const parent = byName.get(current.parent);
    if (!parent) { chainStatus = 'parent_missing'; break; }
    current = parent;
  }
  return { rootToJoint: reverseChain.reverse(), chainStatus,
    limitation: 'This is inspected hierarchy and rest-basis metadata. The quaternion is a rest orientation, not an anatomical axis/limit, and segment length does not establish visible geometry or motion quality.' };
}

const standardNames: Record<RigSemanticRole, { R6?: string[]; R15?: string[] }> = {
  root: { R6: ['HumanoidRootPart'], R15: ['HumanoidRootPart'] },
  pelvis: { R15: ['LowerTorso'] },
  torso: { R6: ['Torso'], R15: ['UpperTorso'] },
  head: { R6: ['Head'], R15: ['Head'] },
  left_shoulder: { R6: ['Left Arm'], R15: ['LeftUpperArm'] },
  right_shoulder: { R6: ['Right Arm'], R15: ['RightUpperArm'] },
  left_elbow: { R15: ['LeftLowerArm'] },
  right_elbow: { R15: ['RightLowerArm'] },
  left_hand: { R6: ['Left Arm'], R15: ['LeftHand'] },
  right_hand: { R6: ['Right Arm'], R15: ['RightHand'] },
  left_hip: { R6: ['Left Leg'], R15: ['LeftUpperLeg'] },
  right_hip: { R6: ['Right Leg'], R15: ['RightUpperLeg'] },
  left_knee: { R15: ['LeftLowerLeg'] },
  right_knee: { R15: ['RightLowerLeg'] },
  left_foot: { R6: ['Left Leg'], R15: ['LeftFoot'] },
  right_foot: { R6: ['Right Leg'], R15: ['RightFoot'] },
};

function tokens(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLocaleLowerCase('en-US').split(/[^a-z0-9]+/).filter(Boolean);
}

export function matchesRigLimbChainName(name: string, side: 'left' | 'right', limb: 'arm' | 'leg') {
  const parts = tokens(name);
  const has = (...values: string[]) => values.some(value => parts.includes(value));
  const sideMatch = side === 'left' ? has('left', 'l') : has('right', 'r');
  const limbMatch = limb === 'arm'
    ? has('arm', 'shoulder', 'elbow', 'forearm', 'hand', 'wrist')
    : has('leg', 'hip', 'thigh', 'knee', 'shin', 'foot', 'ankle');
  return sideMatch && limbMatch;
}

function semanticMatches(role: RigSemanticRole, name: string): boolean {
  const parts = tokens(name);
  const has = (...values: string[]) => values.some(value => parts.includes(value));
  const side = role.startsWith('left_') ? 'left' : role.startsWith('right_') ? 'right' : null;
  if (!side && has('left', 'right', 'l', 'r')) return false;
  if (side) {
    const sideTokens = side === 'left' ? ['left', 'l'] : ['right', 'r'];
    if (!has(...sideTokens)) return false;
  }
  const anatomy = parts.filter(part => !['left', 'right', 'l', 'r', 'joint', 'motor', 'motor6d', 'part', 'bone'].includes(part));
  const hasAnatomy = (...values: string[]) => values.some(value => anatomy.includes(value));
  switch (role) {
    case 'root': return hasAnatomy('root', 'rootpart', 'humanoidrootpart');
    case 'pelvis': return hasAnatomy('pelvis', 'hips', 'hip') || (hasAnatomy('torso') && hasAnatomy('lower', 'bottom'));
    case 'torso': return hasAnatomy('chest', 'ribcage') || (hasAnatomy('torso') && hasAnatomy('upper', 'chest'));
    case 'head': return hasAnatomy('head', 'skull');
    case 'left_shoulder': case 'right_shoulder': return hasAnatomy('shoulder') || (hasAnatomy('arm') && hasAnatomy('upper'))
      || (hasAnatomy('arm') && !hasAnatomy('lower', 'forearm', 'elbow'));
    case 'left_elbow': case 'right_elbow': return hasAnatomy('elbow', 'forearm') || (hasAnatomy('arm') && hasAnatomy('lower'));
    case 'left_hand': case 'right_hand': return hasAnatomy('hand', 'palm', 'wrist');
    case 'left_hip': case 'right_hip': return hasAnatomy('thigh', 'hip') || (hasAnatomy('leg') && hasAnatomy('upper'))
      || (hasAnatomy('leg') && !hasAnatomy('lower', 'knee', 'shin'));
    case 'left_knee': case 'right_knee': return hasAnatomy('knee', 'shin') || (hasAnatomy('leg') && hasAnatomy('lower'));
    case 'left_foot': case 'right_foot': return hasAnatomy('foot', 'ankle');
  }
}

/** Resolve semantic body-role names conservatively; inferred names are suggestions, never rig truth. */
export function resolveRigSemanticRoles(profileInput: unknown, requestedRoles?: unknown) {
  const profile = retargetProfileSchema.parse(profileInput);
  const roles = requestedRoles === undefined
    ? rigSemanticRoleSchema.options
    : z.array(rigSemanticRoleSchema).min(1).max(rigSemanticRoleSchema.options.length).parse(requestedRoles);
  if (new Set(roles).size !== roles.length) throw new Error('Requested semantic roles must be unique.');
  const driven = profile.joints.filter(joint => joint.driven);
  const contextFor = (joint: string): JointContext => jointContext(profile, joint);
  const resolutions: Resolution[] = roles.map(role => {
    const standard = profile.rigType === 'custom' ? [] : standardNames[role][profile.rigType] ?? [];
    const exactCandidates = standard.filter(name => driven.some(joint => joint.name === name));
    if (exactCandidates.length === 1) {
      const joint = exactCandidates[0]!;
      const endpointAlias = profile.rigType === 'R6' && ['left_hand', 'right_hand', 'left_foot', 'right_foot'].includes(role);
      return { role, status: 'exact', joint, candidates: [joint], jointContext: contextFor(joint), evidence: [
        `Exact ${profile.rigType} convention name matched a driven joint.`,
        ...(endpointAlias ? ['R6 exposes this limb as one driven segment; the hand/foot label is an endpoint role, not a separate wrist/ankle joint.'] : []),
      ] };
    }
    const inferred = driven.filter(joint => semanticMatches(role, joint.name)).map(joint => joint.name).sort((a, b) => a.localeCompare(b));
    if (inferred.length === 1) return { role, status: 'inferred', joint: inferred[0], candidates: inferred, jointContext: contextFor(inferred[0]!),
      evidence: ['Unique joint-name token match only; no positional, axis, or anatomical-limit evidence is available.'] };
    if (inferred.length > 1) return { role, status: 'ambiguous', candidates: inferred,
      candidateContexts: inferred.slice(0, maxCandidateContexts).map(joint => ({ joint, context: contextFor(joint) })),
      omittedCandidateContextCount: Math.max(0, inferred.length - maxCandidateContexts),
      evidence: ['Multiple driven joints match the role name; choose the intended exact joint explicitly.'] };
    return { role, status: 'unavailable', candidates: [], evidence: [
      standard.length ? `No driven ${profile.rigType} convention joint named ${standard.join(' or ')} was found.` : `The ${profile.rigType} rig convention does not expose a separate joint for this role.`,
      'The profile contains no geometry/axis evidence that would justify guessing an alternative.',
    ] };
  });
  return {
    rig: { id: profile.rigId, name: profile.rigName, type: profile.rigType, signature: profile.rigSignature },
    drivenJointCount: driven.length,
    resolutions,
    limitations: [
      'Exact indicates a recognized R6/R15 joint-name convention, not verified anatomy or motion quality.',
      'Inferred indicates names only; it never uses spatial position, local joint axes, mesh shape, or anatomical limits.',
      'jointContext exposes the inspected root-to-joint parent chain, rest-basis quaternions, and segment-length estimates; these do not establish anatomy, joint limits, or screen-space orientation.',
      'Ambiguous and unavailable roles have no selected joint. Do not silently choose a candidate.',
      'R6 arms and legs are single driven segments; hand/foot matches identify the limb endpoint, not a separate joint.',
    ],
  };
}
