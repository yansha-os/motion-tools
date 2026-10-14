import { createHash } from 'node:crypto';
import { z } from 'zod';
import { animationGraphFingerprint, animationGraphSchema, evaluateAnimationGraphTransition } from './animation-graph.js';
import { label } from './recipes.js';

const scenarioId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const parameterValue = z.union([z.boolean(), z.number().finite(), z.string().max(256)]);
const MAX_SCENARIO_STEPS = 256;
const MAX_REJECTED_BRANCH_DETAILS = 8;
const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transition'), transitionId: scenarioId }).strict(),
  z.object({ kind: z.literal('no_transition') }).strict(),
]);

export const graphScenarioSchema = z.object({
  id: scenarioId,
  name: label,
  steps: z.array(z.object({
    trigger: label,
    setParameters: z.record(scenarioId, parameterValue).default({}),
    expect: expectationSchema,
  }).strict()).min(1).max(64),
}).strict();

export const graphScenarioSuiteSchema = z.object({
  scenarios: z.array(graphScenarioSchema).min(1).max(100),
}).strict().superRefine((suite, context) => {
  const ids = suite.scenarios.map(scenario => scenario.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['scenarios'], message: 'Scenario IDs must be unique.' });
  const stepCount = suite.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0);
  if (stepCount > MAX_SCENARIO_STEPS) context.addIssue({ code: 'custom', path: ['scenarios'], message: `Scenario suite cannot exceed ${MAX_SCENARIO_STEPS} total trigger steps.` });
  if (Buffer.byteLength(JSON.stringify(suite), 'utf8') > 2 * 1024 * 1024) {
    context.addIssue({ code: 'custom', path: ['scenarios'], message: 'Scenario suite must be no larger than 2 MiB after normalization.' });
  }
});

type GraphScenarioSuite = z.infer<typeof graphScenarioSuiteSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function graphScenarioSuiteFingerprint(suiteInput: unknown): string {
  const suite = graphScenarioSuiteSchema.parse(suiteInput);
  return digest({ schemaVersion: 1, scenarios: suite.scenarios });
}

