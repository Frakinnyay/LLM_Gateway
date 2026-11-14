import Redis from 'ioredis';

export { KEY_NS } from '../../shared/src/constants';

export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2, // fail fast instead of queueing forever when Redis is down
    enableReadyCheck: true,
  });
  redis.on('error', (err) => console.error('redis error:', err.message));
  return redis;
}
