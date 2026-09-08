import { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { pool } from '../../../infrastructure/db/postgres.js';

export interface AtomicReservationResult {
  success: boolean;
  message: 'RESERVED' | 'SOLD_OUT' | 'ERROR';
  reservationId?: string;
}

export class PostgresInventoryRepository {
  /**
   * Atomic Reservation Flow utilizing Pessimistic Row Locking & Conditional Update
   * 
   * STEP 1: BEGIN PostgreSQL Transaction
   * STEP 2: SELECT FOR UPDATE on inventory_pools (Acquires exclusive row lock)
   * STEP 3: Verify available_qty >= requestedQty
   * STEP 4: INSERT INTO reservations table
   * STEP 5: UPDATE inventory_pools SET available_qty = available_qty - X, reserved_qty = reserved_qty + X
   * STEP 6: COMMIT Transaction (Releases lock)
   */
  public async reserveAtomic(
    ticketTypeId: string,
    quantity: number = 1,
    userId: string = 'user-anonymous'
  ): Promise<AtomicReservationResult> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Acquire pessimistic row lock on the inventory pool
      const lockRes = await client.query(
        `SELECT available_qty, reserved_qty 
         FROM inventory_pools 
         WHERE ticket_type_id = $1 
         FOR UPDATE`,
        [ticketTypeId]
      );

      if (lockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: 'SOLD_OUT' };
      }

      const availableQty = lockRes.rows[0].available_qty;
      if (availableQty < quantity) {
        await client.query('ROLLBACK');
        return { success: false, message: 'SOLD_OUT' };
      }

      // 2. Insert Reservation entitlement record
      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes TTL

      await client.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
        [reservationId, userId, ticketTypeId, quantity, expiresAt]
      );

      // 3. Perform atomic update with conditional safety check
      const updateRes = await client.query(
        `UPDATE inventory_pools 
         SET available_qty = available_qty - $1, 
             reserved_qty = reserved_qty + $1, 
             updated_at = CURRENT_TIMESTAMP 
         WHERE ticket_type_id = $2 AND available_qty >= $1`,
        [quantity, ticketTypeId]
      );

      if (updateRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: 'SOLD_OUT' };
      }

      await client.query('COMMIT');
      return { success: true, message: 'RESERVED', reservationId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Helper method for Rollback Testing: Injects an explicit exception mid-transaction after modifying state
   */
  public async reserveWithInjectedError(ticketTypeId: string, userId: string = 'user-error'): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `SELECT available_qty FROM inventory_pools WHERE ticket_type_id = $1 FOR UPDATE`,
        [ticketTypeId]
      );

      // Deduct inventory inside transaction
      await client.query(
        `UPDATE inventory_pools SET available_qty = available_qty - 1, reserved_qty = reserved_qty + 1 WHERE ticket_type_id = $1`,
        [ticketTypeId]
      );

      // INJECTED SIMULATED EXCEPTION
      throw new Error('SIMULATED_NETWORK_FAULT_MID_TRANSACTION');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * LAB-203 Specific Fault Injection: Injects failure BETWEEN INSERT reservation and UPDATE inventory_pools
   */
  public async reserveWithFaultBetweenInsertAndUpdate(
    ticketTypeId: string,
    userId: string = 'user-fault-boundary'
  ): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `SELECT available_qty FROM inventory_pools WHERE ticket_type_id = $1 FOR UPDATE`,
        [ticketTypeId]
      );

      // 1. INSERT reservation row inside transaction
      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await client.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, 1, 'ACTIVE', $4)`,
        [reservationId, userId, ticketTypeId, expiresAt]
      );

      // 2. INJECTED FAULT BETWEEN INSERT AND UPDATE
      throw new Error('CRASH_BETWEEN_INSERT_AND_UPDATE');

      // 3. Unreachable update step due to injected crash
      // await client.query(`UPDATE inventory_pools ...`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
