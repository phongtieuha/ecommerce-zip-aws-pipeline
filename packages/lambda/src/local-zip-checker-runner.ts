/**
 * Local Lambda runner for zip-output-checker development.
 * Combines both zip-output-checker Lambdas into one process:
 *  - Polls the incoming bucket for new .zip objects and invokes handleS3ZipArrival
 *    (production: EventBridge rule on S3 "Object Created" events)
 *  - Long-polls the zip-check delay queue and invokes handleDelayedCheck for each
 *    message that becomes visible (production: SQS event source; each message's
 *    own DelaySeconds is the 5-minute timer, so there is no fixed-interval loop)
 */

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { handleS3ZipArrival, handleDelayedCheck } from "./zip-output-checker";
import { acquireRunnerLock } from "./local-runner-lock";

const INCOMING_BUCKET = process.env.INCOMING_BUCKET;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;
const ZIP_CHECK_QUEUE_URL = process.env.ZIP_CHECK_QUEUE_URL;

if (!INCOMING_BUCKET) throw new Error("INCOMING_BUCKET environment variable is required");
if (!AWS_REGION) throw new Error("AWS_REGION environment variable is required");
if (!AWS_ENDPOINT_URL) throw new Error("AWS_ENDPOINT_URL environment variable is required");
if (!ZIP_CHECK_QUEUE_URL) throw new Error("ZIP_CHECK_QUEUE_URL environment variable is required");

const POLL_INTERVAL = 5000; // 5 seconds
const RUNNER_LOCK_PATH = "/tmp/filepipeline-local-zip-checker-runner.lock";
const SEEN_KEYS_PATH = "/tmp/filepipeline-local-zip-checker-seen.json";

const s3Client = new S3Client({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL,
  forcePathStyle: true,
});

const sqsClient = new SQSClient({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL,
});

function loadSeenKeys(): Set<string> {
  if (!existsSync(SEEN_KEYS_PATH)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(SEEN_KEYS_PATH, "utf-8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveSeenKeys(seen: Set<string>): void {
  writeFileSync(SEEN_KEYS_PATH, JSON.stringify([...seen]), "utf-8");
}

async function pollForNewZips(seen: Set<string>): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: INCOMING_BUCKET,
        ContinuationToken: continuationToken,
      }),
    );
    continuationToken = response.NextContinuationToken;

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key || !key.endsWith(".zip") || seen.has(key)) continue;

      console.log(`New incoming ZIP detected: ${key}`);

      const event = {
        Records: [
          {
            s3: {
              bucket: { name: INCOMING_BUCKET },
              object: { key: encodeURIComponent(key) },
            },
          },
        ],
      };

      try {
        await handleS3ZipArrival(event);
      } catch (error) {
        console.error(
          `handleS3ZipArrival failed for ${key}:`,
          error instanceof Error ? error.message : error,
        );
      }

      seen.add(key);
      saveSeenKeys(seen);
    }
  } while (continuationToken);
}

async function pollDelayedChecks(): Promise<void> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: ZIP_CHECK_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
    }),
  );

  for (const message of response.Messages ?? []) {
    if (!message.Body || !message.ReceiptHandle) continue;

    const sqsEvent = {
      Records: [
        {
          messageId: message.MessageId ?? `local-${Date.now()}`,
          body: message.Body,
        },
      ],
    };

    try {
      const result = (await handleDelayedCheck(sqsEvent as never, {} as never, () => {})) as {
        batchItemFailures?: Array<{ itemIdentifier: string }>;
      } | void;
      const hasFailure = (result?.batchItemFailures ?? []).length > 0;

      if (hasFailure) {
        console.error(`Delayed check reported failure, leaving message for redrive`);
        continue;
      }

      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: ZIP_CHECK_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      console.log("Delayed check completed and message removed");
    } catch (error) {
      console.error(
        "Delayed check failed, leaving message for redrive:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function main(): Promise<void> {
  acquireRunnerLock(RUNNER_LOCK_PATH);

  console.log("Starting local ZIP output checker runner...");
  console.log(`Watching for new zips: s3://${INCOMING_BUCKET}/`);
  console.log(`Long-polling delayed check queue: ${ZIP_CHECK_QUEUE_URL}`);

  const seen = loadSeenKeys();

  while (true) {
    try {
      await pollForNewZips(seen);
    } catch (error) {
      console.error("Error polling for incoming zips:", error);
    }

    try {
      await pollDelayedChecks();
    } catch (error) {
      console.error("Error polling delayed check queue:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

await main();
