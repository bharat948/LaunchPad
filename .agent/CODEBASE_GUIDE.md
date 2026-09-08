# Launchpad: Codebase Understanding & Engineering Agent Guide

> **Target Audience**: AI Coding Assistants, Autonomous Agents, and Senior Engineers onboarding to the Launchpad codebase.
> **Repository Purpose**: High-contention limited-inventory event ticketing and product drop platform engineered for absolute concurrency safety, zero oversell, resilient distributed state evolution, and high-performance scale-out.

---

## 1. System Architecture & Directory Structure

Launchpad is architected as a **Modular Monolith** applying **Hexagonal Architecture (Ports & Adapters)** and **Domain-Driven Design (DDD)**.

```
launchpad/
├── .agent/                             # Agent onboarding, codebase rules, and guide
│   └── CODEBASE_GUIDE.md               # This document
├── docs/                               # Authoritative technical & architectural documentation
│   ├── ENGINEERING_RULES.md            # The 4-part teaching rule & core constraints
│   ├── api/                            # OpenAPI contracts, curl guides, idempotency contracts
│   ├── architecture/                   # ADRs (001-006), LLDs, sequence diagrams, state matrices
│   ├── domain/                         # Glossary, business rules, journey scenarios
│   ├── events/                         # Event catalog, schema evolution policy
│   ├── performance/                    # Capacity notes, read baselines, stampede reports
│   └── sprints/                        # Sprint retrospectives & advancement records
├── migrations/                         # Raw SQL incremental schema migrations (001-005)
├── src/
│   ├── infrastructure/                 # Low-level external systems (DB, Redis, Cache, Limiter, Outbox)
│   │   ├── cache/                      # RedisCacheService, RequestCoalescer (Singleflight)
│   │   ├── consumer/                   # IdempotentConsumer (Inbox), DeadLetterQueue (DLQ Replay)
│   │   ├── db/                         # PostgreSQL connection pool (pg.Pool), migration runner
│   │   ├── idempotency/                # PostgresIdempotencyStore (ACID distributed locks)
│   │   ├── loadbalancer/               # RoundRobinLoadBalancer (L7 stateless proxy)
│   │   ├── outbox/                     # PostgresOutboxRepository, OutboxPublisher
│   │   ├── ratelimit/                  # TokenBucketRateLimiter (atomic distributed Lua script)
│   │   └── resilience/                 # ConcurrencyLimiter (in-flight overload load shedder)
│   ├── middleware/                     # Express middlewares (Correlation, RateLimiting, Idempotency)
│   ├── modules/                        # Bounded contexts / domain modules
│   │   ├── catalog/                    # Event & TicketType definitions, caching, DTOs
│   │   ├── inventory/                  # Atomic reservation, row locks, expiry scanner
│   │   ├── order/                      # Order aggregate, checkout saga, payment workflow
│   │   └── payment/                    # PaymentGateway port, FakePaymentAdapter
│   ├── shared/                         # Cross-cutting primitives
│   │   ├── domain/                     # Clock (System/Test), DomainError hierarchy
│   │   ├── events/                     # Generic DomainEvent envelope, EventSerializer, MessageBroker port
│   │   └── resilience/                 # Client RetryPolicy with Full Jitter Exponential Backoff
│   ├── createApp.ts                    # Stateless Express application factory
│   └── server.ts                       # Server entry point
└── tests/                              # Automated test suites (120+ tests across 31 suites)
    ├── concurrency/                    # Race conditions, fault injections, repeatable barriers
    ├── demo/                           # Architectural layer defect demonstrations & sprint demos
    ├── domain/                         # Pure domain unit tests
    ├── fixtures/                       # Test data builders (EventFixtureBuilder, etc.)
    ├── integration/                    # End-to-end Supertest API integrations
    ├── performance/                    # Latency distribution, baseline, overload experiments
    └── unit/                           # Isolated domain & service unit tests
```

---

## 2. Core Engineering Principles & Consistency Rules

Every contributor (human or AI) must strictly maintain the following patterns:

### A. Pure Domain Layer (Hexagonal Core)
- Domain entities (`Event`, `Reservation`, `Order`, `Money`, `TimeWindow`) live in `src/modules/*/domain/` and `src/shared/domain/`.
- **ZERO External SDK Imports**: The domain layer must never import vendor libraries (`stripe`, `ioredis`, `pg`, `express`).
- **Ports & Adapters**: External dependencies are accessed solely via domain-shaped interfaces (e.g. `PaymentGateway`, `OrderRepository`, `ICacheService`). Infrastructure implementations (`FakePaymentAdapter`, `PostgresEventRepository`) adapt external APIs to these domain ports.

