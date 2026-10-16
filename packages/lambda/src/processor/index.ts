import { randomUUID } from "node:crypto";
import type {
  DuplicateKeyBreakdownEntry,
  FileRecordUpdate,
  ValidationError,
  VendorMapping,
} from "@filepipeline/shared";
import { extractDateFromFilename as extractDateFromFilenameShared } from "@filepipeline/shared/utility/date-extraction";
import { parseBooleanEnv, buildErrorReport } from "../coordinator/validation";
import {
  createFileRecord,
  getFileByS3Key,
  updateFileStatus,
  updateFileRecord,
  appendToVendorBatch,
  getVendorBatchByCountry,
  markVendorBatchConsolidated,
  resetVendorBatch,
} from "../../utils/dynamodb";
import {
  getObject,
  getObjectStream,
  putObject,
  parseS3Key,
  buildConsolidatedOutputKey,
  isArchivedIncomingKey,
  buildArchiveKeyFromIncomingKey,
  moveObject,
} from "../../utils/s3";
import { isRetryableError, NonRetryableError } from "../../utils/errors";
import { parseJSON, streamJSONFromZipStream } from "./parser/json";
import type { ZipStreamStats } from "./parser/json";
import { parseHTML, streamHTMLFromZipStream } from "./parser/html";
import { extractFromScripts } from "./parser/html/script-extractor";
import { loadCompanionFileMap, companionStemOf } from "./parser/companion";
import type { CompanionFileMap } from "./parser/companion";
import type { ExtractedFile } from "./parser/types";
import { createRankingContext, validateRow } from "./validation/index";
import { deduplicateRows } from "./deduplication/dedup";
import { buildDynamicCSVOutput, StreamingCSVWriter } from "./output/index";
import {
  loadVendorMapping,
  loadVendorMappingIndex,
  getNestedValue,
  parseOperation,
  applyOperation,
} from "./schema/index";
import { extractCountryFromPath } from "../../utils/extract-country";

function extractChannelFromSourceKey(s3Key: string, vendor: string): string {
  const match = s3Key.match(/(?:^|\/)channel=([^/]+)/);
  return (match?.[1] || vendor).trim().toLowerCase();
}

function buildFeature2ValidationErrorReportKey(
  sourceS3Key: string,
  vendor: string,
  zipFileName: string,
  country: string,
  jsonFileName: string,
): string {
  const channel = extractChannelFromSourceKey(sourceS3Key, vendor);
  return [
    "failed_processing",
    "file_type=json",
    `channel=${channel}`,
    "request_type=product-keyword-products",
    zipFileName,
    country,
    jsonFileName,
    "validation-errors.json",
  ].join("/");
}

function normalizeFeature2Country(country: string | undefined): string {
  const normalized = (country || "").trim().toLowerCase();
  return normalized || "unknown";
}

function getDuplicateKeyGroupCounts(
  rows: Array<{ rowNumber: number; data: Record<string, unknown> }>,
): Map<string, { example: Omit<DuplicateKeyBreakdownEntry, "failedCount">; count: number }> {
  const grouped = new Map<
    string,
    { example: Omit<DuplicateKeyBreakdownEntry, "failedCount">; count: number }
  >();

  for (const row of rows) {
    const productId =
      (row.data.product_id as string | number | undefined) ??
      (row.data.PRODUCT_ID as string | number | undefined) ??
      (row.data.source_product_id as string | number | undefined) ??
      (row.data.SOURCE_PRODUCT_ID as string | number | undefined);
    const region =
      (row.data.region as string | undefined) ?? (row.data.REGION as string | undefined);
    const searchKeyword =
      (row.data.search_keyword as string | undefined) ??
      (row.data.SEARCH_KEYWORD as string | undefined);
    const recordedOn =
      (row.data.recorded_on as string | undefined) ?? (row.data.RECORDED_ON as string | undefined);

    if (
      productId === undefined &&
      region === undefined &&
      searchKeyword === undefined &&
      recordedOn === undefined
    ) {
      continue;
    }

    const key = JSON.stringify([
      productId ?? "",
      region ?? "",
      searchKeyword ?? "",
      recordedOn ?? "",
    ]);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    grouped.set(key, {
      example: {
        product_id: productId,
        region: region ? String(region) : undefined,
        search_keyword: searchKeyword ? String(searchKeyword) : undefined,
        recorded_on: recordedOn ? String(recordedOn) : undefined,
      },
      count: 1,
    });
  }

  return grouped;
}

function buildDuplicateKeyBreakdownFromRows(
  beforeRows: Array<{ rowNumber: number; data: Record<string, unknown> }>,
  afterRows: Array<{ rowNumber: number; data: Record<string, unknown> }>,
): DuplicateKeyBreakdownEntry[] {
  const beforeCounts = getDuplicateKeyGroupCounts(beforeRows);
  const afterCounts = getDuplicateKeyGroupCounts(afterRows);
  const results: DuplicateKeyBreakdownEntry[] = [];

  for (const [key, beforeEntry] of beforeCounts.entries()) {
    const afterEntry = afterCounts.get(key);
    const failedCount = Math.max(0, beforeEntry.count - (afterEntry?.count ?? 0));
    if (failedCount <= 0) continue;

    results.push({
      ...beforeEntry.example,
      failedCount,
    });
  }

  return results.sort((a, b) => b.failedCount - a.failedCount);
}

interface SQSEvent {
  Records: Array<{
    messageId: string;
    body: string;
    attributes: {
      ApproximateReceiveCount: string;
    };
  }>;
}

