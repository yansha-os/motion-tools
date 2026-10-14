import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectionSchema } from './config.js';
import { compileStudioPlugin, pairStudioPlugin } from './plugin-bundle.js';
import { assessServerBuild, buildIdentitySchema, createBuildIdentity, readBuildIdentity, type BuildIdentity } from './build-identity.js';

export type InstallationCheck = { id: string; status: 'ok' | 'needs_attention' | 'unknown'; detail: string; path?: string; nextAction?: string; reportedBuildIdentity?: BuildIdentity };
export type InstallationDiagnosticsOptions = { projectRoot: string; installRoot?: string; installedPluginPath?: string; checkBridge?: boolean; loadedServerBuild?: unknown };
const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const connectorSchema = z.object({ mcpServers: z.object({ 'roblox-motion': z.object({
  command: z.string().min(1), args: z.array(z.string()), env: z.record(z.string()).optional(),
}).passthrough() }).passthrough() }).passthrough();
const healthSchema = z.object({ name: z.literal('roblox-motion'), version: z.literal(1), buildIdentity: z.unknown().optional() }).passthrough();

async function readOptional(path: string, limit = 8 * 1024 * 1024) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) return { status: 'unreadable' as const };
    const text = await readFile(path, 'utf8');
    return Buffer.byteLength(text) <= limit ? { status: 'read' as const, text } : { status: 'unreadable' as const };
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? { status: 'missing' as const } : { status: 'unreadable' as const };
  }
}

