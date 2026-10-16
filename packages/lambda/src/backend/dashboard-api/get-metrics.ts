import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { CHANNEL_DISPLAY_NAME } from "@filepipeline/shared/constants/channel-display-names";
import { isVendorSupported } from "@filepipeline/shared/utility/vendor-mappings";

const dynamodb = new DynamoDBClient({ region: "ap-southeast-1" });
const s3 = new S3Client({ region: "ap-southeast-1" });
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE;
const CONSOLIDATION_TABLE = process.env.CONSOLIDATION_TABLE;
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;

interface FileRecord {
  readonly vendor: string;
  readonly s3Key: string;
  readonly status: string;
  readonly failureReason: string;
  readonly discoveredFileCount: number | null;
  readonly ingestedFileCount: number | null;
  readonly parsedFileCount: number | null;
  readonly failedJsonSourceFiles: string[] | null;
  readonly failedJsonSourceDetails: FailedSource[] | null;
  readonly zipDiagnostic: Record<string, unknown> | null;
  readonly rowCount: number;
  readonly successCount: number;
  readonly dedupRemovedCount: number | null;
  readonly duplicateKeyBreakdown: DuplicateKeyExample[] | null;
  readonly country: string;
  readonly countries: string[] | null;
  readonly createdAt: string;
}

interface FailedSource {
  readonly file: string;
  readonly reason: string;
  readonly diagnostic?: Record<string, unknown>;
}

interface GroupedFailedJsonSource {
  readonly zipPath: string;
  readonly jsonPaths: FailedSource[];
}

interface FailedProductSource {
  readonly file: string;
  readonly failedCount: number;
  readonly reason: string;
  readonly jsonPaths: FailedSource[];
  readonly duplicateKeyBreakdown?: DuplicateKeyExample[];
}

interface DuplicateKeyExample {
  readonly product_id?: string | number;
  readonly region?: string;
  readonly search_keyword?: string;
  readonly recorded_on?: string;
  readonly failedCount: number;
}

interface ConsolidationStateRecord {
  readonly vendor: string;
  readonly outputRowCountTotal: number;
  readonly productsFailedValidationTotal: number;
  readonly droppedBeforeValidationTotal: number;
}

interface ConsolidationIssue {
  readonly vendor: string;
  readonly date: string;
  readonly state: string;
  readonly detail: string;
  readonly queuedFileCount: number;
}

interface ProcessingOverride {
  readonly total: number;
  readonly byPlatform: Record<string, number>;
  readonly byCountry: Record<string, number>;
}

const VENDOR_TO_CHANNEL: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNEL_DISPLAY_NAME).map(([slug, display]) => [display, slug]),
);

function resolveVendorSlug(vendor: string): string | null {
  const normalizedVendor = vendor.trim();
  if (!normalizedVendor || normalizedVendor === "UNKNOWN") return null;

  // Vendor from DynamoDB is stored as display name (e.g. "Tiktok")
  // Map it to slug (e.g. "tiktok") if it exists in VENDOR_TO_CHANNEL
  const slug = VENDOR_TO_CHANNEL[normalizedVendor];
  return slug ?? null;
}

function isSupportedVendor(vendor: string): boolean {
  const slug = resolveVendorSlug(vendor);
  return slug ? isVendorSupported(slug) : false;
}

function getStringAttr(item: Record<string, AttributeValue>, key: string): string | null {
  const value = item[key];
  if (!value || !("S" in value)) return null;
  return value.S ?? null;
}

