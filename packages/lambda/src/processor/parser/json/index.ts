import { MalformedFileError } from "../../../../utils/errors";
import { Readable } from "node:stream";
import type {
  ParsedRow,
  ParseResult,
  ExtractedFile,
  ZipExtractionResult,
  MappingSelectionRule,
} from "../types";

interface MappingSelectionContext {
  readonly requestType?: string;
  readonly zipFilename?: string;
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

/**
 * Parse JSON array of objects OR single object into rows
 * Supports input formats:
 *   1. Array: [{ "field1": "value1" }, { "field2": "value2" }]
 *   2. Object: { "field1": "value1", "field2": "value2" }
 *
 * Objects are automatically wrapped in an array for processing
 */
export function parseJSON(content: string): ParseResult {
  // Validate content before parsing
  if (isEmptyContent(content)) {
    throw new MalformedFileError("File is empty or contains only whitespace");
  }

  if (isBinaryContent(content)) {
    throw new MalformedFileError("File appears to be binary, not valid JSON");
  }

  try {
    let data = JSON.parse(content);

    // Support both array and single object
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      // Single object: wrap in array
      data = [data];
    }

    if (!Array.isArray(data)) {
      throw new MalformedFileError("JSON must be an array of objects or a single object");
    }

    if (data.length === 0) {
      return {
        headers: [],
        rows: [],
        totalRows: 0,
      };
    }

    // Validate all items are objects
    for (let i = 0; i < data.length; i++) {
      if (typeof data[i] !== "object" || data[i] === null || Array.isArray(data[i])) {
        throw new MalformedFileError(`Item at index ${i} is not an object`);
      }
    }

    // Get headers from the first object's keys
    const headers = Object.keys(data[0]);

    if (headers.length < 2) {
      throw new MalformedFileError(
        `Invalid JSON structure: only ${headers.length} field(s) detected.`,
      );
    }

    // Convert each object to a row, preserving nested structure
    const rows: ParsedRow[] = data.map((item: Record<string, unknown>, index: number) => {
      return {
        rowNumber: index + 1, // 1-indexed
        data: item,
      };
    });

    return {
      headers,
      rows,
      totalRows: rows.length,
    };
  } catch (error) {
    if (error instanceof MalformedFileError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new MalformedFileError(`Invalid JSON syntax: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : "Unknown parsing error";
    throw new MalformedFileError(`Failed to parse JSON: ${message}`);
  }
}

/**
 * Match a filename against a pattern, supporting wildcards
 * Patterns can use:
 * - Exact match: "file.json"
 * - Wildcard: "*.json" matches any JSON file
 */
export function compilePattern(pattern: string): RegExp {
  // Regex-like patterns support:
  // - {a|b|c} as alternation
  // - * as wildcard
  // - standard regex tokens (e.g. \d+)
  const regexLike = /[{}\\+()[\]^$|]/.test(pattern);

  if (regexLike) {
    let transformed = pattern.replace(/\{([^{}]+)\}/g, (_m, group: string) => {
      const options = group
        .split("|")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .join("|");
      return `(${options})`;
    });

    transformed = transformed.replace(/\*/g, ".*");
    return new RegExp(`^${transformed}$`, "i");
  }

  const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexPattern}$`, "i");
}

interface PatternMatchResult {
  readonly matched: boolean;
  readonly captures: Record<string, string>;
}

function matchPattern(value: string, pattern: string): PatternMatchResult {
  if (pattern === value) {
    return { matched: true, captures: {} };
  }
  const regex = compilePattern(pattern);
  const match = regex.exec(value);
  if (!match) {
    return { matched: false, captures: {} };
  }
  const captures: Record<string, string> = {};
  if (match.groups) {
    for (const [key, val] of Object.entries(match.groups)) {
      if (val !== undefined) captures[key] = val;
    }
  }
  return { matched: true, captures };
}

/**
 * Extract the date embedded in a zip filename as a Date, supporting either:
 * - "YYYYMMDDTHHMMSS" (e.g. "SHOPEE__PRODUCT_SKUS__PH__DS__TM__20260821T163000.zip")
 * - "YYYY-MM-DD_HH_MM" (e.g. "TikTok_products_daily_VN_6x_dalat_2026-09-14_12_56.zip")
 * Returns undefined when neither is present.
 */
function extractDateFromZipFilename(zipFilename: string): Date | undefined {
  const match =
    /(\d{4})(\d{2})(\d{2})T\d{6}/.exec(zipFilename) ??
    /(\d{4})-(\d{2})-(\d{2})_\d{2}_\d{2}/.exec(zipFilename);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Determine which mapping to use for a given filename based on selection rules
 * Rules are evaluated in order, first match wins
 */
interface MappingSelectionResult {
  readonly mappingId: string;
  readonly captures: Record<string, string>;
}

function selectMappingForFile(
  filename: string,
  filePath: string,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
): MappingSelectionResult | undefined {
  if (selectionRules && selectionRules.length > 0) {
    for (const rule of selectionRules) {
      if (!rule.filename || !rule.mappingId) continue;

      if (rule.requestType && context?.requestType && rule.requestType !== context.requestType) {
        continue;
      }

      if (rule.zipFilename && context?.zipFilename) {
        const zipMatch = matchPattern(context.zipFilename, rule.zipFilename);
        if (!zipMatch.matched) continue;
      }

      if (rule.zipFilenameDateFrom) {
        const zipDate = context?.zipFilename
          ? extractDateFromZipFilename(context.zipFilename)
          : undefined;
        if (!zipDate || zipDate < new Date(`${rule.zipFilenameDateFrom}T00:00:00.000Z`)) {
          continue;
        }
      }

      // If pattern includes path separators, match against full zip entry path.
      // Otherwise preserve existing basename-only behavior.
      const target = rule.filename.includes("/") ? filePath : filename;

      const result = matchPattern(target, rule.filename);
      if (result.matched) {
        return { mappingId: rule.mappingId, captures: result.captures };
      }
    }

    // When explicit selection rules are configured, only matching files
    // should be processed; unmatched files are skipped.
    return undefined;
  }

  return defaultMapping ? { mappingId: defaultMapping, captures: {} } : undefined;
}

function extractRegionFromPath(
  filePath: string,
  knownRegions?: ReadonlyArray<string>,
): string | undefined {
  const allowed =
    knownRegions && knownRegions.length > 0
      ? new Set(knownRegions.map((r) => r.toLowerCase()))
      : new Set(["id", "my", "ph", "sg", "th", "tw", "vn", "cn"]);

  const segments = filePath.split("/");

  // Strong match: the segment, taken as a whole, IS a region code (optionally
  // suffixed with "_shops"/"-shops"), e.g. "SG_shops" or "ID". Checked across
  // all segments before any fallback below, so a purpose-built region folder
  // deeper in the path (e.g. ".../SG_shops/<shop>/<file>.json") wins over an
  // incidental region-like word embedded in an unrelated multi-word segment,
  // such as a batch/root folder name ("TikTok_products_daily_VN_6x_...")
  // that must not be read as region "vn" just because "vn" appears as one
  // word among many.
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const strongMatch = lower.match(/^([a-z]+)(?:[_-]shops)?$/);
    if (strongMatch && allowed.has(strongMatch[1])) {
      return strongMatch[1];
    }
  }

  // Fallback: scan all segments for a region token embedded among other
  // words (looser formats not covered by the strong-match pass above), e.g.
  // "output/ID/<file>.json" or "PH.something".
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const parts = lower.split(/[^a-z]+/).filter((p) => p.length > 0);
    for (const part of parts) {
      if (allowed.has(part)) {
        return part;
      }
    }
  }

  return undefined;
}

/**
 * Extract all JSON files from a ZIP archive
 * Each JSON file is processed individually and associated with its own mapping
 */
export async function extractJSONFromZip(
  zipBuffer: Buffer,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
  knownRegions?: ReadonlyArray<string>,
): Promise<ZipExtractionResult> {
  const files: ExtractedFile[] = [];
  for await (const file of streamJSONFromZip(
    zipBuffer,
    selectionRules,
    defaultMapping,
    context,
    knownRegions,
  )) {
    files.push(file);
  }

  return { files };
}

/**
 * Stream JSON files from a ZIP archive one-by-one.
 * This avoids building large in-memory arrays before processing can begin.
 */
export async function* streamJSONFromZip(
  zipBuffer: Buffer,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
  knownRegions?: ReadonlyArray<string>,
): AsyncGenerator<ExtractedFile, void, void> {
  const stream = Readable.from(zipBuffer);
  yield* streamJSONFromZipStream(stream, selectionRules, defaultMapping, context, knownRegions);
}

export interface ZipStreamStats {
  discoveredFileCount: number;
  discoveredFilePaths?: string[];
  malformedFilePaths?: string[];
  malformedFileDetails?: Array<{ file: string; reason: string }>;
}

export async function* streamJSONFromZipStream(
  zipStream: Readable,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
  knownRegions?: ReadonlyArray<string>,
  stats?: ZipStreamStats,
): AsyncGenerator<ExtractedFile, void, void> {
  const MAX_TRACKED_PATHS = 200;
  const pushLimited = (list: string[] | undefined, value: string): string[] => {
    const target = list ?? [];
    if (target.length < MAX_TRACKED_PATHS) {
      target.push(value);
    }
    return target;
  };
  const pushMalformedDetail = (
    list: Array<{ file: string; reason: string }> | undefined,
    file: string,
    reason: string,
  ): Array<{ file: string; reason: string }> => {
    const target = list ?? [];
    if (target.length < MAX_TRACKED_PATHS) {
      target.push({ file, reason });
    }
    return target;
  };

  // Track all files for diagnostics
  const allFilePaths = new Set<string>();
  const extensionCounts = new Map<string, number>();
  const topLevelFolders = new Set<string>();

  try {
    const unzipper = await import("unzipper");
    const parser = zipStream.pipe(unzipper.Parse({ forceStream: true }));

    let discoveredJsonFiles = 0;
    let yieldedFiles = 0;
    let matchedFiles = 0;

    for await (const entry of parser) {
      const filePath = entry.path;
      const isFile = entry.type === "File" && typeof filePath === "string";

      // Track all files for diagnostics
      if (isFile) {
        allFilePaths.add(filePath);

        // Extract top-level folder
        const firstSlash = filePath.indexOf("/");
        if (firstSlash > 0) {
          topLevelFolders.add(filePath.substring(0, firstSlash));
        }

        // Track file extension
        const ext = filePath.includes(".")
          ? filePath.substring(filePath.lastIndexOf("."))
          : "(no extension)";
        extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
      }

      const isJsonEntry =
        entry.type === "File" &&
        typeof filePath === "string" &&
        filePath.toLowerCase().endsWith(".json");

      if (!isJsonEntry) {
        entry.autodrain();
        continue;
      }

      discoveredJsonFiles++;
      if (stats) {
        stats.discoveredFilePaths = pushLimited(stats.discoveredFilePaths, filePath);
      }

      const filename = filePath.split("/").pop() || "";

      // Determine mapping before parsing so unmatched files (e.g. fail/*)
      // can be skipped without causing parse errors.
      const selection = selectMappingForFile(
        filename,
        filePath,
        selectionRules,
        defaultMapping,
        context,
      );

      if (!selection) {
        entry.autodrain();
        continue;
      }

      matchedFiles++;

      try {
        const content = await entry.buffer();
        const contentStr = content.toString("utf-8");

        // Parse the JSON content
        let data = JSON.parse(contentStr);

        // Support both array and single object
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          data = [data];
        }

        if (!Array.isArray(data)) {
          throw new MalformedFileError(`Invalid JSON in ${filePath}: must be array or object`);
        }

        const region = extractRegionFromPath(filePath, knownRegions);

        yieldedFiles++;
        yield {
          filename,
          path: filePath,
          data,
          mappingId: selection.mappingId,
          region,
          captures: selection.captures,
        };
      } catch (fileError) {
        const message = fileError instanceof Error ? fileError.message : "Unknown error";
        if (stats) {
          stats.malformedFilePaths = pushLimited(stats.malformedFilePaths, filePath);
          stats.malformedFileDetails = pushMalformedDetail(
            stats.malformedFileDetails,
            filePath,
            message,
          );
        }
      }
    }

    if (stats) {
      stats.discoveredFileCount = discoveredJsonFiles;
    }

    // Build diagnostic object for error cases
    const buildDiagnostic = () => {
      const sampleFilePaths = Array.from(allFilePaths).slice(0, 5);
      const fileExtensions = Array.from(extensionCounts.keys()).sort();
      const expectedPatterns = selectionRules
        ? selectionRules.map((r) => r.filename).join(" or ")
        : "*.json";

      return {
        expectedPattern: expectedPatterns,
        totalFilesInZip: allFilePaths.size,
        jsonFilesFound: discoveredJsonFiles,
        filesMatched: matchedFiles,
        topLevelFolders: Array.from(topLevelFolders).sort(),
        fileExtensionsFound: fileExtensions,
        sampleFilePaths,
      };
    };

    if (discoveredJsonFiles === 0) {
      throw new MalformedFileError("No JSON files found in ZIP archive", buildDiagnostic());
    }

    if (yieldedFiles === 0) {
      if (matchedFiles === 0) {
        // Check if the failure is specifically because the request type is not
        // defined in any selection rule, as opposed to a filename pattern mismatch.
        if (
          context?.requestType &&
          selectionRules &&
          selectionRules.length > 0 &&
          !selectionRules.some((r) => !r.requestType || r.requestType === context.requestType)
        ) {
          throw new MalformedFileError(
            `Request type '${context.requestType}' is not supported in the vendor mapping configuration`,
            buildDiagnostic(),
          );
        }
        throw new MalformedFileError(
          "No matching JSON files found in ZIP archive",
          buildDiagnostic(),
        );
      }
      throw new MalformedFileError("No valid JSON files found in ZIP archive", buildDiagnostic());
    }
  } catch (error) {
    if (error instanceof MalformedFileError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new MalformedFileError(`Invalid JSON syntax in ZIP file: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new MalformedFileError(`Failed to extract ZIP: ${message}`);
  }
}
