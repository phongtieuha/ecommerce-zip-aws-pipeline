# Local Parser Tool

A standalone tool for business users to parse JSON files locally with vendor mappings and generate CSV and Excel outputs **without requiring AWS services**.

## Usage

```bash
bun run parser --vendor=<VENDOR_NAME> --file=<PATH_TO_JSON_FILE>
```

### Optional Arguments

- `--region=<REGION_CODE>` for region substitution in mapping paths (for `$s3` placeholders)
- `--mappings-dir=<PATH>` to override where mappings are loaded from

### Examples

```bash
# Parse a Tiktok PDP file
bun run parser --vendor=Tiktok --file=./data/Tiktok-PDP.json

# Parse a products file
bun run parser --vendor=Tiktok --file=./data/products.json

# Parse Shopee data
bun run parser --vendor=Shopee --file=./shopee-data.json

# Parse from absolute path
bun run parser --vendor=Lazada --file=/Users/john/downloads/lazada.json
```

## Output

The tool generates:

- **CSV file**: `{filename}-parsed.csv` - Raw CSV output with all mapped fields
- **Excel file**: `{filename}-parsed.xlsx` - Excel workbook for easy viewing

Both files are created in the same directory as the input JSON file.

## How It Works

1. **Loads vendor mapping** - Automatically selects the correct mapping based on filename patterns and vendor index
2. **Reads JSON** - Parses the input JSON file (handles single objects or arrays)
3. **Applies path extraction** - If the mapping defines `pathExtraction`, applies it to nested objects/arrays
4. **Transforms to CSV** - Converts data to CSV format with proper escaping and Excel formatting
5. **Generates Excel** - Automatically converts CSV to Excel format for better usability

### No AWS Required

This tool operates **entirely locally**:

- ✓ Reads files from disk
- ✓ Uses local vendor mappings
- ✓ Outputs files locally
- ✗ Does not use S3
- ✗ Does not use DynamoDB
- ✗ Does not use Lambda or SQS

Perfect for business analysts, data specialists, or anyone who wants to test data parsing locally without cloud services.

## Supported Vendors

The tool works with any vendor configured in the `mappings/` directory:

- Tiktok (Tiktok-PDP-1, Tiktok-Products)
- Shopee
- Lazada
- And any others added to the project

## Error Handling

The tool provides helpful error messages:

- Missing or invalid vendor mapping files
- File not found errors
- Malformed JSON
- Invalid paths in mapping configuration

## Notes

- The field-mapping/path-extraction/transformation engine is a separate reimplementation that
  mirrors the Lambda processor's logic (`packages/lambda/src/processor`), not shared code — it
  is kept in sync manually, so headers and column values normally match production.
- Mapping **auto-selection** is simpler than production, though: this tool's `index.ts` only
  supports `*` and `?` glob wildcards in `selectionRules[].filename` and escapes `{`, `}`, `(`,
  `)`, `|` as literal characters. The Lambda processor's `selectMappingForFile`/`compilePattern`
  (`packages/lambda/src/processor/parser/json/index.ts`) additionally supports `{a|b|c}`
  alternation, named capture groups, `requestType`/`zipFilename` gating, and a `zipFilenameDateFrom`
  inclusive-lower-bound date gate (parsed from the zip filename's `YYYYMMDDTHHMMSS` timestamp, used
  to encode upstream schema-change cutovers — see Shopee's `product-skus` rules). For mappings whose
  rules use that syntax (e.g. Tiktok's `Tiktok-Products` rule, or Shopee's date-gated `TM` rule), pass
  `--mappings-dir` pointing at a mapping file directly, or double-check the selected mapping ID
  printed at startup against what the Lambda would choose.
- CSV output includes UTF-8 BOM for proper Excel detection
