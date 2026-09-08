import { describe, it, expect } from 'vitest';
import { TestClock } from '../../src/shared/domain/Clock.js';
import { Reservation, ReservationExpiredError, PrematureExpirationError } from '../../src/modules/inventory/domain/Reservation.js';
import { ReservationStatus } from '../../src/modules/inventory/domain/ReservationStatus.js';
import { InvalidStateTransitionError } from '../../src/shared/domain/DomainError.js';

describe('LAB-301: Reservation Lifecycle State Machine & Transition Matrix', () => {
  const baseTime = new Date('2026-10-01T10:00:00.000Z');

  describe('Happy Path State Transitions', () => {
    it('should initialize Reservation in PENDING status with 10-minute expiry', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      expect(res.status).toBe(ReservationStatus.PENDING);
      expect(res.quantity).toBe(2);
      expect(res.createdAt).toEqual(baseTime);
      expect(res.expiresAt).toEqual(new Date('2026-10-01T10:10:00.000Z'));
    });

    it('should allow confirming PENDING reservation before expiry', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      // Advance by 5 minutes (within 10-minute window)
      clock.advanceByMinutes(5);
      res.confirm(clock);

      expect(res.status).toBe(ReservationStatus.CONFIRMED);
    });

    it('should allow expiring PENDING reservation after expiry time elapses', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      // Advance by 11 minutes (past 10-minute window)
      clock.advanceByMinutes(11);
      res.expire(clock);

      expect(res.status).toBe(ReservationStatus.EXPIRED);
    });

    it('should allow cancelling PENDING reservation', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      res.cancel();
      expect(res.status).toBe(ReservationStatus.CANCELLED);
    });
  });

  describe('Time Boundary & Invariant Checks', () => {
    it('should reject confirming an expired reservation', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      // Advance past 10 minutes
      clock.advanceByMinutes(10.1);

      expect(() => res.confirm(clock)).toThrow(ReservationExpiredError);
    });

    it('should reject expiring a reservation prematurely while hold is active', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 2, clock, 10);

      // Only 3 minutes have passed
      clock.advanceByMinutes(3);

      expect(() => res.expire(clock)).toThrow(PrematureExpirationError);
    });
  });

  describe('Exhaustive Transition Matrix (Terminal State Invariance)', () => {
    it('should block all transitions from CONFIRMED', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 1, clock, 10);
      res.confirm(clock);

      expect(() => res.confirm(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.expire(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.cancel()).toThrow(InvalidStateTransitionError);
    });

    it('should block all transitions from EXPIRED', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 1, clock, 10);
      clock.advanceByMinutes(15);
      res.expire(clock);

      expect(() => res.confirm(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.expire(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.cancel()).toThrow(InvalidStateTransitionError);
    });

    it('should block all transitions from CANCELLED', () => {
      const clock = new TestClock(baseTime);
      const res = Reservation.create('res-1', 'user-1', 'tt-1', 1, clock, 10);
      res.cancel();

      expect(() => res.confirm(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.expire(clock)).toThrow(InvalidStateTransitionError);
      expect(() => res.cancel()).toThrow(InvalidStateTransitionError);
    });
  });
});
