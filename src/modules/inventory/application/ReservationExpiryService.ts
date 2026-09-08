import { PoolClient } from 'pg';
import { pool } from '../../../infrastructure/db/postgres.js';
import { Clock, SystemClock } from '../../../shared/domain/Clock.js';

export interface ExpiryResult {
  expiredCount: number;
  releasedCapacity: number;
  processedIds: string[];
}

export class ReservationExpiryService {
  constructor(private clock: Clock = new SystemClock()) {}

  /**
   * Idempotent & Concurrency-Safe Expiry Scanner
   * 
   * STEP 1: BEGIN transaction
   * STEP 2: Find expired PENDING reservations using FOR UPDATE SKIP LOCKED
   * STEP 3: Mark reservations EXPIRED returning only rows that transitioned
   * STEP 4: Return reserved capacity safely back to available_qty in inventory_pools
   * STEP 5: COMMIT transaction
   */
  public async expirePendingReservations(batchSize: number = 100, ticketTypeId?: string): Promise<ExpiryResult> {
    const client: PoolClient = await pool.connect();
    const now = this.clock.now();

    try {
      await client.query('BEGIN');

      // 1. Select eligible expired reservations with SKIP LOCKED (optionally scoped to ticketTypeId)
      const selectRes = await client.query(
        `SELECT id 
         FROM reservations 
         WHERE status = 'PENDING' 
           AND expires_at < $1 
           AND ($2::uuid IS NULL OR ticket_type_id = $2::uuid)
         ORDER BY expires_at ASC 
         LIMIT $3 
         FOR UPDATE SKIP LOCKED`,
        [now, ticketTypeId || null, batchSize]
      );

      if (selectRes.rows.length === 0) {
        await client.query('COMMIT');
        return { expiredCount: 0, releasedCapacity: 0, processedIds: [] };
      }

      const candidateIds = selectRes.rows.map(r => r.id);

      // 2. Transition reservations to EXPIRED and return affected rows
      const updateRes = await client.query(
        `UPDATE reservations 
         SET status = 'EXPIRED', updated_at = NOW() 
         WHERE id = ANY($1::uuid[]) AND status = 'PENDING'
         RETURNING id, ticket_type_id, quantity`,
        [candidateIds]
      );

      const actualProcessedIds: string[] = [];
      const capacityByTicketType = new Map<string, number>();
      let totalReleased = 0;

      for (const row of updateRes.rows) {
        actualProcessedIds.push(row.id);
        const qty = parseInt(row.quantity, 10);
        totalReleased += qty;
        const currentTotal = capacityByTicketType.get(row.ticket_type_id) || 0;
        capacityByTicketType.set(row.ticket_type_id, currentTotal + qty);
      }

      // 3. Reclaim reserved capacity safely back to available_qty
      for (const [tId, qtyToRelease] of capacityByTicketType.entries()) {
        await client.query(
          `UPDATE inventory_pools 
           SET available_qty = LEAST(total_capacity, available_qty + $1), 
               reserved_qty = GREATEST(0, reserved_qty - $1), 
               updated_at = NOW() 
           WHERE ticket_type_id = $2`,
          [qtyToRelease, tId]
        );
      }

      await client.query('COMMIT');
      return {
        expiredCount: actualProcessedIds.length,
        releasedCapacity: totalReleased,
        processedIds: actualProcessedIds,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
