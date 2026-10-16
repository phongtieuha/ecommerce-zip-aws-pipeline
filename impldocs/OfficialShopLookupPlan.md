# Official Shop Lookup Plan

**Date**: June 22, 2026  
**Status**: Implemented  
**Project**: FilePipeline

---

## Implementation Notes

This plan was implemented closely matching the original design.

Matches:

1. `packages/lambda/src/processor/schema/reference-data-loader.ts` exists with `getIsOfficialShop`, `clearReferenceDataCache`, CSV parsing via `csv-parse/sync`, `byShopId`/`byShopName` maps, ambiguous-key tracking, and an `OFFICIAL_SHOP_LOOKUP_CSV_PATH` env var override — matching the plan's described design.
2. `$lookup.<Platform>.region.shop_id`/`shop_name` token support was added to `packages/lambda/src/processor/validation/validator.ts` (source resolution, around lines 494-529) and to `packages/lambda/src/processor/schema/mapping-loader.ts` (around line 50, special-token validation).
3. Mappings were updated to use it: `mappings/Lazada/Lazada-Products.json` (lines ~118-122), `mappings/Lazada/Lazada-PDP-2.json` (lines ~123-127), and `mappings/Redmart/Redmart-Products.json` (lines ~118-122) use `$lookup.<Platform>.region.shop_id || $lookup.<Platform>.region.shop_name` exactly as planned. `mappings/Redmart/Redmart-PDP-1.json` (lines ~121-125) also adopts the lookup token, but with an additional leading fallback not called out in the plan: `"shop_info.is_mall || $lookup.Redmart.region.shop_id || $lookup.Redmart.region.shop_name"` (and `required: true`, unlike the other three which are `required: false`).
4. Conflict policy matches the plan: non-empty value preferred, conflicting non-empty values mark the key unresolved via `ambiguousShopIdKeys`/`ambiguousShopNameKeys` (`reference-data-loader.ts`, around lines 52-70).

Deviations:

1. The plan's section 3 (adding a lookup-resolution helper to `packages/lambda/src/processor/schema/path-resolver.ts`) was not followed — that file has no lookup/official-shop code. All resolution logic instead lives directly in `validator.ts`. This is a minor architectural deviation, not a functional gap.
2. Not all Lazada/Redmart mappings were converted to the new lookup token: `mappings/Lazada/Lazada-Products-2.json` (around lines 87-90) still uses the old heuristic `"$root.mods.filter.filterItems|JSON.stringify|contain:official"`, and `mappings/Redmart/Redmart-Products-2.json` (around lines 87-90) still uses a raw `"source": "official"` — these two files were never migrated to the lookup-token approach the rest of the plan's mappings use.
3. No dedicated unit tests were found for the reference-data-loader or the lookup-resolution logic in `packages/lambda`, despite the plan calling for loader/resolver unit tests in the Test Plan section.

---

## Objective

Implement deterministic `is_official_shop` derivation for Lazada and Redmart using reference CSV lookup data from:

- `assets/Lazada_Redmart_ShopID_ShopName_IsOfficalShop_20260618 - Shop Data.csv`

This plan explicitly ignores `MIN(RECORDED_ON)` and `MAX(RECORDED_ON)` for matching and precedence.

---

## Scope

Included:

1. Lazada and Redmart `is_official_shop` lookup by `platform + region + shop_id`.
2. Controlled fallback by `platform + region + shop_name` only when unique.
3. Lambda runtime cache for reference data.
4. Mapping updates for Lazada and Redmart mapping files that currently leave `is_official_shop.source` empty.
5. Unit and local integration validation.

Excluded:

1. Any `recorded_on`-based checks.
2. Infrastructure or deployment changes.
3. Output schema changes for `is_official_shop` (remains boolean).

---

## Lookup Rules

### Primary Key

- `PLATFORM|REGION|SHOP_ID`

### Fallback Key

- `PLATFORM|REGION|SHOP_NAME`
- Use only when primary key misses and fallback match is unique.
- Mapping source should express this precedence explicitly as:
- `$lookup.<Platform>.region.shop_id || $lookup.<Platform>.region.shop_name`

### Normalization

1. `PLATFORM`, `REGION`: lowercase + trim for internal matching.
2. `SHOP_ID`: trim and stringify.
3. `SHOP_NAME`: trim; keep normalized variant for fallback matching.
4. Source token casing remains user-friendly (for example `Lazada`), while resolver matching is case-insensitive by lowering both token and CSV/platform context.

### Conflict Policy

1. Prefer non-empty `IS_OFFICIAL_SHOP` over empty values.
2. If conflicting non-empty values exist for the same key, mark key unresolved and do not emit value.
3. Log conflict once per key.

---

## File-Level Change Plan

