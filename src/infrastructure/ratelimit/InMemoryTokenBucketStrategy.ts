import { IRateLimiterStrategy, RateLimitResult } from './IRateLimiterStrategy.js';
import { Clock, SystemClock } from '../../shared/domain/Clock.js';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketOptions {
  capacity: number; // Maximum burst size
  refillRate: number; // Tokens added per second
  clock?: Clock;
}

export class InMemoryTokenBucketStrategy implements IRateLimiterStrategy {
  private capacity: number;
  private refillRate: number;
  private clock: Clock;
  private buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.clock = options.clock || new SystemClock();
  }

  public async consume(key: string, cost: number = 1): Promise<RateLimitResult> {
    const nowMs = this.clock.now().getTime();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: this.capacity,
        lastRefillMs: nowMs,
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time: tokens = min(capacity, tokens + delta_t * rate)
    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    const refilledTokens = elapsedSeconds * this.refillRate;
    const currentTokens = Math.min(this.capacity, bucket.tokens + refilledTokens);

    if (currentTokens >= cost) {
      const remainingTokens = currentTokens - cost;
      bucket.tokens = remainingTokens;
      bucket.lastRefillMs = nowMs;

      // Time until bucket reaches full capacity again
      const timeToFullMs = Math.ceil(((this.capacity - remainingTokens) / this.refillRate) * 1000);

      return {
        allowed: true,
        limit: this.capacity,
        remaining: Math.floor(remainingTokens),
        resetMs: timeToFullMs,
        retryAfterSeconds: 0,
      };
    } else {
      // Not enough tokens: compute wait time until sufficient tokens replenish
      bucket.tokens = currentTokens;
      bucket.lastRefillMs = nowMs;

      const deficit = cost - currentTokens;
      const waitSeconds = Math.max(1, Math.ceil(deficit / this.refillRate));

      return {
        allowed: false,
        limit: this.capacity,
        remaining: Math.floor(currentTokens),
        resetMs: waitSeconds * 1000,
        retryAfterSeconds: waitSeconds,
      };
    }
  }

  public async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }
}
