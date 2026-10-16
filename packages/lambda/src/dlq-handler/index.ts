import { randomUUID } from "node:crypto";
import { createFileRecord, getFileByS3Key, updateFileStatus } from "../../utils/dynamodb";
import { parseS3Key } from "../../utils/s3";
import { extractDateFromFilename } from "@filepipeline/shared/utility/date-extraction";

/**
 * Consumes messages that SQS has moved to filepipeline-dlq after the processing
 * queue's redrive policy exhausts maxReceiveCount, and marks the matching
 * file record `status: "DLQ"` in DynamoDB.
 *
 * This exists because the processor Lambda's own DLQ bookkeeping
 * (markFileForDLQ in processor/index.ts) only runs from within its own
 * in-process error handling — code that a hard Lambda execution timeout
 * bypasses entirely (the runtime kills the invocation with no chance for any
 * catch/finally to run). A file that times out on every retry attempt never
 * gets marked FAILED or DLQ, so it silently disappears from the
 * zipFilesFailed dashboard metric even though it genuinely dead-lettered.
 * This handler is triggered directly by the DLQ's own SQS event source, so it
 * fires regardless of why the original invocations failed.
 */

interface SQSEvent {
  Records: Array<{
    messageId: string;
    body: string;
  }>;
}

interface S3EventMessage {
  Records: Array<{
    s3: {
      bucket: { name: string };
      object: { key: string };
    };
  }>;
}

function extractS3Keys(body: string): string[] {
  let s3Event: S3EventMessage;
  try {
    s3Event = JSON.parse(body);
  } catch (parseError) {
    console.error(`Failed to parse DLQ message body: ${parseError}`);
    return [];
  }

  return (s3Event.Records ?? []).map((record) =>
    decodeURIComponent(record.s3.object.key.replaceAll("+", " ")),
  );
}

async function markFileForDLQ(s3Key: string): Promise<void> {
  const fileRecord = await getFileByS3Key(s3Key);

  if (fileRecord) {
    await updateFileStatus(fileRecord.id, "DLQ");
    return;
  }

  // No record exists yet (e.g. the original invocation timed out before ever
  // reaching the point where it would have created one) — create one so the
  // dashboard can still see this file as failed.
  const { vendor, filename } = parseS3Key(s3Key);
  const now = new Date().toISOString();
  const extractedDate = extractDateFromFilename(filename);
  const createdAtDate = extractedDate ? `${extractedDate}T00:00:00.000Z` : now;

  await createFileRecord({
    id: randomUUID(),
    s3Key,
    vendor,
    filename,
    status: "DLQ",
    queuedAt: now,
    createdAt: createdAtDate,
    updatedAt: now,
  });
}

export async function handler(event: SQSEvent): Promise<void> {
  console.log(`DLQ handler triggered: ${event.Records.length} record(s)`);

  for (const record of event.Records) {
    for (const s3Key of extractS3Keys(record.body)) {
      try {
        await markFileForDLQ(s3Key);
        console.log(`Marked as DLQ: ${s3Key}`);
      } catch (error) {
        console.error(`Failed to mark file as DLQ for ${s3Key}:`, error);
      }
    }
  }
}
