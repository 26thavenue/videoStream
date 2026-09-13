-- migrations/001_init.sql
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  error TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);