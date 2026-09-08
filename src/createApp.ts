import express, { Express, Request, Response, NextFunction } from 'express';
import { correlationIdMiddleware } from './middleware/correlationIdMiddleware.js';
import { errorHandlerMiddleware } from './middleware/errorHandlerMiddleware.js';
import { createEventRouter } from './modules/catalog/interface/EventController.js';
import { ICacheService } from './infrastructure/cache/ICacheService.js';
import { defaultCacheService } from './infrastructure/cache/RedisCacheService.js';
import { RequestCoalescer, defaultCoalescer } from './infrastructure/cache/RequestCoalescer.js';
import { IRateLimiterStrategy } from './infrastructure/ratelimit/IRateLimiterStrategy.js';
import { createRateLimiterMiddleware } from './middleware/rateLimiterMiddleware.js';
import { ConcurrencyLimiter } from './infrastructure/resilience/ConcurrencyLimiter.js';
import { createLoadShedderMiddleware } from './middleware/loadShedderMiddleware.js';
import { IIdempotencyStore } from './infrastructure/idempotency/IdempotencyRecord.js';
import { createIdempotencyMiddleware } from './middleware/idempotencyMiddleware.js';

export interface AppOptions {
  instanceId?: string;
  cacheService?: ICacheService;
  coalescer?: RequestCoalescer;
  rateLimiterStrategy?: IRateLimiterStrategy;
  concurrencyLimiter?: ConcurrencyLimiter;
  idempotencyStore?: IIdempotencyStore;
}

export function createApp(options?: AppOptions): Express {
  const app = express();
  const instanceId = options?.instanceId || 'inst-default';
  const cacheService = options?.cacheService || defaultCacheService;
  const coalescer = options?.coalescer || defaultCoalescer;

  app.use(express.json());
  app.use(correlationIdMiddleware);

  // Trace which horizontal instance served the request
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Served-By', instanceId);
    next();
  });

  // Health check (bypasses load shedding so load balancers can still monitor instance health)
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'UP',
      instanceId,
      timestamp: new Date().toISOString(),
    });
  });

  // Optional Load Shedder / Concurrency Limiter (protects app from overload)
  if (options?.concurrencyLimiter) {
    app.use('/api', createLoadShedderMiddleware({ limiter: options.concurrencyLimiter }));
  }

  // Optional Rate Limiting Middleware
  if (options?.rateLimiterStrategy) {
    app.use('/api', createRateLimiterMiddleware({ strategy: options.rateLimiterStrategy }));
  }

  // Idempotency Middleware (handles Idempotency-Key headers on commands)
  app.use('/api', createIdempotencyMiddleware({ store: options?.idempotencyStore }));

  // Catalog API routes
  const catalogSetup = createEventRouter(cacheService, coalescer);
  app.use('/api', catalogSetup.router);

  // Central Error Handler
  app.use(errorHandlerMiddleware);

  return app;
}
