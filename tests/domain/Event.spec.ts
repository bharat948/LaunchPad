import { describe, it, expect } from 'vitest';
import { Event } from '../../src/modules/catalog/domain/Event.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { TimeWindow } from '../../src/modules/catalog/domain/TimeWindow.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { InventoryPool } from '../../src/modules/inventory/domain/InventoryPool.js';
import {
  InvalidTimeWindowError,
  InvalidMoneyError,
  InvalidCapacityError,
  EmptyTicketTypesError,
  InvalidStateTransitionError,
  InsufficientInventoryError,
} from '../../src/shared/domain/DomainError.js';

describe('LAB-101: Catalog & Event Domain Entities', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const later = new Date('2026-10-01T20:00:00Z');

  describe('Value Objects Invariants', () => {
    it('should create valid TimeWindow when startAt < endAt', () => {
      const window = new TimeWindow(now, later);
      expect(window.startAt).toEqual(now);
      expect(window.endAt).toEqual(later);
    });

    it('should reject invalid TimeWindow when startAt >= endAt before persistence', () => {
      expect(() => new TimeWindow(later, now)).toThrow(InvalidTimeWindowError);
      expect(() => new TimeWindow(now, now)).toThrow(InvalidTimeWindowError);
    });

    it('should create valid Money for non-negative integers', () => {
      const money = new Money(5000, 'USD');
      expect(money.amountCents).toBe(5000);
      expect(money.currency).toBe('USD');
    });

    it('should reject Money with negative amount or non-integer before persistence', () => {
      expect(() => new Money(-100, 'USD')).toThrow(InvalidMoneyError);
      expect(() => new Money(10.5, 'USD')).toThrow(InvalidMoneyError);
    });
  });

  describe('Event & TicketType Domain Rules', () => {
    it('should initialize Event in DRAFT status', () => {
      const window = new TimeWindow(now, later);
      const event = Event.create('evt-1', 'org-1', 'Rock Concert', window);
      expect(event.status).toBe(EventStatus.DRAFT);
      expect(event.ticketTypes.length).toBe(0);
    });

    it('should reject non-positive capacity for TicketType before persistence', () => {
      const window = new TimeWindow(now, later);
      const event = Event.create('evt-1', 'org-1', 'Rock Concert', window);
      const price = new Money(2500, 'USD');

      expect(() => event.addTicketType('tt-1', 'General Admission', price, 0)).toThrow(InvalidCapacityError);
      expect(() => event.addTicketType('tt-1', 'General Admission', price, -10)).toThrow(InvalidCapacityError);
    });

    it('should reject scheduling or publishing an event with zero TicketTypes', () => {
      const window = new TimeWindow(now, later);
      const event = Event.create('evt-1', 'org-1', 'Rock Concert', window);

      expect(() => event.schedule()).toThrow(EmptyTicketTypesError);
      expect(() => event.publish()).toThrow(EmptyTicketTypesError);
    });

    it('should execute explicit state machine transitions when valid', () => {
      const window = new TimeWindow(now, later);
      const event = Event.create('evt-1', 'org-1', 'Rock Concert', window);
      const price = new Money(2500, 'USD');
      event.addTicketType('tt-1', 'General Admission', price, 100);

      event.schedule();
      expect(event.status).toBe(EventStatus.SCHEDULED);

      event.publish();
      expect(event.status).toBe(EventStatus.LIVE);

      event.cancel();
      expect(event.status).toBe(EventStatus.CANCELLED);
    });

    it('should block invalid status transitions before persistence', () => {
      const window = new TimeWindow(now, later);
      const event = Event.create('evt-1', 'org-1', 'Rock Concert', window);
      const price = new Money(2500, 'USD');
      event.addTicketType('tt-1', 'General Admission', price, 100);

      event.publish();
      expect(event.status).toBe(EventStatus.LIVE);

      // Cannot publish an already LIVE event or schedule it back
      expect(() => event.schedule()).toThrow(InvalidStateTransitionError);
    });
  });

  describe('InventoryPool Aggregate Invariants', () => {
    it('should initialize InventoryPool with Total = Available and 0 Reserved/Sold', () => {
      const pool = new InventoryPool('tt-1', 50);
      expect(pool.totalCapacity).toBe(50);
      expect(pool.availableQuantity).toBe(50);
      expect(pool.reservedQuantity).toBe(0);
      expect(pool.soldQuantity).toBe(0);
    });

    it('should correctly process reservations and enforce capacity invariant', () => {
      const pool = new InventoryPool('tt-1', 10);
      pool.reserve(3);
      expect(pool.availableQuantity).toBe(7);
      expect(pool.reservedQuantity).toBe(3);

      pool.fulfill(2);
      expect(pool.reservedQuantity).toBe(1);
      expect(pool.soldQuantity).toBe(2);

      pool.release(1);
      expect(pool.reservedQuantity).toBe(0);
      expect(pool.availableQuantity).toBe(8);
    });

    it('should reject over-reservation attempts', () => {
      const pool = new InventoryPool('tt-1', 5);
      expect(() => pool.reserve(10)).toThrow(InsufficientInventoryError);
    });
  });
});
