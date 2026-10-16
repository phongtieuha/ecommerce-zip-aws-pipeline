/**
 * Local Lambda runner for development
 * Polls SQS queue and invokes the processor handler
 * Simulates retry behavior and DLQ routing
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { handler as processorHandler } from "./processor";
import { getFileByS3Key, updateFileStatus } from "../utils/dynamodb";

interface SQSBatchResponse {
  batchItemFailures?: Array<{ itemIdentifier: string }>;
}

// Validate required environment variables
const QUEUE_URL = process.env.QUEUE_URL;
const DLQ_URL = process.env.DLQ_URL;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

if (!QUEUE_URL) throw new Error("QUEUE_URL environment variable is required");
if (!DLQ_URL) throw new Error("DLQ_URL environment variable is required");
if (!AWS_REGION) throw new Error("AWS_REGION environment variable is required");
if (!AWS_ENDPOINT_URL) throw new Error("AWS_ENDPOINT_URL environment variable is required");

const POLL_INTERVAL = 2000; // 2 seconds
const MAX_RECEIVE_COUNT = 2; // Move to DLQ after 2 failures
const RETRY_DELAY_MS = 1000; // 1 second delay between retries
const RUNNER_LOCK_PATH = "/tmp/filepipeline-local-runner.lock";

const sqsClient = new SQSClient({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL,
});

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRunnerLock(): void {
  const writeOwnLock = () => {
    const fd = openSync(RUNNER_LOCK_PATH, "wx");
    try {
      writeFileSync(fd, String(process.pid), "utf-8");
    } finally {
      closeSync(fd);
    }
  };

  try {
    writeOwnLock();
  } catch (error) {
    const isAlreadyExists =
      typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

    if (!isAlreadyExists) {
      throw error;
    }

    try {
      const raw = readFileSync(RUNNER_LOCK_PATH, "utf-8").trim();
      const activePid = Number.parseInt(raw, 10);
      if (processExists(activePid)) {
        throw new Error(
          `Another local runner is already active (pid ${activePid}). Stop it before starting a new runner.`,
        );
      }
    } catch (staleCheckError) {
      if (staleCheckError instanceof Error && staleCheckError.message.includes("already active")) {
        throw staleCheckError;
      }
    }

    // Stale or malformed lock file: remove and retry once atomically.
    try {
      unlinkSync(RUNNER_LOCK_PATH);
    } catch {
      // Ignore cleanup race; retry below will fail again if another process is active.
    }

    writeOwnLock();
  }

  const releaseLock = () => {
    try {
      if (existsSync(RUNNER_LOCK_PATH)) {
        const current = readFileSync(RUNNER_LOCK_PATH, "utf-8").trim();
        if (current === String(process.pid)) {
          unlinkSync(RUNNER_LOCK_PATH);
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
  };

  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });
}

/**
 * Extract S3 key from SQS message body
 */
function extractS3KeyFromMessage(body: string): string | null {
  try {
    const s3Event = JSON.parse(body);
    if (s3Event.Records?.[0]?.s3?.object?.key) {
      return decodeURIComponent(s3Event.Records[0].s3.object.key.replaceAll("+", " "));
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Move message to DLQ and update file status
 */
async function moveToDeadLetterQueue(
  messageBody: string,
  s3Key: string | null,
  retryCount: number,
): Promise<void> {
  // Send to DLQ with actual retry count as attribute
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: DLQ_URL,
      MessageBody: messageBody,
      MessageAttributes: {
        FailedAttempts: {
          DataType: "Number",
          StringValue: String(retryCount),
        },
      },
    }),
  );

  // Update file status to DLQ
  if (s3Key) {
    const fileRecord = await getFileByS3Key(s3Key);
    if (fileRecord) {
      await updateFileStatus(fileRecord.id, "DLQ", {
        updatedAt: new Date().toISOString(),
      });
      console.log(`Updated file status to DLQ: ${s3Key}`);
    }
  }
}

/**
 * Re-enqueue message with incremented retry count for immediate retry
 */
async function reEnqueueWithRetry(messageBody: string, retryCount: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: messageBody,
      MessageAttributes: {
        RetryCount: {
          DataType: "Number",
          StringValue: String(retryCount),
        },
      },
    }),
  );
}

/**
 * Process a single message with retry/DLQ handling
 */
async function processMessage(
  messageBody: string,
  receiptHandle: string,
  retryCount: number,
): Promise<void> {
  const s3Key = extractS3KeyFromMessage(messageBody);

  const fileInfo = s3Key ? `: ${s3Key}` : "";
  console.log(`Processing message (attempt ${retryCount + 1}/${MAX_RECEIVE_COUNT})${fileInfo}`);

  // Check if we've exceeded max retries
  if (retryCount >= MAX_RECEIVE_COUNT) {
    console.log(`Max retries exceeded, moving to DLQ: ${s3Key}`);
    await moveToDeadLetterQueue(messageBody, s3Key, retryCount);
    await sqsClient.send(
      new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }),
    );
    return;
  }

  try {
    // Build SQS event
    const sqsEvent = {
      Records: [
        {
          messageId: `local-${Date.now()}`,
          body: messageBody,
          attributes: {
            ApproximateReceiveCount: String(retryCount + 1),
          },
        },
      ],
    };

    // Invoke processor and honor partial batch failures.
    // If the handler flags this record as failed, treat as an error so
    // local retry/DLQ behavior matches AWS Lambda + SQS semantics.
    const response = (await processorHandler(sqsEvent)) as SQSBatchResponse;
    const hasFailure = (response.batchItemFailures || []).length > 0;
    if (hasFailure) {
      throw new Error(`Processor reported batch failure for ${s3Key || "message"}`);
    }

    // Delete message on success
    await sqsClient.send(
      new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }),
    );

    console.log(`Successfully processed: ${s3Key}`);
  } catch (error) {
    console.error(
      `Error processing (attempt ${retryCount + 1}): ${error instanceof Error ? error.message : error}`,
    );

    // Delete the failed message and re-enqueue with incremented retry count
    await sqsClient.send(
      new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }),
    );

    await reEnqueueWithRetry(messageBody, retryCount + 1);
    console.log(`Re-enqueued for retry ${retryCount + 2}/${MAX_RECEIVE_COUNT}`);
  }
}

async function pollQueue(): Promise<void> {
  try {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        MessageAttributeNames: ["All"],
        AttributeNames: ["All"],
      }),
    );

    if (response.Messages && response.Messages.length > 0) {
      console.log(`Received ${response.Messages.length} message(s)`);

      for (const message of response.Messages) {
        if (!message.Body || !message.ReceiptHandle) continue;

        // Get retry count from our custom message attribute, default to 0
        const retryCount = Number.parseInt(
          message.MessageAttributes?.RetryCount?.StringValue || "0",
          10,
        );

        await processMessage(message.Body, message.ReceiptHandle, retryCount);
      }
    }
  } catch (error) {
    console.error("Error polling queue:", error);
  }
}

async function main(): Promise<void> {
  acquireRunnerLock();

  console.log("Starting local Lambda runner...");
  console.log(`Queue URL: ${QUEUE_URL}`);
  console.log(`DLQ URL: ${DLQ_URL}`);
  console.log(`Max retries: ${MAX_RECEIVE_COUNT}`);

  // Poll continuously
  while (true) {
    await pollQueue();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

await main();
