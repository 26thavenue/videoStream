# Limits & cost comparison: self-hosted ffmpeg pipeline vs Mux

This repo builds video infrastructure: upload to object storage → ffmpeg transcode to a multi-bitrate HLS ladder → HLS output back in object storage → playback with any HLS player. LocalStack for dev, Cloudflare R2 for prod, a tiny Postgres queue in between.

This file is a reality-check on that approach versus a managed video platform like [Mux](https://mux.com). Two parts:

1. What the self-hosted solution **cannot do** (or must do poorly/yourself) vs a platform.
2. An honest **cost breakdown** across video sizes and monthly volumes.

Rates referenced from `mux.com/pricing` and `developers.cloudflare.com/r2/pricing`, as of September 2026. Both change — re-verify before making real decisions.

---

## 1. Limitations of this solution vs a platform like Mux

### 1.1 You own the operations

This pipeline is a Postgres queue + a polling worker + ffmpeg running on a box you manage. You are on call for:

- worker crashes, memory leaks, dropped queue items
- ffmpeg failing on a weird input (odd codecs, corrupt files, no audio track, variable frame rate)
- disk filling up in `tmp/`, orphaned temp files
- database bloat/backups, Postgres downtime
- OS/ffmpeg/Node security patches — ffmpeg has a steady stream of CVEs
- ffmpeg version upgrades silently changing output quality/settings

Mux is a fully managed service (development, availability, redundancy, scaling, patching done by them) with 24/7 support on paid plans.

### 1.2 Encoding smarts

- Mux uses **per-title / just-in-time encoding**: it analyzes each source and optimizes the bitrate ladder per video, and only builds the renditions a viewer actually requests. That means better quality-per-bit and lower storage than a fixed ladder.
- This repo uses one **static ladder** (1080p/720p/480p, fixed H.264 bitrates for every video). No content-aware tuning.
- Resolution ceiling: **1080p**. No 4K, no H.265/HEVC, no AV1. Mux handles up to 4K on demand.

### 1.3 Delivery & global performance

- Mux streams over a **multi-CDN** (Fastly, Akamai + own POPs) optimized for video, with low-latency HLS and sub-3-second joint start times promised.
- Self-hosted, you serve manifests/segments straight out of R2. Egress is free, but global hit performance, caching behavior, and latency are whatever your setup gives you. No LL-HLS anywhere. To get CDN-grade delivery you must put a CDN in front (Cloudflare free plan works, but you configure and maintain cache rules).

### 1.4 Player + quality analytics (QoE)

- Mux ships **Mux Player** (open-source hls.js/video.js derivative) and **Mux Data** — startup time, rebuffering, bitrate switching, engagement — included free.
- Self-hosted: plain `<video>` + hls.js, **zero playback telemetry**. You won't know a third of your users is buffering unless you build that yourself.

### 1.5 Feature surface

| Feature | Mux | This repo |
| --- | --- | --- |
| Adaptive HLS ingest→playback | Yes | Yes |
| Live streaming (RTMP/SRT) + live-to-VOD | Yes | No |
| MP4 / static renditions | Yes | No |
| Thumbnails / storyboards | Yes | Yes (poster + scene thumbs; no storyboard sprites) |
| Captions (free on-demand, AI translate) | Yes | No |
| AI workflows (chapters, summary, moderation) | Yes (Mux Robots) | No |
| Multi-track audio | Yes (add-on) | No (single AAC track) |
| Signed URLs / domain restriction | Free add-on | Yes (presigner + authenticated proxy) |
| Media-grade DRM | Paid add-on | No |
| Custom domains | $100/mo | Free via CDN/CNAME |
| QoE analytics | Yes (Mux Data) | Partial (request logs/bytes, no rebuffering telemetry) |
| Input format normalization | Any codec/container | Whatever your ffmpeg build handles |

### 1.6 Scale, spikes, and reliability

- Mux absorbs traffic spikes automatically (they run billions of stream-minutes/month).
- Self-hosted: a spike in *transcodes* means a growing queue; a spike in *viewers* means your single box/CDN. Retries, dead-lettering, stuck-job recycling, and a watchdog are now built in, but **redundancy is not** — one dead VM still takes down the pipeline, and there is only one worker/CDN path.

### 1.7 Security & compliance

- Mux has SOC 2/ISO posture, per-asset security you don't think about.
- Self-hosted: signed URLs, encryption at rest, key handling, and any compliance story are 100% your job.

### 1.8 Time to market

- Mux: upload → playable stream in minutes via an API. Days end-to-end for most teams.
- This repo: you already maintain the pipeline, and every missing feature above is another build project. Weeks-to-months total.

### 1.9 What you *gain* by self-hosting

- **Predictable, near-flat cost** at scale (marginal cost of another video ≈ $0).
- **Full control**: custom ladders, codecs, presets, packaging, thumbnails schedules — nothing metered, no per-minute surprises.
- **Data ownership**: video never touches a third party; matters for confidential/proprietary content.
- **No lock-in**: S3 API is portable (LocalStack → R2 → S3 → MinIO).
- **Learning**: you now understand HLS packaging and encoding internals, which Mux makes invisible.

---

## 2. Cost model basics

**Mux** prices per *minute of content*, in three buckets (basic quality, ≤1080p):

| Item | 720p | 1080p | 2K | 4K |
| --- | --- | --- | --- | --- |
| Input (encode) | $0 | $0 | $0 | $0 |
| Storage (/min/month) | $0.0024 | $0.0030 | $0.0048 | $0.0096 |
| Delivery (/min) | $0.0008 | $0.0010 | $0.0016 | $0.0032 |

Notes:
- First **100K delivery minutes are free** every month.
- Newly stored assets start in **cold storage** (up to −60% storage) and auto-tier back after 30 days of watching.
- Input is free for **basic** quality only. *Plus* input starts at $0.025/min, *premium* at $0.0384/min (720p).
- Pay-as-you-go includes a monthly usage credit; prepay plans (`$20/mo → $100` of usage, `$500/mo → $1,000`) cut effective cost roughly in half inside the plan.

**Self-hosted** prices in bytes and flat compute:

- **R2 storage**: `$0.015`/GB-month (10 GB free tier), Class A ops `$4.50`/M, Class B ops `$0.36`/M, **egress $0**.
- **Compute**: pick your always-on box (or an existing computer).
- **Postgres**: runs on the same box in this repo (`$0`) or a free/cheap managed tier.

---

## 3. Assumptions used in the math

| Assumption | Value |
| --- | --- |
| Source bitrate (1080p) | ~8 Mbps → ~1 GB per 17 min |
| HLS ladder bitrate (5000+2800+1400k + 3×128k audio) | ~6.5 Mbps effective → ~49 MB/min |
| Per-video R2 footprint (source + HLS) | 5 min ≈ 0.55 GB · 30 min ≈ 3.3 GB · 90 min ≈ 9.8 GB |
| Worker throughput, 4 vCPU box | ~2× realtime (30-min video ≈ 15 min wall time) |
| Worker boxes | 2 vCPU ≈ $24/mo · 4 vCPU ≈ $48/mo (DigitalOcean-class) |
| Delivery CDN for self-host | Cloudflare free plan in front of R2 (egress/caching $0) |
| Transcoder headroom | 1 box ≈ 50–100 videos of 30 min per month, comfortably |

---

## 4. Per-video cost — storage, first month (1080p)

| Video | Mux storage/mo | Mux input | R2 storage/mo | R2 ops |
| --- | --- | --- | --- | --- |
| 5 min | $0.015 (cold $0.006) | $0 | ~$0.008 (≥18 video fit in free 10 GB) | ≈ $0 |
| 30 min | $0.090 (cold $0.036) | $0 | ~$0.050 | ≈ $0 |
| 90 min | $0.270 (cold $0.108) | $0 | ~$0.147 | ≈ $0 |

Takeaway: **storage is the same order of magnitude on both sides** — Mux's per-minute storage and R2's per-GB storage happen to land in the same ballpark. Storage scaling is *not* where the Mux bill bites.

## 5. Delivery cost — per 1,000 minutes watched (1080p)

| Provider | Cost / 1,000 min | Notes |
| --- | --- | --- |
| Mux | $1.00 | after the 100K free minutes; $10 per 10,000 views of a ~5-min clip |
| Self-host (R2 + CF CDN) | ~$0.005 | ~10,000 segment GETs at Class B `$0.36/M`; egress $0 |

Delivery is the **single biggest cost differentiator**. At roughly 200:1, this is what makes per-minute pricing expensive at scale.

## 6. Monthly totals by scale (the headline table)

Working model, all 1080p, average video 30 min, input free on Mux (basic):

| | Hobby | Startup | Scale |
| --- | --- | --- | --- |
| New videos / month | 10 | 100 | 1,000 |
| Library retained | 50 | 500 | 5,000 |
| Minutes delivered / month | 10,000 | 200,000 | 2,000,000 |
| Worker compute | 2 vCPU $24 | 4 vCPU $48 | 4× 4 vCPU $192 |

**Mux**

| Item | Hobby | Startup | Scale |
| --- | --- | --- | --- |
| Storage | $4.50 | $45.00 | $450 (cold ~$180) |
| Delivery | $0 (free 100K) | $100 | $1,900 |
| Input | $0 | $0 | $0 |
| **Total** | **≈ $4.50** | **≈ $145** | **≈ $2,350** ($2,080 w/ cold) |

**Self-hosted (R2 + VPS box + Postgres on box)**

| Item | Hobby | Startup | Scale |
| --- | --- | --- | --- |
| R2 storage | ≈ $2.50 | ≈ $25 | ≈ $248 |
| Compute | $24 | $48 | $192 |
| R2 ops / delivery | ≈ $0 | ≈ $0 | ≈ $0 |
| **Total** | **≈ $27** | **≈ $73** | **≈ $440** |

### Reading the table

- **Hobby**: Mux wins. ≈$4.50/month is cheaper than any dedicated box, and the $20 monthly usage credit or free plan makes it **~$0** for a launch. Self-host only wins here if you already own idle hardware.
- **Startup**: nearly a wash on cash ($73 vs $145, and Mux credit plans pull it down to ~$100). The real cost of self-hosting is now the engineering/ops time, not the money.
- **Scale**: self-host is **~5× cheaper** on cash ($440 vs $2,350) and the gap widens as delivery minutes grow, because Mux delivery is per-minute and yours is ~free. This is the regime where a fixed ladder and a flat box actually pay off.

### Where the crossover really is

The pivot is **delivery minutes**, not library size:

- Under ~100–150K delivered minutes/month → Mux free tier + credits covers it → **use Mux**, it's free and zero-ops.
- Roughly 200K–2M delivered minutes/month → both are within ~2× of each other after Mux credit plans → decide on **engineering time and feature needs**, not dollars.
- Beyond a few million minutes/month (or multi-100K videos) → Mux bills thousands/month; self-host is a fixed-fee video factory → **self-host wins on cash** if you can carry the operations and accept the missing features.

## 7. The honest add-back: engineering time

Mux's whole pitch is that the numbers above are *all* you pay. Reviewing the self-host totals without labor cost is the most common mistake in these comparisons.

| Effort | Rough scope |
| --- | --- |
| Pipeline build (this repo) | 1–2 weeks |
| Reliability (retries, dead-letter, watchdog, reclaim) | Now built-in |
| Observability (health/metrics, structured+segment logs, uptime pings) | Now built-in |
| Thumbnails + poster | Now built-in |
| Edge cases: bad codecs, no-audio, corrupt files | 2–4 days (ongoing) |
| QoE/analytics equivalent | weeks (ongoing) |
| Live, DRM, MP4, 4K, storyboard sprites | each is a project |

At a modest $50/hr, **1–2 weeks of engineering ≈ $2,000–$4,000** — equivalent to *years* of Hobby Mux, or ~a month of the Scale Mux bill. The self-hosted route is economic only when the pipeline is a one-time cost spread over a large/ongoing volume, or when control/data-ownership justifies the labor regardless.

## 8. Cheap mitigations to close the obvious gaps

Status of the mitigations from the original design, relative to what's now in this repo:

| Mitigation | Status |
| --- | --- |
| **Reliability**: retries, idempotency keys, dead-letter, watchdog | ✅ Implemented (`migrations/002`, `jobs.ts`, `worker.ts`, `watchdog.ts`) |
| **Observability**: `/healthz`, segment logs, uptime pings | ✅ Implemented (`server.ts` — plus `/readyz`, `/metrics`) |
| **Security**: signed URLs + private bucket | ✅ Implemented (presigner + authenticated `/videos/*` proxy) |
| **Thumbnails**: poster + scene frames → R2 | ✅ Implemented (JPEG + WebP) |
| **Delivery**: Cloudflare/CDN in front, cache headers on segments | 🟡 Proxy sets correct `Cache-Control`; CDN in front still to be added |
| **Codecs**: H.265/AV1 renditions, 4K ladder | ⬜ Not started (CPU-time cost only) |

## 9. Bottom line

- **Use Mux** to ship fast or stay small (free tier effectively covers a launch).
- **Use this pipeline** when volume makes the per-minute bill large, when you want data ownership/control, or when you'd rather spend engineer-hours than vendor-dollars and can carry the ops burden.
- The dollars crossover sits around **a few hundred thousand to a couple million delivered minutes per month**; the *real* crossover is whether you can absorb the engineering and missing features.