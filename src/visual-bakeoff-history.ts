import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { animationAcceptanceCriteriaSchema, evaluateAnimationTestCase } from './animation-tests.js';
import { auditAnimation } from './animation-quality.js';
import { extractActionPhaseWindows } from './animation-phases.js';
import { compareContactStability, compareMotion, fingerprintUuid, inspectMotion, telemetrySchema, type MotionMode, type Telemetry } from './inspection.js';
import { recipeSchema, type AnimationRecipe } from './recipes.js';
import { readPngDimensions } from './png.js';
import { animationVisualContext } from './animation-visual-context.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const captureJointMapSchema = z.record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)).refine(map => Object.keys(map).length <= 256);
const captureJointMapFingerprint = (map: Record<string, string>) => digest(Object.entries(map).sort(([left], [right]) => left.localeCompare(right)));
const jointMappingSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), appliedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), renamedJointCount: z.number().int().nonnegative(),
  nameMapApplied: z.boolean(), renamedJoints: z.array(z.object({ source: z.string().min(1).max(128), target: z.string().min(1).max(128) }).strict()).max(512).optional(),
  jointMap: captureJointMapSchema.optional(),
  limitation: z.string().min(1).max(300) }).strict().superRefine((mapping, context) => {
    if (mapping.nameMapApplied !== (mapping.renamedJointCount > 0)) context.addIssue({ code: 'custom', path: ['nameMapApplied'], message: 'Name-map applied status must match the renamed-joint count.' });
    if (mapping.renamedJoints && mapping.renamedJoints.length !== mapping.renamedJointCount) context.addIssue({ code: 'custom', path: ['renamedJoints'], message: 'Renamed-joint details must match the declared count.' });
    if (mapping.renamedJoints && (new Set(mapping.renamedJoints.map(item => item.source)).size !== mapping.renamedJoints.length
      || mapping.renamedJoints.some(item => item.source === item.target))) context.addIssue({ code: 'custom', path: ['renamedJoints'], message: 'Renamed-joint details must have unique source names and actual name changes.' });
    if (mapping.jointMap && captureJointMapFingerprint(mapping.jointMap) !== mapping.fingerprint) context.addIssue({ code: 'custom', path: ['jointMap'], message: 'Exact joint map must match the recorded fingerprint.' });
  });
const assessmentSchema = z.object({ candidateLabel: z.string().min(1).max(80), candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  criterion: z.string().min(3).max(240), status: z.enum(['supported', 'contradicted', 'unclear']), observation: z.string().min(10).max(600),
  evidence: z.array(z.object({ captureId: z.string().uuid(), time: z.number().finite().min(0).max(30), normalizedProgress: z.number().finite().min(0).max(1).optional(),
    view: z.string().min(1).max(40), sha256: z.string().regex(/^[a-f0-9]{64}$/), jointMapping: jointMappingSchema.optional() }).strict()).max(8) }).strict();
type VisualAssessment = z.infer<typeof assessmentSchema>;
type VisualCandidate = { label: string; candidateFingerprint: string; duration?: number };
const evidenceImageSchema = z.object({ captureId: z.string().uuid(), candidateLabel: z.string().min(1).max(80),
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/), time: z.number().finite().min(0).max(30),
  normalizedProgress: z.number().finite().min(0).max(1).optional(), view: z.string().min(1).max(40),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), jointMapping: jointMappingSchema.optional(), bytes: z.number().int().min(33).max(1_400_000),
  width: z.number().int().min(1).max(2048), height: z.number().int().min(1).max(2048) }).strict();
type VisualBakeoffEvidenceImage = z.infer<typeof evidenceImageSchema> & { png: Buffer };
const technicalAuditSchema = z.object({ candidateLabel: z.string().min(1).max(80), candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.object({ tracks: z.number().int().nonnegative(), keys: z.number().int().nonnegative(), duration: z.number().finite().positive(), loop: z.boolean() }).strict(),
  checkAdvisoryIds: z.array(z.string().min(1).max(100)).max(32),
  peaks: z.object({ localPositionSpeed: z.number().finite().nonnegative(), localAngularSpeed: z.number().finite().nonnegative(),
    localPositionAcceleration: z.number().finite().nonnegative(), localAngularAcceleration: z.number().finite().nonnegative(),
    loopPositionDiscontinuity: z.number().finite().nonnegative(), loopAngularDiscontinuity: z.number().finite().nonnegative() }).strict(),
  limitation: z.string().min(1).max(600) }).strict();
