# Concurrency Stress Test & Correctness Report

* **Date**: 2026-09-08
* **Component**: `PostgresInventoryRepository`
* **Test Tool**: Vitest + PostgreSQL 16 (Port 5433)
* **Status**: **PASSED (0% Oversell Verified)**

---

## 1. Executive Summary

Following the overselling reproduction in **LAB-201**, **LAB-202** implemented atomic reservation transactions using **Pessimistic Row Locking (`SELECT FOR UPDATE`)** combined with **Atomic Conditional Guard Updates (`WHERE available_qty >= X`)**.

Under 10, 100, and 1,000 concurrent contender stress tests, PostgreSQL reliably serialized inventory allocations. **Zero over-allocation occurred**, and PostgreSQL transaction rollbacks cleanly protected data integrity during simulated failures.

---

## 2. Benchmark Results

| Experiment | Concurrent Requests | Initial Capacity | Successes Granted | Rejections (Sold Out) | Final DB State (`Avail`, `Res`) | Execution Duration | Oversell Count |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Exp 1: Low Contention** | 10 | 1 | **1** | 9 | `Avail=0, Res=1` | ~60 ms | **0** |
| **Exp 2: Medium Contention** | 100 | 1 | **1** | 99 | `Avail=0, Res=1` | ~322 ms | **0** |
| **Exp 3: High Contention** | 1,000 | 50 | **50** | 950 | `Avail=0, Res=50` | ~2,129 ms | **0** |

---

## 3. Rollback & Atomicity Verification

### Injected Fault Test
* **Scenario**: An artificial network exception (`SIMULATED_NETWORK_FAULT_MID_TRANSACTION`) was thrown mid-transaction after modifying `available_qty`.
* **Observed Behavior**: PostgreSQL instantly aborted the transaction and executed a full rollback.
* **Verification**: PostgreSQL state remained `available_qty = 10, reserved_qty = 0`. Zero dirty writes or half-committed reservations occurred.

---

## 4. Review Questions Answered

### Q1: What lock duration exists?
* **Answer**: The exclusive row-level lock is held strictly between `SELECT FOR UPDATE` and `COMMIT` / `ROLLBACK`. For Experiment 3 (1,000 parallel requests), each transaction held the lock for **less than 2 milliseconds**, processing 1,000 requests in 2.12 seconds on a single PostgreSQL core.

### Q2: What is the throughput trade-off?
* **Answer**: Pessimistic row locking guarantees 100% ACID correctness but serializes transactions targeting the exact same row (`ticket_type_id`). Throughput is bounded by row lock acquisition rate (~450-600 serialized reservations/sec per row in this local test environment).

### Q3: What happens under deadlock?
* **Answer**: If two transactions attempt to acquire locks on multiple rows in reverse order, PostgreSQL's deadlock detector interrupts the cycle after `deadlock_timeout` (default 1s) and aborts one transaction with SQLState `40P01` (deadlock detected).

---

## 5. ADVANCEMENT GATE VERIFICATION

> [!SUCCESS]
> **Zero Oversell Verified Across 1,000 Contenders:**
> Across 1,000 parallel reservation attempts racing for 50 tickets, exactly 50 users received confirmed reservations and 950 were cleanly rejected. Database state reached `Available = 0, Reserved = 50`.
