import { Money } from '../../catalog/domain/Money.js';

export interface ChargeRequest {
  paymentId: string;
  orderId: string;
  idempotencyKey: string;
  amount: Money;
  customerEmail?: string;
  paymentMethodToken: string;
}

export type ChargeStatus = 'SUCCESS' | 'DECLINED' | 'TIMEOUT' | 'FAILED';

export interface ChargeResult {
  status: ChargeStatus;
  transactionId?: string;
  declineCode?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

/**
 * PaymentGateway Port (Hexagonal Architecture)
 * 
 * Defines the contract required by Launchpad for processing external payments.
 * Contains ZERO vendor-specific types (no Stripe, Adyen, or PayPal SDK types).
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}

export interface RefundRequest {
  refundId: string;
  transactionId: string; // The original charge transactionId
  orderId: string;
  amount: Money;
  reason?: string;
  idempotencyKey: string;
}

export type RefundStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT';

export interface RefundResult {
  status: RefundStatus;
  refundTransactionId?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}