interface SQSBatchResponse {
  batchItemFailures: Array<{
    itemIdentifier: string;
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

const INCOMING_BUCKET = process.env.INCOMING_BUCKET || "filepipeline-incoming";
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET || "filepipeline-processed";
const ENABLE_FEATURE2_VALIDATION = parseBooleanEnv("ENABLE_FEATURE2_VALIDATION", false);
const ENABLE_FEATURE2_ERROR_REPORT = parseBooleanEnv("ENABLE_FEATURE2_ERROR_REPORT", false);
const MAX_RECEIVE_COUNT = 2; // Must match SQS redrive policy maxReceiveCount
const PROCESS_FILE_TIMEOUT_MS = Number.parseInt(
  process.env.PROCESS_FILE_TIMEOUT_MS || "1200000",
  10,
);

type ProcessingFailureMetadata = Pick<
  FileRecordUpdate,
  | "discoveredFileCount"
  | "ingestedFileCount"
  | "notIngestedFileCount"
  | "parsedFileCount"
  | "failedJsonSourceFiles"
  | "failedJsonSourceDetails"
  | "rowCount"
  | "successCount"
  | "errorCount"
  | "errors"
  | "country"
  | "countries"
> & {
  readonly zipDiagnostic?: FileRecordUpdate["zipDiagnostic"];
};

type ProcessingFailureError = Error & {
  readonly processingFailureMetadata?: ProcessingFailureMetadata;
};

function createProcessingTimeoutError(s3Key: string): Error {
  const error = new Error(`Processing timed out for ${s3Key} after ${PROCESS_FILE_TIMEOUT_MS}ms`);
  (error as Error & { code?: string }).code = "ETIMEDOUT";
  return error;
}

function assertWithinDeadline(deadlineMs: number, s3Key: string): void {
  if (Date.now() > deadlineMs) {
    throw createProcessingTimeoutError(s3Key);
  }
}

function buildTerminalValidationError(
  s3Key: string,
  message: string,
  rule: string,
): NonNullable<FileRecordUpdate["errors"]> {
  return [
    {
      row: 0,
      field: "file",
      value: s3Key,
      message,
      rule,
    },
  ];
}

function normalizeZipFailureMessage(
  error: unknown,
  discoveredFileCount: number | undefined,
): string {
  if ((discoveredFileCount ?? 0) === 0) {
    return "No files discovered in ZIP archive (archive may be malformed or unreadable)";
  }

  return error instanceof Error ? error.message : String(error);
}

function getZeroOutputFailureMessage(
  discoveredFileCount: number | undefined,
  ingestedFileCount: number | undefined,
  parsedFileCount: number,
): string {
  if (discoveredFileCount === 0) {
    return "No files discovered in ZIP archive (archive may be malformed or unreadable)";
  }

  if (ingestedFileCount === 0) {
    return "No matching files found in ZIP archive";
  }

  if (parsedFileCount === 0) {
    return "No records parsed from matched source files";
  }

  return "No valid output rows after parsing/validation";
}

function collectFailedJsonSourceFiles(stats: ZipStreamStats): string[] | undefined {
  // Only treat malformed/parsing failures as per-file JSON failures.
  // Discovered files that were never selected/processed (for example unsupported request type)
  // should not be emitted as failed JSON source entries.
  const malformedPaths = stats.malformedFilePaths ?? [];
  const unique = new Set<string>(malformedPaths);
  if (unique.size === 0) return undefined;
  return [...unique];
}

function collectFailedJsonSourceDetails(
  stats: ZipStreamStats,
  fallbackReason?: string,
): NonNullable<FileRecordUpdate["failedJsonSourceDetails"]> | undefined {
  const details = new Map<string, string>();

  for (const malformed of stats.malformedFileDetails ?? []) {
    const file = malformed.file?.trim();
    if (!file) continue;
    const reason = malformed.reason?.trim() || "Malformed JSON source file";
    details.set(file, reason);
  }

  for (const file of stats.malformedFilePaths ?? []) {
    if (!file || details.has(file)) continue;
    details.set(file, "Malformed JSON source file");
  }

  const normalizedFallback = fallbackReason?.trim();
  if (normalizedFallback) {
    for (const file of collectFailedJsonSourceFiles(stats) ?? []) {
      if (!details.has(file)) {
        details.set(file, normalizedFallback);
      }
    }
  }

  if (details.size === 0) return undefined;
  return [...details.entries()].map(([file, reason]) => ({ file, reason }));
}

function withProcessingFailureMetadata(
  error: unknown,
  metadata: ProcessingFailureMetadata,
): ProcessingFailureError {
  const wrappedError =
    error instanceof Error ? (error as ProcessingFailureError) : new Error(String(error));
  Object.defineProperty(wrappedError, "processingFailureMetadata", {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  return wrappedError;
}

/**
 * Extract date from S3 filename and convert to ISO date string (YYYY-MM-DD).
 * For createdAt consistency across replays.
 * Returns null if no date is found in the filename.
 *
 * Delegates the actual format matching to the shared extractor
 * (@filepipeline/shared/utility/date-extraction) so this stays in sync with the
 * equivalent extractors in utils/s3.ts and coordinator/date-utils.ts.
 */
function extractDateFromFilename(s3Key: string): string | null {
  const filename = s3Key.split("/").pop();
  if (!filename) return null;
  return extractDateFromFilenameShared(filename);
}

/**
 * Handle error from file processing
 * Returns true if the message should be marked as failed for retry
 */
async function handleProcessingError(
  s3Key: string,
  error: unknown,
  receiveCount: number,
  isLastAttempt: boolean,
): Promise<boolean> {
  console.error(`Error processing ${s3Key} (attempt ${receiveCount}/${MAX_RECEIVE_COUNT}):`, error);

  if (!isRetryableError(error)) {
    console.log(`Non-retryable error for ${s3Key}, marking as FAILED`);
    await markFileFailed(s3Key, error);
    return false; // Don't retry
  }

  if (isLastAttempt) {
    console.log(`Max retries reached for ${s3Key}, marking as DLQ`);
    await markFileForDLQ(s3Key, error);
  }

  return true; // Mark for retry
}

/**
 * Process a single SQS record containing S3 events
 * Returns true if the message should be marked as failed
 */
async function processSqsRecord(sqsRecord: SQSEvent["Records"][0]): Promise<boolean> {
  const receiveCount = Number.parseInt(sqsRecord.attributes.ApproximateReceiveCount, 10);
  const isLastAttempt = receiveCount >= MAX_RECEIVE_COUNT;

  let s3Event: S3EventMessage;
  try {
    s3Event = JSON.parse(sqsRecord.body);
  } catch (parseError) {
    console.error(`Failed to parse SQS message body: ${parseError}`);
    return true; // Will go to DLQ after retries
  }

  for (const s3Record of s3Event.Records) {
    const s3Key = decodeURIComponent(s3Record.s3.object.key.replaceAll("+", " "));

    if (isArchivedIncomingKey(s3Key)) {
      console.log(`Skipping archived file event: ${s3Key}`);
      continue;
    }

    try {
      await processFile(s3Key);
    } catch (error) {
      const shouldRetry = await handleProcessingError(s3Key, error, receiveCount, isLastAttempt);
      if (shouldRetry) {
        return true;
      }
    }
  }

  return false;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  console.log(`Processor Lambda triggered: ${event.Records.length} record(s)`);

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const sqsRecord of event.Records) {
    const shouldMarkFailed = await processSqsRecord(sqsRecord);
    if (shouldMarkFailed) {
      batchItemFailures.push({ itemIdentifier: sqsRecord.messageId });
    }
  }

  return { batchItemFailures };
}

/**
 * Write consolidated CSV from accumulated vendor batch
 */
async function writeConsolidatedCSV(
  vendor: string,
  date: string,
  country: string,
  runId: string,
  filename: string,
  rows: Array<Record<string, unknown>>,
  sourceS3Key?: string,
  customMapping?: VendorMapping,
): Promise<void> {
  const batch = await getVendorBatchByCountry(vendor, date, country, runId);
  if (!batch) {
    console.warn(`No batch found for ${country}#${vendor}#${date}#${filename}, continuing`);
  }

  if (batch?.isConsolidated) {
    console.log(`Batch already consolidated for ${country}#${vendor}#${date}#${filename}`);
    return;
  }

  // Load mapping for the vendor — use custom mapping if provided (for dedup path with specific request type)
  const mapping = customMapping || loadVendorMapping(vendor);

  // Build consolidated CSV from all accumulated rows
  const csvOutput = buildDynamicCSVOutput(rows, mapping);

  // Write to vendor-level S3 key
  const consolidatedKey = buildConsolidatedOutputKey(
    vendor,
    date,
    country,
    batch?.sourceFilename || filename,
    runId,
    sourceS3Key,
  );
  await putObject(PROCESSED_BUCKET, consolidatedKey, csvOutput, "text/csv");
  console.log(
    `Wrote consolidated CSV for ${country}#${vendor}#${date}#${filename} to ${PROCESSED_BUCKET}/${consolidatedKey}`,
  );
  console.log(`CSV contains ${rows.length} rows from ${batch?.fileCount ?? 1} file(s)`);

  // Mark batch as consolidated
  if (batch) {
    await markVendorBatchConsolidated(vendor, date, consolidatedKey, country, runId);
  }
}

function enrichWithCountry(
  data: Record<string, unknown>,
  country: string,
): Record<string, unknown> {
  const existingCubeMetadata =
    data.cube_metadata &&
    typeof data.cube_metadata === "object" &&
    !Array.isArray(data.cube_metadata)
      ? (data.cube_metadata as Record<string, unknown>)
      : undefined;

  const existingCountry = existingCubeMetadata?.country;
  if (typeof existingCountry === "string" && existingCountry.trim() !== "") {
    // Item already carries its own (more specific) country; don't clobber it
    // with the batch/path-derived value.
    return data;
  }

  if (!country) return data;

  return {
    ...data,
    cube_metadata: {
      ...existingCubeMetadata,
      country,
    },
  };
}

interface ProcessingRow {
  rowNumber: number;
  data: Record<string, unknown>;
  rootData: Record<string, unknown>;
}

/**
 * Resolve an arrayPath that may contain find-syntax segments.
 * Find-syntax uses `{findExpr}` to locate the first matching element
 * in an array, e.g. `formData{formType|eq:5}.goodsMutipleType.goodsMutipleTypeInfo`.
 * Segments without find-syntax are resolved via getNestedValue.
 */
function resolveArrayPath(data: Record<string, unknown>, arrayPath: string): unknown {
  // Support || fallbacks at the top level
  const fallbacks = arrayPath
    .split("||")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const path of fallbacks) {
    const result = resolveArrayPathSingle(data, path);
    if (Array.isArray(result) && result.length > 0) return result;
  }
  return undefined;
}

function resolveArrayPathSingle(data: Record<string, unknown>, path: string): unknown {
  // Match segments like `arrayKey{findExpr}` followed by optional `.rest`
  const findMatch = path.match(/^([^{]+)\{([^}]+)\}(.*)$/);
  if (!findMatch) {
    // No find-syntax — resolve directly
    return getNestedValue(data, path);
  }

  const arrayKey = findMatch[1];
  const findExpr = findMatch[2];
  let remaining = findMatch[3];
  if (remaining.startsWith(".")) remaining = remaining.slice(1);

  // Get the array
  const arr = getNestedValue(data, arrayKey);
  if (!Array.isArray(arr)) return undefined;

  // Find matching element using the find expression
  const { basePath, operations, operation } = parseOperation(findExpr);
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const fieldValue = getNestedValue(item as Record<string, unknown>, basePath);
    let conditionMet: unknown;
    if (operations.length > 0) {
      let transformed: unknown = fieldValue;
      for (const op of operations) {
        transformed = applyOperation(transformed, op, item as Record<string, unknown>);
      }
      conditionMet = transformed;
    } else if (operation) {
      conditionMet = applyOperation(fieldValue, operation, item as Record<string, unknown>);
    } else {
      conditionMet = !!fieldValue;
    }

    if (conditionMet === true || conditionMet === 1) {
      if (!remaining) return item;
      // Continue resolving the remaining path against the matched item
      return resolveArrayPathSingle(item as Record<string, unknown>, remaining);
    }
  }
  return undefined;
}

/**
 * Expand rows by iterating over an array field within each row's data.
 * Each array element is injected under the `$expansion` key so that
 * mapping sources can reference element fields via `$expansion.<field>`.
 *
 * arrayPath supports find-syntax: `formData{formType|eq:5}.goodsMutipleType.goodsMutipleTypeInfo`
 */
function applyRowExpansion(
  rows: ProcessingRow[],
  rowExpansion: { readonly arrayPath: string; readonly dedupKey?: string },
): ProcessingRow[] {
  const expanded: ProcessingRow[] = [];
  let skippedRowsWithoutExpansion = 0;
  for (const row of rows) {
    const array = resolveArrayPath(row.data, rowExpansion.arrayPath);
    if (Array.isArray(array) && array.length > 0) {
      const seen = rowExpansion.dedupKey ? new Set<unknown>() : undefined;
      for (const element of array) {
        if (typeof element === "object" && element !== null) {
          if (seen) {
            const key = getNestedValue(element as Record<string, unknown>, rowExpansion.dedupKey!);
            if (seen.has(key)) continue;
            seen.add(key);
          }
          expanded.push({
            rowNumber: expanded.length + 1,
            data: { ...row.data, $expansion: element },
            rootData: row.rootData,
          });
        }
      }
    } else {
      // rowExpansion requires at least one expanded element; otherwise drop the row.
      skippedRowsWithoutExpansion++;
    }
  }

  if (skippedRowsWithoutExpansion > 0) {
    console.log(
      `rowExpansion: skipped ${skippedRowsWithoutExpansion} row(s) because "${rowExpansion.arrayPath}" was missing or empty`,
    );
  }

  return expanded;
}

function resolvePathTokenCandidates(path: string, jsonFileName?: string): string[] {
  if (!path.includes("$fileName") || !jsonFileName) {
    return [path];
  }

  // Use bracket notation so tokens with dots remain a single key segment.
  const escapePathToken = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const candidates: string[] = [];

  // Key entities by filename stem (without extension).
  const dotIndex = jsonFileName.lastIndexOf(".");
  if (dotIndex > 0) {
    const stem = jsonFileName.slice(0, dotIndex);

    // Watsons payloads may use numeric entity keys while files use BP_<id>.json.
    if (/^BP_[0-9]+$/i.test(stem)) {
      candidates.push(stem.slice(3));
    }

    candidates.push(stem);
  } else {
    candidates.push(jsonFileName);
  }

  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.map((candidate) =>
    path.replaceAll("$fileName", `[\"${escapePathToken(candidate)}\"]`),
  );
}

interface IgnoreIfContainsRule {
  readonly path: string;
  readonly text: string | ReadonlyArray<string>;
  readonly caseInsensitive?: boolean;
}

function shouldIgnoreExtractedObject(
  value: Record<string, unknown>,
  rules?: ReadonlyArray<IgnoreIfContainsRule>,
): boolean {
  if (!rules || rules.length === 0) {
    return false;
  }

  return rules.some((rule) => {
    const extracted = getNestedValue(value, rule.path);
    if (extracted === undefined || extracted === null) {
      return false;
    }

    const haystack = String(extracted);
    if (!haystack) {
      return false;
    }

    const texts = Array.isArray(rule.text) ? rule.text : [rule.text];
    return texts.some((t) => {
      if (rule.caseInsensitive) {
        return haystack.toLowerCase().includes(t.toLowerCase());
      }
      return haystack.includes(t);
    });
  });
}

function isMetadataOnlySourcePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return true;

