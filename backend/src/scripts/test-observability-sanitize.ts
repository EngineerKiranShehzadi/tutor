/**
 * Unit tests for the recursive sanitization/truncation utility
 * (observability/sanitize.ts). No DB, no network, no Gemini — pure
 * function tests, same manual-assertion convention as every other test
 * script in this project (see test-observability.ts).
 *
 * Usage: npm run test:observability-sanitize
 */
import { sanitizeAttributes, sanitizeValue, truncateContent } from '../observability/sanitize';

interface Case { label: string; run: () => boolean | { pass: boolean; detail?: string } }
const cases: Case[] = [];

cases.push({
  label: 'Denylisted key names are redacted regardless of value shape',
  run: () => {
    const out = sanitizeAttributes({ password: 'hunter2', apiKey: 'sk-abcdef1234567890', normal: 'fine' }) as Record<string, unknown>;
    return out.password === '[REDACTED]' && out.apiKey === '[REDACTED]' && out.normal === 'fine';
  },
});

cases.push({
  label: 'Bearer-token-shaped values are redacted even under an innocuous key name',
  run: () => {
    const out = sanitizeValue({ value: 'Bearer abc.def.ghi123' }) as Record<string, unknown>;
    return out.value === '[REDACTED]';
  },
});

cases.push({
  label: 'JWT-shaped strings are redacted',
  run: () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = sanitizeValue({ token_like: jwt }) as Record<string, unknown>;
    return out.token_like === '[REDACTED]';
  },
});

cases.push({
  label: 'DB-connection-string-shaped values are redacted',
  run: () => {
    const out = sanitizeValue({ note: 'postgresql://postgres:secretpw@localhost:5432/db' }) as Record<string, unknown>;
    return out.note === '[REDACTED]';
  },
});

cases.push({
  label: 'Long content is truncated and marked truncated',
  run: () => {
    const r = truncateContent('x'.repeat(50), 10);
    return r.truncated === true && r.value.length <= 25 && r.value.startsWith('xxxxxxxxxx');
  },
});

cases.push({
  label: 'Short content is left untouched and not marked truncated',
  run: () => {
    const r = truncateContent('short', 100);
    return r.truncated === false && r.value === 'short';
  },
});

cases.push({
  label: 'Deep nesting beyond MAX_DEPTH does not throw and terminates',
  run: () => {
    let obj: unknown = 'leaf';
    for (let i = 0; i < 20; i++) obj = { child: obj };
    const out = sanitizeValue(obj);
    return typeof out === 'object'; // must terminate without throwing/hanging
  },
});

cases.push({
  label: 'Oversized arrays are bounded, not fully serialized',
  run: () => {
    const arr = Array.from({ length: 500 }, (_, i) => i);
    const out = sanitizeValue(arr) as unknown[];
    return out.length <= 51; // MAX_ARRAY_ITEMS (50) + one "+N more" marker
  },
});

cases.push({
  label: 'Non-sensitive plain values pass through unchanged',
  run: () => {
    const out = sanitizeAttributes({ count: 5, ok: true, name: 'vector-search' });
    return out.count === 5 && out.ok === true && out.name === 'vector-search';
  },
});

cases.push({
  label: 'null/undefined values are preserved, not stringified',
  run: () => {
    const out = sanitizeAttributes({ a: null, b: undefined });
    return out.a === null && out.b === undefined;
  },
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
