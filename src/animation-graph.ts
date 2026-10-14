import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './inspection.js';
import { Library } from './library.js';
import { identifier, label } from './recipes.js';
import { previewSequence, sequenceSchema, type ClipSequence } from './sequencer.js';
import { animationGraphBlendSpace1DSchema, sampleAnimationGraphBlendSpace1D } from './animation-graph-blend-space.js';
import { analyzeAnimationGraphBlendSpace2DReachability, animationGraphBlendSpace2DSchema,
  sampleAnimationGraphBlendSpace2D } from './animation-graph-blend-space-2d.js';

const stateId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const graphStateSchema = z.object({ id: stateId, name: label, animationId: identifier, speed: z.number().finite().min(0.1).max(4).default(1),
  blendSpace1D: animationGraphBlendSpace1DSchema.optional().describe('Optional 1D parameter-driven clip blend.'),
  blendSpace2D: animationGraphBlendSpace2DSchema.optional().describe('Optional 2D parameter-driven directional clip blend.') }).strict().superRefine((state, context) => {
    if (state.blendSpace1D && state.blendSpace2D) context.addIssue({ code: 'custom', path: ['blendSpace2D'],
      message: 'A graph state can declare only one blend-space controller.' });
  });
const graphParameterSchema = z.discriminatedUnion('type', [
  z.object({ name: stateId, type: z.literal('boolean'), defaultValue: z.boolean() }).strict(),
  z.object({ name: stateId, type: z.literal('number'), defaultValue: z.number().finite(), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ name: stateId, type: z.literal('string'), defaultValue: z.string().max(256) }).strict(),
]);
const graphGuardSchema = z.object({
  parameter: stateId, operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
  value: z.union([z.boolean(), z.number().finite(), z.string().max(256)]),
}).strict();
const graphTransitionSchema = z.object({
  id: stateId, from: stateId, to: stateId, trigger: label,
  blendSeconds: z.number().finite().min(0).max(5).default(0.15),
  priority: z.number().int().min(-1000).max(1000).default(0),
  guards: z.array(graphGuardSchema).max(8).default([]),
}).strict();

export const animationGraphSchema = z.object({
  kind: z.literal('animation_graph'), name: label, entryState: stateId,
  sampleRate: z.number().int().min(15).max(60).default(30),
  parameters: z.array(graphParameterSchema).max(64).default([]),
  states: z.array(graphStateSchema).min(1).max(64),
  transitions: z.array(graphTransitionSchema).max(128),
}).strict().superRefine((graph, ctx) => {
  const stateIds = graph.states.map(state => state.id);
  if (new Set(stateIds).size !== stateIds.length) ctx.addIssue({ code: 'custom', path: ['states'], message: 'State IDs must be unique.' });
  if (!stateIds.includes(graph.entryState)) ctx.addIssue({ code: 'custom', path: ['entryState'], message: 'entryState must name a declared graph state.' });
  const transitionIds = graph.transitions.map(transition => transition.id);
  if (new Set(transitionIds).size !== transitionIds.length) ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'Transition IDs must be unique.' });
  const parameterNames = graph.parameters.map(parameter => parameter.name);
  if (new Set(parameterNames).size !== parameterNames.length) ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Graph parameter names must be unique.' });
  graph.parameters.forEach((parameter, index) => {
    if (parameter.type === 'number') {
      if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) ctx.addIssue({ code: 'custom', path: ['parameters', index, 'min'], message: 'Numeric parameter min cannot exceed max.' });
      if (parameter.min !== undefined && parameter.defaultValue < parameter.min) ctx.addIssue({ code: 'custom', path: ['parameters', index, 'defaultValue'], message: 'Numeric parameter defaultValue is below min.' });
      if (parameter.max !== undefined && parameter.defaultValue > parameter.max) ctx.addIssue({ code: 'custom', path: ['parameters', index, 'defaultValue'], message: 'Numeric parameter defaultValue is above max.' });
    }
  });
  const parameterByName = new Map(graph.parameters.map(parameter => [parameter.name, parameter]));
  const stateById = new Map(graph.states.map(state => [state.id, state]));
  graph.states.forEach((state, stateIndex) => {
    const blendSpace = state.blendSpace1D ?? state.blendSpace2D;
    if (!blendSpace) return;
    const blendPath = state.blendSpace1D ? 'blendSpace1D' : 'blendSpace2D';
    const blendKind = state.blendSpace1D ? 'BlendSpace1D' : 'BlendSpace2D';
    const blendParameters = state.blendSpace1D ? [state.blendSpace1D.parameter] : [state.blendSpace2D!.xParameter, state.blendSpace2D!.yParameter];
    for (const parameterName of blendParameters) {
      const parameter = parameterByName.get(parameterName);
      if (!parameter) ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'parameter'],
        message: `Unknown ${blendKind} parameter ${parameterName}.` });
      else if (parameter.type !== 'number') ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'parameter'],
        message: `${blendKind} parameter ${parameterName} must be numeric.` });
    }
    const sampleStateIds = blendSpace.samples.map(sample => sample.stateId);
    if (new Set(sampleStateIds).size !== sampleStateIds.length) ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'samples'],
      message: 'Blend-space source states must be unique.' });
    if (!sampleStateIds.includes(state.id)) ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'samples'],
      message: 'A blend-space controller state must include itself as a sample source.' });
    blendSpace.samples.forEach((sample, sampleIndex) => {
      const source = stateById.get(sample.stateId);
      if (!source) ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'samples', sampleIndex, 'stateId'],
        message: `Unknown ${blendKind} source state ${sample.stateId}.` });
      else if (source.id !== state.id && (source.blendSpace1D || source.blendSpace2D)) ctx.addIssue({ code: 'custom', path: ['states', stateIndex, blendPath, 'samples', sampleIndex, 'stateId'],
        message: `A ${blendKind} sample must reference a regular animation state, not another blend-space controller.` });
    });
  });
  const branchPriorities = graph.transitions.map(transition => `${transition.from}\u0000${transition.trigger.toLowerCase()}\u0000${transition.priority}`);
  if (new Set(branchPriorities).size !== branchPriorities.length) ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'Transitions sharing a source and trigger need distinct priorities.' });
  graph.transitions.forEach((transition, index) => {
    if (!stateIds.includes(transition.from)) ctx.addIssue({ code: 'custom', path: ['transitions', index, 'from'], message: `Unknown source state ${transition.from}.` });
    if (!stateIds.includes(transition.to)) ctx.addIssue({ code: 'custom', path: ['transitions', index, 'to'], message: `Unknown destination state ${transition.to}.` });
    transition.guards.forEach((guard, guardIndex) => {
      const parameter = parameterByName.get(guard.parameter);
      if (!parameter) {
        ctx.addIssue({ code: 'custom', path: ['transitions', index, 'guards', guardIndex, 'parameter'], message: `Unknown graph parameter ${guard.parameter}.` });
        return;
      }
      const validValueType = parameter.type === 'number' ? typeof guard.value === 'number'
        : parameter.type === 'boolean' ? typeof guard.value === 'boolean' : typeof guard.value === 'string';
      if (!validValueType) ctx.addIssue({ code: 'custom', path: ['transitions', index, 'guards', guardIndex, 'value'], message: `Guard value type does not match ${parameter.type} parameter ${parameter.name}.` });
      if (guard.operator !== 'eq' && guard.operator !== 'neq' && parameter.type !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['transitions', index, 'guards', guardIndex, 'operator'], message: 'Ordering operators are supported only for numeric graph parameters.' });
      }
    });
  });
});