  return (
    trimmed === "$s3" ||
    trimmed.startsWith("$s3.") ||
    trimmed.startsWith("$s3|") ||
    trimmed === "$root" ||
    trimmed.startsWith("$root.cube_metadata") ||
    trimmed === "$fileName" ||
    trimmed.startsWith("$fileName|") ||
    trimmed === "$keywordFromFilename" ||
    trimmed === "$keywordFromFoldername" ||
    trimmed === "$dateFromFilename" ||
    trimmed === "$dateFromZipName" ||
    trimmed === "$zipFilename" ||
    trimmed.startsWith("$zipFilename|") ||
    trimmed === "$timestampFromFilename" ||
    trimmed.startsWith("$timestampFromFilename|") ||
    trimmed === "$match" ||
    trimmed.startsWith("$match.") ||
    trimmed.startsWith("$match|")
  );
}

function hasMeaningfulHtmlMappedValue(
  mappedData: Record<string, unknown>,
  mapping: VendorMapping,
): boolean {
  const htmlContextOnlyFields = new Set([
    "recorded_on",
    "region",
    "shop_location",
    "platform",
    "l1_category",
    "l2_category",
    "l3_category",
    "l4_category",
  ]);

  for (const [fieldName, fieldMapping] of Object.entries(mapping.columns)) {
    if (htmlContextOnlyFields.has(fieldName)) continue;
    if (fieldMapping.compute) continue;
    if (fieldMapping.type === "boolean" || fieldMapping.type === "number") continue;

    const source = fieldMapping.source?.trim();
    if (!source) continue;

    const sourceVariants = source
      .split("||")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (sourceVariants.length === 0) continue;
    if (sourceVariants.every((part) => isMetadataOnlySourcePath(part))) continue;

    const value = mappedData[fieldName];

    // Ignore values that only reflect mapping defaults.
    if (fieldMapping.default !== undefined) {
      const defaultValue = fieldMapping.default;
      const normalizedValue = String(value ?? "")
        .trim()
        .toLowerCase();
      const normalizedDefault = String(defaultValue).trim().toLowerCase();
      if (normalizedValue === normalizedDefault) {
        continue;
      }
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (
        !normalized ||
        normalized === "[]" ||
        normalized === "{}" ||
        normalized === "null" ||
        normalized === "undefined" ||
        normalized === "false"
      ) {
        continue;
      }
    }

    const isEmptyValue =
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).length === 0);

    if (!isEmptyValue) {
      return true;
    }
  }

  return false;
}

/**
 * Deduplicate files by timestamp extracted from filenames.
 * Groups files by keyword (capture group 1), sorts alphabetically within each group,
 * then keeps only the first file per unique timestamp (capture group 2).
 * Files whose filenames don't match the pattern pass through unchanged.
 */
function deduplicateFilesByTimestamp(
  files: ExtractedFile[],
  pattern: string,
  keywordPath?: string,
): ExtractedFile[] {
  const regex = new RegExp(pattern);

  // Separate files into those matching the pattern and those that don't
  const matched: Array<{ file: ExtractedFile; keyword: string; timestamp: string }> = [];
  const unmatched: ExtractedFile[] = [];

  for (const file of files) {
    const m = regex.exec(file.filename);
    if (m && m.length >= 3) {
      matched.push({ file, keyword: m[1], timestamp: m[2] });
    } else {
      unmatched.push(file);
    }
  }

  if (matched.length === 0) {
    return files;
  }

  // Sort by filename-extracted keyword for consistent dedup
  matched.sort(
    (a, b) =>
      a.keyword.localeCompare(b.keyword) ||
      a.timestamp.localeCompare(b.timestamp) ||
      a.file.filename.localeCompare(b.file.filename),
  );

  // Dedup: within each keyword, keep only the first file per unique timestamp
  const seenTimestamps = new Map<string, Set<string>>();
  const kept: Array<{ file: ExtractedFile; timestamp: string }> = [];
  let skippedCount = 0;

  for (const { file, keyword, timestamp } of matched) {
    let seen = seenTimestamps.get(keyword);
    if (!seen) {
      seen = new Set();
      seenTimestamps.set(keyword, seen);
    }

    if (seen.has(timestamp)) {
      skippedCount++;
      continue;
    }

    seen.add(timestamp);
    kept.push({ file, timestamp });
  }

  console.log(
    `deduplicateByTimestamp: kept ${kept.length} files, skipped ${skippedCount} files with duplicate timestamps`,
  );

  // Re-sort kept files by the actual keyword from root data (if keywordPath is set).
  // The filename-extracted keyword may differ from the data keyword (e.g. Shopee query rewrite).
  // Use timestamp as secondary sort to preserve chronological order within the same keyword.
  if (keywordPath && kept.length > 1) {
    const tagged = kept.map(({ file, timestamp }) => {
      const root = file.data[0] ?? {};
      const dataKeyword = String(getNestedValue(root, keywordPath) ?? "");
      return { file, dataKeyword, timestamp };
    });
    tagged.sort(
      (a, b) =>
        a.dataKeyword.localeCompare(b.dataKeyword) || a.timestamp.localeCompare(b.timestamp),
    );
    return [...unmatched, ...tagged.map((t) => t.file)];
  }

  // Return unmatched files first (preserve their order), then deduped matched files (sorted by filename keyword)
  return [...unmatched, ...kept.map((k) => k.file)];
}

