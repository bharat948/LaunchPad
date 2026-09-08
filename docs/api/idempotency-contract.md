# Launchpad Idempotency API Contract & Client Integration Guide
**Sprint 7: Idempotency and Retry-Safe API Design**
**Status:** ACTIVE
**Date:** September 8, 2026

---

## 1. Overview
To protect against duplicate order creation and redundant inventory deductions during network timeouts, Launchpad supports the **`Idempotency-Key` HTTP Request Header** on all mutating operations (`POST`, `PUT`, `PATCH`).

---

## 2. Request Header Specification

| Header Name | Type | Constraint | Description |
|---|---|---|---|
| `Idempotency-Key` | String | Max 255 chars, ASCII UUID or random string | Unique client-generated token identifying the specific business intent. Recommended format: UUID v4 (e.g. `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d`). |

---

## 3. Server Behavior Matrix

### Scenario A: Initial Successful Request
- **Request**:
  ```http
  POST /api/events HTTP/1.1
  Idempotency-Key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
  Content-Type: application/json

  { "title": "Coldplay 2026", "organizerId": "org-1", "saleStartAt": "...", "saleEndAt": "..." }
  ```
- **Response**:
  ```http
  HTTP/1.1 201 Created
  Content-Type: application/json

  { "id": "evt-777", "title": "Coldplay 2026", "status": "DRAFT" }
  ```

### Scenario B: Identical Retry (Safe Replay)
- **Request**: Exactly identical header and body.
- **Response**:
  ```http
  HTTP/1.1 201 Created
  Idempotent-Replay: true
  Content-Type: application/json

  { "id": "evt-777", "title": "Coldplay 2026", "status": "DRAFT" }
  ```

### Scenario C: Key Reused with Different Payload (Payload Mismatch)
- **Request**: Reuses `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d` but with `"title": "Different Title"`.
- **Response**:
  ```http
  HTTP/1.1 422 Unprocessable Entity
  Content-Type: application/json

  {
    "error": {
      "code": "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
      "message": "Idempotency-Key was previously used with a different request payload."
    }
  }
  ```

### Scenario D: Concurrent Request in Flight (Lock Contention)
- **Response**:
  ```http
  HTTP/1.1 409 Conflict
  Content-Type: application/json

  {
    "error": {
      "code": "IDEMPOTENCY_KEY_IN_PROGRESS",
      "message": "A request with this idempotency key is currently in progress. Please retry shortly."
    }
  }
  ```
