import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/PostgresInventoryRepository.js';
import { AsyncBarrier } from './AsyncBarrier.js';

describe('LAB-403: Repeatable Concurrency Races with AsyncBarrier', () => {
  const repo = new PostgresInventoryRepository();

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedPool(capacity: number): Promise<string> {
    const eventId = randomUUID();
    const ticketTypeId = randomUUID();

    await pool.query(
      `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
       VALUES ($1, $2, $3, 'LIVE', NOW(), NOW() + INTERVAL '1 day')`,
      [eventId, 'org-repeatable', `Repeatable Drop Cap-${capacity}`]
    );

    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, $3, 3000, 'USD', $4)`,
      [ticketTypeId, eventId, 'Repeatable Tier', capacity]
    );

    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, $2, $3, 0, 0)`,
      [ticketTypeId, capacity, capacity]
    );

    return ticketTypeId;
  }

  it('10x Repeatability Experiment: 10 consecutive runs with 30 contenders competing for 2 tickets', async () => {
    const ITERATIONS = 10;
    const CAPACITY = 2;
    const CONTENDERS = 30;

    console.log(`\n=================== 10x REPEATABILITY EXPERIMENT ===================`);
    console.log(`Running ${ITERATIONS} consecutive synchronized race iterations...`);

    for (let run = 1; run <= ITERATIONS; run++) {
      const ticketTypeId = await seedPool(CAPACITY);
      const barrier = new AsyncBarrier(CONTENDERS);

      // Launch 30 workers that sync at the barrier before querying PostgreSQL
      const workers = Array.from({ length: CONTENDERS }, async (_, i) => {
        // Wait at the starting gun
        await barrier.wait();
        // Fire atomic reservation at the exact same microsecond
        return repo.reserveAtomic(ticketTypeId, 1, `user-rep-${run}-${i}`);
      });

      const results = await Promise.all(workers);
      const successCount = results.filter(r => r.success).length;
      const soldOutCount = results.filter(r => !r.success && r.message === 'SOLD_OUT').length;

      const poolRes = await pool.query(
        `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
        [ticketTypeId]
      );
      const state = poolRes.rows[0];

      // Invariant assertion on every single iteration
      expect(successCount).toBe(CAPACITY);
      expect(soldOutCount).toBe(CONTENDERS - CAPACITY);
      expect(state.available_qty).toBe(0);
      expect(state.reserved_qty).toBe(CAPACITY);

      console.log(`  [Iteration ${run.toString().padStart(2, ' ')}/${ITERATIONS}] -> Success: ${successCount}, Sold Out: ${soldOutCount}, Available: ${state.available_qty}, Reserved: ${state.reserved_qty} (PASS)`);
    }

    console.log(`====================================================================\n`);
  });
});
