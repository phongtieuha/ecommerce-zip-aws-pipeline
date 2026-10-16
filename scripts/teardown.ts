/**
 * Teardown everything FilePipeline created in AWS.
 *
 * This script:
 * 1. Verifies the caller identity and asks for the account ID as confirmation
 * 2. Deletes the FilePipelineStack CloudFormation stack (all CDK-managed resources)
 * 3. Deletes resources created outside the stack:
 *    - Hand-created `filepipeline-*` Lambdas (the tools/* egressors/ingestor), plus
 *      their SQS event source mappings, any same-account source queue tagged
 *      Project=filepipeline, and their IAM roles (if no other Lambda uses them)
 *    - SendGrid secret in Secrets Manager (created by create:aws:sendgrid-secret)
 *    - Log groups of CDK helper Lambdas and tool Lambdas (/aws/lambda/FilePipelineStack-*, filepipeline-*)
 * 4. Deletes the CDK bootstrap stack (CDKToolkit) and its retained staging
 *    bucket / ECR repo — skipped if any other CloudFormation stack exists in
 *    the region, since bootstrap is shared by all CDK apps in the account
 * 5. Removes local cdk-outputs.json
 *
 * Usage:
 *   bun run teardown:aws            # prompts for account ID confirmation
 *   bun run teardown:aws -- --yes   # skip confirmation (non-interactive)
 */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const OUTPUTS_FILE = join(ROOT_DIR, "packages/infra/cdk-outputs.json");

const REGION = "ap-southeast-1";
const STACK_NAME = "FilePipelineStack";
const BOOTSTRAP_STACK_NAME = "CDKToolkit";
const SENDGRID_SECRET_ID = process.env.SENDGRID_SECRET_ID ?? "filepipeline/sendgrid-api-key";
const LOG_GROUP_PREFIXES = [`/aws/lambda/${STACK_NAME}-`, "/aws/lambda/filepipeline-"];
const ACTIVE_STACK_STATUSES = [
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
  "DELETE_FAILED",
  "CREATE_FAILED",
  "UPDATE_ROLLBACK_FAILED",
];

function log(message: string) {
  console.log(`\n🗑️  ${message}`);
}

function logSuccess(message: string) {
  console.log(`✅ ${message}`);
}

function logWarning(message: string) {
  console.log(`⚠️  ${message}`);
}

function logError(message: string) {
  console.error(`❌ ${message}`);
}

