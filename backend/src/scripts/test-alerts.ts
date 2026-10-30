/**
 * Unit tests for the pure rule logic in observability/alerts.service.ts
 * (evaluateRules + decideAlertEvents). No DB, no email, no network.
 *
 * Usage: npm run test:alerts
 */
import { evaluateRules, decideAlertEvents, type WindowStats, type AlertRule, type AlertState } from '../observability/alerts.service';

interface Case { label: string; run: () => boolean }
const cases: Case[] = [];

const cfg = {
  ALERT_MIN_REQUESTS: 20, ALERT_ERROR_RATE: 0.05, ALERT_NOT_FOUND_RATE: 0.4, ALERT_P95_MS: 15000,
} as Parameters<typeof evaluateRules>[1];
const COOLDOWN = 60;
const now = new Date('2026-10-30T12:00:00Z');
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const stats = (o: Partial<WindowStats> = {}): WindowStats =>
  ({ total: 100, errors: 0, notFound: 0, rateLimited: 0, p95Ms: 1000, ...o });
const decide = (s: WindowStats, st: Partial<Record<AlertRule, AlertState>> = {}) =>
  decideAlertEvents(evaluateRules(s, cfg), st, now, COOLDOWN).map(e => `${e.type}:${e.result.rule}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// healthy
cases.push({ label: 'healthy window -> no events', run: () => same(decide(stats()), []) });

// below minimum requests
cases.push({ label: 'below min requests: high error/not-found/p95 do not fire',
  run: () => same(decide(stats({ total: 19, errors: 19, notFound: 19, p95Ms: 99999 })), []) });
cases.push({ label: 'below min requests: llm_rate_limited still fires',
  run: () => same(decide(stats({ total: 3, rateLimited: 1 })), ['fired:llm_rate_limited']) });
cases.push({ label: 'exactly min requests (20) is enough',
  run: () => same(decide(stats({ total: 20, errors: 20 })), ['fired:error_rate']) });
cases.push({ label: 'empty window -> no events, no NaN', run: () => same(decide(stats({ total: 0, p95Ms: null })), []) });

// over threshold
cases.push({ label: 'error rate over threshold fires', run: () => same(decide(stats({ errors: 6 })), ['fired:error_rate']) });
cases.push({ label: 'not-found rate over threshold fires', run: () => same(decide(stats({ notFound: 52 })), ['fired:not_found_rate']) });
cases.push({ label: 'p95 over threshold fires', run: () => same(decide(stats({ p95Ms: 15001 })), ['fired:p95_latency']) });
cases.push({ label: 'any RATE_LIMITED row fires', run: () => same(decide(stats({ rateLimited: 1 })), ['fired:llm_rate_limited']) });

// boundary: equal to threshold does not fire
cases.push({ label: 'error rate == threshold (5/100) does not fire', run: () => same(decide(stats({ errors: 5 })), []) });
cases.push({ label: 'not-found rate == threshold (40/100) does not fire', run: () => same(decide(stats({ notFound: 40 })), []) });
cases.push({ label: 'p95 == threshold (15000) does not fire', run: () => same(decide(stats({ p95Ms: 15000 })), []) });

// cooldown
const bad = stats({ notFound: 52 });
cases.push({ label: 'cooldown: fired 10 min ago -> no repeat',
  run: () => same(decide(bad, { not_found_rate: { lastFiredAt: minsAgo(10) } }), []) });
cases.push({ label: 'cooldown: fired 59 min ago -> still blocked',
  run: () => same(decide(bad, { not_found_rate: { lastFiredAt: minsAgo(59) } }), []) });
cases.push({ label: 'cooldown: fired exactly 60 min ago -> fires again',
  run: () => same(decide(bad, { not_found_rate: { lastFiredAt: minsAgo(60) } }), ['fired:not_found_rate']) });
cases.push({ label: 'cooldown is per rule (other rule still fires)',
  run: () => same(decide(stats({ notFound: 52, errors: 10 }), { not_found_rate: { lastFiredAt: minsAgo(5) } }), ['fired:error_rate']) });

// recovery
cases.push({ label: 'recovery of a fired rule -> exactly one resolved event',
  run: () => same(decide(stats(), { not_found_rate: { lastFiredAt: minsAgo(30) } }), ['resolved:not_found_rate']) });
cases.push({ label: 'after state is cleared, no further resolved event',
  run: () => same(decide(stats(), {}), []) });
cases.push({ label: 'recovery when traffic drops below min requests resolves',
  run: () => same(decide(stats({ total: 0, p95Ms: null }), { error_rate: { lastFiredAt: minsAgo(30) } }), ['resolved:error_rate']) });
cases.push({ label: 'still breached inside cooldown -> neither fired nor resolved',
  run: () => same(decide(bad, { not_found_rate: { lastFiredAt: minsAgo(30) } }), []) });

function main() {
  let failures = 0;
  for (const c of cases) {
    try {
      if (c.run()) console.log(`PASS  ${c.label}`);
      else { failures++; console.log(`FAIL  ${c.label}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
