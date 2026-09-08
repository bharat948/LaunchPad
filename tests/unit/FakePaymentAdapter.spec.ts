import { describe, it, expect } from 'vitest';
import { FakePaymentAdapter } from '../../src/modules/payment/infrastructure/FakePaymentAdapter.js';
import { ProcessPaymentUseCase } from '../../src/modules/payment/application/ProcessPaymentUseCase.js';
import { PaymentGateway, ChargeRequest, ChargeResult } from '../../src/modules/payment/domain/PaymentGateway.js';

describe('LAB-801: Payment Port & Fake Provider (Ports and Adapters / Hexagonal)', () => {
  it('Success Scenario: Captures payment and updates transaction status to CAPTURED', async () => {
    const adapter = new FakePaymentAdapter().setMode('SUCCESS');
    const useCase = new ProcessPaymentUseCase(adapter);

    const result = await useCase.execute({
      paymentId: 'pay-001',
      orderId: 'ord-001',
      amountCents: 5000,
      currency: 'USD',
      paymentMethodToken: 'tok_visa_valid',
      idempotencyKey: 'idem-pay-1',
      customerEmail: 'fan@example.com',
    });

    expect(result.success).toBe(true);
    expect(result.transaction.status).toBe('CAPTURED');
    expect(result.transaction.providerTransactionId).toMatch(/^txn_fake_/);
    expect(result.transaction.failureReason).toBeUndefined();

    // Verify adapter recorded the request correctly
    const history = adapter.getProcessedCharges();
    expect(history).toHaveLength(1);
    expect(history[0].amount.amountCents).toBe(5000);
    expect(history[0].paymentMethodToken).toBe('tok_visa_valid');
  });

  it('Declined Scenario: Handles bank card decline and sets transaction to DECLINED', async () => {
    const adapter = new FakePaymentAdapter().setDecline('insufficient_funds', 'Balance is too low');
    const useCase = new ProcessPaymentUseCase(adapter);

    const result = await useCase.execute({
      paymentId: 'pay-002',
      orderId: 'ord-002',
      amountCents: 99900,
      currency: 'USD',
      paymentMethodToken: 'tok_declined_card',
      idempotencyKey: 'idem-pay-2',
    });

    expect(result.success).toBe(false);
    expect(result.transaction.status).toBe('DECLINED');
    expect(result.errorCode).toBe('insufficient_funds');
    expect(result.errorMessage).toBe('Balance is too low');
    expect(result.transaction.failureReason).toBe('Balance is too low');
  });

  it('Timeout Scenario: Handles external vendor timeout and sets transaction to TIMEOUT', async () => {
    const adapter = new FakePaymentAdapter().setMode('TIMEOUT');
    const useCase = new ProcessPaymentUseCase(adapter);

    const result = await useCase.execute({
      paymentId: 'pay-003',
      orderId: 'ord-003',
      amountCents: 15000,
      paymentMethodToken: 'tok_timeout_card',
      idempotencyKey: 'idem-pay-3',
    });

    expect(result.success).toBe(false);
    expect(result.transaction.status).toBe('TIMEOUT');
    expect(result.errorCode).toBe('PAYMENT_TIMEOUT');
    expect(result.transaction.failureReason).toContain('timed out');
  });

  it('Malformed Provider Response: Gracefully catches corrupt payload and sets transaction to FAILED', async () => {
    const adapter = new FakePaymentAdapter().setMode('MALFORMED');
    const useCase = new ProcessPaymentUseCase(adapter);

    const result = await useCase.execute({
      paymentId: 'pay-004',
      orderId: 'ord-004',
      amountCents: 1000,
      paymentMethodToken: 'tok_malformed_card',
      idempotencyKey: 'idem-pay-4',
    });

    expect(result.success).toBe(false);
    expect(result.transaction.status).toBe('FAILED');
    expect(result.errorCode).toBe('PAYMENT_FAILED');
  });

  it('ADVANCEMENT GATE: Order workflow depends on a domain-shaped interface, not vendor classes', async () => {
    // Implement an alternative third-party adapter (e.g. MockStripeAdapter) on the fly
    class MockStripeAdapter implements PaymentGateway {
      public async charge(request: ChargeRequest): Promise<ChargeResult> {
        // Simulates mapping Stripe SDK's stripe.charges.create() into domain ChargeResult
        return {
          status: 'SUCCESS',
          transactionId: `ch_stripe_${request.paymentId}`,
          rawResponse: { object: 'charge', id: `ch_stripe_${request.paymentId}`, paid: true },
        };
      }
    }

    const stripeAdapter = new MockStripeAdapter();

    // Pass new adapter into ProcessPaymentUseCase without changing ANY domain code!
    const useCase = new ProcessPaymentUseCase(stripeAdapter);

    const result = await useCase.execute({
      paymentId: 'pay-005',
      orderId: 'ord-005',
      amountCents: 7500,
      paymentMethodToken: 'tok_stripe_test',
      idempotencyKey: 'idem-pay-5',
    });

    expect(result.success).toBe(true);
    expect(result.transaction.status).toBe('CAPTURED');
    expect(result.transaction.providerTransactionId).toBe('ch_stripe_pay-005');
  });
});
