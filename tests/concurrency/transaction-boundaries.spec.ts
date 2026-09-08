import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/PostgresInventoryRepository.js';

describe('LAB-203: Transaction Boundaries & Atomicity Fault Injection', () => {
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
      [eventId, 'org-boundary-test', `Boundary Drop Cap-${capacity}`]
    );

    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, $3, 7500, 'USD', $4)`,
      [ticketTypeId, eventId, 'Boundary Ticket', capacity]
    );

    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, $2, $3, 0, 0)`,
      [ticketTypeId, capacity, capacity]
    );

    return { eventId, ticketTypeId };
  }

  it('Fault Injection: Crash between INSERT and UPDATE triggers total rollback (No ghost reservation & No inventory leak)', async () => {
    const { ticketTypeId } = await seedTestPool(5);
    const faultUserId = 'user-fault-boundary';

    // 1. Verify initial DB state before fault injection
    const initialPoolRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(initialPoolRes.rows[0].available_qty).toBe(5);
    expect(initialPoolRes.rows[0].reserved_qty).toBe(0);

    // 2. Execute reservation with injected failure BETWEEN INSERT AND UPDATE
    await expect(
      repo.reserveWithFaultBetweenInsertAndUpdate(ticketTypeId, faultUserId)
    ).rejects.toThrow('CRASH_BETWEEN_INSERT_AND_UPDATE');

    // 3. VERIFY NO GHOST RESERVATION: The INSERT must be cleanly rolled back
    const resCountRes = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE user_id = $1`,
      [faultUserId]
    );
    expect(parseInt(resCountRes.rows[0].count, 10)).toBe(0);

    // 4. VERIFY NO LEAKED INVENTORY: Inventory pool must remain untouched
    const finalPoolRes = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    expect(finalPoolRes.rows[0].available_qty).toBe(5);
    expect(finalPoolRes.rows[0].reserved_qty).toBe(0);
  });

  it('Sprint Demo Live Race: 100 clients competing for 5 tickets (Sold count equals capacity exactly)', async () => {
    const CAPACITY = 5;
    const CONCURRENT_REQUESTS = 100;
    const { ticketTypeId } = await seedTestPool(CAPACITY);

    const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      repo.reserveAtomic(ticketTypeId, 1, `demo-user-${i}`)
    );

    const results = await Promise.all(promises);
    const successResults = results.filter(r => r.success);
    const soldOutResults = results.filter(r => !r.success && r.message === 'SOLD_OUT');

    // Verify DB state
    const poolRes = await pool.query(
      `SELECT total_capacity, available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const finalPool = poolRes.rows[0];

    const resRows = await pool.query(
      `SELECT COUNT(*) FROM reservations WHERE ticket_type_id = $1 AND status = 'ACTIVE'`,
      [ticketTypeId]
    );
    const activeReservationsCount = parseInt(resRows.rows[0].count, 10);

    console.log('\n=================== SPRINT 2 DEMO RACE RESULTS ===================');
    console.log(`Initial Capacity                     : ${CAPACITY}`);
    console.log(`Concurrent Contenders                : ${CONCURRENT_REQUESTS}`);
    console.log(`Successful Reservations Granted       : ${successResults.length}`);
    console.log(`Sold Out Rejections                   : ${soldOutResults.length}`);
    console.log(`Reservations Table Row Count         : ${activeReservationsCount}`);
    console.log(`Final DB Inventory Pool              : Available=${finalPool.available_qty}, Reserved=${finalPool.reserved_qty}`);
    console.log('==================================================================\n');

    expect(successResults.length).toBe(CAPACITY);
    expect(soldOutResults.length).toBe(CONCURRENT_REQUESTS - CAPACITY);
    expect(activeReservationsCount).toBe(CAPACITY);
    expect(finalPool.available_qty).toBe(0);
    expect(finalPool.reserved_qty).toBe(CAPACITY);
  });
});
