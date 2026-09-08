import { Router, Request, Response, NextFunction } from 'express';
import { PostgresEventRepository } from '../infrastructure/PostgresEventRepository.js';
import { CreateEventUseCase } from '../application/CreateEventUseCase.js';
import { GetEventByIdUseCase } from '../application/GetEventByIdUseCase.js';
import { UpdateEventStatusUseCase } from '../application/UpdateEventStatusUseCase.js';
import { CachedGetEventByIdUseCase } from '../application/CachedGetEventByIdUseCase.js';
import { defaultCacheService, RedisCacheService } from '../../../infrastructure/cache/RedisCacheService.js';
import { defaultCoalescer, RequestCoalescer } from '../../../infrastructure/cache/RequestCoalescer.js';
import { ICacheService } from '../../../infrastructure/cache/ICacheService.js';

export function createEventRouter(
  cacheService: ICacheService = defaultCacheService,
  coalescer: RequestCoalescer = defaultCoalescer
): {
  router: Router;
  cachedGetEventByIdUseCase: CachedGetEventByIdUseCase;
  updateEventStatusUseCase: UpdateEventStatusUseCase;
} {
  const router = Router();
  const eventRepo = new PostgresEventRepository();

  const createEventUseCase = new CreateEventUseCase(eventRepo);
  const getEventByIdUseCase = new GetEventByIdUseCase(eventRepo);
  const updateEventStatusUseCase = new UpdateEventStatusUseCase(eventRepo);
  const cachedGetEventByIdUseCase = new CachedGetEventByIdUseCase(
    getEventByIdUseCase,
    cacheService,
    coalescer
  );

  // GET /api/events/cache/metrics (MUST be before /events/:id)
  router.get('/events/cache/metrics', (req: Request, res: Response) => {
    res.status(200).json(cacheService.getMetrics());
  });

  // POST /api/events
  router.post('/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { organizerId, title, saleStartAt, saleEndAt, ticketTypes } = req.body;
      if (!organizerId || !title || !saleStartAt || !saleEndAt) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'organizerId, title, saleStartAt, and saleEndAt are required fields',
          },
        });
        return;
      }

      const eventResponse = await createEventUseCase.execute({
        organizerId,
        title,
        saleStartAt,
        saleEndAt,
        ticketTypes: ticketTypes || [],
      });

      res.status(201).setHeader('Location', `/api/events/${eventResponse.id}`).json(eventResponse);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/events/:id
  router.get('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await cachedGetEventByIdUseCase.execute(id);

      if (!result.event) {
        res.status(404).json({
          error: {
            code: 'EVENT_NOT_FOUND',
            message: `Event with ID '${id}' was not found`,
          },
        });
        return;
      }

      // X-Cache header signals HIT vs MISS for contract observability
      res.setHeader('X-Cache', result.source === 'CACHE' ? 'HIT' : 'MISS');
      res.status(200).json(result.event);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/events/:id/status
  router.patch('/events/:id/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { status } = req.body;
      if (!status) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Target status field is required',
          },
        });
        return;
      }

      const eventResponse = await updateEventStatusUseCase.execute(id, status);
      if (!eventResponse) {
        res.status(404).json({
          error: {
            code: 'EVENT_NOT_FOUND',
            message: `Event with ID '${id}' was not found`,
          },
        });
        return;
      }

      // LAB-503: Invalidate-On-Write to eliminate stale reads immediately
      await cacheService.del(CachedGetEventByIdUseCase.getCacheKey(id));

      res.status(200).json(eventResponse);
    } catch (err) {
      next(err);
    }
  });

  return { router, cachedGetEventByIdUseCase, updateEventStatusUseCase };
}

// Default router instance mounted in server.ts
const defaultSetup = createEventRouter();
export const eventRouter = defaultSetup.router;
export const cachedGetEventByIdUseCase = defaultSetup.cachedGetEventByIdUseCase;
