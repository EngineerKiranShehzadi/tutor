/** Bounded, opt-in database-page warm-up. It never generates/caches answers. */
export interface WarmupConfig {
  enabled: boolean; samples: number; timeoutMs: number; connectTimeoutMs: number;
  cooldownMs: number; globalGapMs: number;
}
export function readWarmupConfig(source: Record<string, string | undefined>): WarmupConfig {
  const flag = (source.RAG_DB_WARMUP_ENABLED ?? 'false').trim();
  if (!['true', 'false'].includes(flag)) throw new Error('RAG_DB_WARMUP_ENABLED must be true or false');
  const n = (key: string, fallback: number, min: number, max: number) => {
    const raw = (source[key] ?? '').trim(), value = raw ? Number(raw) : fallback;
    if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  return { enabled: flag === 'true', samples: n('RAG_DB_WARMUP_SAMPLES', 2, 1, 3),
    timeoutMs: n('RAG_DB_WARMUP_TIMEOUT_MS', 5000, 500, 15000),
    connectTimeoutMs: n('RAG_DB_WARMUP_CONNECT_TIMEOUT_MS', 2000, 250, 5000),
    cooldownMs: n('RAG_DB_WARMUP_COOLDOWN_MS', 120000, 30000, 600000),
    globalGapMs: n('RAG_DB_WARMUP_GLOBAL_GAP_MS', 10000, 1000, 60000) };
}
export const validLectureId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
export function parseSeed(text: string, dimensions: number): number[] {
  const v: unknown = JSON.parse(text);
  if (!Array.isArray(v) || v.length !== dimensions ||
      !v.every(x => typeof x === 'number' && Number.isFinite(x)) || !v.some(x => x !== 0)) {
    throw new Error('INVALID_WARMUP_SEED');
  }
  return v as number[];
}
export interface WarmupResult {
  status: 'DISABLED' | 'BUSY' | 'COOLDOWN' | 'NOT_READY' | 'NO_VALID_SEED' | 'SAMPLED_WARMUP_COMPLETE';
  lectureId: number; versionId?: number; sampleQueries?: number; durationMs?: number;
}
export type WarmTask = (id: number, recent: (version: number) => boolean) => Promise<WarmupResult>;
export class WarmupCoordinator {
  private running = new Map<number, Promise<WarmupResult>>();
  private completed = new Map<string, number>();
  private nextAllowed = 0;
  constructor(private config: WarmupConfig, private task: WarmTask, private now: () => number = Date.now) {}
  run(lectureId: number): Promise<WarmupResult> {
    if (!validLectureId(lectureId)) return Promise.reject(new Error('INVALID_LECTURE_ID'));
    if (!this.config.enabled) return Promise.resolve({ status: 'DISABLED', lectureId });
    const existing = this.running.get(lectureId);
    if (existing) return existing;
    if (this.running.size || this.now() < this.nextAllowed) return Promise.resolve({ status: 'BUSY', lectureId });
    this.nextAllowed = this.now() + this.config.globalGapMs;
    const recent = (v: number) => this.now() < (this.completed.get(`${lectureId}:${v}`) ?? 0);
    const pending = Promise.resolve().then(() => this.task(lectureId, recent)).then(result => {
      if (result.status === 'SAMPLED_WARMUP_COMPLETE' && result.versionId) {
        for (const [key, expiry] of this.completed) if (expiry <= this.now()) this.completed.delete(key);
        const key = `${lectureId}:${result.versionId}`;
        this.completed.delete(key); this.completed.set(key, this.now() + this.config.cooldownMs);
        while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!);
      }
      return result;
    }).finally(() => { this.running.delete(lectureId); });
    this.running.set(lectureId, pending);
    return pending;
  }
}
export interface WarmClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(destroy?: boolean): void;
}
export interface WarmPool { connect(): Promise<WarmClient> }
export function borrowWithDeadline(pool: WarmPool, timeoutMs: number): Promise<WarmClient> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; reject(new Error('WARMUP_CONNECT_TIMEOUT')); }, timeoutMs);
    pool.connect().then(client => {
      if (finished) { client.release(); return; }
      finished = true; clearTimeout(timer); resolve(client);
    }, error => {
      if (!finished) { finished = true; clearTimeout(timer); reject(error); }
    });
  });
}
// Same full-precision cosine metric, lecture/version scope and top-15 shape as
// normal retrieval. The planner chooses exact/HNSW; no plan is forced here.
export const WARM_SEARCH_SQL = `SELECT c.id, c.chunk_text,
  1 - (c.local_embedding <=> $1::vector) AS similarity
  FROM public.lecture_qna_chunks c
  WHERE c.lecture_id = $2 AND c.local_embedding IS NOT NULL
    AND c.id IN (SELECT chunk_id FROM public.dataset_version_chunks WHERE version_id = $3)
  ORDER BY c.local_embedding <=> $1::vector LIMIT 15`;
