import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Event } from '../../src/modules/catalog/domain/Event.js';
import { TimeWindow } from '../../src/modules/catalog/domain/TimeWindow.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';

export interface TicketTypeFixtureSpec {
  id?: string;
  name: string;
  priceCents: number;
  currency?: string;
  capacity: number;
}

export class EventFixtureBuilder {
  private id: string = randomUUID();
  private organizerId: string = 'org-fixture-default';
  private title: string = 'Default Fixture Concert';
  private saleStartAt: Date = new Date(Date.now() + 1000 * 60); // 1 minute in future
  private saleEndAt: Date = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours in future
  private status: EventStatus = EventStatus.DRAFT;
  private ticketTypes: TicketTypeFixtureSpec[] = [];

  public static anEvent(): EventFixtureBuilder {
    return new EventFixtureBuilder();
  }

  public withId(id: string): this {
    this.id = id;
    return this;
  }

  public withOrganizerId(organizerId: string): this {
    this.organizerId = organizerId;
    return this;
  }

  public withTitle(title: string): this {
    this.title = title;
    return this;
  }

  public withSaleWindow(startAt: Date, endAt: Date): this {
    this.saleStartAt = startAt;
    this.saleEndAt = endAt;
    return this;
  }

  public inStatus(status: EventStatus): this {
    this.status = status;
    return this;
  }

  public withTicketType(name: string, priceCents: number, capacity: number, id?: string): this {
    this.ticketTypes.push({
      id: id || randomUUID(),
      name,
      priceCents,
      currency: 'USD',
      capacity,
    });
    return this;
  }

  /**
   * Builds an in-memory Domain Event Aggregate
   */
  public build(): Event {
    const saleWindow = new TimeWindow(this.saleStartAt, this.saleEndAt);
    const event = Event.create(this.id, this.organizerId, this.title, saleWindow);

    for (const tt of this.ticketTypes) {
      const price = new Money(tt.priceCents, tt.currency || 'USD');
      event.addTicketType(tt.id!, tt.name, price, tt.capacity);
    }

    if (this.status === EventStatus.SCHEDULED) {
      event.schedule();
    } else if (this.status === EventStatus.LIVE) {
      if (this.ticketTypes.length === 0) {
        // Add a default ticket type so publish succeeds
        event.addTicketType(randomUUID(), 'Default Tier', new Money(1000, 'USD'), 100);
      }
      event.schedule();
      event.publish();
    } else if (this.status === EventStatus.CANCELLED) {
      event.cancel();
    }

    return event;
  }

  /**
   * Persists Event, TicketTypes, and InventoryPools directly to PostgreSQL
   */
  public async persist(pool: Pool): Promise<{ event: Event; ticketTypeIds: string[] }> {
    const event = this.build();
    const ticketTypeIds: string[] = [];

    await pool.query('BEGIN');
    try {
      await pool.query(
        `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [event.id, event.organizerId, event.title, event.status, event.saleWindow.startAt, event.saleWindow.endAt]
      );

      for (const tt of event.ticketTypes) {
        ticketTypeIds.push(tt.id);
        await pool.query(
          `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [tt.id, tt.eventId, tt.name, tt.price.amountCents, tt.price.currency, tt.capacity]
        );

        await pool.query(
          `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
           VALUES ($1, $2, $3, 0, 0)
           ON CONFLICT (ticket_type_id) DO NOTHING`,
          [tt.id, tt.capacity, tt.capacity]
        );
      }

      await pool.query('COMMIT');
      return { event, ticketTypeIds };
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
}
