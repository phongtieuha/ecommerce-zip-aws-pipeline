import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import * as S3Commands from "@aws-sdk/client-s3";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSBatchResponse, ScheduledEvent } from "aws-lambda";
import type { RegionPlatformMatrixRow } from "./shared";
import {
  asNullableKey,
  createEmptyMatrix,
  formatPercent,
  isMissing,
  normalizePlatform,
  normalizeRegion,
  parseBoolean,
  parseNumber,
} from "./shared";

const AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const DATA_QUALITY_LOCK_TABLE = process.env.DATA_QUALITY_LOCK_TABLE;
const DATA_QUALITY_QUEUE_URL = process.env.DATA_QUALITY_QUEUE_URL;
const DATA_QUALITY_RETRY_DELAY_SECONDS = Number.parseInt(
  process.env.DATA_QUALITY_RETRY_DELAY_SECONDS ?? "180",
  10,
);
const DATA_QUALITY_LOCK_TTL_SECONDS = Number.parseInt(
  process.env.DATA_QUALITY_LOCK_TTL_SECONDS ?? "600",
  10,
);
const TAGGED_OUTPUT_PREFIX = "tagged_output/";
const KEYWORD_PRODUCTS_PREFIX = "output/";
const OUTPUT_PREFIX = "data-quality/";
const OLA_SCRIPT_NAME = "OLA Data Quality";
const OLA_SCRIPT_DESCRIPTION = `
IN_STOCK cannot be NULL
IS_AVAILABLE cannot be NULL
`;
const RATING_REVIEWS_SCRIPT_NAME = "Rating & Reviews Data Quality";
const RATING_REVIEWS_SCRIPT_DESCRIPTION = `
AVG_RATING cannot be NULL
RATING_COUNT cannot be NULL
REVIEW_COUNT cannot be NULL
`;
const SHARE_OF_SEARCH_SCRIPT_NAME = "Share_of_Search_Ranking_Quality";
const SHARE_OF_SEARCH_SCRIPT_DESCRIPTION = `
OVERALL_RANKING cannot be NULL or duplicated for the same search keyword within a region x channel combination
ADS_RANKING and ORGANIC_RANKING cannot be NULL
To give more context on how the ranking logic works:

Each product on a search result page is assigned an OVERALL_RANKING (its actual position on the page), along with an ADS_RANKING and an ORGANIC_RANKING.

If a product is an ad, it will have ADS_RANKING > 0. It occupies a slot on the page (OVERALL_RANKING) but does not advance the ORGANIC_RANKING counter.
If a product is not an ad, it will have ADS_RANKING = 0, and its ORGANIC_RANKING will increment sequentially.
When an ad slot appears between organic products, the ORGANIC_RANKING pauses at its last value and only resumes for the next non-ad product. This means two products can share the same ORGANIC_RANKING value — this is expected behavior, not a data issue.
However, no two products should ever share the same OVERALL_RANKING, as each position on the page can only be occupied by one product. Any duplicate OVERALL_RANKING values for the same search keyword, region, and channel should be flagged and investigated.

LOGIC_ERROR is counted when ADS_RANKING = 0 but ORGANIC_RANKING is NULL for a record.
`;
const PRICE_FEATURE1_SCRIPT_NAME = "Price Competitiveness Quality";
const PRICE_FEATURE2_SCRIPT_NAME = "Price Competitiveness Quality";
const PRICE_SCRIPT_DESCRIPTION = `
We require at least one level of price data to be present per record. Acceptable options are:
+ SKU-level price: SKU_PRICE_BEFORE_DISCOUNT and/or SKU_PRICE_AFTER_DISCOUNT
+ Product-level price: [PRICE_MIN_BEFORE_DISCOUNT and/or PRICE_MIN_AFTER_DISCOUNT]  or  [PRICE_MAX_BEFORE_DISCOUNT and/or  PRICE_MAX_AFTER_DISCOUNT]
Any record where all 6 of these fields are NULL is considered a data quality issue and must be flagged for investigation.
`;
const HTML_PLATFORM_ORDER = [
  "711",
  "JD",
  "LAZADA",
  "MOMOSHOP",
  "REDMART",
  "SHOPEE",
  "TIKTOK SHOP",
  "TMALL",
  "TMALL-SUPERMARKET",
  "WATSONS",
] as const;

const s3 = new S3Client({
  region: AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL),
});

const sqs = new SQSClient({
  region: AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
});

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  }),
);

interface DataQualityEventDetail {
  readonly date?: string;
}

type DataQualityScheduledEvent = Omit<ScheduledEvent<DataQualityEventDetail>, "detail"> & {
  detail?: DataQualityEventDetail;
};

interface DataQualitySource {
  readonly platform: string;
  readonly country: string;
  readonly sourceKey: string;
}

interface DataQualityReportItem {
  readonly script: string;
  readonly description: string;
  readonly date: string;
  readonly sources: DataQualitySource[];
  readonly result: Record<string, unknown>;
}

interface ProductIdPlatformPayload {
  readonly count: number;
  readonly productIdsByRegion: Record<string, string[]>;
}

interface ProductIdTypePayload {
  readonly date: string;
  readonly generatedAt: string;
  readonly type: Feature1ReportGroupKey;
  readonly platforms: Record<string, ProductIdPlatformPayload>;
}

interface ProductIdSummaryFile {
  readonly date: string;
  readonly generatedAt: string;
  readonly feature1: {
    readonly consolidated: Record<string, number | null>;
    readonly "shop-products": Record<string, number | null>;
    readonly "product-skus": Record<string, number | null>;
  };
}

interface ProductIdPlatformFile {
  readonly date: string;
  readonly generatedAt: string;
  readonly type: Feature1ReportGroupKey;
  readonly platform: string;
  readonly count: number;
  readonly productIdsByRegion: Record<string, string[]>;
}

interface ShopIdPlatformPayload {
  readonly count: number;
  readonly shopIdsByRegion: Record<string, string[]>;
}

interface ShopIdTypePayload {
  readonly date: string;
  readonly generatedAt: string;
  readonly type: Feature1ReportGroupKey;
  readonly platforms: Record<string, ShopIdPlatformPayload>;
}

interface ShopIdSummaryFile {
  readonly date: string;
  readonly generatedAt: string;
  readonly feature1: {
    readonly consolidated: Record<string, number | null>;
    readonly "shop-products": Record<string, number | null>;
    readonly "product-skus": Record<string, number | null>;
  };
}

