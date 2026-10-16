# FilePipeline — New Environment Deployment Guide

**Purpose**: this document guides deploying the core file-processing pipeline into a target AWS environment — incoming bucket → core pipeline → processed bucket — without the partner-facing ingestion/egress components the current production deployment depends on. It does not duplicate [README.md](README.md) or [impldocs/ARCHITECTURE.md](impldocs/ARCHITECTURE.md); it adds what they don't cover: this migration's scope, the code change it requires, and deploy sequencing.

---

## 1. Start Here

- [README.md](README.md) — features, quick start, local dev setup, full configuration reference, troubleshooting, and a table of contents covering every section.
- [impldocs/ARCHITECTURE.md](impldocs/ARCHITECTURE.md) — full system diagram, per-Lambda component reference (trigger/reads/writes/memory/timeout), standalone tools, secrets management.
- `impldocs/*.md` — one doc per subsystem/feature (path extraction, multi-region text analysis, data-quality-checker, official-shop lookup, per-file consolidation, operation module architecture, contain_image, product-description operations).

Read those two top-level docs first. Everything below assumes you have.

---

## 2. Prerequisites

- [ ] AWS IAM access for the new account, configured under the `filepipeline` CLI profile, region `ap-southeast-1` — setup steps in README's "AWS Prerequisites" section
- [ ] A SendGrid API key to seed into the new account's Secrets Manager — required before the first deploy (see §4); if reusing the existing SendGrid account, get the key from whoever owns it
- [ ] Access to populate `.env.prod` for the new account (org-specific credential-issuance process — this repo only consumes them)

---

## 3. Current State (being left behind)

- Production today runs in a separate, existing AWS account via a single CDK stack (`FilePipelineStack`) — see `impldocs/ARCHITECTURE.md` for the Component Reference table of what's running there. The ingestion/egress architecture being replaced is described in §4, not repeated here.
- Supporting Lambdas unaffected by this migration, which carry over unchanged to the new environment: zip-output-checker (arrival tracking + missing-output alerts), data-quality-checker (6-hourly quality reports), email-summariser (daily digest), dashboard-api (read-only metrics behind Cognito), dlq-handler (marks the matching `filepipeline-files` record `status: "DLQ"` when SQS moves a message off `filepipeline-queue` after 2 failed receives — internal-only, no partner/egress dependency).
- Verification relies on `bun run typecheck`/`bun run build` plus manual or agent-driven runs (see README's "Agent Tooling" section — `local-zip-tester` and `zip-replayer` subagents exist for this).

---

## 4. Migration

**Goal**: simplify from the current partner-egress architecture down to a self-contained pipeline — incoming bucket → core pipeline → processed bucket, with no external partner-facing hops — running in a new AWS account.

### Current architecture

- **Ingestion**: partner files land in an external bucket → external SQS (`<external-file-scan-queue>`) → `tools/external-ingestor` copies the object into `filepipeline-incoming-*`. Some producers also upload directly to the incoming bucket, skipping this hop.
- **Core pipeline**: S3 `.zip`-created event on the incoming bucket → SQS `filepipeline-queue` → `filepipeline-processor` (parse/validate/dedup) → writes per-file `output/*.csv` to `filepipeline-processed-*`.
- **Regional consolidation**: an S3 event on the processed bucket triggers `filepipeline-coordinator`, which merges per-file CSVs into per-region `tagged_output/.../consolidated.csv`.
- **Egress**: the coordinator directly invokes `tools/external-egressor` (per-file `output/*.csv`) and `tools/consolidation-egressor` (any `tagged_output/*.csv` under that region's prefix — the coordinator's own filter only checks the `.csv` extension, not a `consolidated` substring, so this can also pick up `metadata.csv`) by name. Separately, S3 events trigger `tools/failed-processing-egressor` (`failed_processing/`) and `tools/metrics-egressor` (`metrics/*.json`, produced by `filepipeline-email-summariser`). All four read from `filepipeline-processed-*` and write out to an external partner bucket using separate `EXTERNAL_AWS_*` credentials.

Full detail: `impldocs/ARCHITECTURE.md` (system diagram, Component Reference table).

### Target architecture

`filepipeline-incoming-*` → core pipeline → `filepipeline-processed-*`. Nothing reads from or writes to an external/partner-owned bucket.

### Components not deployed to the new environment

Since this is a fresh AWS account, these are simply never deployed there — there's nothing running yet to tear down. (If a separate goal is also decommissioning them from the _existing_ production account, that's a different exercise, not covered here.)

