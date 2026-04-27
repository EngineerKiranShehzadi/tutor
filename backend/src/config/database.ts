import { Pool } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';

const pool = new Pool(
  env.DB.URL
    ? { connectionString: env.DB.URL, ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }
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
  const client = await pool.connect();
  client.release();
  logger.info('PostgreSQL connected');
};

export default pool;
