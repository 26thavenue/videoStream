import { config } from "dotenv";
import type { S3ClientConfig } from "@aws-sdk/client-s3";

config();

export const PORT = Number(process.env.PORT) || 8081;

export const isLocal = process.env.STORAGE_ENV !== "production";

export const rawBucket = process.env.RAW_BUCKET ?? "raw-videos";
export const processedBucket = process.env.PROCESSED_BUCKET ?? "processed-videos";
export const databaseUrl = process.env.DATABASE_URL;

export const maxAttempts = Number(process.env.MAX_ATTEMPTS) || 4;
export const retryBaseMs = Number(process.env.RETRY_BASE_MS) || 30_000;
export const retryCapMs = Number(process.env.RETRY_CAP_MS) || 3_600_000;
export const stuckJobTtlMs = (Number(process.env.STUCK_JOB_TTL_MIN) || 120) * 60_000;

export const thumbnailsEnabled = process.env.THUMBNAILS !== "false";

export const playbackToken = process.env.PLAYBACK_TOKEN ?? "";
export const uptimePingUrl = process.env.UPTIME_PING_URL ?? "";
export const uptimePingIntervalMs = Number(process.env.UPTIME_PING_INTERVAL_MS) || 300_000;

export const s3: S3ClientConfig = isLocal
  ? {
      endpoint: process.env.LOCALSTACK_ENDPOINT,
      region: process.env.AWS_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
    }
  : {
      endpoint: process.env.R2_ENDPOINT,
      region: "auto",
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
      },
    };