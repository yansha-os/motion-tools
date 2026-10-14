import { createHash } from 'node:crypto';
import { auditAnimation } from './animation-quality.js';
import { recipeSchema, type AnimationRecipe } from './recipes.js';

export type BenchmarkExpectation = {
  id: string;
  description: string;
  outcome: 'pass' | 'warn' | 'fail';
  evidence: string;
};

export type AnimationBenchmarkCase = {
  id: string;
  name: string;
  recipe: unknown;
  expectations: BenchmarkExpectation[];
  limits?: {
    maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond?: number;
    maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond?: number;
  };
};

export type BenchmarkFinding = {
  id: string;
  severity: 'pass' | 'warn' | 'fail';
  message: string;
  evidence: string;
};

export type BenchmarkCaseResult = {
  id: string;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  fingerprint: string | null;
  findings: BenchmarkFinding[];
  expectedOutcomes: { id: string; expected: BenchmarkExpectation['outcome']; actual: BenchmarkExpectation['outcome']; matched: boolean }[];
  metrics?: ReturnType<typeof auditAnimation>['summary'];
  limitations: string[];
};

export type AnimationBenchmarkReport = {
  schemaVersion: 1;
  generatedAt: string;
  suiteFingerprint: string;
  reportFingerprint: string;
  summary: { cases: number; passed: number; warnings: number; failed: number; expectations: number; matchedExpectations: number };
  cases: BenchmarkCaseResult[];
  limitations: string[];
};

export type AnimationBenchmarkGatePolicy = {
  failOnWarnings: boolean;
  requireExpectationsPerCase: boolean;
};

export type AnimationBenchmarkGate = {
  decision: 'pass' | 'blocked';
  reportFingerprint: string;
  gateFingerprint: string;
  policy: AnimationBenchmarkGatePolicy;
  blockingReasons: { caseId?: string; reason: string }[];
  scope: string;
};

const MAX_CASES = 100;
const MAX_EXPECTATIONS_PER_CASE = 100;
const MAX_BYTES = 8 * 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(recipe: AnimationRecipe): string {
  return createHash('sha256').update(canonical(recipe)).digest('hex');
}

export function animationBenchmarkRecipeFingerprint(input: unknown) {
  const parsed = recipeSchema.safeParse(input);
  return parsed.success && parsed.data.kind === 'animation' ? fingerprint(parsed.data) : null;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCase(value: unknown, index: number): AnimationBenchmarkCase {
  if (!isRecord(value)) throw new Error(`Case ${index + 1} must be an object.`);
  const { id, name, recipe, expectations, limits } = value;
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 80) throw new Error(`Case ${index + 1} needs a non-empty id up to 80 characters.`);
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) throw new Error(`Case ${id} needs a non-empty name up to 120 characters.`);
  if (!Array.isArray(expectations) || expectations.length > MAX_EXPECTATIONS_PER_CASE) throw new Error(`Case ${id} expectations must be an array of at most ${MAX_EXPECTATIONS_PER_CASE} entries.`);
  const parsedExpectations: BenchmarkExpectation[] = expectations.map((expectation, expectationIndex) => {
    if (!isRecord(expectation)
      || typeof expectation.id !== 'string' || !expectation.id.trim() || expectation.id.length > 80
      || typeof expectation.description !== 'string' || !expectation.description.trim() || expectation.description.length > 500
      || !['pass', 'warn', 'fail'].includes(String(expectation.outcome))
      || typeof expectation.evidence !== 'string' || !expectation.evidence.trim() || expectation.evidence.length > 1000) {
      throw new Error(`Case ${id} expectation ${expectationIndex + 1} is invalid.`);
    }
    return { id: expectation.id, description: expectation.description, outcome: expectation.outcome as BenchmarkExpectation['outcome'], evidence: expectation.evidence };
  });
  if (new Set(parsedExpectations.map(expectation => expectation.id)).size !== parsedExpectations.length) throw new Error(`Case ${id} expectation IDs must be unique.`);
  let parsedLimits: AnimationBenchmarkCase['limits'];
  if (limits !== undefined) {
    if (!isRecord(limits) || Object.keys(limits).some(key => !['maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond', 'maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond'].includes(key))) {
      throw new Error(`Case ${id} limits must contain only supported explicit numeric loop-seam limits.`);
    }
    const entries = Object.entries(limits);
    if (!entries.length) throw new Error(`Case ${id} limits must contain at least one supported criterion.`);
    for (const [key, limit] of entries) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || limit > 100000) throw new Error(`Case ${id} limit ${key} must be finite and between 0 and 100000.`);
    }
    const animation = recipeSchema.safeParse(recipe);
    if (!animation.success || animation.data.kind !== 'animation' || !animation.data.loop) throw new Error(`Case ${id} loop-seam limits require a valid looping animation recipe.`);
    parsedLimits = limits as AnimationBenchmarkCase['limits'];
  }
  return { id, name, recipe, expectations: parsedExpectations, ...(parsedLimits ? { limits: parsedLimits } : {}) };
}