/** Executes deterministic trigger/parameter assertions without advancing Roblox time or mutating the graph. */
export function runAnimationGraphScenarioSuite(graphInput: unknown, suiteInput: unknown) {
  const graph = animationGraphSchema.parse(graphInput);
  const suite: GraphScenarioSuite = graphScenarioSuiteSchema.parse(suiteInput);
  const transitions = new Map(graph.transitions.map(transition => [transition.id, transition]));
  for (const scenario of suite.scenarios) for (const [index, step] of scenario.steps.entries()) {
    if (step.expect.kind === 'transition' && !transitions.has(step.expect.transitionId)) {
      throw new Error(`Scenario ${scenario.id} step ${index + 1} expects unknown transition ${step.expect.transitionId}.`);
    }
  }

  const scenarioResults = suite.scenarios.map(scenario => {
    let state = graph.entryState;
    let values: Record<string, boolean | number | string> = {};
    const visitedStates = new Set([state]);
    const coveredTransitions = new Set<string>();
    const steps = scenario.steps.map((step, index) => {
      const proposedValues = { ...values, ...step.setParameters };
      const expectedTransition = step.expect.kind === 'transition' ? transitions.get(step.expect.transitionId) : undefined;
      const expectationError = expectedTransition && expectedTransition.from !== state
        ? `Expected transition ${expectedTransition.id} starts in ${expectedTransition.from}, but the scenario is currently in ${state}.`
        : expectedTransition && expectedTransition.trigger.toLowerCase() !== step.trigger.toLowerCase()
          ? `Expected transition ${expectedTransition.id} listens for ${expectedTransition.trigger}, not ${step.trigger}.`
          : null;
      try {
        const evaluation = evaluateAnimationGraphTransition(graph, state, step.trigger, proposedValues);
        values = evaluation.parameterValues;
        const selected = evaluation.selectedTransition;
        const matched = !expectationError && (step.expect.kind === 'transition'
          ? selected?.id === step.expect.transitionId
          : selected === null);
        const stepResult = {
          step: index + 1,
          stateBefore: state,
          trigger: step.trigger,
          parameterValues: values,
          expected: step.expect,
          actualTransitionId: selected?.id ?? null,
          actualStateAfter: selected?.to ?? state,
          matched,
          expectationError,
          ...(selected ? { priority: selected.priority, blendSeconds: selected.blendSeconds } : {}),
          ...(evaluation.noTransitionReason ? { noTransitionReason: evaluation.noTransitionReason } : {}),
          error: null,
          rejectedBranchCount: evaluation.rejectedBranches.length,
          omittedRejectedBranchCount: Math.max(0, evaluation.rejectedBranches.length - MAX_REJECTED_BRANCH_DETAILS),
          rejectedBranches: evaluation.rejectedBranches.slice(0, MAX_REJECTED_BRANCH_DETAILS).map(branch => ({ transitionId: branch.transitionId,
            failedGuards: branch.failedGuards.map(guard => ({ parameter: guard.parameter, operator: guard.operator, expected: guard.value, observed: guard.observed })) })),
        };
        if (selected) {
          coveredTransitions.add(selected.id);
          state = selected.to;
          visitedStates.add(state);
        }
        return stepResult;
      } catch (error) {
        return { step: index + 1, stateBefore: state, trigger: step.trigger, parameterValues: proposedValues,
          expected: step.expect, actualTransitionId: null, actualStateAfter: state, matched: false,
          expectationError,
          error: error instanceof Error ? error.message : String(error), rejectedBranchCount: 0, omittedRejectedBranchCount: 0, rejectedBranches: [] };
      }
    });
    return { id: scenario.id, name: scenario.name, status: steps.every(step => step.matched) ? 'passed' as const : 'failed' as const,
      steps, visitedStateIds: graph.states.filter(item => visitedStates.has(item.id)).map(item => item.id),
      coveredTransitionIds: graph.transitions.filter(item => coveredTransitions.has(item.id)).map(item => item.id) };
  });

  const coveredTransitions = new Set(scenarioResults.flatMap(scenario => scenario.coveredTransitionIds));
  const coveredStates = new Set(scenarioResults.flatMap(scenario => scenario.visitedStateIds));
  const graphFingerprint = animationGraphFingerprint(graph);
  const suiteFingerprint = graphScenarioSuiteFingerprint(suite);
  const report = {
    schemaVersion: 1,
    graphFingerprint,
    suiteFingerprint,
    status: scenarioResults.every(scenario => scenario.status === 'passed') ? 'passed' as const : 'failed' as const,
    summary: { scenarios: scenarioResults.length, passed: scenarioResults.filter(scenario => scenario.status === 'passed').length,
      failed: scenarioResults.filter(scenario => scenario.status === 'failed').length,
      steps: scenarioResults.reduce((sum, scenario) => sum + scenario.steps.length, 0),
      coveredStates: coveredStates.size, totalStates: graph.states.length,
      coveredTransitions: coveredTransitions.size, totalTransitions: graph.transitions.length },
    coveredStateIds: graph.states.filter(state => coveredStates.has(state.id)).map(state => state.id),
    uncoveredStateIds: graph.states.filter(state => !coveredStates.has(state.id)).map(state => state.id),
    coveredTransitionIds: graph.transitions.filter(transition => coveredTransitions.has(transition.id)).map(transition => transition.id),
    uncoveredTransitionIds: graph.transitions.filter(transition => !coveredTransitions.has(transition.id)).map(transition => transition.id),
    scenarios: scenarioResults,
    limitation: 'This suite checks typed parameter validation, priority selection, expected transitions and logical state coverage only. It does not advance time, simulate crossfades, prove marker presence, run Roblox gameplay, inspect rendered animation quality, or mutate/save the graph.',
  };
  return { ...report, reportFingerprint: digest(report) };
}
