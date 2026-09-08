import { Request, Response, NextFunction } from 'express';
import { IRateLimiterStrategy } from '../infrastructure/ratelimit/IRateLimiterStrategy.js';

export interface RateLimiterMiddlewareOptions {
  strategy: IRateLimiterStrategy;
  keyGenerator?: (req: Request) => string;
  cost?: number;
}

export function createRateLimiterMiddleware(options: RateLimiterMiddlewareOptions) {
  const { strategy, keyGenerator, cost = 1 } = options;

  const defaultKeyGen = (req: Request): string => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip || 'anonymous';
    const userId = req.headers['x-user-id'] || 'anon';
    return `${ip}:${userId}:${req.baseUrl || ''}${req.path}`;
  };

  const getKey = keyGenerator || defaultKeyGen;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = getKey(req);
      const result = await strategy.consume(key, cost);

      // Attach standard RFC / IETF RateLimit headers
      res.setHeader('X-RateLimit-Limit', result.limit.toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + result.resetMs) / 1000).toString());

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfterSeconds.toString());
        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many requests. Please retry after ${result.retryAfterSeconds} seconds.`,
            retryAfterSeconds: result.retryAfterSeconds,
          },
        });
        return;
      }

      next();
    } catch (err) {
      // Fail-open: Never drop user requests if rate limiter errors
      next();
    }
  };
}