// Bun auto-loads the root .env (LocalStack endpoint + dummy keys). Drop them so the
// AWS CLI and SDK clients both resolve credentials from AWS_PROFILE instead.
for (const key of [
  "AWS_ENDPOINT_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]) {
  delete process.env[key];
}
const AWS_ENV: NodeJS.ProcessEnv = { ...process.env, AWS_REGION: REGION };

/** Run an AWS CLI command (args array, no shell). Returns stdout, or null on failure. */
function aws(args: string[], { allowFail = false } = {}): string | null {
  const result = spawnSync("aws", [...args, "--region", REGION], {
    env: AWS_ENV,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    if (!allowFail) logError(`aws ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
    return null;
  }
  return result.stdout.trim();
}

function stackExists(stackName: string): boolean {
  return (
    aws(["cloudformation", "describe-stacks", "--stack-name", stackName], { allowFail: true }) !==
    null
  );
}

function getStackOutputs(stackName: string): Record<string, string> {
  const raw = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--query",
    "Stacks[0].Outputs",
    "--output",
    "json",
  ]);
  const outputs = (raw ? JSON.parse(raw) : null) as Array<{
    OutputKey: string;
    OutputValue: string;
  }> | null;
  return Object.fromEntries((outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

function deleteStack(stackName: string): boolean {
  if (!stackExists(stackName)) {
    logSuccess(`Stack ${stackName} not found — already deleted`);
    return true;
  }
  log(`Deleting stack ${stackName} (this can take 10+ minutes, CloudFront is slow)...`);
  if (aws(["cloudformation", "delete-stack", "--stack-name", stackName]) === null) return false;
  if (
    aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stackName]) === null
  ) {
    logError(`Stack ${stackName} did not delete cleanly. Check failed resources with:`);
    console.log(
      `     aws cloudformation describe-stack-events --stack-name ${stackName} --region ${REGION}`,
    );
    return false;
  }
  logSuccess(`Stack ${stackName} deleted`);
  return true;
}

async function emptyAndDeleteBucket(bucket: string): Promise<void> {
  const s3 = new S3Client({ region: REGION });
  try {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId,
      }));
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    logSuccess(`Deleted bucket ${bucket}`);
  } catch (err) {
    if ((err as Error).name === "NoSuchBucket") {
      logSuccess(`Bucket ${bucket} already gone`);
      return;
    }
    logError(`Could not delete bucket ${bucket}: ${(err as Error).name} ${(err as Error).message}`);
  }
}

interface ToolLambda {
  name: string;
  role: string;
}

/** `filepipeline-*` Lambdas not managed by the main stack (created by hand, deployed from tools/*). */
function listToolLambdas(): ToolLambda[] | null {
  const raw = aws([
    "lambda",
    "list-functions",
    "--query",
    "Functions[?starts_with(FunctionName, 'filepipeline-')].[FunctionName,Role]",
    "--output",
    "json",
  ]);
  if (raw === null) return null;
  const stackRaw = stackExists(STACK_NAME)
    ? aws([
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        STACK_NAME,
        "--query",
        "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId",
        "--output",
        "json",
      ])
    : "[]";
  if (stackRaw === null) return null;
  const stackFunctions = new Set(JSON.parse(stackRaw) as string[]);
  return (JSON.parse(raw) as [string, string][])
    .filter(([name]) => !stackFunctions.has(name))
    .map(([name, role]) => ({ name, role }));
}

/** Delete a hand-created SQS queue only if it lives in this account and is tagged as ours. */
function deleteOwnedQueue(queueArn: string, account: string): void {
  const [, , service, region, queueAccount, queueName] = queueArn.split(":");
  if (service !== "sqs" || region !== REGION || queueAccount !== account || !queueName) {
    logWarning(`Leaving event source ${queueArn} (not an SQS queue in this account/region)`);
    return;
  }
  const url = aws(
    ["sqs", "get-queue-url", "--queue-name", queueName, "--query", "QueueUrl", "--output", "text"],
    {
      allowFail: true,
    },
  );
  if (!url) return;
  const project = aws([
    "sqs",
    "list-queue-tags",
    "--queue-url",
    url,
    "--query",
    "Tags.Project",
    "--output",
    "text",
  ]);
  if (project !== "filepipeline") {
    logWarning(`Leaving queue ${queueName} (not tagged Project=filepipeline)`);
    return;
  }
  if (aws(["sqs", "delete-queue", "--queue-url", url]) !== null)
    logSuccess(`Deleted queue ${queueName}`);
}

function deleteRole(roleName: string): void {
  const list = (args: string[]) =>
    JSON.parse(aws([...args, "--output", "json"]) ?? "[]") as string[];

  for (const policyArn of list([
    "iam",
    "list-attached-role-policies",
    "--role-name",
    roleName,
    "--query",
    "AttachedPolicies[].PolicyArn",
  ])) {
    aws(["iam", "detach-role-policy", "--role-name", roleName, "--policy-arn", policyArn]);
    // Delete customer-managed policies (e.g. console-generated AWSLambdaBasicExecutionRole-*) once orphaned
    if (policyArn.includes(":aws:policy/")) continue;
    const attachments = aws([
      "iam",
      "get-policy",
      "--policy-arn",
      policyArn,
      "--query",
      "Policy.AttachmentCount",
      "--output",
      "text",
    ]);
    if (attachments !== "0") continue;
    for (const versionId of list([
      "iam",
      "list-policy-versions",
      "--policy-arn",
      policyArn,
      "--query",
      "Versions[?!IsDefaultVersion].VersionId",
    ])) {
      aws(["iam", "delete-policy-version", "--policy-arn", policyArn, "--version-id", versionId]);
    }
    if (aws(["iam", "delete-policy", "--policy-arn", policyArn]) !== null) {
      console.log(`     deleted policy ${policyArn.split("/").pop()}`);
    }
  }
  for (const policyName of list([
    "iam",
    "list-role-policies",
    "--role-name",
    roleName,
    "--query",
    "PolicyNames",
  ])) {
    aws(["iam", "delete-role-policy", "--role-name", roleName, "--policy-name", policyName]);
  }
  for (const profile of list([
    "iam",
    "list-instance-profiles-for-role",
    "--role-name",
    roleName,
    "--query",
    "InstanceProfiles[].InstanceProfileName",
  ])) {
    aws([
      "iam",
      "remove-role-from-instance-profile",
      "--instance-profile-name",
      profile,
      "--role-name",
      roleName,
    ]);
  }
  if (aws(["iam", "delete-role", "--role-name", roleName]) !== null)
    logSuccess(`Deleted IAM role ${roleName}`);
}

function deleteToolLambdas(toolLambdas: ToolLambda[], account: string): void {
  log("Deleting tool Lambdas created outside the stack...");
  if (toolLambdas.length === 0) {
    logSuccess("No tool Lambdas found");
    return;
  }

  for (const { name } of toolLambdas) {
    // Event source mappings are not removed by delete-function
    const mappingsRaw = aws([
      "lambda",
      "list-event-source-mappings",
      "--function-name",
      name,
      "--query",
      "EventSourceMappings[].[UUID,EventSourceArn]",
      "--output",
      "json",
    ]);
    for (const [uuid, sourceArn] of JSON.parse(mappingsRaw ?? "[]") as [string, string][]) {
      if (aws(["lambda", "delete-event-source-mapping", "--uuid", uuid]) !== null) {
        console.log(`     deleted event source mapping ${name} ← ${sourceArn.split(":").pop()}`);
      }
      deleteOwnedQueue(sourceArn, account);
    }
    if (aws(["lambda", "delete-function", "--function-name", name]) !== null) {
      logSuccess(`Deleted Lambda ${name}`);
    }
  }

  // Delete roles only once no remaining Lambda in the region still uses them
  const remainingRaw = aws([
    "lambda",
    "list-functions",
    "--query",
    "Functions[].Role",
    "--output",
    "json",
  ]);
  if (remainingRaw === null) {
    logWarning("Could not list remaining Lambdas — leaving tool IAM roles in place");
    return;
  }
  const rolesInUse = new Set(JSON.parse(remainingRaw) as string[]);
  for (const roleArn of new Set(toolLambdas.map((t) => t.role))) {
    const roleName = roleArn.split("/").pop()!;
    if (rolesInUse.has(roleArn))
      logWarning(`Leaving IAM role ${roleName} (still used by another Lambda)`);
    else deleteRole(roleName);
  }
}

function deleteSecret(): void {
  log(`Deleting secret ${SENDGRID_SECRET_ID}...`);
  const result = spawnSync(
    "aws",
    [
      "secretsmanager",
      "delete-secret",
      "--secret-id",
      SENDGRID_SECRET_ID,
      "--force-delete-without-recovery",
      "--region",
      REGION,
    ],
    { env: AWS_ENV, encoding: "utf-8" },
  );
  if (result.status === 0) logSuccess(`Deleted secret ${SENDGRID_SECRET_ID}`);
  else if (/ResourceNotFoundException/.test(result.stderr))
    logSuccess("Secret not found — already deleted");
  else logError(`Could not delete secret: ${result.stderr.trim()}`);
}

function deleteLogGroups(): void {
  log("Deleting leftover Lambda log groups...");
  let deleted = 0;
  for (const prefix of LOG_GROUP_PREFIXES) {
    const raw = aws([
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      prefix,
      "--query",
      "logGroups[].logGroupName",
      "--output",
      "json",
    ]);
    for (const name of (raw ? JSON.parse(raw) : []) as string[]) {
      if (aws(["logs", "delete-log-group", "--log-group-name", name]) !== null) {
        console.log(`     deleted ${name}`);
        deleted++;
      }
    }
  }
  logSuccess(`Deleted ${deleted} log group(s)`);
}

async function deleteBootstrap(): Promise<void> {
  if (!stackExists(BOOTSTRAP_STACK_NAME)) {
    logSuccess(`${BOOTSTRAP_STACK_NAME} not found — already deleted`);
    return;
  }

  const raw = aws([
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    ...ACTIVE_STACK_STATUSES,
    "--query",
    "StackSummaries[].StackName",
    "--output",
    "json",
  ]);
  if (raw === null) {
    logWarning(`Could not list stacks — skipping ${BOOTSTRAP_STACK_NAME} deletion to be safe`);
    return;
  }
  const others = (JSON.parse(raw) as string[]).filter(
    (name) => name !== BOOTSTRAP_STACK_NAME && name !== STACK_NAME,
  );
  if (others.length > 0) {
    logWarning(
      `Skipping ${BOOTSTRAP_STACK_NAME}: other stacks exist in ${REGION} and may depend on it: ${others.join(", ")}`,
    );
    return;
  }

  // Staging bucket and ECR repo are RETAINed by the bootstrap template — clean them up explicitly
  const outputs = getStackOutputs(BOOTSTRAP_STACK_NAME);
  const bucket = outputs.BucketName;
  const repo = outputs.ImageRepositoryName;

  if (!deleteStack(BOOTSTRAP_STACK_NAME)) return;

  if (bucket) await emptyAndDeleteBucket(bucket);
  if (repo) {
    const ok = aws(["ecr", "delete-repository", "--repository-name", repo, "--force"], {
      allowFail: true,
    });
    logSuccess(
      ok !== null ? `Deleted ECR repository ${repo}` : `ECR repository ${repo} already gone`,
    );
  }
}

async function confirm(account: string): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n   Type the account ID (${account}) to confirm teardown: `);
  rl.close();
  return answer.trim() === account;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  FilePipeline AWS Teardown");
  console.log("═".repeat(60));

  // Identity pre-check
  const identityRaw = aws(["sts", "get-caller-identity", "--output", "json"]);
  if (identityRaw === null) {
    logError(
      "AWS identity check failed (expired/invalid token or missing profile). " +
        "Refresh credentials for profile 'filepipeline' and rerun.",
    );
    process.exit(1);
  }
  const identity = JSON.parse(identityRaw) as { Account: string; Arn: string };
  console.log(`\n   Profile: ${process.env.AWS_PROFILE ?? "(default)"}`);
  console.log(`   Account: ${identity.Account}`);
  console.log(`   Caller:  ${identity.Arn}`);
  console.log(`   Region:  ${REGION}`);

  const toolLambdas = listToolLambdas();
  if (toolLambdas === null) {
    logError("Could not list Lambda functions — aborting before deleting anything.");
    process.exit(1);
  }

  log("This will permanently delete ALL FilePipeline resources in this account:");
  console.log(`     - ${STACK_NAME}: S3 buckets (and all data), DynamoDB tables, SQS queues,`);
  console.log("       Lambda functions + log groups, EventBridge rules, Cognito user pool,");
  console.log("       HTTP API, CloudFront distribution, IAM roles");
  console.log(
    `     - Tool Lambdas + their IAM roles/SQS triggers: ${toolLambdas.map((t) => t.name).join(", ") || "(none found)"}`,
  );
  console.log(`     - Secret ${SENDGRID_SECRET_ID} (no recovery window)`);
  console.log(`     - Log groups ${LOG_GROUP_PREFIXES.map((p) => `${p}*`).join(", ")}`);
  console.log(
    `     - ${BOOTSTRAP_STACK_NAME} + staging bucket/ECR repo (only if no other stacks exist)`,
  );

  if (!(await confirm(identity.Account))) {
    logWarning("Confirmation did not match — aborting, nothing was deleted.");
    process.exit(1);
  }

  if (!deleteStack(STACK_NAME)) {
    logError("Main stack deletion failed — stopping before deleting secret/bootstrap.");
    process.exit(1);
  }

  deleteToolLambdas(toolLambdas, identity.Account);
  deleteSecret();
  // After stack/tool Lambda deletion: custom-resource Lambdas write logs while the stack is being deleted
  deleteLogGroups();
  await deleteBootstrap();

  if (existsSync(OUTPUTS_FILE)) {
    unlinkSync(OUTPUTS_FILE);
    logSuccess(`Deleted ${OUTPUTS_FILE}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Teardown Complete!");
  console.log("═".repeat(60));
  console.log("\n   To verify, check AWS Console:");
  console.log(
    `     https://${REGION}.console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks`,
  );
  console.log("\n   To redeploy: bun run create:aws:sendgrid-secret && bun run deploy:aws\n");
}

await main().catch((err) => {
  logError(`Teardown failed: ${err.message}`);
  process.exit(1);
});
