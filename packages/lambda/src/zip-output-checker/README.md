# ZIP Output Checker

Monitors incoming ZIP files and alerts if corresponding CSV output files are not produced within 5 minutes.

## Architecture

**Two Lambda Functions:**

1. **S3 Event Handler** (`filepipeline-zip-output-checker-s3`): Triggered when ZIP files arrive in the incoming bucket
   - Sends one SQS message (with `DelaySeconds=300`) to the delay queue per ZIP
2. **SQS Delay Queue Handler** (`filepipeline-zip-output-checker-delayed`): Triggered by the delay queue, exactly once per ZIP, 5 minutes after arrival
   - Verifies if the corresponding CSV exists in the output bucket
   - Sends an email alert if the CSV is missing

**SQS:**

- `filepipeline-zip-check-delay` (+ DLQ `filepipeline-zip-check-dlq`): each message's own `DelaySeconds` is the 5-minute timer — no polling, no shared state, no persistent record to clean up.

**Storage:**

- Incoming bucket: `filepipeline-incoming-{account-id}-{region}`
- Output bucket: `filepipeline-processed-{account-id}-{region}`

## Deployment

There is no standalone `deployment.sh` for this Lambda — both functions are defined in the
main CDK stack (`packages/infra/lib/filepipeline-stack.ts`) and deployed as part of the repo-root
deploy flow.

### Prerequisites

- AWS CLI configured with `filepipeline` profile
- A value in the `filepipeline/sendgrid-api-key` AWS Secrets Manager secret — **required**, not
  optional. `scripts/deploy.ts` fetches it before deploying and exits with an error if the
  secret is missing or empty (the SQS delay-queue handler needs it to send alert emails).

### Deploy

From the repository root:

```bash
AWS_PROFILE=filepipeline bun run deploy:aws
```

This runs `scripts/deploy.ts`, which:

1. Fetches `SENDGRID_API_KEY` from the `filepipeline/sendgrid-api-key` Secrets Manager secret.
2. Builds Lambda functions and deploys the CDK stack (which creates/updates both
   `filepipeline-zip-output-checker-s3` and `filepipeline-zip-output-checker-delayed`, wiring
   `ZIP_CHECK_QUEUE_URL` and `PROCESSED_BUCKET` automatically).
3. Injects `SENDGRID_API_KEY` directly into `filepipeline-zip-output-checker-delayed`'s
   environment via `UpdateFunctionConfiguration` (the CDK definition itself does not set this
   variable for that function).

**Environment Variables (set automatically by the deploy above — not meant to be configured
by hand):**

- `AWS_REGION`: AWS region (`ap-southeast-1`)
- `ZIP_CHECK_QUEUE_URL`: SQS delay queue URL, set by CDK on the S3 handler
- `PROCESSED_BUCKET`: Output S3 bucket, set by CDK on the delayed handler
- `SENDGRID_API_KEY`: required on the delayed handler; injected post-deploy from Secrets
  Manager as described above

### Configure the SendGrid secret

`packages/lambda/src/zip-output-checker/.env` is no longer read by the Lambda or the deploy
script — it exists only as a note pointing at Secrets Manager. Update the key value with:

```bash
AWS_PROFILE=filepipeline aws secretsmanager put-secret-value \
  --region ap-southeast-1 \
  --secret-id filepipeline/sendgrid-api-key \
  --secret-string "your_sendgrid_key_here"
```

## Email Configuration

Alert emails are sent to: `placeholder@email.com` (configurable in code)

To add more recipients, edit `ALERT_EMAIL_TO` in `index.ts` to an array of emails.

## Testing

1. Upload a test ZIP file to the incoming bucket. The key needs `file_type=`/`channel=` segments
   and a date embedded in the filename itself (dashed `YYYY-MM-DD` or compact `YYYYMMDD`,
   optionally with a time suffix) — a bare filename like `test.zip` won't match and the check
   will be silently skipped:

   ```bash
   aws s3 cp test-2026-05-04.zip \
     "s3://filepipeline-incoming-{account-id}-ap-southeast-1/file_type=json/channel=lazada/request_type=product-skus/" \
     --profile filepipeline
   ```

2. Confirm a message appears in `filepipeline-zip-check-delay` immediately, then wait 5+ minutes and check:
   - Email for alert if no CSV was produced

3. Check CloudWatch logs:
   - `/aws/lambda/filepipeline-zip-output-checker-s3`
   - `/aws/lambda/filepipeline-zip-output-checker-delayed`
