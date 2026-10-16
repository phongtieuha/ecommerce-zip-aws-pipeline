#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/replay_external_zip_events.sh [--send] [--allow-nonempty-queue] <path_list_file>

Behavior:
  - Reads a text file of S3 keys (one per line), e.g.
    output/zip-files-from-20260401-to-20260628.txt
  - Accepts lines like:
      archive/file_type=json/channel=.../file.zip
      file_type=json/channel=.../file.zip
      s3://bucket/archive/file_type=.../file.zip
  - Ignores blank/comment lines and non-.zip lines.
  - Replays by copying archive keys to non-archive keys (removing leading "archive/").
  - De-duplicates replay keys so one archive path yields one replay copy.

Mode:
  - list (default): resolves and previews each key; performs no copy (safe, non-mutating)
  - --send: copies archive->replay key once per unique replay key

Flags:
  --send                  Perform the replay copy. Without this flag, the script only previews.
  --allow-nonempty-queue  Skip the queue-empty precheck (only meaningful with --send).

Copy behavior:
  - Retries each copy up to 2 attempts
  - Waits 2 seconds between retries
  - Continues on per-key copy failures and prints a failure summary at the end

Safety checks:
  - Verifies processing queue is empty before a --send replay.
  - Exits if queue has pending/in-flight messages, unless --allow-nonempty-queue is set.
    This prevents replay tests from mixing with stale messages (for example S3 notification s3:TestEvent).
USAGE
}

MODE="list"
ALLOW_NONEMPTY_QUEUE=0
MAX_RETRIES=2
RETRY_DELAY_SEC=2

LIST_FILE=""
for arg in "$@"; do
  case "${arg}" in
    --send)
      MODE="send"
      ;;
    --allow-nonempty-queue)
      ALLOW_NONEMPTY_QUEUE=1
      ;;
    --*)
      usage
      echo
      echo "Error: unknown flag '${arg}'."
      exit 1
      ;;
    *)
      if [[ -n "${LIST_FILE}" ]]; then
        usage
        echo
        echo "Error: multiple path_list_file arguments provided ('${LIST_FILE}' and '${arg}')."
        exit 1
      fi
      LIST_FILE="${arg}"
      ;;
  esac
done

if [[ -z "${LIST_FILE}" || ! -f "${LIST_FILE}" ]]; then
  usage
  echo
  echo "Error: path list file is required and must exist."
  exit 1
fi

AWS_PROFILE_VALUE="filepipeline"
AWS_REGION_VALUE="ap-southeast-1"
BUCKET="filepipeline-incoming-682120331784-ap-southeast-1"
QUEUE_URL="https://sqs.ap-southeast-1.amazonaws.com/682120331784/filepipeline-queue"
s3_cmd() {
  env -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    AWS_PROFILE="${AWS_PROFILE_VALUE}" \
    AWS_PAGER="" \
    AWS_CLI_AUTO_PROMPT=off \
    aws "$@"
}

copy_with_retries() {
  local source_key="$1"
  local replay_key="$2"
  local attempt=1

  while (( attempt <= MAX_RETRIES )); do
    if s3_cmd --no-cli-pager s3 cp \
      --region "${AWS_REGION_VALUE}" \
      "s3://${BUCKET}/${source_key}" \
      "s3://${BUCKET}/${replay_key}" >/dev/null; then
      return 0
    fi

    if (( attempt < MAX_RETRIES )); then
      echo "   -> copy failed (attempt ${attempt}/${MAX_RETRIES}); retrying in ${RETRY_DELAY_SEC}s"
      sleep "${RETRY_DELAY_SEC}"
    fi

    attempt=$((attempt + 1))
  done

  return 1
}

preflight_queue_check() {
  if [[ "${MODE}" != "send" ]]; then
    echo "List mode: skipping queue-empty precheck (no copy will be performed)."
    return 0
  fi

  if [[ "${ALLOW_NONEMPTY_QUEUE}" -eq 1 ]]; then
    echo "NOTE: --allow-nonempty-queue set; skipping strict queue-empty precheck."
    return 0
  fi

  queue_is_empty
}

queue_is_empty() {
  local attrs
  local visible
  local not_visible

  attrs="$(s3_cmd --no-cli-pager sqs get-queue-attributes \
    --queue-url "${QUEUE_URL}" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --region "${AWS_REGION_VALUE}" \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' \
    --output text 2>/dev/null || true)"

  visible="$(printf '%s' "${attrs}" | awk '{print $1}')"
  not_visible="$(printf '%s' "${attrs}" | awk '{print $2}')"

  [[ -n "${visible}" ]] || visible="0"
  [[ -n "${not_visible}" ]] || not_visible="0"

  if [[ "${visible}" == "0" && "${not_visible}" == "0" ]]; then
    return 0
  fi

  echo "Queue preflight failed:"
  echo "  Queue URL: ${QUEUE_URL}"
  echo "  ApproximateNumberOfMessages=${visible}"
  echo "  ApproximateNumberOfMessagesNotVisible=${not_visible}"
  echo
  echo "Replay run aborted to avoid mixing with old queue messages (including possible s3:TestEvent messages from S3 notification updates)."
  echo "If you intentionally want to replay on a non-empty queue, rerun with --allow-nonempty-queue."
  return 1
}

