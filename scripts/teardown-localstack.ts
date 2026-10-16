/**
 * Teardown LocalStack resources for local development.
 *
 * This script:
 * 1. Stops and removes the LocalStack container (docker-compose down)
 * 2. Deletes its persisted state directory, since PERSISTENCE=1 in
 *    docker-compose.yml writes S3/SQS/DynamoDB state to disk — a plain
 *    `docker-compose down` alone does not clear this
 *
 * Usage:
 *   bun run teardown:localstack
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const PERSISTENCE_DIR = join(process.env.TMPDIR ?? "/tmp", "localstack");

function log(message: string) {
  console.log(`\n🗑️  ${message}`);
}

function logSuccess(message: string) {
  console.log(`✅ ${message}`);
}

function logError(message: string) {
  console.error(`❌ ${message}`);
}

async function main() {
  console.log("═".repeat(60));
  console.log("  FilePipeline LocalStack Teardown");
  console.log("═".repeat(60));

  log("Stopping and removing the LocalStack container...");
  const downResult = spawnSync("docker compose down", {
    shell: true,
    cwd: ROOT_DIR,
    stdio: "inherit",
  });

  if (downResult.status !== 0) {
    logError(`docker compose down failed with exit code ${downResult.status}`);
    process.exit(1);
  }
  logSuccess("LocalStack container stopped and removed");

  log(`Removing persisted state at ${PERSISTENCE_DIR}...`);
  if (existsSync(PERSISTENCE_DIR)) {
    rmSync(PERSISTENCE_DIR, { recursive: true, force: true });
    logSuccess(`Deleted ${PERSISTENCE_DIR}`);
  } else {
    logSuccess("No persisted state directory found — nothing to delete");
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Teardown Complete!");
  console.log("═".repeat(60));
  console.log("\n   Next `docker compose up -d` + `bun run setup:localstack` will start clean.");
}

await main().catch((err) => {
  logError(`Teardown failed: ${err.message}`);
  process.exit(1);
});
