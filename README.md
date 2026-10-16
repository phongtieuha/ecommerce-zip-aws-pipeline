# FilePipeline - E-commerce File Processor

A serverless file processing pipeline that ingests vendor JSON/HTML files (individual or ZIP archives) from S3, validates and transforms them to unified CSV outputs, and writes per-file results to S3.

## Table of Contents

- [Features](#features)
- [Status](#status)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Region and S3 Key Pattern](#region-and-s3-key-pattern)
- [Vendor Mappings](#vendor-mappings)
- [Available Scripts](#available-scripts)
- [Mapping Operations](#mapping-operations)
- [Architecture](#architecture)
- [Data Output](#data-output)
- [Important Behaviors](#important-behaviors)
- [Cleaning Up](#cleaning-up)
- [Agent Tooling](#agent-tooling)
- [Configuration](#configuration)
- [AWS Deployment](#aws-deployment)
- [Troubleshooting](#troubleshooting)

## Features

- **ZIP Archive Support**: Process multiple JSON/HTML files from a single ZIP upload - all supported files are extracted and processed
- **Per-File Output, Then Regional Consolidation**: Each input file first produces its own independent CSV; a separate Coordinator Lambda then merges per-file CSVs for the same vendor/region into a `consolidated.csv`
- **Filename-Based Output Naming**: Output CSV named after input file stem under an `output/` prefix (e.g., `output/.../test-upload-1_processed.csv`)
- **Run ID Tracking (DynamoDB only)**: Each upload gets a unique UUID run ID recorded in DynamoDB for traceability — it is **not** embedded in the output/archive S3 key, so re-uploading the same S3 key overwrites the previous output CSV and archived ZIP
- **Path-Preserving Output**: Output keys preserve `file_type/channel/request_type` hierarchy from input, under an `output/` prefix
- **Re-upload Support**: Same S3 key can be uploaded multiple times, each creating a new DynamoDB run record, but writing to the same output/archive S3 key (overwrite, not coexistence)
- **Flexible JSON Input**: Accepts JSON arrays `[{...}]` or single objects `{...}`
- **HTML Selector Extraction**: Supports `document.querySelector(...)` / `document.querySelectorAll(...)` mapping sources with text/HTML/attribute accessors
- **Nested Field Extraction**: Supports dot notation for nested JSON paths (e.g., `data.data.rating_star`)
- **Per-File Mapping**: Each extracted file in ZIP can use different mapping based on filename rules with wildcard support
- **Custom Mapping Operations**: 49 pipe operations implemented, including `|mapurl`, `|currency`, `|gt`, `|flatten`, `|unique`, `|filter`, `|extract_field_to_array`, `|count_bullets_clean`, `|count_charactes_no_bullet` — see [Mapping Operations](#mapping-operations) for the full list
- **HTML Parser Performance Hardening**: Per-row DOM caching reduces repeated parsing overhead for large HTML ZIP workloads
- **Multi-Region Text Analysis**: Language-specific bullet-point and character counting for VN, ID, TH, PH
- **Validation & Error Reporting**: Per-row validation with detailed error reports
- **S3 Event-Driven**: Automatic processing triggered by S3 file uploads (S3 notifies SQS directly — no separate registration Lambda)
- **Partial Success**: Processes valid rows even if some rows fail validation
- **Dead Letter Queue**: Failed messages moved to DLQ after 2 retries

## Status

**Phase 11 Complete** - Per-file processing with regional consolidation and AWS production deployment

- Output CSV files named after input filename stem (no run ID suffix in the key)
- Each file produces its own per-file CSV; the Coordinator Lambda then merges per-file CSVs into a regional `consolidated.csv`
- Run ID (UUID) is tracked in DynamoDB per upload, but does **not** prevent S3 key collisions — re-uploading the same S3 key overwrites the previous output CSV and archived ZIP
- Successfully deployed to AWS (ap-southeast-1) with live end-to-end verification
- All Lambda functions, S3 buckets, DynamoDB tables, and SQS queues operational in production
- Processor Lambda currently runs with `timeout: 5 minutes`, `memorySize: 2560` (see `packages/infra/lib/filepipeline-stack.ts`)

For the detailed historical validation log (Lambda tuning history, per-channel AWS test runs, the processor module refactor), see `impldocs/PerFileConsolidationAndReupload.md`. Note: that document's description of run-ID-suffixed output/archive keys reflects the original March 2026 design and no longer matches current code — see [Region and S3 Key Pattern](#region-and-s3-key-pattern) for current behavior.

## Tech Stack

- **Lambda**: Node.js 20 runtime (AWS), Bun (local)
- **Database**: DynamoDB
- **Infrastructure**: AWS CDK (TypeScript)
- **Local Development**: LocalStack

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Docker](https://www.docker.com/) & Docker Compose
- Git

### 1. Install Dependencies

```bash
bun install
```

### Frontend Dashboard (new workspace package)

The SPA lives in `packages/frontend/dashboard` and is built independently from the Lambda pipeline. It's a read-only monitoring view — processing metrics, data-quality reports, and per-file status — served by `filepipeline-dashboard-api` (see [System Components](#system-components)). In production it's hosted from the `dashboard/` prefix of the processed S3 bucket behind CloudFront, with login via a Cognito Hosted UI (JWT-authorized API calls); `DASHBOARD_SEED_USER_EMAIL`/`DASHBOARD_SEED_USER_PASSWORD` (see [Configuration](#configuration)) can seed an initial user at deploy time.

```bash
bun run dev:dashboard
bun run build:dashboard
```

To upload the compiled static assets to a private S3 bucket for later CloudFront integration:

```bash
bun run deploy:aws:dashboard
```

This runs `sync:env` (pulls API/Cognito config from `packages/infra/cdk-outputs.json` into the dashboard's `.env`), builds, then uploads to S3. `FRONTEND_BUCKET_NAME`, `FRONTEND_BUCKET_PREFIX`, and `AWS_REGION` are already set in the committed `packages/frontend/dashboard/.env` (Bun loads it automatically) — edit that file directly rather than passing these inline. `AWS_PROFILE=filepipeline` is set by the root `deploy:aws:dashboard` script itself, not read from this `.env` file.

### 2. Start LocalStack

```bash
docker-compose up -d
```

Wait a few seconds for LocalStack to initialize.

### 3. Setup LocalStack Resources

```bash
bun run setup:localstack
```

This creates:

- S3 buckets: `filepipeline-incoming`, `filepipeline-processed`
- SQS queues: `filepipeline-queue`, `filepipeline-dlq`, `filepipeline-zip-check-delay`, `filepipeline-zip-check-dlq`
- DynamoDB tables:
  - `filepipeline-files`: File processing records
  - `filepipeline-vendor-batches`: Vendor batch accumulation for consolidation
  - `filepipeline-data-quality-locks`: Data-quality-checker run locks
  - Note: production also provisions `filepipeline-consolidation` (coordinator) via CDK — this is not currently created by `setup:localstack`
- S3 event notifications to SQS

### 4. Start Services

Open a terminal window:

**Terminal - Lambda Processor:**

```bash
bun run dev:lambda
```

This polls SQS and processes files locally.

> **Parity note**: `setup:localstack` does not provision `filepipeline-consolidation`, so the Coordinator's regional-consolidation merge cannot be exercised end-to-end locally today — only the Processor's per-file output can be tested via `dev:lambda`. The zip-output-checker's delay queue (`filepipeline-zip-check-delay`) _is_ provisioned by `setup:localstack` and can be exercised via `bun run dev:zip-checker`.

### 5. Upload Test Files

Seed sample test data:

```bash
bun run upload:local:test
```

> **Note**: This command automatically cleans DynamoDB tables before uploading to ensure a fresh test environment.

## Project Structure

```text
filepipeline/
├── packages/
│   ├── frontend/
│   │   └── dashboard/   # React SPA (Bun + Vite)
│   ├── infra/           # AWS CDK infrastructure
│   ├── lambda/          # Lambda functions
│   └── shared/          # Shared TypeScript types
├── mappings/            # Vendor JSON mapping configs
├── test-data/           # Sample JSON/ZIP files
├── scripts/             # Setup scripts
├── tools/               # Analysis and utility tools
├── docker-compose.yml   # LocalStack setup
└── impldocs/            # Implementation documentation
```

## Region and S3 Key Pattern

- AWS region for deployment and runtime is fixed to `ap-southeast-1`
- Input key pattern:
  - `file_type={file_type}/channel={channel}/request_type={request_type}/{filename}.zip`
- Processed output key pattern:
  - `output/file_type={file_type}/channel={channel}/request_type={request_type}/{filename}_processed.csv`
  - The run ID is tracked in DynamoDB only — it is not part of this key, so re-uploading the same input key overwrites the previous output CSV
- Archived input key pattern:
  - `archive/file_type={file_type}/channel={channel}/request_type={request_type}/{filename}.zip`
  - Same caveat — no run ID suffix, so re-uploading overwrites the prior archive

Where `file_type` is currently `json` or `html`.

## Vendor Mappings

Each vendor has a mapping config in `mappings/` (YAML) that defines how input fields map to output columns.
Mappings can reference nested JSON paths or HTML selector expressions and include validation metadata.
Operations can be appended to sources using `|` (e.g., `|date:YYYY-MM-DD`, `|mapurl:...`, `|currency`, `|filter:review.display_text.length>0`).

HTML source examples:

- `document.querySelector(".product-name").textContent`
- `document.querySelector("a.product-link").getAttribute("href")`
- `document.querySelectorAll(".bullet-item").length`

```json
{
  "columns": {
    "field_name": {
      "source": "path.to.input.field",
      "required": true,
      "type": "string",
      "default": "",
      "min": 0,
      "max": 999,
      "pattern": "^[A-Za-z0-9_-]+$"
    }
  }
}
```

### Adding a New Vendor Mapping

Each vendor directory under `mappings/` has an `index.json` that ties request types to mapping files, e.g. `mappings/711/index.json`:

```json
{
  "vendor": "711",
  "mappings": [
    { "id": "711-PDP-1", "name": "711 PDP v1", "file": "711-PDP-1.json", "description": "..." }
  ],
  "default": "711-PDP-1",
  "selectionRules": [
    { "requestType": "product-skus", "filename": "*.html", "mappingId": "711-PDP-1" }
  ]
}
```

To add a new vendor:

1. Create `mappings/<Vendor>/index.json` with a `vendor` name, at least one `mappings` entry, and a `default`
2. Add one mapping file per `id` (e.g. `mappings/<Vendor>/<Vendor>-PDP-1.json`) with the `columns` schema shown above
3. Add `selectionRules` entries to route specific `requestType`/`filename` patterns to the right mapping file
4. Run `bun run typecheck` and test locally via `upload:local:test` or the `local-zip-tester` agent (see [Agent Tooling](#agent-tooling))

See `impldocs/PathExtractionAndPerFileMapping.md` for the full design rationale behind per-file mapping selection and path extraction.

## Available Scripts

| Command                                          | Description                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `bun install`                                    | Install all dependencies                                                                                            |
| `bun run dev:lambda`                             | Start Lambda processor (polls SQS)                                                                                  |
| `bun run dev:dashboard`                          | Start the frontend dashboard locally                                                                                |
| `bun run setup:localstack`                       | Create LocalStack resources                                                                                         |
| `bun run deploy:aws`                             | Deploy CDK stack (Lambdas + backend infra) — does **not** deploy the frontend dashboard                             |
| `bun run deploy:aws:dashboard`                   | Upload frontend `dist/` to S3 — run separately after `deploy:aws` to publish the dashboard UI                       |
| `bun run teardown:aws`                           | Remove all AWS resources                                                                                            |
| `bun run upload:local:test`                      | Upload sample test files (includes ZIP)                                                                             |
| `bun run csv:excel -- <input.csv> <output.xlsx>` | Convert CSV to Excel (XLSX)                                                                                         |
| `bun run typecheck`                              | Type-check all packages                                                                                             |
| `bun run build`                                  | Build all packages                                                                                                  |
| `bun run format` / `bun run format:check`        | Format (or check formatting) with Prettier                                                                          |
| `bun run dev:lambda:restart`                     | Restart the local Lambda runner                                                                                     |
| `bun run dev:s3manager`                          | Launch the local S3 browser UI                                                                                      |
| `bun run query:local:dynamodb`                   | Dump `filepipeline-files`/`filepipeline-vendor-batches` — **LocalStack only** (defaults to `http://localhost:4566`) |

> **Note**: There is no automated test suite in this repo (no `*.test.ts` files) — correctness is verified via `typecheck`/`build` plus manual/agent-driven runs (see [Agent Tooling](#agent-tooling), [Troubleshooting](#troubleshooting)).

## Mapping Operations

Operations are appended to source paths using the pipe syntax `|`. 49 operations are implemented in total (`packages/lambda/src/processor/schema/operation/handlers/index.ts`); here are the most commonly used ones:

| Operation                          | Description                                                                                | Example                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `count_bullets_clean`              | Counts bullet-point lines (•, -, ●, –, ▪ — exact character set varies by region)           | `details\|count_bullets_clean`                    |
| `count_charactes_no_bullet`        | Counts characters after removing bullet lines                                              | `details\|count_charactes_no_bullet`              |
| `mapurl`                           | Template URL with placeholders (`{value}`, `{country}`, `{shopee_domain}`, and row fields) | `image\|mapurl:https://cdn.com/{country}/{value}` |
| `currency`                         | Convert country code to currency (e.g., vn → VND)                                          | `country\|currency`                               |
| `gt:value`                         | Filter rows where field > value                                                            | `rating\|gt:3.5`                                  |
| `length`                           | Get array/string length                                                                    | `items\|length`                                   |
| `flatten`                          | Flatten nested arrays                                                                      | `nested.items\|flatten`                           |
| `unique`                           | Remove duplicate values                                                                    | `tags\|unique`                                    |
| `filter:path>value`                | Complex filtering                                                                          | `images\|filter:size>1000`                        |
| `extract_field_to_array:fieldName` | Extract specific field from object array                                                   | `items\|extract_field_to_array:id`                |

**Note**: Bullet-point operations (`count_bullets_clean`, `count_charactes_no_bullet`) are automatically routed to language-specific implementations based on the country code extracted from the S3 path (vn, id, th, ph).

**Full list of implemented operation identifiers**, grouped by category:

- **String/text**: `capitalize`, `clean_product_description`, `clean_tiktok_product_description`, `concat`, `concat_field`, `join`, `split`, `count_bullets_clean`, `count_charactes_no_bullet`, `count_words`, `count_words_no_bullet`, `text_to_number`, `date`, `extract_from_square_brackets`, `extract_product_desc_images`, `json_stringify`, `null_if`
- **Boolean/equality/type-coercion**: `boolean_to_number`, `boolean_to_stock`, `boolean_to_text`, `eq`, `contain`, `not_contain`, `contain_image`, `gt`
- **Math/aggregation**: `divide`, `max`, `min`, `sum`, `rating_average`, `rating_text_to_number`
- **Array/collection**: `extract_field_to_array`, `filter`, `filter_by_prefix`, `filter_empty_strings`, `first`, `last`, `find`, `flatten`, `unique`, `unique_by_asset_hash`, `object_values`, `get`, `pair_with_separator`, `length`
- **URL/currency**: `mapurl`, `currency`
- **Vendor-specific transforms**: `transform_lazada_sku_name`, `transform_to_stock`

## Architecture

### System Components

| Lambda                                    | Trigger                                                 | Purpose                                                                                             |
| ----------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `filepipeline-processor`                  | SQS `filepipeline-queue` (S3 event on incoming bucket)  | Extract, parse, validate, write per-file CSV output; archive the source file                        |
| `filepipeline-coordinator`                | S3 event: `output/*.csv` created                        | Merge per-file CSVs into a regional `tagged_output/.../consolidated.csv`; invoke external egressors |
| `filepipeline-zip-output-checker-s3`      | EventBridge: `.zip` created on incoming bucket          | Schedule a one-shot delayed check for the new zip (SQS `DelaySeconds=300`)                          |
| `filepipeline-zip-output-checker-delayed` | SQS `filepipeline-zip-check-delay`, 5 min after arrival | Verify expected output exists for that zip; SendGrid alert if missing                               |
| `filepipeline-data-quality-checker`       | EventBridge cron, every 6h (`00/06/12/18 UTC`)          | Scan `output`/`tagged_output` for quality issues and write reports                                  |
| `filepipeline-email-summariser`           | EventBridge cron, daily `00:00 UTC`                     | Send a daily summary email of processing status (including FAILED/DLQ records)                      |
| `filepipeline-dashboard-api`              | API Gateway HTTP API (JWT-authorized, read-only)        | Serve metrics/data-quality/file-status data to the frontend dashboard                               |

See `impldocs/ARCHITECTURE.md` for the full system diagram and per-Lambda read/write details.

### Standalone Tools (`tools/`, outside the CDK stack)

Deployed independently (own `deployment.sh` per tool, not part of `FilePipelineStack`) — each moves data between the processed bucket and an external partner bucket, or ingests from outside:

| Tool                               | Direction                           | Watches / triggers               |
| ---------------------------------- | ----------------------------------- | -------------------------------- |
| `tools/external-ingestor`          | external → `filepipeline-incoming`  | SQS `<external-file-scan-queue>` |
| `tools/external-egressor`          | `filepipeline-processed` → external | `output/*.csv`                   |
| `tools/consolidation-egressor`     | `filepipeline-processed` → external | `tagged_output/*.csv`            |
| `tools/failed-processing-egressor` | `filepipeline-processed` → external | `failed_processing/*`            |
| `tools/metrics-egressor`           | `filepipeline-processed` → external | `metrics/*.json`                 |

Local/dev-only, no AWS runtime role: `tools/parser` (CLI preview of vendor JSON → CSV/XLSX), `tools/csv-to-excel`, `tools/ranking-calculator` and `tools/bullet-points` (Python), `tools/s3manager` and `tools/local-zip-testing` (LocalStack-only E2E helpers).

### Processing Flow

```text
S3 Incoming
  ↓ (S3 event: .zip created → SQS directly; no separate registration Lambda)
  SQS Queue (buffering)
    ↓
    Processor Lambda (100 concurrent)
     ├─ Create file record (QUEUED) if one doesn't already exist for this event
     ├─ Extract JSON/HTML from ZIP (if .zip file) or read directly
     ├─ Parse JSON (array or single object) or HTML (selector-based extraction)
     ├─ Select per-file mapping rules based on filename patterns
     ├─ Validate rows & extract nested fields
     ├─ Accumulate in DynamoDB batch
     └─ When file processing completes:
       └─ Write per-file CSV to S3 (`output/...`)
       └─ Update status: COMPLETED/PARTIAL/FAILED
       └─ Generate error report (if needed)
       └─ Archive original ZIP (same key on every upload — see Re-upload & Consolidation Behavior below)

    (If 2 receive attempts fail)
    └─► DLQ (filepipeline-dlq) → no automated consumer or replay tooling;
        requires manual re-upload of the source file to reprocess

DynamoDB (processor-owned)
├─ filepipeline-files: Individual file tracking
└─ filepipeline-vendor-batches: Per-run batch metadata and counters

S3 Output
├─ filepipeline-processed/
│  └─ output/file_type={file_type}/channel={channel}/request_type={request_type}/{filename}_processed.csv
│  └─ output/file_type={file_type}/channel={channel}/request_type={request_type}/{filename}.errors.json
│
├─ archive/ (input files, overwritten on re-upload — no run ID suffix)
│  └─ archive/file_type={file_type}/channel={channel}/request_type={request_type}/{filename}.zip
```

This diagram covers ingestion → per-file processing only. A separate Coordinator Lambda (`filepipeline-coordinator`) subsequently merges per-file CSVs from `output/` into regional `tagged_output/.../{region}/consolidated.csv` files. See `impldocs/ARCHITECTURE.md` for the full system diagram, which also covers the zip-output-checker, data-quality-checker, email-summariser, and dashboard-api components not shown here.

### Re-upload & Consolidation Behavior

- Re-uploading the same S3 key creates a new DynamoDB run record but **overwrites** the same output/archive S3 key — no coexistence (see [Region and S3 Key Pattern](#region-and-s3-key-pattern))
- Multiple files for the same vendor/region each produce independent per-file CSVs under `output/`, which the Coordinator Lambda later merges into a regional `tagged_output/.../{region}/consolidated.csv`

For the original per-file consolidation design rationale, see `impldocs/PerFileConsolidationAndReupload.md` (note: the run-ID-suffixed key format it describes has since been removed from the code).

## Data Output

Output files follow a per-file model; the Coordinator Lambda later merges per-file CSVs into a per-region consolidated CSV (see [Re-upload & Consolidation Behavior](#re-upload--consolidation-behavior) for an example):

```
S3 Processed Bucket
└─ output/file_type=json/channel={channel}/request_type={request_type}/
  ├─ {filename}_processed.csv            # Output CSV (overwritten if the same input key is re-uploaded)
  └─ {filename}.errors.json              # Per-file validation errors (if any)
└─ tagged_output/platform={Vendor}/.../{region}/
  ├─ consolidated.csv                    # Coordinator-merged output across per-file CSVs
  └─ metadata.csv
```

## Important Behaviors

- **Run ID Tracking**: DynamoDB-only — identifies each run in the `filepipeline-files` record and in logs, but is not part of any S3 key (see [Region and S3 Key Pattern](#region-and-s3-key-pattern))
- **Re-upload Support**: overwrites the same output/archive S3 key rather than creating a new one; only DynamoDB retains a record of every run (see [Re-upload & Consolidation Behavior](#re-upload--consolidation-behavior))
- **ZIP Archive Processing**: all supported files (`.json`, `.html`, `.htm`) inside a `.zip` are extracted and treated as belonging to that single ZIP, producing one per-file CSV; this allows uploading 100+ source files in a single ZIP for efficient bulk processing

For historical design rationale behind per-file consolidation and run tracking, see `impldocs/PerFileConsolidationAndReupload.md` (note: the run-ID-suffixed S3 key format it originally describes has since been removed from the code).

### Processor Module Layout (Current)

`packages/lambda/src/processor/`

- `parser/json/`: JSON streaming and parsing from ZIP/direct payloads
- `parser/html/`: HTML streaming and selector-based extraction
- `schema/`: mapping loader, path resolver, operations — see `impldocs/OperationModuleArchitecture.md` for the operation-handler module structure
- `validation/`: condition evaluator and row validator
- `output/`: CSV parser and row-to-CSV transformation

## Cleaning Up

Stop LocalStack:

```bash
docker-compose down
```

Remove LocalStack data:

```bash
docker-compose down -v
```

## Agent Tooling

This repo ships with Claude Code subagents for common operational tasks — invoke them via the Agent tool rather than running the underlying scripts by hand:

- **aws-deployer**: Deploys FilePipeline to AWS using the `filepipeline` profile, loading `.env.prod` credentials only if the identity pre-check fails. Use for deploy/redeploy/credential-refresh tasks.
- **local-zip-tester**: Ensures the local Lambda runner is active, uploads a given ZIP to trigger processing, waits for success/error, and audits the output CSV for field completeness.
- **zip-replayer**: Replays archived incoming ZIP events for a specific channel/request_type against AWS, waits for the processor queue to drain, and validates `output`/`tagged_output` freshness in `ap-southeast-1`.

## Configuration

### Environment Files

This repo has three separate env files, each scoped to a different concern — one does not flow into another:

- **`.env`** (repo root) — local dev / LocalStack only. Auto-loaded by `bun run setup:localstack`, `dev:lambda`, `upload:local:test`, `query:local:dynamodb`. Never read by `deploy:aws` or `create:aws:sendgrid-secret`.
- **`.env.prod`** (repo root) — real AWS deploy overrides. Explicitly loaded via `--env-file=.env.prod` by `bun run deploy:aws` and `bun run create:aws:sendgrid-secret` — see the table below for which specific variables actually flow through to the deployed stack via this file (most of `.env`'s local-only variables have no equivalent here, since they're either CDK-auto-derived or irrelevant to a real deploy).
- **[`packages/frontend/dashboard/.env`](packages/frontend/dashboard/README.md)** — a separate, package-scoped file for the dashboard SPA (bucket target, `AWS_REGION`, and `VITE_*` build-time values; `AWS_PROFILE` is set by the root `deploy:aws:dashboard` script itself, not stored in this file). Used both for local dev (`bun run dev:dashboard`) and for `bun run deploy:aws:dashboard`'s build/upload steps. See that package's own README for its full variable reference — its variables don't overlap with the table below.

Key environment variables (all optional — code falls back to sensible defaults unless noted). Never hardcode these values — see `.claude/rules/aws-security.md`.

| Variable                                                             | Used by                                                                          | Purpose                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                         | all                                                                              | Target AWS region (`ap-southeast-1`)                                                                                                                                                                                    |
| `AWS_PROFILE`                                                        | scripts, deploy                                                                  | Named AWS CLI/SDK profile                                                                                                                                                                                               |
| `AWS_ENDPOINT_URL`                                                   | scripts                                                                          | LocalStack endpoint override for local dev                                                                                                                                                                              |
| `INCOMING_BUCKET` / `PROCESSED_BUCKET`                               | processor, scripts (via root `.env`); `deploy:aws` + CDK stack (via `.env.prod`) | In `.env`: override bucket names for local dev tooling. In `.env.prod`: optional override for the actual deployed bucket names — if unset or blank, CDK derives `filepipeline-{incoming\|processed}-{account}-{region}` |
| `QUEUE_URL` / `DLQ_URL`                                              | processor (local runner)                                                         | SQS queue/DLQ URLs for the local Lambda runner                                                                                                                                                                          |
| `DATA_QUALITY_QUEUE_URL`                                             | data-quality-checker (local runner)                                              | SQS queue URL for local data-quality-checker runs                                                                                                                                                                       |
| `DYNAMODB_TABLE`                                                     | processor, email-summariser, dashboard-api                                       | `filepipeline-files` table name override                                                                                                                                                                                |
| `DATA_QUALITY_LOCK_TABLE`                                            | data-quality-checker                                                             | DynamoDB lock table name                                                                                                                                                                                                |
| `CONSOLIDATION_TABLE`                                                | coordinator, email-summariser, dashboard-api, setup script                       | `filepipeline-consolidation` table name override                                                                                                                                                                        |
| `ZIP_CHECK_QUEUE_URL`                                                | zip-output-checker (local runner)                                                | SQS delay queue URL for the local zip-output-checker runner                                                                                                                                                             |
| `DATA_QUALITY_LOCK_TTL_SECONDS` / `DATA_QUALITY_RETRY_DELAY_SECONDS` | data-quality-checker                                                             | Lock TTL and retry backoff                                                                                                                                                                                              |
| `QUALITY_CHECK_DATE`                                                 | data-quality-checker                                                             | Overrides the target date for a manual/backfill run                                                                                                                                                                     |
| `PROCESS_FILE_TIMEOUT_MS`                                            | processor                                                                        | Soft in-code processing deadline (default 20 min) — see [Troubleshooting](#troubleshooting)                                                                                                                             |
| `ENABLE_FEATURE1_VALIDATION` / `ENABLE_FEATURE1_ERROR_REPORT`        | coordinator (via root `.env` locally; `.env.prod` for real deploy)               | Toggle optional validation/error-report behaviors in the coordinator                                                                                                                                                    |
| `ENABLE_FEATURE2_VALIDATION` / `ENABLE_FEATURE2_ERROR_REPORT`        | processor (via root `.env` locally; `.env.prod` for real deploy)                 | Toggle optional validation/error-report behaviors in the processor                                                                                                                                                      |
| `SENDGRID_API_KEY` / `SENDGRID_SECRET_ID`                            | coordinator, email-summariser, zip-output-checker-delayed                        | Alert/summary email delivery — see `impldocs/ARCHITECTURE.md` §5 (Secrets management)                                                                                                                                   |
| `EXTERNAL_EGRESSOR_FUNCTION` / `CONSOLIDATION_EGRESSOR_FUNCTION`     | coordinator                                                                      | Names of the egressor Lambdas to invoke by name — hardcoded at CDK synth time (`filepipeline-stack.ts`), not configurable via any `.env` file                                                                           |
| `OFFICIAL_SHOP_LOOKUP_CSV_PATH`                                      | processor                                                                        | Override path for the official-shop reference CSV                                                                                                                                                                       |
| `METRICS_SCAN_SEGMENTS`                                              | dashboard-api                                                                    | Parallel DynamoDB scan segment count for metrics queries                                                                                                                                                                |
| `DASHBOARD_SEED_USER_EMAIL` / `DASHBOARD_SEED_USER_PASSWORD`         | infra (deploy-time, via `.env.prod`)                                             | Optional seed user for the Cognito-backed dashboard                                                                                                                                                                     |
| `DASHBOARD_AUTH_CALLBACK_URLS` / `DASHBOARD_AUTH_LOGOUT_URLS`        | infra (deploy-time, via `.env.prod`)                                             | Comma-separated Cognito Hosted UI redirect/logout URLs (defaults to `localhost:5173` + the CloudFront URL)                                                                                                              |
| `DASHBOARD_API_ALLOWED_ORIGINS`                                      | infra (deploy-time, via `.env.prod`)                                             | Comma-separated CORS origins allowed to call `filepipeline-dashboard-api` (same defaults as above)                                                                                                                      |
| `DEFAULT_COUNTRY_CODE`                                               | `scripts/seed-test-data.ts`                                                      | Default country for seeded test uploads                                                                                                                                                                                 |

## AWS Deployment

Deploy to real AWS for production use.

### AWS Prerequisites

- AWS CLI installed (`aws --version`; `brew install awscli` on Mac if missing)
- A named AWS CLI profile called `filepipeline` with credentials and proper IAM permissions — this is the profile every deploy/teardown script and the `aws-deployer` subagent expect (`AWS_PROFILE=filepipeline`, see `.claude/rules/deploy-safety.md`). Get the keys from whoever administers this AWS account (this tool cannot generate them), then set them directly, no prompts:
  ```bash
  aws configure set aws_access_key_id <your-access-key-id> --profile filepipeline
  aws configure set aws_secret_access_key <your-secret-access-key> --profile filepipeline
  aws configure set aws_session_token <your-session-token> --profile filepipeline  # only if issued temporary/session credentials
  aws configure set region ap-southeast-1 --profile filepipeline
  ```
  Verify with `AWS_PROFILE=filepipeline aws sts get-caller-identity` — should print your account ID/ARN, not `ExpiredToken`/`InvalidClientTokenId`.
- `.env.prod` populated at the repo root with `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`/`AWS_REGION` — `bun run deploy:aws` (`scripts/deploy.ts`) falls back to these if the `filepipeline` profile's identity check fails, same as the `aws-deployer` agent (see [Agent Tooling](#agent-tooling))
- CDK bootstrapped in your account/region: `npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-1`
- Target region: `ap-southeast-1` (Singapore)
- **On a fresh AWS account, the `filepipeline/sendgrid-api-key` secret must exist in Secrets Manager before the first deploy**: `bun run create:aws:sendgrid-secret <key>`. `deploy:aws` only _reads_ this secret — it never creates it — and exits immediately, before any build/bootstrap/CDK step, if the secret is missing or unreadable (see `impldocs/ARCHITECTURE.md` §5).

### Deploy

```bash
# First deploy on a fresh account only — deploy:aws will fail without this secret already present
bun run create:aws:sendgrid-secret <your-sendgrid-api-key>

bun run deploy:aws
```

Claude Code shortcut: invoke the `aws-deployer` subagent (see [Agent Tooling](#agent-tooling)) to run the same deployment workflow with identity pre-check and guided credential refresh.

This will:

1. Build Lambda functions for Node.js 20
2. Bootstrap CDK environment (if needed)
3. Deploy CloudFormation stack
4. Output resource names and CloudWatch log group URLs

> **`deploy:aws` does not deploy the frontend dashboard.** It only deploys the CDK stack — the Lambda pipeline plus the dashboard's backend infra (API Gateway, Cognito User Pool/Hosted UI, CloudFront distribution, and the optional `DASHBOARD_SEED_USER_EMAIL`/`DASHBOARD_SEED_USER_PASSWORD` seed user). The compiled dashboard SPA assets are a separate build/upload step.
>
> **Order matters: run `deploy:aws` before `deploy:aws:dashboard`.** The Cognito User Pool, Hosted UI domain, seed user, and CloudFront distribution all only exist after `deploy:aws` completes — `deploy:aws:dashboard`'s `sync:env` step reads their IDs/URLs out of `packages/infra/cdk-outputs.json`, which is only generated once the CDK stack has deployed. Running `deploy:aws:dashboard` first will fail (or deploy against stale/missing config).

### Verify Deployment

After deployment, test the end-to-end flow:

```bash
export AWS_PROFILE=filepipeline

# 1. Upload a test file
aws s3 cp test-data/file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip \
  s3://filepipeline-incoming-{account-id}-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/test.zip

# 2. Wait for processing (5-10 seconds)
sleep 10

# 3. Check CloudWatch logs
aws logs tail /aws/lambda/filepipeline-processor --since 5m

# 4. Verify CSV was created
aws s3 ls s3://filepipeline-processed-{account-id}-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/ --recursive

# 5. Download and inspect CSV
aws s3 cp \
  s3://filepipeline-processed-{account-id}-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/test_processed.csv \
  /tmp/output.csv

# 6. Re-upload same file to confirm re-processing works (this OVERWRITES the same
#    output CSV — it does not create a second, run-ID-suffixed file)
aws s3 cp test-data/file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip \
  s3://filepipeline-incoming-{account-id}-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/test.zip

# Only one output CSV will be listed; check the filepipeline-files DynamoDB table
# (via the dashboard or AWS Console) to confirm two separate run records were created
aws s3 ls s3://filepipeline-processed-{account-id}-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/ --recursive \
  | grep "test_processed"
```

Recent production test objects:

- `file_type=json/channel=lazada/request_type=product-skus/20260226T053000_PRODUCT_DETAILS_LAZADA_DS_1_retry1.zip`
- `file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip`
- `file_type=json/channel=tiktok/request_type=username-products/TikTok_products_daily_ID-MY-VN-PH-TH_1x_dalat_2026-03-05_00_10.zip`

All 3 produced processed CSV outputs successfully in the AWS processed bucket.

### Teardown

Remove all AWS resources:

```bash
bun run teardown:aws
```

This runs `cdk destroy` for the CloudFormation stack (no build step) and deletes all associated resources.

### View CloudWatch Logs

Lambda logs are available in CloudWatch:

- Processor: `/aws/lambda/filepipeline-processor`
- Coordinator: `/aws/lambda/filepipeline-coordinator`

## Troubleshooting

### A ZIP file stays in `incoming/` and is never archived

This only happens when an exception is thrown before the archive step, or the archive copy itself silently fails. Common causes:

- Malformed/unreadable content, or missing/broken vendor mapping config — immediately marked `FAILED` in DynamoDB (`MalformedFileError` / `MissingMappingError` / `ValidationConfigError`, `packages/lambda/utils/errors.ts`)
- Retryable errors (S3/DynamoDB errors, mixed parser types in one zip, the soft `PROCESS_FILE_TIMEOUT_MS` deadline) — retried up to 2 times, then marked `DLQ` in DynamoDB
- A hard Lambda crash/timeout — no code runs at all; the file record stays `PROCESSING` indefinitely
- The final archive `moveObject` copy itself fails — only logged as a `console.warn`, never re-thrown (`packages/lambda/src/processor/index.ts`); the file's DynamoDB status can show `COMPLETED` even though the ZIP was never archived

Note: zero valid output rows still results in a `FAILED` status, but that case _does_ still get archived — it's a completed run, not an aborted one.

### Messages in the DLQ (`filepipeline-dlq`)

There is currently **no automated consumer, alarm, or redrive tooling** for the DLQ. Recovery is manual:

1. Check the `filepipeline-files` DynamoDB table for records with `status = "FAILED"` or `"DLQ"` (or wait for the daily email-summariser digest). Locally, `bun run query:local:dynamodb` dumps this table directly (LocalStack only — see [Available Scripts](#available-scripts)); against production, use the dashboard or AWS Console
2. Inspect CloudWatch logs (`/aws/lambda/filepipeline-processor`) for the root cause
3. If it's a bad file or mapping bug, fix the underlying mapping/data first
4. Re-upload the original source file to the same S3 key to re-trigger ingestion — there is no `StartMessageMoveTask`/redrive script in this repo yet

A DLQ message expires after 14 days (SQS's own retention max) with no alarm in front of it, so don't rely on noticing a stuck file passively — check DynamoDB or CloudWatch directly if a channel's output looks stale.
