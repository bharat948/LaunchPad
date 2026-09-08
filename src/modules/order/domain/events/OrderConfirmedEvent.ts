import { randomUUID } from 'crypto';
import { DomainEvent } from '../../../../shared/events/DomainEvent.js';
import { Order } from '../Order.js';

export const ORDER_CONFIRMED_EVENT_TYPE = 'order.confirmed';

export interface OrderConfirmedPayloadV1 {
  orderId: string;
  userId: string;
  reservationId: string;
  ticketTypeId: string;
  quantity: number;
  totalAmountCents: number;
  currency: string;
  confirmedAt: string;
  providerTransactionId: string;
}

export interface OrderConfirmedPayloadV2 extends OrderConfirmedPayloadV1 {
  customerEmail?: string;
  ticketTierName?: string;
}

export type OrderConfirmedEventV1 = DomainEvent<OrderConfirmedPayloadV1>;
export type OrderConfirmedEventV2 = DomainEvent<OrderConfirmedPayloadV2>;

export interface CreateOrderConfirmedEventOptions {
  version?: 1 | 2;
  customerEmail?: string;
  ticketTierName?: string;
  correlationId?: string;
  causationId?: string;
}

/**
 * Factory helper to build a validated OrderConfirmed domain event from an Order aggregate
 */
export function createOrderConfirmedEvent(
  order: Order,
  options: CreateOrderConfirmedEventOptions = {}
): DomainEvent<OrderConfirmedPayloadV1 | OrderConfirmedPayloadV2> {
  if (!order.confirmedAt || !order.providerTransactionId) {
    throw new Error(`Cannot emit OrderConfirmed event for order ${order.id} without confirmation`);
  }

  const version = options.version || 1;
  const basePayload: OrderConfirmedPayloadV1 = {
    orderId: order.id,
    userId: order.userId,
    reservationId: order.reservationId,
    ticketTypeId: order.ticketTypeId,
    quantity: order.quantity,
    totalAmountCents: order.totalAmount.amountCents,
    currency: order.totalAmount.currency,
    confirmedAt: order.confirmedAt.toISOString(),
    providerTransactionId: order.providerTransactionId,
  };

  const data: OrderConfirmedPayloadV1 | OrderConfirmedPayloadV2 =
    version === 2
      ? {
          ...basePayload,
          customerEmail: options.customerEmail,
          ticketTierName: options.ticketTierName,
        }
      : basePayload;

  return {
    eventId: randomUUID(),
    eventType: ORDER_CONFIRMED_EVENT_TYPE,
    aggregateId: order.id,
    version,
    occurredAt: order.confirmedAt.toISOString(),
    producer: 'launchpad.order-service',
    data,
    metadata: {
      correlationId: options.correlationId,
      causationId: options.causationId,
      userId: order.userId,
    },
  };
}
