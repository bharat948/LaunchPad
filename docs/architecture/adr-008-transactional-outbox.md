# ADR-008: Transactional Outbox Pattern for Resilient Event Publishing

## Status
**Accepted**

## Context
In an event-driven modular architecture, confirming an order, updating inventory, or completing a payment must trigger downstream asynchronous processes (e.g., ticket generation, notification dispatch, analytics ingestion). 

Directly publishing events to an external message broker (Kafka, RabbitMQ, Redis) after committing a database transaction creates the **Dual-Write Problem**:
1. If the application server crashes or loses network connectivity immediately after the database commit, the event is permanently lost, leaving downstream systems out of sync.
2. If the application publishes before the database commit, a transaction rollback produces a **ghost event**, causing consumers to fulfill uncommitted orders.
3. Two-Phase Commit (2PC / XA) protocols across relational databases and modern message brokers are slow, fragile, and largely unsupported.

## Decision
We implement the **Transactional Outbox Pattern**:
1. **Shared ACID Boundary**: When an aggregate state change occurs, the corresponding domain event (`DomainEvent<T>`) is serialized and inserted into an `outbox_messages` table **within the exact same local database transaction** as the aggregate update.
2. **Outbox Schema**:
   - `id`: Unique UUID identifier.
   - `event_id`: Unique UUID representing the domain event identity.
   - `event_type`: Domain-qualified event name (e.g., `order.confirmed`).
   - `aggregate_id`: Aggregate root ID (e.g., `orderId`).
   - `payload`: Canonical JSON serialized event payload.
   - `status`: `'PENDING'`, `'PUBLISHED'`, or `'FAILED'`.
   - `retry_count`: Incremented upon transient broker failure.
3. **Outbox Publisher Worker**:
   - A dedicated, restartable `OutboxPublisher` polls unpublished messages using `SELECT ... FOR UPDATE SKIP LOCKED` to allow multiple concurrent publisher workers without lock contention or duplicate reads.
   - Upon successful broker acknowledgement, the publisher marks the record as `PUBLISHED`.
   - If the broker times out or is temporarily unreachable, the publisher increments `retry_count` and retries during subsequent sweeps.

## Consequences & Tradeoffs

### Positive:
- **Zero Event Loss Guarantee**: If an order is committed in PostgreSQL, its corresponding event is guaranteed to exist in the database outbox. Eventual publication is guaranteed even through arbitrary server crashes.
- **Transactional Consistency**: If the database transaction rolls back, the outbox record rolls back with it—completely eliminating ghost events.
- **Transport Agnostic**: The outbox table acts as a reliable buffer. The broker can be down for minutes or hours without blocking the user-facing checkout API.

### Tradeoffs & Mitigations:
1. **At-Least-Once Delivery**: If the publisher publishes to the broker but crashes before updating the outbox row to `PUBLISHED`, the recovered publisher will re-publish the event.
   - *Mitigation*: Downstream consumers must be **Idempotent Consumers** (LAB-1003).
2. **Polling Overhead vs Change Data Capture (CDC)**:
   - Polling adds a small query overhead on the database.
   - *Alternative Considered*: Debezium / CDC tailing PostgreSQL WAL (Write-Ahead Log).
   - *Decision*: Polling outbox with `FOR UPDATE SKIP LOCKED` is simple, dependency-free, and sufficient for current drop scale, while CDC introduces external Kafka Connect operational complexity. CDC can be adopted in future sprints without changing application transaction semantics.
