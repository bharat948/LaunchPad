# ADR-003: Redis Cache-Aside for Event Reads & Fail-Open Resiliency
**Sprint 5: Redis Caching and the Cost of Stale Data**
**Status:** ACCEPTED
**Date:** September 8, 2026

---

## 1. Context & Problem Statement
In Launchpad, `GET /api/events/:id` is the highest-volume read path. Before a ticket drop or concert sale, thousands of concurrent prospective attendees repeatedly query the published event metadata, ticket tiers, and pricing.

In **LAB-501**, our baseline performance benchmark established that each read request issued **2 sequential SQL queries** (`SELECT FROM events` and `SELECT FROM ticket_types`), capping throughput at ~498 RPS at 17.5ms P50 latency. At 10,000+ RPS, this query volume would exhaust the PostgreSQL connection pool, triggering cascading request timeouts.

We need a high-performance in-memory caching tier that eliminates redundant database queries while ensuring high availability.

---

## 2. Decision
We adopt the **Cache-Aside Pattern** using **Redis 7** and `ioredis` with **Fail-Open Resiliency**.

### A. Cache-Aside Workflow
```
[ Client ] ---> GET /api/events/:id
                     |
                     v
             [ Redis Cache ]
             /             \
       (Cache Hit)      (Cache Miss)
          /                 \
  Return Cached DTO     [ PostgreSQL ]
                             |
                     Fetch Event & Tiers
                             |
                     Populate Redis (TTL 300s)
                             |
                     Return DTO to Client
```

### B. Key Naming & Namespace Strategy
All event cache keys follow the structured, versioned schema:
```
events:v1:{eventId}
```
- **Namespace (`events`)**: Prevents key collisions with other modules (e.g. `users`, `reservations`).
- **Version (`v1`)**: Enables zero-downtime schema evolution. If `EventResponseDTO` adds or renames fields in v2, changing the prefix to `events:v2:` instantly prevents deserialization mismatch bugs without needing an invasive flush of the entire Redis cluster.
- **Identifier (`{eventId}` UUID)**: Unique event aggregate ID.

### C. TTL Policy
- **Default TTL: 300 seconds (5 minutes)**:
  - Ensures abandoned keys automatically expire, bounding Redis RAM consumption.
  - Acts as a safety net against leaked stale entries if an invalidation message is dropped.

### D. Fail-Open Resiliency (Advancement Gate)
Redis is an optimization, **not the authoritative system of record**.
If the Redis cluster is unreachable, network partitions occur, or connection limits are exhausted:
1. `RedisCacheService` safely catches all Redis exceptions.
2. It logs an operational warning and increments the internal `errors` counter.
3. The request **fails-open**, transparently delegating the read to PostgreSQL.
4. The user receives HTTP 200 with complete, correct data and `X-Cache: MISS`.
5. **No 500 Internal Server Errors are ever presented to end users due to cache downtime.**

### E. Telemetry & Observability
- HTTP Response Header: `X-Cache: HIT` vs `X-Cache: MISS`.
- Operational Telemetry Endpoint: `GET /api/events/cache/metrics` exposing:
  - `hits`, `misses`, `errors`, `sets`, `dels`, `hitRate` (%).

---

## 3. Review Questions & Architectural Rationales

### Question 1: Why cache-aside rather than write-through?
| Dimension | Cache-Aside (Lazy Loading) | Write-Through |
|---|---|---|
| **Memory Footprint** | **Optimal**: Only requested ("hot") events occupy Redis RAM. Unviewed draft or archived events never pollute cache. | **Wasteful**: Every created or edited event is written to cache even if no user ever views it. |
| **Write Latency** | **Fast**: Writes only commit to PostgreSQL (authoritative store). | **Slower**: Write transactions must block on both PostgreSQL and Redis network roundtrips. |
| **Fault Tolerance** | **Resilient**: If Redis dies, writes succeed 100% and reads fall back to DB. | **Fragile**: If Redis dies, writes either fail or become inconsistent with cache. |
| **Cache Stampede Vulnerability** | Higher risk on initial miss / cold key (mitigated via Request Coalescing in LAB-504). | Lower risk for newly created records. |

**Verdict**: Cache-aside decouples the transactional write path from caching infrastructure, preserves operational resiliency, and optimizes memory usage.

### Question 2: What data should NEVER use this cache?
> **Rule of Thumb**: Only immutable or slowly mutating data belongs in this cache. **Transactional state and concurrency primitives must NEVER use this cache.**

Specifically, the following data must **never** be cached via naive cache-aside:
1. **Authoritative Inventory Counts (`availableInventory`)**:
   - Caching `availableInventory` for even 5 seconds leads to **Phantom Availability**: users are told tickets are available when they are already sold out, causing massive checkout rejection spikes.
2. **Reservation Records & Payment States**:
   - State machine transitions (`PENDING -> CONFIRMED -> EXPIRED`) require strict ACID guarantees in PostgreSQL (`SELECT FOR UPDATE`).
3. **Idempotency Keys & Financial Ledgers**:
   - Must be verified directly against PostgreSQL transaction boundaries to prevent double-charging.

---

## 4. Verification & Metrics
- Unit & Integration Suite: `tests/integration/event-cache.spec.ts` (100% passing).
- Fail-open verification: Disconnecting Redis yields HTTP 200 with zero client disruption.
- Telemetry verified: Hit rate calculated accurately across consecutive hits and misses.
