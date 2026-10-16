# Path Extraction and Per-File Mapping (Essential)

**Date**: March 3, 2026  
**Status**: Completed  
**Project**: FilePipeline

---

## Summary

Implemented two core improvements for mixed JSON ZIP uploads:

1. **Path extraction per mapping**
   - Supports extracting nested data with a configured path (e.g. `data.centralize_item_card.item_cards`).
2. **Per-file mapping inside ZIP**
   - Each JSON file in a ZIP is mapped independently using filename rules (including wildcard support).

Result: mixed Shopee ZIP now processes correctly into one per-file consolidated CSV with expected rows and populated PDP fields.

Current production conventions this work operates under:

- Region: `ap-southeast-1`
- Input key pattern: `file_type=json/channel={channel}/request_type={request_type}/{filename}.zip`
- Output key pattern (as described at the time of this doc): `file_type=json/channel={channel}/request_type={request_type}/{filename}_processed_{runId}.csv`

**Note (2026-08-24)**: The run-ID-suffixed output key format above reflects the original design and no longer matches current code. `buildConsolidatedOutputKey()` (`packages/lambda/utils/s3.ts`) now produces `file_type=json/channel={channel}/request_type={request_type}/{filename}_processed.csv` with no `runId` suffix — the `runId` parameter still exists on the function signature but is unused. See `impldocs/PerFileConsolidationAndReupload.md` for the current, accurate description of output/archive key behavior.

---

## Problem

- Mixed Shopee ZIP contains many JSON files with nested paths, for example:
  - `.../year=2026/month=03/date=04/id/1517647103_04-03-2026_08-09-55_8f9f313b.json`
  - `.../year=2026/month=03/date=04/id/1517647103_04-03-2026_08-10-10_c9a24c83.json`
  - `.../year=2026/month=03/date=04/id/1517647103_04-03-2026_08-10-11_9e0bb46e.json`
- Shopee payloads follow the key pattern:
  - `file_type=json/channel=shopee/request_type=shop-products/{filename}.zip`
  - Internal JSON files still require per-file mapping and optional path extraction.
- Previous flow selected one mapping for the whole ZIP, causing PDP rows to be transformed with the wrong schema.
- Also introduced fallback behavior for path-extraction results (see "Path Extraction Fallback" below).

---

## What Changed

### 1) Mapping Configuration

Production configuration in `mappings/Shopee/index.json`. The index requires a top-level `mappings` array enumerating each mapping's `id`/`name`/`file`/`description` — `mapping-loader.ts:106` throws `ValidationConfigError` if this field is missing or not an array:

```json
{
  "vendor": "Shopee",
  "mappings": [
    {
      "id": "Shopee-PDP-1",
      "name": "Shopee PDP (Product Detail Page) v1",
      "file": "Shopee-PDP-1.json",
      "description": "Standard product detail page mapping with populated source fields"
    },
    {
      "id": "Shopee-PDP-3",
      "name": "Shopee PDP (Product Detail Page) v3",
      "file": "Shopee-PDP-3.json",
      "description": "Standard product detail page mapping with populated source fields"
    },
    {
      "id": "Shopee-Products",
      "name": "Shopee Products Schema",
      "file": "Shopee-Products.json",
      "description": "Products schema with empty source fields (template)"
    },
    {
      "id": "Shopee-Products-2",
      "name": "Shopee Products Schema v2",
      "file": "Shopee-Products-2.json",
      "description": "Feature 2"
    }
  ],
  "default": "Shopee-PDP-3",
  "selectionRules": [
    {
      "requestType": "shop-products",
      "filename": "*/{id|sg|ph|cn|tw|vn|th|my}/*.json",
      "mappingId": "Shopee-Products"
    },
    {
      "requestType": "product-skus",
      "zipFilename": "*Shopee-Product-SKU-MG-TW-*",
      "filename": "*/{tw}/*/*.json",
      "mappingId": "Shopee-PDP-3"
    },
    {
      "requestType": "product-skus",
      "zipFilename": "*SHOPEE__PRODUCT_SKUS__*__DS*__TM__*",
      "zipFilenameDateFrom": "2026-08-21",
      "filename": "*/{id|sg|ph|cn|tw|vn|th|my}/*/*.json",
      "mappingId": "Shopee-PDP-1"
    },
    {
      "requestType": "product-skus",
      "zipFilename": "*SHOPEE__PRODUCT_SKUS__*__DS*__{MG|TM}__*",
      "filename": "*/{id|sg|ph|cn|tw|vn|th|my}/*/*.json",
      "mappingId": "Shopee-PDP-3"
    },
    {
      "requestType": "product-skus",
      "filename": "*/{id|sg|ph|cn|tw|vn|th|my}/*/*.json",
      "mappingId": "Shopee-PDP-1"
    },
    {
      "requestType": "keyword-products",
      "filename": "*/**/{id|sg|ph|cn|tw|vn|th|my}/*.json",
      "mappingId": "Shopee-Products-2"
    }
  ]
}
```

