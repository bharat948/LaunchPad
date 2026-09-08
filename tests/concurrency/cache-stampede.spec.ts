import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { defaultCacheService } from '../../src/infrastructure/cache/RedisCacheService.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { CachedGetEventByIdUseCase } from '../../src/modules/catalog/application/CachedGetEventByIdUseCase.js';
import { GetEventByIdUseCase } from '../../src/modules/catalog/application/GetEventByIdUseCase.js';
import { PostgresEventRepository } from '../../src/modules/catalog/infrastructure/PostgresEventRepository.js';
import { RequestCoalescer } from '../../src/infrastructure/cache/RequestCoalescer.js';
import { AsyncBarrier } from './AsyncBarrier.js';

describe('LAB-504: Cache Stampede (Thundering Herd) Reproduction & Request Coalescing Mitigation', () => {

  it('Stampede Defect: Without coalescing, synchronized expiry causes massive DB query spike', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Coldplay Ahmedabad Mega-Concert')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    const CONCURRENT_CLIENTS = 30;
    let dbExecutions = 0;

    // Spy on DB execution count
    const repo = new PostgresEventRepository();
    const mockGetUseCase = {
      execute: async (id: string) => {
        dbExecutions++;
        // Small delay to simulate realistic database processing time
        await new Promise((r) => setTimeout(r, 20));
        return repo.findById(id).then((e) =>
          e
            ? {
                id: e.id,
                organizerId: e.organizerId,
                title: e.title,
                status: e.status,
                saleStartAt: e.saleWindow.startAt.toISOString(),
                saleEndAt: e.saleWindow.endAt.toISOString(),
                ticketTypes: [],
              }
            : null
        );
      },
    } as unknown as GetEventByIdUseCase;

    const uncoalescedUseCase = new CachedGetEventByIdUseCase(
      mockGetUseCase,
      defaultCacheService,
      new RequestCoalescer(),
      300,
      false // COALESCING DISABLED: Deliberately reproduce stampede!
    );

    // Coordinate all 30 clients to hit the cache on the exact same microsecond
    const barrier = new AsyncBarrier(CONCURRENT_CLIENTS);

    const clientPromises = Array.from({ length: CONCURRENT_CLIENTS }, async () => {
      await barrier.wait();
      return uncoalescedUseCase.execute(event.id);
    });

    const results = await Promise.all(clientPromises);

    // Verify all 30 clients received the event
    expect(results).toHaveLength(CONCURRENT_CLIENTS);
    for (const res of results) {
      expect(res.event?.id).toBe(event.id);
      expect(res.source).toBe('DB');
    }

    // 🔥 STAMPEDE PROVEN: Every single client triggered an independent database query!
    console.log(`[Uncoalesced Stampede] Concurrent Clients: ${CONCURRENT_CLIENTS}, DB Queries: ${dbExecutions}`);
    expect(dbExecutions).toBe(CONCURRENT_CLIENTS); // 30 separate DB queries!
  });

  it('Stampede Mitigation (Singleflight): Request Coalescing collapses 30 concurrent misses into 1 DB query', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Coldplay Ahmedabad Mega-Concert (Coalesced)')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    const CONCURRENT_CLIENTS = 30;
    let dbExecutions = 0;

    const repo = new PostgresEventRepository();
    const mockGetUseCase = {
      execute: async (id: string) => {
        dbExecutions++;
        // Small delay to simulate realistic database processing time
        await new Promise((r) => setTimeout(r, 20));
        return repo.findById(id).then((e) =>
          e
            ? {
                id: e.id,
                organizerId: e.organizerId,
                title: e.title,
                status: e.status,
                saleStartAt: e.saleWindow.startAt.toISOString(),
                saleEndAt: e.saleWindow.endAt.toISOString(),
                ticketTypes: [],
              }
            : null
        );
      },
    } as unknown as GetEventByIdUseCase;

    const coalescer = new RequestCoalescer();
    const coalescedUseCase = new CachedGetEventByIdUseCase(
      mockGetUseCase,
      defaultCacheService,
      coalescer,
      300,
      true // COALESCING ENABLED: Singleflight pattern active!
    );

    // Coordinate all 30 clients to strike simultaneously
    const barrier = new AsyncBarrier(CONCURRENT_CLIENTS);

    const clientPromises = Array.from({ length: CONCURRENT_CLIENTS }, async () => {
      await barrier.wait();
      return coalescedUseCase.execute(event.id);
    });

    const results = await Promise.all(clientPromises);

    // Verify all 30 clients received the event
    expect(results).toHaveLength(CONCURRENT_CLIENTS);
    for (const res of results) {
      expect(res.event?.id).toBe(event.id);
    }

    // ✅ MITIGATION PROVEN: Exactly ONE DB query was executed!
    const stats = coalescer.getStats();
    console.log(
      `[Coalesced Singleflight] Concurrent Clients: ${CONCURRENT_CLIENTS}, Primary DB Queries: ${stats.primaryExecutions}, Coalesced: ${stats.coalescedCount}`
    );

    expect(dbExecutions).toBe(1);
    expect(stats.primaryExecutions).toBe(1);
    expect(stats.coalescedCount).toBe(CONCURRENT_CLIENTS - 1); // 29 coalesced requests
  });
});
