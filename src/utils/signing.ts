import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "./client";
import { processedBucket } from "./config";

export async function signPlaybackUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: processedBucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}