There are 6 selection rules: a `shop-products` rule; a `product-skus` rule scoped by `zipFilename` that routes TW-specific MG archives to `Shopee-PDP-3`; a `product-skus` rule additionally gated by `zipFilenameDateFrom` that routes `DS`+`TM`-tagged archives dated on/after 2026-08-21 to `Shopee-PDP-1` (see "2026-09-04 fix" in the Changelog below); the general `product-skus` rule scoped by `zipFilename` that routes remaining `DS`+`MG`/`TM`-tagged archives to `Shopee-PDP-3`; the unscoped `product-skus` rule; and a `keyword-products` rule. Rules are evaluated in order and the first match wins, so the date-gated rule must be listed ahead of the older unconditional `{MG|TM}` rule it partially supersedes. The region alternation is `{id|sg|ph|cn|tw|vn|th|my}`. Note the index's `default` is currently `Shopee-PDP-3` (used only when no `mappingId` is explicitly passed and no selection rule matches), not `Shopee-PDP-1` as in an earlier revision of this mapping.

Path extraction in `mappings/Shopee/Shopee-Products.json`:

```json
{
  "pathExtraction": {
    "path": "data.centralize_item_card.item_cards || centralize_item_card.item_cards"
  }
}
```

The `||` separates fallback path candidates — each alternative is tried in order and the first one resolving to a non-null value is used.

### 2) ZIP Processing Model

**Before**: merge all files → choose one mapping → process all rows  
**After**: extract each file → choose mapping per file → process each file → merge validated rows

### 3) Wildcard Filename Matching

- Added `*` wildcard support in selection rules.
- Added request-type aware rule matching (`shop-products`, `product-skus`) to avoid cross-schema mapping.
- Selection rules can also scope by `zipFilename` — matched against the ZIP archive's own filename rather than the per-entry path (`mapping-loader.ts:22`, `parser/json/index.ts:199-202`). Used e.g. to route TW-specific or `DS`+`MG`-tagged Shopee archives to a different mapping ahead of the general `product-skus` rule.
- A rule can further be gated by `zipFilenameDateFrom` (`packages/lambda/src/processor/parser/types.ts`, `extractDateFromZipFilename`/`selectMappingForFile` in `parser/json/index.ts:180-225`) — an inclusive lower bound (`YYYY-MM-DD`) on the `YYYYMMDDTHHMMSS` timestamp embedded in the zip filename. A rule with this field only matches zips dated on/after that date; older zips fall through to later rules. Used to encode a known upstream schema-change cutover without needing content-based sniffing (see "2026-09-04 fix" in the Changelog below).
- First matching rule wins.

### 4) Path Extraction Fallback

- If a mapping has **no `pathExtraction` config at all**, each row is kept as-is (passed through unchanged).
- If a mapping **has `pathExtraction.path` configured** but it resolves to `undefined`/`null` for a given row, that row is **dropped/skipped**: "no data at this path means no output row" (`packages/lambda/src/processor/index.ts:1370-1377`) — this avoids producing garbage/empty CSV rows.
- If the configured path instead resolves to a scalar (string, number, etc.), extraction throws an error rather than silently passing the row through.

### 5) Per-File Region Extraction (`extractRegionFromPath`)

