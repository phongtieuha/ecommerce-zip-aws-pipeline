// Utility to extract and normalize date from various vendor file names.
// Returns date in YYYY-MM-DD format or null if not found.
//
// Delegates to the shared extractor (@filepipeline/shared/utility/date-extraction)
// so this stays in sync with the equivalent extractors in utils/s3.ts and
// processor/index.ts. This file previously had its own duplicated copy that
// fell behind — supporting only 2 of the 3 recognized date formats and
// skipping calendar-date validation — which silently dropped files using the
// missing formats from the consolidated CSV (see coordinator/index.ts's S3
// handler, which `continue`s past a file whose date can't be normalized).

export { extractDateFromFilename as extractNormalizedDate } from "@filepipeline/shared/utility/date-extraction";
