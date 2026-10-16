import { S3Handler } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import sgMail from "@sendgrid/mail";
import { parseS3Key } from "../../utils/s3";
import { extractNormalizedDate } from "./date-utils";
import { parseBooleanEnv, validateCSVRecords, buildErrorReport } from "./validation";
import { loadVendorMapping, loadVendorMappingIndex } from "../processor/schema/index";
import type { FieldMapping, ValidationError } from "@filepipeline/shared";

const ENABLE_VALIDATION = parseBooleanEnv("ENABLE_FEATURE1_VALIDATION", false);
const ENABLE_ERROR_REPORT = parseBooleanEnv("ENABLE_FEATURE1_ERROR_REPORT", false);

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? "";
const NULL_ALERT_THRESHOLD = 0.25; // Send alert if >= 25% of mandatory fields have 100% null

const ALERT_EMAIL_TO = [] as const;
const ALERT_EMAIL_FROM = "";

const sendNullFieldAlert = async (
  vendor: string,
  region: string,
  date: string,
  fieldsAt100Pct: string[],
  totalMandatoryFields: number,
  inputFiles: string[],
  receivedFileCount: number,
  expectedFileCount: number,
  droppedSourceProductIdCount: number,
): Promise<void> => {
  if (!SENDGRID_API_KEY) {
    console.log("SENDGRID_API_KEY not set — skipping null field alert email");
    return;
  }

  sgMail.setApiKey(SENDGRID_API_KEY);

  const pctAffected = ((fieldsAt100Pct.length / totalMandatoryFields) * 100).toFixed(1);
  const fileStatus = `${receivedFileCount} of ${expectedFileCount} file(s) received`;
  const isPartial = receivedFileCount < expectedFileCount;

  const subject = `[Alert] ${vendor} / ${region} — ${pctAffected}% mandatory fields fully null, dropped source_product_id rows: ${droppedSourceProductIdCount}${isPartial ? " (partial)" : ""} (${date})`;
  const body = `<html><body>
<p>Hi Team,</p>
<p>The consolidated output for <b>${vendor}</b> region <b>${region}</b> on <b>${date}</b> has 
<b>${fieldsAt100Pct.length}</b> out of <b>${totalMandatoryFields}</b> mandatory fields (${pctAffected}%) 
with <b>100% null values</b>.</p>

<p><b>File status:</b> ${fileStatus}${isPartial ? " — null fields may be populated once remaining files arrive." : ""}</p>

<p><b>Dropped rows (missing source_product_id):</b> ${droppedSourceProductIdCount}</p>

<p><b>Affected fields:</b></p>
<ul>${fieldsAt100Pct.map((f) => `<li>${f}</li>`).join("")}</ul>

<p><b>Input files used:</b></p>
<ul>${inputFiles.map((f) => `<li>${f}</li>`).join("")}</ul>

<p>Please investigate the source data.</p>
<p>Best regards,<br/>Data Ingestion &amp; Processing Service<br/>(Automated alert)</p>
</body></html>`;

  try {
    await sgMail.send({
      to: [...ALERT_EMAIL_TO],
      from: ALERT_EMAIL_FROM,
      subject,
      html: body,
    });
    console.log(`Null field alert email sent for ${vendor}/${region}/${date}`);
  } catch (err) {
    console.error("Failed to send null field alert email", err);
  }
};

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) {
    throw new Error("S3 object body is empty");
  }

  const maybeBody = body as any;

  if (maybeBody instanceof Uint8Array) {
    return Buffer.from(maybeBody);
  }

  if (typeof maybeBody.transformToByteArray === "function") {
    const bytes = await maybeBody.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof maybeBody.transformToString === "function") {
    const text = await maybeBody.transformToString();
    return Buffer.from(text, "utf-8");
  }

  if (typeof maybeBody.on === "function") {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      maybeBody.on("data", (chunk: Buffer | Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      maybeBody.on("end", () => resolve(Buffer.concat(chunks)));
      maybeBody.on("error", reject);
    });
  }

  if (typeof maybeBody[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of maybeBody as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 object body type");
};

const consolidationPathsMap = {
  711: ["request_type=shop-products/", "request_type=product-skus/"],
  JD: ["request_type=shop-products/", "request_type=product-skus/"],
  Lazada: [
    "request_type=shop-products/",
    "request_type=product-skus/",
    "request_type=product-skus-csapi/",
  ],
  Momoshop: ["request_type=catalogue-products/", "request_type=product-skus/"],
  Redmart: ["request_type=shop-products/", "request_type=product-skus/"],
  Shopee: ["request_type=shop-products/", "request_type=product-skus/"],
  Tiktok: ["request_type=username-products/", "request_type=product-skus/"],
  Tmall: ["request_type=shop-products/", "request_type=product-skus/"],
  "Tmall-supermarket": ["request_type=product-skus/"],
  Watsons: ["request_type=shop-products/", "request_type=product-skus/"],
};

const normalizeRegionValue = (value: unknown): string => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "unknown";
  }

  return normalized.toLowerCase();
};

type CoordinatorFailureReason = "validation_failed" | "missing_source_product_id";

interface CoordinatorFailedRow {
  readonly record: Record<string, any>;
  readonly failureReason: CoordinatorFailureReason;
  readonly failureDetail: string;
  readonly validationErrors: ValidationError[];
}

const buildCoordinatorFailedBasePrefix = (outputBasePrefix: string): string => {
  // tagged_output/platform=Lazada/year=2026/month=04/day=07
  // → failed_processing/platform=Lazada/tagged_output/year=2026/month=04/day=07
  const match = outputBasePrefix.match(/^tagged_output\/(platform=[^/]+)\/(.+)$/);
  if (match) {
    return `failed_processing/${match[1]}/tagged_output/${match[2]}`;
  }
  return `failed_processing/${outputBasePrefix}`;
};

/**
 * Derive the failed_processing path that mirrors the processor output key.
 * output/file_type=json/channel=lazada/request_type=shop-products/FILE_processed.csv
 * → failed_processing/file_type=json/channel=lazada/output/request_type=shop-products/FILE.csv
 */
const buildSourceFileFailedKey = (sourceS3Key: string): string => {
  const withoutOutputPrefix = sourceS3Key.startsWith("output/")
    ? sourceS3Key.slice("output/".length)
    : sourceS3Key;
  // Move "output/" segment to sit after the channel= segment
  const withOutputMoved = withoutOutputPrefix.replace(/(channel=[^/]+\/)/, "$1output/");
  // Strip "_processed" from the filename stem
  const withoutProcessed = withOutputMoved.replace(/_processed(?=\.csv$)/, "");
  return `failed_processing/${withoutProcessed}`;
};

