# Scheduler Design Note: Idempotent Inventory Reclamation

## 1. Overview
In a limited-inventory drop platform, buyers hold reservations for 10 minutes while completing checkout. Unpaid reservations must release their reserved capacity back to the available inventory pool automatically.

This note documents the architectural trade-offs between background polling schedulers, delayed message queues, and distributed lock coordination.

---

## 2. Comparison of Expiration Architectures

| Architecture Pattern | How It Works | Strengths | Weaknesses / Risks | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **1. Periodic DB Polling with `SKIP LOCKED`** | Background worker polls PostgreSQL every 1-5 seconds:<br>`SELECT ... WHERE status = 'PENDING' AND expires_at < NOW() FOR UPDATE SKIP LOCKED` | Zero external dependencies. Transactional atomicity in PostgreSQL. Multi-instance safe. | Slight reclamation lag equal to poll interval ($\le 1-2\text{s}$). | **SELECTED** |
| **2. Redis Key Expiration (Pub/Sub Keyspace Events)** | Reservation sets Redis TTL key. On expiry, Redis publishes an event consumed by a worker. | Near-real-time expiration. | Redis keyspace events are **not guaranteed delivery** (at-most-once fire-and-forget). If worker is restarting, events are lost forever. | **REJECTED for core financial inventory** |
| **3. Delayed Message Queue (RabbitMQ / SQS / Kafka Delay)** | Application pushes a delayed message scheduled for $T + 10\text{min}$. | Event-driven. | Requires external queue infrastructure. Duplicate messages can arrive if queue retries, requiring idempotency guards anyway. | **DEFERRED to future scale** |

---

## 3. Multi-Instance Scheduler Coordination: The `SKIP LOCKED` Pattern

In production, multiple replicas of the backend container run concurrently for high availability. If both instances run a naive cron query simultaneously:
* **Naive `SELECT FOR UPDATE`**: Worker 2 blocks waiting for Worker 1 to finish, causing lock wait timeouts and serialized delays.
* **With `FOR UPDATE SKIP LOCKED`**: PostgreSQL automatically skips rows locked by Worker 1 and immediately hands the next available batch of rows to Worker 2.

```mermaid
sequenceDiagram
    autonumber
    actor Scheduler_1 as Worker Instance 1
    actor Scheduler_2 as Worker Instance 2
    participant DB as PostgreSQL Database

    Note over Scheduler_1, Scheduler_2: Both workers trigger at second :00
    Scheduler_1->>DB: SELECT id FROM reservations WHERE status = 'PENDING' AND expires_at < NOW() LIMIT 50 FOR UPDATE SKIP LOCKED
    Note over DB: Locks Rows 1 to 50 for Worker 1
    DB-->>Scheduler_1: Returns Rows 1 to 50

    Scheduler_2->>DB: SELECT id FROM reservations WHERE status = 'PENDING' AND expires_at < NOW() LIMIT 50 FOR UPDATE SKIP LOCKED
    Note over DB: Worker 2 SKIPS Rows 1 to 50 without blocking!<br>Locks Rows 51 to 100 for Worker 2
    DB-->>Scheduler_2: Returns Rows 51 to 100

    Scheduler_1->>DB: UPDATE reservations (1..50) -> EXPIRED; Restore Inventory; COMMIT;
    Scheduler_2->>DB: UPDATE reservations (51..100) -> EXPIRED; Restore Inventory; COMMIT;
    Note over DB: Perfect parallel throughput with zero deadlocks and zero duplicate processing!
```

---

## 4. Idempotency Guarantees

The expiration job is strictly idempotent:
$$\text{Reclaim}(\text{Reservation}) \times N = \text{Reclaim}(\text{Reservation}) \times 1$$

1. **State Predicate Guard**:
   ```sql
   UPDATE reservations 
   SET status = 'EXPIRED', updated_at = NOW() 
   WHERE id = ANY($1::uuid[]) AND status = 'PENDING'
   ```
   If a crash occurs mid-job and the worker retries, any reservations already marked `EXPIRED` match `0` rows on the second run.
2. **Re-run Safety**: As proven in `tests/concurrency/reservation-expiry.spec.ts`, calling the service 3 times in a row results in **zero double-increments** to `available_qty`.
