import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const buildIdentitySchema = z.object({ version: z.literal(1), pluginFingerprint: hash, serverFingerprint: hash }).strict();
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;
const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Read only the deterministic public build manifest; never infer identity from release names. */
export function readBuildIdentity(root = installRoot): BuildIdentity | undefined {
  try {
    const path = join(root, 'dist', 'build-identity.json');
    const info = statSync(path);
    if (!info.isFile() || info.size > 4096) return undefined;
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw) > 4096) return undefined;
    return buildIdentitySchema.parse(JSON.parse(raw));
  } catch { return undefined; }
}

/** Captured once when this module loads, so a rebuild cannot relabel an older running process. */
const startupBuildIdentity = readBuildIdentity();
export const runningBuildIdentity = startupBuildIdentity ? Object.freeze(startupBuildIdentity) : undefined;

export async function createBuildIdentity(root: string, pluginFingerprint: string): Promise<BuildIdentity> {
  const sourceFiles: string[] = [];
  const collect = async (parts: string[]) => {
    for (const entry of await readdir(join(root, 'src', ...parts), { withFileTypes: true })) {
      if (entry.isDirectory()) await collect([...parts, entry.name]);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) sourceFiles.push([...parts, entry.name].join('/'));
    }
  };
  await collect([]);
  const entries = await Promise.all(sourceFiles.sort().map(async source => {
    const compiled = source.slice(0, -3) + '.js';
    const contents = await readFile(join(root, 'dist', 'src', ...compiled.split('/')));
    return { module: compiled, fingerprint: createHash('sha256').update(contents).digest('hex') };
  }));
  if (!entries.length) throw new Error('Cannot identify an empty server build.');
  const dependencyLockFingerprint = createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex');
  return buildIdentitySchema.parse({ version: 1, pluginFingerprint,
    serverFingerprint: createHash('sha256').update(JSON.stringify({ modules: entries, dependencyLockFingerprint })).digest('hex') });
}

export function assessServerBuild(expected: BuildIdentity | undefined, observed: unknown) {
  const parsed = buildIdentitySchema.safeParse(observed);
  if (!expected || !parsed.success) return { status: 'unknown' as const, expected: expected ?? null,
    observed: parsed.success ? parsed.data : null, detail: 'Current build artifacts or the running server did not provide a valid build identity.',
    nextAction: 'Build the project and reload the Motion Tools MCP connection, then check diagnostics again.' };
  const serverMatches = expected.serverFingerprint === parsed.data.serverFingerprint;
  const pluginMatches = expected.pluginFingerprint === parsed.data.pluginFingerprint;
  return { status: serverMatches && pluginMatches ? 'current' as const : 'different' as const, expected, observed: parsed.data,
    detail: serverMatches && pluginMatches ? 'The running server reports the same build as the current artifacts.' : 'The running server reports a different build from the current artifacts.',
    ...(!(serverMatches && pluginMatches) ? { nextAction: 'Reload the Motion Tools MCP connection to load the current server and plugin contract.' } : {}) };
}

export function assessPluginBuild(expected: BuildIdentity | undefined, observed: unknown, online: boolean) {
  const parsed = z.object({ version: z.literal(1), pluginFingerprint: hash }).strict().safeParse(observed);
  if (!online || !expected || !parsed.success) return { status: 'unknown' as const,
    expectedPluginFingerprint: expected?.pluginFingerprint ?? null, reportedPluginFingerprint: parsed.success ? parsed.data.pluginFingerprint : null,
    detail: !online ? 'The plugin session is offline; its loaded build cannot be verified.' : 'Current artifacts or the plugin heartbeat lack a valid build identity.',
    nextAction: 'Install the current paired plugin and reconnect Studio, then read a fresh session heartbeat.' };
  const current = expected.pluginFingerprint === parsed.data.pluginFingerprint;
  return { status: current ? 'current' as const : 'different' as const, expectedPluginFingerprint: expected.pluginFingerprint,
    reportedPluginFingerprint: parsed.data.pluginFingerprint,
    detail: current ? 'The online plugin heartbeat reports the current plugin build.' : 'The online plugin heartbeat reports a different plugin build.',
    ...(!current ? { nextAction: 'Install the current paired plugin and restart Studio before relying on new plugin behavior.' } : {}) };
}
