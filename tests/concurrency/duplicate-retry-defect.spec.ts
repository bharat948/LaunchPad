import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server.js';
import { pool } from '../../src/infrastructure/db/postgres.js';

describe('LAB-701: Retry Ambiguity & Duplicate Order Creation Defect', () => {
  beforeEach(async () => {
    // Clean up test events
    await pool.query("DELETE FROM events WHERE title LIKE 'Retry Defect Concert%'");
  });

  it('ADVANCEMENT GATE: Proves duplicate side effect when client retries after network drop', async () => {
    const payload = {
      organizerId: 'org-coldplay-live',
      title: 'Retry Defect Concert 2026',
      saleStartAt: new Date(Date.now() + 1000 * 60).toISOString(),
      saleEndAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      ticketTypes: [
        { name: 'Standard Seat', priceCents: 4500, capacity: 500 },
      ],
    };

    // 1. First Request: Server processes and commits to PostgreSQL
    const res1 = await request(app)
      .post('/api/events')
      .send(payload);

    expect(res1.status).toBe(201);
    const firstEventId = res1.body.id;

    // 2. SIMULATE NETWORK DROP / CLIENT TIMEOUT:
    // Client sent request 1, server committed, but network dropped the response packet.
    // Client catches timeout exception and blindly retries the exact same intent!
    const res2 = await request(app)
      .post('/api/events')
      .send(payload);

    expect(res2.status).toBe(201);
    const secondEventId = res2.body.id;

    // 🔥 DUPLICATE SIDE-EFFECT DETECTED!
    // Without an Idempotency-Key, the server generated two distinct resource IDs!
    expect(secondEventId).not.toBe(firstEventId);

    // Verify both duplicate events now exist in PostgreSQL database
    const dbCheck = await pool.query(
      "SELECT id, title FROM events WHERE title = 'Retry Defect Concert 2026'"
    );

    expect(dbCheck.rows).toHaveLength(2); // Two duplicate events for one user action!
    console.log(`[Duplicate Defect Demonstrated] DB Row Count: ${dbCheck.rows.length}, Event 1: ${firstEventId}, Event 2: ${secondEventId}`);
  });
});
