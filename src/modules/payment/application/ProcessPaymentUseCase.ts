import { PaymentGateway, ChargeRequest } from '../domain/PaymentGateway.js';
import { PaymentTransaction } from '../domain/PaymentTransaction.js';
import { Money } from '../../catalog/domain/Money.js';

export interface ProcessPaymentCommand {
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency?: string;
  paymentMethodToken: string;
  idempotencyKey: string;
  customerEmail?: string;
}

export interface ProcessPaymentResult {
  transaction: PaymentTransaction;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export class ProcessPaymentUseCase {
  constructor(private gateway: PaymentGateway) {}

  public async execute(command: ProcessPaymentCommand): Promise<ProcessPaymentResult> {
    const money = new Money(command.amountCents, command.currency || 'USD');
    const transaction = new PaymentTransaction(
      command.paymentId,
      command.orderId,
      money,
      command.idempotencyKey
    );

    const chargeRequest: ChargeRequest = {
      paymentId: command.paymentId,
      orderId: command.orderId,
      amount: money,
      paymentMethodToken: command.paymentMethodToken,
      idempotencyKey: command.idempotencyKey,
      customerEmail: command.customerEmail,
    };

    const result = await this.gateway.charge(chargeRequest);

    switch (result.status) {
      case 'SUCCESS':
        transaction.markCaptured(result.transactionId!);
        return {
          transaction,
          success: true,
        };

      case 'DECLINED':
        transaction.markDeclined(result.errorMessage || 'Card declined');
        return {
          transaction,
          success: false,
          errorCode: result.declineCode || 'PAYMENT_DECLINED',
          errorMessage: result.errorMessage,
        };

      case 'TIMEOUT':
        transaction.markTimeout();
        return {
          transaction,
          success: false,
          errorCode: 'PAYMENT_TIMEOUT',
          errorMessage: result.errorMessage || 'Payment provider timed out',
        };

      case 'FAILED':
      default:
        transaction.markFailed(result.errorMessage || 'Provider processing error');
        return {
          transaction,
          success: false,
          errorCode: 'PAYMENT_FAILED',
          errorMessage: result.errorMessage || 'Provider failed to process payment',
        };
    }
  }
}
