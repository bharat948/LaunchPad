export type RequestPriority = 'HIGH' | 'NORMAL' | 'LOW';

export interface ConcurrencyLimiterOptions {
  maxConcurrent: number;
  lowPriorityThresholdRatio?: number; // e.g. 0.8 (shed LOW priority when >= 80% full)
}

export class ConcurrencyLimiter {
  private maxConcurrent: number;
  private lowPriorityThreshold: number;
  private activeRequests = 0;
  private totalAdmitted = 0;
  private totalShed = 0;

  constructor(options: ConcurrencyLimiterOptions) {
    this.maxConcurrent = options.maxConcurrent;
    const ratio = options.lowPriorityThresholdRatio ?? 0.8;
    this.lowPriorityThreshold = Math.floor(this.maxConcurrent * ratio);
  }

  /**
   * Attempts to acquire an execution slot based on request priority.
   * Returns true if admitted, false if shed.
   */
  public tryAcquire(priority: RequestPriority = 'NORMAL'): boolean {
    // 1. If at or above max capacity, reject all non-HIGH requests immediately
    if (this.activeRequests >= this.maxConcurrent) {
      this.totalShed++;
      return false;
    }

    // 2. Priority degradation: Shed LOW priority requests when approaching saturation
    if (priority === 'LOW' && this.activeRequests >= this.lowPriorityThreshold) {
      this.totalShed++;
      return false;
    }

    // 3. Admit request
    this.activeRequests++;
    this.totalAdmitted++;
    return true;
  }

  /**
   * Releases an execution slot upon request completion.
   */
  public release(): void {
    if (this.activeRequests > 0) {
      this.activeRequests--;
    }
  }

  public getStats() {
    const total = this.totalAdmitted + this.totalShed;
    const shedRate = total > 0 ? (this.totalShed / total) * 100 : 0;
    return {
      activeRequests: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      totalAdmitted: this.totalAdmitted,
      totalShed: this.totalShed,
      shedRate: Math.round(shedRate * 100) / 100,
    };
  }

  public resetStats(): void {
    this.activeRequests = 0;
    this.totalAdmitted = 0;
    this.totalShed = 0;
  }
}