function actualOutcome(severity: BenchmarkFinding['severity']): BenchmarkExpectation['outcome'] {
  return severity;
}

function evaluateCase(input: AnimationBenchmarkCase): BenchmarkCaseResult {
  const parsed = recipeSchema.safeParse(input.recipe);
  if (!parsed.success || parsed.data.kind !== 'animation') {
    const message = parsed.success ? 'Benchmark recipe must be an animation.' : parsed.error.issues.map(issue => `${issue.path.join('.') || 'recipe'}: ${issue.message}`).join('; ');
    const findings: BenchmarkFinding[] = [{ id: 'recipe-invalid', severity: 'fail', message: 'Recipe failed strict animation validation.', evidence: message }];
    const expectedOutcomes = input.expectations.map(expectation => ({ id: expectation.id, expected: expectation.outcome, actual: 'fail' as const, matched: expectation.outcome === 'fail' && expectation.id === 'recipe-invalid' }));
    const expectationMismatch = expectedOutcomes.some(outcome => !outcome.matched);
    return {
      id: input.id, name: input.name, status: expectationMismatch || !expectedOutcomes.some(outcome => outcome.id === 'recipe-invalid' && outcome.expected === 'fail') ? 'fail' : 'pass', fingerprint: null, findings,
      expectedOutcomes,
      limitations: ['Invalid recipes cannot be measured beyond validation errors.'],
    };
  }

  const recipe = parsed.data as AnimationRecipe;
  const findings: BenchmarkFinding[] = [{
    id: 'recipe-valid', severity: 'pass', message: 'Animation recipe passes strict schema and timeline validation.',
    evidence: `${recipe.tracks.length} base tracks; ${recipe.tracks.reduce((sum, track) => sum + track.keys.length, 0)} base keys; ${recipe.duration}s; loop=${recipe.loop}.`,
  }];
  const audit = auditAnimation(recipe, 120);
  const activeSeamMetrics = audit.loopSeamVelocity.filter(metric => metric.channel !== 'layer' || (metric.enabled && (metric.weight ?? 0) > 0));
  const seamCriteria = [
    { key: 'maxLoopSeamPositionVelocityDiscontinuityStudsPerSecond' as const, findingId: 'loop-seam-position-velocity', measure: (metric: (typeof activeSeamMetrics)[number]) => metric.positionDiscontinuityStudsPerSecond, unit: 'studs/second', label: 'position-velocity' },
    { key: 'maxLoopSeamAngularVelocityDiscontinuityDegreesPerSecond' as const, findingId: 'loop-seam-angular-velocity', measure: (metric: (typeof activeSeamMetrics)[number]) => metric.angularDiscontinuityDegreesPerSecond, unit: 'degrees/second', label: 'angular-velocity' },
  ];
  for (const criterion of seamCriteria) {
    const limit = input.limits?.[criterion.key];
    if (limit === undefined) continue;
    const worst = activeSeamMetrics.reduce((best, metric) => !best || criterion.measure(metric) > criterion.measure(best) ? metric : best, undefined as (typeof activeSeamMetrics)[number] | undefined);
    const observed = worst ? criterion.measure(worst) : 0;
    const passed = observed <= limit;
    findings.push({ id: criterion.findingId, severity: passed ? 'pass' : 'fail',
      message: `${passed ? 'Loop seam ' + criterion.label + ' discontinuity is within' : 'Loop seam ' + criterion.label + ' discontinuity exceeds'} the explicit limit${worst ? ` on ${worst.joint} (${worst.channel}${worst.layerId ? ` layer ${worst.layerId}` : ''})` : ''}.`,
      evidence: `Observed ${observed.toFixed(6)} ${criterion.unit}; caller limit ${limit} ${criterion.unit}. Estimate uses matched one-sided finite differences on individual authored channels and is not composed world-space playback.` });
  }
  for (const contact of recipe.contacts ?? []) {
    const matchingTracks = recipe.tracks.filter(track => track.joint === contact.effector);
    const matchingLayerTracks = (recipe.layers ?? []).flatMap(layer => layer.tracks.filter(track => track.joint === contact.effector));
    const driven = matchingTracks.length + matchingLayerTracks.length > 0;
    findings.push({
      id: `contact-track:${contact.effector}:${contact.start}:${contact.end}`,
      severity: driven ? 'pass' : 'warn',
      message: driven ? `Declared ${contact.kind} contact has a matching authored track.` : `Declared ${contact.kind} contact has no authored track with the effector name.`,
      evidence: `${contact.effector} from ${contact.start}s to ${contact.end}s; matching base tracks=${matchingTracks.length}, layer tracks=${matchingLayerTracks.length}. This confirms channel presence only, not world-space contact stability.`,
    });
  }
  for (const marker of recipe.markers) {
    findings.push({
      id: `marker:${marker.name}:${marker.time}`,
      severity: 'pass', message: `Marker ${marker.name} is within the validated clip timeline.`,
      evidence: `Marker at ${marker.time}s in a ${recipe.duration}s clip${marker.value ? `; value=${marker.value}` : ''}.`,
    });
  }
  for (const advisory of audit.advisories.filter(item => item.id !== 'visual-review')) {
    findings.push({ id: `audit:${advisory.id}`, severity: 'warn', message: advisory.detail, evidence: `Deterministic structural advisory ${advisory.id}; interpret against the intended motion and rig.` });
  }
  if (!recipe.contacts?.length) findings.push({
    id: 'contacts-undeclared', severity: 'warn', message: 'No support or grip contacts are declared.',
    evidence: 'The evaluator cannot test intended planted-foot or hand-grip intervals without explicit contact declarations and rig-space samples.',
  });
  if (!recipe.markers.length) findings.push({
    id: 'events-undeclared', severity: 'warn', message: 'No event markers are declared.',
    evidence: 'No semantic timing events are available for alignment or event-specific regression checks.',
  });

  const expectedOutcomes = input.expectations.map(expectation => {
    const matchedFinding = findings.find(finding => finding.id === expectation.id);
    const actual = matchedFinding ? actualOutcome(matchedFinding.severity) : 'warn';
    return { id: expectation.id, expected: expectation.outcome, actual, matched: actual === expectation.outcome };
  });
  const expectationMismatch = expectedOutcomes.some(outcome => !outcome.matched);
  const unexpectedFailure = findings.some(finding => finding.severity === 'fail'
    && !expectedOutcomes.some(outcome => outcome.id === finding.id && outcome.expected === 'fail' && outcome.matched));
  const unexpectedWarning = findings.some(finding => finding.severity === 'warn'
    && !expectedOutcomes.some(outcome => outcome.id === finding.id && outcome.expected === 'warn' && outcome.matched));
  const status: BenchmarkCaseResult['status'] = expectationMismatch || unexpectedFailure
    ? 'fail'
    : unexpectedWarning || expectedOutcomes.some(outcome => outcome.expected === 'warn')
      ? 'warn'
      : 'pass';
  return {
    id: input.id, name: input.name, status, fingerprint: fingerprint(recipe), findings, expectedOutcomes, metrics: audit.summary,
    limitations: [
      'Recipe-only analysis does not evaluate rig hierarchy, rest pose, Motor6D/Bone axes, world-space contacts, skinning, rendered appearance, collisions, or physics.',
      'A passing result means only that declared static expectations and implemented structural checks passed; it is not an artistic-quality score or Roblox runtime certification.',
      'Expected outcomes are human-authored regression assertions. The evaluator does not infer whether a motion fulfills its natural-language intent.',
    ],
  };
}

