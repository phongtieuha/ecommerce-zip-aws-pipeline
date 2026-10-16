/**
 * Shared types for HTML and JSON parsers
 */

export interface ParsedRow {
  readonly rowNumber: number;
  readonly data: Record<string, unknown>;
}

export interface ParseResult {
  readonly headers: string[];
  readonly rows: ParsedRow[];
  readonly totalRows: number;
}

/**
 * Result from extracting a single file from a ZIP archive
 */
export interface ExtractedFile {
  readonly filename: string;
  readonly path: string;
  readonly data: Record<string, unknown>[];
  readonly mappingId?: string;
  readonly region?: string;
  readonly captures?: Record<string, string>;
}

export interface ZipExtractionResult {
  readonly files: ExtractedFile[];
}

export interface MappingSelectionRule {
  readonly filename: string;
  readonly mappingId: string;
  readonly requestType?: string;
  readonly zipFilename?: string;
  /**
   * Optional inclusive lower bound (YYYY-MM-DD) on the date/time timestamp
   * embedded in the zip filename (e.g. "..._20260821T163000.zip"). Lets a
   * rule apply only from a known upstream schema-change cutover onward,
   * while an earlier catch-all rule keeps matching older files.
   */
  readonly zipFilenameDateFrom?: string;
}
