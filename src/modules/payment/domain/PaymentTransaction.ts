import { Money } from '../../catalog/domain/Money.js';

export type PaymentTransactionStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'DECLINED'
  | 'TIMEOUT'
  | 'FAILED';

export class PaymentTransaction {
  constructor(
    public readonly id: string,
    public readonly orderId: string,
    public readonly amount: Money,
    public readonly idempotencyKey: string,
    private _status: PaymentTransactionStatus = 'PENDING',
    private _providerTransactionId?: string,
    private _failureReason?: string,
    public readonly createdAt: Date = new Date(),
    private _updatedAt: Date = new Date()
  ) {}

  public get status(): PaymentTransactionStatus {
    return this._status;
  }

  public get providerTransactionId(): string | undefined {
    return this._providerTransactionId;
  }

  public get failureReason(): string | undefined {
    return this._failureReason;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public markCaptured(providerTxnId: string): void {
    this._status = 'CAPTURED';
    this._providerTransactionId = providerTxnId;
    this._updatedAt = new Date();
  }

  public markDeclined(reason: string): void {
    this._status = 'DECLINED';
    this._failureReason = reason;
    this._updatedAt = new Date();
  }

  public markTimeout(): void {
    this._status = 'TIMEOUT';
    this._failureReason = 'Payment provider timed out with ambiguous outcome';
    this._updatedAt = new Date();
  }

  public markFailed(error: string): void {
    this._status = 'FAILED';
    this._failureReason = error;
    this._updatedAt = new Date();
  }
}
