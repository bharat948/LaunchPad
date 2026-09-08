# Operations Runbook: Dead Letter Queue (DLQ) & Message Replay

> **Ticket**: LAB-1004 — Retry and DLQ policy  
> **Concept**: Error classification, bounded retries with backoff, poison message quarantine, operational replay

---

## 1. Purpose & Principles

In an asynchronous event-driven system, message processing failures fall into two distinct categories:
1. **Transient Errors**: Network timeouts, database deadlocks, temporary rate limits, or short-lived downstream outages. These recover automatically through **bounded exponential backoff retries**.
2. **Permanent Poison Messages**: Corrupted payloads, schema incompatibilities, missing mandatory fields, or violated business invariants. Retrying these will **never succeed** and will block the consumer queue (Head-of-Line Blocking).

The Dead Letter Queue (DLQ) ensures that:
- Poison messages are **quarantined immediately** into the `dead_letter_messages` table.
- Healthy messages on the topic continue processing with **zero downtime or delay**.
- Engineers have full visibility and can replay messages once the root cause is resolved.

---

## 2. Failure Classification & Retry Matrix

| Failure Type | Example Exception | Action | Backoff Policy |
| :--- | :--- | :--- | :--- |
| **Transient** | `ConnectionTimeoutError`, `40P01 (deadlock)`, `429 Too Many Requests` | Retry with exponential backoff | $20\text{ms} \times 2^{\text{attempt}-1}$ (Max 3 attempts) |
| **Exhausted Transient** | 3 consecutive timeouts | Divert to DLQ | Status: `DEAD` |
| **Permanent Poison** | `PermanentPoisonError`, Schema validation error, unparseable JSON | **Immediate DLQ diversion (Zero retries)** | Status: `DEAD` |

---

## 3. Operational Triage & Replay Procedure

When messages accumulate in the DLQ:

### Step 1: Inspect Dead Letter Records
```sql
SELECT id, event_id, consumer_name, error_message, attempts, failed_at
FROM dead_letter_messages
WHERE status = 'DEAD'
ORDER BY failed_at DESC;
```

### Step 2: Inspect Payload & Root Cause
```sql
SELECT payload, error_stack FROM dead_letter_messages WHERE id = '<DEAD_LETTER_ID>';
```
- If the bug is code-related (e.g. consumer assumed a field was non-null that arrived undefined), deploy a code fix before attempting replay.
- If the bug was downstream infrastructure unavailability (e.g. third-party API outage that has since recovered), the message is ready for replay.

### Step 3: Trigger Replay
Using the consumer's replay API:
```typescript
const result = await consumer.replay(deadLetterId, async (event) => {
  await ticketIssuer.issue(event.data);
});
// Updates status to 'REPLAYED' and records replayed_at timestamp
```

---

## 4. Review Questions & Answers

### Q1: Who is allowed to replay?
- In production, replaying dead-letter messages must be restricted to **Site Reliability Engineers (SREs), Platform Admins, or automated reconciliation jobs**.
- Blindly bulk-replaying thousands of messages without fixing the root cause can trigger cascading failures or re-saturate downstream services.

### Q2: How do you avoid replaying a message whose side effect partly happened?
- **Atomic Transactions (LAB-1003)**: If the side effect was a database update, the entire side effect committed or rolled back as an atomic unit together with the inbox row.
- **Idempotent Consumers**: Because the consumer employs the **Inbox Pattern** (`inbox_messages`), any replayed event that already successfully executed part of its process will be detected and short-circuited safely without duplicate business effects.