interface CoordinatorValidationOutcome {
  readonly content: string;
  readonly outputRowCountTotal: number;
  readonly productsFailedValidationTotal: number;
  readonly failedRows: CoordinatorFailedRow[];
}

interface CoordinatorMergeOutcome {
  readonly content: string;
  readonly droppedBeforeValidationTotal: number;
  readonly droppedFromIncomingSourceProductIdTotal: number;
  readonly droppedFromExistingSourceProductIdTotal: number;
  readonly droppedRows: CoordinatorFailedRow[];
}

const createMissingSourceProductIdFailedRow = (
  record: Record<string, any>,
): CoordinatorFailedRow => ({
  record: {
    ...record,
    region: normalizeRegionValue(record.region),
  },
  failureReason: "missing_source_product_id",
  failureDetail: "required_merge_key_missing",
  validationErrors: [],
});

const prepareContentForCoordinatorValidation = async (
  content: string,
): Promise<CoordinatorMergeOutcome> => {
  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const records = parse(content, { columns: true }) as Record<string, any>[];
  if (records.length === 0) {
    return {
      content,
      droppedBeforeValidationTotal: 0,
      droppedFromIncomingSourceProductIdTotal: 0,
      droppedFromExistingSourceProductIdTotal: 0,
      droppedRows: [],
    };
  }

  const headers = Object.keys(records[0]);
  const retainedRecords: Record<string, any>[] = [];
  const droppedRows: CoordinatorFailedRow[] = [];

  for (const record of records) {
    const productId = String(record.source_product_id ?? "").trim();
    if (!productId) {
      droppedRows.push(createMissingSourceProductIdFailedRow(record));
      continue;
    }

    retainedRecords.push({
      ...record,
      source_product_id: productId,
      region: normalizeRegionValue(record.region),
    });
  }

  return {
    content:
      retainedRecords.length > 0
        ? stringify(retainedRecords, { header: true, columns: headers })
        : stringify([], { header: true, columns: headers }),
    droppedBeforeValidationTotal: droppedRows.length,
    droppedFromIncomingSourceProductIdTotal: droppedRows.length,
    droppedFromExistingSourceProductIdTotal: 0,
    droppedRows,
  };
};

/**
 * Run validation on CSV content and return the surviving rows plus dropped validation rows.
 * Validation failures can still be emitted to failed-processing artifacts when
 * error reporting is enabled, even if filtering is disabled.
 */
const validateAndFilterCSV = async (
  content: string,
  vendor: string,
): Promise<CoordinatorValidationOutcome> => {
  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const records = parse(content, { columns: true }) as Record<string, any>[];
  if (records.length === 0) {
    return {
      content,
      outputRowCountTotal: 0,
      productsFailedValidationTotal: 0,
      failedRows: [],
    };
  }

  if (!ENABLE_VALIDATION && !ENABLE_ERROR_REPORT) {
    return {
      content,
      outputRowCountTotal: records.length,
      productsFailedValidationTotal: 0,
      failedRows: [],
    };
  }

  const { validRecords, errors, invalidRecords } = validateCSVRecords(records, vendor);
  const shouldEmitValidationFailures = ENABLE_VALIDATION || ENABLE_ERROR_REPORT;
  const failedRows = shouldEmitValidationFailures
    ? invalidRecords.map(
        (invalidRecord: { record: Record<string, any>; errors: ValidationError[] }) => ({
          record: {
            ...invalidRecord.record,
            region: normalizeRegionValue(invalidRecord.record.region),
          },
          failureReason: "validation_failed" as const,
          failureDetail: "see_validation_errors_json",
          validationErrors: invalidRecord.errors,
        }),
      )
    : [];
  // failedRows is already empty unless shouldEmitValidationFailures is true, so
  // its length is the correct count in every case — including when
  // ENABLE_VALIDATION is off but ENABLE_ERROR_REPORT is on, where failed rows
  // are still written to failed_processing/ and must still be counted.
  const productsFailedValidationTotal = failedRows.length;

  console.log(
    `Validation: ${records.length} records → ${validRecords.length} valid, ${errors.length} errors`,
  );

  // When ENABLE_VALIDATION is off, pass all rows through unfiltered
  if (!ENABLE_VALIDATION) {
    return {
      content,
      outputRowCountTotal: records.length,
      productsFailedValidationTotal,
      failedRows,
    };
  }

  const headers = Object.keys(records[0]);
  const validatedContent = stringify(validRecords, { header: true, columns: headers });
  return {
    content: validatedContent,
    outputRowCountTotal: validRecords.length,
    productsFailedValidationTotal,
    failedRows,
  };
};

/**
 * Merge two CSV files using composite key (source_product_id + source_sku_id)
 * with fan-out for product-level rows:
 *
 * - Composite key = `productId|skuId` when source_sku_id is present and
 *   differs from source_product_id (SKU-level row from product-skus).
 * - Product-level key = `productId` when source_sku_id is blank or equals
 *   source_product_id (shop-products row).
 *
 * Fan-out behaviour:
 * - When a product-level row arrives and SKU-level rows already exist for
 *   that product, the product-level fields are spread to every SKU row.
 * - When SKU-level rows arrive and only a product-level row exists, the
 *   product-level row is replaced by the new SKU rows (inheriting its fields).
 *
 * Within the same key, preserve-last: later non-blank values overwrite.
 */