interface ShopIdPlatformFile {
  readonly date: string;
  readonly generatedAt: string;
  readonly type: Feature1ReportGroupKey;
  readonly platform: string;
  readonly count: number;
  readonly shopIdsByRegion: Record<string, string[]>;
}

interface Feature1BuildResult {
  readonly reports: DataQualityReportItem[];
  readonly productIdPayload: ProductIdTypePayload | null;
  readonly shopIdPayload: ShopIdTypePayload | null;
}

type Feature1ReportGroupKey = "consolidated" | "shop-products" | "product-skus";

interface Feature1DataQualityCombinedReport {
  readonly consolidated: DataQualityReportItem[];
  readonly "shop-products": DataQualityReportItem[];
  readonly "product-skus": DataQualityReportItem[];
}

interface DataQualityCombinedReport {
  readonly feature1: Feature1DataQualityCombinedReport;
  readonly feature2: DataQualityReportItem[];
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const FEATURE1_PRICE_FIELDS = [
  "SKU_PRICE_BEFORE_DISCOUNT",
  "SKU_PRICE_AFTER_DISCOUNT",
  "PRICE_MIN_BEFORE_DISCOUNT",
  "PRICE_MIN_AFTER_DISCOUNT",
  "PRICE_MAX_BEFORE_DISCOUNT",
  "PRICE_MAX_AFTER_DISCOUNT",
] as const;

const FEATURE2_PRICE_FIELDS = [
  "PRICE_MIN_BEFORE_DISCOUNT",
  "PRICE_MIN_AFTER_DISCOUNT",
  "PRICE_MAX_BEFORE_DISCOUNT",
  "PRICE_MAX_AFTER_DISCOUNT",
] as const;

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const getPreviousIsoDate = (isoDate: string): string => {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() - 1);
  return toIsoDate(base);
};