export type AnimationGraph = z.infer<typeof animationGraphSchema>;

type GraphGuard = AnimationGraph['transitions'][number]['guards'][number];
type GuardReachability = { transitionId: string; status: 'reachable' | 'unreachable' | 'unknown';
  witness?: Record<string, boolean | number | string>; reason: string; exploredNodes: number;
  localStatus?: 'reachable' | 'unreachable' | 'unknown'; locallyReachable?: boolean; entryReachable?: boolean };
const MAX_GUARD_ANALYSIS_NODES = 100_000;

function guardMatchesValue(guard: GraphGuard, value: boolean | number | string): boolean {
  switch (guard.operator) {
    case 'eq': return value === guard.value;
    case 'neq': return value !== guard.value;
    case 'gt': return typeof value === 'number' && typeof guard.value === 'number' && value > guard.value;
    case 'gte': return typeof value === 'number' && typeof guard.value === 'number' && value >= guard.value;
    case 'lt': return typeof value === 'number' && typeof guard.value === 'number' && value < guard.value;
    case 'lte': return typeof value === 'number' && typeof guard.value === 'number' && value <= guard.value;
  }
}

function adjacentFloat(value: number, direction: -1 | 1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + BigInt((value > 0 ? direction : -direction)));
  return view.getFloat64(0);
}