### 1) Add reference data loader/cache

- File to add: `packages/lambda/src/processor/schema/reference-data-loader.ts`

Responsibilities:

1. Parse CSV once per cold start (or first lookup call).
2. Build in-memory maps:
3. `byShopId: Map<string, boolean>`
4. `byShopName: Map<string, boolean | "AMBIGUOUS">`
5. Expose lookup API and cache helpers.

Suggested exported functions:

1. `loadShopIsOfficialLookup(vendor: string, csvPath?: string)`
2. `getIsOfficialShop(vendor: string, region: string, shopId?: string | number, shopName?: string)`
3. `clearReferenceDataCache()`

---

### 2) Extend source resolution for lookup token

- File to update: `packages/lambda/src/processor/validation/validator.ts`

Changes:

1. In source resolution flow, add support for lookup token format.
2. Resolve vendor/region/shop_id/shop_name from runtime context.
3. Query lookup utility with primary key first, fallback second.
4. Return `undefined` for unresolved or ambiguous lookup.

---

### 3) Add reusable reference resolver entry point

- File to update: `packages/lambda/src/processor/schema/path-resolver.ts`

Changes:

1. Add helper for resolving lookup token values from current context.
2. Keep it additive so existing path behavior is unchanged.

---

### 4) Allow lookup token in mapping loader validation

- File to update: `packages/lambda/src/processor/schema/mapping-loader.ts`

Changes:

1. Update special source token validation to allow `$lookup.*` source token.
2. Preserve existing validation behavior for all current tokens.

---

### 5) Update runtime context typing

- File to update: `packages/shared/src/types/index.ts`

Changes:

1. Extend runtime context type to support optional lookup/cache access, if needed by resolver implementation.

---

### 6) Update Lazada and Redmart mappings

- Files to update:
  - `mappings/Lazada/Lazada-PDP-2.json`
  - relevant `mappings/Redmart/*.json` files where `is_official_shop.source` is currently empty

Current:

```json
"is_official_shop": {
  "source": "",
  "type": "boolean",
  "required": false
}
```

Planned:

```json
"is_official_shop": {
  "source": "$lookup.Lazada.region.shop_id || $lookup.Lazada.region.shop_name",
  "type": "boolean",
  "required": false
}
```

Note:

1. Keep field type as boolean.
2. Keep requirement flag unchanged.
3. Apply the same token pattern to Redmart mappings using `"$lookup.Redmart.region.shop_id"`.
4. Keep `shop_id` lookup first and `shop_name` lookup second in all mappings.

### Source Usage Examples

Lazada mapping example:

```json
"is_official_shop": {
  "source": "$lookup.Lazada.region.shop_id || $lookup.Lazada.region.shop_name",
  "type": "boolean",
  "required": false
}
```

Redmart mapping example:

```json
"is_official_shop": {
  "source": "$lookup.Redmart.region.shop_id || $lookup.Redmart.region.shop_name",
  "type": "boolean",
  "required": false
}
```

---

## Test Plan

### Unit Tests

Files to add/update under lambda tests:

1. Loader tests for CSV parse, normalization, and duplicate handling.
2. Resolver tests for primary/fallback precedence and ambiguity handling.
3. Validation that recorded_on columns are not read or compared.

### Local Integration Test

Fixture:

- `test-data/file_type=json/channel=lazada/request_type=product-skus-csapi/file_type=json_channel=lazada_request_type=product-skus-csapi_20260408T063000_PRODUCT_DETAILS_LAZADA_DS_1.zip`
- one Redmart fixture covering `is_official_shop` output behavior

Checks:

1. `is_official_shop` populated when lookup key exists.
2. unresolved rows remain empty/undefined (no forced false positives).
3. Existing fields stay stable:
4. `shop_id`
5. `shop_location`
6. `shop_name`

---

## Risks and Mitigations

1. Missing or moved CSV asset

- Mitigation: env override for CSV path + clear startup error.

2. `SHOP_ID` type mismatches (number/string)

- Mitigation: canonical string normalization.

3. Non-unique fallback by `shop_name`

- Mitigation: allow fallback only for unique key; otherwise unresolved.

4. Duplicate/conflicting records in source CSV

- Mitigation: conflict policy + once-per-key logging.

5. Runtime overhead

- Mitigation: in-memory cache per Lambda instance.

---

## Execution Order

1. Implement loader/cache utility.
2. Add lookup token support in validation/resolver path.
3. Update mapping-loader token validation.
4. Update Lazada and Redmart mapping sources.
5. Add unit tests.
6. Run local integration fixture and verify output behavior.

---

## Related Docs

1. `impldocs/PathExtractionAndPerFileMapping.md`
2. `impldocs/ContainImageOperation.md`
