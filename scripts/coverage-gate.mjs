#!/usr/bin/env node
/**
 * Coverage regression gate.
 *
 * `vitest run --coverage` writes a JSON summary for each app; this compares its
 * totals with the checked-in baseline. CI fails when line/statement/function/
 * branch coverage drops below the baseline (with a tiny rounding tolerance),
 * so the gate tracks real regressions instead of an arbitrary fixed target.
 *
 * Refresh the baseline deliberately after adding meaningful tests:
 *   npm run coverage:update
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'scripts', 'coverage-baseline.json');
const metrics = ['lines', 'statements', 'functions', 'branches'];
// Percentage points; keeps tiny V8 rounding differences from failing CI.
const tolerance = 0.05;

const projects = [
  {
    name: 'server',
    summary: path.join(root, 'apps', 'server', 'coverage', 'coverage-summary.json'),
  },
  {
    name: 'web',
    summary: path.join(root, 'apps', 'web', 'coverage', 'coverage-summary.json'),
  },
];

const update = process.argv.includes('--update');

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${label} at ${file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const current = {};
for (const project of projects) {
  const summary = readJson(project.summary, `${project.name} coverage summary`);
  const total = summary.total;
  if (!total || metrics.some((metric) => typeof total[metric]?.pct !== 'number')) {
    console.error(`${project.summary} is missing total coverage metrics.`);
    process.exit(1);
  }
  current[project.name] = Object.fromEntries(
    metrics.map((metric) => [metric, Number(total[metric].pct.toFixed(2))]),
  );
}

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Coverage baseline updated: ${path.relative(root, baselinePath)}`);
  process.exit(0);
}

const baseline = readJson(baselinePath, 'coverage baseline');
const failures = [];

console.log('Coverage gate (current vs baseline, percentage points)');
for (const project of projects) {
  const before = baseline[project.name];
  if (!before) {
    failures.push(`${project.name}: no baseline entry — run npm run coverage:update`);
    continue;
  }

  console.log(`\n${project.name}`);
  for (const metric of metrics) {
    const now = current[project.name][metric];
    const then = before[metric];
    if (typeof then !== 'number') {
      failures.push(`${project.name}.${metric}: no baseline value — run npm run coverage:update`);
      continue;
    }
    const delta = Number((now - then).toFixed(2));
    const marker = delta < -tolerance ? 'FAIL' : 'ok';
    const sign = delta >= 0 ? '+' : '';
    console.log(
      `  ${marker.padEnd(4)} ${metric.padEnd(10)} ${now.toFixed(2).padStart(6)}%  (${sign}${delta.toFixed(2)})`,
    );
    if (delta < -tolerance) {
      failures.push(
        `${project.name}.${metric}: ${now.toFixed(2)}% is ${Math.abs(delta).toFixed(2)}pp below baseline ${then.toFixed(2)}%`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('\nCoverage regression:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    '\nAdd tests, or if the lower total is intentional run `npm run coverage:update` and explain the change.',
  );
  process.exit(1);
}

console.log('\nCoverage gate passed (no metric below baseline).');
