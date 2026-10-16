/**
 * Deploy FilePipeline infrastructure to AWS.
 *
 * This script:
 * 1. Builds Lambda functions for AWS (Node.js 20 runtime)
 * 2. Runs CDK deploy to create/update all AWS resources, including the
 *    email-summariser and zip-output-checker Lambda code
 * 3. Injects SENDGRID_API_KEY (from Secrets Manager) into the email-summariser
 *    and zip-output-checker-delayed Lambda configs, since CDK doesn't manage
 *    that env var for them
 * 4. Prints outputs for key AWS resources
 *
 * Prerequisites:
 * - AWS credentials configured (via environment or AWS CLI profile)
 * - CDK bootstrapped in target account/region
 *
 * Usage:
 *   bun run deploy:aws
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdated,
} from "@aws-sdk/client-lambda";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const INFRA_DIR = join(ROOT_DIR, "packages/infra");
const LAMBDA_DIR = join(ROOT_DIR, "packages/lambda");
const OUTPUTS_FILE = join(INFRA_DIR, "cdk-outputs.json");

const REGION = "ap-southeast-1";
const STACK_NAME = "FilePipelineStack";
const SENDGRID_SECRET_ID = process.env.SENDGRID_SECRET_ID ?? "filepipeline/sendgrid-api-key";
const EMAIL_FUNCTION_NAME = "filepipeline-email-summariser";
const ZIP_DELAYED_FUNCTION_NAME = "filepipeline-zip-output-checker-delayed";

interface CdkOutputs {
  [stackName: string]: Record<string, string | undefined>;
}

interface StackResourceSummary {
  LogicalResourceId?: string;
  PhysicalResourceId?: string;
  ResourceType?: string;
  ResourceStatus?: string;
}

function getLiveStackOutputs(stackName: string): Record<string, string> {
  try {
    const raw = execSync(
      `aws cloudformation describe-stacks --region ${REGION} --stack-name ${stackName} --query 'Stacks[0].Outputs' --output json`,
      {
        stdio: "pipe",
        env: process.env,
      },
    ).toString();

    const outputs = JSON.parse(raw) as Array<{ OutputKey?: string; OutputValue?: string }>;
    const map: Record<string, string> = {};

    for (const output of outputs) {
      if (output.OutputKey && output.OutputValue) {
        map[output.OutputKey] = output.OutputValue;
      }
    }

    return map;
  } catch {
    return {};
  }
}

function getLiveStackResources(stackName: string): StackResourceSummary[] {
  try {
    const raw = execSync(
      `aws cloudformation list-stack-resources --region ${REGION} --stack-name ${stackName} --output json`,
      {
        stdio: "pipe",
        env: {
          ...process.env,
          AWS_PAGER: "",
        },
      },
    ).toString();

    const payload = JSON.parse(raw) as {
      StackResourceSummaries?: StackResourceSummary[];
    };

    return (payload.StackResourceSummaries ?? []).filter(
      (resource) =>
        resource.ResourceStatus === "CREATE_COMPLETE" ||
        resource.ResourceStatus === "UPDATE_COMPLETE",
    );
  } catch {
    return [];
  }
}

function printSection(title: string, values: string[]) {
  if (values.length === 0) return;

  console.log(`\n   ${title}:`);
  for (const value of values) {
    console.log(`     - ${value}`);
  }
}

function parseResourceNameFromArn(arn: string): string {
  const lastColon = arn.lastIndexOf(":");
  if (lastColon === -1 || lastColon === arn.length - 1) return arn;
  return arn.slice(lastColon + 1);
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function getResourceNamesByType(
  resources: StackResourceSummary[],
  resourceType: string,
  options?: {
    excludeLogicalIdPrefixes?: string[];
  },
): string[] {
  const excludePrefixes = options?.excludeLogicalIdPrefixes ?? [];

  return uniqueSorted(
    resources
      .filter((resource) => resource.ResourceType === resourceType)
      .filter((resource) => {
        const logicalId = resource.LogicalResourceId ?? "";
        return !excludePrefixes.some((prefix) => logicalId.startsWith(prefix));
      })
      .map((resource) => resource.PhysicalResourceId),
  );
}

function getFriendlyResourceNamesByType(
  resources: StackResourceSummary[],
  resourceType: string,
  formatResource: (resource: StackResourceSummary) => string | undefined,
  options?: {
    excludeLogicalIdPrefixes?: string[];
  },
): string[] {
  const excludePrefixes = options?.excludeLogicalIdPrefixes ?? [];

  return uniqueSorted(
    resources
      .filter((resource) => resource.ResourceType === resourceType)
      .filter((resource) => {
        const logicalId = resource.LogicalResourceId ?? "";
        return !excludePrefixes.some((prefix) => logicalId.startsWith(prefix));
      })
      .map(formatResource),
  );
}

function formatEventBridgeRule(resource: StackResourceSummary): string | undefined {
  const logicalId = resource.LogicalResourceId ?? "";
  const physicalId = resource.PhysicalResourceId;

  if (logicalId.startsWith("EmailSummariserSchedule")) {
    return physicalId
      ? `email-summariser daily schedule (${physicalId})`
      : "email-summariser daily schedule";
  }

  return physicalId ? `${logicalId} (${physicalId})` : logicalId || undefined;
}

function formatHttpApi(resource: StackResourceSummary): string | undefined {
  const logicalId = resource.LogicalResourceId ?? "";
  const physicalId = resource.PhysicalResourceId;

  if (logicalId.startsWith("DashboardHttpApi")) {
    return physicalId ? `filepipeline-dashboard-api (${physicalId})` : "filepipeline-dashboard-api";
  }

  return physicalId ? `${logicalId} (${physicalId})` : logicalId || undefined;
}

function log(message: string) {
  console.log(`\n📦 ${message}`);
}

function logSuccess(message: string) {
  console.log(`✅ ${message}`);
}

function logError(message: string) {
  console.error(`❌ ${message}`);
}

function runCommand(command: string, cwd: string, description: string): boolean {
  log(description);
  console.log(`   Running: ${command}`);
  console.log(`   In: ${cwd}\n`);

  const result = spawnSync(command, {
    shell: true,
    cwd,
    stdio: "inherit",
    env: { ...process.env, AWS_REGION: REGION },
  });

  if (result.status !== 0) {
    logError(`Command failed with exit code ${result.status}`);
    return false;
  }

  return true;
}

async function fetchSendGridApiKey(): Promise<string> {
  const client = new SecretsManagerClient({ region: REGION });

  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: SENDGRID_SECRET_ID }));
    const sendgridApiKey = response.SecretString?.trim();

    if (!sendgridApiKey) {
      logError(
        `Secret ${SENDGRID_SECRET_ID} has no value. coordinator, email-summariser, and zip-output-checker-delayed all require SENDGRID_API_KEY — fix the secret and rerun.`,
      );
      process.exit(1);
    }

    // Coordinator reads SENDGRID_API_KEY straight from CDK synth's process.env.
    process.env.SENDGRID_API_KEY = sendgridApiKey;
    logSuccess(`Loaded SENDGRID_API_KEY from Secrets Manager (${SENDGRID_SECRET_ID})`);
    return sendgridApiKey;
  } catch (error) {
    logError(
      `Could not read secret ${SENDGRID_SECRET_ID} (${(error as Error).name ?? "error"}). coordinator, email-summariser, and zip-output-checker-delayed all require SENDGRID_API_KEY — fix access to the secret and rerun.`,
    );
    process.exit(1);
  }
}

async function injectSendGridKey(
  lambdaClient: LambdaClient,
  functionName: string,
  sendgridApiKey: string,
): Promise<void> {
  log(`Updating ${functionName} environment with SENDGRID_API_KEY...`);
  const currentConfig = await lambdaClient.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
  );

  await lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: functionName,
      Environment: {
        Variables: {
          ...currentConfig.Environment?.Variables,
          SENDGRID_API_KEY: sendgridApiKey,
        },
      },
    }),
  );

  await waitUntilFunctionUpdated(
    { client: lambdaClient, maxWaitTime: 120 },
    { FunctionName: functionName },
  );
  logSuccess(`${functionName} environment updated`);
}

function checkPrerequisites(): boolean {
  log("Checking prerequisites...");

  // Check AWS credentials
  try {
    execSync("aws sts get-caller-identity", {
      stdio: "pipe",
      env: process.env,
    });
    logSuccess("AWS credentials configured");
  } catch {
    logError(
      "AWS credentials not configured. Please run 'aws configure' or set AWS_* environment variables.",
    );
    return false;
  }

  // Check CDK is installed
  try {
    execSync("npx cdk --version", {
      stdio: "pipe",
      cwd: INFRA_DIR,
      env: process.env,
    });
    logSuccess("CDK is available");
  } catch {
    logError("CDK not found. Please install aws-cdk.");
    return false;
  }

  return true;
}

const BUCKET_ENV_OVERRIDES: Array<{ envKey: string; outputKey: string; label: string }> = [
  { envKey: "INCOMING_BUCKET", outputKey: "IncomingBucketName", label: "incoming" },
  { envKey: "PROCESSED_BUCKET", outputKey: "ProcessedBucketName", label: "processed" },
];

type BucketStatus = "exists" | "not-found" | "unknown";

function checkBucketStatus(bucketName: string): { status: BucketStatus; detail: string } {
  const result = spawnSync("aws", ["s3api", "head-bucket", "--bucket", bucketName], {
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });

  if (result.status === 0) return { status: "exists", detail: "" };

  const stderr = result.stderr?.toString().trim() ?? "";

  // "head-bucket" returns the same exit code for 404 (genuinely gone) and 403
  // (bad credentials, or valid credentials with no permission on this bucket) —
  // only stderr distinguishes them. Anything not confirmed 404 is treated as
  // "unknown" and blocked, so a credentials/permission problem never gets
  // silently read as "the old bucket is gone, safe to replace."
  if (/\b404\b/.test(stderr) || /NoSuchBucket/i.test(stderr) || /not found/i.test(stderr)) {
    return { status: "not-found", detail: stderr };
  }

  return { status: "unknown", detail: stderr };
}

function checkBucketRenameSafety(): boolean {
  if (!existsSync(OUTPUTS_FILE)) {
    // No prior deploy recorded — nothing to compare against.
    return true;
  }

  const previousOutputs: CdkOutputs = JSON.parse(readFileSync(OUTPUTS_FILE, "utf-8"));
  const previousStackOutputs = previousOutputs[STACK_NAME] ?? {};

  for (const { envKey, outputKey, label } of BUCKET_ENV_OVERRIDES) {
    const intended = process.env[envKey]?.trim();
    const previous = previousStackOutputs[outputKey];

    if (!intended || !previous || intended === previous) continue;

    log(`Checking whether the previous ${label} bucket ("${previous}") still exists...`);
    const { status, detail } = checkBucketStatus(previous);

    if (status !== "not-found") {
      logError(
        `${envKey} in .env.prod ("${intended}") differs from the currently deployed ${label} bucket ("${previous}").\n` +
          (status === "exists"
            ? `   That bucket still exists. Changing this forces CloudFormation to replace it — deleting "${previous}" and everything in it.\n`
            : `   Could not confirm "${previous}" is gone (unexpected response, treating as unsafe): ${detail}\n`) +
          `   To proceed with the rename: delete/empty "${previous}" yourself first, then rerun.\n` +
          `   To keep the current bucket: revert ${envKey} in .env.prod to "${previous}" (or blank).`,
      );
      return false;
    }

    logSuccess(
      `Previous ${label} bucket ("${previous}") confirmed gone (404) — rename to "${intended}" is safe`,
    );
  }

  return true;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  FilePipeline AWS Deployment");
  console.log("═".repeat(60));

  // Fetch SENDGRID_API_KEY once; reused for coordinator (via CDK synth) and,
  // after CDK deploy, injected directly into email-summariser/zip-output-checker.
  const sendgridApiKey = await fetchSendGridApiKey();

  // Check prerequisites
  if (!checkPrerequisites()) {
    process.exit(1);
  }

  // Fail fast if .env.prod requests a bucket rename that would destroy the old bucket
  if (!checkBucketRenameSafety()) {
    process.exit(1);
  }

  // Step 1: Build Lambda functions
  if (!runCommand("npm run build:aws", LAMBDA_DIR, "Building Lambda functions for Node.js 20...")) {
    process.exit(1);
  }
  logSuccess("Lambda functions built");

  // Step 2: Bootstrap CDK (if needed)
  log("Checking CDK bootstrap status...");
  const bootstrapResult = spawnSync(
    `npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/${REGION}`,
    {
      shell: true,
      cwd: INFRA_DIR,
      stdio: "inherit",
      env: { ...process.env, AWS_REGION: REGION },
    },
  );
  if (bootstrapResult.status !== 0) {
    console.log("   (Bootstrap may have already been done, continuing...)");
  }

  // Step 3: Deploy CDK stack
  if (
    !runCommand(
      `npx cdk deploy ${STACK_NAME} --require-approval never --outputs-file cdk-outputs.json`,
      INFRA_DIR,
      "Deploying CDK stack to AWS...",
    )
  ) {
    process.exit(1);
  }
  logSuccess("CDK stack deployed");

  // Step 3.5: Inject SENDGRID_API_KEY into the two functions CDK doesn't set it for.
  const lambdaClient = new LambdaClient({ region: REGION });
  await injectSendGridKey(lambdaClient, EMAIL_FUNCTION_NAME, sendgridApiKey);
  await injectSendGridKey(lambdaClient, ZIP_DELAYED_FUNCTION_NAME, sendgridApiKey);

  // Step 4: Read outputs for summary
  log("Reading CDK outputs...");

  if (!existsSync(OUTPUTS_FILE)) {
    logError(`CDK outputs file not found: ${OUTPUTS_FILE}`);
    process.exit(1);
  }

  const outputs: CdkOutputs = JSON.parse(readFileSync(OUTPUTS_FILE, "utf-8"));
  const fileOutputs = outputs[STACK_NAME];
  const liveOutputs = getLiveStackOutputs(STACK_NAME);
  const liveResources = getLiveStackResources(STACK_NAME);
  const stackOutputs = {
    ...(fileOutputs ?? {}),
    ...liveOutputs,
  };

  if (Object.keys(stackOutputs).length === 0) {
    logError(`Stack outputs not found for ${STACK_NAME}`);
    process.exit(1);
  }

  logSuccess("CDK outputs loaded");

  const outputEntries = Object.entries(stackOutputs);

  const s3Buckets = getResourceNamesByType(liveResources, "AWS::S3::Bucket");

  const sqsQueues = getResourceNamesByType(liveResources, "AWS::SQS::Queue").map(
    (queueArnOrUrl) => queueArnOrUrl.split("/").pop() ?? queueArnOrUrl,
  );

  const dynamoTables = getResourceNamesByType(liveResources, "AWS::DynamoDB::Table");

  const lambdaFunctions = getResourceNamesByType(liveResources, "AWS::Lambda::Function", {
    excludeLogicalIdPrefixes: ["AWS679f53fac002430cb0da5b7982bd2287", "IncomingKeep-"],
  }).filter((name) => !name.startsWith("FilePipelineStack-"));

  const logGroups = getResourceNamesByType(liveResources, "AWS::Logs::LogGroup");

  const eventBridgeRules = getFriendlyResourceNamesByType(
    liveResources,
    "AWS::Events::Rule",
    formatEventBridgeRule,
  );

  const httpApis = getFriendlyResourceNamesByType(
    liveResources,
    "AWS::ApiGatewayV2::Api",
    formatHttpApi,
  );

  const apiEndpoints = outputEntries
    .filter(([key]) => /ApiUrl$/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value))
    .sort();

  const cloudFrontResources = outputEntries
    .filter(([key]) => /CloudFront(Domain|Url)$/i.test(key))
    .map(([key, value]) => (value ? `${key}: ${value}` : null))
    .filter((value): value is string => Boolean(value))
    .sort();

  const authResources = outputEntries
    .filter(([key]) => key.startsWith("DashboardUserPool"))
    .map(([key, value]) => (value ? `${key}: ${value}` : null))
    .filter((value): value is string => Boolean(value))
    .sort();

  // Print summary
  console.log("\n" + "═".repeat(60));
  console.log("  Deployment Complete!");
  console.log("═".repeat(60));
  console.log("\n📋 Resources Created:\n");
  printSection("S3 Buckets", s3Buckets);
  printSection("SQS Queues", sqsQueues);
  printSection("DynamoDB Tables", dynamoTables);
  printSection("Lambda Functions", lambdaFunctions);
  printSection("CloudWatch Log Groups", logGroups);
  printSection("EventBridge Rules", eventBridgeRules);
  printSection("HTTP APIs", httpApis);
  printSection("API Endpoints", apiEndpoints);
  printSection("CloudFront", cloudFrontResources);
  printSection("Auth Resources", authResources);

  console.log("\n📝 Next Steps:\n");
  console.log(`   1. Upload a test file and check CloudWatch Logs:`);
  console.log(
    `      https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#logsV2:log-groups`,
  );

  console.log("\n⚠️  To teardown all resources, run:");
  console.log("   bun run teardown:aws\n");
}

await main().catch((err) => {
  logError(`Deployment failed: ${err.message}`);
  process.exit(1);
});