const mergeCSVFiles = async (
  consolidatedContent: string,
  newContent: string,
): Promise<CoordinatorMergeOutcome> => {
  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const consolidatedRecords = parse(consolidatedContent, { columns: true }) as Record<
    string,
    any
  >[];
  const newRecords = parse(newContent, { columns: true }) as Record<string, any>[];

  // SKU-level rows keyed by "productId|skuId"
  const skuRows = new Map<string, Record<string, any>>();
  // Product-level rows keyed by "productId" (no distinct SKU)
  const productRows = new Map<string, Record<string, any>>();
  // Track which productIds have SKU-level rows
  const productToSkuKeys = new Map<string, Set<string>>();
  const droppedRowsFromIncoming: CoordinatorFailedRow[] = [];
  let droppedFromIncomingSourceProductIdTotal = 0;
  let droppedFromExistingSourceProductIdTotal = 0;

  const orderedColumns: string[] = [];
  const seenColumns = new Set<string>();

  const normalize = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    const s = String(value).trim();
    if (!s || s.toLowerCase() === "null") return undefined;
    return s;
  };

  const isBlank = (value: unknown): boolean => {
    if (value === null || value === undefined) return true;
    const s = String(value).trim().toLowerCase();
    return s === "" || s === "null" || s === "undefined";
  };

  const trackColumns = (record: Record<string, any>) => {
    Object.keys(record).forEach((key) => {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        orderedColumns.push(key);
      }
    });
  };

  /** Overwrite blank fields in `target` with non-blank values from `source`. */
  const spreadFields = (target: Record<string, any>, source: Record<string, any>) => {
    Object.entries(source).forEach(([key, value]) => {
      if (!isBlank(value)) {
        target[key] = value;
      }
    });
  };

  const mergeRecord = (rawRecord: Record<string, any>, source: "incoming" | "existing") => {
    const productId = normalize(rawRecord.source_product_id);
    if (!productId) {
      if (source === "incoming") {
        droppedRowsFromIncoming.push(createMissingSourceProductIdFailedRow(rawRecord));
        droppedFromIncomingSourceProductIdTotal += 1;
      } else {
        droppedFromExistingSourceProductIdTotal += 1;
      }
      return;
    }

    const skuId = normalize(rawRecord.source_sku_id);
    const isSkuLevel = skuId !== undefined && skuId !== productId;

    const incomingRecord: Record<string, any> = {
      ...rawRecord,
      source_product_id: productId,
      region: normalizeRegionValue(rawRecord.region),
    };
    trackColumns(incomingRecord);

    if (isSkuLevel) {
      const compositeKey = `${productId}|${skuId}`;

      // Register this SKU under its product
      let skuKeySet = productToSkuKeys.get(productId);
      if (!skuKeySet) {
        skuKeySet = new Set();
        productToSkuKeys.set(productId, skuKeySet);
      }
      skuKeySet.add(compositeKey);

      // If a product-level row existed, inherit its fields then remove it
      const existingProductRow = productRows.get(productId);
      if (existingProductRow) {
        // Spread product-level data as base, then overlay SKU data
        const merged: Record<string, any> = { ...existingProductRow, ...incomingRecord };
        // But preserve non-blank product-level values where SKU is blank
        Object.entries(existingProductRow).forEach(([key, value]) => {
          if (isBlank(merged[key]) && !isBlank(value)) {
            merged[key] = value;
          }
        });
        skuRows.set(compositeKey, merged);
        // Also spread product-level data to any other existing SKU rows
        for (const otherKey of skuKeySet) {
          if (otherKey !== compositeKey) {
            const otherRow = skuRows.get(otherKey);
            if (otherRow) spreadFields(otherRow, existingProductRow);
          }
        }
        productRows.delete(productId);
      } else {
        // Normal SKU-level merge
        const existing = skuRows.get(compositeKey);
        if (!existing) {
          skuRows.set(compositeKey, incomingRecord);
        } else {
          spreadFields(existing, incomingRecord);
        }
      }
    } else {
      // Product-level row (no distinct SKU)
      const existingSkuKeys = productToSkuKeys.get(productId);
      if (existingSkuKeys && existingSkuKeys.size > 0) {
        // Fan out product-level fields to all existing SKU rows
        for (const skuKey of existingSkuKeys) {
          const skuRow = skuRows.get(skuKey);
          if (skuRow) spreadFields(skuRow, incomingRecord);
        }
      } else {
        // No SKU rows yet — store as product-level
        const existing = productRows.get(productId);
        if (!existing) {
          productRows.set(productId, incomingRecord);
        } else {
          spreadFields(existing, incomingRecord);
        }
      }
    }
  };

  consolidatedRecords.forEach((record) => mergeRecord(record, "existing"));
  newRecords.forEach((record) => mergeRecord(record, "incoming"));

  // Output: all SKU-level rows first, then remaining product-level rows
  const allRows = [...skuRows.values(), ...productRows.values()];

  return {
    content: stringify(allRows, {
      header: true,
      columns: orderedColumns,
    }),
    droppedBeforeValidationTotal:
      droppedFromIncomingSourceProductIdTotal + droppedFromExistingSourceProductIdTotal,
    droppedFromIncomingSourceProductIdTotal,
    droppedFromExistingSourceProductIdTotal,
    droppedRows: droppedRowsFromIncoming,
  };
};

