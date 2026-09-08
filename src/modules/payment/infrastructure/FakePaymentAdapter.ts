import { randomUUID } from 'crypto';
import {
  PaymentGateway,
  ChargeRequest,
  ChargeResult,
  ChargeStatus,
  RefundRequest,
  RefundResult,
  RefundStatus,
} from '../domain/PaymentGateway.js';

export type FakeAdapterMode = 'SUCCESS' | 'DECLINED' | 'TIMEOUT' | 'MALFORMED';

export class FakePaymentAdapter implements PaymentGateway {
  private mode: FakeAdapterMode = 'SUCCESS';
  private latencyMs: number = 0;
  private declineCode: string = 'card_declined';
  private declineMessage: string = 'Your card has insufficient funds';
  private processedCharges: ChargeRequest[] = [];
  private processedRefunds: RefundRequest[] = [];
  private refundFailCount: number = 0;

  constructor(initialMode: FakeAdapterMode = 'SUCCESS') {
    this.mode = initialMode;
  }

  public setMode(mode: FakeAdapterMode): this {
    this.mode = mode;
    return this;
  }

  public simulateSuccess(): this {
    return this.setMode('SUCCESS');
  }

  public simulateDecline(code: string = 'card_declined', message: string = 'Card declined'): this {
    return this.setDecline(code, message);
  }

  public simulateTimeout(): this {
    return this.setMode('TIMEOUT');
  }

  public simulateMalformed(): this {
    return this.setMode('MALFORMED');
  }

  public setLatencyMs(ms: number): this {
    this.latencyMs = ms;
    return this;
  }

  public setDecline(code: string, message: string): this {
    this.mode = 'DECLINED';
    this.declineCode = code;
    this.declineMessage = message;
    return this;
  }

  public getProcessedCharges(): ChargeRequest[] {
    return [...this.processedCharges];
  }

  public failNextRefunds(count: number = 1): this {
    this.refundFailCount = count;
    return this;
  }

  public getProcessedRefunds(): RefundRequest[] {
    return [...this.processedRefunds];
  }

  public clearHistory(): void {
    this.processedCharges = [];
    this.processedRefunds = [];
    this.refundFailCount = 0;
  }

  public async refund(request: RefundRequest): Promise<RefundResult> {
    this.processedRefunds.push(request);

    if (this.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    }

    if (this.refundFailCount > 0) {
      this.refundFailCount--;
      return {
        status: 'FAILED',
        errorMessage: 'Simulated payment network connection failure during refund',
      };
    }

    return {
      status: 'SUCCESS',
      refundTransactionId: `ref_fake_${randomUUID()}`,
      rawResponse: {
        provider: 'FakePaymentGateway',
        refunded: true,
        amount: request.amount.amountCents,
        originalTransactionId: request.transactionId,
      },
    };
  }

  public async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.processedCharges.push(request);

    if (this.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    }

    switch (this.mode) {
      case 'SUCCESS':
        return {
          status: 'SUCCESS',
          transactionId: `txn_fake_${randomUUID()}`,
          rawResponse: {
            provider: 'FakePaymentGateway',
            paid: true,
            amount: request.amount.amountCents,
            currency: request.amount.currency,
          },
        };

      case 'DECLINED':
        return {
          status: 'DECLINED',
          declineCode: this.declineCode,
          errorMessage: this.declineMessage,
          rawResponse: {
            provider: 'FakePaymentGateway',
            paid: false,
            error: {
              code: this.declineCode,
              message: this.declineMessage,
            },
          },
        };

      case 'TIMEOUT':
        return {
          status: 'TIMEOUT',
          errorMessage: 'Gateway timed out waiting for upstream acquiring bank',
          rawResponse: {
            provider: 'FakePaymentGateway',
            timeout: true,
          },
        };

      case 'MALFORMED':
        // Simulates vendor returning unexpected garbage or corrupt schema
        return {
          status: 'FAILED',
          errorMessage: 'Malformed vendor payload: Missing required status field',
          rawResponse: {
            unrecognizedField: 12345,
          },
        };

      default:
        return {
          status: 'FAILED',
          errorMessage: 'Unknown provider failure',
        };
    }
  }
}
