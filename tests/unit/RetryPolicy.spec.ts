import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy, RetryError } from '../../src/shared/resilience/RetryPolicy.js';

describe('LAB-703: Retry Policy, Exponential Backoff & Error Classification', () => {
  it('Retries on transient 503 Overload and eventually succeeds', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });
    let attempts = 0;

    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 3) {
        const err: RetryError = new Error('Overloaded');
        err.statusCode = 503;
        throw err;
      }
      return 'SUCCESS_AFTER_RETRY';
    });

    expect(result).toBe('SUCCESS_AFTER_RETRY');
    expect(attempts).toBe(3);
  });

  it('Aborts immediately on non-retryable 400 / 422 Client Errors without retrying', async () => {
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 10 });
    let attempts = 0;

    await expect(
      policy.execute(async () => {
        attempts++;
        const err: RetryError = new Error('Payload Mismatch');
        err.statusCode = 422;
        throw err;
      })
    ).rejects.toThrow('Payload Mismatch');

    // Exactly 1 attempt made: zero retries wasted on client error!
    expect(attempts).toBe(1);
  });

  it('Bounded Attempts: Re-throws original error once maxAttempts are exhausted', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10 });
    let attempts = 0;

    await expect(
      policy.execute(async () => {
        attempts++;
        const err: RetryError = new Error('Gateway Timeout');
        err.statusCode = 504;
        throw err;
      })
    ).rejects.toThrow('Gateway Timeout');

    expect(attempts).toBe(3);
  });

  it('Full Jitter Math: Backoff delays are bounded within [0, baseDelay * 2^attempt]', () => {
    const policy = new RetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, jitter: true });

    for (let attempt = 0; attempt < 5; attempt++) {
      const maxPossible = Math.min(1000, 100 * Math.pow(2, attempt));
      const backoff = policy.computeBackoffMs(attempt);
      expect(backoff).toBeGreaterThanOrEqual(0);
      expect(backoff).toBeLessThanOrEqual(maxPossible);
    }
  });

  it('Retry-After Header: Prioritizes explicit server Retry-After delay', () => {
    const policy = new RetryPolicy({ baseDelayMs: 50 });
    const backoff = policy.computeBackoffMs(0, 5); // 5 seconds
    expect(backoff).toBe(5000);
  });
});
