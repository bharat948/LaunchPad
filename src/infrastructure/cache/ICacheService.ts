export interface CacheMetrics {
  hits: number;
  misses: number;
  errors: number;
  sets: number;
  dels: number;
  hitRate: number; // percentage 0-100
}

export interface ICacheService {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  getMetrics(): CacheMetrics;
  resetMetrics(): void;
  close(): Promise<void>;
}
