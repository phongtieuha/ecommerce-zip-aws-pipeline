const EXACT_ERROR_MAP: Record<string, string> = {
  "Malformed JSON source file":
    "The JSON source file is malformed or has an unsupported structure. The file was skipped during ZIP processing.",
  "No matching JSON files found in ZIP archive":
    "The ZIP was opened and files were discovered, but none of their paths matched the vendor's configured mapping patterns. The data may be in an unexpected folder structure or filename format.",
  "No JSON files found in ZIP archive":
    "The ZIP was opened successfully but contained zero JSON files. The archive may be empty or contain only non-JSON files.",
  "No HTML files found in ZIP archive":
    "The ZIP was opened successfully but contained zero HTML files. The archive may be empty or contain only non-HTML files.",
  "No valid output rows after parsing/validation":
    "Files were discovered, matched mappings, and were parsed — but after extraction, filtering, and expansion all rows resolved to empty or null values and nothing remained to write.",
  "No records parsed from matched source files":
    "Files matched the mapping configuration but parsing produced zero structured records. All matched files may be empty arrays or objects with no extractable data.",
  "No files discovered in ZIP archive (archive may be malformed or unreadable)":
    "The ZIP could not be read at all. The archive may be corrupted, truncated, password-protected, or not a valid ZIP file.",
};

const PREFIX_ERROR_MAP: Array<[string, string]> = [
  [
    "Request type '",
    "The request type in the S3 path is not defined in the vendor's mapping configuration. No selection rules exist for this request type, so none of the files inside the ZIP could be matched to a mapping.",
  ],
  [
    "Invalid JSON syntax in ZIP file:",
    "A specific JSON entry inside the ZIP has a syntax error. The file was skipped and processing continued with other files.",
  ],
  [
    "Invalid JSON in ",
    "A JSON file was found but its root content is not a valid object/array structure expected by the parser. The file was skipped.",
  ],
  [
    "Unexpected token",
    "A JSON file has invalid syntax (for example trailing commas or broken quotes). The parser could not decode this file.",
  ],
  [
    "Unexpected end of JSON input",
    "A JSON file appears truncated or incomplete, so parsing ended before the document was finished.",
  ],
  [
    "Failed to extract ZIP HTML:",
    "A low-level decompression error occurred while streaming the ZIP. The archive may have corrupted entry headers or an unsupported compression method.",
  ],
  [
    "Failed to extract ZIP:",
    "A low-level decompression error occurred while streaming the ZIP. The archive may have corrupted entry headers or an unsupported compression method.",
  ],
];

export function getErrorExplanation(reason: string): string | undefined {
  if (reason in EXACT_ERROR_MAP) {
    return EXACT_ERROR_MAP[reason];
  }

  for (const [prefix, explanation] of PREFIX_ERROR_MAP) {
    if (reason.startsWith(prefix)) {
      return explanation;
    }
  }

  return undefined;
}
