import type { ScheduledEvent } from "aws-lambda";
import sgMail from "@sendgrid/mail";
import type { MailDataRequired } from "@sendgrid/mail";
import { DynamoDBClient, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? "";
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET ?? "";

const EMAIL_TO = [] satisfies MailDataRequired["to"];
const EMAIL_FROM: MailDataRequired["from"] = "";
const EMAIL_SUBJECT_TEMPLATE: NonNullable<MailDataRequired["subject"]> =
  "Daily File Ingestion & Processing Summary – {{date}}";
const EMAIL_BODY_TEMPLATE: NonNullable<MailDataRequired["html"]> = `<html><body><div>Hi Team,

Please find below the summary of file ingestion and processing for {{date}}.

<b style="text-transform: uppercase;">Ingestion Summary — Feature 2</b><br/>
<b>ZIP Files Ingested (Total):</b> {{kw_zip_total}}<br/>
<b>ZIP Files by Platform</b>
{{kw_zip_by_platform}}
<b>JSON Files Ingested (Total):</b> {{kw_json_total}}<br/>
<b>JSON Files by Platform</b>
{{kw_json_by_platform}}
<b>JSON Files by Country</b>
{{kw_json_by_country}}
<b>Unique Products Ingested (Total):</b> {{kw_products_ingested_total}}<br/>
<b>Unique Products by Platform</b>
{{kw_products_ingested_by_platform}}
<b>Unique Products by Country</b>
{{kw_products_ingested_by_country}}

<b style="text-transform: uppercase;">Processing Summary — Feature 2</b><br/>
<b>Unique Products in Output (Total):</b> {{kw_products_output_total}}<br/>
<b>Unique Products by Platform</b>
{{kw_products_output_by_platform}}
<b>Unique Products by Country</b>
{{kw_products_output_by_country}}

<b style="text-transform: uppercase;">Ingestion Summary — Feature 1</b><br/>
<b>ZIP Files Ingested (Total):</b> {{other_zip_total}}<br/>
<b>ZIP Files by Platform</b>
{{other_zip_by_platform}}
<b>JSON Files Ingested (Total):</b> {{other_json_total}}<br/>
<b>JSON Files by Platform</b>
{{other_json_by_platform}}
<b>JSON Files by Country</b>
{{other_json_by_country}}
<b>Unique Products Ingested (Total):</b> {{other_products_ingested_total}}<br/>
<b>Unique Products by Platform</b>
{{other_products_ingested_by_platform}}
<b>Unique Products by Country</b>
{{other_products_ingested_by_country}}

<b style="text-transform: uppercase;">Processing Summary — Feature 1</b><br/>
<b>Unique Products in Output (Total):</b> {{other_products_output_total}}<br/>
<b>Unique Products by Platform</b>
{{other_products_output_by_platform}}
<b>Unique Products by Country</b>
{{other_products_output_by_country}}

Best regards,
Data Ingestion & Processing Service
(This is an automated email, please do not reply)
</div></body></html>`;

const dynamodb = new DynamoDBClient({ region: "ap-southeast-1" });
const s3 = new S3Client({ region: "ap-southeast-1" });
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE;
const CONSOLIDATION_TABLE = process.env.CONSOLIDATION_TABLE;

interface FileRecord {
  readonly vendor: string;
  readonly s3Key: string;
  readonly status: string;
  readonly failureReason: string;
  readonly discoveredFileCount: number | null;
  readonly ingestedFileCount: number | null;
  readonly parsedFileCount: number | null;
  readonly failedJsonSourceFiles: string[] | null;
  readonly rowCount: number;
  readonly successCount: number;
  readonly country: string;
  readonly createdAt: string;
}

interface FailedSource {
  readonly file: string;
  readonly reason: string;
}

interface ConsolidationStateRecord {
  readonly vendor: string;
  readonly outputRowCountTotal: number;
}

interface ProcessingOverride {
  readonly total: number;
  readonly byPlatform: Record<string, number>;
  readonly byCountry: Record<string, number>;
}

function getStringAttr(item: Record<string, AttributeValue>, key: string): string | null {
  const value = item[key];
  if (!value || !("S" in value)) {
    return null;
  }

  return value.S ?? null;
}

function getNumberAttr(item: Record<string, AttributeValue>, key: string): number | null {
  const value = item[key];
  if (!value || !("N" in value)) {
    return null;
  }

  const parsed = Number(value.N);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringListAttr(item: Record<string, AttributeValue>, key: string): string[] | null {
  const value = item[key];
  if (!value) {
    return null;
  }

  if ("SS" in value && Array.isArray(value.SS)) {
    return value.SS.filter((entry): entry is string => typeof entry === "string");
  }

  if ("L" in value && Array.isArray(value.L)) {
    const entries: string[] = [];
    for (const entry of value.L) {
      if ("S" in entry && typeof entry.S === "string") {
        entries.push(entry.S);
      }
    }
    return entries;
  }

  return null;
}

function getFailureReasonAttr(item: Record<string, AttributeValue>): string {
  const value = item["errors"];
  if (value && "L" in value && Array.isArray(value.L)) {
    for (const entry of value.L) {
      if (!("M" in entry)) continue;
      const map = entry.M;
      if (!map) continue;
      const message = map["message"];
      if (message && "S" in message) {
        const messageText = message.S;
        if (!messageText) continue;
        const trimmed = messageText.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }

  return "No detailed failure reason recorded";
}

function toFileRecord(item: Record<string, AttributeValue>): FileRecord | null {
  const vendor = getStringAttr(item, "vendor");
  const s3Key = getStringAttr(item, "s3Key");
  const createdAt = getStringAttr(item, "createdAt");
  const status = getStringAttr(item, "status") ?? "UNKNOWN";
  const failureReason = getFailureReasonAttr(item);
  const discoveredFileCount = getNumberAttr(item, "discoveredFileCount");
  const ingestedFileCount = getNumberAttr(item, "ingestedFileCount");
  const parsedFileCount = getNumberAttr(item, "parsedFileCount");
  const failedJsonSourceFiles = getStringListAttr(item, "failedJsonSourceFiles");
  const rowCount = getNumberAttr(item, "rowCount");
  const successCount = getNumberAttr(item, "successCount") ?? 0;
  const country = getStringAttr(item, "country") ?? "";

  if (!vendor || !s3Key || !createdAt || rowCount === null) {
    return null;
  }

  return {
    vendor,
    s3Key,
    status,
    failureReason,
    discoveredFileCount,
    ingestedFileCount,
    parsedFileCount,
    failedJsonSourceFiles,
    rowCount,
    successCount,
    country,
    createdAt,
  };
}

async function getFilesForDate(datePrefix: string): Promise<FileRecord[]> {
  if (!DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is not configured for email summariser Lambda.");
  }

  const records: FileRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamodb.send(
      new ScanCommand({
        TableName: DYNAMODB_TABLE,
        ProjectionExpression:
          "#vendor, #s3Key, #status, #errors, #discoveredFileCount, #ingestedFileCount, #parsedFileCount, #failedJsonSourceFiles, #rowCount, #successCount, #country, #createdAt",
        FilterExpression: "begins_with(#createdAt, :datePrefix)",
        ExpressionAttributeNames: {
          "#vendor": "vendor",
          "#s3Key": "s3Key",
          "#status": "status",
          "#errors": "errors",
          "#discoveredFileCount": "discoveredFileCount",
          "#ingestedFileCount": "ingestedFileCount",
          "#parsedFileCount": "parsedFileCount",
          "#failedJsonSourceFiles": "failedJsonSourceFiles",
          "#rowCount": "rowCount",
          "#successCount": "successCount",
          "#country": "country",
          "#createdAt": "createdAt",
        },
        ExpressionAttributeValues: {
          ":datePrefix": { S: datePrefix },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const record = toFileRecord(item);
      if (record) {
        records.push(record);
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return records;
}

function toConsolidationStateRecord(
  item: Record<string, AttributeValue>,
): ConsolidationStateRecord | null {
  const pk = getStringAttr(item, "pk");
  const outputRowCountTotal = getNumberAttr(item, "outputRowCountTotal");
  if (!pk || outputRowCountTotal === null) return null;

  const [vendor] = pk.split("#");
  if (!vendor) return null;

  return {
    vendor,
    outputRowCountTotal,
  };
}

async function getConsolidationStatesForDate(date: string): Promise<ConsolidationStateRecord[]> {
  if (!CONSOLIDATION_TABLE) {
    return [];
  }

  const records: ConsolidationStateRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamodb.send(
      new ScanCommand({
        TableName: CONSOLIDATION_TABLE,
        ProjectionExpression: "#pk, #sk, #outputRowCountTotal",
        FilterExpression: "#sk = :state AND contains(#pk, :dateSuffix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#outputRowCountTotal": "outputRowCountTotal",
        },
        ExpressionAttributeValues: {
          ":state": { S: "state" },
          ":dateSuffix": { S: `#${date}` },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const record = toConsolidationStateRecord(item);
      if (record) records.push(record);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return records;
}

function groupConsolidatedOutputByPlatform(
  records: ConsolidationStateRecord[],
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const record of records) {
    grouped[record.vendor] = (grouped[record.vendor] ?? 0) + record.outputRowCountTotal;
  }
  return grouped;
}

async function listObjectKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const entry of response.Contents ?? []) {
      if (entry.Key) keys.push(entry.Key);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function countCsvRowsStreaming(body: unknown): Promise<number> {
  if (!body) return 0;
  const maybeBody = body as any;
  let newlineCount = 0;
  let totalBytes = 0;

  if (typeof maybeBody.transformToByteArray === "function") {
    const bytes: Uint8Array = await maybeBody.transformToByteArray();
    for (const b of bytes) {
      if (b === 0x0a) newlineCount++;
    }
    totalBytes = bytes.length;
  } else {
    for await (const chunk of maybeBody as NodeJS.ReadableStream) {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlineCount++;
      }
    }
  }

  if (totalBytes === 0) return 0;
  return Math.max(0, newlineCount - 1);
}

async function getConsolidatedSuccessByCountry(date: string): Promise<Record<string, number>> {
  if (!PROCESSED_BUCKET) return {};

  const [year, month, day] = date.split("-");

  const allKeys = await listObjectKeys(PROCESSED_BUCKET, "tagged_output/platform=");
  const consolidatedKeys = allKeys.filter(
    (key) =>
      key.includes(`/year=${year}/month=${month}/day=${day}/`) && key.endsWith("/consolidated.csv"),
  );

  const byCountry: Record<string, number> = {};
  for (const key of consolidatedKeys) {
    const parts = key.split("/");
    const country = parts.length >= 2 ? parts[parts.length - 2] : "UNKNOWN";

    const objectResponse = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );

    const rowCount = await countCsvRowsStreaming(objectResponse.Body);
    byCountry[country] = (byCountry[country] ?? 0) + rowCount;
  }

  return byCountry;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatAsTable(entries: [string, number][]): string {
  const sorted = entries
    .filter(([key]) => key !== "UNKNOWN")
    .sort(([a], [b]) => a.localeCompare(b));
  const td = "padding:4px 12px;border:1px solid #ccc";
  const headers = sorted
    .map(([key]) => `<td style="${td};font-weight:bold">${key.toUpperCase()}</td>`)
    .join("");
  const values = sorted.map(([, val]) => `<td style="${td}">${fmtNum(val)}</td>`).join("");
  return `<table style="border-collapse:collapse"><tr>${headers}</tr><tr>${values}</tr></table>`;
}

function formatGroupedCounts(
  records: FileRecord[],
  keyFn: (r: FileRecord) => string = (r) => r.vendor,
): string {
  const grouped = new Map<string, number>();
  for (const record of records) {
    const key = keyFn(record);
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  return formatAsTable([...grouped.entries()]);
}

function formatGroupedTotals(
  records: FileRecord[],
  valueFn: (r: FileRecord) => number = (r) => r.rowCount,
  keyFn: (r: FileRecord) => string = (r) => r.vendor,
): string {
  const grouped = new Map<string, number>();
  for (const record of records) {
    const key = keyFn(record);
    grouped.set(key, (grouped.get(key) ?? 0) + valueFn(record));
  }

  return formatAsTable([...grouped.entries()]);
}

function groupCounts(
  records: FileRecord[],
  keyFn: (r: FileRecord) => string = (r) => r.vendor,
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const record of records) {
    const key = keyFn(record);
    if (key === "UNKNOWN") continue;
    grouped[key] = (grouped[key] ?? 0) + 1;
  }
  return grouped;
}

function groupTotals(
  records: FileRecord[],
  valueFn: (r: FileRecord) => number = (r) => r.rowCount,
  keyFn: (r: FileRecord) => string = (r) => r.vendor,
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const record of records) {
    const key = keyFn(record);
    if (key === "UNKNOWN") continue;
    grouped[key] = (grouped[key] ?? 0) + valueFn(record);
  }
  return grouped;
}

function extractRequestType(s3Key: string): string {
  const match = s3Key.match(/request_type=([^/]+)/);
  return match?.[1] ?? "unknown";
}

function isKeywordProducts(record: FileRecord): boolean {
  return extractRequestType(record.s3Key) === "keyword-products";
}

function getParsedSourceFileCount(record: FileRecord): number {
  return record.ingestedFileCount || record.parsedFileCount || 1;
}

function getFailedSources(records: FileRecord[]): FailedSource[] {
  return records
    .filter((record) => record.status === "FAILED" || record.status === "DLQ")
    .map((record) => ({
      file: record.s3Key,
      reason: record.failureReason,
    }));
}

function getFailedJsonSources(records: FileRecord[]): FailedSource[] {
  return records.flatMap((record) => {
    if (record.status !== "FAILED" && record.status !== "DLQ") return [];
    if (!record.failedJsonSourceFiles || record.failedJsonSourceFiles.length === 0) return [];

    return record.failedJsonSourceFiles.map((path) => ({
      file: path,
      reason: record.failureReason,
    }));
  });
}

function buildCategoryReplacements(
  prefix: string,
  sourceRecords: FileRecord[],
  zipRecords: FileRecord[],
  byCountry: (r: FileRecord) => string,
  options?: {
    readonly processingSuccessOverride?: ProcessingOverride;
  },
): Record<string, string> {
  const productsIngestedTotal = sourceRecords.reduce((sum, r) => sum + r.rowCount, 0);
  const processingSuccessOverride = options?.processingSuccessOverride;
  const productsOutputTotal =
    processingSuccessOverride?.total ?? sourceRecords.reduce((sum, r) => sum + r.successCount, 0);

  const productsOutputByPlatform = processingSuccessOverride?.byPlatform
    ? formatAsTable(Object.entries(processingSuccessOverride.byPlatform))
    : formatGroupedTotals(sourceRecords, (r) => r.successCount);

  const productsOutputByCountry = processingSuccessOverride?.byCountry
    ? formatAsTable(Object.entries(processingSuccessOverride.byCountry))
    : formatGroupedTotals(sourceRecords, (r) => r.successCount, byCountry);

  return {
    [`{{${prefix}_zip_total}}`]: String(zipRecords.length),
    [`{{${prefix}_zip_by_platform}}`]: formatGroupedCounts(zipRecords),
    [`{{${prefix}_json_total}}`]: String(
      sourceRecords.reduce((sum, r) => sum + getParsedSourceFileCount(r), 0),
    ),
    [`{{${prefix}_json_by_platform}}`]: formatGroupedTotals(
      sourceRecords,
      getParsedSourceFileCount,
    ),
    [`{{${prefix}_json_by_country}}`]: formatGroupedTotals(
      sourceRecords,
      getParsedSourceFileCount,
      byCountry,
    ),
    [`{{${prefix}_products_ingested_total}}`]: fmtNum(productsIngestedTotal),
    [`{{${prefix}_products_ingested_by_platform}}`]: formatGroupedTotals(sourceRecords),
    [`{{${prefix}_products_ingested_by_country}}`]: formatGroupedTotals(
      sourceRecords,
      (r) => r.rowCount,
      byCountry,
    ),
    [`{{${prefix}_products_output_total}}`]: fmtNum(productsOutputTotal),
    [`{{${prefix}_products_output_by_platform}}`]: productsOutputByPlatform,
    [`{{${prefix}_products_output_by_country}}`]: productsOutputByCountry,
  };
}

function buildCategoryMetrics(
  sourceRecords: FileRecord[],
  zipRecords: FileRecord[],
  byCountry: (r: FileRecord) => string,
  options?: {
    readonly processingSuccessOverride?: ProcessingOverride;
  },
) {
  const processingSuccessOverride = options?.processingSuccessOverride;
  const failedZipSources = getFailedSources(zipRecords);
  const failedJsonSources = getFailedJsonSources(sourceRecords);

  return {
    ingestion: {
      zipFilesTotal: zipRecords.length,
      zipFilesFailed: failedZipSources.length,
      zipFilesFailedSources: failedZipSources,
      zipFilesByPlatform: groupCounts(zipRecords),
      jsonFilesTotal: sourceRecords.reduce((sum, r) => sum + getParsedSourceFileCount(r), 0),
      jsonFilesFailed: failedJsonSources.length,
      jsonFilesFailedSources: failedJsonSources,
      jsonFilesByPlatform: groupTotals(sourceRecords, getParsedSourceFileCount),
      jsonFilesByCountry: groupTotals(sourceRecords, getParsedSourceFileCount, byCountry),
      uniqueProductsTotal: sourceRecords.reduce((sum, r) => sum + r.rowCount, 0),
      uniqueProductsByPlatform: groupTotals(sourceRecords),
      uniqueProductsByCountry: groupTotals(sourceRecords, (r) => r.rowCount, byCountry),
    },
    processing: {
      uniqueProductsTotal:
        processingSuccessOverride?.total ??
        sourceRecords.reduce((sum, r) => sum + r.successCount, 0),
      uniqueProductsByPlatform:
        processingSuccessOverride?.byPlatform ?? groupTotals(sourceRecords, (r) => r.successCount),
      uniqueProductsByCountry:
        processingSuccessOverride?.byCountry ??
        groupTotals(sourceRecords, (r) => r.successCount, byCountry),
    },
  };
}

function replaceTemplateValues(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [placeholder, value] of Object.entries(values)) {
    output = output.split(placeholder).join(value);
  }
  return output;
}

export async function handler(_event: ScheduledEvent): Promise<void> {
  if (!SENDGRID_API_KEY) {
    throw new Error("SendGrid API key placeholder is still in use. Replace SENDGRID_API_KEY.");
  }

  if (!DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is not configured for email summariser Lambda.");
  }

  sgMail.setApiKey(SENDGRID_API_KEY);

  const yesterdayDate = new Date(Date.now() - 86400000);
  const yesterday = yesterdayDate.toISOString().split("T")[0];
  const yesterdayFormatted = yesterdayDate.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const yesterdayRecords = await getFilesForDate(yesterday);
  const sourceRecords = yesterdayRecords.filter(
    (record) =>
      record.s3Key.startsWith("file_type=json/") || record.s3Key.startsWith("file_type=html/"),
  );
  const byCountry = (r: FileRecord) => r.country || "UNKNOWN";

  const kwSource = sourceRecords.filter(isKeywordProducts);
  const otherSource = sourceRecords.filter((r) => !isKeywordProducts(r));
  const kwZip = kwSource.filter((r) => r.s3Key.endsWith(".zip"));
  const otherZip = otherSource.filter((r) => r.s3Key.endsWith(".zip"));
  const consolidationStates = await getConsolidationStatesForDate(yesterday);
  const consolidatedByPlatform = groupConsolidatedOutputByPlatform(consolidationStates);
  const consolidatedSuccessTotal = Object.values(consolidatedByPlatform).reduce(
    (sum, count) => sum + count,
    0,
  );
  const consolidatedByCountry = await getConsolidatedSuccessByCountry(yesterday);

  const replacements: Record<string, string> = {
    "{{date}}": yesterdayFormatted,
    ...buildCategoryReplacements("kw", kwSource, kwZip, byCountry),
    ...buildCategoryReplacements("other", otherSource, otherZip, byCountry, {
      processingSuccessOverride: {
        total: consolidatedSuccessTotal,
        byPlatform: consolidatedByPlatform,
        byCountry: consolidatedByCountry,
      },
    }),
  };

  const subject = replaceTemplateValues(EMAIL_SUBJECT_TEMPLATE, replacements);
  const html = replaceTemplateValues(EMAIL_BODY_TEMPLATE, replacements).replace(/\n/g, "<br>\n");

  const response = await sgMail.send({
    to: EMAIL_TO,
    from: EMAIL_FROM,
    subject,
    html,
  });

  console.log("SendGrid response:", JSON.stringify(response, null, 2));
  console.log(`Email summary sent to ${EMAIL_TO.join(", ")}`);
  console.log(`Summariser source table: ${DYNAMODB_TABLE}`);
  console.log(`Summariser records used for ${yesterday}: ${yesterdayRecords.length}`);
  console.log(`Summariser source records used for ${yesterday}: ${sourceRecords.length}`);

  // Write metrics JSON to S3
  if (PROCESSED_BUCKET) {
    const metrics = {
      date: yesterday,
      dateFormatted: yesterdayFormatted,
      feature2: buildCategoryMetrics(kwSource, kwZip, byCountry),
      feature1: buildCategoryMetrics(otherSource, otherZip, byCountry, {
        processingSuccessOverride: {
          total: consolidatedSuccessTotal,
          byPlatform: consolidatedByPlatform,
          byCountry: consolidatedByCountry,
        },
      }),
    };

    const dateCompact = yesterday.replace(/-/g, "");
    const metricsKey = `metrics/${dateCompact}_Daily File Ingestion & Processing Summary.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: metricsKey,
        Body: JSON.stringify(metrics, null, 2),
        ContentType: "application/json",
      }),
    );
    console.log(`Metrics JSON written to s3://${PROCESSED_BUCKET}/${metricsKey}`);
  } else {
    console.log("PROCESSED_BUCKET not set — skipping metrics JSON write");
  }
}
