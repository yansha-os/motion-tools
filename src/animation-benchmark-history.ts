import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { evaluateAnimationBenchmarkGate, runAnimationBenchmark, verifyAnimationBenchmarkAttestation, type AnimationBenchmarkGatePolicy } from './animation-benchmark.js';
import { identifier } from './recipes.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const benchmarkCaseSchema = z.object({
  id: z.string().min(1).max(80), name: z.string(), status: z.enum(['pass', 'warn', 'fail']), fingerprint: hash.nullable(),
  findings: z.array(z.object({ id: z.string(), severity: z.enum(['pass', 'warn', 'fail']), message: z.string(), evidence: z.string() }).strict()),
  expectedOutcomes: z.array(z.object({ id: z.string(), expected: z.enum(['pass', 'warn', 'fail']), actual: z.enum(['pass', 'warn', 'fail']), matched: z.boolean() }).strict()),
  metrics: z.object({ tracks: z.number(), keys: z.number(), duration: z.number(), loop: z.boolean(), layerTracks: z.number(), rootMotionTracks: z.number(), analyzedTracks: z.number(), analyzedKeys: z.number() }).strict().optional(),
  limitations: z.array(z.string()),
}).strict();
const recordSchema = z.object({
  id: identifier,
  recordedAt: z.string().datetime(),
  report: z.object({
    schemaVersion: z.literal(1), generatedAt: z.string().datetime(), suiteFingerprint: hash, reportFingerprint: hash,
    summary: z.object({ cases: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), warnings: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), expectations: z.number().int().nonnegative(), matchedExpectations: z.number().int().nonnegative() }).strict(),
    cases: z.array(benchmarkCaseSchema).min(1).max(100), limitations: z.array(z.string()),
  }).strict(),
  releaseGate: z.object({ decision: z.enum(['pass', 'blocked']), reportFingerprint: hash, gateFingerprint: hash,
    policy: z.object({ failOnWarnings: z.boolean(), requireExpectationsPerCase: z.boolean() }).strict(),
    blockingReasons: z.array(z.object({ caseId: z.string().min(1).max(80).optional(), reason: z.string() }).strict()), scope: z.string() }).strict(),
}).strict();

export type AnimationBenchmarkRun = z.infer<typeof recordSchema>;
const statusRank = { pass: 0, warn: 1, fail: 2 } as const;
const severityRank = { pass: 0, warn: 1, fail: 2 } as const;

export class AnimationBenchmarkHistory {
  constructor(readonly directory: string) {}

