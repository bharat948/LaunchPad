import { InvalidTimeWindowError } from '../../../shared/domain/DomainError.js';

export class TimeWindow {
  public readonly startAt: Date;
  public readonly endAt: Date;

  constructor(startAt: Date, endAt: Date) {
    if (!startAt || !endAt || isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      throw new InvalidTimeWindowError('Invalid Date instances provided to TimeWindow');
    }
    if (startAt.getTime() >= endAt.getTime()) {
      throw new InvalidTimeWindowError(`startAt (${startAt.toISOString()}) must be strictly before endAt (${endAt.toISOString()})`);
    }
    this.startAt = new Date(startAt.getTime());
    this.endAt = new Date(endAt.getTime());
  }

  public isActiveAt(date: Date): boolean {
    const time = date.getTime();
    return time >= this.startAt.getTime() && time <= this.endAt.getTime();
  }

  public equals(other: TimeWindow): boolean {
    return this.startAt.getTime() === other.startAt.getTime() && this.endAt.getTime() === other.endAt.getTime();
  }
}
