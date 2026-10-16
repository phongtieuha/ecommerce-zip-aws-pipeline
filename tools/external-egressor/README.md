# External Egressor Lambda

Lambda to copy files from internal processed bucket to an external output bucket.

## Trigger

In the current CDK stack (`packages/infra/lib/filepipeline-stack.ts`), this Lambda is **not**
wired to an S3 bucket notification. Instead, the coordinator Lambda (`filepipeline-coordinator`)
directly invokes `filepipeline-external-egressor` (async `InvokeCommand`, `EXTERNAL_EGRESSOR_FUNCTION`
env var) with a synthetic S3-event-shaped payload for each object it writes under `output/`.
The coordinator's IAM role is granted `lambda:InvokeFunction` on this function's ARN for that
purpose.

The handler code itself still accepts either a native S3 event shape or an SQS message whose
body contains standard S3 event JSON, so it can also be wired to a real S3 ObjectCreated
notification or an SQS queue if needed.

## Environment variables

- `AWS_REGION=ap-southeast-1`
- `SOURCE_BUCKET` (required, expected internal source bucket)
- `SOURCE_PREFIX` — declared but **not currently enforced**: the key filter (`isAllowedKey` in
  `src/index.ts`) is hardcoded to the `output/` prefix regardless of this variable's value.
- `DESTINATION_BUCKET` (required, external destination bucket)
- `DESTINATION_PREFIX` (optional, prepend to destination key)
- `EXTERNAL_AWS_REGION` (optional, default `ap-southeast-1`)
- `EXTERNAL_AWS_ACCESS_KEY_ID` (required)
- `EXTERNAL_AWS_SECRET_ACCESS_KEY` (required)

## Build

```bash
bun run --filter @filepipeline/external-egressor build
```

## Deploy

```bash
cd tools/external-egressor
bash deployment.sh
```

## Notes

- Reads from source bucket using Lambda role credentials.
- Writes to destination bucket using `EXTERNAL_AWS_*` credentials.
