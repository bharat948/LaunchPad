export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class TestClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date = new Date('2026-10-01T12:00:00.000Z')) {
    this.currentTime = new Date(initialTime.getTime());
  }

  public now(): Date {
    return new Date(this.currentTime.getTime());
  }

  public setNow(date: Date): void {
    this.currentTime = new Date(date.getTime());
  }

  public advanceByMs(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }

  public advanceByMinutes(minutes: number): void {
    this.advanceByMs(minutes * 60 * 1000);
  }
}
