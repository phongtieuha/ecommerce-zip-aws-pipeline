import type { S3Event, S3EventRecord, SQSHandler } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

interface S3EventBody {
  Event?: string;
  Records?: S3EventRecord[];
}

const AWS_REGION = process.env.AWS_REGION || "ap-southeast-1";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET;
const SOURCE_PREFIX = (process.env.SOURCE_PREFIX || "tagged_output").replace(/^\/+|\/+$/g, "");
const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;
const DESTINATION_PREFIX = (process.env.DESTINATION_PREFIX || "").replace(/^\/+|\/+$/g, "");
const EXTERNAL_AWS_REGION = process.env.EXTERNAL_AWS_REGION || "ap-southeast-1";
const EXTERNAL_AWS_ACCESS_KEY_ID = process.env.EXTERNAL_AWS_ACCESS_KEY_ID;
const EXTERNAL_AWS_SECRET_ACCESS_KEY = process.env.EXTERNAL_AWS_SECRET_ACCESS_KEY;

if (!SOURCE_BUCKET) throw new Error("SOURCE_BUCKET is required");
if (!DESTINATION_BUCKET) throw new Error("DESTINATION_BUCKET is required");
if (!EXTERNAL_AWS_ACCESS_KEY_ID || !EXTERNAL_AWS_SECRET_ACCESS_KEY) {
  throw new Error("EXTERNAL_AWS_ACCESS_KEY_ID and EXTERNAL_AWS_SECRET_ACCESS_KEY are required");
}

const sourceS3Client = new S3Client({ region: AWS_REGION });
const destinationS3Client = new S3Client({
  region: EXTERNAL_AWS_REGION,
  credentials: {
    accessKeyId: EXTERNAL_AWS_ACCESS_KEY_ID,
    secretAccessKey: EXTERNAL_AWS_SECRET_ACCESS_KEY,
  },
});

function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, " "));
}

function isSupportedObjectEvent(eventName?: string): boolean {
  if (!eventName) return true;
  return eventName.startsWith("ObjectCreated:");
}

function isAllowedKey(key: string): boolean {
  if (!SOURCE_PREFIX) return key.endsWith(".csv");
  return (key.startsWith(`${SOURCE_PREFIX}/`) || key === SOURCE_PREFIX) && key.endsWith(".csv");
}

function buildDestinationKey(sourceKey: string): string {
  const normalizedSourceKey = sourceKey.replace(/^\/+/, "");
  if (!DESTINATION_PREFIX) return normalizedSourceKey;
  return `${DESTINATION_PREFIX}/${normalizedSourceKey}`;
}

function parseEventRecords(event: unknown): S3EventRecord[] {
  const candidate = event as { Records?: Array<{ body?: string }> };

  if (!candidate.Records || candidate.Records.length === 0) {
    return [];
  }

  const first = candidate.Records[0] as { s3?: unknown; body?: string };

  if (first.s3) {
    return (candidate as S3Event).Records;
  }

  const records: S3EventRecord[] = [];
  for (const message of candidate.Records) {
    if (!message.body) continue;
    let parsed: S3EventBody;
    try {
      parsed = JSON.parse(message.body) as S3EventBody;
    } catch (error) {
      console.error("Skipping non-JSON SQS message", error);
      continue;
    }

    if (parsed.Event === "s3:TestEvent") {
      continue;
    }

    if (parsed.Records?.length) {
      records.push(...parsed.Records);
    }
  }

  return records;
}

async function copyRecord(record: S3EventRecord): Promise<void> {
  const sourceBucket = record.s3.bucket.name;
  const sourceKey = decodeS3Key(record.s3.object.key);

  if (sourceBucket !== SOURCE_BUCKET) {
    console.log(`Skipping source bucket ${sourceBucket}; expected ${SOURCE_BUCKET}`);
    return;
  }

  if (!isSupportedObjectEvent(record.eventName)) {
    console.log(`Skipping event ${record.eventName || "unknown"}`);
    return;
  }

  if (!isAllowedKey(sourceKey)) {
    console.log(`Skipping key outside SOURCE_PREFIX or non-csv: ${sourceKey}`);
    return;
  }

  const destinationKey = buildDestinationKey(sourceKey);

  const sourceObject = await sourceS3Client.send(
    new GetObjectCommand({
      Bucket: sourceBucket,
      Key: sourceKey,
    }),
  );

  if (!sourceObject.Body) {
    throw new Error(`No body returned for s3://${sourceBucket}/${sourceKey}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of sourceObject.Body as NodeJS.ReadableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bodyBuffer = Buffer.concat(chunks);

  await destinationS3Client.send(
    new PutObjectCommand({
      Bucket: DESTINATION_BUCKET,
      Key: destinationKey,
      Body: bodyBuffer,
      ContentLength: bodyBuffer.length,
      ContentType: sourceObject.ContentType || "application/octet-stream",
    }),
  );

  console.log(
    `Copied s3://${sourceBucket}/${sourceKey} to s3://${DESTINATION_BUCKET}/${destinationKey}`,
  );
}

export const handler: SQSHandler = async (event) => {
  const records = parseEventRecords(event);
  if (records.length === 0) {
    console.log("No S3 records to process");
    return;
  }

  for (const record of records) {
    await copyRecord(record);
  }
};
