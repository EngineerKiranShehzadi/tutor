import pool, { query } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { sendAdminAlertEmail } from '../services/email.service';

// Email alerts over the last ALERT_WINDOW_MINUTES of rag_request_log. Fired
// state lives in observability_alert_state so cooldowns survive restarts.
// Emails carry aggregate numbers only — never student or question data.

const ALERT_LOCK_KEY = 804001;

export type AlertRule = 'error_rate' | 'not_found_rate' | 'p95_latency' | 'llm_rate_limited';

export interface WindowStats {
  total: number;
  errors: number;
  notFound: number;
  rateLimited: number;
  p95Ms: number | null;
}

export interface RuleResult {
  rule: AlertRule;
  breached: boolean;
  value: number;
  title: string;      // e.g. "High not-found rate"
  valueText: string;  // e.g. "52%"
  thresholdText: string;
}

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

// Same status definitions as monitor.service.ts summarizePeriod.
async function getWindowStats(windowMinutes: number): Promise<WindowStats> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
            count(*) FILTER (WHERE response_status = 'NOT_FOUND')::int AS not_found,
            count(*) FILTER (WHERE error_code = 'RATE_LIMITED')::int AS rate_limited,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms))::float8 AS p95
       FROM rag_request_log
      WHERE created_at >= now() - make_interval(mins => $1)`,
    [windowMinutes]
  );
  const r = rows[0];
  return {
    total: Number(r.total),
    errors: Number(r.errors),
    notFound: Number(r.not_found),
    rateLimited: Number(r.rate_limited),
    p95Ms: r.p95 === null ? null : Number(r.p95),
  };
}

// Pure: turns window stats into one result per rule. Rate and latency rules
// need ALERT_MIN_REQUESTS rows (below that they count as normal); the
// rate-limit rule does not.
export function evaluateRules(s: WindowStats, cfg = env.OBSERVABILITY): RuleResult[] {
  const enough = s.total >= cfg.ALERT_MIN_REQUESTS;
  const errorRate = s.total === 0 ? 0 : s.errors / s.total;
  const notFoundRate = s.total === 0 ? 0 : s.notFound / s.total;
  const p95 = s.p95Ms ?? 0;
  return [
    {
      rule: 'error_rate', breached: enough && errorRate > cfg.ALERT_ERROR_RATE, value: errorRate,
      title: 'High error rate', valueText: pct(errorRate), thresholdText: pct(cfg.ALERT_ERROR_RATE),
    },
    {
      rule: 'not_found_rate', breached: enough && notFoundRate > cfg.ALERT_NOT_FOUND_RATE, value: notFoundRate,
      title: 'High not-found rate', valueText: pct(notFoundRate), thresholdText: pct(cfg.ALERT_NOT_FOUND_RATE),
    },
    {
      rule: 'p95_latency', breached: enough && p95 > cfg.ALERT_P95_MS, value: p95,
      title: 'High p95 latency', valueText: `${Math.round(p95)} ms`, thresholdText: `${cfg.ALERT_P95_MS} ms`,
    },
    {
      rule: 'llm_rate_limited', breached: s.rateLimited > 0, value: s.rateLimited,
      title: 'LLM rate limiting', valueText: `${s.rateLimited} request(s)`, thresholdText: '0 requests',
    },
  ];
}

export interface AlertState { lastFiredAt: Date | null }
export interface AlertEvent { type: 'fired' | 'resolved'; result: RuleResult }

// Pure: decides what to send. A breached rule fires unless it fired within the
// cooldown; a rule that has fired and is back to normal resolves (once — the
// caller then clears its state).
export function decideAlertEvents(
  results: RuleResult[],
  states: Partial<Record<AlertRule, AlertState>>,
  now: Date,
  cooldownMinutes: number
): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const result of results) {
    const lastFiredAt = states[result.rule]?.lastFiredAt ?? null;
    if (result.breached) {
      const inCooldown = lastFiredAt !== null && now.getTime() - lastFiredAt.getTime() < cooldownMinutes * 60_000;
      if (!inCooldown) events.push({ type: 'fired', result });
    } else if (lastFiredAt !== null) {
      events.push({ type: 'resolved', result });
    }
  }
  return events;
}

async function sendEvent(e: AlertEvent, s: WindowStats): Promise<void> {
  const r = e.result;
  const win = env.OBSERVABILITY.ALERT_WINDOW_MINUTES;
  if (e.type === 'fired') {
    await sendAdminAlertEmail(`${r.title}: ${r.valueText} in last ${win} min`, [
      `Rule: ${r.rule}`,
      `Window: last ${win} minutes (${s.total} requests)`,
      `Value: ${r.valueText}`,
      `Threshold: ${r.thresholdText}`,
    ]);
    await query(
      `INSERT INTO observability_alert_state (rule, last_fired_at, last_value)
       VALUES ($1, now(), $2)
       ON CONFLICT (rule) DO UPDATE SET last_fired_at = now(), last_value = EXCLUDED.last_value`,
      [r.rule, r.value]
    );
  } else {
    await sendAdminAlertEmail(`Resolved: ${r.title}`, [
      `Rule: ${r.rule}`,
      `Window: last ${win} minutes (${s.total} requests)`,
      `Value now: ${r.valueText}`,
      `Threshold: ${r.thresholdText}`,
    ]);
    await query(`DELETE FROM observability_alert_state WHERE rule = $1`, [r.rule]);
  }
}

// One evaluation pass. Skipped when another instance holds the advisory lock.
// A failure in one rule (e.g. SMTP down) is logged and retried next tick
// because its state is only written after the email went out.
export async function runAlertCheck(): Promise<void> {
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [ALERT_LOCK_KEY]);
    if (!got.rows[0].ok) return;
    try {
      const stats = await getWindowStats(env.OBSERVABILITY.ALERT_WINDOW_MINUTES);
      const { rows } = await query<{ rule: AlertRule; last_fired_at: Date | null }>(
        `SELECT rule, last_fired_at FROM observability_alert_state`
      );
      const states: Partial<Record<AlertRule, AlertState>> = {};
      for (const r of rows) states[r.rule] = { lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at) : null };

      const events = decideAlertEvents(evaluateRules(stats), states, new Date(), env.OBSERVABILITY.ALERT_COOLDOWN_MINUTES);
      for (const e of events) {
        try {
          await sendEvent(e, stats);
        } catch (err) {
          logger.error(`[ALERTS] rule ${e.result.rule} failed`, err);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ALERT_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