Alongside `filename`, `data`, and `mappingId`, each extracted JSON file also carries a `region` derived from its own zip entry path by `extractRegionFromPath` (`packages/lambda/src/processor/parser/json/index.ts:222-260`). This feeds `runtimeContext.s3.country` (`packages/lambda/src/processor/index.ts:~1230-1270`, `file.region || effectiveCountry`), which mapping fields read via the `$s3.country` default — the sole region source for mappings whose `region` column has an empty `source` (e.g. `mappings/Tiktok/Tiktok-Products.json`, used for `request_type=username-products`).

**2026-08-30 fix**: the original implementation scanned every path segment left-to-right and returned the _first_ one that normalized to a known region code (`id/my/ph/sg/th/tw/vn/cn`). For zips whose entries are nested under a wrapper folder that repeats the batch/zip's own name (e.g. `TikTok_products_daily_VN_6x_dalat_2026-08-17_22_10/Mobile_Price_Lite/SG_shops/colgate_singapore/...json`), that wrapper segment's embedded country token (`VN`, from the batch name) won over the correct, deeper `SG_shops` segment — mislabeling every row in the zip with the wrapper's region regardless of which per-shop country folder it actually lived in. One archived zip had ~80% of 8075 rows mislabeled this way.

The fix makes the function prefer a segment that _is_ a region code as a whole (optionally suffixed `_shops`/`-shops`, e.g. `SG_shops`) across all segments before falling back to the original loose token-scan — so a purpose-built region folder deeper in the path wins over an incidental region-like word embedded in an unrelated multi-word segment. Verified against local test fixtures and real archived S3 samples: only previously-mislabeled rows changed, no regressions elsewhere. Note this is **not predictable from the zip's filename or naming convention alone** — two archives with an identical S3 naming pattern (down to the same day) can differ in whether their internal entries carry the wrapper-folder prefix, depending on how the zip was packaged upstream at creation time.

### 6) Additional `pathExtraction` Options

Beyond `path`, the `pathExtraction` config (`packages/shared/src/types/vendor-mapping.ts:116-141`, validated in `packages/lambda/src/processor/schema/mapping-loader.ts:171-263`) supports:

- **`scriptExpression`**: a JS expression evaluated against the contents of `<script>` tags in an HTML document, with inline scripts pre-executed in a sandboxed VM (`window`/`document` stubs). Used in place of `path` for HTML-sourced mappings; the result must be an array of objects, and the extracted rows are then resolved with the JSON dot-path resolver rather than CSS selectors (`processor/index.ts:1266-1301`).
- **`ignoreIfContains`**: an array of `{ path, text, caseInsensitive? }` rules checked against each extracted row; a row matching any rule is dropped before reaching the output — used for content-based filtering (e.g. excluding placeholder/error payloads).
- **`deduplicateByTimestamp`**: a `{ pattern, keywordPath? }` config that deduplicates files (not rows) within a ZIP by keyword + timestamp, extracted via a regex with at least two capture groups; when multiple files share a keyword, only one is kept for processing (`processor/index.ts:1146-1165`).

---

## Key Code Areas

- `packages/lambda/src/processor/parser/json/index.ts`
  - Returns extracted files with `filename`, `data`, resolved `mappingId`, and `region` (see "Per-File Region Extraction" above)
  - Adds filename pattern matching (`*.json`)
- `packages/lambda/src/processor/index.ts`
  - Processes ZIP entries file-by-file with their own mappings
  - Applies path extraction only when mapping config includes it
- `packages/shared/src/types/vendor-mapping.ts`
  - Adds optional `pathExtraction` config to mapping type
- `packages/lambda/src/processor/schema/mapping-loader.ts`
  - Validates `pathExtraction` when present, including `path`, `scriptExpression`, `ignoreIfContains`, and `deduplicateByTimestamp` (see "Additional `pathExtraction` Options" above)

---

## HTML Parser Details

HTML input support is implemented in the same processor pipeline and is used for channels where source data arrives as ZIP archives containing `.html` or `.htm` files.

### HTML Pipeline Components

