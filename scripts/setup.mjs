import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { config } from '../dist/src/config.js';
import { pairStudioPlugin } from '../dist/src/plugin-bundle.js';
const root = resolve('.');
const settings = await config(root);
let previousBlender;
let mcpConfig = { mcpServers: {} };
try {
  mcpConfig = JSON.parse(await readFile('.local/mcp-config.json', 'utf8'));
  previousBlender = mcpConfig.mcpServers?.['roblox-motion']?.env?.BLENDER_EXECUTABLE;
}
catch (error) { if (error.code !== 'ENOENT') throw error; }
const blenderExecutable = process.env.BLENDER_EXECUTABLE || previousBlender;
const plugin = pairStudioPlugin(await readFile('dist/RobloxMotion.plugin.lua', 'utf8'), settings);
await writeFile('.local/RobloxMotion.plugin.lua', plugin);
const entry = { command: process.execPath, args: [join(root, 'dist', 'src', 'index.js')], env: { MOTION_PROJECT_ROOT: root, ...(blenderExecutable ? { BLENDER_EXECUTABLE: blenderExecutable } : {}) } };
if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object' || Array.isArray(mcpConfig.mcpServers)) mcpConfig.mcpServers = {};
mcpConfig.mcpServers['roblox-motion'] = entry;
await writeFile('.local/mcp-config.json', JSON.stringify(mcpConfig, null, 2));
console.log('Prepared paired Studio plugin and MCP configuration in .local/.');
