export class NonRetryableError extends Error {
  public readonly isRetryable = false;

  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class MalformedFileError extends NonRetryableError {
  public readonly diagnostic?: Record<string, unknown>;

  constructor(message: string, diagnostic?: Record<string, unknown>) {
    super(message, "MALFORMED_FILE");
    this.diagnostic = diagnostic;
  }
}

export class MissingMappingError extends NonRetryableError {
  constructor(vendor: string) {
    super(`No mapping configuration found for vendor: ${vendor}`, "MISSING_MAPPING");
  }
}

export class ValidationConfigError extends NonRetryableError {
  constructor(message: string) {
    super(message, "VALIDATION_CONFIG_ERROR");
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) {
    return false;
  }

  // AWS SDK errors that are retryable
  if (error instanceof Error) {
    const retryableCodes = [
      "ThrottlingException",
      "ProvisionedThroughputExceededException",
      "ServiceUnavailable",
      "InternalServerError",
      "RequestTimeout",
      "ECONNRESET",
      "ETIMEDOUT",
    ];

    const errorCode = (error as Error & { code?: string }).code;
    if (errorCode && retryableCodes.includes(errorCode)) {
      return true;
    }
  }

  // Default: assume retryable (will go to DLQ after max retries)
  return true;
}
