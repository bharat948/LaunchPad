-- Migration: 004_create_idempotency_keys_table.sql
-- Purpose: Persist idempotency keys, request fingerprints, and cached HTTP responses for safe client retries

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255),
  request_path VARCHAR(255) NOT NULL,
  request_method VARCHAR(16) NOT NULL,
  request_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of canonical request body
  status VARCHAR(32) NOT NULL, -- 'IN_PROGRESS', 'COMPLETED', 'FAILED'
  response_status_code INT,
  response_headers JSONB,
  response_body JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  locked_until TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);