normalize_replay_key() {
  local raw="$1"
  local key="${raw//$'\r'/}"

  # trim leading/trailing whitespace
  key="${key#${key%%[![:space:]]*}}"
  key="${key%${key##*[![:space:]]}}"

  [[ -z "${key}" || "${key:0:1}" == "#" ]] && return 1

  if [[ "${key}" == s3://* ]]; then
    key="${key#s3://}"
    key="${key#*/}"
  fi

  key="${key#/}"
  [[ "${key}" == *.zip ]] || return 1

  if [[ "${key}" == archive/* ]]; then
    key="${key#archive/}"
  fi

  printf '%s\n' "${key}"
}

resolve_source_key() {
  local replay_key="$1"
  local source_key="archive/${replay_key}"

  if s3_cmd --no-cli-pager s3api head-object \
    --bucket "${BUCKET}" \
    --key "${source_key}" \
    --region "${AWS_REGION_VALUE}" >/dev/null 2>&1; then
    printf '%s\n' "${source_key}"
    return 0
  fi

  # Fallback: if caller already provided non-archive path and it exists, use it.
  if s3_cmd --no-cli-pager s3api head-object \
    --bucket "${BUCKET}" \
    --key "${replay_key}" \
    --region "${AWS_REGION_VALUE}" >/dev/null 2>&1; then
    printf '%s\n' "${replay_key}"
    return 0
  fi

  return 1
}

SOURCE_LINES=0
SKIPPED_LINES=0
TMP_KEYS_FILE="$(mktemp)"
TMP_UNIQUE_FILE="$(mktemp)"
trap 'rm -f "${TMP_KEYS_FILE}" "${TMP_UNIQUE_FILE}"' EXIT

while IFS= read -r line || [[ -n "${line}" ]]; do
  SOURCE_LINES=$((SOURCE_LINES + 1))
  if ! replay_key="$(normalize_replay_key "${line}")"; then
    SKIPPED_LINES=$((SKIPPED_LINES + 1))
    continue
  fi

  printf '%s\n' "${replay_key}" >> "${TMP_KEYS_FILE}"
done < "${LIST_FILE}"

if [[ -s "${TMP_KEYS_FILE}" ]]; then
  LC_ALL=C sort -u "${TMP_KEYS_FILE}" > "${TMP_UNIQUE_FILE}"
fi

UNIQUE_COUNT=$(wc -l < "${TMP_UNIQUE_FILE}" | tr -d ' ')

echo "Mode: ${MODE}"
echo "AWS_PROFILE: ${AWS_PROFILE_VALUE}"
echo "AWS_REGION: ${AWS_REGION_VALUE}"
echo "Bucket: ${BUCKET}"
echo "Input list: ${LIST_FILE}"
echo "Input lines: ${SOURCE_LINES}"
echo "Skipped lines (blank/comment/non-zip): ${SKIPPED_LINES}"
echo "Unique replay keys: ${UNIQUE_COUNT}"
echo "Max retries per copy: ${MAX_RETRIES}"
echo "Retry delay seconds: ${RETRY_DELAY_SEC}"
echo

RUN_STARTED_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Run started (UTC): ${RUN_STARTED_UTC}"
echo

preflight_queue_check

if [[ "${UNIQUE_COUNT}" -eq 0 ]]; then
  echo "No replayable zip keys found."
  exit 0
fi

COPIED=0
FAILED=0
IDX=0
MISSING_SOURCE=0
TMP_FAILED_FILE="$(mktemp)"
trap 'rm -f "${TMP_KEYS_FILE}" "${TMP_UNIQUE_FILE}" "${TMP_FAILED_FILE}"' EXIT
while IFS= read -r key; do
  IDX=$((IDX + 1))
  printf '[%s/%s] %s\n' "${IDX}" "${UNIQUE_COUNT}" "${key}"

  source_key=""
  if ! source_key="$(resolve_source_key "${key}")"; then
    MISSING_SOURCE=$((MISSING_SOURCE + 1))
    echo "   -> skipped: source object not found in bucket (${key} or archive/${key})"
    continue
  fi

  echo "   source: ${source_key}"
  echo "   replay: ${key}"

  if [[ "${MODE}" == "send" ]]; then
    if copy_with_retries "${source_key}" "${key}"; then
      COPIED=$((COPIED + 1))
      echo "   -> copied (S3 ObjectCreated will enqueue processor message)"
    else
      FAILED=$((FAILED + 1))
      printf '%s\n' "${key}" >> "${TMP_FAILED_FILE}"
      echo "   -> failed after ${MAX_RETRIES} attempt(s)"
    fi
  fi
done < "${TMP_UNIQUE_FILE}"

if [[ "${MODE}" == "send" ]]; then
  RUN_FINISHED_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  SKIPPED_SOURCE=$((MISSING_SOURCE + FAILED))

  echo
  echo "Run finished (UTC): ${RUN_FINISHED_UTC}"
  echo "Copied ${COPIED} object(s), one replay copy per unique replay key."
  echo "Skipped missing source: ${MISSING_SOURCE}"
  echo "Failed copies: ${FAILED}"
  echo "Attempted keys: ${UNIQUE_COUNT}"
  echo
  echo "Summary counters:"
  echo "  SUMMARY_TOTAL_KEYS=${UNIQUE_COUNT}"
  echo "  SUMMARY_COPIED=${COPIED}"
  echo "  SUMMARY_MISSING_SOURCE=${MISSING_SOURCE}"
  echo "  SUMMARY_FAILED=${FAILED}"
  echo "  SUMMARY_SKIPPED=${SKIPPED_SOURCE}"
  echo "  SUMMARY_EXPECTED_SQS_MESSAGES=${COPIED}"

  if (( FAILED > 0 )); then
    echo "Failed replay keys:"
    cat "${TMP_FAILED_FILE}"
    exit 2
  fi
else
  echo
  echo "List-only mode complete. Use --send to replay by archive->incoming copy."
fi

echo "Done."
