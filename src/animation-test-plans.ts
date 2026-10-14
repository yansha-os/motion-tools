import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { formatAnimationTime } from './time-format.js';
import { fingerprint } from './inspection.js';
import { Library } from './library.js';
import { identifier, label } from './recipes.js';
import { animationTestCaseSchema } from './animation-tests.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contactSegmentSchema = z.object({ startTime: z.number().finite().min(0).max(30), endTime: z.number().finite().min(0).max(30),
  startSampleId: z.string().regex(/^s\d{3}$/), endSampleId: z.string().regex(/^s\d{3}$/), displacementStuds: z.number().finite().nonnegative() }).strict()
  .superRefine((segment, ctx) => { if (segment.startTime >= segment.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'A contact evidence segment must have positive duration.' }); });
const pinnedCaseSchema = animationTestCaseSchema.and(z.object({ expectedFingerprint: hash }).passthrough());
const planSchema = z.object({
  id: identifier, parentId: identifier.optional(), name: label, revision: z.number().int().positive(),
  createdAt: z.string().datetime(), cases: z.array(pinnedCaseSchema).min(1).max(8),
}).strict().superRefine((plan, ctx) => {
  const ids = plan.cases.map(testCase => testCase.assetId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['cases'], message: 'Each test plan may include an animation only once.' });
});
const checkSchema = z.object({
  id: z.string().min(1).max(160), status: z.enum(['passed', 'failed', 'unknown']), detail: z.string().max(4000),
  observed: z.union([z.number().finite(), z.string().max(4000), z.boolean()]).optional(),
  expected: z.union([z.number().finite(), z.string().max(4000), z.boolean()]).optional(), unit: z.string().max(100).optional(),
  sampleIds: z.array(z.string().regex(/^s\d{3}$/)).max(128).optional(),
  segment: contactSegmentSchema.optional(),
}).strict().superRefine((check, ctx) => {
  if (!check.segment) return;
  if (!check.id.endsWith(':step-speed')) ctx.addIssue({ code: 'custom', path: ['segment'], message: 'Structured contact segments are only valid on step-speed checks.' });
  if (typeof check.observed !== 'number' || check.unit !== 'studs/second') ctx.addIssue({ code: 'custom', path: ['observed'], message: 'A structured step-speed segment requires a numeric studs/second measurement.' });
  if (!check.sampleIds || check.sampleIds.length !== 2 || check.sampleIds[0] !== check.segment.startSampleId || check.sampleIds[1] !== check.segment.endSampleId) {
    ctx.addIssue({ code: 'custom', path: ['sampleIds'], message: 'Step-speed sample IDs must exactly match the structured segment endpoints.' });
  }
  if (typeof check.observed === 'number') {
    const measuredSpeed = check.segment.displacementStuds / (check.segment.endTime - check.segment.startTime);
    if (Math.abs(check.observed - measuredSpeed) > Math.max(1e-8, Math.abs(measuredSpeed) * 1e-6)) {
      ctx.addIssue({ code: 'custom', path: ['observed'], message: 'Step-speed value does not match segment displacement divided by segment duration.' });
    }
  }
});
const testResultSchema = z.object({ assetId: identifier, fingerprint: hash, status: z.enum(['passed', 'failed', 'incomplete']), checks: z.array(checkSchema).max(512) }).strict()
  .superRefine((result, ctx) => {
    const ids = result.checks.map(check => check.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['checks'], message: 'A test result cannot contain duplicate check IDs.' });
  });
const runSchema = z.object({
  id: identifier, planId: identifier, planRevision: z.number().int().positive(), runAt: z.string().datetime(),
  rigId: identifier, rigSignature: z.string().min(1).max(30000), status: z.enum(['passed', 'failed', 'incomplete']),
  summary: z.object({ requested: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), incomplete: z.number().int().nonnegative() }).strict(),
  results: z.array(testResultSchema).min(1).max(8),
}).strict();
export type AnimationTestPlan = z.infer<typeof planSchema>;
export type AnimationTestPlanRun = z.infer<typeof runSchema>;
type ComparisonStatus = 'regression' | 'improvement' | 'stable' | 'unresolved' | 'criteria_changed';

function expectedTestCheckIds(testCase: AnimationTestPlan['cases'][number]) {
  const ids = ['asset_fingerprint'];
  if (testCase.duration) ids.push('duration');
  if (testCase.loop !== undefined) ids.push('loop');
  ids.push(...testCase.requiredMarkers.map(marker => `marker:${marker}`));
  ids.push(...testCase.requiredTracks.map(joint => `track:${joint}`));
  if (testCase.maxPeakAngularSpeedDegreesPerSecond !== undefined) ids.push('max_peak_angular_speed');
  if (testCase.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond !== undefined) ids.push('max_loop_seam_position_velocity_discontinuity');
  if (testCase.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond !== undefined) ids.push('max_loop_seam_angular_velocity_discontinuity');
  if (testCase.maxLoopComposedPositionOffsetStuds !== undefined) ids.push('max_loop_composed_position_offset');
  if (testCase.maxLoopComposedAngularOffsetDegrees !== undefined) ids.push('max_loop_composed_angular_offset');
  for (const requirement of testCase.jointLoopLimits ?? []) {
    if (requirement.maxPositionOffsetStuds !== undefined) ids.push(`loop-joint:${requirement.joint}:position`);
    if (requirement.maxAngularOffsetDegrees !== undefined) ids.push(`loop-joint:${requirement.joint}:angular`);
  }
  for (const [index, bendPlane] of testCase.bendPlanes.entries()) ids.push(`bend-plane:${bendPlane.effector}:${index + 1}`);
  for (const [index, contact] of testCase.contacts.entries()) {
    const prefix = `contact:${contact.effector}:${index + 1}`;
    ids.push(prefix);
    if (contact.maxAngularDriftDegrees !== undefined) ids.push(`${prefix}:rotation`);
    if (contact.maxGroundOffsetStuds !== undefined) ids.push(`${prefix}:ground`);
    if (contact.targetPosition !== undefined) ids.push(`${prefix}:target`);
    if (contact.targetOrientation !== undefined) ids.push(`${prefix}:orientation-target`);
    if (contact.maxCumulativeTravelStuds !== undefined) ids.push(`${prefix}:travel`);
    if (contact.maxStepSpeedStudsPerSecond !== undefined) ids.push(`${prefix}:step-speed`);
  }
  return [...new Set(ids)];
}