function guardValueDomains(graph: AnimationGraph, guards: GraphGuard[]) {
  const parameters = new Map(graph.parameters.map(parameter => [parameter.name, parameter]));
  const domains = new Map<string, (boolean | number | string)[]>();
  for (const guard of guards) {
    const values = domains.get(guard.parameter) ?? [];
    const parameter = parameters.get(guard.parameter)!;
    const withinDomain = (value: boolean | number | string) => parameter.type !== 'number' || typeof value !== 'number'
      || ((parameter.min === undefined || value >= parameter.min) && (parameter.max === undefined || value <= parameter.max));
    if (withinDomain(guard.value) && !values.includes(guard.value)) values.push(guard.value);
    if (typeof guard.value === 'number') for (const direction of [-1, 1] as const) {
      const neighbor = adjacentFloat(guard.value, direction);
      if (withinDomain(neighbor) && Number.isFinite(neighbor) && !values.includes(neighbor)) values.push(neighbor);
    }
    domains.set(guard.parameter, values);
  }
  for (const [name, values] of domains) {
    const parameter = parameters.get(name)!;
    if (parameter.type === 'boolean') {
      if (!values.includes(false)) values.push(false);
      if (!values.includes(true)) values.push(true);
    } else if (parameter.type === 'string') {
      let other = '__motion_guard_other__';
      while (values.includes(other)) other += '_';
      values.push(other);
    } else {
      const numeric = values.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
      const add = (value: number) => {
        if (Number.isFinite(value) && (parameter.min === undefined || value >= parameter.min)
          && (parameter.max === undefined || value <= parameter.max) && !values.includes(value)) values.push(value);
      };
      add(parameter.defaultValue);
      if (parameter.min !== undefined) add(parameter.min);
      if (parameter.max !== undefined) add(parameter.max);
      for (let index = 1; index < numeric.length; index++) {
        const left = numeric[index - 1]!;
        const right = numeric[index]!;
        const midpoint = left + (right - left) / 2;
        if (midpoint > left && midpoint < right) add(midpoint);
      }
      if (parameter.min === undefined && numeric.length) add(adjacentFloat(numeric[0]!, -1));
      if (parameter.max === undefined && numeric.length) add(adjacentFloat(numeric.at(-1)!, 1));
    }
  }
  return domains;
}

