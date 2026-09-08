# Retry Policy Matrix: Safe Retries, Error Classification & Full Jitter Backoff
**Sprint 7: Idempotency and Retry-Safe API Design (LAB-703)**
**Status:** COMPLETED
**Date:** September 8, 2026

---

## 1. Executive Summary & Problem Statement
Blind, uncoordinated client retries are dangerous:
1. **Outage Amplification (Thundering Herd)**: If an overloaded backend starts slowing down, thousands of clients simultaneously retrying multiply traffic by $3\times–5\times$, turning a minor transient hiccup into a catastrophic total blackout.
2. **Duplicate Business Effects**: Retrying non-idempotent write endpoints (`POST`) without an `Idempotency-Key` duplicates orders, reservations, and payment charges.

This document classifies every operation in Launchpad, defines the retry safety contract, and establishes our **Exponential Backoff with Full Jitter** standard.

---

## 2. Operation Safety Classification Matrix

| Operation / Path | HTTP Method | Naturally Idempotent? | Safe to Retry WITHOUT Idempotency-Key? | Safe to Retry WITH Idempotency-Key? | Max Attempts | Base Backoff | Max Backoff |
|---|---|---|---|---|---|---|---|
| **Health Check** (`/health`) | `GET` | **YES** | **YES** | N/A | 5 | 100ms | 1,000ms |
| **Get Event Details** (`/api/events/:id`) | `GET` | **YES** | **YES** | N/A | 3 | 100ms | 2,000ms |
| **Delete Event** (`/api/events/:id`) | `DELETE` | **YES** | **YES** | N/A | 3 | 200ms | 2,000ms |
| **Create Event** (`/api/events`) | `POST` | **NO** | ❌ **STRICTLY UNSAFE** | ✅ **SAFE** | 3 | 200ms | 3,000ms |
| **Create Reservation** (`/api/reservations`) | `POST` | **NO** | ❌ **STRICTLY UNSAFE** | ✅ **SAFE** | 3 | 500ms | 5,000ms |
| **Update Event Status** (`/api/events/:id/status`) | `PATCH` | **PARTIAL** | ⚠️ Conditionally safe (FSM rejects repeat) | ✅ **SAFE** | 3 | 200ms | 2,000ms |

---

## 3. Error Classification: Retryable vs Non-Retryable

| HTTP Status / Error Code | Category | Action | Retry Safety Argument |
|---|---|---|---|
| **400 Bad Request** | Client Error | ❌ **Abort Immediately** | Malformed JSON or invalid syntax will fail again on retry. |
| **401 Unauthorized** | Client Error | ❌ **Abort Immediately** | Missing credentials require user authentication. |
| **403 Forbidden** | Client Error | ❌ **Abort Immediately** | Caller lacks permissions; retry will not grant access. |
| **404 Not Found** | Client Error | ❌ **Abort Immediately** | Requested resource does not exist. |
| **409 Conflict** | Concurrency Conflict | ⚠️ **Retry with Jitter** | In-flight idempotency conflict (`IDEMPOTENCY_KEY_IN_PROGRESS`) resolves once the leader finishes. |
| **422 Unprocessable Entity** | Client Error | ❌ **Abort Immediately** | Domain rule violation or idempotency payload mismatch; retry with same body will fail again. |
| **429 Too Many Requests** | Rate Limited | ✅ **Retry with Backoff** | Respect server `Retry-After` header. |
| **500 Internal Server Error** | Server Error | ✅ **Retry (if Idempotent)** | Transient database glitch or process crash; safe if key present. |
| **502 Bad Gateway** | Proxy Error | ✅ **Retry (if Idempotent)** | Node crashed or restarting; retry reaches surviving node. |
| **503 Service Unavailable** | Overloaded | ✅ **Retry with Jitter** | Backpressure engaged; respect `Retry-After`. |
| **504 Gateway Timeout** | Proxy Timeout | ✅ **Retry (ONLY with Key)** | "Unknown outcome" dilemma; safe only with `Idempotency-Key`. |
| **ECONNRESET / ETIMEDOUT** | Network Error | ✅ **Retry (ONLY with Key)** | Socket drop; safe only with `Idempotency-Key`. |

---

## 4. Backoff Algorithm: Full Jitter Exponential Backoff

To prevent retrying clients from synchronizing into periodic shockwaves, we adopt AWS's **Full Jitter** formula:

$$t_{\text{sleep}} = \text{random}\left(0, \min\left(t_{\text{max}}, t_{\text{base}} \times 2^{\text{attempt}}\right)\right)$$

### Why Full Jitter is Essential:
```
Without Jitter (Fixed Exponential Backoff):
Time 0s: 1,000 clients fail.
Time 1s: ALL 1,000 clients retry simultaneously! (Spike 1)
Time 2s: ALL 1,000 clients retry simultaneously! (Spike 2)
Result: The server never recovers.

With Full Jitter:
Time 0s: 1,000 clients fail.
Clients choose uniform random delays between 0ms and 1000ms.
Result: The 1,000 retries are smoothly smeared across the entire 1-second interval!
```

---

## 5. Architectural Review Questions

### Question 1: When should the caller stop retrying?
**Answer: The caller must stop retrying when any of these 4 conditions occur:**
1. **Non-Retryable 4xx Error Received**: Client validation failures (400, 422), authentication failures (401, 403), or not found (404). Retrying these burns client CPU and server bandwidth with zero chance of success.
2. **Maximum Attempt Bound Reached**: Typically 3 to 5 attempts. If a system is down for 5 consecutive retries with exponential backoff, further retries are futile.
3. **Total Deadline / Timeout Budget Exhausted**: E.g., a checkout journey has a 10-second total deadline. If attempts 1 and 2 consume 8 seconds, attempt 3 must abort if it exceeds the remaining budget.
4. **Permanent Failure Indicated by Server**: Specific error envelopes indicating fatal state (e.g. `EVENT_CANCELLED`, `ACCOUNT_SUSPENDED`).

### Question 2: How can retries create a thundering herd?
**Answer: Uncoordinated retries synchronize on failure boundaries.**
1. When a database transaction takes longer than usual (e.g. 500ms instead of 10ms), upstream API gateways time out at 1,000ms.
2. If 5,000 clients timed out at the 1,000ms mark and use a fixed backoff (e.g. retry after 1,000ms), all 5,000 clients fire their retry at $t = 2,000\text{ms}$.
3. This creates **harmonic constructive interference**—a periodic surge of traffic that knocks over the database repeatedly.
4. **Mitigation**: Full Jitter randomly disperses the retry arrival times across the timeline, completely de-synchronizing the herd.

---

## 6. Advancement Gate Verification
- [x] **Every Network Retry Has a Documented Safety Argument**: Mapped in the Operation Safety Classification Matrix.
- [x] **Idempotent-Only Write Retries**: Enforced via `Idempotency-Key` headers on `POST /api/events` and `POST /api/reservations`.
- [x] **Bounded & Jittered**: Full Jitter implementation mathematically verified in `tests/unit/RetryPolicy.spec.ts`.