function checkEvidencePlan(testCase: AnimationTestPlan['cases'][number], checkId: string) {
  if (checkId === 'asset_fingerprint' || checkId === 'duration' || checkId === 'loop' || checkId.startsWith('marker:')) {
    return { checkId, evidenceSource: 'saved_recipe' as const, requiredStudioEvidence: [] as string[] };
  }
  if (checkId === 'max_peak_angular_speed' || checkId === 'max_loop_seam_position_velocity_discontinuity' || checkId === 'max_loop_seam_angular_velocity_discontinuity'
    || checkId === 'max_loop_composed_position_offset' || checkId === 'max_loop_composed_angular_offset' || checkId.startsWith('loop-joint:')) {
    return { checkId, evidenceSource: 'offline_recipe_analysis' as const, requiredStudioEvidence: [] as string[] };
  }
  if (checkId.startsWith('track:')) {
    return { checkId, evidenceSource: 'live_studio' as const,
      requiredStudioEvidence: ['A recent inspection of the target rig', 'A driven joint matching the required recipe track'] };
  }
  const bendPlaneMatch = /^bend-plane:(.*):(\d+)$/.exec(checkId);
  if (bendPlaneMatch) {
    const bendPlane = testCase.bendPlanes[Number(bendPlaneMatch[2]) - 1];
    if (!bendPlane || bendPlane.effector.toLowerCase() !== bendPlaneMatch[1]!.toLowerCase()) {
      return { checkId, evidenceSource: 'unknown' as const, requiredStudioEvidence: ['Check ID does not map to a declared bend-plane criterion'] };
    }
    return { checkId, evidenceSource: 'live_studio' as const,
      bendPlaneWindow: { rootJoint: bendPlane.rootJoint, middleJoint: bendPlane.middleJoint, effector: bendPlane.effector,
        start: bendPlane.start, end: bendPlane.end, minSamples: bendPlane.minSamples, maxSampleGapSeconds: bendPlane.maxSampleGapSeconds },
      requiredStudioEvidence: ['Actual joint-pivot positions throughout the interval', 'Three driven joints in a direct parent-child chain', 'A measurable non-degenerate bend plane'] };
  }
  const match = /^contact:(.*):(\d+)(?::(rotation|ground|target|orientation-target|travel|step-speed))?$/.exec(checkId);
  if (!match) return { checkId, evidenceSource: 'unknown' as const, requiredStudioEvidence: ['Review the check definition before relying on it'] };
  const contact = testCase.contacts[Number(match[2]) - 1];
  if (!contact || contact.effector.toLowerCase() !== match[1]!.toLowerCase()) {
    return { checkId, evidenceSource: 'unknown' as const, requiredStudioEvidence: ['Check ID does not map to a declared contact criterion'] };
  }
  const measure = match[3];
  const requiredStudioEvidence = measure === 'rotation' ? ['Orientation samples throughout the contact window']
    : measure === 'ground' ? ['A recognized foot effector with a sole bound', 'A measured rest-ground plane']
      : measure === 'target' ? ['Pivot-local effector positions throughout the contact window']
        : measure === 'orientation-target' ? ['Pivot-local effector orientations throughout the contact window']
          : measure === 'travel' || measure === 'step-speed' ? ['Ordered effector position samples throughout the contact window']
            : ['A driven effector on the target rig', 'Effector positions throughout the contact window'];
  return { checkId, evidenceSource: 'live_studio' as const,
    contactWindow: { effector: contact.effector, kind: contact.kind, start: contact.start, end: contact.end,
      minSamples: contact.minSamples, maxSampleGapSeconds: contact.maxSampleGapSeconds },
    requiredStudioEvidence };
}

function criterionForCheck(testCase: AnimationTestPlan['cases'][number] | undefined, checkId: string) {
  if (!testCase) return undefined;
  if (checkId === 'asset_fingerprint') return 'pinned-animation-content';
  if (checkId === 'duration') return testCase.duration;
  if (checkId === 'loop') return testCase.loop;
  if (checkId === 'max_peak_angular_speed') return { limit: testCase.maxPeakAngularSpeedDegreesPerSecond, motionMode: testCase.motionMode };
  if (checkId === 'max_loop_seam_position_velocity_discontinuity') return testCase.maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond;
  if (checkId === 'max_loop_seam_angular_velocity_discontinuity') return testCase.maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond;
  if (checkId === 'max_loop_composed_position_offset') return testCase.maxLoopComposedPositionOffsetStuds;
  if (checkId === 'max_loop_composed_angular_offset') return testCase.maxLoopComposedAngularOffsetDegrees;
  const loopJointMatch = /^loop-joint:(.*):(position|angular)$/.exec(checkId);
  if (loopJointMatch) {
    const requirement = testCase.jointLoopLimits?.find(value => value.joint === loopJointMatch[1]);
    if (!requirement) return undefined;
    return { joint: requirement.joint, limit: loopJointMatch[2] === 'position' ? requirement.maxPositionOffsetStuds : requirement.maxAngularOffsetDegrees };
  }
  if (checkId.startsWith('marker:')) {
    const marker = testCase.requiredMarkers.find(item => item.toLowerCase() === checkId.slice('marker:'.length).toLowerCase());
    return marker?.toLowerCase();
  }
  if (checkId.startsWith('track:')) {
    const track = testCase.requiredTracks.find(item => item.toLowerCase() === checkId.slice('track:'.length).toLowerCase());
    return track?.toLowerCase();
  }
  const bendPlaneMatch = /^bend-plane:(.*):(\d+)$/.exec(checkId);
  if (bendPlaneMatch) {
    const bendPlane = testCase.bendPlanes[Number(bendPlaneMatch[2]) - 1];
    if (!bendPlane || bendPlane.effector.toLowerCase() !== bendPlaneMatch[1]!.toLowerCase()) return undefined;
    return { rootJoint: bendPlane.rootJoint.toLowerCase(), middleJoint: bendPlane.middleJoint.toLowerCase(), effector: bendPlane.effector.toLowerCase(),
      start: bendPlane.start, end: bendPlane.end, poleTarget: bendPlane.poleTarget, maxDeviationDegrees: bendPlane.maxDeviationDegrees,
      minSamples: bendPlane.minSamples, maxSampleGapSeconds: bendPlane.maxSampleGapSeconds, motionMode: testCase.motionMode };
  }
  const contactMatch = /^contact:(.*):(\d+)(?::(rotation|ground|target|orientation-target|travel|step-speed))?$/.exec(checkId);
  if (contactMatch) {
    const contact = testCase.contacts[Number(contactMatch[2]) - 1];
    if (!contact || contact.effector.toLowerCase() !== contactMatch[1]!.toLowerCase()) return undefined;
    const common = { effector: contact.effector.toLowerCase(), kind: contact.kind, start: contact.start, end: contact.end,
      minSamples: contact.minSamples, maxSampleGapSeconds: contact.maxSampleGapSeconds, motionMode: testCase.motionMode };
    if (contactMatch[3] === 'rotation') return { ...common, maxAngularDriftDegrees: contact.maxAngularDriftDegrees };
    if (contactMatch[3] === 'ground') return { ...common, maxGroundOffsetStuds: contact.maxGroundOffsetStuds };
    if (contactMatch[3] === 'target') return { ...common, targetPosition: contact.targetPosition, maxTargetDistanceStuds: contact.maxTargetDistanceStuds };
    if (contactMatch[3] === 'orientation-target') return { ...common, targetOrientation: contact.targetOrientation, maxAngularTargetErrorDegrees: contact.maxAngularTargetErrorDegrees };
    if (contactMatch[3] === 'travel') return { ...common, maxCumulativeTravelStuds: contact.maxCumulativeTravelStuds };
    if (contactMatch[3] === 'step-speed') return { ...common, maxStepSpeedStudsPerSecond: contact.maxStepSpeedStudsPerSecond };
    return { ...common, maxDriftStuds: contact.maxDriftStuds };
  }
  return undefined;
}

