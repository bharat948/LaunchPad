import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server.js';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';

describe('LAB-501: Establish Read Baseline (Pre-Cache Measurements)', () => {
  let eventId: string;

  beforeAll(async () => {
    await runMigrations();

    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Pre-Cache Baseline Conference')
      .withTicketType('General Admission', 4900, 500)
      .withTicketType('VIP Keynote', 19900, 50)
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    eventId = event.id;
  });

  it(
    'Measures GET /api/events/:id latency distribution (P50, P95, P99) under 500 requests',
    async () => {
    const TOTAL_REQUESTS = 500;
    const latencies: number[] = [];

    // Warm up connection pool with 10 initial requests
    for (let i = 0; i < 10; i++) {
      await request(app).get(`/api/events/${eventId}`);
    }

    // Benchmark loop
    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      const start = performance.now();
      const res = await request(app).get(`/api/events/${eventId}`);
      const duration = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(eventId);
      expect(res.body.ticketTypes.length).toBe(2);
      latencies.push(duration);
    }

    latencies.sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const mean = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    console.log('\n=================== READ BASELINE METRICS (PURE POSTGRES) ===================');
    console.log(`Total HTTP Requests           : ${TOTAL_REQUESTS}`);
    console.log(`Database Queries Per Request  : 2 (SELECT events + SELECT ticket_types)`);
    console.log(`Min Latency                   : ${min.toFixed(2)} ms`);
    console.log(`Mean Latency                  : ${mean.toFixed(2)} ms`);
    console.log(`P50 (Median) Latency          : ${p50.toFixed(2)} ms`);
    console.log(`P95 Latency                   : ${p95.toFixed(2)} ms`);
    console.log(`P99 Latency                   : ${p99.toFixed(2)} ms`);
    console.log(`Max Latency                   : ${max.toFixed(2)} ms`);
    console.log('=============================================================================\n');

    expect(p50).toBeGreaterThan(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
  }, 30000);
});
