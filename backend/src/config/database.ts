import { Pool } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';

const pool = new Pool(
  env.DB.URL
    ? { connectionString: env.DB.URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     env.DB.HOST,
        port:     env.DB.PORT,
        database: env.DB.NAME,
        user:     env.DB.USER,
        password: env.DB.PASSWORD,
        ssl:      env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      }
);

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', err);
});

export const query = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
  // cast through unknown to bypass pg's QueryResultRow constraint while keeping our generic T
) => pool.query(text, params) as unknown as Promise<{ rows: T[]; rowCount: number | null }>;

export const connectDB = async (): Promise<void> => {
  const MAX_RETRIES = 7;
  const BASE_DELAY  = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info('PostgreSQL connected');
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY * attempt;
      const agg = err as { errors?: Error[] };
      const detail = agg.errors?.map((e) => e.message || e.code).join(', ');
      const msg = detail || (err instanceof Error ? (err.message || err.toString()) : String(err));
      logger.warn(`[DB] Connection attempt ${attempt} failed — retrying in ${delay}ms… ${msg}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

export default pool;