- `tools/external-ingestor` and its dependency on the external SQS queue / external partner bucket IAM access.
- `tools/external-egressor`, `tools/consolidation-egressor`, `tools/failed-processing-egressor`, `tools/metrics-egressor` — all four, along with their S3 event-notification wiring and `EXTERNAL_AWS_*` credentials, none of which get set up in the new account.

### Deployment checklist

#### Required code change before first deploy

`packages/infra/lib/filepipeline-stack.ts:346-347` hardcodes `EXTERNAL_EGRESSOR_FUNCTION: "filepipeline-external-egressor"` and `CONSOLIDATION_EGRESSOR_FUNCTION: "filepipeline-consolidation-egressor"` into the coordinator Lambda's environment — these aren't read from `.env`, so deploying the stack as-is into the new account will still set them. Since those egressor Lambdas are intentionally not deployed there (see above), the coordinator's `InvokeCommand` calls against them will fail on every processed file. This is caught and logged rather than thrown (`coordinator/index.ts:1102-1165`, `runPostWriteFanouts`/`runPreWriteFanouts`), so it won't break processing, but it does mean permanent per-file `console.error` noise in CloudWatch from day one.

**Before the first deploy**: remove (or blank) these two environment values in `filepipeline-stack.ts`, and remove the associated `iam.PolicyStatement` granting `lambda:InvokeFunction` on their ARNs (`filepipeline-stack.ts:388-396` — the account/region in that ARN are dynamic CDK tokens, not hardcoded, but the two function-name suffixes are the same hardcoded names as above; removing this grants no functional fix, just cleans up dead invoke permission on two ARNs that will never exist in the new account).

**This is the complete extent of egressor/ingestor-related code to touch** — confirmed by grepping `packages/infra`, `packages/lambda/src`, `packages/shared`, `scripts/`, and `mappings/` for every `egressor`/`ingestor` reference in the repo:

- `tools/external-ingestor`, `tools/failed-processing-egressor`, and `tools/metrics-egressor` have **zero** references anywhere outside their own `tools/*/` directories — no stack code, no env vars, no IAM grants tied to them. There's nothing to remove for these three; they simply never get their own `deployment.sh` run in the new account.
- `coordinator/index.ts` itself needs **no code change** — it already has explicit skip-logic for both fan-outs when their env var is unset (`"EXTERNAL_EGRESSOR_FUNCTION is not set; skipping..."` / `"...CONSOLIDATION_EGRESSOR_FUNCTION is not set; skipping..."`). Once the two `filepipeline-stack.ts` env vars above are blanked, the coordinator cleanly no-ops both fan-outs with an info-level `console.log`, not an error — so the per-file `console.error` noise this section opened with goes away entirely, with no Lambda handler code touched.

#### Change target variables in .env.prod and packages/frontend/dashboard/.env

Root `.env` is local-dev-only and irrelevant to this migration (see README's Configuration section). Two other files need attention for the new account:

**`.env.prod`** (`bun run deploy:aws`/`create:aws:sendgrid-secret` load this wholesale via `--env-file=.env.prod`):

- **`INCOMING_BUCKET` / `PROCESSED_BUCKET` — optional bucket name override.** `filepipeline-stack.ts:137,145` falls back to the auto-derived name (`filepipeline-incoming-{account}-{region}` etc.) whenever the env var is unset **or blank** (`?.trim() || default` — deliberately not `??`, since Bun's `--env-file` sets a bare `KEY=` line to `""` rather than leaving it undefined, and `""` is not nullish) — so leaving `.env.prod` blank keeps the account-ID-suffixed default, while setting a value there pins the bucket to that exact name instead.
- **`DASHBOARD_AUTH_CALLBACK_URLS` / `DASHBOARD_AUTH_LOGOUT_URLS` / `DASHBOARD_API_ALLOWED_ORIGINS` — must be updated, but only after a first deploy.** These ARE read directly (`filepipeline-stack.ts:578,582,673`) and configure the real Cognito app client and API Gateway CORS allow-list. They currently hold the old account's CloudFront domain. Since the new account's CloudFront distribution domain doesn't exist until after the stack is deployed once, follow the documented two-pass pattern (`packages/frontend/dashboard/README.md`'s `redirect_mismatch` fix): deploy once with these left blank/localhost-only so CDK's own fallback is used, read the real domain back from `cdk-outputs.json` (`DashboardCloudFrontDomain`/`DashboardCloudFrontUrl`), update these three vars to the new domain, then redeploy.
- **`DASHBOARD_SEED_USER_EMAIL` / `DASHBOARD_SEED_USER_PASSWORD` — a new choice, not something to look up.** These aren't tied to the old account at all — they're read directly (`filepipeline-stack.ts:611-612`) to optionally create the new environment's first dashboard admin user in its Cognito User Pool. Decide the real email/password for this admin here; leave both blank to skip seeding a user and create one manually post-deploy instead.
- **`ENABLE_FEATURE1_*` / `ENABLE_FEATURE2_*` — copy over from root `.env` if you want the same flag values in the new account.** These aren't account-specific, but since `.env.prod` (not `.env`) now drives the real deploy, any value only set in `.env` won't reach the new stack — it'll silently fall back to the CDK stack's own hardcoded default instead.

**`packages/frontend/dashboard/.env`** — most of its account-specific values are refreshed automatically by the `sync:env` step of `bun run deploy:aws:dashboard` (`VITE_DASHBOARD_API_URL`, `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`, `VITE_AWS_REGION`, all pulled from `cdk-outputs.json`). Two are not auto-synced and need manual updates for the new account:

- **`FRONTEND_BUCKET_NAME`** — currently the old account's processed bucket name; update to the new one (from `cdk-outputs.json` or the pattern in the `.env.prod` bullet above).
- **`VITE_COGNITO_REDIRECT_URI` / `VITE_COGNITO_LOGOUT_REDIRECT_URI`** — currently the old CloudFront domain; same two-pass dependency as `.env.prod`'s `DASHBOARD_AUTH_*` vars above (the new domain doesn't exist until after a first deploy), so update these once that domain is known.

