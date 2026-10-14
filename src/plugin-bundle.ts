import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const studioModuleNames = ['Rig', 'EditorContext', 'EditorTransaction', 'EnergyColumn', 'Authoring', 'CurveAnimationAuthoring',
  'Preview', 'IKContact', 'ReviewCapture', 'MotionInspection', 'GraphMotionInspection', 'Manipulator', 'IKSolver',
  'AnimationImport', 'ExportValidation', 'KeyframeSelection', 'Mirror'] as const;

/** Keep build and installation inspection on the same byte-for-byte plugin assembly. */
export async function compileStudioPlugin(root: string) {
  const modules = await Promise.all(studioModuleNames.map(name => readFile(join(root, 'studio', `${name}.lua`), 'utf8')));
  let output = '-- Roblox Motion Tools. Generated from studio/*.lua.\n';
  for (const [index, name] of studioModuleNames.entries()) output += `local ${name} = (function()\n${modules[index]!}\nend)()\n`;
  // Give the editor its own register frame; inlined module bindings remain upvalues.
  const template = output + 'do\nlocal function initializeMotionTools()\n'
    + await readFile(join(root, 'studio', 'Plugin.lua'), 'utf8')
    + '\nend\ninitializeMotionTools()\nend\n';
  if (template.split('__PLUGIN_BUILD_FINGERPRINT__').length !== 2) {
    throw new Error('Studio plugin source must contain exactly one build fingerprint placeholder.');
  }
  const pluginFingerprint = createHash('sha256').update(template).digest('hex');
  return { pluginFingerprint, source: template.replace('__PLUGIN_BUILD_FINGERPRINT__', pluginFingerprint) };
}

export async function assembleStudioPlugin(root: string) { return (await compileStudioPlugin(root)).source; }

export function pairStudioPlugin(template: string, connection: { port: number; token: string }) {
  if (template.split('__BRIDGE_URL__').length !== 2 || template.split('__BRIDGE_TOKEN__').length !== 2) {
    throw new Error('Generated Studio plugin must contain exactly one URL placeholder and one pairing placeholder. Rebuild before pairing.');
  }
  return template.replace('__BRIDGE_URL__', `http://127.0.0.1:${connection.port}`).replace('__BRIDGE_TOKEN__', connection.token);
}
