import { InvalidCapacityError } from '../../../shared/domain/DomainError.js';
import { Money } from './Money.js';

export class TicketType {
  public readonly id: string;
  public readonly eventId: string;
  public readonly name: string;
  public readonly price: Money;
  public readonly capacity: number;

  constructor(id: string, eventId: string, name: string, price: Money, capacity: number) {
    if (!id || id.trim().length === 0) {
      throw new Error('TicketType ID cannot be empty');
    }
    if (!name || name.trim().length === 0) {
      throw new Error('TicketType name cannot be empty');
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new InvalidCapacityError(`TicketType capacity must be a positive integer > 0. Received: ${capacity}`);
    }
    this.id = id;
    this.eventId = eventId;
    this.name = name.trim();
    this.price = price;
    this.capacity = capacity;
  }
}
