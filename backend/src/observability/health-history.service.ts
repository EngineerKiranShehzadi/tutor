import { query } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { checkReadiness } from './health.service';
import type { ComponentHealth, ReadinessResult } from './health.service';

/**
 * History for /health/ready.
 *
 * checkReadiness() answers "is everything up right now" and keeps nothing. A
 * dependency that failed overnight and recovered by morning left no trace, so
 * the System Health page could only ever show five green rows. This records
 * one row per component per poll (table: health_check_log, migration 028) and
 * reads back uptime over a window plus the time of the last failure.
 */

export interface ComponentHistory {
  component: string;
  /** Share of checks that passed, 0..1. null when nothing was counted. */
  uptime: number | null;
  /** How many checks that share is based on, so the page can say so. */
  sampleCount: number;
  /** Most recent failure, across all retained history, not just the window. */
  lastFailureAt: string | null;
}

/**
 * latencyMs is 0 both for a probe that failed and for a provider that is
 * configured but has no free probe to time. Storing that 0 would make a
 * service that never answered look like one that answered instantly, and
 * would pull every average down with a measurement that never happened.
 * Nothing measured is stored as NULL.
 */
const measuredLatency = (c: ComponentHealth): number | null =>
  c.status === 'healthy' && c.latencyMs > 0 ? c.latencyMs : null;

// Consecutive failures per component, in memory. This is what finally gives
// ALERT_CONSECUTIVE_HEALTH_FAILURES something to count: the setting has been
// in env.ts and .env all along, but nothing read it, so it did nothing.
//
// It logs rather than emails. Email alerting runs off rag_request_log rules in
// alerts.service.ts and ships disabled; wiring health failures into it is the
// next step, not this one. Counting from zero on restart is intended: a
// process that has just started has not observed any consecutive anything.
const consecutiveFailures = new Map<string, number>();

/** Tests only. */
export const resetConsecutiveFailures = (): void => consecutiveFailures.clear();

function trackConsecutiveFailures(components: ReadinessResult['components']): void {
  const threshold = env.OBSERVABILITY.ALERT_CONSECUTIVE_HEALTH_FAILURES;
  for (const [name, c] of Object.entries(components)) {
    const prev = consecutiveFailures.get(name) ?? 0;

    // Only `unhealthy` counts. `degraded` means the check could not be run
    // (UNVERIFIED_PROVIDER), which is not evidence that anything is wrong.
    if (c.status === 'unhealthy') {
      const next = prev + 1;
      consecutiveFailures.set(name, next);
      // `===` not `>=`: this fires once, as the threshold is crossed, rather
      // than on every poll for as long as the outage lasts.
      if (next === threshold) {
        logger.error(`[HEALTH] ${name} has failed ${next} consecutive checks (code=${c.errorCode ?? 'none'})`);
      }
      continue;
    }

    if (prev >= threshold) logger.info(`[HEALTH] ${name} recovered after ${prev} consecutive failures`);
    consecutiveFailures.set(name, 0);
  }
}

/**
 * Runs one readiness check and stores its result. Returns the rows written.
 *
 * One INSERT for all components on purpose: now() is the transaction
 * timestamp, so every row of a poll shares one checked_at and the samples
 * group cleanly instead of being smeared across a few hundred milliseconds.
 */
export async function recordHealthCheck(): Promise<number> {
  const result = await checkReadiness();
  trackConsecutiveFailures(result.components);

  const entries = Object.entries(result.components);
  if (entries.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = entries.map(([name, c], i) => {
    const b = i * 4;
    values.push(name, c.status, measuredLatency(c), c.errorCode ?? null);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  });

  await query(
    `INSERT INTO health_check_log (component, status, latency_ms, error_code)
     VALUES ${tuples.join(', ')}`,
    values
  );
  return entries.length;
}

interface WindowRow { component: string; counted: number; healthy: number }
interface FailureRow { component: string; last_failure_at: string }

/**
 * Uptime over the last `windowHours`, plus the last failure of all time.
 *
 * The two are deliberately scoped differently. Uptime has to be over a stated
 * window or the number means nothing. "Last failure" is most useful unbounded:
 * being told a service last failed four days ago is the answer, and a 24 hour
 * window would have reported nothing at all. Retention bounds it in practice.
 *
 * `degraded` is excluded from both the numerator and the denominator. It means
 * the check could not be run, so counting it as a failure would understate a
 * service that is fine, and counting it as a success would overstate one that
 * was never actually verified.
 */
export async function getHealthHistory(windowHours = 24): Promise<ComponentHistory[]> {
  const [windowed, failures] = await Promise.all([
    query<WindowRow>(
      `SELECT component,
              count(*) FILTER (WHERE status IN ('healthy', 'unhealthy'))::int AS counted,
              count(*) FILTER (WHERE status = 'healthy')::int               AS healthy
         FROM health_check_log
        WHERE checked_at >= now() - make_interval(hours => $1)
        GROUP BY component`,
      [windowHours]
    ),
    query<FailureRow>(
      `SELECT component, max(checked_at) AS last_failure_at
         FROM health_check_log
        WHERE status = 'unhealthy'
        GROUP BY component`
    ),
  ]);

  const lastFailure = new Map(failures.rows.map(r => [r.component, r.last_failure_at]));
  const seen = new Map<string, ComponentHistory>();

  for (const r of windowed.rows) {
    seen.set(r.component, {
      component: r.component,
      uptime: r.counted > 0 ? r.healthy / r.counted : null,
      sampleCount: r.counted,
      lastFailureAt: lastFailure.get(r.component) ?? null,
    });
  }

  // A component that has only ever failed outside the window still has a last
  // failure worth reporting, so it must not be dropped for having no samples
  // inside it.
  for (const [component, at] of lastFailure) {
    if (!seen.has(component)) {
      seen.set(component, { component, uptime: null, sampleCount: 0, lastFailureAt: at });
    }
  }

  return [...seen.values()];
}
