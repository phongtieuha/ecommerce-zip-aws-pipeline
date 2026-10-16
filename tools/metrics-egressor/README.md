# Metrics Egressor Lambda

Standalone Lambda to copy files from `metrics/` in the internal processed bucket to an external output bucket.

## Trigger behavior

This lambda is intended to be invoked by S3 ObjectCreated notifications filtered by:

- prefix: `metrics/`
- suffix: `.json`

## Environment variables

- `AWS_REGION` (default: `ap-southeast-1`)
- `SOURCE_BUCKET` (required)
- `SOURCE_PREFIX` (optional, default `metrics`)
- `DESTINATION_BUCKET` (required)
- `DESTINATION_PREFIX` (optional, default `metrics`)
- `EXTERNAL_AWS_REGION` (default: `ap-southeast-1`)
- `EXTERNAL_AWS_ACCESS_KEY_ID` (required)
- `EXTERNAL_AWS_SECRET_ACCESS_KEY` (required)

## Independent deployment

1. Ensure environment variables are configured on the Lambda.
2. Run:

```bash
cd tools/metrics-egressor
bash deployment.sh
```

The deployment script:

- builds and zips the lambda
- updates the lambda function code
- sets lambda timeout configuration
