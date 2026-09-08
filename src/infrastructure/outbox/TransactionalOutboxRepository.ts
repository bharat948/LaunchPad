import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { DomainEvent } from '../../shared/events/DomainEvent.js';
import { pool as defaultPool } from '../db/postgres.js';

export interface OutboxRecord {
  id: string;
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: DomainEvent;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  retryCount: number;
  createdAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

export interface IOutboxRepository {
  insertWithinTransaction(client: PoolClient, event: DomainEvent): Promise<void>;
  insert(event: DomainEvent): Promise<void>;
  fetchPendingBatch(limit?: number, aggregateId?: string): Promise<OutboxRecord[]>;
  markPublished(id: string, publishedAt?: Date): Promise<void>;
  recordFailure(id: string, error: string): Promise<void>;
  countPending(aggregateId?: string): Promise<number>;
  getByEventId(eventId: string): Promise<OutboxRecord | null>;
  clear(): Promise<void>;
}

export class PostgresOutboxRepository implements IOutboxRepository {
  constructor(private dbPool: Pool = defaultPool) {}

  /**
   * Atomic insertion inside an EXISTING transaction (e.g. order confirmation)
   */
  public async insertWithinTransaction(client: PoolClient, event: DomainEvent): Promise<void> {
    const id = randomUUID();
    const query = `
      INSERT INTO outbox_messages (
        id, event_id, event_type, aggregate_id, payload, status, retry_count, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, NOW())
      ON CONFLICT (event_id) DO NOTHING;
    `;
    await client.query(query, [
      id,
      event.eventId,
      event.eventType,
      event.aggregateId,
      JSON.stringify(event),
    ]);
  }

  /**
   * Standalone insert (creates its own client)
   */
  public async insert(event: DomainEvent): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await this.insertWithinTransaction(client, event);
    } finally {
      client.release();
    }
  }

  /**
   * Reads a batch of unpublished rows for the publisher to process.
   * Uses FOR UPDATE SKIP LOCKED to allow concurrent publisher workers without double-reading!
   */
  public async fetchPendingBatch(limit: number = 50, aggregateId?: string): Promise<OutboxRecord[]> {
    const query = aggregateId
      ? `
        SELECT id, event_id, event_type, aggregate_id, payload, status, retry_count, created_at, published_at, last_error
        FROM outbox_messages
        WHERE status = 'PENDING' AND aggregate_id = $2
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `
      : `
        SELECT id, event_id, event_type, aggregate_id, payload, status, retry_count, created_at, published_at, last_error
        FROM outbox_messages
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;
    const params = aggregateId ? [limit, aggregateId] : [limit];
    const res = await this.dbPool.query(query, params);
    return res.rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      aggregateId: r.aggregate_id,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      retryCount: r.retry_count,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      lastError: r.last_error,
    }));
  }

  public async markPublished(id: string, publishedAt: Date = new Date()): Promise<void> {
    const query = `
      UPDATE outbox_messages
      SET status = 'PUBLISHED', published_at = $1, last_error = NULL
      WHERE id = $2;
    `;
    await this.dbPool.query(query, [publishedAt, id]);
  }

  public async recordFailure(id: string, error: string): Promise<void> {
    const query = `
      UPDATE outbox_messages
      SET status = CASE WHEN retry_count >= 5 THEN 'FAILED' ELSE 'PENDING' END,
          retry_count = retry_count + 1,
          last_error = $1
      WHERE id = $2;
    `;
    await this.dbPool.query(query, [error, id]);
  }

  public async countPending(aggregateId?: string): Promise<number> {
    const query = aggregateId
      ? `SELECT COUNT(*)::int as count FROM outbox_messages WHERE status = 'PENDING' AND aggregate_id = $1`
      : `SELECT COUNT(*)::int as count FROM outbox_messages WHERE status = 'PENDING'`;
    const params = aggregateId ? [aggregateId] : [];
    const res = await this.dbPool.query(query, params);
    return res.rows[0].count;
  }

  public async getByEventId(eventId: string): Promise<OutboxRecord | null> {
    const query = `
      SELECT id, event_id, event_type, aggregate_id, payload, status, retry_count, created_at, published_at, last_error
      FROM outbox_messages
      WHERE event_id = $1;
    `;
    const res = await this.dbPool.query(query, [eventId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      aggregateId: r.aggregate_id,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      retryCount: r.retry_count,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      lastError: r.last_error,
    };
  }

  public async clear(): Promise<void> {
    await this.dbPool.query(`DELETE FROM outbox_messages`);
  }
}
