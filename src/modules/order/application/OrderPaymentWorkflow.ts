import { randomUUID } from 'crypto';
import { Clock, SystemClock } from '../../../shared/domain/Clock.js';
import { Money } from '../../catalog/domain/Money.js';
import { Reservation } from '../../inventory/domain/Reservation.js';
import { ReservationStatus } from '../../inventory/domain/ReservationStatus.js';
import { PaymentGateway, ChargeRequest } from '../../payment/domain/PaymentGateway.js';
import { Order, PaymentAttempt } from '../domain/Order.js';
import { OrderStatus } from '../domain/OrderStatus.js';
import { OrderRepository } from '../domain/OrderRepository.js';

export interface ReservationRepository {
  findById(id: string): Promise<Reservation | null>;
  save(reservation: Reservation): Promise<void>;
}

export class InMemoryReservationRepository implements ReservationRepository {
  private reservations = new Map<string, Reservation>();

  public async findById(id: string): Promise<Reservation | null> {
    return this.reservations.get(id) || null;
  }

  public async save(reservation: Reservation): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  public clear(): void {
    this.reservations.clear();
  }
}

export interface InitiateCheckoutCommand {
  reservationId: string;
  totalAmount: Money;
}

export interface ProcessPaymentCommand {
  orderId: string;
  paymentMethodToken: string;
  idempotencyKey: string;
  customerEmail?: string;
}

export interface ProcessPaymentResult {
  success: boolean;
  status: OrderStatus;
  transactionId?: string;
  recoverable?: boolean;
  timeout?: boolean;
  alreadyProcessed?: boolean;
  message?: string;
}

export interface PaymentWebhookPayload {
  eventId: string;
  orderId: string;
  providerTransactionId: string;
  status: 'SUCCESS' | 'DECLINED' | 'FAILED';
  errorMessage?: string;
}

export type TicketIssuer = (order: Order) => Promise<void>;

export interface CompensationResult {
  handled: boolean;
  outcome: 'COMPENSATED' | 'COMPENSATION_FAILED' | 'ALREADY_COMPENSATED';
  status: OrderStatus;
  refundTransactionId?: string;
  errorMessage?: string;
}

export interface WebhookResult {
  handled: boolean;
  outcome:
    | 'CONFIRMED'
    | 'DUPLICATE_IGNORED'
    | 'DECLINED'
    | 'REFUND_TRIGGERED'
    | 'IGNORED_AFTER_CONFIRMATION';
  status: OrderStatus;
  message: string;
  refundInitiated?: boolean;
}

export class OrderPaymentWorkflow {
  private processedWebhookEvents = new Set<string>();
  private ticketIssuer: TicketIssuer = async () => {};

  constructor(
    private orderRepo: OrderRepository,
    private reservationRepo: ReservationRepository,
    private paymentGateway: PaymentGateway,
    private clock: Clock = new SystemClock()
  ) {}

  public setTicketIssuer(issuer: TicketIssuer): void {
    this.ticketIssuer = issuer;
  }

  /**
   * STEP 1: Initiate checkout for an active reservation
   */
  public async initiateCheckout(command: InitiateCheckoutCommand): Promise<Order> {
    const reservation = await this.reservationRepo.findById(command.reservationId);
    if (!reservation) {
      throw new Error(`Reservation not found: ${command.reservationId}`);
    }

    if (reservation.status !== ReservationStatus.PENDING) {
      throw new Error(`Cannot checkout reservation with status: ${reservation.status}`);
    }

    // Transition reservation to PAYMENT_PENDING
    reservation.startPayment(this.clock);
    await this.reservationRepo.save(reservation);

    const orderId = randomUUID();
    const order = new Order(
      orderId,
      reservation.userId,
      reservation.id,
      reservation.ticketTypeId,
      reservation.quantity,
      command.totalAmount,
      OrderStatus.PAYMENT_PENDING
    );

    await this.orderRepo.save(order);
    return order;
  }

