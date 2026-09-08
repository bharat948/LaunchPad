import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Reservation } from '../../src/modules/inventory/domain/Reservation.js';
import { ReservationStatus } from '../../src/modules/inventory/domain/ReservationStatus.js';
import { Clock, SystemClock } from '../../src/shared/domain/Clock.js';

export class ReservationFixtureBuilder {
  private id: string = randomUUID();
  private userId: string = 'user-fixture-default';
  private ticketTypeId: string = randomUUID();
  private quantity: number = 1;
  private status: ReservationStatus = ReservationStatus.PENDING;
  private ttlMinutes: number = 10;
  private clock: Clock = new SystemClock();

  public static aReservation(): ReservationFixtureBuilder {
    return new ReservationFixtureBuilder();
  }

  public withId(id: string): this {
    this.id = id;
    return this;
  }

  public withUserId(userId: string): this {
    this.userId = userId;
    return this;
  }

  public withTicketTypeId(ticketTypeId: string): this {
    this.ticketTypeId = ticketTypeId;
    return this;
  }

  public withQuantity(quantity: number): this {
    this.quantity = quantity;
    return this;
  }

  public withClock(clock: Clock): this {
    this.clock = clock;
    return this;
  }

  public withTTLMinutes(minutes: number): this {
    this.ttlMinutes = minutes;
    return this;
  }

  public inStatus(status: ReservationStatus): this {
    this.status = status;
    return this;
  }

  public build(): Reservation {
    const res = Reservation.create(this.id, this.userId, this.ticketTypeId, this.quantity, this.clock, this.ttlMinutes);
    if (this.status === ReservationStatus.CONFIRMED) {
      res.confirm(this.clock);
    } else if (this.status === ReservationStatus.CANCELLED) {
      res.cancel();
    }
    return res;
  }

  public async persist(pool: Pool): Promise<Reservation> {
    const res = this.build();
    await pool.query('BEGIN');
    try {
      await pool.query(
        `INSERT INTO reservations (id, user_id, ticket_type_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [res.id, res.userId, res.ticketTypeId, res.quantity, res.status, res.expiresAt]
      );

      if (res.status === ReservationStatus.PENDING) {
        await pool.query(
          `UPDATE inventory_pools 
           SET available_qty = GREATEST(0, available_qty - $1), 
               reserved_qty = reserved_qty + $1 
           WHERE ticket_type_id = $2`,
          [res.quantity, res.ticketTypeId]
        );
      }

      await pool.query('COMMIT');
      return res;
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
}
