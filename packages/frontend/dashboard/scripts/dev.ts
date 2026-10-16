import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(__dirname, "..");
const envLocalPath = join(dashboardDir, ".env.local");

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

const envFromLocal = existsSync(envLocalPath)
  ? parseEnvFile(readFileSync(envLocalPath, "utf8"))
  : {};

if (!existsSync(envLocalPath)) {
  console.warn(`[dev] ${envLocalPath} not found. Falling back to default Vite env loading.`);
}

const child = spawn("vite", {
  cwd: dashboardDir,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    ...envFromLocal,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[dev] Failed to start Vite: ${error.message}`);
  process.exit(1);
});