const bodyToString = async (body: unknown): Promise<string> => {
  if (!body) {
    throw new Error("S3 object body is empty");
  }

  const maybeBody = body as {
    transformToString?: () => Promise<string>;
    transformToByteArray?: () => Promise<Uint8Array>;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
  };

  if (typeof maybeBody.transformToString === "function") {
    return maybeBody.transformToString();
  }

  if (typeof maybeBody.transformToByteArray === "function") {
    const bytes = await maybeBody.transformToByteArray();
    return Buffer.from(bytes).toString("utf-8");
  }

  if (typeof maybeBody.on === "function") {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      maybeBody.on?.("data", (...args: unknown[]) => {
        const [chunk] = args;
        chunks.push(
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk ?? "")),
        );
      });
      maybeBody.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      maybeBody.on?.("error", reject);
    });
  }

  if (typeof maybeBody[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of maybeBody as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  throw new Error("Unsupported S3 body type");
};

const resolveTargetDate = (event: DataQualityScheduledEvent): string => {
  const overrideDate = event.detail?.date ?? process.env.QUALITY_CHECK_DATE;
  if (overrideDate) {
    if (!datePattern.test(overrideDate)) {
      throw new Error(`Invalid override date: ${overrideDate}`);
    }
    return overrideDate;
  }

  if (event.time && datePattern.test(event.time.slice(0, 10))) {
    return getPreviousIsoDate(event.time.slice(0, 10));
  }

  return getPreviousIsoDate(toIsoDate(new Date()));
};

const buildDateSegment = (date: string): string => {
  const [year, month, day] = date.split("-");
  return `/year=${year}/month=${month}/day=${day}/`;
};

const buildCompactDate = (date: string): string => date.replace(/-/g, "");

const keyMatchesTargetDate = (key: string, date: string): boolean =>
  key.includes(buildDateSegment(date)) ||
  key.includes(date) ||
  key.includes(buildCompactDate(date));

const isTargetConsolidatedCsv = (key: string, date: string): boolean =>
  key.startsWith(TAGGED_OUTPUT_PREFIX) &&
  key.endsWith("/consolidated.csv") &&
  keyMatchesTargetDate(key, date);

const isTargetFeature1OutputCsv = (key: string, date: string): boolean =>
  key.startsWith(KEYWORD_PRODUCTS_PREFIX) &&
  !key.includes("/request_type=keyword-products/") &&
  key.endsWith(".csv") &&
  !key.endsWith("/metrics_processed.csv") &&
  keyMatchesTargetDate(key, date);

const isTargetKeywordProductsCsv = (key: string, date: string): boolean =>
  key.startsWith(KEYWORD_PRODUCTS_PREFIX) &&
  key.includes("/request_type=keyword-products/") &&
  key.endsWith(".csv") &&
  !key.endsWith("/metrics_processed.csv") &&
  keyMatchesTargetDate(key, date);

const extractSourceFromTaggedOutputKey = (key: string): DataQualitySource => {
  const match = key.match(
    /^tagged_output\/platform=([^/]+)\/year=\d{4}\/month=\d{2}\/day=\d{2}\/([^/]+)\/consolidated\.csv$/,
  );

  if (!match) {
    throw new Error(`Unexpected tagged output key format: ${key}`);
  }

  return {
    platform: match[1],
    country: match[2],
    sourceKey: key,
  };
};

const extractSourceFromFeature1OutputKey = (key: string): DataQualitySource => {
  const channel = key.match(/\/channel=([^/]+)\//)?.[1] ?? "UNKNOWN";
  const country =
    key.match(/\/(cn|id|jp|kr|my|ph|sg|th|tw|vn)\//i)?.[1]?.toUpperCase() ?? "UNKNOWN";

  return {
    platform: channel,
    country,
    sourceKey: key,
  };
};

const extractSourceFromFeature1Key = (key: string): DataQualitySource =>
  key.startsWith(TAGGED_OUTPUT_PREFIX)
    ? extractSourceFromTaggedOutputKey(key)
    : extractSourceFromFeature1OutputKey(key);

const getFeature1ReportGroupForKey = (key: string): Feature1ReportGroupKey | null => {
  if (key.startsWith(TAGGED_OUTPUT_PREFIX)) {
    return "consolidated";
  }

  const requestType = key.match(/\/request_type=([^/]+)\//)?.[1]?.toLowerCase();
  if (!requestType) {
    return null;
  }

  if (["shop-products", "catalogue-products", "username-products"].includes(requestType)) {
    return "shop-products";
  }

  if (["product-skus", "product-skus-csapi"].includes(requestType)) {
    return "product-skus";
  }

  return null;
};

const extractSourceFromKeywordProductsKey = (key: string): DataQualitySource => {
  const channel = key.match(/\/channel=([^/]+)\//)?.[1] ?? "UNKNOWN";
  const country =
    key.match(/\/(cn|id|jp|kr|my|ph|sg|th|tw|vn)\//i)?.[1]?.toUpperCase() ?? "UNKNOWN";

  return {
    platform: channel,
    country,
    sourceKey: key,
  };
};

const listKeysForDate = async (
  bucket: string,
  prefix: string,
  keyFilter: (key: string, date: string) => boolean,
  date: string,
): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new S3Commands.ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of response.Contents ?? []) {
      if (!item.Key) {
        continue;
      }

      if (keyFilter(item.Key, date)) {
        keys.push(item.Key);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return [...new Set(keys)].sort((left, right) => left.localeCompare(right));
};

const loadCsvRows = async (bucket: string, key: string): Promise<Record<string, string>[]> => {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  const content = await bodyToString(response.Body);
  const { parse } = await import("csv-parse/sync");

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];

  return records.map((record) => {
    const normalized: Record<string, string> = {};
    for (const [field, value] of Object.entries(record)) {
      normalized[field.trim().toUpperCase()] = value;
    }
    return normalized;
  });
};

const loadCsvRowsSequentially = async (
  bucket: string,
  keys: string[],
): Promise<Record<string, string>[]> => {
  const rows: Record<string, string>[] = [];

  for (const key of keys) {
    const batch = await loadCsvRows(bucket, key);
    for (const row of batch) {
      rows.push(row);
    }
  }

  return rows;
};

const buildReportKey = (date: string): string =>
  `${OUTPUT_PREFIX}${date}_Data Validation Report.json`;

const isSqsEvent = (event: unknown): event is SQSEvent =>
  Array.isArray((event as SQSEvent | undefined)?.Records);

const parseDateFromTaggedOutputKey = (key: string): string | null => {
  const match = key.match(/\/year=(\d{4})\/month=(\d{2})\/day=(\d{2})\//);
  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
};

const parseDateFromOutputKey = (key: string): string | null => {
  const hyphenDate = key.match(/(\d{4}-\d{2}-\d{2})/);
  if (hyphenDate) {
    return hyphenDate[1] ?? null;
  }

  const compactDate = key.match(/(?:^|\D)(\d{8})(?:\D|$)/);
  if (!compactDate) {
    return null;
  }

  const value = compactDate[1] ?? "";
  if (value.length !== 8) {
    return null;
  }

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
};

const isRelevantCsvTriggerKey = (key: string): boolean => {
  if (key.startsWith(OUTPUT_PREFIX)) {
    return false;
  }

  if (key.startsWith(TAGGED_OUTPUT_PREFIX)) {
    return key.endsWith("/consolidated.csv");
  }

  if (!key.startsWith(KEYWORD_PRODUCTS_PREFIX)) {
    return false;
  }

  if (!key.endsWith(".csv")) {
    return false;
  }

  return !key.endsWith("/metrics_processed.csv");
};

const extractReportDateFromKey = (key: string): string | null => {
  const date = key.startsWith(TAGGED_OUTPUT_PREFIX)
    ? parseDateFromTaggedOutputKey(key)
    : parseDateFromOutputKey(key);

  if (!date || !datePattern.test(date)) {
    return null;
  }

  return date;
};

const extractTriggerDatesFromSqsBody = (body: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const records = (parsed as { Records?: unknown[] }).Records;
  if (!Array.isArray(records)) {
    return [];
  }

  const dates = new Set<string>();
  for (const rawRecord of records) {
    const key = (rawRecord as { s3?: { object?: { key?: string } } })?.s3?.object?.key;
    if (!key || typeof key !== "string") {
      continue;
    }

    const decodedKey = decodeURIComponent(key.replaceAll("+", " "));
    if (!isRelevantCsvTriggerKey(decodedKey)) {
      continue;
    }

    const reportDate = extractReportDateFromKey(decodedKey);
    if (!reportDate) {
      continue;
    }

    dates.add(reportDate);
  }

  return [...dates].sort((left, right) => left.localeCompare(right));
};

const buildDateLockKey = (date: string): string => `DQ#${date}`;

const acquireDateLock = async (date: string, owner: string): Promise<boolean> => {
  if (!DATA_QUALITY_LOCK_TABLE) {
    throw new Error("DATA_QUALITY_LOCK_TABLE is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const lockUntil = now + DATA_QUALITY_LOCK_TTL_SECONDS;

  try {
    await ddb.send(
      new PutCommand({
        TableName: DATA_QUALITY_LOCK_TABLE,
        Item: {
          pk: buildDateLockKey(date),
          owner,
          lockUntil,
          updatedAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(pk) OR lockUntil < :now OR #owner = :owner",
        ExpressionAttributeNames: {
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":now": now,
          ":owner": owner,
        },
      }),
    );
    return true;
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
};

const releaseDateLock = async (date: string, owner: string): Promise<void> => {
  if (!DATA_QUALITY_LOCK_TABLE) {
    return;
  }

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: DATA_QUALITY_LOCK_TABLE,
        Key: {
          pk: buildDateLockKey(date),
        },
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":owner": owner,
        },
      }),
    );
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name !== "ConditionalCheckFailedException") {
      throw error;
    }
  }
};

const delayMessageRetry = async (receiptHandle: string): Promise<void> => {
  if (!DATA_QUALITY_QUEUE_URL) {
    return;
  }

  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: DATA_QUALITY_QUEUE_URL,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: DATA_QUALITY_RETRY_DELAY_SECONDS,
    }),
  );
};

const matrixRowsToRegionMap = (
  rows: RegionPlatformMatrixRow[],
): Record<string, Record<string, unknown>> => {
  const result: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    const { REGION, ...vendors } = row;
    result[REGION] = vendors;
  }

  return result;
};

const buildGroupKey = (region: string, platform: string): string => `${region}||${platform}`;

const splitGroupKey = (key: string): [string, string] => {
  const [region, platform] = key.split("||");
  return [region, platform];
};

interface OLAFlags {
  stockNull: boolean;
  availNull: boolean;
  mismatch: boolean;
  valid: boolean;
}

interface RatingFlags {
  avgNull: boolean;
  reviewNull: boolean;
  ratingNull: boolean;
}

const collectRegionsFromGroupSummary = (grouped: Map<string, unknown>): string[] =>
  [...new Set([...grouped.keys()].map((key) => splitGroupKey(key)[0]))].sort();

