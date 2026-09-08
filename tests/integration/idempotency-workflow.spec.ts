import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server.js';
import { pool } from '../../src/infrastructure/db/postgres.js';

describe('LAB-702: Idempotency Key Workflow & Deduplication', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM idempotency_keys WHERE key LIKE 'test-key-%'");
    await pool.query("DELETE FROM events WHERE title LIKE 'Idempotent Event%'");
  });

  it('Safe Replay: Retrying same key + payload returns original response with Idempotent-Replay header', async () => {
    const IDEMPOTENCY_KEY = 'test-key-replay-1';
    const payload = {
      organizerId: 'org-idempotent',
      title: 'Idempotent Event Replay Tour',
      saleStartAt: new Date(Date.now() + 1000 * 60).toISOString(),
      saleEndAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      ticketTypes: [{ name: 'VIP', priceCents: 15000, capacity: 100 }],
    };

    // First request: Execution
    const res1 = await request(app)
      .post('/api/events')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.headers['idempotent-replay']).toBeUndefined();
    const createdEventId = res1.body.id;

    // Second request: Safe Replay
    const res2 = await request(app)
      .post('/api/events')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.headers['idempotent-replay']).toBe('true');
    expect(res2.body.id).toBe(createdEventId);
    expect(res2.body.title).toBe('Idempotent Event Replay Tour');

    // Verify DB definitely has ONLY 1 record
    const dbCheck = await pool.query(
      "SELECT id FROM events WHERE title = 'Idempotent Event Replay Tour'"
    );
    expect(dbCheck.rows).toHaveLength(1);
  });

  it('Payload Mismatch: Reusing same key with altered payload returns 422 Unprocessable Entity', async () => {
    const IDEMPOTENCY_KEY = 'test-key-mismatch-1';
    const originalPayload = {
      organizerId: 'org-idempotent',
      title: 'Idempotent Event Original Title',
      saleStartAt: new Date(Date.now() + 1000 * 60).toISOString(),
      saleEndAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      ticketTypes: [],
    };

    // 1. Initial request commits with original payload
    const res1 = await request(app)
      .post('/api/events')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(originalPayload);
    expect(res1.status).toBe(201);

    // 2. Re-use key with different title!
    const alteredPayload = {
      ...originalPayload,
      title: 'Idempotent Event TAMPERED Title',
    };

    const res2 = await request(app)
      .post('/api/events')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(alteredPayload);

    expect(res2.status).toBe(422);
    expect(res2.body).toEqual({
      error: {
        code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        message: 'Idempotency-Key was previously used with a different request payload.',
      },
    });
  });

  it('ADVANCEMENT GATE: Concurrent retry storm cannot create duplicate orders for one idempotency key', async () => {
    const IDEMPOTENCY_KEY = 'test-key-storm-1';
    const payload = {
      organizerId: 'org-storm',
      title: 'Idempotent Event Storm Show',
      saleStartAt: new Date(Date.now() + 1000 * 60).toISOString(),
      saleEndAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      ticketTypes: [{ name: 'Standard', priceCents: 5000, capacity: 50 }],
    };

    const CONCURRENT_RETRIES = 10;

    // Fire 10 identical requests with the same Idempotency-Key simultaneously
    const promises = Array.from({ length: CONCURRENT_RETRIES }, () =>
      request(app)
        .post('/api/events')
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send(payload)
    );

    const responses = await Promise.all(promises);

    // All responses should either be 201 (Created / Replayed) or 409 (In Progress conflict)
    for (const res of responses) {
      expect([201, 409]).toContain(res.status);
    }

    // At least one request succeeded
    const createdResponses = responses.filter(r => r.status === 201);
    expect(createdResponses.length).toBeGreaterThanOrEqual(1);

    // If multiple returned 201, all must have returned the EXACT same event ID!
    const eventIds = new Set(createdResponses.map(r => r.body.id));
    expect(eventIds.size).toBe(1);

    // Verify PostgreSQL state: EXACTLY 1 event exists in database!
    const dbCheck = await pool.query(
      "SELECT id FROM events WHERE title = 'Idempotent Event Storm Show'"
    );
    expect(dbCheck.rows).toHaveLength(1);
    console.log(`[Concurrent Storm Verified] Created: ${createdResponses.length}, 409 Conflicts: ${responses.length - createdResponses.length}, Unique DB Rows: ${dbCheck.rows.length}`);
  });
});
