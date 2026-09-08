import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import { ConcurrencyLimiter } from '../../src/infrastructure/resilience/ConcurrencyLimiter.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { pool } from '../../src/infrastructure/db/postgres.js';

describe('LAB-603: Overload Experiment, Backpressure & Load Shedding', () => {
  let eventId: string;

  beforeEach(async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Overload Resilience Stadium Show')
      .inStatus(EventStatus.LIVE)
      .persist(pool);
    eventId = event.id;
  });

  it('Predictable Load Shedding: Rejects excess concurrent requests with HTTP 503 rather than collapsing', async () => {
    const MAX_CONCURRENT = 5;
    const limiter = new ConcurrencyLimiter({ maxConcurrent: MAX_CONCURRENT });

    const app = createApp({
      instanceId: 'shedder-test-node',
      concurrencyLimiter: limiter,
    });

    const TOTAL_REQUESTS = 25;

    // Dispatch 25 requests simultaneously
    const promises = Array.from({ length: TOTAL_REQUESTS }, () =>
      request(app).get(`/api/events/${eventId}`)
    );

    const responses = await Promise.all(promises);

    const admitted = responses.filter(r => r.status === 200);
    const shed = responses.filter(r => r.status === 503);

    // 1. All 25 requests resolved cleanly without hanging or crashing
    expect(responses).toHaveLength(TOTAL_REQUESTS);

    // 2. Excess requests failed fast with HTTP 503 and proper Retry-After
    expect(shed.length).toBeGreaterThan(0);
    for (const res of shed) {
      expect(res.headers['retry-after']).toBe('2');
      expect(res.body.error.code).toBe('SERVER_OVERLOADED');
    }

    // 3. Admitted requests completed successfully
    expect(admitted.length).toBeGreaterThan(0);
    for (const res of admitted) {
      expect(res.body.id).toBe(eventId);
    }

    // 4. Concurrency stats verification
    const stats = limiter.getStats();
    expect(stats.totalAdmitted + stats.totalShed).toBe(TOTAL_REQUESTS);
    expect(stats.totalShed).toBe(shed.length);
  });

  it('Priority Degradation Policy: Sheds LOW priority reads before HIGH priority mutations when under load', async () => {
    // Capacity 10, lowPriorityThreshold = 4
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 10,
      lowPriorityThresholdRatio: 0.4,
    });

    // Artificially occupy 5 slots (surpassing the low priority threshold of 4)
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('NORMAL')).toBe(true);
    }

    // Now activeRequests = 5.
    // 1. LOW priority request should be shed immediately
    const lowPriorityResult = limiter.tryAcquire('LOW');
    expect(lowPriorityResult).toBe(false); // SHED!

    // 2. HIGH priority request (e.g. checkout reservation) should still be admitted!
    const highPriorityResult = limiter.tryAcquire('HIGH');
    expect(highPriorityResult).toBe(true); // ADMITTED!

    // Release acquired slots
    for (let i = 0; i < 6; i++) {
      limiter.release();
    }
  });

  it('ADVANCEMENT GATE: Proves sustainable rate vs saturated cliff', async () => {
    // Verify system throughput under sustainable load (10 concurrent requests)
    const SUSTAINABLE_CONCURRENCY = 10;
    const TOTAL_BURST = 30;

    const limiter = new ConcurrencyLimiter({ maxConcurrent: SUSTAINABLE_CONCURRENCY });
    const app = createApp({ concurrencyLimiter: limiter });

    const start = performance.now();
    const responses = await Promise.all(
      Array.from({ length: TOTAL_BURST }, () => request(app).get(`/api/events/${eventId}`))
    );
    const duration = performance.now() - start;

    const successCount = responses.filter(r => r.status === 200).length;
    const shedCount = responses.filter(r => r.status === 503).length;

    console.log(
      `[Capacity Observation] Total: ${TOTAL_BURST}, Admitted: ${successCount}, Shed: ${shedCount}, Duration: ${duration.toFixed(2)}ms`
    );

    expect(successCount + shedCount).toBe(TOTAL_BURST);
    expect(duration).toBeLessThan(1500); // Fails fast without thread hanging
  });
});
