# OpenAPI / REST API Contract: Event Management

## Overview
This specification documents the REST API endpoints provided by the Catalog module for managing Event and TicketType lifecycles.

---

## Global Headers & Behavior

* **`X-Correlation-ID`**: Every API response includes an `X-Correlation-ID` header. Callers can supply their own UUID in the `X-Correlation-ID` request header to trace requests across systems.
* **Content-Type**: `application/json`

---

## Error Envelope Schema

All non-`2xx` error responses adhere to a uniform JSON error envelope:

```json
{
  "error": {
    "code": "INVALID_TIME_WINDOW",
    "message": "startAt must be strictly before endAt",
    "timestamp": "2026-09-08T12:45:00.000Z",
    "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

### HTTP Status Code Mappings

| HTTP Status Code | Scenario | Error Code Examples |
| :--- | :--- | :--- |
| **`200 OK`** | Resource retrieved or state updated successfully. | N/A |
| **`201 Created`** | Resource created successfully. Includes `Location` header. | N/A |
| **`400 Bad Request`** | Malformed JSON syntax or invalid domain attribute values. | `MALFORMED_JSON`, `VALIDATION_ERROR`, `INVALID_TIME_WINDOW`, `INVALID_CAPACITY` |
| **`404 Not Found`** | Event ID does not exist. | `EVENT_NOT_FOUND` |
| **`409 Conflict`** | Illegal domain state transition or capacity invariant violation. | `EMPTY_TICKET_TYPES_ERROR`, `INVALID_STATE_TRANSITION_ERROR` |

---

## Endpoints

### 1. Create Event
`POST /api/events`

Creates a new Event in `DRAFT` status and configures associated `TicketType`s and `InventoryPool`s.

* **Request Body**:
```json
{
  "organizerId": "org-99",
  "title": "Launchpad Systems Conference 2026",
  "saleStartAt": "2026-10-01T09:00:00.000Z",
  "saleEndAt": "2026-10-01T18:00:00.000Z",
  "ticketTypes": [
    {
      "name": "General Admission",
      "priceCents": 5000,
      "currency": "USD",
      "capacity": 100
    },
    {
      "name": "VIP Pass",
      "priceCents": 15000,
      "currency": "USD",
      "capacity": 20
    }
  ]
}
```

* **Response (`201 Created`)**:
  * Header: `Location: /api/events/3a9856f2-e568-45b0-9844-0b73c242c748`
```json
{
  "id": "3a9856f2-e568-45b0-9844-0b73c242c748",
  "organizerId": "org-99",
  "title": "Launchpad Systems Conference 2026",
  "status": "DRAFT",
  "saleStartAt": "2026-10-01T09:00:00.000Z",
  "saleEndAt": "2026-10-01T18:00:00.000Z",
  "ticketTypes": [
    {
      "id": "c1f7a14e-9d22-4a0b-934d-17e94e77b678",
      "name": "General Admission",
      "priceCents": 5000,
      "currency": "USD",
      "capacity": 100
    },
    {
      "id": "8d3e911a-12bc-4efb-88a9-67290f1190bc",
      "name": "VIP Pass",
      "priceCents": 15000,
      "currency": "USD",
      "capacity": 20
    }
  ]
}
```

---

### 2. Get Event Details
`GET /api/events/:id`

Retrieves single Event record with its current status and ticket categories.

* **Response (`200 OK`)**:
  Same JSON structure as `POST /api/events` response.

---

### 3. Update Event Status
`PATCH /api/events/:id/status`

Applies state machine transitions (`DRAFT` $\rightarrow$ `SCHEDULED` $\rightarrow$ `LIVE` $\rightarrow$ `CANCELLED`). Idempotent when called with the current status.

* **Request Body**:
```json
{
  "status": "LIVE"
}
```

* **Response (`200 OK`)**: Updated Event DTO object.
* **Error Response (`409 Conflict`)**: Returned if attempting an invalid status jump or publishing an event with zero ticket tiers.
