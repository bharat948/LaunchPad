# LAB-504: Cache Stampede (Thundering Herd) Report
**Sprint 5: Redis Caching and the Cost of Stale Data**
**Status:** COMPLETED
**Date:** September 8, 2026

---

## 1. Executive Summary & Defect Analysis
A **Cache Stampede** (also known as the **Thundering Herd Problem**) occurs when a heavily requested ("hot") cache key suddenly expires or is invalidated while dozens or hundreds of concurrent clients request it simultaneously.

In a naive cache-aside system:
1. All concurrent requests observe a cache miss (`null` from Redis) at the exact same microsecond.
2. Every request concurrently issues an independent query to PostgreSQL.
3. The database is assaulted with a synchronized spike of redundant queries for the identical row.
4. Connection pools exhaust, query queue depths spike, and response times collapse under cascading timeouts.

---

## 2. Experimental Reproduction & Mitigation

Using our deterministic `AsyncBarrier` synchronization latch, we simulated 30 concurrent clients hitting an event key whose cache was either expired or cold.

### Empirical Comparison: Uncoalesced vs Request Coalescing (Singleflight)

| Metric | Unmitigated Cache-Aside (Stampede) | Request Coalescing (Singleflight) | Impact / Reduction |
|---|---|---|---|
| **Concurrent Clients** | 30 | 30 | — |
| **Database Queries Executed** | **30 queries** | **1 query** | **-96.7% DB load reduction** |
| **Coalesced Requests** | 0 | 29 | 29 requests shared 1 in-flight Promise |
| **Client Success Rate** | 100% (High DB Stress) | 100% (Zero Redundant DB Stress) | Identical correct payload delivered |
| **DB Connection Overhead** | High contention across connection pool | Minimal (Single connection borrowed) | Connection pool starvation eliminated |

```
Unmitigated Stampede:
Client 1  ---> Miss ---> DB Query 1 (Postgres)
Client 2  ---> Miss ---> DB Query 2 (Postgres)
Client 3  ---> Miss ---> DB Query 3 (Postgres) ... [30 DB Queries!]

Singleflight Coalescing:
Client 1  ---> Miss ---> Starts In-Flight DB Query 1 (Leader)
Client 2  ---> Miss ---> Waits on In-Flight Promise 1 (Coalesced)
Client 3  ---> Miss ---> Waits on In-Flight Promise 1 (Coalesced) ... [Only 1 DB Query!]
```

---

## 3. Architecture of the Singleflight Pattern

Our `RequestCoalescer` (`src/infrastructure/cache/RequestCoalescer.ts`) maintains an in-memory map of active in-flight promises:
```ts
public async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = this.inFlight.get(key);
  if (existing) {
    this.coalescedCount++;
    return existing as Promise<T>;
  }

  this.primaryExecutions++;
  const promise = fn().finally(() => {
    this.inFlight.delete(key);
  });

  this.inFlight.set(key, promise);
  return promise;
}
```

When Client 1 triggers a cache miss:
- It creates and registers the database query promise for `events:v1:{id}`.
- Clients 2 through 30 arrive before Client 1's promise settles. They detect the registered key in `inFlight` and simply `await` that exact same promise.
- Upon resolution, the promise cleans itself up via `.finally()`.

---

## 4. Architectural Review Question

### Question: What new failure mode does the mitigation add?
**Answer: Blast-radius coupling across concurrent requests and multi-instance limitations.**

1. **Error Cascading (Shared Fate)**:
   - If the leader request fails (e.g. database timeout or query error), **all 29 waiting clients reject simultaneously** with the exact same error.
   - *Mitigation*: Fallback retries or error isolation per client.
2. **Hanging Loader Memory Leak**:
   - If the downstream database query hangs indefinitely without a timeout, all coalesced requests hang indefinitely, holding open HTTP connections and accumulating memory.
   - *Mitigation*: Strict timeout wrappers (`AbortController` / `Promise.race([query, timeout])`) on the loader function.
3. **Multi-Instance Limitation (In-Process Scope)**:
   - In-memory `RequestCoalescer` protects against stampedes **within a single Node.js process**.
   - If the application runs 10 Kubernetes pods behind a load balancer, each pod will execute 1 query (resulting in 10 DB queries instead of 300).
   - *Next Level*: If 10 queries per cluster is still too high, Redis Mutex locking (`SET key value NX PX`) or Stale-While-Revalidate background refresh can be introduced. However, distributed locks add lock contention and distributed deadlock risks. For event metadata, in-process singleflight is the most elegant, zero-dependency sweet spot.

---

## 5. Advancement Gate Verification
- [x] **Measured Benefit**: Stampede reduced from 30 DB queries to 1 DB query (96.7% reduction).
- [x] **Documented Consistency Tradeoff**: In-process singleflight eliminates redundant stampede queries while bounding risk to process boundaries.
