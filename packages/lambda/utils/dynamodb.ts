import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  FileRecord,
  FileRecordCreate,
  FileRecordUpdate,
  FileStatus,
  VendorBatch,
} from "@filepipeline/shared";

// Validate required environment variables
const AWS_REGION = process.env.AWS_REGION;
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE;

if (!AWS_REGION) throw new Error("AWS_REGION environment variable is required");
if (!DYNAMODB_TABLE) throw new Error("DYNAMODB_TABLE environment variable is required");

const client = new DynamoDBClient({
  region: AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // Prevent runtime failures when nested optional fields are undefined.
    removeUndefinedValues: true,
  },
});
const TABLE_NAME = DYNAMODB_TABLE;

export async function createFileRecord(record: FileRecordCreate): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...record,
        parsedFileCount: 0,
        rowCount: 0,
        successCount: 0,
        errorCount: 0,
        errors: [],
      },
    }),
  );
}

export async function getFileRecord(id: string): Promise<FileRecord | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { id },
    }),
  );
  return (result.Item as FileRecord) || null;
}

export async function updateFileRecord(id: string, updates: FileRecordUpdate): Promise<void> {
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      updateExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    }
  });

  if (updateExpressions.length === 0) return;

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }),
  );
}

export async function updateFileStatus(
  id: string,
  status: FileStatus,
  additionalUpdates: Partial<FileRecordUpdate> = {},
): Promise<void> {
  await updateFileRecord(id, {
    status,
    updatedAt: new Date().toISOString(),
    ...additionalUpdates,
  });
}

export async function getFileByS3Key(s3Key: string): Promise<FileRecord | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "s3Key-index",
      KeyConditionExpression: "#s3Key = :s3Key",
      ExpressionAttributeNames: { "#s3Key": "s3Key" },
      ExpressionAttributeValues: { ":s3Key": s3Key },
    }),
  );

  const items = (result.Items as FileRecord[] | undefined) ?? [];
  if (items.length === 0) return null;

  // If multiple records exist for the same key, use the latest run.
  items.sort((a, b) => {
    const timeA = Date.parse(a.createdAt || "") || 0;
    const timeB = Date.parse(b.createdAt || "") || 0;
    return timeB - timeA;
  });

  return items[0] || null;
}

const VENDOR_BATCH_TABLE = "filepipeline-vendor-batches";

function getFilenameStem(filename?: string): string {
  if (!filename) return "";
  const leaf = filename.split("/").pop() || filename;
  return leaf.replace(/\.[^.]+$/, "");
}

function getBatchKey(vendor: string, date: string, country: string = "", runId?: string): string {
  const run = runId?.trim();
  if (country) {
    return run ? `${country}#${vendor}#${date}#${run}` : `${country}#${vendor}#${date}`;
  }
  return run ? `${vendor}#${date}#${run}` : `${vendor}#${date}`;
}

export async function getOrCreateVendorBatch(
  vendor: string,
  date: string,
  country: string = "",
  runId?: string,
): Promise<VendorBatch> {
  const batchKey = getBatchKey(vendor, date, country, runId);
  const existing = await docClient.send(
    new GetCommand({
      TableName: VENDOR_BATCH_TABLE,
      Key: { batchKey },
    }),
  );

  if (existing.Item) {
    return existing.Item as VendorBatch;
  }

  const newBatch: VendorBatch = {
    batchKey,
    vendor,
    date,
    rows: [],
    fileCount: 0,
    successRowCount: 0,
    errorRowCount: 0,
    isConsolidated: false,
    lastUpdatedAt: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: VENDOR_BATCH_TABLE,
      Item: newBatch,
    }),
  );

  return newBatch;
}

