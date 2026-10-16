export type FileStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "PARTIAL" | "FAILED" | "DLQ";

export interface ValidationError {
  readonly row: number;
  readonly field: string;
  readonly value: unknown;
  readonly message: string;
  readonly rule: string;
}

export interface FailedJsonSourceDetail {
  readonly file: string;
  readonly reason: string;
}

export interface ZipDiagnostic {
  readonly expectedPattern?: string;
  readonly totalFilesInZip: number;
  readonly jsonFilesFound: number;
  readonly filesMatched: number;
  readonly topLevelFolders: string[];
  readonly fileExtensionsFound: string[];
  readonly sampleFilePaths: string[];
}

export interface DuplicateKeyBreakdownEntry {
  readonly product_id?: string | number;
  readonly region?: string;
  readonly search_keyword?: string;
  readonly recorded_on?: string;
  readonly failedCount: number;
}

export interface FileRecord {
  readonly id: string;
  readonly s3Key: string;
  readonly vendor: string;
  readonly filename: string;
  readonly status: FileStatus;
  readonly discoveredFileCount?: number;
  readonly ingestedFileCount?: number;
  readonly notIngestedFileCount?: number;
  readonly parsedFileCount?: number;
  readonly failedJsonSourceFiles?: string[];
  readonly failedJsonSourceDetails?: FailedJsonSourceDetail[];
  readonly zipDiagnostic?: ZipDiagnostic;
  readonly rowCount: number;
  readonly successCount: number;
  readonly dedupRemovedCount?: number;
  readonly duplicateKeyBreakdown?: DuplicateKeyBreakdownEntry[];
  readonly errorCount: number;
  readonly errors: ValidationError[];
  readonly country?: string;
  readonly countries?: string[];
  readonly outputKey?: string;
  readonly errorReportKey?: string;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileRecordCreate {
  readonly id: string;
  readonly s3Key: string;
  readonly vendor: string;
  readonly filename: string;
  readonly status: FileStatus;
  readonly queuedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileRecordUpdate {
  readonly status?: FileStatus;
  readonly discoveredFileCount?: number;
  readonly ingestedFileCount?: number;
  readonly notIngestedFileCount?: number;
  readonly parsedFileCount?: number;
  readonly failedJsonSourceFiles?: string[];
  readonly failedJsonSourceDetails?: FailedJsonSourceDetail[];
  readonly zipDiagnostic?: ZipDiagnostic;
  readonly rowCount?: number;
  readonly successCount?: number;
  readonly dedupRemovedCount?: number;
  readonly duplicateKeyBreakdown?: DuplicateKeyBreakdownEntry[];
  readonly errorCount?: number;
  readonly errors?: ValidationError[];
  readonly country?: string;
  readonly countries?: string[];
  readonly outputKey?: string;
  readonly errorReportKey?: string;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt: string;
}

export interface FileListResponse {
  readonly files: FileRecord[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface FileFilters {
  readonly vendor?: string;
  readonly status?: FileStatus;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly limit?: number;
}
