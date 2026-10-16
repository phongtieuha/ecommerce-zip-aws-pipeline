# External Ingestor Lambda

Integration Lambda to consume S3-event messages from queue `<external-file-scan-queue>` and copy objects into the pipeline incoming bucket.

## Message shape expected

SQS message body should be JSON containing either:

- S3 test event (`Event: "s3:TestEvent"`) -> skipped
- S3 object event with `Records[].s3.bucket.name` and `Records[].s3.object.key`

## Environment variables

- `AWS_REGION=ap-southeast-1`
- `DESTINATION_BUCKET` (required)
- `DESTINATION_PREFIX` (optional, default empty)
- `DESTINATION_USE_EXTERNAL_CREDS` (optional, default `false`; when `true`, writes to destination use `EXTERNAL_AWS_*` credentials)
- `ALLOWED_SOURCE_BUCKETS` (optional comma-separated allowlist)
- `SOURCE_ASSUME_ROLE_ARN` (optional, for cross-account read)

**External Bucket Access (optional, for cross-org/cross-account with access keys):**

- `EXTERNAL_BUCKET_NAME` (optional, bucket name to read from with explicit credentials)
- `EXTERNAL_AWS_REGION` (optional, AWS region for external bucket, default `ap-southeast-1`)
- `EXTERNAL_AWS_ACCESS_KEY_ID` (optional, access key for external bucket)
- `EXTERNAL_AWS_SECRET_ACCESS_KEY` (optional, secret key for external bucket)

If all external bucket vars are provided, the Lambda will use those credentials to read from the external bucket and write to the destination bucket.

`DESTINATION_PREFIX` lets you prepend all copied keys, for example:

- empty prefix -> `file_type=json/channel=.../request_type=.../file.zip`
- `incoming` -> `incoming/file_type=json/channel=.../request_type=.../file.zip`

## Build

```bash
bun run --filter @filepipeline/external-ingestor build
```

## Optional local run

```bash
bun run --filter @filepipeline/external-ingestor start
```

## Example AWS CLI wiring (manual)

Create event source mapping from existing queue to your Lambda function:

```bash
AWS_PROFILE=filepipeline aws lambda create-event-source-mapping \
  --region ap-southeast-1 \
  --function-name YOUR_INGESTOR_LAMBDA_NAME \
  --batch-size 1 \
  --event-source-arn arn:aws:sqs:ap-southeast-1:682120331784:<external-file-scan-queue>
```

Grant queue invoke permission by attaching `AWSLambdaSQSQueueExecutionRole` to the Lambda role.

`<external-file-scan-queue>` is **not** part of the CDK stack — it's created and managed by hand (no DLQ/redrive policy — failed deliveries are not retried), so if ever recreated, tag it to match the convention used for the CDK-managed queues in `packages/infra/lib/filepipeline-stack.ts` (`Tier=app`):

```bash
AWS_PROFILE=filepipeline aws sqs tag-queue \
  --region ap-southeast-1 \
  --queue-url https://sqs.ap-southeast-1.amazonaws.com/682120331784/<external-file-scan-queue> \
  --tags Project=filepipeline,ENV=prod,Tier=app
```

Grant source and destination bucket permissions on Lambda role:

- `s3:GetObject` on source bucket prefix
- `s3:PutObject` on destination bucket prefix
- `s3:ListBucket` as needed for troubleshooting

For cross-account source with AssumeRole:

- Lambda role needs `sts:AssumeRole` on `SOURCE_ASSUME_ROLE_ARN`
- External role trust policy must trust this Lambda role
- External role policy grants `s3:GetObject` on external source bucket

For external bucket access with explicit credentials:

- Set `EXTERNAL_BUCKET_NAME`, `EXTERNAL_AWS_ACCESS_KEY_ID`, and `EXTERNAL_AWS_SECRET_ACCESS_KEY` in Lambda env vars
- Lambda will use these credentials to read objects from the external bucket
- Destination bucket write permissions still come from Lambda execution role
- Useful for reading from external S3 buckets outside your AWS account or organization
