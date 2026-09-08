# ADR-006: Workflow Compensation via the Saga Pattern

## Status
**ACCEPTED** (Sprint 8 / LAB-803)

---

## 1. Context & Problem Statement
During event checkout, a user's purchase evolves through multiple asynchronous, distributed steps:
1. **Inventory Hold**: Hold tickets in `reservations` table (`PENDING -> PAYMENT_PENDING`).
2. **Payment Collection**: Charge buyer's payment method via external Payment Service Provider (Stripe, Adyen).
3. **Ticket Issuance & Entitlement Generation**: Generate secure ticket tokens, barcode payloads, and commit order confirmation.

**The Distributed Failure Problem**:
What happens when Step 2 (payment charge) succeeds, but Step 3 (ticket generation / DB confirmation) crashes due to a constraint violation, database disconnect, or out-of-memory error?
- Money was deducted from the customer's card.
- No tickets were issued.
- Inventory remains locked in a limbo hold.

Because the payment was executed against an external, third-party system across the Internet, a simple SQL `ROLLBACK` cannot undo the financial transaction. We must implement **Compensating Transactions** to deterministically restore system consistency.

---

## 2. Decision: Orchestrated Saga with Retryable Compensations

We reject Two-Phase Commit (2PC) and distributed XA transactions because external payment gateways do not support them, and holding distributed locks across external APIs destroys throughput.

Instead, Launchpad adopts the **Saga Pattern** orchestrated by `OrderPaymentWorkflow`:
- Each forward step has an explicit, idempotent **compensating step** executed in reverse order upon failure.
- When compensation experiences transient failures (e.g. refund endpoint timeout), the workflow records the state (`COMPENSATION_PENDING`) and schedules retryable execution until reaching a terminal state (`CANCELLED_REFUNDED`).

### Forward vs. Compensating Actions Matrix

| Step | Forward Action | Failure Condition | Compensating Action | Idempotency Anchor |
| :--- | :--- | :--- | :--- | :--- |
| **Step 1: Inventory** | Deduct available, add to reserved; create Reservation | Sold out / Event not Live | Cancel Reservation (`res.cancel()`); return capacity to pool | `reservation.id` |
| **Step 2: Payment** | Call `PaymentGateway.charge()` | Card declined / Timeout | Call `PaymentGateway.refund()` | `refund_${order.id}_${attempt}` |
| **Step 3: Fulfillment** | Issue Ticket Entitlements; confirm Order | PDF/Barcode generation failure, DB crash | Void uncommitted tickets; trigger compensation | `order.id` |

---

## 3. Answers to Review Questions

### Review Question 1: Why can’t we just use one DB transaction around external payment?
Wrapping an external HTTP call inside a local PostgreSQL transaction (`BEGIN ... paymentGateway.charge() ... COMMIT`) is an anti-pattern for three critical reasons:
1. **Connection Pool Starvation**: Payment gateways typically have P99 latencies of 1,000ms to 5,000ms. Holding a PostgreSQL connection open and blocking row locks (`SELECT FOR UPDATE`) for seconds quickly exhausts `pg.Pool` connection pools (default 10-20 connections), leading to platform-wide HTTP 503 load-shedding and cascading timeouts.
2. **False Safety (The Unknown Outcome Dilemma)**: If the application crashes or network times out while awaiting the response, PostgreSQL rolls back the local transaction upon connection drop. However, the external payment gateway **already charged the card**! The database state would record no purchase, while the customer's credit card statement reflects an authorized debit.
3. **No Distributed 2PC Support**: External third-party payment gateways (Stripe, Adyen, Razorpay) are RESTful APIs and do not participate in XA/2PC protocols. Local database transactions cannot control remote banking rails.

### Review Question 2: Which compensations are not true reversals?
In a pure mathematical model, a reversal resets the system to the exact pre-transaction state ($S_0 \xrightarrow{f} S_1 \xrightarrow{f^{-1}} S_0$). In real-world commerce, several compensations are **semantic compensations**, not true reversals:
1. **Financial Refunds**: A refund does not "delete" the charge. It generates an entirely new financial transaction with separate fee structures, interchange costs, bank statements line items, and takes 3-5 business days to clear.
2. **Customer Notifications (SMS / Email)**: You cannot un-send a "Your order is processing" email. You can only send a compensating follow-up: "Your order failed to complete; a refund has been issued."
3. **Opportunity Cost on High-Contention Inventory**: If tickets were held for 10 minutes and then refunded, other users who visited the site during those 10 minutes saw "Sold Out" and bounced. That lost sales opportunity cannot be reversed.

---

## 4. Consequences & Trade-offs

### Positive
- **Guaranteed Eventual Consistency**: Orders never remain in an ambiguous "charged-but-unfulfilled" zombie state.
- **Resilience to Transient Errors**: Failed compensations are recorded with audit logs and are safely retryable.
- **Zero Oversell**: Reserved inventory is released back to the general pool upon compensation.

### Negative
- **Temporary Customer Confusion**: The customer sees a charge and subsequent refund on their banking app.
- **State Complexity**: Introduces `COMPENSATION_PENDING` and `CANCELLED_REFUNDED` states that require monitoring and background reconciliation workers.
