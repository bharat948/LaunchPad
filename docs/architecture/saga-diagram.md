# Saga Workflow Compensation Diagram (LAB-803)

## 1. The Post-Payment Failure Problem

When ticket generation or database confirmation crashes after the customer's card has already been charged:

```mermaid
sequenceDiagram
    autonumber
    actor Buyer
    participant Orchestrator as OrderPaymentWorkflow
    participant Res as Reservation (Inventory)
    participant PSP as PaymentGateway (Stripe/Adyen)
    participant TicketService as TicketIssuanceService

    Note over Buyer, TicketService: Forward Actions
    Buyer->>Orchestrator: initiateCheckout()
    Orchestrator->>Res: Hold Inventory [PENDING -> PAYMENT_PENDING]
    Buyer->>Orchestrator: processPayment()
    Orchestrator->>PSP: charge(amount, cardToken)
    PSP-->>Orchestrator: HTTP 200 OK (txn_charged_999)
    Note over Orchestrator: Money collected from Buyer's bank!

    Orchestrator->>TicketService: issueTickets(order)
    TicketService--xOrchestrator: Crash! Error: TICKET_DB_DEADLOCK / DISK_FULL
    Note over Orchestrator: CRITICAL FAILURE: Money charged, but tickets cannot be issued!
```

---

## 2. Saga Compensating Action Flow

The Orchestrator coordinates compensating transactions in reverse order:

```mermaid
sequenceDiagram
    autonumber
    participant Orchestrator as OrderPaymentWorkflow
    participant Res as Reservation (Inventory)
    participant PSP as PaymentGateway (Stripe/Adyen)
    participant OrderRepo as OrderRepository

    Note over Orchestrator: Saga Compensation Triggered
    Orchestrator->>Res: cancel() [PAYMENT_PENDING -> CANCELLED]
    Note over Res: Inventory capacity released back to available pool

    Orchestrator->>PSP: refund(txn_charged_999, refundIdempKey)
    alt Refund Succeeded
        PSP-->>Orchestrator: HTTP 200 OK (ref_fake_888)
        Orchestrator->>OrderRepo: order.markCompensated(ref_fake_888) [CANCELLED_REFUNDED]
        Note over Orchestrator: Terminal Consistency Reached: Money Refunded, Inventory Freed
    else Refund Failed / Timed Out
        PSP--xOrchestrator: Network Timeout / 503 Service Unavailable
        Orchestrator->>OrderRepo: order.markCompensationPending(reason) [COMPENSATION_PENDING]
        Note over Orchestrator: Retryable State: Captured in audit log for background reconciliation
    end
```

---

## 3. Retryable Compensation Loop

When the refund fails on the initial attempt, the workflow does not panic or lose track of money:

```mermaid
flowchart TD
    Start([Post-Payment Failure]) --> CancelRes[Cancel Reservation & Release Hold]
    CancelRes --> AttemptRefund[Attempt Gateway Refund #1]
    
    AttemptRefund -->|Fails / Timeout| CompPending[Order State: COMPENSATION_PENDING]
    CompPending --> LogAttempt[Log CompensationAttempt to Order Audit Trail]
    LogAttempt --> AwaitRetry[Background Reconciler / Retry Trigger]
    
    AwaitRetry --> RetryComp[retryCompensation()]
    RetryComp --> AttemptRefund2[Attempt Gateway Refund #2 with same Idempotency Key]
    
    AttemptRefund2 -->|Fails| CompPending
    AttemptRefund2 -->|Succeeds| CancelledRefunded[Order State: CANCELLED_REFUNDED]
    AttemptRefund -->|Succeeds| CancelledRefunded
    
    CancelledRefunded --> Terminal([Terminal Consistent State: Zero Customer Loss])
```
