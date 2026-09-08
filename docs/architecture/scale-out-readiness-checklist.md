# Scale-Out Readiness Checklist & Stateless Architecture
**Sprint 6: Traffic Protection — Stateless Scale-Out & Rate Limiting (LAB-601)**
**Status:** COMPLETED
**Date:** September 8, 2026

---

## 1. Executive Summary & Objective
To withstand massive traffic spikes during high-demand concert ticket drops (e.g. Coldplay, Taylor Swift), Launchpad must scale horizontally by adding stateless backend instances behind a Layer 7 load balancer / reverse proxy.

In **LAB-601**, we proved that:
1. The backend application is **100% stateless**. No correctness invariant or user session depends on which process receives a request.
2. Consecutive requests can alternate arbitrarily between different instances (`inst-1` and `inst-2`) without user-visible inconsistency.
3. Database writes and cache invalidations on one instance are immediately visible to all other instances.
4. An instance can crash or be terminated under active load with **zero dropped requests**, as the load balancer dynamically fails over to surviving instances.

---

## 2. Process-Local State Audit

Before declaring an application horizontally scalable, every variable, data structure, and singleton in the codebase must be audited against the **Statelessness Invariant**:

| Component | State Type | Location | Safe for Scale-Out? | Rationale & Constraint |
|---|---|---|---|---|
| **Inventory Counts** | Authoritative Transactional State | PostgreSQL (`inventory_pools`) | **YES** | Kept out of process memory. Governed by ACID row locks (`SELECT FOR UPDATE`). |
| **Reservations & State Machine** | Authoritative Domain Entities | PostgreSQL (`reservations`) | **YES** | State machine transitions (`PENDING -> CONFIRMED -> EXPIRED`) persist to shared database. |
| **Event Catalog Cache** | Read Optimization | Redis 7 (`events:v1:{id}`) | **YES** | Shared cluster cache. Invalidate-on-write on any instance purges key for all instances. |
| **Request Coalescing (Singleflight)** | Performance Optimization | In-Process Memory (`inFlight` Map) | **YES** | Process-local. Does not hold authoritative truth; only prevents stampedes within each worker. |
| **Correlation IDs** | Request Context | HTTP Header (`X-Correlation-ID`) | **YES** | Stateless middleware; propagates across distributed tracing spans. |
| **Metrics Counters** | Telemetry Buffers | In-Process Memory | **YES** | Process-local metrics. In production, scraped by Prometheus via `/metrics` or aggregated by statsd. |

---

## 3. Scale-Out Readiness Checklist (12-Factor Verification)

- [x] **1. Stateless Processes**: The application stores zero client session data, shopping carts, or transaction state in local memory or local disk.
- [x] **2. Externalized Backing Services**: PostgreSQL and Redis are treated as attached resources reachable via network URLs (`DATABASE_URL`, `REDIS_HOST`).
- [x] **3. Shared Cache Coherence**: Any mutation on instance A (`PATCH /api/events/:id/status`) invalidates the shared Redis key so instance B immediately reads fresh truth.
- [x] **4. Concurrency Safety Across Instances**: Multiple instances competing for the same inventory record are serialized by PostgreSQL row-level locks (`SELECT FOR UPDATE`), guaranteeing 0% oversell across nodes.
- [x] **5. Observability Header**: Every response emits `X-Served-By: {instanceId}` so load balancing distribution and debug traces are transparent.
- [x] **6. Health Checks**: `/health` endpoint reports instance status and uptime for upstream load balancer probes.
- [x] **7. Seamless Failover**: When an instance dies, upstream load balancers route traffic to surviving nodes without 5xx errors.
- [x] **8. Concurrency & Connection Limits**: Database connection pools (`pg.Pool`) are budgeted across instances so $N_{\text{instances}} \times \text{pool\_size} \le \text{PostgreSQL max\_connections}$.

---

## 4. Architectural Review Questions

### Question 1: What state is safe to keep locally?
**Answer: Only immutable configuration, compiled templates, and short-lived request-coalescing buffers.**

1. **Safe to Keep in Local Process Memory**:
   - **Immutable Bootstrapping Configuration**: Environment variables, route definitions, database connection strings, logging formats.
   - **Compiled Code & Schemas**: JIT-compiled templates, parsed JSON schemas, regex patterns.
   - **Singleflight In-Flight Promise Maps**: `RequestCoalescer` in-flight promises are transient (lifespan: milliseconds). If two instances execute parallel DB queries for an unprimed key, correctness is 100% preserved; only database query reduction is localized to each node.
   - **Pre-Aggregated Telemetry Buffers**: High-frequency metric counters (e.g. request counts) held for 5–10 seconds before pushing to Prometheus/Datadog.
2. **STRICTLY FORBIDDEN in Local Process Memory**:
   - User authentication sessions (e.g. in-memory session maps).
   - In-memory inventory pools or ticket reservations (violates atomicity).
   - Local file uploads / temp storage expected by subsequent requests.
   - Mutexes or locks that guard cross-request consistency.

### Question 2: What changes with sticky sessions?
**Answer: Sticky sessions introduce fatal hot-spots, uneven traffic distribution, and fragile deployments.**

1. **What Sticky Sessions Do**:
   - A load balancer binds a client (via IP hash or `Set-Cookie`) to one specific backend instance so all subsequent requests from that user route to the same pod.
2. **Why Sticky Sessions Are Dangerous for High-Demand Drops**:
   - **Flash Sale Hot-Spots**: During a concert ticket on-sale, thousands of users arrive simultaneously. If sticky sessions hash users to pods, one instance can become overloaded (100% CPU) while neighboring instances sit idle.
   - **Broken Failover**: If instance A crashes, all users "stuck" to instance A lose their active session or get dumped abruptly to instance B.
   - **Disrupted Rolling Deployments**: Pods cannot be drained gracefully without breaking user journeys.
3. **The Stateless Recommendation**:
   - **Never use sticky sessions for Launchpad.**
   - All state is externalized to PostgreSQL and Redis. Every request is completely self-contained, allowing the load balancer to distribute traffic using pure Round-Robin or Least-Connections.

---

## 5. Advancement Gate Verification
- [x] **Verification**: Tested in `tests/integration/scale-out-stateless.spec.ts`.
- [x] Requests alternate between `inst-1` and `inst-2` with identical responses.
- [x] Writes on `inst-1` immediately reflect on `inst-2`.
- [x] 50 concurrent reservations across `inst-1` and `inst-2` maintain 0% oversell.
- [x] Killing `inst-1` during 100-request read traffic causes 100% of remaining traffic to fail over to `inst-2` with **0 dropped requests and 100% HTTP 200 responses**.
- [x] **Advancement Gate Satisfied**: No correctness depends on which application instance receives a request.
