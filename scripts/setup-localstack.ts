/**
 * Setup LocalStack resources for local development
 * Run: bun run scripts/setup-localstack.ts
 */

import {
  S3Client,
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
} from "@aws-sdk/client-s3";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const ENDPOINT = "http://localhost:4566";
const REGION = "ap-southeast-1";
const INCOMING_BUCKET = process.env.INCOMING_BUCKET || "filepipeline-incoming";
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET || "filepipeline-processed";
const PROCESSING_DLQ_NAME = "filepipeline-dlq";
const PROCESSING_QUEUE_NAME = "filepipeline-queue";
const DATA_QUALITY_LOCK_TABLE =
  process.env.DATA_QUALITY_LOCK_TABLE || "filepipeline-data-quality-locks";
const CONSOLIDATION_TABLE = process.env.CONSOLIDATION_TABLE || "filepipeline-consolidation";
const ZIP_CHECK_DLQ_NAME = "filepipeline-zip-check-dlq";
const ZIP_CHECK_QUEUE_NAME = "filepipeline-zip-check-delay";

const s3Client = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const sqsClient = new SQSClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const dynamoClient = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function createBuckets() {
  const buckets = [INCOMING_BUCKET, PROCESSED_BUCKET];

  for (const bucket of buckets) {
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`✅ Created bucket: ${bucket}`);
    } catch (error: any) {
      if (error.name === "BucketAlreadyOwnedByYou" || error.name === "BucketAlreadyExists") {
        console.log(`ℹ️  Bucket already exists: ${bucket}`);
      } else {
        console.error(`❌ Failed to create bucket ${bucket}:`, error.message);
      }
    }
  }
}

async function createQueues() {
  const ensureQueue = async (
    queueName: string,
    attributes: Record<string, string>,
  ): Promise<{ queueUrl: string; queueArn: string }> => {
    try {
      const result = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: attributes,
        }),
      );
      console.log(`✅ Created queue: ${queueName}`);

      const queueUrl =
        result.QueueUrl ||
        `http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000/${queueName}`;
      const queueAttrs = await sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );

      return {
        queueUrl,
        queueArn: queueAttrs.Attributes?.QueueArn || "",
      };
    } catch (error: any) {
      if (error.name === "QueueNameExists" || error.name === "QueueAlreadyExists") {
        console.log(`ℹ️  Queue already exists: ${queueName}`);
        const queueUrl = `http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000/${queueName}`;
        const queueAttrs = await sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["QueueArn"],
          }),
        );

        return {
          queueUrl,
          queueArn: queueAttrs.Attributes?.QueueArn || "",
        };
      }

      console.error(`❌ Failed to create queue ${queueName}:`, error.message);
      throw error;
    }
  };

  const processingDlq = await ensureQueue(PROCESSING_DLQ_NAME, {
    MessageRetentionPeriod: "1209600",
  });

  await ensureQueue(PROCESSING_QUEUE_NAME, {
    VisibilityTimeout: "360",
    MessageRetentionPeriod: "86400",
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: processingDlq.queueArn,
      maxReceiveCount: 2, // Must match prod CDK (packages/infra/lib/filepipeline-stack.ts)
    }),
  });

  const zipCheckDlq = await ensureQueue(ZIP_CHECK_DLQ_NAME, {
    MessageRetentionPeriod: "1209600",
  });

  await ensureQueue(ZIP_CHECK_QUEUE_NAME, {
    VisibilityTimeout: "60",
    MessageRetentionPeriod: "86400",
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: zipCheckDlq.queueArn,
      maxReceiveCount: 2, // Must match prod CDK (packages/infra/lib/filepipeline-stack.ts)
    }),
  });
}

