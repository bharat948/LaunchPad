import { PoolClient } from 'pg';
import { pool } from '../../../infrastructure/db/postgres.js';
import { Event } from '../domain/Event.js';
import { EventStatus } from '../domain/EventStatus.js';
import { TimeWindow } from '../domain/TimeWindow.js';
import { TicketType } from '../domain/TicketType.js';
import { Money } from '../domain/Money.js';
import { InventoryPool } from '../../inventory/domain/InventoryPool.js';

export interface IEventRepository {
  save(event: Event, inventoryPools?: InventoryPool[]): Promise<void>;
  findById(id: string): Promise<Event | null>;
  updateStatus(event: Event): Promise<void>;
}

export class PostgresEventRepository implements IEventRepository {
  public async save(event: Event, inventoryPools: InventoryPool[] = []): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert Event
      await client.query(
        `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           status = EXCLUDED.status,
           sale_start_at = EXCLUDED.sale_start_at,
           sale_end_at = EXCLUDED.sale_end_at,
           updated_at = CURRENT_TIMESTAMP`,
        [event.id, event.organizerId, event.title, event.status, event.saleWindow.startAt, event.saleWindow.endAt]
      );

      // Insert TicketTypes
      for (const tt of event.ticketTypes) {
        await client.query(
          `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [tt.id, tt.eventId, tt.name, tt.price.amountCents, tt.price.currency, tt.capacity]
        );
      }

      // Insert InventoryPools
      for (const poolItem of inventoryPools) {
        await client.query(
          `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (ticket_type_id) DO NOTHING`,
          [poolItem.ticketTypeId, poolItem.totalCapacity, poolItem.availableQuantity, poolItem.reservedQuantity, poolItem.soldQuantity]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async findById(id: string): Promise<Event | null> {
    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (eventRes.rows.length === 0) return null;

    const row = eventRes.rows[0];
    const saleWindow = new TimeWindow(new Date(row.sale_start_at), new Date(row.sale_end_at));
    
    // Reconstruct Event aggregate (using factory create or private instantiation)
    const event = Event.create(row.id, row.organizer_id, row.title, saleWindow);

    // Fetch associated TicketTypes
    const ttRes = await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [id]);
    for (const ttRow of ttRes.rows) {
      const price = new Money(ttRow.price_cents, ttRow.currency);
      event.addTicketType(ttRow.id, ttRow.name, price, ttRow.capacity);
    }

    // Apply status
    if (row.status === EventStatus.SCHEDULED) event.schedule();
    else if (row.status === EventStatus.LIVE) {
      if (event.status === EventStatus.DRAFT) event.schedule();
      event.publish();
    } else if (row.status === EventStatus.CANCELLED) {
      event.cancel();
    }

    return event;
  }

  public async updateStatus(event: Event): Promise<void> {
    await pool.query(
      `UPDATE events SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [event.status, event.id]
    );
  }
}
