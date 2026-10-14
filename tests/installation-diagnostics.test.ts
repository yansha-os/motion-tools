import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Queue } from '../src/bridge.js';
import { Library } from '../src/library.js';
import { Blender } from '../src/blender.js';
import { createMcp } from '../src/server.js';
import { assembleStudioPlugin, pairStudioPlugin, studioModuleNames } from '../src/plugin-bundle.js';
import { diagnoseInstallation } from '../src/installation-diagnostics.js';
import { createBuildIdentity, readBuildIdentity, runningBuildIdentity } from '../src/build-identity.js';
import { compileStudioPlugin } from '../src/plugin-bundle.js';

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, port = 7331) {
  const root = await mkdtemp(join(tmpdir(), 'motion-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['studio', 'src', '.local', 'dist/src', 'installed'].map(directory => mkdir(join(root, directory), { recursive: true })));
  await Promise.all(studioModuleNames.map(name => writeFile(join(root, 'studio', `${name}.lua`), `-- fixture ${name}\nreturn {}\n`)));
  await writeFile(join(root, 'studio', 'Plugin.lua'), 'local BASE = "__BRIDGE_URL__"\nlocal TOKEN = "__BRIDGE_TOKEN__"\nlocal PLUGIN_BUILD_FINGERPRINT = "__PLUGIN_BUILD_FINGERPRINT__"\n');
  const token = 'a'.repeat(64);
  const connection = { token, port };
  const template = await assembleStudioPlugin(root);
  const paired = pairStudioPlugin(template, connection);
  const installedPluginPath = join(root, 'installed', 'RobloxMotion.plugin.lua');
  const entryPath = join(root, 'dist', 'src', 'index.js');
  await Promise.all([
    writeFile(join(root, 'dist', 'RobloxMotion.plugin.lua'), template),
    writeFile(join(root, '.local', 'RobloxMotion.plugin.lua'), paired),
    writeFile(installedPluginPath, paired),
    writeFile(entryPath, '// fixture compiled entry\n'),
    writeFile(join(root, 'src', 'index.ts'), '// fixture source entry\n'),
    writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n'),
    writeFile(join(root, '.local', 'connection.json'), JSON.stringify(connection)),
    writeFile(join(root, '.local', 'mcp-config.json'), JSON.stringify({ mcpServers: { 'roblox-motion': {
      command: process.execPath, args: [entryPath], env: { MOTION_PROJECT_ROOT: root },
    } } })),
  ]);
  const plugin = await compileStudioPlugin(root);
  await writeFile(join(root, 'dist', 'build-identity.json'), JSON.stringify(await createBuildIdentity(root, plugin.pluginFingerprint)));
  return { root, token, installedPluginPath, entryPath, options: { projectRoot: root, installRoot: root, installedPluginPath } };
}

test('installation doctor verifies current files without changing them or exposing pairing credentials', async t => {
  const f = await fixture(t);
  const before = await readdir(join(f.root, '.local'));
  const connectionBefore = await readFile(join(f.root, '.local', 'connection.json'), 'utf8');
  const report = await diagnoseInstallation(f.options);
  assert.equal(report.status, 'ready');
  assert.ok(report.checks.every(check => check.status === 'ok'));
  assert.ok(!JSON.stringify(report).includes(f.token));
  assert.deepEqual(await readdir(join(f.root, '.local')), before);
  assert.equal(await readFile(join(f.root, '.local', 'connection.json'), 'utf8'), connectionBefore);
  assert.ok(!report.checks.some(check => check.id === 'bridge'), 'file inspection must not probe or start a bridge');
});

test('installation doctor detects stale source, prepared plugin, and installed copies independently', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'studio', 'Rig.lua'), '-- changed source\nreturn {version = 2}\n');
  const stale = await diagnoseInstallation(f.options);
  for (const id of ['plugin_build', 'prepared_plugin', 'installed_plugin']) assert.equal(stale.checks.find(check => check.id === id)?.status, 'needs_attention');
  await writeFile(join(f.root, 'dist', 'RobloxMotion.plugin.lua'), await assembleStudioPlugin(f.root));
  const rebuilt = await diagnoseInstallation(f.options);
  assert.equal(rebuilt.checks.find(check => check.id === 'plugin_build')?.status, 'ok');
  assert.equal(rebuilt.checks.find(check => check.id === 'prepared_plugin')?.status, 'needs_attention');
  assert.equal(rebuilt.checks.find(check => check.id === 'installed_plugin')?.status, 'needs_attention');
});

test('installation doctor distinguishes pairing drift and keeps old and new tokens out of results', async t => {
  const f = await fixture(t);
  const changedToken = 'b'.repeat(64);
  await writeFile(join(f.root, '.local', 'connection.json'), JSON.stringify({ token: changedToken, port: 7331 }));
  const report = await diagnoseInstallation(f.options);
  assert.equal(report.checks.find(check => check.id === 'plugin_build')?.status, 'ok');
  assert.equal(report.checks.find(check => check.id === 'pairing')?.status, 'ok');
  assert.equal(report.checks.find(check => check.id === 'installed_plugin')?.status, 'needs_attention');
  assert.ok(!JSON.stringify(report).includes(f.token) && !JSON.stringify(report).includes(changedToken));
});