function getNumberAttr(item: Record<string, AttributeValue>, key: string): number | null {
  const value = item[key];
  if (!value || !("N" in value)) return null;
  const parsed = Number(value.N);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringListAttr(item: Record<string, AttributeValue>, key: string): string[] | null {
  const value = item[key];
  if (!value) return null;

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

function getFailedSourceListAttr(
  item: Record<string, AttributeValue>,
  key: string,
): FailedSource[] | null {
  const value = item[key];
  if (!value || !("L" in value) || !Array.isArray(value.L)) return null;

  const entries: FailedSource[] = [];
  for (const entry of value.L) {
    if (!("M" in entry) || !entry.M) continue;
    const fileAttr = entry.M["file"];
    if (!fileAttr || !("S" in fileAttr) || !fileAttr.S) continue;

    const reasonAttr = entry.M["reason"];
    const reason =
      reasonAttr && "S" in reasonAttr && reasonAttr.S
        ? reasonAttr.S
        : "No detailed failure reason recorded";

    entries.push({
      file: fileAttr.S,
      reason,
    });
  }

  return entries.length > 0 ? entries : null;
}

function getDuplicateKeyBreakdownAttr(
  item: Record<string, AttributeValue>,
  key: string,
): DuplicateKeyExample[] | null {
  const value = item[key];
  if (!value || !("L" in value) || !Array.isArray(value.L)) return null;

  const entries: DuplicateKeyExample[] = [];
  for (const entry of value.L) {
    if (!("M" in entry) || !entry.M) continue;
    const map = entry.M;

    const getString = (attrKey: string): string | undefined => {
      const attr = map[attrKey];
      if (!attr || !("S" in attr) || !attr.S) return undefined;
      return attr.S;
    };

    const getStringOrNumber = (attrKey: string): string | number | undefined => {
      const attr = map[attrKey];
      if (!attr) return undefined;
      if ("S" in attr) return attr.S ?? undefined;
      if ("N" in attr) {
        const parsed = Number(attr.N);
        return Number.isFinite(parsed) ? parsed : attr.N;
      }
      return undefined;
    };

    const failedCountAttr = map["failedCount"];
    let failedCount = 0;
    if (failedCountAttr && "N" in failedCountAttr) {
      const parsed = Number(failedCountAttr.N);
      failedCount = Number.isFinite(parsed) ? parsed : 0;
    }
    if (failedCount <= 0) continue;

    entries.push({
      product_id: getStringOrNumber("product_id") ?? getStringOrNumber("source_product_id"),
      region: getString("region"),
      search_keyword: getString("search_keyword"),
      recorded_on: getString("recorded_on"),
      failedCount,
    });
  }

  return entries.length > 0 ? entries : null;
}

function getZipDiagnosticAttr(
  item: Record<string, AttributeValue>,
  key: string,
): Record<string, unknown> | null {
  const value = item[key];
  if (!value || !("M" in value) || !value.M) return null;

  const map = value.M;
  const diagnostic: Record<string, unknown> = {};

  const getString = (attrKey: string): string | undefined => {
    const attr = map[attrKey];
    if (!attr || !("S" in attr) || !attr.S) return undefined;
    return attr.S;
  };

  const getNumber = (attrKey: string): number | undefined => {
    const attr = map[attrKey];
    if (!attr || !("N" in attr)) return undefined;
    const parsed = Number(attr.N);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const getStringList = (attrKey: string): string[] | undefined => {
    const attr = map[attrKey];
    if (!attr) return undefined;
    if ("L" in attr && Array.isArray(attr.L)) {
      const list: string[] = [];
      for (const entry of attr.L) {
        if ("S" in entry && typeof entry.S === "string") {
          list.push(entry.S);
        }
      }
      return list.length > 0 ? list : undefined;
    }
    return undefined;
  };

  const expectedPattern = getString("expectedPattern");
  const totalFilesInZip = getNumber("totalFilesInZip");
  const jsonFilesFound = getNumber("jsonFilesFound");
  const filesMatched = getNumber("filesMatched");
  const topLevelFolders = getStringList("topLevelFolders");
  const fileExtensionsFound = getStringList("fileExtensionsFound");
  const sampleFilePaths = getStringList("sampleFilePaths");

  if (expectedPattern) diagnostic.expectedPattern = expectedPattern;
  if (totalFilesInZip !== undefined) diagnostic.totalFilesInZip = totalFilesInZip;
  if (jsonFilesFound !== undefined) diagnostic.jsonFilesFound = jsonFilesFound;
  if (filesMatched !== undefined) diagnostic.filesMatched = filesMatched;
  if (topLevelFolders) diagnostic.topLevelFolders = topLevelFolders;
  if (fileExtensionsFound) diagnostic.fileExtensionsFound = fileExtensionsFound;
  if (sampleFilePaths) diagnostic.sampleFilePaths = sampleFilePaths;

  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
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
  const failedJsonSourceDetails = getFailedSourceListAttr(item, "failedJsonSourceDetails");
  const rowCount = getNumberAttr(item, "rowCount");
  const successCount = getNumberAttr(item, "successCount") ?? 0;
  const dedupRemovedCount = getNumberAttr(item, "dedupRemovedCount");
  const duplicateKeyBreakdown = getDuplicateKeyBreakdownAttr(item, "duplicateKeyBreakdown");
  const zipDiagnostic = getZipDiagnosticAttr(item, "zipDiagnostic");
  const country = getStringAttr(item, "country") ?? "";
  const countries = getStringListAttr(item, "countries");

  if (!vendor || !s3Key || !createdAt || rowCount === null) return null;
  return {
    vendor,
    s3Key,
    status,
    failureReason,
    discoveredFileCount,
    ingestedFileCount,
    parsedFileCount,
    failedJsonSourceFiles,
    failedJsonSourceDetails,
    zipDiagnostic,
    rowCount,
    successCount,
    dedupRemovedCount,
    duplicateKeyBreakdown,
    country,
    countries,
    createdAt,
  };
}

async function getFilesForDate(datePrefix: string): Promise<FileRecord[]> {
  if (!DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is not configured.");
  }

  const configuredSegments = Number(process.env.METRICS_SCAN_SEGMENTS ?? "4");
  const totalSegments = Number.isFinite(configuredSegments)
    ? Math.max(1, Math.min(16, Math.floor(configuredSegments)))
    : 4;

  const scanSegment = async (segment: number): Promise<FileRecord[]> => {
    const segmentRecords: FileRecord[] = [];
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await dynamodb.send(
        new ScanCommand({
          TableName: DYNAMODB_TABLE,
          ProjectionExpression:
            "#vendor, #s3Key, #status, #errors, #discoveredFileCount, #ingestedFileCount, #parsedFileCount, #failedJsonSourceFiles, #failedJsonSourceDetails, #zipDiagnostic, #rowCount, #successCount, #dedupRemovedCount, #duplicateKeyBreakdown, #country, #countries, #createdAt",
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
            "#failedJsonSourceDetails": "failedJsonSourceDetails",
            "#zipDiagnostic": "zipDiagnostic",
            "#rowCount": "rowCount",
            "#successCount": "successCount",
            "#dedupRemovedCount": "dedupRemovedCount",
            "#duplicateKeyBreakdown": "duplicateKeyBreakdown",
            "#country": "country",
            "#countries": "countries",
            "#createdAt": "createdAt",
          },
          ExpressionAttributeValues: {
            ":datePrefix": { S: datePrefix },
          },
          Segment: segment,
          TotalSegments: totalSegments,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      for (const item of response.Items ?? []) {
        const record = toFileRecord(item);
        if (record) segmentRecords.push(record);
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return segmentRecords;
  };

  const segmentedResults = await Promise.all(
    Array.from({ length: totalSegments }, (_, index) => scanSegment(index)),
  );

  return segmentedResults.flat();
}

function toConsolidationStateRecord(
  item: Record<string, AttributeValue>,
): ConsolidationStateRecord | null {
  const pk = getStringAttr(item, "pk");
  const outputRowCountTotal = getNumberAttr(item, "outputRowCountTotal");
  const productsFailedValidationTotal = getNumberAttr(item, "productsFailedValidationTotal") ?? 0;
  const droppedBeforeValidationTotal = getNumberAttr(item, "droppedBeforeValidationTotal") ?? 0;
  if (!pk || outputRowCountTotal === null) return null;

  const [vendor] = pk.split("#");
  if (!vendor) return null;

  return {
    vendor,
    outputRowCountTotal,
    productsFailedValidationTotal,
    droppedBeforeValidationTotal,
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
        ProjectionExpression:
          "#pk, #sk, #outputRowCountTotal, #productsFailedValidationTotal, #droppedBeforeValidationTotal",
        FilterExpression: "#sk = :state AND contains(#pk, :dateSuffix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#outputRowCountTotal": "outputRowCountTotal",
          "#productsFailedValidationTotal": "productsFailedValidationTotal",
          "#droppedBeforeValidationTotal": "droppedBeforeValidationTotal",
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

async function getConsolidationIssuesForDate(date: string): Promise<ConsolidationIssue[]> {
  if (!CONSOLIDATION_TABLE) {
    return [];
  }

  const issueCandidates: Array<{
    vendor: string;
    status: string;
    errorMessage: string | null;
    stateKey: string;
  }> = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamodb.send(
      new ScanCommand({
        TableName: CONSOLIDATION_TABLE,
        ProjectionExpression: "#pk, #sk, #status, #errorMessage",
        FilterExpression: "#sk = :state AND contains(#pk, :dateSuffix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#status": "status",
          "#errorMessage": "errorMessage",
        },
        ExpressionAttributeValues: {
          ":state": { S: "state" },
          ":dateSuffix": { S: `#${date}` },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const pk = getStringAttr(item, "pk");
      const status = getStringAttr(item, "status");
      const errorMessage = getStringAttr(item, "errorMessage");

      if (!pk || !status) continue;

      const [vendor] = pk.split("#");
      if (!vendor) continue;

      // Only report non-terminal states or states with errors
      if (status !== "READY" && status !== "COMPLETE") {
        issueCandidates.push({
          vendor,
          status,
          errorMessage,
          stateKey: pk,
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const queuedCounts = await mapWithConcurrency(issueCandidates, 8, (candidate) =>
    countQueuedFilesForState(candidate.stateKey),
  );

  const issues: ConsolidationIssue[] = [];
  for (let i = 0; i < issueCandidates.length; i++) {
    const candidate = issueCandidates[i];
    const queuedCount = queuedCounts[i] ?? 0;

    issues.push({
      vendor: candidate.vendor,
      date,
      state: candidate.status,
      detail:
        candidate.status === "FAILED"
          ? candidate.errorMessage || "Consolidation failed (no error details)"
          : candidate.status === "PROCESSING"
            ? `Consolidation in progress with ${queuedCount} queued files`
            : `Consolidation state unknown: ${candidate.status}`,
      queuedFileCount: queuedCount,
    });
  }

  return issues;
}

async function countQueuedFilesForState(stateKey: string): Promise<number> {
  if (!CONSOLIDATION_TABLE) {
    return 0;
  }

  try {
    let total = 0;
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await dynamodb.send(
        new QueryCommand({
          TableName: CONSOLIDATION_TABLE,
          Select: "COUNT",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :queued)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#sk": "sk",
          },
          ExpressionAttributeValues: {
            ":pk": { S: stateKey },
            ":queued": { S: "queued#" },
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      total += response.Count ?? 0;
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return total;
  } catch {
    return 0;
  }
}

function groupConsolidatedFailedByPlatform(
  records: ConsolidationStateRecord[],
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const record of records) {
    const failedTotal = record.productsFailedValidationTotal + record.droppedBeforeValidationTotal;
    grouped[record.vendor] = (grouped[record.vendor] ?? 0) + failedTotal;
  }
  return grouped;
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

function buildMergeDroppedSources(
  sourceSuccessByPlatform: Record<string, number>,
  consolidatedByPlatform: Record<string, number>,
  consolidatedFailedByPlatform: Record<string, number>,
  date: string,
): FailedProductSource[] {
  const [year, month, day] = date.split("-");

  const results = Object.entries(sourceSuccessByPlatform)
    .map(([vendor, sourceSuccessTotal]) => {
      const mergedOutputTotal = consolidatedByPlatform[vendor] ?? 0;
      const knownFailedTotal = consolidatedFailedByPlatform[vendor] ?? 0;
      const droppedAfterMerging = Math.max(
        0,
        sourceSuccessTotal - mergedOutputTotal - knownFailedTotal,
      );

      if (droppedAfterMerging <= 0) return null;

      return {
        file: `tagged_output/platform=${vendor}/year=${year}/month=${month}/day=${day}/*/consolidated.csv`,
        failedCount: droppedAfterMerging,
        reason: "merged into existing product/sku IDs during consolidation",
        jsonPaths: [] as FailedSource[],
      };
    })
    .filter((entry): entry is FailedProductSource => entry !== null)
    .sort((a, b) => b.failedCount - a.failedCount);

  return results;
}

function buildConsolidatedFailedSources(
  records: ConsolidationStateRecord[],
  date: string,
): Promise<FailedProductSource[]> {
  const [year, month, day] = date.split("-");
  const results = records
    .map((record) => {
      const validationFailed = record.productsFailedValidationTotal;
      const droppedBeforeValidation = record.droppedBeforeValidationTotal;
      const failedCount = validationFailed + droppedBeforeValidation;
      if (failedCount <= 0) return null;

      const reasons: string[] = [];
      if (validationFailed > 0) reasons.push(`validation_failed=${validationFailed}`);
      if (droppedBeforeValidation > 0) {
        reasons.push("dropped due to missing source_product_id field");
      }

      return {
        file: `tagged_output/platform=${record.vendor}/year=${year}/month=${month}/day=${day}/*/consolidated.csv`,
        failedCount,
        reason: reasons.join(", ") || "No explicit processing error recorded",
        jsonPaths: [] as FailedSource[],
      };
    })
    .filter((entry): entry is FailedProductSource => entry !== null)
    .sort((a, b) => b.failedCount - a.failedCount);

  return Promise.resolve(results);
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      results[currentIndex] = await worker(items[currentIndex]);
    }
  };

  await Promise.all(Array.from({ length: boundedLimit }, () => runWorker()));
  return results;
}

async function summarizeFailedProcessingFile(
  key: string,
): Promise<{ rowCount: number; reasonCounts: Record<string, number> }> {
  if (!PROCESSED_BUCKET) return { rowCount: 0, reasonCounts: {} };

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: key,
    }),
  );

  const csv = await bodyToString(response.Body);
  if (!csv.trim()) return { rowCount: 0, reasonCounts: {} };

  const { parse } = await import("csv-parse/sync");
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Array<Record<string, any>>;

  const reasonCounts: Record<string, number> = {};
  for (const row of rows) {
    const reason = String(row.failure_reason ?? "").trim();
    if (!reason) continue;
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }

  return { rowCount: rows.length, reasonCounts };
}

async function extractDuplicateKeyExamples(
  csvS3Key: string,
  maxExamples = 5,
): Promise<DuplicateKeyExample[]> {
  if (!PROCESSED_BUCKET) return [];

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: csvS3Key,
      }),
    );

    const csv = await bodyToString(response.Body);
    if (!csv.trim()) return [];

    const { parse } = await import("csv-parse/sync");
    const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Array<
      Record<string, unknown>
    >;

    const grouped = new Map<string, DuplicateKeyExample>();

    for (const row of rows) {
      const productId =
        (row.product_id as string | number | undefined) ??
        (row.PRODUCT_ID as string | number | undefined);
      const region = (row.region as string | undefined) ?? (row.REGION as string | undefined);
      const searchKeyword =
        (row.search_keyword as string | undefined) ?? (row.SEARCH_KEYWORD as string | undefined);
      const recordedOn =
        (row.recorded_on as string | undefined) ?? (row.RECORDED_ON as string | undefined);

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
        grouped.set(key, {
          ...existing,
          failedCount: existing.failedCount + 1,
        });
        continue;
      }

      grouped.set(key, {
        product_id: productId,
        region: region ? String(region) : undefined,
        search_keyword: searchKeyword ? String(searchKeyword) : undefined,
        recorded_on: recordedOn ? String(recordedOn) : undefined,
        failedCount: 1,
      });
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.failedCount - a.failedCount)
      .slice(0, maxExamples);
  } catch {
    return [];
  }
}

function buildDuplicateBreakdownCandidateKeys(record: FileRecord): string[] {
  const candidates = new Set<string>();

  if (record.s3Key.endsWith(".csv")) {
    candidates.add(record.s3Key);
  }

  const sourceKey = record.s3Key.startsWith("output/")
    ? record.s3Key.slice("output/".length)
    : record.s3Key;

  const lastSlash = sourceKey.lastIndexOf("/");
  const dir = lastSlash >= 0 ? sourceKey.slice(0, lastSlash) : "";
  const file = lastSlash >= 0 ? sourceKey.slice(lastSlash + 1) : sourceKey;
  const fileStem = file.replace(/\.[^.]+$/, "");

  if (dir.includes("file_type=") && dir.includes("channel=") && dir.includes("request_type=")) {
    candidates.add(`output/${dir}/${fileStem}_processed.csv`);

    const failedDir = dir.replace(/(channel=[^/]+\/)/, "$1output/");
    candidates.add(`failed_processing/${failedDir}/${fileStem}.csv`);
  }

  return Array.from(candidates);
}

async function extractDuplicateKeyExamplesFromRecord(
  record: FileRecord,
): Promise<DuplicateKeyExample[]> {
  const candidateKeys = buildDuplicateBreakdownCandidateKeys(record);

  for (const key of candidateKeys) {
    const breakdown = await extractDuplicateKeyExamples(key);
    if (breakdown.length > 0) {
      return breakdown;
    }
  }

  return [];
}

function formatFailedReason(reasonCounts: Record<string, number>): string {
  const entries = Object.entries(reasonCounts);
  if (entries.length === 0) {
    return "No explicit processing error recorded";
  }

  const parts: string[] = [];
  for (const [reason, count] of entries) {
    if (reason === "missing_source_product_id") {
      parts.push("dropped due to missing source_product_id field");
      continue;
    }

    parts.push(`${reason}=${count}`);
  }

  return parts.join(", ");
}

async function buildDetailedConsolidatedFailedSources(
  records: ConsolidationStateRecord[],
  date: string,
): Promise<FailedProductSource[]> {
  const [year, month, day] = date.split("-");
  const compactDate = `${year}${month}${day}`;
  const resultBatches = await mapWithConcurrency(records, 4, async (record) => {
    const entries: FailedProductSource[] = [];
    const expectedValidation = record.productsFailedValidationTotal;
    const expectedMissing = record.droppedBeforeValidationTotal;
    const expectedTotal = expectedValidation + expectedMissing;
    if (expectedTotal <= 0) return entries;

    const channel = VENDOR_TO_CHANNEL[record.vendor];
    if (!channel || !PROCESSED_BUCKET) {
      const reasons: string[] = [];
      if (expectedValidation > 0) reasons.push(`validation_failed=${expectedValidation}`);
      if (expectedMissing > 0) {
        reasons.push("dropped due to missing source_product_id field");
      }
      entries.push({
        file: `tagged_output/platform=${record.vendor}/year=${year}/month=${month}/day=${day}/*/consolidated.csv`,
        failedCount: expectedTotal,
        reason: reasons.join(", ") || "No explicit processing error recorded",
        jsonPaths: [],
      });
      return entries;
    }

    const prefixes = [
      `failed_processing/file_type=json/channel=${channel}/output/`,
      `failed_processing/file_type=html/channel=${channel}/output/`,
    ];

    const candidateKeySet = new Set<string>();
    const keyGroups = await Promise.all(
      prefixes.map((prefix) => listObjectKeys(PROCESSED_BUCKET, prefix)),
    );

    for (const keys of keyGroups) {
      for (const key of keys) {
        if (!key.endsWith(".csv")) continue;
        if (!key.includes(compactDate)) continue;
        candidateKeySet.add(key);
      }
    }

    let accountedValidation = 0;
    let accountedMissing = 0;
    let accountedTotal = 0;

    const candidateKeys = Array.from(candidateKeySet);
    const summaries = await mapWithConcurrency(candidateKeys, 8, (key) =>
      summarizeFailedProcessingFile(key),
    );

    for (let i = 0; i < candidateKeys.length; i++) {
      const key = candidateKeys[i];
      const { rowCount, reasonCounts } = summaries[i];
      if (rowCount <= 0) continue;

      accountedTotal += rowCount;
      accountedValidation += reasonCounts.validation_failed ?? 0;
      accountedMissing += reasonCounts.missing_source_product_id ?? 0;

      entries.push({
        file: key,
        failedCount: rowCount,
        reason: formatFailedReason(reasonCounts),
        jsonPaths: [],
      });
    }

    const missingValidation = Math.max(0, expectedValidation - accountedValidation);
    const missingSourceId = Math.max(0, expectedMissing - accountedMissing);
    const unmatchedTotal = Math.max(0, expectedTotal - accountedTotal);

    if (unmatchedTotal > 0 || missingValidation > 0 || missingSourceId > 0) {
      const reasons: string[] = [];
      if (missingValidation > 0) reasons.push(`validation_failed=${missingValidation}`);
      if (missingSourceId > 0) {
        reasons.push("dropped due to missing source_product_id field");
      }

      entries.push({
        file: `tagged_output/platform=${record.vendor}/year=${year}/month=${month}/day=${day}/*/consolidated.csv`,
        failedCount: unmatchedTotal > 0 ? unmatchedTotal : missingValidation + missingSourceId,
        reason: reasons.join(", ") || "No explicit processing error recorded",
        jsonPaths: [],
      });
    }

    return entries;
  });

  return resultBatches.flat().sort((a, b) => b.failedCount - a.failedCount);
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";

  const maybeBody = body as any;
  if (typeof maybeBody.transformToString === "function") {
    return maybeBody.transformToString();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of maybeBody as NodeJS.ReadableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
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
  // newlineCount includes the header row's newline; subtract 1 for header
  return Math.max(0, newlineCount - 1);
}

interface ConsolidatedCounts {
  readonly byCountry: Record<string, number>;
  readonly byPlatform: Record<string, number>;
}

async function getConsolidatedCounts(date: string): Promise<ConsolidatedCounts> {
  if (!PROCESSED_BUCKET) return { byCountry: {}, byPlatform: {} };

  const [year, month, day] = date.split("-");
  const vendors = Object.keys(VENDOR_TO_CHANNEL);

  const keyGroups = await mapWithConcurrency(vendors, 6, async (vendor) => {
    const prefix = `tagged_output/platform=${vendor}/year=${year}/month=${month}/day=${day}/`;
    const keys = await listObjectKeys(PROCESSED_BUCKET, prefix);
    return keys.filter((key) => key.endsWith("/consolidated.csv"));
  });

  const consolidatedKeys = keyGroups.flat();

  const byCountry: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};

  const rowResults = await mapWithConcurrency(consolidatedKeys, 8, async (key) => {
    const platformMatch = key.match(/platform=([^/]+)/);
    const platform = platformMatch?.[1];

    const parts = key.split("/");
    const country = parts.length >= 2 ? parts[parts.length - 2] : "UNKNOWN";

    const objectResponse = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );

    const rowCount = await countCsvRowsStreaming(objectResponse.Body);
    return { country, platform, rowCount };
  });

  for (const result of rowResults) {
    byCountry[result.country] = (byCountry[result.country] ?? 0) + result.rowCount;
    if (result.platform) {
      byPlatform[result.platform] = (byPlatform[result.platform] ?? 0) + result.rowCount;
    }
  }

  return { byCountry, byPlatform };
}

function groupCounts(
  records: FileRecord[],
  keyFn: (r: FileRecord) => string = (r) => r.vendor,
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const record of records) {
    const key = keyFn(record);
    if (!isSupportedVendor(key)) continue;
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
    if (!isSupportedVendor(key)) continue;
    // Keep original vendor key format from DynamoDB
    grouped[key] = (grouped[key] ?? 0) + valueFn(record);
  }
  return grouped;
}

function getResolvedCountries(record: FileRecord): string[] {
  const normalizedCountries = (record.countries ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry !== "multi" && entry !== "unknown");

  if (normalizedCountries.length > 0) {
    return Array.from(new Set(normalizedCountries)).sort((a, b) => a.localeCompare(b));
  }

  const fallback = (record.country ?? "").trim().toLowerCase();
  if (!fallback || fallback === "multi" || fallback === "unknown") {
    return ["UNKNOWN"];
  }

  return [fallback];
}

function allocateByCountries(value: number, countries: string[]): Array<[string, number]> {
  const safeValue = Math.max(0, Math.floor(value));
  if (safeValue <= 0 || countries.length === 0) return [];

  const base = Math.floor(safeValue / countries.length);
  let remainder = safeValue - base * countries.length;

  return countries.map((country) => {
    const allocated = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return [country, allocated];
  });
}

function groupTotalsByCountry(
  records: FileRecord[],
  valueFn: (r: FileRecord) => number,
  options?: { readonly ignoreUnknown?: boolean },
): Record<string, number> {
  const grouped: Record<string, number> = {};
  const ignoreUnknown = options?.ignoreUnknown ?? false;

  for (const record of records) {
    const allocations = allocateByCountries(valueFn(record), getResolvedCountries(record));
    for (const [country, allocated] of allocations) {
      if (ignoreUnknown && country === "UNKNOWN") continue;
      if (allocated <= 0) continue;
      grouped[country] = (grouped[country] ?? 0) + allocated;
    }
  }

  return grouped;
}

function groupPathsByPlatform(records: FileRecord[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const record of records) {
    const key = record.vendor;
    if (!isSupportedVendor(key)) continue;
    grouped[key] = grouped[key] ?? [];
    grouped[key].push(record.s3Key);
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => a.localeCompare(b));
  }

  return grouped;
}

function estimateCountryDistribution(
  sourceRecords: FileRecord[],
  platformTotals: Record<string, number>,
): Record<string, number> {
  const sourceByPlatformCountry = new Map<string, Map<string, number>>();

  for (const record of sourceRecords) {
    const platform = record.vendor;
    if (platform === "UNKNOWN") continue;
    const allocations = allocateByCountries(record.successCount, getResolvedCountries(record));

    if (!sourceByPlatformCountry.has(platform)) {
      sourceByPlatformCountry.set(platform, new Map<string, number>());
    }

    const countryMap = sourceByPlatformCountry.get(platform)!;
    for (const [country, allocated] of allocations) {
      if (allocated <= 0) continue;
      countryMap.set(country, (countryMap.get(country) ?? 0) + allocated);
    }
  }

  const estimatedByCountry: Record<string, number> = {};

  for (const [platform, targetTotal] of Object.entries(platformTotals)) {
    if (targetTotal <= 0) continue;

    const countryMap = sourceByPlatformCountry.get(platform);
    if (!countryMap || countryMap.size === 0) {
      estimatedByCountry.UNKNOWN = (estimatedByCountry.UNKNOWN ?? 0) + targetTotal;
      continue;
    }

    const sourceTotal = Array.from(countryMap.values()).reduce((sum, n) => sum + n, 0);
    if (sourceTotal <= 0) {
      estimatedByCountry.UNKNOWN = (estimatedByCountry.UNKNOWN ?? 0) + targetTotal;
      continue;
    }

    const rawAllocations = Array.from(countryMap.entries()).map(([country, count]) => {
      const exact = (count / sourceTotal) * targetTotal;
      const floored = Math.floor(exact);
      return { country, exact, floored, fraction: exact - floored };
    });

    let remaining =
      targetTotal - rawAllocations.reduce((sum, allocation) => sum + allocation.floored, 0);

    rawAllocations.sort((a, b) => b.fraction - a.fraction);
    for (let i = 0; i < rawAllocations.length && remaining > 0; i += 1) {
      rawAllocations[i]!.floored += 1;
      remaining -= 1;
    }

    for (const allocation of rawAllocations) {
      if (allocation.floored <= 0) continue;
      estimatedByCountry[allocation.country] =
        (estimatedByCountry[allocation.country] ?? 0) + allocation.floored;
    }
  }

  return estimatedByCountry;
}

function extractRequestType(s3Key: string): string {
  const match = s3Key.match(/request_type=([^/]+)/);
  return match?.[1] ?? "unknown";
}

function isShopProducts(record: FileRecord): boolean {
  const requestType = extractRequestType(record.s3Key);
  return (
    requestType === "shop-products" ||
    requestType === "catalogue-products" ||
    requestType === "username-products"
  );
}

function isPdp(record: FileRecord): boolean {
  const requestType = extractRequestType(record.s3Key);
  return requestType === "product-skus" || requestType === "product-skus-csapi";
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
      diagnostic: record.zipDiagnostic ?? undefined,
    }));
}