  /**
   * STEP 2: Process payment attempt against the external payment gateway port
   */
  public async processPayment(command: ProcessPaymentCommand): Promise<ProcessPaymentResult> {
    const order = await this.orderRepo.findById(command.orderId);
    if (!order) {
      throw new Error(`Order not found: ${command.orderId}`);
    }

    const reservation = await this.reservationRepo.findById(order.reservationId);
    if (!reservation) {
      throw new Error(`Reservation not found: ${order.reservationId}`);
    }

    // Idempotency check: Has this idempotency key already been attempted for this order?
    const existingAttempt = order.paymentAttempts.find(
      (a) => a.idempotencyKey === command.idempotencyKey
    );
    if (existingAttempt && existingAttempt.status === 'SUCCESS') {
      return {
        success: true,
        status: order.status,
        transactionId: existingAttempt.providerTransactionId,
        alreadyProcessed: true,
        message: 'Payment already successfully processed for this idempotency key',
      };
    }

    if (order.status === OrderStatus.CONFIRMED) {
      return {
        success: true,
        status: OrderStatus.CONFIRMED,
        transactionId: order.providerTransactionId,
        alreadyProcessed: true,
        message: 'Order already confirmed',
      };
    }

    if (order.status === OrderStatus.PAYMENT_DECLINED) {
      order.retryPayment();
    }

    const attemptNumber = order.paymentAttempts.length + 1;
    const chargeRequest: ChargeRequest = {
      paymentId: randomUUID(),
      orderId: order.id,
      amount: order.totalAmount,
      paymentMethodToken: command.paymentMethodToken,
      idempotencyKey: command.idempotencyKey,
      customerEmail: command.customerEmail,
    };

    const chargeResult = await this.paymentGateway.charge(chargeRequest);

    if (chargeResult.status === 'SUCCESS') {
      const attempt: PaymentAttempt = {
        attemptNumber,
        idempotencyKey: command.idempotencyKey,
        status: 'SUCCESS',
        providerTransactionId: chargeResult.transactionId,
        timestamp: this.clock.now(),
      };
      order.recordPaymentAttempt(attempt);

      try {
        // Forward Step 3: Ticket issuance / entitlement generation
        await this.ticketIssuer(order);

        // Final Confirmations
        order.confirm(chargeResult.transactionId!, this.clock.now());
        reservation.confirm(this.clock);

        await this.reservationRepo.save(reservation);
        await this.orderRepo.save(order);

        return {
          success: true,
          status: OrderStatus.CONFIRMED,
          transactionId: chargeResult.transactionId,
        };
      } catch (fulfillmentError) {
        // POST-PAYMENT FAILURE!
        // Payment was charged upstream, but ticket issuance / fulfillment crashed.
        // Execute Saga Compensating Actions (cancel reservation hold + refund payment):
        await this.orderRepo.save(order);
        const compResult = await this.compensateOrder(
          order.id,
          chargeResult.transactionId!,
          fulfillmentError instanceof Error ? fulfillmentError.message : 'Fulfillment failure'
        );

        return {
          success: false,
          status: compResult.status,
          message: `Post-payment fulfillment failed: ${
            fulfillmentError instanceof Error ? fulfillmentError.message : 'Error'
          }. Compensation: ${compResult.outcome}`,
        };
      }
    }

    if (chargeResult.status === 'DECLINED') {
      const attempt: PaymentAttempt = {
        attemptNumber,
        idempotencyKey: command.idempotencyKey,
        status: 'DECLINED',
        failureReason: chargeResult.errorMessage || 'Card declined',
        timestamp: this.clock.now(),
      };
      order.recordPaymentAttempt(attempt);
      order.markPaymentDeclined(chargeResult.errorMessage || 'Card declined');

      // Recoverable: Revert reservation back to PENDING if not expired so user can retry
      if (this.clock.now().getTime() <= reservation.expiresAt.getTime()) {
        reservation.revertPaymentDecline();
        await this.reservationRepo.save(reservation);
      }

      await this.orderRepo.save(order);

      return {
        success: false,
        status: OrderStatus.PAYMENT_DECLINED,
        recoverable: true,
        message: chargeResult.errorMessage || 'Payment card was declined',
      };
    }

    if (chargeResult.status === 'TIMEOUT') {
      const attempt: PaymentAttempt = {
        attemptNumber,
        idempotencyKey: command.idempotencyKey,
        status: 'TIMEOUT',
        failureReason: chargeResult.errorMessage || 'Gateway timeout',
        timestamp: this.clock.now(),
      };
      order.recordPaymentAttempt(attempt);

      // Order remains in PAYMENT_PENDING awaiting asynchronous reconciliation or webhook
      await this.orderRepo.save(order);

      return {
        success: false,
        status: OrderStatus.PAYMENT_PENDING,
        timeout: true,
        message: 'Payment request timed out. Status is pending provider reconciliation.',
      };
    }

    // FAILED / Malformed
    const attempt: PaymentAttempt = {
      attemptNumber,
      idempotencyKey: command.idempotencyKey,
      status: 'FAILED',
      failureReason: chargeResult.errorMessage || 'Provider failure',
      timestamp: this.clock.now(),
    };
    order.recordPaymentAttempt(attempt);
    order.markPaymentDeclined(chargeResult.errorMessage || 'Provider failure');

    if (this.clock.now().getTime() <= reservation.expiresAt.getTime()) {
      reservation.revertPaymentDecline();
      await this.reservationRepo.save(reservation);
    }

    await this.orderRepo.save(order);

    return {
      success: false,
      status: OrderStatus.PAYMENT_DECLINED,
      recoverable: true,
      message: chargeResult.errorMessage || 'Provider failed to process payment',
    };
  }

