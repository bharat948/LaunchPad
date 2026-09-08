import { DomainEvent } from './DomainEvent.js';

export type UpcasterFn = (legacyData: Record<string, unknown>) => Record<string, unknown>;

export class EventSerializer {
  private static upcasters = new Map<string, UpcasterFn>();

  /**
   * Registers a schema migration upcaster for an event type and version transition
   */
  public static registerUpcaster(
    eventType: string,
    fromVersion: number,
    toVersion: number,
    upcaster: UpcasterFn
  ): void {
    const key = `${eventType}:${fromVersion}->${toVersion}`;
    this.upcasters.set(key, upcaster);
  }

  public static clearUpcasters(): void {
    this.upcasters.clear();
  }

  /**
   * Serializes a DomainEvent into a JSON string with envelope validation
   */
  public static serialize<T>(event: DomainEvent<T>): string {
    if (!event.eventId) throw new Error('DomainEvent must have an eventId');
    if (!event.eventType) throw new Error('DomainEvent must have an eventType');
    if (!event.aggregateId) throw new Error('DomainEvent must have an aggregateId');
    if (!event.version || event.version < 1) throw new Error('DomainEvent must have a valid version >= 1');
    if (!event.occurredAt) throw new Error('DomainEvent must have an occurredAt timestamp');
    if (!event.producer) throw new Error('DomainEvent must have a producer name');
    if (event.data === undefined || event.data === null) {
      throw new Error('DomainEvent must have a data payload');
    }

    return JSON.stringify(event);
  }

  /**
   * Deserializes raw JSON into a typed DomainEvent with forward-compatibility tolerance
   */
  public static deserialize<T = Record<string, unknown>>(rawJson: string): DomainEvent<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`Failed to parse event JSON: ${err instanceof Error ? err.message : 'Invalid JSON'}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Deserialized event must be an object');
    }

    const event = parsed as Partial<DomainEvent<T>>;

    if (!event.eventId || typeof event.eventId !== 'string') {
      throw new Error('Invalid or missing eventId in event envelope');
    }
    if (!event.eventType || typeof event.eventType !== 'string') {
      throw new Error('Invalid or missing eventType in event envelope');
    }
    if (!event.aggregateId || typeof event.aggregateId !== 'string') {
      throw new Error('Invalid or missing aggregateId in event envelope');
    }
    if (typeof event.version !== 'number' || event.version < 1) {
      throw new Error('Invalid or missing version in event envelope');
    }
    if (!event.occurredAt || typeof event.occurredAt !== 'string') {
      throw new Error('Invalid or missing occurredAt in event envelope');
    }
    if (!event.producer || typeof event.producer !== 'string') {
      throw new Error('Invalid or missing producer in event envelope');
    }
    if (event.data === undefined || event.data === null) {
      throw new Error('Invalid or missing data payload in event envelope');
    }

    return event as DomainEvent<T>;
  }

  /**
   * Upcasts an event from its native version to a target version using registered upcasters
   */
  public static upcast<T = Record<string, unknown>>(
    event: DomainEvent<Record<string, unknown>>,
    targetVersion: number
  ): DomainEvent<T> {
    let currentVersion = event.version;
    let currentData = { ...event.data };

    while (currentVersion < targetVersion) {
      const nextVersion = currentVersion + 1;
      const key = `${event.eventType}:${currentVersion}->${nextVersion}`;
      const upcaster = this.upcasters.get(key);

      if (!upcaster) {
        throw new Error(
          `No upcaster registered for ${event.eventType} from version ${currentVersion} to ${nextVersion}`
        );
      }

      currentData = upcaster(currentData);
      currentVersion = nextVersion;
    }

    return {
      ...event,
      version: targetVersion,
      data: currentData as T,
    };
  }
}
