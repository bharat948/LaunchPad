export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean; // Defaults to true (Full Jitter)
}

export interface RetryError extends Error {
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;
}

export class RetryPolicy {
  private maxAttempts: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private jitter: boolean;

  constructor(options?: RetryPolicyOptions) {
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 50;
    this.maxDelayMs = options?.maxDelayMs ?? 1000;
    this.jitter = options?.jitter ?? true;
  }

  /**
   * Determines whether an error is safe and meaningful to retry.
   */
  public isRetryable(err: unknown): boolean {
    const error = err as RetryError;

    // Network level transient errors
    const networkErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'];
    if (error.code && networkErrorCodes.includes(error.code)) {
      return true;
    }

    if (error.statusCode) {
      // 429 (Rate Limited) and 503 (Overloaded) and 504 (Gateway Timeout) are transient
      if ([429, 503, 504].includes(error.statusCode)) {
        return true;
      }

      // Client errors (400, 401, 403, 404, 409, 422) are non-retryable
      if (error.statusCode >= 400 && error.statusCode < 500) {
        return false;
      }

      // Other 5xx (500, 502) can be retried if operation is idempotent
      if (error.statusCode >= 500) {
        return true;
      }
    }

    return false;
  }

  /**
   * Computes backoff delay using Full Jitter:
   * sleep = random_between(0, min(maxDelay, baseDelay * 2^attempt))
   */
  public computeBackoffMs(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }

    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, attempt));
    if (this.jitter) {
      return Math.floor(Math.random() * exponential);
    }
    return exponential;
  }

  public async execute<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;

        // If error is not retryable, abort immediately without wasting attempts
        if (!this.isRetryable(err)) {
          throw err;
        }

        // If final attempt exhausted, rethrow
        if (attempt === this.maxAttempts - 1) {
          throw err;
        }

        const retryAfter = (err as RetryError).retryAfterSeconds;
        const sleepMs = this.computeBackoffMs(attempt, retryAfter);
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }

    throw lastError;
  }
}
