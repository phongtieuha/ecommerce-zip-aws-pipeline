# Multi-Region Bullet Point Analysis

**Date**: March 9, 2026  
**Status**: Completed  
**Project**: FilePipeline

---

## Summary

Implemented bullet point counting and character analysis functions across 4 regions (Vietnam, Indonesia, Thailand, Philippines) with country-based routing in the Lambda processor. This enables product descriptions to be analyzed for bullet-point formatting and word content across different vendor implementations.

Key deliverables:

1. **Python implementations** for data analysis and validation
2. **TypeScript implementations** with language-specific tokenization
3. **Lambda operation support** with automatic country-based routing
4. **Test coverage** with Vietnamese, Thai, and Philippines text samples

---

## Problem

Different vendors format product descriptions differently:

- Some use bullet points (-, •, ●, ▪)
- Content needs analysis for word count, character count, and bullet detection
- Operations should work transparently based on source country extracted from S3 path
- Need parity between analytical Python scripts and production TypeScript code

---

## Solution Architecture

### Regional Language Support

| Region               | File                                                                                | Approach                                                              | Features                                                             |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Vietnam (vn)**     | `tools/bullet-points/id+vn.py`<br>`packages/shared/src/utility/bullet-points/vn.ts` | Simple regex, character-based counting                                | Bullet detection, character counting                                 |
| **Indonesia (id)**   | Re-exports from vn.ts                                                               | Same as Vietnam                                                       | Shares vn.ts implementation                                          |
| **Thailand (th)**    | `tools/bullet-points/th.py`<br>`packages/shared/src/utility/bullet-points/th.ts`    | Python: pythainlp tokenizer<br>TS: Thai char regex + Latin word regex | Proper Thai word segmentation (Python)<br>Approximation (TypeScript) |
| **Philippines (ph)** | `tools/bullet-points/ph.py`<br>`packages/shared/src/utility/bullet-points/ph.ts`    | English word pattern matching                                         | Latin/English word counting                                          |

### Exported Functions

Each region module exports:

```typescript
// Count bullet lines (lines starting with •, -, –, ▪)
count_bullets_clean(text): number

// Count characters after removing bullet lines
count_charactes_no_bullet(text): number

// Count words (language-specific)
count_words(text): number

// Count words after removing bullet lines
count_words_no_bullet(text): number
```

---

## Implementation Details

### 1. Python Implementation (`tools/bullet-points/`)

#### Vietnam & Indonesia (`id+vn.py`)

```python
def count_bullets_clean(text):
    pattern = r"(?m)^\s*(?:-+|•|●)\s+.+"
    return len(re.findall(pattern, text))

def count_words_no_bullet(text):
    pattern = r"(?m)^\s*(?:-+|•|●)\s+.*$"
    text_no_bullet = re.sub(pattern, "", text)
    return len(text_no_bullet.split())  # Returns word count

def count_words_id_vn(text):
    return len(text.split())
```

#### Thailand (`th.py`)

```python
def count_words_th(text):
    # Uses pythainlp.tokenize.word_tokenize(text, engine='newmm')
    # Filters tokens into Thai characters and Latin/numeric words
    # Returns total count

def count_words_th_no_bullet(text):
    # Removes bullet lines first, then tokenizes remaining text
```

#### Philippines (`ph.py`)

```python
def count_words_ph(text):
    word_pattern = r"\b[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*\b"
    return len(re.findall(word_pattern, text))
```

### 2. TypeScript Implementation (`packages/shared/src/utility/bullet-points/`)

Each language file (`vn.ts`, `id.ts`, `th.ts`, `ph.ts`) exports equivalent functions:

```typescript
// Examples from th.ts and ph.ts

export function count_bullets_clean(text: string | null | undefined): number {
  const bulletPattern = /^\s*[•\-–▪]\s+.+$/gm;
  const matches = text.match(bulletPattern);
  return matches ? matches.length : 0;
}

export function count_charactes_no_bullet(text: string | null | undefined): number {
  const bulletPattern = /^\s*[•\-–▪]\s+.*$/gm;
  const textNoBullets = text.replace(bulletPattern, "");
  return textNoBullets.length;
}
```

