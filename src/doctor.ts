import { diagnoseInstallation } from './installation-diagnostics.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = process.argv.slice(2);
if (options.some(option => option !== '--json')) {
  console.error('Usage: npm run doctor -- [--json]');
  process.exitCode = 1;
} else {
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const report = await diagnoseInstallation({ projectRoot: resolve(process.env.MOTION_PROJECT_ROOT ?? installRoot), installRoot, checkBridge: true });
  if (options.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Motion Tools installation: ${report.status}`);
    for (const check of report.checks) {
      console.log(`[${check.status}] ${check.id}: ${check.detail}`);
      if (check.nextAction) console.log(`  Next: ${check.nextAction}`);
    }
    console.log(report.limitation);
  }
  process.exitCode = report.status === 'ready' ? 0 : report.status === 'needs_attention' ? 1 : 2;
}