const buildFeature1OlaNullMatrix = (
  groups: Map<string, Map<string, OLAFlags>>,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const skuFlags = groups.get(buildGroupKey(row.REGION, platform));
      if (!skuFlags || skuFlags.size === 0) {
        row[platform] = "-";
        continue;
      }

      let stockNull = 0;
      let availNull = 0;
      for (const flags of skuFlags.values()) {
        if (flags.stockNull) {
          stockNull += 1;
        }
        if (flags.availNull) {
          availNull += 1;
        }
      }

      row[platform] = {
        STOCK: formatPercent(stockNull / skuFlags.size),
        IS_AVAILABLE: formatPercent(availNull / skuFlags.size),
      };
    }
  }

  return matrix;
};

const buildFeature1OlaMismatchMatrix = (
  groups: Map<string, Map<string, OLAFlags>>,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const skuFlags = groups.get(buildGroupKey(row.REGION, platform));
      if (!skuFlags || skuFlags.size === 0) {
        row[platform] = "-";
        continue;
      }

      let mismatchSku = 0;
      let validSku = 0;
      for (const flags of skuFlags.values()) {
        if (flags.valid) {
          validSku += 1;
        }
        if (flags.mismatch) {
          mismatchSku += 1;
        }
      }

      row[platform] = validSku === 0 ? "0.0%" : formatPercent(mismatchSku / validSku);
    }
  }

  return matrix;
};

const buildFeature1RatingAvgMatrix = (
  groups: Map<string, Map<string, RatingFlags>>,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const skuFlags = groups.get(buildGroupKey(row.REGION, platform));
      if (!skuFlags || skuFlags.size === 0) {
        row[platform] = "-";
        continue;
      }

      let avgNull = 0;
      for (const flags of skuFlags.values()) {
        if (flags.avgNull) {
          avgNull += 1;
        }
      }

      row[platform] = formatPercent(avgNull / skuFlags.size);
    }
  }

  return matrix;
};

const buildFeature1RatingReviewMatrix = (
  groups: Map<string, Map<string, RatingFlags>>,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const skuFlags = groups.get(buildGroupKey(row.REGION, platform));
      if (!skuFlags || skuFlags.size === 0) {
        row[platform] = "-";
        continue;
      }

      let reviewNull = 0;
      let ratingNull = 0;
      for (const flags of skuFlags.values()) {
        if (flags.reviewNull) {
          reviewNull += 1;
        }
        if (flags.ratingNull) {
          ratingNull += 1;
        }
      }

      row[platform] = {
        REVIEW_COUNT: formatPercent(reviewNull / skuFlags.size),
        RATING_COUNT: formatPercent(ratingNull / skuFlags.size),
      };
    }
  }

  return matrix;
};

const buildMissingAllPriceMatrix = (
  groups: Map<string, { totalRows: number; missingAllPriceRows: number }>,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const group = groups.get(buildGroupKey(row.REGION, platform));
      if (!group || group.totalRows === 0) {
        row[platform] = "-";
        continue;
      }

      row[platform] = formatPercent(group.missingAllPriceRows / group.totalRows);
    }
  }

  return matrix;
};

const buildProductIdPayloadPlatforms = (
  groups: Map<string, Map<string, Set<string>>>,
): Record<string, ProductIdPlatformPayload> => {
  const result: Record<string, ProductIdPlatformPayload> = {};

  const toPayload = (regionGroups: Map<string, Set<string>>): ProductIdPlatformPayload => {
    const productIdsByRegion: Record<string, string[]> = {};
    let count = 0;

    for (const region of [...regionGroups.keys()].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const ids = regionGroups.get(region);
      if (!ids || ids.size === 0) {
        continue;
      }

      const sortedIds = [...ids].sort((left, right) => left.localeCompare(right));
      productIdsByRegion[region] = sortedIds;
      count += sortedIds.length;
    }

    return {
      count,
      productIdsByRegion,
    };
  };

  for (const platform of HTML_PLATFORM_ORDER) {
    const regionGroups = groups.get(platform);
    if (regionGroups) {
      result[platform] = toPayload(regionGroups);
    }
  }

  for (const [platform, regionGroups] of groups.entries()) {
    if (platform in result) {
      continue;
    }

    result[platform] = toPayload(regionGroups);
  }

  return result;
};

const buildProductIdFileBaseKey = (date: string): string => `${OUTPUT_PREFIX}${date}_Product_IDs`;

const buildProductIdSummaryKey = (date: string): string =>
  `${OUTPUT_PREFIX}${date}_Product IDs.json`;

const buildLegacyProductIdFileBaseKey = (date: string): string =>
  `${OUTPUT_PREFIX}${date}_Product IDs`;

const buildProductIdManifestKey = (date: string): string =>
  `${buildProductIdFileBaseKey(date)}.json`;

const buildLegacyProductIdManifestKey = (date: string): string =>
  `${buildLegacyProductIdFileBaseKey(date)}.json`;

const toProductIdPlatformFileSegment = (platform: string): string =>
  platform
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "_");

const buildProductIdPayloadKey = (
  date: string,
  type: Feature1ReportGroupKey,
  platform: string,
): string =>
  `${buildProductIdFileBaseKey(date)}/${type}/${toProductIdPlatformFileSegment(platform)}.json`;

const buildLegacyProductIdPayloadKey = (date: string, type: Feature1ReportGroupKey): string =>
  `${buildProductIdFileBaseKey(date)}/${type}.json`;

const buildOldSpaceNamingProductIdPayloadKey = (
  date: string,
  type: Feature1ReportGroupKey,
): string => `${buildLegacyProductIdFileBaseKey(date)}/${type}.json`;

const buildProductIdCountSummary = (
  payloads: Partial<Record<Feature1ReportGroupKey, ProductIdTypePayload>>,
): ProductIdSummaryFile["feature1"] => {
  const getCounts = (group: Feature1ReportGroupKey): Record<string, number | null> => {
    const payload = payloads[group];
    const result: Record<string, number | null> = {};

    for (const platform of HTML_PLATFORM_ORDER) {
      result[platform] = null;
    }

    if (!payload) {
      return result;
    }

    for (const [platform, platformPayload] of Object.entries(payload.platforms)) {
      if (platform in result) {
        result[platform] = platformPayload.count;
      }
    }

    return result;
  };

  return {
    consolidated: getCounts("consolidated"),
    "shop-products": getCounts("shop-products"),
    "product-skus": getCounts("product-skus"),
  };
};