### B. Explicit Error Hierarchy
- **Never throw generic strings or untyped `new Error(...)`** in business logic.
- Extend `DomainError` from [`src/shared/domain/DomainError.ts`](../src/shared/domain/DomainError.ts):
  - `InvalidStateTransitionError`: Thrown on illegal state jumps.
  - `ReservationExpiredError`: Thrown when trying to confirm an expired hold.
  - `PrematureExpirationError`: Thrown if expiry is triggered before `expiresAt`.

### C. Deterministic Time via the `Clock` Abstraction
- **Never call `new Date()` or `Date.now()` directly** in domain entities or use cases.
- Inject the [`Clock`](../src/shared/domain/Clock.ts) interface (`SystemClock` for production, `TestClock` for unit tests).
- In tests, use `clock.advanceByMinutes(10)` or `clock.setNow(...)` to simulate time passage deterministically without sleeping real wall-clock time.

### D. Absolute Zero Oversell Invariant (Concurrency Safety)
- Under high contention (e.g. 1,000 users competing for 10 tickets), inventory reservations must **never oversell**.
- Always use pessimistic row locking and atomic conditional updates:
  ```sql
  SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1 FOR UPDATE;
  UPDATE inventory_pools SET available_qty = available_qty - $1, reserved_qty = reserved_qty + $1 
  WHERE ticket_type_id = $2 AND available_qty >= $1;
  ```

### E. Coherent State Evolution (Saga & State Machines)
- Multi-entity workflows coordinate `ReservationStatus` (`PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELLED`), `OrderStatus` (`CREATED`, `PAYMENT_PENDING`, `CONFIRMED`, `PAYMENT_DECLINED`, `EXPIRED`, `CANCELLED`, `REFUND_REQUIRED`, `COMPENSATION_PENDING`, `CANCELLED_REFUNDED`), and payment outcomes.
- **Recoverable Declines**: Card declines transition order to `PAYMENT_DECLINED` while preserving the reservation in `PENDING` (if not expired) so the buyer can retry.
- **Late Webhook Safety**: Webhook arriving with `SUCCESS` after reservation expiration must transition order to `REFUND_REQUIRED` (and trigger a refund) rather than confirming an oversold seat.
- **Saga Compensations**: Downstream fulfillment failure after payment success executes compensating actions in reverse order (`reservation.cancel()` + `paymentGateway.refund()`).

### F. Idempotency & Retry Safety
- Mutating endpoints accept an `Idempotency-Key` header.
- Cached responses are stored in PostgreSQL with SHA-256 request payload fingerprints.
- Concurrent identical requests receive HTTP 409 (`IDEMPOTENCY_KEY_IN_PROGRESS`). Replays return cached responses with `Idempotent-Replay: true`. Payload mismatches return HTTP 422.
- Retries use **Full Jitter Exponential Backoff**:
  $$t_{\text{sleep}} = \text{random}(0, \min(t_{\text{max}}, t_{\text{base}} \times 2^{\text{attempt}}))$$

### G. Domain Event Contracts (Event-Driven Backbone)
- Standard envelope (`DomainEvent<T>`) using past-tense immutable facts (`order.confirmed`).
- **Event-Carried State Transfer**: Include minimal facts (`orderId`, `userId`, `quantity`, `totalAmountCents`, `customerEmail`) so downstream consumers require **zero queries** to PostgreSQL.
- Support **in-memory schema upcasting** (`EventSerializer.upcast`) so consumers handle multiple schema versions without modifying on-disk broker logs.

