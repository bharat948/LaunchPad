# Reservation State Machine Diagram

## 1. State Diagram

```mermaid
stateDiagram-v2
    [*] --> PENDING: create(ticketTypeId, qty, clock, ttl=10m)

    state PENDING {
        [*] --> ActiveHold
        ActiveHold: Hold on InventoryPool capacity
        ActiveHold: expiresAt = now + 10m
    }

    PENDING --> CONFIRMED: confirm(clock) [clock.now <= expiresAt]
    PENDING --> EXPIRED: expire(clock) [clock.now > expiresAt]
    PENDING --> CANCELLED: cancel()

    state CONFIRMED {
        [*] --> TicketIssued
        TicketIssued: Terminal State
        TicketIssued: Entitlement created for buyer
    }

    state EXPIRED {
        [*] --> CapacityReleased
        CapacityReleased: Terminal State
        CapacityReleased: Capacity returned to Available
    }

    state CANCELLED {
        [*] --> UserRevoked
        UserRevoked: Terminal State
        UserRevoked: Hold released
    }

    CONFIRMED --> [*]
    EXPIRED --> [*]
    CANCELLED --> [*]
```

---

## 2. Transition Matrix Table

| Current State | Target State | Trigger Operation | Preconditions / Guard Rules | Postconditions / Side Effects |
| :--- | :--- | :--- | :--- | :--- |
| **`[*]` (None)** | **`PENDING`** | `Reservation.create()` | `qty > 0`, `ticketTypeId` valid | Reservation created with `expiresAt = now + 10m`. |
| **`PENDING`** | **`CONFIRMED`** | `res.confirm(clock)` | `clock.now() <= expiresAt` | Order confirmed; Ticket entitlement issued. |
| **`PENDING`** | **`EXPIRED`** | `res.expire(clock)` | `clock.now() > expiresAt` | Reservation marked expired; Capacity returned to `available_qty`. |
| **`PENDING`** | **`CANCELLED`** | `res.cancel()` | None | Reservation cancelled; Capacity returned to `available_qty`. |
| **`CONFIRMED`** | Any | Any | **FORBIDDEN** | Throws `InvalidStateTransitionError`. |
| **`EXPIRED`** | Any | Any | **FORBIDDEN** | Throws `InvalidStateTransitionError`. |
| **`CANCELLED`** | Any | Any | **FORBIDDEN** | Throws `InvalidStateTransitionError`. |
