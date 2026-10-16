import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";
import countryToCurrency from "country-to-currency";
import type { VendorMapping } from "@filepipeline/shared";
import { count_bullets_clean as count_bullets_clean_vn } from "@filepipeline/shared/utility/bullet-points/vn";
import { count_charactes_no_bullet as count_charactes_no_bullet_vn } from "@filepipeline/shared/utility/bullet-points/vn";
import { count_bullets_clean as count_bullets_clean_id } from "@filepipeline/shared/utility/bullet-points/id";
import { count_charactes_no_bullet as count_charactes_no_bullet_id } from "@filepipeline/shared/utility/bullet-points/id";
import { count_bullets_clean as count_bullets_clean_th } from "@filepipeline/shared/utility/bullet-points/th";
import { count_charactes_no_bullet as count_charactes_no_bullet_th } from "@filepipeline/shared/utility/bullet-points/th";
import { count_bullets_clean as count_bullets_clean_ph } from "@filepipeline/shared/utility/bullet-points/ph";
import { count_charactes_no_bullet as count_charactes_no_bullet_ph } from "@filepipeline/shared/utility/bullet-points/ph";

/**
 * Local parser tool for business users
 * Parses a JSON file with a specific vendor mapping and outputs CSV + Excel
 * Usage: bun run parser --vendor=Tiktok --file=./data.json
 *
 * Note: Does NOT require AWS services (S3, DynamoDB).
 * Uses only the validation and transformation logic from the Lambda processor.
 */

// Resolve executable/script location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveMappingsDir(args: Record<string, string>): string {
  const explicitMappingsDir = args["mappings-dir"] || process.env.PARSER_MAPPINGS_DIR;

  if (explicitMappingsDir) {
    const resolved = resolve(process.cwd(), explicitMappingsDir);
    if (existsSync(resolved)) {
      return resolved;
    }
    throw new Error(`Mappings directory not found: ${resolved}`);
  }

  const candidates = [
    join(__dirname, "mappings"),
    join(__dirname, "..", "mappings"),
    join(__dirname, "..", "..", "mappings"),
    join(process.cwd(), "mappings"),
    join(process.cwd(), "..", "mappings"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not locate mappings directory. Provide --mappings-dir=/path/to/mappings or set PARSER_MAPPINGS_DIR.",
  );
}

// Parse command-line arguments
function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const params: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (key && value) {
        params[key] = value;
      } else if (arg === "--help" || arg === "-h") {
        params["help"] = "true";
      }
    }
  }

  return params;
}

// Load all vendor information
function loadVendorInfo(mappingsDir?: string): Array<{
  name: string;
  mappings: Array<{ id: string; name: string; description: string }>;
  filePatterns: Array<{ pattern: string; mappingId: string; description: string }>;
}> {
  const vendors: Array<{
    name: string;
    mappings: Array<{ id: string; name: string; description: string }>;
    filePatterns: Array<{ pattern: string; mappingId: string; description: string }>;
  }> = [];

  if (!mappingsDir) {
    return vendors;
  }

  try {
    const vendorDirs = readdirSync(mappingsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const vendorDir of vendorDirs) {
      try {
        const indexPath = join(mappingsDir, vendorDir, "index.json");
        const indexContent = readFileSync(indexPath, "utf-8");
        const index = JSON.parse(indexContent);

        vendors.push({
          name: index.vendor || vendorDir,
          mappings: (index.mappings || []).map(
            (m: { id: string; name: string; description: string }) => ({
              id: m.id,
              name: m.name,
              description: m.description,
            }),
          ),
          filePatterns: (index.selectionRules || []).map(
            (rule: { filename: string; mappingId: string }) => {
              const mapping = (index.mappings || []).find(
                (m: { id: string }) => m.id === rule.mappingId,
              );
              return {
                pattern: rule.filename,
                mappingId: rule.mappingId,
                description: mapping?.name || rule.mappingId,
              };
            },
          ),
        });
      } catch {
        // Skip vendors with invalid configuration
      }
    }
  } catch {
    // Mappings directory not found
  }

  return vendors;
}

