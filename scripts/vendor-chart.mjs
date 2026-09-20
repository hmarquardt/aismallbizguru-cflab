import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Analytics Worker serves static assets directly; there is no frontend
// bundler. Chart.js is vendored into analytics-ui/vendor so the deployed
// dashboard never loads chart code from a third-party origin.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/chart.js/dist/chart.umd.js');
const target = resolve(root, 'analytics-ui/vendor/chart.umd.js');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (!existsSync(source)) {
  console.error('chart.js is not installed; run npm ci first');
  process.exit(1);
}

if (process.argv[2] === 'verify') {
  if (!existsSync(target)) {
    console.error('analytics-ui/vendor/chart.umd.js is missing; run npm run vendor:chart');
    process.exit(1);
  }
  if (sha256(source) !== sha256(target)) {
    console.error('analytics-ui/vendor/chart.umd.js is out of date; run npm run vendor:chart');
    process.exit(1);
  }
  console.log('vendored chart.umd.js matches node_modules/chart.js');
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const version = JSON.parse(readFileSync(resolve(root, 'node_modules/chart.js/package.json'), 'utf8')).version;
console.log(`vendored chart.js ${version} -> analytics-ui/vendor/chart.umd.js`);
