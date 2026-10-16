/**
 * Local Lambda runner for data-quality-checker development.
 * Polls the data-quality SQS queue and invokes the checker handler.
 */

import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { handler as dataQualityHandler } from "./data-quality-checker";

const DATA_QUALITY_QUEUE_URL = process.env.DATA_QUALITY_QUEUE_URL;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

if (!DATA_QUALITY_QUEUE_URL) {
  throw new Error("DATA_QUALITY_QUEUE_URL environment variable is required");
}
if (!AWS_REGION) {
  throw new Error("AWS_REGION environment variable is required");
}
if (!AWS_ENDPOINT_URL) {
  throw new Error("AWS_ENDPOINT_URL environment variable is required");
}

const POLL_INTERVAL = 2000;
const RUNNER_LOCK_PATH = "/tmp/filepipeline-local-data-quality-runner.lock";

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
  if (existsSync(RUNNER_LOCK_PATH)) {
    try {
      const raw = readFileSync(RUNNER_LOCK_PATH, "utf-8").trim();
      const activePid = Number.parseInt(raw, 10);
      if (processExists(activePid)) {
        throw new Error(
          `Another local data quality runner is already active (pid ${activePid}). Stop it before starting a new runner.`,
        );
      }
      unlinkSync(RUNNER_LOCK_PATH);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already active")) {
        throw error;
      }
      try {
        unlinkSync(RUNNER_LOCK_PATH);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  writeFileSync(RUNNER_LOCK_PATH, String(process.pid), "utf-8");

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

async function processMessage(message: {
  MessageId?: string;
  Body?: string;
  ReceiptHandle?: string;
  Attributes?: Record<string, string>;
}): Promise<void> {
  if (!message.Body || !message.ReceiptHandle || !message.MessageId) {
    return;
  }

  const sqsEvent: SQSEvent = {
    Records: [
      {
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body: message.Body,
        attributes: {
          ApproximateReceiveCount: message.Attributes?.ApproximateReceiveCount || "1",
          ApproximateFirstReceiveTimestamp:
            message.Attributes?.ApproximateFirstReceiveTimestamp || String(Date.now()),
          SenderId: message.Attributes?.SenderId || "local",
          SentTimestamp: message.Attributes?.SentTimestamp || String(Date.now()),
          SequenceNumber: message.Attributes?.SequenceNumber || "0",
          MessageGroupId: message.Attributes?.MessageGroupId || "local",
          MessageDeduplicationId: message.Attributes?.MessageDeduplicationId || message.MessageId,
          DeadLetterQueueSourceArn: message.Attributes?.DeadLetterQueueSourceArn || "",
          AWSTraceHeader: message.Attributes?.AWSTraceHeader || "",
        },
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: DATA_QUALITY_QUEUE_URL!,
        awsRegion: AWS_REGION!,
      },
    ],
  };

  console.log("Processing data quality trigger", {
    messageId: message.MessageId,
    receiveCount: message.Attributes?.ApproximateReceiveCount || "1",
  });

  let response: void | SQSBatchResponse;
  try {
    response = await dataQualityHandler(sqsEvent);
  } catch (error) {
    console.error("Data quality handler failed", {
      messageId: message.MessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const failedIds = new Set((response?.batchItemFailures || []).map((item) => item.itemIdentifier));
  if (failedIds.has(message.MessageId)) {
    console.warn("Data quality handler requested retry", {
      messageId: message.MessageId,
    });
    return;
  }

  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: DATA_QUALITY_QUEUE_URL,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );

  console.log("Successfully processed data quality trigger", {
    messageId: message.MessageId,
  });
}

async function pollQueue(): Promise<void> {
  try {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: DATA_QUALITY_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        AttributeNames: ["All"],
      }),
    );

    if (!response.Messages?.length) {
      return;
    }

    console.log(`Received ${response.Messages.length} data quality message(s)`);
    for (const message of response.Messages) {
      await processMessage(message);
    }
  } catch (error) {
    console.error("Error polling data quality queue:", error);
  }
}

async function main(): Promise<void> {
  acquireRunnerLock();

  console.log("Starting local data quality runner...");
  console.log(`Queue URL: ${DATA_QUALITY_QUEUE_URL}`);

  while (true) {
    await pollQueue();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

await main();