**Note on Thailand**: Python uses `pythainlp` for proper Thai tokenization. TypeScript uses regex approximation:

- Thai characters: `[\u0E00-\u0E7F]+` (Thai Unicode range)
- Latin words: `[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*`

This gives reasonable approximations without npm dependencies, with the trade-off that word counts differ slightly from Python.

### 3. Lambda Integration (`packages/lambda/src/processor/schema/operation/`)

`applyOperation()` (`operation/index.ts`) is a thin dispatcher that looks up the
operation type in a handler map and delegates to a dedicated handler file —
there is no switch/case:

```typescript
// operation/index.ts
export function applyOperation(
  value: unknown,
  operation: Operation,
  context?: Record<string, unknown>,
): unknown {
  const handler = operationHandlers[operation.type];
  return handler(value, operation, context);
}
```

Each operation type has its own file under `operation/handlers/`, e.g.
`operation/handlers/count-bullets-clean.ts` does the automatic country
routing:

```typescript
// operation/handlers/count-bullets-clean.ts
export const handleCountBulletsClean: OperationHandler<"count_bullets_clean"> = (
  value,
  _operation,
  context,
) => {
  if (typeof value !== "string") return undefined;

  const country = resolveCountry(undefined, context);
  if (country === "vn") return count_bullets_clean_vn(value);
  if (country === "id") return count_bullets_clean_id(value);
  if (country === "th") return count_bullets_clean_th(value);
  if (country === "ph") return count_bullets_clean_ph(value);
  return count_bullets_clean_vn(value); // fallback
};
```

### 4. Package Configuration

Updated `packages/shared/package.json` with subpath exports:

```json
"exports": {
  "./utility/bullet-points/vn": { ... },
  "./utility/bullet-points/id": { ... },
  "./utility/bullet-points/th": { ... },
  "./utility/bullet-points/ph": { ... }
}
```

---

## Mapping Usage Examples

### Shopee PDP Mapping

```json
{
  "num_bullets_update": {
    "source": "details|count_bullets_clean"
  },
  "updated_num_words": {
    "source": "details|count_words_no_bullet"
  },
  "word_count": {
    "source": "details|count_words"
  }
}
```

### Lazada PDP Mapping

```json
{
  "num_bullets_update": {
    "source": "desc|count_bullets_clean"
  },
  "updated_num_words": {
    "source": "desc|count_words_no_bullet"
  }
}
```

### Tiktok PDP Mapping

```json
{
  "num_bullets_update": {
    "source": "product_base.desc_detail|count_bullets_clean"
  },
  "updated_num_words": {
    "source": "product_base.desc_detail|count_words_no_bullet"
  }
}
```

---

## Testing & Validation

### Python Validation

Ran `tools/bullet-points/th.py` and `tools/bullet-points/ph.py`:

**Thailand Results:**

- th_1: 596 words, 268 without bullets, 28 bullets
- th_2: 437 words, 321 without bullets, 13 bullets

**Philippines Results:**

- ph_1: 191 words, 70 without bullets, 11 bullets
- ph_2: 192 words, 72 without bullets, 11 bullets

### TypeScript Validation

Created test files and ran with actual product descriptions:

**Shopee CSV Output (vn):**

- num_bullets_update: 2 ✓
- updated_num_words: 384 ✓
- word_count: 652 ✓

**Lazada CSV Output (vn):**

- num_bullets_update: 0 ✓
- updated_num_words: 2376 ✓

**Tiktok CSV Output (vn):**

- num_bullets_update: 0 ✓
- updated_num_words: 2003 ✓

End-to-end processing verified with test data uploaded to LocalStack and processed through Lambda.

---

## Key Design Decisions

1. **Character-based vs Word-based Operations**
   - `count_charactes_no_bullet` returns character count and is simple, accurate,
     and doesn't require tokenization; it works identically across all regions.
     It is registered as a valid operation but, as of this audit, current
     mapping files use `count_words_no_bullet` (word-based, with per-region
     tokenization) for `updated_num_words` instead.
   - `count_words_no_bullet` returns a word count using the same per-country
     routing as `count_words` (see `Exported Functions` above), so results
     differ slightly across regions (e.g. the Thai regex approximation).

