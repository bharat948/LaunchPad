import { describe, it, expect } from 'vitest';
import { InMemoryTokenBucketStrategy } from '../../src/infrastructure/ratelimit/InMemoryTokenBucketStrategy.js';
import { TestClock } from '../../src/shared/domain/Clock.js';

describe('LAB-602: Token Bucket Rate Limiter Algorithm & Mathematics', () => {
  it('Burst: Permits requests up to maximum burst capacity C', async () => {
    const clock = new TestClock();
    const limiter = new InMemoryTokenBucketStrategy({
      capacity: 5,
      refillRate: 1, // 1 token per second
      clock,
    });

    const KEY = 'client-burst-1';

    // 5 consecutive requests should all succeed
    for (let i = 0; i < 5; i++) {
      const res = await limiter.consume(KEY, 1);
      expect(res.allowed).toBe(true);
      expect(res.limit).toBe(5);
      expect(res.remaining).toBe(4 - i);
      expect(res.retryAfterSeconds).toBe(0);
    }
  });

  it('Boundary Condition: Reject request C + 1 when bucket is depleted', async () => {
    const clock = new TestClock();
    const limiter = new InMemoryTokenBucketStrategy({
      capacity: 3,
      refillRate: 1, // 1 token per second
      clock,
    });

    const KEY = 'client-boundary-1';

    // Consume all 3 tokens
    await limiter.consume(KEY, 1);
    await limiter.consume(KEY, 1);
    await limiter.consume(KEY, 1);

    // Request 4 should be throttled
    const throttled = await limiter.consume(KEY, 1);
    expect(throttled.allowed).toBe(false);
    expect(throttled.remaining).toBe(0);
    expect(throttled.limit).toBe(3);
    expect(throttled.retryAfterSeconds).toBe(1); // Needs 1 second to replenish 1 token
    expect(throttled.resetMs).toBe(1000);
  });

  it('Replenishment: Refills tokens deterministically with time passage (delta_t * rate)', async () => {
    const clock = new TestClock();
    const limiter = new InMemoryTokenBucketStrategy({
      capacity: 10,
      refillRate: 2, // 2 tokens per second
      clock,
    });

    const KEY = 'client-replenish-1';

    // Drain all 10 tokens
    for (let i = 0; i < 10; i++) {
      await limiter.consume(KEY, 1);
    }

    // Verify empty
    const emptyCheck = await limiter.consume(KEY, 1);
    expect(emptyCheck.allowed).toBe(false);

    // Advance time by 3 seconds -> replenishes 3 * 2 = 6 tokens
    clock.advanceByMs(3000);

    // Should be able to consume exactly 6 requests
    for (let i = 0; i < 6; i++) {
      const res = await limiter.consume(KEY, 1);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(5 - i);
    }

    // Request 7 should fail
    const overLimit = await limiter.consume(KEY, 1);
    expect(overLimit.allowed).toBe(false);
  });

  it('Capacity Ceiling: Tokens never exceed maximum capacity even after long idle times', async () => {
    const clock = new TestClock();
    const limiter = new InMemoryTokenBucketStrategy({
      capacity: 5,
      refillRate: 2,
      clock,
    });

    const KEY = 'client-ceiling-1';

    // Advance time by 1 hour (3600 seconds = 7200 tokens theoretically)
    clock.advanceByMs(3600 * 1000);

    // Consume 1 token; remaining should be 4 (clamped to capacity 5)
    const res = await limiter.consume(KEY, 1);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(4);
  });
});