function getFailedJsonSources(records: FileRecord[]): GroupedFailedJsonSource[] {
  return records.flatMap((record) => {
    if (record.status !== "FAILED" && record.status !== "DLQ") return [];
    const detailedSources = record.failedJsonSourceDetails ?? [];

    if (detailedSources.length > 0) {
      return [
        {
          zipPath: record.s3Key,
          jsonPaths: detailedSources,
        },
      ];
    }

    if (!record.failedJsonSourceFiles || record.failedJsonSourceFiles.length === 0) return [];

    return [
      {
        zipPath: record.s3Key,
        jsonPaths: record.failedJsonSourceFiles.map((path) => ({
          file: path,
          reason: record.failureReason,
        })),
      },
    ];
  });
}

function getTopJsonPathReason(jsonPaths: FailedSource[]): string | null {
  if (jsonPaths.length === 0) return null;

  const grouped: Record<string, number> = {};
  for (const source of jsonPaths) {
    const reason = source.reason?.trim();
    if (!reason) continue;
    grouped[reason] = (grouped[reason] ?? 0) + 1;
  }

  const entries = Object.entries(grouped);
  if (entries.length === 0) return null;

  const [topReason, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
  if (topCount === 1) return topReason;

  return `${topReason} (${topCount} JSON/HTML files)`;
}

function getProcessingFailedReason(record: FileRecord, jsonPaths: FailedSource[]): string {
  const topJsonReason = getTopJsonPathReason(jsonPaths);
  if (topJsonReason) return topJsonReason;

  if (record.status === "FAILED" || record.status === "DLQ") {
    return record.failureReason;
  }

  if (record.failureReason && record.failureReason !== "No detailed failure reason recorded") {
    return record.failureReason;
  }

  if (
    record.dedupRemovedCount !== null &&
    record.dedupRemovedCount !== undefined &&
    record.dedupRemovedCount > 0
  ) {
    return 'These records contained duplicates of the same "product ID + region + search_keyword + recorded_on" combination and were therefore skipped from the output CSV.';
  }

  return "No explicit processing error recorded. Some ingested products were filtered or dropped before output.";
}

function getTechnicalFailureSources(records: FileRecord[]): FailedProductSource[] {
  return records
    .filter((record) => record.status === "FAILED" || record.status === "DLQ")
    .map((record) => {
      const failedCount = Math.max(0, record.rowCount - record.successCount);
      if (failedCount <= 0) return null;

      const detailedJsonPaths = record.failedJsonSourceDetails ?? [];
      const fallbackJsonPaths = (record.failedJsonSourceFiles ?? []).map((path) => ({
        file: path,
        reason: record.failureReason,
      }));
      const jsonPaths = detailedJsonPaths.length > 0 ? detailedJsonPaths : fallbackJsonPaths;

      return {
        file: record.s3Key,
        failedCount,
        reason: record.failureReason,
        jsonPaths,
      };
    })
    .filter((entry): entry is FailedProductSource => entry !== null)
    .filter((entry) => entry.failedCount > 0)
    .sort((a, b) => b.failedCount - a.failedCount);
}

function getFailedProductSources(records: FileRecord[]): FailedProductSource[] {
  return records
    .map((record) => {
      const failedCount = Math.max(0, record.rowCount - record.successCount);
      if (failedCount <= 0) return null;

      const detailedJsonPaths = record.failedJsonSourceDetails ?? [];
      const fallbackJsonPaths = (record.failedJsonSourceFiles ?? []).map((path) => ({
        file: path,
        reason: record.failureReason,
      }));
      const jsonPaths = detailedJsonPaths.length > 0 ? detailedJsonPaths : fallbackJsonPaths;
      const reason = getProcessingFailedReason(record, jsonPaths);
      const hasDedupRemoved = (record.dedupRemovedCount ?? 0) > 0;

      // Use pre-computed breakdown from DynamoDB only (written by processor at dedup time).
      // Records processed before this field was introduced will simply have no breakdown,
      // avoiding slow S3 CSV reads on every API call.
      const duplicateKeyBreakdown =
        hasDedupRemoved && record.duplicateKeyBreakdown && record.duplicateKeyBreakdown.length > 0
          ? record.duplicateKeyBreakdown
          : undefined;

      return {
        file: record.s3Key,
        failedCount,
        reason,
        jsonPaths,
        ...(duplicateKeyBreakdown ? { duplicateKeyBreakdown } : {}),
      };
    })
    .filter((entry): entry is FailedProductSource => entry !== null)
    .sort((a, b) => b.failedCount - a.failedCount);
}

async function buildCategoryMetrics(
  sourceRecords: FileRecord[],
  zipRecords: FileRecord[],
  options?: {
    readonly includeProcessingFailedSources?: boolean;
    readonly zipBreakdownMode?: "split" | "combined";
    readonly processingSuccessOverride?: ProcessingOverride;
    readonly processingFailedTotalOverride?: number;
    readonly processingFailedSourcesOverride?: FailedProductSource[];
    readonly processingFailedProcessingTotalOverride?: number;
    readonly processingFailedProcessingSourcesOverride?: FailedProductSource[];
    readonly processingDroppedAfterMergingTotalOverride?: number;
    readonly processingDroppedAfterMergingSourcesOverride?: FailedProductSource[];
  },
) {
  const includeProcessingFailedSources = options?.includeProcessingFailedSources ?? true;
  const zipBreakdownMode = options?.zipBreakdownMode ?? "split";
  const processingSuccessOverride = options?.processingSuccessOverride;
  const processingFailedTotalOverride = options?.processingFailedTotalOverride;
  const processingFailedSourcesOverride = options?.processingFailedSourcesOverride;
  const processingFailedProcessingTotalOverride = options?.processingFailedProcessingTotalOverride;
  const processingFailedProcessingSourcesOverride =
    options?.processingFailedProcessingSourcesOverride;
  const processingDroppedAfterMergingTotalOverride =
    options?.processingDroppedAfterMergingTotalOverride;
  const processingDroppedAfterMergingSourcesOverride =
    options?.processingDroppedAfterMergingSourcesOverride;
  const supportedZipRecords = zipRecords.filter((record) => isSupportedVendor(record.vendor));
  const failedZipSources = getFailedSources(supportedZipRecords);
  const failedJsonSources = getFailedJsonSources(sourceRecords);
  const allFailedProductSources = getFailedProductSources(sourceRecords);
  const allTechnicalFailureSources = getTechnicalFailureSources(sourceRecords);
  const zipCountsByPlatform = groupCounts(zipRecords);
  const zipPathsByPlatform = groupPathsByPlatform(zipRecords);
  const shopProductsZipRecords = zipRecords.filter(isShopProducts);
  const pdpZipRecords = zipRecords.filter(isPdp);
  const failedProductSources = processingFailedSourcesOverride
    ? processingFailedSourcesOverride
    : includeProcessingFailedSources
      ? allFailedProductSources
      : [];

  return {
    ingestion: {
      zipFilesTotal: supportedZipRecords.length,
      zipFilesFailed: failedZipSources.length,
      zipFilesFailedSources: failedZipSources,
      ...(zipBreakdownMode === "combined"
        ? {
            zipFilesByPlatform: zipCountsByPlatform,
            zipFilesPathsByPlatform: zipPathsByPlatform,
          }
        : {
            zipFilesShopProductsByPlatform: groupCounts(shopProductsZipRecords),
            zipFilesPdpByPlatform: groupCounts(pdpZipRecords),
            zipFilesShopProductsPathsByPlatform: groupPathsByPlatform(shopProductsZipRecords),
            zipFilesPdpPathsByPlatform: groupPathsByPlatform(pdpZipRecords),
          }),
      jsonFilesTotal: sourceRecords.reduce((sum, r) => sum + getParsedSourceFileCount(r), 0),
      // Keep summary count aligned with the source details list.
      jsonFilesFailed: failedJsonSources.reduce((sum, entry) => sum + entry.jsonPaths.length, 0),
      jsonFilesFailedSources: failedJsonSources,
      jsonFilesByPlatform: groupTotals(sourceRecords, getParsedSourceFileCount),
      jsonFilesByCountry: groupTotalsByCountry(sourceRecords, getParsedSourceFileCount, {
        ignoreUnknown: true,
      }),
      uniqueProductsTotal: sourceRecords.reduce((sum, r) => sum + r.rowCount, 0),
      uniqueProductsByPlatform: groupTotals(sourceRecords),
      uniqueProductsByCountry: groupTotalsByCountry(sourceRecords, (r) => r.rowCount),
    },
    processing: {
      uniqueProductsTotal:
        processingSuccessOverride?.total ??
        sourceRecords.reduce((sum, r) => sum + r.successCount, 0),
      uniqueProductsFailed:
        processingFailedTotalOverride ??
        allFailedProductSources.reduce((sum, entry) => sum + entry.failedCount, 0),
      uniqueProductsFailedSources: failedProductSources,
      uniqueProductsFailedProcessing:
        processingFailedProcessingTotalOverride ??
        allTechnicalFailureSources.reduce((sum, entry) => sum + entry.failedCount, 0),
      uniqueProductsFailedProcessingSources:
        processingFailedProcessingSourcesOverride ?? allTechnicalFailureSources,
      uniqueProductsDroppedAfterMerging: processingDroppedAfterMergingTotalOverride ?? 0,
      uniqueProductsDroppedAfterMergingSources: processingDroppedAfterMergingSourcesOverride ?? [],
      uniqueProductsByPlatform:
        processingSuccessOverride?.byPlatform ?? groupTotals(sourceRecords, (r) => r.successCount),
      uniqueProductsByCountry:
        processingSuccessOverride?.byCountry ??
        groupTotalsByCountry(sourceRecords, (r) => r.successCount),
    },
  };
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

type FeatureKey = "feature1" | "feature2";

function parseDateFromEvent(event: APIGatewayProxyEventV2): string | null {
  const date = event.queryStringParameters?.["date"] ?? new Date().toISOString().split("T")[0]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  return date;
}

async function buildFeature1MetricsPayload(date: string, sourceRecords: FileRecord[]) {
  const otherSource = sourceRecords.filter((r) => !isKeywordProducts(r));
  const otherZip = otherSource.filter((r) => r.s3Key.endsWith(".zip"));

  const consolidationStates = await getConsolidationStatesForDate(date);
  const consolidatedByPlatform = groupConsolidatedOutputByPlatform(consolidationStates);
  const consolidatedByCountry = estimateCountryDistribution(otherSource, consolidatedByPlatform);
  const consolidatedFailedByPlatform = groupConsolidatedFailedByPlatform(consolidationStates);

  const [consolidatedFailedSources, consolidationIssues] = await Promise.all([
    buildConsolidatedFailedSources(consolidationStates, date),
    getConsolidationIssuesForDate(date),
  ]);

  const sourceSuccessByPlatform = groupTotals(otherSource, (r) => r.successCount);
  const mergeDroppedSources = buildMergeDroppedSources(
    sourceSuccessByPlatform,
    consolidatedByPlatform,
    consolidatedFailedByPlatform,
    date,
  );

  const consolidationIssueSources: FailedProductSource[] = consolidationIssues.map((issue) => {
    const [year, month, day] = date.split("-");
    return {
      file: `consolidation/platform=${issue.vendor}/year=${year}/month=${month}/day=${day}`,
      failedCount: sourceSuccessByPlatform[issue.vendor] ?? 0,
      reason: issue.detail,
      jsonPaths: [],
    };
  });

  const consolidationIssueFailedTotal = consolidationIssueSources.reduce(
    (sum, entry) => sum + entry.failedCount,
    0,
  );

  const vendorsWithIssues = new Set(consolidationIssues.map((i) => i.vendor));
  const cleanMergeDroppedSources = mergeDroppedSources.filter(
    (source) =>
      !Array.from(vendorsWithIssues).some((vendor) => source.file.includes(`platform=${vendor}`)),
  );

  const allConsolidationFailedSources = [
    ...consolidatedFailedSources,
    ...consolidationIssueSources,
  ];
  const consolidationFailedTotal = allConsolidationFailedSources.reduce(
    (sum, entry) => sum + entry.failedCount,
    0,
  );
  const cleanMergeDroppedTotal = cleanMergeDroppedSources.reduce(
    (sum, entry) => sum + entry.failedCount,
    0,
  );

  return await buildCategoryMetrics(otherSource, otherZip, {
    includeProcessingFailedSources: false,
    processingSuccessOverride: {
      total: Object.values(consolidatedByPlatform).reduce((sum, n) => sum + n, 0),
      byPlatform: consolidatedByPlatform,
      byCountry: consolidatedByCountry,
    },
    processingFailedTotalOverride: consolidationFailedTotal,
    processingFailedSourcesOverride: allConsolidationFailedSources,
    processingFailedProcessingTotalOverride: consolidationIssueFailedTotal,
    processingFailedProcessingSourcesOverride: consolidationIssueSources,
    processingDroppedAfterMergingTotalOverride: cleanMergeDroppedTotal,
    processingDroppedAfterMergingSourcesOverride: cleanMergeDroppedSources,
  });
}

async function buildFeature2MetricsPayload(sourceRecords: FileRecord[]) {
  const kwSource = sourceRecords.filter(isKeywordProducts);
  const kwZip = kwSource.filter((r) => r.s3Key.endsWith(".zip"));

  return await buildCategoryMetrics(kwSource, kwZip, {
    includeProcessingFailedSources: true,
    zipBreakdownMode: "combined",
  });
}

async function buildMetricsResponse(date: string, feature?: FeatureKey) {
  const records = await getFilesForDate(date);
  const sourceRecords = records.filter(
    (r) => r.s3Key.startsWith("file_type=json/") || r.s3Key.startsWith("file_type=html/"),
  );

  if (feature === "feature1") {
    return {
      date,
      feature1: await buildFeature1MetricsPayload(date, sourceRecords),
    };
  }

  if (feature === "feature2") {
    return {
      date,
      feature2: await buildFeature2MetricsPayload(sourceRecords),
    };
  }

  const [feature1, feature2] = await Promise.all([
    buildFeature1MetricsPayload(date, sourceRecords),
    buildFeature2MetricsPayload(sourceRecords),
  ]);

  return { date, feature1, feature2 };
}

export async function handleGetMetrics(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const date = parseDateFromEvent(event);
  if (!date) {
    return jsonResponse(400, { error: "Invalid date format. Use YYYY-MM-DD." });
  }

  return jsonResponse(200, await buildMetricsResponse(date));
}

export async function handleGetFeature1Metrics(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const date = parseDateFromEvent(event);
  if (!date) {
    return jsonResponse(400, { error: "Invalid date format. Use YYYY-MM-DD." });
  }

  return jsonResponse(200, await buildMetricsResponse(date, "feature1"));
}

export async function handleGetFeature2Metrics(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const date = parseDateFromEvent(event);
  if (!date) {
    return jsonResponse(400, { error: "Invalid date format. Use YYYY-MM-DD." });
  }

  return jsonResponse(200, await buildMetricsResponse(date, "feature2"));
}
