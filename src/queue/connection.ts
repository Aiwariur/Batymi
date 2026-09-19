import IORedis from "ioredis";

/**
 * Redis connection dedicated to BullMQ. BullMQ requires
 * maxRetriesPerRequest = null so blocking commands are never aborted.
 */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

/**
 * Plain Redis connection used by the conversation store.
 */
export function createStoreConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
