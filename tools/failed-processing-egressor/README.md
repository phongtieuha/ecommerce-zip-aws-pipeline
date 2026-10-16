# Failed Processing Egressor Lambda

Standalone Lambda to copy files from `failed_processing/` in the internal processed bucket to an external output bucket.

## Trigger behavior

This lambda is intended to be invoked by S3 ObjectCreated notifications filtered by:

- prefix: `failed_processing/`
- suffix: `.csv` or `.json`

## Environment variables

- `AWS_REGION` (default: `ap-southeast-1`)
- `SOURCE_BUCKET` (required)
- `SOURCE_PREFIX` (optional, default `failed_processing`)
- `DESTINATION_BUCKET` (required)
- `DESTINATION_PREFIX` (optional, default `failed_processing`)
- `EXTERNAL_AWS_REGION` (default: `ap-southeast-1`)
- `EXTERNAL_AWS_ACCESS_KEY_ID` (required)
- `EXTERNAL_AWS_SECRET_ACCESS_KEY` (required)

## Independent deployment

1. Ensure environment variables are configured on the Lambda.
2. Run:

```bash
cd tools/failed-processing-egressor
bash deployment.sh
```

The deployment script:

- builds and zips the lambda
- updates the lambda function code
- sets lambda timeout configuration
- ensures source-bucket S3 notifications include both:
  - `failed_processing/*.csv`
  - `failed_processing/*.json`

## File types supported

- `.csv` - Failed processing CSV files (missing productId, validation failures)
- `.json` - Validation error detail files (validation-errors.json)
