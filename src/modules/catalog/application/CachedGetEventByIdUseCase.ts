import { GetEventByIdUseCase } from './GetEventByIdUseCase.js';
import { EventResponseDTO } from './EventDTOs.js';
import { ICacheService } from '../../../infrastructure/cache/ICacheService.js';
import { RequestCoalescer } from '../../../infrastructure/cache/RequestCoalescer.js';

export interface CachedEventResult {
  event: EventResponseDTO | null;
  source: 'CACHE' | 'DB';
}

export class CachedGetEventByIdUseCase {
  private ttlSeconds: number;
  private coalescingEnabled: boolean;

  constructor(
    private underlyingUseCase: GetEventByIdUseCase,
    private cacheService: ICacheService,
    private coalescer: RequestCoalescer,
    ttlSeconds = 300,
    coalescingEnabled = true
  ) {
    this.ttlSeconds = ttlSeconds;
    this.coalescingEnabled = coalescingEnabled;
  }

  public setCoalescingEnabled(enabled: boolean): void {
    this.coalescingEnabled = enabled;
  }

  public static getCacheKey(id: string): string {
    return `events:v1:${id}`;
  }

  public async execute(id: string): Promise<CachedEventResult> {
    const cacheKey = CachedGetEventByIdUseCase.getCacheKey(id);

    // 1. Check Redis first (Cache-Aside)
    const cached = await this.cacheService.get<EventResponseDTO>(cacheKey);
    if (cached) {
      return { event: cached, source: 'CACHE' };
    }

    // 2. Cache Miss: Fetch from database
    if (this.coalescingEnabled) {
      // Coalesced singleflight DB load
      const event = await this.coalescer.do(cacheKey, async () => {
        const dbEvent = await this.underlyingUseCase.execute(id);
        if (dbEvent) {
          await this.cacheService.set(cacheKey, dbEvent, this.ttlSeconds);
        }
        return dbEvent;
      });

      return { event, source: 'DB' };
    } else {
      // Direct uncoalesced DB load (reproduces stampede)
      const dbEvent = await this.underlyingUseCase.execute(id);
      if (dbEvent) {
        await this.cacheService.set(cacheKey, dbEvent, this.ttlSeconds);
      }
      return { event: dbEvent, source: 'DB' };
    }
  }
}
