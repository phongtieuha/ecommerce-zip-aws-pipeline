import type { SQSHandler } from "aws-lambda";
import { Readable } from "node:stream";
import {
  S3Client,
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  STSClient,
  AssumeRoleCommand,
  type Credentials as StsCredentials,
} from "@aws-sdk/client-sts";

interface S3Record {
  s3: {
    bucket: { name: string };
    object: { key: string; eTag?: string; versionId?: string };
  };
  eventName?: string;
  awsRegion?: string;
}

interface S3EventBody {
  Event?: string;
  Records?: S3Record[];
}

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const DEST_BUCKET = process.env.DESTINATION_BUCKET;
const DEST_PREFIX = (process.env.DESTINATION_PREFIX || "").replace(/^\/+|\/+$/g, "");
const ALLOWED_SOURCE_BUCKETS = new Set(
  (process.env.ALLOWED_SOURCE_BUCKETS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
);
const SOURCE_ASSUME_ROLE_ARN = process.env.SOURCE_ASSUME_ROLE_ARN;

// External bucket access credentials (optional, for cross-account/cross-org access)
const EXTERNAL_BUCKET_NAME = process.env.EXTERNAL_BUCKET_NAME;
const EXTERNAL_AWS_REGION = process.env.EXTERNAL_AWS_REGION || "ap-southeast-1";
const EXTERNAL_AWS_ACCESS_KEY_ID = process.env.EXTERNAL_AWS_ACCESS_KEY_ID;
const EXTERNAL_AWS_SECRET_ACCESS_KEY = process.env.EXTERNAL_AWS_SECRET_ACCESS_KEY;
const DESTINATION_USE_EXTERNAL_CREDS = process.env.DESTINATION_USE_EXTERNAL_CREDS === "true";
const REQUEST_STREAM_BUFFER_SIZE = 64 * 1024;

if (!DEST_BUCKET) {
  throw new Error("DESTINATION_BUCKET is required");
}

const defaultS3Client = new S3Client({
  region: REGION,
  requestStreamBufferSize: REQUEST_STREAM_BUFFER_SIZE,
});
const stsClient = new STSClient({ region: REGION });
const assumedClients = new Map<string, S3Client>();

// Initialize external S3 client if credentials are provided
let externalS3Client: S3Client | null = null;
if (EXTERNAL_BUCKET_NAME && EXTERNAL_AWS_ACCESS_KEY_ID && EXTERNAL_AWS_SECRET_ACCESS_KEY) {
  externalS3Client = new S3Client({
    region: EXTERNAL_AWS_REGION,
    requestStreamBufferSize: REQUEST_STREAM_BUFFER_SIZE,
    credentials: {
      accessKeyId: EXTERNAL_AWS_ACCESS_KEY_ID,
      secretAccessKey: EXTERNAL_AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log(`✅ Initialized external S3 client for bucket: ${EXTERNAL_BUCKET_NAME}`);
}

function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, " "));
}

function buildDestinationKey(sourceKey: string): string {
  const key = sourceKey.replace(/^\/+/, "");
  if (!DEST_PREFIX) return key;
  return `${DEST_PREFIX}/${key}`;
}

function isSupportedObjectEvent(eventName?: string): boolean {
  if (!eventName) return true;
  return eventName.startsWith("ObjectCreated:");
}

async function getClientForSource(sourceBucket?: string): Promise<S3Client> {
  // Check if this is the external bucket with explicit credentials
  if (sourceBucket === EXTERNAL_BUCKET_NAME && externalS3Client) {
    console.log(`Using external S3 client for bucket: ${sourceBucket}`);
    return externalS3Client;
  }

  if (!SOURCE_ASSUME_ROLE_ARN) {
    return defaultS3Client;
  }

  const cached = assumedClients.get(SOURCE_ASSUME_ROLE_ARN);
  if (cached) return cached;

  const assumed = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: SOURCE_ASSUME_ROLE_ARN,
      RoleSessionName: "filepipeline-external-ingestor",
      DurationSeconds: 3600,
    }),
  );

  if (!assumed.Credentials) {
    throw new Error("AssumeRole succeeded but no temporary credentials were returned");
  }

  const credentials = assumed.Credentials as StsCredentials;
  const client = new S3Client({
    region: REGION,
    requestStreamBufferSize: REQUEST_STREAM_BUFFER_SIZE,
    credentials: {
      accessKeyId: credentials.AccessKeyId || "",
      secretAccessKey: credentials.SecretAccessKey || "",
      sessionToken: credentials.SessionToken,
    },
  });

  assumedClients.set(SOURCE_ASSUME_ROLE_ARN, client);
  return client;
}

