import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileStudioPlugin, pairStudioPlugin, studioModuleNames } from '../src/plugin-bundle.js';
import { assessPluginBuild, assessServerBuild, createBuildIdentity, readBuildIdentity, type BuildIdentity } from '../src/build-identity.js';

test('build fingerprints are deterministic, pairing-independent, and change when runtime modules or plugin source change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'motion-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['studio', 'src', 'dist/src'].map(path => mkdir(join(root, path), { recursive: true })));
  await Promise.all(studioModuleNames.map(name => writeFile(join(root, 'studio', `${name}.lua`), `return {name = "${name}"}\n`)));
  await writeFile(join(root, 'studio', 'Plugin.lua'), 'local PLUGIN_BUILD_FINGERPRINT = "__PLUGIN_BUILD_FINGERPRINT__"\nlocal BASE = "__BRIDGE_URL__"\nlocal TOKEN = "__BRIDGE_TOKEN__"\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'dist', 'src', 'index.js'), 'export const value = 1;\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const plugin = await compileStudioPlugin(root);
  assert.deepEqual(await compileStudioPlugin(root), plugin);
  for (const token of ['a'.repeat(64), 'b'.repeat(64)]) {
    const paired = pairStudioPlugin(plugin.source, { port: 7331, token });
    assert.ok(paired.includes(`PLUGIN_BUILD_FINGERPRINT = "${plugin.pluginFingerprint}"`));
  }
  const initial = await createBuildIdentity(root, plugin.pluginFingerprint);
  assert.deepEqual(await createBuildIdentity(root, plugin.pluginFingerprint), initial);
  await writeFile(join(root, 'dist', 'src', 'index.js'), 'export const value = 2;\n');
  const changed = await createBuildIdentity(root, plugin.pluginFingerprint);
  assert.notEqual(changed.serverFingerprint, initial.serverFingerprint);
  assert.equal(changed.pluginFingerprint, initial.pluginFingerprint);
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"dependency":{"version":"2"}}}\n');
  assert.notEqual((await createBuildIdentity(root, plugin.pluginFingerprint)).serverFingerprint, changed.serverFingerprint,
    'a changed dependency lock must also change the reported server build');
  await writeFile(join(root, 'studio', 'Rig.lua'), 'return {changed = true}\n');
  assert.notEqual((await compileStudioPlugin(root)).pluginFingerprint, plugin.pluginFingerprint);
  assert.equal(readBuildIdentity(root), undefined);
  await writeFile(join(root, 'dist', 'build-identity.json'), JSON.stringify(initial));
  assert.deepEqual(readBuildIdentity(root), initial);
  await writeFile(join(root, 'dist', 'build-identity.json'), '{"version":1,"serverFingerprint":"invalid"}');
  assert.equal(readBuildIdentity(root), undefined);
});

test('build assessments distinguish current, different, malformed, missing, and offline identities', () => {
  const build: BuildIdentity = { version: 1, pluginFingerprint: 'a'.repeat(64), serverFingerprint: 'b'.repeat(64) };
  assert.equal(assessServerBuild(build, { ...build }).status, 'current');
  assert.equal(assessServerBuild(build, { ...build, serverFingerprint: 'c'.repeat(64) }).status, 'different');
  assert.equal(assessServerBuild(build, { ...build, pluginFingerprint: 'c'.repeat(64) }).status, 'different');
  assert.equal(assessServerBuild(build, { version: 1, pluginFingerprint: 'bad' }).status, 'unknown');
  assert.equal(assessServerBuild(undefined, build).status, 'unknown');
  const reportedPlugin = { version: 1, pluginFingerprint: build.pluginFingerprint };
  assert.equal(assessPluginBuild(build, reportedPlugin, true).status, 'current');
  assert.equal(assessPluginBuild(build, { ...reportedPlugin, pluginFingerprint: 'c'.repeat(64) }, true).status, 'different');
  assert.equal(assessPluginBuild(build, reportedPlugin, false).status, 'unknown');
  assert.equal(assessPluginBuild(build, { pluginVersion: '1.0.0' }, true).status, 'unknown');
});
