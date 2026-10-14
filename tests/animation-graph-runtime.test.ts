import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sampleAnimationGraphBlendSpace1D } from '../src/animation-graph-blend-space.js';
import { sampleAnimationGraphBlendSpace2D } from '../src/animation-graph-blend-space-2d.js';
import { generateAnimationGraphRuntime } from '../src/animation-graph-runtime.js';
import { simulateAnimationGraphTimeline } from '../src/animation-graph-simulation.js';
import { animationPreset } from '../src/recipes.js';

const graph = {
  kind: 'animation_graph' as const,
  name: 'Runtime test',
  entryState: 'idle',
  sampleRate: 30,
  parameters: [
    { name: 'stamina', type: 'number' as const, defaultValue: 0.5, min: 0, max: 1 },
    { name: 'grounded', type: 'boolean' as const, defaultValue: true },
    { name: 'weapon', type: 'string' as const, defaultValue: 'sword' },
  ],
  states: [
    { id: 'idle', name: 'Idle', animationId: '00000000-0000-4000-8000-000000000001', speed: 1 },
    { id: 'strike', name: 'Strike', animationId: '00000000-0000-4000-8000-000000000002', speed: 1.25 },
  ],
  transitions: [
    { id: 'heavy', from: 'idle', to: 'strike', trigger: 'Attack', priority: 10, blendSeconds: 0.2, guards: [
      { parameter: 'stamina', operator: 'gte' as const, value: 0.7 }, { parameter: 'grounded', operator: 'eq' as const, value: true },
    ] },
    { id: 'light', from: 'idle', to: 'strike', trigger: 'attack', priority: 0, blendSeconds: 0.1, guards: [] },
    { id: 'release', from: 'strike', to: 'idle', trigger: 'Release', priority: 0, blendSeconds: 0.05, guards: [] },
    { id: 'recover', from: 'strike', to: 'idle', trigger: 'AnimationEnded', priority: 0, blendSeconds: 0.15, guards: [] },
  ],
};
const metadata = [animationPreset('idle', 'Looped idle', 1.5, 0.4), animationPreset('slash', 'One-shot strike', 0.8, 0.7)]
  .map(({ duration, loop, priority, markers }) => ({ duration, loop, ...(priority ? { priority } : {}), markers }));

test('runtime export produces a deterministic Luau controller with asset, state, guard and crossfade data', () => {
  const exported = generateAnimationGraphRuntime(graph, metadata, { idle: '12345', strike: 'rbxassetid://98765' });
  assert.equal(exported.stateCount, 2);
  assert.equal(exported.transitionCount, 4);
  assert.match(exported.controllerFingerprint, /^[a-f0-9]{64}$/);
  assert.match(exported.moduleSource, /\["animationId"\] = "rbxassetid:\/\/12345"/);
  assert.match(exported.moduleSource, /\["animationId"\] = "rbxassetid:\/\/98765"/);
  assert.match(exported.moduleSource, /\["looped"\] = true/);
  assert.match(exported.moduleSource, /\["looped"\] = false/);
  assert.match(exported.moduleSource, /\["priority"\] = "Core"/);
  assert.match(exported.moduleSource, /function Controller:SetParameters\(values\)/);
  assert.match(exported.moduleSource, /function Controller:SetPlaybackSpeed\(multiplier\)/);
  assert.match(exported.moduleSource, /function Binding:SetPlaybackSpeed\(multiplier\)/);
  assert.match(exported.moduleSource, /function Controller:Trigger\(triggerName\)/);
  assert.match(exported.moduleSource, /function Controller:ConnectMarker\(markerName, callback\)/);
  assert.match(exported.moduleSource, /function Controller.BindToPlayer\(player, onController, options\)/);
  assert.match(exported.moduleSource, /function Controller:EvaluateTrigger\(triggerName\)/);
  assert.match(exported.moduleSource, /function Controller:GetAvailableTriggers\(\)/);
  assert.match(exported.moduleSource, /function Binding:EvaluateTrigger\(triggerName\)/);
  assert.match(exported.moduleSource, /function Binding:GetAvailableTriggers\(\)/);
  assert.match(exported.moduleSource, /function Controller:TriggerWithParameters\(triggerName, updates, expectedTransitionId\)/);
  assert.match(exported.moduleSource, /GetMarkerReachedSignal\(markerName\)/);
  assert.match(exported.moduleSource, /table.sort\(candidates/);
  assert.match(exported.moduleSource, /track:Play\(fadeSeconds, spec\.weight, spec\.speed\)/);
  assert.match(exported.moduleSource, /Roblox controls how Play affects an already-playing track/);
  assert.doesNotMatch(exported.moduleSource, /previousTrack:Stop\(0\)/,
    'runtime cleanup and self-transition restarts must not use zero-fade Stop, which can freeze Motor6D joints');
  assert.match(exported.moduleSource, /previousTrack:Stop\(math\.max\(fadeRemaining, 1 \/ 60\)\)/,
    'a partially restarted blend channel must be rolled back using a nonzero fade');
  assert.match(exported.moduleSource, /track\.Ended:Connect/);
  assert.match(exported.moduleSource, /function Controller:Preload\(stateIds\)/);
  assert.match(exported.moduleSource, /function Controller:GetLoadedStateIds\(\)/);
  assert.match(exported.moduleSource, /options\.preloadAll/);
  assert.equal(exported.contract.methods.includes('Preload(stateIds?)'), true);
  assert.equal(exported.contract.methods.includes('GetBlendState()'), true);
  assert.equal(exported.contract.methods.includes('SynchronizeBlendPlayback()'), true);
  assert.match(exported.moduleSource, /function Controller:GetBlendState\(\)/);
  assert.match(exported.moduleSource, /simulationTimingCalibration/);
  assert.match(exported.assetSetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(exported.moduleSource, /function Controller:SynchronizeBlendPlayback\(\)/);
  assert.equal(exported.contract.constructor, 'Controller.new(animator, options?)');
  assert.equal(exported.contract.automaticTrigger.includes('AnimationEnded'), true);
  assert.equal(exported.controllerFingerprint,
    generateAnimationGraphRuntime(graph, metadata, { strike: '98765', idle: 'rbxassetid://12345' }).controllerFingerprint,
    'equivalent normalized asset IDs and map ordering must produce stable fingerprints');
  assert.equal(exported.assetSetFingerprint,
    generateAnimationGraphRuntime(graph, metadata, { strike: '98765', idle: 'rbxassetid://12345' }).assetSetFingerprint,
    'the live timing asset-set fingerprint must be stable across map ordering and accepted ID prefixes');
  assert.notEqual(exported.assetSetFingerprint,
    generateAnimationGraphRuntime(graph, metadata, { strike: '98766', idle: '12345' }).assetSetFingerprint,
    'the asset-set fingerprint must change when any published animation ID changes');
});

test('runtime export emits BlendSpace1D controllers and rejects source metadata that would desynchronize playback', () => {
  const blendGraph = { ...graph, states: graph.states.map(state => state.id === 'idle' ? { ...state,
    blendSpace1D: { parameter: 'stamina', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'strike' }] } } : state) };
  const compatibleMetadata = metadata.map(item => ({ ...item, loop: true, markers: [] }));
  const exported = generateAnimationGraphRuntime(blendGraph, compatibleMetadata, { idle: '12345', strike: '98765' });
  assert.equal(exported.trackChannelCount, 3, 'a two-sample BlendSpace needs isolated source channels plus one regular state channel');
  assert.match(exported.contract.loading, /independent AnimationTrack channels/);
  assert.match(exported.moduleSource, /function Controller:SetParameter/);
  assert.match(exported.moduleSource, /track:AdjustWeight\(spec\.weight, fadeRemaining\)/);
  assert.match(exported.moduleSource, /state\.speed \* source\.duration \/ state\.duration/);
  assert.match(exported.moduleSource, /local function interpolationAlpha\(value, lower, upper\)/);
  assert.throws(() => generateAnimationGraphRuntime(blendGraph, metadata, { idle: '12345', strike: '98765' }), /must match the controller loop setting/i);
});

test('runtime export emits deterministic 2D topology and Luau directional-weight evaluation', () => {
  const directionalGraph = { ...graph,
    parameters: [
      { name: 'moveX', type: 'number' as const, defaultValue: 0.25, min: -1, max: 1 },
      { name: 'moveY', type: 'number' as const, defaultValue: 0.5, min: -1, max: 1 },
    ], states: [
      { id: 'idle', name: 'Directional', animationId: '00000000-0000-4000-8000-000000000001', speed: 1,
        blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
          { x: 0, y: 0, stateId: 'idle' }, { x: 0.5, y: 0, stateId: 'mid' },
          { x: 1, y: 0, stateId: 'strike' }, { x: 0, y: 1, stateId: 'recover' },
        ] } },
      { id: 'strike', name: 'Right', animationId: '00000000-0000-4000-8000-000000000002', speed: 1 },
      { id: 'mid', name: 'Forward-right transition', animationId: '00000000-0000-4000-8000-000000000004', speed: 1 },
      { id: 'recover', name: 'Forward', animationId: '00000000-0000-4000-8000-000000000003', speed: 1 },
    ], transitions: [] };
  const directionalMetadata = [...metadata.map(item => ({ ...item, loop: true, markers: [] })),
    { duration: 1, loop: true, markers: [] }, { duration: 1, loop: true, markers: [] }];
  const exported = generateAnimationGraphRuntime(directionalGraph, directionalMetadata,
    { idle: '12345', strike: '98765', mid: '24680', recover: '54321' });
  assert.equal(exported.trackChannelCount, 7);
  assert.match(exported.moduleSource, /\["blendSpace2D"\]/);
  assert.match(exported.moduleSource, /\["triangles"\]/);
  assert.match(exported.moduleSource, /\["hullEdges"\]/);
  assert.match(exported.moduleSource, /state\.blendSpace2D/);
  assert.match(exported.moduleSource, /local function blendWeights\(state, parameters\)/);
  const controllerState = directionalGraph.states[0]!;
  if (!('blendSpace2D' in controllerState)) throw new Error('Expected a directional blend fixture.');
  const expected = sampleAnimationGraphBlendSpace2D(controllerState.blendSpace2D, { x: 0.25, y: 0.5 });
  assert.deepEqual(Object.fromEntries(expected.weights.map(sample => [sample.stateId, sample.weight])),
    { idle: 0, mid: 0.5, strike: 0, recover: 0.5 });
});