### H. Transactional Outbox & Idempotent Consumer (At-Least-Once Delivery & Inbox Deduplication)
- **Eliminate Dual-Writes**: Never write to a database and publish to a message broker in separate uncoordinated steps.
- **Transactional Outbox (`outbox_messages`)**: Insert the event record within the *exact same* PostgreSQL transaction client that commits the domain aggregate state.
- **Restartable Polling Publisher**: Use `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent worker processes sweep unpublished rows without double-processing or lock contention.
- **Idempotent Consumer (`inbox_messages`)**: Consumers track processed `(event_id, consumer_name)`. Any duplicated broker redelivery is recognized and safely short-circuits.
- **Failure Classification & Dead Letter Queue (`dead_letter_messages`)**: Classify errors into transient (retry with exponential backoff) vs. permanent poison pills (immediate quarantine to DLQ to prevent Head-of-Line blocking). Support documented operational replay.

---

## 3. Testing Strategy & Isolation Rules

Launchpad maintains a comprehensive test suite (currently **120 tests across 31 suites**) with 100% green status.

### The Test Pyramid
1. **Unit Tests (`tests/unit/`, `tests/domain/`)**: Hermetic, sub-millisecond tests verifying entities, value objects, token bucket math, retry policies, and event contracts without network I/O.
2. **Integration Tests (`tests/integration/`)**: Supertest + Express against live PostgreSQL and Redis containers, verifying REST contracts, caching, rate limiting, and idempotency.
3. **Concurrency Stress Tests (`tests/concurrency/`)**: 100 to 1,000 concurrent contenders using `AsyncBarrier` latches to prove zero-oversell, transaction rollback on fault injection, and cache stampede coalescing.
4. **Performance Tests (`tests/performance/`)**: Latency percentiles (P50/P95/P99) and overload load-shedding limits.
5. **Sprint Defect Demos (`tests/demo/`)**: Controlled defect simulations intentionally breaking domain rules, API schemas, and concurrency primitives to prove automated guardrails catch them.

### ⚠️ Critical Test Isolation Rules (DO NOT VIOLATE)
When writing or executing tests in Vitest:
1. **Never Flush Redis in Test Hooks**: Do not call `rawRedis.flushdb()` in test setup/teardown. Tests run with `shuffle: true` in parallel; flushing Redis breaks other running suites.
2. **Never Close Shared Singletons in `afterAll`**:
   - Do **NOT** call `await pool.end()` in individual test files (terminates the shared DB pool for other test files).
   - Do **NOT** call `await defaultCacheService.close()` in individual test files.
   - Keep shared singletons open for the process lifecycle.
3. **Isolate Test Metrics with Fresh Instances**:
   When testing cache hit/miss metrics or token bucket quotas, instantiate dedicated isolated instances:
   ```typescript
   const isolatedCache = new RedisCacheService();
   const isolatedCoalescer = new RequestCoalescer();
   const setup = createEventRouter(isolatedCache, isolatedCoalescer);
   ```
4. **Vitest Configuration**:
   Configured in [`vitest.config.ts`](../vitest.config.ts) with `sequence: { shuffle: true }` and `testTimeout: 30000` to support concurrent heavy stress tests.

---

## 4. Local Environment Setup & Running Guide

### Prerequisites
- **Node.js**: `v20+` or `v22+`
- **Docker Desktop**: Running with Linux container engine
- **Docker Compose**: `v2+`

### Port Mappings
| Service | Container Port | Host Port | Container Name | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `5432` | **`5433`** | `launchpad-db-1` | Mapped to 5433 to prevent collision with local Postgres |
| **Redis 7** | `6379` | **`6379`** | `launchpad-redis-1` | Used for cache-aside and distributed rate limiting |

### Setup Commands
```bash
# 1. Clone & copy environment variables
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start PostgreSQL and Redis containers
docker compose up -d

# 4. Verify containers are healthy
docker compose ps

# 5. Run database migrations
npm run db:migrate
```

### Running Tests
```bash
# Run entire test suite (all 26 test suites)
npm test

# Run a specific test file
npx vitest run tests/unit/OrderPaymentWorkflow.spec.ts

# Run tests in watch mode during development
npm run test:watch
```

### Running the Application Server
```bash
# Development mode (live TypeScript reload)
npm run dev

# Production build & start
npm run build
npm start
```

---

## 5. The 4-Part Teaching Rule (Engineering Communication)

Codified in [`docs/ENGINEERING_RULES.md`](../docs/ENGINEERING_RULES.md), every completed ticket and implementation review must be presented with the strict 4-part structure:
1. **WHAT We Did**: Executive summary of components, contracts, and changes built.
2. **HOW We Did It**: Deep technical mechanics, architectural flow, code snippets, and sequence diagrams.
3. **WHY We Did It**: The concrete problem solved (e.g. eliminating race conditions, vendor lock-in, double-charging).
4. **WHY It Is Necessary & Industry Best Practices**: Enterprise production rationale, resilience patterns, and comparison against common anti-patterns.
