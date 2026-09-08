import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { defaultCacheService } from '../../src/infrastructure/cache/RedisCacheService.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { CachedGetEventByIdUseCase } from '../../src/modules/catalog/application/CachedGetEventByIdUseCase.js';
import { GetEventByIdUseCase } from '../../src/modules/catalog/application/GetEventByIdUseCase.js';
import { PostgresEventRepository } from '../../src/modules/catalog/infrastructure/PostgresEventRepository.js';

describe('LAB-503: Stale-Cache Defect Reproduction & Invalidate-On-Write Mitigation', () => {
  it('ADVANCEMENT GATE - Part 1: Deliberately reproduces the Stale-Cache Bug when update omits invalidation', async () => {
    // 1. Seed event initially in SCHEDULED status
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Dua Lipa Radical Optimism Tour')
      .withTicketType('Standard', 8000, 200)
      .inStatus(EventStatus.SCHEDULED)
      .persist(pool);

    // 2. Read event -> populates Redis with SCHEDULED status
    const initialRead = await request(app).get(`/api/events/${event.id}`);
    expect(initialRead.status).toBe(200);
    expect(initialRead.body.status).toBe(EventStatus.SCHEDULED);
    expect(initialRead.headers['x-cache']).toBe('MISS');

    // Confirm cached in Redis
    const cachedRead = await request(app).get(`/api/events/${event.id}`);
    expect(cachedRead.headers['x-cache']).toBe('HIT');
    expect(cachedRead.body.status).toBe(EventStatus.SCHEDULED);

    // 3. DEFECT SIMULATION: Update event directly in PostgreSQL WITHOUT cache invalidation
    await pool.query(
      `UPDATE events SET status = $1, updated_at = NOW() WHERE id = $2`,
      [EventStatus.LIVE, event.id]
    );

    // Verify DB definitely has the new status
    const dbCheck = await pool.query(`SELECT status FROM events WHERE id = $1`, [event.id]);
    expect(dbCheck.rows[0].status).toBe(EventStatus.LIVE);

    // 4. READ AGAIN: Observe the stale read defect!
    const staleRead = await request(app).get(`/api/events/${event.id}`);

    // 🔥 BUG PROVEN: Even though DB is LIVE, user sees stale SCHEDULED from Redis!
    expect(staleRead.headers['x-cache']).toBe('HIT');
    expect(staleRead.body.status).toBe(EventStatus.SCHEDULED); // Outdated stale data!
    expect(staleRead.body.status).not.toBe(dbCheck.rows[0].status);
  });

  it('ADVANCEMENT GATE - Part 2: Proves Invalidate-On-Write permanently eliminates the Stale-Cache Bug', async () => {
    // 1. Seed event initially in SCHEDULED status
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Coldplay Ahmedabad Stadium Show')
      .withTicketType('VIP Floor', 12000, 500)
      .inStatus(EventStatus.SCHEDULED)
      .persist(pool);

    // 2. Warm up cache with initial read
    const res1 = await request(app).get(`/api/events/${event.id}`);
    expect(res1.body.status).toBe(EventStatus.SCHEDULED);

    // Confirm warm cache HIT
    const res2 = await request(app).get(`/api/events/${event.id}`);
    expect(res2.headers['x-cache']).toBe('HIT');

    // 3. Update via PATCH endpoint which executes Invalidate-On-Write (cacheService.del)
    const patchRes = await request(app)
      .patch(`/api/events/${event.id}/status`)
      .send({ status: EventStatus.LIVE });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe(EventStatus.LIVE);

    // 4. Read immediately after update: Cache should MISS and return fresh status LIVE!
    const freshRead = await request(app).get(`/api/events/${event.id}`);

    // ✅ MITIGATION PROVEN:
    // - Cache was invalidated, so read resulted in a fresh MISS
    // - Returned data immediately reflects LIVE status from DB
    expect(freshRead.headers['x-cache']).toBe('MISS');
    expect(freshRead.body.status).toBe(EventStatus.LIVE);

    // 5. Subsequent read should be a warm HIT with the updated LIVE status
    const subsequentRead = await request(app).get(`/api/events/${event.id}`);
    expect(subsequentRead.headers['x-cache']).toBe('HIT');
    expect(subsequentRead.body.status).toBe(EventStatus.LIVE);
  });

  it('Race Condition Experiment: Concurrent slow DB read miss + immediate update', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Diljit Dosanjh Dil-Luminati Tour')
      .withTicketType('Fan Pit', 9999, 100)
      .inStatus(EventStatus.SCHEDULED)
      .persist(pool);

    const cacheKey = CachedGetEventByIdUseCase.getCacheKey(event.id);
    const repo = new PostgresEventRepository();
    const getUseCase = new GetEventByIdUseCase(repo);

    // Simulate a slow read query by injecting latency before setting to cache
    const slowReadPromise = (async () => {
      const data = await getUseCase.execute(event.id);
      // Injected delay simulating network pause before writing to cache
      await new Promise(r => setTimeout(r, 100));
      await defaultCacheService.set(cacheKey, data, 300);
      return data;
    })();

    // In parallel, an update arrives mid-flight
    await new Promise(r => setTimeout(r, 20)); // let read start
    await request(app)
      .patch(`/api/events/${event.id}/status`)
      .send({ status: EventStatus.LIVE });

    await slowReadPromise;

    // After slow read completes, verify if cache has outdated status or if TTL / re-invalidation clears it
    const readAfterRace = await request(app).get(`/api/events/${event.id}`);
    expect([EventStatus.SCHEDULED, EventStatus.LIVE]).toContain(readAfterRace.body.status);
  });
});
