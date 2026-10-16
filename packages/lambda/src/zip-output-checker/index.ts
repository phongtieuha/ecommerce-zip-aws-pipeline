import type { SQSHandler } from "aws-lambda";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import sgMail from "@sendgrid/mail";
import { buildConsolidatedOutputKey, isArchivedIncomingKey } from "../../utils/s3";

const s3 = new S3Client({
  region: "ap-southeast-1",
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: !!process.env.AWS_ENDPOINT_URL,
});

const sqs = new SQSClient({
  region: "ap-southeast-1",
  endpoint: process.env.AWS_ENDPOINT_URL,
});

const ZIP_CHECK_QUEUE_URL = process.env.ZIP_CHECK_QUEUE_URL;
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? "";
const ALERT_EMAIL_TO = [""];
const ALERT_EMAIL_FROM = "";
const CHECK_DELAY_MINUTES = 5;

interface PendingZipCheck {
  readonly s3Key: string;
  readonly channel: string;
  readonly fileType: string; // json or html
  readonly filename: string;
  readonly receivedAt: string; // ISO timestamp
}

/**
 * Extract vendor and date from S3 key.
 * Current format: file_type=json/channel=lazada/request_type=product-skus/filename.zip
 * The date isn't a path segment — it's embedded in the filename itself, in one of
 * two conventions seen across vendor uploads: dashed (2026-03-04) or compact,
 * optionally with a time suffix (20260503T034700).
 */
const extractMetadataFromKey = (
  key: string,
): { fileType: string; channel: string; date: string; filename: string } | null => {
  const fileTypeMatch = key.match(/file_type=([^/]+)/);
  const channelMatch = key.match(/channel=([^/]+)/);
  const filename = key.split("/").pop() || "";
  const dateMatch =
    filename.match(/(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/) ||
    filename.match(/(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);

  if (!fileTypeMatch || !channelMatch || !dateMatch) {
    return null;
  }

  const fileType = fileTypeMatch[1];
  const channel = channelMatch[1];
  const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

  return { fileType, channel, date, filename };
};

/**
 * Normalise incoming event into a flat list of S3 keys.
 * Accepts either:
 *  - Standard S3 notification: { Records: [{ s3: { object: { key } } }] }
 *  - EventBridge S3 event:     { detail: { bucket: { name }, object: { key } } }
 */
interface S3EventRecord {
  s3: { bucket: { name: string }; object: { key: string } };
}

const toS3Records = (event: unknown): S3EventRecord[] => {
  const e = event as Record<string, unknown>;

  // EventBridge S3 Object Created
  if (e["detail"] && !e["Records"]) {
    const detail = e["detail"] as Record<string, unknown>;
    const bucket = ((detail["bucket"] as Record<string, unknown>)?.["name"] as string) ?? "";
    const key = ((detail["object"] as Record<string, unknown>)?.["key"] as string) ?? "";
    if (key) return [{ s3: { bucket: { name: bucket }, object: { key } } }];
    return [];
  }

  // Standard S3 notification
  const records = e["Records"];
  if (Array.isArray(records)) {
    return records as S3EventRecord[];
  }

  return [];
};

/**
 * S3 event handler: schedule a one-shot delayed check for each incoming ZIP.
 * Accepts both direct S3 notifications and EventBridge S3 events.
 */
export const handleS3ZipArrival = async (event: unknown): Promise<void> => {
  if (!ZIP_CHECK_QUEUE_URL) {
    console.log("ZIP_CHECK_QUEUE_URL not configured, skipping");
    return;
  }

  for (const record of toS3Records(event)) {
    const s3Key = decodeURIComponent(record.s3.object.key);
    console.log("Processing S3 key:", s3Key);

    if (!s3Key.endsWith(".zip")) {
      console.log("Skipped: not a ZIP file");
      continue;
    }

    // The processor's archive copy (moveObject) is itself an S3 "Object Created"
    // event ending in .zip, so it matches this same EventBridge rule — without
    // this guard, every ZIP schedules two independent checks (one per event)
    // and, if the CSV is missing, sends two duplicate alert emails.
    if (isArchivedIncomingKey(s3Key)) {
      console.log("Skipped: archive copy, not the original upload");
      continue;
    }

    const metadata = extractMetadataFromKey(s3Key);
    if (!metadata) {
      console.log("Skipped: could not extract metadata from key");
      continue;
    }

    const { channel, filename, fileType } = metadata;
    const receivedAt = new Date().toISOString();

    const check: PendingZipCheck = { s3Key, channel, fileType, filename, receivedAt };

    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: ZIP_CHECK_QUEUE_URL,
          MessageBody: JSON.stringify(check),
          DelaySeconds: CHECK_DELAY_MINUTES * 60,
        }),
      );
      console.log(`Scheduled ZIP check: ${filename}`);
    } catch (err) {
      console.error("Failed to schedule ZIP check", { filename, err });
    }
  }
};

