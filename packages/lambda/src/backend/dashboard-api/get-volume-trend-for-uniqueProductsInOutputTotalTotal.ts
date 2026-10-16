import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({ region: "ap-southeast-1" });
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE;
const CONSOLIDATION_TABLE = process.env.CONSOLIDATION_TABLE;

interface FileRecord {
  readonly s3Key: string;
  readonly successCount: number;
  readonly createdAt: string;
}

interface VolumeTrendPoint {
  readonly date: string;
  readonly value: number;
}

interface VolumeTrendTab {
  readonly key: string;
  readonly label: string;
  readonly data: VolumeTrendPoint[];
}

interface TrendMetrics {
  uniqueProductsInOutputTotalTotal: number;
}

interface ConsolidationStateRecord {
  readonly date: string;
  readonly outputRowCountTotal: number;
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateRange(
  startDate?: string,
  endDate?: string,
): { dates: string[]; startDate: string; endDate: string } | null {
  if (!startDate || !endDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return null;

  const dates: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return {
    dates,
    startDate,
    endDate,
  };
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

function toFileRecord(item: Record<string, AttributeValue>): FileRecord | null {
  const s3Key = getStringAttr(item, "s3Key");
  const createdAt = getStringAttr(item, "createdAt");

  if (!s3Key || !createdAt) return null;

  return {
    s3Key,
    successCount: getNumberAttr(item, "successCount") ?? 0,
    createdAt,
  };
}

function toConsolidationStateRecord(
  item: Record<string, AttributeValue>,
): ConsolidationStateRecord | null {
  const pk = getStringAttr(item, "pk");
  const outputRowCountTotal = getNumberAttr(item, "outputRowCountTotal");
  if (!pk || outputRowCountTotal === null) return null;

  const [, date] = pk.split("#");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  return {
    date,
    outputRowCountTotal,
  };
}

async function getFilesForDateRange(startDate: string, endDate: string): Promise<FileRecord[]> {
  if (!DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is not configured.");
  }

  const startDateTime = `${startDate}T00:00:00.000Z`;
  const endDateTime = `${endDate}T23:59:59.999Z`;

  const records: FileRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamodb.send(
      new ScanCommand({
        TableName: DYNAMODB_TABLE,
        ProjectionExpression: "#s3Key, #successCount, #createdAt",
        FilterExpression: "#createdAt BETWEEN :startDateTime AND :endDateTime",
        ExpressionAttributeNames: {
          "#s3Key": "s3Key",
          "#successCount": "successCount",
          "#createdAt": "createdAt",
        },
        ExpressionAttributeValues: {
          ":startDateTime": { S: startDateTime },
          ":endDateTime": { S: endDateTime },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const record = toFileRecord(item);
      if (record) records.push(record);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return records;
}

async function getConsolidationStatesForDateRange(
  startDate: string,
  endDate: string,
): Promise<ConsolidationStateRecord[]> {
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
        FilterExpression: "#sk = :state",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#outputRowCountTotal": "outputRowCountTotal",
        },
        ExpressionAttributeValues: {
          ":state": { S: "state" },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const record = toConsolidationStateRecord(item);
      if (!record) continue;
      if (record.date < startDate || record.date > endDate) continue;
      records.push(record);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return records;
}

function groupConsolidatedOutputByDate(
  records: ConsolidationStateRecord[],
  dates: string[],
): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const date of dates) {
    grouped[date] = 0;
  }

  for (const record of records) {
    if (!(record.date in grouped)) continue;
    grouped[record.date] += record.outputRowCountTotal;
  }

  return grouped;
}

function isSourceRecord(record: FileRecord): boolean {
  return record.s3Key.startsWith("file_type=json/") || record.s3Key.startsWith("file_type=html/");
}

function extractRequestType(s3Key: string): string {
  const match = s3Key.match(/request_type=([^/]+)/);
  return match?.[1] ?? "unknown";
}

function isKeywordProducts(record: FileRecord): boolean {
  return extractRequestType(record.s3Key) === "keyword-products";
}

function toDateOnly(isoDateTime: string): string {
  return isoDateTime.slice(0, 10);
}

function initializeMetricsByDate(dates: string[]): Record<string, TrendMetrics> {
  const metrics: Record<string, TrendMetrics> = {};

  for (const date of dates) {
    metrics[date] = {
      uniqueProductsInOutputTotalTotal: 0,
    };
  }

  return metrics;
}

function buildMetricsByDate(
  records: FileRecord[],
  dates: string[],
  options?: { readonly outputTotalsByDate?: Record<string, number> },
): Record<string, TrendMetrics> {
  const metricsByDate = initializeMetricsByDate(dates);

  for (const record of records) {
    const date = toDateOnly(record.createdAt);
    const metrics = metricsByDate[date];
    if (!metrics) continue;

    metrics.uniqueProductsInOutputTotalTotal += record.successCount;
  }

  const outputTotalsByDate = options?.outputTotalsByDate;
  if (outputTotalsByDate) {
    for (const date of dates) {
      metricsByDate[date]!.uniqueProductsInOutputTotalTotal = outputTotalsByDate[date] ?? 0;
    }
  }

  return metricsByDate;
}

function buildSingleMetricResponse(
  metricsByDate: Record<string, TrendMetrics>,
  dates: string[],
): VolumeTrendTab {
  return {
    key: "uniqueProductsInOutputTotalTotal",
    label: "Unique Products in Output (Total)",
    data: dates.map((date) => ({
      date,
      value: metricsByDate[date]?.uniqueProductsInOutputTotalTotal ?? 0,
    })),
  };
}

export async function handleGetFeature1UniqueProductsInOutputTotalTotal(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const dateRange = parseDateRange(
    event.queryStringParameters?.["startDate"],
    event.queryStringParameters?.["endDate"],
  );

  if (!dateRange) {
    return jsonResponse(400, {
      error: "Invalid date range. Use startDate and endDate in YYYY-MM-DD format.",
    });
  }

  const { dates, startDate, endDate } = dateRange;
  const records = await getFilesForDateRange(startDate, endDate);
  const sourceRecords = records.filter(isSourceRecord);
  const consolidationStateRecords = await getConsolidationStatesForDateRange(startDate, endDate);
  const consolidatedOutputByDate = groupConsolidatedOutputByDate(consolidationStateRecords, dates);
  const feature1SourceRecords = sourceRecords.filter((record) => !isKeywordProducts(record));
  const feature1MetricsByDate = buildMetricsByDate(feature1SourceRecords, dates, {
    outputTotalsByDate: consolidatedOutputByDate,
  });

  const response = buildSingleMetricResponse(feature1MetricsByDate, dates);
  return jsonResponse(200, response as unknown as Record<string, unknown>);
}

export async function handleGetFeature2UniqueProductsInOutputTotalTotal(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const dateRange = parseDateRange(
    event.queryStringParameters?.["startDate"],
    event.queryStringParameters?.["endDate"],
  );

  if (!dateRange) {
    return jsonResponse(400, {
      error: "Invalid date range. Use startDate and endDate in YYYY-MM-DD format.",
    });
  }

  const { dates, startDate, endDate } = dateRange;
  const records = await getFilesForDateRange(startDate, endDate);
  const sourceRecords = records.filter(isSourceRecord);
  const feature2SourceRecords = sourceRecords.filter(isKeywordProducts);
  const feature2MetricsByDate = buildMetricsByDate(feature2SourceRecords, dates);

  const response = buildSingleMetricResponse(feature2MetricsByDate, dates);
  return jsonResponse(200, response as unknown as Record<string, unknown>);
}
