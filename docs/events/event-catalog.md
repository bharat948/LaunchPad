# Launchpad Domain Event Catalog (LAB-901)

## 1. Fundamental Distinction: Events vs. Commands

In Launchpad's architecture, clear boundaries separate imperative **Commands** from reactive **Domain Events**:

| Dimension | Command | Domain Event |
| :--- | :--- | :--- |
| **Intent** | An **instruction** requesting an action to be performed in the future. | A **fact** recording something that has already happened in the past. |
| **Grammar / Tense** | Imperative mood: `ConfirmOrder`, `ReserveTickets`, `ChargePayment`. | Past tense statement: `OrderConfirmed`, `TicketsReserved`, `PaymentFailed`. |
| **Expectation / Sender** | Expects success or rejection; caller waits or handles command validation errors. | Statement of fact; caller has committed change; cannot be rejected or undone by consumer. |
| **Cardinality** | **1-to-1**: Targeted directly at a single handling service/aggregate. | **1-to-Many**: Broadcast asynchronously to zero or more unknown downstream consumers. |
| **Coupling** | High: Sender must know the receiver's interface and error contracts. | Low: Publisher only knows its own schema; consumers subscribe independently. |
| **Side Effects** | Mutates state if validated. | Informs external systems to trigger secondary reactions (emails, metrics). |

---

## 2. Standard CloudEvents-Aligned Envelope

Every event published to Launchpad's message backbone adheres to the standard `DomainEvent<T>` envelope:

```json
{
  "eventId": "c7a8e234-8712-40f3-9821-d7a04910cf91",
  "eventType": "order.confirmed",
  "aggregateId": "ord_918237912",
  "version": 1,
  "occurredAt": "2026-09-08T12:00:00.000Z",
  "producer": "launchpad.order-service",
  "data": {
    "orderId": "ord_918237912",
    "userId": "user_alice_456",
    "reservationId": "res_8172361",
    "ticketTypeId": "tt_vip_001",
    "quantity": 2,
    "totalAmountCents": 15000,
    "currency": "USD",
    "confirmedAt": "2026-09-08T12:00:00.000Z",
    "providerTransactionId": "txn_stripe_38129038"
  },
  "metadata": {
    "correlationId": "corr_91283019",
    "causationId": "cmd_checkout_9912",
    "userId": "user_alice_456"
  }
}
```

---

## 3. Canonical Events Catalog

### Event: `order.confirmed`
- **Topic / Routing Key**: `launchpad.orders.confirmed`
- **Producer**: `launchpad.order-service`
- **Partition Key**: `aggregateId` (`orderId`) — ensures strict per-order FIFO ordering.
- **Downstream Consumers**:
  - `NotificationConsumer`: Generates and emails PDF tickets / SMS confirmation receipts.
  - `AnalyticsConsumer`: Updates real-time sales dashboards, GMV metrics, and conversion rates.
  - `FraudDetectionConsumer`: Evaluates post-checkout buyer behavior models.
- **Schema Payload (v1)**:
  - `orderId` (string, UUID)
  - `userId` (string)
  - `reservationId` (string, UUID)
  - `ticketTypeId` (string, UUID)
  - `quantity` (integer, positive)
  - `totalAmountCents` (integer, non-negative)
  - `currency` (string, ISO 4217, e.g. `USD`)
  - `confirmedAt` (string, ISO-8601)
  - `providerTransactionId` (string)
- **Schema Payload (v2 additions)**:
  - `customerEmail` (string, optional)
  - `ticketTierName` (string, optional)

---

### Event: `reservation.expired`
- **Topic / Routing Key**: `launchpad.inventory.reservations.expired`
- **Producer**: `launchpad.inventory-service` (Expiry Scanner)
- **Partition Key**: `ticketTypeId` — groups capacity updates sequentially.
- **Downstream Consumers**:
  - `InventoryMetricsConsumer`: Tracks drop-off rate and unclaimed seat allocations.
  - `MarketingWaitlistConsumer`: Alerts waitlisted buyers that capacity has become available.

---

### Event: `order.compensated`
- **Topic / Routing Key**: `launchpad.orders.compensated`
- **Producer**: `launchpad.order-service` (Saga Orchestrator)
- **Partition Key**: `orderId`
- **Downstream Consumers**:
  - `CustomerSupportConsumer`: Flags customer incident for follow-up.
  - `FinancialLedgerConsumer`: Records chargeback / refund reconciliation journal entries.
