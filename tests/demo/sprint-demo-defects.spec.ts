import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../../src/server.js';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { Event } from '../../src/modules/catalog/domain/Event.js';
import { TimeWindow } from '../../src/modules/catalog/domain/TimeWindow.js';
import { Money } from '../../src/modules/catalog/domain/Money.js';
import { InvalidCapacityError } from '../../src/shared/domain/DomainError.js';
import { NaiveInventoryRepository } from '../../src/modules/inventory/infrastructure/NaiveInventoryRepository.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/PostgresInventoryRepository.js';

describe('LAB-403: Sprint Demo - Breaking Three Architectural Layers', () => {
  const naiveRepo = new NaiveInventoryRepository();
  const atomicRepo = new PostgresInventoryRepository();

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  // =========================================================================
  // DEMO 1: BREAKING A DOMAIN RULE (Layer 1 - Unit Test Catch)
  // =========================================================================
  it('Demo 1 (Domain Rule Defect): Negative ticket capacity is rejected at Domain Boundary', () => {
    const window = new TimeWindow(new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T20:00:00Z'));
    const event = Event.create('evt-demo-1', 'org-demo', 'Broken Rule Event', window);
    const price = new Money(5000, 'USD');

    console.log('\n[Demo 1] Intentionally breaking domain invariant with negative capacity (-50)...');
    
    // Breaking action: adding -50 tickets
    expect(() => {
      event.addTicketType('tt-broken', 'VIP Broken', price, -50);
    }).toThrow(InvalidCapacityError);

    console.log('  -> CAUGHT by Layer 1 Domain Unit Invariant! (No DB or HTTP involved)\n');
  });

  // =========================================================================
  // DEMO 2: BREAKING AN API SCHEMA CONTRACT (Layer 2 - Integration Test Catch)
  // =========================================================================
  it('Demo 2 (API Schema Contract Defect): Missing required fields return 400 Validation Error', async () => {
    console.log('[Demo 2] Intentionally breaking API schema with missing title & organizerId...');

    // Breaking action: payload missing title and organizerId
    const brokenPayload = {
      saleStartAt: '2026-12-01T10:00:00.000Z',
      saleEndAt: '2026-12-01T18:00:00.000Z',
    };

    const response = await request(app).post('/api/events').send(brokenPayload);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    console.log(`  -> CAUGHT by Layer 2 REST Integration Test! (Status: ${response.status}, Code: ${response.body.error.code})\n`);
  });

  // =========================================================================
  // DEMO 3: BREAKING A CONCURRENCY PRIMITIVE (Layer 3 - Concurrency Test Catch)
  // =========================================================================
  it('Demo 3 (Concurrency Primitive Defect): Naive un-locked code oversells, while Atomic code protects capacity', async () => {
    const eventId = randomUUID();
    const naiveTicketTypeId = randomUUID();
    const atomicTicketTypeId = randomUUID();

    // 1. Seed two identical pools with Capacity = 1
    await pool.query(
      `INSERT INTO events (id, organizer_id, title, status, sale_start_at, sale_end_at)
       VALUES ($1, 'org-demo', 'Concurrency Demo', 'LIVE', NOW(), NOW() + INTERVAL '1 day')`,
      [eventId]
    );

    // Pool A (Naive target)
    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, 'Naive Tier', 1000, 'USD', 1)`,
      [naiveTicketTypeId, eventId]
    );
    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, 1, 1, 0, 0)`,
      [naiveTicketTypeId]
    );

    // Pool B (Atomic target)
    await pool.query(
      `INSERT INTO ticket_types (id, event_id, name, price_cents, currency, capacity)
       VALUES ($1, $2, 'Atomic Tier', 1000, 'USD', 1)`,
      [atomicTicketTypeId, eventId]
    );
    await pool.query(
      `INSERT INTO inventory_pools (ticket_type_id, total_capacity, available_qty, reserved_qty, sold_qty)
       VALUES ($1, 1, 1, 0, 0)`,
      [atomicTicketTypeId]
    );

    console.log('[Demo 3] Breaking concurrency primitive: 20 concurrent requests for 1 ticket...');

    // A) Run against Naive Un-locked code
    const naiveResults = await Promise.all(
      Array.from({ length: 20 }, () => naiveRepo.reserveNaive(naiveTicketTypeId, 1))
    );
    const naiveSuccessCount = naiveResults.filter(r => r.success).length;

    // B) Run against Atomic Pessimistic Locked code
    const atomicResults = await Promise.all(
      Array.from({ length: 20 }, (_, i) => atomicRepo.reserveAtomic(atomicTicketTypeId, 1, `demo-user-${i}`))
    );
    const atomicSuccessCount = atomicResults.filter(r => r.success).length;

    console.log(`  -> Naive (Broken Concurrency Primitive): ${naiveSuccessCount} users granted ticket (OVERSELL!)`);
    console.log(`  -> Atomic (Protected Primitive)        : ${atomicSuccessCount} user granted ticket (0% OVERSELL!)\n`);

    expect(naiveSuccessCount).toBeGreaterThan(1); // Defect demonstrated!
    expect(atomicSuccessCount).toBe(1); // Protected primitive holds invariant!
  });
});
