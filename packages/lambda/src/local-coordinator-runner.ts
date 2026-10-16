/**
 * Local Lambda runner for coordinator development.
 * Polls the processed bucket for new output/*.csv objects and invokes the coordinator
 * handler directly. In production the coordinator is triggered by an S3 event
 * notification on the processed bucket (prefix "output/", suffix ".csv") — LocalStack
 * setup does not wire that notification up, so this runner polls instead.
 */

import type { Context, S3Event } from "aws-lambda";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { handler as coordinatorHandler } from "./coordinator";
import { acquireRunnerLock } from "./local-runner-lock";

const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

if (!PROCESSED_BUCKET) throw new Error("PROCESSED_BUCKET environment variable is required");
if (!AWS_REGION) throw new Error("AWS_REGION environment variable is required");
if (!AWS_ENDPOINT_URL) throw new Error("AWS_ENDPOINT_URL environment variable is required");

const POLL_INTERVAL = 5000; // 5 seconds
const RUNNER_LOCK_PATH = "/tmp/filepipeline-local-coordinator-runner.lock";
const SEEN_KEYS_PATH = "/tmp/filepipeline-local-coordinator-seen.json";

const s3Client = new S3Client({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL,
  forcePathStyle: true,
});

function loadSeenKeys(): Set<string> {
  if (!existsSync(SEEN_KEYS_PATH)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(SEEN_KEYS_PATH, "utf-8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveSeenKeys(seen: Set<string>): void {
  writeFileSync(SEEN_KEYS_PATH, JSON.stringify([...seen]), "utf-8");
}

function buildS3Event(bucket: string, key: string): S3Event {
  return {
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: AWS_REGION!,
        eventTime: new Date().toISOString(),
        eventName: "ObjectCreated:Put",
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "local-coordinator-runner",
          bucket: {
            name: bucket,
            ownerIdentity: { principalId: "local" },
            arn: `arn:aws:s3:::${bucket}`,
          },
          object: { key: encodeURIComponent(key), size: 0, eTag: "", sequencer: "" },
        },
      } as unknown as S3Event["Records"][number],
    ],
  };
}

async function pollForNewOutputFiles(seen: Set<string>): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: PROCESSED_BUCKET,
        Prefix: "output/",
        ContinuationToken: continuationToken,
      }),
    );
    continuationToken = response.NextContinuationToken;

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key || !key.endsWith(".csv") || seen.has(key)) continue;

      console.log(`New output CSV detected: ${key}`);

      try {
        await coordinatorHandler(buildS3Event(PROCESSED_BUCKET!, key), {} as Context, () => {});
        console.log(`Coordinator processed: ${key}`);
      } catch (error) {
        console.error(
          `Coordinator failed for ${key}:`,
          error instanceof Error ? error.message : error,
        );
      }

      seen.add(key);
      saveSeenKeys(seen);
    }
  } while (continuationToken);
}

async function main(): Promise<void> {
  acquireRunnerLock(RUNNER_LOCK_PATH);

  console.log("Starting local Coordinator runner...");
  console.log(`Watching: s3://${PROCESSED_BUCKET}/output/`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  const seen = loadSeenKeys();

  while (true) {
    try {
      await pollForNewOutputFiles(seen);
    } catch (error) {
      console.error("Error polling for output files:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

await main();
