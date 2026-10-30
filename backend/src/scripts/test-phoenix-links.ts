/**
 * Unit tests for observability/phoenix-links.ts pure helpers.
 * Pure: no DB, no network, no Phoenix.
 *
 * Usage: npm run test:phoenix-links
 */
import { formatPhoenixTraceUrl, composePhoenixTraceUrl, toProjectGlobalId } from '../services/observability/phoenix-links';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } }
const cases: Case[] = [];

const TRACE = 'ef72d3212e11add57e53f52877f5c482';
const PROJECT = 'UHJvamVjdDo0';
const EXPECTED = `http://localhost:6016/projects/${PROJECT}/traces/${TRACE}`;

cases.push({
  label: 'formats the Phoenix trace URL',
  run: () => formatPhoenixTraceUrl('http://localhost:6016', PROJECT, TRACE) === EXPECTED,
});

cases.push({
  label: 'strips a trailing slash from the public URL',
  run: () => formatPhoenixTraceUrl('http://localhost:6016/', PROJECT, TRACE) === EXPECTED &&
    formatPhoenixTraceUrl('http://localhost:6016//', PROJECT, TRACE) === EXPECTED,
});

cases.push({
  label: 'compose returns the URL for valid inputs',
  run: () => composePhoenixTraceUrl('http://localhost:6016/', PROJECT, TRACE) === EXPECTED,
});

cases.push({
  label: 'compose returns null for an empty public URL',
  run: () => composePhoenixTraceUrl('', PROJECT, TRACE) === null && composePhoenixTraceUrl('  ', PROJECT, TRACE) === null,
});

for (const bad of ['', 'abc', 'EF72D3212E11ADD57E53F52877F5C482', '0'.repeat(32), 'g'.repeat(32), TRACE + '0']) {
  cases.push({
    label: `compose returns null for invalid trace ID "${bad.slice(0, 12)}${bad.length > 12 ? '…' : ''}"`,
    run: () => composePhoenixTraceUrl('http://localhost:6016', PROJECT, bad) === null,
  });
}

cases.push({
  label: 'compose returns null for a non-string trace ID',
  run: () => composePhoenixTraceUrl('http://localhost:6016', PROJECT, 123) === null,
});

cases.push({
  label: 'compose returns null when the project could not be resolved',
  run: () => composePhoenixTraceUrl('http://localhost:6016', null, TRACE) === null,
});

cases.push({
  label: 'numeric project id becomes base64("Project:<id>")',
  run: () => toProjectGlobalId('4') === PROJECT && toProjectGlobalId('12') === Buffer.from('Project:12').toString('base64'),
});

cases.push({
  label: 'an existing global id is left unchanged',
  run: () => toProjectGlobalId(PROJECT) === PROJECT,
});

function main() {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = c.run();
      const pass = typeof r === 'boolean' ? r : r.pass;
      const detail = typeof r === 'boolean' ? '' : r.detail ? ` (${r.detail})` : '';
      if (pass) console.log(`PASS  ${c.label}${detail}`);
      else { failures++; console.log(`FAIL  ${c.label}${detail}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
