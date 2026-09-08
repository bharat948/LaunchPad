# Sprint 10 Retrospective: Transactional Outbox, Idempotent Consumers & Dead Letters

## Sprint Summary
- **Sprint Objective**: Make database-to-broker publication and consumer processing resilient to crashes, network partitions, and poison messages without distributed transactions.
- **Backlog Completed**:
  - `LAB-1001`: Reproduced Dual-Write Failure modes (post-commit crash missing event, pre-commit failure ghost event).
  - `LAB-1002`: Implemented Transactional Outbox (`outbox_messages` table, atomic DB writes, restartable `OutboxPublisher` with `SKIP LOCKED`).
  - `LAB-1003`: Implemented Idempotent Consumer (`inbox_messages` deduplication, atomic side-effect execution).
  - `LAB-1004`: Implemented Retry & DLQ Policy (transient vs permanent classification, backoff, `dead_letter_messages`, operational replay).
  - `Sprint Demo`: Broker down recovery and poison message DLQ isolation/replay.

---

## Retrospective Questions

### 1. What does "eventual" mean quantitatively in your prototype?
In our prototype architecture:
- **Immediate Path (p50 < 15ms)**: The client request commits the domain entity and writes the event to the `outbox_messages` table in the same ACID transaction. The HTTP response completes immediately.
- **Publisher Polling Interval (100ms - 1000ms)**: The background `OutboxPublisher` sweeps pending rows. Under normal operational conditions, the end-to-end latency from database commit to broker publication is **bounded by the polling interval + network latency**:
  $$t_{\text{delivery}} \approx \text{pollInterval} + t_{\text{broker\_ack}} \approx 50\text{ms} \text{ to } 500\text{ms}$$
- **Under Broker Outage**: "Eventual" means as soon as the message broker recovers. Outbox records remain durable in PostgreSQL indefinitely until published.

### 2. Where are duplicates still possible?
Duplicates can occur at three specific boundaries in the delivery lifecycle:
1. **Publisher-to-Broker Boundary**: If `broker.publish()` succeeds, but the application crashes or times out before executing `outboxRepo.markPublished(id)`, the restarted publisher will re-send the message.
2. **Broker-to-Consumer Boundary**: If the consumer finishes processing but crashes or experiences a network partition before acknowledging (ACK) the message to the broker, the broker will redeliver the message to another consumer instance.
3. **Operational Replay Boundary**: An engineer manually replaying a dead-letter message after a fix.

**How we protect against these duplicates**:
- The **Idempotent Consumer Inbox Pattern (`inbox_messages`)** inspects `(event_id, consumer_name)`. Any duplicated delivery is recognized as a duplicate and discarded before side effects can execute twice.

### 3. What We Explicitly Avoided (DO NOT ADD YET)
- **Exactly-Once Claims**: We recognize that exactly-once delivery at the network layer is mathematically impossible across distributed boundaries (FLP theorem / Two Generals' Problem). We deliver **at-least-once transport + idempotent consumer deduplication = effectively-once processing**.
- **Silent Event Deletion**: Failed messages are never silently dropped or deleted. They are preserved in `dead_letter_messages` with complete payload, error stack, and attempt count for audit and replay.
