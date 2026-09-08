/**
 * RequestCoalescer (Singleflight pattern)
 * 
 * Ensures that for any given key, only ONE in-flight asynchronous operation (e.g. database query)
 * executes at a time. Concurrent duplicate requests share the exact same in-flight Promise,
 * effectively preventing cache stampedes when hot keys expire or during cold boots.
 */
export class RequestCoalescer {
  private inFlight = new Map<string, Promise<unknown>>();
  private coalescedCount = 0;
  private primaryExecutions = 0;

  /**
   * Executes or shares an in-flight Promise for the specified key.
   */
  public async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.coalescedCount++;
      return existing as Promise<T>;
    }

    this.primaryExecutions++;
    const promise = fn()
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  public getStats() {
    return {
      activeInFlight: this.inFlight.size,
      primaryExecutions: this.primaryExecutions,
      coalescedCount: this.coalescedCount,
    };
  }

  public resetStats() {
    this.primaryExecutions = 0;
    this.coalescedCount = 0;
  }
}

export const defaultCoalescer = new RequestCoalescer();
