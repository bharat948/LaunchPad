# Launchpad Test Strategy & Engineering Architecture

## 1. Executive Summary
A test suite must be an **engineering system** that provides measurable confidence, rapid feedback, and zero flaky tests. In a high-concurrency ticketing platform, bugs live at different architectural boundaries: some are pure domain logic errors, while others are microsecond database race conditions.

This document establishes the **Launchpad Test Pyramid**, naming conventions, fixture standards, and an explicit decision tree for adding new tests.

---

## 2. The Launchpad Test Pyramid

```
                       / \
                      /   \
                     /     \
                    /  C3   \      Layer 3: Concurrency & Race Tests (10%)
                   /---------\     Real PostgreSQL parallel connections (Locks, SKIP LOCKED)
                  /           \
                 /     I2      \   Layer 2: Database & REST Integration Tests (20%)
                /---------------\  Real PostgreSQL (SQL migrations, constraints, Supertest HTTP)
               /                 \
              /        U1         \ Layer 1: Domain Unit Tests (70%)
             /---------------------\ In-memory, 0 I/O, runs in < 50ms (Entities, Value Objects)
```

---

## 3. Test Layers & Execution Commands

| Layer | Path Pattern | Dependencies | Execution Time | Purpose & Scope | Command |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Layer 1: Unit** | `tests/domain/**/*.spec.ts` | Pure in-memory (`Clock`, Domain Entities) | **< 50 ms** | Tests business invariants, state machine transitions, time windows, and mathematical rules without any DB or I/O. | `npm run test:unit` |
| **Layer 2: Integration** | `tests/integration/**/*.spec.ts` | Real PostgreSQL + Express | **~400 ms** | Tests REST HTTP contracts (`Location` headers, status codes, DTO mapping) and SQL migrations/foreign keys. | `npm run test:integration` |
| **Layer 3: Concurrency** | `tests/concurrency/**/*.spec.ts` | Real PostgreSQL parallel pool | **~1-3 sec** | Tests multi-threaded race conditions (100 to 1,000 parallel clients), pessimistic row locks, and `FOR UPDATE SKIP LOCKED`. | `npm run test:concurrency` |
| **Full Pyramid** | All test suites | Everything | **~8-10 sec** | Complete regression run executed in randomized order. | `npm test` |

---

## 4. Randomized Execution Order (Combating State Leakage)

In [`vitest.config.ts`](file:///d:/SystemDesign/launchpad/vitest.config.ts), we enabled:
```typescript
export default defineConfig({
  test: {
    sequence: {
      shuffle: true, // Shuffles test order on every run
    },
  },
});
```

* **Why Randomization is Critical**:
  Tests that inadvertently rely on state left behind by previous tests (e.g. database rows or shared static variables) pass when run in alphabetical order, but fail unpredictably in CI/CD pipelines. Shuffling exposes hidden order-dependencies immediately.

---

## 5. Reusable Fixture Builders

To prevent fragile, repetitive SQL boilerplate across tests, we use the **Fluent Fixture Builder Pattern**:

### `EventFixtureBuilder`
```typescript
const { event, ticketTypeIds } = await EventFixtureBuilder.anEvent()
  .withTitle('Summer Music Fest')
  .withTicketType('General Admission', 5000, 100)
  .inStatus(EventStatus.LIVE)
  .persist(pool);
```

### `ReservationFixtureBuilder`
```typescript
const reservation = await ReservationFixtureBuilder.aReservation()
  .withTicketTypeId(ticketTypeId)
  .withQuantity(2)
  .inStatus(ReservationStatus.PENDING)
  .persist(pool);
```

---

## 6. Review Questions Answered

### Q1: Which tests give false confidence with mocks?
* **Answer**: **Concurrency, row locking, and database constraint tests!**
* **The Danger of Mocking**:
  If you mock `pg.Pool` or repository methods with in-memory mock objects (e.g. `mockRepo.save = vi.fn()`), the mock runs in single-threaded JavaScript memory:
  * A mock **CANNOT** reproduce a `SELECT FOR UPDATE` lock wait.
  * A mock **CANNOT** reproduce a race condition where 100 threads read `available_qty = 1`.
  * A mock **CANNOT** test PostgreSQL `CHECK (available_qty >= 0)` constraints.
  * *Mocking the database gives 100% false confidence that your code is concurrency-safe when it is actually broken.*

### Q2: Which layer should verify SQL constraints?
* **Answer**: **Layer 2 (Database Integration Tests)** against a real PostgreSQL instance.
* *Why*: SQL constraints (like `CHECK (sale_start_at < sale_end_at)` or `FOREIGN KEY REFERENCES events(id) ON DELETE CASCADE`) are enforced by the relational database engine, not the application framework. Integration tests ensure migration DDL statements and database engine rules work harmoniously.

---

## 7. ADVANCEMENT GATE: Defect Decision Matrix

Use this decision matrix when adding a new test:

```
                  What type of defect or feature are you addressing?
                                          │
       ┌──────────────────────────────────┼──────────────────────────────────┐
       ▼                                  ▼                                  ▼
[Domain Rule / State Jump]       [HTTP API / Schema Constraint]     [Race Condition / Contention]
  - Bad date window                - 400 Bad Request envelope         - Oversell bug
  - Negative ticket capacity       - 201 Created Location header      - Pessimistic lock duration
  - Expired hold confirmation      - Foreign key cascade              - Multi-worker SKIP LOCKED
       │                                  │                                  │
       ▼                                  ▼                                  ▼
Add to: Layer 1 (Unit)           Add to: Layer 2 (Integration)      Add to: Layer 3 (Concurrency)
`tests/domain/`                  `tests/integration/`               `tests/concurrency/`
*Pure in-memory, 0 I/O*          *Real PostgreSQL + Express*        *Real Parallel Pool (100+ req)*
```
