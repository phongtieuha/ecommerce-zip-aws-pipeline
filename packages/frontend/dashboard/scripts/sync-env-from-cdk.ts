import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface StackOutputs {
  readonly MetricsApiUrl?: string;
  readonly DashboardUserPoolDomain?: string;
  readonly DashboardUserPoolClientId?: string;
}

interface CdkOutputs {
  readonly FilePipelineStack?: StackOutputs;
}

const OUTPUTS_PATH = fileURLToPath(new URL("../../../infra/cdk-outputs.json", import.meta.url));
const DASHBOARD_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const REGION = process.env.AWS_REGION ?? "ap-southeast-1";

const REQUIRED_OUTPUT_KEYS: Array<keyof StackOutputs> = [
  "MetricsApiUrl",
  "DashboardUserPoolDomain",
  "DashboardUserPoolClientId",
];

function toHostedUiDomain(domain: string): string {
  const trimmed = domain.trim();
  const withoutScheme = trimmed.replace(/^https?:\/\//, "");

  if (withoutScheme.includes(".")) {
    return withoutScheme;
  }

  return `${withoutScheme}.auth.${REGION}.amazoncognito.com`;
}

function setEnvValue(envContent: string, key: string, value: string): string {
  const linePattern = new RegExp(`^${key}=.*$`, "m");
  const newLine = `${key}=${value}`;

  if (linePattern.test(envContent)) {
    return envContent.replace(linePattern, newLine);
  }

  return envContent.endsWith("\n") ? `${envContent}${newLine}\n` : `${envContent}\n${newLine}\n`;
}

function getMissingKeys(outputs: StackOutputs): string[] {
  return REQUIRED_OUTPUT_KEYS.filter((key) => !outputs[key]).map((key) => key.toString());
}

async function main() {
  let outputsRaw: string;
  try {
    outputsRaw = await readFile(OUTPUTS_PATH, "utf8");
  } catch {
    console.warn(`[sync:env] Skipping: CDK outputs not found at ${OUTPUTS_PATH}`);
    process.exit(0);
  }

  const outputs = JSON.parse(outputsRaw) as CdkOutputs;
  const stackOutputs = outputs.FilePipelineStack;

  if (!stackOutputs) {
    console.warn("[sync:env] Skipping: FilePipelineStack outputs not found in cdk-outputs.json");
    process.exit(0);
  }

  const missingKeys = getMissingKeys(stackOutputs);
  if (missingKeys.length > 0) {
    console.warn(`[sync:env] Skipping: missing output keys: ${missingKeys.join(", ")}`);
    process.exit(0);
  }

  const currentEnv = await readFile(DASHBOARD_ENV_PATH, "utf8");

  let nextEnv = currentEnv;
  nextEnv = setEnvValue(nextEnv, "VITE_DASHBOARD_API_URL", stackOutputs.MetricsApiUrl ?? "");
  nextEnv = setEnvValue(
    nextEnv,
    "VITE_COGNITO_DOMAIN",
    stackOutputs.DashboardUserPoolDomain
      ? toHostedUiDomain(stackOutputs.DashboardUserPoolDomain)
      : "",
  );
  nextEnv = setEnvValue(
    nextEnv,
    "VITE_COGNITO_CLIENT_ID",
    stackOutputs.DashboardUserPoolClientId ?? "",
  );
  nextEnv = setEnvValue(nextEnv, "VITE_AWS_REGION", REGION);

  if (nextEnv !== currentEnv) {
    await writeFile(DASHBOARD_ENV_PATH, nextEnv, "utf8");
    console.log(`[sync:env] Updated ${DASHBOARD_ENV_PATH}`);
  } else {
    console.log("[sync:env] No changes needed");
  }
}

await main();
