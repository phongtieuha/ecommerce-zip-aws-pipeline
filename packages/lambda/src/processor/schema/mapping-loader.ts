import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VendorMapping } from "@filepipeline/shared";
import { MissingMappingError, ValidationConfigError } from "../../../utils/errors";

const mappingsCache = new Map<string, VendorMapping>();
const indexCache = new Map<string, VendorMappingIndex>();

interface VendorMappingIndex {
  readonly vendor: string;
  readonly mappings: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly file: string;
    readonly description: string;
  }>;
  readonly default: string;
  readonly selectionRules?: ReadonlyArray<{
    readonly filename: string;
    readonly mappingId: string;
    readonly requestType?: string;
    readonly zipFilename?: string;
  }>;
  readonly regions?: ReadonlyArray<string>;
  readonly pathExtraction?: {
    readonly path: string;
  };
}

function isSpecialSourceToken(source: string): boolean {
  return (
    source === "$root" ||
    source.startsWith("$root.") ||
    source.startsWith("$root|") ||
    source === "$fileName" ||
    source.startsWith("$fileName|") ||
    source === "$s3" ||
    source.startsWith("$s3.") ||
    source.startsWith("$s3|") ||
    source === "$keywordFromFoldername" ||
    source === "$dateFromZipName" ||
    source.startsWith("$dateFromZipName|") ||
    source === "$match" ||
    source.startsWith("$match.") ||
    source.startsWith("$match|") ||
    source === "$timestampFromFilename" ||
    source.startsWith("$timestampFromFilename|") ||
    source === "$zipFilename" ||
    source.startsWith("$zipFilename|") ||
    source.startsWith("$lookup.")
  );
}

function isValidHtmlSourceExpression(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return true;
  if (isSpecialSourceToken(trimmed)) return true;

  return trimmed
    .split("||")
    .map((part) => part.trim())
    .every(
      (part) =>
        part.startsWith("document.querySelector(") || part.startsWith("document.querySelectorAll("),
    );
}

function isValidRankingKind(kind: unknown): boolean {
  return kind === "download" || kind === "ads" || kind === "organic" || kind === "overall";
}

function getMappingsDir(): string {
  // In Lambda, mappings are bundled alongside the function code
  const lambdaPath = join("/var/task", "mappings");
  const localPath = join(process.cwd(), "..", "..", "mappings");
  const repoRootPath = join(process.cwd(), "mappings");

  if (existsSync(lambdaPath)) return lambdaPath;
  if (existsSync(localPath)) return localPath;
  if (existsSync(repoRootPath)) return repoRootPath;

  throw new ValidationConfigError(`Mappings directory not found`);
}

export function loadVendorMappingIndex(vendor: string): VendorMappingIndex {
  const cached = indexCache.get(vendor);
  if (cached) return cached;

  const mappingsDir = getMappingsDir();
  const vendorDir = join(mappingsDir, vendor);
  const indexFile = join(vendorDir, "index.json");

  // Check if vendor directory and index exist
  if (!existsSync(vendorDir) || !existsSync(indexFile)) {
    throw new MissingMappingError(vendor);
  }

  let index: VendorMappingIndex;
  try {
    const indexContent = readFileSync(indexFile, "utf-8");
    index = JSON.parse(indexContent) as VendorMappingIndex;
  } catch (error) {
    throw new ValidationConfigError(`Failed to load mapping index for vendor ${vendor}: ${error}`);
  }

  if (!index.vendor || !Array.isArray(index.mappings) || typeof index.default !== "string") {
    throw new ValidationConfigError(`Invalid mapping index for vendor ${vendor}`);
  }

  if (index.selectionRules) {
    for (const rule of index.selectionRules) {
      if (!rule.filename || !rule.mappingId) {
        throw new ValidationConfigError(
          `Invalid mapping selection rule for vendor ${vendor}: ${JSON.stringify(rule)}`,
        );
      }
    }
  }

  indexCache.set(vendor, index);
  return index;
}

/**
 * Load vendor mapping configuration
 * @param vendor - Vendor name (e.g., "Shopee")
 * @param mappingId - Optional specific mapping ID (e.g., "Shopee-Products"). If not provided, uses default from index.
 */
