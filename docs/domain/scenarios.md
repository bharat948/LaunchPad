# Domain Scenarios & Hand Walkthroughs

This document details the core happy path, 5 explicit failure paths, and 3 step-by-step hand walkthroughs of real-world scenarios in the Launchpad domain.

---

## 1. Happy Path Journey

### Core Flow: Successful High-Demand Reservation & Ticket Issuance
1. **Event Creation**: Organizer creates event "Tech Conference 2026" with 100 General Admission (`GA`) tickets at \$50 each.
2. **Sale Opening**: Organizer updates event status to `LIVE`. `SaleWindow` becomes active.
3. **Reservation Request**: User Alice requests a reservation for 2 `GA` tickets.
4. **Inventory Reservation**: Domain verifies `Available Quantity` $\ge 2$ ($100 \ge 2$), decrements available capacity to 98, increments `Reserved Quantity` to 2, and creates a `Reservation` with status `ACTIVE` and `expiresAt` = $T + 10$ minutes.
5. **Order Checkout**: Alice submits checkout for the reservation. An `Order` is created with status `PENDING_PAYMENT`.
6. **Payment Authorization**: Payment processor approves \$100 charge.
7. **Fulfillment**: Domain receives payment success signal:
   * `Order` status -> `PAID`
   * `Reservation` status -> `FULFILLED`
   * `Reserved Quantity` decrements by 2, `Sold Quantity` increments by 2 ($0 \rightarrow 2$).
   * 2 distinct `Ticket` entitlements issued to Alice.

---

## 2. Five Failure Paths

### Failure Path 1: Sold Out (Insufficient Inventory)
* **Trigger**: User Bob requests 2 tickets for `GA` tier when `Available Quantity` is 1.
* **Domain Behavior**: Domain rejects reservation request with `INSUFFICIENT_INVENTORY`. Available, reserved, and sold quantities remain unchanged. No reservation created.

### Failure Path 2: Reservation Expiry (Payment Timeout)
* **Trigger**: User Charlie creates a reservation for 1 ticket ($T_0$). Charlie fails to pay within 10 minutes ($T_0 + 10$).
* **Domain Behavior**: At $T > T_0 + 10$, reservation status transitions to `EXPIRED`. Reserved quantity decrements by 1, and available quantity increments by 1. Subsequent checkout attempts on this reservation are rejected with `RESERVATION_EXPIRED`.

### Failure Path 3: Payment Declined
* **Trigger**: User Dave attempts checkout on an active reservation, but the payment gateway returns `CARD_DECLINED`.
* **Domain Behavior**: Order status transitions to `PAYMENT_FAILED`. The reservation remains `ACTIVE` until `expiresAt`, allowing Dave to retry payment with a different payment method before time expires.

### Failure Path 4: Event Cancelled by Organizer
* **Trigger**: Organizer cancels the event while users have active reservations and confirmed orders.
* **Domain Behavior**: Event status transitions to `CANCELLED`. Active reservations transition to `CANCELLED` (releasing inventory holds). Confirmed orders transition to `REFUNDED`. Issued tickets transition to `VOIDED`.

### Failure Path 5: Per-User Quota Exceeded
* **Trigger**: User Eve already holds an active reservation for 3 tickets for an event. Eve attempts to reserve 2 additional tickets for the same event (total 5).
* **Domain Behavior**: Domain evaluates `Existing Active Hold Quantity (3) + Requested Quantity (2) = 5 > Max Quota (4)`. Reservation rejected with `USER_QUOTA_EXCEEDED`.

---

## 3. Concrete Hand Walkthrough Scenarios

### Scenario 1: High-Contention Happy Path

**Initial State**:
* `Event`: "Summer Music Fest" (Status: `LIVE`)
* `TicketType`: `VIP`
* Capacity Pool: `Total` = 10, `Available` = 2, `Reserved` = 3, `Sold` = 5.

**Steps**:
| Step | Actor | Action | Domain State Changes |
| :--- | :--- | :--- | :--- |
| **1.1** | User A | Requests reservation for 2 `VIP` tickets | `Available`: $2 \rightarrow 0$, `Reserved`: $3 \rightarrow 5$. Reservation `R-101` created (`ACTIVE`, exp: 12:10). |
| **1.2** | User B | Requests reservation for 1 `VIP` ticket | `Available` = 0. Request REJECTED (`SOLD_OUT`). |
| **1.3** | User A | Submits payment for `R-101` at 12:05 | Payment confirmed. Order `O-501` -> `PAID`. `R-101` -> `FULFILLED`. |
| **1.4** | Domain | Ticket Generation | `Reserved`: $5 \rightarrow 3$, `Sold`: $5 \rightarrow 7$. `Ticket-006`, `Ticket-007` issued. |

---

### Scenario 2: Sold-Out Contention & Expiry Recovery

**Initial State**:
* `Event`: "Tech Keynote" (Status: `LIVE`)
* `TicketType`: `GA`
* Capacity Pool: `Total` = 5, `Available` = 0, `Reserved` = 2 (`R-201` by User A, exp: 12:00), `Sold` = 3.

**Steps**:
| Step | Actor | Action | Domain State Changes |
| :--- | :--- | :--- | :--- |
| **2.1** | User B | Attempts to reserve 1 `GA` ticket at 11:58 | `Available` = 0. Request REJECTED (`SOLD_OUT`). |
| **2.2** | System | Clock reaches 12:00:01 (User A did not pay) | `R-201` status -> `EXPIRED`. Inventory released: `Reserved`: $2 \rightarrow 1$, `Available`: $0 \rightarrow 1$. |
| **2.3** | User B | Retries reservation for 1 `GA` ticket at 12:00:05 | `Available` = 1 $\ge 1$. `Available`: $1 \rightarrow 0$, `Reserved`: $1 \rightarrow 2$. Reservation `R-202` created for User B! |
| **2.4** | User A | Attempts payment for `R-201` at 12:01 | Domain checks `R-201` status (`EXPIRED`). Payment rejected. |

---

### Scenario 3: Event Cancellation & Refund Cascade

**Initial State**:
* `Event`: "Indie Night" (Status: `LIVE`)
* `TicketType`: `Standard`
* Capacity Pool: `Total` = 10, `Available` = 5, `Reserved` = 2 (`R-301` unpaid), `Sold` = 3 (`O-701` paid with `T-1`, `T-2`, `T-3` issued).

**Steps**:
| Step | Actor | Action | Domain State Changes |
| :--- | :--- | :--- | :--- |
| **3.1** | Organizer | Cancels event due to severe weather | Event status -> `CANCELLED`. SaleWindow closed. |
| **3.2** | Domain | Cancel Active Reservations | `R-301` status -> `CANCELLED`. Reserved inventory released. |
| **3.3** | Domain | Invalidate Issued Tickets | `T-1`, `T-2`, `T-3` status -> `VOIDED`. |
| **3.4** | Domain | Process Order Refunds | `O-701` status -> `REFUNDED`. Refund instruction dispatched to payment gateway. |
| **3.5** | User C | Attempts new reservation | Event is `CANCELLED`. Request REJECTED (`EVENT_INACTIVE`). |
