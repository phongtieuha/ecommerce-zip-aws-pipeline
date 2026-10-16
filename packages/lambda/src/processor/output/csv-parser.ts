import { parse } from "csv-parse/sync";
import { MalformedFileError } from "../../../utils/errors";

export interface ParsedRow {
  rowNumber: number;
  data: Record<string, unknown>;
}

export interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  totalRows: number;
}

/**
 * Check if content appears to be binary (non-text)
 */
function isBinaryContent(content: string): boolean {
  // Check for null bytes or high proportion of non-printable chars
  let nonPrintable = 0;
  const sampleSize = Math.min(content.length, 1000);
  for (let i = 0; i < sampleSize; i++) {
    const code = content.codePointAt(i) ?? 0;
    // Null byte or control chars (except newline, tab, carriage return)
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      nonPrintable++;
    }
  }
  // More than 10% non-printable = likely binary
  return nonPrintable / sampleSize > 0.1;
}

/**
 * Check if content is essentially empty (whitespace only)
 */
function isEmptyContent(content: string): boolean {
  return content.trim().length === 0;
}

export function parseCSV(content: string): ParseResult {
  // Validate content before parsing
  if (isEmptyContent(content)) {
    throw new MalformedFileError("File is empty or contains only whitespace");
  }

  if (isBinaryContent(content)) {
    throw new MalformedFileError("File appears to be binary, not a valid CSV");
  }

  try {
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relaxColumnCount: true,
      relaxQuotes: true,
    });

    if (!records || records.length === 0) {
      return {
        headers: [],
        rows: [],
        totalRows: 0,
      };
    }

    const headers = Object.keys(records[0]);

    // Validate CSV structure - must have at least 2 columns
    if (headers.length < 2) {
      throw new MalformedFileError(
        `Invalid CSV structure: only ${headers.length} column(s) detected. Check delimiter.`,
      );
    }

    // Check for suspicious single-column that contains delimiters (wrong delimiter used)
    if (headers.length === 1 && (headers[0].includes(";") || headers[0].includes("\t"))) {
      throw new MalformedFileError("Invalid CSV: appears to use wrong delimiter (expected comma)");
    }

    const rows: ParsedRow[] = records.map((record: Record<string, string>, index: number) => ({
      rowNumber: index + 2, // +2 because: 1-indexed + header row
      data: record,
    }));

    return {
      headers,
      rows,
      totalRows: rows.length,
    };
  } catch (error) {
    if (error instanceof MalformedFileError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown parsing error";
    throw new MalformedFileError(`Failed to parse CSV: ${message}`);
  }
}

export async function extractCSVFromZip(zipBuffer: Buffer): Promise<string> {
  try {
    const unzipper = await import("unzipper");
    const directory = await unzipper.Open.buffer(zipBuffer);

    // Find the first CSV file in the archive
    const csvFile = directory.files.find(
      (f) => f.path.toLowerCase().endsWith(".csv") && f.type === "File",
    );

    if (!csvFile) {
      throw new MalformedFileError("No CSV file found in ZIP archive");
    }

    const content = await csvFile.buffer();
    return content.toString("utf-8");
  } catch (error) {
    if (error instanceof MalformedFileError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new MalformedFileError(`Failed to extract ZIP: ${message}`);
  }
}
