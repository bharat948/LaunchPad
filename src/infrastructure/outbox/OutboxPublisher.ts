import { IOutboxRepository } from './TransactionalOutboxRepository.js';
import { MessageBroker } from '../../shared/events/MessageBroker.js';
import { Clock, SystemClock } from '../../shared/domain/Clock.js';

export interface PublishBatchSummary {
  published: number;
  failed: number;
  remaining: number;
}

export class OutboxPublisher {
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private outboxRepo: IOutboxRepository,
    private broker: MessageBroker,
    private clock: Clock = new SystemClock()
  ) {}

  /**
   * Sweeps and publishes pending outbox messages to the broker.
   * Atomic within message boundary: each message is published, then marked published.
   */
  public async publishPending(batchSize: number = 50, aggregateId?: string): Promise<PublishBatchSummary> {
    const pending = await this.outboxRepo.fetchPendingBatch(batchSize, aggregateId);
    let published = 0;
    let failed = 0;

    for (const record of pending) {
      try {
        // Publish to message broker topic (topic defaults to eventType)
        await this.broker.publish(record.eventType, record.payload);

        // Mark published in database
        await this.outboxRepo.markPublished(record.id, this.clock.now());
        published++;
      } catch (err) {
        failed++;
        const errorMessage = err instanceof Error ? err.message : 'Unknown broker publish error';
        await this.outboxRepo.recordFailure(record.id, errorMessage);
      }
    }

    const remaining = await this.outboxRepo.countPending(aggregateId);
    return { published, failed, remaining };
  }

  /**
   * Starts background polling worker
   */
  public start(pollIntervalMs: number = 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        await this.publishPending();
      } catch (err) {
        // Background polling errors shouldn't crash the server
      }
      if (this.isRunning) {
        this.timer = setTimeout(poll, pollIntervalMs);
      }
    };

    this.timer = setTimeout(poll, pollIntervalMs);
  }

  /**
   * Stops background polling worker gracefully
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
