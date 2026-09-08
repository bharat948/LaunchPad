export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterSeconds: number;
}

export interface IRateLimiterStrategy {
  consume(key: string, cost?: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}