// Display help information
function showHelp(mappingsDir?: string) {
  const vendorInfo = loadVendorInfo(mappingsDir);

  console.log("");
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║           📊 FilePipeline Local Parser Tool                        ║");
  console.log("║     Transform vendor JSON files to CSV and Excel formats        ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("");

  console.log("USAGE:");
  console.log("  bun run parser --vendor=VENDOR --file=PATH [--region=REGION]");
  console.log("");

  console.log("OPTIONS:");
  console.log("  --vendor=NAME   Vendor name (see supported vendors below)");
  console.log("  --file=PATH     Path to JSON file (absolute or relative)");
  console.log("  --region=CODE   Region code for region-specific fields (vn, th, ph, etc.)");
  console.log("  --mappings-dir=PATH  Optional mappings directory path");
  console.log("  --help, -h      Show this help message");
  console.log("");

  console.log("SUPPORTED VENDORS & FILE NAMING CONVENTIONS:");
  console.log("");

  for (const vendor of vendorInfo) {
    console.log(`📦 ${vendor.name}`);

    if (vendor.filePatterns.length > 0) {
      console.log("   File Naming Patterns:");
      for (const pattern of vendor.filePatterns) {
        console.log(`     • ${pattern.pattern.padEnd(15)} → ${pattern.description}`);
      }
    }

    if (vendor.mappings.length > 0) {
      console.log("   Available Mappings:");
      for (const mapping of vendor.mappings) {
        console.log(`     • ${mapping.id}`);
      }
    }
    console.log("");
  }

  console.log("EXAMPLES:");
  console.log("  # Parse a Tiktok product list file");
  console.log("  $ bun run parser --vendor=Tiktok --file=./data/products_.json");
  console.log("");
  console.log("  # Parse a Shopee PDP file with region");
  console.log("  $ bun run parser --vendor=Shopee --file=./data/product*.json --region=vn");
  console.log("");
  console.log("  # Parse a Lazada product list (alternate format)");
  console.log("  $ bun run parser --vendor=Lazada --file=./data/products_.json --region=th");
  console.log("");

  console.log("DETAILS:");
  console.log("  • The parser automatically selects the correct mapping based on");
  console.log("    the input filename pattern (e.g., _.json, *.json, +.json)");
  console.log("  • Output files are generated in the same directory as the input file");
  console.log("  • Both CSV and Excel (.xlsx) formats are created");
  console.log("  • Mappings are auto-discovered; override with --mappings-dir if needed");
  console.log("  • Region parameter ($s3 substitution): When a region is provided,");
  console.log("    field mappings with $s3 placeholders are automatically resolved");
  console.log("    (e.g., data.$s3.prices → data.vn.prices for --region=vn)");
  console.log("  • No AWS services (S3, DynamoDB, Lambda) required - runs locally");
  console.log("");
}

// Load vendor mapping from disk
function loadVendorMapping(
  vendor: string,
  filename: string,
  mappingsDir: string,
): {
  mapping: VendorMapping;
  selectedMappingId: string;
} {
  const vendorDir = join(mappingsDir, vendor);

  // First, try to load index.json to find the right mapping
  try {
    const indexPath = join(vendorDir, "index.json");
    const indexContent = readFileSync(indexPath, "utf-8");
    const index = JSON.parse(indexContent) as {
      default?: string;
      selectionRules?: Array<{ filename: string; mappingId: string }>;
      mappings?: Array<{ id: string; file: string }>;
    };

    // Determine which mapping to use based on filename
    let mappingId = index.default || "default";

    if (index.selectionRules) {
      for (const rule of index.selectionRules) {
        // Convert glob patterns to regex
        // First escape all regex special chars, then convert glob wildcards
        let pattern = rule.filename.replace(/[-[\]{}()*+?.\\^$|#\s]/g, "\\$&");
        // Now unescape the wildcards and convert them
        pattern = pattern.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");

        if (new RegExp(`^${pattern}$`).test(filename)) {
          mappingId = rule.mappingId;
          break;
        }
      }
    }

    // Find the mapping file
    let mappingFile = `${mappingId}.json`;
    if (index.mappings) {
      const mapping = index.mappings.find((m) => m.id === mappingId);
      if (mapping) {
        mappingFile = mapping.file;
      }
    }

    const mappingPath = join(vendorDir, mappingFile);
    const mappingContent = readFileSync(mappingPath, "utf-8");
    return {
      mapping: JSON.parse(mappingContent) as VendorMapping,
      selectedMappingId: mappingId,
    };
  } catch (error) {
    // Fallback: try to load vendor.json directly
    try {
      const mappingPath = join(vendorDir, `${vendor}.json`);
      const mappingContent = readFileSync(mappingPath, "utf-8");
      return {
        mapping: JSON.parse(mappingContent) as VendorMapping,
        selectedMappingId: vendor,
      };
    } catch {
      throw new Error(
        `Could not load mapping for vendor "${vendor}". Checked: ${vendorDir}/index.json and ${vendorDir}/${vendor}.json\nError: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Resolve a field value from a nested path in an object, with optional transformation
function resolveFieldValue(
  obj: Record<string, unknown>,
  path: string,
  context?: { country?: string; region?: string; s3?: Record<string, unknown> },
): unknown {
  if (!path) return undefined;

  const tokenizePath = (input: string): string[] => {
    const tokens: string[] = [];
    let i = 0;

    while (i < input.length) {
      const char = input[i];

      if (char === ".") {
        i += 1;
        continue;
      }

      if (char === "[") {
        const next = input[i + 1];

        // Bracket string key: ['key.with.dots'] or ["key.with.dots"]
        if (next === "'" || next === '"') {
          const quote = next;
          i += 2;
          const start = i;
          while (i < input.length && input[i] !== quote) {
            i += 1;
          }
          if (i >= input.length) {
            break;
          }
          tokens.push(input.slice(start, i));
          i += 1; // closing quote
          if (input[i] === "]") {
            i += 1;
          }
          continue;
        }

        // Bracket numeric index: [0]
        i += 1;
        const start = i;
        while (i < input.length && /[0-9]/.test(input[i])) {
          i += 1;
        }
        if (start < i) {
          tokens.push(input.slice(start, i));
        }
        if (input[i] === "]") {
          i += 1;
        }
        continue;
      }

      // Dot key segment
      const start = i;
      while (i < input.length && input[i] !== "." && input[i] !== "[") {
        i += 1;
      }
      if (start < i) {
        tokens.push(input.slice(start, i));
      }
    }

    return tokens;
  };

  // Handle transformations indicated by pipe (e.g., "field|date:YYYY-MM-DD" or "field|sum")
  let fieldPath = path;
  let transformation = "";

  if (path.includes("|")) {
    const parts = path.split("|");
    fieldPath = parts[0];
    transformation = parts.slice(1).join("|");
  }

  const getValueByPath = (target: unknown, pathExpr: string): unknown => {
    let current: unknown = target;
    const parts = tokenizePath(pathExpr);

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;

      if (part === "length") {
        if (Array.isArray(current) || typeof current === "string") {
          current = current.length;
          continue;
        }
        if (typeof current === "object") {
          current = Object.keys(current as Record<string, unknown>).length;
          continue;
        }
        return undefined;
      }

      const isArrayIndex = /^\d+$/.test(part);
      if (Array.isArray(current)) {
        if (!isArrayIndex) return undefined;
        current = current[Number.parseInt(part, 10)];
        continue;
      }

      if (typeof current === "object") {
        if (isArrayIndex) return undefined;
        current = (current as Record<string, unknown>)[part];
        continue;
      }

      return undefined;
    }

    return current;
  };

  const resolveDynamicBracketKeys = (pathExpr: string, target: unknown): string => {
    return pathExpr.replace(/\[([^\]]+)\]/g, (fullMatch, keyExpr: string) => {
      const trimmed = keyExpr.trim();
      if (!trimmed) return fullMatch;

      // Keep static bracket forms unchanged
      if (/^\d+$/.test(trimmed)) return fullMatch;
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return fullMatch;
      }

      // Resolve dynamic key from current source object (e.g. [$expansion.sku_id])
      const resolved = getValueByPath(target, trimmed);
      if (resolved === null || resolved === undefined) {
        return fullMatch;
      }

      const key = String(resolved).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return `["${key}"]`;
    });
  };

  const extractCountryCode = (input: unknown): string | undefined => {
    if (typeof input !== "string") return undefined;
    const normalized = input.trim().toLowerCase();
    if (!normalized) return undefined;

    const keyPathCountry = normalized.match(/^([a-z]{2})\/[^/]+\/\d{4}\/\d{2}\/\d{2}\//);
    if (keyPathCountry) return keyPathCountry[1];

    const directCountry = normalized.match(/^[a-z]{2}$/);
    if (directCountry) return normalized;

    const localeCountry = normalized.match(/^[a-z]{2}[-_][a-z]{2}$/);
    if (localeCountry) return normalized.split(/[-_]/)[1];

    const hashCountry = normalized.match(/^([a-z]{2})-/);
    if (hashCountry) return hashCountry[1];

    const hostCountry = normalized.match(/^([a-z]{2})\./);
    if (hostCountry) return hostCountry[1];

    if (
      normalized.startsWith("s3://") ||
      normalized.startsWith("http://") ||
      normalized.startsWith("https://")
    ) {
      try {
        const parsed = new URL(normalized);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) {
          return segments[0];
        }
      } catch {
        // Ignore URL parse failures.
      }
    }

    return undefined;
  };

  const resolveCountry = (valueForCountry: unknown): string => {
    const fromValue = extractCountryCode(valueForCountry);
    if (fromValue) return fromValue;

    const fromContext =
      extractCountryCode(context?.country) ||
      extractCountryCode(context?.region) ||
      extractCountryCode(getValueByPath(obj, "cube_metadata.country")) ||
      extractCountryCode(getValueByPath(obj, "country")) ||
      "";

    return fromContext;
  };

  const normalizeTextToken = (value: string): string => {
    return value
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const extractTextFieldsOnly = (value: unknown): string[] => {
    if (value === null || value === undefined) {
      return [];
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }

      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return extractTextFieldsOnly(JSON.parse(trimmed));
        } catch {
          return [];
        }
      }

      // Plain string not under a "text" key — skip, don't collect
      return [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => extractTextFieldsOnly(item));
    }

    if (typeof value === "object") {
      const objValue = value as Record<string, unknown>;
      const collected: string[] = [];

      for (const [key, child] of Object.entries(objValue)) {
        if (key === "text") {
          if (typeof child === "string") {
            const normalized = normalizeTextToken(child);
            if (normalized) {
              collected.push(normalized);
            }
          } else {
            collected.push(...extractTextFieldsOnly(child));
          }
          continue;
        }

        collected.push(...extractTextFieldsOnly(child));
      }

      return collected;
    }

    return [];
  };

  // Resolve the base field path
  let current: unknown;
  const resolvedFieldPath = resolveDynamicBracketKeys(fieldPath, obj);
  if (fieldPath === "$s3") {
    current = context?.s3;
  } else if (fieldPath.startsWith("$s3.")) {
    current = context?.s3
      ? getValueByPath(context.s3, resolvedFieldPath.slice("$s3.".length))
      : undefined;
  } else {
    current = getValueByPath(obj, resolvedFieldPath);
  }

  // Apply transformations (supports operation chains like a|extract_field_to_array:x|flatten|unique)
  if (transformation && current !== null && current !== undefined) {
    const operations = transformation.split("|").filter((op) => op.length > 0);

    for (const op of operations) {
      if (current === null || current === undefined) {
        break;
      }

      if (op.startsWith("date:")) {
        const format = op.substring(5);
        if (typeof current === "number" || typeof current === "string") {
          let timestamp = typeof current === "string" ? parseFloat(current) : current;
          if (timestamp < 100000000000) {
            timestamp = timestamp * 1000;
          }
          const date = new Date(timestamp);
          if (!isNaN(date.getTime())) {
            let formatted = format;
            formatted = formatted.replace("YYYY", date.getUTCFullYear().toString());
            formatted = formatted.replace("MM", String(date.getUTCMonth() + 1).padStart(2, "0"));
            formatted = formatted.replace("DD", String(date.getUTCDate()).padStart(2, "0"));
            formatted = formatted.replace("HH", String(date.getUTCHours()).padStart(2, "0"));
            formatted = formatted.replace("mm", String(date.getUTCMinutes()).padStart(2, "0"));
            formatted = formatted.replace("ss", String(date.getUTCSeconds()).padStart(2, "0"));
            current = formatted;
          }
        }
        continue;
      }

      if (op.startsWith("eq:")) {
        const expected = op.substring(3);
        current =
          current !== null && current !== undefined ? String(current) === expected : undefined;
        continue;
      }

      if (op.startsWith("gt:")) {
        const target = Number.parseFloat(op.substring(3));
        const left = Number.parseFloat(String(current));
        current = !Number.isNaN(left) && !Number.isNaN(target) ? left > target : undefined;
        continue;
      }

      if (op.startsWith("filter:")) {
        if (!Array.isArray(current)) {
          current = undefined;
          continue;
        }

        const condition = op.substring(7);
        const match = condition.match(/^(.+?)(===|!==|>=|<=|==|!=|>|<)(.+)$/);
        if (!match) {
          current = undefined;
          continue;
        }

        const [, filterPath, operator, rawValue] = match;
        const filtered = current.filter((item) => {
          if (!item || typeof item !== "object") return false;

          const itemValue = getValueByPath(item, filterPath.trim());
          if (itemValue === null || itemValue === undefined) return false;

          const left = Number.isNaN(Number(itemValue)) ? String(itemValue) : Number(itemValue);
          const right = Number.isNaN(Number(rawValue.trim()))
            ? rawValue.trim()
            : Number(rawValue.trim());

          switch (operator) {
            case ">":
              return typeof left === "number" && typeof right === "number" ? left > right : false;
            case "<":
              return typeof left === "number" && typeof right === "number" ? left < right : false;
            case ">=":
              return typeof left === "number" && typeof right === "number" ? left >= right : false;
            case "<=":
              return typeof left === "number" && typeof right === "number" ? left <= right : false;
            case "!=":
            case "!==":
              return String(left) !== String(right);
            case "==":
            case "===":
              return String(left) === String(right);
            default:
              return false;
          }
        });

        current = filtered.length > 0 ? filtered : undefined;
        continue;
      }

      if (op === "length") {
        if (Array.isArray(current) || typeof current === "string") {
          current = (current as { length: number }).length;
        }
        continue;
      }

      if (op === "sum") {
        if (Array.isArray(current)) {
          current = (current as number[]).reduce(
            (a, b) => (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0),
            0,
          );
        } else if (typeof current === "object") {
          current = Object.values(current).reduce((sum, val) => {
            const numVal = typeof val === "number" ? val : 0;
            return (typeof sum === "number" ? sum : 0) + numVal;
          }, 0);
        }
        continue;
      }

      if (op.startsWith("concat:")) {
        const suffix = op.substring("concat:".length);
        current =
          current !== null && current !== undefined ? `${String(current)}${suffix}` : undefined;
        continue;
      }

      if (op.startsWith("concat_field:")) {
        const rawPath = op.substring("concat_field:".length).trim();
        if (!rawPath) {
          continue;
        }

        const resolvedPath = resolveDynamicBracketKeys(rawPath, obj);
        const suffix = getValueByPath(obj, resolvedPath);

        if (current !== null && current !== undefined) {
          current =
            suffix !== null && suffix !== undefined
              ? `${String(current)}${String(suffix)}`
              : String(current);
        } else {
          current = undefined;
        }

        continue;
      }

      if (op === "clean_tiktok_product_description") {
        const extracted = extractTextFieldsOnly(current);
        current =
          extracted.length > 0 ? extracted.join(" ").replace(/\s+/g, " ").trim() : undefined;
        continue;
      }

      if (op.startsWith("extract_field_to_array:")) {
        const fields = op
          .substring("extract_field_to_array:".length)
          .split(",")
          .map((field) => field.trim())
          .filter((field) => field.length > 0);
        if (Array.isArray(current)) {
          const collected: unknown[] = [];
          for (const item of current) {
            if (item && typeof item === "object") {
              for (const field of fields) {
                const extracted = resolveFieldValue(item as Record<string, unknown>, field);
                if (Array.isArray(extracted)) {
                  collected.push(...extracted);
                } else if (extracted !== null && extracted !== undefined) {
                  collected.push(extracted);
                }
              }
            }
          }
          current = collected.length > 0 ? collected : undefined;
        } else {
          current = undefined;
        }
        continue;
      }

      if (op === "flatten") {
        if (Array.isArray(current)) {
          const flattened: unknown[] = [];
          for (const item of current) {
            if (Array.isArray(item)) {
              flattened.push(...item);
            } else {
              flattened.push(item);
            }
          }
          current = flattened;
        }
        continue;
      }

      if (op === "unique") {
        if (Array.isArray(current)) {
          const seen = new Set<string>();
          const deduped: unknown[] = [];
          for (const item of current) {
            const key =
              typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(item);
            }
          }
          current = deduped;
        }
        continue;
      }

      if (op.startsWith("mapurl:")) {
        const template = op.substring(7);

        const mapValue = (input: unknown): string => {
          if (input === null || input === undefined) return "";
          const valueString = String(input);

          return template.replace(/\{([^}]+)\}/g, (_, token: string) => {
            const key = token.trim();
            if (key === "value") return valueString;
            if (key === "country") return resolveCountry(input);

            const fromContext = getValueByPath(obj, key);
            if (fromContext === null || fromContext === undefined) return "";
            return String(fromContext);
          });
        };

        if (Array.isArray(current)) {
          current = current.map((item) => mapValue(item)).filter((url) => url !== "");
        } else {
          current = mapValue(current);
        }
        continue;
      }

      if (op === "currency") {
        const countryCode = resolveCountry(current).toUpperCase();
        if (!countryCode) {
          current = undefined;
        } else {
          const currency = countryToCurrency[countryCode as keyof typeof countryToCurrency];
          current = currency || undefined;
        }
        continue;
      }

      if (op === "text_to_number") {
        const text = String(current).trim();
        const match = text.match(/([0-9]*\.?[0-9]+)\s*([kmb]?)\s*\+?/i);
        if (!match) {
          current = undefined;
          continue;
        }

        const num = Number.parseFloat(match[1]);
        const multiplier = (match[2] || "").toLowerCase();
        const factor =
          multiplier === "k"
            ? 1000
            : multiplier === "m"
              ? 1000000
              : multiplier === "b"
                ? 1000000000
                : 1;
        current = Number.isNaN(num) ? undefined : Math.round(num * factor);
        continue;
      }

      if (op === "count_bullets_clean") {
        if (typeof current === "string") {
          const locale = (context?.country || context?.region || "vn").toLowerCase();
          if (locale === "id") current = count_bullets_clean_id(current);
          else if (locale === "th") current = count_bullets_clean_th(current);
          else if (locale === "ph") current = count_bullets_clean_ph(current);
          else current = count_bullets_clean_vn(current);
        } else {
          current = undefined;
        }
        continue;
      }

      if (op === "count_charactes_no_bullet") {
        if (typeof current === "string") {
          const locale = (context?.country || context?.region || "vn").toLowerCase();
          if (locale === "id") current = count_charactes_no_bullet_id(current);
          else if (locale === "th") current = count_charactes_no_bullet_th(current);
          else if (locale === "ph") current = count_charactes_no_bullet_ph(current);
          else current = count_charactes_no_bullet_vn(current);
        } else {
          current = undefined;
        }
      }
    }
  }

  return current;
}

// Build CSV with the same logic as Lambda transformer
function buildDynamicCSVOutput(
  rows: Array<Record<string, unknown>>,
  mapping: VendorMapping,
  region: string = "",
  rootData?: unknown,
): string {
  const columnNames = Object.keys(mapping.columns);
  const header = columnNames.join(",");

  const escapeCSV = (value: unknown): string => {
    if (value === null || value === undefined) return "";

    // Handle numbers - remove unnecessary .0 decimals
    if (typeof value === "number") {
      if (Number.isInteger(value) || value % 1 === 0) {
        return String(Math.floor(value));
      }
      return String(value);
    }

    // Preserve structured values instead of coercing to "[object Object]".
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

    // Try to parse as number and format if it's a whole number
    if (/^\d+\.0+$/.test(str)) {
      // String like "29000.0" should become "29000"
      return str.replace(/\.0+$/, "");
    }

    str = str.replaceAll("\r\n", "\\n").replaceAll("\n", "\\n").replaceAll("\r", "\\n");
    if (str.includes(",") || str.includes('"')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  };

  const csvRows = rows.map((row) => {
    const rawRoot = (rootData && typeof rootData === "object" ? rootData : {}) as Record<
      string,
      unknown
    >;
    const cubeMetadata =
      rawRoot.cube_metadata && typeof rawRoot.cube_metadata === "object"
        ? (rawRoot.cube_metadata as Record<string, unknown>)
        : {};
    const countryFromRoot =
      (region && region.length > 0 ? region : undefined) ||
      (typeof cubeMetadata.country === "string" ? (cubeMetadata.country as string) : undefined);
    const root = {
      ...rawRoot,
      cube_metadata: {
        ...cubeMetadata,
        ...(countryFromRoot ? { country: countryFromRoot } : {}),
      },
    } as Record<string, unknown>;

    return columnNames
      .map((col) => {
        const fieldMapping = mapping.columns[col as keyof typeof mapping.columns];

        // Get source path and apply region substitution if needed
        let sourcePath = fieldMapping?.source || "";

        // Extract value from source path (or use column name as fallback for direct mapping)
        let value: unknown;
        if (sourcePath) {
          // Handle $root references (resolve from root data)
          if (sourcePath.startsWith("$root.")) {
            const rootPath = sourcePath.substring(6); // Remove "$root." prefix
            value = resolveFieldValue(root as Record<string, unknown>, rootPath, {
              country: countryFromRoot,
              region,
              s3: { country: countryFromRoot || "", region: region || "" },
            });
          } else {
            // Regular path resolution from row data
            value = resolveFieldValue(row, sourcePath, {
              country: countryFromRoot,
              region,
              s3: { country: countryFromRoot || "", region: region || "" },
            });
          }
        } else {
          // If no source path, try direct column name as key
          value = row[col];
        }

        if ((value === undefined || value === "") && fieldMapping?.default !== undefined) {
          return escapeCSV(fieldMapping.default);
        }
        return escapeCSV(value);
      })
      .join(",");
  });

  const bom = "\uFEFF"; // UTF-8 BOM for Excel
  return bom + [header, ...csvRows].join("\n");
}

// Main execution
async function main() {
  const args = parseArgs();
  let mappingsDir: string | undefined;

  try {
    mappingsDir = resolveMappingsDir(args);
  } catch (error) {
    if (args.help) {
      showHelp();
      console.log("⚠️  Mappings directory not found. Use --mappings-dir=PATH if needed.");
      process.exit(0);
    }
    throw error;
  }

  // Show help if requested
  if (args.help) {
    showHelp(mappingsDir);
    process.exit(0);
  }

  const vendor = args.vendor;
  const filePath = args.file;
  const region = args.region || ""; // Optional region code (vn, th, ph, etc.)

  if (!vendor || !filePath) {
    showHelp(mappingsDir);
    console.error("❌ Missing required arguments: --vendor and --file");
    process.exit(1);
  }

  try {
    // Resolve file path
    const resolvedFilePath = resolve(process.cwd(), filePath);

    console.log(`📂 Loading vendor mapping for: ${vendor}`);
    const { mapping, selectedMappingId } = loadVendorMapping(
      vendor,
      filePath.split("/").pop() || "",
      mappingsDir!,
    );
    console.log(`   Using mapping: ${selectedMappingId}`);
    if (region) {
      console.log(`   Region: ${region} (fields with $s3 will be substituted)`);
    }

    console.log(`📄 Reading file: ${resolvedFilePath}`);
    const fileContent = readFileSync(resolvedFilePath, "utf-8");
    const originalData = JSON.parse(fileContent); // Keep reference to original data
    let data = originalData;

    // Ensure data is an array
    let items = Array.isArray(data) ? data : [data];
    console.log(`   Parsed ${items.length} item(s)`);

    // Apply path extraction if needed
    if (mapping.pathExtraction?.path) {
      console.log(`🔍 Applying path extraction: ${mapping.pathExtraction.path}`);

      const extracted: unknown[] = [];
      for (const item of items) {
        const current = resolveFieldValue(
          item as Record<string, unknown>,
          mapping.pathExtraction.path,
        );

        if (Array.isArray(current)) {
          extracted.push(...current);
        } else if (current && typeof current === "object") {
          extracted.push(current);
        } else if (current === undefined || current === null) {
          // Path not found - skip row (no data at this path means no output row)
        }
      }
      items = extracted;
      console.log(`   Extracted ${items.length} item(s)`);
    }

    // Process and transform to CSV (without full validation, since we don't need AWS context)
    console.log(`⚙️  Transforming data to CSV`);
    const rows = items.map((item, idx) => {
      return {
        rowNumber: idx + 1,
        data: (item as Record<string, unknown>) || {},
      };
    });

    const csvContent = buildDynamicCSVOutput(
      rows.map((r) => r.data),
      mapping,
      region,
      originalData,
    );

    // Determine output paths (same directory as input file)
    const outputDir = dirname(resolvedFilePath);
    const filename = basename(resolvedFilePath).split(".")[0] || "output";
    const csvPath = join(outputDir, `${filename}-parsed.csv`);
    const excelPath = join(outputDir, `${filename}-parsed.xlsx`);

    // Write CSV
    console.log(`💾 Writing CSV`);
    writeFileSync(csvPath, csvContent, "utf-8");
    console.log(`   ✓ ${csvPath}`);

    // Convert CSV to Excel
    console.log(`📊 Creating Excel file`);
    const lines = csvContent.replaceAll("\uFEFF", "").trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const data_rows = lines.slice(1).map((line) => {
      const values = line.split(",");
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = values[i]?.trim() || "";
      });
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(data_rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const excelBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    writeFileSync(excelPath, excelBuffer);
    console.log(`   ✓ ${excelPath}`);

    console.log("");
    console.log(`✅ Successfully parsed ${items.length} rows`);
    console.log("");
    console.log("Output files:");
    console.log(`  CSV:   ${csvPath}`);
    console.log(`  Excel: ${excelPath}`);
  } catch (error) {
    console.error("");
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
