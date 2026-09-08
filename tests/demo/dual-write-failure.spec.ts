import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { createOrderConfirmedEvent } from '../../src/modules/order/domain/events/OrderConfirmedEvent.js';
import { Order } from '../../src/modules/order/domain/Order.js';
import { OrderStatus } from '../../src/modules/order/domain/OrderStatus.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { DomainEvent } from '../../src/shared/events/DomainEvent.js';

class FakeBroker {
  public publishedEvents: DomainEvent[] = [];
  public shouldFail: boolean = false;

  public async publish(event: DomainEvent): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Broker connection refused / timeout');
    }
    this.publishedEvents.push(event);
  }

  public clear(): void {
    this.publishedEvents = [];
    this.shouldFail = false;
  }
}

describe('LAB-1001: Reproduce Dual-Write Failure (Atomicity Boundary Breakdown)', () => {
  let broker: FakeBroker;

  beforeEach(() => {
    broker = new FakeBroker();
  });

  it('Failure Mode 1: Post-Commit Crash results in CONFIRMED order with MISSING event (Silent Inconsistency)', async () => {
    const orderId = randomUUID();
    const userId = 'usr-dual-write-1';
    const reservationId = randomUUID();
    const ticketTypeId = randomUUID();

    const order = new Order(
      orderId,
      userId,
      reservationId,
      ticketTypeId,
      2,
      new Money(10000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );

    // Confirm order in memory
    const confirmedAt = new Date();
    order.confirm('txn-stripe-12345', confirmedAt);

    // 1. Transaction commits to Database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [order.ticketTypeId, 'org-dual', 'Dual Write Event', 'PUBLISHED', new Date(), new Date(Date.now() + 3600000)]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // 2. Controlled Fault Injection: Crash / Broker failure AFTER commit
    broker.shouldFail = true;
    let publishError: Error | null = null;
    try {
      const event = createOrderConfirmedEvent(order);
      await broker.publish(event);
    } catch (err) {
      publishError = err as Error;
    }

    // VERIFICATION OF DEFECT:
    expect(publishError).not.toBeNull();
    expect(publishError?.message).toContain('Broker connection refused');
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    // The critical dual-write defect: The broker has ZERO events!
    expect(broker.publishedEvents.length).toBe(0);

    console.log('\n[LAB-1001 Failure Mode 1 Demonstrated]');
    console.log(` -> Order ${order.id} is CONFIRMED in memory/DB.`);
    console.log(` -> Broker received: ${broker.publishedEvents.length} events.`);
    console.log(' -> Result: Downstream notification & ticket issuance NEVER triggered!\n');
  });

  it('Failure Mode 2: Publish-Before-Commit results in GHOST EVENT delivered to consumers on DB rollback', async () => {
    const orderId = randomUUID();
    const userId = 'usr-dual-write-2';
    const reservationId = randomUUID();
    const ticketTypeId = randomUUID();

    const order = new Order(
      orderId,
      userId,
      reservationId,
      ticketTypeId,
      1,
      new Money(5000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-ghost-999', new Date());

    // 1. Naive attempt: Publish to broker BEFORE committing to DB
    const event = createOrderConfirmedEvent(order);
    await broker.publish(event);
    expect(broker.publishedEvents.length).toBe(1);

    // Downstream consumer receives event and acts on it
    const downstreamConsumerReceived = broker.publishedEvents[0];
    expect(downstreamConsumerReceived.aggregateId).toBe(orderId);

    // 2. Database transaction fails & rolls back (e.g. Unique constraint violation or deadlock)
    let dbError: Error | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Intentionally execute invalid SQL to trigger transaction rollback
      await client.query('INSERT INTO non_existent_table_for_rollback (id) VALUES ($1)', [orderId]);
      await client.query('COMMIT');
    } catch (err) {
      dbError = err as Error;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // VERIFICATION OF DEFECT:
    expect(dbError).not.toBeNull();
    // The database rolled back, so no order exists in DB
    // But broker already delivered event to consumers!
    expect(broker.publishedEvents.length).toBe(1);

    console.log('\n[LAB-1001 Failure Mode 2 Demonstrated]');
    console.log(` -> DB transaction failed with: ${dbError?.message.split('\n')[0]}`);
    console.log(' -> DB transaction ROLLED BACK.');
    console.log(` -> But Broker already accepted event: ${downstreamConsumerReceived.eventId}`);
    console.log(' -> Result: GHOST EVENT! Downstream consumer issued goods for an order that was rolled back!\n');
  });
});