  private async writeNewRecord(path: string, run: AnimationBenchmarkRun) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(run, null, 2), { flag: 'wx' });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async readPath(path: string, expectedId?: string) {
    const run = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if ((expectedId !== undefined && run.id !== expectedId) || !verifyAnimationBenchmarkAttestation(run.report, run.releaseGate)) {
      throw new Error('Benchmark history record identity or fingerprint attestation is invalid.');
    }
    return run;
  }

  async record(suite: unknown, policy: Partial<AnimationBenchmarkGatePolicy> = {}): Promise<AnimationBenchmarkRun> {
    const report = runAnimationBenchmark(suite);
    const releaseGate = evaluateAnimationBenchmarkGate(report, policy);
    const run = recordSchema.parse({ id: randomUUID(), recordedAt: new Date().toISOString(), report, releaseGate });
    await this.writeSuite(report.suiteFingerprint, suite, report.reportFingerprint);
    await mkdir(this.directory, { recursive: true });
    await this.writeNewRecord(join(this.directory, `${run.id}.json`), run);
    return run;
  }

  private async writeSuite(suiteFingerprint: string, suite: unknown, expectedReportFingerprint: string) {
    const directory = join(this.directory, 'suites');
    const path = join(directory, `${suiteFingerprint}.json`);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `${randomUUID()}.pending`);
    try {
      await writeFile(temporaryPath, JSON.stringify(suite, null, 2), { flag: 'wx' });
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = runAnimationBenchmark(JSON.parse(await readFile(path, 'utf8')));
      if (existing.suiteFingerprint !== suiteFingerprint || existing.reportFingerprint !== expectedReportFingerprint) {
        throw new Error('Content-addressed benchmark suite archive failed its fingerprint check.');
      }
    } finally { await unlink(temporaryPath).catch(() => undefined); }
  }

  private async loadSuite(runId: string) {
    const run = await this.read(runId);
    const suite = JSON.parse(await readFile(join(this.directory, 'suites', `${run.report.suiteFingerprint}.json`), 'utf8')) as unknown;
    const replayed = runAnimationBenchmark(suite);
    if (replayed.suiteFingerprint !== run.report.suiteFingerprint || replayed.reportFingerprint !== run.report.reportFingerprint) {
      throw new Error('Archived benchmark suite does not reproduce the selected run report.');
    }
    return { run, suite, replayed };
  }

  async readSuite(runId: string, offset = 0, limit = 10) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('Benchmark suite pagination requires offset ≥ 0 and limit 1–20.');
    }
    const { run, suite, replayed } = await this.loadSuite(runId);
    if (typeof suite !== 'object' || suite === null || !('cases' in suite) || !Array.isArray(suite.cases)) {
      throw new Error('Archived benchmark suite has an invalid case list.');
    }
    const cases = suite.cases;
    return { runId: run.id, suiteFingerprint: replayed.suiteFingerprint, reportFingerprint: replayed.reportFingerprint,
      suiteHeader: { schemaVersion: 1 }, cases: cases.slice(offset, offset + limit), totalCases: cases.length, offset,
      nextOffset: offset + limit < cases.length ? offset + limit : null, replayVerified: true as const,
      limitation: 'The archived suite reproduces deterministic recipe-level analysis and declared expectations only; it does not reproduce Studio runtime, rendering, or artistic review.' };
  }

  async rerun(runId: string) {
    const { run, suite } = await this.loadSuite(runId);
    return this.record(suite, run.releaseGate.policy);
  }

  async read(idInput: string): Promise<AnimationBenchmarkRun> {
    const id = identifier.parse(idInput);
    return this.readPath(join(this.directory, `${id}.json`), id);
  }

  async list(limit = 20, suiteFingerprint?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Benchmark history limit must be 1–100.');
    if (suiteFingerprint !== undefined) hash.parse(suiteFingerprint);
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(file => /^[0-9a-f-]{36}\.json$/.test(file));
    const runs = (await Promise.all(files.map(async file => this.readPath(join(this.directory, file), file.slice(0, -5)))))
      .filter(run => suiteFingerprint === undefined || run.report.suiteFingerprint === suiteFingerprint);
    runs.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || left.id.localeCompare(right.id));
    return { total: runs.length, runs: runs.slice(0, limit).map(run => ({ id: run.id, recordedAt: run.recordedAt,
      suiteFingerprint: run.report.suiteFingerprint, reportFingerprint: run.report.reportFingerprint,
      gateFingerprint: run.releaseGate.gateFingerprint, decision: run.releaseGate.decision, summary: run.report.summary })) };
  }

  async compare(beforeId: string, afterId: string) {
    if (beforeId === afterId) throw new Error('Choose two distinct benchmark run IDs.');
    const [before, after] = await Promise.all([this.read(beforeId), this.read(afterId)]);
    const beforeCases = new Map(before.report.cases.map(item => [item.id, item] as const));
    const afterCases = new Map(after.report.cases.map(item => [item.id, item] as const));
    const ids = [...new Set([...beforeCases.keys(), ...afterCases.keys()])].sort();
    const cases = ids.map(id => {
      const left = beforeCases.get(id), right = afterCases.get(id);
      const statusTrend = !left || !right ? 'case_added_or_removed'
        : statusRank[right.status] > statusRank[left.status] ? 'status_worsened'
          : statusRank[right.status] < statusRank[left.status] ? 'status_improved' : 'status_stable';
      const leftFindings = new Map(left?.findings.map(finding => [finding.id, finding] as const) ?? []);
      const rightFindings = new Map(right?.findings.map(finding => [finding.id, finding] as const) ?? []);
      const findingIds = [...new Set([...leftFindings.keys(), ...rightFindings.keys()])].sort();
      const findingChanges = findingIds.flatMap(findingId => {
        const previous = leftFindings.get(findingId), current = rightFindings.get(findingId);
        const change = !previous ? 'appeared' : !current ? 'disappeared'
          : severityRank[current.severity] > severityRank[previous.severity] ? 'severity_increased'
            : severityRank[current.severity] < severityRank[previous.severity] ? 'severity_decreased'
              : current.evidence !== previous.evidence || current.message !== previous.message ? 'evidence_changed' : 'stable';
        if (change === 'stable') return [];
        return [{ findingId, change, beforeSeverity: previous?.severity ?? null, afterSeverity: current?.severity ?? null,
          beforeMessage: previous?.message ?? null, afterMessage: current?.message ?? null,
          beforeEvidence: previous?.evidence ?? null, afterEvidence: current?.evidence ?? null }];
      });
      const leftExpectations = new Map(left?.expectedOutcomes.map(outcome => [outcome.id, outcome] as const) ?? []);
      const rightExpectations = new Map(right?.expectedOutcomes.map(outcome => [outcome.id, outcome] as const) ?? []);
      const expectationIds = [...new Set([...leftExpectations.keys(), ...rightExpectations.keys()])].sort();
      const expectationChanges = expectationIds.flatMap(expectationId => {
        const previous = leftExpectations.get(expectationId), current = rightExpectations.get(expectationId);
        const change = !previous ? 'added' : !current ? 'removed'
          : previous.expected !== current.expected ? 'criterion_changed'
            : previous.actual !== current.actual || previous.matched !== current.matched ? 'result_changed' : 'stable';
        if (change === 'stable') return [];
        return [{ expectationId, change, beforeExpected: previous?.expected ?? null, afterExpected: current?.expected ?? null,
          beforeActual: previous?.actual ?? null, afterActual: current?.actual ?? null,
          beforeMatched: previous?.matched ?? null, afterMatched: current?.matched ?? null,
          criterionChanged: previous && current ? previous.expected !== current.expected : null,
          observedResultChanged: previous && current ? previous.actual !== current.actual : null,
          matchStateChanged: previous && current ? previous.matched !== current.matched : null }];
      });
      return { id, statusTrend, beforeStatus: left?.status ?? null, afterStatus: right?.status ?? null,
        beforeName: left?.name ?? null, afterName: right?.name ?? null,
        caseNameChanged: left && right ? left.name !== right.name : null,
        recipeFingerprintChanged: left && right ? left.fingerprint !== right.fingerprint : null,
        beforeFindingCount: left?.findings.length ?? 0, afterFindingCount: right?.findings.length ?? 0, findingChanges, expectationChanges };
    });
    return {
      before: { id: before.id, suiteFingerprint: before.report.suiteFingerprint, reportFingerprint: before.report.reportFingerprint,
        gateFingerprint: before.releaseGate.gateFingerprint, decision: before.releaseGate.decision },
      after: { id: after.id, suiteFingerprint: after.report.suiteFingerprint, reportFingerprint: after.report.reportFingerprint,
        gateFingerprint: after.releaseGate.gateFingerprint, decision: after.releaseGate.decision },
      comparability: before.report.suiteFingerprint === after.report.suiteFingerprint ? 'same_suite' : 'changed_suite',
      caseChanges: cases,
      interpretation: 'Finding changes compare deterministic structural observations and their evidence; case status trends summarize pass/warn/fail only. Neither implies artistic quality improved or regressed. Changed-suite comparisons are exploratory because suite definitions or recipe inputs differ.',
    };
  }
}
