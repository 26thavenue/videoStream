-- migrations/002_reliability.sql
ALTER TABLE jobs
  ADD COLUMN idempotency_key TEXT UNIQUE,
  ADD COLUMN attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 4,
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, next_attempt_at);