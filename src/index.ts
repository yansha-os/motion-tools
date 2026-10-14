import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Queue, startBridge } from './bridge.js';
import { Library } from './library.js';
import { Blender } from './blender.js';
import { createMcp } from './server.js';
import { config } from './config.js';
import { readFile } from 'node:fs/promises';
import { appToken, MotionApp } from './app.js';
import { Connections } from './providers.js';
import { PoseLibrary } from './pose-library.js';

const installRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const root = resolve(process.env.MOTION_PROJECT_ROOT ?? installRoot);
const settings = await config(root);
const queue = new Queue(Date.now, join(root, 'artifacts', 'studio-job-journal.json'));
const library = new Library(join(root, 'artifacts', 'library'));
const poses = new PoseLibrary(join(root, 'artifacts', 'poses'));
const app = new MotionApp(await appToken(root), library, queue, new Connections(join(root, '.local', 'providers.json')), root);
const files = Object.fromEntries(await Promise.all([['/app', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/review.js', 'review.js', 'text/javascript; charset=utf-8'], ['/app.css', 'app.css', 'text/css; charset=utf-8']].map(async ([url, name, type]) => [url!, { type: type!, content: await readFile(join(installRoot, 'web', name!), 'utf8') }])));
const bridge = await startBridge(queue, settings.token, settings.port, { library, poses, app, files });
const blender = new Blender(root, process.env.BLENDER_EXECUTABLE ?? 'blender');
const server = createMcp(library, queue, blender, app.reviews, poses);
const transport = new StdioServerTransport();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  app.authoring.close();
  app.reviews.close();
  bridge.close(); bridge.closeAllConnections();
  await server.close();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
if (!process.argv.includes('--app')) {
  process.stdin.once('end', () => void close());
  await server.connect(transport);
}
console.error(`Motion Tools bridge: http://127.0.0.1:${settings.port}. Connect the paired Studio plugin.`);
