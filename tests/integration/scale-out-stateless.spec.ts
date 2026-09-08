import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { defaultCacheService } from '../../src/infrastructure/cache/RedisCacheService.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';
import { createApp } from '../../src/createApp.js';
import { RoundRobinLoadBalancer } from '../../src/infrastructure/loadbalancer/RoundRobinLoadBalancer.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/PostgresInventoryRepository.js';

describe('LAB-601: Stateless Scale-Out & Multi-Instance Load Balancing', () => {
  let loadBalancer: RoundRobinLoadBalancer;
  let proxyApp: ReturnType<RoundRobinLoadBalancer['createProxyApp']>;
  let inst1App: ReturnType<typeof createApp>;
  let inst2App: ReturnType<typeof createApp>;

  beforeEach(() => {
    loadBalancer = new RoundRobinLoadBalancer();
    inst1App = createApp({ instanceId: 'inst-1' });
    inst2App = createApp({ instanceId: 'inst-2' });

    loadBalancer.registerInstance('inst-1', inst1App);
    loadBalancer.registerInstance('inst-2', inst2App);
    proxyApp = loadBalancer.createProxyApp();
  });

  it('Alternating Requests: Requests alternate instances without user-visible inconsistency', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Karan Aujla It Was All A Dream Tour')
      .withTicketType('VIP Area', 12000, 100)
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    // Request 1: Dispatched to inst-1 (Cold Cache Miss)
    const res1 = await request(proxyApp).get(`/api/events/${event.id}`);
    expect(res1.status).toBe(200);
    expect(res1.headers['x-served-by']).toBe('inst-1');
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.title).toBe('Karan Aujla It Was All A Dream Tour');

    // Request 2: Dispatched to inst-2 (Warm Cache Hit from shared Redis!)
    const res2 = await request(proxyApp).get(`/api/events/${event.id}`);
    expect(res2.status).toBe(200);
    expect(res2.headers['x-served-by']).toBe('inst-2');
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body).toEqual(res1.body);

    // Request 3: Dispatched back to inst-1 (Warm Cache Hit)
    const res3 = await request(proxyApp).get(`/api/events/${event.id}`);
    expect(res3.status).toBe(200);
    expect(res3.headers['x-served-by']).toBe('inst-1');
    expect(res3.headers['x-cache']).toBe('HIT');

    // Request 4: Dispatched back to inst-2 (Warm Cache Hit)
    const res4 = await request(proxyApp).get(`/api/events/${event.id}`);
    expect(res4.status).toBe(200);
    expect(res4.headers['x-served-by']).toBe('inst-2');
    expect(res4.headers['x-cache']).toBe('HIT');

    const stats = loadBalancer.getStats();
    expect(stats['inst-1']).toBe(2);
    expect(stats['inst-2']).toBe(2);
  });

  it('Cross-Instance Write & Invalidation: Update on inst-1 is immediately visible on inst-2', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Coldplay Ahmedabad Night 2')
      .withTicketType('Standard', 4500, 500)
      .inStatus(EventStatus.SCHEDULED)
      .persist(pool);

    // 1. Prime cache via inst-1
    const read1 = await request(inst1App).get(`/api/events/${event.id}`);
    expect(read1.headers['x-served-by']).toBe('inst-1');
    expect(read1.body.status).toBe(EventStatus.SCHEDULED);

    // Verify inst-2 reads the cached SCHEDULED status
    const read2 = await request(inst2App).get(`/api/events/${event.id}`);
    expect(read2.headers['x-served-by']).toBe('inst-2');
    expect(read2.headers['x-cache']).toBe('HIT');
    expect(read2.body.status).toBe(EventStatus.SCHEDULED);

    // 2. Perform write on inst-1 (PATCH status to LIVE)
    const patchRes = await request(inst1App)
      .patch(`/api/events/${event.id}/status`)
      .send({ status: EventStatus.LIVE });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe(EventStatus.LIVE);

    // 3. Read immediately on inst-2!
    // inst-1 invalidated the shared Redis key; inst-2 MUST see fresh LIVE status!
    const read3 = await request(inst2App).get(`/api/events/${event.id}`);
    expect(read3.headers['x-served-by']).toBe('inst-2');
    expect(read3.headers['x-cache']).toBe('MISS'); // Cache was cleared across instances
    expect(read3.body.status).toBe(EventStatus.LIVE);
  });

  it('Cross-Instance Atomic Reservation: 50 concurrent claims across inst-1 and inst-2 maintain zero-oversell', async () => {
    const TOTAL_CAPACITY = 2;
    const { event, ticketTypeIds } = await EventFixtureBuilder.anEvent()
      .withTitle('Taylor Swift Era Tour Scaled')
      .withTicketType('Front Row VIP', 50000, TOTAL_CAPACITY)
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    const ticketTypeId = ticketTypeIds[0];
    const TOTAL_CONTENDERS = 50;

    // Direct repository access simulating concurrent requests handled across both instances
    const repo1 = new PostgresInventoryRepository();
    const repo2 = new PostgresInventoryRepository();

    const contenders = Array.from({ length: TOTAL_CONTENDERS }, (_, index) => {
      // Alternate between instance 1 repo and instance 2 repo
      const activeRepo = index % 2 === 0 ? repo1 : repo2;
      return activeRepo.reserveAtomic(ticketTypeId, 1, `user-${index}`);
    });

    const results = await Promise.all(contenders);

    const successes = results.filter(r => r.success);
    const soldOuts = results.filter(r => !r.success && r.message === 'SOLD_OUT');

    // Exactly 2 succeed, 48 rejected
    expect(successes).toHaveLength(TOTAL_CAPACITY);
    expect(soldOuts).toHaveLength(TOTAL_CONTENDERS - TOTAL_CAPACITY);

    // Verify DB inventory invariant in PostgreSQL
    const poolState = await pool.query(
      'SELECT available_qty, reserved_qty FROM inventory_pools WHERE ticket_type_id = $1',
      [ticketTypeId]
    );
    expect(poolState.rows[0].available_qty).toBe(0);
    expect(poolState.rows[0].reserved_qty).toBe(TOTAL_CAPACITY);
  });

  it('ADVANCEMENT GATE: Kill one instance during read traffic (Seamless Failover with 0 Dropped Requests)', async () => {
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('High Availability Festival')
      .inStatus(EventStatus.LIVE)
      .persist(pool);

    const TOTAL_REQUESTS = 100;
    const KILL_AT_REQUEST = 40;
    const responses: Array<{ status: number; servedBy: string }> = [];

    for (let i = 1; i <= TOTAL_REQUESTS; i++) {
      if (i === KILL_AT_REQUEST) {
        // 🔥 Simulate hard crash / OOM kill of instance 1
        loadBalancer.killInstance('inst-1');
      }

      const res = await request(proxyApp).get(`/api/events/${event.id}`);
      responses.push({
        status: res.status,
        servedBy: res.headers['x-served-by'],
      });
    }

    // 1. Every single request succeeded with HTTP 200 (Zero 5xx errors or dropped connections)
    expect(responses).toHaveLength(TOTAL_REQUESTS);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    // 2. Before request 40, traffic alternated between inst-1 and inst-2
    const beforeKill = responses.slice(0, KILL_AT_REQUEST - 1);
    const inst1Before = beforeKill.filter(r => r.servedBy === 'inst-1');
    const inst2Before = beforeKill.filter(r => r.servedBy === 'inst-2');
    expect(inst1Before.length).toBeGreaterThan(15);
    expect(inst2Before.length).toBeGreaterThan(15);

    // 3. After request 40, 100% of traffic seamlessly failed over to inst-2!
    const afterKill = responses.slice(KILL_AT_REQUEST - 1);
    const inst1After = afterKill.filter(r => r.servedBy === 'inst-1');
    const inst2After = afterKill.filter(r => r.servedBy === 'inst-2');

    expect(inst1After).toHaveLength(0); // inst-1 received zero requests after kill
    expect(inst2After).toHaveLength(afterKill.length); // inst-2 handled 100% of failover traffic
  });
});