const clearFailedProcessingArtifacts = async (
  s3: S3Client,
  bucket: string,
  failedBasePrefix: string,
): Promise<void> => {
  let continuationToken: string | undefined;

  do {
    const listResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${failedBasePrefix}/`,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (listResp.Contents ?? [])
      .map((entry) => entry.Key)
      .filter((key): key is string => Boolean(key))
      .map((key) => ({ Key: key }));

    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }

    continuationToken = listResp.NextContinuationToken;
  } while (continuationToken);
};

/**
 * Write rows dropped for missing source_product_id into the failed_processing path
 * that mirrors the processor output key, so the source request_type is preserved.
 * Output: failed_processing/file_type=json/channel=.../output/request_type=.../FILE.csv
 * Overwrites on re-run; deletes the file if there are no drops.
 */
const writeSourceFileFailedRows = async (
  s3: S3Client,
  bucket: string,
  sourceS3Key: string,
  droppedRows: CoordinatorFailedRow[],
): Promise<void> => {
  const destKey = buildSourceFileFailedKey(sourceS3Key);

  if (droppedRows.length === 0) {
    // Best-effort delete to avoid stale files from prior runs
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: [{ Key: destKey }], Quiet: true },
        }),
      );
    } catch {
      // Ignore — object may not exist
    }
    return;
  }

  const { stringify } = await import("csv-stringify/sync");

  const orderedColumns: string[] = [];
  const seenColumns = new Set<string>();
  for (const row of droppedRows) {
    for (const key of Object.keys(row.record)) {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        orderedColumns.push(key);
      }
    }
  }

  const csvRows = droppedRows.map((row) => ({
    ...row.record,
    failure_reason: row.failureReason,
    failure_detail: row.failureDetail,
  }));

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: destKey,
      Body: stringify(csvRows, {
        header: true,
        columns: [...orderedColumns, "failure_reason", "failure_detail"],
      }),
      ContentType: "text/csv",
    }),
  );
  console.log(`Written source-file failed rows: ${destKey} (${droppedRows.length} rows)`);
};

/**
 * Write validation-failed rows into the coordinator failed_processing path,
 * split by region alongside a validation-errors.json.
 * Output: failed_processing/platform={Vendor}/tagged_output/year=.../month=.../day=.../{region}/consolidated.csv
 */
const writeValidationFailedRows = async (
  s3: S3Client,
  bucket: string,
  failedBasePrefix: string,
  failedRows: CoordinatorFailedRow[],
): Promise<void> => {
  await clearFailedProcessingArtifacts(s3, bucket, failedBasePrefix);

  if (failedRows.length === 0) {
    return;
  }

  const { stringify } = await import("csv-stringify/sync");
  const failedRowsByRegion = new Map<string, CoordinatorFailedRow[]>();

  for (const failedRow of failedRows) {
    const region = normalizeRegionValue(failedRow.record.region);
    const regionRows = failedRowsByRegion.get(region) ?? [];
    regionRows.push({
      ...failedRow,
      record: {
        ...failedRow.record,
        region,
      },
    });
    failedRowsByRegion.set(region, regionRows);
  }

  for (const [region, regionRows] of failedRowsByRegion) {
    const orderedColumns: string[] = [];
    const seenColumns = new Set<string>();

    for (const failedRow of regionRows) {
      for (const key of Object.keys(failedRow.record)) {
        if (!seenColumns.has(key)) {
          seenColumns.add(key);
          orderedColumns.push(key);
        }
      }
    }

    const failedCsvRows = regionRows.map((failedRow) => ({
      ...failedRow.record,
      failure_reason: failedRow.failureReason,
      failure_detail: failedRow.failureDetail,
    }));

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${failedBasePrefix}/${region}/consolidated.csv`,
        Body: stringify(failedCsvRows, {
          header: true,
          columns: [...orderedColumns, "failure_reason", "failure_detail"],
        }),
        ContentType: "text/csv",
      }),
    );

    const remappedValidationErrors: ValidationError[] = [];
    regionRows.forEach((failedRow, index) => {
      for (const validationError of failedRow.validationErrors) {
        remappedValidationErrors.push({
          ...validationError,
          row: index + 1,
        });
      }
    });

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${failedBasePrefix}/${region}/validation-errors.json`,
        Body: buildErrorReport(remappedValidationErrors),
        ContentType: "application/json",
      }),
    );
  }
};

/**
 * Split CSV content by region column and write per-region files to S3.
 * Output path: {basePrefix}/{region}/consolidated.csv
 */
const writeRegionCSVFiles = async (
  s3: S3Client,
  bucket: string,
  basePrefix: string,
  content: string,
): Promise<void> => {
  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const records = parse(content, { columns: true }) as Record<string, any>[];
  if (records.length === 0) return;

  const headers = Object.keys(records[0]);
  const regionMap = new Map<string, Record<string, any>[]>();

  for (const record of records) {
    const region = normalizeRegionValue(record.region);
    const normalizedRecord = {
      ...record,
      region,
    };
    if (!regionMap.has(region)) regionMap.set(region, []);
    regionMap.get(region)!.push(normalizedRecord);
  }

  for (const [region, rows] of regionMap) {
    const csv = stringify(rows, { header: true, columns: headers });
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${basePrefix}/${region}/consolidated.csv`,
        Body: csv,
        ContentType: "text/csv",
      }),
    );
    console.log(
      `Written region CSV: ${basePrefix}/${region}/consolidated.csv (${rows.length} rows)`,
    );
  }
};

/**
 * Read existing input files from any metadata.csv under the given base prefix.
 * Returns the list of input file names, or an empty array if no metadata exists.
 */