async function processFile(s3Key: string): Promise<void> {
  console.log(`Processing file: ${s3Key}`);
  const deadlineMs = Date.now() + PROCESS_FILE_TIMEOUT_MS;

  const { country, vendor, date, filename, requestType } = parseS3Key(s3Key);
  let effectiveCountry = country;
  const runtimeContext = {
    parser: "json" as "json" | "html",
    match: {} as Record<string, string>,
    s3: {
      bucket: INCOMING_BUCKET,
      key: s3Key,
      country: effectiveCountry,
      vendor,
      date,
      filename,
      requestType,
      jsonFileName: undefined as string | undefined,
      jsonFilePath: undefined as string | undefined,
    },
  };
  const timestamp = new Date().toISOString();

  // Get or create file record
  let fileRecord = await getFileByS3Key(s3Key);
  if (!fileRecord) {
    // Create record if registration Lambda didn't create it
    const now = new Date().toISOString();
    const extractedDate = extractDateFromFilename(s3Key);
    const createdAtDate = extractedDate ? `${extractedDate}T00:00:00.000Z` : now;
    const newRecord = {
      id: randomUUID(),
      s3Key,
      vendor,
      filename,
      status: "QUEUED" as const,
      queuedAt: now,
      createdAt: createdAtDate,
      updatedAt: now,
    };
    await createFileRecord(newRecord);
    fileRecord = {
      ...newRecord,
      rowCount: 0,
      successCount: 0,
      errorCount: 0,
      errors: [],
    };
  } else if (
    fileRecord.status === "COMPLETED" ||
    fileRecord.status === "PARTIAL" ||
    fileRecord.status === "FAILED" ||
    fileRecord.status === "DLQ"
  ) {
    // Same S3 key being replayed; update existing record with extracted date instead of creating a new one
    const now = new Date().toISOString();
    const extractedDate = extractDateFromFilename(s3Key);
    const createdAtDate = extractedDate ? `${extractedDate}T00:00:00.000Z` : fileRecord.createdAt;

    // Update the existing record with extracted date, reset to QUEUED for reprocessing
    await updateFileRecord(fileRecord.id, {
      createdAt: createdAtDate,
      queuedAt: now,
      updatedAt: now,
      status: "QUEUED",
      // Clear stale failure metadata from previous runs on the same S3 key.
      failedJsonSourceFiles: [],
      failedJsonSourceDetails: [],
      rowCount: 0,
      successCount: 0,
      errorCount: 0,
      errors: [],
    });

    // Reset the vendor batch's isConsolidated flag so the CSV is re-written on replay.
    // Replays may have stale fileRecord.country (for example MULTI) while current parsing
    // resolves a concrete country (for example my), so reset all plausible batch keys.
    const { vendor: batchVendor, date: batchDate, country: parsedBatchCountry } = parseS3Key(s3Key);
    const replayBatchCountries = new Set<string>([""]);

    if (fileRecord.country?.trim()) {
      replayBatchCountries.add(fileRecord.country.trim());
    }

    if (parsedBatchCountry?.trim()) {
      replayBatchCountries.add(parsedBatchCountry.trim());
    }

    // Reuse previously discovered countries from prior processing runs (for example my/ph).
    for (const batchCountry of fileRecord.countries ?? []) {
      if (batchCountry?.trim()) {
        replayBatchCountries.add(batchCountry.trim());
      }
    }

    for (const replayBatchCountry of replayBatchCountries) {
      await resetVendorBatch(batchVendor, batchDate, replayBatchCountry, fileRecord.id);
    }

    // Refresh record with updated values
    fileRecord = await getFileByS3Key(s3Key);
    if (!fileRecord) {
      throw new Error(`Failed to refresh file record after update: ${s3Key}`);
    }
  }

  // Update status to PROCESSING
  await updateFileStatus(fileRecord.id, "PROCESSING", { startedAt: timestamp });

  // Process files based on type
  let allValidatedRows: Array<{ rowNumber: number; data: Record<string, unknown> }> = [];
  let totalRowsToValidate = 0;
  let globalRowNumber = 0;
  let parsedFileCount = 0;
  let discoveredFileCount: number | undefined;
  let ingestedFileCount: number | undefined;
  let skippedHtmlDefaultLikeRows = 0;
  let totalIgnoredByContentCount = 0;
  let scriptExtractionFailureCount = 0;
  let companionFilesJoined = 0;
  let companionFilesUnmatched = 0;
  let failedJsonSourceFiles: string[] | undefined;
  let failedJsonSourceDetails: NonNullable<FileRecordUpdate["failedJsonSourceDetails"]> | undefined;
  const discoveredCountries = new Set<string>();
  let lastHeartbeatMs = Date.now();
  // Streaming CSV writer for large ZIP files — rows are flushed in batches
  // instead of accumulated in memory.
  let streamingCsvWriter: StreamingCSVWriter | undefined;
  // Track which mappings are used for deduplication check
  const usedMappingIds = new Set<string>();
  // Track the mapping to use for CSV output (for both streaming and buffered paths)
  let csvOutputMapping: VendorMapping | undefined;
  // Accumulate validation errors for feature2 error report (keyword-products only)
  const isKeywordProducts = requestType === "keyword-products";
  const validationErrorsByJsonFile = new Map<
    string,
    { country: string; jsonFileName: string; errors: ValidationError[] }
  >();

  const recordFeature2ValidationErrors = (errors: ValidationError[]) => {
    if (!isKeywordProducts || !ENABLE_FEATURE2_ERROR_REPORT || errors.length === 0) {
      return;
    }

    const jsonFileName = runtimeContext.s3.jsonFileName || filename;
    const country = normalizeFeature2Country(runtimeContext.s3.country);
    const key = `${country}/${jsonFileName}`;
    const existing = validationErrorsByJsonFile.get(key) ?? {
      country,
      jsonFileName,
      errors: [],
    };
    existing.errors.push(...errors);
    validationErrorsByJsonFile.set(key, existing);
  };

  const heartbeat = async () => {
    const now = Date.now();
    if (now - lastHeartbeatMs >= 30000) {
      await updateFileRecord(fileRecord.id, { updatedAt: new Date().toISOString() });
      lastHeartbeatMs = now;
    }
  };

  if (s3Key.toLowerCase().endsWith(".zip")) {
    // ZIP file: process each file individually with its own mapping
    const mappingIndex = loadVendorMappingIndex(vendor);
    const defaultMapping = loadVendorMapping(vendor, mappingIndex.default);
    const zipParser = defaultMapping.parser ?? "json";
    let lastProgressLogMs = Date.now();
    const mappingCache = new Map<string, ReturnType<typeof loadVendorMapping>>();
    const zipStats: ZipStreamStats = { discoveredFileCount: 0 };
    let bufferedFiles: ExtractedFile[] = [];
    try {
      const zipObjectStream = await getObjectStream(INCOMING_BUCKET, s3Key);
      const zipStream =
        zipParser === "html"
          ? streamHTMLFromZipStream(
              zipObjectStream,
              mappingIndex.selectionRules,
              mappingIndex.default,
              { requestType, zipFilename: filename },
              mappingIndex.regions,
              zipStats,
            )
          : streamJSONFromZipStream(
              zipObjectStream,
              mappingIndex.selectionRules,
              mappingIndex.default,
              { requestType, zipFilename: filename },
              mappingIndex.regions,
              zipStats,
            );

      // Process each file from the ZIP with its own mapping
      // Buffer all files first to support deduplication if needed
      for await (const file of zipStream) {
        bufferedFiles.push(file);
      }
      discoveredFileCount = zipStats.discoveredFileCount;
      ingestedFileCount = bufferedFiles.length;
      if (zipParser === "json") {
        failedJsonSourceFiles = collectFailedJsonSourceFiles(zipStats);
        failedJsonSourceDetails = collectFailedJsonSourceDetails(zipStats);
      }
    } catch (error) {
      discoveredFileCount = zipStats.discoveredFileCount;
      ingestedFileCount = bufferedFiles.length;
      const errorMessage = normalizeZipFailureMessage(error, discoveredFileCount);
      if (zipParser === "json") {
        failedJsonSourceFiles = collectFailedJsonSourceFiles(zipStats);
        failedJsonSourceDetails = collectFailedJsonSourceDetails(zipStats, errorMessage);
      }

      const errorRule = error instanceof NonRetryableError ? error.code : "UNKNOWN";
      const zipDiagnostic =
        error instanceof Error &&
        "diagnostic" in error &&
        error.diagnostic &&
        typeof error.diagnostic === "object"
          ? (error.diagnostic as FileRecordUpdate["zipDiagnostic"])
          : undefined;
      throw withProcessingFailureMetadata(error, {
        discoveredFileCount,
        ingestedFileCount,
        notIngestedFileCount:
          discoveredFileCount !== undefined && ingestedFileCount !== undefined
            ? Math.max(0, discoveredFileCount - ingestedFileCount)
            : undefined,
        parsedFileCount,
        failedJsonSourceFiles,
        failedJsonSourceDetails,
        zipDiagnostic,
        rowCount: 0,
        successCount: 0,
        errorCount: 1,
        country: effectiveCountry || undefined,
        countries:
          discoveredCountries.size > 0
            ? Array.from(discoveredCountries).sort((a, b) => a.localeCompare(b))
            : undefined,
        errors: buildTerminalValidationError(s3Key, errorMessage, errorRule),
      });
    }

    // Check if any mapping requires timestamp-based deduplication
    let filesToProcess = bufferedFiles;
    const dedupConfigs = new Map<string, string | undefined>();
    for (const file of bufferedFiles) {
      const cacheKey = file.mappingId || "default";
      let mapping = mappingCache.get(cacheKey);
      if (!mapping) {
        mapping = loadVendorMapping(vendor, file.mappingId);
        mappingCache.set(cacheKey, mapping);
      }
      const dedup = mapping.pathExtraction?.deduplicateByTimestamp;
      if (dedup?.pattern && !dedupConfigs.has(dedup.pattern)) {
        dedupConfigs.set(dedup.pattern, dedup.keywordPath);
      }
    }

    // Apply dedup for each unique pattern found
    for (const [pattern, keywordPath] of dedupConfigs) {
      filesToProcess = deduplicateFilesByTimestamp(filesToProcess, pattern, keywordPath);
    }

    // Check if any mapping requires row-level deduplication and track used mappings
    let hasRowDedup = false;
    for (const file of filesToProcess) {
      const mapId = file.mappingId || "default";
      usedMappingIds.add(mapId);
      const cacheKey = mapId;
      let mapping = mappingCache.get(cacheKey);
      if (!mapping) {
        mapping = loadVendorMapping(vendor, file.mappingId);
        mappingCache.set(cacheKey, mapping);
      }
      if (mapping.rowDeduplication) {
        hasRowDedup = true;
      }
    }

    // Initialise streaming CSV writer — the consolidated output key depends on
    // vendor batch state, so we resolve it lazily on first row write.
    // Skip streaming writer if row-level deduplication is configured, since we need
    // to accumulate all rows in memory to deduplicate properly.
    // Determine the mapping for CSV output from the first file's mapping.
    // This ensures the CSV schema matches the actual processing mapping, not the default.
    const firstFileMappingId =
      filesToProcess.length > 0 ? filesToProcess[0].mappingId || "default" : mappingIndex.default;
    csvOutputMapping = loadVendorMapping(vendor, firstFileMappingId);

    if (!hasRowDedup) {
      const consolidatedKey = buildConsolidatedOutputKey(
        vendor,
        date,
        effectiveCountry,
        filename,
        fileRecord.id,
        s3Key,
      );
      // Create streaming CSV writer with the correct mapping
      streamingCsvWriter = new StreamingCSVWriter(
        PROCESSED_BUCKET,
        consolidatedKey,
        csvOutputMapping,
      );
    }

    // Companion HTML bodies (e.g. Momoshop's description/output/<id>.html) joined into
    // JSON rows by filename stem. Loaded lazily, once per distinct filePattern, since a
    // ZIP is only ever parsed with one file type (see the "Mixed parser types" guard below).
    const companionFileMaps = new Map<string, CompanionFileMap>();

    const rankingContext = createRankingContext();
    for (const file of filesToProcess) {
      parsedFileCount++;
      assertWithinDeadline(deadlineMs, s3Key);

      runtimeContext.s3.jsonFileName = file.filename;
      runtimeContext.s3.jsonFilePath = file.path;
      runtimeContext.match = file.captures ?? {};

      // Extract country from folder path if not already set
      if (!effectiveCountry) {
        // Try file.region first, then extract from path, fallback to empty string
        effectiveCountry =
          file.region ||
          extractCountryFromPath(file.path) ||
          extractCountryFromPath(file.filename) ||
          "";
        runtimeContext.s3.country = effectiveCountry;
      }

      await heartbeat();

      const mappingCacheKey = file.mappingId || "default";
      let mapping = mappingCache.get(mappingCacheKey);
      if (!mapping) {
        mapping = loadVendorMapping(vendor, file.mappingId);
        mappingCache.set(mappingCacheKey, mapping);
      }

      const fileParser = mapping.parser ?? zipParser;
      if (fileParser !== zipParser) {
        throw new Error(
          `Mixed parser types in one ZIP are not supported yet: expected ${zipParser}, got ${fileParser} for ${file.path}`,
        );
      }
      runtimeContext.parser = fileParser;

      let companionMap: CompanionFileMap | undefined;
      if (mapping.companionSource) {
        const { filePattern } = mapping.companionSource;
        companionMap = companionFileMaps.get(filePattern);
        if (!companionMap) {
          const zipBuffer = await getObject(INCOMING_BUCKET, s3Key);
          companionMap = await loadCompanionFileMap(zipBuffer, filePattern);
          companionFileMaps.set(filePattern, companionMap);
        }
      }

      const fileCountry = file.region || effectiveCountry;
      runtimeContext.s3.country = fileCountry;
      if (fileCountry) {
        discoveredCountries.add(fileCountry);
      }

      // Convert data array to ParsedRow format
      const fileRows: ProcessingRow[] = file.data.map((data, index) => {
        const rootData = enrichWithCountry(data, fileCountry);
        return {
          rowNumber: index + 1,
          data: rootData,
          rootData,
        };
      });

      // Apply path extraction if configured in the mapping
      let finalRows: ProcessingRow[] = fileRows;

      // scriptExpression: evaluate JS expression against <script> contents from HTML
      if (mapping.pathExtraction?.scriptExpression) {
        const htmlContent =
          fileRows.length > 0 ? (fileRows[0].data.__html as string | undefined) : undefined;
        if (htmlContent) {
          const extracted = extractFromScripts(
            htmlContent,
            mapping.pathExtraction.scriptExpression,
            () => scriptExtractionFailureCount++,
          );
          const rootData = fileRows[0].rootData;
          let ignoredByContentCount = 0;

          const scriptRows: ProcessingRow[] = [];
          for (const item of extracted) {
            if (shouldIgnoreExtractedObject(item, mapping.pathExtraction.ignoreIfContains)) {
              ignoredByContentCount++;
              continue;
            }
            scriptRows.push({
              rowNumber: scriptRows.length + 1,
              data: enrichWithCountry(item, fileCountry),
              rootData,
            });
          }

          finalRows = scriptRows;
          // Extracted rows are plain JSON — use JSON dot-path resolver, not HTML selectors
          runtimeContext.parser = "json";

          totalIgnoredByContentCount += ignoredByContentCount;
          console.log(`scriptExpression: extracted ${scriptRows.length} row(s) from ${file.path}`);
        }
      } else if (mapping.pathExtraction?.path) {
        const extractedRows: ProcessingRow[] = [];
        let extractionRowCount = 0;
        let ignoredByContentCount = 0;
        const extractionPaths = resolvePathTokenCandidates(
          mapping.pathExtraction.path,
          file.filename,
        );

        // Apply path extraction to each row
        for (const row of fileRows) {
          let extractedValue: unknown;
          let hasScalarMatch = false;

          for (const extractionPath of extractionPaths) {
            const candidate = getNestedValue(row.data, extractionPath);
            if (candidate === undefined || candidate === null) {
              continue;
            }

            if (Array.isArray(candidate) || typeof candidate === "object") {
              extractedValue = candidate;
              hasScalarMatch = false;
              break;
            }

            hasScalarMatch = true;
          }

          if (Array.isArray(extractedValue)) {
            // Extract array - each item becomes a row
            for (const item of extractedValue) {
              if (typeof item === "object" && item !== null) {
                const extractedObject = item as Record<string, unknown>;
                if (
                  shouldIgnoreExtractedObject(
                    extractedObject,
                    mapping.pathExtraction.ignoreIfContains,
                  )
                ) {
                  ignoredByContentCount++;
                  continue;
                }

                extractedRows.push({
                  rowNumber: extractedRows.length + 1,
                  data: enrichWithCountry(extractedObject, fileCountry),
                  rootData: row.rootData,
                });
                extractionRowCount++;
              }
            }
          } else if (typeof extractedValue === "object" && extractedValue !== null) {
            // Single object - add as one row
            const extractedObject = extractedValue as Record<string, unknown>;
            if (
              shouldIgnoreExtractedObject(extractedObject, mapping.pathExtraction.ignoreIfContains)
            ) {
              ignoredByContentCount++;
              continue;
            }

            extractedRows.push({
              rowNumber: extractedRows.length + 1,
              data: enrichWithCountry(extractedObject, fileCountry),
              rootData: row.rootData,
            });
            extractionRowCount++;
          } else if (extractedValue === undefined || extractedValue === null) {
            if (hasScalarMatch) {
              throw new Error(
                `Path extraction failed: "${mapping.pathExtraction.path}" returned non-object value`,
              );
            }

            // Path not found - skip row (no data at this path means no output row)
          } else {
            // Extracted value is a scalar (string, number, etc.) - error
            throw new Error(
              `Path extraction failed: "${mapping.pathExtraction.path}" returned non-object value`,
            );
          }
        }

        finalRows = extractedRows;

        totalIgnoredByContentCount += ignoredByContentCount;
      }

      if (companionMap && mapping.companionSource) {
        const companionBody = companionMap.get(companionStemOf(file.filename));
        if (companionBody !== undefined && companionBody.length > 0) {
          companionFilesJoined++;
          const injectKey = mapping.companionSource.injectAs;
          finalRows = finalRows.map((row) => ({
            ...row,
            data: { ...row.data, [injectKey]: companionBody },
          }));
        } else {
          companionFilesUnmatched++;
        }
      }

      // Expand rows by array field if configured
      if (mapping.rowExpansion) {
        const preExpansionCount = finalRows.length;
        finalRows = applyRowExpansion(finalRows, mapping.rowExpansion);
        if (finalRows.length !== preExpansionCount) {
          console.log(
            `rowExpansion: expanded ${preExpansionCount} row(s) into ${finalRows.length} row(s) via "${mapping.rowExpansion.arrayPath}" for ${file.path}`,
          );
        }
      }

      // Validate and transform rows for this file — stream to CSV writer
      totalRowsToValidate += finalRows.length;
      for (const [, row] of finalRows.entries()) {
        globalRowNumber++;
        rankingContext.rowIndex = globalRowNumber - 1;

        if (row.rowNumber % 500 === 0) {
          assertWithinDeadline(deadlineMs, s3Key);
          await heartbeat();
        }

        const result = validateRow(
          { rowNumber: row.rowNumber, data: row.data },
          mapping,
          row.rootData,
          { ...runtimeContext, ranking: rankingContext },
        );

        if (
          runtimeContext.parser === "html" &&
          !hasMeaningfulHtmlMappedValue(result.data, mapping)
        ) {
          skippedHtmlDefaultLikeRows++;
          continue;
        }

        recordFeature2ValidationErrors(result.errors);

        const shouldSkip = isKeywordProducts && ENABLE_FEATURE2_VALIDATION && !result.isValid;
        if (!shouldSkip) {
          if (streamingCsvWriter) {
            await streamingCsvWriter.addRow(result.data);
          } else {
            allValidatedRows.push({ rowNumber: globalRowNumber, data: result.data });
          }
        }
      }

      const now = Date.now();
      if (parsedFileCount <= 3 || now - lastProgressLogMs >= 15000) {
        const currentRowCount = streamingCsvWriter
          ? streamingCsvWriter.rowCount
          : allValidatedRows.length;
        console.log(
          `[${vendor}] ${filename}: processed ${parsedFileCount} ZIP entries, ${currentRowCount} rows`,
        );
        lastProgressLogMs = now;
      }
    }

    console.log(`Parsed ${parsedFileCount} file(s) from ${s3Key}`);
    if (companionFilesJoined > 0 || companionFilesUnmatched > 0) {
      console.log(
        `companionSource: joined ${companionFilesJoined} file(s), ${companionFilesUnmatched} unmatched or empty, in ${s3Key}`,
      );
    }
    if (totalIgnoredByContentCount > 0) {
      console.log(
        `ignoreIfContains: skipped ${totalIgnoredByContentCount} row(s) across ${parsedFileCount} file(s) in ${s3Key}`,
      );
    }
    if (scriptExtractionFailureCount > 0) {
      console.log(
        `scriptExpression: evaluation failed for ${scriptExtractionFailureCount} entr${scriptExtractionFailureCount === 1 ? "y" : "ies"} in ${s3Key}`,
      );
    }
  } else {
    // Non-ZIP files remain on the buffered path.
    const fileBuffer = await getObject(INCOMING_BUCKET, s3Key);

    // Load vendor mapping
    const mapping = loadVendorMapping(vendor);
    const parser = mapping.parser ?? "json";
    runtimeContext.parser = parser;

    // Single file parsing routes by mapping parser (defaults to json)
    const content = fileBuffer.toString("utf-8");
    const parseResult = parser === "html" ? parseHTML(content) : parseJSON(content);
    parsedFileCount = 1;
    console.log(`Parsed ${parseResult.totalRows} rows from ${s3Key} using parser=${parser}`);

    // Apply path extraction if configured in the mapping
    let finalRows: ProcessingRow[] = parseResult.rows.map((row) => {
      const rootData = enrichWithCountry(row.data, effectiveCountry);
      return {
        rowNumber: row.rowNumber,
        data: rootData,
        rootData,
      };
    });
    if (mapping.pathExtraction?.scriptExpression) {
      const htmlContent =
        finalRows.length > 0 ? (finalRows[0].data.__html as string | undefined) : undefined;
      if (htmlContent) {
        const extracted = extractFromScripts(htmlContent, mapping.pathExtraction.scriptExpression);
        const rootData = finalRows[0].rootData;
        let ignoredByContentCount = 0;

        const scriptRows: ProcessingRow[] = [];
        for (const item of extracted) {
          if (shouldIgnoreExtractedObject(item, mapping.pathExtraction.ignoreIfContains)) {
            ignoredByContentCount++;
            continue;
          }
          scriptRows.push({
            rowNumber: scriptRows.length + 1,
            data: enrichWithCountry(item, effectiveCountry),
            rootData,
          });
        }

        finalRows = scriptRows;
        // Extracted rows are plain JSON — use JSON dot-path resolver, not HTML selectors
        runtimeContext.parser = "json";

        if (ignoredByContentCount > 0) {
          console.log(
            `scriptExpression: ignored ${ignoredByContentCount} row(s) by ignoreIfContains`,
          );
        }
        console.log(`scriptExpression: extracted ${scriptRows.length} row(s) from ${s3Key}`);
      }
    } else if (mapping.pathExtraction?.path) {
      const extractedRows: ProcessingRow[] = [];
      let extractionRowCount = 0;
      let ignoredByContentCount = 0;

      // Apply path extraction to each row
      const extractionPaths = resolvePathTokenCandidates(mapping.pathExtraction.path, filename);

      for (const row of finalRows) {
        let extractedValue: unknown;
        let hasScalarMatch = false;

        for (const extractionPath of extractionPaths) {
          const candidate = getNestedValue(row.data, extractionPath);
          if (candidate === undefined || candidate === null) {
            continue;
          }

          if (Array.isArray(candidate) || typeof candidate === "object") {
            extractedValue = candidate;
            hasScalarMatch = false;
            break;
          }

          hasScalarMatch = true;
        }

        if (Array.isArray(extractedValue)) {
          // Extract array - each item becomes a row
          for (const item of extractedValue) {
            if (typeof item === "object" && item !== null) {
              const extractedObject = item as Record<string, unknown>;
              if (
                shouldIgnoreExtractedObject(
                  extractedObject,
                  mapping.pathExtraction.ignoreIfContains,
                )
              ) {
                ignoredByContentCount++;
                continue;
              }

              extractedRows.push({
                rowNumber: extractedRows.length + 1,
                data: enrichWithCountry(extractedObject, effectiveCountry),
                rootData: row.rootData,
              });
              extractionRowCount++;
            }
          }
        } else if (typeof extractedValue === "object" && extractedValue !== null) {
          // Single object - add as one row
          const extractedObject = extractedValue as Record<string, unknown>;
          if (
            shouldIgnoreExtractedObject(extractedObject, mapping.pathExtraction.ignoreIfContains)
          ) {
            ignoredByContentCount++;
            continue;
          }

          extractedRows.push({
            rowNumber: extractedRows.length + 1,
            data: enrichWithCountry(extractedObject, effectiveCountry),
            rootData: row.rootData,
          });
          extractionRowCount++;
        } else if (extractedValue === undefined || extractedValue === null) {
          if (hasScalarMatch) {
            throw new Error(
              `Path extraction failed: "${mapping.pathExtraction.path}" returned non-object value`,
            );
          }

          // Path not found - skip row (no data at this path means no output row)
        } else {
          // Extracted value is a scalar (string, number, etc.) - error
          throw new Error(
            `Path extraction failed: "${mapping.pathExtraction.path}" returned non-object value`,
          );
        }
      }

      finalRows = extractedRows;
      console.log(
        `Path extraction: extracted ${extractionRowCount} rows from "${mapping.pathExtraction.path}", ignored ${ignoredByContentCount} rows by ignoreIfContains`,
      );
    }

    // Expand rows by array field if configured
    if (mapping.rowExpansion) {
      const preExpansionCount = finalRows.length;
      finalRows = applyRowExpansion(finalRows, mapping.rowExpansion);
      if (finalRows.length !== preExpansionCount) {
        console.log(
          `rowExpansion: expanded ${preExpansionCount} row(s) into ${finalRows.length} row(s) via "${mapping.rowExpansion.arrayPath}"`,
        );
      }
    }

    // Validate and transform rows
    totalRowsToValidate = finalRows.length;
    const rankingContext = createRankingContext();
    for (const [rowIndex, row] of finalRows.entries()) {
      globalRowNumber++;
      rankingContext.rowIndex = rowIndex;

      if (row.rowNumber % 500 === 0) {
        assertWithinDeadline(deadlineMs, s3Key);
        await heartbeat();
      }

      const result = validateRow(
        { rowNumber: row.rowNumber, data: row.data },
        mapping,
        row.rootData,
        { ...runtimeContext, ranking: rankingContext },
      );

      if (runtimeContext.parser === "html" && !hasMeaningfulHtmlMappedValue(result.data, mapping)) {
        skippedHtmlDefaultLikeRows++;
        continue;
      }

      recordFeature2ValidationErrors(result.errors);

      if (!isKeywordProducts || !ENABLE_FEATURE2_VALIDATION || result.isValid) {
        allValidatedRows.push({ rowNumber: globalRowNumber, data: result.data });
      }
    }
  }

  // Apply row-level deduplication if configured
  let dedupRemovedCount = 0;
  let duplicateKeyBreakdown: DuplicateKeyBreakdownEntry[] | undefined;
  if (allValidatedRows.length > 0) {
    let dedupMapping: ReturnType<typeof loadVendorMapping> | undefined;

    if (s3Key.toLowerCase().endsWith(".zip")) {
      // For ZIP files, check all actual mappings used for dedup config
      // Use the first mapping that has rowDeduplication config, or the default if none
      const mappingIndex = loadVendorMappingIndex(vendor);

      // Check each used mapping for dedup config
      for (const mapId of usedMappingIds) {
        const mapping = loadVendorMapping(vendor, mapId);
        if (mapping.rowDeduplication) {
          dedupMapping = mapping;
          break;
        }
      }

      // Fallback to default if no dedup config found
      if (!dedupMapping) {
        dedupMapping = loadVendorMapping(vendor, mappingIndex.default);
      }
    } else {
      // For non-ZIP files, use the single mapping
      dedupMapping = loadVendorMapping(vendor);
    }

    if (dedupMapping.rowDeduplication) {
      const rowsBeforeDedup = allValidatedRows;
      const beforeCount = allValidatedRows.length;
      allValidatedRows = deduplicateRows(allValidatedRows, dedupMapping);
      const afterCount = allValidatedRows.length;
      dedupRemovedCount = beforeCount - afterCount;
      if (dedupRemovedCount > 0) {
        duplicateKeyBreakdown = buildDuplicateKeyBreakdownFromRows(
          rowsBeforeDedup,
          allValidatedRows,
        );
      }
      console.log(
        `rowDeduplication: ${dedupRemovedCount} duplicate(s) removed (${beforeCount} → ${afterCount} rows)`,
      );

      // Recompute rankings post-dedup for each keyword/region partition
      recomputeRankingsPostDedup(allValidatedRows);
    }
  }

  // Helper function to recompute rankings after dedup
  function recomputeRankingsPostDedup(
    rows: Array<{ rowNumber: number; data: Record<string, unknown> }>,
  ): void {
    // Count rows by keyword before partitioning
    const keywordCounts = new Map<string, number>();
    for (const row of rows) {
      const keyword = String(row.data.search_keyword ?? "");
      keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
    }
    const topKeywords = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([keyword, count]) => `${keyword}=${count}`)
      .join(", ");

    // Group rows by (search_keyword, region) to get partitions
    const partitionMap = new Map<string, typeof rows>();
    for (const row of rows) {
      const keyword = String(row.data.search_keyword ?? "");
      const region = String(row.data.region ?? "");
      const partitionKey = `${keyword}|${region}`;

      if (!partitionMap.has(partitionKey)) {
        partitionMap.set(partitionKey, []);
      }
      partitionMap.get(partitionKey)!.push(row);
    }

    // Recompute rankings sequentially within each partition
    let minPartitionRows = Infinity;
    let maxPartitionRows = 0;
    for (const [, partitionRows] of partitionMap.entries()) {
      let adsCounter = 0;
      let organicCounter = 0;
      let overallCounter = 0;

      for (let idx = 0; idx < partitionRows.length; idx++) {
        const row = partitionRows[idx];
        const isAd = row.data.is_ad === true || row.data.is_ad === "true" || row.data.is_ad === 1;

        // Recompute ads ranking
        if (isAd) {
          adsCounter++;
          row.data.ads_ranking = adsCounter;
        } else {
          row.data.ads_ranking = 0;
        }

        // Recompute organic ranking
        if (!isAd) {
          organicCounter++;
          row.data.organic_ranking = organicCounter;
        } else {
          row.data.organic_ranking = 0;
        }

        // Recompute overall ranking (always increments per row)
        overallCounter++;
        row.data.overall_ranking = overallCounter;
        row.data.download_rank = overallCounter;
      }

      minPartitionRows = Math.min(minPartitionRows, partitionRows.length);
      maxPartitionRows = Math.max(maxPartitionRows, partitionRows.length);
    }

    console.log(
      `[recomputeRankingsPostDedup] rows=${rows.length} keywords=${keywordCounts.size} (top: ${topKeywords}) partitions=${partitionMap.size} rows/partition min=${partitionMap.size ? minPartitionRows : 0} max=${maxPartitionRows}`,
    );
  }

  // Write feature2 validation error report for keyword-products, grouped by JSON file.
  if (isKeywordProducts && ENABLE_FEATURE2_ERROR_REPORT && validationErrorsByJsonFile.size > 0) {
    for (const { country, jsonFileName, errors } of validationErrorsByJsonFile.values()) {
      const errorReportKey = buildFeature2ValidationErrorReportKey(
        s3Key,
        vendor,
        filename,
        country,
        jsonFileName,
      );
      await putObject(
        PROCESSED_BUCKET,
        errorReportKey,
        buildErrorReport(errors),
        "application/json",
      );
      console.log(
        `Wrote feature2 validation error report: ${errorReportKey} (${errors.length} errors)`,
      );
    }
  }

  // Determine final status
  if (skippedHtmlDefaultLikeRows > 0) {
    console.log(
      `Filtered ${skippedHtmlDefaultLikeRows} HTML row(s) with only default/empty mapped values`,
    );
  }
  const successCount = streamingCsvWriter ? streamingCsvWriter.rowCount : allValidatedRows.length;
  const status: "COMPLETED" | "FAILED" = successCount > 0 ? "COMPLETED" : "FAILED";

  const terminalErrors =
    status === "FAILED"
      ? buildTerminalValidationError(
          s3Key,
          getZeroOutputFailureMessage(discoveredFileCount, ingestedFileCount, parsedFileCount),
          "ZERO_OUTPUT_ROWS",
        )
      : [];

  if (status === "FAILED" && failedJsonSourceFiles && failedJsonSourceFiles.length > 0) {
    const failureReason = terminalErrors[0]?.message ?? "No detailed failure reason recorded";
    const detailsByFile = new Map<string, string>();

    for (const detail of failedJsonSourceDetails ?? []) {
      detailsByFile.set(detail.file, detail.reason);
    }

    for (const file of failedJsonSourceFiles) {
      if (!detailsByFile.has(file)) {
        detailsByFile.set(file, failureReason);
      }
    }

    failedJsonSourceDetails = [...detailsByFile.entries()].map(([file, reason]) => ({
      file,
      reason,
    }));
  }

  // Finish streaming CSV writer (flushes remaining rows and completes S3 upload)
  if (streamingCsvWriter) {
    if (streamingCsvWriter.rowCount === 0) {
      // No rows to write — abort to avoid creating an empty file on S3
      await streamingCsvWriter.abort();
      console.log(`Skipped writing empty CSV (0 rows) for ${vendor}/${date}/${effectiveCountry}`);
    } else {
      try {
        await streamingCsvWriter.finish();
      } catch (finishError) {
        await streamingCsvWriter.abort();
        throw finishError;
      }
    }
  }

  // Append validated rows to vendor batch accumulator (only counters are persisted)
  await appendToVendorBatch(
    vendor,
    date,
    streamingCsvWriter ? [] : allValidatedRows.map((r) => r.data),
    successCount,
    0,
    effectiveCountry,
    fileRecord.id,
    filename,
  );
  console.log(
    `Appended ${successCount} rows to vendor batch ${effectiveCountry}#${vendor}#${date}#${fileRecord.id}`,
  );

  // Update file record
  const update: FileRecordUpdate = {
    status,
    discoveredFileCount,
    ingestedFileCount,
    notIngestedFileCount:
      discoveredFileCount !== undefined && ingestedFileCount !== undefined
        ? discoveredFileCount - ingestedFileCount
        : undefined,
    parsedFileCount,
    failedJsonSourceFiles: status === "FAILED" ? failedJsonSourceFiles : undefined,
    failedJsonSourceDetails: status === "FAILED" ? failedJsonSourceDetails : undefined,
    rowCount: totalRowsToValidate,
    successCount,
    dedupRemovedCount: dedupRemovedCount > 0 ? dedupRemovedCount : undefined,
    duplicateKeyBreakdown:
      dedupRemovedCount > 0 && duplicateKeyBreakdown && duplicateKeyBreakdown.length > 0
        ? duplicateKeyBreakdown
        : undefined,
    errorCount: terminalErrors.length,
    errors: terminalErrors,
    country:
      discoveredCountries.size > 1
        ? "MULTI"
        : Array.from(discoveredCountries)[0] || effectiveCountry || undefined,
    countries:
      discoveredCountries.size > 0
        ? Array.from(discoveredCountries).sort((a, b) => a.localeCompare(b))
        : [],
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await updateFileRecord(fileRecord.id, update);
  console.log(`Updated file record ${fileRecord.id} with status ${status}`);

  // Archive incoming ZIP files after processing to avoid clutter and reprocessing.
  if (s3Key.toLowerCase().endsWith(".zip")) {
    const archiveKey = buildArchiveKeyFromIncomingKey(s3Key, fileRecord.id);
    try {
      await moveObject(INCOMING_BUCKET, s3Key, archiveKey);
      console.log(`Archived processed ZIP from ${s3Key} to ${archiveKey}`);
    } catch (archiveError) {
      console.warn(`Failed to archive ZIP ${s3Key} to ${archiveKey}:`, archiveError);
    }
  }

  // Consolidate for non-streaming path (non-ZIP files and ZIP files with dedup).
  // ZIP files without dedup already streamed their consolidated CSV via streamingCsvWriter.
  if (!streamingCsvWriter) {
    await writeConsolidatedCSV(
      vendor,
      date,
      effectiveCountry,
      fileRecord.id,
      filename,
      allValidatedRows.map((r) => r.data),
      s3Key,
      csvOutputMapping,
    );
  } else {
    // For streaming path, mark the vendor batch as consolidated
    const batch = await getVendorBatchByCountry(vendor, date, effectiveCountry, fileRecord.id);
    if (batch && !batch.isConsolidated) {
      const consolidatedKey = buildConsolidatedOutputKey(
        vendor,
        date,
        effectiveCountry,
        filename,
        fileRecord.id,
        s3Key,
      );
      await markVendorBatchConsolidated(
        vendor,
        date,
        consolidatedKey,
        effectiveCountry,
        fileRecord.id,
      );
      console.log(
        `Wrote streamed consolidated CSV for ${effectiveCountry}#${vendor}#${date} to ${PROCESSED_BUCKET}/${consolidatedKey} (${successCount} rows)`,
      );
    }
  }
}

