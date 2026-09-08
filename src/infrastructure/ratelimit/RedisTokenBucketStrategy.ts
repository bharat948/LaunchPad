import { Redis } from 'ioredis';
import { IRateLimiterStrategy, RateLimitResult } from './IRateLimiterStrategy.js';
import { defaultCacheService, RedisCacheService } from '../cache/RedisCacheService.js';

export interface RedisTokenBucketOptions {
  capacity: number;
  refillRate: number; // Tokens per second
  redisClient?: Redis;
}

const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_updated')
local tokens = tonumber(bucket[1])
local last_updated = tonumber(bucket[2])

if not tokens then
  tokens = capacity
  last_updated = now
end

local elapsed = math.max(0, now - last_updated)
local refilled = elapsed * refill_rate
local current_tokens = math.min(capacity, tokens + refilled)

local allowed = 0
local remaining = current_tokens
local retry_after = 0

if current_tokens >= cost then
  allowed = 1
  remaining = current_tokens - cost
  redis.call('HMSET', key, 'tokens', remaining, 'last_updated', now)
  local ttl = math.ceil((capacity / refill_rate) * 2)
  redis.call('EXPIRE', key, math.max(60, ttl))
else
  allowed = 0
  remaining = current_tokens
  local deficit = cost - current_tokens
  retry_after = math.max(1, math.ceil(deficit / refill_rate))
  redis.call('HMSET', key, 'tokens', current_tokens, 'last_updated', now)
  local ttl = math.ceil((capacity / refill_rate) * 2)
  redis.call('EXPIRE', key, math.max(60, ttl))
end

local time_to_full = math.ceil(((capacity - remaining) / refill_rate) * 1000)
return { allowed, math.floor(remaining), time_to_full, retry_after }
`;

export class RedisTokenBucketStrategy implements IRateLimiterStrategy {
  private capacity: number;
  private refillRate: number;
  private redis: Redis;

  constructor(options: RedisTokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.redis = options.redisClient || defaultCacheService.getRawClient();
  }

  public async consume(key: string, cost: number = 1): Promise<RateLimitResult> {
    try {
      const nowSeconds = Date.now() / 1000;
      const redisKey = `ratelimit:v1:${key}`;

      const res = (await this.redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        redisKey,
        this.capacity,
        this.refillRate,
        cost,
        nowSeconds
      )) as [number, number, number, number];

      const allowed = res[0] === 1;
      const remaining = res[1];
      const resetMs = res[2];
      const retryAfterSeconds = res[3];

      return {
        allowed,
        limit: this.capacity,
        remaining,
        resetMs,
        retryAfterSeconds,
      };
    } catch (err) {
      // Fail-open policy: If Redis fails, permit request rather than blocking legitimate users
      console.warn(`[RedisTokenBucketStrategy] Rate limiter operational error: ${(err as Error).message}`);
      return {
        allowed: true,
        limit: this.capacity,
        remaining: this.capacity,
        resetMs: 0,
        retryAfterSeconds: 0,
      };
    }
  }

  public async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`ratelimit:v1:${key}`);
    } catch {
      // Ignore
    }
  }
}
