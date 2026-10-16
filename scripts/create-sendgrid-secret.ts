/**
 * Create or update the SendGrid API key secret in AWS Secrets Manager.
 *
 * Usage:
 *   bun run scripts/create-sendgrid-secret.ts <secret>
 */
import { spawnSync } from "node:child_process";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";

const REGION = "ap-southeast-1";
const SECRET_ID = process.env.SENDGRID_SECRET_ID ?? "filepipeline/sendgrid-api-key";

if (!process.env.AWS_PROFILE) {
  throw new Error(
    "AWS_PROFILE is not set. Run via 'bun run create:aws:sendgrid-secret <key>' or export AWS_PROFILE before invoking this script directly.",
  );
}

const AWS_PROFILE: string = process.env.AWS_PROFILE;

function log(message: string) {
  console.log(`\n📦 ${message}`);
}

function logSuccess(message: string) {
  console.log(`✅ ${message}`);
}

function logError(message: string) {
  console.error(`❌ ${message}`);
}

function checkIdentity(): boolean {
  const result = spawnSync("aws", ["sts", "get-caller-identity", "--output", "json"], {
    stdio: "pipe",
    env: { ...process.env, AWS_PROFILE, AWS_REGION: REGION, AWS_PAGER: "" },
  });
  return result.status === 0;
}

function ensureAwsCredentials(): void {
  log(`Checking AWS identity for profile ${AWS_PROFILE}...`);

  if (!checkIdentity()) {
    throw new Error(
      `AWS identity check failed for profile ${AWS_PROFILE}. Refresh its credentials (e.g. 'aws sso login --profile ${AWS_PROFILE}' or 'aws configure set ... --profile ${AWS_PROFILE}') and rerun.`,
    );
  }

  logSuccess(`AWS credentials configured (profile: ${AWS_PROFILE})`);
}

async function main() {
  const secret = process.argv[2]?.trim();

  if (!secret) {
    throw new Error("Usage: bun run scripts/create-sendgrid-secret.ts <secret>");
  }

  ensureAwsCredentials();

  const client = new SecretsManagerClient({ region: REGION });

  log(`Writing secret ${SECRET_ID} in ${REGION} (profile: ${AWS_PROFILE})...`);
  try {
    await client.send(
      new CreateSecretCommand({
        Name: SECRET_ID,
        SecretString: secret,
        Description: "SendGrid API key used by FilePipeline Lambdas",
      }),
    );
    logSuccess(`Created secret ${SECRET_ID}`);
  } catch (error) {
    if (error instanceof ResourceExistsException) {
      await client.send(new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString: secret }));
      logSuccess(`Secret ${SECRET_ID} already existed — updated its value`);
    } else {
      throw error;
    }
  }
}

main().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
