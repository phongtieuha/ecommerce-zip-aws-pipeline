import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(__dirname, "..");
const envPath = join(dashboardDir, ".env");

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted && value.length >= 2) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

if (!existsSync(envPath)) {
  throw new Error(`[build:deploy] Missing ${envPath}`);
}

const envFileVars = parseEnvFile(readFileSync(envPath, "utf8"));
const viteEnvFromDotEnv = Object.fromEntries(
  Object.entries(envFileVars).filter(([key]) => key.startsWith("VITE_")),
);

const child = spawn("bun", ["run", "build"], {
  cwd: dashboardDir,
  stdio: "inherit",
  env: {
    ...process.env,
    ...viteEnvFromDotEnv,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[build:deploy] Failed to run build: ${error.message}`);
  process.exit(1);
});
