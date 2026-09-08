import { Pool, PoolClient } from 'pg';
import { DomainEvent } from '../../shared/events/DomainEvent.js';
import { pool as defaultPool } from '../db/postgres.js';

export interface ConsumerExecutionResult {
  status: 'PROCESSED' | 'DUPLICATE_SKIPPED' | 'FAILED';
  eventId: string;
  consumerName: string;
  message?: string;
}

export type TransactionalSideEffect<T = unknown> = (
  event: DomainEvent<T>,
  client: PoolClient
) => Promise<void>;

export type ExternalSideEffect<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

/**
 * IdempotentConsumer / Inbox Pattern Implementation
 * Guarantees that at-least-once broker delivery results in effectively-once business side effects.
 */
export class IdempotentConsumer {
  constructor(
    public readonly consumerName: string,
    private dbPool: Pool = defaultPool
  ) {}

  /**
   * Processes a database side-effect within an ACID transaction shared with the inbox record.
   * If the business effect crashes, the inbox entry rolls back, allowing safe retry.
   * If already processed, it safely short-circuits with DUPLICATE_SKIPPED.
   */
  public async processTransactional<T>(
    event: DomainEvent<T>,
    sideEffect: TransactionalSideEffect<T>
  ): Promise<ConsumerExecutionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');

      // Attempt to acquire inbox lock / insert processing entry with conflict handling
      const checkQuery = `
        SELECT status FROM inbox_messages
        WHERE event_id = $1 AND consumer_name = $2
        FOR UPDATE;
      `;
      const existing = await client.query(checkQuery, [event.eventId, this.consumerName]);

      if (existing.rows.length > 0 && existing.rows[0].status === 'COMPLETED') {
        await client.query('ROLLBACK');
        return {
          status: 'DUPLICATE_SKIPPED',
          eventId: event.eventId,
          consumerName: this.consumerName,
          message: 'Event already successfully processed by this consumer',
        };
      }

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO inbox_messages (event_id, consumer_name, status, processed_at)
           VALUES ($1, $2, 'PROCESSING', NOW())`,
          [event.eventId, this.consumerName]
        );
      }

      // Execute caller's business side effect with the transaction client
      await sideEffect(event, client);

      // Mark COMPLETED
      await client.query(
        `UPDATE inbox_messages
         SET status = 'COMPLETED', processed_at = NOW()
         WHERE event_id = $1 AND consumer_name = $2`,
        [event.eventId, this.consumerName]
      );

      await client.query('COMMIT');

      return {
        status: 'PROCESSED',
        eventId: event.eventId,
        consumerName: this.consumerName,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Helper to check if an event has already been processed by this consumer
   */
  public async isProcessed(eventId: string): Promise<boolean> {
    const res = await this.dbPool.query(
      `SELECT status FROM inbox_messages WHERE event_id = $1 AND consumer_name = $2`,
      [eventId, this.consumerName]
    );
    return res.rows.length > 0 && res.rows[0].status === 'COMPLETED';
  }

  /**
   * Cleans up inbox records for tests
   */
  public async clear(): Promise<void> {
    await this.dbPool.query(
      `DELETE FROM inbox_messages WHERE consumer_name = $1`,
      [this.consumerName]
    );
  }
}
