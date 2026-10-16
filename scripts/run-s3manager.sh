#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S3MANAGER_DIR="$ROOT_DIR/tools/s3manager"
PORT="${PORT:-8090}"

cd "$S3MANAGER_DIR"
source ./set-env.sh
export PORT

exec ./s3manager "$@"