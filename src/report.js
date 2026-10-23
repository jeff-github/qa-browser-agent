import fs from 'fs/promises';
import path from 'path';

const runs = await fs.readdir('runs').catch(() => []);
const latest = runs.sort().at(-1);
if (!latest) {
  console.log('No runs found.');
  process.exit(0);
}
const reportPath = path.join('runs', latest, 'report.md');
console.log(await fs.readFile(reportPath, 'utf8'));
