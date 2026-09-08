import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { Order } from '../../src/modules/order/domain/Order.js';
import { OrderStatus } from '../../src/modules/order/domain/OrderStatus.js';
import {
  createOrderConfirmedEvent,
  ORDER_CONFIRMED_EVENT_TYPE,
  OrderConfirmedPayloadV1,
  OrderConfirmedPayloadV2,
} from '../../src/modules/order/domain/events/OrderConfirmedEvent.js';
import { EventSerializer } from '../../src/shared/events/EventSerializer.js';

describe('LAB-901: Domain Event Modeling & Schema Evolution', () => {
  beforeEach(() => {
    EventSerializer.clearUpcasters();
  });

  function createConfirmedOrder(): Order {
    const order = new Order(
      randomUUID(),
      'user_charlie_789',
      randomUUID(),
      randomUUID(),
      2,
      new Money(9000, 'USD'),
      OrderStatus.PAYMENT_PENDING
    );
    order.confirm('txn_fake_stripe_9999', new Date('2026-09-08T15:00:00.000Z'));
    return order;
  }

  describe('1. Canonical Event Envelope & Serialization', () => {
    it('creates and serializes an OrderConfirmed event adhering to the standard envelope', () => {
      const order = createConfirmedOrder();
      const event = createOrderConfirmedEvent(order, {
        version: 1,
        correlationId: 'corr_test_001',
      });

      expect(event.eventType).toBe(ORDER_CONFIRMED_EVENT_TYPE);
      expect(event.aggregateId).toBe(order.id);
      expect(event.version).toBe(1);
      expect(event.producer).toBe('launchpad.order-service');
      expect(event.data.orderId).toBe(order.id);
      expect(event.data.totalAmountCents).toBe(9000);
      expect(event.data.currency).toBe('USD');
      expect(event.metadata?.correlationId).toBe('corr_test_001');

      // Serialization roundtrip
      const json = EventSerializer.serialize(event);
      expect(typeof json).toBe('string');

      const deserialized = EventSerializer.deserialize<OrderConfirmedPayloadV1>(json);
      expect(deserialized.eventId).toBe(event.eventId);
      expect(deserialized.data.quantity).toBe(2);
      expect(deserialized.data.providerTransactionId).toBe('txn_fake_stripe_9999');
    });

    it('rejects events missing essential envelope properties', () => {
      const invalidEvent: any = {
        eventType: 'order.confirmed',
        // missing eventId, version, data, etc.
      };

      expect(() => EventSerializer.serialize(invalidEvent)).toThrow(
        'DomainEvent must have an eventId'
      );
    });
  });

  describe('2. Backward Compatibility & Upcasting (v1 Event -> v2 Consumer)', () => {
    it('seamlessly upcasts legacy v1 event payloads to v2 with default enriched facts', () => {
      // 1. Register schema migration upcaster for v1 -> v2
      EventSerializer.registerUpcaster(
        ORDER_CONFIRMED_EVENT_TYPE,
        1,
        2,
        (legacyData) => ({
          ...legacyData,
          customerEmail: (legacyData.customerEmail as string) || 'guest@launchpad.internal',
          ticketTierName: (legacyData.ticketTierName as string) || 'Standard Admission',
        })
      );

      // 2. Legacy v1 event payload
      const order = createConfirmedOrder();
      const v1Event = createOrderConfirmedEvent(order, { version: 1 });
      const rawJsonV1 = EventSerializer.serialize(v1Event);

      // 3. Modern v2 consumer receives v1 JSON and upcasts
      const deserializedV1 = EventSerializer.deserialize<Record<string, unknown>>(rawJsonV1);
      expect(deserializedV1.version).toBe(1);

      const upcastEvent = EventSerializer.upcast<OrderConfirmedPayloadV2>(deserializedV1, 2);

      expect(upcastEvent.version).toBe(2);
      expect(upcastEvent.data.orderId).toBe(order.id);
      expect(upcastEvent.data.totalAmountCents).toBe(9000);
      // Enriched attributes provided by upcaster:
      expect(upcastEvent.data.customerEmail).toBe('guest@launchpad.internal');
      expect(upcastEvent.data.ticketTierName).toBe('Standard Admission');
    });
  });

  describe('3. Forward Compatibility (v2 Event -> v1 Consumer)', () => {
    it('allows legacy v1 consumers to safely read v2 events, ignoring unknown added fields', () => {
      const order = createConfirmedOrder();
      const v2Event = createOrderConfirmedEvent(order, {
        version: 2,
        customerEmail: 'vip_buyer@example.com',
        ticketTierName: 'VIP Golden Circle',
      });

      const rawJsonV2 = EventSerializer.serialize(v2Event);

      // Legacy v1 consumer deserializes payload
      const deserialized = EventSerializer.deserialize<OrderConfirmedPayloadV1>(rawJsonV2);

      expect(deserialized.version).toBe(2);
      expect(deserialized.data.orderId).toBe(order.id);
      expect(deserialized.data.quantity).toBe(2);
      expect(deserialized.data.totalAmountCents).toBe(9000);
      // New attributes do not break deserialization
      expect((deserialized.data as any).customerEmail).toBe('vip_buyer@example.com');
    });
  });

  describe('4. ADVANCEMENT GATE: Self-Contained Consumer Independence (Zero DB Calls)', () => {
    it('enables notification and analytics consumers to react completely using only event facts', () => {
      const order = createConfirmedOrder();
      const event = createOrderConfirmedEvent(order, {
        version: 2,
        customerEmail: 'alice@company.com',
        ticketTierName: 'General Admission Early Bird',
      });

      // --- Consumer 1: Notification / Email Receipt Consumer ---
      class MockNotificationConsumer {
        public sentEmails: Array<{ recipient: string; subject: string; body: string }> = [];

        public handle(evt: typeof event): void {
          // Extracts all data directly from event; zero database calls made!
          const recipient = evt.data.customerEmail || 'unknown@example.com';
          const subject = `Order Confirmed: ${evt.data.orderId}`;
          const body = `Thank you for your purchase of ${evt.data.quantity} tickets. Total Paid: $${(
            evt.data.totalAmountCents / 100
          ).toFixed(2)} ${evt.data.currency}. Confirmation Txn: ${evt.data.providerTransactionId}`;

          this.sentEmails.push({ recipient, subject, body });
        }
      }

      // --- Consumer 2: Analytics Revenue Metrics Consumer ---
      class MockAnalyticsConsumer {
        public totalRevenueCents = 0;
        public totalTicketsSold = 0;

        public handle(evt: typeof event): void {
          this.totalRevenueCents += evt.data.totalAmountCents;
          this.totalTicketsSold += evt.data.quantity;
        }
      }

      const notificationService = new MockNotificationConsumer();
      const analyticsService = new MockAnalyticsConsumer();

      // Dispatch event to consumers
      notificationService.handle(event);
      analyticsService.handle(event);

      // Verify Notification output
      expect(notificationService.sentEmails.length).toBe(1);
      expect(notificationService.sentEmails[0].recipient).toBe('alice@company.com');
      expect(notificationService.sentEmails[0].body).toContain('Total Paid: $90.00 USD');
      expect(notificationService.sentEmails[0].body).toContain('txn_fake_stripe_9999');

      // Verify Analytics output
      expect(analyticsService.totalRevenueCents).toBe(9000);
      expect(analyticsService.totalTicketsSold).toBe(2);

      // ADVANCEMENT GATE PROOF:
      // Both consumers completed full business processing with ZERO queries to the producer database!
    });
  });
});
