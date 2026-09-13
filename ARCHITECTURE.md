# Architecture

Object storage in → ffmpeg transcode → HLS packaging → object storage out → adaptive playback. A Postgres-backed job queue sits between upload and processing; a Hono server authenticates and proxies playback. LocalStack mimics S3 in dev; Cloudflare R2 is the production backend — the swap is one env var.

## 1. System diagram

```
                        ┌────────────────────────────────────────────┐
                        │        Object storage (LocalStack / R2)   │
 upload ── put ───────► │  raw-videos       processed-videos         │
                        │                                          │
                        └──────────────────▲───────────────────▲────┘
                                           │ put                │ get (proxy)
┌──────────┐  enqueue    ┌──────────────┐  │                    │   ┌───────────┐
│ uploads  │ ──────────► │     jobs     │  │                    │   │  server   │
│ (CLI)    │  insert     │  (Postgres)  │  │   download         │   │  (Hono)   │
└──────────┘ ─── put ──► └──────▲───────┘  │   transcode        │   │  healthz  │
                               │ claim/     │   thumbnails ─────┘   │  proxy    │
                               │ complete/  │   upload              │  metrics  │
                               │ fail/      │                       └─────┬─────┘
                               │ recycle    └───────┐                      │
                               ▼                      ▼                      ▼
                         ┌────────────┐    ┌──────────────┐            players /
                         │   worker   │ ◄──│  watchdog    │            browsers
                         └────────────┘    └──────────────┘
                          (polls PG,        (spawns + restarts
                           drives ffmpeg)    worker on crash)
```

Three processes, all run via `pnpm` scripts:

| Process | Script | Role |
| --- | --- | --- |
| **server** | `pnpm dev` | HTTP API: health, metrics, authenticated playback proxy, signed URLs, uptime pings |
| **worker** | `pnpm worker` | Polls Postgres, downloads sources, runs ffmpeg, uploads HLS + thumbnails |
| **watchdog** | `pnpm watchdog` | Supervises the worker; restarts it with backoff on crash |

## 2. Data flow

1. **Upload** — `pnpm upload <file> [--key <idempotency-key>]` PUTs the raw file to `raw-videos` and inserts a job row (idempotency key defaults to the filename, so re-running the same file never double-queues).
2. **Enqueue** — `enqueueJob(source, key)` does `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` and reports whether a new job was created.
3. **Claim** — the worker polls `claimNextJob()`: a single `UPDATE ... WHERE id = (SELECT ... WHERE status='pending' AND next_attempt_at <= now() ... FOR UPDATE SKIP LOCKED) RETURNING *` atomically claims the next eligible job with no race between concurrent workers.
4. **Process** — worker downloads the source to `tmp/`, runs the multi-bitrate HLS transcode, then optionally the thumbnail pass, then re-uploads everything into `processed-videos` under `{videoId}/…`.
5. **Serve** — the server's `/videos/*` proxy streams the object back with the right `Content-Type`/`Cache-Control`, gated by the optional `PLAYBACK_TOKEN`. A signed-URL variant is available at `/api/playback/:videoId`.

## 3. Storage layout (`processed-videos`)

```
{videoId}/
├── master.m3u8          # top-level HLS variant playlist
├── stream_0/{...}.ts    # 1080p segments + playlist.m3u8
├── stream_1/{...}.ts    # 720p
├── stream_2/{...}.ts    # 480p
└── thumbnails/
    ├── poster.jpg       # first rep. frame, 640x360
    ├── thumb-1.jpg .. thumb-3.jpg   # ~25/50/75% duration
    └── poster.webp etc. # webp variants
```

## 4. Job lifecycle

| Status | Meaning | Transition |
| --- | --- | --- |
| `pending` | queued, eligible (honors `next_attempt_at`) | → `processing` on claim |
| `processing` | claimed, worker running | → `done` / `pending` (retry) / `dead` |
| `done` | success | terminal |
| `dead` | final failure after `max_attempts` | terminal; `requeueDeadJob()` to rerun |
| `failed` | reserved for manual/legacy rows | (unused by the worker) |

```
                 enqueue
                   │
                   ▼
              ┌─────────┐   claim   ┌─────────────┐  success  ┌──────┐
   ──────────►│ pending │ ────────► │ processing  │ ─────────►│ done │
              └────▲────┘           └──────┬──────┘            └──────┘
   retry (backoff) │                       │ failure
    ┌──────────────┘                       │
    │         attempts < max               ▼
    │                              ┌───────────────┐
    └──────────────────────────────│  dead (if    │
                                   │ attempts >=  │
                                   │ max)         │
                                   └───────────────┘
         stuck (> TTL) ──────────► back to pending
```

## 5. Reliability model

Every failure path in the pipeline is covered:

