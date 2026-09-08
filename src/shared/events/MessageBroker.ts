import { DomainEvent } from './DomainEvent.js';

export type MessageHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

/**
 * MessageBroker Port: Decouples core application logic from message transports (Kafka, RabbitMQ, Redis, In-Memory)
 */
export interface MessageBroker {
  publish(topic: string, event: DomainEvent): Promise<void>;
  subscribe(topic: string, handler: MessageHandler): Promise<void>;
}

/**
 * InMemoryMessageBroker: Production-like broker simulator for hermetic unit, integration, and fault-injection testing.
 */
export class InMemoryMessageBroker implements MessageBroker {
  private handlers = new Map<string, MessageHandler[]>();
  public publishedMessages: { topic: string; event: DomainEvent }[] = [];
  public isDown: boolean = false;
  public failCount: number = 0;

  public async publish(topic: string, event: DomainEvent): Promise<void> {
    if (this.isDown) {
      throw new Error(`[MessageBroker Error]: Broker is down / connection refused for topic ${topic}`);
    }

    if (this.failCount > 0) {
      this.failCount--;
      throw new Error(`[MessageBroker Error]: Simulated transient broker timeout on topic ${topic}`);
    }

    this.publishedMessages.push({ topic, event });

    // Asynchronously dispatch to subscribers to mimic network decoupling
    const topicHandlers = this.handlers.get(topic) || [];
    for (const handler of topicHandlers) {
      // Intentionally do not await handler here to decouple publish latency from consumer execution
      setImmediate(async () => {
        try {
          await handler(event);
        } catch (err) {
          // Unhandled consumer errors are handled by consumer retry/DLQ mechanics
        }
      });
    }
  }

  public async subscribe(topic: string, handler: MessageHandler): Promise<void> {
    const existing = this.handlers.get(topic) || [];
    existing.push(handler);
    this.handlers.set(topic, existing);
  }

  public getMessagesForTopic(topic: string): DomainEvent[] {
    return this.publishedMessages
      .filter((m) => m.topic === topic)
      .map((m) => m.event);
  }

  public clear(): void {
    this.publishedMessages = [];
    this.handlers.clear();
    this.isDown = false;
    this.failCount = 0;
  }
}
