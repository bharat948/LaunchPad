import { pool } from '../src/infrastructure/db/postgres.js';
import { runMigrations } from '../src/infrastructure/db/runMigrations.js';
import { EventFixtureBuilder } from '../tests/fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../src/modules/catalog/domain/EventStatus.js';
import { GetEventByIdUseCase } from '../src/modules/catalog/application/GetEventByIdUseCase.js';
import { PostgresEventRepository } from '../src/modules/catalog/infrastructure/PostgresEventRepository.js';
import { CachedGetEventByIdUseCase } from '../src/modules/catalog/application/CachedGetEventByIdUseCase.js';
import { defaultCacheService } from '../src/infrastructure/cache/RedisCacheService.js';
import { defaultCoalescer } from '../src/infrastructure/cache/RequestCoalescer.js';

export interface BenchmarkMetrics {
  name: string;
  totalRequests: number;
  concurrency: number;
  durationMs: number;
  rps: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  queriesPerRequest: number;
}

function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number; min: number; max: number; mean: number } {
  latencies.sort((a, b) => a - b);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const mean = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;

  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  return { p50, p95, p99, min, max, mean };
}

export async function runReadBenchmark(
  name: string,
  executeFn: () => Promise<unknown>,
  queriesPerRequest: number,
  totalRequests: number = 1000,
  concurrency: number = 10
): Promise<BenchmarkMetrics> {
  const latencies: number[] = [];
  const startTime = performance.now();
  let completed = 0;

  async function worker() {
    while (completed < totalRequests) {
      completed++;
      const reqStart = performance.now();
      await executeFn();
      const reqEnd = performance.now();
      latencies.push(reqEnd - reqStart);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalDurationMs = performance.now() - startTime;
  const rps = Math.round((totalRequests / (totalDurationMs / 1000)));
  const { p50, p95, p99, min, max, mean } = calculatePercentiles(latencies);

  return {
    name,
    totalRequests,
    concurrency,
    durationMs: Math.round(totalDurationMs),
    rps,
    minMs: Number(min.toFixed(2)),
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
    meanMs: Number(mean.toFixed(2)),
    queriesPerRequest,
  };
}

async function main() {
  await runMigrations();

  console.log('Seeding representative published event with 3 ticket tiers...');
  const { event } = await EventFixtureBuilder.anEvent()
    .withTitle('Global Tech Summit 2026')
    .withTicketType('General Admission', 5000, 1000)
    .withTicketType('VIP Access', 15000, 150)
    .withTicketType('Speaker Dinner Pass', 35000, 30)
    .inStatus(EventStatus.LIVE)
    .persist(pool);

  console.log(`Event seeded with ID: ${event.id}`);

  const repo = new PostgresEventRepository();
  const dbUseCase = new GetEventByIdUseCase(repo);
  const cachedUseCase = new CachedGetEventByIdUseCase(dbUseCase, defaultCacheService, defaultCoalescer);

  // 1. Pure PostgreSQL - Unwarmed
  console.log('\n--- 1. Pure PostgreSQL (Unwarmed Pool) ---');
  const coldPgMetrics = await runReadBenchmark(
    'Pure Postgres (Cold)',
    () => dbUseCase.execute(event.id),
    2,
    1000,
    10
  );
  console.table([coldPgMetrics]);

  // 2. Pure PostgreSQL - Pre-warmed
  console.log('\n--- 2. Pure PostgreSQL (Pre-warmed Pool) ---');
  const warmPgMetrics = await runReadBenchmark(
    'Pure Postgres (Warm)',
    () => dbUseCase.execute(event.id),
    2,
    1000,
    10
  );
  console.table([warmPgMetrics]);

  // 3. Redis Cache-Aside - Warm Hit
  // Prime cache first with 1 request
  await cachedUseCase.execute(event.id);
  console.log('\n--- 3. Redis Cache-Aside (Warm Hits) ---');
  const warmRedisMetrics = await runReadBenchmark(
    'Redis Cache-Aside (Hits)',
    () => cachedUseCase.execute(event.id),
    0, // 0 DB queries!
    1000,
    10
  );
  console.table([warmRedisMetrics]);

  console.log('\n================== SPRINT 5 PERFORMANCE COMPARISON ==================');
  console.table([
    {
      Architecture: 'Pure PostgreSQL (Baseline)',
      RPS: warmPgMetrics.rps,
      P50_ms: warmPgMetrics.p50Ms,
      P99_ms: warmPgMetrics.p99Ms,
      DB_Queries_Per_Req: warmPgMetrics.queriesPerRequest,
    },
    {
      Architecture: 'Redis Cache-Aside (Optimized)',
      RPS: warmRedisMetrics.rps,
      P50_ms: warmRedisMetrics.p50Ms,
      P99_ms: warmRedisMetrics.p99Ms,
      DB_Queries_Per_Req: warmRedisMetrics.queriesPerRequest,
    },
  ]);
  console.log('=====================================================================');

  await pool.end();
  await defaultCacheService.close();
}

if (process.argv[1] && process.argv[1].endsWith('benchmark-event-read.ts')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
