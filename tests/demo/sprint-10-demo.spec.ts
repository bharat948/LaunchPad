import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { PostgresOutboxRepository } from '../../src/infrastructure/outbox/TransactionalOutboxRepository.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/OutboxPublisher.js';
import { InMemoryMessageBroker } from '../../src/shared/events/MessageBroker.js';
import {
  DeadLetterQueueRepository,
  ResilientMessageConsumer,
  PermanentPoisonError,
} from '../../src/infrastructure/consumer/DeadLetterQueue.js';
import { IdempotentConsumer } from '../../src/infrastructure/consumer/IdempotentConsumer.js';
import { createOrderConfirmedEvent } from '../../src/modules/order/domain/events/OrderConfirmedEvent.js';
import { Order } from '../../src/modules/order/domain/Order.js';
import { OrderStatus } from '../../src/modules/order/domain/OrderStatus.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { TestClock } from '../../src/shared/domain/Clock.js';

describe('Sprint 10 Demo: Resilient Outbox, Consumer Inbox & Dead Letter Operations', () => {
  let outboxRepo: PostgresOutboxRepository;
  let dlqRepo: DeadLetterQueueRepository;
  let broker: InMemoryMessageBroker;
  let publisher: OutboxPublisher;
  let clock: TestClock;

  beforeEach(async () => {
    outboxRepo = new PostgresOutboxRepository(pool);
    dlqRepo = new DeadLetterQueueRepository(pool);
    await outboxRepo.clear();
    await dlqRepo.clear();
    broker = new InMemoryMessageBroker();
    clock = new TestClock(new Date('2026-11-01T10:00:00Z'));
    publisher = new OutboxPublisher(outboxRepo, broker, clock);
  });

  afterEach(async () => {
    await publisher.stop();
  });

  it('Sprint Demo 1: Confirm order with broker offline; restore broker and observe guaranteed event delivery', async () => {
    console.log('\n================== SPRINT DEMO 1: BROKER DOWN RECOVERY ==================');

    // 1. Broker is OFFLINE
    broker.isDown = true;
    console.log('1. Simulating external message broker outage (Kafka/RabbitMQ down)...');

    const order = new Order(
      randomUUID(),
      'usr-demo-1',
      randomUUID(),
      randomUUID(),
      2,
      new Money(15000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn-demo-broker-down', clock.now());
    const event = createOrderConfirmedEvent(order);

    // 2. Application confirms order and atomically saves to outbox
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outboxRepo.insertWithinTransaction(client, event);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    console.log(`2. Order ${order.id} confirmed and saved to PostgreSQL Transactional Outbox.`);

    // 3. Publisher sweep fails safely without losing the event
    const sweep1 = await publisher.publishPending(50, order.id);
    console.log(`3. Publisher attempt with broker down: published=${sweep1.published}, failed=${sweep1.failed}, pending=${sweep1.remaining}`);
    expect(sweep1.published).toBe(0);
    expect(sweep1.failed).toBe(1);
    expect(sweep1.remaining).toBe(1);
    expect(broker.publishedMessages.length).toBe(0);

    // 4. Broker recovers
    broker.isDown = false;
    console.log('4. Message broker connection restored!');

    // 5. Publisher runs next sweep
    const sweep2 = await publisher.publishPending(50, order.id);
    console.log(`5. Publisher recovery sweep: published=${sweep2.published}, failed=${sweep2.failed}, pending=${sweep2.remaining}`);
    expect(sweep2.published).toBe(1);
    expect(sweep2.failed).toBe(0);
    expect(sweep2.remaining).toBe(0);

    // 6. Verify broker now holds the delivered event
    const delivered = broker.getMessagesForTopic(event.eventType);
    expect(delivered.length).toBe(1);
    expect(delivered[0].eventId).toBe(event.eventId);
    console.log(`6. Guaranteed Event Delivery confirmed: Event ${delivered[0].eventId} published successfully!\n`);
  });

  it('Sprint Demo 2: Inject poison event, inspect DLQ isolation, and execute operational replay', async () => {
    console.log('\n================== SPRINT DEMO 2: POISON EVENT & DLQ REPLAY ==================');
    const consumerName = 'sprint-demo-consumer';
    const consumer = new ResilientMessageConsumer(consumerName, dlqRepo, {
      maxAttempts: 3,
      baseBackoffMs: 10,
    });
    const inboxConsumer = new IdempotentConsumer(consumerName, pool);
    await inboxConsumer.clear();

    // 1. Inject a poisoned event (e.g. malformed user record)
    const poisonEvent = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { corruptedField: null, illegalState: true },
    };

    console.log(`1. Injecting poison message into consumer: ${poisonEvent.eventId}`);
    const poisonResult = await consumer.consume(poisonEvent, async () => {
      throw new PermanentPoisonError('Poison pill: invalid schema data format');
    });

    console.log(`2. Consumer execution status: ${poisonResult.status}, attempts: ${poisonResult.attempts}, DLQ ID: ${poisonResult.deadLetterId}`);
    expect(poisonResult.status).toBe('DLQ_DIVERTED');
    expect(poisonResult.deadLetterId).toBeDefined();

    // 2. Verify DLQ table has the record with status DEAD
    const dlqRecord = await dlqRepo.fetchById(poisonResult.deadLetterId!);
    expect(dlqRecord).not.toBeNull();
    expect(dlqRecord?.status).toBe('DEAD');
    console.log(`3. Verified in DLQ: status=${dlqRecord?.status}, error="${dlqRecord?.errorMessage}"`);

    // 3. Verify healthy traffic is unblocked
    const healthyEvent = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { valid: true },
    };
    const healthyResult = await consumer.consume(healthyEvent, async () => {
      // Processes successfully
    });
    expect(healthyResult.status).toBe('SUCCESS');
    console.log('4. Healthy pipeline check: subsequent event processed with SUCCESS.');

    // 4. Operator investigates, fixes root cause, and initiates replay
    console.log('5. Operator triggering replay after fixing downstream consumer handler...');
    let replayExecuted = false;
    const replayResult = await consumer.replay(poisonResult.deadLetterId!, async (event) => {
      expect(event.eventId).toBe(poisonEvent.eventId);
      replayExecuted = true;
    });

    expect(replayResult.success).toBe(true);
    expect(replayExecuted).toBe(true);

    const replayedRecord = await dlqRepo.fetchById(poisonResult.deadLetterId!);
    expect(replayedRecord?.status).toBe('REPLAYED');
    console.log(`6. DLQ record status after replay: ${replayedRecord?.status}, replayedAt: ${replayedRecord?.replayedAt?.toISOString()}\n`);
  });
});
