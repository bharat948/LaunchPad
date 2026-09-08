import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import {
  IIdempotencyStore,
} from '../infrastructure/idempotency/IdempotencyRecord.js';
import { defaultIdempotencyStore } from '../infrastructure/idempotency/PostgresIdempotencyStore.js';

export interface IdempotencyMiddlewareOptions {
  store?: IIdempotencyStore;
}

export function createIdempotencyMiddleware(options?: IdempotencyMiddlewareOptions) {
  const store = options?.store || defaultIdempotencyStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.headers['idempotency-key'];

    // Only inspect commands with an Idempotency-Key header
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      next();
      return;
    }

    const key = rawKey.trim();
    if (key.length > 255) {
      res.status(400).json({
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key length must not exceed 255 characters.',
        },
      });
      return;
    }

    // Compute canonical SHA-256 request payload fingerprint
    const canonicalBody = req.body ? JSON.stringify(req.body) : '';
    const requestHash = createHash('sha256').update(canonicalBody).digest('hex');
    const userId = (req.headers['x-user-id'] as string) || undefined;
    const requestPath = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;

    try {
      const acquireResult = await store.acquire(
        key,
        requestPath,
        req.method,
        requestHash,
        userId
      );

      // 1. Mismatch: Same key used with different payload
      if (acquireResult.state === 'MISMATCH') {
        res.status(422).json({
          error: {
            code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            message: 'Idempotency-Key was previously used with a different request payload.',
          },
        });
        return;
      }

      // 2. Completed: Replay cached response
      if (acquireResult.state === 'COMPLETED') {
        const { record } = acquireResult;
        res.setHeader('Idempotent-Replay', 'true');
        res.status(record.responseStatusCode || 200).json(record.responseBody);
        return;
      }

      // 3. In-Progress: Concurrent identical request is already processing
      if (acquireResult.state === 'IN_PROGRESS') {
        res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
            message: 'A request with this idempotency key is currently in progress. Please retry shortly.',
          },
        });
        return;
      }

      // 4. Acquired: Intercept response to store result on completion
      let responseBodyCaptured: unknown = null;
      const originalJson = res.json.bind(res);

      res.json = (body: unknown): Response => {
        responseBodyCaptured = body;
        return originalJson(body);
      };

      res.on('finish', async () => {
        const statusCode = res.statusCode;
        // Persist successful (2xx) and client validation (4xx) results
        if (statusCode >= 200 && statusCode < 500) {
          try {
            await store.complete(
              key,
              statusCode,
              { 'content-type': 'application/json' },
              responseBodyCaptured
            );
          } catch (err) {
            console.error('[IdempotencyMiddleware] Failed to complete idempotency record:', err);
          }
        } else {
          // Server errors (5xx) do not lock in failures; allow safe client retry
          await store.fail(key).catch(() => {});
        }
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
