# Explicit Domain Rules & Invariants

This document outlines the core business invariants, state transitions, and validation rules governing the Launchpad domain engine.

---

## 1. Explicit Domain Rules (Minimum 10 Invariants)

### Rule 1: Capacity Invariant (No Overbooking)
* **Statement**: For any given `TicketType`, the sum of `Available Quantity`, `Reserved Quantity`, and `Sold Quantity` MUST always equal `Total Capacity`.
  $$\text{Total Capacity} = \text{Available Quantity} + \text{Reserved Quantity} + \text{Sold Quantity}$$
* **Constraint**: $\text{Available Quantity} \ge 0$, $\text{Reserved Quantity} \ge 0$, $\text{Sold Quantity} \ge 0$.

### Rule 2: Event Life-Cycle Gating
* **Statement**: Reservations MUST only be accepted if the `Event` status is currently `LIVE` and the current timestamp falls strictly within `SaleWindow` ($\text{startAt} \le T_{\text{current}} \le \text{endAt}$).
* **Invalid Transitions**: Cannot reserve tickets for events in `DRAFT`, `SCHEDULED`, `ENDED`, or `CANCELLED` status.

### Rule 3: Event Activation Prerequisites
* **Statement**: An `Event` cannot transition from `DRAFT` to `SCHEDULED` or `LIVE` unless it has at least one configured `TicketType` with $\text{Total Capacity} > 0$ and a valid `SaleWindow`.

### Rule 4: Reservation Expiration Boundary
* **Statement**: A `Reservation` MUST specify an explicit `expiresAt` timestamp set at creation ($T_{\text{creation}} + \text{Hold Duration}$, e.g. 10 minutes).
* **Automated Transition**: Once $T_{\text{current}} > \text{expiresAt}$, an unpaid reservation transitions to `EXPIRED`.

### Rule 5: Automatic Inventory Reclamation
* **Statement**: When a `Reservation` transitions to `EXPIRED` or `CANCELLED`, its held quantity MUST immediately be decremented from `Reserved Quantity` and added back to `Available Quantity`.

### Rule 6: Order-Reservation Coupling
* **Statement**: An `Order` can ONLY be created against active, non-expired `Reservation`s belonging to the same purchasing user.
* **Invariant**: The total price of the `Order` MUST lock the price recorded on the `Reservation` at the time of reservation creation.

### Rule 7: Strict Ticket Fulfillment Condition
* **Statement**: `Ticket` entities MUST ONLY be generated and issued when an `Order` transitions to `PAID` status following successful full payment before reservation expiration.
* **Transition**: Holds transition from `Reserved Quantity` to `Sold Quantity`.

### Rule 8: User Contention Limit
* **Statement**: A single user account MUST NOT hold active reservations exceeding the per-user quota (hard threshold: 4 tickets per user per event).

### Rule 9: Event Cancellation Cascade
* **Statement**: Transitioning an `Event` to `CANCELLED` instantly:
  1. Closes all active sale windows.
  2. Cancels all pending `Reservation`s (reclaiming reserved capacity).
  3. Transitions all pending `Order`s to `CANCELLED`.
  4. Triggers refund flows for all confirmed `Order`s and voids their corresponding `Ticket` entitlements (`Ticket` status -> `VOIDED`).

### Rule 10: Order Immutability
* **Statement**: Once an `Order` reaches a terminal state (`PAID`, `EXPIRED`, `CANCELLED`, or `REFUNDED`), its monetary totals, item breakdown, and owner ID CANNOT be modified.

---

## 2. Review Questions & Architectural Boundaries

### Question A: Which rules belong to the Pure Domain vs. the API Layer?

| Rule Description | Classification | Rationale |
| :--- | :--- | :--- |
| **Inventory Non-Negativity & Capacity Invariant** | **Domain Rule** | Core business safety; must hold regardless of delivery protocol (HTTP, gRPC, CLI). |
| **Reservation Expiry & Auto-Release** | **Domain Rule** | Governs entity lifecycle and commercial holds. |
| **HTTP Request Payload Validation (e.g. Email format, JSON syntax)** | **API Rule** | Transport concerns; domain expects well-formed value objects (`EmailAddress`, `UserId`). |
| **Rate Limiting (e.g. 10 requests/sec per IP)** | **API Rule** | Infrastructure defense against DDoS / brute force; not business domain logic. |
| **Authentication & OAuth JWT Token Parsing** | **API Layer / Gateway** | Identity verification; domain accepts validated `UserId` actor references. |
| **User Max 4 Tickets per Event** | **Domain Rule** | Fair access commercial domain restriction. |

### Question B: Which terms are currently overloaded in system discussions?

1. **"Ticket"**: People say "I bought a ticket" when referring to a row in the database, a QR code, an event tier, or a reservation hold.
   * *Resolution*: Separate `TicketType` (product definition), `Reservation` (temporary hold), `Order` (financial transaction), and `Ticket` (issued token/entitlement).
2. **"Event"**: People say "the event is live" meaning either the concert has started or ticket sales are open.
   * *Resolution*: Distinguish physical `EventTime` from `SaleWindow`.
