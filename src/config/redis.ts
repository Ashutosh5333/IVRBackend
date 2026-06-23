import Redis from 'ioredis';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

const createRedisClient = (): Redis => {
  const redisUrl = process.env.REDIS_URL ?? '';

  // Upstash requires TLS — force rediss:// protocol
  const tlsUrl = redisUrl.startsWith('redis://')
    ? redisUrl.replace('redis://', 'rediss://')
    : redisUrl;

  const client = new Redis(tlsUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    enableReadyCheck: false,  // Upstash blocks PING on connect
    lazyConnect: false,
    tls: { rejectUnauthorized: false }, // Required for Upstash TLS
  });

  client.on('connect', () => logger.info('Redis connected'));
  client.on('error', (err) => logger.error('Redis error', err));
  client.on('close', () => logger.warn('Redis connection closed'));

  return client;
};

export const redis = createRedisClient();

export const acquireLock = async (
  key: string,
  ttlSeconds: number = 60
): Promise<boolean> => {
  const result = await redis.set(`lock:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
};

export const releaseLock = async (key: string): Promise<void> => {
  await redis.del(`lock:${key}`);
};

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  const val = await redis.get(key);
  return val ? (JSON.parse(val) as T) : null;
};

export const cacheSet = async (
  key: string,
  value: unknown,
  ttlSeconds: number = 300
): Promise<void> => {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
};

export const cacheDel = async (key: string): Promise<void> => {
  await redis.del(key);
};

export const cacheDelPattern = async (pattern: string): Promise<void> => {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
};

export const setActiveCall = async (
  tenantId: string,
  candidateId: string,
  callSid: string
): Promise<void> => {
  await redis.hset(`active_calls:${tenantId}`, candidateId, callSid);
  await redis.expire(`active_calls:${tenantId}`, 3600);
};

export const removeActiveCall = async (
  tenantId: string,
  candidateId: string
): Promise<void> => {
  await redis.hdel(`active_calls:${tenantId}`, candidateId);
};

export const getActiveCalls = async (
  tenantId: string
): Promise<Record<string, string>> => {
  return (await redis.hgetall(`active_calls:${tenantId}`)) ?? {};
};

export const countActiveCalls = async (tenantId: string): Promise<number> => {
  const calls = await getActiveCalls(tenantId);
  return Object.keys(calls).length;
};
