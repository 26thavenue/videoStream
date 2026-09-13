import { Pool } from "pg";
import { databaseUrl, maxAttempts } from "./config";
import { backoffDelay } from "./backoff";

export type JobStatus = "pending" | "processing" | "done" | "failed" | "dead";

export interface Job {
  id: number;
  source_key: string;
  status: JobStatus;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  started_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueResult {
  job: Job;
  created: boolean;
}

const pool = new Pool({ connectionString: databaseUrl });

export async function dbPing(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function enqueueJob(sourceKey: string, idempotencyKey?: string): Promise<EnqueueResult> {
  if (idempotencyKey) {
    const inserted = await pool.query<Job>(
      `INSERT INTO jobs (source_key, idempotency_key, max_attempts)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [sourceKey, idempotencyKey, maxAttempts]
    );
    if (inserted.rows.length > 0) {
      return { job: inserted.rows[0], created: true };
    }
    const existing = await pool.query<Job>(
      "SELECT * FROM jobs WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return { job: existing.rows[0], created: false };
  }

  const res = await pool.query<Job>(
    "INSERT INTO jobs (source_key, max_attempts) VALUES ($1, $2) RETURNING *",
    [sourceKey, maxAttempts]
  );
  return { job: res.rows[0], created: true };
}

export async function claimNextJob(): Promise<Job | null> {
  const res = await pool.query<Job>(`
    UPDATE jobs SET
      status = 'processing',
      attempts = attempts + 1,
      started_at = now(),
      next_attempt_at = NULL,
      updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return res.rows[0] ?? null;
}

export async function completeJob(id: number): Promise<void> {
  await pool.query(
    "UPDATE jobs SET status = 'done', error = NULL, next_attempt_at = NULL, updated_at = now() WHERE id = $1",
    [id]
  );
}

export async function failJob(id: number, error: unknown): Promise<"retry" | "dead"> {
  const errText = String(error);
  const res = await pool.query<Pick<Job, "attempts" | "max_attempts">>(
    "SELECT attempts, max_attempts FROM jobs WHERE id = $1",
    [id]
  );
  const job = res.rows[0];
  if (!job) return "dead";

  if (job.attempts >= job.max_attempts) {
    await pool.query(
      "UPDATE jobs SET status = 'dead', error = $2, next_attempt_at = NULL, updated_at = now() WHERE id = $1",
      [id, errText]
    );
    return "dead";
  }

  const delay = backoffDelay(job.attempts);
  await pool.query(
    `UPDATE jobs SET
       status = 'pending',
       error = $2,
       next_attempt_at = now() + ($3 * interval '1 millisecond'),
       updated_at = now()
     WHERE id = $1`,
    [id, errText, delay]
  );
  return "retry";
}

export async function recycleStuckJobs(ttlMs: number): Promise<number> {
  const res = await pool.query(
    `UPDATE jobs SET
       status = 'pending',
       started_at = NULL,
       error = CASE
         WHEN error IS NULL THEN 'recycled: stuck in processing'
         ELSE error || '; recycled: stuck in processing'
       END,
       updated_at = now()
     WHERE status = 'processing'
       AND started_at < now() - ($1 * interval '1 millisecond')
     RETURNING id`,
    [ttlMs]
  );
  return res.rowCount ?? 0;
}

export async function requeueDeadJob(id: number): Promise<Job | null> {
  const res = await pool.query<Job>(
    `UPDATE jobs SET
       status = 'pending',
       attempts = 0,
       error = NULL,
       next_attempt_at = now(),
       updated_at = now()
     WHERE id = $1 AND status = 'dead'
     RETURNING *`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function jobCounts(): Promise<Record<JobStatus, number>> {
  const counts: Record<JobStatus, number> = {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    dead: 0,
  };
  const res = await pool.query<{ status: JobStatus; count: number }>(
    "SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status"
  );
  for (const row of res.rows) counts[row.status] = row.count;
  return counts;
}