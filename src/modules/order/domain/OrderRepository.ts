import { Order } from './Order.js';

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findByReservationId(reservationId: string): Promise<Order | null>;
  findByProviderTransactionId(providerTxnId: string): Promise<Order | null>;
}

export class InMemoryOrderRepository implements OrderRepository {
  private orders = new Map<string, Order>();

  public async save(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }

  public async findById(id: string): Promise<Order | null> {
    return this.orders.get(id) || null;
  }

  public async findByReservationId(reservationId: string): Promise<Order | null> {
    for (const order of this.orders.values()) {
      if (order.reservationId === reservationId) {
        return order;
      }
    }
    return null;
  }

  public async findByProviderTransactionId(providerTxnId: string): Promise<Order | null> {
    for (const order of this.orders.values()) {
      if (order.providerTransactionId === providerTxnId) {
        return order;
      }
      for (const attempt of order.paymentAttempts) {
        if (attempt.providerTransactionId === providerTxnId) {
          return order;
        }
      }
    }
    return null;
  }

  public clear(): void {
    this.orders.clear();
  }
}
