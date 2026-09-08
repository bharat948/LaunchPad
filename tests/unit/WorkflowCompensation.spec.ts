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

describe('LAB-803: Workflow Compensation & Saga Fault Recovery', () => {
  let clock: TestClock;
  let orderRepo: InMemoryOrderRepository;
  let reservationRepo: InMemoryReservationRepository;
  let paymentAdapter: FakePaymentAdapter;
  let workflow: OrderPaymentWorkflow;

  const initialTime = new Date('2026-09-08T12:00:00.000Z');
  const ticketTypeId = randomUUID();
  const userId = 'user-bob-999';

  beforeEach(() => {
    clock = new TestClock(initialTime);
    orderRepo = new InMemoryOrderRepository();
    reservationRepo = new InMemoryReservationRepository();
    paymentAdapter = new FakePaymentAdapter('SUCCESS');
    workflow = new OrderPaymentWorkflow(orderRepo, reservationRepo, paymentAdapter, clock);
  });

  function createTestReservation(ttlMinutes = 10): Reservation {
    const reservation = Reservation.create(
      randomUUID(),
      userId,
      ticketTypeId,
      2,
      clock,
      ttlMinutes
    );
    reservationRepo.save(reservation);
    return reservation;
  }

  describe('1. Post-Payment Fulfillment Failure Triggers Compensation', () => {
    it('cancels reservation and refunds money when ticket generation crashes after payment success', async () => {
      // 1. Inject failure into post-payment ticket issuance step
      workflow.setTicketIssuer(async () => {
        throw new Error('SIMULATED_TICKET_DB_CRASH: Unique barcode generation failed');
      });

      const reservation = createTestReservation();
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(12000, 'USD'),
      });

      // 2. Execute payment: charge succeeds, but fulfillment throws
      const result = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_valid',
        idempotencyKey: 'idemp-comp-1',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(OrderStatus.CANCELLED_REFUNDED);
      expect(result.message).toContain('Compensation: COMPENSATED');

      // 3. Verify Saga Compensating Actions executed
      const updatedOrder = await orderRepo.findById(order.id);
      const updatedReservation = await reservationRepo.findById(reservation.id);

      // Inventory hold was cancelled and freed
      expect(updatedReservation?.status).toBe(ReservationStatus.CANCELLED);

      // Order reached terminal CANCELLED_REFUNDED state
      expect(updatedOrder?.status).toBe(OrderStatus.CANCELLED_REFUNDED);
      expect(updatedOrder?.refundTransactionId).toBeDefined();

      // Provider was refunded
      const processedRefunds = paymentAdapter.getProcessedRefunds();
      expect(processedRefunds.length).toBe(1);
      expect(processedRefunds[0].orderId).toBe(order.id);
      expect(processedRefunds[0].amount.amountCents).toBe(12000);
    });
  });

  describe('2. ADVANCEMENT GATE: Compensation Itself Fails Once Then Succeeds on Retry', () => {
    it('captures COMPENSATION_PENDING on refund failure, and transitions to CANCELLED_REFUNDED upon retry', async () => {
      // 1. Setup ticket crash and simulate 1 transient refund failure at PSP
      workflow.setTicketIssuer(async () => {
        throw new Error('SIMULATED_BARCODE_SERVICE_OUTAGE');
      });
      paymentAdapter.failNextRefunds(1); // First refund call will fail!

      const reservation = createTestReservation();
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(9500, 'USD'),
      });

      // 2. Process checkout: payment succeeds, ticket fails, refund attempt 1 fails
      const initialResult = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_valid',
        idempotencyKey: 'idemp-comp-retry-1',
      });

      expect(initialResult.success).toBe(false);
      expect(initialResult.status).toBe(OrderStatus.COMPENSATION_PENDING);

      // Verify order is captured in COMPENSATION_PENDING with audit trail
      const orderPending = await orderRepo.findById(order.id);
      expect(orderPending?.status).toBe(OrderStatus.COMPENSATION_PENDING);
      expect(orderPending?.compensationAttempts.length).toBe(1);
      expect(orderPending?.compensationAttempts[0].status).toBe('FAILED');

      // Reservation was still cancelled so seats are freed
      const reservationCancelled = await reservationRepo.findById(reservation.id);
      expect(reservationCancelled?.status).toBe(ReservationStatus.CANCELLED);

      // 3. Retry compensation (e.g. background reconciler or cron worker triggers retry)
      const retryResult = await workflow.retryCompensation(order.id);

      expect(retryResult.handled).toBe(true);
      expect(retryResult.outcome).toBe('COMPENSATED');
      expect(retryResult.status).toBe(OrderStatus.CANCELLED_REFUNDED);
      expect(retryResult.refundTransactionId).toBeDefined();

      // 4. Final Verification: Reached terminal recoverable state with 2 compensation attempts
      const finalOrder = await orderRepo.findById(order.id);
      expect(finalOrder?.status).toBe(OrderStatus.CANCELLED_REFUNDED);
      expect(finalOrder?.compensationAttempts.length).toBe(2);
      expect(finalOrder?.compensationAttempts[0].status).toBe('FAILED');
      expect(finalOrder?.compensationAttempts[1].status).toBe('SUCCESS');
      expect(finalOrder?.refundTransactionId).toBe(retryResult.refundTransactionId);

      const refundsAtGateway = paymentAdapter.getProcessedRefunds();
      expect(refundsAtGateway.length).toBe(2); // 1 failed, 1 succeeded
    });
  });

  describe('3. Idempotent Compensation Guard', () => {
    it('returns ALREADY_COMPENSATED if compensation is triggered repeatedly', async () => {
      const reservation = createTestReservation();
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(5000, 'USD'),
      });

      // Manually trigger initial compensation
      const firstComp = await workflow.compensateOrder(order.id, 'txn_fake_manual');
      expect(firstComp.outcome).toBe('COMPENSATED');
      expect(firstComp.status).toBe(OrderStatus.CANCELLED_REFUNDED);

      // Duplicate compensation call
      const duplicateComp = await workflow.compensateOrder(order.id, 'txn_fake_manual');
      expect(duplicateComp.outcome).toBe('ALREADY_COMPENSATED');
      expect(duplicateComp.status).toBe(OrderStatus.CANCELLED_REFUNDED);

      // Exactly 1 refund was dispatched to provider
      expect(paymentAdapter.getProcessedRefunds().length).toBe(1);
    });
  });
});