function getClientForDestination(): S3Client {
  if (DESTINATION_USE_EXTERNAL_CREDS && externalS3Client) {
    return externalS3Client;
  }
  return defaultS3Client;
}

function assertSourceBucketAllowed(bucket: string): void {
  if (ALLOWED_SOURCE_BUCKETS.size === 0) {
    return;
  }
  if (!ALLOWED_SOURCE_BUCKETS.has(bucket)) {
    throw new Error(`Source bucket ${bucket} is not allowed`);
  }
}

async function copyViaGetPut(
  sourceBucket: string,
  sourceKey: string,
  versionId?: string,
): Promise<void> {
  const sourceClient = await getClientForSource(sourceBucket);
  const destinationClient = getClientForDestination();
  const destinationKey = buildDestinationKey(sourceKey);

  const getInput: GetObjectCommandInput = {
    Bucket: sourceBucket,
    Key: sourceKey,
  };

  if (versionId) {
    getInput.VersionId = versionId;
  }

  let getResult;
  try {
    getResult = await sourceClient.send(new GetObjectCommand(getInput));
  } catch (error) {
    console.error(`Failed to read source object s3://${sourceBucket}/${sourceKey}`, error);
    throw error;
  }
  if (!getResult.Body) {
    throw new Error(`No body returned for s3://${sourceBucket}/${sourceKey}`);
  }

  const streamBody = getResult.Body as Readable;
  const contentLength = getResult.ContentLength;

  try {
    await destinationClient.send(
      new PutObjectCommand({
        Bucket: DEST_BUCKET,
        Key: destinationKey,
        Body: streamBody,
        ContentLength: contentLength,
        ContentType: getResult.ContentType || "application/zip",
      }),
    );
  } catch (error) {
    console.error(
      `Failed to write destination object s3://${DEST_BUCKET}/${destinationKey}`,
      error,
    );
    throw error;
  }

  console.log(`Copied to s3://${DEST_BUCKET}/${destinationKey}`);
}

async function copyRecord(record: S3Record): Promise<void> {
  const sourceBucket = record.s3.bucket.name;
  const sourceKey = decodeS3Key(record.s3.object.key);
  const versionId = record.s3.object.versionId;

  assertSourceBucketAllowed(sourceBucket);

  if (SOURCE_ASSUME_ROLE_ARN || sourceBucket === EXTERNAL_BUCKET_NAME) {
    await copyViaGetPut(sourceBucket, sourceKey, versionId);
    return;
  }

  // Fast path when current credentials can read source + write destination.
  // Preserves server-side copy in S3 without downloading data through Lambda.
  const destinationClient = getClientForDestination();
  const destinationKey = buildDestinationKey(sourceKey);
  const copySource = `${sourceBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`;

  await destinationClient.send(
    new CopyObjectCommand({
      Bucket: DEST_BUCKET,
      Key: destinationKey,
      CopySource: copySource,
    }),
  );

  console.log(`Copied s3://${sourceBucket}/${sourceKey} to s3://${DEST_BUCKET}/${destinationKey}`);
}

function parseBody(body: string): S3EventBody {
  const parsed = JSON.parse(body) as S3EventBody;
  return parsed;
}

export const handler: SQSHandler = async (event) => {
  for (const message of event.Records) {
    let parsedBody: S3EventBody;

    try {
      parsedBody = parseBody(message.body);
    } catch (error) {
      console.error(`Invalid JSON message ${message.messageId}:`, error);
      continue;
    }

    if (parsedBody.Event === "s3:TestEvent") {
      console.log(`Skipping S3 test event message ${message.messageId}`);
      continue;
    }

    const s3Records = parsedBody.Records || [];
    if (s3Records.length === 0) {
      console.log(`No S3 records in message ${message.messageId}, skipping`);
      continue;
    }

    for (const s3Record of s3Records) {
      if (!s3Record.s3?.bucket?.name) {
        console.log(`Skipping record with no S3 bucket info: ${JSON.stringify(s3Record)}`);
        continue;
      }

      if (!isSupportedObjectEvent(s3Record.eventName)) {
        console.log(`Skipping event ${s3Record.eventName || "unknown"}`);
        continue;
      }

      await copyRecord(s3Record);
    }
  }
};
