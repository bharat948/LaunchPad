import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server.js';
import { runMigrations } from '../../src/infrastructure/db/runMigrations.js';
import { pool } from '../../src/infrastructure/db/postgres.js';
import { EventFixtureBuilder } from '../fixtures/EventFixtureBuilder.js';
import { EventStatus } from '../../src/modules/catalog/domain/EventStatus.js';

describe('LAB-102: Event REST API Integration Tests', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  let testEventId: string;

  beforeEach(async () => {
    // Isolated fixture for each test to guarantee 100% order-independence under randomized execution
    const { event } = await EventFixtureBuilder.anEvent()
      .withTitle('Integration Test Concert')
      .withTicketType('General Admission', 3500, 200)
      .inStatus(EventStatus.DRAFT)
      .persist(pool);

    testEventId = event.id;
  });

  describe('POST /api/events', () => {
    it('should create an Event with ticket types and return 201 Created', async () => {
      const payload = {
        organizerId: 'org-test-100',
        title: 'Backend Systems Summit',
        saleStartAt: '2026-12-01T10:00:00.000Z',
        saleEndAt: '2026-12-01T18:00:00.000Z',
        ticketTypes: [
          {
            name: 'Standard Tier',
            priceCents: 3500,
            currency: 'USD',
            capacity: 250,
          },
          {
            name: 'VIP Tier',
            priceCents: 9900,
            currency: 'USD',
            capacity: 25,
          },
        ],
      };

      const response = await request(app)
        .post('/api/events')
        .set('X-Correlation-ID', 'integration-test-corr-id')
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.headers['x-correlation-id']).toBe('integration-test-corr-id');
      expect(response.headers['location']).toBe(`/api/events/${response.body.id}`);

      expect(response.body).toHaveProperty('id');
      expect(response.body.title).toBe('Backend Systems Summit');
      expect(response.body.status).toBe('DRAFT');
      expect(response.body.ticketTypes.length).toBe(2);
    });

    it('should reject invalid TimeWindow with 400 Bad Request', async () => {
      const payload = {
        organizerId: 'org-test-100',
        title: 'Bad Dates Summit',
        saleStartAt: '2026-12-01T18:00:00.000Z',
        saleEndAt: '2026-12-01T10:00:00.000Z',
      };

      const response = await request(app).post('/api/events').send(payload);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('INVALID_TIME_WINDOW_ERROR');
    });

    it('should reject malformed JSON with 400 Bad Request', async () => {
      const response = await request(app)
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .send('{ "title": "Malformed", ');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MALFORMED_JSON');
    });
  });

  describe('GET /api/events/:id', () => {
    it('should retrieve created event details with 200 OK', async () => {
      const response = await request(app).get(`/api/events/${testEventId}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(testEventId);
      expect(response.body.title).toBe('Integration Test Concert');
    });

    it('should return 404 Not Found for non-existent event ID', async () => {
      const response = await request(app).get('/api/events/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('EVENT_NOT_FOUND');
    });
  });

  describe('PATCH /api/events/:id/status', () => {
    it('should transition status from DRAFT to SCHEDULED with 200 OK', async () => {
      const response = await request(app)
        .patch(`/api/events/${testEventId}/status`)
        .send({ status: 'SCHEDULED' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('SCHEDULED');
    });

    it('should transition status from SCHEDULED to LIVE with 200 OK', async () => {
      // First move to SCHEDULED
      await request(app).patch(`/api/events/${testEventId}/status`).send({ status: 'SCHEDULED' });

      const response = await request(app)
        .patch(`/api/events/${testEventId}/status`)
        .send({ status: 'LIVE' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('LIVE');
    });

    it('should be idempotent when called with current status', async () => {
      const response = await request(app)
        .patch(`/api/events/${testEventId}/status`)
        .send({ status: 'DRAFT' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('DRAFT');
    });

    it('should return 409 Conflict when attempting invalid status jump', async () => {
      // Transition to CANCELLED
      await request(app).patch(`/api/events/${testEventId}/status`).send({ status: 'CANCELLED' });

      // Attempt invalid jump from CANCELLED to SCHEDULED
      const response = await request(app)
        .patch(`/api/events/${testEventId}/status`)
        .send({ status: 'SCHEDULED' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION_ERROR');
    });
  });
});