const buildShopIdPayloadPlatforms = (
  groups: Map<string, Map<string, Set<string>>>,
): Record<string, ShopIdPlatformPayload> => {
  const result: Record<string, ShopIdPlatformPayload> = {};

  const toPayload = (regionGroups: Map<string, Set<string>>): ShopIdPlatformPayload => {
    const shopIdsByRegion: Record<string, string[]> = {};
    let count = 0;

    for (const region of [...regionGroups.keys()].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const ids = regionGroups.get(region);
      if (!ids || ids.size === 0) {
        continue;
      }

      const sortedIds = [...ids].sort((left, right) => left.localeCompare(right));
      shopIdsByRegion[region] = sortedIds;
      count += sortedIds.length;
    }

    return {
      count,
      shopIdsByRegion,
    };
  };

  for (const platform of HTML_PLATFORM_ORDER) {
    const regionGroups = groups.get(platform);
    if (regionGroups) {
      result[platform] = toPayload(regionGroups);
    }
  }

  for (const [platform, regionGroups] of groups.entries()) {
    if (platform in result) {
      continue;
    }

    result[platform] = toPayload(regionGroups);
  }

  return result;
};

const buildShopIdFileBaseKey = (date: string): string => `${OUTPUT_PREFIX}${date}_Shop_IDs`;

const buildShopIdSummaryKey = (date: string): string => `${OUTPUT_PREFIX}${date}_Shop IDs.json`;

const buildShopIdPayloadKey = (
  date: string,
  type: Feature1ReportGroupKey,
  platform: string,
): string =>
  `${buildShopIdFileBaseKey(date)}/${type}/${toProductIdPlatformFileSegment(platform)}.json`;

const buildShopIdCountSummary = (
  payloads: Partial<Record<Feature1ReportGroupKey, ShopIdTypePayload>>,
): ShopIdSummaryFile["feature1"] => {
  const getCounts = (group: Feature1ReportGroupKey): Record<string, number | null> => {
    const payload = payloads[group];
    const result: Record<string, number | null> = {};

    for (const platform of HTML_PLATFORM_ORDER) {
      result[platform] = null;
    }

    if (!payload) {
      return result;
    }

    for (const [platform, platformPayload] of Object.entries(payload.platforms)) {
      if (platform in result) {
        result[platform] = platformPayload.count;
      }
    }

    return result;
  };

  return {
    consolidated: getCounts("consolidated"),
    "shop-products": getCounts("shop-products"),
    "product-skus": getCounts("product-skus"),
  };
};

const putJsonObject = async (key: string, body: unknown): Promise<void> => {
  if (!PROCESSED_BUCKET) {
    throw new Error("PROCESSED_BUCKET is not configured for data quality checker Lambda.");
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json",
    }),
  );
};

const deleteJsonObjectIfExists = async (key: string): Promise<void> => {
  if (!PROCESSED_BUCKET) {
    throw new Error("PROCESSED_BUCKET is not configured for data quality checker Lambda.");
  }

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound" || name === "AccessDenied") {
      console.warn("Skipping product-id cleanup delete", {
        key,
        reason: name ?? "unknown",
      });
      return;
    }
    throw error;
  }
};

