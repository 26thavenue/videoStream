import fs from "node:fs";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./client";
import { rawBucket } from "./config";
import { enqueueJob } from "./jobs";
import { log } from "./logger";

function parseArgs(argv: string[]): { filePath: string; idempotencyKey?: string } {
  const filePath = argv[0];
  if (!filePath) {
    log.error("usage: pnpm upload <video-file> [--key <idempotency-key>]");
    process.exit(1);
  }
  const keyIndex = argv.indexOf("--key");
  const idempotencyKey =
    keyIndex >= 0 && argv[keyIndex + 1]
      ? argv[keyIndex + 1]
      : path.basename(filePath);
  return { filePath, idempotencyKey };
}

async function main(): Promise<void> {
  const { filePath, idempotencyKey } = parseArgs(process.argv.slice(2));

  const key = path.basename(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: rawBucket,
      Key: key,
      Body: fs.readFileSync(filePath),
    })
  );

  const { job, created } = await enqueueJob(key, idempotencyKey);
  if (created) {
    log.info("enqueued job", { id: job.id, sourceKey: key, idempotencyKey });
  } else {
    log.warn("job already queued for key", { id: job.id, sourceKey: key, idempotencyKey });
  }
}

void main();