test('installation doctor does not regenerate missing pairing and sanitizes malformed settings', async t => {
  const f = await fixture(t);
  const path = join(f.root, '.local', 'connection.json');
  await unlink(path);
  const missing = await diagnoseInstallation(f.options);
  assert.equal(missing.checks.find(check => check.id === 'pairing')?.status, 'needs_attention');
  assert.ok(!(await readdir(join(f.root, '.local'))).includes('connection.json'));
  const sensitiveText = 'sensitive-invalid-setting';
  await writeFile(path, sensitiveText);
  const malformed = await diagnoseInstallation(f.options);
  assert.equal(malformed.checks.find(check => check.id === 'pairing')?.status, 'needs_attention');
  assert.ok(!JSON.stringify(malformed).includes(sensitiveText));
  assert.equal(await readFile(path, 'utf8'), sensitiveText);
});

test('installation doctor catches connector project drift without returning unrelated environment values', async t => {
  const f = await fixture(t);
  const secret = 'unrelated-provider-secret';
  await writeFile(join(f.root, '.local', 'mcp-config.json'), JSON.stringify({ mcpServers: { 'roblox-motion': {
    command: process.execPath, args: [f.entryPath], env: { MOTION_PROJECT_ROOT: join(f.root, 'different-project'), PRIVATE_KEY: secret },
  } } }));
  const report = await diagnoseInstallation(f.options);
  assert.equal(report.checks.find(check => check.id === 'connector_config')?.status, 'needs_attention');
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('doctor health probe is authenticated, bounded, read-only, and refuses redirects', async t => {
  let mode = 'healthy', requests = 0, receivedAuthorization = '';
  let healthBuild: unknown;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/health');
    receivedAuthorization = request.headers.authorization ?? '';
    if (mode === 'rejected') { response.writeHead(403); response.end('{}'); return; }
    if (mode === 'redirect') { response.writeHead(302, { location: '/other' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'roblox-motion', version: 1, ...(mode === 'current' || mode === 'different' ? { buildIdentity: healthBuild } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const f = await fixture(t, address.port);
  const healthy = await diagnoseInstallation({ ...f.options, checkBridge: true });
  assert.equal(healthy.checks.find(check => check.id === 'bridge')?.status, 'ok');
  assert.equal(healthy.checks.find(check => check.id === 'bridge_build')?.status, 'unknown', 'a legacy bridge without identity cannot be called current');
  assert.equal(receivedAuthorization, `Bearer ${f.token}`);
  mode = 'current';
  healthBuild = readBuildIdentity(f.root);
  const current = await diagnoseInstallation({ ...f.options, checkBridge: true });
  assert.equal(current.checks.find(check => check.id === 'bridge_build')?.status, 'ok');
  mode = 'different';
  healthBuild = { ...readBuildIdentity(f.root), serverFingerprint: '0'.repeat(64) };
  const different = await diagnoseInstallation({ ...f.options, checkBridge: true });
  assert.equal(different.checks.find(check => check.id === 'bridge_build')?.status, 'needs_attention');
  mode = 'rejected';
  const rejected = await diagnoseInstallation({ ...f.options, checkBridge: true });
  assert.equal(rejected.checks.find(check => check.id === 'bridge')?.status, 'needs_attention');
  mode = 'redirect';
  const redirected = await diagnoseInstallation({ ...f.options, checkBridge: true });
  assert.equal(redirected.checks.find(check => check.id === 'bridge')?.status, 'unknown');
  assert.equal(requests, 5, 'the probe must not follow a redirect or execute any Studio command');
  assert.ok(!JSON.stringify([healthy, rejected, redirected]).includes(f.token));
});

test('MCP installation doctor is discoverable and reports connectivity without queueing work or creating pairing', async t => {
  const f = await fixture(t);
  await unlink(join(f.root, '.local', 'connection.json'));
  const queue = new Queue();
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, { name: 'Doctor fixture', motionToolsBuild: runningBuildIdentity ? { version: 1, pluginFingerprint: runningBuildIdentity.pluginFingerprint } : undefined });
  const server = createMcp(new Library(join(f.root, 'artifacts', 'library')), queue, new Blender(f.root, 'blender'));
  const client = new Client({ name: 'installation-doctor-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.find(tool => tool.name === 'motion_installation_diagnostics')?.annotations?.readOnlyHint, true);
    const response = await client.callTool({ name: 'motion_installation_diagnostics', arguments: {} });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = (response.structuredContent as { result: { checks: { id: string; status: string }[]; studio: { onlineSessionCount: number } } }).result;
    assert.equal(result.checks.find(check => check.id === 'pairing')?.status, 'needs_attention');
    assert.equal(result.studio.onlineSessionCount, 1);
    const resumed = await client.callTool({ name: 'motion_agent_resume', arguments: { sessionId } });
    const context = (resumed.structuredContent as { result: { serverBuildAssessment: { status: string }; sessions: { pluginBuildAssessment: { status: string } }[] } }).result;
    assert.equal(context.serverBuildAssessment.status, 'current');
    assert.equal(context.sessions[0]?.pluginBuildAssessment.status, 'current');
    queue.heartbeat(sessionId, { name: 'Doctor fixture', motionToolsBuild: { version: 1, pluginFingerprint: '0'.repeat(64) } });
    const stale = await client.callTool({ name: 'motion_agent_resume', arguments: { sessionId } });
    const staleContext = (stale.structuredContent as { result: { sessions: { pluginBuildAssessment: { status: string } }[]; nextActions: string[] } }).result;
    assert.equal(staleContext.sessions[0]?.pluginBuildAssessment.status, 'different');
    assert.ok(staleContext.nextActions.some(action => /different build.*restart Studio/i.test(action)));
    assert.deepEqual(queue.listJobs(sessionId).jobs, []);
    assert.ok(!(await readdir(join(f.root, '.local'))).includes('connection.json'));
    assert.ok(!JSON.stringify(response).includes(f.token));
  } finally { await client.close(); await server.close(); }
});
