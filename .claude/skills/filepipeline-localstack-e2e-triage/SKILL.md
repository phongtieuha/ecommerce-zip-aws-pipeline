---
name: filepipeline-localstack-e2e-triage
description: "Diagnose and stabilize FilePipeline LocalStack processing runs. Use when: E2E run stuck in PROCESSING, DynamoDB and output mismatch, S3 key path or vendor extraction issues in local runs. Do not use for frontend-only issues or non-LocalStack incidents."
---

# FilePipeline LocalStack E2E Triage

## Use When

- E2E processing appears stuck in `PROCESSING`
- DynamoDB status does not match generated artifacts
- S3 key partition/path appears malformed for channel or vendor extraction
- Local reruns show inconsistent state

## Do Not Use

- Frontend/UI rendering issues
- Production-only AWS incidents without LocalStack involvement

## Workflow

1. Confirm single-runner execution to avoid concurrent state conflicts.
2. Verify input S3 key follows canonical partition format expected by the pipeline.
3. Check queue backlogs and DLQ signals if configured.
4. Validate DynamoDB records via targeted partition key queries before broad scans.
5. Cross-check output object existence and row counts in expected output location.
6. Summarize root cause and propose minimal, reversible remediation.

## Output Format

1. Findings ordered by severity.
2. Evidence for each finding (command and key result).
3. Minimal remediation steps.
4. Remaining risks or verification gaps.

## Safety

- Never print secrets or credential values.
- Avoid destructive git or environment reset actions unless explicitly requested.
