# Launchpad 🚀

Launchpad is an enterprise-grade backend platform engineered for **limited-inventory event drops, flash sales, and high-contention ticket reservations**.

When a high-demand drop occurs, thousands of concurrent users and automated bots compete for scarce inventory within sub-second windows. Launchpad guarantees **absolute zero oversell**, resilient state progression across distributed failure domains, cache stampede immunity, distributed rate limiting, idempotent retry safety, and graceful saga compensation for multi-step payment workflows.

---

## 🎯 Key Architectural Capabilities

- **Zero-Oversell Concurrency Engine**: Atomic pessimistic row locking (`SELECT ... FOR UPDATE`) and database-enforced invariants prevent race conditions and inventory corruption even under 1,000+ parallel requests.
- **Cache-Aside & Stampede Protection**: Redis-backed event caching paired with in-process **Request Coalescing (Singleflight Pattern)** and jittered TTLs eliminate thundering herd spikes against the database.
- **Horizontal Stateless Scale-Out**: Zero process-local correctness state. Application instances can scale out dynamically behind an L7 round-robin load balancer.
- **Distributed Atomic Rate Limiter**: High-throughput Token Bucket rate limiting implemented via atomic Redis Lua scripts with RFC-compliant HTTP `429 Too Many Requests` and `Retry-After` guidance.
- **Overload Protection & Load Shedding**: In-flight concurrency limiters protect scarce CPU and database connections during sustained overload, returning fast, predictable HTTP 503 load-shedding responses.
- **Idempotency & Retry-Safe API Design**: ACID transaction-backed idempotency store supporting client-supplied `Idempotency-Key` headers, SHA-256 request payload fingerprinting, cached response replays (`Idempotent-Replay: true`), and Full Jitter Exponential Backoff retries.
- **Ports & Adapters (Hexagonal Architecture)**: Clean separation of domain logic from vendor SDKs via domain ports (`PaymentGateway`) and interchangeable adapters (`FakePaymentAdapter`) with configurable fault injection (latency, card declines, network timeouts).
- **Resilient Workflow State Orchestration**: Decoupled `ReservationStatus` and `OrderStatus` finite state machines capable of handling out-of-order webhooks, duplicate callbacks, and reconciling late payment confirmations.
- **Saga Compensating Transactions**: Distributed multi-step workflows execute compensating actions in reverse order (`reservation.cancel()` + `paymentGateway.refund()`) when downstream fulfillment fails after payment capture.
- **Event-Driven Backbone & Schema Evolution**: Immutable domain events (`DomainEvent<T>`) employing **Event-Carried State Transfer** and schema version upcasters to decouple downstream consumers (notifications, analytics) without querying primary databases.

---

## 📚 Documentation & Architecture Map

