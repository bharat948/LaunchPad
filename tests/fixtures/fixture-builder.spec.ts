import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { EventFixtureBuilder } from './EventFixtureBuilder.js';
import { ReservationFixtureBuilder } from './ReservationFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { ReservationStatus } from '../../src/modules/inventory/domain/ReservationStatus.js';

describe('LAB-401: Fixture Builder Verification', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('EventFixtureBuilder should build domain event and persist to PostgreSQL', async () => {
    const { event, ticketTypeIds } = await EventFixtureBuilder.anEvent()
      .withTitle('Symphony Orchestra 2026')
      .withTicketType('Balcony', 4500, 200)
      .withTicketType('Orchestra Pit', 12000, 50)
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    expect(event.title).toBe('Symphony Orchestra 2026');
    expect(event.status).toBe(EventStatus.LIVE);
    expect(ticketTypeIds.length).toBe(2);

    // Verify row persisted in DB
    const res = await pool.query('SELECT * FROM events WHERE id = $1', [event.id]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].title).toBe('Symphony Orchestra 2026');
  });

  it('ReservationFixtureBuilder should build and persist reservation', async () => {
    const { ticketTypeIds } = await EventFixtureBuilder.anEvent()
      .withTicketType('General', 5000, 100)
      .persist(pool);

    const reservation = await ReservationFixtureBuilder.aReservation()
      .withTicketTypeId(ticketTypeIds[0])
      .withQuantity(2)
      .inStatus(ReservationStatus.PENDING)
      .persist(pool);

    expect(reservation.quantity).toBe(2);
    expect(reservation.status).toBe(ReservationStatus.PENDING);

    const res = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservation.id]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].ticket_type_id).toBe(ticketTypeIds[0]);
  });
});
