# Consolidation Egressor Lambda

Standalone Lambda to copy files from `tagged_output/*.csv` in the internal processed bucket to an external output bucket.

## Trigger behavior

In the current CDK stack (`packages/infra/lib/filepipeline-stack.ts`), this Lambda is **not**
wired to a real S3 bucket notification. Instead, after the coordinator Lambda
(`filepipeline-coordinator`) writes CSVs under `tagged_output/`, it lists the objects there and
directly invokes `filepipeline-consolidation-egressor` once per CSV (async `InvokeCommand`, via
the `CONSOLIDATION_EGRESSOR_FUNCTION` env var) with a synthetic S3-event-shaped payload. The
coordinator's IAM role is granted `lambda:InvokeFunction` on this function's ARN for that
purpose.

The handler's own key filter (`isAllowedKey` in `src/index.ts`) still gates on:

- prefix: `SOURCE_PREFIX` (default `tagged_output/`)
- suffix: `.csv`

so it would also work correctly if pointed at a real S3 ObjectCreated notification.

## Environment variables

- `AWS_REGION` (default: `ap-southeast-1`)
- `SOURCE_BUCKET` (required)
- `SOURCE_PREFIX` (optional, default `tagged_output`)
- `DESTINATION_BUCKET` (required)
- `DESTINATION_PREFIX` (optional)
- `EXTERNAL_AWS_REGION` (default: `ap-southeast-1`)
- `EXTERNAL_AWS_ACCESS_KEY_ID` (required)
- `EXTERNAL_AWS_SECRET_ACCESS_KEY` (required)

## Independent deployment

1. Ensure `.env` exists and fill values.
2. Run:

```bash
cd tools/consolidation-egressor
bash deployment.sh
```

The deployment script (`deployment.sh`) only updates an **existing** Lambda's code and
timeout:

- builds and zips the lambda
- updates the lambda function code (`aws lambda update-function-code`)
- sets the lambda timeout (`aws lambda update-function-configuration --timeout 29`)

It does not create the function, set environment variables, grant S3 invoke permission, or
touch S3 bucket notifications — those are handled by the CDK stack / IAM policy (see "Trigger
behavior" above) and must already be in place before running this script.