export function loadVendorMapping(vendor: string, mappingId?: string): VendorMapping {
  const mappingsDir = getMappingsDir();
  const vendorDir = join(mappingsDir, vendor);
  const index = loadVendorMappingIndex(vendor);

  // Determine which mapping to use
  const targetMappingId = mappingId || index.default;
  const mappingInfo = index.mappings.find((m) => m.id === targetMappingId);

  if (!mappingInfo) {
    throw new ValidationConfigError(
      `Mapping ID "${targetMappingId}" not found for vendor ${vendor}`,
    );
  }

  // Check cache with composite key
  const cacheKey = `${vendor}:${targetMappingId}`;
  const cached = mappingsCache.get(cacheKey);
  if (cached) return cached;

  // Load the mapping file
  const mappingFile = join(vendorDir, mappingInfo.file);
  if (!existsSync(mappingFile)) {
    throw new MissingMappingError(`${vendor}/${mappingInfo.file}`);
  }

  try {
    const content = readFileSync(mappingFile, "utf-8");
    const mapping = JSON.parse(content) as VendorMapping;

    // Validate mapping structure
    if (!mapping.vendor || !mapping.columns) {
      throw new ValidationConfigError(`Invalid mapping file: ${mappingFile}`);
    }

    // Validate parser hint for upcoming parser routing.
    if (mapping.parser !== undefined && mapping.parser !== "json" && mapping.parser !== "html") {
      throw new ValidationConfigError(
        `Invalid parser in mapping ${mappingFile}: expected "json" or "html"`,
      );
    }

    // Validate pathExtraction if present
    if (mapping.pathExtraction) {
      if (!mapping.pathExtraction.path && !mapping.pathExtraction.scriptExpression) {
        throw new ValidationConfigError(
          `Invalid pathExtraction in mapping ${mappingFile}: path or scriptExpression is required`,
        );
      }

      if (mapping.pathExtraction.scriptExpression !== undefined) {
        if (
          typeof mapping.pathExtraction.scriptExpression !== "string" ||
          !mapping.pathExtraction.scriptExpression.trim()
        ) {
          throw new ValidationConfigError(
            `Invalid pathExtraction in mapping ${mappingFile}: scriptExpression must be a non-empty string`,
          );
        }
      }

      if (mapping.pathExtraction.ignoreIfContains !== undefined) {
        if (!Array.isArray(mapping.pathExtraction.ignoreIfContains)) {
          throw new ValidationConfigError(
            `Invalid pathExtraction in mapping ${mappingFile}: ignoreIfContains must be an array`,
          );
        }

        for (const [index, rule] of mapping.pathExtraction.ignoreIfContains.entries()) {
          if (!rule || typeof rule.path !== "string" || !rule.path.trim()) {
            throw new ValidationConfigError(
              `Invalid pathExtraction.ignoreIfContains[${index}] in mapping ${mappingFile}: path is required`,
            );
          }

          if (!rule || (typeof rule.text !== "string" && !Array.isArray(rule.text))) {
            throw new ValidationConfigError(
              `Invalid pathExtraction.ignoreIfContains[${index}] in mapping ${mappingFile}: text must be a string or array of strings`,
            );
          }
          const texts = Array.isArray(rule.text) ? rule.text : [rule.text];
          if (
            texts.length === 0 ||
            texts.some((t: unknown) => typeof t !== "string" || !t.trim())
          ) {
            throw new ValidationConfigError(
              `Invalid pathExtraction.ignoreIfContains[${index}] in mapping ${mappingFile}: text entries must be non-empty strings`,
            );
          }

          if (rule.caseInsensitive !== undefined && typeof rule.caseInsensitive !== "boolean") {
            throw new ValidationConfigError(
              `Invalid pathExtraction.ignoreIfContains[${index}] in mapping ${mappingFile}: caseInsensitive must be boolean`,
            );
          }
        }
      }

      if (mapping.pathExtraction.deduplicateByTimestamp !== undefined) {
        const dedup = mapping.pathExtraction.deduplicateByTimestamp;
        if (typeof dedup !== "object" || dedup === null || Array.isArray(dedup)) {
          throw new ValidationConfigError(
            `Invalid pathExtraction.deduplicateByTimestamp in mapping ${mappingFile}: must be an object`,
          );
        }
        if (typeof dedup.pattern !== "string" || !dedup.pattern.trim()) {
          throw new ValidationConfigError(
            `Invalid pathExtraction.deduplicateByTimestamp.pattern in mapping ${mappingFile}: must be a non-empty string`,
          );
        }
        try {
          const testRegex = new RegExp(dedup.pattern);
          // Verify the pattern has at least 2 capture groups by testing exec on a dummy string
          const src = testRegex.source;
          const openParens = (src.match(/\((?!\?)/g) || []).length;
          if (openParens < 2) {
            throw new ValidationConfigError(
              `Invalid pathExtraction.deduplicateByTimestamp.pattern in mapping ${mappingFile}: must have at least 2 capture groups (keyword and timestamp)`,
            );
          }
        } catch (e) {
          if (e instanceof ValidationConfigError) throw e;
          throw new ValidationConfigError(
            `Invalid pathExtraction.deduplicateByTimestamp.pattern in mapping ${mappingFile}: invalid regex: ${(e as Error).message}`,
          );
        }
        if (dedup.keywordPath !== undefined) {
          if (typeof dedup.keywordPath !== "string" || !dedup.keywordPath.trim()) {
            throw new ValidationConfigError(
              `Invalid pathExtraction.deduplicateByTimestamp.keywordPath in mapping ${mappingFile}: must be a non-empty string`,
            );
          }
        }
      }
    }

    if (mapping.companionSource) {
      if (mapping.parser === "html") {
        throw new ValidationConfigError(
          `Invalid companionSource in mapping ${mappingFile}: not supported when parser is "html" (companion values are injected as a plain field, which the HTML parser's CSS-selector source resolution cannot read)`,
        );
      }
      if (
        typeof mapping.companionSource.filePattern !== "string" ||
        !mapping.companionSource.filePattern.trim()
      ) {
        throw new ValidationConfigError(
          `Invalid companionSource in mapping ${mappingFile}: filePattern must be a non-empty string`,
        );
      }
      if (
        typeof mapping.companionSource.injectAs !== "string" ||
        !mapping.companionSource.injectAs.trim()
      ) {
        throw new ValidationConfigError(
          `Invalid companionSource in mapping ${mappingFile}: injectAs must be a non-empty string`,
        );
      }
    }

    if (mapping.parser === "html" && !mapping.pathExtraction?.scriptExpression) {
      for (const [fieldName, fieldMapping] of Object.entries(mapping.columns)) {
        if (
          fieldMapping.compute &&
          (fieldMapping.compute.type !== "ranking" ||
            !isValidRankingKind(fieldMapping.compute.kind))
        ) {
          throw new ValidationConfigError(
            `Invalid compute config for ${mappingFile} field \"${fieldName}\"`,
          );
        }

        if (
          typeof fieldMapping.source === "string" &&
          fieldMapping.source.trim().length > 0 &&
          !isValidHtmlSourceExpression(fieldMapping.source)
        ) {
          throw new ValidationConfigError(
            `Invalid HTML source for ${mappingFile} field \"${fieldName}\": use document.querySelector(...) convention`,
          );
        }
      }
    } else {
      for (const [fieldName, fieldMapping] of Object.entries(mapping.columns)) {
        if (
          fieldMapping.compute &&
          (fieldMapping.compute.type !== "ranking" ||
            !isValidRankingKind(fieldMapping.compute.kind))
        ) {
          throw new ValidationConfigError(
            `Invalid compute config for ${mappingFile} field \"${fieldName}\"`,
          );
        }
      }
    }

    // Cache it
    mappingsCache.set(cacheKey, mapping);
    const parserHint = mapping.parser ?? "json";
    console.log(`Loaded mapping: ${vendor} → ${targetMappingId} (parser hint: ${parserHint})`);
    return mapping;
  } catch (error) {
    if (error instanceof MissingMappingError || error instanceof ValidationConfigError) {
      throw error;
    }
    throw new ValidationConfigError(`Failed to load mapping ${mappingFile}: ${error}`);
  }
}

export function clearMappingCache(): void {
  mappingsCache.clear();
  indexCache.clear();
}
