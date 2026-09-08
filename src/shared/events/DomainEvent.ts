export interface EventMetadata {
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  userId?: string;
}

/**
 * Standard Domain Event Envelope (CloudEvents / Event-Driven Architecture aligned)
 * 
 * Represents an immutable statement of fact that has occurred in the system.
 * Named strictly in the past tense (e.g., 'order.confirmed', 'reservation.expired').
 */
export interface DomainEvent<T = unknown> {
  /** Globally unique event identifier (UUID v4) */
  eventId: string;

  /** Domain-qualified event type in past tense: e.g. 'order.confirmed' */
  eventType: string;

  /** Identifier of the aggregate root that emitted this event (e.g., orderId) */
  aggregateId: string;

  /** Monotonically increasing schema version integer (e.g., 1, 2) */
  version: number;

  /** UTC ISO-8601 timestamp when the event occurred */
  occurredAt: string;

  /** Name of the producing service / bounded context */
  producer: string;

  /** The minimal, self-contained factual data payload */
  data: T;

  /** Optional distributed tracing and auditing metadata */
  metadata?: EventMetadata;
}