  /**
   * STEP 3: Handle asynchronous provider callback / webhook
   */
  public async handlePaymentWebhook(payload: PaymentWebhookPayload): Promise<WebhookResult> {
    // 1. Webhook Deduplication: Event ID check
    if (this.processedWebhookEvents.has(payload.eventId)) {
      const existingOrder = await this.orderRepo.findById(payload.orderId);
      return {
        handled: true,
        outcome: 'DUPLICATE_IGNORED',
        status: existingOrder ? existingOrder.status : OrderStatus.CONFIRMED,
        message: `Webhook event ${payload.eventId} has already been processed`,
      };
    }

    const order = await this.orderRepo.findById(payload.orderId);
    if (!order) {
      throw new Error(`Order not found for webhook: ${payload.orderId}`);
    }

    const reservation = await this.reservationRepo.findById(order.reservationId);
    if (!reservation) {
      throw new Error(`Reservation not found for webhook: ${order.reservationId}`);
    }

    // 2. Duplicate Check: If order already CONFIRMED
    if (order.status === OrderStatus.CONFIRMED) {
      this.processedWebhookEvents.add(payload.eventId);
      return {
        handled: true,
        outcome: 'DUPLICATE_IGNORED',
        status: OrderStatus.CONFIRMED,
        message: 'Order was already confirmed; ignoring duplicate callback',
      };
    }

    // 3. Late Success after Expiration (ADVANCEMENT GATE: Non-contradictory state)
    if (payload.status === 'SUCCESS') {
      const isExpired =
        reservation.status === ReservationStatus.EXPIRED ||
        order.status === OrderStatus.EXPIRED ||
        this.clock.now().getTime() > reservation.expiresAt.getTime();

      if (isExpired) {
        // INVENTORY WAS RELEASED TO POOL!
        // To prevent oversell, we MUST NOT confirm the order.
        order.markRefundRequired(
          payload.providerTransactionId,
          'Late payment received after reservation expiration'
        );
        this.processedWebhookEvents.add(payload.eventId);
        await this.orderRepo.save(order);

        return {
          handled: true,
          outcome: 'REFUND_TRIGGERED',
          status: OrderStatus.REFUND_REQUIRED,
          refundInitiated: true,
          message:
            'Late payment received after reservation expired. Initiated automatic refund to protect inventory invariant.',
        };
      }

      // Valid timely confirmation
      order.confirm(payload.providerTransactionId, this.clock.now());
      reservation.confirm(this.clock);

      this.processedWebhookEvents.add(payload.eventId);
      await this.reservationRepo.save(reservation);
      await this.orderRepo.save(order);

      return {
        handled: true,
        outcome: 'CONFIRMED',
        status: OrderStatus.CONFIRMED,
        message: 'Order successfully confirmed via webhook',
      };
    }

    // 4. Webhook reports DECLINED or FAILED

    order.markPaymentDeclined(payload.errorMessage || 'Webhook reported payment declined');
    if (this.clock.now().getTime() <= reservation.expiresAt.getTime()) {
      reservation.revertPaymentDecline();
      await this.reservationRepo.save(reservation);
    }
    this.processedWebhookEvents.add(payload.eventId);
    await this.orderRepo.save(order);

    return {
      handled: true,
      outcome: 'DECLINED',
      status: OrderStatus.PAYMENT_DECLINED,
      message: 'Order payment marked declined via webhook',
    };
  }

