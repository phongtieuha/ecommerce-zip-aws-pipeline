import { MalformedFileError } from "../../../../utils/errors";
import { Readable } from "node:stream";
import type { ExtractedFile, MappingSelectionRule } from "../types";
export { getHtmlNestedValue, resolveHtmlSelectorValue } from "./path-resolver";

export interface ParsedRow {
  readonly rowNumber: number;
  readonly data: Record<string, unknown>;
}

export interface ParseResult {
  readonly headers: string[];
  readonly rows: ParsedRow[];
  readonly totalRows: number;
}

interface MappingSelectionContext {
  readonly requestType?: string;
  readonly zipFilename?: string;
}

function isBinaryContent(content: string): boolean {
  let nonPrintable = 0;
  const sampleSize = Math.min(content.length, 1000);
  for (let i = 0; i < sampleSize; i++) {
    const code = content.codePointAt(i) ?? 0;
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      nonPrintable++;
    }
  }

  return nonPrintable / sampleSize > 0.1;
}

function parseHtmlDocument(content: string): Record<string, unknown> {
  const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";

  return {
    __html: content,
    html: content,
    title,
  };
}

/**
 * Extract the inner content of a <body> tag from a raw HTML document string.
 * Returns an empty string when no <body> tag is present, rather than falling
 * back to the full document — a malformed/truncated file (missing </body>)
 * would otherwise leak <head>/<script>/<style> content into mapped fields.
 */
export function extractHtmlBody(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return match ? match[1].trim() : "";
}

export function parseHTML(content: string): ParseResult {
  if (content.trim().length === 0) {
    throw new MalformedFileError("File is empty or contains only whitespace");
  }

  if (isBinaryContent(content)) {
    throw new MalformedFileError("File appears to be binary, not valid HTML");
  }

  const data = parseHtmlDocument(content);

  return {
    headers: Object.keys(data),
    rows: [{ rowNumber: 1, data }],
    totalRows: 1,
  };
}

function compilePattern(pattern: string): RegExp {
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

      const target = rule.filename.includes("/") ? filePath : filename;
      const result = matchPattern(target, rule.filename);
      if (result.matched) {
        return { mappingId: rule.mappingId, captures: result.captures };
      }
    }

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

  const normalizeSegment = (segment: string): string | undefined => {
    const lower = segment.toLowerCase();
    if (allowed.has(lower)) return lower;

    const parts = lower.split(/[^a-z]+/).filter((p) => p.length > 0);
    for (const part of parts) {
      if (allowed.has(part)) return part;
    }

    return undefined;
  };

  for (const segment of filePath.split("/")) {
    const region = normalizeSegment(segment);
    if (region) return region;
  }

  return undefined;
}

export async function* streamHTMLFromZip(
  zipBuffer: Buffer,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
  knownRegions?: ReadonlyArray<string>,
): AsyncGenerator<ExtractedFile, void, void> {
  const stream = Readable.from(zipBuffer);
  yield* streamHTMLFromZipStream(stream, selectionRules, defaultMapping, context, knownRegions);
}

export interface ZipStreamStats {
  discoveredFileCount: number;
}

export async function* streamHTMLFromZipStream(
  zipStream: Readable,
  selectionRules?: ReadonlyArray<MappingSelectionRule>,
  defaultMapping?: string,
  context?: MappingSelectionContext,
  knownRegions?: ReadonlyArray<string>,
  stats?: ZipStreamStats,
): AsyncGenerator<ExtractedFile, void, void> {
  try {
    const unzipper = await import("unzipper");
    const parser = zipStream.pipe(unzipper.Parse({ forceStream: true }));

    let discoveredHtmlFiles = 0;

    let yieldedFiles = 0;

    const MAX_MALFORMED_HTML_LOGS = 3;
    let malformedHtmlEntryCount = 0;

    for await (const entry of parser) {
      const filePath = entry.path;
      const isHtmlEntry =
        entry.type === "File" &&
        typeof filePath === "string" &&
        (filePath.toLowerCase().endsWith(".html") || filePath.toLowerCase().endsWith(".htm"));

      if (!isHtmlEntry) {
        entry.autodrain();
        continue;
      }

      discoveredHtmlFiles++;
      const filename = filePath.split("/").pop() || "";

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

      try {
        const content = await entry.buffer();
        const contentStr = content.toString("utf-8");
        const parsed = parseHTML(contentStr);
        const region = extractRegionFromPath(filePath, knownRegions);

        yieldedFiles++;
        yield {
          filename,
          path: filePath,
          data: parsed.rows.map((row) => row.data),
          mappingId: selection.mappingId,
          region,
          captures: selection.captures,
        };
      } catch (fileError) {
        const message = fileError instanceof Error ? fileError.message : "Unknown error";
        malformedHtmlEntryCount++;
        if (malformedHtmlEntryCount <= MAX_MALFORMED_HTML_LOGS) {
          console.warn(`Skipping malformed HTML entry ${filePath}: ${message}`);
        }
      }
    }

    if (malformedHtmlEntryCount > MAX_MALFORMED_HTML_LOGS) {
      console.warn(
        `Skipped ${malformedHtmlEntryCount} malformed HTML entries total (showing first ${MAX_MALFORMED_HTML_LOGS})`,
      );
    }

    if (stats) {
      stats.discoveredFileCount = discoveredHtmlFiles;
    }

    if (discoveredHtmlFiles === 0) {
      throw new MalformedFileError("No HTML files found in ZIP archive");
    }

    if (yieldedFiles === 0) {
      throw new MalformedFileError("No valid HTML files found in ZIP archive");
    }
  } catch (error) {
    if (error instanceof MalformedFileError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    throw new MalformedFileError(`Failed to extract ZIP HTML: ${message}`);
  }
}