export async function warmLecture(pool: WarmPool, config: WarmupConfig, lectureId: number,
  dimensions: number, modelVersion: string, recent: (version: number) => boolean): Promise<WarmupResult> {
  if (!validLectureId(lectureId)) throw new Error('INVALID_LECTURE_ID');
  const started = Date.now(), client = await borrowWithDeadline(pool, config.connectTimeoutMs);
  let released = false, transaction = false;
  const deadline = setTimeout(() => { released = true; client.release(true); }, config.timeoutMs);
  const run = async (sql: string, values?: unknown[]) => {
    if (released) throw new Error('WARMUP_DEADLINE');
    return client.query(sql, values);
  };
  try {
    await run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await run("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '500ms', true)", [String(config.timeoutMs)]);
    // Global transaction lock prevents simultaneous expensive warm-ups across replicas.
    const lock = await run('SELECT pg_try_advisory_xact_lock(1095977801, 1) AS acquired');
    if (!lock.rows[0]?.acquired) return { status: 'BUSY', lectureId };
    const scope = await run(`SELECT active_version_id FROM public.lectures
      WHERE id = $1 AND status = 'READY'`, [lectureId]);
    const version = Number(scope.rows[0]?.active_version_id);
    if (!validLectureId(version)) return { status: 'NOT_READY', lectureId };
    if (recent(version)) return { status: 'COOLDOWN', lectureId, versionId: version };
    const seeds = await run(`WITH numbered AS MATERIALIZED (
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.id) AS rn, COUNT(*) OVER () AS total
      FROM public.lecture_qna_chunks c
      WHERE c.lecture_id = $1 AND c.embedding_model_version = $3 AND c.local_embedding IS NOT NULL
        AND c.id IN (SELECT chunk_id FROM public.dataset_version_chunks WHERE version_id = $2)
    ), chosen AS (
      SELECT DISTINCT n.id FROM numbered n JOIN generate_series(0, $4::int - 1) s(i)
        ON n.rn = 1 + FLOOR(s.i::numeric * (n.total - 1) / GREATEST($4::int - 1, 1))
    ) SELECT c.local_embedding::text AS vector_text FROM chosen
      JOIN public.lecture_qna_chunks c ON c.id = chosen.id ORDER BY c.id`,
    [lectureId, version, modelVersion, config.samples]);
    let count = 0;
    for (const seed of seeds.rows) {
      let vector: number[];
      try { vector = parseSeed(seed.vector_text, dimensions); } catch { continue; }
      await run(WARM_SEARCH_SQL, [JSON.stringify(vector), lectureId, version]); count++;
    }
    if (released) throw new Error('WARMUP_DEADLINE');
    return { status: count ? 'SAMPLED_WARMUP_COMPLETE' : 'NO_VALID_SEED', lectureId,
      versionId: version, sampleQueries: count, durationMs: Date.now() - started };
  } finally {
    if (!released) {
      try { if (transaction) await run('ROLLBACK'); }
      catch { if (!released) { released = true; client.release(true); } }
      finally { clearTimeout(deadline); if (!released) { released = true; client.release(); } }
    } else clearTimeout(deadline);
  }
}
