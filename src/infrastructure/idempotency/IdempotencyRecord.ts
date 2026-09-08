export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord {
  key: string;
  userId?: string;
  requestPath: string;
  requestMethod: string;
  requestHash: string; // SHA-256 hex string
  status: IdempotencyStatus;
  responseStatusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  createdAt: Date;
  lockedUntil?: Date;
}

export type AcquireResult =
  | { state: 'ACQUIRED' }
  | { state: 'COMPLETED'; record: IdempotencyRecord }
  | { state: 'IN_PROGRESS' }
  | { state: 'MISMATCH' };

export interface IIdempotencyStore {
  acquire(
    key: string,
    path: string,
    method: string,
    hash: string,
    userId?: string,
    lockDurationMs?: number
  ): Promise<AcquireResult>;

  complete(
    key: string,
    statusCode: number,
    headers: Record<string, string>,
    body: unknown
  ): Promise<void>;

  fail(key: string): Promise<void>;
}
