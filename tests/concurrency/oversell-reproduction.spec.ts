import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { NaiveInventoryRepository } from '../../src/modules/inventory/infrastructure/NaiveInventoryRepository.js';

describe('LAB-201: Reproduce Overselling (Race Condition Experiment)', () => {
  const naiveRepo = new NaiveInventoryRepository();
  let ticketTypeId: string;
  let eventId: string;

  beforeAll(async () => {
    await runMigrations();

    eventId = randomUUID();
    ticketTypeId = randomUUID();

    // 1. Seed PostgreSQL database with 1 Event and 1 TicketType with Total Capacity = 1
    await pool.query(
      `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 day')`,
      [eventId, 'org-race-test', 'Flash Drop Concert', 'LIVE']
    );

    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ticketTypeId, eventId, 'VIP Single Ticket', 10000, 'USD', 1]
    );

    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticketTypeId, 1, 1, 0, 0]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should demonstrate overselling when 100 concurrent requests compete for 1 ticket', async () => {
    const CONCURRENT_REQUESTS = 100;
    const promises = [];

    // Fire 100 concurrent reservation attempts at the exact same millisecond
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      promises.push(naiveRepo.reserveNaive(ticketTypeId, 1));
    }

    const results = await Promise.all(promises);

    const successfulReservations = results.filter(r => r.success);
    const failedReservations = results.filter(r => !r.success);

    // Fetch authoritative database state after the race completes
    const dbRes = await pool.query(
      `SELECT total_capacity, available_qty, reserved_qty, sold_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );
    const finalState = dbRes.rows[0];

    console.log('\n=================== RACE CONDITION EXPERIMENT RESULTS ===================');
    console.log(`Total Inventory Available Initially : 1`);
    console.log(`Concurrent Reservation Attempts      : ${CONCURRENT_REQUESTS}`);
    console.log(`Successful Claims Reported to Users : ${successfulReservations.length}`);
    console.log(`Rejected Claims Reported to Users   : ${failedReservations.length}`);
    console.log(`Final Database State in PostgreSQL  : Available=${finalState.available_qty}, Reserved=${finalState.reserved_qty}`);
    console.log('=========================================================================\n');

    // VERIFICATION OF RACE CONDITION:
    // In a correct system, exactly 1 request should succeed.
    // In naive code, multiple requests read available_qty = 1 concurrently and return success!
    expect(successfulReservations.length).toBeGreaterThan(1);
    
    // The oversell count is how many extra users were granted a ticket beyond actual capacity (1)
    const oversellCount = successfulReservations.length - 1;
    console.log(`🔥 OVERSELL DETECTED! ${oversellCount} extra users received fake confirmation!`);
  });
});