type VisualTechnicalAudit = z.infer<typeof technicalAuditSchema>;
export function summarizeVisualCandidateAudit(candidateLabel: string, candidateFingerprint: string, recipe: AnimationRecipe): VisualTechnicalAudit {
  const audit = auditAnimation(recipe);
  const maximum = (values: number[]) => values.length ? Math.max(...values) : 0;
  return technicalAuditSchema.parse({ candidateLabel, candidateFingerprint,
    summary: { tracks: audit.summary.tracks, keys: audit.summary.keys, duration: audit.summary.duration, loop: audit.summary.loop },
    checkAdvisoryIds: audit.advisories.filter(item => item.severity === 'check').map(item => item.id).sort(),
    peaks: { localPositionSpeed: maximum(audit.curveMotion.map(item => item.peakLocalPositionSpeed.unitsPerSecond)),
      localAngularSpeed: maximum(audit.curveMotion.map(item => item.peakLocalAngularSpeed.degreesPerSecond)),
      localPositionAcceleration: maximum(audit.curveMotion.map(item => item.peakLocalPositionAcceleration.unitsPerSecondSquared)),
      localAngularAcceleration: maximum(audit.curveMotion.map(item => item.peakLocalAngularAcceleration.degreesPerSecondSquared)),
      loopPositionDiscontinuity: maximum(audit.loopSeamVelocity.map(item => item.positionDiscontinuityStudsPerSecond)),
      loopAngularDiscontinuity: maximum(audit.loopSeamVelocity.map(item => item.angularDiscontinuityDegreesPerSecond)) },
    limitation: 'Offline local-recipe measurements only; not rendered world motion, contact/physics truth, or artistic quality.' });
}
function reportFingerprint(value: { jobId: string; rigId: string; rigSignature: string; candidates: VisualCandidate[]; criteria: string[]; assessments: VisualAssessment[]; technicalAudits?: VisualTechnicalAudit[] }) {
  return digest({ version: 1, jobId: value.jobId, rigId: value.rigId, rigSignature: value.rigSignature,
    candidates: value.candidates.map(candidate => ({ label: candidate.label, candidateFingerprint: candidate.candidateFingerprint,
      ...(candidate.duration !== undefined ? { duration: candidate.duration } : {}) })),
    criteria: value.criteria, assessments: value.assessments.map(assessment => ({ candidateLabel: assessment.candidateLabel,
      candidateFingerprint: assessment.candidateFingerprint, criterion: assessment.criterion, status: assessment.status,
      observation: assessment.observation, evidence: assessment.evidence.map(item => ({ captureId: item.captureId, time: item.time,
        ...(item.normalizedProgress !== undefined ? { normalizedProgress: item.normalizedProgress } : {}), view: item.view, sha256: item.sha256,
        ...(item.jointMapping ? { jointMapping: item.jointMapping.jointMap ? { fingerprint: item.jointMapping.fingerprint,
          appliedFingerprint: item.jointMapping.appliedFingerprint, renamedJointCount: item.jointMapping.renamedJointCount,
          nameMapApplied: item.jointMapping.nameMapApplied, renamedJoints: item.jointMapping.renamedJoints,
          jointMap: item.jointMapping.jointMap, limitation: item.jointMapping.limitation } : { ...item.jointMapping } } : {}) })) })),
    ...(value.technicalAudits ? { technicalAudits: value.technicalAudits } : {}) });
}
export function visualBakeoffReportFingerprint(value: { jobId: string; rigId: string; rigSignature: string; candidates: VisualCandidate[]; criteria: string[]; assessments: VisualAssessment[]; technicalAudits?: VisualTechnicalAudit[] }) {
  return reportFingerprint(value);
}
const recordBodySchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime(), jobId: z.string().uuid(),
  rigId: z.string().uuid(), rigSignature: z.string().min(1).max(30000), reportFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  candidateRecipesPersisted: z.literal(true).optional(),
  evidenceImages: z.array(evidenceImageSchema).max(16).optional(),
  candidates: z.array(z.object({ label: z.string().min(1).max(80), candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    duration: z.number().finite().min(0.1).max(30).optional() }).strict()).min(2).max(4),
  technicalAudits: z.array(technicalAuditSchema).min(2).max(4).optional(),
  criteria: z.array(z.string().min(3).max(240)).min(1).max(8), assessments: z.array(assessmentSchema).min(2).max(32),
  limitation: z.string().min(1).max(1000) }).strict().superRefine((record, context) => {
  if (record.assessments.length !== record.candidates.length * record.criteria.length) context.addIssue({ code: 'custom', message: 'Visual report must cover every candidate and criterion.' });
  if (record.technicalAudits) {
    const auditIdentities = new Set(record.technicalAudits.map(audit => `${audit.candidateLabel.toLocaleLowerCase('en-US')}\u0000${audit.candidateFingerprint}`));
    const candidateIdentities = new Set(record.candidates.map(candidate => `${candidate.label.toLocaleLowerCase('en-US')}\u0000${candidate.candidateFingerprint}`));
    if (record.technicalAudits.length !== record.candidates.length || auditIdentities.size !== record.technicalAudits.length
      || [...candidateIdentities].some(identity => !auditIdentities.has(identity))) context.addIssue({ code: 'custom', path: ['technicalAudits'], message: 'Technical audit snapshots must match every recorded candidate exactly once.' });
  }
  const labels = new Set(record.candidates.map(candidate => candidate.label.toLocaleLowerCase('en-US')));
  const fingerprints = new Set(record.candidates.map(candidate => candidate.candidateFingerprint));
  if (labels.size !== record.candidates.length || fingerprints.size !== record.candidates.length) context.addIssue({ code: 'custom', message: 'Candidate labels and fingerprints must be unique.' });
  const criteria = new Set(record.criteria.map(criterion => criterion.toLocaleLowerCase('en-US')));
  if (criteria.size !== record.criteria.length) context.addIssue({ code: 'custom', message: 'Visual criteria must be unique.' });
  const pairs = new Set<string>();
  record.assessments.forEach((assessment, index) => {
    if (!labels.has(assessment.candidateLabel.toLocaleLowerCase('en-US')) || !fingerprints.has(assessment.candidateFingerprint)
      || !criteria.has(assessment.criterion.toLocaleLowerCase('en-US'))) context.addIssue({ code: 'custom', path: ['assessments', index], message: 'Assessment must reference a recorded candidate and criterion.' });
    const key = `${assessment.candidateLabel.toLocaleLowerCase('en-US')}\u0000${assessment.criterion.toLocaleLowerCase('en-US')}`;
    if (pairs.has(key)) context.addIssue({ code: 'custom', path: ['assessments', index], message: 'Candidate/criterion assessment must be unique.' });
    pairs.add(key);
  });
  if (record.evidenceImages) {
    const citedEvidence = new Map<string, { candidateLabel: string; candidateFingerprint: string; time: number; normalizedProgress?: number; view: string; sha256: string;
      jointMapping?: z.infer<typeof jointMappingSchema> }>();
    for (const assessment of record.assessments) for (const evidence of assessment.evidence) {
      const existing = citedEvidence.get(evidence.captureId);
      const next = { candidateLabel: assessment.candidateLabel, candidateFingerprint: assessment.candidateFingerprint, time: evidence.time,
        ...(evidence.normalizedProgress !== undefined ? { normalizedProgress: evidence.normalizedProgress } : {}), view: evidence.view, sha256: evidence.sha256,
        ...(evidence.jointMapping ? { jointMapping: evidence.jointMapping } : {}) };
      if (existing && digest(existing) !== digest(next)) context.addIssue({ code: 'custom', path: ['evidenceImages'], message: `Capture ${evidence.captureId} has conflicting candidate or image metadata.` });
      citedEvidence.set(evidence.captureId, next);
    }
    const seenImages = new Set<string>();
    for (const [index, image] of record.evidenceImages.entries()) {
      const cited = citedEvidence.get(image.captureId);
      if (seenImages.has(image.captureId)) context.addIssue({ code: 'custom', path: ['evidenceImages', index], message: 'Evidence image capture IDs must be unique.' });
      if (!cited || cited.candidateLabel !== image.candidateLabel || cited.candidateFingerprint !== image.candidateFingerprint
        || cited.time !== image.time || cited.normalizedProgress !== image.normalizedProgress || cited.view !== image.view || cited.sha256 !== image.sha256
        || digest(cited.jointMapping ?? null) !== digest(image.jointMapping ?? null)) {
        context.addIssue({ code: 'custom', path: ['evidenceImages', index], message: 'Persisted image metadata must match a cited assessment image exactly.' });
      }
      seenImages.add(image.captureId);
    }
    if (seenImages.size !== citedEvidence.size) context.addIssue({ code: 'custom', path: ['evidenceImages'], message: 'Persisted images must cover every cited visual evidence capture.' });
  }
  if (reportFingerprint(record) !== record.reportFingerprint) context.addIssue({ code: 'custom', path: ['reportFingerprint'], message: 'Report fingerprint does not match the recorded candidates, criteria, assessments, and evidence.' });
});
const storedSchema = z.object({ record: recordBodySchema, recordDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const candidateRecheckBodySchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime(),
  parentHistoryRecordId: z.string().uuid(), parentReportFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  revisionRecipePersisted: z.literal(true),
  candidateLabel: z.string().min(1).max(80), baselineRecipeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  revisionRecipeFingerprint: z.string().regex(/^[a-f0-9]{64}$/), baselineSourceRigId: z.string().uuid(), rigId: z.string().uuid(), rigSignature: z.string().min(1).max(30000),
  motionMode: z.enum(['unknown', 'in_place', 'root_motion', 'stationary']),
  jointMap: z.record(z.string(), z.string()), sampleRateHz: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)]),
  phaseDetailLimit: z.number().int().min(1).max(16), comparisonDetailLimit: z.number().int().min(1).max(96),
  acceptance: animationAcceptanceCriteriaSchema.optional(),
  baselineAssetId: z.string().uuid(), baselineTelemetry: telemetrySchema,
  revisionAssetId: z.string().uuid(), revisionTelemetry: telemetrySchema,
}).strict().superRefine((record, context) => {
  for (const side of ['baseline', 'revision'] as const) {
    const telemetry = record[`${side}Telemetry`];
    if (telemetry.rigId !== record.rigId) context.addIssue({ code: 'custom', path: [`${side}Telemetry`, 'rigId'], message: 'Recheck telemetry must use the recorded measured rig.' });
    if (telemetry.assetId !== record[`${side}AssetId`]) context.addIssue({ code: 'custom', path: [`${side}Telemetry`, 'assetId'], message: 'Recheck telemetry must match its exact candidate identity.' });
  }
  if (/^[a-f0-9]{64}$/.test(record.baselineRecipeFingerprint) && record.baselineAssetId !== fingerprintUuid(record.baselineRecipeFingerprint)) {
    context.addIssue({ code: 'custom', path: ['baselineAssetId'], message: 'Baseline telemetry asset identity must be derived from the exact baseline recipe fingerprint.' });
  }
  if (/^[a-f0-9]{64}$/.test(record.revisionRecipeFingerprint) && record.revisionAssetId !== fingerprintUuid(record.revisionRecipeFingerprint)) {
    context.addIssue({ code: 'custom', path: ['revisionAssetId'], message: 'Revision telemetry asset identity must be derived from the exact revised recipe fingerprint.' });
  }
});
const storedCandidateRecheckSchema = z.object({ record: candidateRecheckBodySchema, recordDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type VisualBakeoffCandidateRecheckInput = Omit<z.infer<typeof candidateRecheckBodySchema>, 'schemaVersion' | 'id' | 'createdAt' | 'revisionRecipePersisted' | 'parentReportFingerprint' | 'baselineRecipeFingerprint' | 'revisionRecipeFingerprint'> & {
  parentReportFingerprint: string; baselineRecipeFingerprint: string; revisionRecipeFingerprint: string; revisionRecipe: AnimationRecipe;
};
export type VisualBakeoffRecordInput = Omit<z.infer<typeof recordBodySchema>, 'schemaVersion' | 'id' | 'createdAt' | 'candidateRecipesPersisted' | 'evidenceImages'>;
export type VisualBakeoffCandidateRecipe = { candidateLabel: string; candidateFingerprint: string; recipe: AnimationRecipe };

function deriveCandidateRecheck(record: z.infer<typeof candidateRecheckBodySchema>, baselineRecipe: AnimationRecipe, revisionRecipe: AnimationRecipe) {
  const inspect = (recipe: AnimationRecipe, raw: Telemetry, assetId: string) => {
    const structural = auditAnimation(recipe, record.sampleRateHz, record.phaseDetailLimit);
    const studio = inspectMotion(recipe, raw, record.motionMode).report;
    const acceptance = record.acceptance ? evaluateAnimationTestCase(recipe,
      { ...record.acceptance, assetId, motionMode: record.motionMode }, structural, studio, raw, record.jointMap) : undefined;
    return { fingerprint: digest(recipe), structural, studio, ...(acceptance ? { acceptance } : {}) };
  };
  const baseline = inspect(baselineRecipe, record.baselineTelemetry, record.baselineAssetId);
  const revision = inspect(revisionRecipe, record.revisionTelemetry, record.revisionAssetId);
  const comparison = compareMotion(record.baselineTelemetry, record.revisionTelemetry, record.comparisonDetailLimit, {
    parent: extractActionPhaseWindows(baselineRecipe).phases, child: extractActionPhaseWindows(revisionRecipe).phases,
  });
  return {
    recheckRecordId: record.id, recordedAt: record.createdAt,
    parentHistoryRecordId: record.parentHistoryRecordId, parentReportFingerprint: record.parentReportFingerprint,
    candidateLabel: record.candidateLabel, baselineSourceRigId: record.baselineSourceRigId,
    baselineRigSignature: record.rigSignature, measuredRigId: record.rigId, measuredRigSignature: record.rigSignature,
    sameRigTopologyAsBaseline: true,
    baseline: { fingerprint: baseline.fingerprint, structural: baseline.structural, studio: baseline.studio, ...(baseline.acceptance ? { acceptance: baseline.acceptance } : {}) },
    revision: { fingerprint: revision.fingerprint, structural: revision.structural, studio: revision.studio, ...(revision.acceptance ? { acceptance: revision.acceptance } : {}) },
    comparison, contactComparison: compareContactStability(baseline.studio, revision.studio), rigId: record.rigId, rigSignature: record.rigSignature,
    limitations: ['Same-rig telemetry is measured pose evidence, not Roblox gameplay physics or rendered deformation.',
      'The baseline recipe is exact and fingerprint-verified, but its historical screenshots are not re-captured by this tool.',
      'Numeric change and caller-authored acceptance checks do not decide artistic quality or select a winner.'],
    next: 'Inspect the revised recipe and measured change map, then capture fresh multi-view evidence for the revision. Save/export only after explicit review.',
  };
}

export class VisualBakeoffHistory {
  constructor(private readonly root: string) {}

  async record(input: VisualBakeoffRecordInput & { candidateRecipes?: VisualBakeoffCandidateRecipe[]; evidenceImages?: VisualBakeoffEvidenceImage[] }) {
    const { candidateRecipes, evidenceImages, ...recordInput } = input;
    const imageMetadata = evidenceImages?.map(image => {
      const { png: _png, ...metadata } = image;
      return evidenceImageSchema.parse(metadata);
    });
    const record = recordBodySchema.parse({ ...recordInput, ...(candidateRecipes ? { candidateRecipesPersisted: true as const } : {}),
      ...(imageMetadata ? { evidenceImages: imageMetadata } : {}),
      schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString() });
    const validatedImages: { sha256: string; png: Buffer }[] = [];
    if (evidenceImages) {
      const totalBytes = evidenceImages.reduce((total, image) => total + image.png.length, 0);
      if (totalBytes > 24_000_000) throw new Error('Persisted visual evidence exceeds the 24 MB per-report limit.');
      for (const image of evidenceImages) {
        const { png, ...rawMetadata } = image;
        const metadata = evidenceImageSchema.parse(rawMetadata);
        if (png.length !== metadata.bytes || createHash('sha256').update(png).digest('hex') !== metadata.sha256) {
          throw new Error(`Visual evidence image ${metadata.captureId} does not match its recorded byte length and SHA-256.`);
        }
        const dimensions = readPngDimensions(png);
        if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) throw new Error(`Visual evidence image ${metadata.captureId} dimensions do not match its metadata.`);
        validatedImages.push({ sha256: metadata.sha256, png });
      }
    }
    const validatedRecipes: { candidateFingerprint: string; recipe: AnimationRecipe }[] = [];
    if (candidateRecipes) {
      const candidateMap = new Map(record.candidates.map(candidate => [candidate.label.toLocaleLowerCase('en-US'), candidate]));
      const seen = new Set<string>();
      if (candidateRecipes.length !== record.candidates.length) throw new Error('Recipe snapshots must cover every visual bake-off candidate exactly once.');
      for (const snapshot of candidateRecipes) {
        const key = snapshot.candidateLabel.toLocaleLowerCase('en-US');
        const candidate = candidateMap.get(key);
        const recipe = recipeSchema.parse(snapshot.recipe);
        if (recipe.kind !== 'animation' || !candidate || seen.has(key) || candidate.candidateFingerprint !== snapshot.candidateFingerprint
          || digest(recipe) !== snapshot.candidateFingerprint) throw new Error(`Recipe snapshot for ${snapshot.candidateLabel} does not match its exact recorded candidate fingerprint.`);
        const technicalAudit = record.technicalAudits?.find(audit => audit.candidateLabel.toLocaleLowerCase('en-US') === key);
        if (record.technicalAudits && (!technicalAudit || digest(technicalAudit) !== digest(summarizeVisualCandidateAudit(candidate.label, candidate.candidateFingerprint, recipe)))) {
          throw new Error(`Technical audit snapshot for ${candidate.label} does not match the exact candidate recipe.`);
        }
        seen.add(key);
        validatedRecipes.push({ candidateFingerprint: snapshot.candidateFingerprint, recipe });
      }
    }
    for (const image of validatedImages) await this.persistEvidenceImage(image.sha256, image.png);
    for (const snapshot of validatedRecipes) await this.persistRecipeSnapshot(snapshot.candidateFingerprint, snapshot.recipe);
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, `${record.createdAt.replaceAll(':', '-')}-${record.id}.json`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ record, recordDigest: digest(record) })}\n`, { flag: 'wx' });
      await link(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return record;
  }

  private async persistRecipeSnapshot(candidateFingerprint: string, recipe: AnimationRecipe) {
    const directory = join(this.root, 'recipes');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${candidateFingerprint}.json`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ candidateFingerprint, recipe })}\n`, { flag: 'wx' });
      try { await link(temporaryPath, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(path, 'utf8')) as { candidateFingerprint?: unknown; recipe?: unknown };
        if (existing.candidateFingerprint !== candidateFingerprint || digest(recipeSchema.parse(existing.recipe)) !== candidateFingerprint) {
          throw new Error(`Existing content-addressed recipe snapshot ${candidateFingerprint} failed verification.`);
        }
      }
    } finally { await unlink(temporaryPath).catch(() => undefined); }
  }

  private async persistEvidenceImage(sha256: string, png: Buffer) {
    const directory = join(this.root, 'images');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sha256}.png`), temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, png, { flag: 'wx' });
      try { await link(temporaryPath, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(path);
        if (createHash('sha256').update(existing).digest('hex') !== sha256 || !existing.equals(png)) throw new Error(`Existing visual evidence image ${sha256} failed its content-address integrity check.`);
      }
    } finally { await unlink(temporaryPath).catch(() => undefined); }
  }

  async readEvidenceImage(historyRecordId: string, captureId: string) {
    const record = await this.read(historyRecordId);
    const image = record.evidenceImages?.find(candidate => candidate.captureId === captureId);
    if (!image) throw new Error(`No persisted visual evidence image ${captureId} belongs to bake-off report ${historyRecordId}.`);
    const png = await readFile(join(this.root, 'images', `${image.sha256}.png`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Persisted visual evidence image ${captureId} is missing.`);
      throw error;
    });
    if (png.length !== image.bytes || createHash('sha256').update(png).digest('hex') !== image.sha256) throw new Error(`Persisted visual evidence image ${captureId} failed its SHA-256 integrity check.`);
    const dimensions = readPngDimensions(png);
    if (dimensions.width !== image.width || dimensions.height !== image.height) throw new Error(`Persisted visual evidence image ${captureId} failed its dimension integrity check.`);
    return { historyRecordId: record.id, reportFingerprint: record.reportFingerprint, ...image, mimeType: 'image/png' as const, pngBase64: png.toString('base64') };
  }

  async readCandidateRecipe(historyRecordId: string, candidateLabel: string) {
    const record = await this.read(historyRecordId);
    if (!record.candidateRecipesPersisted) throw new Error('This historical candidate has no persisted recipe snapshot. Older reports or reports recorded before recipe snapshot support cannot be resumed.');
    const candidate = record.candidates.find(item => item.label.toLocaleLowerCase('en-US') === candidateLabel.toLocaleLowerCase('en-US'));
    if (!candidate) throw new Error(`No candidate labeled ${candidateLabel} exists in visual bake-off record ${historyRecordId}.`);
    const recipe = await this.readRecipeSnapshot(candidate.candidateFingerprint);
    return { historyRecordId: record.id, reportFingerprint: record.reportFingerprint, rigId: record.rigId, rigSignature: record.rigSignature,
      candidate: { label: candidate.label, candidateFingerprint: candidate.candidateFingerprint, duration: candidate.duration },
      recipe, persistence: 'This exact candidate recipe was recovered from the append-only local snapshot. It is still unsaved in the Roblox animation library.' };
  }

  private async readRecipeSnapshot(candidateFingerprint: string) {
    const path = join(this.root, 'recipes', `${candidateFingerprint}.json`);
    let stored: unknown;
    try { stored = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Attested candidate recipe snapshot ${candidateFingerprint} is missing or was never persisted.`);
      throw error;
    }
    const parsed = z.object({ candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/), recipe: recipeSchema }).strict().parse(stored);
    if (parsed.candidateFingerprint !== candidateFingerprint || parsed.recipe.kind !== 'animation'
      || digest(parsed.recipe) !== candidateFingerprint) throw new Error(`Persisted candidate recipe ${candidateFingerprint} failed its fingerprint integrity check.`);
    return parsed.recipe;
  }

  async readRefinementContext(historyRecordId: string, candidateLabel: string, criterion?: string) {
    const [record, recovered] = await Promise.all([this.read(historyRecordId), this.readCandidateRecipe(historyRecordId, candidateLabel)]);
    const candidateFindings = record.assessments.filter(item => item.candidateLabel.toLocaleLowerCase('en-US') === recovered.candidate.label.toLocaleLowerCase('en-US'));
    const findings = criterion
      ? candidateFindings.filter(item => item.criterion.toLocaleLowerCase('en-US') === criterion.trim().toLocaleLowerCase('en-US'))
      : candidateFindings;
    if (criterion && findings.length === 0) throw new Error(`Criterion ${criterion} is not recorded for candidate ${recovered.candidate.label}.`);
    const imageAvailability = await Promise.all(findings.map(async item => {
      if (item.evidence.length === 0) return false;
      try {
        await Promise.all(item.evidence.map(evidence => this.readEvidenceImage(record.id, evidence.captureId)));
        return true;
      } catch {
        return false;
      }
    }));
    return { ...recovered, sourceFingerprint: recovered.candidate.candidateFingerprint,
      findings: findings.map((item, index) => ({ criterion: item.criterion, status: item.status,
      observation: item.observation, evidence: item.evidence.map(evidence => ({ ...evidence,
        authoredContext: animationVisualContext(recovered.recipe, evidence.time) })), imageBytesAvailable: imageAvailability[index]!,
      ...(item.status === 'contradicted' ? { patchPreviewBinding: { historyRecordId: record.id,
        reportFingerprint: record.reportFingerprint, candidateFingerprint: recovered.candidate.candidateFingerprint,
        criterion: item.criterion, evidenceCaptureIds: item.evidence.map(frame => frame.captureId) } } : {}) })),
      limitation: 'The exact cited screenshot bytes are retained when the bake-off report says evidenceImages are present. They are historical context, not fresh visual verification; inspect cited images again and capture the revised candidate before accepting or saving it.',
      next: 'Inspect the inline historical image blocks returned with this context. If images were not requested, retrieve cited frames with motion_studio_visual_bakeoff_evidence_image_read. If a cited image is unavailable or fails integrity checks, do not claim visual inspection; recapture the candidate for fresh evidence. For a contradicted finding, use its patchPreviewBinding with motion_animation_candidate_patch_preview, include the exact recovered recipe and source fingerprint, and provide a specific changeIntent. The patch preview is non-mutating; capture the revised candidate again for fresh visual review before acceptance or save.' };
  }

  async read(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new Error('Visual bake-off record ID must be a UUID.');
    const names = await readdir(this.root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const name = names.find(entry => entry.endsWith(`-${id}.json`));
    if (!name) throw new Error(`No visual bake-off record with ID ${id}.`);
    const stored = storedSchema.parse(JSON.parse(await readFile(join(this.root, name), 'utf8')));
    if (stored.record.id !== id || digest(stored.record) !== stored.recordDigest) throw new Error('Visual bake-off record failed its integrity check.');
    await this.verifyRecipeSnapshots(stored.record);
    await this.verifyEvidenceImageFiles(stored.record);
    return stored.record;
  }

  private async verifyEvidenceImageFiles(record: z.infer<typeof recordBodySchema>) {
    for (const image of record.evidenceImages ?? []) {
      const metadata = await stat(join(this.root, 'images', `${image.sha256}.png`)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Attested visual evidence image ${image.captureId} is missing.`);
        throw error;
      });
      if (!metadata.isFile() || metadata.size !== image.bytes) throw new Error(`Attested visual evidence image ${image.captureId} is missing or has the wrong byte length.`);
    }
  }

  private async verifyRecipeSnapshots(record: z.infer<typeof recordBodySchema>) {
    if (!record.candidateRecipesPersisted) return;
    const recipes = await Promise.all(record.candidates.map(candidate => this.readRecipeSnapshot(candidate.candidateFingerprint)));
    if (record.technicalAudits) record.candidates.forEach((candidate, index) => {
      const technicalAudit = record.technicalAudits!.find(audit => audit.candidateLabel.toLocaleLowerCase('en-US') === candidate.label.toLocaleLowerCase('en-US'));
      if (!technicalAudit || digest(technicalAudit) !== digest(summarizeVisualCandidateAudit(candidate.label, candidate.candidateFingerprint, recipes[index]!))) {
        throw new Error(`Visual bake-off technical audit for ${candidate.label} does not match its persisted recipe snapshot.`);
      }
    });
  }

  async list(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
    const names = await readdir(this.root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const files = names.filter(name => name.endsWith('.json')).sort().reverse();
    const records = [];
    for (const name of files) {
      const stored = storedSchema.parse(JSON.parse(await readFile(join(this.root, name), 'utf8')));
      if (digest(stored.record) !== stored.recordDigest) throw new Error(`Visual bake-off record ${stored.record.id} failed its integrity check.`);
      await this.verifyRecipeSnapshots(stored.record);
      await this.verifyEvidenceImageFiles(stored.record);
      records.push(stored.record);
      if (records.length === limit) break;
    }
    return { total: files.length, records };
  }

  async recordCandidateRecheck(input: VisualBakeoffCandidateRecheckInput) {
    const baseline = await this.readCandidateRecipe(input.parentHistoryRecordId, input.candidateLabel);
    if (baseline.reportFingerprint !== input.parentReportFingerprint) throw new Error('The parent bake-off report fingerprint changed before this recheck was recorded.');
    if (baseline.rigSignature !== input.rigSignature) throw new Error('The measured rig topology differs from the persisted visual bake-off baseline.');
    if (baseline.rigId !== input.baselineSourceRigId) throw new Error('Baseline rig identity does not match the persisted visual bake-off.');
    if (baseline.candidate.candidateFingerprint !== input.baselineRecipeFingerprint) throw new Error('Baseline recipe fingerprint does not match the persisted candidate snapshot.');
    if (input.baselineAssetId !== fingerprintUuid(input.baselineRecipeFingerprint)) throw new Error('Baseline telemetry asset ID must be derived from the exact baseline recipe fingerprint.');
    const revisionRecipe = recipeSchema.parse(input.revisionRecipe);
    if (revisionRecipe.kind !== 'animation' || digest(revisionRecipe) !== input.revisionRecipeFingerprint) throw new Error('Revision recipe does not match its recorded content fingerprint.');
    if (input.revisionAssetId !== fingerprintUuid(input.revisionRecipeFingerprint)) throw new Error('Revision telemetry asset ID must be derived from the exact revised recipe fingerprint.');
    const baselineTelemetry = telemetrySchema.parse(input.baselineTelemetry);
    const revisionTelemetry = telemetrySchema.parse(input.revisionTelemetry);
    if (baselineTelemetry.duration !== baseline.recipe.duration || baselineTelemetry.loop !== baseline.recipe.loop) throw new Error('Baseline telemetry timing does not match the exact persisted baseline recipe.');
    if (revisionTelemetry.duration !== revisionRecipe.duration || revisionTelemetry.loop !== revisionRecipe.loop) throw new Error('Revision telemetry timing does not match the exact revised recipe.');
    const { revisionRecipe: _revisionRecipe, ...bodyInput } = input;
    const record = candidateRecheckBodySchema.parse({ ...bodyInput, revisionRecipePersisted: true as const,
      schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString() });
    await this.persistRecipeSnapshot(record.revisionRecipeFingerprint, revisionRecipe);
    const directory = join(this.root, 'rechecks');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${record.createdAt.replaceAll(':', '-')}-${record.id}.json`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ record, recordDigest: digest(record) })}\n`, { flag: 'wx' });
      await link(temporaryPath, path);
    } finally { await unlink(temporaryPath).catch(() => undefined); }
    return { id: record.id, createdAt: record.createdAt, parentHistoryRecordId: record.parentHistoryRecordId,
      parentReportFingerprint: record.parentReportFingerprint, candidateLabel: record.candidateLabel,
      baselineRecipeFingerprint: record.baselineRecipeFingerprint, revisionRecipeFingerprint: record.revisionRecipeFingerprint,
      rigId: record.rigId, rigSignature: record.rigSignature };
  }

  private async loadCandidateRecheck(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new Error('Visual bake-off recheck record ID must be a UUID.');
    const directory = join(this.root, 'rechecks');
    const names = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const name = names.find(entry => entry.endsWith(`-${id}.json`));
    if (!name) throw new Error(`No visual bake-off recheck record with ID ${id}.`);
    const stored = storedCandidateRecheckSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
    const record = stored.record;
    if (record.id !== id || digest(record) !== stored.recordDigest) throw new Error('Visual bake-off recheck record failed its integrity check.');
    const baseline = await this.readCandidateRecipe(record.parentHistoryRecordId, record.candidateLabel);
    if (baseline.reportFingerprint !== record.parentReportFingerprint || baseline.rigId !== record.baselineSourceRigId
      || baseline.rigSignature !== record.rigSignature || baseline.candidate.candidateFingerprint !== record.baselineRecipeFingerprint) {
      throw new Error('Visual bake-off recheck no longer matches its fingerprint-verified parent report and baseline recipe.');
    }
    const revisionRecipe = await this.readRecipeSnapshot(record.revisionRecipeFingerprint);
    if (baseline.recipe.duration !== record.baselineTelemetry.duration || baseline.recipe.loop !== record.baselineTelemetry.loop
      || revisionRecipe.duration !== record.revisionTelemetry.duration || revisionRecipe.loop !== record.revisionTelemetry.loop) {
      throw new Error('Persisted recheck telemetry timing does not match its fingerprint-verified candidate recipe.');
    }
    return { record, baselineRecipe: baseline.recipe, revisionRecipe };
  }

  async readCandidateRecheck(id: string) {
    const loaded = await this.loadCandidateRecheck(id);
    return deriveCandidateRecheck(loaded.record, loaded.baselineRecipe, loaded.revisionRecipe);
  }

  async listCandidateRechecks(limit = 20, offset = 0, parentHistoryRecordId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('offset must be an integer from 0 to 100000.');
    if (parentHistoryRecordId) z.string().uuid().parse(parentHistoryRecordId);
    const directory = join(this.root, 'rechecks');
    const names = (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }))
      .filter(name => name.endsWith('.json')).sort().reverse();
    const records = [];
    for (const name of names) {
      const stored = storedCandidateRecheckSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
      const verified = await this.loadCandidateRecheck(stored.record.id);
      const record = verified.record;
      if (parentHistoryRecordId && record.parentHistoryRecordId !== parentHistoryRecordId) continue;
      records.push({ id: record.id, createdAt: record.createdAt, parentHistoryRecordId: record.parentHistoryRecordId,
        parentReportFingerprint: record.parentReportFingerprint, candidateLabel: record.candidateLabel,
        baselineRecipeFingerprint: record.baselineRecipeFingerprint, revisionRecipeFingerprint: record.revisionRecipeFingerprint,
        rigId: record.rigId, rigSignature: record.rigSignature });
    }
    return { total: records.length, offset, records: records.slice(offset, offset + limit),
      nextOffset: offset + limit < records.length ? offset + limit : null };
  }

  async compareCandidateRechecks(beforeId: string, afterId: string) {
    if (beforeId === afterId) throw new Error('Choose two distinct recheck record IDs.');
    const [before, after] = await Promise.all([this.loadCandidateRecheck(beforeId), this.loadCandidateRecheck(afterId)]);
    const left = before.record, right = after.record;
    if (left.parentHistoryRecordId !== right.parentHistoryRecordId || left.candidateLabel.toLocaleLowerCase('en-US') !== right.candidateLabel.toLocaleLowerCase('en-US')
      || left.baselineRecipeFingerprint !== right.baselineRecipeFingerprint) throw new Error('Rechecks must share the same persisted bake-off baseline candidate.');
    if (left.rigId !== right.rigId || left.rigSignature !== right.rigSignature) throw new Error('Rechecks must use the same rig identity and topology signature.');
    const beforeResult = deriveCandidateRecheck(left, before.baselineRecipe, before.revisionRecipe);
    const afterResult = deriveCandidateRecheck(right, after.baselineRecipe, after.revisionRecipe);
    const checksBefore = new Map((beforeResult.revision.acceptance?.checks ?? []).map(check => [check.id, check]));
    const checksAfter = new Map((afterResult.revision.acceptance?.checks ?? []).map(check => [check.id, check]));
    const checkIds = [...new Set([...checksBefore.keys(), ...checksAfter.keys()])].sort();
    const acceptanceChanges = checkIds.map(id => {
      const first = checksBefore.get(id), second = checksAfter.get(id);
      const numericDelta = first && second && typeof first.observed === 'number' && typeof second.observed === 'number' && first.unit === second.unit
        ? { before: first.observed, after: second.observed, delta: second.observed - first.observed, unit: second.unit } : null;
      return { id, before: first?.status ?? 'not_recorded', after: second?.status ?? 'not_recorded', numericDelta };
    });
    const comparison = compareMotion(left.revisionTelemetry, right.revisionTelemetry, Math.max(left.comparisonDetailLimit, right.comparisonDetailLimit), {
      parent: extractActionPhaseWindows(before.revisionRecipe).phases, child: extractActionPhaseWindows(after.revisionRecipe).phases,
    });
    return { beforeRecheckRecordId: left.id, afterRecheckRecordId: right.id,
      parentHistoryRecordId: left.parentHistoryRecordId, candidateLabel: left.candidateLabel,
      sameRigIdentityAndTopology: true,
      revisionRecipe: { beforeFingerprint: left.revisionRecipeFingerprint, afterFingerprint: right.revisionRecipeFingerprint,
        changed: left.revisionRecipeFingerprint !== right.revisionRecipeFingerprint },
      acceptanceCriteriaChanged: digest(left.acceptance ?? null) !== digest(right.acceptance ?? null), acceptanceChanges,
      motionComparison: comparison,
      contactComparison: compareContactStability(beforeResult.revision.studio, afterResult.revision.studio),
      interpretationVerified: false,
      limitation: 'This compares same-rig pose telemetry and explicitly configured technical checks. It does not determine whether the animation is artistically better, prove rendered appearance or gameplay physics, or select a winner.' };
  }

  async compareEvidenceTiming(beforeId: string, afterId: string) {
    const [before, after] = await Promise.all([this.read(beforeId), this.read(afterId)]);
    if (before.rigSignature !== after.rigSignature) throw new Error('Visual bake-off records use different rig topology signatures and cannot be compared.');
    const identity = (candidateLabel: string, criterion: string) => `${candidateLabel.toLocaleLowerCase('en-US')}\u0000${criterion.toLocaleLowerCase('en-US')}`;
    const beforeMap = new Map(before.assessments.map(item => [identity(item.candidateLabel, item.criterion), item]));
    const afterMap = new Map(after.assessments.map(item => [identity(item.candidateLabel, item.criterion), item]));
    const shared = [...beforeMap.keys()].filter(key => afterMap.has(key)).sort();
    const comparisons = shared.map(key => {
      const left = beforeMap.get(key)!;
      const right = afterMap.get(key)!;
      const beforeCandidate = before.candidates.find(candidate => candidate.label.toLocaleLowerCase('en-US') === left.candidateLabel.toLocaleLowerCase('en-US'));
      const afterCandidate = after.candidates.find(candidate => candidate.label.toLocaleLowerCase('en-US') === right.candidateLabel.toLocaleLowerCase('en-US'));
      const progress = (evidence: VisualAssessment['evidence'][number], duration: number | undefined) => evidence.normalizedProgress
        ?? (duration !== undefined ? evidence.time / duration : null);
      const views = [...new Set([...left.evidence.map(item => item.view), ...right.evidence.map(item => item.view)])].sort();
      return { candidateLabel: left.candidateLabel, criterion: left.criterion,
        candidateFingerprint: { before: left.candidateFingerprint, after: right.candidateFingerprint,
          recipeChanged: left.candidateFingerprint !== right.candidateFingerprint },
        evidenceByView: views.map(view => {
          const beforeEvidence = left.evidence.filter(item => item.view === view).sort((a, b) => a.time - b.time);
          const afterEvidence = right.evidence.filter(item => item.view === view).sort((a, b) => a.time - b.time);
          const beforeProgress = beforeEvidence.map(item => progress(item, beforeCandidate?.duration));
          const afterProgress = afterEvidence.map(item => progress(item, afterCandidate?.duration));
          const sameCount = beforeProgress.length === afterProgress.length;
          const deltas = sameCount ? beforeProgress.map((value, index) => value === null || afterProgress[index] === null
            ? null : afterProgress[index]! - value) : [];
          return { view, before: beforeEvidence.map((item, index) => ({ timeSeconds: item.time, normalizedProgress: beforeProgress[index] })),
            after: afterEvidence.map((item, index) => ({ timeSeconds: item.time, normalizedProgress: afterProgress[index] })),
            evidenceCountChanged: !sameCount, normalizedProgressDeltaByOrder: deltas };
        }),
      };
    });
    const normalizeSet = (values: string[]) => [...values].map(value => value.toLocaleLowerCase('en-US')).sort();
    const beforeCriteria = normalizeSet(before.criteria);
    const afterCriteria = normalizeSet(after.criteria);
    const criteriaChanged = JSON.stringify(beforeCriteria) !== JSON.stringify(afterCriteria);
    const beforeCandidates = new Map(before.candidates.map(candidate => [candidate.label.toLocaleLowerCase('en-US'), candidate]));
    const afterCandidates = new Map(after.candidates.map(candidate => [candidate.label.toLocaleLowerCase('en-US'), candidate]));
    const candidateLabels = [...new Set([...beforeCandidates.keys(), ...afterCandidates.keys()])].sort();
    const candidateChanges = candidateLabels.map(label => {
      const left = beforeCandidates.get(label);
      const right = afterCandidates.get(label);
      return { label: right?.label ?? left!.label,
        change: !left ? 'added' as const : !right ? 'removed' as const
          : left.candidateFingerprint !== right.candidateFingerprint ? 'recipe_changed' as const : 'unchanged' as const };
    });
    const statusTransitions = comparisons.map(comparison => {
      const left = beforeMap.get(identity(comparison.candidateLabel, comparison.criterion))!;
      const right = afterMap.get(identity(comparison.candidateLabel, comparison.criterion))!;
      const transition = left.status === right.status ? 'unchanged' as const
        : left.status === 'contradicted' && right.status === 'supported' ? 'reported_resolved' as const
          : left.status === 'supported' && right.status === 'contradicted' ? 'reported_regressed' as const : 'status_changed' as const;
      return { candidateLabel: comparison.candidateLabel, criterion: comparison.criterion,
        beforeStatus: left.status, afterStatus: right.status, transition };
    });
    const reportedRegressions = statusTransitions.filter(item => item.transition === 'reported_regressed').length;
    const reportedResolutions = statusTransitions.filter(item => item.transition === 'reported_resolved').length;
    const uncertainStatuses = [...before.assessments, ...after.assessments].filter(item => item.status === 'unclear').length;
    const unmatchedBeforeAssessments = before.assessments.filter(item => !afterMap.has(identity(item.candidateLabel, item.criterion)));
    const unmatchedAfterAssessments = after.assessments.filter(item => !beforeMap.has(identity(item.candidateLabel, item.criterion)));
    const completeCoverage = !criteriaChanged && candidateChanges.every(item => item.change !== 'added' && item.change !== 'removed')
      && unmatchedBeforeAssessments.length === 0 && unmatchedAfterAssessments.length === 0;
    const reportedOutcome = !completeCoverage || uncertainStatuses > 0 ? 'inconclusive'
      : reportedRegressions > 0 && reportedResolutions > 0 ? 'mixed_reported_changes'
        : reportedRegressions > 0 ? 'reported_regressions' : reportedResolutions > 0 ? 'reported_resolutions' : 'no_reported_status_regression';
    const candidateSummaries = candidateChanges.map(candidate => {
      const labelKey = candidate.label.toLocaleLowerCase('en-US');
      const beforeAssessments = before.assessments.filter(item => item.candidateLabel.toLocaleLowerCase('en-US') === labelKey);
      const afterAssessments = after.assessments.filter(item => item.candidateLabel.toLocaleLowerCase('en-US') === labelKey);
      const transitions = statusTransitions.filter(item => item.candidateLabel.toLocaleLowerCase('en-US') === labelKey);
      const evidence = (items: VisualAssessment[]) => ({ citations: items.reduce((sum, item) => sum + item.evidence.length, 0),
        criteriaWithEvidence: items.filter(item => item.evidence.length > 0).length,
        views: [...new Set(items.flatMap(item => item.evidence.map(frame => frame.view)))].sort() });
      return { label: candidate.label, recipeChange: candidate.change,
        assessments: { before: beforeAssessments.length, after: afterAssessments.length },
        statusCounts: { before: { supported: beforeAssessments.filter(item => item.status === 'supported').length,
          contradicted: beforeAssessments.filter(item => item.status === 'contradicted').length, unclear: beforeAssessments.filter(item => item.status === 'unclear').length },
        after: { supported: afterAssessments.filter(item => item.status === 'supported').length,
          contradicted: afterAssessments.filter(item => item.status === 'contradicted').length, unclear: afterAssessments.filter(item => item.status === 'unclear').length } },
        reportedTransitions: { regressed: transitions.filter(item => item.transition === 'reported_regressed').length,
          resolved: transitions.filter(item => item.transition === 'reported_resolved').length,
          otherStatusChanges: transitions.filter(item => item.transition === 'status_changed').length },
        evidenceCoverage: { before: evidence(beforeAssessments), after: evidence(afterAssessments) } };
    });
    const beforeAudits = new Map((before.technicalAudits ?? []).map(item => [item.candidateLabel.toLocaleLowerCase('en-US'), item]));
    const afterAudits = new Map((after.technicalAudits ?? []).map(item => [item.candidateLabel.toLocaleLowerCase('en-US'), item]));
    const technicalAuditComparison = candidateChanges.map(candidate => {
      const labelKey = candidate.label.toLocaleLowerCase('en-US');
      const left = beforeAudits.get(labelKey);
      const right = afterAudits.get(labelKey);
      if (!left || !right) return { candidateLabel: candidate.label, available: false as const,
        reason: !left && !right ? 'Neither report contains a persisted technical audit snapshot.' : !left ? 'The baseline report predates technical audit snapshots.' : 'The current report has no technical audit snapshot.' };
      const numericDelta = (beforeValue: number, afterValue: number) => ({ before: beforeValue, after: afterValue, delta: afterValue - beforeValue });
      const beforeAdvisories = new Set(left.checkAdvisoryIds);
      const afterAdvisories = new Set(right.checkAdvisoryIds);
      return { candidateLabel: candidate.label, available: true as const, recipeChanged: left.candidateFingerprint !== right.candidateFingerprint,
        summary: { tracks: numericDelta(left.summary.tracks, right.summary.tracks), keys: numericDelta(left.summary.keys, right.summary.keys),
          durationSeconds: numericDelta(left.summary.duration, right.summary.duration), loopChanged: left.summary.loop !== right.summary.loop },
        advisoryIds: { before: left.checkAdvisoryIds, after: right.checkAdvisoryIds,
          added: [...afterAdvisories].filter(id => !beforeAdvisories.has(id)).sort(), removed: [...beforeAdvisories].filter(id => !afterAdvisories.has(id)).sort() },
        peakMetricDeltas: Object.fromEntries(Object.keys(left.peaks).map(key => [key,
          numericDelta(left.peaks[key as keyof typeof left.peaks], right.peaks[key as keyof typeof right.peaks])])),
        limitation: left.limitation };
    });
    return { beforeRecordId: before.id, afterRecordId: after.id, sameRigTopology: true, matchedAssessmentCount: comparisons.length,
      unmatchedBeforeAssessments: unmatchedBeforeAssessments.map(item => ({ candidateLabel: item.candidateLabel, criterion: item.criterion })),
      unmatchedAfterAssessments: unmatchedAfterAssessments.map(item => ({ candidateLabel: item.candidateLabel, criterion: item.criterion })),
      rubric: { beforeCriteria: before.criteria, afterCriteria: after.criteria, changed: criteriaChanged }, candidateChanges, candidateSummaries, technicalAuditComparison,
      regressionSummary: { coverage: completeCoverage ? 'complete' as const : 'incomplete' as const, reportedOutcome,
        matchedAssessmentCount: statusTransitions.length, reportedRegressions, reportedResolutions, uncertainStatuses,
        statusTransitions, interpretationVerified: false,
        limitation: 'This summarizes agent-authored status labels only. Recipe fingerprint changes are reported separately and do not invalidate label/criterion coverage, but matching labels do not prove semantic equivalence. This is not an animation-quality score or verified regression gate; inspect fresh visual evidence and test the animation in its target gameplay context.' },
      comparisons, interpretation: 'This compares the times/normalized progress of images the agent chose to cite for the same candidate label and criterion. It does not measure the underlying motion event, prove the event moved, validate the visual notes, or establish improvement. Null normalizedProgress means the historical record did not include clip duration.' };
  }
}
