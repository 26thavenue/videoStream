import fs from "node:fs";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./client";
import { rawBucket, processedBucket, stuckJobTtlMs, thumbnailsEnabled } from "./config";
import { claimNextJob, completeJob, failJob, recycleStuckJobs, type Job } from "./jobs";
import { runFfmpegHLS, runFfmpegThumbnails, probeDuration } from "./runner";
import { log } from "./logger";

const TMP_DIR = "tmp";
const POLL_INTERVAL_MS = 3000;
const RECLAIM_INTERVAL_MS = 60_000;

let stopping = false;

process.on("SIGTERM", () => {
  log.warn("SIGTERM received, draining");
  stopping = true;
});
process.on("SIGINT", () => {
  log.warn("SIGINT received, draining");
  stopping = true;
});

function downloadSource(key: string, destPath: string): Promise<void> {
  return s3
    .send(new GetObjectCommand({ Bucket: rawBucket, Key: key }))
    .then(async (res) => {
      if (!res.Body) throw new Error(`empty body for ${key}`);
      await new Promise<void>((resolve, reject) => {
        const dest = fs.createWriteStream(destPath);
        (res.Body as unknown as NodeJS.ReadableStream).pipe(dest);
        dest.on("finish", () => resolve());
        dest.on("error", reject);
      });
    });
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filename.endsWith(".ts")) return "video/mp2t";
  if (filename.endsWith(".jpg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function uploadDirRecursive(localDir: string, remotePrefix: string): Promise<void> {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remoteKey = `${remotePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await uploadDirRecursive(localPath, remoteKey);
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: processedBucket,
          Key: remoteKey,
          Body: fs.readFileSync(localPath),
          ContentType: contentTypeFor(entry.name),
        })
      );
    }
  }
}

async function processJob(sourceKey: string, videoId: string): Promise<void> {
  const tmpInput = path.join(TMP_DIR, `${videoId}-src.mp4`);
  const tmpOutputDir = path.join(TMP_DIR, `${videoId}-hls`);
  const tmpThumbDir = path.join(TMP_DIR, `${videoId}-thumbs`);

  try {
    await downloadSource(sourceKey, tmpInput);
    await runFfmpegHLS(tmpInput, tmpOutputDir);
    await uploadDirRecursive(tmpOutputDir, videoId);

    if (thumbnailsEnabled) {
      const durationSec = await probeDuration(tmpInput);
      await runFfmpegThumbnails(tmpInput, tmpThumbDir, durationSec);
      await uploadDirRecursive(tmpThumbDir, path.join(videoId, "thumbnails"));
    }
  } finally {
    fs.rmSync(tmpInput, { force: true });
    fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    fs.rmSync(tmpThumbDir, { recursive: true, force: true });
  }
}

async function reclaimLoop(): Promise<void> {
  try {
    const recycled = await recycleStuckJobs(stuckJobTtlMs);
    if (recycled > 0) log.warn("recycled stuck jobs", { count: recycled });
  } catch (err) {
    log.error("reclaim pass failed", { err: String(err) });
  }
}

async function pollLoop(): Promise<void> {
  if (stopping) {
    log.info("worker stopping");
    process.exit(0);
  }

  let job: Job | null = null;
  try {
    job = await claimNextJob();
  } catch (err) {
    log.error("claim failed", { err: String(err) });
    setTimeout(pollLoop, POLL_INTERVAL_MS * 5);
    return;
  }

  if (!job) {
    setTimeout(pollLoop, POLL_INTERVAL_MS);
    return;
  }

  const videoId = path.parse(job.source_key).name;
  try {
    await processJob(job.source_key, videoId);
    await completeJob(job.id);
    log.info("job done", { id: job.id, sourceKey: job.source_key });
  } catch (err) {
    const outcome = await failJob(job.id, err);
    log.error("job failed", { id: job.id, sourceKey: job.source_key, outcome, err: String(err) });
  }
  void pollLoop();
}

setTimeout(reclaimLoop, 5_000);
setInterval(reclaimLoop, RECLAIM_INTERVAL_MS).unref();
void pollLoop();