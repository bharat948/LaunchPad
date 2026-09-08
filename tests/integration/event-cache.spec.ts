import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { app } from '../../src/server.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { defaultCacheService, RedisCacheService } from '../../src/infrastructure/cache/RedisCacheService.js';
import { RequestCoalescer } from '../../src/infrastructure/cache/RequestCoalescer.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { createEventRouter } from '../../src/modules/catalog/interface/EventController.js';
import { errorHandlerMiddleware } from '../../src/middleware/errorHandlerMiddleware.js';

describe('LAB-502: Cache-Aside for Event Reads', () => {
  it('Cold path: First read should MISS cache, query DB, and populate Redis', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Coldplay Ahmedabad Tour')
      .withTicketType('VIP Lounge', 15000, 100)
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    // First request: Cache Miss
    const res1 = await request(app).get(`/api/events/${event.id}`);

    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.title).toBe('Coldplay Ahmedabad Tour');

    // Verify key was populated in Redis directly
    const rawRedis = defaultCacheService.getRawClient();
    const cachedData = await rawRedis.get(`events:v1:${event.id}`);
    expect(cachedData).not.toBeNull();
    const parsed = JSON.parse(cachedData!);
    expect(parsed.id).toBe(event.id);
    expect(parsed.title).toBe('Coldplay Ahmedabad Tour');
  });

  it('Warm path: Second read should HIT cache and return identical payload', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Lollapalooza India 2026')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    // 1. Cold Miss
    const res1 = await request(app).get(`/api/events/${event.id}`);
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');

    // 2. Warm Hit
    const res2 = await request(app).get(`/api/events/${event.id}`);
    expect(res2.status).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body).toEqual(res1.body);
  });

  it('Metrics: Instruments hit and miss counters accurately in isolated instance', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Sunburn Goa Festival')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    const isolatedCache = new RedisCacheService();
    const isolatedCoalescer = new RequestCoalescer();
    const setup = createEventRouter(isolatedCache, isolatedCoalescer);
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api', setup.router);
    testApp.use(errorHandlerMiddleware);

    // 1 Miss
    await request(testApp).get(`/api/events/${event.id}`);
    // 3 Hits
    await request(testApp).get(`/api/events/${event.id}`);
    await request(testApp).get(`/api/events/${event.id}`);
    await request(testApp).get(`/api/events/${event.id}`);

    const metricsRes = await request(testApp).get('/api/events/cache/metrics');
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.misses).toBe(1);
    expect(metricsRes.body.hits).toBe(3);
    expect(metricsRes.body.sets).toBe(1);
    expect(metricsRes.body.hitRate).toBe(75); // 3 / 4 = 75%
  });

  it('ADVANCEMENT GATE: System remains available and correct when Redis is down (Fail-Open)', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Arijit Singh Symphony Live')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    // Create an isolated test app with a broken/disconnected Redis cache service
    const brokenCacheService = new RedisCacheService({
      host: '127.0.0.1',
      port: 59999, // Non-existent dead port
      connectTimeout: 200,
      maxRetriesPerRequest: 0,
    });

    const brokenSetup = createEventRouter(brokenCacheService);
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api', brokenSetup.router);
    testApp.use(errorHandlerMiddleware);

    // Read should NOT fail with 500! It must fail-open to PostgreSQL
    const res = await request(testApp).get(`/api/events/${event.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(event.id);
    expect(res.body.title).toBe('Arijit Singh Symphony Live');
    expect(res.headers['x-cache']).toBe('MISS');

    // Verify error was tracked in cache metrics
    const metrics = brokenCacheService.getMetrics();
    expect(metrics.errors).toBeGreaterThan(0);

    await brokenCacheService.close();
  });
});