const deleteObjectsByPrefix = async (prefix: string): Promise<void> => {
  if (!PROCESSED_BUCKET) {
    throw new Error("PROCESSED_BUCKET is not configured for data quality checker Lambda.");
  }

  let continuationToken: string | undefined;

  do {
    let response;
    try {
      response = await s3.send(
        new S3Commands.ListObjectsV2Command({
          Bucket: PROCESSED_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "AccessDenied") {
        console.warn("Skipping product-id cleanup listing", {
          prefix,
          reason: name,
        });
        return;
      }
      throw error;
    }

    for (const item of response.Contents ?? []) {
      if (!item.Key) {
        continue;
      }

      await deleteJsonObjectIfExists(item.Key);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
};

const buildShareNullMatrix = (
  groups: Map<
    string,
    {
      totalRows: number;
      nullOverall: number;
      nullAds: number;
      nullOrg: number;
      dupOverall: number;
      badLogic: number;
    }
  >,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const group = groups.get(buildGroupKey(row.REGION, platform));
      if (!group || group.totalRows === 0) {
        row[platform] = "-";
        continue;
      }

      row[platform] = {
        OVERALL: formatPercent(group.nullOverall / group.totalRows),
        ADS: formatPercent(group.nullAds / group.totalRows),
        ORG: formatPercent(group.nullOrg / group.totalRows),
      };
    }
  }

  return matrix;
};

const buildShareIssueMatrix = (
  groups: Map<
    string,
    {
      totalRows: number;
      nullOverall: number;
      nullAds: number;
      nullOrg: number;
      dupOverall: number;
      badLogic: number;
    }
  >,
): RegionPlatformMatrixRow[] => {
  const regions = collectRegionsFromGroupSummary(groups);
  const matrix = createEmptyMatrix(regions, [...HTML_PLATFORM_ORDER]);

  for (const row of matrix) {
    for (const platform of HTML_PLATFORM_ORDER) {
      const group = groups.get(buildGroupKey(row.REGION, platform));
      if (!group || group.totalRows === 0) {
        row[platform] = "-";
        continue;
      }

      row[platform] = {
        DUP_OVERALL: formatPercent(group.dupOverall / group.totalRows),
        LOGIC_ERROR: formatPercent(group.badLogic / group.totalRows),
      };
    }
  }

  return matrix;
};

const buildFeature1Reports = async (
  targetDate: string,
  reportGroup: Feature1ReportGroupKey,
  keys: string[],
  generatedAt: string,
): Promise<Feature1BuildResult> => {
  if (!PROCESSED_BUCKET) {
    return {
      reports: [],
      productIdPayload: null,
      shopIdPayload: null,
    };
  }

  if (keys.length === 0) {
    return {
      reports: [],
      productIdPayload: {
        date: targetDate,
        generatedAt,
        type: reportGroup,
        platforms: {},
      },
      shopIdPayload: {
        date: targetDate,
        generatedAt,
        type: reportGroup,
        platforms: {},
      },
    };
  }

  const sources = keys.map(extractSourceFromFeature1Key);

  const olaGroups = new Map<string, Map<string, OLAFlags>>();
  const ratingGroups = new Map<string, Map<string, RatingFlags>>();
  const priceFeature1Groups = new Map<string, { totalRows: number; missingAllPriceRows: number }>();
  const uniqueSourceProductIdGroups = new Map<string, Map<string, Set<string>>>();
  const uniqueShopIdGroups = new Map<string, Map<string, Set<string>>>();

  for (const key of keys) {
    const rows = await loadCsvRows(PROCESSED_BUCKET, key);
    for (const row of rows) {
      const region = normalizeRegion(row.REGION);
      const platform = normalizePlatform(row.PLATFORM);
      if (!region || !platform) {
        continue;
      }

      const groupKey = buildGroupKey(region, platform);

      if (!uniqueSourceProductIdGroups.has(platform)) {
        uniqueSourceProductIdGroups.set(platform, new Map<string, Set<string>>());
      }

      const sourceProductId = asNullableKey(row.SOURCE_PRODUCT_ID);
      if (sourceProductId) {
        const regionCode = region.toLowerCase();
        const regionGroups = uniqueSourceProductIdGroups.get(platform);
        if (!regionGroups) {
          continue;
        }

        if (!regionGroups.has(regionCode)) {
          regionGroups.set(regionCode, new Set<string>());
        }

        regionGroups.get(regionCode)?.add(sourceProductId);
      }

      if (!uniqueShopIdGroups.has(platform)) {
        uniqueShopIdGroups.set(platform, new Map<string, Set<string>>());
      }

      const shopId = asNullableKey(row.SHOP_ID);
      if (shopId) {
        const regionCode = region.toLowerCase();
        const shopRegionGroups = uniqueShopIdGroups.get(platform);
        if (!shopRegionGroups) {
          continue;
        }

        if (!shopRegionGroups.has(regionCode)) {
          shopRegionGroups.set(regionCode, new Set<string>());
        }

        shopRegionGroups.get(regionCode)?.add(shopId);
      }

      const skuId = asNullableKey(row.SOURCE_SKU_ID);
      if (skuId) {
        if (!olaGroups.has(groupKey)) {
          olaGroups.set(groupKey, new Map<string, OLAFlags>());
        }
        const olaSkuFlags = olaGroups.get(groupKey);
        if (!olaSkuFlags) {
          continue;
        }

        if (!olaSkuFlags.has(skuId)) {
          olaSkuFlags.set(skuId, {
            stockNull: true,
            availNull: true,
            mismatch: false,
            valid: false,
          });
        }

        const olaFlags = olaSkuFlags.get(skuId);
        if (olaFlags) {
          const stockMissing = isMissing(row.STOCK);
          const availMissing = isMissing(row.IS_AVAILABLE);
          if (!stockMissing) {
            olaFlags.stockNull = false;
          }
          if (!availMissing) {
            olaFlags.availNull = false;
          }

          const stock = parseNumber(row.STOCK);
          const isAvailable = parseBoolean(row.IS_AVAILABLE);
          if (stock !== null && isAvailable !== null) {
            olaFlags.valid = true;
            const mismatch = (isAvailable && stock === 0) || (!isAvailable && stock !== 0);
            if (mismatch) {
              olaFlags.mismatch = true;
            }
          }
        }
      }

      const ratingEntityId =
        asNullableKey(row.SOURCE_SKU_ID) ?? asNullableKey(row.SOURCE_PRODUCT_ID);
      if (ratingEntityId) {
        if (!ratingGroups.has(groupKey)) {
          ratingGroups.set(groupKey, new Map<string, RatingFlags>());
        }
        const ratingSkuFlags = ratingGroups.get(groupKey);
        if (!ratingSkuFlags) {
          continue;
        }

        if (!ratingSkuFlags.has(ratingEntityId)) {
          ratingSkuFlags.set(ratingEntityId, {
            avgNull: true,
            reviewNull: true,
            ratingNull: true,
          });
        }

        const ratingFlags = ratingSkuFlags.get(ratingEntityId);
        if (ratingFlags) {
          if (!isMissing(row.AVG_RATING)) {
            ratingFlags.avgNull = false;
          }
          if (!isMissing(row.REVIEW_COUNT)) {
            ratingFlags.reviewNull = false;
          }
          if (!isMissing(row.RATING_COUNT)) {
            ratingFlags.ratingNull = false;
          }
        }
      }

      if (!priceFeature1Groups.has(groupKey)) {
        priceFeature1Groups.set(groupKey, {
          totalRows: 0,
          missingAllPriceRows: 0,
        });
      }

      const priceGroup = priceFeature1Groups.get(groupKey);
      if (!priceGroup) {
        continue;
      }

      priceGroup.totalRows += 1;
      const missingAllPrice = FEATURE1_PRICE_FIELDS.every((field) => isMissing(row[field]));
      if (missingAllPrice) {
        priceGroup.missingAllPriceRows += 1;
      }
    }
  }

  const productIdPayload: ProductIdTypePayload = {
    date: targetDate,
    generatedAt,
    type: reportGroup,
    platforms: buildProductIdPayloadPlatforms(uniqueSourceProductIdGroups),
  };

  const shopIdPayload: ShopIdTypePayload = {
    date: targetDate,
    generatedAt,
    type: reportGroup,
    platforms: buildShopIdPayloadPlatforms(uniqueShopIdGroups),
  };

  return {
    reports: [
      {
        script: OLA_SCRIPT_NAME,
        description: OLA_SCRIPT_DESCRIPTION.trim(),
        date: targetDate,
        sources,
        result: {
          "Percentage of NULL in STOCK and IS_AVAILABLE": matrixRowsToRegionMap(
            buildFeature1OlaNullMatrix(olaGroups),
          ),
          "Percentage of Mismatch Data between STOCK and IS_AVAILABLE": matrixRowsToRegionMap(
            buildFeature1OlaMismatchMatrix(olaGroups),
          ),
        },
      },
      {
        script: RATING_REVIEWS_SCRIPT_NAME,
        description: RATING_REVIEWS_SCRIPT_DESCRIPTION.trim(),
        date: targetDate,
        sources,
        result: {
          "Percentage of NULL in AVG_RATING": matrixRowsToRegionMap(
            buildFeature1RatingAvgMatrix(ratingGroups),
          ),
          "Percentage of NULL in REVIEW_COUNT and RATING_COUNT": matrixRowsToRegionMap(
            buildFeature1RatingReviewMatrix(ratingGroups),
          ),
        },
      },
      {
        script: PRICE_FEATURE1_SCRIPT_NAME,
        description: PRICE_SCRIPT_DESCRIPTION.trim(),
        date: targetDate,
        sources,
        result: {
          "Percentage of rows with all price fields missing": matrixRowsToRegionMap(
            buildMissingAllPriceMatrix(priceFeature1Groups),
          ),
        },
      },
    ],
    productIdPayload,
    shopIdPayload,
  };
};

const runDataQualityForDate = async (targetDate: string): Promise<void> => {
  if (!PROCESSED_BUCKET) {
    throw new Error("PROCESSED_BUCKET is not configured for data quality checker Lambda.");
  }

  const generatedAt = new Date().toISOString();

  const [taggedOutputFeature1Keys, outputFeature1Keys, feature2Keys] = await Promise.all([
    listKeysForDate(PROCESSED_BUCKET, TAGGED_OUTPUT_PREFIX, isTargetConsolidatedCsv, targetDate),
    listKeysForDate(
      PROCESSED_BUCKET,
      KEYWORD_PRODUCTS_PREFIX,
      isTargetFeature1OutputCsv,
      targetDate,
    ),
    listKeysForDate(
      PROCESSED_BUCKET,
      KEYWORD_PRODUCTS_PREFIX,
      isTargetKeywordProductsCsv,
      targetDate,
    ),
  ]);

  const feature1Keys = [...new Set([...taggedOutputFeature1Keys, ...outputFeature1Keys])].sort(
    (left, right) => left.localeCompare(right),
  );

  if (feature1Keys.length === 0 && feature2Keys.length === 0) {
    throw new Error(`No matching feature1/feature2 CSV files found for date ${targetDate}`);
  }

  const feature1KeysByGroup = new Map<Feature1ReportGroupKey, string[]>();
  for (const key of feature1Keys) {
    const group = getFeature1ReportGroupForKey(key);
    if (!group) {
      continue;
    }

    const groupKeys = feature1KeysByGroup.get(group) ?? [];
    groupKeys.push(key);
    feature1KeysByGroup.set(group, groupKeys);
  }

  let feature1Report: Feature1DataQualityCombinedReport = {
    consolidated: [],
    "shop-products": [],
    "product-skus": [],
  };
  let feature2Report: DataQualityReportItem[] = [];
  const productIdPayloads: Partial<Record<Feature1ReportGroupKey, ProductIdTypePayload>> = {};
  const shopIdPayloads: Partial<Record<Feature1ReportGroupKey, ShopIdTypePayload>> = {};

  if (feature1Keys.length > 0) {
    const consolidatedFeature1 = await buildFeature1Reports(
      targetDate,
      "consolidated",
      feature1KeysByGroup.get("consolidated") ?? [],
      generatedAt,
    );
    const shopProductsFeature1 = await buildFeature1Reports(
      targetDate,
      "shop-products",
      feature1KeysByGroup.get("shop-products") ?? [],
      generatedAt,
    );
    const productSkusFeature1 = await buildFeature1Reports(
      targetDate,
      "product-skus",
      feature1KeysByGroup.get("product-skus") ?? [],
      generatedAt,
    );

    feature1Report = {
      consolidated: consolidatedFeature1.reports,
      "shop-products": shopProductsFeature1.reports,
      "product-skus": productSkusFeature1.reports,
    };

    productIdPayloads.consolidated = consolidatedFeature1.productIdPayload ?? undefined;
    productIdPayloads["shop-products"] = shopProductsFeature1.productIdPayload ?? undefined;
    productIdPayloads["product-skus"] = productSkusFeature1.productIdPayload ?? undefined;

    shopIdPayloads.consolidated = consolidatedFeature1.shopIdPayload ?? undefined;
    shopIdPayloads["shop-products"] = shopProductsFeature1.shopIdPayload ?? undefined;
    shopIdPayloads["product-skus"] = productSkusFeature1.shopIdPayload ?? undefined;

    for (const group of ["consolidated", "shop-products", "product-skus"] as const) {
      const payload = productIdPayloads[group];
      if (payload) {
        await deleteJsonObjectIfExists(buildLegacyProductIdPayloadKey(targetDate, group));
        await deleteJsonObjectIfExists(buildOldSpaceNamingProductIdPayloadKey(targetDate, group));

        for (const [platform, platformPayload] of Object.entries(payload.platforms)) {
          const payloadKey = buildProductIdPayloadKey(targetDate, group, platform);
          const platformFile: ProductIdPlatformFile = {
            date: payload.date,
            generatedAt: payload.generatedAt,
            type: group,
            platform,
            count: platformPayload.count,
            productIdsByRegion: platformPayload.productIdsByRegion,
          };
          await putJsonObject(payloadKey, platformFile);
        }
      }

      const shopPayload = shopIdPayloads[group];
      if (shopPayload) {
        for (const [platform, platformPayload] of Object.entries(shopPayload.platforms)) {
          const payloadKey = buildShopIdPayloadKey(targetDate, group, platform);
          const platformFile: ShopIdPlatformFile = {
            date: shopPayload.date,
            generatedAt: shopPayload.generatedAt,
            type: group,
            platform,
            count: platformPayload.count,
            shopIdsByRegion: platformPayload.shopIdsByRegion,
          };
          await putJsonObject(payloadKey, platformFile);
        }
      }
    }

    await deleteJsonObjectIfExists(buildProductIdManifestKey(targetDate));
    await deleteJsonObjectIfExists(buildLegacyProductIdManifestKey(targetDate));
    await deleteObjectsByPrefix(`${buildLegacyProductIdFileBaseKey(targetDate)}/`);

    const productIdSummary: ProductIdSummaryFile = {
      date: targetDate,
      generatedAt,
      feature1: buildProductIdCountSummary(productIdPayloads),
    };
    await putJsonObject(buildProductIdSummaryKey(targetDate), productIdSummary);

    const shopIdSummary: ShopIdSummaryFile = {
      date: targetDate,
      generatedAt,
      feature1: buildShopIdCountSummary(shopIdPayloads),
    };
    await putJsonObject(buildShopIdSummaryKey(targetDate), shopIdSummary);
  }

  if (feature2Keys.length > 0) {
    const sources = feature2Keys.map(extractSourceFromKeywordProductsKey);

    const duplicateOverallRankings = new Map<string, number>();
    for (const key of feature2Keys) {
      const rows = await loadCsvRows(PROCESSED_BUCKET, key);
      for (const row of rows) {
        const region = normalizeRegion(row.REGION);
        const platform = normalizePlatform(row.PLATFORM);
        const searchKeyword = asNullableKey(row.SEARCH_KEYWORD);
        const overallRanking = asNullableKey(row.OVERALL_RANKING);

        if (!region || !platform || !searchKeyword || !overallRanking) {
          continue;
        }

        const duplicateKey = `${region}||${platform}||${searchKeyword}||${overallRanking}`;
        duplicateOverallRankings.set(
          duplicateKey,
          (duplicateOverallRankings.get(duplicateKey) ?? 0) + 1,
        );
      }
    }

    const shareGroups = new Map<
      string,
      {
        totalRows: number;
        nullOverall: number;
        nullAds: number;
        nullOrg: number;
        dupOverall: number;
        badLogic: number;
      }
    >();
    const priceFeature2Groups = new Map<
      string,
      { totalRows: number; missingAllPriceRows: number }
    >();

    for (const key of feature2Keys) {
      const rows = await loadCsvRows(PROCESSED_BUCKET, key);
      for (const row of rows) {
        const region = normalizeRegion(row.REGION);
        const platform = normalizePlatform(row.PLATFORM);

        if (!region || !platform) {
          continue;
        }

        const groupKey = buildGroupKey(region, platform);

        if (!priceFeature2Groups.has(groupKey)) {
          priceFeature2Groups.set(groupKey, {
            totalRows: 0,
            missingAllPriceRows: 0,
          });
        }
        const priceGroup = priceFeature2Groups.get(groupKey);
        if (!priceGroup) {
          continue;
        }
        priceGroup.totalRows += 1;
        const missingAllPrice = FEATURE2_PRICE_FIELDS.every((field) => isMissing(row[field]));
        if (missingAllPrice) {
          priceGroup.missingAllPriceRows += 1;
        }

        const searchKeyword = asNullableKey(row.SEARCH_KEYWORD);
        if (!searchKeyword) {
          continue;
        }

        if (!shareGroups.has(groupKey)) {
          shareGroups.set(groupKey, {
            totalRows: 0,
            nullOverall: 0,
            nullAds: 0,
            nullOrg: 0,
            dupOverall: 0,
            badLogic: 0,
          });
        }

        const shareGroup = shareGroups.get(groupKey);
        if (!shareGroup) {
          continue;
        }
        shareGroup.totalRows += 1;

        const overallRanking = asNullableKey(row.OVERALL_RANKING);
        const adsRanking = parseNumber(row.ADS_RANKING);
        const organicMissing = isMissing(row.ORGANIC_RANKING);

        if (overallRanking === null) {
          shareGroup.nullOverall += 1;
        }
        if (adsRanking === null) {
          shareGroup.nullAds += 1;
        }
        if (organicMissing) {
          shareGroup.nullOrg += 1;
        }

        if (overallRanking) {
          const duplicateKey = `${region}||${platform}||${searchKeyword}||${overallRanking}`;
          if ((duplicateOverallRankings.get(duplicateKey) ?? 0) > 1) {
            shareGroup.dupOverall += 1;
          }
        }

        if (adsRanking === 0 && organicMissing) {
          shareGroup.badLogic += 1;
        }
      }
    }

    feature2Report = [
      {
        script: SHARE_OF_SEARCH_SCRIPT_NAME,
        description: SHARE_OF_SEARCH_SCRIPT_DESCRIPTION.trim(),
        date: targetDate,
        sources,
        result: {
          "NULL % in Ranking Fields (OVERALL / ADS / ORGANIC)": matrixRowsToRegionMap(
            buildShareNullMatrix(shareGroups),
          ),
          "Critical Issues (Duplicate OVERALL_RANKING & Logic Errors)": matrixRowsToRegionMap(
            buildShareIssueMatrix(shareGroups),
          ),
        },
      },
      {
        script: PRICE_FEATURE2_SCRIPT_NAME,
        description: PRICE_SCRIPT_DESCRIPTION.trim(),
        date: targetDate,
        sources,
        result: {
          "Percentage of rows with all price fields missing": matrixRowsToRegionMap(
            buildMissingAllPriceMatrix(priceFeature2Groups),
          ),
        },
      },
    ];
  }

  const combinedReport: DataQualityCombinedReport = {
    feature1: feature1Report,
    feature2: feature2Report,
  };

  const outputKey = buildReportKey(targetDate);
  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: outputKey,
      Body: JSON.stringify(combinedReport, null, 2),
      ContentType: "application/json",
    }),
  );

  console.log("Data quality checker completed", {
    date: targetDate,
    feature1SourceCount: feature1Keys.length,
    feature2SourceCount: feature2Keys.length,
    outputKey,
  });
};

