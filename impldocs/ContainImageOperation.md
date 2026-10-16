# contain_image Operation Logic

**Date**: June 21, 2026  
**Status**: Completed  
**Project**: FilePipeline

---

## Summary

This document explains the `contain_image` transformation operation implemented in [packages/lambda/src/processor/schema/operation/handlers/contain-image.ts](packages/lambda/src/processor/schema/operation/handlers/contain-image.ts), with core detection logic in [packages/lambda/src/processor/schema/operation/helpers.ts](packages/lambda/src/processor/schema/operation/helpers.ts).

`contain_image` returns a boolean indicating whether the input content contains at least one image reference. It is designed to work with raw strings, arrays, and structured objects.

---

## Where It Is Defined

1. Operation type union includes `{ type: "contain_image" }` (in `operation/types.ts`).
2. Parser supports `|contain_image` in mapping source expressions (in `operation/parser.ts`).
3. Runtime execution delegates to `containsImageReference(value)` (in `operation/helpers.ts`).

Relevant code paths:

1. `parseOperationPart(operationPart)` — `packages/lambda/src/processor/schema/operation/parser.ts`
2. `handlers/contain-image.ts` — thin wrapper registered in `handlers/index.ts`, invoked via `applyOperation` in `packages/lambda/src/processor/schema/operation/index.ts`
3. `containsImageReference(value)` — `packages/lambda/src/processor/schema/operation/helpers.ts` (around line 341)

---

## Detection Rules

`containsImageReference(value)` uses these checks, in order.

### 1) Null and undefined guard

- `null` or `undefined` returns `false`.

### 2) Array recursion

- If input is an array, each element is checked recursively.
- Returns `true` when any element contains an image reference.

### 3) Value normalization to text

- String input: used directly.
- Object input: serialized with `JSON.stringify`.
- Other primitives: converted with `String(value)`.
- Empty/whitespace-only text returns `false`.

### 4) Data URI image detection

- Matches `data:image/<type>;base64,...`.
- If present, returns `true`.

### 5) HTML `<img>` tag detection

- Detects `<img ... src="...">` or `<img ... src='...'>`.
- If present, returns `true`.

### 6) File extension URL or filename detection

- Matches image extensions in plain text or URLs:
  - `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp`, `svg`, `avif`, `heic`, `heif`
- Supports optional query/hash suffixes.
- If present, returns `true`.

### 7) URL token scanning for image hints

From extracted URL tokens (`http://`, `https://`, `//`), detects:

1. Query-based format hints, for example:
   - `format=jpg`, `fmt=png`, `mime=image/jpeg`
2. Encoded mime hints:
   - `image%2fjpeg`
3. Image-like host/path patterns:
   - `.img.` or `.images.` domains
   - path segments like `/img`, `/image`, `/images`, `/photo`, `/photos`

If any hint matches, returns `true`.

### 8) Final fallback

- If none of the checks match, returns `false`.

---

## Mapping Usage

Typical pipeline usage:

1. Build or combine text/media content.
2. Run `|contain_image`.
3. Optionally convert boolean to output-friendly value.

Example:

```json
"is_lorikeet": {
  "source": "desc_obj|extract_field_to_array:text,image|join:\n|contain_image|boolean_to_text",
  "type": "string",
  "required": false
}
```

Behavior:

1. `contain_image` outputs `true` or `false`.
2. `boolean_to_text` converts to `"Yes"` or `"No"`.

---

## Expected Input and Output

1. Input types accepted: `string`, `array`, `object`, primitive values.
2. Output type: `boolean`.
3. Safe default: returns `false` for empty or non-matching content.

---

## Notes and Limitations

1. Detection is heuristic and pattern-based; it does not fetch URLs.
2. Non-standard image references without detectable hints may return `false`.
3. Generic URLs without extension or image hints rely on host/path/query signals.

---

## Source Reference

1. [packages/lambda/src/processor/schema/operation/handlers/contain-image.ts](packages/lambda/src/processor/schema/operation/handlers/contain-image.ts) — handler (thin wrapper)
2. [packages/lambda/src/processor/schema/operation/helpers.ts](packages/lambda/src/processor/schema/operation/helpers.ts) — `containsImageReference` detection logic (around line 341)
3. [packages/lambda/src/processor/schema/operation/types.ts](packages/lambda/src/processor/schema/operation/types.ts) — operation union type entry
4. [packages/lambda/src/processor/schema/operation/parser.ts](packages/lambda/src/processor/schema/operation/parser.ts) — parser entry

## Related Documentation

1. [impldocs/PathExtractionAndPerFileMapping.md](impldocs/PathExtractionAndPerFileMapping.md) for pipeline context on path resolution, mapping source expressions, and operation chaining behavior.
2. [impldocs/OperationModuleArchitecture.md](impldocs/OperationModuleArchitecture.md) for the general module structure (dispatch, handler registry, how to add a new operation) this operation lives in.