function measurementSignatureForCheck(testCase: AnimationTestPlan['cases'][number] | undefined, checkId: string) {
  if (!testCase) return undefined;
  if (checkId === 'max_peak_angular_speed') return 'peak-local-angular-speed-degrees-per-second';
  if (checkId === 'max_loop_seam_position_velocity_discontinuity') return 'approx-loop-seam-position-velocity-discontinuity-studs-per-second';
  if (checkId === 'max_loop_seam_angular_velocity_discontinuity') return 'approx-loop-seam-angular-velocity-discontinuity-degrees-per-second';
  const bendPlaneMatch = /^bend-plane:(.*):(\d+)$/.exec(checkId);
  if (bendPlaneMatch) {
    const bendPlane = testCase.bendPlanes[Number(bendPlaneMatch[2]) - 1];
    if (!bendPlane || bendPlane.effector.toLowerCase() !== bendPlaneMatch[1]!.toLowerCase()) return undefined;
    return JSON.stringify({ rootJoint: bendPlane.rootJoint.toLowerCase(), middleJoint: bendPlane.middleJoint.toLowerCase(), effector: bendPlane.effector.toLowerCase(),
      start: bendPlane.start, end: bendPlane.end, poleTarget: bendPlane.poleTarget, measure: 'joint-pivot-bend-plane-deviation' });
  }
  const contactMatch = /^contact:(.*):(\d+)(?::(rotation|ground|target|orientation-target|travel|step-speed))?$/.exec(checkId);
  if (!contactMatch) return undefined;
  const contact = testCase.contacts[Number(contactMatch[2]) - 1];
  if (!contact || contact.effector.toLowerCase() !== contactMatch[1]!.toLowerCase()) return undefined;
  return JSON.stringify({ effector: contact.effector.toLowerCase(), kind: contact.kind, start: contact.start, end: contact.end,
    measure: contactMatch[3] ?? 'position_drift' });
}