export function runAnimationBenchmark(input: unknown): AnimationBenchmarkReport {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error(`Benchmark input must be valid JSON no larger than ${MAX_BYTES} bytes.`);
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.cases)) throw new Error('Benchmark suite must contain schemaVersion: 1 and a cases array.');
  if (input.cases.length === 0 || input.cases.length > MAX_CASES) throw new Error(`Benchmark suite must contain 1–${MAX_CASES} cases.`);
  const cases = input.cases.map(validateCase);
  if (new Set(cases.map(testCase => testCase.id)).size !== cases.length) throw new Error('Benchmark case IDs must be unique.');
  const results = cases.map(evaluateCase);
  const expectationCount = results.reduce((sum, result) => sum + result.expectedOutcomes.length, 0);
  const matchedExpectations = results.reduce((sum, result) => sum + result.expectedOutcomes.filter(outcome => outcome.matched).length, 0);
  const suiteFingerprint = hash(input);
  const summary = {
      cases: results.length,
      passed: results.filter(result => result.status === 'pass').length,
      warnings: results.filter(result => result.status === 'warn').length,
      failed: results.filter(result => result.status === 'fail').length,
      expectations: expectationCount,
      matchedExpectations,
    };
  const limitations = [
      'This is a deterministic recipe regression harness, not an animation-quality model or rendered evaluation.',
      'World-space contact, silhouette, readability, weight, and Roblox engine behavior require a live rig and visual review.',
      'Do not compare scores across different expectation sets as if they were a universal quality rating.',
    ];
  const reportFingerprint = hash({ schemaVersion: 1, suiteFingerprint, summary, cases: results, limitations });
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), suiteFingerprint, reportFingerprint,
    summary, cases: results, limitations,
  };
}

