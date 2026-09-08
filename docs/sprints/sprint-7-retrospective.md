# Sprint 7 Retrospective & Demo Report
**Theme: Idempotency and Retry-Safe API Design**
**Date:** September 8, 2026
**Status:** ALL ADVANCEMENT GATES SATISFIED

---

## 1. Sprint Objective & Completion Checklist
The goal of Sprint 7 was to design and implement an end-to-end retry-safe architecture so that network timeouts and client retries never cause duplicate business effects or double inventory deductions.

- [x] **LAB-701: Reproduce Duplicate Order Creation**: Demonstrated the "Unknown Outcome Problem" where a post-commit timeout caused duplicate events in PostgreSQL; mapped the failure in `retry-failure-sequence.md`.
- [x] **LAB-702: Implement Idempotency Key Workflow**: Created PostgreSQL-backed `idempotency_keys` table, SHA-256 fingerprinting, replay response headers (`Idempotent-Replay: true`), payload mismatch rejection (422), and concurrent race protection (409) in `adr-005-idempotency.md`.
- [x] **LAB-703: Classify Retries**: Authored `retry-policy-matrix.md`, built `RetryPolicy` engine with **Full Jitter Exponential Backoff**, and categorized retryable (429, 503, timeouts) vs non-retryable errors (400, 401, 404, 422).

---

## 2. Sprint Demo: Live Verification

### Demo 1: The Duplicate Defect (Without Idempotency Key)
```
1. Client POST /api/events (Payload: "Retry Defect Concert 2026")
   -> Server commits: Event UUID evt-111 generated.
2. Simulated Network Drop / Client Timeout.
3. Client retries POST /api/events (Same Payload, No Key)
   -> Server commits: Event UUID evt-222 generated.
🔥 DEFECT: 2 separate events created in PostgreSQL for 1 user action!
```

### Demo 2: Safe Replay & Deduplication (With Idempotency Key)
```
1. Client POST /api/events [Idempotency-Key: test-key-replay-1]
   -> Server acquires lock in PostgreSQL, commits, saves response.
   -> Returns HTTP 201 Created (evt-999).
2. Simulated Network Drop / Timeout.
3. Client retries POST /api/events [Idempotency-Key: test-key-replay-1]
   -> Server detects key test-key-replay-1 in COMPLETED state.
   -> Returns HTTP 201 Created (evt-999) with Header: Idempotent-Replay: true.
✅ ZERO DUPLICATES: Exactly 1 row in PostgreSQL!
```

### Demo 3: Payload Mismatch Protection
```
1. Client sends POST /api/events [Idempotency-Key: key-mismatch-1, Title: "Original"]
   -> Committed with HTTP 201.
2. Client sends POST /api/events [Idempotency-Key: key-mismatch-1, Title: "TAMPERED"]
   -> Server detects SHA-256 hash mismatch!
   -> Returns HTTP 422 Unprocessable Entity (IDEMPOTENCY_KEY_PAYLOAD_MISMATCH).
```

### Demo 4: Concurrent Retry Storm
```
10 identical requests with Idempotency-Key: key-storm-1 fired simultaneously.
-> Exactly 1 request acquires lock and commits.
-> Remaining requests receive cached 201 replay or 409 conflict.
-> Exactly 1 event created in PostgreSQL!
```

---

## 3. Retrospective

### Question 1: Where does idempotency belong: edge, service, or DB?
**Answer: Hybrid: Coarse deduplication can live at the Edge, but authoritative idempotency MUST live at the Service/DB boundary.**

1. **Edge (API Gateway / Cloudflare)**:
   - Can cache responses for `Idempotency-Key` to save backend bandwidth on repeat hits.
   - *Limitation*: If the edge caches a response before the database transaction actually commits, or if edge and backend become out of sync, stale replays occur. Edge cannot coordinate with database rollback semantics.
2. **Service / Application Layer**:
   - Computes request body SHA-256 fingerprints.
   - Intercepts requests and enforces conflict states (409, 422).
3. **Database Layer (The Ultimate Source of Truth)**:
   - The unique constraint `PRIMARY KEY (key)` on `idempotency_keys` in PostgreSQL provides **mathematically unbreakable ACID deduplication**.
   - If an edge layer claims a request was deduplicated, but the database allows a duplicate insert, the system has failed.
   - **Verdict**: Enforce at the Service level, anchor authoritatively in PostgreSQL.

### Question 2: Which keys could become a storage burden?
1. **High-Frequency Read / Search Endpoints**:
   - If developers carelessly attach `Idempotency-Key` to read endpoints (`GET /events`), millions of search queries would flood the idempotency table.
   - *Rule*: Only mutating command operations (`POST`, `PATCH`, `PUT`) should accept idempotency keys.
2. **Abandoned In-Progress Keys**:
   - Crashed requests that never completed leave `IN_PROGRESS` rows.
   - *Rule*: Enforce `locked_until` timestamps (e.g. 30s) so abandoned locks expire and can be reclaimed.
3. **High-Volume Polling Clients**:
   - Bots sending thousands of unique keys per minute would generate gigabytes of index bloat.
   - *Rule*: Enforce a strict **24-hour retention window** with scheduled deletion.

---

## 4. Architectural Boundaries Respected (DO NOT ADD YET)
- [x] **NO False "Exactly-Once" Claims**: Acknowledged that networks are fundamentally at-least-once; idempotency simulates exactly-once semantics by deduplicating at the receiver.
- [x] **NO Distributed 2PC Transactions**: Maintained single-database ACID transaction boundaries.
