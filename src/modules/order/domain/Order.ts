import { Money } from '../../catalog/domain/Money.js';
import { OrderStatus } from './OrderStatus.js';
import { DomainError, InvalidStateTransitionError } from '../../../shared/domain/DomainError.js';

export interface PaymentAttempt {
  attemptNumber: number;
  idempotencyKey: string;
  status: 'PENDING' | 'SUCCESS' | 'DECLINED' | 'TIMEOUT' | 'FAILED';
  providerTransactionId?: string;
  failureReason?: string;
  timestamp: Date;
}

export interface CompensationAttempt {
  attemptNumber: number;
  idempotencyKey: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  refundTransactionId?: string;
  failureReason?: string;
  timestamp: Date;
}

export class Order {
  public readonly id: string;
  public readonly userId: string;
  public readonly reservationId: string;
  public readonly ticketTypeId: string;
  public readonly quantity: number;
  public readonly totalAmount: Money;
  private _status: OrderStatus;
  private _providerTransactionId?: string;
  private _refundTransactionId?: string;
  private _confirmedAt?: Date;
  private _paymentAttempts: PaymentAttempt[] = [];
  private _compensationAttempts: CompensationAttempt[] = [];
  public readonly createdAt: Date;
  private _updatedAt: Date;

  constructor(
    id: string,
    userId: string,
    reservationId: string,
    ticketTypeId: string,
    quantity: number,
    totalAmount: Money,
    status: OrderStatus = OrderStatus.PAYMENT_PENDING,
    providerTransactionId?: string,
    confirmedAt?: Date,
    paymentAttempts: PaymentAttempt[] = [],
    createdAt: Date = new Date(),
    updatedAt: Date = new Date()
  ) {
    if (!id || id.trim().length === 0) throw new Error('Order ID cannot be empty');
    if (!userId || userId.trim().length === 0) throw new Error('User ID cannot be empty');
    if (!reservationId || reservationId.trim().length === 0) throw new Error('Reservation ID cannot be empty');
    if (!ticketTypeId || ticketTypeId.trim().length === 0) throw new Error('TicketType ID cannot be empty');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive integer');

    this.id = id;
    this.userId = userId;
    this.reservationId = reservationId;
    this.ticketTypeId = ticketTypeId;
    this.quantity = quantity;
    this.totalAmount = totalAmount;
    this._status = status;
    this._providerTransactionId = providerTransactionId;
    this._confirmedAt = confirmedAt;
    this._paymentAttempts = [...paymentAttempts];
    this.createdAt = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  public get status(): OrderStatus {
    return this._status;
  }

  public get providerTransactionId(): string | undefined {
    return this._providerTransactionId;
  }

  public get confirmedAt(): Date | undefined {
    return this._confirmedAt;
  }

  public get paymentAttempts(): ReadonlyArray<PaymentAttempt> {
    return [...this._paymentAttempts];
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Adds an attempt to the payment audit trail
   */
  public recordPaymentAttempt(attempt: PaymentAttempt): void {
    this._paymentAttempts.push({ ...attempt });
    this._updatedAt = new Date();
  }

  /**
   * Transition to CONFIRMED
   * Rule: Idempotent guard. If already CONFIRMED with matching providerTxnId, does nothing.
   * If terminal EXPIRED / CANCELLED / REFUND_REQUIRED, throws error.
   */
  public confirm(providerTransactionId: string, timestamp: Date = new Date()): boolean {
    if (this._status === OrderStatus.CONFIRMED) {
      // Idempotent duplicate: already confirmed
      return false;
    }

    if (
      this._status !== OrderStatus.PAYMENT_PENDING &&
      this._status !== OrderStatus.CREATED &&
      this._status !== OrderStatus.PAYMENT_DECLINED
    ) {
      throw new InvalidStateTransitionError(this._status, OrderStatus.CONFIRMED);
    }

    this._status = OrderStatus.CONFIRMED;
    this._providerTransactionId = providerTransactionId;
    this._confirmedAt = new Date(timestamp.getTime());
    this._updatedAt = new Date();
    return true;
  }

  /**
   * Transition to PAYMENT_DECLINED
   * Rule: Must be in PAYMENT_PENDING.
   * Order remains open to retry as long as reservation is active.
   */
  public markPaymentDeclined(reason: string): void {
    if (this._status !== OrderStatus.PAYMENT_PENDING) {
      throw new InvalidStateTransitionError(this._status, OrderStatus.PAYMENT_DECLINED);
    }
    this._status = OrderStatus.PAYMENT_DECLINED;
    this._updatedAt = new Date();
  }

  /**
   * Transition to PAYMENT_PENDING (e.g. retrying after previous decline)
   */
  public retryPayment(): void {
    if (this._status !== OrderStatus.PAYMENT_DECLINED) {
      throw new InvalidStateTransitionError(this._status, OrderStatus.PAYMENT_PENDING);
    }
    this._status = OrderStatus.PAYMENT_PENDING;
    this._updatedAt = new Date();
  }

  /**
   * Transition to REFUND_REQUIRED
   * Rule: Used when a late payment callback reports SUCCESS after the order/reservation
   * has already EXPIRED or CANCELLED, ensuring inventory is NEVER oversold.
   */
  public markRefundRequired(providerTransactionId: string, reason: string): void {
    this._status = OrderStatus.REFUND_REQUIRED;
    this._providerTransactionId = providerTransactionId;
    this._updatedAt = new Date();
  }

  /**
   * Transition to EXPIRED
   */
  public expire(): void {
    if (this._status === OrderStatus.CONFIRMED) {
      throw new InvalidStateTransitionError(this._status, OrderStatus.EXPIRED);
    }
    this._status = OrderStatus.EXPIRED;
    this._updatedAt = new Date();
  }

  public get refundTransactionId(): string | undefined {
    return this._refundTransactionId;
  }

  public get compensationAttempts(): ReadonlyArray<CompensationAttempt> {
    return [...this._compensationAttempts];
  }

  public recordCompensationAttempt(attempt: CompensationAttempt): void {
    this._compensationAttempts.push({ ...attempt });
    this._updatedAt = new Date();
  }

  /**
   * Transition to COMPENSATION_PENDING
   * Rule: In-flight compensation or retry needed when downstream fulfillment fails
   */
  public markCompensationPending(reason: string): void {
    this._status = OrderStatus.COMPENSATION_PENDING;
    this._updatedAt = new Date();
  }

  /**
   * Transition to CANCELLED_REFUNDED
   * Rule: Terminal state after successful Saga compensation (refund completed)
   */
  public markCompensated(refundTransactionId: string): void {
    this._status = OrderStatus.CANCELLED_REFUNDED;
    this._refundTransactionId = refundTransactionId;
    this._updatedAt = new Date();
  }

  /**
   * Transition to CANCELLED
   */
  public cancel(): void {
    if (this._status === OrderStatus.CONFIRMED) {
      throw new InvalidStateTransitionError(this._status, OrderStatus.CANCELLED);
    }
    this._status = OrderStatus.CANCELLED;
    this._updatedAt = new Date();
  }
}
