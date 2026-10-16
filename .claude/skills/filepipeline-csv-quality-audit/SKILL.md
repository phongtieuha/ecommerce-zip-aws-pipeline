---
name: filepipeline-csv-quality-audit
description: "Run fast field-level quality audits on FilePipeline CSV files. Use when: checking null or empty counts, sentinel values such as -1 or 0, and post-mapping regression checks or users ask to audit a csv file. Do not use for full statistical profiling."
---

# FilePipeline CSV Quality Audit

## Use When

- User asks whether any column is null or empty
- User asks for sentinel-value checks (`-1`, `0`, or exact value checks)
- User asks for cross-field consistency checks (for example `num_images` vs `image_urls` length, `num_vid` vs `video_urls` length)
- User asks for before/after price consistency checks (for example `price_max_before_discount` should be `>=` matching `price_max_after_discount`)
- Regression validation after parser or mapping changes

## Do Not Use

- Full exploratory data analysis
- Binary file validation
- Schema migration design

## Workflow

1. Reuse the committed audit script at `tools/local-zip-testing/audit-csv.py` and pass only the target CSV path (it auto-locates the source zip under `test-data/`; pass `--zip <path>` only if that lookup fails). It takes no column-name argument. It covers required-field completeness (missing columns, resolved from the channel/request-type mapping), the `num_images`/`image_urls` and `num_vid`/`video_urls` cross-checks, and before/after price-pair checks.
2. `audit-csv.py` does not do arbitrary per-column null/empty or sentinel-value counting (steps 3-6 below) — for those, read the CSV directly (e.g. Python's `csv` module) rather than creating a new persisted audit script for a one-off check.
3. Validate requested column exists.
4. If column name appears misspelled, check likely close match and report substitution clearly.
5. Count null or empty values using policy: missing field or empty string.
6. Count exact sentinel matches when requested.
7. When requested, run cross-field checks:
   - `num_images` equals length of `image_urls`
   - `num_vid` equals length of `video_urls`
8. When requested, run paired `_before_*` vs `_after_*` checks:
   - For each requested pair, validate `<field>_before_<suffix> >= <field>_after_<suffix>` (infix naming, e.g. `price_max_before_discount`/`price_max_after_discount`)
   - Report total violating rows and which field pairs violated
9. Return concise result and sample indicators only when user asks for samples.

## Output Format

1. One-line verdict first.
2. Exact count.
3. Null policy used.
4. Column-substitution note when applicable.

## Safety

- Do not modify source CSV.
- Do not expose unrelated row content unless explicitly requested.
