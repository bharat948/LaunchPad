import { pool } from '../../../infrastructure/db/postgres.js';

export interface NaiveReservationResult {
  success: boolean;
  message: string;
  readAvailableQty?: number;
}

export class NaiveInventoryRepository {
  /**
   * Intentionally Naive (Un-locked, Non-Atomic) Reservation Flow
   * 
   * STEP 1: READ available quantity from PostgreSQL (without lock)
   * STEP 2: IN-MEMORY CHECK if available_qty >= requested
   * STEP 3: ARTIFICIAL DELAY (simulates real-world network / I/O latency)
   * STEP 4: UN-CONDITIONAL WRITE back to PostgreSQL
   */
  public async reserveNaive(ticketTypeId: string, requestedQty: number = 1): Promise<NaiveReservationResult> {
    // 1. Read current state without any row locking or transaction isolation
    const readResult = await pool.query(
      `SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1`,
      [ticketTypeId]
    );

    if (readResult.rows.length === 0) {
      return { success: false, message: 'TicketType not found' };
    }

    const availableQty = readResult.rows[0].available_qty;
    const reservedQty = readResult.rows[0].reserved_qty;

    // 2. In-memory application check
    if (availableQty < requestedQty) {
      return { success: false, message: 'Insufficient inventory', readAvailableQty: availableQty };
    }

    // 3. Simulate realistic network / db I/O interleaving delay (10ms)
    await new Promise(resolve => setTimeout(resolve, 10));

    // 4. Naive write-back (blind update based on stale in-memory read)
    const newAvailable = availableQty - requestedQty;
    const newReserved = reservedQty + requestedQty;

    await pool.query(
      `UPDATE inventory_pools 
       SET available_qty = $1, reserved_qty = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE ticket_type_id = $3`,
      [newAvailable, newReserved, ticketTypeId]
    );

    return { success: true, message: 'Reserved successfully', readAvailableQty: availableQty };
  }
}
