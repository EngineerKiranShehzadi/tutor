import pool from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runAlertCheck } from './alerts.service';

// Timers for the email alert check and the daily rag_request_log cleanup.
// Retention always runs (it used to start only with email alerts, which ship
// disabled, so the 90-day retention never ran); the alert check only when
// OBSERVABILITY_ALERTS_ENABLED. All timers are unref()'d and cleared by
// stopMaintenanceScheduler().

const RETENTION_LOCK_KEY = 804002;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_FIRST_RUN_DELAY_MS = 60_000;
const DELETE_BATCH = 10_000;

let alertTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let retentionStartTimer: NodeJS.Timeout | null = null;
let alertRunning = false;
let retentionRunning = false;

export async function runRetention(): Promise<number> {
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
          [env.OBSERVABILITY.RETENTION_DAYS, DELETE_BATCH]
        );
        total += res.rowCount ?? 0;
        if ((res.rowCount ?? 0) < DELETE_BATCH) break;
      }
      if (total > 0) logger.info(`[RETENTION] deleted ${total} rag_request_log rows older than ${env.OBSERVABILITY.RETENTION_DAYS} days`);
      return total;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]);
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

  logger.info(`[MAINTENANCE] scheduler started: request-log retention ${env.OBSERVABILITY.RETENTION_DAYS}d (daily); `
    + (alertTimer ? `email alerts every ${env.OBSERVABILITY.ALERT_CHECK_INTERVAL_MS}ms` : 'email alerts off (OBSERVABILITY_ALERTS_ENABLED=false)'));
}

// Which parts are running — for tests and diagnostics.
export function maintenanceSchedulerState(): { retention: boolean; alerts: boolean } {
  return { retention: retentionTimer !== null, alerts: alertTimer !== null };
}

export function stopMaintenanceScheduler(): void {
  if (alertTimer) clearInterval(alertTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  if (retentionStartTimer) clearTimeout(retentionStartTimer);
  alertTimer = retentionTimer = retentionStartTimer = null;
}