| Category | Document | Description |
| :--- | :--- | :--- |
| **Agent / Contributor Guide** | [`.agent/CODEBASE_GUIDE.md`](.agent/CODEBASE_GUIDE.md) | Comprehensive engineering guide, patterns, test isolation rules, and conventions |
| **Engineering Rules** | [`docs/ENGINEERING_RULES.md`](docs/ENGINEERING_RULES.md) | The mandatory 4-Part Teaching Rule and technical constraints |
| **Architecture Baselines** | [ADR-001: Modular Monolith](docs/architecture/adr-001-modular-monolith.md) | Initial modular monolith architecture design |
| | [ADR-002: Inventory Concurrency](docs/architecture/adr-002-inventory-concurrency.md) | Concurrency control & row-level locking strategy |
| | [ADR-003: Event Caching](docs/architecture/adr-003-event-cache.md) | Cache-aside and invalidation patterns |
| | [ADR-004: Rate Limiting](docs/architecture/adr-004-rate-limiting.md) | Distributed token bucket rate limiting strategy |
| | [ADR-005: Idempotency](docs/architecture/adr-005-idempotency.md) | Distributed idempotency keys & retry safety |
| | [ADR-006: Workflow Compensation](docs/architecture/adr-006-workflow-compensation.md) | Saga orchestrations and compensating transactions |
| | [ADR-008: Transactional Outbox](docs/architecture/adr-008-transactional-outbox.md) | Outbox pattern, at-least-once delivery & restartable publisher |
| **Domain Modeling** | [`docs/domain/glossary.md`](docs/domain/glossary.md) | Ubiquitous domain language and definitions |
| | [`docs/domain/rules.md`](docs/domain/rules.md) | Invariants, constraints, and business rules |
| | [`docs/domain/scenarios.md`](docs/domain/scenarios.md) | End-to-end user journeys and state lifecycles |
| **Sequence & State Diagrams**| [`docs/architecture/dual-write-failure-sequence.md`](docs/architecture/dual-write-failure-sequence.md) | Dual-write atomicity breakdown & failure modes |
| | [`docs/architecture/payment-workflow-sequence.md`](docs/architecture/payment-workflow-sequence.md) | Payment orchestration and callback reconciliation |
| | [`docs/architecture/saga-diagram.md`](docs/architecture/saga-diagram.md) | Forward transactions vs. backward compensating actions |
| | [`docs/architecture/state-transition-matrix.md`](docs/architecture/state-transition-matrix.md) | Complete matrix of valid and invalid state transitions |
| **Event Contracts & Consumer**| [`docs/events/event-catalog.md`](docs/events/event-catalog.md) | Domain event definitions, payloads, and topics |
| | [`docs/events/schema-evolution-policy.md`](docs/events/schema-evolution-policy.md) | Backward/forward compatibility rules and in-memory upcasters |
| | [`docs/architecture/consumer-idempotency-note.md`](docs/architecture/consumer-idempotency-note.md) | Inbox deduplication & atomic side-effect boundaries |
| | [`docs/architecture/dlq-runbook.md`](docs/architecture/dlq-runbook.md) | Dead Letter Queue operations, triage, and replay runbook |
| **Performance & Reports** | [`docs/performance/cache-stampede-report.md`](docs/performance/cache-stampede-report.md) | Request coalescing benchmarks under synchronized expiry |
| | [`docs/performance/capacity-observation-note.md`](docs/performance/capacity-observation-note.md) | Load saturation and load shedding observations |
| | [`docs/performance/read-baseline-report.md`](docs/performance/read-baseline-report.md) | Latency percentiles (P50/P95/P99) under warm cache |

---

## 🏗️ Sprint Progression Roadmap

- ✅ **Sprint 1: Architecture Baseline & Catalog Foundation** (`LAB-101`–`LAB-104`): Domain model, value objects (`Money`, `TimeWindow`), REST APIs, and DB migrations.
- ✅ **Sprint 2: Concurrency & Inventory Protection** (`LAB-201`–`LAB-204`): Reproduced overselling bug, implemented atomic row-level locks, transactional boundaries, and high-concurrency benchmarks.
- ✅ **Sprint 3: Reservation Lifecycle & Expiry Scanner** (`LAB-301`–`LAB-303`): Reservation state machine, background sweeper with transactional release, and deterministic clock testing.
- ✅ **Sprint 4: Database Optimization & Read Scaling** (`LAB-401`–`LAB-404`): Compound B-tree indexing, query plan analysis (`EXPLAIN ANALYZE`), Redis cache-aside, and event-driven cache invalidation.
- ✅ **Sprint 5: Cache Stampede Mitigation** (`LAB-501`–`LAB-504`): Benchmarked synchronized key expiry, implemented Request Coalescing (Singleflight) and TTL jitter, eliminating DB spikes.
- ✅ **Sprint 6: Traffic Protection & Stateless Scale-Out** (`LAB-601`–`LAB-603`): Multi-instance stateless scale-out, L7 round-robin load balancing, atomic Redis token bucket rate limiting, and in-flight load shedding.
- ✅ **Sprint 7: Idempotency & Retry-Safe API Design** (`LAB-701`–`LAB-703`): ACID PostgreSQL idempotency store, SHA-256 fingerprinting, replay response headers, and Full Jitter Exponential Backoff retries.
- ✅ **Sprint 8: Payments, Adapters & Workflow Compensation** (`LAB-801`–`LAB-803`): Hexagonal payment port, `FakePaymentAdapter`, `PAYMENT_PENDING` states, late-webhook reconciliation, and Saga compensating transactions (`RefundRequest`).
- ✅ **Sprint 9: Event-Driven Backbone & Async Consumers** (`LAB-901`): Domain event envelope, Event-Carried State Transfer contracts, and schema evolution upcasting.
- ✅ **Sprint 10: Transactional Outbox, Idempotent Consumers & Dead Letters** (`LAB-1001`–`LAB-1004`): Dual-write defect reproduction, transactional outbox pattern, inbox deduplication, poison message isolation into DLQ, and operational replay.

