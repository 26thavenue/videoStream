import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { s3 } from "./client";
import { processedBucket } from "./config";
import { dbPing } from "./jobs";

export interface HealthStatus {
  ok: boolean;
  checks: Record<string, { ok: boolean; error?: string }>;
}

export async function checkStorage(): Promise<{ ok: boolean; error?: string }> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: processedBucket }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function readiness(): Promise<HealthStatus> {
  const db = await dbPing().then((ok) => ({ ok }));
  const storage = await checkStorage();
  return {
    ok: db.ok && storage.ok,
    checks: { db, storage },
  };
}