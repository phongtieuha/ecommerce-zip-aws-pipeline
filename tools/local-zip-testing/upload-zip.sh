#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  cat <<'USAGE'
Usage: ./upload-zip.sh <zip-file-path>

Uploads a ZIP file to the local FilePipeline incoming S3 bucket with a generated run token.

Arguments:
  zip-file-path      Path to the ZIP file to upload. Can optionally include test-data/ prefix.
USAGE

  exit 1
fi

ZIP_PATH="$1"

# Strip everything up to and including a test-data/ segment, whether the
# input is relative ("test-data/...") or absolute (".../<repo>/test-data/...")
ZIP_PATH="${ZIP_PATH#./}"
if [[ "$ZIP_PATH" == *test-data/* ]]; then
  ZIP_PATH="${ZIP_PATH#*test-data/}"
fi

BUCKET="filepipeline-incoming"
ENDPOINT="http://localhost:4566"
REGION="ap-southeast-1"
AWS_ACCESS_KEY_ID="test"
AWS_SECRET_ACCESS_KEY="test"
RUN_TOKEN="local-$(date +%s%N | cut -b1-13)"

# Resolve full path with test-data fallback
FULL_ZIP_PATH="$ZIP_PATH"
if [ ! -f "$FULL_ZIP_PATH" ]; then
  FULL_ZIP_PATH="test-data/$ZIP_PATH"
  if [ ! -f "$FULL_ZIP_PATH" ]; then
    echo "ZIP file not found: $ZIP_PATH" >&2
    exit 1
  fi
fi

# Build S3 key from normalized path (test-data/ already stripped). The run
# token is inserted as its own path segment rather than appended to the
# filename: mapping selectionRules' `zipFilename` gate matches against only
# the S3 key's basename (see `s3Key.split("/").pop()` in
# packages/lambda/src/processor/index.ts), so mangling the basename with a
# suffix breaks any exact/trailing-literal zipFilename pattern (e.g. a rule
# matching one specific fixture's exact name) that would otherwise match in
# production, where the uploaded filename is never modified.
ZIP_BASENAME="$(basename "$ZIP_PATH")"
ZIP_DIR="$(dirname "$ZIP_PATH")"
if [ "$ZIP_DIR" = "." ]; then
  S3_KEY="${RUN_TOKEN}/${ZIP_BASENAME}"
else
  S3_KEY="${ZIP_DIR}/${RUN_TOKEN}/${ZIP_BASENAME}"
fi

echo "Uploading $FULL_ZIP_PATH to s3://$BUCKET/$S3_KEY"

AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" aws --endpoint-url "$ENDPOINT" s3 cp "$FULL_ZIP_PATH" "s3://$BUCKET/$S3_KEY" --region "$REGION"

cat <<EOF
UPLOAD_COMPLETE=1
RUN_TOKEN=$RUN_TOKEN
S3_KEY=$S3_KEY
BUCKET=$BUCKET
ENDPOINT=$ENDPOINT
REGION=$REGION
EOF