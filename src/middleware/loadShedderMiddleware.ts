import { Request, Response, NextFunction } from 'express';
import { ConcurrencyLimiter, RequestPriority } from '../infrastructure/resilience/ConcurrencyLimiter.js';

export interface LoadShedderOptions {
  limiter: ConcurrencyLimiter;
  priorityResolver?: (req: Request) => RequestPriority;
}

export function createLoadShedderMiddleware(options: LoadShedderOptions) {
  const { limiter, priorityResolver } = options;

  const defaultPriority = (req: Request): RequestPriority => {
    // Critical write paths (reservations, status updates) have HIGH priority
    if (req.path.includes('/reservations') || req.method === 'POST' || req.method === 'PATCH') {
      return 'HIGH';
    }
    // Direct event detail reads have NORMAL priority
    if (req.method === 'GET' && req.path.match(/^\/events\/[^/]+$/)) {
      return 'NORMAL';
    }
    // Background or general catalog queries have LOW priority (shed first)
    return 'LOW';
  };

  const getPriority = priorityResolver || defaultPriority;

  return (req: Request, res: Response, next: NextFunction): void => {
    const priority = getPriority(req);

    if (!limiter.tryAcquire(priority)) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({
        error: {
          code: 'SERVER_OVERLOADED',
          message: 'Server is currently operating at maximum capacity. Please retry shortly.',
          retryAfterSeconds: 2,
        },
      });
      return;
    }

    // Release slot when response finishes or closes
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        limiter.release();
      }
    };

    res.on('finish', releaseOnce);
    res.on('close', releaseOnce);

    next();
  };
}
