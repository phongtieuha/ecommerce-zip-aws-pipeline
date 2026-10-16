# Product Description Operations

**Date**: June 22, 2026  
**Updated**: June 24, 2026  
**Status**: Implemented  
**Project**: FilePipeline

---

## Summary

Product description normalization is now standardized through one canonical operation chain before producing output:

| Operation chain             | Returns                                                                | Mapping field                                 |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| `clean_product_description` | `string` — normalized plain text (HTML stripped, whitespace collapsed) | `cleaned_product_desc`                        |
| `clean_product_description  | length`                                                                | `number` — character count of normalized text | `product_desc_char_count` |

Both forms rely on the same underlying `normalizeProductDescriptionValue` helper and accept the same input shapes.

## Problem

Existing `product_desc_char_count` mappings used raw `|length` on `innerHTML` or raw field values, including HTML tags, markup whitespace, and serialized JSON structure in the count.

The reference CSV (`assets/DS - sample product_desc - Sheet1.csv`) shows the expected behavior:

- strip HTML tags
- collapse extra whitespace
- concatenate arrays of strings
- extract meaningful text from structured objects
- count normalized characters only

A companion `cleaned_product_desc` field was also added to expose the normalized text directly, so downstream consumers can read the cleaned string without re-parsing the raw HTML.

## Normalization strategy (`normalizeProductDescriptionValue`)

Shared by both operations. Handles all common description input shapes:

- **String**: parse as JSON first if it starts with `{` or `[`; strip HTML tags via regex; collapse `\s+` to a single space; trim
- **Array**: recursively normalize each element; join with a single space; filter empty
- **Object**: extract text from prioritized keys in order — `text`, `t`, `content`, `description`, `sub`, `li_sub`, `value`; recursively normalize values; fall back to all object values if no priority key is present

## Operations

### `|clean_product_description`

Returns the normalized plain text string. Returns `undefined` for null/undefined/empty input (falls back to `default` in the mapping).

```
document.querySelector('[itemprop=description]').innerHTML|clean_product_description
→ "เซ็นโซดายน์ ยาสีฟัน ดีพคลีน 50 กรัม..."
```

### `|clean_product_description|length`

Returns the `string.length` (UTF-16 code units, matching JavaScript semantics) of normalized text.
For empty/null input, this resolves to `0` via `|length` semantics in the operation pipeline.

```
description|clean_product_description|length
→ 890
```

### `|count_product_description` (deprecated and removed)

`count_product_description` has been removed from the runtime operation registry and parser in favor of the canonical chain `clean_product_description|length`.
Existing mappings were migrated accordingly.

## Mapping patterns

### HTML parser (711, Watsons PDP)

```json
"cleaned_product_desc": {
  "source": "document.querySelector('[itemprop=description]').innerHTML|clean_product_description",
  "type": "string",
  "required": false,
  "default": ""
},
"product_desc_char_count": {
  "source": "document.querySelector('[itemprop=description]').innerHTML|clean_product_description|length",
  "type": "number",
  "required": false,
  "default": 0
}
```

### JSON parser — plain field (Lazada, Watsons Products, Shopee PDP-3)

```json
"product_desc_char_count": {
  "source": "desc|clean_product_description|length || description|clean_product_description|length",
  "type": "number",
  "required": false,
  "default": 0
}
```

### JSON parser — structured array (Shopee PDP-1)

```json
"product_desc_char_count": {
  "source": "desc_obj|extract_field_to_array:text|join:\n|clean_product_description|length || item.description|clean_product_description|length",
  "type": "number",
  "required": false,
  "default": 0
}
```

## Implementation location

`packages/lambda/src/processor/schema/operation/`:

- `types.ts` — `Operation` union: `{ type: "clean_product_description" }`
- `parser.ts` (around line 152-153) — `parseOperationPart`: parses `clean_product_description`
- `helpers.ts` — `normalizeProductDescriptionValue`: shared helper — strip HTML tags, collapse whitespace, handle arrays and objects recursively
- `helpers.ts` — `stripHtmlTags`: replaces `<[^>]+>` with empty string
- `handlers/clean-product-description.ts` — handler that returns the normalized string or `undefined`
- Character counting is now performed by chaining `|length` after `|clean_product_description`

Note: a TikTok-specific variant, `handlers/clean-tiktok-product-description.ts`, also exists but is outside the chain described in this document. It uses a separate `extractTextFieldsOnly` helper (`operation/helpers.ts`, around lines 135-188) rather than `normalizeProductDescriptionValue`, and is a real, undocumented addition worth a pointer for anyone touching TikTok mappings.

## Validation

Validated locally against `test-data/file_type=html/channel=711/request_type=product-skus/...PRODUCT_DETAILS_711_DS.zip`:

- 153 rows processed; 152/153 with non-zero `product_desc_char_count` (1 row has no source product id)
- `product_desc_char_count` range: 81–1919 characters
- `cleaned_product_desc` returns plain Thai/English text with HTML and whitespace stripped

Also validated against Shopee PH ZIP (27,703 rows):

- 22,767/27,703 rows with non-zero count (18% zero = SKU expansions with no description)
- Range: 33–5,553 characters

## Note on character count semantics

`clean_product_description|length` uses JavaScript `string.length` (UTF-16 code units). Text containing supplementary Unicode characters (e.g. Mathematical Bold `𝐈𝐧𝐜𝐥𝐮𝐝𝐞𝐬`, U+1D400 range) will produce counts slightly higher than Python `len()`, since each supplementary character counts as 2 in JS but 1 in Python. This is expected and consistent with all other `|length`-based operations in the pipeline.

---

## Related docs

- `impldocs/PathExtractionAndPerFileMapping.md` — HTML selector resolution and operation chaining
- `impldocs/MultiRegionBulletPointAnalysis.md` — existing description counting operations and country-specific text handling
- `impldocs/OperationModuleArchitecture.md` — the general module structure (dispatch, handler registry, how to add a new operation) this operation lives in