function samePath(left: string, right: string) {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

async function inspectBridge(connection: z.infer<typeof connectionSchema>): Promise<InstallationCheck> {
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}/health`, {
      headers: { authorization: `Bearer ${connection.token}` }, redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    if (response.status === 403) return { id: 'bridge', status: 'needs_attention',
      detail: 'The local bridge rejected this project’s pairing. A different project or an old server may own the port.',
      nextAction: 'Check which Motion Tools connector owns the port; reload the intended connector with this project’s configuration.' };
    if (!response.ok || !response.body) return { id: 'bridge', status: 'needs_attention', detail: 'The configured port did not return a Motion Tools health response.',
      nextAction: 'Check the active connector and its project path before starting another server.' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); throw new Error('Oversized health response.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const health: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed = healthSchema.safeParse(health);
    if (!parsed.success) return { id: 'bridge', status: 'needs_attention', detail: 'The configured port returned an unrecognized service response.',
      nextAction: 'Check the active connector and its project path before starting another server.' };
    const build = buildIdentitySchema.safeParse(parsed.data.buildIdentity);
    return { id: 'bridge', status: 'ok', detail: 'The paired local Motion Tools bridge answered. Studio connectivity and rig readiness still require motion_agent_resume.',
      ...(build.success ? { reportedBuildIdentity: build.data } : {}) };
  } catch {
    return { id: 'bridge', status: 'unknown', detail: 'The paired bridge could not be verified within 1.5 seconds.',
      nextAction: 'Start or reload the Motion Tools MCP connector, then rerun diagnostics. Avoid starting a second server while the connector owns the port.' };
  }
}

/** Read-only installation audit. Never creates pairing settings, installs plugins, or starts a server. */
export async function diagnoseInstallation(options: InstallationDiagnosticsOptions) {
  const root = resolve(options.projectRoot), installRoot = resolve(options.installRoot ?? installedRoot);
  const checks: InstallationCheck[] = [];
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
  checks.push({ id: 'node', status: nodeSupported ? 'ok' : 'needs_attention', detail: `Node ${process.versions.node}; Motion Tools requires Node 22 or later.`,
    ...(!nodeSupported ? { nextAction: 'Use Node 22 or later for the connector command.' } : {}) });
  let template: string | undefined;
  let pluginFingerprint: string | undefined;
  try {
    const plugin = await compileStudioPlugin(installRoot);
    template = plugin.source;
    pluginFingerprint = plugin.pluginFingerprint;
    checks.push({ id: 'plugin_sources', status: 'ok', detail: 'Studio plugin source modules are readable.' });
  } catch {
    checks.push({ id: 'plugin_sources', status: 'unknown', detail: 'The complete Studio source tree could not be read; source freshness is unverified.',
      nextAction: 'Run diagnostics from the Motion Tools checkout with its studio directory present.' });
  }
  const bundlePath = join(installRoot, 'dist', 'RobloxMotion.plugin.lua');
  const bundle = await readOptional(bundlePath);
  if (bundle.status !== 'read') checks.push({ id: 'plugin_build', status: 'needs_attention', path: bundlePath,
    detail: 'The generated plugin is missing or unreadable.', nextAction: 'Run npm run build, then npm run setup:freebuff.' });
  else checks.push({ id: 'plugin_build', status: template === undefined ? 'unknown' : bundle.text === template ? 'ok' : 'needs_attention', path: bundlePath,
    detail: template === undefined ? 'Generated plugin exists, but source freshness is unverified.' : bundle.text === template ? 'Generated plugin matches current Studio source.' : 'Generated plugin is stale relative to current Studio source.',
    ...(template !== undefined && bundle.text !== template ? { nextAction: 'Run npm run setup:freebuff to rebuild, pair, and install the current plugin.' } : {}) });

  const identity = readBuildIdentity(installRoot);
  if (!identity) checks.push({ id: 'build_manifest', status: 'needs_attention', detail: 'Public build identity is missing or invalid.', nextAction: 'Run npm run build, then reload the Motion Tools MCP connection.' });
  else {
    let compiledIdentity: BuildIdentity | undefined;
    try { if (pluginFingerprint) compiledIdentity = await createBuildIdentity(installRoot, pluginFingerprint); } catch { /* Missing build inputs remain unverified. */ }
    const assessment = assessServerBuild(identity, compiledIdentity);
    checks.push({ id: 'build_manifest', status: assessment.status === 'current' ? 'ok' : assessment.status === 'different' ? 'needs_attention' : 'unknown',
      detail: assessment.status === 'current' ? 'Build manifest matches Studio source, compiled server modules, and the dependency lock.' : assessment.status === 'different' ? 'Build manifest differs from Studio source, compiled server modules, or the dependency lock.' : 'Build inputs are unavailable; manifest freshness cannot be verified.',
      ...(assessment.status !== 'current' ? { nextAction: 'Run npm run build before relying on the build identity.' } : {}) });
  }
  const loadedServerBuildAssessment = 'loadedServerBuild' in options ? assessServerBuild(identity, options.loadedServerBuild) : undefined;
  if (loadedServerBuildAssessment) checks.push({ id: 'loaded_server_build',
    status: loadedServerBuildAssessment.status === 'current' ? 'ok' : loadedServerBuildAssessment.status === 'different' ? 'needs_attention' : 'unknown',
    detail: loadedServerBuildAssessment.detail, ...(loadedServerBuildAssessment.nextAction ? { nextAction: loadedServerBuildAssessment.nextAction } : {}) });

  const connectionPath = join(root, '.local', 'connection.json');
  const connectionFile = await readOptional(connectionPath, 65536);
  let connection: z.infer<typeof connectionSchema> | undefined;
  try { if (connectionFile.status === 'read') connection = connectionSchema.parse(JSON.parse(connectionFile.text)); } catch { /* Report only sanitized diagnostics below. */ }
  checks.push({ id: 'pairing', status: connection ? 'ok' : 'needs_attention', path: connectionPath,
    detail: connection ? 'Existing pairing configuration is valid; credentials are omitted.' : 'Existing pairing configuration is missing, invalid, or unreadable.',
    ...(!connection ? { nextAction: 'Restore this project’s pairing settings or run setup and reinstall its paired plugin.' } : {}) });
  let expectedPlugin: string | undefined;
  try { if (template && connection) expectedPlugin = pairStudioPlugin(template, connection); } catch { /* Do not expose plugin source or credentials. */ }
  const checkPluginCopy = async (id: string, path: string, action: string) => {
    const file = await readOptional(path);
    if (file.status !== 'read') checks.push({ id, status: 'needs_attention', path, detail: 'Plugin copy is missing or unreadable.', nextAction: action });
    else if (!expectedPlugin) checks.push({ id, status: 'unknown', path, detail: 'Plugin copy exists, but current source and pairing could not both be verified.' });
    else checks.push({ id, status: file.text === expectedPlugin ? 'ok' : 'needs_attention', path,
      detail: file.text === expectedPlugin ? 'Plugin copy matches current source and this project’s pairing.' : 'Plugin copy differs from current source or this project’s pairing.',
      ...(file.text !== expectedPlugin ? { nextAction: action } : {}) });
  };
  await checkPluginCopy('prepared_plugin', join(root, '.local', 'RobloxMotion.plugin.lua'), 'Run npm run setup:freebuff to rebuild, pair, and install the current plugin.');
  const installedPluginPath = options.installedPluginPath ?? (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Roblox', 'Plugins', 'RobloxMotion.plugin.lua') : undefined);
  if (installedPluginPath) await checkPluginCopy('installed_plugin', installedPluginPath,
    'Run npm run setup:freebuff, then restart Studio. Installation backs up the previous local plugin.');
  else checks.push({ id: 'installed_plugin', status: 'unknown', detail: 'The Studio local plugin directory is unavailable on this host.' });

  const entryPath = join(installRoot, 'dist', 'src', 'index.js');
  const entry = await readOptional(entryPath);
  checks.push({ id: 'server_entry', status: entry.status === 'read' ? 'ok' : 'needs_attention', path: entryPath,
    detail: entry.status === 'read' ? 'Compiled MCP entry exists. Reload the client after rebuilding to load code changes.' : 'Compiled MCP entry is missing or unreadable.',
    ...(entry.status !== 'read' ? { nextAction: 'Run npm run build before loading the MCP connector.' } : {}) });
  const connectorPath = join(root, '.local', 'mcp-config.json');
  const connectorFile = await readOptional(connectorPath, 65536);
  let connectorReady = false;
  try {
    const config = connectorFile.status === 'read' ? connectorSchema.parse(JSON.parse(connectorFile.text)) : undefined;
    const connector = config?.mcpServers['roblox-motion'];
    if (connector && isAbsolute(connector.command) && connector.args.length === 1 && isAbsolute(connector.args[0]!)
      && samePath(connector.args[0]!, entryPath) && connector.env?.MOTION_PROJECT_ROOT && isAbsolute(connector.env.MOTION_PROJECT_ROOT)
      && samePath(connector.env.MOTION_PROJECT_ROOT, root)) connectorReady = (await stat(connector.command)).isFile();
  } catch { /* Connector errors may contain secrets; emit a fixed message. */ }
  checks.push({ id: 'connector_config', status: connectorReady ? 'ok' : 'needs_attention', path: connectorPath,
    detail: connectorReady ? 'Prepared connector points to the compiled entry and this project. The client’s actual connector configuration is not inspected.' : 'Prepared connector is missing, invalid, or points to different paths.',
    ...(!connectorReady ? { nextAction: 'Run npm run setup, then import .local/mcp-config.json into the intended MCP client and reload it.' } : {}) });
  if (options.checkBridge) {
    const bridge = connection ? await inspectBridge(connection) : { id: 'bridge', status: 'unknown' as const,
      detail: 'Bridge health cannot be checked without valid existing pairing settings.' };
    checks.push(bridge);
    if (bridge.status === 'ok') {
      const assessment = assessServerBuild(identity, 'reportedBuildIdentity' in bridge ? bridge.reportedBuildIdentity : undefined);
      checks.push({ id: 'bridge_build', status: assessment.status === 'current' ? 'ok' : assessment.status === 'different' ? 'needs_attention' : 'unknown',
        detail: assessment.detail, ...(assessment.nextAction ? { nextAction: assessment.nextAction } : {}) });
    }
  }
  return { generatedAt: new Date().toISOString(), projectRoot: root, installRoot,
    status: checks.some(check => check.status === 'needs_attention') ? 'needs_attention' as const : checks.some(check => check.status === 'unknown') ? 'incomplete' as const : 'ready' as const,
    scope: options.checkBridge ? 'installation_and_bridge_health' as const : 'installation_files' as const, checks,
    buildIdentity: identity ?? null, ...(loadedServerBuildAssessment ? { loadedServerBuildAssessment } : {}),
    limitation: 'Build fingerprints identify source/artifacts and the build reported by this process or paired bridge; they do not verify client image support, runtime modifications, visual quality, or export. Use motion_agent_resume for the plugin heartbeat build and motion_agent_readiness for rig/editor prerequisites.' };
}
