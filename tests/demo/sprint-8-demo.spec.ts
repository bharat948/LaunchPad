import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { TestClock } from '../../src/shared/domain/Clock.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { Reservation } from '../../src/modules/inventory/domain/Reservation.js';
import { ReservationStatus } from '../../src/modules/inventory/domain/ReservationStatus.js';
import { FakePaymentAdapter } from '../../src/modules/payment/infrastructure/FakePaymentAdapter.js';
import {
  OrderPaymentWorkflow,
  InMemoryReservationRepository,
} from '../../src/modules/order/application/OrderPaymentWorkflow.js';
import { InMemoryOrderRepository } from '../../src/modules/order/domain/OrderRepository.js';
import { OrderStatus } from '../../src/modules/order/domain/OrderStatus.js';

describe('Sprint 8 Demo: Payments, Adapters and Workflow Compensation', () => {
  let clock: TestClock;
  let orderRepo: InMemoryOrderRepository;
  let reservationRepo: InMemoryReservationRepository;
  let paymentAdapter: FakePaymentAdapter;
  let workflow: OrderPaymentWorkflow;

  const initialTime = new Date('2026-09-08T12:00:00.000Z');
  const ticketTypeId = randomUUID();
  const userId = 'user-demo-sprint-8';

  beforeEach(() => {
    clock = new TestClock(initialTime);
    orderRepo = new InMemoryOrderRepository();
    reservationRepo = new InMemoryReservationRepository();
    paymentAdapter = new FakePaymentAdapter('SUCCESS');
    workflow = new OrderPaymentWorkflow(orderRepo, reservationRepo, paymentAdapter, clock);
  });

  function createReservation(ttlMinutes = 10): Reservation {
    const res = Reservation.create(randomUUID(), userId, ticketTypeId, 2, clock, ttlMinutes);
    reservationRepo.save(res);
    return res;
  }

  it('Demo 1 (Success Scenario): Complete end-to-end checkout with instant confirmation', async () => {
    console.log('\n[Demo 1] Running Happy Path Success Scenario...');
    const reservation = createReservation(10);
    const order = await workflow.initiateCheckout({
      reservationId: reservation.id,
      totalAmount: new Money(15000, 'USD'),
    });

    const result = await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_mastercard',
      idempotencyKey: 'demo-key-success',
    });

    console.log(`  -> Payment Result : ${result.status} (Txn: ${result.transactionId})`);
    console.log(`  -> Order Status   : ${(await orderRepo.findById(order.id))?.status}`);
    console.log(`  -> Res Status     : ${(await reservationRepo.findById(reservation.id))?.status}`);

    expect(result.success).toBe(true);
    expect(result.status).toBe(OrderStatus.CONFIRMED);
  });

  it('Demo 2 (Decline Scenario): Card declined leaves reservation open for recoverable retry', async () => {
    console.log('\n[Demo 2] Running Recoverable Decline Scenario...');
    const reservation = createReservation(10);
    const order = await workflow.initiateCheckout({
      reservationId: reservation.id,
      totalAmount: new Money(6000, 'USD'),
    });

    // Simulate card decline
    paymentAdapter.simulateDecline('card_limit_exceeded', 'Credit card limit exceeded');
    const declineResult = await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_declined',
      idempotencyKey: 'demo-key-decline',
    });

    console.log(`  -> Attempt 1 Result: ${declineResult.status} (Recoverable: ${declineResult.recoverable})`);
    const resAfterDecline = await reservationRepo.findById(reservation.id);
    console.log(`  -> Reservation State: ${resAfterDecline?.status} (Hold preserved!)`);
    expect(resAfterDecline?.status).toBe(ReservationStatus.PENDING);

    // Immediate retry with alternative card
    paymentAdapter.simulateSuccess();
    const retryResult = await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_valid',
      idempotencyKey: 'demo-key-retry',
    });

    console.log(`  -> Attempt 2 Result: ${retryResult.status} (Txn: ${retryResult.transactionId})`);
    expect(retryResult.status).toBe(OrderStatus.CONFIRMED);
  });

  it('Demo 3 (Timeout Scenario): Gateway timeout leaves order in PAYMENT_PENDING awaiting reconciliation', async () => {
    console.log('\n[Demo 3] Running Ambiguous Timeout Scenario...');
    const reservation = createReservation(10);
    const order = await workflow.initiateCheckout({
      reservationId: reservation.id,
      totalAmount: new Money(4500, 'USD'),
    });

    paymentAdapter.simulateTimeout();
    const timeoutResult = await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_hung',
      idempotencyKey: 'demo-key-timeout',
    });

    console.log(`  -> Timeout Result   : ${timeoutResult.status} (Timeout: ${timeoutResult.timeout})`);
    console.log(`  -> Message          : ${timeoutResult.message}`);
    expect(timeoutResult.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(timeoutResult.timeout).toBe(true);
  });

  it('Demo 4 (Late-Success Reconciliation): Asynchronous webhook arriving after expiration initiates refund', async () => {
    console.log('\n[Demo 4] Running Late-Success After Expiration Scenario...');
    const reservation = createReservation(10);
    const order = await workflow.initiateCheckout({
      reservationId: reservation.id,
      totalAmount: new Money(8500, 'USD'),
    });

    paymentAdapter.simulateTimeout();
    await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_hung',
      idempotencyKey: 'demo-key-late',
    });

    // Advance 12 minutes (past 10 min hold); scanner expires reservation
    clock.advanceByMinutes(12);
    reservation.expire(clock);
    await reservationRepo.save(reservation);

    console.log(`  -> Time advanced 12m. Reservation Status: ${reservation.status}`);

    // Late provider webhook arrives with SUCCESS
    const lateWebhook = await workflow.handlePaymentWebhook({
      eventId: 'evt_demo_late_webhook',
      orderId: order.id,
      providerTransactionId: 'txn_late_captured',
      status: 'SUCCESS',
    });

    console.log(`  -> Webhook Outcome : ${lateWebhook.outcome}`);
    console.log(`  -> Order Status    : ${lateWebhook.status} (Anti-Oversell Protected!)`);
    console.log(`  -> Refund Triggered: ${lateWebhook.refundInitiated}`);

    expect(lateWebhook.outcome).toBe('REFUND_TRIGGERED');
    expect(lateWebhook.status).toBe(OrderStatus.REFUND_REQUIRED);
  });

  it('Demo 5 (Compensation Scenario): Downstream fulfillment failure executes retryable refund', async () => {
    console.log('\n[Demo 5] Running Saga Workflow Compensation Scenario...');
    const reservation = createReservation(10);
    const order = await workflow.initiateCheckout({
      reservationId: reservation.id,
      totalAmount: new Money(11000, 'USD'),
    });

    // Downstream failure: Ticket generation service crashes
    workflow.setTicketIssuer(async () => {
      throw new Error('TICKET_DB_DEADLOCK: Unique ticket index conflict');
    });

    // Simulate transient failure during refund (fails once)
    paymentAdapter.failNextRefunds(1);

    const compResult = await workflow.processPayment({
      orderId: order.id,
      paymentMethodToken: 'pm_card_valid',
      idempotencyKey: 'demo-key-comp',
    });

    console.log(`  -> First Compensation Attempt: ${compResult.status} (Recorded in audit trail)`);
    expect(compResult.status).toBe(OrderStatus.COMPENSATION_PENDING);

    // Reconciler retry
    const retryComp = await workflow.retryCompensation(order.id);
    console.log(`  -> Retry Compensation Result : ${retryComp.outcome} -> ${retryComp.status}`);
    console.log(`  -> Refund Transaction ID     : ${retryComp.refundTransactionId}`);

    expect(retryComp.status).toBe(OrderStatus.CANCELLED_REFUNDED);
  });
});
