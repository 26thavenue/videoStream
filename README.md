# VideoStream

Object storage in → ffmpeg transcode → HLS packaging → object storage out → adaptive streaming playback with a reliable, observable pipeline.

Upload a raw video, and the pipeline automatically transcodes it into multiple bitrates (1080p, 720p, 480p), packages the output as HLS (`.m3u8` + `.ts` segments), generates thumbnails, and stores it in a private bucket ready for any HLS player — served through an authenticated playback proxy.

Develop entirely offline against [LocalStack](https://github.com/localstack/localstack) (mocked S3), then switch to Cloudflare R2 in production by changing a single env var — no code changes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design and [LIMITS-and-COSTS.md](LIMITS-and-COSTS.md) for an honest self-hosted-vs-Mux comparison.

## Stack

- **TypeScript** + [Hono](https://hono.dev/) server (`@hono/node-server`)
- **ffmpeg** for multi-bitrate HLS transcoding + thumbnails
- **LocalStack** — local S3 emulation for development
- **Cloudflare R2** — S3-compatible object storage for production
- **Postgres** — job queue with retries, backoff, and dead-lettering
- **pnpm** package manager

## Features

- Multi-bitrate adaptive HLS (1080p / 720p / 480p) with `master.m3u8`
- Poster + scene thumbnails (JPEG + WebP) per video
- Reliable job queue: idempotent enqueue, exponential-backoff retries, dead-lettering, stuck-job recovery, graceful shutdown
- Worker watchdog that restarts the process on crash
- Observability: `/healthz`, `/readyz`, `/metrics`, structured JSON logs, segment-request logs, optional uptime pings
- Secure playback: private buckets behind an authenticated Hono proxy + signed-URL support

## Project structure

```
videoStream/
├── ARCHITECTURE.md          # system design
├── .env.example
├── package.json
├── migrations/
│   ├── 001_init.sql
│   └── 002_reliability.sql  # retries, idempotency, dead-letter
├── scripts/
│   └── init-buckets.sh
├── src/
│   ├── server.ts            # Hono API: health, metrics, playback proxy
│   └── utils/
│       ├── config.ts        # env-driven config, dev vs prod
│       ├── client.ts        # S3 client factory (LocalStack or R2)
│       ├── runner.ts        # ffmpeg HLS + thumbnail commands
│       ├── jobs.ts          # Postgres job queue (claim/retry/dead/recycle)
│       ├── backoff.ts       # exponential backoff w/ jitter
│       ├── worker.ts        # polls jobs and orchestrates the pipeline
│       ├── watchdog.ts      # restarts the worker on crash
│       ├── uploads.ts       # CLI: push a file + enqueue idempotently
│       ├── logger.ts        # JSON-lines logger
│       ├── health.ts        # readiness checks (DB + storage)
│       ├── auth.ts          # bearer-token middleware
│       ├── metrics.ts       # counters + Prometheus text
│       ├── ping.ts          # uptime beacons
│       └── signing.ts       # R2 signed URLs (s3-request-presigner)
└── tmp/                     # local scratch space for downloads/transcodes
```

## Requirements

- Node.js + [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (for LocalStack + Postgres)
- [ffmpeg](https://ffmpeg.org/) + `ffprobe` installed on the host or worker container
  (`apt-get install ffmpeg` on Debian, `brew install ffmpeg` on macOS)

## Quickstart

```bash
pnpm install
cp .env.example .env
pnpm dev          # API server on http://localhost:${PORT} (default 8081)
```

## Local development workflow

The full local loop uses LocalStack to emulate S3 so you never touch real cloud storage while iterating.

1. Bring up LocalStack + Postgres:

   ```bash
   docker compose up -d
   ```

2. Bootstrap buckets and apply migrations:

   ```bash
   ./scripts/init-buckets.sh
   psql $DATABASE_URL -f migrations/001_init.sql
   psql $DATABASE_URL -f migrations/002_reliability.sql
   ```

3. Terminal 1 — start the worker (+ server if you want playback):

   ```bash
   pnpm watchdog    # supervised worker (recommended)
   # or: pnpm worker
   pnpm dev         # separate terminal: API server
   ```

4. Terminal 2 — push a test video through the pipeline:

   ```bash
   pnpm upload ./sample.mp4
   ```

   Re-running the same upload is a no-op (idempotency key defaults to the filename).

5. Verify the output:

   ```bash
   awslocal s3 ls s3://processed-videos/sample/ --recursive
   ```

   You should see `master.m3u8`, `stream_0/`, `stream_1/`, `stream_2/` with `.ts` segments, and a `thumbnails/` folder.

6. Play it back through the proxy: `http://localhost:8081/videos/sample/master.m3u8`
   (protect with `PLAYBACK_TOKEN` in `.env` for anything non-local).

## `pnpm upload` options

```bash
pnpm upload ./video.mp4                 # idempotency key = filename
pnpm upload ./video.mp4 --key any-unique-string
```

## Switching to real Cloudflare R2

Only `.env` changes — nothing in the worker, ffmpeg runner, or job queue does.

```bash
STORAGE_ENV=production
R2_ACCOUNT_ID=xxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxx
R2_ENDPOINT=https://xxxxxxxx.r2.cloudflarestorage.com
```

### Creating the R2 buckets and API token

1. Cloudflare dashboard → **R2** → **Create bucket** → name it `raw-videos`, repeat for `processed-videos`.
2. **R2 → Manage API tokens → Create API token** → grant "Object Read & Write" scoped to both buckets.
3. Your account ID is on the R2 overview page or in the dashboard sidebar.

### Playback in production

Keep `processed-videos` **private** and use the server:

- `GET /videos/{key}` — proxy streams the object with correct content-type/cache headers (set `PLAYBACK_TOKEN` and send `Authorization: Bearer <token>`).
- `GET /api/playback/:videoId` — returns a presigned URL for the master playlist via `@aws-sdk/s3-request-presigner`.

### Triggers in production

- **R2 event notifications** (Cloudflare Queues) fire a message when an object lands in `raw-videos`; the worker consumes from a queue instead of polling Postgres.
- Simpler alternative: a small script calls `ListObjectsV2` on `raw-videos` every minute, diffs against the `jobs` table, and enqueues anything new.

## Reliability

- **Idempotent enqueue** — unique `idempotency_key`; retried uploads never double-queue.
- **Retries** — failures go back to `pending` with exponential backoff (30s → 1h cap, jittered) via `next_attempt_at`.
- **Dead-letter** — after `max_attempts` (default 4) a job lands in `dead` with its error retained for manual review.
- **Stuck-job recovery** — `processing` jobs older than `STUCK_JOB_TTL_MIN` (default 120) are recycled every 60s, covering a worker dying mid-job.
- **Graceful drain** — SIGTERM/SIGINT finish the current job, then exit cleanly.
- **Watchdog** — `pnpm watchdog` restarts the worker on crash with backoff (capped).
- **Resilient polling** — transient DB/storage errors are logged and retried, never crash the process.

## Observability

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness — process up, uptime, pid |
| `GET /readyz` | Readiness — checks Postgres + object storage, 503 on failure |
| `GET /metrics` | Prometheus text — served bytes/requests, jobs by status |

- **Structured logs** — all processes emit newline-delimited JSON via `logger.ts`.
- **Segment logs** — the playback proxy logs `{ key, bytes, ms }` per served object (your view-activity signal).
- **Uptime pings** — with `UPTIME_PING_URL` set, the server beats Healthchecks.io/UptimeRobot-style heartbeats.

## Postgres as the job queue — why

It's already running (docker-compose), `FOR UPDATE SKIP LOCKED` gives race-free claims, transactions guarantee no lost jobs, and the table doubles as an audit trail. Retries/visibility timeouts from managed queues are folded in as `attempts` + `next_attempt_at` + dead-lettering. Revisit Redis/BullMQ or SQS if you need priority scheduling or very high fanout. (Full rationale in [ARCHITECTURE.md#10](ARCHITECTURE.md#10)).

## Player

Point any HLS player at the proxy URL (or a signed URL):

```html
<video id="video" controls style="width:100%"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
  const video = document.getElementById('video');
  const src = 'http://localhost:8081/videos/sample/master.m3u8'; // add Authorization header if PLAYBACK_TOKEN is set

  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src; // native HLS support (Safari)
  }
</script>
```

For a browser player against a token-protected proxy you'd normally serve the token cookie-side and let the proxy check it, or switch to the signed-URL mode (`/api/playback/:videoId`) which needs no header.

## Environment variables

See [.env.example](.env.example) for a full annotated list:

| Variable | Description |
| --- | --- |
| `PORT` | HTTP server port (default `8081`) |
| `STORAGE_ENV` | `local` (LocalStack) or `production` (R2) |
| `LOCALSTACK_ENDPOINT` | LocalStack S3 endpoint (dev) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | LocalStack creds (dev) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` | R2 creds (prod) |
| `RAW_BUCKET` / `PROCESSED_BUCKET` | Bucket names |
| `DATABASE_URL` | Postgres connection string (job queue) |
| `MAX_ATTEMPTS` | Retries before dead-letter (default 4) |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` | Backoff range (default 30 000 / 3 600 000) |
| `STUCK_JOB_TTL_MIN` | Reclaim timeout for orphaned jobs (default 120) |
| `THUMBNAILS` | `false` to skip the thumbnail pass |
| `PLAYBACK_TOKEN` | Bearer token guarding `/videos/*` (empty = open, dev only) |
| `UPTIME_PING_URL` / `UPTIME_PING_INTERVAL_MS` | Optional uptime heartbeat |
| `ADMIN_TOKEN` | Reserved for the future authenticated enqueue endpoint |