async function createDynamoTable() {
  try {
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: "filepipeline-files",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "vendor", AttributeType: "S" },
          { AttributeName: "status", AttributeType: "S" },
          { AttributeName: "createdAt", AttributeType: "S" },
          { AttributeName: "s3Key", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "vendor-status-index",
            KeySchema: [
              { AttributeName: "vendor", KeyType: "HASH" },
              { AttributeName: "status", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
          {
            IndexName: "status-createdAt-index",
            KeySchema: [
              { AttributeName: "status", KeyType: "HASH" },
              { AttributeName: "createdAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
          {
            IndexName: "s3Key-index",
            KeySchema: [{ AttributeName: "s3Key", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    console.log(`✅ Created DynamoDB table: filepipeline-files`);
  } catch (error: any) {
    if (error.name === "ResourceInUseException") {
      console.log(`ℹ️  DynamoDB table already exists: filepipeline-files`);
    } else {
      console.error(`❌ Failed to create DynamoDB table:`, error.message);
    }
  }
}

async function createVendorBatchTable() {
  try {
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: "filepipeline-vendor-batches",
        KeySchema: [{ AttributeName: "batchKey", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "batchKey", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    console.log(`✅ Created DynamoDB table: filepipeline-vendor-batches`);
  } catch (error: any) {
    if (error.name === "ResourceInUseException") {
      console.log(`ℹ️  DynamoDB table already exists: filepipeline-vendor-batches`);
    } else {
      console.error(`❌ Failed to create DynamoDB table:`, error.message);
    }
  }
}

async function createDataQualityLockTable() {
  try {
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: DATA_QUALITY_LOCK_TABLE,
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    console.log(`✅ Created DynamoDB table: ${DATA_QUALITY_LOCK_TABLE}`);
  } catch (error: any) {
    if (error.name === "ResourceInUseException") {
      console.log(`ℹ️  DynamoDB table already exists: ${DATA_QUALITY_LOCK_TABLE}`);
    } else {
      console.error(
        `❌ Failed to create DynamoDB table ${DATA_QUALITY_LOCK_TABLE}:`,
        error.message,
      );
    }
  }
}

async function createConsolidationTable() {
  try {
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: CONSOLIDATION_TABLE,
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    console.log(`✅ Created DynamoDB table: ${CONSOLIDATION_TABLE}`);
  } catch (error: any) {
    if (error.name === "ResourceInUseException") {
      console.log(`ℹ️  DynamoDB table already exists: ${CONSOLIDATION_TABLE}`);
    } else {
      console.error(`❌ Failed to create DynamoDB table ${CONSOLIDATION_TABLE}:`, error.message);
    }
  }
}

async function configureS3Notifications() {
  const processingQueueArn = `arn:aws:sqs:${REGION}:000000000000:${PROCESSING_QUEUE_NAME}`;

  try {
    await s3Client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: INCOMING_BUCKET,
        NotificationConfiguration: {
          QueueConfigurations: [
            {
              QueueArn: processingQueueArn,
              Events: ["s3:ObjectCreated:*"],
              Filter: {
                Key: {
                  FilterRules: [{ Name: "suffix", Value: ".zip" }],
                },
              },
            },
            {
              QueueArn: processingQueueArn,
              Events: ["s3:ObjectCreated:*"],
              Filter: {
                Key: {
                  FilterRules: [{ Name: "suffix", Value: ".json" }],
                },
              },
            },
          ],
        },
      }),
    );
    console.log(`✅ Configured S3 notifications for ${INCOMING_BUCKET}`);
  } catch (error: any) {
    console.error(`❌ Failed to configure S3 notifications:`, error.message);
  }
}

async function main() {
  console.log("🚀 Setting up LocalStack resources...\n");

  // Wait for LocalStack to be ready
  console.log("Waiting for LocalStack to be ready...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  await createBuckets();
  await createQueues();
  await createDynamoTable();
  await createVendorBatchTable();
  await createDataQualityLockTable();
  await createConsolidationTable();
  await configureS3Notifications();

  console.log("\n✨ LocalStack setup complete!");
  console.log("\nResources created:");
  console.log(`  - S3: ${INCOMING_BUCKET}, ${PROCESSED_BUCKET}`);
  console.log(
    `  - SQS: ${PROCESSING_QUEUE_NAME}, ${PROCESSING_DLQ_NAME}, ${ZIP_CHECK_QUEUE_NAME}, ${ZIP_CHECK_DLQ_NAME}`,
  );
  console.log(
    `  - DynamoDB: filepipeline-files, filepipeline-vendor-batches, ${DATA_QUALITY_LOCK_TABLE}, ${CONSOLIDATION_TABLE}`,
  );
  console.log("\nYou can now run:");
  console.log("  bun run dev:lambda        # Start Lambda processor");
  console.log("  bun run dev:coordinator   # Start Coordinator (regional consolidation)");
  console.log("  bun run dev:zip-checker   # Start ZIP output checker");
  console.log("  bun run dev:data-quality  # Start data quality checker");
}

await main();
