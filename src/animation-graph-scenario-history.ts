import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AnimationGraphLibrary } from './animation-graph.js';
import { graphScenarioSchema, graphScenarioSuiteFingerprint, graphScenarioSuiteSchema, runAnimationGraphScenarioSuite } from './animation-graph-scenarios.js';
import { identifier, label } from './recipes.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const parentSchema = z.object({ id: identifier, revision: z.number().int().positive() }).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function draftPayload(value: { name: string; parent?: { id: string; revision: number }; graphId: string; graphFingerprint: string;
  scenarios: z.infer<typeof graphScenarioSchema>[] }) {
  return { schemaVersion: 1, name: value.name, parent: value.parent ?? null, graphId: value.graphId,
    graphFingerprint: value.graphFingerprint, scenarios: value.scenarios };
}

function deterministicPlanId(fingerprint: string) {
  const bytes = createHash('sha256').update(`motion-tools:graph-scenario-plan:${fingerprint}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const planSchema = z.object({
  id: identifier,
  name: label,
  revision: z.number().int().positive(),
  parent: parentSchema.nullable(),
  graphId: identifier,
  graphFingerprint: hash,
  suiteFingerprint: hash,
  draftFingerprint: hash,
  planFingerprint: hash,
  createdAt: z.string().datetime(),
  scenarios: z.array(graphScenarioSchema).min(1).max(100),
}).strict().superRefine((plan, context) => {
  const suiteFingerprint = graphScenarioSuiteFingerprint({ scenarios: plan.scenarios });
  if (suiteFingerprint !== plan.suiteFingerprint) context.addIssue({ code: 'custom', path: ['suiteFingerprint'], message: 'Plan scenario suite fingerprint does not match its scenarios.' });
  const parent = plan.parent ?? undefined;
  const computedDraft = digest(draftPayload({ name: plan.name, parent, graphId: plan.graphId,
    graphFingerprint: plan.graphFingerprint, scenarios: plan.scenarios }));
  if (computedDraft !== plan.draftFingerprint) context.addIssue({ code: 'custom', path: ['draftFingerprint'], message: 'Plan draft fingerprint does not match its immutable content.' });
  if (plan.id !== deterministicPlanId(plan.draftFingerprint)) context.addIssue({ code: 'custom', path: ['id'], message: 'Plan ID is not the deterministic ID for its reviewed draft.' });
  if (plan.revision !== (parent?.revision ?? 0) + 1) context.addIssue({ code: 'custom', path: ['revision'], message: 'Plan revision must directly follow its parent revision.' });
  if (digest({ draftFingerprint: plan.draftFingerprint, revision: plan.revision }) !== plan.planFingerprint) {
    context.addIssue({ code: 'custom', path: ['planFingerprint'], message: 'Plan fingerprint does not match the reviewed draft and revision.' });
  }
});

const resultReportSchema = z.object({
  schemaVersion: z.literal(1), graphFingerprint: hash, suiteFingerprint: hash,
  status: z.enum(['passed', 'failed']),
  summary: z.object({ scenarios: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(), coveredStates: z.number().int().nonnegative(), totalStates: z.number().int().nonnegative(),
    coveredTransitions: z.number().int().nonnegative(), totalTransitions: z.number().int().nonnegative() }).strict(),
  coveredStateIds: z.array(z.string()), uncoveredStateIds: z.array(z.string()),
  coveredTransitionIds: z.array(z.string()), uncoveredTransitionIds: z.array(z.string()),
  scenarios: z.array(z.unknown()).min(1).max(100), limitation: z.string(), reportFingerprint: hash,
}).strict().superRefine((report, context) => {
  const { reportFingerprint, ...content } = report;
  if (digest(content) !== reportFingerprint) context.addIssue({ code: 'custom', path: ['reportFingerprint'], message: 'Scenario report fingerprint does not match its content.' });
});

const runSchema = z.object({
  id: identifier,
  planId: identifier,
  planFingerprint: hash,
  planRevision: z.number().int().positive(),
  graphId: identifier,
  graphFingerprint: hash,
  suiteFingerprint: hash,
  recordedAt: z.string().datetime(),
  report: resultReportSchema,
  runFingerprint: hash,
}).strict().superRefine((run, context) => {
  if (run.report.graphFingerprint !== run.graphFingerprint || run.report.suiteFingerprint !== run.suiteFingerprint) {
    context.addIssue({ code: 'custom', path: ['report'], message: 'Scenario run report does not match its pinned graph and suite.' });
  }
  const { runFingerprint, ...content } = run;
  if (digest(content) !== runFingerprint) context.addIssue({ code: 'custom', path: ['runFingerprint'], message: 'Scenario run fingerprint does not match its content.' });
});

const storedRunSchema = z.object({ run: runSchema, integrity: hash }).strict();
export type GraphScenarioPlan = z.infer<typeof planSchema>;
export type GraphScenarioRun = z.infer<typeof runSchema>;

async function writeImmutable(path: string, value: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await link(temporaryPath, path);
  } finally { await unlink(temporaryPath).catch(() => undefined); }
}

function compareRunContent(before: GraphScenarioRun, after: GraphScenarioRun) {
  const beforeScenarios = new Map(before.report.scenarios.map((value) => {
    const scenario = value as { id: string; name: string; status: 'passed' | 'failed'; steps: { step: number; matched: boolean; actualTransitionId: string | null }[] };
    return [scenario.id, scenario] as const;
  }));
  const afterScenarios = new Map(after.report.scenarios.map((value) => {
    const scenario = value as { id: string; name: string; status: 'passed' | 'failed'; steps: { step: number; matched: boolean; actualTransitionId: string | null }[] };
    return [scenario.id, scenario] as const;
  }));
  const scenarioChanges = [...new Set([...beforeScenarios.keys(), ...afterScenarios.keys()])].sort().map(id => {
    const left = beforeScenarios.get(id), right = afterScenarios.get(id);
    const trend = !left ? 'added' : !right ? 'removed' : left.status === right.status
      ? left.status === 'passed' ? 'stable_pass' : 'stable_fail'
      : left.status === 'passed' ? 'regression' : 'improvement';
    const stepChanges = [...new Set([...(left?.steps ?? []).map(step => step.step), ...(right?.steps ?? []).map(step => step.step)])].sort((a, b) => a - b).flatMap(step => {
      const oldStep = left?.steps.find(item => item.step === step);
      const newStep = right?.steps.find(item => item.step === step);
      if (!oldStep || !newStep || (oldStep.matched === newStep.matched && oldStep.actualTransitionId === newStep.actualTransitionId)) return [];
      return [{ step, beforeMatched: oldStep.matched, afterMatched: newStep.matched,
        beforeTransitionId: oldStep.actualTransitionId, afterTransitionId: newStep.actualTransitionId }];
    });
    return { id, trend, beforeStatus: left?.status ?? null, afterStatus: right?.status ?? null,
      beforeName: left?.name ?? null, afterName: right?.name ?? null, stepChanges };
  });
  return { scenarioChanges, summary: { regressions: scenarioChanges.filter(item => item.trend === 'regression').length,
    improvements: scenarioChanges.filter(item => item.trend === 'improvement').length,
    stableFailures: scenarioChanges.filter(item => item.trend === 'stable_fail').length,
    stablePasses: scenarioChanges.filter(item => item.trend === 'stable_pass').length,
    added: scenarioChanges.filter(item => item.trend === 'added').length,
    removed: scenarioChanges.filter(item => item.trend === 'removed').length } };
}

export class AnimationGraphScenarioHistory {
  constructor(private readonly directory: string, private readonly graphs: AnimationGraphLibrary) {}

  private async loadPlan(id: string): Promise<GraphScenarioPlan> {
    const path = join(this.directory, 'plans', `${identifier.parse(id)}.json`);
    return planSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }

  async preview(nameInput: string, graphIdInput: string, scenariosInput: unknown, parentPlanId?: string) {
    const name = label.parse(nameInput);
    const graphId = identifier.parse(graphIdInput);
    const savedGraph = await this.graphs.get(graphId);
    const suite = graphScenarioSuiteSchema.parse({ scenarios: scenariosInput });
    const parent = parentPlanId ? await this.loadPlan(parentPlanId) : undefined;
    const parentRef = parent ? { id: parent.id, revision: parent.revision } : undefined;
    const payload = draftPayload({ name, parent: parentRef, graphId, graphFingerprint: savedGraph.graphFingerprint, scenarios: suite.scenarios });
    const draftFingerprint = digest(payload);
    return { name, graphId, graphFingerprint: savedGraph.graphFingerprint, sourceFingerprints: savedGraph.sourceFingerprints,
      parent: parentRef ?? null, proposedRevision: (parent?.revision ?? 0) + 1,
      proposedPlanId: deterministicPlanId(draftFingerprint), scenarios: suite.scenarios,
      suiteFingerprint: graphScenarioSuiteFingerprint(suite), draftFingerprint,
      coveragePreview: { scenarioCount: suite.scenarios.length, stepCount: suite.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
        expectedTransitions: [...new Set(suite.scenarios.flatMap(scenario => scenario.steps.flatMap(step => step.expect.kind === 'transition' ? [step.expect.transitionId] : [])))].sort() },
      willWrite: false, commitTool: 'motion_animation_graph_scenario_plan_create',
      limitation: 'This draft pins the current graph and source animations but does not execute scenarios. Review expected routes and negative cases before creating the immutable contract.' };
  }

  async create(nameInput: string, graphIdInput: string, scenariosInput: unknown, expectedDraftFingerprint: string, parentPlanId?: string) {
    const expected = hash.parse(expectedDraftFingerprint);
    const name = label.parse(nameInput);
    const graphId = identifier.parse(graphIdInput);
    const suite = graphScenarioSuiteSchema.parse({ scenarios: scenariosInput });
    const parent = parentPlanId ? await this.loadPlan(parentPlanId) : undefined;
    const existingPath = join(this.directory, 'plans', `${deterministicPlanId(expected)}.json`);
    try {
      const existing = planSchema.parse(JSON.parse(await readFile(existingPath, 'utf8')));
      if (existing.draftFingerprint === expected && existing.name === name && existing.graphId === graphId
        && existing.parent?.id === parent?.id && JSON.stringify(existing.scenarios) === JSON.stringify(suite.scenarios)) return existing;
      throw new Error('The reviewed draft fingerprint belongs to a different immutable plan request.');
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const draft = await this.preview(name, graphId, suite.scenarios, parentPlanId);
    if (draft.draftFingerprint !== expected) throw new Error('The scenario-plan draft differs from the reviewed preview. Re-preview the current graph and cases before committing.');
    if (parent && draft.proposedRevision !== parent.revision + 1) throw new Error('Scenario-plan parent revision changed after preview.');
    const plan = planSchema.parse({ id: draft.proposedPlanId, name: draft.name, revision: draft.proposedRevision,
      parent: draft.parent, graphId: draft.graphId, graphFingerprint: draft.graphFingerprint,
      suiteFingerprint: draft.suiteFingerprint, draftFingerprint: draft.draftFingerprint,
      planFingerprint: digest({ draftFingerprint: draft.draftFingerprint, revision: draft.proposedRevision }),
      createdAt: new Date().toISOString(), scenarios: draft.scenarios });
    const directory = join(this.directory, 'plans');
    await mkdir(directory, { recursive: true });
    try { await writeImmutable(existingPath, plan); return plan; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.loadPlan(plan.id);
      if (existing.planFingerprint !== plan.planFingerprint) throw new Error('Deterministic scenario-plan identity collision; refusing to overwrite immutable content.');
      return existing;
    }
  }

  async read(id: string) {
    const plan = await this.loadPlan(id);
    try {
      const graph = await this.graphs.get(plan.graphId);
      return { plan, graphStatus: graph.graphFingerprint === plan.graphFingerprint ? 'current' as const : 'changed' as const,
        currentGraphFingerprint: graph.graphFingerprint };
    } catch (error) {
      return { plan, graphStatus: 'unavailable' as const, graphIssue: error instanceof Error ? error.message : String(error) };
    }
  }

  async list(offset = 0, limit = 30) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Plan pagination requires offset ≥ 0 and limit 1–100.');
    const directory = join(this.directory, 'plans');
    const names = (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    const plans = await Promise.all(names.map(name => this.loadPlan(name.slice(0, -5))));
    const rows = await Promise.all(plans.map(async plan => {
      try {
        const graph = await this.graphs.get(plan.graphId);
        return { id: plan.id, name: plan.name, revision: plan.revision, parentId: plan.parent?.id ?? null,
          graphId: plan.graphId, graphStatus: graph.graphFingerprint === plan.graphFingerprint ? 'current' as const : 'changed' as const,
          scenarioCount: plan.scenarios.length, suiteFingerprint: plan.suiteFingerprint, createdAt: plan.createdAt };
      } catch {
        return { id: plan.id, name: plan.name, revision: plan.revision, parentId: plan.parent?.id ?? null,
          graphId: plan.graphId, graphStatus: 'unavailable' as const, scenarioCount: plan.scenarios.length,
          suiteFingerprint: plan.suiteFingerprint, createdAt: plan.createdAt };
      }
    }));
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { total: rows.length, offset, plans: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  private async readRunPath(path: string, expectedId?: string): Promise<GraphScenarioRun> {
    const stored = storedRunSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if ((expectedId !== undefined && stored.run.id !== expectedId) || digest(stored.run) !== stored.integrity) throw new Error('Animation graph scenario run identity or integrity check failed.');
    return stored.run;
  }

  async run(planIdInput: string, expectedPlanFingerprint?: string) {
    const plan = await this.loadPlan(planIdInput);
    if (expectedPlanFingerprint !== undefined && hash.parse(expectedPlanFingerprint) !== plan.planFingerprint) throw new Error('Scenario plan fingerprint differs from the reviewed expectation. Read the current immutable plan before running it.');
    const graph = await this.graphs.get(plan.graphId);
    if (graph.graphFingerprint !== plan.graphFingerprint) throw new Error('Saved graph differs from this scenario plan. Create a reviewed child plan for the new graph revision.');
    const report = runAnimationGraphScenarioSuite(graph.graph, { scenarios: plan.scenarios });
    if (report.suiteFingerprint !== plan.suiteFingerprint) throw new Error('Scenario plan content failed its suite-fingerprint check.');
    const base = { id: randomUUID(), planId: plan.id, planFingerprint: plan.planFingerprint, planRevision: plan.revision,
      graphId: plan.graphId, graphFingerprint: plan.graphFingerprint, suiteFingerprint: plan.suiteFingerprint,
      recordedAt: new Date().toISOString(), report };
    const run = runSchema.parse({ ...base, runFingerprint: digest(base) });
    const directory = join(this.directory, 'runs');
    await mkdir(directory, { recursive: true });
    await writeImmutable(join(directory, `${run.id}.json`), { run, integrity: digest(run) });
    return run;
  }

  async history(planIdInput: string, limit = 20) {
    const plan = await this.loadPlan(planIdInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Scenario run history limit must be 1–100.');
    const directory = join(this.directory, 'runs');
    const names = (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const all = await Promise.all(names.map(name => this.readRunPath(join(directory, name), name.slice(0, -5))));
    const runs = all.filter(run => run.planId === plan.id);
    for (const run of runs) if (run.planFingerprint !== plan.planFingerprint) throw new Error(`Run ${run.id} does not match the immutable scenario plan.`);
    runs.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || left.id.localeCompare(right.id));
    return { planId: plan.id, planFingerprint: plan.planFingerprint, total: runs.length, runs: runs.slice(0, limit) };
  }

  async compare(beforeRunId: string, afterRunId: string) {
    const directory = join(this.directory, 'runs');
    const before = await this.readRunPath(join(directory, `${identifier.parse(beforeRunId)}.json`), beforeRunId);
    const after = await this.readRunPath(join(directory, `${identifier.parse(afterRunId)}.json`), afterRunId);
    const compared = compareRunContent(before, after);
    return { before: { id: before.id, planId: before.planId, planFingerprint: before.planFingerprint,
      graphFingerprint: before.graphFingerprint, suiteFingerprint: before.suiteFingerprint,
      reportFingerprint: before.report.reportFingerprint, status: before.report.status },
    after: { id: after.id, planId: after.planId, planFingerprint: after.planFingerprint,
      graphFingerprint: after.graphFingerprint, suiteFingerprint: after.suiteFingerprint,
      reportFingerprint: after.report.reportFingerprint, status: after.report.status },
    comparability: before.graphFingerprint === after.graphFingerprint && before.suiteFingerprint === after.suiteFingerprint ? 'same_contract' : 'changed_contract',
    ...compared,
    interpretation: 'Run comparisons report deterministic transition-assertion changes only. A pass/fail trend is not an animation-quality judgment, Roblox runtime result, or proof of gameplay correctness. Changed graph/suite contracts are exploratory and not directly comparable.' };
  }
}
