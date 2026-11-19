#!/usr/bin/env node
/**
 * CI dependency audit gate.
 *
 * Runs `npm audit --omit=dev --json` and fails on any high/critical advisory
 * that is not explicitly allow-listed in `scripts/audit-allowlist.json`.
 * The allow-list exists for known build-chain findings we cannot fix without a
 * major framework upgrade; every entry needs a reason and an expiry review.
 *
 * Run locally with `npm run audit:ci`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(root, 'scripts', 'audit-allowlist.json');

let allowlist;
try {
  allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${allowlistPath}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
if (typeof allowlist !== 'object' || allowlist === null || Array.isArray(allowlist)) {
  console.error('scripts/audit-allowlist.json must be an object of { "GHSA-…": "reason" }');
  process.exit(1);
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

const output = audit.stdout?.trim();
if (!output) {
  console.error(audit.stderr?.trim() || 'npm audit produced no output');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(output);
} catch {
  console.error('npm audit did not return JSON:');
  console.error(output.slice(0, 2000));
  process.exit(1);
}

if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const findings = [];
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;

  const advisories = (vuln.via ?? []).filter((via) => typeof via === 'object');
  if (advisories.length === 0) {
    // A transitive dependency without its own advisory entry (defense in depth).
    findings.push({
      id: `npm:${pkg}`,
      pkg,
      severity: vuln.severity,
      title: `vulnerable ${vuln.range ?? 'version'}`,
    });
    continue;
  }

  for (const advisory of advisories) {
    const id = (advisory.url ?? '').match(/GHSA-[\w-]+/)?.[0] ?? `npm:${advisory.source}`;
    findings.push({
      id,
      pkg,
      severity: vuln.severity,
      title: advisory.title ?? pkg,
    });
  }
}

const unique = [...new Map(findings.map((f) => [`${f.id}\0${f.pkg}`, f])).values()];
const blocked = unique.filter((finding) => !(finding.id in allowlist));

for (const finding of unique) {
  const status = finding.id in allowlist ? 'ALLOWED' : 'FAIL';
  console.log(`${status}  ${finding.severity}  ${finding.pkg}  ${finding.id}`);
  console.log(`        ${finding.title}`);
}

if (blocked.length > 0) {
  console.error(`\nDependency audit failed: ${blocked.length} high/critical finding(s).`);
  console.error(
    'Fix the dependency, or add a justified GHSA entry to scripts/audit-allowlist.json.',
  );
  process.exit(1);
}

console.log(
  unique.length === 0
    ? '\nDependency audit passed (no high/critical findings).'
    : `\nDependency audit passed (${unique.length} high/critical finding(s), all allow-listed).`,
);