const readInputFilesFromMetadata = async (
  s3: S3Client,
  bucket: string,
  basePrefix: string,
): Promise<string[]> => {
  const { parse } = await import("csv-parse/sync");

  // List region folders to find a metadata.csv
  const listResp = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${basePrefix}/` }),
  );
  const metadataKeys = (listResp.Contents ?? [])
    .map((o) => o.Key!)
    .filter((k) => k.endsWith("/metadata.csv"));

  if (metadataKeys.length === 0) return [];

  try {
    const metaObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metadataKeys[0] }));
    const metaBuf = await bodyToBuffer(metaObj.Body);
    const metaRecords = parse(metaBuf.toString("utf-8"), { columns: true }) as Record<
      string,
      any
    >[];
    return metaRecords
      .filter((r: Record<string, any>) => r["Mandatory or Optional"] === "Input File")
      .map((r: Record<string, any>) => r["Field Name"]);
  } catch {
    return [];
  }
};

/**
 * Write a metadata CSV alongside each region's consolidated.csv.
 * Contains:
 * - Input files used to generate the consolidated sheet
 * - Mandatory fields with their null percentage
 */
const writeMetadataCSVFiles = async (
  s3: S3Client,
  bucket: string,
  basePrefix: string,
  content: string,
  vendor: string,
  newInputFiles: string[],
  droppedSourceProductIdCount: number = 0,
): Promise<void> => {
  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const records = parse(content, { columns: true }) as Record<string, any>[];
  if (records.length === 0) return;

  const extractRequestType = (s3Key: string): string | undefined => {
    const match = s3Key.match(/request_type=([^/]+)/);
    return match?.[1];
  };

  const resolveMappingIdsForInputFiles = (): string[] => {
    const index = loadVendorMappingIndex(vendor);
    const resolved = new Set<string>();

    for (const inputFile of newInputFiles) {
      const requestType = extractRequestType(inputFile);
      if (!requestType) continue;
      const rule = index.selectionRules?.find((r) => r.requestType === requestType);
      if (rule?.mappingId) {
        resolved.add(rule.mappingId);
      }
    }

    if (resolved.size === 0) {
      resolved.add(index.default);
    }

    return [...resolved];
  };

  const mappingIds = resolveMappingIdsForInputFiles();

  // Build required fields from request-type aware mapping(s).
  // If multiple mappings are involved, use intersection to avoid false mandatory alerts.
  const requiredFieldSets = mappingIds.map((mappingId) => {
    const mapping = loadVendorMapping(vendor, mappingId);
    const required = new Set<string>();
    for (const [name, def] of Object.entries(mapping.columns)) {
      if ((def as FieldMapping).required) required.add(name);
    }
    return required;
  });

  let requiredFields: string[] = [];
  if (requiredFieldSets.length === 1) {
    requiredFields = [...requiredFieldSets[0]];
  } else {
    const [firstSet, ...restSets] = requiredFieldSets;
    requiredFields = [...firstSet].filter((field) =>
      restSets.every((fieldSet) => fieldSet.has(field)),
    );
  }

  // Split records by region
  const regionMap = new Map<string, Record<string, any>[]>();
  for (const record of records) {
    const region = normalizeRegionValue(record.region);
    if (!regionMap.has(region)) regionMap.set(region, []);
    regionMap.get(region)!.push(record);
  }

  // Use only the input files passed by the caller (no metadata carry-over)
  const allInputFiles = [...new Set(newInputFiles)];
  console.log(
    `writeMetadataCSVFiles: vendor=${vendor}, regions=${[...regionMap.keys()].join(",")}, ` +
      `requiredFields=${requiredFields.length}, mappingIds=${mappingIds.join("|")}, inputFiles=${allInputFiles.length}`,
  );

  const dateMatch = basePrefix.match(/year=(\d{4})\/month=(\d{2})\/day=(\d{2})/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "unknown";
  const vendorKey = vendor as keyof typeof consolidationPathsMap;
  const expectedFileCount = consolidationPathsMap[vendorKey]?.length ?? 1;

  const buildMetadataForRegion = (rows: Record<string, any>[]) => {
    const totalRows = rows.length;
    const metaRows: { section: string; name: string; value: string }[] = [];
    const fieldsAt100Pct: string[] = [];

    for (const field of requiredFields) {
      const nullCount = rows.filter((r) => {
        const val = r[field];
        return val === undefined || val === null || String(val).trim() === "";
      }).length;
      const nullPct = ((nullCount / totalRows) * 100).toFixed(2);
      metaRows.push({
        section: "Mandatory Field",
        name: field,
        value: `${nullPct}%`,
      });
      if (nullCount === totalRows) {
        fieldsAt100Pct.push(field);
      }
    }

    metaRows.push({ section: "", name: "", value: "" });

    for (const file of allInputFiles) {
      metaRows.push({ section: "Input File", name: file, value: "" });
    }

    const csv = stringify(metaRows, {
      header: true,
      columns: [
        { key: "section", header: "Mandatory or Optional" },
        { key: "name", header: "Field Name" },
        { key: "value", header: "Null Value Percentage" },
      ],
    });

    return { csv, fieldsAt100Pct };
  };

  const writeMetadataForRegion = async (region: string, rows: Record<string, any>[]) => {
    const { csv, fieldsAt100Pct } = buildMetadataForRegion(rows);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${basePrefix}/${region}/metadata.csv`,
        Body: csv,
        ContentType: "text/csv",
      }),
    );
    console.log(`Written metadata: ${basePrefix}/${region}/metadata.csv`);

    // Single unified alert: if source_product_id is null/dropped or >= 25% of mandatory fields are 100% null
    const hasSourceProductIdNull =
      fieldsAt100Pct.includes("source_product_id") || droppedSourceProductIdCount > 0;
    const exceedsThreshold =
      requiredFields.length > 0 &&
      fieldsAt100Pct.length / requiredFields.length >= NULL_ALERT_THRESHOLD;

    if (hasSourceProductIdNull || exceedsThreshold) {
      console.log(
        `Scheduling null field alert email for ${vendor}/${region}/${date} (${allInputFiles.length}/${expectedFileCount} files)...`,
      );
      void sendNullFieldAlert(
        vendor,
        region,
        date,
        fieldsAt100Pct,
        requiredFields.length,
        allInputFiles,
        allInputFiles.length,
        expectedFileCount,
        droppedSourceProductIdCount,
      ).catch((err) => {
        console.error(`Null field alert failed for ${vendor}/${region}/${date}`, err);
      });
    }
  };

  const failedRegions = new Set<string>();

  for (const [region, rows] of regionMap) {
    try {
      await writeMetadataForRegion(region, rows);
    } catch (err) {
      failedRegions.add(region);
      console.error(`Failed writing metadata for ${vendor}/${region}/${date}`, err);
    }
  }

  // Reconciliation pass: ensure every region with consolidated.csv has metadata.csv.
  // This protects against partial writes from intermittent failures.
  try {
    const listResp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${basePrefix}/` }),
    );
    const keys = (listResp.Contents ?? []).map((o) => o.Key ?? "");
    const consolidatedRegions = new Set<string>();
    const metadataRegions = new Set<string>();

    for (const key of keys) {
      if (key.endsWith("/consolidated.csv")) {
        const parts = key.split("/");
        if (parts.length >= 2) consolidatedRegions.add(parts[parts.length - 2]);
      }
      if (key.endsWith("/metadata.csv")) {
        const parts = key.split("/");
        if (parts.length >= 2) metadataRegions.add(parts[parts.length - 2]);
      }
    }

    for (const region of consolidatedRegions) {
      if (metadataRegions.has(region)) continue;
      const rows = regionMap.get(region);
      if (!rows || rows.length === 0) {
        console.warn(
          `Metadata reconciliation skipped for ${vendor}/${region}/${date}: no rows available in current content`,
        );
        continue;
      }

      try {
        await writeMetadataForRegion(region, rows);
        failedRegions.delete(region);
        console.log(`Metadata reconciliation succeeded: ${basePrefix}/${region}/metadata.csv`);
      } catch (err) {
        failedRegions.add(region);
        console.error(`Metadata reconciliation failed for ${vendor}/${region}/${date}`, err);
      }
    }
  } catch (err) {
    console.error(`Metadata reconciliation scan failed for ${vendor}/${date}`, err);
  }

  if (failedRegions.size > 0) {
    console.error(
      `Metadata write completed with ${failedRegions.size} unresolved region(s): ${[...failedRegions].join(",")}`,
    );
  }
};

/**
 * Read all per-region consolidated CSV files under a base prefix and combine into a single CSV string.
 */
const readAllRegionCSVs = async (
  s3: S3Client,
  bucket: string,
  basePrefix: string,
): Promise<string | null> => {
  const listResp = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${basePrefix}/` }),
  );

  const csvKeys = (listResp.Contents ?? [])
    .map((o) => o.Key!)
    .filter((k) => k.endsWith("/consolidated.csv"));

  if (csvKeys.length === 0) return null;

  const { parse } = await import("csv-parse/sync");
  const { stringify } = await import("csv-stringify/sync");

  const allRecords: Record<string, any>[] = [];
  let headers: string[] = [];

  for (const key of csvKeys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await bodyToBuffer(obj.Body);
    const records = parse(buf.toString("utf-8"), { columns: true }) as Record<string, any>[];
    if (headers.length === 0 && records.length > 0) {
      headers = Object.keys(records[0]);
    }
    allRecords.push(...records);
  }

  if (allRecords.length === 0) return null;
  return stringify(allRecords, { header: true, columns: headers });
};

