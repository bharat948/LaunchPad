# Executable Curl Collection: Launchpad Event API

## Base URL
`http://localhost:3000`

---

## 1. Create Event (`POST /api/events`)

```bash
curl -i -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: test-create-001" \
  -d '{
    "organizerId": "org-101",
    "title": "High Contention Tech Summit",
    "saleStartAt": "2026-11-01T10:00:00.000Z",
    "saleEndAt": "2026-11-01T20:00:00.000Z",
    "ticketTypes": [
      {
        "name": "General Admission",
        "priceCents": 4900,
        "currency": "USD",
        "capacity": 500
      },
      {
        "name": "VIP Keynote",
        "priceCents": 19900,
        "currency": "USD",
        "capacity": 50
      }
    ]
  }'
```

---

## 2. Get Event Details (`GET /api/events/:id`)

```bash
curl -i -X GET http://localhost:3000/api/events/<EVENT_ID> \
  -H "X-Correlation-ID: test-get-001"
```

---

## 3. Transition Event to SCHEDULED (`PATCH /api/events/:id/status`)

```bash
curl -i -X PATCH http://localhost:3000/api/events/<EVENT_ID>/status \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: test-patch-001" \
  -d '{
    "status": "SCHEDULED"
  }'
```

---

## 4. Publish Event to LIVE (`PATCH /api/events/:id/status`)

```bash
curl -i -X PATCH http://localhost:3000/api/events/<EVENT_ID>/status \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: test-patch-002" \
  -d '{
    "status": "LIVE"
  }'
```

---

## 5. Malformed JSON Test (`400 Bad Request`)

```bash
curl -i -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{ "title": "Broken JSON", '
```

---

## 6. Invalid Domain Time Window Test (`400 Bad Request`)

```bash
curl -i -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "organizerId": "org-101",
    "title": "Invalid Window",
    "saleStartAt": "2026-11-01T20:00:00.000Z",
    "saleEndAt": "2026-11-01T10:00:00.000Z"
  }'
```

---

## 7. Non-Existent Event ID (`404 Not Found`)

```bash
curl -i -X GET http://localhost:3000/api/events/00000000-0000-0000-0000-000000000000
```