test('runtime export reports independent AnimationTrack channel count for memory and preload planning', () => {
  const sourceIds = Array.from({ length: 15 }, (_, index) => `source${index}`);
  const controllerIds = Array.from({ length: 16 }, (_, index) => `blend${index}`);
  const channelBoundGraph = { kind: 'animation_graph' as const, name: 'Track channel bound', entryState: controllerIds[0]!, sampleRate: 30,
    parameters: [{ name: 'speed', type: 'number' as const, defaultValue: 0, min: 0, max: 15 }],
    states: [...controllerIds.map((id, index) => ({ id, name: id, animationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, speed: 1,
      blendSpace1D: { parameter: 'speed', samples: [{ value: 0, stateId: id }, ...sourceIds.map((stateId, sampleIndex) => ({ value: sampleIndex + 1, stateId }))] } })),
      ...sourceIds.map((id, index) => ({ id, name: id, animationId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`, speed: 1 }))],
    transitions: [] };
  const channelBoundMetadata = channelBoundGraph.states.map(() => ({ duration: 1, loop: true, markers: [] }));
  const channelBoundAssetIds = Object.fromEntries(channelBoundGraph.states.map((state, index) => [state.id, String(index + 1)]));
  const exported = generateAnimationGraphRuntime(channelBoundGraph, channelBoundMetadata, channelBoundAssetIds);
  assert.equal(exported.trackChannelCount, 271);
  assert.match(exported.contract.loading, /separate Animator:LoadAnimation call and track/);
});

test('runtime export rejects missing, extra, malformed IDs and mismatched source metadata', () => {
  assert.throws(() => generateAnimationGraphRuntime(graph, metadata, { idle: '12345' }), /Missing published animation IDs.*strike/);
  assert.throws(() => generateAnimationGraphRuntime(graph, metadata, { idle: '12345', strike: '98765', extra: '22' }), /Unknown graph states.*extra/);
  assert.throws(() => generateAnimationGraphRuntime(graph, metadata, { idle: 'https://example.com/12345', strike: '98765' }), /positive numeric Roblox animation asset ID/);
  assert.throws(() => generateAnimationGraphRuntime(graph, metadata.slice(0, 1), { idle: '12345', strike: '98765' }), /exactly one entry per graph state/);
  assert.throws(() => generateAnimationGraphRuntime(graph, [metadata[0]!, { kind: 'vfx' } as never], { idle: '12345', strike: '98765' }), /unrecognized key/i);
});

test('runtime Luau string serialization escapes control characters in guard values', () => {
  const controlSafeGraph = { ...graph, parameters: [{ name: 'weapon', type: 'string' as const, defaultValue: 'sword' }],
    transitions: [{ id: 'escape', from: 'idle', to: 'strike', trigger: 'Attack', priority: 0, blendSeconds: 0.1,
      guards: [{ parameter: 'weapon', operator: 'eq' as const, value: 'slash\u0001\n"quoted"' }] }] };
  const exported = generateAnimationGraphRuntime(controlSafeGraph, metadata, { idle: '12345', strike: '98765' });
  assert.match(exported.moduleSource, /slash\\001\\n\\"quoted\\"/);
  assert.equal(exported.moduleSource.includes('\u0001'), false);
});

test('generated runtime executes priority guards, crossfades and automatic one-shot completion in Luau', { skip: !existsSync(process.env.LUAU_EXECUTABLE ?? join(process.cwd(), '.local', 'tools', 'luau-0.737', 'luau.exe')) }, async () => {
  const exported = generateAnimationGraphRuntime(graph, metadata, { idle: '12345', strike: '98765' });
  const blendGraph = { ...graph, states: graph.states.map(state => state.id === 'idle' ? { ...state,
    blendSpace1D: { parameter: 'stamina', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'strike' }] } } : state) };
  const blendMetadata = metadata.map(item => ({ ...item, loop: true,
    markers: [{ name: 'BlendMarker', time: item.duration / 2 }] }));
  const blendRuntime = generateAnimationGraphRuntime(blendGraph, blendMetadata, { idle: '12345', strike: '98765' });
  const directionalGraph = { kind: 'animation_graph' as const, name: 'Runtime directional blend', entryState: 'idle', sampleRate: 30,
    parameters: [
      { name: 'moveX', type: 'number' as const, defaultValue: 0.25, min: -1, max: 1 },
      { name: 'moveY', type: 'number' as const, defaultValue: 0.5, min: -1, max: 1 },
    ], states: [
      { id: 'idle', name: 'Directional', animationId: '00000000-0000-4000-8000-000000000001', speed: 1,
        blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
          { x: 0, y: 0, stateId: 'idle' }, { x: 0.5, y: 0, stateId: 'mid' },
          { x: 1, y: 0, stateId: 'strike' }, { x: 0, y: 1, stateId: 'recover' },
        ] } },
      { id: 'strike', name: 'Right', animationId: '00000000-0000-4000-8000-000000000002', speed: 1 },
      { id: 'mid', name: 'Forward-right transition', animationId: '00000000-0000-4000-8000-000000000004', speed: 1 },
      { id: 'recover', name: 'Forward', animationId: '00000000-0000-4000-8000-000000000003', speed: 1 },
    ], transitions: [] };
  const directionalMetadata = [...metadata.map(item => ({ ...item, loop: true, markers: [] })),
    { duration: 1, loop: true, markers: [] }, { duration: 1, loop: true, markers: [] }];
  const directionalBlendRuntime = generateAnimationGraphRuntime(directionalGraph, directionalMetadata,
    { idle: '12345', strike: '98765', mid: '24680', recover: '54321' });
  const directionalState = directionalGraph.states[0]!;
  if (!('blendSpace2D' in directionalState)) throw new Error('Expected a directional blend fixture.');
  const directionalParityCases = Array.from({ length: 17 }, (_, xIndex) => Array.from({ length: 17 }, (_, yIndex) => {
    const x = xIndex / 8 - 1, y = yIndex / 8 - 1;
    const sampled = sampleAnimationGraphBlendSpace2D(directionalState.blendSpace2D, { x, y });
    const weightByState = Object.fromEntries(sampled.weights.map(sample => [sample.stateId, sample.weight]));
    return `{ x = ${x}, y = ${y}, idle = ${weightByState.idle}, strike = ${weightByState.strike}, mid = ${weightByState.mid}, recover = ${weightByState.recover} }`;
  })).flat().join(',\n');
  const extremeDirectionalGraph = { ...directionalGraph,
    parameters: directionalGraph.parameters.map(parameter => ({ ...parameter, defaultValue: 0, min: -1e308, max: 1e308 })),
    states: directionalGraph.states.map(state => state.id === 'idle' ? { ...state,
      blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
        { x: -1e308, y: -1e308, stateId: 'idle' }, { x: 1e308, y: -1e308, stateId: 'mid' },
        { x: 1e308, y: 1e308, stateId: 'strike' }, { x: -1e308, y: 1e308, stateId: 'recover' },
      ] } } : state) };
  const extremeDirectionalRuntime = generateAnimationGraphRuntime(extremeDirectionalGraph, directionalMetadata,
    { idle: '12345', strike: '98765', mid: '24680', recover: '54321' });
  const extremeDirectionalState = extremeDirectionalGraph.states[0]!;
  if (!('blendSpace2D' in extremeDirectionalState)) throw new Error('Expected an extreme directional blend fixture.');
  const extremeDirectionalParityCases = [-1e308, -5e307, 0, 5e307, 1e308].flatMap(x => [-1e308, -5e307, 0, 5e307, 1e308].map(y => {
    const sampled = sampleAnimationGraphBlendSpace2D(extremeDirectionalState.blendSpace2D, { x, y });
    const weightByState = Object.fromEntries(sampled.weights.map(sample => [sample.stateId, sample.weight]));
    return `{ x = ${x}, y = ${y}, idle = ${weightByState.idle}, strike = ${weightByState.strike}, mid = ${weightByState.mid}, recover = ${weightByState.recover} }`;
  })).join(',\n');
  const outlierDirectionalGraph = { ...directionalGraph,
    parameters: directionalGraph.parameters.map(parameter => ({ ...parameter, defaultValue: 0, min: -1e308, max: 1e308 })),
    states: directionalGraph.states.map(state => state.id === 'idle' ? { ...state,
      blendSpace2D: { xParameter: 'moveX', yParameter: 'moveY', samples: [
        { x: 0, y: 0, stateId: 'idle' }, { x: 0.1, y: 0, stateId: 'mid' },
        { x: 0, y: 0.1, stateId: 'strike' }, { x: 1e308, y: 1e308, stateId: 'recover' },
      ] } } : state) };
  const outlierDirectionalRuntime = generateAnimationGraphRuntime(outlierDirectionalGraph, directionalMetadata,
    { idle: '12345', strike: '98765', mid: '24680', recover: '54321' });
  const outlierDirectionalState = outlierDirectionalGraph.states[0]!;
  if (!('blendSpace2D' in outlierDirectionalState)) throw new Error('Expected an outlier directional blend fixture.');
  const outlierSample = sampleAnimationGraphBlendSpace2D(outlierDirectionalState.blendSpace2D, { x: 0.025, y: 0.025 });
  const outlierWeightByState = Object.fromEntries(outlierSample.weights.map(sample => [sample.stateId, sample.weight]));
  const blendControllerState = blendGraph.states.find(state => state.id === 'idle');
  if (!blendControllerState || !('blendSpace1D' in blendControllerState)) throw new Error('Expected a BlendSpace controller fixture.');
  const blendParityCases = Array.from({ length: 101 }, (_, index) => {
    const value = index / 100;
    const expected = sampleAnimationGraphBlendSpace1D(blendControllerState.blendSpace1D, value);
    return `{ value = ${value}, idle = ${expected.weights[0]!.weight}, strike = ${expected.weights[1]!.weight} }`;
  }).join(',\n');
  const extremeBlendGraph = { ...blendGraph,
    parameters: blendGraph.parameters.map(parameter => parameter.name === 'stamina'
      ? { ...parameter, defaultValue: 0, min: -1e308, max: 1e308 } : parameter),
    states: blendGraph.states.map(state => state.id === 'idle' ? { ...state,
    blendSpace1D: { parameter: 'stamina', samples: [{ value: -1e308, stateId: 'idle' }, { value: 1e308, stateId: 'strike' }] } } : state) };
  const extremeBlendRuntime = generateAnimationGraphRuntime(extremeBlendGraph, blendMetadata, { idle: '12345', strike: '98765' });
  const extremeBlendControllerState = extremeBlendGraph.states.find(state => state.id === 'idle');
  if (!extremeBlendControllerState || !('blendSpace1D' in extremeBlendControllerState)) throw new Error('Expected an extreme BlendSpace fixture.');
  const extremeBlendParityCases = [-1e308, -7.5e307, -5e307, -1, 0, 1, 5e307, 7.5e307, 1e308].map(value => {
    const expected = sampleAnimationGraphBlendSpace1D(extremeBlendControllerState.blendSpace1D, value);
    return `{ value = ${value}, idle = ${expected.weights[0]!.weight}, strike = ${expected.weights[1]!.weight} }`;
  }).join(',\n');
  const selfRestartGraph = { kind: 'animation_graph' as const, name: 'Self restart', entryState: 'idle', sampleRate: 30,
    states: [graph.states[0]!], transitions: [{ id: 'restart', from: 'idle', to: 'idle', trigger: 'Again', blendSeconds: 0.35 }] };
  const selfRestartRuntime = generateAnimationGraphRuntime(selfRestartGraph, [metadata[0]!], { idle: '12345' });
  const loadFailureGraph = { kind: 'animation_graph' as const, name: 'Load failure rollback', entryState: 'idle', sampleRate: 30,
    parameters: [{ name: 'armed', type: 'boolean' as const, defaultValue: false }],
    states: [
      { id: 'idle', name: 'Idle', animationId: '00000000-0000-4000-8000-000000000021', speed: 1 },
      { id: 'preferred', name: 'Preferred', animationId: '00000000-0000-4000-8000-000000000022', speed: 1 },
      { id: 'fallback', name: 'Fallback', animationId: '00000000-0000-4000-8000-000000000023', speed: 1 },
    ],
    transitions: [
      { id: 'preferredBranch', from: 'idle', to: 'preferred', trigger: 'Try', priority: 10, blendSeconds: 0.2, guards: [] },
      { id: 'lowerFallback', from: 'idle', to: 'fallback', trigger: 'Try', priority: 0, blendSeconds: 0.1, guards: [] },
    ] };
  const loadFailureMetadata = [metadata[0]!, metadata[1]!, metadata[1]!];
  const loadFailureRuntime = generateAnimationGraphRuntime(loadFailureGraph, loadFailureMetadata,
    { idle: '12001', preferred: '12002', fallback: '12003' });
  const partialBlendGraph = { ...graph, entryState: 'approach', states: graph.states.map(state => state.id === 'idle' ? { ...state,
    blendSpace1D: { parameter: 'stamina', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'strike' }] } } : state).concat([
      { id: 'approach', name: 'Approach', animationId: '00000000-0000-4000-8000-000000000003', speed: 1 },
    ]), transitions: [{ id: 'enterBlend', from: 'approach', to: 'idle', trigger: 'Blend', blendSeconds: 0.2 }] };
  const partialBlendMetadata = [...metadata.map(item => ({ ...item, loop: true, markers: [] })),
    { duration: 1, loop: true, markers: [] }];
  const partialBlendRuntime = generateAnimationGraphRuntime(partialBlendGraph, partialBlendMetadata,
    { idle: '12345', strike: '98765', approach: '54321' });
  const overlapBlendGraph = { ...graph, entryState: 'strike', states: graph.states.map(state => state.id === 'idle' ? { ...state,
    blendSpace1D: { parameter: 'stamina', samples: [{ value: 0, stateId: 'idle' }, { value: 1, stateId: 'strike' }] } } : state),
    transitions: [{ id: 'enterBlend', from: 'strike', to: 'idle', trigger: 'Blend', blendSeconds: 0.2 }] };
  const overlapBlendMetadata = metadata.map(item => ({ ...item, loop: true, markers: [{ name: 'BlendMarker', time: item.duration / 2 }] }));
  const overlapBlendRuntime = generateAnimationGraphRuntime(overlapBlendGraph, overlapBlendMetadata,
    { idle: '12345', strike: '98765' });
  const interruptedRecipes = {
    '00000000-0000-4000-8000-000000000011': { ...animationPreset('idle', 'Interrupt A', 1, 0.5),
      markers: [{ name: 'OldStateMarker', time: 0.05 }] },
    '00000000-0000-4000-8000-000000000012': animationPreset('idle', 'Interrupt B', 1, 0.5),
    '00000000-0000-4000-8000-000000000013': animationPreset('idle', 'Interrupt C', 1, 0.5),
  };
  const interruptedGraph = { kind: 'animation_graph' as const, name: 'Interrupted blends', entryState: 'a', sampleRate: 30,
    states: [
      { id: 'a', name: 'A', animationId: '00000000-0000-4000-8000-000000000011', speed: 1 },
      { id: 'b', name: 'B', animationId: '00000000-0000-4000-8000-000000000012', speed: 1 },
      { id: 'c', name: 'C', animationId: '00000000-0000-4000-8000-000000000013', speed: 1 },
    ], transitions: [
      { id: 'start', from: 'a', to: 'b', trigger: 'Go', blendSeconds: 0.2 },
      { id: 'staleMarker', from: 'b', to: 'c', trigger: 'OldStateMarker', blendSeconds: 0.1 },
      { id: 'interrupt', from: 'b', to: 'c', trigger: 'Interrupt', blendSeconds: 0.4 },
      { id: 'return', from: 'c', to: 'a', trigger: 'Return', blendSeconds: 0.3 },
    ] };
  const interruptedMetadata = Object.values(interruptedRecipes).map(recipe => ({ duration: recipe.duration, loop: recipe.loop,
    ...(recipe.priority ? { priority: recipe.priority } : {}), markers: recipe.markers }));
  const interruptedRuntime = generateAnimationGraphRuntime(interruptedGraph, interruptedMetadata, {
    a: '11001', b: '11002', c: '11003',
  });
  const interruptedSimulation = simulateAnimationGraphTimeline(interruptedGraph, interruptedRecipes, { duration: 0.3, events: [
    { at: 0, kind: 'trigger', trigger: 'Go' },
    { at: 0.1, kind: 'trigger', trigger: 'Interrupt' },
    { at: 0.3, kind: 'trigger', trigger: 'Return' },
  ] });
  assert.deepEqual(interruptedSimulation.transitionIds, ['start', 'interrupt', 'return']);
  assert.equal(interruptedSimulation.triggeredMarkers.some(marker => marker.marker === 'OldStateMarker'), false,
    'a stale outgoing-state marker must not enter the timeline after a transition');
  const root = await mkdtemp(join(tmpdir(), 'motion-graph-runtime-luau-'));
  const scriptPath = join(root, 'runtime-test.luau');
  const harness = `local mockWorkspace = {}
workspace = mockWorkspace
game = { GetService = function(_, name) assert(name == "Workspace"); return mockWorkspace end }
typeof = function(value)
    if type(value) == "table" and value.__class then return "Instance" end
    return type(value)
end
local function makeSignal()
    local handlers = {}
    return {
        Connect = function(_, callback)
            local slot = { callback = callback, connected = true }
            table.insert(handlers, slot)
            return { Disconnect = function() slot.connected = false end }
        end,
        Fire = function(_, ...)
            for _, slot in ipairs(handlers) do if slot.connected then slot.callback(...) end end
        end,
    }
end
Instance = { new = function(className)
    assert(className == "Animation")
    return { Destroy = function(self) self.destroyed = true end }
end }
Enum = { AnimationPriority = { Core = "Core" } }
local scheduledTasks = {}
task = { spawn = function(callback) table.insert(scheduledTasks, callback) end }
local mockClock = 0
os = { clock = function() return mockClock end }
local function runScheduledTasks()
    while #scheduledTasks > 0 do table.remove(scheduledTasks, 1)() end
end
local function makeAnimator(failAnimationId, failPlayAnimationId, failAdjustAnimationId)
    local animator = { __class = "Animator", AncestryChanged = makeSignal(), inWorkspace = true, loadedTracks = {}, loadedTrackList = {},
        failAnimationId = failAnimationId, failPlayAnimationId = failPlayAnimationId,
        failAdjustAnimationId = failAdjustAnimationId, failSpeedAnimationId = nil, failTimePositionAnimationId = nil }
    function animator:IsA(className) return className == "Animator" end
    function animator:IsDescendantOf(instance) return instance == mockWorkspace and self.inWorkspace end
    function animator:LoadAnimation(animation)
        if animation.AnimationId == self.failAnimationId then error("mock animation load failure") end
        local track = setmetatable({ Ended = makeSignal(), IsPlaying = false, AnimationId = animation.AnimationId, AnimationName = animation.Name, calls = {},
            _timePosition = 0, WeightCurrent = 0, WeightTarget = 0 }, {
            __index = function(self, key) if key == "TimePosition" then return rawget(self, "_timePosition") end end,
            __newindex = function(self, key, value)
                if key == "TimePosition" then
                    if self.AnimationId == animator.failTimePositionAnimationId then error("mock TimePosition seek failure") end
                    rawset(self, "_timePosition", value)
                else rawset(self, key, value) end
            end,
        })
        track.markerSignals = {}
        function track:Play(fade, weight, speed)
            if self.AnimationId == animator.failPlayAnimationId then error("mock animation play failure") end
            local wasPlaying = self.IsPlaying
            local previousWeight = self.WeightCurrent
            self.IsPlaying = true
            rawset(self, "_timePosition", 0)
            self.Speed = speed
            self.WeightTarget = weight or 1
            self.WeightCurrent = fade == 0 and self.WeightTarget or wasPlaying and previousWeight or 0
            table.insert(self.calls, { method = "Play", fade = fade, weight = weight, speed = speed })
            self.lastPlay = { fade, weight, speed }
        end
        function track:Stop(fade)
            self.IsPlaying = false
            self.WeightTarget = 0
            if fade == 0 then self.WeightCurrent = 0 end
            table.insert(self.calls, { method = "Stop", fade = fade })
            self.lastStop = fade
        end
        function track:AdjustWeight(weight, fade)
            if self.AnimationId == animator.failAdjustAnimationId then
                animator.failAdjustAnimationId = nil
                error("mock AdjustWeight failure")
            end
            self.WeightTarget = weight
            if fade == 0 then self.WeightCurrent = weight end
            table.insert(self.calls, { method = "AdjustWeight", weight = weight, fade = fade })
            self.lastAdjust = { weight = weight, fade = fade }
        end
        function track:AdjustSpeed(speed)
            if self.AnimationId == animator.failSpeedAnimationId then
                animator.failSpeedAnimationId = nil
                error("mock AdjustSpeed failure")
            end
            self.Speed = speed
            table.insert(self.calls, { method = "AdjustSpeed", speed = speed })
        end
        function track:GetMarkerReachedSignal(markerName)
            if not self.markerSignals[markerName] then self.markerSignals[markerName] = makeSignal() end
            return self.markerSignals[markerName]
        end
        function track:Destroy() self.destroyed = true end
        self.loadedTracks[animation.AnimationId] = track
        table.insert(self.loadedTrackList, track)
        return track
    end
    return animator
end
local animator = makeAnimator()
local function makeCharacter()
    local character = { Parent = mockWorkspace }
    local humanoid = { Parent = character }
    local boundAnimator = makeAnimator()
    boundAnimator.Parent = humanoid
    function character:FindFirstChildOfClass(className)
        if className == "Humanoid" then return humanoid end
    end
    function character:WaitForChild(name, _timeout)
        if name == "Humanoid" then return humanoid end
    end
    function humanoid:FindFirstChildOfClass(className)
        if className == "Animator" then return boundAnimator end
    end
    function humanoid:WaitForChild(name, _timeout)
        if name == "Animator" then return boundAnimator end
    end
    return character, boundAnimator
end
local function makePlayer(character)
    local player = { __class = "Player", Character = character, CharacterAdded = makeSignal(), CharacterRemoving = makeSignal() }
    function player:IsA(className) return className == "Player" end
    return player
end
local Controller = (function()
${exported.moduleSource}
end)()
local BlendController = (function()
${blendRuntime.moduleSource}
end)()
local DirectionalBlendController = (function()
${directionalBlendRuntime.moduleSource}
end)()
local directionalParityCases = {
${directionalParityCases}
}
local blendParityCases = {
${blendParityCases}
}
local extremeBlendParityCases = {
${extremeBlendParityCases}
}
local ExtremeBlendController = (function()
${extremeBlendRuntime.moduleSource}
end)()
local InterruptedController = (function()
${interruptedRuntime.moduleSource}
end)()
local SelfRestartController = (function()
${selfRestartRuntime.moduleSource}
end)()
local LoadFailureController = (function()
${loadFailureRuntime.moduleSource}
end)()
local PartialBlendController = (function()
${partialBlendRuntime.moduleSource}
end)()
local OverlapBlendController = (function()
${overlapBlendRuntime.moduleSource}
end)()
local controller = Controller.new(animator)
assert(controller:GetState() == "idle")
assert(animator.loadedTracks["rbxassetid://12345"].IsPlaying)
assert(animator.loadedTracks["rbxassetid://98765"] == nil, "non-entry animation tracks should remain unloaded until needed")
local loadedInitially = controller:GetLoadedStateIds()
assert(#loadedInitially == 1 and loadedInitially[1] == "idle")
local preloaded, preloadedIds = controller:Preload("strike")
assert(preloaded and #preloadedIds == 1 and preloadedIds[1] == "strike")
assert(animator.loadedTracks["rbxassetid://98765"] ~= nil, "explicit preload should load the requested track")
local invalidPreload, invalidPreloadResult = controller:Preload({ "strike", "unknown" })
assert(not invalidPreload and invalidPreloadResult.reason == "unknown_state")
local sparsePreload, sparsePreloadResult = controller:Preload({ [1] = "strike", [3] = "idle" })
assert(not sparsePreload and sparsePreloadResult.reason == "state_ids_must_be_a_dense_array")
assert(#controller:GetLoadedStateIds() == 2, "invalid preload requests must not partially alter the cache")
local availableBeforeAttack = controller:GetAvailableTriggers()
assert(#availableBeforeAttack == 1 and availableBeforeAttack[1].trigger == "Attack")
local blockedEvaluation = controller:EvaluateTrigger("Attack")
assert(blockedEvaluation.selectedTransition.transitionId == "light" and blockedEvaluation.selectedTransition.destinationLoaded,
    "the unguarded fallback should be selected while the high-priority stamina guard fails")
assert(blockedEvaluation.branches[1].transitionId == "heavy" and not blockedEvaluation.branches[1].matched)
local invalid, invalidReason = controller:SetParameter("stamina", 2)
assert(not invalid and string.find(invalidReason, "above its maximum"))
assert(controller:GetParameter("stamina") == 0.5, "invalid values must not change graph parameters")
local updated = controller:SetParameters({ stamina = 0.8, grounded = true })
assert(updated)
local triggerEvaluation = controller:EvaluateTrigger("Attack")
assert(triggerEvaluation.selectedTransition.transitionId == "heavy" and triggerEvaluation.selectedTransition.destinationLoaded)
assert(triggerEvaluation.branches[2].transitionId == "light" and triggerEvaluation.branches[2].matched)
local markerEvent = nil
local markerConnection, markerError = controller:ConnectMarker("Release", function(name, parameterString, stateId)
    markerEvent = { name, parameterString, stateId }
end)
assert(markerConnection and not markerError)
local unknownMarker, unknownMarkerError = controller:ConnectMarker("NotAuthored", function() end)
assert(not unknownMarker and string.find(unknownMarkerError, "Unknown animation marker"))
local transitioned, transition = controller:Trigger("attack")
assert(transitioned and transition.transitionId == "heavy", "highest-priority matching guard should win")
assert(controller:GetState() == "strike")
local strikeTrack = animator.loadedTracks["rbxassetid://98765"]
assert(strikeTrack.IsPlaying and strikeTrack.lastPlay[1] == 0.2 and strikeTrack.lastPlay[3] == 1.25)
assert(animator.loadedTracks["rbxassetid://12345"].lastStop == 0.2, "outgoing track must crossfade")
strikeTrack.markerSignals.Release:Fire("heavy")
assert(markerEvent[1] == "Release" and markerEvent[2] == "heavy" and markerEvent[3] == "strike")
assert(controller:GetState() == "idle", "an authored marker should invoke the same-named graph transition")
local restarted = controller:Trigger("Attack")
assert(restarted and controller:GetState() == "strike")
strikeTrack.IsPlaying = false
strikeTrack.Ended:Fire()
assert(controller:GetState() == "idle", "a naturally ended non-looping state should trigger AnimationEnded")
assert(animator.loadedTracks["rbxassetid://12345"].IsPlaying)
controller:Destroy()
controller:Destroy()
assert(controller:GetState() == nil)
local afterDestroy = controller:Trigger("attack")
assert(not afterDestroy)
local selfRestartAnimator = makeAnimator()
local selfRestartController = SelfRestartController.new(selfRestartAnimator)
local selfRestartTrack = selfRestartAnimator.loadedTracks["rbxassetid://12345"]
local selfRestartOk, selfRestartResult = selfRestartController:Trigger("Again")
assert(selfRestartOk and selfRestartResult.from == "idle" and selfRestartResult.to == "idle")
assert(#selfRestartTrack.calls == 2 and selfRestartTrack.calls[1].method == "Play"
    and selfRestartTrack.calls[2].method == "Play" and selfRestartTrack.calls[2].fade == 0.35,
    "a self-transition should restart the current track with Play and its requested fade, without a zero-fade Stop")
assert(selfRestartTrack.TimePosition == 0 and selfRestartTrack.WeightCurrent == 1 and selfRestartTrack.WeightTarget == 1,
    "replaying a full-weight cached track must not fabricate a fade from zero weight")
selfRestartController:Destroy()
local loadFailureAnimator = makeAnimator("rbxassetid://12002")
local loadFailureController = LoadFailureController.new(loadFailureAnimator)
local loadFailureOk, loadFailureResult = loadFailureController:TriggerWithParameters("Try", { armed = true })
assert(not loadFailureOk and loadFailureResult.reason == "animation_load_failed"
    and loadFailureResult.transitionId == "preferredBranch")
assert(loadFailureController:GetState() == "idle" and loadFailureController:GetParameter("armed") == false,
    "a selected destination load failure must roll back state and parameter changes")
assert(loadFailureAnimator.loadedTracks["rbxassetid://12003"] == nil,
    "a destination load failure must not fall through to a lower-priority branch")
loadFailureController:Destroy()
local guardController = Controller.new(makeAnimator())
local unavailable = guardController:EvaluateTrigger("Attack")
assert(unavailable.selectedTransition.transitionId == "light" and unavailable.branches[1].transitionId == "heavy")
assert(unavailable.selectedTransition.destinationLoaded == false and unavailable.destinationLoaded == false,
    "an unloaded selected destination must be explicitly reported as false")
assert(unavailable.noTransitionReason == nil, "a selected fallback must not report a no-transition reason")
assert(unavailable.branches[1].checks[1].parameter == "stamina" and not unavailable.branches[1].checks[1].matched)
assert(unavailable.branches[1].checks[1].observed == 0.5,
    "the diagnostic should expose the observed value that rejected a higher-priority branch")
local unknownTrigger = guardController:EvaluateTrigger("Dodge")
assert(unknownTrigger.selectedTransition == nil and unknownTrigger.noTransitionReason == "no_transition_for_state_and_trigger")
local transactionalController = Controller.new(makeAnimator())
local transactionOk, transactionResult = transactionalController:TriggerWithParameters("Attack", { stamina = 0.8, grounded = true })
assert(transactionOk and transactionResult.transitionId == "heavy" and transactionalController:GetState() == "strike")
assert(transactionalController:GetParameter("stamina") == 0.8, "successful atomic transition should commit its parameter updates")
transactionalController:Destroy()
local rejectedController = Controller.new(makeAnimator())
local mismatchOk, mismatchResult = rejectedController:TriggerWithParameters("Attack", { stamina = 0.8, grounded = false }, "heavy")
assert(not mismatchOk and mismatchResult.reason == "selected_transition_mismatch" and mismatchResult.selectedTransition.transitionId == "light")
assert(rejectedController:GetParameter("stamina") == 0.5 and rejectedController:GetState() == "idle",
    "an expected-transition mismatch must not commit proposed values or play the fallback")
local rejectedOk, rejectedResult = rejectedController:TriggerWithParameters("Attack", { stamina = 0.2, unknown = true })
assert(not rejectedOk and rejectedResult.reason == "invalid_parameter_update")
assert(rejectedController:GetParameter("stamina") == 0.5 and rejectedController:GetState() == "idle",
    "invalid atomic updates must not mutate parameters or state")
local fallbackOk, fallbackResult = rejectedController:TriggerWithParameters("Attack", { stamina = 0.8, grounded = false })
assert(fallbackOk and fallbackResult.transitionId == "light")
assert(rejectedController:GetParameter("stamina") == 0.8,
    "a successfully started fallback is a valid transaction and commits its proposed parameters")
rejectedController:Destroy()
local failingLoadController = Controller.new(makeAnimator("rbxassetid://98765"))
local loadFailed, loadFailure = failingLoadController:TriggerWithParameters("Attack", { stamina = 0.8, grounded = true }, "heavy")
assert(not loadFailed and loadFailure.reason == "animation_load_failed")
assert(failingLoadController:GetParameter("stamina") == 0.5 and failingLoadController:GetState() == "idle",
    "a destination animation load failure must roll back parameter and state changes")
failingLoadController:Destroy()
guardController:Destroy()
local firstCharacter, firstAnimator = makeCharacter()
local secondCharacter, secondAnimator = makeCharacter()
local staleCharacter, staleAnimator = makeCharacter()
local finalCharacter, finalAnimator = makeCharacter()
local player = makePlayer(firstCharacter)
local readyCallbacks = {}
local binding = Controller.BindToPlayer(player, function(boundController, character)
    table.insert(readyCallbacks, { controller = boundController, character = character })
end)
local unavailableBindingEvaluation, unavailableBindingError = binding:EvaluateTrigger("Attack")
assert(unavailableBindingEvaluation == nil and unavailableBindingError.reason == "controller_not_ready")
local unavailableBlendState, unavailableBlendError = binding:GetBlendState()
assert(unavailableBlendState == nil and unavailableBlendError.reason == "controller_not_ready")
local unavailablePreload, unavailablePreloadResult = binding:Preload("strike")
assert(not unavailablePreload and unavailablePreloadResult.reason == "controller_not_ready")
runScheduledTasks()
assert(#readyCallbacks == 1 and readyCallbacks[1].character == firstCharacter)
local discreteBlendState, discreteBlendError = binding:GetBlendState()
assert(discreteBlendState == nil and discreteBlendError.reason == "current_state_not_blended" and discreteBlendError.stateId == "idle")
assert(binding:GetParameter("stamina") == 0.5)
assert(binding:GetPlaybackSpeed() == 1 and binding:SetPlaybackSpeed(1.25)
    and binding:GetPlaybackSpeed() == 1.25,
    "respawn-safe bindings should expose and update the active controller playback-speed multiplier")
assert(binding:SetPlaybackSpeed(1))
assert(binding:SetParameter("stamina", 0.6))
assert(binding:SetParameters({ stamina = 0.5, grounded = true }))
local boundPreloadOk, boundPreloadIds = binding:Preload("strike")
assert(boundPreloadOk and #boundPreloadIds == 1 and boundPreloadIds[1] == "strike")
local boundLoaded = binding:GetLoadedStateIds()
assert(#boundLoaded == 2 and boundLoaded[1] == "idle" and boundLoaded[2] == "strike")
local boundAvailable = binding:GetAvailableTriggers()
assert(#boundAvailable == 1 and boundAvailable[1].selectedTransition.transitionId == "light")
local boundEvaluation = binding:EvaluateTrigger("Attack")
assert(boundEvaluation.selectedTransition.transitionId == "light")
local boundActionOk, boundActionResult = binding:TriggerWithParameters("Attack", { stamina = 0.8, grounded = true }, "heavy")
assert(boundActionOk and boundActionResult.transitionId == "heavy" and binding:GetState() == "strike",
    "respawn-safe player bindings must forward atomic exact-transition actions")
local firstController = binding:GetController()
local firstIdleTrack = firstAnimator.loadedTracks["rbxassetid://12345"]
player.CharacterRemoving:Fire(firstCharacter)
player.Character = nil
firstCharacter.Parent = nil
assert(binding:GetController() == nil and firstController.destroyed and firstIdleTrack.destroyed,
    "removing a character must immediately destroy its controller and tracks")
player.Character = secondCharacter
player.CharacterAdded:Fire(secondCharacter)
runScheduledTasks()
assert(#readyCallbacks == 2 and binding:GetState() == "idle")
assert(binding:GetParameter("stamina") == 0.5,
    "a respawn must start from the new controller's declared parameter defaults")
assert(binding:SetParameter("stamina", 0.65) and binding:GetParameter("stamina") == 0.65,
    "parameter forwarding must target the current respawn controller")
local secondSpawnPreloadOk, secondSpawnPreloaded = binding:Preload("strike")
assert(secondSpawnPreloadOk and #secondSpawnPreloaded == 1 and secondSpawnPreloaded[1] == "strike")
local secondSpawnLoaded = binding:GetLoadedStateIds()
assert(#secondSpawnLoaded == 2 and secondSpawnLoaded[2] == "strike",
    "preload and cache inspection must also target the current respawn controller")
player.Character = staleCharacter
player.CharacterAdded:Fire(staleCharacter)
player.CharacterRemoving:Fire(staleCharacter)
player.Character = nil
player.Character = finalCharacter
player.CharacterAdded:Fire(finalCharacter)
runScheduledTasks()
assert(#readyCallbacks == 3 and readyCallbacks[3].character == finalCharacter,
    "async setup for a removed spawn must not attach a stale controller")
local finalController = binding:GetController()
local finalTrack = finalAnimator.loadedTracks["rbxassetid://12345"]
finalAnimator.inWorkspace = false
finalAnimator.AncestryChanged:Fire(finalAnimator, nil)
assert(finalController.destroyed and finalTrack.destroyed and binding:GetController() == nil,
    "an Animator removed from Workspace must auto-clean its tracks")
binding:Destroy()
local preloadAllAnimator = makeAnimator()
local preloadAllController = Controller.new(preloadAllAnimator, { preloadAll = true })
local allLoaded = preloadAllController:GetLoadedStateIds()
assert(#allLoaded == 2 and preloadAllAnimator.loadedTracks["rbxassetid://98765"] ~= nil,
    "preloadAll should load every graph state before gameplay transitions")
preloadAllController:Destroy()
local interruptedAnimator = makeAnimator()
local interruptedController = InterruptedController.new(interruptedAnimator)
local startOk, startResult = interruptedController:Trigger("Go")
assert(startOk and startResult.transitionId == "start")
local trackA = interruptedAnimator.loadedTracks["rbxassetid://11001"]
trackA.markerSignals.OldStateMarker:Fire("stale")
assert(interruptedController:GetState() == "b", "a fading outgoing track's marker must be ignored after leaving its state")
local interruptOk, interruptResult = interruptedController:Trigger("Interrupt")
assert(interruptOk and interruptResult.transitionId == "interrupt")
local returnOk, returnResult = interruptedController:Trigger("Return")
assert(returnOk and returnResult.transitionId == "return")
local callTransitions = { startResult.transitionId, interruptResult.transitionId, returnResult.transitionId }
assert(table.concat(callTransitions, ",") == "start,interrupt,return")
local trackB = interruptedAnimator.loadedTracks["rbxassetid://11002"]
local trackC = interruptedAnimator.loadedTracks["rbxassetid://11003"]
assert(#trackA.calls == 3 and trackA.calls[1].method == "Play" and trackA.calls[1].fade == 0
    and trackA.calls[2].method == "Stop" and trackA.calls[2].fade == 0.2
    and trackA.calls[3].method == "Play" and trackA.calls[3].fade == 0.3,
    "the revisited A track should play again after it began fading out")
assert(#trackB.calls == 2 and trackB.calls[1].method == "Play" and trackB.calls[1].fade == 0.2
    and trackB.calls[2].method == "Stop" and trackB.calls[2].fade == 0.4,
    "B should keep its own outgoing fade after the next transition")
assert(#trackC.calls == 2 and trackC.calls[1].method == "Play" and trackC.calls[1].fade == 0.4
    and trackC.calls[2].method == "Stop" and trackC.calls[2].fade == 0.3)
interruptedController:Destroy()
local blendAnimator = makeAnimator()
local blendController = BlendController.new(blendAnimator)
local blendIdleTrack = blendAnimator.loadedTracks["rbxassetid://12345"]
local blendStrikeTrack = blendAnimator.loadedTracks["rbxassetid://98765"]
blendIdleTrack.Length, blendStrikeTrack.Length = 1.5, 0.8
blendIdleTrack.TimePosition, blendStrikeTrack.TimePosition = 0, 0
assert(blendIdleTrack.IsPlaying and blendStrikeTrack.IsPlaying, "a blend controller should load and play all source clips")
local initialBlendState = blendController:GetBlendState()
assert(initialBlendState.stateId == "idle" and initialBlendState.parameter == "stamina"
    and initialBlendState.parameterValue == 0.5 and initialBlendState.sampledValue == 0.5
    and initialBlendState.samples[1].expectedWeight == 0.5 and initialBlendState.samples[1].currentWeight == 0.5
    and initialBlendState.samples[1].targetWeight == 0.5 and initialBlendState.samples[1].isPlaying
    and initialBlendState.samples[2].authoredStateSpeed == 1.25
    and math.abs(initialBlendState.samples[2].effectivePlaybackSpeed - (0.8 / 1.5)) < 1e-9
    and math.abs(initialBlendState.samples[2].observedPlaybackSpeed - (0.8 / 1.5)) < 1e-9
    and initialBlendState.samples[2].observedLengthSeconds == 0.8
    and initialBlendState.samples[2].observedTimeSeconds == 0
    and initialBlendState.samples[2].observedNormalizedPhase == 0
    and initialBlendState.samples[2].authoredSpeedOverridden
    and initialBlendState.phaseSync.complete
    and initialBlendState.phaseSync.observedCount == 2
    and initialBlendState.phaseSync.requiredCount == 2
    and initialBlendState.phaseSync.maxCircularPhaseDifference == 0
    and initialBlendState.phaseSync.worstPair.firstStateId == "idle"
    and initialBlendState.phaseSync.worstPair.secondStateId == "strike"
    and initialBlendState.simulationTimingCalibration.ready
    and initialBlendState.simulationTimingCalibration.controllerStateId == "idle"
    and initialBlendState.simulationTimingCalibration.assetSetFingerprint == "${blendRuntime.assetSetFingerprint}"
    and initialBlendState.simulationTimingCalibration.animationIdsByStateId.idle == "rbxassetid://12345"
    and initialBlendState.simulationTimingCalibration.animationIdsByStateId.strike == "rbxassetid://98765"
    and initialBlendState.simulationTimingCalibration.observedBlendAnimationLengths.idle.idle == 1.5
    and initialBlendState.simulationTimingCalibration.observedBlendAnimationLengths.idle.strike == 0.8
    and initialBlendState.simulationTimingCalibration.observedBlendAnimationPlaybackSpeeds.idle.idle == 1
    and math.abs(initialBlendState.simulationTimingCalibration.observedBlendAnimationPlaybackSpeeds.idle.strike - (0.8 / 1.5)) < 1e-9
    and initialBlendState.simulationTimingCalibration.observedBlendAnimationStartPhases.idle.idle == 0
    and initialBlendState.simulationTimingCalibration.observedBlendAnimationStartPhases.idle.strike == 0
    and initialBlendState.totalCurrentWeight == 1 and initialBlendState.totalTargetWeight == 1,
    "live diagnostics should distinguish authored/effective speed and expose an asset-checkable simulator calibration snapshot")
assert(math.abs(blendIdleTrack.WeightTarget - 0.5) < 1e-9 and math.abs(blendStrikeTrack.WeightTarget - 0.5) < 1e-9,
    "the default parameter should distribute weight between adjacent source clips")
assert(math.abs(blendStrikeTrack.lastPlay[3] - (0.8 / 1.5)) < 1e-9,
    "source clip playback speed should preserve normalized phase across unequal authored durations")
local speedOk, speedResult = blendController:SetPlaybackSpeed(2)
assert(speedOk and blendController:GetPlaybackSpeed() == 2 and #speedResult.changedStateIds == 2
    and blendIdleTrack.Speed == 2 and math.abs(blendStrikeTrack.Speed - (2 * 0.8 / 1.5)) < 1e-9,
    "controller speed scaling should adjust every active BlendSpace source while preserving their relative phase rates")
blendController.tracks["@blend:idle:2"] = nil
local missingSpeedTrackOk, missingSpeedTrackResult = blendController:SetPlaybackSpeed(1.5)
assert(not missingSpeedTrackOk and missingSpeedTrackResult.reason == "active_track_not_loaded"
    and #missingSpeedTrackResult.attemptedStateIds == 0 and blendIdleTrack.Speed == 2
    and blendController:GetPlaybackSpeed() == 2,
    "speed changes must preflight the full BlendSpace channel set before mutating any track")
blendController.tracks["@blend:idle:2"] = blendStrikeTrack
local invalidSpeedOk, invalidSpeedResult = blendController:SetPlaybackSpeed(0)
assert(not invalidSpeedOk and invalidSpeedResult.reason == "invalid_playback_speed"
    and blendController:GetPlaybackSpeed() == 2,
    "invalid speed scales must be rejected without changing controller state")
blendAnimator.failSpeedAnimationId = "rbxassetid://98765"
local failedSpeedOk, failedSpeedResult = blendController:SetPlaybackSpeed(1.5)
assert(not failedSpeedOk and failedSpeedResult.reason == "playback_speed_update_failed"
    and table.concat(failedSpeedResult.restoredStateIds, ",") == "strike,idle"
    and blendController:GetPlaybackSpeed() == 2 and blendIdleTrack.Speed == 2
    and math.abs(blendStrikeTrack.Speed - (2 * 0.8 / 1.5)) < 1e-9,
    "partial speed updates must roll every source channel back before rejecting the multiplier")
assert(blendController:SetPlaybackSpeed(1) and blendController:GetPlaybackSpeed() == 1)
for _, expected in ipairs(blendParityCases) do
    assert(blendController:SetParameter("stamina", expected.value))
    local observed = blendController:GetBlendState()
    assert(math.abs(observed.samples[1].expectedWeight - expected.idle) < 1e-12
        and math.abs(observed.samples[2].expectedWeight - expected.strike) < 1e-12
        and math.abs(blendIdleTrack.WeightTarget - expected.idle) < 1e-12
        and math.abs(blendStrikeTrack.WeightTarget - expected.strike) < 1e-12,
        "generated Luau BlendSpace weights must match the TypeScript sampler at every sweep value")
end
local markerCalls = 0
local markerConnection = blendController:ConnectMarker("BlendMarker", function(_, _, sourceStateId)
    assert(sourceStateId == "idle")
    markerCalls += 1
end)
blendIdleTrack.markerSignals.BlendMarker:Fire("controller")
assert(blendStrikeTrack.markerSignals.BlendMarker == nil, "non-controller blend sources must not bind duplicate graph events")
assert(markerConnection and markerCalls == 1, "a blend controller should dispatch its synchronized marker once, not once per clip")
assert(blendController:SetParameter("stamina", 1))
assert(blendIdleTrack.WeightTarget == 0 and blendStrikeTrack.WeightTarget == 1,
    "changing a numeric parameter should immediately update active clip weights")
local endpointBlendState = blendController:GetBlendState()
assert(endpointBlendState.parameterValue == 1 and endpointBlendState.samples[1].expectedWeight == 0
    and endpointBlendState.samples[2].expectedWeight == 1 and endpointBlendState.samples[2].currentWeight == 1,
    "live blend diagnostics should reflect clamped endpoint weights after parameter changes")
blendIdleTrack.TimePosition = 0.75
blendStrikeTrack.IsPlaying = false
local restartOk, restartResult = blendController:SetParameter("stamina", 0.5)
assert(restartOk and restartResult.phaseSourceStateId == "idle"
    and table.concat(restartResult.restartedStateIds, ",") == "strike",
    "successful blend-channel recovery should report the source clock and restarted sample")
assert(blendStrikeTrack.IsPlaying and math.abs(blendStrikeTrack.TimePosition - 0.4) < 1e-9
    and math.abs(blendStrikeTrack.lastPlay[3] - (0.8 / 1.5)) < 1e-9,
    "a stopped blend channel reactivated by a parameter update must seek to the current normalized source phase")
local recoveredBlendState = blendController:GetBlendState()
assert(recoveredBlendState.samples[2].observedNormalizedPhase == 0.5
    and recoveredBlendState.phaseSync.complete
    and recoveredBlendState.phaseSync.maxCircularPhaseDifference == 0,
    "live diagnostics should report the Roblox-observed phase after a source channel is resynchronized")
blendStrikeTrack.TimePosition = 0.2
local driftedBlendState = blendController:GetBlendState()
assert(math.abs(driftedBlendState.phaseSync.maxCircularPhaseDifference - 0.25) < 1e-9
    and driftedBlendState.phaseSync.worstPair.firstStateId == "idle"
    and driftedBlendState.phaseSync.worstPair.secondStateId == "strike",
    "live diagnostics should quantify circular phase drift across loaded blend samples")
blendStrikeTrack.Length = 0.9
local synchronizedBlendOk, synchronizedBlendResult = blendController:SynchronizeBlendPlayback()
local synchronizedBlendState = blendController:GetBlendState()
assert(synchronizedBlendOk and synchronizedBlendResult.anchorStateId == "idle"
    and math.abs(synchronizedBlendResult.normalizedPhase - 0.5) < 1e-9
    and table.concat(synchronizedBlendResult.synchronizedStateIds, ",") == "idle,strike"
    and math.abs(blendStrikeTrack.Speed - 0.6) < 1e-9
    and math.abs(blendStrikeTrack.TimePosition - 0.45) < 1e-9
    and synchronizedBlendState.simulationTimingCalibration.observedBlendAnimationPlaybackSpeeds.idle.strike == 0.6
    and math.abs(synchronizedBlendState.simulationTimingCalibration.observedBlendAnimationStartPhases.idle.strike - 0.5) < 1e-9
    and synchronizedBlendState.phaseSync.maxCircularPhaseDifference == 0,
    "runtime synchronization should use actual Roblox lengths to align sample rates and normalized phase")
blendStrikeTrack.IsPlaying = false
local calibratedRestartOk, calibratedRestart = blendController:SetParameter("stamina", 0.75)
assert(calibratedRestartOk and table.concat(calibratedRestart.restartedStateIds, ",") == "strike"
    and math.abs(blendStrikeTrack.lastPlay[3] - 0.6) < 1e-9
    and math.abs(blendStrikeTrack.TimePosition - 0.45) < 1e-9,
    "runtime length calibration should persist when a blend source channel restarts")
assert(blendController:SetParameter("stamina", 0.5))
local leaveBlendOk = blendController:Trigger("attack")
assert(leaveBlendOk and blendController:GetState() == "strike")
local reenterBlendOk = blendController:Trigger("Release")
local reenteredStrikeSample = blendController.tracks["@blend:idle:2"]
assert(reenterBlendOk and blendController:GetState() == "idle"
    and math.abs(reenteredStrikeSample.Speed - 0.6) < 1e-9,
    "runtime length calibration should persist when leaving and re-entering the blend controller")
blendStrikeTrack.Length = 1
blendAnimator.failSpeedAnimationId = "rbxassetid://98765"
local idleTimeBeforeFailedSync = blendIdleTrack.TimePosition
local syncFailureOk, syncFailure = blendController:SynchronizeBlendPlayback()
assert(not syncFailureOk and syncFailure.reason == "blend_playback_sync_failed"
    and syncFailure.stateId == "strike" and #syncFailure.rollbackFailures == 0
    and math.abs(blendIdleTrack.Speed - 1) < 1e-9 and math.abs(blendIdleTrack.TimePosition - idleTimeBeforeFailedSync) < 1e-9
    and math.abs(blendStrikeTrack.Speed - 0.6) < 1e-9,
    "a failed runtime speed adjustment should roll back already-applied sample changes")
blendStrikeTrack.Length = 0.8
blendStrikeTrack.TimePosition = 0.4
blendStrikeTrack.IsPlaying = false
local incompletePhaseState = blendController:GetBlendState()
assert(not incompletePhaseState.phaseSync.complete
    and incompletePhaseState.phaseSync.observedCount == 1
    and incompletePhaseState.phaseSync.maxCircularPhaseDifference == 0
    and incompletePhaseState.phaseSync.unavailableStateIds[1] == "strike"
    and incompletePhaseState.simulationTimingCalibration.ready
    and incompletePhaseState.simulationTimingCalibration.observedBlendAnimationLengths.idle.strike == 0.8
    and incompletePhaseState.simulationTimingCalibration.observedBlendAnimationStartPhases == nil
    and incompletePhaseState.simulationTimingCalibration.unavailableStartPhaseStateIds[1] == "strike",
    "loaded lengths remain valid timing evidence even when a stopped track cannot contribute phase evidence")
local incompleteSyncOk, incompleteSync = blendController:SynchronizeBlendPlayback()
assert(not incompleteSyncOk and incompleteSync.reason == "blend_playback_not_ready"
    and incompleteSync.unavailableStateIds[1] == "strike"
    and math.abs(blendIdleTrack.Speed - 1) < 1e-9,
    "runtime synchronization should fail closed without changing any channel when a blend sample is stopped")
blendStrikeTrack.IsPlaying = true
blendStrikeTrack.Length = 0
local unloadedBlendState = blendController:GetBlendState()
assert(not unloadedBlendState.simulationTimingCalibration.ready
    and unloadedBlendState.simulationTimingCalibration.unavailableStateIds[1] == "strike"
    and unloadedBlendState.simulationTimingCalibration.unavailablePlaybackSpeedStateIds[1] == "strike"
    and unloadedBlendState.simulationTimingCalibration.observedBlendAnimationStartPhases == nil
    and unloadedBlendState.simulationTimingCalibration.observedBlendAnimationLengths == nil,
    "the simulator calibration map must be withheld until every source length is loaded")
local unloadedSyncOk, unloadedSync = blendController:SynchronizeBlendPlayback()
assert(not unloadedSyncOk and unloadedSync.reason == "blend_playback_not_ready"
    and unloadedSync.unavailableStateIds[1] == "strike",
    "runtime synchronization should fail closed while Roblox has not loaded every sample length")
blendStrikeTrack.Length = 0.8
blendStrikeTrack.IsPlaying = false
blendAnimator.failTimePositionAnimationId = "rbxassetid://98765"
local seekOk, seekFailure = blendController:SetParameter("stamina", 1)
assert(not seekOk and seekFailure.reason == "blend_channel_restart_failed"
    and seekFailure.stateId == "strike" and table.concat(seekFailure.restartedStateIds, ",") == "strike"
    and blendController:GetParameter("stamina") == 0.5 and not blendStrikeTrack.IsPlaying
    and blendStrikeTrack.lastStop == 0.05 and blendIdleTrack.WeightTarget == 0.5,
    "a failed phase seek after Play must roll back the newly started channel and restore previous blend targets; reason="
        .. tostring(seekFailure.reason) .. ", state=" .. tostring(seekFailure.stateId)
        .. ", started=" .. table.concat(seekFailure.restartedStateIds or {}, ",")
        .. ", speed=" .. tostring(blendStrikeTrack.Speed) .. ", time=" .. tostring(blendStrikeTrack.TimePosition)
        .. ", stop=" .. tostring(blendStrikeTrack.lastStop) .. ", idleTarget=" .. tostring(blendIdleTrack.WeightTarget))
blendAnimator.failTimePositionAnimationId = nil
blendIdleTrack.IsPlaying = false
blendStrikeTrack.IsPlaying = false
local phaseUnavailableOk, phaseUnavailableFailure = blendController:SetParameter("stamina", 0.75)
assert(not phaseUnavailableOk and phaseUnavailableFailure.reason == "blend_channel_restart_failed"
    and string.find(phaseUnavailableFailure.error, "no source playback clock")
    and phaseUnavailableFailure.phaseSourceStateId == nil and #phaseUnavailableFailure.restartedStateIds == 0
    and blendController:GetParameter("stamina") == 0.5,
    "the runtime must fail closed when every source clock is stopped instead of restarting at an invented phase")
blendIdleTrack.IsPlaying = true
blendAnimator.failPlayAnimationId = "rbxassetid://98765"
local restartOk, restartFailure = blendController:SetParameter("stamina", 1)
assert(not restartOk and restartFailure.reason == "blend_channel_restart_failed"
    and restartFailure.stateId == "strike" and blendController:GetParameter("stamina") == 0.5
    and blendIdleTrack.WeightTarget == 0.5 and not blendStrikeTrack.IsPlaying,
    "a failed stopped-channel restart must roll back other weights and leave parameters unchanged")
blendAnimator.failPlayAnimationId = nil
blendIdleTrack.IsPlaying = false
blendStrikeTrack.IsPlaying = true
blendStrikeTrack.TimePosition = 0.4
blendAnimator.failAdjustAnimationId = "rbxassetid://98765"
local partialRestartOk, partialRestartFailure = blendController:SetParameter("stamina", 0.75)
assert(not partialRestartOk and partialRestartFailure.reason == "blend_weight_update_failed"
    and partialRestartFailure.stateId == "strike" and partialRestartFailure.phaseSourceStateId == "strike"
    and table.concat(partialRestartFailure.restartedStateIds, ",") == "idle"
    and blendController:GetParameter("stamina") == 0.5
    and not blendIdleTrack.IsPlaying and blendIdleTrack.lastStop == 0.05
    and blendStrikeTrack.WeightTarget == 0.5,
    "a later channel failure must stop any earlier restarted channel with a safe fade and restore prior weights")
assert(blendController:SetPlaybackSpeed(1.5))
assert(blendController:SetParameter("stamina", 1))
local blendTransitionOk, blendTransition = blendController:Trigger("Attack")
assert(blendTransitionOk and blendTransition.transitionId == "heavy" and blendController:GetState() == "strike",
    "state transitions should leave the blend controller and enter the selected discrete state")
local discreteStrikeTrack = blendAnimator.loadedTrackList[#blendAnimator.loadedTrackList]
assert(blendIdleTrack.lastStop == 0.2 and discreteStrikeTrack.AnimationName == "strike" and discreteStrikeTrack.lastPlay[3] == 1.875,
    "transitioning out should fade only clips not shared with the destination, then apply destination speed")
local scaledReentryOk = blendController:Trigger("Release")
assert(scaledReentryOk and blendController:GetPlaybackSpeed() == 1.5
    and math.abs(blendIdleTrack.lastPlay[3] - 1.5) < 1e-9
    and math.abs(blendStrikeTrack.lastPlay[3] - 0.9) < 1e-9,
    "the playback-speed multiplier must persist when returning to a BlendSpace and scale every source proportionally")
blendController:Destroy()
local overlapBlendAnimator = makeAnimator()
local overlapBlendController = OverlapBlendController.new(overlapBlendAnimator)
local regularStrikeTrack = overlapBlendAnimator.loadedTrackList[1]
assert(regularStrikeTrack.AnimationName == "strike" and regularStrikeTrack.WeightCurrent == 1)
local overlapStarted, overlapResult = overlapBlendController:Trigger("Blend")
assert(overlapStarted and overlapResult.transitionId == "enterBlend")
local overlapBlendStrikeTrack = nil
for _, loadedTrack in ipairs(overlapBlendAnimator.loadedTrackList) do
    if loadedTrack.AnimationName == "@blend:idle:2" then overlapBlendStrikeTrack = loadedTrack end
end
assert(overlapBlendStrikeTrack ~= nil and overlapBlendStrikeTrack ~= regularStrikeTrack
    and overlapBlendStrikeTrack.AnimationId == regularStrikeTrack.AnimationId,
    "a clip already playing as a state must get an independent track when reused as a blend sample")
assert(regularStrikeTrack.WeightCurrent == 1 and regularStrikeTrack.WeightTarget == 0
    and overlapBlendStrikeTrack.WeightCurrent == 0 and overlapBlendStrikeTrack.WeightTarget == 0.5,
    "crossfading into a blend must preserve the outgoing track weight while fading its separate sample channel in")
local overlapBlendMarkerCalls = 0
overlapBlendController:ConnectMarker("BlendMarker", function() overlapBlendMarkerCalls += 1 end)
assert(overlapBlendStrikeTrack.markerSignals.BlendMarker == nil and overlapBlendMarkerCalls == 0,
    "a reused source clip must not connect duplicate controller marker events")
overlapBlendController:Destroy()
assert(next(overlapBlendController.tracks) == nil and next(overlapBlendController.animations) == nil
    and next(overlapBlendController.trackSourceStateIds) == nil,
    "destroying a graph controller must release every independent blend channel and its source mapping")
local failedWeightAnimator = makeAnimator(nil, nil, "rbxassetid://98765")
local failedWeightController = BlendController.new(failedWeightAnimator)
local failedWeightIdle = failedWeightAnimator.loadedTracks["rbxassetid://12345"]
local failedWeightStrike = failedWeightAnimator.loadedTracks["rbxassetid://98765"]
local weightsUpdated, weightFailure = failedWeightController:SetParameters({ stamina = 1, grounded = false })
assert(not weightsUpdated and weightFailure.reason == "blend_weight_update_failed" and weightFailure.stateId == "strike",
    "a failed per-track weight update should return structured diagnostics")
assert(failedWeightController:GetParameter("stamina") == 0.5 and failedWeightController:GetParameter("grounded") == true
    and failedWeightIdle.WeightTarget == 0.5
    and failedWeightStrike.WeightTarget == 0.5,
    "failed multi-clip updates should restore previous weights and must not commit the parameter")
assert(table.concat(weightFailure.attemptedStateIds, ",") == "idle,strike"
    and #weightFailure.restoredStateIds == 2 and #weightFailure.rollbackFailures == 0,
    "weight update failure should report attempted clips and successful rollback evidence")
failedWeightController:Destroy()
local extremeBlendAnimator = makeAnimator()
local extremeBlend = ExtremeBlendController.new(extremeBlendAnimator)
local extremeIdleTrack = extremeBlendAnimator.loadedTracks["rbxassetid://12345"]
local extremeStrikeTrack = extremeBlendAnimator.loadedTracks["rbxassetid://98765"]
for _, expected in ipairs(extremeBlendParityCases) do
    assert(extremeBlend:SetParameter("stamina", expected.value))
    local observed = extremeBlend:GetBlendState()
    assert(math.abs(observed.samples[1].expectedWeight - expected.idle) < 1e-12
        and math.abs(observed.samples[2].expectedWeight - expected.strike) < 1e-12
        and math.abs(extremeIdleTrack.WeightTarget - expected.idle) < 1e-12
        and math.abs(extremeStrikeTrack.WeightTarget - expected.strike) < 1e-12,
        "generated Luau must match TypeScript interpolation across overflowing finite sample spans")
end
extremeBlend:Destroy()
local failedBlendAnimator = makeAnimator("rbxassetid://98765")
local loadedBlend, blendLoadError = pcall(BlendController.new, failedBlendAnimator)
assert(not loadedBlend and string.find(tostring(blendLoadError), "Could not load entry animation state"),
    "failure to load any required blend source should fail controller construction")
assert(failedBlendAnimator.loadedTracks["rbxassetid://12345"].destroyed,
    "failed blend initialization should clean up earlier source tracks")
local partialBlendAnimator = makeAnimator(nil, "rbxassetid://98765")
local partialBlendController = PartialBlendController.new(partialBlendAnimator)
local partialPlayOk, partialPlayFailure = partialBlendController:Trigger("Blend")
assert(not partialPlayOk and partialPlayFailure.reason == "animation_play_failed"
    and partialPlayFailure.transitionId == "enterBlend" and partialPlayFailure.stateId == "strike",
    "a failed source Play during a blend transition should return structured failure evidence")
assert(partialBlendController:GetState() == "approach" and partialBlendController:GetParameter("stamina") == 0.5,
    "a partial blend Play failure must preserve the prior state and parameters")
assert(partialBlendAnimator.loadedTracks["rbxassetid://54321"].IsPlaying
    and not partialBlendAnimator.loadedTracks["rbxassetid://12345"].IsPlaying
    and not partialBlendAnimator.loadedTracks["rbxassetid://98765"].IsPlaying,
    "a partial blend Play failure must keep the old state running and stop every attempted destination source")
assert(table.concat(partialPlayFailure.cleanedUpStateIds, ",") == "idle,strike",
    "failure diagnostics should report destination tracks whose partial playback was rolled back")
partialBlendController:Destroy()
local fadeBlendAnimator = makeAnimator()
local fadeBlendController = PartialBlendController.new(fadeBlendAnimator)
local enteredBlend, enteredBlendResult = fadeBlendController:Trigger("Blend")
assert(enteredBlend and enteredBlendResult.transitionId == "enterBlend")
local fadingIdle = fadeBlendAnimator.loadedTracks["rbxassetid://12345"]
local fadingStrike = fadeBlendAnimator.loadedTracks["rbxassetid://98765"]
fadingIdle.WeightCurrent, fadingStrike.WeightCurrent = 0.25, 0.25
mockClock = 0.1
assert(fadeBlendController:SetParameter("stamina", 1))
assert(fadingIdle.lastAdjust.fade == 0.1 and fadingStrike.lastAdjust.fade == 0.1
    and fadingIdle.WeightCurrent == 0.25 and fadingStrike.WeightCurrent == 0.25
    and fadingIdle.WeightTarget == 0 and fadingStrike.WeightTarget == 1,
    "changing a blend parameter during entry crossfade should preserve the remaining fade instead of snapping to full weight")
local fadingBlendState = fadeBlendController:GetBlendState()
assert(fadingBlendState.totalCurrentWeight == 0.5 and fadingBlendState.totalTargetWeight == 1,
    "live diagnostics should distinguish in-progress track weights from their target weights")
fadeBlendController:Destroy()
mockClock = 0
local function runDirectionalBlendSmoke()
local directionalAnimator = makeAnimator()
local directionalController = DirectionalBlendController.new(directionalAnimator)
local directionalIdle = directionalAnimator.loadedTracks["rbxassetid://12345"]
local directionalRight = directionalAnimator.loadedTracks["rbxassetid://98765"]
local directionalMid = directionalAnimator.loadedTracks["rbxassetid://24680"]
local directionalForward = directionalAnimator.loadedTracks["rbxassetid://54321"]
local directionalState = directionalController:GetBlendState()
assert(directionalState.parameter.x == "moveX" and directionalState.parameter.y == "moveY"
    and directionalState.parameterValue.x == 0.25 and directionalState.parameterValue.y == 0.5
    and directionalState.samples[1].expectedWeight == 0
    and directionalState.samples[2].expectedWeight == 0.5
    and directionalState.samples[3].expectedWeight == 0
    and directionalState.samples[4].expectedWeight == 0.5,
    "the generated 2D runtime should match barycentric sample weights")
for _, case in ipairs(directionalParityCases) do
    directionalController:SetParameters({ moveX = case.x, moveY = case.y })
    local observed = directionalController:GetBlendState()
    assert(observed.parameterValue.x == case.x and observed.parameterValue.y == case.y
        and math.abs(observed.samples[1].expectedWeight - case.idle) < 1e-8
        and math.abs(observed.samples[2].expectedWeight - case.mid) < 1e-8
        and math.abs(observed.samples[3].expectedWeight - case.strike) < 1e-8
        and math.abs(observed.samples[4].expectedWeight - case.recover) < 1e-8,
        "generated Luau 2D weights diverged at " .. case.x .. "," .. case.y .. " expected="
            .. case.idle .. "," .. case.mid .. "," .. case.strike .. "," .. case.recover .. " actual="
            .. observed.samples[1].expectedWeight .. "," .. observed.samples[2].expectedWeight .. ","
            .. observed.samples[3].expectedWeight .. "," .. observed.samples[4].expectedWeight
            .. " params=" .. tostring(observed.parameterValue.x) .. "," .. tostring(observed.parameterValue.y))
end
do
    local ExtremeDirectionalBlendController = (function()
${extremeDirectionalRuntime.moduleSource}
    end)()
    local extremeDirectionalParityCases = {
${extremeDirectionalParityCases}
    }
    local extremeDirectionalAnimator = makeAnimator()
    local extremeDirectionalController = ExtremeDirectionalBlendController.new(extremeDirectionalAnimator)
    for _, case in ipairs(extremeDirectionalParityCases) do
        assert(extremeDirectionalController:SetParameters({ moveX = case.x, moveY = case.y }))
        local observed = extremeDirectionalController:GetBlendState()
        assert(math.abs(observed.samples[1].expectedWeight - case.idle) < 1e-8
            and math.abs(observed.samples[2].expectedWeight - case.mid) < 1e-8
            and math.abs(observed.samples[3].expectedWeight - case.strike) < 1e-8
            and math.abs(observed.samples[4].expectedWeight - case.recover) < 1e-8,
            "generated Luau 2D weights must stay finite and match editor output at extreme finite coordinates")
    end
    extremeDirectionalController:Destroy()
end
do
    local OutlierDirectionalBlendController = (function()
${outlierDirectionalRuntime.moduleSource}
    end)()
    local outlierDirectionalController = OutlierDirectionalBlendController.new(makeAnimator())
    assert(outlierDirectionalController:SetParameters({ moveX = 0.025, moveY = 0.025 }))
    local observed = outlierDirectionalController:GetBlendState()
    assert(math.abs(observed.samples[1].expectedWeight - ${outlierWeightByState.idle}) < 1e-10
        and math.abs(observed.samples[2].expectedWeight - ${outlierWeightByState.mid}) < 1e-10
        and math.abs(observed.samples[3].expectedWeight - ${outlierWeightByState.strike}) < 1e-10
        and math.abs(observed.samples[4].expectedWeight - ${outlierWeightByState.recover}) < 1e-10,
        "generated Luau must preserve a local blend triangle beside a distant finite outlier")
    outlierDirectionalController:Destroy()
end
local outsideOk, outsideResult = directionalController:SetParameters({ moveX = 0.8, moveY = 0.8 })
local outsideState = directionalController:GetBlendState()
assert(outsideOk and outsideState.clamped and math.abs(outsideState.sampledValue.x - 0.5) < 1e-9
    and math.abs(outsideState.sampledValue.y - 0.5) < 1e-9
    and outsideState.samples[1].targetWeight == 0
    and outsideState.samples[2].targetWeight == 0
    and math.abs(outsideState.samples[3].targetWeight - 0.5) < 1e-9
    and math.abs(outsideState.samples[4].targetWeight - 0.5) < 1e-9
    and directionalIdle.WeightTarget == 0 and directionalMid.WeightTarget == 0
    and directionalRight.WeightTarget == 0.5 and directionalForward.WeightTarget == 0.5,
    "outside-hull parameter changes should project to the nearest edge and update live AnimationTrack weights")
local collinearEdgeOk = directionalController:SetParameters({ moveX = 0.5, moveY = -0.5 })
local collinearEdgeState = directionalController:GetBlendState()
assert(collinearEdgeOk and collinearEdgeState.clamped
    and collinearEdgeState.samples[1].targetWeight == 0
    and collinearEdgeState.samples[2].targetWeight == 1
    and collinearEdgeState.samples[3].targetWeight == 0
    and collinearEdgeState.samples[4].targetWeight == 0
    and directionalMid.WeightTarget == 1,
    "outside-hull projection should preserve authored intermediate clips on collinear hull edges")
local centerOk = directionalController:SetParameters({ moveX = 0, moveY = 0 })
assert(centerOk and directionalIdle.WeightTarget == 1 and directionalRight.WeightTarget == 0 and directionalForward.WeightTarget == 0,
    "2D runtime parameter updates should restore exact sample weights")
directionalController:Destroy()
mockClock = 0
end
runDirectionalBlendSmoke()
print("Generated graph runtime passed Luau behavior smoke test")
`;
  try {
    await writeFile(scriptPath, harness);
    const result = spawnSync(process.env.LUAU_EXECUTABLE ?? join(process.cwd(), '.local', 'tools', 'luau-0.737', 'luau.exe'), [scriptPath], { encoding: 'utf8' });
    if (result.error) throw result.error;
    const failedLine = Number(result.stderr.match(/runtime-test\.luau:(\d+)/)?.[1] ?? 0);
    const context = failedLine > 0 ? harness.split('\n').slice(Math.max(0, failedLine - 4), failedLine + 1).map((line, index) => `${Math.max(1, failedLine - 3) + index}: ${line}`).join('\n') : '';
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${context}`);
    assert.match(result.stdout, /Generated graph runtime passed Luau behavior smoke test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