async function writeNewRecord(path: string, record: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(record, null, 2), { flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function deterministicPlanId(draftFingerprint: string) {
  const bytes = createHash('sha256').update(`motion-tools:test-plan:${draftFingerprint}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return identifier.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

function fingerprintPlanDraft(name: string, parentPlan: { id: string; revision: number } | null, cases: AnimationTestPlan['cases']) {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, name, parentPlan, cases })).digest('hex');
}

async function writeRecordIfAbsent(path: string, record: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(record, null, 2), { flag: 'wx' });
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class AnimationTestPlanLibrary {
  constructor(readonly directory: string, readonly runsDirectory: string, readonly animations: Library) {}

  private async load(id: string) {
    identifier.parse(id);
    const plan = planSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
    if (plan.id !== id) throw new Error('Animation test plan identity mismatch.');
    return plan;
  }

  private assertRunMatchesPlan(plan: AnimationTestPlan, run: AnimationTestPlanRun) {
    if (run.planId !== plan.id || run.planRevision !== plan.revision) throw new Error(`Run ${run.id} does not belong to the requested plan revision.`);
    const expectedIds = plan.cases.map(testCase => testCase.assetId).sort();
    const actualIds = run.results.map(result => result.assetId).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) throw new Error('Run results must include exactly one result for every animation in the pinned plan.');
    const pinnedCases = new Map(plan.cases.map(testCase => [testCase.assetId, testCase]));
    for (const result of run.results) {
      const pinned = pinnedCases.get(result.assetId)!;
      const expectedChecks = expectedTestCheckIds(pinned);
      const actualChecks = new Set(result.checks.map(check => check.id));
      const missingChecks = expectedChecks.filter(checkId => !actualChecks.has(checkId));
      const fingerprintCheck = result.checks.find(check => check.id === 'asset_fingerprint');
      if (result.fingerprint !== pinned.expectedFingerprint && (result.status !== 'failed' || fingerprintCheck?.status !== 'failed'
        || fingerprintCheck.observed !== result.fingerprint || fingerprintCheck.expected !== pinned.expectedFingerprint)) {
        throw new Error(`Run for animation ${result.assetId} reports a fingerprint different from its pinned plan revision without an explicit failed asset_fingerprint check.`);
      }
      if (result.fingerprint === pinned.expectedFingerprint && (fingerprintCheck?.status !== 'passed'
        || fingerprintCheck.observed !== pinned.expectedFingerprint || fingerprintCheck.expected !== pinned.expectedFingerprint)) {
        throw new Error(`Run for animation ${result.assetId} must include a passing asset_fingerprint check matching its pinned plan revision.`);
      }
      const failedChecks = result.checks.filter(check => check.status === 'failed');
      const unknownChecks = result.checks.filter(check => check.status === 'unknown');
      const expectedResultStatus = failedChecks.length > 0 || result.fingerprint !== pinned.expectedFingerprint ? 'failed'
        : missingChecks.length > 0 || unknownChecks.length > 0 ? 'incomplete' : 'passed';
      if (result.status !== expectedResultStatus) {
        throw new Error(`Run result for animation ${result.assetId} is ${result.status}, but its checks and declared criteria require ${expectedResultStatus}${missingChecks.length ? ` (missing: ${missingChecks.join(', ')})` : ''}.`);
      }
    }
    const passed = run.results.filter(result => result.status === 'passed').length;
    const failed = run.results.filter(result => result.status === 'failed').length;
    const incomplete = run.results.filter(result => result.status === 'incomplete').length;
    if (run.summary.requested !== run.results.length || run.summary.passed !== passed || run.summary.failed !== failed || run.summary.incomplete !== incomplete) {
      throw new Error('Run summary does not match its per-animation results.');
    }
    const expectedStatus = failed ? 'failed' : incomplete ? 'incomplete' : 'passed';
    if (run.status !== expectedStatus) throw new Error('Run status does not match the per-animation results.');
  }

  async preview(nameInput: string, casesInput: unknown, parentId?: string) {
    const name = label.parse(nameInput);
    const cases = z.array(animationTestCaseSchema).min(1).max(8).parse(casesInput);
    const ids = cases.map(item => item.assetId);
    if (new Set(ids).size !== ids.length) throw new Error('Each test plan may include an animation only once.');
    const parent = parentId ? await this.get(parentId) : undefined;
    const pinnedCases = await Promise.all(cases.map(async testCase => {
      const asset = await this.animations.get(testCase.assetId);
      if (asset.recipe.kind !== 'animation') throw new Error(`Test plan asset ${testCase.assetId} is not an animation.`);
      const currentFingerprint = fingerprint(asset.recipe);
      if (testCase.expectedFingerprint && testCase.expectedFingerprint !== currentFingerprint) throw new Error(`Animation ${testCase.assetId} no longer matches the supplied fingerprint. Read the current recipe and explicitly review it before creating a new test plan revision.`);
      const pinned = pinnedCaseSchema.parse({ ...testCase, expectedFingerprint: currentFingerprint });
      const declaredCheckIds = expectedTestCheckIds(pinned);
      const checkRequirements = declaredCheckIds.map(checkId => checkEvidencePlan(pinned, checkId));
      const liveStudioCheckIds = checkRequirements.filter(check => check.evidenceSource === 'live_studio').map(check => check.checkId);
      return { assetId: asset.id, animationName: asset.recipe.name, currentFingerprint, pinned,
        declaredCheckIds, checkRequirements,
        validationPlan: { requiresLiveStudio: liveStudioCheckIds.length > 0,
          liveStudioCheckIds,
          offlineCheckIds: checkRequirements.filter(check => check.evidenceSource !== 'live_studio').map(check => check.checkId),
          requiredDrivenJoints: [...new Set([...pinned.requiredTracks, ...pinned.contacts.map(contact => contact.effector), ...pinned.bendPlanes.flatMap(bendPlane => [bendPlane.rootJoint, bendPlane.middleJoint, bendPlane.effector])])],
          contactWindows: pinned.contacts.map(contact => ({ effector: contact.effector, kind: contact.kind,
            start: contact.start, end: contact.end, minSamples: contact.minSamples, maxSampleGapSeconds: contact.maxSampleGapSeconds })),
          bendPlaneWindows: pinned.bendPlanes.map(({ rootJoint, middleJoint, effector, start, end, minSamples, maxSampleGapSeconds }) => ({ rootJoint, middleJoint, effector, start, end, minSamples, maxSampleGapSeconds })) } };
    }));
    const parentPlan = parent ? { id: parent.id, revision: parent.revision } : null;
    const pinned = pinnedCases.map(item => item.pinned);
    const draftFingerprint = fingerprintPlanDraft(name, parentPlan, pinned);
    return { name, parentPlan,
      proposedRevision: parent ? parent.revision + 1 : 1,
      proposedPlanId: deterministicPlanId(draftFingerprint), cases: pinned, draftFingerprint,
      review: pinnedCases.map(({ assetId, animationName, currentFingerprint, declaredCheckIds, checkRequirements, validationPlan }) => ({
        assetId, animationName, currentFingerprint, declaredCheckIds, checkRequirements, validationPlan })),
      willWrite: false, commitTool: 'motion_animation_test_plan_create',
      limitation: 'This preview validates and fingerprints the proposed criteria but does not claim they are artistically sufficient. Confirm the checks and thresholds before creating or running the immutable plan.' };
  }

  async create(name: string, casesInput: unknown, parentId?: string, expectedDraftFingerprint?: string) {
    const reviewedFingerprint = expectedDraftFingerprint === undefined ? undefined : hash.parse(expectedDraftFingerprint);
    if (reviewedFingerprint) {
      let existing: AnimationTestPlan | undefined;
      try { existing = await this.load(deterministicPlanId(reviewedFingerprint)); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existing) {
        const normalizedName = label.parse(name);
        const normalizedCases = z.array(animationTestCaseSchema).min(1).max(8).parse(casesInput);
        const requestedParent = parentId ? await this.get(parentId) : undefined;
        const requestedParentPlan = requestedParent ? { id: requestedParent.id, revision: requestedParent.revision } : null;
        const existingParentPlan = existing.parentId ? await this.get(existing.parentId) : undefined;
        const pinnedByAsset = new Map(existing.cases.map(testCase => [testCase.assetId, testCase]));
        const matchingCases = normalizedCases.map(testCase => {
          const pinned = pinnedByAsset.get(testCase.assetId);
          if (!pinned || (testCase.expectedFingerprint !== undefined && testCase.expectedFingerprint !== pinned.expectedFingerprint)) return undefined;
          return pinnedCaseSchema.parse({ ...testCase, expectedFingerprint: pinned.expectedFingerprint });
        });
        const sameRequest = normalizedName === existing.name
          && JSON.stringify(requestedParentPlan) === JSON.stringify(existingParentPlan ? { id: existingParentPlan.id, revision: existingParentPlan.revision } : null)
          && existing.revision === (requestedParentPlan ? requestedParentPlan.revision + 1 : 1)
          && normalizedCases.length === existing.cases.length && matchingCases.every((item): item is AnimationTestPlan['cases'][number] => item !== undefined)
          && JSON.stringify(matchingCases) === JSON.stringify(existing.cases)
          && fingerprintPlanDraft(normalizedName, requestedParentPlan, matchingCases as AnimationTestPlan['cases']) === reviewedFingerprint;
        if (!sameRequest) throw new Error('The reviewed draft fingerprint belongs to a different immutable plan request.');
        return existing;
      }
    }
    const draft = await this.preview(name, casesInput, parentId);
    if (reviewedFingerprint !== undefined && draft.draftFingerprint !== reviewedFingerprint) {
      throw new Error('The test-plan draft differs from the reviewed preview. Re-preview the current cases and fingerprints before committing.');
    }
    if (draft.parentPlan) {
      const currentParent = await this.get(draft.parentPlan.id);
      if (currentParent.revision !== draft.parentPlan.revision) throw new Error('The parent plan revision changed after preview; review a fresh draft before committing.');
    }
    for (const testCase of draft.cases) {
      const asset = await this.animations.get(testCase.assetId);
      if (asset.recipe.kind !== 'animation' || fingerprint(asset.recipe) !== testCase.expectedFingerprint) {
        throw new Error(`Animation ${testCase.assetId} changed after plan preview; review a fresh test-plan draft before committing.`);
      }
    }
    const plan = planSchema.parse({ id: draft.proposedPlanId, ...(draft.parentPlan ? { parentId: draft.parentPlan.id } : {}), name: draft.name,
      revision: draft.proposedRevision, createdAt: new Date().toISOString(), cases: draft.cases });
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${plan.id}.json`);
    if (await writeRecordIfAbsent(path, plan)) return plan;
    const existing = await this.load(plan.id);
    if (existing.name !== plan.name || existing.parentId !== plan.parentId || existing.revision !== plan.revision
      || JSON.stringify(existing.cases) !== JSON.stringify(plan.cases)) {
      throw new Error('A deterministic test-plan ID already exists with different content; refusing to overwrite the immutable plan.');
    }
    return existing;
  }

  async get(id: string) { return this.load(id); }

  async list(offset = 0, limit = 30) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Plan pagination requires offset ≥ 0 and limit 1–100.');
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    const plans = await Promise.all(files.map(file => this.load(file.slice(0, -5))));
    const rows = await Promise.all(plans.map(async plan => {
      const assets = await Promise.all(plan.cases.map(testCase => this.animations.get(testCase.assetId).catch(() => undefined)));
      const staleAssetCount = assets.reduce((count, asset, index) => count + (asset?.recipe.kind !== 'animation' || fingerprint(asset.recipe) !== plan.cases[index]!.expectedFingerprint ? 1 : 0), 0);
      return { id: plan.id, parentId: plan.parentId, name: plan.name, revision: plan.revision, createdAt: plan.createdAt, caseCount: plan.cases.length, staleAssetCount };
    }));
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { total: rows.length, offset, plans: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  async recordRun(input: unknown) {
    const record = z.record(z.unknown()).parse(input);
    const run = runSchema.parse({ ...record, id: randomUUID() });
    const plan = await this.load(run.planId);
    this.assertRunMatchesPlan(plan, run);
    await mkdir(this.runsDirectory, { recursive: true });
    await writeNewRecord(join(this.runsDirectory, `${run.id}.json`), run);
    return run;
  }

  async listRuns(planId: string, limit = 20) {
    const plan = await this.load(planId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Run history limit must be 1–100.');
    await mkdir(this.runsDirectory, { recursive: true });
    const files = (await readdir(this.runsDirectory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const runs = (await Promise.all(files.map(async file => {
      const run = runSchema.parse(JSON.parse(await readFile(join(this.runsDirectory, file), 'utf8')));
      if (run.id !== file.slice(0, -5)) throw new Error('Animation test run identity mismatch.');
      if (run.planId === planId) this.assertRunMatchesPlan(plan, run);
      return run;
    }))).filter(run => run.planId === planId);
    runs.sort((a, b) => b.runAt.localeCompare(a.runAt) || a.id.localeCompare(b.id));
    return { planId, total: runs.length, runs: runs.slice(0, limit) };
  }

  /** Find bounded, fingerprint-aware persisted test evidence for selected animations. */
  async findAssetEvidence(assets: { assetId: string; currentFingerprint: string }[], targetRigSignature?: string, planLimit = 100) {
    if (!Number.isInteger(planLimit) || planLimit < 1 || planLimit > 100) throw new Error('Evidence plan scan limit must be 1–100.');
    const requested = new Map(assets.map(asset => [asset.assetId, asset.currentFingerprint]));
    if (requested.size !== assets.length) throw new Error('Evidence lookup asset IDs must be unique.');
    const page = await this.list(0, planLimit);
    const loadedPlans = await Promise.all(page.plans.map(plan => this.load(plan.id)));
    const planById = new Map(loadedPlans.map(plan => [plan.id, plan]));
    const runsByPlan = new Map(loadedPlans.map(plan => [plan.id, [] as AnimationTestPlanRun[]]));
    await mkdir(this.runsDirectory, { recursive: true });
    const runFiles = (await readdir(this.runsDirectory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    for (const file of runFiles) {
      const run = runSchema.parse(JSON.parse(await readFile(join(this.runsDirectory, file), 'utf8')));
      if (run.id !== file.slice(0, -5)) throw new Error('Animation test run identity mismatch.');
      const records = runsByPlan.get(run.planId);
      const plan = planById.get(run.planId);
      if (records && plan) {
        this.assertRunMatchesPlan(plan, run);
        records.push(run);
      }
    }
    const perAsset = new Map(assets.map(asset => [asset.assetId, [] as {
      planId: string; planName: string; planRevision: number; runId: string; runAt: string;
      rigId: string; rigSignature: string; rigMatchesTarget: boolean | null;
      fingerprint: string; currentRecipe: boolean; status: 'passed' | 'failed' | 'incomplete';
      checks: { id: string; status: 'passed' | 'failed' | 'unknown'; detail: string; observed?: number | string | boolean; expected?: number | string | boolean; unit?: string }[];
      criteriaCoverage: { requiredCheckIds: string[]; missingCheckIds: string[]; unknownCheckIds: string[]; failedCheckIds: string[]; unplannedCheckIds: string[] };
    }[]]));
    let scannedPlanCount = 0;
    for (const plan of page.plans) {
      scannedPlanCount += 1;
      const history = runsByPlan.get(plan.id)!;
      history.sort((left, right) => right.runAt.localeCompare(left.runAt) || left.id.localeCompare(right.id));
      for (const run of history.slice(0, 100)) for (const result of run.results) {
        const currentFingerprint = requested.get(result.assetId);
        if (currentFingerprint === undefined) continue;
        const testCase = planById.get(plan.id)!.cases.find(item => item.assetId === result.assetId);
        if (!testCase) continue;
        const requiredCheckIds = expectedTestCheckIds(testCase);
        const checkById = new Map(result.checks.map(check => [check.id, check]));
        const missingCheckIds = requiredCheckIds.filter(id => !checkById.has(id));
        const rows = perAsset.get(result.assetId)!;
        rows.push({ planId: plan.id, planName: plan.name, planRevision: plan.revision,
          runId: run.id, runAt: run.runAt, rigId: run.rigId, rigSignature: run.rigSignature,
          rigMatchesTarget: targetRigSignature ? run.rigSignature === targetRigSignature : null,
          fingerprint: result.fingerprint, currentRecipe: result.fingerprint === currentFingerprint,
          status: result.status, checks: result.checks.map(check => ({ id: check.id, status: check.status, detail: check.detail,
            ...(check.observed !== undefined ? { observed: check.observed } : {}), ...(check.expected !== undefined ? { expected: check.expected } : {}), ...(check.unit ? { unit: check.unit } : {}) })),
          criteriaCoverage: { requiredCheckIds, missingCheckIds,
            unknownCheckIds: requiredCheckIds.filter(id => checkById.get(id)?.status === 'unknown'),
            failedCheckIds: requiredCheckIds.filter(id => checkById.get(id)?.status === 'failed'),
            unplannedCheckIds: result.checks.map(check => check.id).filter(id => !requiredCheckIds.includes(id)) } });
      }
    }
    const results = assets.map(asset => {
      const history = perAsset.get(asset.assetId)!;
      history.sort((left, right) => right.runAt.localeCompare(left.runAt) || left.runId.localeCompare(right.runId));
      const currentRuns = history.filter(run => run.currentRecipe);
      const applicableRuns = targetRigSignature ? currentRuns.filter(run => run.rigMatchesTarget) : currentRuns;
      const latestRun = applicableRuns[0];
      const priorComparableRun = latestRun && applicableRuns.slice(1).find(run => run.planId === latestRun.planId
        && run.rigId === latestRun.rigId && run.rigSignature === latestRun.rigSignature && run.fingerprint === latestRun.fingerprint);
      const priorChecks = new Map((priorComparableRun?.checks ?? []).map(check => [check.id, check]));
      const runComparison = latestRun && priorComparableRun ? (() => {
        const checks: { checkId: string; trend: 'regression' | 'improvement' | 'stable_pass' | 'persistent_failure' | 'unresolved'; baselineStatus: 'passed' | 'failed' | 'unknown' | null; candidateStatus: 'passed' | 'failed' | 'unknown' | null; baselineObserved?: number | string | boolean; candidateObserved?: number | string | boolean; observedDelta?: number; unit?: string | null }[] = latestRun.checks.map(candidate => {
          const baseline = priorChecks.get(candidate.id);
          const trend = !baseline || baseline.status === 'unknown' || candidate.status === 'unknown' ? 'unresolved' as const
            : baseline.status === 'passed' && candidate.status === 'failed' ? 'regression' as const
              : baseline.status === 'failed' && candidate.status === 'passed' ? 'improvement' as const
                : baseline.status === 'passed' ? 'stable_pass' as const
                  : baseline.status === 'failed' ? 'persistent_failure' as const : 'unresolved' as const;
          const observedDelta = baseline && typeof baseline.observed === 'number' && typeof candidate.observed === 'number'
            && baseline.unit === candidate.unit ? candidate.observed - baseline.observed : undefined;
          return { checkId: candidate.id, trend, baselineStatus: baseline?.status ?? null, candidateStatus: candidate.status,
            ...(baseline && Object.prototype.hasOwnProperty.call(baseline, 'observed') ? { baselineObserved: baseline.observed } : {}),
            ...(Object.prototype.hasOwnProperty.call(candidate, 'observed') ? { candidateObserved: candidate.observed } : {}),
            ...(observedDelta !== undefined ? { observedDelta, unit: candidate.unit ?? null } : {}) };
        });
        for (const baseline of priorComparableRun.checks) if (!latestRun.checks.some(check => check.id === baseline.id)) checks.push({ checkId: baseline.id, trend: 'unresolved', baselineStatus: baseline.status, candidateStatus: null });
        return { baselineRunId: priorComparableRun.runId, candidateRunId: latestRun.runId, planId: latestRun.planId,
          rigId: latestRun.rigId, rigSignature: latestRun.rigSignature, recipeFingerprint: latestRun.fingerprint,
          summary: { regressions: checks.filter(check => check.trend === 'regression').length,
            improvements: checks.filter(check => check.trend === 'improvement').length,
            stablePasses: checks.filter(check => check.trend === 'stable_pass').length,
            persistentFailures: checks.filter(check => check.trend === 'persistent_failure').length,
            unresolved: checks.filter(check => check.trend === 'unresolved').length }, checks };
      })() : null;
      const evidenceStatus = !history.length ? 'no_recorded_runs' as const
        : !currentRuns.length ? 'only_stale_recipe_runs' as const
          : targetRigSignature && !applicableRuns.length ? 'current_recipe_tested_on_other_rig' as const
            : applicableRuns[0]!.status === 'passed' ? 'latest_applicable_run_passed' as const
              : applicableRuns[0]!.status === 'failed' ? 'latest_applicable_run_failed' as const : 'latest_applicable_run_incomplete' as const;
      const latestApplicable = applicableRuns[0];
      const coverage = latestApplicable?.criteriaCoverage;
      const coverageGap = !latestApplicable ? { status: 'no_applicable_run' as const, nextAction: 'Run the declared test plan on the intended rig, or define an explicit test plan before making technical acceptance claims.' }
        : coverage?.missingCheckIds.length ? { status: 'declared_checks_missing' as const, nextAction: 'Rerun the pinned plan or repair the persisted run so every declared check has a result.' }
          : coverage?.unknownCheckIds.length ? { status: 'declared_checks_unresolved' as const, nextAction: 'Resolve unavailable telemetry or sample coverage, then rerun; unknown is not a pass.' }
            : coverage?.failedCheckIds.length ? { status: 'declared_checks_failed' as const, nextAction: 'Review the failed check evidence and refine or explicitly revise the acceptance criteria before rerunning.' }
              : { status: 'declared_checks_passed' as const, nextAction: 'The declared checks passed on this exact recipe and rig topology; visually review the clip because these checks do not establish artistic quality.' };
      return { assetId: asset.assetId, currentFingerprint: asset.currentFingerprint, evidenceStatus,
        currentRecipeRunCount: currentRuns.length, staleRecipeRunCount: history.length - currentRuns.length,
        targetRigSignature: targetRigSignature ?? null,
        latestApplicableRun: applicableRuns[0] ?? null,
        acceptanceCoverageGap: coverageGap,
        repeatedRunComparison: runComparison,
        latestCurrentRecipeRun: currentRuns[0] ?? null,
        latestRecordedRun: history[0] ?? null,
        recentRuns: history.slice(0, 3) };
    });
    return { scannedPlanCount, planScanTruncated: page.total > page.plans.length,
      targetRigSignature: targetRigSignature ?? null, results,
      limitation: 'Persisted checks are declared technical acceptance evidence, not proof of artistic quality, rendered appearance, or correctness on a different rig topology. A pass applies only to the exact recipe fingerprint and, when supplied, exact rig topology signature. Review the animation visually in Studio.' };
  }

  /** Keep evidence for an exact revision separate from evidence on its immutable ancestors. */
  async findAssetLineageEvidence(assetIds: string[], targetRigSignature?: string, planLimit = 100, ancestorDepthLimit = 10) {
    if (!Number.isInteger(ancestorDepthLimit) || ancestorDepthLimit < 1 || ancestorDepthLimit > 25) throw new Error('Lineage depth limit must be 1–25.');
    if (new Set(assetIds).size !== assetIds.length) throw new Error('Lineage evidence asset IDs must be unique.');
    const assetsById = new Map<string, Awaited<ReturnType<Library['get']>>>();
    const lineage = [] as { assetId: string; recipeFingerprint: string; ancestors: { assetId: string; depth: number; recipeFingerprint: string; sameRecipeContentAsSelected: boolean }[]; truncated: boolean; nextParentId: string | null }[];
    for (const assetId of assetIds) {
      const selected = await this.animations.get(assetId);
      if (selected.recipe.kind !== 'animation') throw new Error(`Lineage evidence asset ${assetId} is not an animation.`);
      assetsById.set(selected.id, selected);
      const selectedFingerprint = fingerprint(selected.recipe);
      const ancestors = [] as { assetId: string; depth: number; recipeFingerprint: string; sameRecipeContentAsSelected: boolean }[];
      const seen = new Set([selected.id]);
      let parentId = selected.parentId;
      let depth = 0;
      while (parentId && depth < ancestorDepthLimit) {
        if (seen.has(parentId)) throw new Error(`Animation revision lineage contains a cycle at ${parentId}.`);
        const parent = await this.animations.get(parentId);
        if (parent.recipe.kind !== 'animation') throw new Error(`Animation ${selected.id} has a non-animation parent revision.`);
        seen.add(parent.id);
        assetsById.set(parent.id, parent);
        depth += 1;
        const parentFingerprint = fingerprint(parent.recipe);
        ancestors.push({ assetId: parent.id, depth, recipeFingerprint: parentFingerprint,
          sameRecipeContentAsSelected: parentFingerprint === selectedFingerprint });
        parentId = parent.parentId;
      }
      lineage.push({ assetId: selected.id, recipeFingerprint: selectedFingerprint, ancestors,
        truncated: Boolean(parentId), nextParentId: parentId ?? null });
    }
    const evidence = await this.findAssetEvidence([...assetsById.values()].map(asset => ({ assetId: asset.id, currentFingerprint: fingerprint(asset.recipe) })), targetRigSignature, planLimit);
    const evidenceByAssetId = new Map(evidence.results.map(result => [result.assetId, result]));
    return { ...evidence, results: lineage.map(item => ({ assetId: item.assetId,
      exactRevisionEvidence: evidenceByAssetId.get(item.assetId)!,
      ancestors: item.ancestors.map(ancestor => ({ ...ancestor, evidence: evidenceByAssetId.get(ancestor.assetId)!,
        appliesToSelectedRevision: false as const })),
      lineageTruncated: item.truncated, nextParentId: item.nextParentId })),
      limitation: `${evidence.limitation} Ancestor test evidence is historical context only and never transfers automatically to a child revision.` };
  }

  async getRun(runId: string) {
    identifier.parse(runId);
    const run = runSchema.parse(JSON.parse(await readFile(join(this.runsDirectory, `${runId}.json`), 'utf8')));
    if (run.id !== runId) throw new Error('Animation test run identity mismatch.');
    return run;
  }

  async readRunForPlan(runId: string, planId: string) {
    const [plan, run] = await Promise.all([this.load(planId), this.getRun(runId)]);
    if (run.planId !== plan.id || run.planRevision !== plan.revision) throw new Error('Persisted run does not belong to this exact animation test plan revision.');
    this.assertRunMatchesPlan(plan, run);
    return { plan, run };
  }

  async compareRuns(parentPlanId: string, childPlanId: string, baselineRunId?: string, candidateRunId?: string) {
    const [parent, child] = await Promise.all([this.load(parentPlanId), this.load(childPlanId)]);
    if (child.parentId !== parent.id || child.revision !== parent.revision + 1) throw new Error('Regression comparison requires a direct child test-plan revision.');
    const chooseRun = async (plan: AnimationTestPlan, runId?: string) => {
      const run = runId ? await this.getRun(runId) : (await this.listRuns(plan.id, 100)).runs[0];
      if (!run) throw new Error(`No persisted run exists for test plan ${plan.id}.`);
      this.assertRunMatchesPlan(plan, run);
      return run;
    };
    const [baseline, candidate] = await Promise.all([chooseRun(parent, baselineRunId), chooseRun(child, candidateRunId)]);
    if (baseline.rigId !== candidate.rigId || baseline.rigSignature !== candidate.rigSignature) throw new Error('Regression comparison requires runs captured on the exact same rig ID and topology signature.');
    const parentCases = new Map(parent.cases.map(testCase => [testCase.assetId, testCase]));
    const childCases = new Map(child.cases.map(testCase => [testCase.assetId, testCase]));
    const baselineAssets = new Map(baseline.results.map(result => [result.assetId, result]));
    const candidateAssets = new Map(candidate.results.map(result => [result.assetId, result]));
    const ancestryCache = new Map<string, Map<string, number>>();
    const ancestors = async (assetId: string) => {
      const cached = ancestryCache.get(assetId);
      if (cached) return cached;
      const chain = new Map<string, number>();
      let currentId: string | undefined = assetId;
      while (currentId && !chain.has(currentId)) {
        chain.set(currentId, chain.size);
        const asset = await this.animations.get(currentId);
        currentId = asset.parentId;
      }
      if (currentId) throw new Error(`Animation revision lineage contains a cycle at ${currentId}.`);
      ancestryCache.set(assetId, chain);
      return chain;
    };
    const pairs: { baselineAssetId: string; candidateAssetId: string; lineage: 'same_asset' | 'child_revision' | 'unmatched' }[] = [];
    const usedCandidateIds = new Set<string>();
    for (const assetId of parentCases.keys()) if (childCases.has(assetId)) {
      pairs.push({ baselineAssetId: assetId, candidateAssetId: assetId, lineage: 'same_asset' });
      usedCandidateIds.add(assetId);
    }
    for (const candidateAssetId of childCases.keys()) {
      if (usedCandidateIds.has(candidateAssetId)) continue;
      const ancestry = await ancestors(candidateAssetId);
      const lineageCandidates = [...parentCases.keys()].flatMap(baselineAssetId => {
        const distance = ancestry.get(baselineAssetId);
        return distance !== undefined && distance > 0 ? [{ baselineAssetId, distance }] : [];
      }).sort((a, b) => a.distance - b.distance);
      if (lineageCandidates.length && (lineageCandidates.length === 1 || lineageCandidates[0]!.distance < lineageCandidates[1]!.distance)) {
        pairs.push({ baselineAssetId: lineageCandidates[0]!.baselineAssetId, candidateAssetId, lineage: 'child_revision' });
        usedCandidateIds.add(candidateAssetId);
      }
    }
    for (const assetId of parentCases.keys()) if (!pairs.some(pair => pair.baselineAssetId === assetId)) pairs.push({ baselineAssetId: assetId, candidateAssetId: '', lineage: 'unmatched' });
    for (const assetId of childCases.keys()) if (!usedCandidateIds.has(assetId)) pairs.push({ baselineAssetId: '', candidateAssetId: assetId, lineage: 'unmatched' });
    const comparisons: { assetId: string; candidateAssetId?: string; lineage: 'same_asset' | 'child_revision' | 'unmatched'; baselineFingerprint?: string; candidateFingerprint?: string; fingerprintChanged: boolean; checkComparisons: { checkId: string; status: ComparisonStatus; measurementTrend?: 'worsened' | 'improved' | 'unchanged'; baselineStatus?: string; candidateStatus?: string; baselineObserved?: number | string | boolean; candidateObserved?: number | string | boolean; baselineExpected?: number | string | boolean; candidateExpected?: number | string | boolean; baselineSampleIds?: string[]; candidateSampleIds?: string[]; observedDelta?: number; unit?: string; baselineSegment?: z.infer<typeof contactSegmentSchema>; candidateSegment?: z.infer<typeof contactSegmentSchema> }[] }[] = [];
    for (const pair of pairs) {
      const beforeCase = parentCases.get(pair.baselineAssetId), afterCase = childCases.get(pair.candidateAssetId);
      const baselineResult = pair.baselineAssetId ? baselineAssets.get(pair.baselineAssetId) : undefined;
      const candidateResult = pair.candidateAssetId ? candidateAssets.get(pair.candidateAssetId) : undefined;
      const beforeChecks = new Map((baselineResult?.checks ?? []).map(check => [check.id, check]));
      const afterChecks = new Map((candidateResult?.checks ?? []).map(check => [check.id, check]));
      const checkComparisons = [...new Set([...beforeChecks.keys(), ...afterChecks.keys()])].map(checkId => {
        const before = beforeChecks.get(checkId), after = afterChecks.get(checkId);
        const beforeCriterion = criterionForCheck(beforeCase, checkId), afterCriterion = criterionForCheck(afterCase, checkId);
        const criteriaChanged = beforeCriterion === undefined || afterCriterion === undefined || JSON.stringify(beforeCriterion) !== JSON.stringify(afterCriterion);
        const beforeMeasurement = measurementSignatureForCheck(beforeCase, checkId), afterMeasurement = measurementSignatureForCheck(afterCase, checkId);
        const measurementComparable = beforeMeasurement !== undefined && beforeMeasurement === afterMeasurement;
        let status: ComparisonStatus;
        if (criteriaChanged) status = 'criteria_changed';
        else if (!before || !after) status = 'criteria_changed';
        else if (before.status === 'passed' && after.status === 'failed') status = 'regression';
        else if (before.status !== 'passed' && after.status === 'passed') status = 'improvement';
        else if (before.status === after.status && before.status !== 'unknown') status = 'stable';
        else status = 'unresolved';
        const delta = typeof before?.observed === 'number' && typeof after?.observed === 'number' && before.unit === after.unit ? after.observed - before.observed : undefined;
        const lowerIsBetter = checkId === 'max_peak_angular_speed' || checkId.startsWith('max_loop_seam_') || checkId.startsWith('contact:');
        const measurementTrend = measurementComparable && lowerIsBetter && delta !== undefined
          ? Math.abs(delta) < 1e-9 ? 'unchanged' as const : delta > 0 ? 'worsened' as const : 'improved' as const : undefined;
        return { checkId, status, ...(measurementTrend ? { measurementTrend } : {}), ...(before ? { baselineStatus: before.status,
          ...(before.observed !== undefined ? { baselineObserved: before.observed } : {}), ...(before.expected !== undefined ? { baselineExpected: before.expected } : {}),
          ...(before.sampleIds ? { baselineSampleIds: before.sampleIds } : {}), ...(before.segment ? { baselineSegment: before.segment } : {}) } : {}),
        ...(after ? { candidateStatus: after.status, ...(after.observed !== undefined ? { candidateObserved: after.observed } : {}),
          ...(after.expected !== undefined ? { candidateExpected: after.expected } : {}), ...(after.sampleIds ? { candidateSampleIds: after.sampleIds } : {}),
          ...(after.segment ? { candidateSegment: after.segment } : {}) } : {}), ...(delta !== undefined ? { observedDelta: delta } : {}), ...(after?.unit ? { unit: after.unit } : {}) };
      });
      comparisons.push({ assetId: pair.baselineAssetId || pair.candidateAssetId, ...(pair.candidateAssetId && pair.candidateAssetId !== pair.baselineAssetId ? { candidateAssetId: pair.candidateAssetId } : {}), lineage: pair.lineage,
        ...(baselineResult ? { baselineFingerprint: baselineResult.fingerprint } : {}), ...(candidateResult ? { candidateFingerprint: candidateResult.fingerprint } : {}),
        fingerprintChanged: Boolean(baselineResult && candidateResult && baselineResult.fingerprint !== candidateResult.fingerprint), checkComparisons });
    }
    const checkComparisons = comparisons.flatMap(item => item.checkComparisons);
    const summary = {
      assets: comparisons.length,
      comparedChecks: checkComparisons.length,
      regressions: checkComparisons.filter(item => item.status === 'regression').length,
      improvements: checkComparisons.filter(item => item.status === 'improvement').length,
      stable: checkComparisons.filter(item => item.status === 'stable').length,
      unresolved: checkComparisons.filter(item => item.status === 'unresolved').length,
      criteriaChanged: comparisons.filter(asset => asset.checkComparisons.some(item => item.status === 'criteria_changed')).length,
      criteriaChangedChecks: checkComparisons.filter(item => item.status === 'criteria_changed').length,
      measurementsWorsened: checkComparisons.filter(item => item.measurementTrend === 'worsened').length,
      measurementsImproved: checkComparisons.filter(item => item.measurementTrend === 'improved').length,
      measurementsUnchanged: checkComparisons.filter(item => item.measurementTrend === 'unchanged').length,
    };
    const triageItems = comparisons.flatMap(asset => asset.checkComparisons
      .filter(check => check.status === 'regression' || check.status === 'unresolved')
      .map(check => ({ assetId: asset.assetId, ...(asset.candidateAssetId ? { candidateAssetId: asset.candidateAssetId } : {}), checkId: check.checkId,
        status: check.status as 'regression' | 'unresolved', ...(check.candidateObserved !== undefined ? { observed: check.candidateObserved } : {}),
        ...(check.candidateExpected !== undefined ? { expected: check.candidateExpected } : {}), ...(check.unit ? { unit: check.unit } : {}),
        ...(check.measurementTrend ? { measurementTrend: check.measurementTrend } : {}), ...(check.candidateSampleIds ? { sampleIds: check.candidateSampleIds } : {}),
        ...(check.candidateSegment ? { segment: check.candidateSegment } : {}),
        nextAction: check.candidateSegment
          ? `Scrub the candidate from ${formatAnimationTime(check.candidateSegment.startTime)}s to ${formatAnimationTime(check.candidateSegment.endTime)}s and inspect samples ${check.candidateSegment.startSampleId} → ${check.candidateSegment.endSampleId}; decide whether the measured change is intentional.`
          : check.candidateSampleIds?.length
            ? `Inspect candidate samples ${check.candidateSampleIds.join(', ')} on the same rig and verify whether the measured change is intentional.`
            : 'Review the candidate check and its declared criterion on the same rig before deciding whether to revise it.' })));
    const triage = { regressionCount: triageItems.filter(item => item.status === 'regression').length,
      unresolvedCount: triageItems.filter(item => item.status === 'unresolved').length,
      criteriaChangedCount: summary.criteriaChangedChecks, items: triageItems };
    return { parentPlan: { id: parent.id, revision: parent.revision, name: parent.name }, childPlan: { id: child.id, revision: child.revision, name: child.name },
      baselineRun: { id: baseline.id, runAt: baseline.runAt }, candidateRun: { id: candidate.id, runAt: candidate.runAt }, rigId: baseline.rigId, rigSignature: baseline.rigSignature,
      summary, triage, assets: comparisons, limitation: 'This compares declared test outcomes only. Changed criteria are excluded from improvement/regression claims; same-rig sampling does not establish artistic quality or in-game performance. Triage actions identify evidence to inspect and never prescribe automatic edits.' };
  }
}
