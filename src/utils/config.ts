import { config } from "dotenv";

config();

export const PORT = process.env.PORT;

const isLocal = process.env.STORAGE_ENV === 'local';

module.exports = {
  isLocal,
  raw_bucket: process.env.RAW_BUCKET,
  processed_bucket: process.env.PROCESSED_BUCKET,
  s3: isLocal
    ? {
        endpoint: process.env.LOCALSTACK_ENDPOINT,
        region: process.env.AWS_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      },
};
