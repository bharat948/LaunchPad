-- Migration 003: Add Expiry Indexes & Partial Index for Expiration Scanner

-- In a high-traffic production system, millions of reservations will accumulate.
-- Indexing all rows on (status, expires_at) would consume large memory.
-- A Partial Index indexes ONLY rows where status = 'PENDING', keeping index size tiny!
CREATE INDEX IF NOT EXISTS idx_reservations_pending_expires 
ON reservations (expires_at) 
WHERE status = 'PENDING';
