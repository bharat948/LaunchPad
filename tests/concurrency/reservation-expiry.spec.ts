import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { TestClock } from '../../src/shared/domain/Clock.js';
import { ReservationExpiryService } from '../../src/modules/inventory/application/ReservationExpiryService.js';

describe('LAB-302: Idempotent Reservation Expiry & Inventory Reclamation', () => {
  const baseTime = new Date('2026-10-01T12:00:00.000Z');
  const clock = new TestClock(baseTime);
  const expiryService = new ReservationExpiryService(clock);

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedTestPool(capacity: number): Promise<{ eventId: string; ticketTypeId: string }> {
    const eventId = randomUUID();
    const ticketTypeId = randomUUID();

    await pool.query(
      `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
       VALUES ($1, $2, $3, 'LIVE', NOW(), NOW() + INTERVAL '1 day')`,
      [eventId, 'org-expiry-test', `Expiry Drop Cap-${capacity}`]
    );

    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, $3, 4000, 'USD', $4)`,
      [ticketTypeId, eventId, 'Expiry Ticket', capacity]
    );

    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, $2, 0, $3, 0)`,
      [ticketTypeId, capacity, capacity]
    );

    return { eventId, ticketTypeId };
  }

  it('Batch Expiration: Scans expired PENDING reservations and restores available_qty', async () => {
    const BATCH_SIZE = 50;
    const { ticketTypeId } = await seedTestPool(BATCH_SIZE);

    // Create 50 expired reservations (expires_at in the past relative to clock)
    const pastTime = new Date(baseTime.getTime() - 5 * 60 * 1000);
    for (let i = 0; i < BATCH_SIZE; i++) {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'PENDING', $4)`,
        [randomUUID(), `batch-user-${i}`, ticketTypeId, pastTime]
      );
    }

    const result = await expiryService.expirePendingReservations(100, ticketTypeId);

    expect(result.expiredCount).toBe(BATCH_SIZE);
    expect(result.releasedCapacity).toBe(BATCH_SIZE);

    // Verify DB inventory pool state
    const poolRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(poolRes.rows[0].available_qty).toBe(BATCH_SIZE);
    expect(poolRes.rows[0].reserved_qty).toBe(0);
  });

  it('Advancement Gate: Idempotency & Re-run Safety (No double increment)', async () => {
    const CAPACITY = 20;
    const { ticketTypeId } = await seedTestPool(CAPACITY);

    const pastTime = new Date(baseTime.getTime() - 5 * 60 * 1000);
    for (let i = 0; i < CAPACITY; i++) {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'PENDING', $4)`,
        [randomUUID(), `idempotent-user-${i}`, ticketTypeId, pastTime]
      );
    }

    // FIRST RUN: Expires all 20 reservations
    const firstRun = await expiryService.expirePendingReservations(100, ticketTypeId);
    expect(firstRun.expiredCount).toBe(CAPACITY);
    expect(firstRun.releasedCapacity).toBe(CAPACITY);

    const dbResAfterFirstRun = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(dbResAfterFirstRun.rows[0].available_qty).toBe(CAPACITY);
    expect(dbResAfterFirstRun.rows[0].reserved_qty).toBe(0);

    // SECOND RUN (IMMEDIATE RE-RUN / CRASH RETRY):
    const secondRun = await expiryService.expirePendingReservations(100, ticketTypeId);
    expect(secondRun.expiredCount).toBe(0);
    expect(secondRun.releasedCapacity).toBe(0);

    // THIRD RUN:
    const thirdRun = await expiryService.expirePendingReservations(100, ticketTypeId);
    expect(thirdRun.expiredCount).toBe(0);
    expect(thirdRun.releasedCapacity).toBe(0);

    // Verify inventory state did NOT double-increment!
    const dbResAfterSubsequentRuns = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(dbResAfterSubsequentRuns.rows[0].available_qty).toBe(CAPACITY);
    expect(dbResAfterSubsequentRuns.rows[0].reserved_qty).toBe(0);
  });

  it('Multi-Instance Scheduler Coordination: FOR UPDATE SKIP LOCKED processes disjoint sets', async () => {
    const TOTAL_EXPIRED = 40;
    const { ticketTypeId } = await seedTestPool(TOTAL_EXPIRED);

    const pastTime = new Date(baseTime.getTime() - 10 * 60 * 1000);
    for (let i = 0; i < TOTAL_EXPIRED; i++) {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'PENDING', $4)`,
        [randomUUID(), `multi-worker-${i}`, ticketTypeId, pastTime]
      );
    }

    // Run 2 concurrent worker instances with batchSize = 20 scoped to this pool
    const [worker1, worker2] = await Promise.all([
      expiryService.expirePendingReservations(20, ticketTypeId),
      expiryService.expirePendingReservations(20, ticketTypeId),
    ]);

    console.log(`\n[Multi-Instance Scheduler] Worker 1 processed: ${worker1.expiredCount}, Worker 2 processed: ${worker2.expiredCount}`);

    const totalProcessed = worker1.expiredCount + worker2.expiredCount;
    expect(totalProcessed).toBe(40);

    // Verify mutual exclusivity: Worker 1 and Worker 2 must have zero overlapping IDs
    const worker1Set = new Set(worker1.processedIds);
    for (const id of worker2.processedIds) {
      expect(worker1Set.has(id)).toBe(false);
    }
  });

  it('Active Hold Protection: Unexpired reservations are untouched by expiry scanner', async () => {
    const { ticketTypeId } = await seedTestPool(10);

    // 5 expired reservations
    const pastTime = new Date(baseTime.getTime() - 2 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'PENDING', $4)`,
        [randomUUID(), `past-user-${i}`, ticketTypeId, pastTime]
      );
    }

    // 5 active, unexpired reservations (expires in future)
    const futureTime = new Date(baseTime.getTime() + 8 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'PENDING', $4)`,
        [randomUUID(), `active-user-${i}`, ticketTypeId, futureTime]
      );
    }

    const result = await expiryService.expirePendingReservations(100, ticketTypeId);

    // Only the 5 expired reservations should be processed
    expect(result.expiredCount).toBe(5);
    expect(result.releasedCapacity).toBe(5);

    // The remaining 5 reservations must still be PENDING
    const pendingRes = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE ticket_type_id = $1 AND status = 'PENDING'`,
      [ticketTypeId]
    );
    expect(parseInt(pendingRes.rows[0].count, 10)).toBe(5);
  });
});
