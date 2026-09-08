# LAB-501: Event Read Baseline Performance Report
**Sprint 5: Redis Caching and the Cost of Stale Data**
**Status:** COMPLETED
**Date:** September 8, 2026

---

## 1. Executive Summary & Objective
Before introducing Redis, an in-memory caching tier, or any performance optimization into Launchpad, we must establish rigorous, empirical baseline measurements of our primary read path:
`GET /api/events/:id`

Without concrete baseline latency and throughput numbers under repeatable load, introducing a cache is an **unjustified architectural complexity** that risks stale data bugs, cache stampedes, and operational overhead without measurable benefit.

This report captures the pre-cache performance profile against PostgreSQL with 1,000 requests at concurrency 10, both under Cold and Warm connection pool conditions, and under an automated 500-request regression test harness.

---

## 2. Test Environment & Harness

| Component | Specification |
|---|---|
| **Database** | PostgreSQL 16 Alpine in Docker container (`launchpad-db-1`) |
| **Port** | 5433 (mapped from container 5432) |
| **Connection Pool** | `pg.Pool` (Max 20 connections) |
| **App Runtime** | Node.js / Express / TypeScript via `tsx` |
| **Test Endpoint** | `GET /api/events/:id` |
| **Payload** | Published Event with 3 Ticket Types (General Admission, VIP, Early Bird) |
| **Concurrency** | 10 concurrent HTTP clients |
| **Total Requests** | 1,000 (Cold & Warm Benchmark) / 500 (Automated Vitest Regression) |

---

## 3. Empirical Baseline Measurements

### A. 1,000 Request Benchmark (`scripts/benchmark-event-read.ts`)

| Metric | Cold Run (Unwarmed Pool) | Warm Run (Pre-warmed Pool) | Delta / Impact |
|---|---|---|---|
| **Total Requests** | 1,000 | 1,000 | - |
| **Concurrency** | 10 | 10 | - |
| **Total Duration** | 3,045 ms | 2,006 ms | **-34.1% duration** |
| **Throughput (RPS)** | **328 req/sec** | **498 req/sec** | **+51.8% throughput** |
| **Min Latency** | 5.16 ms | 3.15 ms | -2.01 ms |
| **P50 (Median)** | **24.59 ms** | **17.50 ms** | **-28.8% faster** |
| **P95 Latency** | **62.58 ms** | **41.90 ms** | **-33.0% faster** |
| **P99 Latency** | **104.92 ms** | **52.78 ms** | **-49.7% tail latency reduction** |
| **Max Latency** | 363.30 ms | 60.00 ms | Tail connection handshake eliminated |
| **Mean Latency** | 30.41 ms | 20.03 ms | -34.1% faster |
| **DB Queries / Req** | **2** | **2** | Sequential `events` + `ticket_types` |

### B. Automated Performance Test (`tests/performance/read-baseline.spec.ts`)
Under the randomized Vitest harness (500 requests, concurrent pool):
- **P50 (Median):** 13.04 ms
- **P95:** 26.15 ms
- **P99:** 36.34 ms
- **Max:** 46.93 ms
- **Assertion:** `p50 < 40ms` and `p99 < 150ms` (Passed)

---

## 4. Query Volume & Database Load Analysis

For every single `GET /api/events/:id` call, the backend executes **2 sequential database queries**:
```sql
-- Query 1: Fetch root event entity
SELECT id, title, description, status, starts_at, ends_at, created_at, updated_at
FROM events
WHERE id = $1;

-- Query 2: Fetch all ticket tiers for event
SELECT id, event_id, name, price_amount, price_currency, total_capacity, available_inventory, reserved_inventory
FROM ticket_types
WHERE event_id = $1;
```

### Cumulative Database Impact at Scale
- At **500 req/sec** (Warm baseline throughput): The database receives **1,000 queries/sec**.
- At a modest flash-sale traffic spike of **10,000 req/sec**:
  - The database would be hammered with **20,000 queries/sec**.
  - A connection pool of 20 would experience severe queueing delay.
  - P99 latency would skyrocket past 500ms–1000ms due to connection pool starvation, even though each query takes < 1ms to execute in Postgres engine memory.

---

## 5. Architectural Review Questions

### Question 1: Is the database actually the bottleneck?
**Answer: No, not yet for single-digit queries on indexed tables, but connection pool starvation and network roundtrips are the real operational bottleneck.**

1. **Query Execution vs Network & Pooling Overhead**:
   - In PostgreSQL, `SELECT WHERE id = $1` uses the Primary Key B-Tree index, which takes **< 0.1ms** of CPU execution time inside PostgreSQL shared buffers.
   - However, each HTTP request pays:
     - 2 TCP roundtrips between Node.js and PostgreSQL (sequential `await`).
     - Connection pool checkout and checkin overhead in `pg.Pool`.
     - JSON serialization and parsing over the wire.
   - This expands a <0.2ms database CPU operation into an average **17.5ms** user-perceived HTTP latency.
2. **Saturation Limits**:
   - PostgreSQL connection limits are constrained by OS process overhead (Postgres uses one process per connection). A pool of 20–100 connections handles ~500–1,500 RPS before queuing occurs.
   - Therefore, while Postgres itself is fast, it cannot absorb tens of thousands of concurrent read requests during a ticket drop without exhausting its connection pool.

### Question 2: What portion of the response is cacheable?
**Answer: Static metadata is cacheable; live inventory availability is volatile and dangerous to cache naively.**

Let us decompose the response JSON payload:
```json
{
  "id": "b7228b4e-2883-42f2-92d5-d6fafd05742d",
  "title": "Coldplay World Tour 2026",
  "description": "Live in Mumbai",
  "status": "PUBLISHED",
  "timeWindow": {
    "startsAt": "2026-10-01T14:30:00.000Z",
    "endsAt": "2026-10-01T17:30:00.000Z"
  },
  "ticketTypes": [
    {
      "id": "tier-1",
      "name": "General Admission",
      "price": { "amount": 5000, "currency": "INR" },
      "capacity": 500,
      "availableInventory": 450,    <-- VOLATILE INVARIANT!
      "reservedInventory": 50       <-- VOLATILE INVARIANT!
    }
  ]
}
```

1. **Highly Cacheable (TTL: minutes/hours or event-based invalidation):**
   - Event `title`, `description`, `status`, `timeWindow`
   - Ticket type `id`, `name`, `price`, `capacity`
   - These mutate infrequently (e.g. only when organizer edits the event).
2. **Volatile / Dangerous to Cache:**
   - `availableInventory` and `reservedInventory`
   - If cached with a naive 60-second TTL:
     - Users see "10 tickets left" when inventory is actually `0` (Phantom Availability).
     - Users proceed to checkout only to fail at atomic reservation, causing massive user frustration and checkout churn.
3. **Design Implication for LAB-502 / LAB-503:**
   - Option A: Cache entire event payload with short TTL + cache invalidation on write.
   - Option B: Cache immutable metadata in Redis, read volatile inventory counts separately or display fuzzy availability ("In High Demand") on event pages, delegating exact inventory validation strictly to the reservation transaction.

---

## 6. Advancement Gate Verification
- [x] Baseline exists before Redis is introduced (`Cold P50: 24.59ms, P99: 104.92ms`, `Warm P50: 17.50ms, P99: 52.78ms`, `RPS: 498`).
- [x] DB query count measured (2 queries per HTTP request).
- [x] Repeatable benchmark script and automated Vitest regression test merged and green.
- [x] Zero Redis packages or connections present in codebase during LAB-501.
