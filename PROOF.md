# Proof: this is adaptive HLS streaming, not an object file download

This is a hands-on runbook to demonstrate, with observable evidence, that playback goes through
**packaged multi-bitrate HLS** (segmented, adaptive) rather than a single file served from object
storage. It also includes an A/B against the original file so the difference is undeniable.

Everything here runs locally against LocalStack + Postgres.

---

## 0. Prerequisites

```bash
docker compose up -d          # LocalStack + Postgres
pnpm exec tsc --noEmit        # should exit 0
```

Terminal A — API server:
```bash
pnpm dev
```

Terminal B — worker:
```bash
pnpm watchdog
```

Upload the sample and wait for `job done` in the worker:
```bash
pnpm upload ./sample.mp4
```

> `PLAYBACK_TOKEN` unset = open access (dev). Set it for anything non-local.

---

## 1. Evidence A — there is no file to "just play"

List what the pipeline actually produced:

```bash
docker exec videostream-localstack-1 awslocal s3 ls s3://processed-videos/sample/ --recursive
```

You will see a **manifest + many small segments**, never a single `.mp4`:

```
sample/master.m3u8
sample/stream_0/playlist.m3u8
sample/stream_0/data000.ts
sample/stream_0/data001.ts
sample/stream_1/...
sample/stream_2/...
sample/thumbnails/poster.jpg
```

The master manifest is a **menu of renditions**, not media:

```bash
curl -s http://localhost:8081/videos/sample/master.m3u8
```

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2886247,RESOLUTION=1920x1080,CODECS="avc1.640028"
stream_0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2052190,RESOLUTION=1280x720,CODECS="avc1.64001f"
stream_1/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1207045,RESOLUTION=854x480,CODECS="avc1.64001e"
stream_2/playlist.m3u8
```

The player chooses one of these **per segment, during playback**.

---

## 2. Evidence B — playback is many requests, one per segment

1. Open the player:
   ```bash
   start player.html
   ```
2. Leave the default URL (`http://localhost:8081/videos/sample/master.m3u8`) and press play.
3. Watch the **Segment log** in the player fill with `playlist` and `segment` rows, each showing its
   rendition and size. The header chip shows the **active rendition** (e.g. `1080p · 5000 kbps`).

Server side, the proxy logs one line per object:

```bash
# in Terminal A you'll see, per file:
# segment served {"key":"sample/stream_0/data000.ts","bytes":3333616,"ms":...}
```

And Prometheus counters move with every segment:

```bash
curl -s http://localhost:8081/metrics | grep -E "segment_requests_total|segment_bytes_total"
```

Expected: `segment_requests_total` grows by ~1 per segment + a couple for manifests; a 12s clip =
~7-9 requests. **A single file would be 1 request.**

> Tip: `curl -I` is a HEAD and won't count — use a GET (or the player) to move the counter.

---

## 3. Evidence C — A/B against the raw file

The server exposes the **original upload** read-only at `/source/*` (same proxy, separate counters).

Play the raw file:
```bash
curl -s -o /dev/null -w "HTTP %{http_code}  %{size_download} bytes\n" http://localhost:8081/source/sample.mp4
```
or paste `http://localhost:8081/source/sample.mp4` into the player and press play.

| | Raw `/source/sample.mp4` | HLS `/videos/sample/master.m3u8` |
| --- | --- | --- |
| Files fetched | **1** (plus a few HTTP Range requests when seeking) | **many** (manifest + one per segment) |
| Metric | `source_requests_total` ↑ by 1 | `segment_requests_total` ↑ by ~dozens |
| Renditions | 1 fixed | 3, switchable live |
| Adapts to bandwidth | no | yes |

Prove the counters are independent:
```bash
curl -s http://localhost:8081/metrics | grep -E "source_requests_total|segment_requests_total"
```
- `source_requests_total` only moves when you hit `/source/*`.
- `segment_requests_total` only moves when the HLS player fetches `/videos/*`.

The raw file supports `Accept-Ranges: bytes` + `206 Partial Content`, which is what makes seeking and
progressive playback possible — but it is still **one bitrate, one file**.

```bash
curl -s -i -H "Range: bytes=0-1023" http://localhost:8081/source/sample.mp4 | head -8
# HTTP/1.1 206 Partial Content
# content-range: bytes 0-1023/3056859
```

---

## 4. Evidence D — watch it adapt (the part only streaming can do)

This is the killer demo: switch renditions mid-playback based on network conditions.

1. Open `player.html`, play the HLS URL, confirm the chip shows `1080p`.
2. DevTools → **Network** → throttle to **Slow 3G** (or change the network speed).
3. Watch the **active rendition chip** drop (1080p → 720p → 480p) and the Segment log start showing
   `stream_2/…` entries instead of `stream_0/…`.
4. Set throttling back to **Online** and watch it climb back to 1080p.

That live switch is impossible with a single object-storage file — you can't re-encode the file you're
already watching. In the server log you'll see requests move between `sample/stream_0/…` and
`sample/stream_2/…`.

---

## 5. Metrics reference

| Metric | Meaning |
| --- | --- |
| `segment_requests_total` | HLS objects served by the proxy (`/videos/*`) |
| `segment_bytes_total` | Bytes streamed as HLS segments |
| `source_requests_total` | Raw source objects served (`/source/*`) |
| `source_bytes_total` | Bytes streamed as raw files |
| `playback_404_total` | Missing keys (bad videoId/path) |
| `playback_errors_total` | Proxy/S3 errors |
| `jobs_status{status="..."}` | Queue depth by state (pending/processing/done/dead) |

---

## 6. One-line summary

The pipeline turns one uploaded file into a **ladder of segmented, manifest-driven renditions** that a
player can switch between in real time — and every byte served is observable per object through the
proxy's logs and metrics. That package, not the storage layer, is what "streaming" means here.