export async function appendToVendorBatch(
  vendor: string,
  date: string,
  rows: Array<Record<string, unknown>>,
  successCount: number,
  errorCount: number,
  country: string = "",
  runId?: string,
  filename?: string,
): Promise<void> {
  const batchKey = getBatchKey(vendor, date, country, runId);

  // Get existing batch or create new one
  const batch = await getOrCreateVendorBatch(vendor, date, country, runId);

  const updatedFileCount = batch.fileCount + 1;
  const updatedSuccessCount = batch.successRowCount + successCount;
  const updatedErrorCount = batch.errorRowCount + errorCount;

  // Derive the filename stem (strip extension) to use as the output name
  const filenameStem = getFilenameStem(filename);

  await docClient.send(
    new UpdateCommand({
      TableName: VENDOR_BATCH_TABLE,
      Key: { batchKey },
      UpdateExpression:
        "SET fileCount = :fileCount, successRowCount = :successRowCount, errorRowCount = :errorRowCount, lastUpdatedAt = :lastUpdatedAt, sourceFilename = if_not_exists(sourceFilename, :sourceFilename), runId = if_not_exists(runId, :runId)",
      ExpressionAttributeValues: {
        ":fileCount": updatedFileCount,
        ":successRowCount": updatedSuccessCount,
        ":errorRowCount": updatedErrorCount,
        ":lastUpdatedAt": new Date().toISOString(),
        ":sourceFilename": filenameStem || vendor,
        ":runId": runId || "",
      },
    }),
  );
}

export async function getVendorBatch(vendor: string, date: string): Promise<VendorBatch | null> {
  const batchKey = getBatchKey(vendor, date);
  const result = await docClient.send(
    new GetCommand({
      TableName: VENDOR_BATCH_TABLE,
      Key: { batchKey },
    }),
  );
  return (result.Item as VendorBatch) || null;
}

export async function getVendorBatchByCountry(
  vendor: string,
  date: string,
  country: string,
  runId?: string,
): Promise<VendorBatch | null> {
  const batchKey = getBatchKey(vendor, date, country, runId);
  const result = await docClient.send(
    new GetCommand({
      TableName: VENDOR_BATCH_TABLE,
      Key: { batchKey },
    }),
  );
  return (result.Item as VendorBatch) || null;
}

export async function markVendorBatchConsolidated(
  vendor: string,
  date: string,
  consolidatedOutputKey: string,
  country: string = "",
  runId?: string,
): Promise<void> {
  const batchKey = getBatchKey(vendor, date, country, runId);
  await docClient.send(
    new UpdateCommand({
      TableName: VENDOR_BATCH_TABLE,
      Key: { batchKey },
      UpdateExpression:
        "SET isConsolidated = :true, consolidatedOutputKey = :outputKey, lastUpdatedAt = :timestamp",
      ExpressionAttributeValues: {
        ":true": true,
        ":outputKey": consolidatedOutputKey,
        ":timestamp": new Date().toISOString(),
      },
    }),
  );
}

export async function resetVendorBatch(
  vendor: string,
  date: string,
  country: string = "",
  runId?: string,
): Promise<void> {
  const batchKey = getBatchKey(vendor, date, country, runId);
  await docClient
    .send(
      new UpdateCommand({
        TableName: VENDOR_BATCH_TABLE,
        Key: { batchKey },
        UpdateExpression:
          "SET isConsolidated = :false, lastUpdatedAt = :timestamp REMOVE consolidatedOutputKey",
        ExpressionAttributeValues: {
          ":false": false,
          ":timestamp": new Date().toISOString(),
        },
        ConditionExpression: "attribute_exists(batchKey)",
      }),
    )
    .catch(() => {
      // Batch record may not exist yet for this runId — safe to ignore
    });
}

export async function countProcessingFiles(
  vendor: string,
  date: string,
  country: string = "",
): Promise<number> {
  // Query for QUEUED files
  const queuedResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "vendor-status-index",
      KeyConditionExpression: "vendor = :vendor AND #status = :queued",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":vendor": vendor,
        ":queued": "QUEUED",
      },
    }),
  );

  // Query for PROCESSING files
  const processingResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "vendor-status-index",
      KeyConditionExpression: "vendor = :vendor AND #status = :processing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":vendor": vendor,
        ":processing": "PROCESSING",
      },
    }),
  );

  // Combine and filter by date
  const allPendingFiles = [
    ...(queuedResult.Items as FileRecord[]),
    ...(processingResult.Items as FileRecord[]),
  ];
  const filesThisDate = allPendingFiles.filter((item) => {
    if (!item.createdAt.startsWith(date)) return false;
    if (!country) return true;
    return item.s3Key.startsWith(`${country}/${vendor}/`);
  });

  return filesThisDate.length;
}
