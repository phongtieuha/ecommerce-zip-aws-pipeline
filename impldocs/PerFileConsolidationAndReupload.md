# Per-File Consolidation and Reupload

**Date**: March 11, 2026 (rewritten 2026-07-30 to describe current behavior only)
**Status**: Implemented
**Project**: FilePipeline

---

## Summary

Each uploaded file (a `.zip` archive, or a bare `.json`/`.html` file) is tracked as its own `FileRecord` in the `filepipeline-files` DynamoDB table, keyed by its S3 key. Processing a file produces one independent output CSV — a file's rows are never merged with another file's rows at this stage. (Regional consolidation across multiple files happens later, in the Coordinator Lambda — see `impldocs/ARCHITECTURE.md`.)

Re-uploading the same S3 key does not create a new record or a new output. It reuses the existing `FileRecord` and overwrites the previous output CSV and archived ZIP in place.

---

## File Record Lifecycle

- **New S3 key**: `getFileByS3Key(s3Key)` finds nothing, so a new `FileRecord` is created with a fresh UUID `id` and `status: "QUEUED"`.
- **Re-upload of an existing S3 key**: if the existing record's status is `COMPLETED`, `PARTIAL`, `FAILED`, or `DLQ`, the same record is reused — `updateFileRecord(fileRecord.id, { status: "QUEUED", rowCount: 0, successCount: 0, errorCount: 0, errors: [], ... })` resets it in place rather than creating a second record.
- There is only ever one `FileRecord` per S3 key. `getFileByS3Key()` (`packages/lambda/utils/dynamodb.ts:103-125`) queries and returns that single record.

Source: `packages/lambda/src/processor/index.ts` (around lines 929-1009).

---

## Output and Archive Keys

- Output CSV: `output/{same path structure as input}/{filename-stem}_processed.csv` — built by `buildConsolidatedOutputKey()` (`packages/lambda/utils/s3.ts`).
- Archived source ZIP: `archive/{same path structure as input}/{original filename}` — built by `buildArchiveKeyFromIncomingKey()` (same file).

Both keys are derived only from the input path and filename. Re-uploading the same input key produces the exact same output/archive keys, so each re-upload **overwrites** the prior CSV and archived ZIP rather than coexisting alongside it. Nothing in S3 preserves a history of earlier runs — only the `FileRecord`'s `updatedAt`/`queuedAt` timestamps change.

---

## Per-File Batch Isolation

To keep each file's rows in their own CSV — rather than merging with other files uploaded for the same vendor/date — DynamoDB batch accumulation is keyed by `{country}#{vendor}#{date}#{fileRecord.id}` (`getBatchKey()`, `packages/lambda/utils/dynamodb.ts`). Using the file record's own `id` as part of this key is what makes per-file consolidation work: two different files uploaded on the same day for the same vendor get two distinct batch keys, and therefore two distinct output CSVs.

---

## Related

- `impldocs/ARCHITECTURE.md` — full system diagram; see the Notes section for this same re-upload/overwrite behavior called out at the system level.
- `impldocs/OperationModuleArchitecture.md`, `impldocs/PathExtractionAndPerFileMapping.md` — other processor-internals docs.

---

## Changelog

### 2026-03-23

- Processor internals refactored into domain folders (`parser`, `schema`, `validation`, `output`); no behavior change.

### 2026-07-30

- Rewrote this doc to describe current behavior only. The previous version documented a run-ID-suffix design intended to make output/archive keys collision-free and to preserve every re-upload as a separate output — that design was never fully wired into the S3 key builders (the parameter exists but is unused) and is not covered here.