/** Analyzes typed branch guards over exact comparison truth partitions with a bounded search. */
function analyzeGuardReachability(graph: AnimationGraph) {
  const groups = new Map<string, AnimationGraph['transitions']>();
  for (const transition of graph.transitions) {
    const key = `${transition.from}\u0000${transition.trigger.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(transition);
    groups.set(key, group);
  }
  const results: GuardReachability[] = [];
  let remainingBudget = MAX_GUARD_ANALYSIS_NODES;
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => right.priority - left.priority);
    const initial = guardValueDomains(graph, ordered.flatMap(transition => transition.guards));
    for (const [index, transition] of ordered.entries()) {
      let exploredNodes = 0;
      let exhausted = false;
      const domains = new Map([...initial].map(([name, values]) => [name, [...values]]));
      for (const guard of transition.guards) domains.set(guard.parameter,
        (domains.get(guard.parameter) ?? []).filter(value => guardMatchesValue(guard, value)));
      if ([...domains.values()].some(values => values.length === 0)) {
        results.push({ transitionId: transition.id, status: 'unreachable', reason: 'Its own guard conjunction is contradictory or outside the parameter domain.', exploredNodes });
        continue;
      }
      const search = (branchIndex: number, current: Map<string, (boolean | number | string)[]>): Record<string, boolean | number | string> | null => {
        exploredNodes++;
        if (--remainingBudget < 0) { exhausted = true; return null; }
        if (branchIndex === index) return Object.fromEntries([...current].map(([name, values]) => {
          const parameter = graph.parameters.find(candidate => candidate.name === name)!;
          return [name, values.includes(parameter.defaultValue) ? parameter.defaultValue : values[0]!];
        }));
        const blocker = ordered[branchIndex]!;
        if (blocker.guards.length === 0) return null;
        const alreadyFalse = blocker.guards.some(guard => (current.get(guard.parameter) ?? []).every(value => !guardMatchesValue(guard, value)));
        if (alreadyFalse) return search(branchIndex + 1, current);
        const choices = blocker.guards.flatMap(guard => {
          const values = current.get(guard.parameter) ?? [];
          const failing = values.filter(value => !guardMatchesValue(guard, value));
          return failing.length ? [{ name: guard.parameter, failing }] : [];
        });
        for (const choice of choices) {
          const narrowed = new Map(current);
          narrowed.set(choice.name, choice.failing);
          const witness = search(branchIndex + 1, narrowed);
          if (witness) return witness;
          if (exhausted) return null;
        }
        return null;
      };
      const witness = search(0, domains);
      if (witness) results.push({ transitionId: transition.id, status: 'reachable', witness,
        reason: 'A concrete typed parameter assignment selects this branch after all higher-priority routes are checked.', exploredNodes });
      else if (exhausted) results.push({ transitionId: transition.id, status: 'unknown',
        reason: 'The bounded graph-wide search budget was exhausted; reachability is not inferred.', exploredNodes });
      else results.push({ transitionId: transition.id, status: 'unreachable',
        reason: index === 0 ? 'Its own guard conjunction has no satisfying parameter assignment.' : 'Every satisfying assignment is selected by a higher-priority transition.', exploredNodes });
    }
  }
  return { results, exhausted: remainingBudget < 0 };
}

function buildGraphExecutionCoverage(graph: AnimationGraph, localResults: GuardReachability[]) {
  const resultById = new Map(localResults.map(result => [result.transitionId, result]));
  const transitionsFrom = new Map(graph.states.map(state => [state.id, graph.transitions.filter(transition => transition.from === state.id)]));
  const pathByState = new Map<string, string[]>([[graph.entryState, []]]);
  const pending = [graph.entryState];
  while (pending.length) {
    const stateId = pending.shift()!;
    for (const transition of transitionsFrom.get(stateId) ?? []) {
      if (resultById.get(transition.id)?.status !== 'reachable' || pathByState.has(transition.to)) continue;
      pathByState.set(transition.to, [...pathByState.get(stateId)!, transition.id]);
      pending.push(transition.to);
    }
  }
  const transitionById = new Map(graph.transitions.map(transition => [transition.id, transition]));
  const scenarios = [] as { targetTransitionId: string; transitionPath: string[]; statePath: string[];
    steps: { step: number; fromState: string; trigger: string; parameterValues: Record<string, boolean | number | string>;
      expectedTransitionId: string; toState: string; blendSeconds: number; triggerSource: 'animation_end' | 'gameplay_or_marker' }[] }[];
  const routes = localResults.map(result => {
    const transition = transitionById.get(result.transitionId)!;
    const sourcePath = pathByState.get(transition.from);
    if (result.status !== 'reachable') return { ...result, localStatus: result.status, locallyReachable: false, entryReachable: false };
    if (!sourcePath) return { ...result, status: 'unreachable' as const, locallyReachable: true, entryReachable: false,
      localStatus: 'reachable' as const, reason: `The branch is locally selectable, but source state ${transition.from} has no feasible trigger path from entry state ${graph.entryState}.` };
    const transitionPath = [...sourcePath, transition.id];
    const statePath = [graph.entryState];
    const steps = transitionPath.map((transitionId, index) => {
      const stepTransition = transitionById.get(transitionId)!;
      statePath.push(stepTransition.to);
      const stepResult = resultById.get(transitionId)!;
      return { step: index + 1, fromState: stepTransition.from, trigger: stepTransition.trigger,
        parameterValues: stepResult.witness ?? {}, expectedTransitionId: transitionId, toState: stepTransition.to,
        blendSeconds: stepTransition.blendSeconds,
        triggerSource: stepTransition.trigger.toLowerCase() === 'animationended' ? 'animation_end' as const : 'gameplay_or_marker' as const };
    });
    scenarios.push({ targetTransitionId: transition.id, transitionPath, statePath, steps });
    return { ...result, localStatus: 'reachable' as const, locallyReachable: true, entryReachable: true };
  });
  const feasibleStates = [...pathByState.keys()];
  return { routes, scenarios, entryReachableStateIds: feasibleStates,
    entryUnreachableStateIds: graph.states.filter(state => !pathByState.has(state.id)).map(state => state.id),
    coverage: { reachableTransitions: routes.filter(route => route.entryReachable).length,
      locallyReachableTransitions: routes.filter(route => route.locallyReachable).length,
      unreachableTransitions: routes.filter(route => route.status === 'unreachable').length,
      unknownTransitions: routes.filter(route => route.status === 'unknown').length,
      scenarios: scenarios.length },
    limitation: 'Each scenario is a shortest logical trigger trace from the entry state and sets a witness before each branch. It does not model wall-clock timing, cooldowns, interruption policy, marker availability in published assets, automatic one-shot completion timing, or game-specific trigger authority.' };
}

const graphRecordSchema = z.object({
  id: identifier, createdAt: z.string().datetime(), parentId: identifier.optional(),
  sourceFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(64), graph: animationGraphSchema,
}).strict();
export type SavedAnimationGraph = z.infer<typeof graphRecordSchema>;

function hashGraphPath(input: unknown) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
export function animationGraphFingerprint(input: unknown) {
  return hashGraphPath(animationGraphSchema.parse(input));
}
export function graphPathAssetId(candidateFingerprint: string) {
  const bytes = Buffer.from(candidateFingerprint.slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return identifier.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

export function diagnoseAnimationGraph(graphInput: unknown) {
  const graph = animationGraphSchema.parse(graphInput);
  const guardAnalysis = analyzeGuardReachability(graph);
  const executionCoverage = buildGraphExecutionCoverage(graph, guardAnalysis.results);
  const byId = new Map(graph.states.map(state => [state.id, state]));
  const parameterByName = new Map(graph.parameters.map(parameter => [parameter.name, parameter]));
  const adjacency = new Map(graph.states.map(state => [state.id, [] as string[]]));
  for (const transition of graph.transitions) adjacency.get(transition.from)!.push(transition.to);
  const reachable = new Set<string>([graph.entryState]);
  const pending = [graph.entryState];
  while (pending.length) for (const target of adjacency.get(pending.shift()!) ?? []) if (!reachable.has(target)) {
    reachable.add(target);
    pending.push(target);
  }
  return {
    stateCount: graph.states.length,
    transitionCount: graph.transitions.length,
    reachableStateIds: graph.states.filter(state => reachable.has(state.id)).map(state => state.id),
    unreachableStateIds: graph.states.filter(state => !reachable.has(state.id)).map(state => state.id),
    terminalStateIds: graph.states.filter(state => (adjacency.get(state.id)?.length ?? 0) === 0).map(state => state.id),
    isolatedStateIds: graph.states.filter(state => !reachable.has(state.id) && (adjacency.get(state.id)?.length ?? 0) === 0).map(state => state.id),
    transitionBranches: [...new Map(graph.transitions.map(transition => [
      `${transition.from}\u0000${transition.trigger.toLowerCase()}`,
      { from: transition.from, trigger: transition.trigger },
    ])).entries()].map(([key, display]) => {
      const [fromKey, triggerKey] = key.split('\u0000');
      const branches = graph.transitions.filter(transition => transition.from === fromKey
        && transition.trigger.toLowerCase() === triggerKey).sort((a, b) => b.priority - a.priority);
      let unconditionalBranchSeen = false;
      const diagnosedBranches = branches.map(transition => {
        const shadowedByUnconditional = unconditionalBranchSeen;
        if (transition.guards.length === 0) unconditionalBranchSeen = true;
        return { id: transition.id, to: transition.to, priority: transition.priority,
          guardCount: transition.guards.length, shadowedByUnconditional };
      });
      return { from: display.from, trigger: display.trigger, branches: diagnosedBranches,
        hasUnconditionalFallback: branches.some(transition => transition.guards.length === 0),
        unreachableTransitionIds: diagnosedBranches.filter(branch => branch.shadowedByUnconditional).map(branch => branch.id) };
    }),
    guardReachability: executionCoverage.routes,
    triggerScenarios: executionCoverage.scenarios,
    triggerCoverage: { ...executionCoverage.coverage, entryReachableStateIds: executionCoverage.entryReachableStateIds,
      entryUnreachableStateIds: executionCoverage.entryUnreachableStateIds, limitation: executionCoverage.limitation },
    guardAnalysisBudget: { maxSearchNodes: MAX_GUARD_ANALYSIS_NODES, exhausted: guardAnalysis.exhausted,
      limitation: 'Typed guards are analyzed over exact comparison truth partitions with a bounded graph-wide search. Unknown means the search budget ran out; it must not be treated as unreachable.' },
    blendSpaceDiagnostics: [...graph.states.flatMap(state => {
      const blendSpace = state.blendSpace1D;
      if (!blendSpace) return [];
      const parameter = parameterByName.get(blendSpace.parameter);
      if (!parameter || parameter.type !== 'number') return [];
      const firstValue = blendSpace.samples[0]!.value;
      const lastValue = blendSpace.samples.at(-1)!.value;
      const minimum = parameter.min ?? firstValue;
      const maximum = parameter.max ?? lastValue;
      const candidates = [...new Set([minimum, maximum,
        ...blendSpace.samples.map(sample => sample.value).filter(value => value >= minimum && value <= maximum)])];
      const weightsByState = new Map(blendSpace.samples.map(sample => [sample.stateId, { maximumWeight: 0, witnessParameterValues: [] as number[] }]));
      for (const value of candidates) {
        for (const sample of sampleAnimationGraphBlendSpace1D(blendSpace, value).weights) {
          const evidence = weightsByState.get(sample.stateId)!;
          evidence.maximumWeight = Math.max(evidence.maximumWeight, sample.weight);
          if (sample.weight > 0) evidence.witnessParameterValues.push(value);
        }
      }
      const sources = blendSpace.samples.map(sample => {
        const evidence = weightsByState.get(sample.stateId)!;
        const sourceState = byId.get(sample.stateId);
        return { stateId: sample.stateId, sampleValue: sample.value, reachable: evidence.maximumWeight > 0,
          authoredStateSpeed: sourceState?.speed ?? null, speedAuthority: 'blend_controller' as const,
          maximumReachableWeight: evidence.maximumWeight, witnessParameterValues: [...new Set(evidence.witnessParameterValues)] };
      });
      return [{ stateId: state.id, parameter: blendSpace.parameter,
        parameterRange: { min: parameter.min ?? null, max: parameter.max ?? null },
        reachableSourceStateIds: sources.filter(source => source.reachable).map(source => source.stateId),
        unreachableSourceStateIds: sources.filter(source => !source.reachable).map(source => source.stateId), sources,
        limitation: 'Reachability is computed from the declared numeric parameter range and the authored adjacent-linear BlendSpace curve. An unbounded parameter side uses the outer sample value as a representative boundary; this detects whether a source can contribute, not whether game code ever assigns a witnessing value.' }];
    }), ...graph.states.flatMap(state => {
      const blendSpace = state.blendSpace2D;
      if (!blendSpace) return [];
      const xParameter = parameterByName.get(blendSpace.xParameter);
      const yParameter = parameterByName.get(blendSpace.yParameter);
      if (xParameter?.type !== 'number' || yParameter?.type !== 'number') return [];
      const xCoordinates = blendSpace.samples.map(sample => sample.x);
      const yCoordinates = blendSpace.samples.map(sample => sample.y);
      const effectiveRange = {
        x: { min: xParameter.min ?? Math.min(...xCoordinates), max: xParameter.max ?? Math.max(...xCoordinates) },
        y: { min: yParameter.min ?? Math.min(...yCoordinates), max: yParameter.max ?? Math.max(...yCoordinates) },
      };
      const reachability = analyzeAnimationGraphBlendSpace2DReachability(blendSpace, effectiveRange);
      const evidenceByState = new Map(reachability.map(source => [source.stateId, source]));
      const sources = blendSpace.samples.map(sample => {
        const evidence = evidenceByState.get(sample.stateId)!;
        return { stateId: sample.stateId, samplePosition: { x: sample.x, y: sample.y }, reachable: evidence.reachable,
          authoredStateSpeed: byId.get(sample.stateId)?.speed ?? null, speedAuthority: 'blend_controller' as const,
          maximumReachableWeight: evidence.maximumReachableWeight,
          witnessParameterValues: evidence.witnessParameterValues ? [evidence.witnessParameterValues] : [] };
      });
      return [{ stateId: state.id, parameters: { x: blendSpace.xParameter, y: blendSpace.yParameter },
        parameterRanges: { x: { min: xParameter.min ?? null, max: xParameter.max ?? null }, y: { min: yParameter.min ?? null, max: yParameter.max ?? null } },
        reachableSourceStateIds: sources.filter(source => source.reachable).map(source => source.stateId),
        unreachableSourceStateIds: sources.filter(source => !source.reachable).map(source => source.stateId), sources,
        analysis: 'continuous_piecewise_linear_maximum',
        analysisCoverage: xParameter.min !== undefined && xParameter.max !== undefined
          && yParameter.min !== undefined && yParameter.max !== undefined
          ? 'complete_declared_rectangle' as const : 'authored_extent_for_unbounded_axes' as const,
        effectiveParameterRanges: effectiveRange,
        limitation: 'Maximum weights and witnesses are optimized over the effective finite rectangle using the exact authored triangle interpolation and nearest-hull-edge projection regions. An axis without declared min/max uses its authored sample extent as a representative bound; exact reachability over that unbounded axis is not claimed. This does not prove gameplay code ever assigns a witnessing value.' }];
    })],
    parameterNames: graph.parameters.map(parameter => parameter.name),
    limitation: 'Reachability and branch diagnostics are structural checks only. The separate runtime-export tool generates playback code from a saved, current graph after published asset IDs are supplied; it does not publish assets or establish whether the game integration matches intended gameplay.',
    declaredStates: [...byId.keys()],
  };
}

export function normalizeAnimationGraphParameters(graphInput: unknown, valuesInput: unknown = {}) {
  const graph = animationGraphSchema.parse(graphInput);
  const supplied = z.record(stateId, z.union([z.boolean(), z.number().finite(), z.string().max(256)])).parse(valuesInput);
  const declared = new Map(graph.parameters.map(parameter => [parameter.name, parameter]));
  for (const name of Object.keys(supplied)) if (!declared.has(name)) throw new Error(`Unknown graph parameter value ${name}.`);
  const values: Record<string, boolean | number | string> = {};
  for (const parameter of graph.parameters) {
    const value = supplied[parameter.name] ?? parameter.defaultValue;
    const typeMatches = parameter.type === 'number' ? typeof value === 'number'
      : parameter.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string';
    if (!typeMatches) throw new Error(`Runtime value for parameter ${parameter.name} must be ${parameter.type}.`);
    if (parameter.type === 'number') {
      if (typeof value !== 'number') throw new Error(`Runtime value for parameter ${parameter.name} must be number.`);
      if ((parameter.min !== undefined && value < parameter.min) || (parameter.max !== undefined && value > parameter.max)) {
        throw new Error(`Runtime value for parameter ${parameter.name} is outside its declared range.`);
      }
    }
    values[parameter.name] = value;
  }
  return values;
}

export function evaluateAnimationGraphTransition(graphInput: unknown, currentStateInput: unknown, triggerInput: unknown, valuesInput: unknown = {}) {
  const graph = animationGraphSchema.parse(graphInput);
  const currentState = stateId.parse(currentStateInput);
  const trigger = label.parse(triggerInput);
  if (!graph.states.some(state => state.id === currentState)) throw new Error(`Unknown current graph state ${currentState}.`);
  const values = normalizeAnimationGraphParameters(graph, valuesInput);
  const candidates = graph.transitions.filter(transition => transition.from === currentState && transition.trigger.toLowerCase() === trigger.toLowerCase())
    .sort((left, right) => right.priority - left.priority);
  const evaluated = candidates.map(transition => {
    const checks = transition.guards.map(guard => {
      const observed = values[guard.parameter]!;
      let matched: boolean;
      switch (guard.operator) {
        case 'eq': matched = observed === guard.value; break;
        case 'neq': matched = observed !== guard.value; break;
        case 'gt': matched = typeof observed === 'number' && typeof guard.value === 'number' && observed > guard.value; break;
        case 'gte': matched = typeof observed === 'number' && typeof guard.value === 'number' && observed >= guard.value; break;
        case 'lt': matched = typeof observed === 'number' && typeof guard.value === 'number' && observed < guard.value; break;
        case 'lte': matched = typeof observed === 'number' && typeof guard.value === 'number' && observed <= guard.value; break;
      }
      return { ...guard, observed, matched };
    });
    return { transition, checks, matched: checks.every(check => check.matched) };
  });
  const selected = evaluated.find(result => result.matched);
  return {
    currentState, trigger, parameterValues: values,
    selectedTransition: selected ? { id: selected.transition.id, from: selected.transition.from, to: selected.transition.to,
      priority: selected.transition.priority, blendSeconds: selected.transition.blendSeconds,
      selectionReason: 'highest-priority branch whose guards all matched', checks: selected.checks } : null,
    matchedTransitionIds: evaluated.filter(result => result.matched).map(result => result.transition.id),
    shadowedTransitionIds: selected ? evaluated.filter(result => result.matched && result.transition.id !== selected.transition.id).map(result => result.transition.id) : [],
    rejectedBranches: evaluated.filter(result => !result.matched).map(result => ({ transitionId: result.transition.id,
      failedGuards: result.checks.filter(check => !check.matched) })),
    noTransitionMatched: !selected,
    noTransitionReason: selected ? null : candidates.length === 0 ? 'no_transition_for_state_and_trigger' : 'all_candidate_guards_failed',
    limitation: 'This deterministic evaluator tests graph guard logic only. It does not advance time, play Roblox animations, handle interruptions, or integrate with a Humanoid/Animator.' ,
  };
}

async function loadGraphSources(graph: AnimationGraph, animations: Library) {
  const assets = await Promise.all(graph.states.map(state => animations.get(state.animationId)));
  for (const [index, asset] of assets.entries()) {
    if (asset.recipe.kind !== 'animation') throw new Error(`Graph state ${graph.states[index]!.id} must reference an animation asset.`);
  }
  return assets;
}

export async function previewAnimationGraph(graphInput: unknown, animations: Library) {
  const graph = animationGraphSchema.parse(graphInput);
  const assets = await loadGraphSources(graph, animations);
  return { graph, graphFingerprint: hashGraphPath(graph), sourceFingerprints: assets.map(asset => fingerprint(asset.recipe)),
    diagnostics: diagnoseAnimationGraph(graph) };
}

export function graphPathSequence(graphInput: unknown, transitionIdsInput: unknown, assets: Awaited<ReturnType<Library['get']>>[]): ClipSequence {
  const graph = animationGraphSchema.parse(graphInput);
  const transitionIds = z.array(stateId).min(0).max(31).parse(transitionIdsInput);
  if (transitionIds.length > 31) throw new Error('A graph path may contain at most 32 states.');
  if (assets.length !== graph.states.length) throw new Error('Animation source asset count does not match the graph state count.');
  const statesById = new Map(graph.states.map((state, index) => [state.id, { state, asset: assets[index]! }]));
  const transitionsById = new Map(graph.transitions.map(transition => [transition.id, transition]));
  const pathStateIds = [graph.entryState];
  for (const transitionId of transitionIds) {
    const transition = transitionsById.get(transitionId);
    if (!transition) throw new Error(`Unknown transition ${transitionId}.`);
    if (transition.from !== pathStateIds.at(-1)) throw new Error(`Transition ${transitionId} starts at ${transition.from}, not the current path state ${pathStateIds.at(-1)}.`);
    pathStateIds.push(transition.to);
  }

  const clips: ClipSequence['clips'] = [];
  let start = 0;
  for (let index = 0; index < pathStateIds.length; index++) {
    const entry = statesById.get(pathStateIds[index]!);
    if (!entry || entry.asset.recipe.kind !== 'animation') throw new Error(`Graph state ${pathStateIds[index]} is missing a valid animation source.`);
    const sourceDuration = entry.asset.recipe.duration;
    const duration = sourceDuration / entry.state.speed;
    const incoming = index > 0 ? transitionsById.get(transitionIds[index - 1]!)! : undefined;
    const outgoing = index < transitionIds.length ? transitionsById.get(transitionIds[index]!)! : undefined;
    if (incoming && incoming.blendSeconds > duration) throw new Error(`Transition ${incoming.id} blend exceeds destination state ${entry.state.id}'s playback duration.`);
    if (outgoing) {
      const destination = statesById.get(outgoing.to);
      if (!destination || destination.asset.recipe.kind !== 'animation') throw new Error(`Transition ${outgoing.id} has no valid destination animation.`);
      if (outgoing.blendSeconds > duration || outgoing.blendSeconds > destination.asset.recipe.duration / destination.state.speed) {
        throw new Error(`Transition ${outgoing.id} blend exceeds one of its adjacent state playback durations.`);
      }
    }
    if (index > 0) start -= incoming!.blendSeconds;
    clips.push({ animationId: entry.state.animationId, start, sourceStart: 0, sourceEnd: sourceDuration, speed: entry.state.speed,
      fadeIn: incoming?.blendSeconds ?? 0, fadeOut: outgoing?.blendSeconds ?? 0 });
    start += duration;
  }
  return sequenceSchema.parse({ kind: 'sequence', name: `${graph.name} Path`, sampleRate: graph.sampleRate, loop: false, clips });
}