export async function handler(
  event: DataQualityScheduledEvent | SQSEvent,
): Promise<void | SQSBatchResponse> {
  if (!isSqsEvent(event)) {
    const targetDate = resolveTargetDate(event);
    await runDataQualityForDate(targetDate);
    return;
  }

  const messageDateMap = new Map<string, { receiptHandle: string; dates: string[] }>();
  for (const record of event.Records) {
    const dates = extractTriggerDatesFromSqsBody(record.body);
    if (dates.length === 0) {
      continue;
    }

    messageDateMap.set(record.messageId, {
      receiptHandle: record.receiptHandle,
      dates,
    });
  }

  if (messageDateMap.size === 0) {
    return { batchItemFailures: [] };
  }

  const uniqueDates = [
    ...new Set([...messageDateMap.values()].flatMap((entry) => entry.dates)),
  ].sort((left, right) => left.localeCompare(right));

  const dateRunStatus = new Map<string, "success" | "locked" | "error">();

  for (const date of uniqueDates) {
    const owner = `${date}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const lockAcquired = await acquireDateLock(date, owner);
    if (!lockAcquired) {
      dateRunStatus.set(date, "locked");
      continue;
    }

    try {
      await runDataQualityForDate(date);
      dateRunStatus.set(date, "success");
    } catch (error) {
      dateRunStatus.set(date, "error");
      console.error("Data quality run failed for date", {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await releaseDateLock(date, owner);
    }
  }

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const [messageId, message] of messageDateMap.entries()) {
    const hasLockedDate = message.dates.some((date) => dateRunStatus.get(date) === "locked");
    const hasErroredDate = message.dates.some((date) => dateRunStatus.get(date) === "error");

    if (!hasLockedDate && !hasErroredDate) {
      continue;
    }

    if (hasLockedDate) {
      try {
        await delayMessageRetry(message.receiptHandle);
      } catch (error) {
        console.warn("Failed to set delayed retry visibility for message", {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    batchItemFailures.push({ itemIdentifier: messageId });
  }

  return { batchItemFailures };
}