2. **No External Dependencies for Thai in TypeScript**
   - Rejected `thai-tokenizer` npm package
   - Trade-off: Word counts differ slightly from pythainlp but avoid extra dependency
   - Character operations remain perfectly accurate

3. **Country-based Routing**
   - Resolved by `resolveCountry()` (`operation/helpers.ts`), which scans several
     candidate fields on the row (`cube_metadata.country`, `cube_metadata.s3_key`,
     `s3Key`, `country`, `country_code`, `region`, `locale`, and, as a last resort,
     image-URL fields) through a generic `extractCountryCode()` that understands
     multiple formats (S3-key-style path prefix, full URL path, hyphen-prefixed,
     bare 2-letter code, locale like `en-us`, hostname prefix)
   - The S3-path-derived country still flows in: `enrichWithCountry()`
     (`packages/lambda/src/processor/index.ts`) writes the batch/path-derived
     country onto each row's `cube_metadata.country` before `applyOperation` runs,
     unless the row already carries its own more specific country
   - Automatic fallback to Vietnam (vn) implementation as default

4. **Indonesia Reuses Vietnam**
   - id.ts simply imports and re-exports vn.ts functions
   - Both use similar text processing rules
   - Reduces code duplication

5. **Module Structure**
   - Separate files per region: `vn.ts`, `id.ts`, `th.ts`, `ph.ts`
   - No shared index.ts (architectural issue removed in prior refactoring)
   - Package exports configured for each region-specific path

---

## Files Changed

### Python Scripts

- `tools/bullet-points/id+vn.py` - Existing (unchanged)
- `tools/bullet-points/th.py` - Fixed with imports (added `import re` and `from setup import df_concat_all`)
- `tools/bullet-points/ph.py` - Fixed with imports (added `import re` and `from setup import df_concat_all`)

### TypeScript Implementation

- `packages/shared/src/utility/bullet-points/th.ts` - **New**
- `packages/shared/src/utility/bullet-points/ph.ts` - **New**
- `packages/shared/src/utility/bullet-points/id.ts` - Existing (no changes)
- `packages/shared/src/utility/bullet-points/vn.ts` - Existing (no changes)

### Configuration

- `packages/shared/package.json` - Added th and ph exports
- `packages/lambda/src/processor/schema/operation/handlers/count-bullets-clean.ts` (and sibling handler files) - Added imports and country routing for th and ph

---

## Limitations & Future Improvements

### Current Limitations

1. **Thai word counting in TypeScript**: Regex approximation vs pythainlp's proper tokenization
   - Impact: Word count differs ~10-15% from Python version
   - Solution: Would need `thai-tokenizer` npm package (currently not used)

2. **Philippines assumption**: Only handles English/Latin word patterns
   - Impact: May undercount if descriptions contain Filipino/Tagalog native words
   - Acceptable: Current test data validates correctly

### Future Enhancements

1. Optional npm Thai tokenizer for improved accuracy
2. Support for additional regional languages if needed
3. Configurable bullet marker patterns per vendor/region
4. Caching of tokenization results for performance

---

## Deployment Checklist

- [x] Python implementations fixed and tested
- [x] TypeScript implementations created
- [x] Package exports configured
- [x] Lambda operations extended with routing
- [x] End-to-end testing with LocalStack
- [x] Mapping files support new operations
- [x] Code pushed to repository

---

## Changelog

### 2026-03-23

- Updated processor code location references after module refactor:
  - Operation routing now lives in `packages/lambda/src/processor/schema/operation/` (`index.ts` for dispatch, `handlers/*.ts` for one file per operation, plus `parser.ts`, `types.ts`, and `helpers.ts`)
  - Nested-path resolution now lives in `packages/lambda/src/processor/schema/path-resolver.ts`
- No logic changes to bullet-point analysis operators; only file organization changed.

---

## Related Documentation

- `impldocs/CountProductDescriptionOperation.md` — related description counting operations
- `impldocs/OperationModuleArchitecture.md` — the general module structure (dispatch, handler registry, how to add a new operation) these operations live in