- `packages/lambda/src/processor/parser/html/index.ts`
  - `streamHTMLFromZip()` scans ZIP entries, filters HTML files, applies per-file mapping selection rules, and yields one extracted file payload at a time.
  - `parseHTML()` wraps each HTML document into a row object containing `__html`, `html`, and basic metadata (`title`).
- `packages/lambda/src/processor/parser/html/path-resolver.ts`
  - Resolves mapping `source` fields written as `document.querySelector(...)` or `document.querySelectorAll(...)` expressions.
  - Supports operations chaining through the shared operation engine in `processor/schema/operation/` (`index.ts` dispatch, `handlers/*.ts`).

### Supported HTML Source Expressions

The resolver supports these forms:

- `document.querySelector(".selector")`
- `document.querySelector(".selector").textContent`
- `document.querySelector(".selector").innerText`
- `document.querySelector(".selector").innerHTML`
- `document.querySelector(".selector").outerHTML`
- `document.querySelector(".selector").getAttribute("href")`
- `document.querySelectorAll(".selector").length`

It also supports fallback chains in mapping fields:

- `sourceA || sourceB || sourceC`

and operation pipes:

- `document.querySelector(".price").textContent|text_to_number`

### Performance Hardening: DOM Caching

During 711 replay testing, product-skus HTML archives repeatedly timed out in Lambda even though ZIP size was smaller than Watsons JSON archives. Root cause was repeated DOM parsing (`cheerio.load`) for the same HTML document across many field lookups.

Implemented optimization:

- Added a per-row `WeakMap<Record<string, unknown>, CheerioAPI>` cache in `parser/html/path-resolver.ts`.
- Each HTML row is parsed once, then reused for all selector resolutions on that row.

Impact:

- Eliminated repeated parse overhead in hot loops.
- Stabilized processing for large-entry HTML ZIP workloads.

### Validation Outcome (AWS)

After deploying the cache optimization and replaying only 711 `product-skus`:

- All replayed files transitioned to `COMPLETED` (previously stuck in `PROCESSING`/retry cycles).
- CSV outputs were generated successfully for each replayed file.
- Output row counts and file sizes were consistent with expected non-empty extraction.

This confirms HTML parser support is production-ready for current 711-style selector mappings, with improved timeout resilience.

---

## Verified Output

For current AWS Shopee test upload:

- Input ZIP: `file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip`
- Status: **COMPLETED**
- Output rows: **14,003**
- Errors: **0**
- Output CSV written to processed bucket (at the time of this test, using run-id naming; current code no longer appends a run-id suffix — see the note under "Current production conventions" above):
  - `file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04_processed_{runId}.csv`

Per-file mapping and path extraction rules are applied at JSON-entry level based on filename pattern and request type.

---

## Runbook (Quick Verify)

```bash
# Local verify
bun run setup:localstack
bun run --filter @filepipeline/lambda build
bun run upload:local:test
bun run dev:lambda
```

AWS quick verify (current path model):

```bash
export AWS_PROFILE=filepipeline
export AWS_REGION=ap-southeast-1

aws s3 cp \
  test-data/file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip \
  s3://filepipeline-incoming-682120331784-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/nike_shopee_shop-products_daily_unity-colossus_2026-03-04.zip

aws s3 ls \
  s3://filepipeline-processed-682120331784-ap-southeast-1/file_type=json/channel=shopee/request_type=shop-products/ \
  --recursive
```

---

## Final Notes

- This implementation supports mixed file types in one ZIP without hardcoding vendor-specific fallback logic.
- Mapping behavior is now explicit and maintainable via `selectionRules` + mapping-level `pathExtraction`.
- This behavior is compatible with the path-preserving S3 key structure; output keys no longer carry a run-id suffix (see note above).

See also:

- [impldocs/ContainImageOperation.md](impldocs/ContainImageOperation.md) for the detailed detection logic of the `contain_image` mapping operation used in operation chains.

---

## Changelog

### 2026-10-02

