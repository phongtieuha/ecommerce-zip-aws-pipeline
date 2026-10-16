/**
 * Shared single-instance lock helper for local Lambda runners.
 * Prevents two copies of the same local runner from polling concurrently.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireRunnerLock(lockPath: string): void {
  const writeOwnLock = () => {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, String(process.pid), "utf-8");
    } finally {
      closeSync(fd);
    }
  };

  try {
    writeOwnLock();
  } catch (error) {
    const isAlreadyExists =
      typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

    if (!isAlreadyExists) {
      throw error;
    }

    try {
      const raw = readFileSync(lockPath, "utf-8").trim();
      const activePid = Number.parseInt(raw, 10);
      if (processExists(activePid)) {
        throw new Error(
          `Another local runner is already active (pid ${activePid}). Stop it before starting a new runner.`,
        );
      }
    } catch (staleCheckError) {
      if (staleCheckError instanceof Error && staleCheckError.message.includes("already active")) {
        throw staleCheckError;
      }
    }

    // Stale or malformed lock file: remove and retry once atomically.
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore cleanup race; retry below will fail again if another process is active.
    }

    writeOwnLock();
  }

  const releaseLock = () => {
    try {
      if (existsSync(lockPath)) {
        const current = readFileSync(lockPath, "utf-8").trim();
        if (current === String(process.pid)) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
  };

  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });
}
