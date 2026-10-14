import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../src/inspection.js';
import { Connections, WindowsSecrets, providerClient, type Complete } from '../src/providers.js';
import { Authoring, authoringSystemPrompt } from '../src/authoring.js';
import { Library } from '../src/library.js';
import { animationPreset, vfxPreset } from '../src/recipes.js';
import { Queue, startBridge } from '../src/bridge.js';
import { PoseLibrary } from '../src/pose-library.js';
import { MotionApp } from '../src/app.js';
import { mappedAnimationTargets } from '../src/export-targets.js';

const fakeCodec = { protect: async (text: string) => Buffer.from(text).toString('base64'), unprotect: async (text: string) => Buffer.from(text, 'base64').toString() };
const key = 'test-key-that-is-not-real';
async function fixture(complete?: Complete) {
  const root = await mkdtemp(join(tmpdir(), 'motion-app-'));
  const library = new Library(join(root, 'artifacts/library')), queue = new Queue();
  const connections = new Connections(join(root, '.local/providers.json'), fakeCodec, {});
  await connections.save({ provider: 'deepseek', model: 'test-model', apiKey: key });
  const authoring = new Authoring(library, queue, connections, root, complete);
  return { root, library, queue, connections, authoring };
}
const draft = () => ({ approach: 'Standard R15 weight shifts', checkpoints: ['Check planted feet', 'Inspect loop transition'], avoid: ['Foot sliding'], recipe: animationPreset('walk', 'Walk', 1.2, 1) });
async function wait(authoring: Authoring, id: string) {
  for (let i = 0; i < 200; i++) { const job = authoring.get(id); if (job.status !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Draft timed out in test');
}

test('connections keep session keys out of disk and API responses; remembered keys survive restart and can be removed', async () => {
  const { root, connections } = await fixture();
  const path = join(root, '.local/providers.json');
  assert.equal((await readFile(path, 'utf8')).includes(key), false);
  assert.equal(JSON.stringify(await connections.list()).includes(key), false);
  await assert.rejects(new Connections(path, fakeCodec, {}).credential('deepseek'), /Connect/);
  await connections.save({ provider: 'deepseek', model: 'changed-model', remember: true });
  assert.equal((await readFile(path, 'utf8')).includes(key), false);
  const restarted = new Connections(path, fakeCodec, {});
  assert.equal((await restarted.credential('deepseek')).apiKey, key);
  assert.equal((await restarted.credential('deepseek')).model, 'changed-model');
  assert.equal((await restarted.list()).find(p => p.id === 'deepseek')?.source, 'remembered');
  await restarted.remove('deepseek');
  await assert.rejects(restarted.credential('deepseek'), /Connect/);
  assert.equal((await readFile(path, 'utf8')).includes('encryptedKey'), false);
});

test('Windows DPAPI round trip does not persist or echo a plaintext key', { skip: process.platform !== 'win32' }, async () => {
  const codec = new WindowsSecrets();
  const encrypted = await codec.protect(key);
  assert.ok(encrypted.length > key.length); assert.equal(encrypted.includes(key), false);
  assert.equal(await codec.unprotect(encrypted), key);
});

test('provider adapters use fixed official endpoints, correct auth, limits, no redirects, and normalize token usage', async () => {
  for (const provider of ['claude', 'deepseek', 'glm'] as const) {
    const client = providerClient(async (url, init) => {
      const request = JSON.parse(init!.body as string), headers = init!.headers as Record<string, string>;
      assert.match(String(url), provider === 'claude' ? /^https:\/\/api.anthropic.com\/v1\/messages$/ : provider === 'deepseek' ? /^https:\/\/api.deepseek.com\/chat\/completions$/ : /^https:\/\/api.z.ai\/api\/paas\/v4\/chat\/completions$/);
      assert.equal(request.max_tokens, 4000); assert.equal(request.stream, false); assert.equal(init!.redirect, 'error');
      assert.equal((init!.body as string).includes(key), false);
      if (provider === 'claude') { assert.equal(headers['x-api-key'], key); assert.equal(headers['anthropic-workspace-id'], 'workspace-test'); assert.equal(request.system, 'system'); }
      else { assert.equal(headers.Authorization, `Bearer ${key}`); assert.equal(request.messages[0].content, 'system'); assert.equal(request.thinking.type, 'disabled'); }
      return Response.json(provider === 'claude' ? { content: [{ type: 'thinking', thinking: 'ignore' }, { type: 'text', text: '{"draft":true}' }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: 'end_turn' } : { choices: [{ message: { content: '{"draft":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    const result = await client({ provider, model: 'example', apiKey: key, workspace: 'workspace-test' }, 'system', 'prompt', 4000, new AbortController().signal);
    assert.equal(result.text, '{"draft":true}'); assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
  }
});

test('provider failures do not echo upstream secrets; truncated and oversized output is rejected', async () => {
  const credential = { provider: 'deepseek' as const, model: 'test', apiKey: key, workspace: '' };
  for (const response of [new Response(key, { status: 401 }), Response.json({ choices: [{ finish_reason: 'length' }] }), new Response('a'.repeat(2_000_001))]) {
    const client = providerClient(async () => response);
    await assert.rejects(client(credential, '', '', 2000, new AbortController().signal), error => error instanceof Error && !error.message.includes(key));
  }
});

test('provider adapters reject malformed response shapes and identify truncated Claude output', async () => {
  const credential = { provider: 'deepseek' as const, model: 'test', apiKey: key, workspace: '' };
  const malformed: Array<{ provider: 'claude' | 'deepseek' | 'glm'; body: unknown }> = [
    { provider: 'claude', body: { content: 'not-an-array' } },
    { provider: 'deepseek', body: { choices: { message: { content: '{}' } } } },
    { provider: 'glm', body: { choices: [{ message: { content: 42 } }] } },
  ];
  for (const item of malformed) {
    const client = providerClient(async () => Response.json(item.body));
    await assert.rejects(client({ ...credential, provider: item.provider }, '', '', 2000, new AbortController().signal), /unexpected response shape/);
  }
  const claude = providerClient(async () => Response.json({ content: [{ type: 'text', text: '{}' }], stop_reason: 'max_tokens' }));
  await assert.rejects(claude({ ...credential, provider: 'claude' }, '', '', 2000, new AbortController().signal), /output token limit/);
});

test('library filtering happens before pagination and returns every animation revision after restart', async () => {
  const { library } = await fixture();
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) { ids.push((await library.save(animationPreset('idle', 'Same name', 1, 1), ids.at(-1))).id); await library.save(vfxPreset('impact', 'Effect')); }
  const restarted = new Library(library.directory), found = new Set<string>(); let offset: number | null = 0;
  do { const page = await restarted.list(offset, 2, 'animation'); assert.equal(page.total, 7); for (const asset of page.assets) { assert.equal(asset.kind, 'animation'); found.add(asset.id); } offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual([...found].sort(), ids.sort());
});

test('generation saves validated immutable drafts with a pending visual workflow, usage, and optional single repair', async () => {
  let calls = 0;
  const f = await fixture(async () => ({ text: JSON.stringify(++calls === 1 ? { ...draft(), recipe: { ...draft().recipe, duration: -2 } } : draft()), usage: { inputTokens: 100, outputTokens: 300 } }));
  const parent = await f.library.save(animationPreset('walk', 'Original', 1, 1));
  const first = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Walk with weight', parentId: parent.id, repair: true });
  assert.throws(() => f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Double click' }), /already running/);
  const result = await wait(f.authoring, first.id);
  assert.equal(result.status, 'succeeded', result.error); assert.equal(calls, 2);
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 600 });
  const saved = await f.library.get(result.assetId!); assert.equal(saved.parentId, parent.id);
  assert.equal((await f.library.get(parent.id)).recipe.name, 'Original');
  const provenance = JSON.parse(await readFile(join(f.root, 'artifacts/generations', `${saved.id}.json`), 'utf8'));
  assert.equal(provenance.reviewed, false); assert.equal(JSON.stringify(provenance).includes(key), false);
  assert.equal(result.motionAudit?.summary.tracks, 6, 'generated animations should receive the deterministic motion audit immediately');
  assert.ok(result.motionAudit?.advisories.some(advisory => advisory.id === 'synchronized-timing'),
    'the audit should surface structural timing cues without rejecting the draft');
  assert.ok((result.motionAudit?.refinementTargets.length ?? 0) <= 4, 'provider-facing audit detail should stay bounded');
  assert.match(result.motionAudit?.limitation ?? '', /cannot certify an artistic result/i);
  assert.deepEqual(provenance.motionAudit, JSON.parse(JSON.stringify(result.motionAudit)),
    'the exact compact audit should be available in generation provenance after restart');
  const workflow = JSON.parse(await readFile(join(f.root, 'artifacts/workflows', result.workflowId!, '000001.json'), 'utf8'));
  assert.equal(workflow.brief.request, 'Walk with weight'); assert.equal(workflow.candidates.length, 0);
});

test('invalid output does not silently retry or save; cancellation saves no draft', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { text: '{bad', usage: { inputTokens: 1, outputTokens: 1 } }; });
  const result = await wait(f.authoring, f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Walk' }).id);
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal((await f.library.list()).total, 0);
  const cancelled = await fixture(async (_a, _b, _c, _d, signal) => { await new Promise<void>((resolve, reject) => { if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); throw new Error('unreachable'); });
  const job = cancelled.authoring.start({ provider: 'deepseek', kind: 'vfx', prompt: 'Fire' }); cancelled.authoring.cancel(job.id);
  assert.equal((await wait(cancelled.authoring, job.id)).status, 'cancelled'); assert.equal((await cancelled.library.list()).total, 0);
});

test('selected rig is inspected before generation and unknown animated names are rejected', async () => {
  let gotContext = false;
  let gotMeasuredRigContext = false;
  let gotVisualGeometry = false;
  let conflictingGeometryWasExcluded = false;
  let gotAiRigSummary = false;
  let systemPrompt = '';
  const f = await fixture(async (_c, instructions, prompt) => {
    systemPrompt = instructions;
    const payload = JSON.parse(prompt) as { rig: { rigType?: string; visualGeometryLimitations?: string; roleEvidenceLimitations?: string;
      directlyAnimatableJointNames?: string[]; semanticRoles?: { role: string; status: string; joint?: string;
        jointContext?: { chainStatus: string; jointNames: string[] } }[];
      joints?: { name: string; segmentLengthStuds?: number; restBasisQuaternion?: number[];
        visualGeometry?: { dimensionsStuds: number[]; partClass: string; transparency: number } }[] } };
    gotContext = payload.rig.joints?.some(joint => joint.name === 'OnlyDrivenJoint') ?? false;
    gotMeasuredRigContext = payload.rig.rigType === 'custom' && payload.rig.joints?.some(joint =>
      joint.name === 'OnlyDrivenJoint' && joint.segmentLengthStuds === 1
      && JSON.stringify(joint.restBasisQuaternion) === '[0,0,0,1]') === true;
    gotVisualGeometry = payload.rig.joints?.some(joint => joint.name === 'OnlyDrivenJoint'
      && joint.visualGeometry?.partClass === 'Part' && joint.visualGeometry.transparency === 0.25
      && JSON.stringify(joint.visualGeometry.dimensionsStuds) === '[1,3,1]') === true
      && /not mesh bounds/.test(payload.rig.visualGeometryLimitations ?? '');
    conflictingGeometryWasExcluded = payload.rig.joints?.some(joint => joint.name === 'RightUpperArm' && joint.visualGeometry !== undefined) === false;
    gotAiRigSummary = payload.rig.directlyAnimatableJointNames?.includes('OnlyDrivenJoint') === true
      && payload.rig.directlyAnimatableJointNames.includes('RightUpperArm')
      && payload.rig.semanticRoles?.some(role => role.role === 'right_shoulder' && role.status === 'inferred' && role.joint === 'RightUpperArm'
        && role.jointContext?.chainStatus === 'parent_missing' && JSON.stringify(role.jointContext.jointNames) === '["RightUpperArm"]') === true
      && payload.rig.semanticRoles?.some(role => role.role === 'right_elbow' && role.status === 'unavailable') === true
      && /neither proves anatomy/i.test(payload.rig.roleEvidenceLimitations ?? '')
      && /parent_missing.*incomplete ancestry/i.test(payload.rig.roleEvidenceLimitations ?? '');
    return { text: JSON.stringify(draft()), usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'unknown-joint-rig-signature';
  const profile = { version: 1 as const, rigId, rigName: 'Rig', rigType: 'custom' as const, rigSignature,
    joints: [
      { name: 'RootControl', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'OnlyDrivenJoint', parent: 'RootControl', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
      { name: 'RightUpperArm', parent: 'MissingRoot', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    ] };
  f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Walk', sessionId, rigId });
  const timer = setInterval(() => { const command = f.queue.poll(sessionId); if (command) { assert.equal(command.operation, 'inspect'); f.queue.complete(sessionId, command.id, true, { id: rigId, rigSignature, retargetProfile: profile, animatedNames: [{ name: 'OnlyDrivenJoint', parent: 'RootControl', driven: true,
    visualGeometry: { source: 'BasePart.Size', dimensionsStuds: [1, 3, 1], partClass: 'Part', transparency: 0.25, shape: 'Enum.PartType.Block' } },
    { name: 'RightUpperArm', parent: 'WrongParent', driven: true,
      visualGeometry: { source: 'BasePart.Size', dimensionsStuds: [20, 20, 20], partClass: 'Part', transparency: 0, shape: 'Enum.PartType.Block' } }] }); } }, 10);
  try {
    assert.equal((await wait(f.authoring, job.id)).status, 'failed');
    assert.equal(gotContext, true);
    assert.equal(gotMeasuredRigContext, true, 'generation should receive validated rig type, proportions, and rest-basis reference');
    assert.equal(gotVisualGeometry, true, 'generation should receive validated visible-part proportions and caveats');
    assert.equal(conflictingGeometryWasExcluded, true, 'generation must not attach visual evidence to a node whose parent conflicts with the inspected hierarchy');
    assert.equal(gotAiRigSummary, true, 'generation should receive exact driven channels and cautious custom-role name evidence');
    assert.match(systemPrompt, /rig\.directlyAnimatableJointNames as the exact channel allow-list/i);
    assert.match(systemPrompt, /Never guess an ambiguous or unavailable target/i);
    assert.match(systemPrompt, /parent_missing, cycle_detected, and depth_capped as incomplete hierarchy evidence/i);
    assert.equal((await f.library.list()).total, 0);
  } finally { clearInterval(timer); }
});

test('targeted AI revisions retain incomplete joint ancestry in the inspected-rig context', async () => {
  let gotIncompleteAncestry = false;
  let calls = 0;
  const f = await fixture(async (_credential, _instructions, prompt) => {
    calls++;
    const payload = JSON.parse(prompt) as { rig: { semanticRoles?: { role: string; status: string; joint?: string;
      jointContext?: { chainStatus: string; jointNames: string[] } }[] } };
    gotIncompleteAncestry = payload.rig.semanticRoles?.some(role => role.role === 'right_shoulder'
      && role.status === 'inferred' && role.joint === 'RightUpperArm'
      && role.jointContext?.chainStatus === 'parent_missing'
      && JSON.stringify(role.jointContext.jointNames) === '["RightUpperArm"]') === true;
    return { text: JSON.stringify({ approach: 'Refine the existing shoulder key.', checkpoints: ['Review the shoulder arc'], avoid: [],
      operations: [{ operation: 'set_pose', joint: 'RightUpperArm', time: 0.5, rotation: [-35, 0, 0] }] }),
      usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const rigId = randomUUID(), sessionId = randomUUID(), rigSignature = 'revision-rig-signature';
  const recipe = animationPreset('slash', 'Original slash', 1, 1);
  const parent = await f.library.save(recipe);
  f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  const feedback = { reviewId: randomUUID(), reviewRevision: 2, sourceReviewRevision: 1, assetId: parent.id,
    assetHash: fingerprint(parent.recipe), liked: 'Keep the attack timing.', changes: 'Reduce the shoulder lift.', overall: 'refine',
    answers: [], measuredFindings: [], reservation: randomUUID() };
  const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: feedback.changes, parentId: parent.id, sessionId, rigId }, feedback);
  const profile = { version: 1 as const, rigId, rigName: 'Revision Rig', rigType: 'custom' as const, rigSignature,
    joints: [
      { name: 'RootControl', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      { name: 'RightUpperArm', parent: 'MissingRoot', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
      { name: 'UpperTorso', parent: 'RootControl', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
    ] };
  const timer = setInterval(() => {
    const command = f.queue.poll(sessionId);
    if (command) {
      assert.equal(command.operation, 'inspect');
      f.queue.complete(sessionId, command.id, true, { id: rigId, rigSignature, retargetProfile: profile,
        animatedNames: [{ name: 'RightUpperArm', parent: 'MissingRoot', driven: true },
          { name: 'UpperTorso', parent: 'RootControl', driven: true }] });
    }
  }, 10);
  try {
    const result = await wait(f.authoring, job.id);
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(calls, 1, 'a valid targeted patch should be applied in one provider call');
    assert.equal(gotIncompleteAncestry, true, 'targeted revisions must receive the same explicit incomplete-chain evidence as new drafts');
    const revised = await f.library.get(result.assetId!);
    assert.equal(revised.parentId, parent.id);
    assert.deepEqual(revised.recipe.kind === 'animation' && revised.recipe.tracks.find(track => track.joint === 'RightUpperArm')?.keys[2]?.rotation,
      [-35, 0, 0]);
    const provenance = JSON.parse(await readFile(join(f.root, 'artifacts/generations', `${revised.id}.json`), 'utf8')) as { revisionMode?: string };
    assert.equal(provenance.revisionMode, 'targeted_patch');
  } finally { clearInterval(timer); }
});

test('one-shot generation repair catches unsupported root-motion, layer, and unprofiled joints before save', async () => {
  for (const invalidChannel of ['rootMotion', 'layer', 'profileMismatch'] as const) {
    let calls = 0;
    let repairPrompt = '';
    const baseRecipe = draft().recipe;
    const drivenTrack = { ...baseRecipe.tracks[0]!, joint: 'OnlyDrivenJoint' };
    const inactiveLayerTrack = { ...drivenTrack, joint: 'OptionalJoint' };
    const validRecipe = { ...baseRecipe, tracks: [drivenTrack], layers: [{ id: randomUUID(), name: 'Optional secondary motion',
      blendMode: 'Additive' as const, weight: 0.5, enabled: false, tracks: [inactiveLayerTrack] }] };
    const unsupportedJoint = invalidChannel === 'rootMotion' ? 'UnknownRootMotionJoint'
      : invalidChannel === 'layer' ? 'UnknownLayerJoint' : 'UnprofiledDrivenJoint';
    const invalidRecipe = invalidChannel === 'rootMotion'
      ? { ...validRecipe, rootMotion: { ...drivenTrack, joint: unsupportedJoint } }
      : invalidChannel === 'layer'
        ? { ...validRecipe, layers: [{ id: randomUUID(), name: 'Generated layer', blendMode: 'Additive' as const,
          weight: 1, enabled: true, tracks: [{ ...drivenTrack, joint: unsupportedJoint }] }] }
        : { ...validRecipe, tracks: [{ ...drivenTrack, joint: unsupportedJoint }] };
    const f = await fixture(async (_credential, _system, prompt) => {
      calls++;
      if (calls === 2) repairPrompt = prompt;
      const generated = { ...draft(), recipe: calls === 1 ? invalidRecipe : validRecipe };
      return { text: JSON.stringify(generated), usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = `authoring-${invalidChannel}-validation`;
    const profile = { version: 1 as const, rigId, rigName: 'Single driven joint rig', rigType: 'custom' as const, rigSignature,
      joints: [
        { name: 'OnlyDrivenJoint', parent: '', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
        { name: 'OptionalJoint', parent: '', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 1 },
      ] };
    f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
    const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: `Make a test animation with invalid ${invalidChannel} channel`, sessionId, rigId, repair: true });
    const timer = setInterval(() => {
      const command = f.queue.poll(sessionId);
      if (command) {
        assert.equal(command.operation, 'inspect');
        f.queue.complete(sessionId, command.id, true, { id: rigId, rigSignature, retargetProfile: profile,
          animatedNames: [{ name: 'OnlyDrivenJoint', driven: true }, { name: 'OptionalJoint', driven: true },
            ...(invalidChannel === 'profileMismatch' ? [{ name: unsupportedJoint, driven: true }] : [])] });
      }
    }, 10);
    try {
      const result = await wait(f.authoring, job.id);
      assert.equal(result.status, 'succeeded', result.error);
      assert.equal(calls, 2, `${invalidChannel} joint should be rejected before the save path and repaired once`);
      assert.ok(repairPrompt.includes(unsupportedJoint), 'repair prompt should name the exact unsupported channel joint');
      assert.equal(result.rigCoverage?.channelCoverage.drivenJointCount, 2);
      assert.equal(result.rigCoverage?.channelCoverage.coveredDrivenJointCount, 1);
      assert.deepEqual(result.rigCoverage?.channelCoverage.unresolvedTrackJoints, []);
      assert.deepEqual(result.rigCoverage?.nextActions, [{ code: 'review_inactive_layer_channels', joints: ['OptionalJoint'],
        layerIds: [validRecipe.layers[0]!.id], recommendedAction: 'Review whether these disabled or zero-weight layer channels are intentional. Enable or raise a layer weight only if it should contribute; Motion Tools did not change it.' }]);
      assert.equal(result.rigCoverage?.semanticRoleCoverage.summary.roleCount, 16);
      assert.match(result.rigCoverage?.semanticRoleCoverage.limitation ?? '', /not a quality score or quota/i);
      const saved = await f.library.get(result.assetId!);
      assert.deepEqual(saved.recipe.kind === 'animation'
        ? [...saved.recipe.tracks.map(track => track.joint), ...(saved.recipe.rootMotion ? [saved.recipe.rootMotion.joint] : []),
          ...(saved.recipe.layers ?? []).flatMap(layer => layer.tracks.map(track => track.joint))]
        : [], ['OnlyDrivenJoint', 'OptionalJoint']);
      const provenance = JSON.parse(await readFile(join(f.root, 'artifacts/generations', `${saved.id}.json`), 'utf8')) as { rigCoverage?: unknown };
      assert.deepEqual(provenance.rigCoverage, JSON.parse(JSON.stringify(result.rigCoverage)),
        'persisted provenance and the JSON-serialized generation job should expose the same derived coverage');
    } finally { clearInterval(timer); f.authoring.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test('generation aborts without saving if the selected rig changes while the provider is composing the draft', async () => {
  let changeSelection = () => {};
  const f = await fixture(async () => { changeSelection(); return { text: JSON.stringify(draft()), usage: { inputTokens: 1, outputTokens: 1 } }; });
  const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'generation-rig-v1', otherRigId = randomUUID();
  const recipe = draft().recipe;
  const profile = { version: 1 as const, rigId, rigName: 'Selected rig', rigType: 'R15' as const, rigSignature,
    joints: [{ name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      ...recipe.tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 }))] };
  f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature } });
  changeSelection = () => f.queue.heartbeat(sessionId, { activeRig: { id: otherRigId, rigSignature: 'other-rig-v1' } });
  const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Create an in-place walk', sessionId, rigId });
  const timer = setInterval(() => {
    const command = f.queue.poll(sessionId);
    if (command) { assert.equal(command.operation, 'inspect'); f.queue.complete(sessionId, command.id, true, { id: rigId, rigSignature, animatedNames: profile.joints.map(({ name, parent, driven }) => ({ name, parent, driven })), retargetProfile: profile }); }
  }, 10);
  try {
    const result = await wait(f.authoring, job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /selected Motion Tools rig changed during generation/);
    assert.equal((await f.library.list()).total, 0);
  } finally { clearInterval(timer); f.authoring.close(); }
});

test('generated animation drafts retain the exact inspected rig profile as asset provenance', async () => {
  const f = await fixture(async () => ({ text: JSON.stringify(draft()), usage: { inputTokens: 1, outputTokens: 1 } }));
  const sessionId = randomUUID(), rigId = randomUUID(), recipe = draft().recipe;
  const profile = {
    version: 1 as const, rigId, rigName: 'Inspected source rig', rigType: 'R15' as const, rigSignature: 'inspected-source-signature',
    joints: [
      { name: 'HumanoidRootPart', parent: '', driven: false, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 0 },
      ...recipe.tracks.map(track => ({ name: track.joint, parent: 'HumanoidRootPart', driven: true, basis: [0, 0, 0, 1] as [number, number, number, number], segmentLength: 2 })),
    ],
  };
  f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature: profile.rigSignature } });
  const job = f.authoring.start({ provider: 'deepseek', kind: 'animation', prompt: 'Create an in-place walk', sessionId, rigId });
  const timer = setInterval(() => {
    const command = f.queue.poll(sessionId);
    if (command) { assert.equal(command.operation, 'inspect'); f.queue.complete(sessionId, command.id, true, { id: rigId, rigSignature: profile.rigSignature, animatedNames: profile.joints.map(({ name, parent, driven }) => ({ name, parent, driven })), retargetProfile: profile }); }
  }, 10);
  try {
    const result = await wait(f.authoring, job.id);
    assert.equal(result.status, 'succeeded', result.error);
    const saved = await f.library.get(result.assetId!);
    assert.deepEqual(saved.sourceRigProfile, profile);
  } finally { clearInterval(timer); f.authoring.close(); }
});

test('browser app separates auth from Studio, blocks hostile origins, and confirms preview/save through jobs', async () => {
  const f = await fixture(), app = new MotionApp('browser-token', f.library, f.queue, f.connections, f.root, f.authoring);
  const poses = new PoseLibrary(join(f.root, 'artifacts', 'poses'));
  const bridge = await startBridge(f.queue, 'studio-token', 0, { library: f.library, poses, app, files: { '/app': { type: 'text/html', content: 'local app' } } });
  const url = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
  const post = (path: string, input: unknown = {}, token = 'browser-token', origin = url) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(input) });
  try {
    const page = await fetch(url + '/app'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await post('/app-api/state', {}, 'studio-token')).status, 403);
    assert.equal((await post('/app-api/state', {}, 'browser-token', 'https://evil.example')).status, 403);
    assert.equal((await post('/app-api/state', {}, 'browser-token', 'null')).status, 403);
    const state = await post('/app-api/state'); assert.equal(state.status, 200); assert.equal((await state.text()).includes(key), false);
    assert.equal((await post('/poll', {}, 'studio-token')).status, 403);
    const sessionId = randomUUID(), rigId = randomUUID(), rigSignature = 'browser-save-rig-v1'; f.queue.heartbeat(sessionId, { activeRig: { id: rigId, rigSignature }, selection: [{ id: rigId, name: 'Fixture' }] });
    const asset = await f.library.save(draft().recipe);
    const reusablePose = await poses.save({ name: 'Bridge Pose', transforms: [{ joint: 'UpperTorso', rotation: [5, 0, 0] }] });
    const poseListing = await post('/poses/list', { query: 'bridge' }, 'studio-token', '');
    assert.equal((await poseListing.json() as { total: number }).total, 1);
    const poseRead = await post('/poses/read', { id: reusablePose.id }, 'studio-token', '');
    assert.equal((await poseRead.json() as { pose: { name: string } }).pose.name, 'Bridge Pose');
    assert.equal((await post('/poses/list', {}, 'studio-token', url)).status, 403);
    const listing = await post('/library/list', { kind: 'animation' }, 'studio-token', ''); assert.equal((await listing.json() as any).total, 1);
    assert.equal((await post('/library/read', { id: '../../secrets' }, 'studio-token', '')).status, 400);
    const action = { sessionId, rigId, assetId: asset.id };
    const preview = await (await post('/app-api/preview', action)).json() as { id: string; status: string };
    assert.equal(preview.status, 'queued');
    const previewCommand = f.queue.poll(sessionId)!; assert.equal(previewCommand.id, preview.id); assert.equal(previewCommand.operation, 'preview');
    f.queue.complete(sessionId, preview.id, true, { played: true });
    const assetFingerprint = fingerprint((await f.library.get(asset.id)).recipe);
    assert.equal((await post('/app-api/save', action)).status, 400, 'save is rejected without an export preflight and exact-revision approval');
    assert.equal(f.queue.poll(sessionId), null, 'rejected save does not enqueue a Studio command');
    const preflight = await (await post('/app-api/save-preflight', action)).json() as { id: string; status: string };
    assert.equal(preflight.status, 'queued');
    const preflightCommand = f.queue.poll(sessionId)!;
    assert.equal(preflightCommand.id, preflight.id); assert.equal(preflightCommand.operation, 'validate_animation_export');
    const preflightPayload = preflightCommand.payload as { assetId: string; assetFingerprint: string; rigId: string; rigSignature: string; jointMap: Record<string, string> };
    assert.equal(preflightPayload.assetId, asset.id); assert.equal(preflightPayload.assetFingerprint, assetFingerprint);
    assert.equal(preflightPayload.rigId, rigId); assert.equal(preflightPayload.rigSignature, rigSignature); assert.deepEqual(preflightPayload.jointMap, {});
    const exportRecipe = (await f.library.get(asset.id)).recipe;
    if (exportRecipe.kind !== 'animation') throw new Error('Fixture should be an animation.');
    const mappedTargetJoints = mappedAnimationTargets(exportRecipe, {});
    f.queue.complete(sessionId, preflight.id, true, { valid: true, assetId: asset.id, assetFingerprint, rigId, rigSignature,
      frameCount: 12, poseCount: 24, markerCount: 0, animatedTrackCount: mappedTargetJoints.length, mappedTargetJoints,
      format: 'KeyframeSequence', saved: false, note: 'Converted successfully.' });
    assert.equal((await post('/app-api/save', { ...action, preflightJobId: preflight.id, userApprovedFingerprint: 'b'.repeat(64) })).status, 400,
      'mismatched approval fingerprint is rejected');
    assert.equal(f.queue.poll(sessionId), null, 'mismatched approval does not enqueue a save');
    const save = await (await post('/app-api/save', { ...action, preflightJobId: preflight.id, userApprovedFingerprint: assetFingerprint })).json() as { id: string; status: string };
    assert.equal(save.status, 'queued');
    const saveCommand = f.queue.poll(sessionId)!; assert.equal(saveCommand.id, save.id); assert.equal(saveCommand.operation, 'save_animation');
    const savePayload = saveCommand.payload as { assetId: string; assetFingerprint: string; rigSignature: string; preflightFingerprint: string };
    assert.equal(savePayload.assetId, asset.id); assert.equal(savePayload.assetFingerprint, assetFingerprint); assert.equal(savePayload.rigSignature, rigSignature);
    assert.match(savePayload.preflightFingerprint, /^[a-f0-9]{64}$/);
    f.queue.complete(sessionId, save.id, true, { saved: 'test', kind: 'KeyframeSequence' });
    assert.equal((await (await post('/app-api/job', { id: save.id })).json() as { status: string }).status, 'succeeded');
  } finally { f.authoring.close(); bridge.close(); bridge.closeAllConnections(); }
});
