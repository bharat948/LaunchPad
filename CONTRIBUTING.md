# Contributing to Launchpad 🚀

Thank you for your interest in contributing to **Launchpad**!

Launchpad is an enterprise-grade backend platform built for **high-contention flash sales and limited-inventory drops**. It is designed with uncompromising distributed systems rigor, absolute zero-oversell guarantees, hexagonal modular boundaries, and comprehensive concurrency testing.

To maintain this standard of engineering excellence, please read this guide before contributing.

---

## 🧭 Table of Contents
1. [Core Architectural Philosophy](#core-architectural-philosophy)
2. [Prerequisites & Local Environment](#prerequisites--local-environment)
3. [Quickstart Setup](#quickstart-setup)
4. [Git & Branching Workflow](#git--branching-workflow)
5. [Coding Standards & Conventions](#coding-standards--conventions)
6. [Testing Strategy & Critical Isolation Rules](#testing-strategy--critical-isolation-rules)
7. [Submitting a Pull Request](#submitting-a-pull-request)

---

## 🏛️ Core Architectural Philosophy

Contributors (human or AI) must uphold the following patterns:

1. **Hexagonal Architecture (Ports & Adapters)**:
   - **Pure Domain Core**: The domain entities (`Event`, `Reservation`, `Order`, `Money`) must **never import external libraries** (`pg`, `ioredis`, `express`, `stripe`).
   - External dependencies (database, cache, payment gateways, message brokers) are accessed solely via domain-shaped port interfaces (e.g. `PaymentGateway`, `MessageBroker`, `IOutboxRepository`).
2. **Deterministic Time**:
   - Never call `new Date()` or `Date.now()` directly in domain logic. Always inject the [`Clock`](src/shared/domain/Clock.ts) interface (`SystemClock` for production, `TestClock` for deterministic tests).
3. **Explicit Error Hierarchy**:
   - Never throw untyped strings or generic `new Error()`. Extend [`DomainError`](src/shared/domain/DomainError.ts) (e.g., `InvalidStateTransitionError`, `ReservationExpiredError`).
4. **Absolute Zero Oversell**:
   - Inventory reservation must use pessimistic row locks (`SELECT ... FOR UPDATE`) and database-enforced atomic conditional updates.

For a full reference, review [`.agent/CODEBASE_GUIDE.md`](.agent/CODEBASE_GUIDE.md).

---

## 🛠️ Prerequisites & Local Environment

Ensure you have installed:
- **Node.js**: `v20+` or `v22+` (`node -v`)
- **npm**: `v10+` (`npm -v`)
- **Docker Desktop & Docker Compose**: `v2+` (`docker compose version`)

### Port Allocation
| Service | Container Port | Host Port | Purpose |
| :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `5432` | **`5433`** | Primary transactional database (`app_dev`) |
| **Redis 7** | `6379` | **`6379`** | Cache-aside & distributed rate limiting |

> **Note**: Host port `5433` is deliberately configured to prevent port collision with any native PostgreSQL instance running on host port `5432`.

---

## 🚀 Quickstart Setup

```bash
# 1. Clone repository
git clone https://github.com/your-org/launchpad.git
cd launchpad

# 2. Copy environment configuration
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Start local infrastructure
docker compose up -d

# 5. Run database migrations
npm run db:migrate

# 6. Run the complete test suite (120+ tests)
npm test

# 7. Start application in development mode
npm run dev
```

---

## 🌿 Git & Branching Workflow

### 1. Branch Naming
- Features: `feature/<ticket-id>-<short-description>` (e.g., `feature/LAB-1005-kafka-adapter`)
- Bug fixes: `fix/<ticket-id>-<short-description>` (e.g., `fix/LAB-1006-token-bucket-leak`)
- Documentation: `docs/<description>` (e.g., `docs/update-saga-diagram`)

### 2. Conventional Commits
All commit messages must adhere to [Conventional Commits](https://www.conventionalcommits.org/):
```
feat(order): implement order confirmed outbox event
fix(cache): resolve singleflight race on concurrent expiry
test(concurrency): add 1000 contender stress test barrier
docs(architecture): add ADR-009 event streaming architecture
refactor(inventory): extract row lock query to repository
```

---

## 🧪 Testing Strategy & Critical Isolation Rules

All code contributions must be backed by automated tests. Tests run in Vitest with `sequence: { shuffle: true }` across parallel worker threads.

### ⚠️ Critical Isolation Rules (DO NOT VIOLATE)
1. **Never Flush Redis in Test Hooks**: Do NOT call `rawRedis.flushdb()` in test hooks (`beforeEach`/`afterAll`). Doing so breaks other test suites executing concurrently.
2. **Never Close Shared Singletons in `afterAll`**:
   - Do **NOT** call `await pool.end()` in individual test files.
   - Do **NOT** call `await defaultCacheService.close()` in individual test files.
   - Shared singletons must remain open for the process lifecycle.
3. **Isolate Test Metrics with Fresh Instances**:
   When asserting on cache hit/miss metrics or token bucket quotas, instantiate dedicated isolated instances:
   ```typescript
   const isolatedCache = new RedisCacheService();
   const isolatedCoalescer = new RequestCoalescer();
   ```
4. **Deterministic Time Advancement**:
   Use `TestClock.advanceByMinutes(N)` instead of `setTimeout` or `sleep`.

### Test Commands
```bash
# Run all tests
npm test

# Run isolated suites
npm run test:unit
npm run test:integration
npm run test:concurrency

# Run in watch mode during development
npm run test:watch
```

---

## 📋 Submitting a Pull Request

Before submitting a PR, ensure:
1. All database migrations execute cleanly on a fresh database:
   ```bash
   docker compose down -v && docker compose up -d && npm run db:migrate
   ```
2. The entire test suite passes 100% green:
   ```bash
   npm test
   ```
3. TypeScript compiles with zero errors:
   ```bash
   npm run build
   ```
4. New architectural decisions or state machines are documented with an ADR in `docs/architecture/`.
5. PR description follows the **4-Part Engineering Rule** ([`docs/ENGINEERING_RULES.md`](docs/ENGINEERING_RULES.md)):
   - **WHAT** Was Done
   - **HOW** It Was Implemented
   - **WHY** It Was Necessary
   - **Industry Best Practices & Tradeoffs**
