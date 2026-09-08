import { InvalidCapacityError, InsufficientInventoryError } from '../../../shared/domain/DomainError.js';

export class InventoryPool {
  public readonly ticketTypeId: string;
  public readonly totalCapacity: number;
  private _availableQuantity: number;
  private _reservedQuantity: number;
  private _soldQuantity: number;

  constructor(ticketTypeId: string, totalCapacity: number) {
    if (!ticketTypeId || ticketTypeId.trim().length === 0) {
      throw new Error('TicketType ID cannot be empty');
    }
    if (!Number.isInteger(totalCapacity) || totalCapacity <= 0) {
      throw new InvalidCapacityError(`Total capacity must be a positive integer > 0. Received: ${totalCapacity}`);
    }
    this.ticketTypeId = ticketTypeId;
    this.totalCapacity = totalCapacity;
    this._availableQuantity = totalCapacity;
    this._reservedQuantity = 0;
    this._soldQuantity = 0;
  }

  public get availableQuantity(): number {
    return this._availableQuantity;
  }

  public get reservedQuantity(): number {
    return this._reservedQuantity;
  }

  public get soldQuantity(): number {
    return this._soldQuantity;
  }

  public reserve(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Reserve quantity must be a positive integer');
    }
    if (quantity > this._availableQuantity) {
      throw new InsufficientInventoryError(`Cannot reserve ${quantity} tickets. Only ${this._availableQuantity} available.`);
    }
    this._availableQuantity -= quantity;
    this._reservedQuantity += quantity;
    this.assertCapacityInvariant();
  }

  public release(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Release quantity must be a positive integer');
    }
    if (quantity > this._reservedQuantity) {
      throw new Error(`Cannot release ${quantity} tickets. Only ${this._reservedQuantity} reserved.`);
    }
    this._reservedQuantity -= quantity;
    this._availableQuantity += quantity;
    this.assertCapacityInvariant();
  }

  public fulfill(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Fulfill quantity must be a positive integer');
    }
    if (quantity > this._reservedQuantity) {
      throw new Error(`Cannot fulfill ${quantity} tickets. Only ${this._reservedQuantity} reserved.`);
    }
    this._reservedQuantity -= quantity;
    this._soldQuantity += quantity;
    this.assertCapacityInvariant();
  }

  private assertCapacityInvariant(): void {
    if (this._availableQuantity + this._reservedQuantity + this._soldQuantity !== this.totalCapacity) {
      throw new Error('Capacity invariant violated! Total capacity does not equal Available + Reserved + Sold.');
    }
  }
}
