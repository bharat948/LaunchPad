import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/PostgresInventoryRepository.js';

describe('LAB-202: Atomic Reservation & Concurrency Verification', () => {
  const repo = new PostgresInventoryRepository();

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
      [eventId, 'org-atomic-test', `Atomic Drop Cap-${capacity}`]
    );

    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, $3, 5000, 'USD', $4)`,
      [ticketTypeId, eventId, 'Atomic Ticket', capacity]
    );

    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, $2, $3, 0, 0)`,
      [ticketTypeId, capacity, capacity]
    );

    return { eventId, ticketTypeId };
  }

  it('Experiment 1: 10 concurrent requests competing for 1 ticket (Zero Oversell)', async () => {
    const { ticketTypeId } = await seedTestPool(1);
    const CONCURRENT_REQUESTS = 10;

    const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      repo.reserveAtomic(ticketTypeId, 1, `user-10-${i}`)
    );

    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.success).length;
    const soldOutCount = results.filter(r => !r.success && r.message === 'SOLD_OUT').length;

    const dbRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const state = dbRes.rows[0];

    console.log(`\n[Experiment 1 - 10 Contenders] Success: ${successCount}, Sold Out: ${soldOutCount}, DB State: Avail=${state.available_qty}, Res=${state.reserved_qty}`);

    expect(successCount).toBe(1);
    expect(soldOutCount).toBe(9);
    expect(state.available_qty).toBe(0);
    expect(state.reserved_qty).toBe(1);
  });

  it('Experiment 2: 100 concurrent requests competing for 1 ticket (Zero Oversell)', async () => {
    const { ticketTypeId } = await seedTestPool(1);
    const CONCURRENT_REQUESTS = 100;

    const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      repo.reserveAtomic(ticketTypeId, 1, `user-100-${i}`)
    );

    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.success).length;
    const soldOutCount = results.filter(r => !r.success && r.message === 'SOLD_OUT').length;

    const dbRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const state = dbRes.rows[0];

    console.log(`[Experiment 2 - 100 Contenders] Success: ${successCount}, Sold Out: ${soldOutCount}, DB State: Avail=${state.available_qty}, Res=${state.reserved_qty}`);

    expect(successCount).toBe(1);
    expect(soldOutCount).toBe(99);
    expect(state.available_qty).toBe(0);
    expect(state.reserved_qty).toBe(1);
  });

  it('Experiment 3: 1,000 concurrent requests competing for 50 tickets (Zero Oversell)', async () => {
    const CAPACITY = 50;
    const { ticketTypeId } = await seedTestPool(CAPACITY);
    const CONCURRENT_REQUESTS = 1000;

    const startTime = Date.now();
    const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      repo.reserveAtomic(ticketTypeId, 1, `user-1000-${i}`)
    );

    const results = await Promise.all(promises);
    const durationMs = Date.now() - startTime;

    const successCount = results.filter(r => r.success).length;
    const soldOutCount = results.filter(r => !r.success && r.message === 'SOLD_OUT').length;

    const dbRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const state = dbRes.rows[0];

    console.log(`[Experiment 3 - 1000 Contenders / 50 Capacity] Duration: ${durationMs}ms`);
    console.log(`   -> Success: ${successCount}, Sold Out: ${soldOutCount}`);
    console.log(`   -> DB State: Avail=${state.available_qty}, Res=${state.reserved_qty}`);

    expect(successCount).toBe(CAPACITY);
    expect(soldOutCount).toBe(CONCURRENT_REQUESTS - CAPACITY);
    expect(state.available_qty).toBe(0);
    expect(state.reserved_qty).toBe(CAPACITY);
  });

  it('Rollback Behavior: Injected exception mid-transaction leaves state untouched', async () => {
    const { ticketTypeId } = await seedTestPool(10);

    const initialRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const initialAvail = initialRes.rows[0].available_qty;

    // Execute reservation with mid-transaction injected exception
    await expect(repo.reserveWithInjectedError(ticketTypeId, 'fault-user')).rejects.toThrow('SIMULATED_NETWORK_FAULT_MID_TRANSACTION');

    // Verify PostgreSQL automatically rolled back changes
    const finalRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(finalRes.rows[0].available_qty).toBe(initialAvail);
    expect(finalRes.rows[0].reserved_qty).toBe(0);
  });
});
