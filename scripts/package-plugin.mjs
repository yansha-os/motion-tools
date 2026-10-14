import { writeFile, mkdir } from 'node:fs/promises';
import { compileStudioPlugin } from '../dist/src/plugin-bundle.js';
import { createBuildIdentity } from '../dist/src/build-identity.js';
await mkdir('dist', { recursive: true });
const plugin = await compileStudioPlugin('.');
const identity = await createBuildIdentity('.', plugin.pluginFingerprint);
await writeFile('dist/RobloxMotion.plugin.lua', plugin.source);
await writeFile('dist/build-identity.json', JSON.stringify(identity, null, 2) + '\n');
