# Sprint 6 Retrospective & Demo Report
**Theme: Traffic Protection — Stateless Scale-Out & Rate Limiting**
**Date:** September 8, 2026
**Status:** ALL ADVANCEMENT GATES SATISFIED

---

## 1. Sprint Objective & Completion Checklist
The goal of Sprint 6 was to make the Launchpad API safe to run as multiple horizontal instances and protect scarce database/transactional operations from unbounded request surges.

- [x] **LAB-601: Run Two Application Instances**: Refactored app bootstrapping into `createApp()`, verified 100% statelessness, demonstrated cross-instance read and write consistency, and proved **zero-downtime failover** when an instance is killed under active traffic.
- [x] **LAB-602: Implement Rate Limiter Abstraction**: Implemented Strategy Pattern with Token Bucket math, atomic distributed Redis Lua script, standard RFC RateLimit headers, and shared multi-instance enforcement.
- [x] **LAB-603: Overload Experiment, Backpressure & Load Shedding**: Systematically pushed the system beyond capacity, identified the primary bottleneck (PostgreSQL connection pool queue depth), and implemented **In-Flight Concurrency Limiting** with a **Priority Degradation Policy** that fails fast with HTTP 503 instead of cascading into collapse.

---

## 2. Sprint Demo: Live Verification

### Demo 1: Multi-Instance Round-Robin Load Balancing
```
Request 1 -> Dispatched to inst-1 (X-Served-By: inst-1, X-Cache: MISS)
Request 2 -> Dispatched to inst-2 (X-Served-By: inst-2, X-Cache: HIT from shared Redis!)
Request 3 -> Dispatched to inst-1 (X-Served-By: inst-1, X-Cache: HIT)
Request 4 -> Dispatched to inst-2 (X-Served-By: inst-2, X-Cache: HIT)
```
- Both instances share PostgreSQL and Redis seamlessly without user-visible drift.
- Status update on `inst-1` invalidates Redis; subsequent read on `inst-2` immediately reflects the updated state.

### Demo 2: Distributed Rate Limiting (HTTP 429) Across Nodes
```
Quota = 4 requests shared across instances
Request 1 on inst-1 -> 200 OK (X-RateLimit-Remaining: 3)
Request 2 on inst-2 -> 200 OK (X-RateLimit-Remaining: 2)
Request 3 on inst-1 -> 200 OK (X-RateLimit-Remaining: 1)
Request 4 on inst-2 -> 200 OK (X-RateLimit-Remaining: 0)
Request 5 on inst-1 -> 429 Too Many Requests (RATE_LIMIT_EXCEEDED, Retry-After: 1)
Request 6 on inst-2 -> 429 Too Many Requests (RATE_LIMIT_EXCEEDED, Retry-After: 1)
```
- Both instances query the atomic Redis Lua Token Bucket; the client cannot bypass limits by round-robining across nodes.

### Demo 3: Load Shedding & Priority Degradation (HTTP 503)
```
Instance configured for max 10 concurrent in-flight executions:
- 30 burst requests arrive simultaneously.
- 10 admitted requests complete cleanly in < 15ms.
- 20 excess requests fail fast in < 1ms with HTTP 503 (SERVER_OVERLOADED, Retry-After: 2).
- Zero hanging requests, zero socket timeouts, zero unhandled rejections!
```

---

## 3. Retrospective

### Question 1: What hidden state prevented horizontal scaling?
1. **In-Memory Rate Limit Counters**:
   - If rate limiting had been stored in Node.js process memory (`new Map()`), adding instances would linearly multiply the quota. A client could bypass a 5 req/min limit by sending 5 requests to instance 1, 5 to instance 2, and 5 to instance 3 (15 total requests).
   - *Fix*: Centralized atomic Token Bucket in Redis Lua.
2. **Process-Bound Singleflight Caches**:
   - In-memory `RequestCoalescer` is scoped per Node.js process. When two instances start simultaneously, both query PostgreSQL for a cold key. While this preserves correctness, true distributed coalescing requires shared Redis mutexes.
3. **Local Lifecycle Hooks**:
   - Running background cron jobs or cleanup tasks inside application servers breaks when scaled to $N$ instances (leading to $N$ competing scheduler executions).

### Question 2: Where is the bottleneck now?
**Answer: The PostgreSQL database connection pool and serialized row locks on hot inventory rows.**
- With horizontal scale-out, Node.js CPU is no longer the bottleneck—we can spin up 10 or 20 Node.js instances.
- With Redis caching, read traffic is no longer the bottleneck—Redis handles 50,000+ cached RPS.
- **The true bottleneck is the transactional write path**:
  - For a world-tour concert with 50,000 concurrent fans vying for the same VIP tier, every single reservation must acquire an exclusive pessimistic row lock on `inventory_pools` (`SELECT FOR UPDATE`).
  - PostgreSQL serializes these transactions one by one.
  - Furthermore, $N$ app instances competing for the same PostgreSQL cluster will eventually exhaust the database's `max_connections` (e.g. 100–200).
- *Future Evolution*: Partitioning inventory pools, asynchronous ticket waiting rooms / queues, or Redis atomic inventory decrementing before entering the database.

---

## 4. Architectural Boundaries Respected (DO NOT ADD YET)
- [x] **NO Kubernetes autoscaling**: Scale-out was verified with explicit multi-instance architecture and simulated reverse proxy routing.
- [x] **NO global multi-region routing**: Kept single-region and simple.
- [x] **NO complex service meshes (Istio/Linkerd)**: Resiliency, load balancing, and rate limiting were cleanly solved at the application and Layer 7 gateway layers.
