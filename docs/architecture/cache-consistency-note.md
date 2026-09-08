# Cache Consistency Note: Stale-Cache Defect & Invalidation Strategies
**Sprint 5: Redis Caching and the Cost of Stale Data (LAB-503)**
**Status:** COMPLETED
**Date:** September 8, 2026

---

## 1. Executive Summary & Defect Statement
Introducing a cache immediately breaks the **single source of truth** invariant of an application.
Whenever data mutates in the primary persistent datastore (PostgreSQL) while an older copy remains stored in the in-memory cache (Redis), the application enters an **inconsistent state**.

In **LAB-503**, we deliberately demonstrated this failure mode:
1. An event is cached in Redis with `status: SCHEDULED`.
2. An administrator publishes the event, transitioning its state in PostgreSQL to `status: LIVE`.
3. Because the cache was not invalidated, subsequent user queries received `status: SCHEDULED` with `X-Cache: HIT`.
4. Users could not purchase tickets because the API falsely reported the event was not yet live!

---

## 2. Invalidation Strategies Compared

| Strategy | Mechanism | Pros | Cons & Edge Cases |
|---|---|---|---|
| **TTL-Only Expiry** | Do not invalidate on write; rely entirely on 300s TTL. | Simple; zero coupling between write path and cache. | **Unacceptable consistency window**: Users see stale data for up to 300 seconds. Highly damaging for status or pricing changes. |
| **Invalidate-On-Write (`DEL key`)** *(Adopted)* | On every database UPDATE / DELETE, execute `cache.del(events:v1:{id})`. | Simple, robust, low write latency overhead; next read automatically fetches fresh truth. | Small race condition window if a slow read is in-flight during the update. |
| **Write-Through / Update Cache** | On DB update, immediately serialize and overwrite `cache.set(key, newDto)`. | Eliminates subsequent cache miss latency. | Wastes memory if key is never read again; requires dual-write locking to prevent race where older write overwrites newer write. |
| **Versioned Keys (`events:v{version}:{id}`)** | Increment entity version column in DB (`version = version + 1`). | Eliminates all cache-overwrite races. | Requires schema support and client/caller awareness of current entity version. |

### Decision: Invalidate-On-Write (`DEL key`)
We chose **Invalidate-On-Write**:
- When `PATCH /api/events/:id/status` executes successfully in PostgreSQL, the controller immediately calls:
  ```ts
  await cacheService.del(CachedGetEventByIdUseCase.getCacheKey(id));
  ```
- The very next request misses the cache (`X-Cache: MISS`), reads the authoritative row from PostgreSQL, and repopulates Redis with the fresh state.

---

## 3. Concurrency Race: Concurrent Read Miss + Write Update

Consider the following execution timeline:
```
Time  Client A (Read - Cache Miss)       Client B (Update - Status Change)
----  ----------------------------       ---------------------------------
T1    Checks Redis (Miss)
T2    Reads Postgres (Status = DRAFT)
T3                                       Updates Postgres (Status = LIVE)
T4                                       Invalidates Redis (DEL events:v1:123)
T5    Writes to Redis (Status = DRAFT) <-- RACE CONDITION!
```
At **T5**, Client A's slow read completes *after* Client B's update and invalidation, writing the **stale `DRAFT` state back into Redis**.

### How to Mitigate the Race Window:
1. **Short TTL Ceiling**: Even if the race occurs, an aggressive TTL (e.g., 60–300s) bounds the duration of the stale window.
2. **Double Invalidation (Delayed Del)**: Send a second invalidation command 500ms after the transaction commits (asynchronous cleanup).
3. **Database Version Tags in Cache**: Compare entity updated timestamp / version before writing to cache.

---

## 4. Architectural Review Questions

### Question 1: Can stale data cause financial or correctness harm?
**Answer: Yes, catastrophic harm.**

1. **Incorrect Pricing (Financial Loss / Legal Liability)**:
   - If a concert organizer updates ticket prices from \$50 to \$100 due to high demand, but the cache serves \$50 for 5 minutes, hundreds of users checkout at the wrong price.
   - Either the business absorbs massive revenue loss, or cancels orders, triggering customer outrage and potential consumer protection violations.
2. **Event Cancellation Ignored**:
   - If an event is cancelled due to severe weather or artist illness, but the cache continues serving `status: PUBLISHED`, users continue traveling, queueing, and attempting to purchase tickets.
3. **Draft Leaks**:
   - Private or unannounced artist line-ups leaked early due to cache retention after an admin attempts to revert an accidental publish.

### Question 2: Should inventory ever be cached the same way?
**Answer: Absolutely NOT.**

- **Inventory is a high-contention, transactional decrement invariant**:
  - $Available \ge 0$ is a zero-tolerance invariant.
  - Caching inventory counts in naive Cache-Aside guarantees **overselling** (double booking) or **phantom sold-out** conditions.
- **How Production Ticketing Systems Handle Inventory**:
  1. **Fuzzy UI Indicators**: Event catalog pages only display coarse states: *"Tickets Available"*, *"Selling Fast"*, or *"Sold Out"*.
  2. **Atomic In-Memory Reservations (Redis Lua / Redis Transactions)**: If Redis is used for inventory, it must be updated via atomic `DECRBY` with floor checks (`if redis.call('get', key) >= qty then ...`), not read-then-write cache-aside.
  3. **Authoritative ACID Lock**: The true claim of inventory must always occur inside a database transaction boundary (`SELECT FOR UPDATE` or conditional SQL `UPDATE inventory WHERE available >= requested`).

---

## 5. Advancement Gate Verification
- [x] **Stale-Cache Bug Demonstrated**: Automated test `tests/concurrency/stale-cache-invalidation.spec.ts` proves that updating PostgreSQL without invalidating Redis results in stale read hits.
- [x] **Mitigation Verified**: Test proves that Invalidate-On-Write forces an immediate cache miss and serves fresh data on the very next read.
- [x] **Consistency Window Documented**: Race conditions analyzed and bounded.
