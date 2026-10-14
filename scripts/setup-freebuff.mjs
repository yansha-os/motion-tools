import { spawnSync } from 'node:child_process';

const setup = spawnSync(process.execPath, ['scripts/setup.mjs'], { stdio: 'inherit' });
if (setup.error) throw setup.error;
if (setup.status !== 0) process.exit(setup.status ?? 1);

const install = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/install-studio-plugin.ps1'], { stdio: 'inherit' });
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

console.log('\nMotion Tools is prepared for Freebuff.');
console.log('1. In Freebuff Desktop, add a local MCP server named "roblox-motion" using the command and args in .local/mcp-config.json.');
console.log('2. Restart Freebuff (or reload its MCP connectors) so it launches the Motion Tools server.');
console.log('3. Restart Roblox Studio and open Plugins > Motion Tools. The plugin connects automatically; choose or add a rig in its Rig Library.');
console.log('4. Ask Freebuff to resume the Motion Tools session, inspect the active rig, author an animation candidate, and preview it before saving an approved result.');
console.log('5. If the connection or plugin needs troubleshooting, run npm.cmd run doctor or ask Freebuff to use motion_installation_diagnostics.');
console.log('\nDo not run npm start or npm run app while Freebuff owns the local Studio bridge port.');