1. **Idempotent enqueue** — a unique `idempotency_key` column makes double-uploads no-ops even when the uploader retries.
2. **Exponential-backoff retries** — on failure the job returns to `pending` with `next_attempt_at = now() + backoff(attempts)` (30s doubling to a 1h cap, jittered). `claimNextJob()` only sees due jobs.
3. **Dead-lettering** — after `max_attempts` (default 4) a job moves to `dead` with the `error` retained; `requeueDeadJob()` (a future CLI op) promotes it back. The queue never silently loses work.
4. **Stuck-job recycl** — `recycleStuckJobs(ttl)` runs every 60s in the worker and flips any `processing` job older than 2h back to `pending`. This covers a worker dying mid-job (the watchdog replaced the process, this reclaims its in-flight work).
5. **Graceful drain** — SIGTERM/SIGINT set a drain flag: the worker finishes the current job, completes/fails it, then exits 0.
6. **Watchdog** — `pnpm watchdog` spawns the worker, streams its output, and restarts it on non-zero exit after jittered backoff, capping consecutive crashes at 10 (then exits so an external supervisor can take over).
7. **Transient DB/storage errors don't crash** — `claimNextJob` and reclaim failures are caught and retried, not thrown as process-killing unhandled rejections.

## 6. Observability

- **Structured JSON logs** — every process logs newline-delimited JSON (`{ts, level, msg, ...fields}`) via `logger.ts`. Grep-able, pipe to any log shipper.
- **`GET /healthz`** — liveness: process up, uptime, pid. No dependencies, so it answers even when the stack is down.
- **`GET /readyz`** — readiness: pings Postgres (`SELECT 1`) and object storage (`HeadBucket`); returns 503 with per-component detail if either is down. Point load balancers/uptime monitors here.
- **`GET /metrics`** — Prometheus text: `segment_requests_total`, `segment_bytes_total`, `playback_404_total`, `playback_errors_total`, and `jobs_status{status=…}` gauges from the DB.
- **Segment-request logs** — every object served through the `/videos/*` proxy logs `{ key, bytes, ms }` (the `flush()` of the stream transform). This is your per-view/engagement signal in exchange for traffic.
- **Uptime pings** — when `UPTIME_PING_URL` is set (Healthchecks.io / UptimeRobot style), the server GETs it on boot and every `UPTIME_PING_INTERVAL_MS`.

## 7. Playback & security

- **Private buckets** — the `processed-videos` bucket is not required to be public. All playback goes through the server.
- **Proxy route** (`GET /videos/{key}`) — streams R2 objects through Hono; sets correct `Content-Type` per file and `Cache-Control` (`immutable` for `.ts`/images, `no-store` for `.m3u8`). This single choke point is what enables both auth and per-segment logs.
- **Bearer auth** — if `PLAYBACK_TOKEN` is set, `/videos/*` and `/api/playback/:videoId` require `Authorization: Bearer <token>`. If unset the proxy is open (dev mode); do not run production with it empty.
- **Signed URLs** — `signing.ts` (powered by `@aws-sdk/s3-request-presigner`) can mint expiring URLs for any object; exposed as `/api/playback/:videoId` returning the master playlist URL. Useful later for handing short-lived URLs to clients without burning proxy bandwidth.
- **Content-type + cache hygiene** — manifests are `no-store` (relatively cheap, always fresh), segments and images cache long, so a CDN in front would behave correctly out of the box.

## 8. Thumbnails

`THUMBNAILS=true` (default) triggers a second ffmpeg pass after the HLS encode:

1. `probeDuration()` uses `ffprobe` for the source length.
2. `runFfmpegThumbnails()` extracts 4 frames (poster + 25/50/75% offsets, clamped to the clip), each as a 640px-wide JPEG **and** WebP.
3. Output is uploaded to `{videoId}/thumbnails/`.

## 9. Configuration

All knobs live in `.env` (see `.env.example`). Grouped:

- **Storage**: `STORAGE_ENV`, LocalStack/R2 credentials, `RAW_BUCKET`, `PROCESSED_BUCKET`
- **Queue**: `DATABASE_URL`, `MAX_ATTEMPTS`, `RETRY_BASE_MS`, `RETRY_CAP_MS`, `STUCK_JOB_TTL_MIN`
- **Features**: `THUMBNAILS`
- **HTTP**: `PORT`, `PLAYBACK_TOKEN`
- **Uptime**: `UPTIME_PING_URL`, `UPTIME_PING_INTERVAL_MS`
- **Reserved**: `ADMIN_TOKEN` (future authenticated enqueue endpoint)

## 10. Why Postgres as the job queue?

- It's already here (docker-compose) — no extra service for Redis/BullMQ or SQS.
- `FOR UPDATE SKIP LOCKED` is the canonical safe-concurrency claim pattern; it scales to several concurrent workers.
- Transactions guarantee no job is lost between enqueue and claim; the table doubles as an audit trail.
- The schema additions (attempts, `next_attempt_at`, dead-lettering) fold in what queuing platforms call retries and visibility timeouts, so this approach stays adequate well beyond current volume.

Revisit when: fanout to many consumers with bursty large jobs, per-job priority/scheduling semantics, or managed-queue visibility/TTL features become necessary.

## 11. Scripts

| Command | What it runs |
| --- | --- |
| `pnpm dev` | Hono API server |
| `pnpm worker` | Single foreground worker (dev/debug) |
| `pnpm watchdog` | Supervisor that keeps a worker alive |
| `pnpm upload <file> [--key k]` | Push a file + enqueue idempotently |

## 12. Known gaps / future work

- Front the proxy with a CDN for global delivery (free Cloudflare plan).
- Authenticated enqueue endpoint (`POST /api/videos`) using `ADMIN_TOKEN`.
- `requeueDeadJob` exposed as a CLI/`pnpm` op.
- DRM, live streaming, MP4/static renditions, real-time QoE analytics — see `LIMITS-and-COSTS.md`.