  /**
   * SAGA COMPENSATING ACTION:
   * Reverses an in-flight or failed checkout by:
   * 1. Cancelling the reservation hold (freeing inventory back to pool).
   * 2. Issuing a financial refund through the payment gateway port.
   * 3. Transitioning order to CANCELLED_REFUNDED (or COMPENSATION_PENDING on failure).
   */
  public async compensateOrder(
    orderId: string,
    providerTxnId?: string,
    reason: string = 'Saga compensation: downstream fulfillment failed'
  ): Promise<CompensationResult> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order not found for compensation: ${orderId}`);
    }

    if (order.status === OrderStatus.CANCELLED_REFUNDED) {
      return {
        handled: true,
        outcome: 'ALREADY_COMPENSATED',
        status: OrderStatus.CANCELLED_REFUNDED,
        refundTransactionId: order.refundTransactionId,
      };
    }

    // Step 1: Release held inventory
    const reservation = await this.reservationRepo.findById(order.reservationId);
    if (
      reservation &&
      reservation.status !== ReservationStatus.CANCELLED &&
      reservation.status !== ReservationStatus.EXPIRED
    ) {
      reservation.cancel();
      await this.reservationRepo.save(reservation);
    }

    const txnId =
      providerTxnId ||
      order.providerTransactionId ||
      order.paymentAttempts.find((a) => a.status === 'SUCCESS')?.providerTransactionId;

    if (!txnId) {
      // No payment charge was captured; simply cancel order
      order.cancel();
      await this.orderRepo.save(order);
      return {
        handled: true,
        outcome: 'COMPENSATED',
        status: OrderStatus.CANCELLED,
      };
    }

    // Step 2: Refund Payment through Payment Port
    const attemptNumber = order.compensationAttempts.length + 1;
    const refundIdempotencyKey = `refund_${order.id}_${attemptNumber}`;

    const refundRes = await this.paymentGateway.refund({
      refundId: randomUUID(),
      transactionId: txnId,
      orderId: order.id,
      amount: order.totalAmount,
      reason,
      idempotencyKey: refundIdempotencyKey,
    });

    if (refundRes.status === 'SUCCESS') {
      order.recordCompensationAttempt({
        attemptNumber,
        idempotencyKey: refundIdempotencyKey,
        status: 'SUCCESS',
        refundTransactionId: refundRes.refundTransactionId,
        timestamp: this.clock.now(),
      });
      order.markCompensated(refundRes.refundTransactionId!);
      await this.orderRepo.save(order);

      return {
        handled: true,
        outcome: 'COMPENSATED',
        status: OrderStatus.CANCELLED_REFUNDED,
        refundTransactionId: refundRes.refundTransactionId,
      };
    }

    // Refund failed or timed out: Record failure and mark COMPENSATION_PENDING
    order.recordCompensationAttempt({
      attemptNumber,
      idempotencyKey: refundIdempotencyKey,
      status: 'FAILED',
      failureReason: refundRes.errorMessage || 'Refund failed at provider',
      timestamp: this.clock.now(),
    });
    order.markCompensationPending(refundRes.errorMessage || 'Refund failed at provider');
    await this.orderRepo.save(order);

    return {
      handled: true,
      outcome: 'COMPENSATION_FAILED',
      status: OrderStatus.COMPENSATION_PENDING,
      errorMessage: refundRes.errorMessage,
    };
  }

  /**
   * Retries compensation for an order in COMPENSATION_PENDING
   */
  public async retryCompensation(orderId: string): Promise<CompensationResult> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order not found for retry compensation: ${orderId}`);
    }

    if (order.status !== OrderStatus.COMPENSATION_PENDING) {
      throw new Error(`Cannot retry compensation for order with status: ${order.status}`);
    }

    return this.compensateOrder(orderId, undefined, 'Retry compensation');
  }
}
