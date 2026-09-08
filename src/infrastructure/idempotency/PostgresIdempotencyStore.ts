import { Pool } from 'pg';
import { pool as defaultPool } from '../db/postgres.js';
import {
  IIdempotencyStore,
  AcquireResult,
  IdempotencyRecord,
} from './IdempotencyRecord.js';

export class PostgresIdempotencyStore implements IIdempotencyStore {
  constructor(private pool: Pool = defaultPool) {}

  public async acquire(
    key: string,
    path: string,
    method: string,
    hash: string,
    userId?: string,
    lockDurationMs: number = 30000 // 30 second in-flight lock ceiling
  ): Promise<AcquireResult> {
    const lockedUntil = new Date(Date.now() + lockDurationMs);

    // 1. Attempt atomic insert of new idempotency record
    const insertRes = await this.pool.query(
      `INSERT INTO idempotency_keys (key, user_id, request_path, request_method, request_hash, status, locked_until)
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6)
       ON CONFLICT (key) DO NOTHING
       RETURNING *`,
      [key, userId || null, path, method, hash, lockedUntil]
    );

    if (insertRes.rows.length > 0) {
      return { state: 'ACQUIRED' };
    }

    // 2. Key already exists: inspect existing record
    const selectRes = await this.pool.query(
      `SELECT * FROM idempotency_keys WHERE key = $1`,
      [key]
    );

    if (selectRes.rows.length === 0) {
      // Rare race: deleted right after conflict, retry acquire
      return this.acquire(key, path, method, hash, userId, lockDurationMs);
    }

    const row = selectRes.rows[0];

    // 3. Payload Fingerprint Check: Disallow key reuse with different body!
    if (row.request_hash !== hash) {
      return { state: 'MISMATCH' };
    }

    // 4. Completed: Safe to replay stored response
    if (row.status === 'COMPLETED') {
      const record: IdempotencyRecord = {
        key: row.key,
        userId: row.user_id,
        requestPath: row.request_path,
        requestMethod: row.request_method,
        requestHash: row.request_hash,
        status: row.status,
        responseStatusCode: row.response_status_code,
        responseHeaders: row.response_headers || {},
        responseBody: row.response_body,
        createdAt: row.created_at,
        lockedUntil: row.locked_until,
      };
      return { state: 'COMPLETED', record };
    }

    // 5. In-Progress: Check if lock has expired (crash recovery)
    if (row.locked_until && new Date(row.locked_until) < new Date()) {
      // Reclaim abandoned/crashed lock
      const updateRes = await this.pool.query(
        `UPDATE idempotency_keys
         SET status = 'IN_PROGRESS', locked_until = $1
         WHERE key = $2 AND status = 'IN_PROGRESS' AND locked_until < NOW()
         RETURNING *`,
        [lockedUntil, key]
      );

      if (updateRes.rows.length > 0) {
        return { state: 'ACQUIRED' };
      }
    }

    // Active concurrent request in flight
    return { state: 'IN_PROGRESS' };
  }

  public async complete(
    key: string,
    statusCode: number,
    headers: Record<string, string>,
    body: unknown
  ): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED',
           response_status_code = $1,
           response_headers = $2,
           response_body = $3,
           locked_until = NULL
       WHERE key = $4`,
      [statusCode, JSON.stringify(headers), JSON.stringify(body), key]
    );
  }

  public async fail(key: string): Promise<void> {
    // Delete or mark failed so client can retry cleanly
    await this.pool.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND status = 'IN_PROGRESS'`,
      [key]
    );
  }
}

export const defaultIdempotencyStore = new PostgresIdempotencyStore();