export class AnimationGraphLibrary {
  constructor(readonly directory: string, readonly animations: Library) {}

  async save(graphInput: unknown, parentId?: string): Promise<SavedAnimationGraph> {
    const graph = animationGraphSchema.parse(graphInput);
    if (parentId) {
      const parent = await this.load(parentId);
      if (parent.graph.kind !== graph.kind) throw new Error('An animation-graph revision must retain its asset kind.');
    }
    const assets = await loadGraphSources(graph, this.animations);
    const record = graphRecordSchema.parse({ id: randomUUID(), createdAt: new Date().toISOString(), ...(parentId ? { parentId } : {}),
      sourceFingerprints: assets.map(asset => fingerprint(asset.recipe)), graph });
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${record.id}.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
    return record;
  }

  private async load(id: string) {
    identifier.parse(id);
    const record = graphRecordSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
    if (record.id !== id) throw new Error('Animation-graph identity mismatch.');
    return record;
  }

  private async integrity(record: SavedAnimationGraph) {
    try {
      const assets = await loadGraphSources(record.graph, this.animations);
      const current = assets.map(asset => fingerprint(asset.recipe));
      if (record.sourceFingerprints.length !== current.length) return { status: 'stale' as const, issue: 'Stored source fingerprint count does not match graph states.' };
      const changedStateIds = current.flatMap((value, index) => value === record.sourceFingerprints[index] ? [] : [record.graph.states[index]!.id]);
      return changedStateIds.length ? { status: 'stale' as const, issue: `Source animation changed for graph states: ${changedStateIds.join(', ')}.`, changedStateIds }
        : { status: 'verified' as const, changedStateIds: [] as string[] };
    } catch (error) {
      return { status: 'stale' as const, issue: error instanceof Error ? error.message : 'An animation source is unavailable.' };
    }
  }

