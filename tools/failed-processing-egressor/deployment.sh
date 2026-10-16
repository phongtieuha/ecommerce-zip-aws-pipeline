#!/usr/bin/env bash
set -euo pipefail

AWS_REGION_VALUE="${AWS_REGION:-ap-southeast-1}"
AWS_PROFILE_VALUE="${AWS_PROFILE:-filepipeline}"
FUNCTION_NAME="${FUNCTION_NAME:-filepipeline-failed-processing-egressor}"

echo "Building ${FUNCTION_NAME}..."
bunx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/index.cjs

echo "Packaging Lambda zip..."
rm -f dist/egressor.zip
(
  cd dist
  zip -j egressor.zip index.cjs
)

echo "Updating Lambda code..."
AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda update-function-code \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}" \
  --zip-file fileb://dist/egressor.zip >/dev/null

AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda wait function-updated \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}"

echo "Updating Lambda configuration..."
AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda update-function-configuration \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}" \
  --timeout 29 >/dev/null

AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda wait function-updated \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}"

FUNCTION_ARN=$(AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda get-function-configuration \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}" \
  --query "FunctionArn" \
  --output text)

SOURCE_BUCKET=$(AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws lambda get-function-configuration \
  --region "${AWS_REGION_VALUE}" \
  --function-name "${FUNCTION_NAME}" \
  --query "Environment.Variables.SOURCE_BUCKET" \
  --output text)

if [[ -z "${SOURCE_BUCKET}" || "${SOURCE_BUCKET}" == "None" ]]; then
  echo "SOURCE_BUCKET is missing from Lambda environment. Skipping S3 notification update."
  exit 1
fi

echo "Ensuring S3 notifications include failed_processing CSV and JSON for ${SOURCE_BUCKET}..."

CURRENT_CONFIG_FILE=$(mktemp)
UPDATED_CONFIG_FILE=$(mktemp)

cleanup() {
  rm -f "${CURRENT_CONFIG_FILE}" "${UPDATED_CONFIG_FILE}"
}
trap cleanup EXIT

AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws s3api get-bucket-notification-configuration \
  --bucket "${SOURCE_BUCKET}" \
  --region "${AWS_REGION_VALUE}" >"${CURRENT_CONFIG_FILE}"

jq \
  --arg functionArn "${FUNCTION_ARN}" \
  '
    .LambdaFunctionConfigurations =
      ((.LambdaFunctionConfigurations // [])
      | map(select((.Id // "") != "filepipeline-failed-processing-egressor-csv" and (.Id // "") != "filepipeline-failed-processing-egressor-json"))
      + [
          {
            "Id": "filepipeline-failed-processing-egressor-csv",
            "LambdaFunctionArn": $functionArn,
            "Events": ["s3:ObjectCreated:*"],
            "Filter": {
              "Key": {
                "FilterRules": [
                  { "Name": "Prefix", "Value": "failed_processing/" },
                  { "Name": "Suffix", "Value": ".csv" }
                ]
              }
            }
          },
          {
            "Id": "filepipeline-failed-processing-egressor-json",
            "LambdaFunctionArn": $functionArn,
            "Events": ["s3:ObjectCreated:*"],
            "Filter": {
              "Key": {
                "FilterRules": [
                  { "Name": "Prefix", "Value": "failed_processing/" },
                  { "Name": "Suffix", "Value": ".json" }
                ]
              }
            }
          }
        ])
  ' "${CURRENT_CONFIG_FILE}" >"${UPDATED_CONFIG_FILE}"

AWS_PAGER="" AWS_PROFILE="${AWS_PROFILE_VALUE}" aws s3api put-bucket-notification-configuration \
  --bucket "${SOURCE_BUCKET}" \
  --region "${AWS_REGION_VALUE}" \
  --notification-configuration "file://${UPDATED_CONFIG_FILE}" \
  --skip-destination-validation

echo "Deployment complete. Notifications updated for .csv and .json under failed_processing/."
