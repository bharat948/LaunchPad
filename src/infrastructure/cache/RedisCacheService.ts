import { Redis } from 'ioredis';
import dotenv from 'dotenv';
import { ICacheService, CacheMetrics } from './ICacheService.js';

dotenv.config();

export interface RedisCacheOptions {
  host?: string;
  port?: number;
  connectTimeout?: number;
  maxRetriesPerRequest?: number;
}

export class RedisCacheService implements ICacheService {
  private redis: Redis;
  private hits = 0;
  private misses = 0;
  private errors = 0;
  private sets = 0;
  private dels = 0;

  constructor(options?: RedisCacheOptions, customClient?: Redis) {
    if (customClient) {
      this.redis = customClient;
    } else {
      const host = options?.host || process.env.REDIS_HOST || 'localhost';
      const port = options?.port || parseInt(process.env.REDIS_PORT || '6379', 10);
      const connectTimeout = options?.connectTimeout || 5000;
      const maxRetriesPerRequest = options?.maxRetriesPerRequest ?? 5;

      this.redis = new Redis({
        host,
        port,
        connectTimeout,
        maxRetriesPerRequest,
        enableOfflineQueue: false, // Fail immediately when disconnected rather than buffering
        retryStrategy(times) {
          return Math.min(times * 100, 2000);
        },
      });
    }

    // Suppress unhandled error events from crashing Node.js runtime
    this.redis.on('error', (err) => {
      this.errors++;
      // Operational log for monitoring
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[RedisCacheService] Operational Redis Error: ${err.message}`);
      }
    });
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redis.get(key);
      if (!data) {
        this.misses++;
        return null;
      }
      this.hits++;
      return JSON.parse(data) as T;
    } catch (err) {
      // Fail-open: Redis outage gracefully degrades to database read
      this.errors++;
      this.misses++;
      return null;
    }
  }

  public async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.redis.set(key, serialized, 'EX', ttlSeconds);
      this.sets++;
    } catch (err) {
      // Fail-open: Swallow error so application flow never fails on cache write failure
      this.errors++;
    }
  }

  public async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
      this.dels++;
    } catch (err) {
      this.errors++;
    }
  }

  public getMetrics(): CacheMetrics {
    const totalReads = this.hits + this.misses;
    const hitRate = totalReads > 0 ? (this.hits / totalReads) * 100 : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      sets: this.sets,
      dels: this.dels,
      hitRate: Math.round(hitRate * 100) / 100,
    };
  }

  public resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
    this.sets = 0;
    this.dels = 0;
  }

  public async close(): Promise<void> {
    try {
      if (this.redis.status === 'ready' || this.redis.status === 'connecting') {
        await this.redis.quit();
      } else {
        this.redis.disconnect();
      }
    } catch {
      this.redis.disconnect();
    }
  }

  public getRawClient(): Redis {
    return this.redis;
  }
}

// Global shared singleton for application runtime
export const defaultCacheService = new RedisCacheService();