  async get(id: string) {
    const record = await this.load(id);
    const integrity = await this.integrity(record);
    if (integrity.status === 'stale') throw new Error(`Animation graph ${id} has stale source assets. ${integrity.issue} Create a child graph revision to explicitly adopt changed animation content.`);
    return { ...record, diagnostics: diagnoseAnimationGraph(record.graph), graphFingerprint: hashGraphPath(record.graph) };
  }

  async list(offset = 0, limit = 30) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Graph pagination requires offset ≥ 0 and limit 1–100.');
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(file => /^[0-9a-f-]{36}\.json$/.test(file));
    const records = await Promise.all(files.map(file => this.load(file.slice(0, -5))));
    const results = await Promise.all(records.map(async record => {
      const integrity = await this.integrity(record);
      return { id: record.id, parentId: record.parentId, createdAt: record.createdAt, name: record.graph.name,
        sourceIntegrity: integrity.status,
        ...(integrity.status === 'stale' ? { sourceIntegrityIssue: integrity.issue } : {}), ...diagnoseAnimationGraph(record.graph) };
    }));
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { total: results.length, offset, graphs: results.slice(offset, offset + limit), nextOffset: offset + limit < results.length ? offset + limit : null };
  }

  async previewPath(id: string, transitionIds: unknown) {
    const record = await this.get(id);
    const assets = await loadGraphSources(record.graph, this.animations);
    const sequence = graphPathSequence(record.graph, transitionIds, assets);
    const preview = await previewSequence(sequence, this.animations);
    const routeTransitions = z.array(stateId).parse(transitionIds).map(transitionId => record.graph.transitions.find(transition => transition.id === transitionId)!);
    const statePath = [record.graph.entryState, ...routeTransitions.map(transition => transition.to)];
    return { graphId: record.id, graphFingerprint: record.graphFingerprint, graphDiagnostics: record.diagnostics,
      statePath, transitions: routeTransitions, sequence, sequencePreview: preview, sourceFingerprints: record.sourceFingerprints,
      candidateFingerprint: hashGraphPath({ graphId: record.id, graphFingerprint: record.graphFingerprint, statePath, transitions: routeTransitions,
        sourceFingerprints: record.sourceFingerprints, animationFingerprint: fingerprint(preview.animation) }),
      limitation: 'This is a deterministic offline composition of the requested route, not a Roblox runtime state machine. It does not publish animations, evaluate gameplay conditions, or certify transition appearance.' };
  }
}