const triggerConsolidationEgressorForTaggedOutputCsvs = async (
  s3: S3Client,
  lambdaClient: LambdaClient,
  bucket: string,
  basePrefix: string,
  consolidationEgressorFunction: string,
): Promise<void> => {
  const csvKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const listResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${basePrefix}/`,
        ContinuationToken: continuationToken,
      }),
    );

    for (const entry of listResp.Contents ?? []) {
      const key = entry.Key;
      if (!key || !key.endsWith(".csv")) continue;
      csvKeys.push(key);
    }

    continuationToken = listResp.NextContinuationToken;
  } while (continuationToken);

  for (const key of csvKeys) {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: consolidationEgressorFunction,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            Records: [
              {
                eventName: "ObjectCreated:Put",
                s3: {
                  bucket: { name: bucket },
                  object: { key },
                },
              },
            ],
          }),
        ),
      }),
    );
  }

  console.log(
    `Triggered consolidation egressor for ${csvKeys.length} tagged_output csv file(s) under ${basePrefix}`,
  );
};

const runPostWriteFanouts = async (
  s3: S3Client,
  sqsClient: SQSClient,
  lambdaClient: LambdaClient,
  bucket: string,
  outputBasePrefix: string,
  consolidationEgressorFunction?: string,
): Promise<void> => {
  if (consolidationEgressorFunction) {
    try {
      await triggerConsolidationEgressorForTaggedOutputCsvs(
        s3,
        lambdaClient,
        bucket,
        outputBasePrefix,
        consolidationEgressorFunction,
      );
    } catch (invokeError) {
      console.error(
        "Failed to trigger consolidation egressor lambda after tagged_output writes:",
        consolidationEgressorFunction,
        outputBasePrefix,
        invokeError,
      );
    }
  } else {
    console.log(
      "CONSOLIDATION_EGRESSOR_FUNCTION is not set; skipping post-write consolidation fan-out",
    );
  }
};

const runPreWriteFanouts = async (
  lambdaClient: LambdaClient,
  record: Record<string, any>,
  decodedS3Key: string,
  externalEgressorFunction?: string,
): Promise<void> => {
  if (externalEgressorFunction) {
    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: externalEgressorFunction,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ Records: [record] })),
        }),
      );
      console.log(
        "Forwarded CSV event to external egressor lambda:",
        externalEgressorFunction,
        decodedS3Key,
      );
    } catch (invokeError) {
      console.error(
        "Failed to forward CSV event to external egressor lambda:",
        externalEgressorFunction,
        decodedS3Key,
        invokeError,
      );
    }
  } else {
    console.log("EXTERNAL_EGRESSOR_FUNCTION is not set; skipping external fan-out");
  }
};

export const handler: S3Handler = async (event) => {
  // For each S3 event, log to filepipeline-files table
  const AWS_REGION = process.env.AWS_REGION;
  const CONSOLIDATION_TABLE = process.env.CONSOLIDATION_TABLE;
  const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
  const EXTERNAL_EGRESSOR_FUNCTION = process.env.EXTERNAL_EGRESSOR_FUNCTION;
  const CONSOLIDATION_EGRESSOR_FUNCTION = process.env.CONSOLIDATION_EGRESSOR_FUNCTION;
  const s3 = new S3Client({
    region: AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
    forcePathStyle: !!process.env.AWS_ENDPOINT_URL,
  });
  const lambdaClient = new LambdaClient({
    region: AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  });
  const sqsClient = new SQSClient({
    region: AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  });
  const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL }),
  );

  const updateCoordinatorCounters = async (
    stateKey: string,
    counters: {
      outputRowCountTotal: number;
      productsFailedValidationTotal: number;
      droppedBeforeValidationTotal: number;
    },
  ) => {
    await docClient.send(
      new UpdateCommand({
        TableName: CONSOLIDATION_TABLE,
        Key: { pk: stateKey, sk: "state" },
        UpdateExpression:
          "SET outputRowCountTotal = :outputRows, productsFailedValidationTotal = :failedProducts, droppedBeforeValidationTotal = :droppedRows",
        ExpressionAttributeValues: {
          ":outputRows": counters.outputRowCountTotal,
          ":failedProducts": counters.productsFailedValidationTotal,
          ":droppedRows": counters.droppedBeforeValidationTotal,
        },
      }),
    );
  };

  for (const record of event.Records) {
    const s3Key = record.s3.object.key;
    const decodedS3Key = decodeURIComponent(s3Key);
    console.log("Processing S3 key:", decodedS3Key);
    if (!decodedS3Key.endsWith(".csv")) {
      console.log("Skipped: not a CSV", decodedS3Key);
      continue;
    }

    await runPreWriteFanouts(lambdaClient, record, decodedS3Key, EXTERNAL_EGRESSOR_FUNCTION);

    const { vendor, filename } = parseS3Key(decodedS3Key);
    console.log("Parsed vendor:", vendor, "filename:", filename);
    const validPaths = consolidationPathsMap[vendor as keyof typeof consolidationPathsMap];
    console.log("Valid paths:", validPaths);
    // Find the request_type segment in the key for matching
    const requestTypeMatch = decodedS3Key.match(/request_type=[^/]+\//);
    const requestTypeSegment = requestTypeMatch ? requestTypeMatch[0] : "";
    if (!validPaths || !validPaths.some((prefix) => requestTypeSegment.startsWith(prefix))) {
      console.log("Skipped: invalid path", decodedS3Key, "vendor:", vendor);
      continue;
    }
    const normalizedDate = extractNormalizedDate(filename);
    console.log("Normalized date:", normalizedDate);
    if (!normalizedDate) {
      // Unlike the "invalid path" skip above, this is not an expected/routine
      // case — every file reaching this point already passed vendor/path
      // validation and should have a parseable date. Surface it as an error
      // (rather than a plain console.log) so it doesn't silently vanish from
      // the consolidated output with no operational signal.
      console.error(
        `Skipped: no normalized date found in filename, file will NOT be added to consolidated CSV: ${decodedS3Key}`,
      );
      continue;
    }

    // Build output S3 key for consolidated file
    console.log("Building output prefix with vendor:", vendor, "normalizedDate:", normalizedDate);
    const yyyy = normalizedDate.slice(0, 4);
    const mm = normalizedDate.slice(5, 7);
    const dd = normalizedDate.slice(8, 10);
    const outputBasePrefix = `tagged_output/platform=${vendor}/year=${yyyy}/month=${mm}/day=${dd}`;
    const failedBasePrefix = buildCoordinatorFailedBasePrefix(outputBasePrefix);
    console.log("Output base prefix:", outputBasePrefix);

    // DynamoDB: track consolidation state and queue
    const stateKey = `${vendor}#${normalizedDate}`;
    console.log("State key:", stateKey);
    // Try to get the state record
    console.log("Fetching state from DynamoDB...");
    const stateResp = await docClient.send(
      new GetCommand({ TableName: CONSOLIDATION_TABLE, Key: { pk: stateKey, sk: "state" } }),
    );
    const stateItem = stateResp.Item as { status?: string } | undefined;
    console.log("State item:", stateItem);

    // Check if any consolidated region files exist in S3
    console.log("Checking if consolidated files exist...");
    const listResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: PROCESSED_BUCKET,
        Prefix: `${outputBasePrefix}/`,
        MaxKeys: 1,
      }),
    );
    const consolidatedExists = (listResp.Contents?.length ?? 0) > 0;
    console.log("Consolidated files exist:", consolidatedExists);

    // 1st case: no consolidated file exists and not currently processing — process immediately
    console.log(
      "Checking if should process immediately. consolidatedExists:",
      consolidatedExists,
      "stateItem.status:",
      stateItem?.status,
    );
    if (!consolidatedExists && (!stateItem || stateItem.status !== "PROCESSING")) {
      console.log("Processing immediately...");
      try {
        // Atomically acquire processing lock. If another invocation already set PROCESSING,
        // this condition fails and we queue this file for later.
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: CONSOLIDATION_TABLE,
              Key: { pk: stateKey, sk: "state" },
              ConditionExpression: "attribute_not_exists(#status) OR #status <> :processing",
              UpdateExpression: "SET #status = :processing, startedAt = :now",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":processing": "PROCESSING",
                ":now": new Date().toISOString(),
              },
            }),
          );
        } catch (lockError) {
          const lockErr = lockError as any;
          if (lockErr?.name === "ConditionalCheckFailedException") {
            console.log("Another invocation is already PROCESSING, queuing file:", decodedS3Key);
            await docClient.send(
              new PutCommand({
                TableName: CONSOLIDATION_TABLE,
                Item: {
                  pk: stateKey,
                  sk: `queued#${uuidv4()}`,
                  s3Key: decodedS3Key,
                  filename,
                  queuedAt: new Date().toISOString(),
                },
              }),
            );
            console.log("File queued due to lock contention");
            continue;
          }
          throw lockError;
        }
        console.log("Marked as PROCESSING in DynamoDB");

        // Read input file from S3 and write region-split consolidated output files
        console.log(
          "Reading input file from S3. Bucket:",
          record.s3.bucket.name,
          "Key:",
          decodedS3Key,
        );
        const inputObj = await s3.send(
          new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: decodedS3Key }),
        );
        console.log("Input file retrieved from S3");

        const inputBody = await bodyToBuffer(inputObj.Body);
        console.log("Input file converted to buffer. Size:", inputBody.length);

        const preValidationOutcome = await prepareContentForCoordinatorValidation(
          inputBody.toString("utf-8"),
        );

        // Validate and filter CSV content before writing
        const validationOutcome = await validateAndFilterCSV(preValidationOutcome.content, vendor);
        const validatedContent = validationOutcome.content;

        // Write to region-split consolidated output files
        await writeRegionCSVFiles(s3, PROCESSED_BUCKET!, outputBasePrefix, validatedContent);
        // Track all input files for this consolidation run
        const allConsolidationInputFiles: string[] = [decodedS3Key];
        await writeMetadataCSVFiles(
          s3,
          PROCESSED_BUCKET!,
          outputBasePrefix,
          validatedContent,
          vendor,
          allConsolidationInputFiles,
          preValidationOutcome.droppedBeforeValidationTotal,
        );
        await writeSourceFileFailedRows(
          s3,
          PROCESSED_BUCKET!,
          decodedS3Key,
          preValidationOutcome.droppedRows,
        );
        await writeValidationFailedRows(
          s3,
          PROCESSED_BUCKET!,
          failedBasePrefix,
          validationOutcome.failedRows,
        );
        await runPostWriteFanouts(
          s3,
          sqsClient,
          lambdaClient,
          PROCESSED_BUCKET!,
          outputBasePrefix,
          CONSOLIDATION_EGRESSOR_FUNCTION,
        );
        await updateCoordinatorCounters(stateKey, {
          outputRowCountTotal: validationOutcome.outputRowCountTotal,
          productsFailedValidationTotal: validationOutcome.productsFailedValidationTotal,
          droppedBeforeValidationTotal: preValidationOutcome.droppedBeforeValidationTotal,
        });
        console.log("Region-split consolidated files written to S3");

        // Mark as ready
        await docClient.send(
          new UpdateCommand({
            TableName: CONSOLIDATION_TABLE,
            Key: { pk: stateKey, sk: "state" },
            UpdateExpression: "SET #status = :ready, finishedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":ready": "READY", ":now": new Date().toISOString() },
          }),
        );
        console.log("Updated status to READY in DynamoDB");

        // After marking as ready, check for queued files and process them
        // 1. Query all queued files for this vendor/date
        const { QueryCommand, DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
        const queuedResp = await docClient.send(
          new QueryCommand({
            TableName: CONSOLIDATION_TABLE,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :queued)",
            ExpressionAttributeValues: { ":pk": stateKey, ":queued": "queued#" },
          }),
        );
        console.log("Queued files:", queuedResp.Items?.length || 0);
        const queuedFiles = (queuedResp.Items as any[]) || [];
        for (const queued of queuedFiles) {
          try {
            console.log("Processing queued file:", queued.s3Key);

            // Read the queued file from S3
            const queuedObj = await s3.send(
              new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: queued.s3Key }),
            );
            const queuedBuffer = await bodyToBuffer(queuedObj.Body);
            const queuedContent = queuedBuffer.toString("utf-8");

            // Read all current region-split consolidated files from S3
            const consolidatedContent =
              (await readAllRegionCSVs(s3, PROCESSED_BUCKET!, outputBasePrefix)) ?? "";

            // Merge files using preserve-first strategy
            const mergeOutcome = consolidatedContent
              ? await mergeCSVFiles(consolidatedContent, queuedContent)
              : await prepareContentForCoordinatorValidation(queuedContent);

            // Validate and filter merged content
            const validationOutcome = await validateAndFilterCSV(mergeOutcome.content, vendor);
            const validatedMerged = validationOutcome.content;

            // Write merged content back to region-split S3 files
            await writeRegionCSVFiles(s3, PROCESSED_BUCKET!, outputBasePrefix, validatedMerged);
            allConsolidationInputFiles.push(queued.s3Key);
            await writeMetadataCSVFiles(
              s3,
              PROCESSED_BUCKET!,
              outputBasePrefix,
              validatedMerged,
              vendor,
              allConsolidationInputFiles,
              mergeOutcome.droppedFromIncomingSourceProductIdTotal,
            );
            await writeSourceFileFailedRows(
              s3,
              PROCESSED_BUCKET!,
              queued.s3Key,
              mergeOutcome.droppedRows,
            );
            await writeValidationFailedRows(
              s3,
              PROCESSED_BUCKET!,
              failedBasePrefix,
              validationOutcome.failedRows,
            );
            await runPostWriteFanouts(
              s3,
              sqsClient,
              lambdaClient,
              PROCESSED_BUCKET!,
              outputBasePrefix,
              CONSOLIDATION_EGRESSOR_FUNCTION,
            );
            await updateCoordinatorCounters(stateKey, {
              outputRowCountTotal: validationOutcome.outputRowCountTotal,
              productsFailedValidationTotal: validationOutcome.productsFailedValidationTotal,
              droppedBeforeValidationTotal: mergeOutcome.droppedBeforeValidationTotal,
            });
            console.log("Merged queued file into consolidated, removing from queue");
          } catch (queueError) {
            console.error("Failed to process queued file", { queued: queued.sk, queueError });
            // Continue to next queued file, but don't delete this one yet
            continue;
          }

          // Remove from queue after successful processing
          await docClient.send(
            new DeleteCommand({
              TableName: CONSOLIDATION_TABLE,
              Key: { pk: stateKey, sk: queued.sk },
            }),
          );
        }
        console.log("Processing complete, continuing to next record");
      } catch (error) {
        console.error("Immediate processing failed", {
          stateKey,
          outputBasePrefix,
          decodedS3Key,
          error,
        });
        await docClient.send(
          new UpdateCommand({
            TableName: CONSOLIDATION_TABLE,
            Key: { pk: stateKey, sk: "state" },
            UpdateExpression: "SET #status = :failed, failedAt = :now, errorMessage = :err",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":failed": "FAILED",
              ":now": new Date().toISOString(),
              ":err": error instanceof Error ? error.message : String(error),
            },
          }),
        );
        throw error;
      }

      continue;
    }

    // 2nd case: consolidated file does not yet exist but a run is in progress — queue for later
    if (!consolidatedExists && stateItem?.status === "PROCESSING") {
      console.log("Processing in progress, queuing file for later:", decodedS3Key);
      await docClient.send(
        new PutCommand({
          TableName: CONSOLIDATION_TABLE,
          Item: {
            pk: stateKey,
            sk: `queued#${uuidv4()}`,
            s3Key: decodedS3Key,
            filename,
            queuedAt: new Date().toISOString(),
          },
        }),
      );
      console.log("File queued successfully");
      continue;
    }

    // 3rd case: consolidated file already exists and is READY (or FAILED from a previous
    // partial write) — merge the new file into the existing consolidated output.
    if (consolidatedExists && (stateItem?.status === "READY" || stateItem?.status === "FAILED")) {
      console.log(
        "Consolidated file exists and status is",
        stateItem?.status,
        ", will merge:",
        decodedS3Key,
      );
      try {
        // Read all current region-split consolidated files
        const consolidatedContent =
          (await readAllRegionCSVs(s3, PROCESSED_BUCKET!, outputBasePrefix)) ?? "";

        // Read new incoming file
        const newObj = await s3.send(
          new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: decodedS3Key }),
        );
        const newBuffer = await bodyToBuffer(newObj.Body);
        const newContent = newBuffer.toString("utf-8");

        // Merge files using preserve-first strategy
        const mergeOutcome = consolidatedContent
          ? await mergeCSVFiles(consolidatedContent, newContent)
          : await prepareContentForCoordinatorValidation(newContent);

        // Validate and filter merged content
        const validationOutcome = await validateAndFilterCSV(mergeOutcome.content, vendor);
        const validatedMerged = validationOutcome.content;

        // Write merged content back to region-split S3 files
        await writeRegionCSVFiles(s3, PROCESSED_BUCKET!, outputBasePrefix, validatedMerged);

        // Read existing metadata to get prior input files for this date
        const existingInputFiles = await readInputFilesFromMetadata(
          s3,
          PROCESSED_BUCKET!,
          outputBasePrefix,
        );
        await writeMetadataCSVFiles(
          s3,
          PROCESSED_BUCKET!,
          outputBasePrefix,
          validatedMerged,
          vendor,
          [...existingInputFiles, decodedS3Key],
          mergeOutcome.droppedFromIncomingSourceProductIdTotal,
        );
        await writeSourceFileFailedRows(
          s3,
          PROCESSED_BUCKET!,
          decodedS3Key,
          mergeOutcome.droppedRows,
        );
        await writeValidationFailedRows(
          s3,
          PROCESSED_BUCKET!,
          failedBasePrefix,
          validationOutcome.failedRows,
        );
        await runPostWriteFanouts(
          s3,
          sqsClient,
          lambdaClient,
          PROCESSED_BUCKET!,
          outputBasePrefix,
          CONSOLIDATION_EGRESSOR_FUNCTION,
        );
        await updateCoordinatorCounters(stateKey, {
          outputRowCountTotal: validationOutcome.outputRowCountTotal,
          productsFailedValidationTotal: validationOutcome.productsFailedValidationTotal,
          droppedBeforeValidationTotal: mergeOutcome.droppedBeforeValidationTotal,
        });
        console.log("Merged and wrote region-split consolidated files successfully");
      } catch (error) {
        console.error("Append/merge failed", { stateKey, outputBasePrefix, decodedS3Key, error });
        await docClient.send(
          new UpdateCommand({
            TableName: CONSOLIDATION_TABLE,
            Key: { pk: stateKey, sk: "state" },
            UpdateExpression: "SET #status = :failed, failedAt = :now, errorMessage = :err",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":failed": "FAILED",
              ":now": new Date().toISOString(),
              ":err": error instanceof Error ? error.message : String(error),
            },
          }),
        );
        throw error;
      }
      continue;
    }
  }
  // No return value needed for S3Handler
};