- **Bug**: TikTok `product-skus` zips dated on/after 2026-09-24 moved the product payload up one level inside the `Tiktok-PDP-3` component: `component_data.product_info.product_model` is now empty and the fields live directly on `component_data.product_info` (`product_id`, `title`, `seller_id`, `seller.name`, `sold_count`, `images`, `review`, `price`, `desc_blocks`, `skus`). SKUs carry their own `price.{sale,origin}_price_decimal` and a numeric `stock` instead of `promotion_model.promotion_product_price.skus_price[...]` and `sku_quantity.available_quantity`. `rowExpansion` found no SKUs, so 2026-09-25…09-30 zips failed with `ZERO_OUTPUT_ROWS` and the transition-day 2026-09-24 zip (1,025 old-format + 23,403 new-format entries) produced only 4,476 rows.
- **Fix**: appended new-shape `||` fallbacks to the existing sources in `mappings/Tiktok/Tiktok-PDP-3.json` (and `product_info.skus` to `rowExpansion.arrayPath`) instead of adding a date-gated mapping — fallbacks resolve per entry, so the mixed-format 2026-09-24 zip works without a selection-rule change and old-format resolution is unchanged. `stock` now reads `$expansion.sku_quantity.available_quantity || $expansion.stock`, because the previous first alternative (`$expansion.stock|gt:0|boolean_to_stock`) would have turned the new numeric `stock` into the `999` sentinel. Verified locally: 2026-09-30 → 73,343 rows (was 0), 2026-09-24 → 73,227 rows (was 4,476); identity columns match 2026-09-22 old-format output for 1,344 overlapping SKUs. See `TIKTOK_PDP_SCHEMA_FIX.md`.

### 2026-09-16

- **Bug**: TikTok's `username-products` and `product-skus` exports both moved to a flatter JSON shape for zips dated on/after 2026-09-02 — the same class of upstream schema-change cutover as the Shopee case below. `username-products`: `data.product_list_map['Store.Product_Page_Feeds.Single'].product_list` instead of the older `data.products.product_list_map['Showcase.Profile_Page_Showcase_Feeds.Common']` wrapper (no `Mobile_Price_Lite`/`{XX}_shops` wrapper). `product-skus`: a Remix/Next.js-style route-loader structure, `loaderData['(product_name_slug$)/(product_id)/page'].page_config.components_map[N].component_data.product_info` (`N` located via `filter:component_type==product_info`), instead of `Tiktok-PDP-1`'s `data.product_details[0]` or `Tiktok-PDP-2`'s `product_details.goda_protocol.global.product_info_resp.products[0]`. Because the existing unconditional filename rules routed all such zips to `Tiktok-Products`/`Tiktok-PDP-1` regardless of date, post-cutover zips would have failed the same way the Shopee case did (path extraction returning nothing against the new shape).
- **Fix**: added two new mappings — `Tiktok-Products-2` (`mappings/Tiktok/Tiktok-Products-2.json`) and `Tiktok-PDP-3` (`mappings/Tiktok/Tiktok-PDP-3.json`, column sources otherwise copied from `Tiktok-PDP-1`, which already carried matching `product_model`/`seller_model`/`promotion_model`/`review_model` fallback paths) — plus two new `selectionRules` entries in `mappings/Tiktok/index.json`, each gated with `zipFilenameDateFrom: "2026-09-02"` ahead of the existing unconditional rules, mirroring the `zipFilenameDateFrom` mechanism introduced for the Shopee cutover below. `Tiktok-PDP-3`'s filename pattern also now includes `GB`/`US` bare country-code folders (in addition to the existing `CN|ID|MY|PH|SG|TH|TW|VN`).
- **Also updated**: `extractDateFromZipFilename` (`processor/parser/json/index.ts`) gained a second recognized zip-filename date format, `YYYY-MM-DD_HH_MM` (e.g. `..._2026-09-14_12_56.zip`), needed because TikTok zip filenames don't use Shopee's `YYYYMMDDTHHMMSS` convention — without it, the new `zipFilenameDateFrom` gate above would never resolve a date for TikTok zips and would fail closed. The `local-zip-tester` agent's audit-script port of this function (`tools/local-zip-testing/audit-csv.py`) was updated to match, plus a fix to `compile_pattern()` to translate JS-style named capture groups (`(?<name>...)`, used by `mappings/Tiktok/index.json`'s `shop_name` capture) into Python's `(?P<name>...)` syntax — see `CLAUDE.md` for the standing reminder to re-verify this script's fidelity to `selectMappingForFile` whenever that function gains a new gate.

