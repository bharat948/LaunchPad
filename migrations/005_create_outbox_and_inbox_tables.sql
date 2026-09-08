-- Migration: 005_create_outbox_and_inbox_tables.sql
-- Purpose: Persist transactional outbox, consumer inbox deduplication, and dead letter records

CREATE TABLE IF NOT EXISTS outbox_messages (
  id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(128) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PUBLISHED', 'FAILED'
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_messages(aggregate_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  event_id VARCHAR(255) NOT NULL,
  consumer_name VARCHAR(128) NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED', -- 'COMPLETED', 'FAILED'
  PRIMARY KEY (event_id, consumer_name)
);

CREATE INDEX IF NOT EXISTS idx_inbox_processed_at ON inbox_messages(processed_at);

CREATE TABLE IF NOT EXISTS dead_letter_messages (
  id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL,
  consumer_name VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  attempts INT NOT NULL DEFAULT 1,
  failed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  replayed_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(32) NOT NULL DEFAULT 'DEAD' -- 'DEAD', 'REPLAYED', 'DISCARDED'
);

CREATE INDEX IF NOT EXISTS idx_dlq_status_failed ON dead_letter_messages(status, failed_at);
