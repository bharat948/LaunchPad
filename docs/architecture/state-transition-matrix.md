# Composite State Transition Matrix (LAB-802 & LAB-803)

## 1. Domain Entities & State Models

In Launchpad's payment workflow, three state machines evolve together:
1. **`Reservation`**: `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELLED`
2. **`Order`**: `CREATED`, `PAYMENT_PENDING`, `CONFIRMED`, `PAYMENT_DECLINED`, `EXPIRED`, `CANCELLED`, `REFUND_REQUIRED`, `COMPENSATION_PENDING`, `CANCELLED_REFUNDED`
3. **`PaymentAttempt`**: `PENDING`, `SUCCESS`, `DECLINED`, `TIMEOUT`, `FAILED`
4. **`CompensationAttempt`**: `PENDING`, `SUCCESS`, `FAILED`

---

## 2. Multi-Entity State Transition Matrix

The table below documents how inbound triggers transition both the **Order** and **Reservation** states:

| Trigger Event | Initial Order State | Initial Reservation State | Guard / Preconditions | Final Order State | Final Reservation State | Side Effects & Actions |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`initiateCheckout()`** | `None` | `PENDING` | `now <= expiresAt` | `PAYMENT_PENDING` | `PAYMENT_PENDING` | Creates Order with amount and items; locks reservation into checkout. |
| **`processPayment()` -> Gateway returns `SUCCESS` & Fulfillment Succeeds** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | `now <= expiresAt` | `CONFIRMED` | `CONFIRMED` | Records transaction ID; issues tickets; marks order confirmed. |
| **`processPayment()` -> Payment `SUCCESS` but Fulfillment Fails** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | Post-payment error (e.g. ticket crash) | `CANCELLED_REFUNDED` (or `COMPENSATION_PENDING`) | `CANCELLED` | **Saga Compensation**: Cancels reservation hold; triggers `paymentGateway.refund()`. |
| **Compensation Refund Fails (PSP error)** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | Refund endpoint timeout / error | `COMPENSATION_PENDING` | `CANCELLED` | Records failure in audit trail; leaves order retryable. |
| **`retryCompensation()` -> Refund Succeeds** | `COMPENSATION_PENDING` | `CANCELLED` | Matching idempotency key | `CANCELLED_REFUNDED` | `CANCELLED` | Terminal consistent state reached; refund ID recorded. |
| **`processPayment()` -> Gateway returns `DECLINED`** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | None | `PAYMENT_DECLINED` | `PENDING` | **Recoverable Decline**: Reservation hold is retained; user can retry payment. |
| **`processPayment()` -> Gateway returns `TIMEOUT`** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | None | `PAYMENT_PENDING` | `PAYMENT_PENDING` | Records timeout attempt; awaits webhook or asynchronous reconciliation. |
| **`retryPayment()`** | `PAYMENT_DECLINED` | `PENDING` | `now <= expiresAt` | `PAYMENT_PENDING` | `PAYMENT_PENDING` | User enters new card; initiates fresh payment attempt. |
| **Duplicate Webhook (`SUCCESS`)** | `CONFIRMED` | `CONFIRMED` | Matching `providerTransactionId` | `CONFIRMED` | `CONFIRMED` | **Idempotent No-Op**: Returns HTTP 200 `DUPLICATE_IGNORED`; no duplicate tickets. |
| **Late Webhook (`SUCCESS`) (Before Expiry)** | `PAYMENT_PENDING` | `PAYMENT_PENDING` | `now <= expiresAt` | `CONFIRMED` | `CONFIRMED` | Successfully reconciles in-flight transaction; confirms order. |
| **Late Webhook (`SUCCESS`) (After Expiry)** | `PAYMENT_PENDING` / `EXPIRED` | `EXPIRED` | `now > expiresAt` (Capacity released to pool) | `REFUND_REQUIRED` | `EXPIRED` | **Advancement Gate**: Prevents oversell! Order is flagged for refund/void. |
| **Webhook (`DECLINED`) after Confirmation** | `CONFIRMED` | `CONFIRMED` | Order already confirmed | `CONFIRMED` | `CONFIRMED` | Ignored as duplicate/stale; alerts fraud/chargeback ops without breaking order. |
| **Background Expiry Scanner** | `PAYMENT_PENDING` / `PAYMENT_DECLINED` | `PENDING` / `PAYMENT_PENDING` | `now > expiresAt` | `EXPIRED` | `EXPIRED` | Releases held capacity back to `available_qty` in `inventory_pools`. |
| **User Manual Cancellation** | `PAYMENT_PENDING` / `PAYMENT_DECLINED` | `PENDING` / `PAYMENT_PENDING` | Order not `CONFIRMED` | `CANCELLED` | `CANCELLED` | Releases held capacity immediately back to pool. |

---

## 3. Invariants Enforced

1. **The Single-Confirmation Invariant**:
   An Order and its underlying Reservation can transition to `CONFIRMED` **exactly once**. Any subsequent provider callbacks, network retries, or manual retries are recognized as duplicates and produce zero state mutation.

2. **The Recoverable Decline Invariant**:
   A payment card decline (e.g., card limit, typo in CVV, insufficient funds) does **not** forfeit the user's reserved tickets. The reservation reverts to `PENDING` so the user can complete payment with an alternative method before `expiresAt`.

3. **The Non-Contradictory State Invariant (Anti-Oversell Gate)**:
   Under no circumstances can an Order transition to `CONFIRMED` if its Reservation has transitioned to `EXPIRED` and returned tickets to the pool. When an upstream provider eventually charges a buyer after local expiration, the workflow forces the order into `REFUND_REQUIRED`.

4. **The Saga Compensation Invariant (Zero-Money-Lost Gate)**:
   If money is collected from a user but downstream fulfillment crashes, the system deterministically executes compensating actions: freeing inventory back to the pool and refunding the charge. If refunding fails, state transitions to `COMPENSATION_PENDING` with retryability guaranteed until reaching `CANCELLED_REFUNDED`.