async function markFileFailed(s3Key: string, error: unknown): Promise<void> {
  try {
    let fileRecord = await getFileByS3Key(s3Key);

    if (!fileRecord) {
      // Create a failed record
      const { vendor, filename } = parseS3Key(s3Key);
      const now = new Date().toISOString();
      const extractedDate = extractDateFromFilename(s3Key);
      const createdAtDate = extractedDate ? `${extractedDate}T00:00:00.000Z` : now;
      await createFileRecord({
        id: randomUUID(),
        s3Key,
        vendor,
        filename,
        status: "FAILED",
        queuedAt: now,
        createdAt: createdAtDate,
        updatedAt: now,
      });
      fileRecord = await getFileByS3Key(s3Key);
    }

    if (fileRecord) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof NonRetryableError ? error.code : "UNKNOWN";
      const metadata = (error as ProcessingFailureError).processingFailureMetadata;

      await updateFileRecord(fileRecord.id, {
        status: "FAILED",
        discoveredFileCount: metadata?.discoveredFileCount,
        ingestedFileCount: metadata?.ingestedFileCount,
        notIngestedFileCount: metadata?.notIngestedFileCount,
        parsedFileCount: metadata?.parsedFileCount,
        failedJsonSourceFiles: metadata?.failedJsonSourceFiles ?? [],
        failedJsonSourceDetails: metadata?.failedJsonSourceDetails ?? [],
        zipDiagnostic: metadata?.zipDiagnostic,
        rowCount: metadata?.rowCount,
        successCount: metadata?.successCount,
        country: metadata?.country,
        countries: metadata?.countries,
        errorCount: metadata?.errorCount ?? 1,
        errors: metadata?.errors ?? buildTerminalValidationError(s3Key, errorMessage, errorCode),
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (updateError) {
    console.error("Failed to mark file as failed:", updateError);
  }
}

/**
 * Mark a file as moved to DLQ (after max retries for retryable errors)
 */
async function markFileForDLQ(s3Key: string, error: unknown): Promise<void> {
  try {
    let fileRecord = await getFileByS3Key(s3Key);

    if (!fileRecord) {
      // Create a DLQ record
      const { vendor, filename } = parseS3Key(s3Key);
      const now = new Date().toISOString();
      const extractedDate = extractDateFromFilename(s3Key);
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
      fileRecord = await getFileByS3Key(s3Key);
    }

    if (fileRecord) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const metadata = (error as ProcessingFailureError).processingFailureMetadata;

      await updateFileRecord(fileRecord.id, {
        status: "DLQ",
        discoveredFileCount: metadata?.discoveredFileCount,
        ingestedFileCount: metadata?.ingestedFileCount,
        notIngestedFileCount: metadata?.notIngestedFileCount,
        parsedFileCount: metadata?.parsedFileCount,
        failedJsonSourceFiles: metadata?.failedJsonSourceFiles ?? [],
        failedJsonSourceDetails: metadata?.failedJsonSourceDetails ?? [],
        zipDiagnostic: metadata?.zipDiagnostic,
        rowCount: metadata?.rowCount,
        successCount: metadata?.successCount,
        country: metadata?.country,
        countries: metadata?.countries,
        errorCount: metadata?.errorCount ?? 1,
        errors: metadata?.errors ?? [
          {
            row: 0,
            field: "processing",
            value: s3Key,
            message: `Max retries exceeded: ${errorMessage}`,
            rule: "MAX_RETRIES",
          },
        ],
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (updateError) {
    console.error("Failed to mark file for DLQ:", updateError);
  }
}

// For local development
export { handler as processorHandler };
