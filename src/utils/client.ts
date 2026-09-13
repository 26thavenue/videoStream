import { S3Client } from "@aws-sdk/client-s3";
import { s3 as s3Config } from "./config";

export const s3 = new S3Client(s3Config);

export default s3;