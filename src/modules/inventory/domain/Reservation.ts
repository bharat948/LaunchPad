import { DomainError, InvalidStateTransitionError } from '../../../shared/domain/DomainError.js';
import { Clock } from '../../../shared/domain/Clock.js';
import { ReservationStatus } from './ReservationStatus.js';

export class ReservationExpiredError extends DomainError {
  constructor(message: string = 'Reservation has expired and cannot be confirmed') {
    super(message);
  }
}

export class PrematureExpirationError extends DomainError {
  constructor(message: string = 'Cannot expire reservation before expiresAt timestamp has passed') {
    super(message);
  }
}

export class Reservation {
  public readonly id: string;
  public readonly userId: string;
  public readonly ticketTypeId: string;
  public readonly quantity: number;
  public readonly createdAt: Date;
  public readonly expiresAt: Date;
  private _status: ReservationStatus;

  constructor(
    id: string,
    userId: string,
    ticketTypeId: string,
    quantity: number,
    createdAt: Date,
    expiresAt: Date,
    status: ReservationStatus = ReservationStatus.PENDING
  ) {
    if (!id || id.trim().length === 0) throw new Error('Reservation ID cannot be empty');
    if (!userId || userId.trim().length === 0) throw new Error('User ID cannot be empty');
    if (!ticketTypeId || ticketTypeId.trim().length === 0) throw new Error('TicketType ID cannot be empty');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive integer');
    if (createdAt.getTime() >= expiresAt.getTime()) {
      throw new Error('createdAt must be strictly before expiresAt');
    }

    this.id = id;
    this.userId = userId;
    this.ticketTypeId = ticketTypeId;
    this.quantity = quantity;
    this.createdAt = new Date(createdAt.getTime());
    this.expiresAt = new Date(expiresAt.getTime());
    this._status = status;
  }

  public static create(
    id: string,
    userId: string,
    ticketTypeId: string,
    quantity: number,
    clock: Clock,
    ttlMinutes: number = 10
  ): Reservation {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    return new Reservation(id, userId, ticketTypeId, quantity, now, expiresAt, ReservationStatus.PENDING);
  }

  public get status(): ReservationStatus {
    return this._status;
  }

  /**
   * Transition: PENDING -> PAYMENT_PENDING
   * Rule: Must be PENDING, and clock.now() must be <= expiresAt
   */
  public startPayment(clock: Clock): void {
    if (this._status !== ReservationStatus.PENDING) {
      throw new InvalidStateTransitionError(this._status, ReservationStatus.PAYMENT_PENDING);
    }
    if (clock.now().getTime() > this.expiresAt.getTime()) {
      throw new ReservationExpiredError(
        `Reservation expired at ${this.expiresAt.toISOString()}. Current time is ${clock.now().toISOString()}`
      );
    }
    this._status = ReservationStatus.PAYMENT_PENDING;
  }

  /**
   * Transition: PAYMENT_PENDING -> PENDING (Recoverable state on payment decline)
   * Rule: Must be PAYMENT_PENDING. Allows buyer to retry with alternate payment method.
   */
  public revertPaymentDecline(): void {
    if (this._status !== ReservationStatus.PAYMENT_PENDING) {
      throw new InvalidStateTransitionError(this._status, ReservationStatus.PENDING);
    }
    this._status = ReservationStatus.PENDING;
  }

  /**
   * Transition: PENDING | PAYMENT_PENDING -> CONFIRMED
   * Rule: Must be PENDING or PAYMENT_PENDING, and clock.now() must be <= expiresAt
   */
  public confirm(clock: Clock): void {
    if (
      this._status !== ReservationStatus.PENDING &&
      this._status !== ReservationStatus.PAYMENT_PENDING
    ) {
      throw new InvalidStateTransitionError(this._status, ReservationStatus.CONFIRMED);
    }
    if (clock.now().getTime() > this.expiresAt.getTime()) {
      throw new ReservationExpiredError(
        `Reservation expired at ${this.expiresAt.toISOString()}. Current time is ${clock.now().toISOString()}`
      );
    }
    this._status = ReservationStatus.CONFIRMED;
  }

  /**
   * Transition: PENDING | PAYMENT_PENDING -> EXPIRED
   * Rule: Must be PENDING or PAYMENT_PENDING, and clock.now() must be > expiresAt
   */
  public expire(clock: Clock): void {
    if (
      this._status !== ReservationStatus.PENDING &&
      this._status !== ReservationStatus.PAYMENT_PENDING
    ) {
      throw new InvalidStateTransitionError(this._status, ReservationStatus.EXPIRED);
    }
    if (clock.now().getTime() <= this.expiresAt.getTime()) {
      throw new PrematureExpirationError(
        `Cannot expire reservation before ${this.expiresAt.toISOString()}. Current time is ${clock.now().toISOString()}`
      );
    }
    this._status = ReservationStatus.EXPIRED;
  }

  /**
   * Transition: PENDING | PAYMENT_PENDING -> CANCELLED
   * Rule: Must be PENDING or PAYMENT_PENDING
   */
  public cancel(): void {
    if (
      this._status !== ReservationStatus.PENDING &&
      this._status !== ReservationStatus.PAYMENT_PENDING
    ) {
      throw new InvalidStateTransitionError(this._status, ReservationStatus.CANCELLED);
    }
    this._status = ReservationStatus.CANCELLED;
  }
}