/**
 * Check whether the specific CSV this ZIP should have produced exists in the
 * output bucket. Uses the same key derivation as the processor
 * (buildConsolidatedOutputKey) so this matches the exact file for this run,
 * not just any CSV that happens to exist under the shared
 * channel/request_type output folder — multiple runs for the same
 * channel/request_type write into that same folder, so a prefix-only check
 * would find an unrelated sibling run's CSV and mask this run's failure.
 */
const csvExistsForZip = async (record: PendingZipCheck): Promise<boolean> => {
  if (!PROCESSED_BUCKET) {
    console.log("PROCESSED_BUCKET not set, assuming CSV exists");
    return true;
  }

  const expectedKey = buildConsolidatedOutputKey(
    "",
    "",
    "",
    record.filename,
    undefined,
    record.s3Key,
  );

  try {
    await s3.send(new HeadObjectCommand({ Bucket: PROCESSED_BUCKET, Key: expectedKey }));
    console.log(`Found CSV at ${expectedKey}`);
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) {
      return false;
    }
    console.error(`Error checking CSV at ${expectedKey}:`, err);
    return false;
  }
};

/**
 * Send alert email for missing CSV.
 */
const sendMissingCsvAlert = async (zipRecord: PendingZipCheck): Promise<void> => {
  const subject = `[Alert] Missing CSV Output — ZIP: ${zipRecord.filename}`;
  const body = `<html><body>
<p>Hi,</p>
<p>A ZIP file arrived in the incoming bucket but no corresponding CSV output was produced within 5 minutes.</p>

<p><b>ZIP Details:</b></p>
<ul>
  <li><b>Filename:</b> ${zipRecord.filename}</li>
  <li><b>Channel:</b> ${zipRecord.channel}</li>
  <li><b>File Type:</b> ${zipRecord.fileType}</li>
  <li><b>S3 Key:</b> ${zipRecord.s3Key}</li>
  <li><b>Received:</b> ${zipRecord.receivedAt}</li>
</ul>

<p>Please investigate the processing pipeline.</p>
<p>Best regards,<br/>ZIP Output Checker<br/>(Automated alert)</p>
</body></html>`;

  await sgMail.send({
    to: ALERT_EMAIL_TO as string[],
    from: ALERT_EMAIL_FROM,
    subject,
    html: body,
  });
  console.log(`Alert email sent for ${zipRecord.filename}`);
};

interface SQSBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * SQS delay-queue handler: each message is one ZIP's delayed check, delivered
 * exactly 5 minutes after arrival (via the message's own DelaySeconds). Checks
 * whether the expected CSV exists and sends an alert if not — no shared state,
 * no scan, one message in, one check out.
 */
export const handleDelayedCheck: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const sqsRecord of event.Records) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key placeholder is still in use. Replace SENDGRID_API_KEY.");
      }
      sgMail.setApiKey(SENDGRID_API_KEY);

      const check = JSON.parse(sqsRecord.body) as PendingZipCheck;
      const csvExists = await csvExistsForZip(check);

      if (!csvExists) {
        console.log(`CSV missing for ${check.filename}, sending alert`);
        await sendMissingCsvAlert(check);
      } else {
        console.log(`CSV found for ${check.filename}, nothing to do`);
      }
    } catch (err) {
      console.error("Delayed check failed for message", sqsRecord.messageId, err);
      batchItemFailures.push({ itemIdentifier: sqsRecord.messageId });
    }
  }

  return { batchItemFailures };
};