### 2026-09-04

- **Bug**: `SHOPEE__PRODUCT_SKUS__PH__DS__TM__*` zips dated on/after 2026-08-21 have a different upstream JSON shape than older `TM` zips — a flatter `data.data.{skus,...}` payload (matching `Shopee-PDP-1`'s `pathExtraction.path: "data.data || ..."` and `rowExpansion.arrayPath: "skus || item.models"`) instead of the older, deeply-nested `data.detail.item.models` scrape-wrapper shape that `Shopee-PDP-3` was built for (`pathExtraction.path: "... || data.detail.item || data"`, `rowExpansion.arrayPath: "models"`). Because the old unconditional `zipFilename: "*...__{MG|TM}__*"` rule routed all `TM` zips to `Shopee-PDP-3` regardless of date, every post-cutover `TM` zip hit `ZERO_OUTPUT_ROWS` (the `models` array expected by `Shopee-PDP-3` doesn't exist anywhere in the new shape) and failed with `status=FAILED`, 0 rows.
- **Fix**: added `zipFilenameDateFrom` as a new optional field on `MappingSelectionRule` (`packages/lambda/src/processor/parser/types.ts`), implemented as an inclusive lower bound in `selectMappingForFile` (`parser/json/index.ts:180-225`, via `extractDateFromZipFilename`). Added a new rule in `mappings/Shopee/index.json` ahead of the old `{MG|TM}` rule: `TM`-tagged zips dated ≥ 2026-08-21 → `Shopee-PDP-1`; everything else (older `TM` zips, all `MG` zips) still falls through to the unchanged `Shopee-PDP-3` rule. Verified against local fixtures on both sides of the boundary (2026-08-19, 2026-08-20, 2026-08-21, 2026-08-30) — each routes to the mapping matching its actual JSON shape, confirming 2026-08-21 is the real cutover, not a guess.
- **Related fix**: `Shopee-PDP-1`'s `sku_name` column (`mappings/Shopee/Shopee-PDP-1.json`) was `$expansion.props_names || $expansion.name` with no fallback, leaving this `required: true` field empty for every SKU with no per-variant name/props (single-variant products) — 686 of 1591 rows in the 2026-08-30 fixture. Added `|| title` as a final fallback, mirroring the pattern already used by `Shopee-PDP-3`'s own `sku_name` (`$expansion.name || title`) and by this same file's `product_name` (`title || item.title`). Confirmed via `applyRowExpansion` (`processor/index.ts:637`, `data: { ...row.data, $expansion: element }`) that the top-level `title` field remains reachable inside an expanded per-SKU row.
- **Also fixed**: the `local-zip-tester` agent's audit-script reproduction of `selectMappingForFile` (`tools/local-zip-testing/audit-csv.py`) had no `zipFilenameDateFrom` support at all, so it silently mis-resolved `Shopee-PDP-1` for pre-cutover zips during this investigation — the same class of drift previously fixed for the `fnmatch`/`zipFilename`-gate gap (see `CLAUDE.md`). Patched with a faithful port of `extractDateFromZipFilename` and the date-gate check; re-verified it agrees with the real runtime across the 2026-08-19/20/21/30 boundary zips.

### 2026-08-30

- Fixed `extractRegionFromPath` (`packages/lambda/src/processor/parser/json/index.ts`) to stop mislabeling every row in a zip with a country token incidentally embedded in a wrapper/batch-root folder name, instead of the correct per-shop `{XX}_shops` folder deeper in the path. See "Per-File Region Extraction" above for full details. Deployed to production the same day.

### 2026-03-23

- Updated code references to the refactored processor layout:
  - JSON parser: `processor/parser/json/index.ts`
  - Mapping loader: `processor/schema/mapping-loader.ts`
- Functional behavior for per-file mapping and path extraction remains unchanged.
