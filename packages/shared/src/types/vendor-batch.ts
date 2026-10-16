/**
 * Vendor batch accumulator for consolidating multiple files into single CSV
 * Key: {country}#{vendor}#{date}#{runId} (e.g., "vn#Shopee#2026-03-02#2f9d...")
 */
export interface VendorBatch {
  readonly batchKey: string; // "{country}#{vendor}#{date}#{runId}"
  readonly vendor: string;
  readonly date: string; // "yyyy-MM-dd"
  readonly rows: Array<Record<string, unknown>>; // Legacy field, kept for compatibility
  readonly fileCount: number; // Number of files processed for this vendor/date
  readonly successRowCount: number; // Total valid rows across all files
  readonly errorRowCount: number; // Total invalid rows across all files
  readonly sourceFilename?: string; // Stem of the first input file (e.g. "my_shopee_file"), used as output CSV name
  readonly runId?: string; // File run identifier (file record id)
  readonly isConsolidated: boolean; // True when CSV has been written
  readonly consolidatedOutputKey?: string; // S3 key of final CSV (set when consolidated)
  readonly lastUpdatedAt: string; // ISO timestamp
}
