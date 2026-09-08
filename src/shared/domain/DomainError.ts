export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidTimeWindowError extends DomainError {
  constructor(message: string = 'startAt must be strictly before endAt') {
    super(message);
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string = 'Money amount must be a non-negative integer') {
    super(message);
  }
}

export class InvalidCapacityError extends DomainError {
  constructor(message: string = 'Capacity must be greater than zero') {
    super(message);
  }
}

export class EmptyTicketTypesError extends DomainError {
  constructor(message: string = 'Event must have at least one ticket type before scheduling or publishing') {
    super(message);
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(fromStatus: string, toStatus: string) {
    super(`Cannot transition event status from ${fromStatus} to ${toStatus}`);
  }
}

export class InsufficientInventoryError extends DomainError {
  constructor(message: string = 'Requested quantity exceeds available inventory') {
    super(message);
  }
}
