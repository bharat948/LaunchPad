import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import { RedisTokenBucketStrategy } from '../../src/infrastructure/ratelimit/RedisTokenBucketStrategy.js';
import { defaultCacheService } from '../../src/infrastructure/cache/RedisCacheService.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { pool } from '../../src/infrastructure/db/postgres.js';

describe('LAB-602: Rate Limiter Middleware & Shared Redis Enforcement', () => {
  let eventId: string;

  beforeEach(async () => {
    const rawRedis = defaultCacheService.getRawClient();
    if (rawRedis.status === 'ready') {
      const keys = await rawRedis.keys('ratelimit:v1:*');
      if (keys.length > 0) {
        await rawRedis.del(...keys);
      }
    }

    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Dua Lipa Rate Limited Concert')
      .inStatus(EventStatus.LIVE)
      .persist(pool);
    eventId = event.id;
  });

  it('Throttling & RFC Headers: Enforces quota, emits X-RateLimit-* headers, and returns 429 with Retry-After', async () => {
    const limiter = new RedisTokenBucketStrategy({
      capacity: 3,
      refillRate: 1, // 1 token per second
    });

    const app = createApp({
      instanceId: 'rate-limited-app',
      rateLimiterStrategy: limiter,
    });

    // Request 1
    const res1 = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '10.0.0.1');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe('3');
    expect(res1.headers['x-ratelimit-remaining']).toBe('2');
    expect(res1.headers['x-ratelimit-reset']).toBeDefined();

    // Request 2
    const res2 = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '10.0.0.1');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('1');

    // Request 3
    const res3 = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '10.0.0.1');
    expect(res3.status).toBe(200);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');

    // Request 4: Over capacity -> Throttled with HTTP 429!
    const res4 = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '10.0.0.1');
    expect(res4.status).toBe(429);
    expect(res4.headers['retry-after']).toBeDefined();
    expect(Number(res4.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res4.body).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: expect.stringContaining('Too many requests'),
        retryAfterSeconds: expect.any(Number),
      },
    });
  });

  it('Scoping: Throttling Client A does not affect Client B', async () => {
    const limiter = new RedisTokenBucketStrategy({
      capacity: 2,
      refillRate: 1,
    });

    const app = createApp({ rateLimiterStrategy: limiter });

    // Client A uses up all quota
    await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '192.168.1.100');
    await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '192.168.1.100');
    const throttledA = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '192.168.1.100');
    expect(throttledA.status).toBe(429);

    // Client B sends request: should be 100% unaffected
    const resB = await request(app).get(`/api/events/${eventId}`).set('X-Forwarded-For', '192.168.1.200');
    expect(resB.status).toBe(200);
    expect(resB.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('ADVANCEMENT GATE: Multi-Instance Shared Enforcement via Redis', async () => {
    const SHARED_CAPACITY = 4;
    const sharedLimiter = new RedisTokenBucketStrategy({
      capacity: SHARED_CAPACITY,
      refillRate: 0.5, // 1 token every 2 seconds
    });

    // Two distinct horizontal app instances sharing the same Redis limiter
    const inst1 = createApp({ instanceId: 'inst-1', rateLimiterStrategy: sharedLimiter });
    const inst2 = createApp({ instanceId: 'inst-2', rateLimiterStrategy: sharedLimiter });

    const CLIENT_IP = '172.16.0.50';

    // Request 1 on inst-1: Allowed (Remaining = 3)
    const r1 = await request(inst1).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r1.status).toBe(200);
    expect(r1.headers['x-served-by']).toBe('inst-1');
    expect(r1.headers['x-ratelimit-remaining']).toBe('3');

    // Request 2 on inst-2: Allowed (Remaining = 2)
    const r2 = await request(inst2).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r2.status).toBe(200);
    expect(r2.headers['x-served-by']).toBe('inst-2');
    expect(r2.headers['x-ratelimit-remaining']).toBe('2');

    // Request 3 on inst-1: Allowed (Remaining = 1)
    const r3 = await request(inst1).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r3.status).toBe(200);
    expect(r3.headers['x-served-by']).toBe('inst-1');
    expect(r3.headers['x-ratelimit-remaining']).toBe('1');

    // Request 4 on inst-2: Allowed (Remaining = 0)
    const r4 = await request(inst2).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r4.status).toBe(200);
    expect(r4.headers['x-served-by']).toBe('inst-2');
    expect(r4.headers['x-ratelimit-remaining']).toBe('0');

    // Request 5 on inst-1: THROTTLED (HTTP 429)!
    const r5 = await request(inst1).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r5.status).toBe(429);
    expect(r5.headers['x-served-by']).toBe('inst-1');
    expect(r5.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // Request 6 on inst-2: ALSO THROTTLED (HTTP 429)!
    const r6 = await request(inst2).get(`/api/events/${eventId}`).set('X-Forwarded-For', CLIENT_IP);
    expect(r6.status).toBe(429);
    expect(r6.headers['x-served-by']).toBe('inst-2');
    expect(r6.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