---

## 🛠️ Prerequisites & Infrastructure

Before setting up the project, ensure the following are installed:

- **Node.js**: `v20+` or `v22+`
- **npm**: `v10+`
- **Docker Desktop**: Running with Linux container engine
- **Docker Compose**: `v2+`

### Container Port Mappings

| Service | Container Port | Host Port | Container Name | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `5432` | **`5433`** | `launchpad-db-1` | Primary transactional store (`app_dev`) |
| **Redis 7** | `6379` | **`6379`** | `launchpad-redis-1` | Cache-aside store & distributed rate limiter |

> **Port Safety**: PostgreSQL is mapped to host port **`5433`** to prevent collisions with existing native PostgreSQL instances running on port `5432`.

---

## 🚀 Quick Start Setup

### 1. Environment Configuration

```bash
# Windows PowerShell
Copy-Item .env.example .env

# Bash / Linux / macOS
cp .env.example .env
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Database & Redis Services

```bash
docker compose up -d
docker compose ps
```

### 4. Run Schema Migrations

Apply raw incremental SQL migrations (`migrations/001-*.sql` to `005-*.sql`):

```bash
npm run db:migrate
```

---

## 🧪 Testing Strategy & Execution

Launchpad maintains a comprehensive, automated test suite (**120 tests across 31 suites**) with 100% pass rates.

### Running Tests

```bash
# Run the entire test suite
npm test

# Run a specific test suite
npx vitest run tests/unit/TransactionalOutbox.spec.ts

# Run tests in watch mode
npm run test:watch
```

### Test Isolation Guardrails
When authoring or executing tests:
1. **Never Flush Redis in Test Hooks**: Do not call `rawRedis.flushdb()` in test hooks; Vitest executes suites concurrently with `shuffle: true`.
2. **Never Close Shared Singletons in `afterAll`**: Do not invoke `await pool.end()` or `await defaultCacheService.close()` in individual test files.
3. **Use Dedicated Instances for Metric Testing**: Instantiate isolated `new RedisCacheService()` or `new RequestCoalescer()` objects when verifying cache hit/miss counts.

---

## 🖥️ Running the Application Server

### Development Mode (TypeScript live execution)
```bash
npm run dev
```
Server listens at `http://localhost:3000`.

### Production Build & Start
```bash
npm run build
npm start
```

---

## 📡 REST API & Example Requests

### 1. Health Check
```bash
curl -i GET http://localhost:3000/health
```

### 2. Create Event (`POST /api/events`)
```bash
curl -i -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: setup-test-001" \
  -d '{
    "organizerId": "org-101",
    "title": "Launchpad Drop 2026",
    "saleStartAt": "2026-11-01T10:00:00.000Z",
    "saleEndAt": "2026-11-01T20:00:00.000Z",
    "ticketTypes": [
      {
        "name": "General Admission",
        "priceCents": 4900,
        "currency": "USD",
        "capacity": 500
      },
      {
        "name": "VIP Pass",
        "priceCents": 19900,
        "currency": "USD",
        "capacity": 50
      }
    ]
  }'
```

### 3. Fetch Event Details (`GET /api/events/:id`)
```bash
curl -i GET http://localhost:3000/api/events/<EVENT_ID>
```

### 4. Reserve Tickets with Idempotency (`POST /api/reservations`)
```bash
curl -i -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: idemp-req-uuid-001" \
  -d '{
    "ticketTypeId": "<TICKET_TYPE_ID>",
    "userId": "usr-1234",
    "quantity": 2
  }'
```

---

## 🧹 Teardown & Environment Reset

```bash
# Stop containers
docker compose down

# Stop containers and wipe PostgreSQL/Redis volumes for a clean slate
docker compose down -v
docker compose up -d
npm run db:migrate
```

