import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { IdempotentConsumer } from '../../src/infrastructure/consumer/IdempotentConsumer.js';
import { DomainEvent } from '../../src/shared/events/DomainEvent.js';

describe('LAB-1003: Idempotent Consumer & Inbox Deduplication', () => {
  let consumer: IdempotentConsumer;
  const consumerName = 'test-ticket-issuer';

  beforeEach(async () => {
    consumer = new IdempotentConsumer(consumerName, pool);
    await consumer.clear();
  });

  it('First delivery executes side effect and records completion in inbox', async () => {
    const eventId = randomUUID();
    const event: DomainEvent<{ ticketId: string }> = {
      eventId,
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { ticketId: randomUUID() },
    };

    let sideEffectExecuted = false;
    const result = await consumer.processTransactional(event, async (_ev, _client) => {
      sideEffectExecuted = true;
    });

    expect(result.status).toBe('PROCESSED');
    expect(sideEffectExecuted).toBe(true);

    const isDone = await consumer.isProcessed(eventId);
    expect(isDone).toBe(true);
  });

  it('Duplicate Delivery: Delivering the exact same event 10 times executes side effect exactly once', async () => {
    const eventId = randomUUID();
    const event: DomainEvent<{ ticketId: string }> = {
      eventId,
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { ticketId: randomUUID() },
    };

    let executionCount = 0;
    const execute = () =>
      consumer.processTransactional(event, async (_ev, _client) => {
        executionCount++;
      });

    // Send 10 times consecutively (simulating publisher retries & broker redeliveries)
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await execute());
    }

    // First attempt was PROCESSED
    expect(results[0].status).toBe('PROCESSED');

    // Subsequent 9 attempts were DUPLICATE_SKIPPED
    for (let i = 1; i < 10; i++) {
      expect(results[i].status).toBe('DUPLICATE_SKIPPED');
    }

    // Side effect ran EXACTLY ONCE
    expect(executionCount).toBe(1);
  });

  it('Crash / Failure Rollback: If side effect throws, inbox record rolls back, allowing safe retry', async () => {
    const eventId = randomUUID();
    const event: DomainEvent<{ amount: number }> = {
      eventId,
      eventType: 'payment.captured',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'payment-service',
      data: { amount: 5000 },
    };

    // First run: side effect crashes
    let crashed = false;
    try {
      await consumer.processTransactional(event, async () => {
        throw new Error('Simulated database deadlock / foreign key failure');
      });
    } catch (err) {
      crashed = true;
    }
    expect(crashed).toBe(true);

    // Inbox record should have rolled back
    const isDoneAfterCrash = await consumer.isProcessed(eventId);
    expect(isDoneAfterCrash).toBe(false);

    // Second run: retrying succeeds
    let retryExecuted = false;
    const retryResult = await consumer.processTransactional(event, async () => {
      retryExecuted = true;
    });

    expect(retryResult.status).toBe('PROCESSED');
    expect(retryExecuted).toBe(true);
    expect(await consumer.isProcessed(eventId)).toBe(true);
  });

  it('Multi-Consumer Independence: Multiple independent consumers processing the same event both succeed', async () => {
    const eventId = randomUUID();
    const event: DomainEvent<{ userId: string }> = {
      eventId,
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { userId: 'usr-multi' },
    };

    const emailConsumer = new IdempotentConsumer('email-notifier', pool);
    const analyticsConsumer = new IdempotentConsumer('analytics-indexer', pool);

    await emailConsumer.clear();
    await analyticsConsumer.clear();

    let emailSent = false;
    let analyticsIndexed = false;

    const emailRes = await emailConsumer.processTransactional(event, async () => {
      emailSent = true;
    });
    const analyticsRes = await analyticsConsumer.processTransactional(event, async () => {
      analyticsIndexed = true;
    });

    expect(emailRes.status).toBe('PROCESSED');
    expect(analyticsRes.status).toBe('PROCESSED');
    expect(emailSent).toBe(true);
    expect(analyticsIndexed).toBe(true);

    // Replaying for email consumer is skipped, but doesn't affect analytics
    const emailDup = await emailConsumer.processTransactional(event, async () => {
      throw new Error('Should not run');
    });
    expect(emailDup.status).toBe('DUPLICATE_SKIPPED');
  });
});
