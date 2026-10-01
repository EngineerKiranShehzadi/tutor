import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// Archival only — stores the raw uploaded dataset file exactly as received,
// before chunk.service.ts ever parses/splits/embeds it, so the original
// source spreadsheet can always be recovered or re-processed later
// regardless of what the ingestion pipeline does with it. Nothing else in
// the app reads from S3 — this is a one-way write.

let client: S3Client | null = null;

// True only when a bucket and region are set. Lets local/dev runs work with
// no AWS account: callers skip the archive step instead of failing.
export function isS3Configured(): boolean {
  return Boolean(env.S3.BUCKET_NAME && env.S3.REGION);
}

function getS3Client(): S3Client {
  if (!env.S3.BUCKET_NAME || !env.S3.REGION) {
    throw new AppError('S3_DATASET_BUCKET / S3_REGION is not configured. Please add them to your .env file.', 500);
  }
  if (!client) {
    client = new S3Client({
      region: env.S3.REGION,
      // Falls back to the default AWS credential provider chain (IAM role,
      // shared credentials file, etc.) when explicit keys aren't set —
      // same "optional, not required()" philosophy as the rest of env.ts.
      ...(env.S3.ACCESS_KEY_ID && env.S3.SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: env.S3.ACCESS_KEY_ID, secretAccessKey: env.S3.SECRET_ACCESS_KEY } }
        : {}),
    });
  }
  return client;
}

export interface UploadRawDatasetResult {
  bucket: string;
  key: string;
}

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Uploads the raw .xlsx buffer under a lecture- and timestamp-scoped key so
// re-uploads for the same lecture never overwrite an earlier raw file.
export async function uploadRawDataset(
  lectureId: number,
  buffer: Buffer,
  originalFilename: string
): Promise<UploadRawDatasetResult> {
  const s3 = getS3Client();
  const bucket = env.S3.BUCKET_NAME;
  const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `datasets/lecture-${lectureId}/${Date.now()}-${safeName}`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: XLSX_CONTENT_TYPE,
  }));

  logger.info(`[S3] ✅ Raw dataset stored: s3://${bucket}/${key}`);
  return { bucket, key };
}
