import express, { Express, Request, Response, NextFunction } from 'express';

export interface UpstreamInstance {
  name: string;
  app: Express;
  isHealthy: boolean;
}

export class RoundRobinLoadBalancer {
  private instances: UpstreamInstance[] = [];
  private currentIndex = 0;
  private stats: Record<string, number> = {};

  public registerInstance(name: string, app: Express): void {
    this.instances.push({ name, app, isHealthy: true });
    this.stats[name] = 0;
  }

  public killInstance(name: string): void {
    const instance = this.instances.find(i => i.name === name);
    if (instance) {
      instance.isHealthy = false;
    }
  }

  public restoreInstance(name: string): void {
    const instance = this.instances.find(i => i.name === name);
    if (instance) {
      instance.isHealthy = true;
    }
  }

  public getHealthyInstances(): UpstreamInstance[] {
    return this.instances.filter(i => i.isHealthy);
  }

  public getNextInstance(): UpstreamInstance | null {
    const healthy = this.getHealthyInstances();
    if (healthy.length === 0) return null;

    const instance = healthy[this.currentIndex % healthy.length];
    this.currentIndex = (this.currentIndex + 1) % healthy.length;
    this.stats[instance.name] = (this.stats[instance.name] || 0) + 1;
    return instance;
  }

  public getStats(): Record<string, number> {
    return { ...this.stats };
  }

  /**
   * Returns an Express application acting as the reverse proxy gateway
   */
  public createProxyApp(): Express {
    const proxyApp = express();

    // Catch-all route to dispatch to the next healthy instance
    proxyApp.use((req: Request, res: Response, next: NextFunction) => {
      const upstream = this.getNextInstance();
      if (!upstream) {
        res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'All upstream application instances are unhealthy or unavailable',
          },
        });
        return;
      }

      // Forward directly to upstream Express app
      upstream.app(req, res, next);
    });

    return proxyApp;
  }
}
