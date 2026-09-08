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

describe('OrderPaymentWorkflow (LAB-802: State Transitions & Coherent Lifecycle)', () => {
  let clock: TestClock;
  let orderRepo: InMemoryOrderRepository;
  let reservationRepo: InMemoryReservationRepository;
  let paymentAdapter: FakePaymentAdapter;
  let workflow: OrderPaymentWorkflow;

  const initialTime = new Date('2026-09-08T12:00:00.000Z');
  const ticketTypeId = randomUUID();
  const userId = 'user-alice-123';

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

  describe('1. Happy Path: Checkout to Confirmation', () => {
    it('transitions reservation to PAYMENT_PENDING and confirms both order and reservation upon payment success', async () => {
      const reservation = createTestReservation();
      expect(reservation.status).toBe(ReservationStatus.PENDING);

      // 1. Initiate checkout
      const totalAmount = new Money(5000, 'USD'); // $50.00
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount,
      });

      expect(order.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(reservation.status).toBe(ReservationStatus.PAYMENT_PENDING);

      // 2. Process payment
      const result = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_visa',
        idempotencyKey: 'idemp-key-happy-1',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe(OrderStatus.CONFIRMED);
      expect(result.transactionId).toBeDefined();

      // Verify domain entities updated in repositories
      const updatedOrder = await orderRepo.findById(order.id);
      const updatedReservation = await reservationRepo.findById(reservation.id);

      expect(updatedOrder?.status).toBe(OrderStatus.CONFIRMED);
      expect(updatedOrder?.providerTransactionId).toBe(result.transactionId);
      expect(updatedOrder?.confirmedAt).toBeDefined();
      expect(updatedReservation?.status).toBe(ReservationStatus.CONFIRMED);
    });
  });

  describe('2. Recoverable Decline Flow', () => {
    it('leaves reservation in recoverable PENDING state when payment is declined, allowing subsequent successful retry', async () => {
      const reservation = createTestReservation();
      const totalAmount = new Money(7500, 'USD');

      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount,
      });

      // Configure adapter to simulate card decline
      paymentAdapter.simulateDecline('insufficient_funds');

      const declineResult = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_insufficient_funds',
        idempotencyKey: 'idemp-key-decline-1',
      });

      expect(declineResult.success).toBe(false);
      expect(declineResult.status).toBe(OrderStatus.PAYMENT_DECLINED);
      expect(declineResult.recoverable).toBe(true);

      // Acceptance Criteria: Decline leaves valid recoverable state (reservation reverts to PENDING)
      const reservationAfterDecline = await reservationRepo.findById(reservation.id);
      const orderAfterDecline = await orderRepo.findById(order.id);

      expect(reservationAfterDecline?.status).toBe(ReservationStatus.PENDING);
      expect(orderAfterDecline?.status).toBe(OrderStatus.PAYMENT_DECLINED);

      // Buyer enters alternative valid card
      paymentAdapter.simulateSuccess();

      const retryResult = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_valid_mastercard',
        idempotencyKey: 'idemp-key-retry-success',
      });

      expect(retryResult.success).toBe(true);
      expect(retryResult.status).toBe(OrderStatus.CONFIRMED);

      const finalOrder = await orderRepo.findById(order.id);
      const finalReservation = await reservationRepo.findById(reservation.id);

      expect(finalOrder?.status).toBe(OrderStatus.CONFIRMED);
      expect(finalReservation?.status).toBe(ReservationStatus.CONFIRMED);
      expect(finalOrder?.paymentAttempts.length).toBe(2);
      expect(finalOrder?.paymentAttempts[0].status).toBe('DECLINED');
      expect(finalOrder?.paymentAttempts[1].status).toBe('SUCCESS');
    });
  });

  describe('3. Duplicate Webhook / Callback Handling', () => {
    it('safely handles duplicate and replayed webhooks without double-confirming', async () => {
      const reservation = createTestReservation();
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(10000, 'USD'),
      });

      // Delivery 1: Successful webhook
      const webhook1 = await workflow.handlePaymentWebhook({
        eventId: 'evt_stripe_001',
        orderId: order.id,
        providerTransactionId: 'txn_provider_001',
        status: 'SUCCESS',
      });

      expect(webhook1.handled).toBe(true);
      expect(webhook1.outcome).toBe('CONFIRMED');
      expect(webhook1.status).toBe(OrderStatus.CONFIRMED);

      // Delivery 2: Exact duplicate webhook (network retry)
      const webhook2 = await workflow.handlePaymentWebhook({
        eventId: 'evt_stripe_001',
        orderId: order.id,
        providerTransactionId: 'txn_provider_001',
        status: 'SUCCESS',
      });

      expect(webhook2.handled).toBe(true);
      expect(webhook2.outcome).toBe('DUPLICATE_IGNORED');
      expect(webhook2.status).toBe(OrderStatus.CONFIRMED);

      // Delivery 3: Different event ID, but order already confirmed
      const webhook3 = await workflow.handlePaymentWebhook({
        eventId: 'evt_stripe_002',
        orderId: order.id,
        providerTransactionId: 'txn_provider_001',
        status: 'SUCCESS',
      });

      expect(webhook3.handled).toBe(true);
      expect(webhook3.outcome).toBe('DUPLICATE_IGNORED');

      const finalOrder = await orderRepo.findById(order.id);
      expect(finalOrder?.status).toBe(OrderStatus.CONFIRMED);
    });
  });

  describe('4. Ambiguous Timeout then In-Time Webhook', () => {
    it('reconciles local timeout when webhook arrives before reservation expiration', async () => {
      const reservation = createTestReservation(10); // 10 minutes TTL
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(3000, 'USD'),
      });

      // Simulate network socket timeout during payment call
      paymentAdapter.simulateTimeout();

      const timeoutResult = await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_slow_bank',
        idempotencyKey: 'idemp-timeout-1',
      });

      expect(timeoutResult.success).toBe(false);
      expect(timeoutResult.timeout).toBe(true);
      expect(timeoutResult.status).toBe(OrderStatus.PAYMENT_PENDING);

      // Advance clock by 2 minutes (still well within 10-minute hold)
      clock.advanceByMinutes(2);

      // Webhook arrives reporting charge succeeded upstream
      const webhookResult = await workflow.handlePaymentWebhook({
        eventId: 'evt_late_success_001',
        orderId: order.id,
        providerTransactionId: 'txn_upstream_late_1',
        status: 'SUCCESS',
      });

      expect(webhookResult.handled).toBe(true);
      expect(webhookResult.outcome).toBe('CONFIRMED');
      expect(webhookResult.status).toBe(OrderStatus.CONFIRMED);

      const confirmedOrder = await orderRepo.findById(order.id);
      const confirmedReservation = await reservationRepo.findById(reservation.id);

      expect(confirmedOrder?.status).toBe(OrderStatus.CONFIRMED);
      expect(confirmedReservation?.status).toBe(ReservationStatus.CONFIRMED);
    });
  });

  describe('5. ADVANCEMENT GATE: Timeout Followed by Late Success After Expiration', () => {
    it('prevents contradictory state and oversell by routing late payment to REFUND_REQUIRED when reservation has expired', async () => {
      const reservation = createTestReservation(10); // 10 minutes TTL
      const order = await workflow.initiateCheckout({
        reservationId: reservation.id,
        totalAmount: new Money(8000, 'USD'),
      });

      // 1. Payment times out locally
      paymentAdapter.simulateTimeout();
      await workflow.processPayment({
        orderId: order.id,
        paymentMethodToken: 'pm_card_hung',
        idempotencyKey: 'idemp-gate-timeout',
      });

      // 2. Advance time by 15 minutes (past 10 min TTL)
      clock.advanceByMinutes(15);

      // Background expiry scanner marks reservation EXPIRED and releases inventory
      reservation.expire(clock);
      await reservationRepo.save(reservation);

      expect(reservation.status).toBe(ReservationStatus.EXPIRED);

      // 3. Late webhook arrives from payment provider claiming SUCCESS
      const lateWebhookResult = await workflow.handlePaymentWebhook({
        eventId: 'evt_stripe_late_arrival',
        orderId: order.id,
        providerTransactionId: 'txn_stripe_late_charged',
        status: 'SUCCESS',
      });

      // 4. Verification of Advancement Gate:
      // Must NOT confirm order! Doing so would oversell released tickets!
      expect(lateWebhookResult.handled).toBe(true);
      expect(lateWebhookResult.outcome).toBe('REFUND_TRIGGERED');
      expect(lateWebhookResult.status).toBe(OrderStatus.REFUND_REQUIRED);
      expect(lateWebhookResult.refundInitiated).toBe(true);

      const finalOrder = await orderRepo.findById(order.id);
      const finalReservation = await reservationRepo.findById(reservation.id);

      // COHERENT, NON-CONTRADICTORY STATE VERIFIED:
      expect(finalOrder?.status).toBe(OrderStatus.REFUND_REQUIRED);
      expect(finalOrder?.status).not.toBe(OrderStatus.CONFIRMED);
      expect(finalReservation?.status).toBe(ReservationStatus.EXPIRED);
    });
  });
});
