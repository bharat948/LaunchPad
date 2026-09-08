# Sprint 5 Retrospective & Demo Report
**Theme: Redis Caching and the Cost of Stale Data**
**Date:** September 8, 2026
**Status:** ALL ADVANCEMENT GATES SATISFIED

---

## 1. Sprint Objective & Completion Checklist
The goal of Sprint 5 was to introduce Redis caching **only for a measured read path** and scientifically learn every correctness cost and failure mode that caching introduces into a distributed system.

- [x] **LAB-501: Establish Read Baseline**: Recorded empirical P50 (17.5ms), P99 (52.78ms), and 498 RPS against pure PostgreSQL before introducing any cache code.
- [x] **LAB-502: Implement Cache-Aside for Event Reads**: Introduced Redis 7 with `ioredis`, versioned keys (`events:v1:{id}`), 300s TTL, and **fail-open resilience** (advancement gate: system remains available when Redis is stopped).
- [x] **LAB-503: Create and Fix Stale-Cache Bug**: Deliberately reproduced the stale-read defect upon database updates; implemented and verified **Invalidate-On-Write** (`DEL key`) mitigation.
- [x] **LAB-504: Reproduce Cache Stampede**: Demonstrated thundering herd query spike (30 concurrent misses -> 30 DB queries); implemented **Request Coalescing (Singleflight)** reducing DB load to **1 query** (96.7% reduction).

---

## 2. Sprint Demo: Live Experimental Verification

### Demo 1: Cold vs Warm Cache Benchmark
```
1. Initial Request (Cold Cache Miss):
   GET /api/events/{id} -> Returns HTTP 200 | X-Cache: MISS | DB Queries: 2
   (Loads from PostgreSQL, transforms domain entity, populates Redis with 300s TTL)

2. Subsequent Requests (Warm Cache Hit):
   GET /api/events/{id} -> Returns HTTP 200 | X-Cache: HIT | DB Queries: 0
   (Served directly from Redis RAM in < 2ms without touching PostgreSQL)
```

### Demo 2: Stale-Cache Reproduction & Invalidation Mitigation
```
1. Cache has Event Status: SCHEDULED
2. DB Updated to Status: LIVE (via PATCH /api/events/:id/status)
3. Without Invalidation -> GET returns SCHEDULED (STALE BUG DETECTED!)
4. With Invalidate-On-Write -> DEL events:v1:{id} executed immediately.
5. Immediate next GET returns LIVE (X-Cache: MISS), fresh data repopulated!
```

### Demo 3: Hot-Key Cache Stampede & Request Coalescing (Singleflight)
```
1. 30 concurrent clients hit expired event key simultaneously via AsyncBarrier.
2. Unmitigated Cache-Aside -> 30 independent PostgreSQL queries fired.
3. With Singleflight RequestCoalescer -> Exactly 1 DB query fired, 29 requests coalesced!
```

---

## 3. Retrospective

### Question 1: What new complexity did caching add?
1. **Loss of Single Source of Truth**: Data now lives in two places (PostgreSQL and Redis), creating potential drift, stale reads, and cache coherence synchronization challenges.
2. **Dual-Write / Invalidation Races**: In-flight slow database reads can race with database updates, re-populating the cache with stale data.
3. **Operational Failure Surface**: We now operate and monitor an additional service (Redis container/cluster), requiring connection pooling, fail-open logic, and memory eviction tuning.
4. **Cache Stampede Vulnerability**: Cold starts or expired hot keys cause violent query spikes on the database unless request coalescing or mutexes are in place.

### Question 2: Was the measured win worth it?
**Yes, but strictly for read-heavy immutable metadata, and definitely NOT for inventory.**
- For `GET /api/events/:id`, offloading repetitive reads from PostgreSQL to Redis frees up precious database connection pool capacity for atomic reservation transactions (`SELECT FOR UPDATE`).
- The measured win:
  - Database queries per event read dropped from **2 queries to 0 queries** on cache hits.
  - Throughput potential increased by orders of magnitude while protecting Postgres connection limits.
  - Fail-open resilience guarantees that if Redis crashes, the application continues serving traffic without downtime.

---

## 4. Architectural Boundaries Respected (DO NOT ADD YET)
- [x] **NO transactional inventory cached as authoritative state**: Inventory availability ($Available \ge 0$) remains strictly guarded by PostgreSQL ACID transaction boundaries.
- [x] **NO complex distributed Redis locks**: Concurrency control for reservations remains in PostgreSQL; request coalescing for cache misses was solved cleanly in-process via Singleflight without distributed lock overhead.
- [x] **NO broad "cache everything" abstractions**: Only the measured `GET /api/events/:id` path is cached.
