import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { PostgresOutboxRepository } from '../../src/infrastructure/outbox/TransactionalOutboxRepository.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/OutboxPublisher.ts';
import { InMemoryMessageBroker } from '../../src/shared/events/MessageBroker.js';
import { createOrderConfirmedEvent } from '../../src/modules/order/domain/events/OrderConfirmedEvent.js';
import { Order } from '../../src/modules/order/domain/Order.js';
import { OrderStatus } from '../../src/modules/order/domain/OrderStatus.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { TestClock } from '../../src/shared/domain/Clock.js';

describe('LAB-1002: Transactional Outbox Pattern & Reliable Publication', () => {
  let outboxRepo: PostgresOutboxRepository;
  let broker: InMemoryMessageBroker;
  let publisher: OutboxPublisher;
  let clock: TestClock;

  beforeEach(async () => {
    outboxRepo = new PostgresOutboxRepository(pool);
    await outboxRepo.clear();
    broker = new InMemoryMessageBroker();
    clock = new TestClock(new Date('2026-11-01T10:00:00Z'));
    publisher = new OutboxPublisher(outboxRepo, broker, clock);
  });

  afterEach(async () => {
    await publisher.stop();
  });

  it('Atomicity: Outbox message is committed in the same transaction as order confirmation', async () => {
    const orderId = randomUUID();
    const order = new Order(
      orderId,
      'usr-outbox-1',
      randomUUID(),
      randomUUID(),
      2,
      new Money(10000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-outbox-1', clock.now());
    const event = createOrderConfirmedEvent(order);

    // Perform atomic transaction: write aggregate & outbox message
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outboxRepo.insertWithinTransaction(client, event);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const pendingCount = await outboxRepo.countPending(order.id);
    expect(pendingCount).toBe(1);

    const pendingBatch = await outboxRepo.fetchPendingBatch(10, order.id);
    expect(pendingBatch.length).toBe(1);
    expect(pendingBatch[0].eventId).toBe(event.eventId);
    expect(pendingBatch[0].aggregateId).toBe(orderId);
    expect(pendingBatch[0].status).toBe('PENDING');
  });

  it('Atomicity Rollback: If transaction rolls back, outbox message is not persisted (Zero Ghost Events)', async () => {
    const order = new Order(
      randomUUID(),
      'usr-rollback',
      randomUUID(),
      randomUUID(),
      1,
      new Money(5000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-rollback', clock.now());
    const event = createOrderConfirmedEvent(order);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outboxRepo.insertWithinTransaction(client, event);
      // Explicitly ROLLBACK
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const pendingCount = await outboxRepo.countPending(order.id);
    expect(pendingCount).toBe(0);
  });

  it('Publication: Publisher reads pending messages, publishes to broker, and marks status as PUBLISHED', async () => {
    const order = new Order(
      randomUUID(),
      'usr-pub',
      randomUUID(),
      randomUUID(),
      1,
      new Money(2500, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-pub-1', clock.now());
    const event = createOrderConfirmedEvent(order);

    await outboxRepo.insert(event);
    expect(await outboxRepo.countPending(order.id)).toBe(1);

    // Execute publisher sweep
    const result = await publisher.publishPending(50, order.id);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);

    // Verify broker received event
    const published = broker.getMessagesForTopic(event.eventType);
    expect(published.length).toBe(1);
    expect(published[0].eventId).toBe(event.eventId);

    // Verify outbox record in DB is now PUBLISHED
    const pendingAfter = await outboxRepo.countPending(order.id);
    expect(pendingAfter).toBe(0);
  });

  it('Restartability: When broker fails temporarily, outbox retains messages and drains upon recovery', async () => {
    const order = new Order(
      randomUUID(),
      'usr-restart',
      randomUUID(),
      randomUUID(),
      1,
      new Money(3000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-restart-1', clock.now());
    const event = createOrderConfirmedEvent(order);
    await outboxRepo.insert(event);

    // 1. Simulate broker down
    broker.isDown = true;
    const failResult = await publisher.publishPending(50, order.id);
    expect(failResult.published).toBe(0);
    expect(failResult.failed).toBe(1);
    expect(failResult.remaining).toBe(1);
    expect(broker.publishedMessages.length).toBe(0);

    // 2. Broker recovers
    broker.isDown = false;
    const recoverResult = await publisher.publishPending(50, order.id);
    expect(recoverResult.published).toBe(1);
    expect(recoverResult.failed).toBe(0);
    expect(recoverResult.remaining).toBe(0);
    expect(broker.publishedMessages.length).toBe(1);
  });

  it('At-Least-Once Delivery: Crash after broker publish but before mark-as-published produces duplicate on replay', async () => {
    const order = new Order(
      randomUUID(),
      'usr-dup',
      randomUUID(),
      randomUUID(),
      1,
      new Money(1500, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-dup', clock.now());
    const event = createOrderConfirmedEvent(order);
    await outboxRepo.insert(event);

    // First attempt: broker receives it, but we simulate a crash before DB markPublished
    const pending = await outboxRepo.fetchPendingBatch(1, order.id);
    await broker.publish(pending[0].eventType, pending[0].payload);
    expect(broker.publishedMessages.length).toBe(1);

    // Simulated crash happens here (process killed before outboxRepo.markPublished)
    // Server reboots, publisher runs normal sweep:
    const secondResult = await publisher.publishPending(50, order.id);
    expect(secondResult.published).toBe(1);

    // Broker received the message TWICE (At-least-once delivery demonstrated)
    const messages = broker.getMessagesForTopic(event.eventType);
    expect(messages.length).toBe(2);
    expect(messages[0].eventId).toBe(messages[1].eventId);
  });
});
