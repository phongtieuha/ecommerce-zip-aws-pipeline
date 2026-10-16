import type { VendorMapping } from "@filepipeline/shared";
import { S3MultipartWriter } from "../../../utils/s3";

/**
 * Escape a value for CSV output
 */
function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        value = json;
      }
    } catch {
      // Fall through to generic string conversion.
    }
  }

  let str = String(value);
  // Replace actual newlines/carriage returns with escaped sequences
  str = str.replaceAll("\r\n", "\\n").replaceAll("\n", "\\n").replaceAll("\r", "\\n");
  if (str.includes(",") || str.includes('"')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

/**
 * Build CSV output with dynamic columns based on vendor mapping
 */
export function buildDynamicCSVOutput(
  rows: Array<Record<string, unknown>>,
  mapping: VendorMapping,
): string {
  const columnNames = Object.keys(mapping.columns);
  const header = columnNames.join(",");

  const csvRows = rows.map((row) => {
    return columnNames.map((col) => escapeCSV(row[col])).join(",");
  });

  // Add UTF-8 BOM for Excel compatibility - ensures proper column detection
  const bom = "\uFEFF";
  return bom + [header, ...csvRows].join("\n");
}

/**
 * Streaming CSV writer that flushes rows in batches to S3 via multipart upload.
 * Rows are never accumulated into one giant array — each batch is serialised
 * to CSV text, written to the S3MultipartWriter, then discarded.
 */
export class StreamingCSVWriter {
  private writer: S3MultipartWriter;
  private mapping: VendorMapping;
  private columnNames: string[];
  private headerWritten = false;
  private batch: Array<Record<string, unknown>> = [];
  private _rowCount = 0;

  /** Number of rows to buffer before flushing to S3. */
  private static readonly BATCH_SIZE = 5000;

  constructor(bucket: string, key: string, mapping: VendorMapping) {
    this.writer = new S3MultipartWriter(bucket, key, "text/csv");
    this.mapping = mapping;
    this.columnNames = Object.keys(mapping.columns);
  }

  get rowCount(): number {
    return this._rowCount;
  }

  /** Add a validated row (already mapped). Flushes when BATCH_SIZE is reached. */
  async addRow(row: Record<string, unknown>): Promise<void> {
    this.batch.push(row);
    this._rowCount++;
    if (this.batch.length >= StreamingCSVWriter.BATCH_SIZE) {
      await this.flush();
    }
  }

  /** Flush remaining rows and complete the S3 upload. */
  async finish(): Promise<void> {
    if (this.batch.length > 0) {
      await this.flush();
    }
    await this.writer.finish();
  }

  /** Abort the upload (call on errors). */
  async abort(): Promise<void> {
    await this.writer.abort();
  }

  private async flush(): Promise<void> {
    let csv = "";
    if (!this.headerWritten) {
      const bom = "\uFEFF";
      csv += bom + this.columnNames.join(",") + "\n";
      this.headerWritten = true;
    }

    for (const row of this.batch) {
      csv += this.columnNames.map((col) => escapeCSV(row[col])).join(",") + "\n";
    }

    this.batch = [];
    await this.writer.write(csv);
  }
}
