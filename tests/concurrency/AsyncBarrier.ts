/**
 * AsyncBarrier (Countdown Latch / Starting Gun)
 * 
 * Coordinates N concurrent asynchronous workers so they wait until all workers are ready,
 * and then releases them simultaneously on the exact same microsecond.
 * 
 * Prevents timing jitter in Promise.all where early promises execute before later promises are created.
 */
export class AsyncBarrier {
  private parties: number;
  private waitingCount: number = 0;
  private resolvers: Array<() => void> = [];
  private isReleased: boolean = false;

  constructor(parties: number) {
    if (parties <= 0) {
      throw new Error('Barrier parties count must be greater than 0');
    }
    this.parties = parties;
  }

  /**
   * Called by each worker. Pauses execution until all parties have called wait(),
   * or until release() is explicitly called.
   */
  public async wait(): Promise<void> {
    if (this.isReleased) return;

    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
      this.waitingCount++;

      if (this.waitingCount === this.parties) {
        this.release();
      }
    });
  }

  /**
   * Fires the starting gun, resolving all waiting worker promises simultaneously.
   */
  public release(): void {
    if (this.isReleased) return;
    this.isReleased = true;

    const currentResolvers = [...this.resolvers];
    this.resolvers = [];

    // Trigger all resolves on the same microtask turn
    for (const resolve of currentResolvers) {
      resolve();
    }
  }

  public get pendingWorkers(): number {
    return this.parties - this.waitingCount;
  }
}
