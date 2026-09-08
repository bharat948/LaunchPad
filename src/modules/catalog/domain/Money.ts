import { InvalidMoneyError } from '../../../shared/domain/DomainError.js';

export class Money {
  public readonly amountCents: number;
  public readonly currency: string;

  constructor(amountCents: number, currency: string = 'USD') {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new InvalidMoneyError(`Money amount must be a non-negative integer in cents. Received: ${amountCents}`);
    }
    if (!currency || currency.trim().length === 0) {
      throw new InvalidMoneyError('Currency string must be provided');
    }
    this.amountCents = amountCents;
    this.currency = currency.toUpperCase();
  }

  public equals(other: Money): boolean {
    return this.amountCents === other.amountCents && this.currency === other.currency;
  }
}
