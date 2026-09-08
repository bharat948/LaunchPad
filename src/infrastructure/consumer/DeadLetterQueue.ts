import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { DomainEvent } from '../../shared/events/DomainEvent.js';
import { pool as defaultPool } from '../db/postgres.js';

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export class PermanentPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPoisonError';
  }
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Common transient database or network error keywords
    return (
      msg.includes('deadlock') ||
      msg.includes('connection reset') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('rate limit') ||
      msg.includes('503') ||
      msg.includes('429')
    );
  }
  return false;
}

export interface DeadLetterRecord {
  id: string;
  eventId: string;
  consumerName: string;
  payload: DomainEvent;
  errorMessage: string;
  errorStack?: string;
  attempts: number;
  failedAt: Date;
  replayedAt?: Date | null;
  status: 'DEAD' | 'REPLAYED' | 'DISCARDED';
}

export interface RetryConfig {
  maxAttempts: number;
  baseBackoffMs: number;
}

export class DeadLetterQueueRepository {
  constructor(private dbPool: Pool = defaultPool) {}

  public async moveToDeadLetter(
    event: DomainEvent,
    consumerName: string,
    error: Error,
    attempts: number
  ): Promise<string> {
    const id = randomUUID();
    const query = `
      INSERT INTO dead_letter_messages (
        id, event_id, consumer_name, payload, error_message, error_stack, attempts, failed_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'DEAD')
      RETURNING id;
    `;
    const res = await this.dbPool.query(query, [
      id,
      event.eventId,
      consumerName,
      JSON.stringify(event),
      error.message,
      error.stack || null,
      attempts,
    ]);
    return res.rows[0].id;
  }

  public async fetchById(id: string): Promise<DeadLetterRecord | null> {
    const res = await this.dbPool.query(
      `SELECT id, event_id, consumer_name, payload, error_message, error_stack, attempts, failed_at, replayed_at, status
       FROM dead_letter_messages WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      eventId: r.event_id,
      consumerName: r.consumer_name,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      errorMessage: r.error_message,
      errorStack: r.error_stack,
      attempts: r.attempts,
      failedAt: r.failed_at,
      replayedAt: r.replayed_at,
      status: r.status,
    };
  }

  public async listDeadLetters(consumerName?: string): Promise<DeadLetterRecord[]> {
    const query = consumerName
      ? `SELECT * FROM dead_letter_messages WHERE consumer_name = $1 AND status = 'DEAD' ORDER BY failed_at DESC`
      : `SELECT * FROM dead_letter_messages WHERE status = 'DEAD' ORDER BY failed_at DESC`;
    const params = consumerName ? [consumerName] : [];
    const res = await this.dbPool.query(query, params);
    return res.rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      consumerName: r.consumer_name,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      errorMessage: r.error_message,
      errorStack: r.error_stack,
      attempts: r.attempts,
      failedAt: r.failed_at,
      replayedAt: r.replayed_at,
      status: r.status,
    }));
  }

  public async markReplayed(id: string): Promise<void> {
    await this.dbPool.query(
      `UPDATE dead_letter_messages SET status = 'REPLAYED', replayed_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  public async markDiscarded(id: string): Promise<void> {
    await this.dbPool.query(
      `UPDATE dead_letter_messages SET status = 'DISCARDED' WHERE id = $1`,
      [id]
    );
  }

  public async clear(): Promise<void> {
    await this.dbPool.query(`DELETE FROM dead_letter_messages`);
  }
}

export type ConsumerAction<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

export class ResilientMessageConsumer {
  constructor(
    public readonly consumerName: string,
    private dlqRepo: DeadLetterQueueRepository,
    private config: RetryConfig = { maxAttempts: 3, baseBackoffMs: 20 }
  ) {}

  /**
   * Consumes an event with automatic classification, retry with backoff, and DLQ diversion
   */
  public async consume<T>(
    event: DomainEvent<T>,
    action: ConsumerAction<T>
  ): Promise<{ status: 'SUCCESS' | 'DLQ_DIVERTED'; attempts: number; deadLetterId?: string }> {
    let attempt = 0;

    while (attempt < this.config.maxAttempts) {
      attempt++;
      try {
        await action(event);
        return { status: 'SUCCESS', attempts: attempt };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        // 1. If permanent poison pill, divert to DLQ immediately without retrying
        if (error instanceof PermanentPoisonError) {
          const deadLetterId = await this.dlqRepo.moveToDeadLetter(
            event,
            this.consumerName,
            error,
            attempt
          );
          return { status: 'DLQ_DIVERTED', attempts: attempt, deadLetterId };
        }

        // 2. If transient and attempts remain, backoff and retry
        if (isTransientError(error) && attempt < this.config.maxAttempts) {
          const sleepMs = this.config.baseBackoffMs * Math.pow(2, attempt - 1);
          await new Promise((res) => setTimeout(res, sleepMs));
          continue;
        }

        // 3. Retries exhausted
        const deadLetterId = await this.dlqRepo.moveToDeadLetter(
          event,
          this.consumerName,
          error,
          attempt
        );
        return { status: 'DLQ_DIVERTED', attempts: attempt, deadLetterId };
      }
    }

    // Safety fallback
    const deadLetterId = await this.dlqRepo.moveToDeadLetter(
      event,
      this.consumerName,
      new Error('Max retry attempts exhausted'),
      attempt
    );
    return { status: 'DLQ_DIVERTED', attempts: attempt, deadLetterId };
  }

  /**
   * Replays a dead letter message using an action handler
   */
  public async replay(
    deadLetterId: string,
    action: ConsumerAction
  ): Promise<{ success: boolean; error?: string }> {
    const record = await this.dlqRepo.fetchById(deadLetterId);
    if (!record) {
      throw new Error(`Dead letter record not found: ${deadLetterId}`);
    }

    try {
      await action(record.payload);
      await this.dlqRepo.markReplayed(deadLetterId);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Replay failed',
      };
    }
  }
}
