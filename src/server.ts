import { Readable } from "node:stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./utils/client";
import { PORT, rawBucket, processedBucket, playbackToken, uptimePingUrl, uptimePingIntervalMs } from "./utils/config";
import { readiness } from "./utils/health";
import { bearerAuth } from "./utils/auth";
import { renderMetrics, metrics } from "./utils/metrics";
import { startUptimePings } from "./utils/ping";
import { signPlaybackUrl } from "./utils/signing";
import { log } from "./utils/logger";

const app = new Hono();
const startedAt = Date.now();

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  log.info("http", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms,
  });
});

app.get("/", (c) =>
  c.json({
    service: "videoStream",
    endpoints: ["/healthz", "/readyz", "/metrics", "/videos/*", "/source/*", "/api/playback/:videoId"],
  })
);

app.get("/healthz", (c) =>
  c.json({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), pid: process.pid })
);

app.get("/readyz", async (c) => {
  const status = await readiness();
  return c.json(status, status.ok ? 200 : 503);
});

app.get("/metrics", async (c) => c.text(await renderMetrics()));

function contentTypeFor(key: string): string {
  if (key.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (key.endsWith(".ts")) return "video/mp2t";
  if (key.endsWith(".mp4") || key.endsWith(".m4v")) return "video/mp4";
  if (key.endsWith(".mov")) return "video/quicktime";
  if (key.endsWith(".webm")) return "video/webm";
  if (key.endsWith(".jpg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

interface StreamOptions {
  bucket: string;
  key: string;
  range?: string;
  immutable: boolean;
  contentType: string;
  onServed: (bytes: number) => void;
  logMsg: string;
}

async function streamObject(opts: StreamOptions): Promise<Response> {
  const start = Date.now();
  let bytes = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += (chunk as Uint8Array).byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      opts.onServed(bytes);
      log.info(opts.logMsg, { key: opts.key, bytes, ms: Date.now() - start });
    },
  });

  const res = await s3.send(
    new GetObjectCommand({ Bucket: opts.bucket, Key: opts.key, Range: opts.range })
  );
  if (!res.Body) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Cache-Control": opts.immutable ? "public, max-age=31536000, immutable" : "no-store",
    "Accept-Ranges": "bytes",
  };
  if (res.ContentRange) headers["Content-Range"] = res.ContentRange;
  if (res.ContentLength != null) headers["Content-Length"] = String(res.ContentLength);

  const body = Readable.toWeb(res.Body as unknown as Readable).pipeThrough(transform);
  return new Response(body, { status: res.ContentRange ? 206 : 200, headers });
}

app.use("/videos/*", cors());
app.use("/videos/*", bearerAuth(playbackToken));

app.get("/videos/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/videos\//, ""));
  if (!key) return c.text("Not found", 404);

  const isImmutable = key.endsWith(".ts") || key.endsWith(".jpg") || key.endsWith(".webp");
  try {
    return await streamObject({
      bucket: processedBucket,
      key,
      immutable: isImmutable,
      contentType: contentTypeFor(key),
      onServed: (bytes) => metrics.incServed(bytes),
      logMsg: "segment served",
    });
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      metrics.incNotFound();
      return c.text("Not found", 404);
    }
    metrics.incErrors();
    log.error("proxy error", { key, err: String(err) });
    return c.text("Internal error", 500);
  }
});

app.use("/source/*", cors());
app.use("/source/*", bearerAuth(playbackToken));

app.get("/source/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/source\//, ""));
  if (!key) return c.text("Not found", 404);

  try {
    return await streamObject({
      bucket: rawBucket,
      key,
      range: c.req.header("range"),
      immutable: false,
      contentType: contentTypeFor(key),
      onServed: (bytes) => metrics.incSourceServed(bytes),
      logMsg: "source served",
    });
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      metrics.incNotFound();
      return c.text("Not found", 404);
    }
    metrics.incErrors();
    log.error("source proxy error", { key, err: String(err) });
    return c.text("Internal error", 500);
  }
});

app.get("/api/playback/:videoId", bearerAuth(playbackToken), async (c) => {
  const videoId = c.req.param("videoId");
  try {
    const url = await signPlaybackUrl(`${videoId}/master.m3u8`);
    return c.json({ url });
  } catch (err) {
    log.error("sign error", { videoId, err: String(err) });
    return c.text("Internal error", 500);
  }
});

startUptimePings(uptimePingUrl, uptimePingIntervalMs);

serve({ fetch: app.fetch, port: PORT });
log.info("server listening", { port: PORT });