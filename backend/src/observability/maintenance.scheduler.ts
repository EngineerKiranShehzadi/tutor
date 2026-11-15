import pool from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runAlertCheck } from './alerts.service';
import { recordHealthCheck } from './health-history.service';

// Timers for the email alert check and the daily rag_request_log cleanup.
// Retention always runs (it used to start only with email alerts, which ship
// disabled, so the 90-day retention never ran); the alert check only when
// OBSERVABILITY_ALERTS_ENABLED. All timers are unref()'d and cleared by
// stopMaintenanceScheduler().

const RETENTION_LOCK_KEY = 804002;
const HEALTH_POLL_LOCK_KEY = 804003;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_FIRST_RUN_DELAY_MS = 60_000;
// Sooner than retention's minute: the first sample is what stops the System
// Health page showing "no history yet" for the whole of a fresh boot, and the
// probes it runs are the same ones the page itself already triggers.
const HEALTH_POLL_FIRST_RUN_DELAY_MS = 20_000;
const DELETE_BATCH = 10_000;

let alertTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let retentionStartTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let healthStartTimer: NodeJS.Timeout | null = null;
let alertRunning = false;
let retentionRunning = false;
let healthRunning = false;

export async function runRetention(): Promise<number> {
  // Defensive floor: a cutoff of now() would delete the whole log. env.ts
  // already refuses 0 or a non-number at boot (positiveInt); this guards any
  // other way the value could reach here.
  const days = Math.max(1, env.OBSERVABILITY.RETENTION_DAYS);
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [RETENTION_LOCK_KEY]);
    if (!got.rows[0].ok) return 0;
    try {
      let total = 0;
      for (;;) {
        const res = await client.query(
          `DELETE FROM rag_request_log
            WHERE id IN (SELECT id FROM rag_request_log
                          WHERE created_at < now() - make_interval(days => $1)
                          LIMIT $2)`,
          [days, DELETE_BATCH]
        );
        total += res.rowCount ?? 0;
        if ((res.rowCount ?? 0) < DELETE_BATCH) break;
      }
      // health_check_log follows the same policy: it is observability data of
      // the same kind, with the same reason to expire, so it gets the same
      // retention rather than a second setting to keep in step with this one.
      let healthTotal = 0;
      for (;;) {
        const res = await client.query(
          `DELETE FROM health_check_log
            WHERE id IN (SELECT id FROM health_check_log
                          WHERE checked_at < now() - make_interval(days => $1)
                          LIMIT $2)`,
          [days, DELETE_BATCH]
        );
        healthTotal += res.rowCount ?? 0;
        if ((res.rowCount ?? 0) < DELETE_BATCH) break;
      }

      if (total > 0) logger.info(`[RETENTION] deleted ${total} rag_request_log rows older than ${days} days`);
      if (healthTotal > 0) logger.info(`[RETENTION] deleted ${healthTotal} health_check_log rows older than ${days} days`);
      return total;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * One readiness check, recorded. Advisory-locked like retention so two runs
 * cannot overlap: a slow probe must not have the next tick start a second
 * check beside it and write two samples for the same moment.
 */
export async function runHealthPoll(): Promise<number> {
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [HEALTH_POLL_LOCK_KEY]);
    if (!got.rows[0].ok) return 0;
    try {
      return await recordHealthCheck();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [HEALTH_POLL_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function startMaintenanceScheduler(): void {
  if (retentionTimer) return;

  if (env.OBSERVABILITY.ALERTS_ENABLED) {
    alertTimer = setInterval(() => {
      if (alertRunning) return;
      alertRunning = true;
      runAlertCheck()
        .catch(err => logger.error('[ALERTS] check failed', err))
        .finally(() => { alertRunning = false; });
    }, env.OBSERVABILITY.ALERT_CHECK_INTERVAL_MS);
    alertTimer.unref();
  }

  const retention = (): void => {
    if (retentionRunning) return;
    retentionRunning = true;
    runRetention()
      .catch(err => logger.error('[RETENTION] cleanup failed', err))
      .finally(() => { retentionRunning = false; });
  };
  retentionStartTimer = setTimeout(retention, RETENTION_FIRST_RUN_DELAY_MS);
  retentionStartTimer.unref();
  retentionTimer = setInterval(retention, DAY_MS);
  retentionTimer.unref();

  // Health history. Runs always, like retention and for the same reason: the
  // page that reads it is of no use with gaps in the record, and a poll that
  // only runs when some other feature is enabled is a poll that never runs.
  const healthPoll = (): void => {
    if (healthRunning) return;
    healthRunning = true;
    runHealthPoll()
      .catch(err => logger.error('[HEALTH-HISTORY] poll failed', err))
      .finally(() => { healthRunning = false; });
  };
  healthStartTimer = setTimeout(healthPoll, HEALTH_POLL_FIRST_RUN_DELAY_MS);
  healthStartTimer.unref();
  healthTimer = setInterval(healthPoll, env.HEALTH.POLL_INTERVAL_MS);
  healthTimer.unref();

  logger.info(`[MAINTENANCE] scheduler started: request-log and health-history retention ${env.OBSERVABILITY.RETENTION_DAYS}d (daily); `
    + `health poll every ${env.HEALTH.POLL_INTERVAL_MS}ms; `
    + (alertTimer ? `email alerts every ${env.OBSERVABILITY.ALERT_CHECK_INTERVAL_MS}ms` : 'email alerts off (OBSERVABILITY_ALERTS_ENABLED=false)'));
}

// Which parts are running — for tests and diagnostics.
export function maintenanceSchedulerState(): { retention: boolean; alerts: boolean; healthPoll: boolean } {
  return { retention: retentionTimer !== null, alerts: alertTimer !== null, healthPoll: healthTimer !== null };
}

export function stopMaintenanceScheduler(): void {
  if (alertTimer) clearInterval(alertTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  if (retentionStartTimer) clearTimeout(retentionStartTimer);
  if (healthTimer) clearInterval(healthTimer);
  if (healthStartTimer) clearTimeout(healthStartTimer);
  alertTimer = retentionTimer = retentionStartTimer = healthTimer = healthStartTimer = null;
}
