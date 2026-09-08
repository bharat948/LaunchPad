import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../src/infrastructure/db/postgres.js';
import {
  DeadLetterQueueRepository,
  ResilientMessageConsumer,
  TransientError,
  PermanentPoisonError,
} from '../../src/infrastructure/consumer/DeadLetterQueue.js';
import { DomainEvent } from '../../src/shared/events/DomainEvent.js';

describe('LAB-1004: Retry Policy, Poison Pill DLQ & Operational Replay', () => {
  let dlqRepo: DeadLetterQueueRepository;
  let consumer: ResilientMessageConsumer;
  const consumerName = 'test-fulfillment-consumer';

  beforeEach(async () => {
    dlqRepo = new DeadLetterQueueRepository(pool);
    await dlqRepo.clear();
    consumer = new ResilientMessageConsumer(consumerName, dlqRepo, {
      maxAttempts: 3,
      baseBackoffMs: 10,
    });
  });

  it('Transient Recovery: Fails on attempt 1, backs off, and succeeds on attempt 2 without DLQ', async () => {
    const event: DomainEvent<{ id: string }> = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { id: 'item-1' },
    };

    let attemptCount = 0;
    const result = await consumer.consume(event, async () => {
      attemptCount++;
      if (attemptCount === 1) {
        throw new TransientError('Database connection temporarily timed out');
      }
      // Succeeds on attempt 2
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.attempts).toBe(2);
    expect(attemptCount).toBe(2);

    const deadLetters = await dlqRepo.listDeadLetters(consumerName);
    expect(deadLetters.length).toBe(0);
  });

  it('Exhausted Retries: Transient failure that exceeds maxAttempts is safely moved to DLQ', async () => {
    const event: DomainEvent<{ id: string }> = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { id: 'exhausted-item' },
    };

    let attemptCount = 0;
    const result = await consumer.consume(event, async () => {
      attemptCount++;
      throw new TransientError('Persistent downstream network outage');
    });

    expect(result.status).toBe('DLQ_DIVERTED');
    expect(result.attempts).toBe(3);
    expect(attemptCount).toBe(3);
    expect(result.deadLetterId).toBeDefined();

    // Verify persisted in DLQ table
    const record = await dlqRepo.fetchById(result.deadLetterId!);
    expect(record).not.toBeNull();
    expect(record?.status).toBe('DEAD');
    expect(record?.errorMessage).toContain('downstream network outage');
    expect(record?.attempts).toBe(3);
  });

  it('Poison Message Quarantine: Permanent error is quarantined immediately without blocking queue', async () => {
    const poisonEvent: DomainEvent<{ corruptData: string }> = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { corruptData: 'malformed-unparseable-bytes' },
    };

    let poisonAttempts = 0;
    const poisonResult = await consumer.consume(poisonEvent, async () => {
      poisonAttempts++;
      throw new PermanentPoisonError('Corrupt payload schema: invalid character encoding');
    });

    // Zero redundant retries for poison messages!
    expect(poisonResult.status).toBe('DLQ_DIVERTED');
    expect(poisonResult.attempts).toBe(1);
    expect(poisonAttempts).toBe(1);

    // Verify immediately quarantined in DLQ
    const dlqRecord = await dlqRepo.fetchById(poisonResult.deadLetterId!);
    expect(dlqRecord?.status).toBe('DEAD');
    expect(dlqRecord?.errorMessage).toContain('Corrupt payload schema');

    // Pipeline Unblocked: A subsequent healthy message processes immediately without delay
    const healthyEvent: DomainEvent<{ id: string }> = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { id: 'healthy-item' },
    };

    let healthyProcessed = false;
    const healthyResult = await consumer.consume(healthyEvent, async () => {
      healthyProcessed = true;
    });

    expect(healthyResult.status).toBe('SUCCESS');
    expect(healthyProcessed).toBe(true);
  });

  it('Operational Replay: DLQ record can be replayed after bug fix and transitions to REPLAYED', async () => {
    const event: DomainEvent<{ ticketId: string }> = {
      eventId: randomUUID(),
      eventType: 'order.confirmed',
      aggregateId: randomUUID(),
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      data: { ticketId: 'ticket-999' },
    };

    // 1. Message fails and lands in DLQ
    const failResult = await consumer.consume(event, async () => {
      throw new PermanentPoisonError('Missing third-party partner authorization token');
    });
    const dlqId = failResult.deadLetterId!;

    const beforeReplay = await dlqRepo.fetchById(dlqId);
    expect(beforeReplay?.status).toBe('DEAD');

    // 2. Engineer patches the partner token and triggers replay
    let replayedSuccessfully = false;
    const replayRes = await consumer.replay(dlqId, async (replayedEvent) => {
      expect(replayedEvent.eventId).toBe(event.eventId);
      replayedSuccessfully = true;
    });

    expect(replayRes.success).toBe(true);
    expect(replayedSuccessfully).toBe(true);

    // 3. Status is now REPLAYED with audit timestamp
    const afterReplay = await dlqRepo.fetchById(dlqId);
    expect(afterReplay?.status).toBe('REPLAYED');
    expect(afterReplay?.replayedAt).toBeDefined();
  });
});
