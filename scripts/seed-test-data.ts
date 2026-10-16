/**
 * Seed test data to LocalStack S3
 *
 * Usage:
 *   bun run scripts/seed-test-data.ts           # Upload static test files
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ENDPOINT = process.env.AWS_ENDPOINT_URL || "http://localhost:4566";
const REGION = process.env.AWS_REGION || "ap-southeast-1";
const BUCKET = process.env.INCOMING_BUCKET || "filepipeline-incoming";
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "vn";

const s3Client = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const dynamoClient = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function clearDynamoTable(tableName: string): Promise<void> {
  console.log(`🗑️  Clearing DynamoDB table: ${tableName}`);

  try {
    let itemsDeleted = 0;
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const scanResult = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      if (scanResult.Items && scanResult.Items.length > 0) {
        // Batch delete in chunks of 25 (DynamoDB limit)
        const chunks: any[][] = [];
        for (let i = 0; i < scanResult.Items.length; i += 25) {
          chunks.push(scanResult.Items.slice(i, i + 25));
        }

        for (const chunk of chunks) {
          const deleteRequests = chunk.map((item) => {
            // Determine the key based on table structure
            let key: Record<string, unknown>;
            if (tableName === "filepipeline-files") {
              key = { id: item.id };
            } else {
              key = { batchKey: item.batchKey };
            }

            return {
              DeleteRequest: {
                Key: key,
              },
            };
          });

          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [tableName]: deleteRequests,
              },
            }),
          );

          itemsDeleted += chunk.length;
        }
      }

      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`   ✅ Deleted ${itemsDeleted} items from ${tableName}`);
  } catch (error: any) {
    if (error.name === "ResourceNotFoundException") {
      console.log(`   ⚠️  Table ${tableName} does not exist yet`);
    } else {
      throw error;
    }
  }
}

async function cleanupDynamoData(): Promise<void> {
  console.log("🧹 Cleaning up DynamoDB data...\n");
  await clearDynamoTable("filepipeline-files");
  await clearDynamoTable("filepipeline-vendor-batches");
  console.log();
}

function getDatePath(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

async function uploadFile(
  country: string,
  vendor: string,
  filename: string,
  content: Buffer | string,
): Promise<void> {
  const datePath = getDatePath();
  const key = `${country}/${vendor}/${datePath}/${filename}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: content,
      ContentType: filename.endsWith(".json")
        ? "application/json"
        : filename.endsWith(".zip")
          ? "application/zip"
          : "application/octet-stream",
    }),
  );

  console.log(`✅ Uploaded: s3://${BUCKET}/${key}`);
}

async function uploadObjectByKey(key: string, content: Buffer | string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: content,
      ContentType: key.endsWith(".json")
        ? "application/json"
        : key.endsWith(".zip")
          ? "application/zip"
          : "application/octet-stream",
    }),
  );

  console.log(`✅ Uploaded: s3://${BUCKET}/${key}`);
}

function resolveCountryCode(vendor: string): string {
  const lowerVendor = vendor.toLowerCase();

  if (lowerVendor.includes("shopee")) return "vn";
  if (lowerVendor.includes("lazada")) return "vn";
  if (lowerVendor.includes("tiktok")) return "vn";

  return DEFAULT_COUNTRY_CODE;
}

function collectUploadableFiles(baseDir: string, currentDir: string = baseDir): string[] {
  const entries = readdirSync(currentDir);
  const uploadableFiles: string[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);
    const entryStats = statSync(fullPath);

    if (entryStats.isDirectory()) {
      uploadableFiles.push(...collectUploadableFiles(baseDir, fullPath));
      continue;
    }

    if (entry.endsWith(".json") || entry.endsWith(".zip")) {
      uploadableFiles.push(fullPath);
    }
  }

  return uploadableFiles;
}

async function seedStaticFiles(): Promise<void> {
  console.log("📁 Uploading static test files...\n");

  const testDataDir = join(process.cwd(), "test-data");
  const topLevelDirs = readdirSync(testDataDir);

  for (const dirName of topLevelDirs) {
    const dirPath = join(testDataDir, dirName);
    if (!statSync(dirPath).isDirectory()) continue;

    const files = collectUploadableFiles(dirPath);
    for (const filePath of files) {
      // Read as Buffer for ZIP files, UTF-8 string for JSON
      const isZip = filePath.endsWith(".zip");
      const content = isZip ? readFileSync(filePath) : readFileSync(filePath, "utf-8");

      if (dirName.startsWith("file_type=")) {
        const key = relative(testDataDir, filePath).replaceAll("\\", "/");
        await uploadObjectByKey(key, content);
      } else {
        const filename = basename(filePath);
        await uploadFile(resolveCountryCode(dirName), dirName, filename, content);
      }
    }
  }
}

async function main() {
  console.log("🚀 Seeding test data to LocalStack S3...\n");

  // Clean up existing DynamoDB data
  await cleanupDynamoData();

  await seedStaticFiles();

  console.log("\n✨ Test data seeded successfully!");
  console.log(`\nCheck the dashboard at http://localhost:5173`);
}

await main();
