import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

// Strip params pg driver doesn't understand (e.g. channel_binding)

const buildConnectionString = (): string => {
  const url = process.env.DATABASE_URL ?? '';
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
};

const pool = new Pool({
  connectionString: buildConnectionString(),
  // ssl: { rejectUnauthorized: false }, // Required for Neon DB
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => logger.info('New DB client connected'));
pool.on('error', (err) => logger.error('Unexpected DB pool error', err));

export const query = async <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn('Slow query detected', { text: text.substring(0, 100), duration });
    }
    return result.rows as T[];
  } catch (error) {
    logger.error('DB query error', { text: text.substring(0, 100), error });
    throw error;
  }
};

export const queryOne = async <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> => {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
};

export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const checkDbConnection = async (): Promise<boolean> => {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
};

export { pool };