/**
 * Apply an explicit release policy to a benchmark report. This gates only declared
 * structural assertions; it is intentionally not a visual or artistic-quality verdict.
 */
export function evaluateAnimationBenchmarkGate(
  report: AnimationBenchmarkReport,
  policy: Partial<AnimationBenchmarkGatePolicy> = {},
): AnimationBenchmarkGate {
  const resolvedPolicy: AnimationBenchmarkGatePolicy = {
    failOnWarnings: policy.failOnWarnings ?? true,
    requireExpectationsPerCase: policy.requireExpectationsPerCase ?? true,
  };
  const blockingReasons: AnimationBenchmarkGate['blockingReasons'] = [];
  for (const result of report.cases) {
    if (result.status === 'fail') blockingReasons.push({ caseId: result.id, reason: 'Benchmark case failed.' });
    if (resolvedPolicy.failOnWarnings && result.status === 'warn') blockingReasons.push({ caseId: result.id, reason: 'Benchmark case has warnings and policy does not allow them.' });
    if (resolvedPolicy.requireExpectationsPerCase && result.expectedOutcomes.length === 0) {
      blockingReasons.push({ caseId: result.id, reason: 'Case has no declared expectations; release gate requires at least one assertion per case.' });
    }
    for (const outcome of result.expectedOutcomes) {
      if (!outcome.matched) blockingReasons.push({ caseId: result.id, reason: `Expectation "${outcome.id}" did not match: expected ${outcome.expected}, observed ${outcome.actual}.` });
    }
  }
  const decision = blockingReasons.length === 0 ? 'pass' : 'blocked';
  const gateFingerprint = hash({ reportFingerprint: report.reportFingerprint, decision, policy: resolvedPolicy, blockingReasons });
  return {
    decision,
    reportFingerprint: report.reportFingerprint,
    gateFingerprint,
    policy: resolvedPolicy,
    blockingReasons,
    scope: 'This decision covers only strict recipe validation, implemented structural checks, and caller-declared expectations in this report. It does not certify intent, artistic quality, rig behavior, rendered appearance, physics, or Roblox runtime correctness.',
  };
}

export function verifyAnimationBenchmarkAttestation(report: AnimationBenchmarkReport, gate: AnimationBenchmarkGate): boolean {
  const expectedReportFingerprint = hash({ schemaVersion: 1, suiteFingerprint: report.suiteFingerprint,
    summary: report.summary, cases: report.cases, limitations: report.limitations });
  if (report.reportFingerprint !== expectedReportFingerprint || gate.reportFingerprint !== report.reportFingerprint) return false;
  const expectedGateFingerprint = hash({ reportFingerprint: gate.reportFingerprint, decision: gate.decision,
    policy: gate.policy, blockingReasons: gate.blockingReasons });
  return gate.gateFingerprint === expectedGateFingerprint;
}
