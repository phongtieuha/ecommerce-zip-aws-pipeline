#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/filepipeline-local-runner.lock"
RUNNER_PATTERN="src/local-processor-runner.ts"
STOP_ONLY="${1:-}"

cd "$ROOT_DIR"

if pgrep -f "$RUNNER_PATTERN" >/dev/null 2>&1; then
  echo "Stopping existing local runner process(es)..."
  pgrep -f "$RUNNER_PATTERN" | xargs kill
  # Give processes a short grace window before force-kill fallback.
  sleep 1
  if pgrep -f "$RUNNER_PATTERN" >/dev/null 2>&1; then
    echo "Force stopping remaining local runner process(es)..."
    pgrep -f "$RUNNER_PATTERN" | xargs kill -9
  fi
else
  echo "No existing local runner process found."
fi

if [[ -f "$LOCK_FILE" ]]; then
  echo "Removing stale runner lock: $LOCK_FILE"
  rm -f "$LOCK_FILE"
fi

if [[ "$STOP_ONLY" == "--stop-only" ]]; then
  echo "Stopped local runner."
  exit 0
fi

echo "Starting local runner..."
exec bun run --env-file=.env --filter @filepipeline/lambda dev