#### Run locally first

Before spending a real AWS deploy cycle on it, validate the code change and updated `.env` against LocalStack, per this repo's own rule to test locally whenever possible:

```bash
docker-compose up -d
bun run setup:localstack
bun run dev:lambda
bun run upload:local:test
```

To browse the LocalStack buckets directly while checking output, `bun run dev:s3manager` starts a local S3 browser UI (`tools/s3manager`, default port 8090) — optional, but useful for confirming keys/output land where expected without shelling out to `aws s3 ls`.

Confirm processed output lands correctly. This only exercises the Processor path, not the Coordinator — `dev:lambda` runs the Processor alone; the Coordinator has its own separate local runner (`bun run dev:coordinator`), and per README/`impldocs/ARCHITECTURE.md`, `setup:localstack` doesn't provision `filepipeline-consolidation`, so the Coordinator's regional-consolidation/egressor-invoke code path — where the code change above actually applies — isn't exercisable end-to-end locally today either way. This step validates the Processor and `.env` basics only; the coordinator code change still needs verifying against real AWS after deploy.

#### Deploy steps

Run in order, once the code change and `.env` changes above are made and validated locally:

1. **Set up the `filepipeline` AWS CLI profile** for the new account — README's "AWS Prerequisites" section (`aws configure set aws_access_key_id/aws_secret_access_key/aws_session_token/region --profile filepipeline`).
2. **Bootstrap CDK** for the new account/region — README's "AWS Prerequisites" section (`npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-1`). Get `ACCOUNT_ID` from `aws sts get-caller-identity --profile filepipeline --query Account --output text`.
3. **Create the SendGrid secret** in the new account — required before the first `deploy:aws` or it fails immediately (see §2 above): `bun run create:aws:sendgrid-secret <key>`.
4. **Deploy the CDK stack**: `bun run deploy:aws`.
5. **Deploy the dashboard SPA assets**: `bun run deploy:aws:dashboard`. On this first deploy, the `DASHBOARD_AUTH_*`/`DASHBOARD_API_ALLOWED_ORIGINS` vars won't yet point at the real CloudFront domain — follow the two-pass pattern above (update those three vars from `cdk-outputs.json`, rerun `deploy:aws`) before this step will produce a working login flow.

---

## 5. Operational Runbook Pointers

For the new environment once the migration above is complete:

- **Redeploying after the initial migration**: `bun run deploy:aws` (or the `aws-deployer` Claude Code subagent — see README's "Agent Tooling" section). For the _first_ deploy into the new environment, use §4's Deploy steps instead, in order.
- **Teardown**: `bun run teardown:aws`.
- **Local dev**: `docker-compose up -d` → `bun run setup:localstack` → `bun run dev:lambda`.
- **Troubleshooting**: README's "Troubleshooting" section covers the two most common failure categories in detail with file/line citations.
- **Configuration reference**: README's "Configuration" section lists every environment variable actually read by the code, with what uses it.
