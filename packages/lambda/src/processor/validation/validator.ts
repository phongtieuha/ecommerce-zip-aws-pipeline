import type {
  VendorMapping,
  FieldMapping,
  ValidationError,
  RankingComputationKind,
} from "@filepipeline/shared";
import {
  calculateAdsRanking,
  calculateDownloadRank,
  calculateOrganicRanking,
  calculateOverallRanking,
  resolveKeywordColumn,
} from "@filepipeline/shared/utility/ranking-calculator";
import type { ParsedRow } from "../output/csv-parser";
import { getNestedValue, nestedValueToString } from "../schema/path-resolver";
import { getHtmlNestedValue } from "../parser/html/path-resolver";
import { evaluateCondition } from "./condition-evaluator";
import { parseOperation, applyOperation } from "../schema/operation/index";
import type { OperationRuntimeContext } from "../schema/operation/index";
import { getIsOfficialShop } from "../schema/reference-data-loader";

export interface ValidationResult {
  readonly isValid: boolean;
  readonly errors: ValidationError[];
  readonly transformedValue?: unknown;
}

export interface RowValidationResult {
  readonly isValid: boolean;
  readonly errors: ValidationError[];
  readonly data: Record<string, unknown>;
}

export interface RuntimeSourceContext {
  readonly s3?: Record<string, unknown>;
  readonly match?: Record<string, string>;
  readonly parser?: "json" | "html";
  readonly ranking?: RankingRuntimeContext;
}

export interface RankingRuntimeContext {
  rowIndex: number;
  adsCounter: number;
  organicCounter: number;
  overallCounter: number;
  currentKeyword?: string;
  currentRegion?: string;
}

const loggedOutputIfFailures = new Set<string>();

const NUMERIC_PRICE_FIELDS = new Set([
  "sku_price_after_discount",
  "sku_price_before_discount",
  "price_max_after_discount",
  "price_min_after_discount",
  "price_max_before_discount",
  "price_min_before_discount",
]);

function stripOuterParentheses(value: string): string {
  const match = value.match(/^\((.*)\)$/);
  return match ? match[1].trim() : value;
}

function normalizeLocalizedNumber(value: string, treatSingleDotAsThousands: boolean): string {
  let cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return cleaned;

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    cleaned = cleaned.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") {
      cleaned = cleaned.replace(",", ".");
    }
    return cleaned;
  }

  if (commaCount > 0) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(cleaned)) {
      return cleaned.replace(/,/g, "");
    }
    if (commaCount === 1 && /^-?\d+,\d+$/.test(cleaned)) {
      return cleaned.replace(",", ".");
    }
    return cleaned.replace(/,/g, "");
  }

  if (dotCount > 0) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      return cleaned.replace(/\./g, "");
    }
    if (treatSingleDotAsThousands && dotCount === 1 && /^-?\d+\.\d{3}$/.test(cleaned)) {
      return cleaned.replace(".", "");
    }
  }

  return cleaned;
}

function normalizeNumberInput(fieldName: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const normalizedFieldName = fieldName.toLowerCase();

  if (normalizedFieldName === "rating_count") {
    const withoutParens = stripOuterParentheses(trimmed);
    const withoutGrouping = withoutParens.replace(/,/g, "");
    return normalizeLocalizedNumber(withoutGrouping, false);
  }

  if (NUMERIC_PRICE_FIELDS.has(normalizedFieldName)) {
    // Remove known currency prefixes/symbols from marketplace payload values.
    let currencyStripped = trimmed.replace(/^(rp|idr|thb|sgd)\s*/i, "");
    currencyStripped = currencyStripped.replace(/[฿$€£¥₫]/g, "");
    currencyStripped = currencyStripped.replace(/[^0-9,.-]/g, "");
    return normalizeLocalizedNumber(currencyStripped, true);
  }

  return trimmed;
}

export function createRankingContext(): RankingRuntimeContext {
  return {
    rowIndex: 0,
    adsCounter: 0,
    organicCounter: 0,
    overallCounter: 0,
  };
}

/**
 * Search all top-level array properties of a row object for the first element
 * where the find expression evaluates to true.
 * find expression format: "fieldPath|operation" e.g. "formType|eq:5"
 */
function findInContext(
  rowData: Record<string, unknown>,
  findExpression: string,
): Record<string, unknown> | undefined {
  const { basePath, operations, operation } = parseOperation(findExpression);

  for (const key of Object.keys(rowData)) {
    const arr = rowData[key];
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;

      const fieldValue = getNestedValue(item as Record<string, unknown>, basePath);
      let conditionMet: unknown;

      if (operations.length > 0) {
        let transformed: unknown = fieldValue;
        for (const op of operations) {
          transformed = applyOperation(transformed, op, item as Record<string, unknown>);
        }
        conditionMet = transformed;
      } else if (operation) {
        conditionMet = applyOperation(fieldValue, operation, item as Record<string, unknown>);
      } else {
        conditionMet = !!fieldValue;
      }

      if (conditionMet === true || conditionMet === 1) {
        return item as Record<string, unknown>;
      }
    }
  }

  return undefined;
}

function splitSourceFallbacks(sourcePath: string): string[] {
  const parts = sourcePath
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 1 ? parts : [sourcePath];
}

function hasResolvedValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

function resolveDefaultValue(
  defaultValue: FieldMapping["default"],
  rowData: Record<string, unknown>,
  rootData?: Record<string, unknown>,
  runtimeContext?: RuntimeSourceContext,
  currentOutput?: Record<string, unknown>,
  runtime?: OperationRuntimeContext,
): unknown {
  if (typeof defaultValue !== "string") {
    return defaultValue;
  }

  const trimmed = defaultValue.trim();
  const isSpecialSourceToken =
    trimmed === "$root" ||
    trimmed.startsWith("$root.") ||
    trimmed.startsWith("$root|") ||
    trimmed === "$fileName" ||
    trimmed.startsWith("$fileName|") ||
    trimmed === "$s3" ||
    trimmed.startsWith("$s3.") ||
    trimmed.startsWith("$s3|") ||
    trimmed === "$keywordFromFilename" ||
    trimmed === "$keywordFromFoldername" ||
    trimmed === "$dateFromFilename" ||
    trimmed === "$dateFromZipName" ||
    trimmed.startsWith("$lookup.");

  if (!isSpecialSourceToken) {
    return defaultValue;
  }

  const resolved = resolveSourceValue(
    rowData,
    trimmed,
    rootData,
    runtimeContext,
    undefined,
    currentOutput,
    runtime,
  );
  return resolved === undefined ? defaultValue : resolved;
}

function isRankingFieldMapping(fieldMapping: FieldMapping): fieldMapping is FieldMapping & {
  compute: {
    type: "ranking";
    kind: RankingComputationKind;
    dependsOn?: string;
  };
} {
  return fieldMapping.compute?.type === "ranking";
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }

  return Boolean(value);
}

function computeRankingValue(
  fieldMapping: FieldMapping,
  data: Record<string, unknown>,
  rankingContext?: RankingRuntimeContext,
): unknown {
  if (!isRankingFieldMapping(fieldMapping) || !rankingContext) {
    return undefined;
  }

  // Resolve keyword column from the output data for per-keyword counter resets
  const keywordCol = resolveKeywordColumn(Object.keys(data));
  const currentKeyword = keywordCol ? String(data[keywordCol] ?? "") : undefined;
  const previousKeyword = rankingContext.currentKeyword;
  const currentRegion = data.region !== undefined ? String(data.region ?? "") : undefined;
  const previousRegion = rankingContext.currentRegion;

  switch (fieldMapping.compute.kind) {
    case "download":
      return calculateDownloadRank(rankingContext.rowIndex);
    case "ads": {
      const dependencyField = fieldMapping.compute.dependsOn || "is_ad";
      const { value, nextAdsCounter } = calculateAdsRanking({
        isAd: coerceBoolean(data[dependencyField]),
        adsCounter: rankingContext.adsCounter,
        currentKeyword,
        previousKeyword,
        currentRegion,
        previousRegion,
      });
      rankingContext.adsCounter = nextAdsCounter;
      return value;
    }
    case "organic": {
      const dependencyField = fieldMapping.compute.dependsOn || "is_ad";
      const { value, nextOrganicCounter } = calculateOrganicRanking({
        isAd: coerceBoolean(data[dependencyField]),
        organicCounter: rankingContext.organicCounter,
        currentKeyword,
        previousKeyword,
        currentRegion,
        previousRegion,
      });
      rankingContext.organicCounter = nextOrganicCounter;
      return value;
    }
    case "overall": {
      const { value, nextOverallCounter } = calculateOverallRanking({
        overallCounter: rankingContext.overallCounter,
        currentKeyword,
        previousKeyword,
        currentRegion,
        previousRegion,
      });
      rankingContext.overallCounter = nextOverallCounter;
      return value;
    }
  }
}

function assignFieldResult(
  data: Record<string, unknown>,
  errors: ValidationError[],
  targetField: string,
  fieldMapping: FieldMapping,
  rowNumber: number,
  rawValue: unknown,
  resolvedDefault?: unknown,
): void {
  const sourceValueStr = nestedValueToString(rawValue);

  const result = validateField(
    sourceValueStr,
    targetField,
    fieldMapping,
    rowNumber,
    resolvedDefault,
  );

  errors.push(...result.errors);
  if (result.transformedValue !== undefined) {
    data[targetField] = result.transformedValue;
  } else {
    data[targetField] = "";
  }
}

function resolveSourceValue(
  rowData: Record<string, unknown>,
  sourcePath: string,
  rootData?: Record<string, unknown>,
  runtimeContext?: RuntimeSourceContext,
  arrayFilter?: (items: unknown[]) => unknown[],
  currentOutput?: Record<string, unknown>,
  runtime?: OperationRuntimeContext,
): unknown {
  const fallbackPaths = splitSourceFallbacks(sourcePath);
  if (fallbackPaths.length > 1) {
    for (const fallbackPath of fallbackPaths) {
      const resolved = resolveSourceValue(
        rowData,
        fallbackPath,
        rootData,
        runtimeContext,
        arrayFilter,
        currentOutput,
        runtime,
      );
      if (hasResolvedValue(resolved)) {
        return resolved;
      }
    }

    return undefined;
  }

  const effectiveRoot = rootData ?? rowData;
  const jsonFileName =
    typeof runtimeContext?.s3?.jsonFileName === "string"
      ? (runtimeContext.s3.jsonFileName as string)
      : undefined;
  const jsonFilePath =
    typeof runtimeContext?.s3?.jsonFilePath === "string"
      ? (runtimeContext.s3.jsonFilePath as string)
      : undefined;

  if (sourcePath === "$dateFromZipName" || sourcePath === "$dateFromFilename") {
    // Return the date parsed from the ZIP/input filename (YYYY-MM-DD)
    return runtimeContext?.s3?.date;
  }
  if (sourcePath === "$keywordFromFilename") {
    // Extract keyword from JSON filename by stripping the trailing
    // _DD-MM-YYYY_HH-MM-SS_hex.json suffix (e.g. "body_wash_06-04-2026_01-42-30_a5b80837.json" → "body wash")
    if (!jsonFileName) return undefined;
    const basename = jsonFileName.replace(/\.json$/i, "");
    const match = basename.match(/^(.+?)_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}_[a-f0-9]+$/);
    if (!match) return undefined;
    return match[1].replace(/_/g, " ");
  }
  if (sourcePath === "$keywordFromFoldername") {
    // Extract keyword from ZIP internal file path folder:
    // <country>/<keyword>/output/<file>.json -> <keyword>
    // <country>/<keyword>/html/<file>.html   -> <keyword>
    if (!jsonFilePath) return undefined;
    const normalizedPath = jsonFilePath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.length < 4) return undefined;
    const parentFolder = parts[parts.length - 2];
    if (parentFolder !== "output" && parentFolder !== "html") return undefined;
    return parts[parts.length - 3];
  }
  if (sourcePath === "$root") {
    return effectiveRoot;
  }

  if (sourcePath.startsWith("$root.")) {
    return getNestedValue(effectiveRoot, sourcePath.slice("$root.".length), undefined, runtime);
  }

  if (sourcePath.startsWith("$root|")) {
    return getNestedValue(effectiveRoot, sourcePath.slice("$root".length));
  }

  if (sourcePath === "$fileName") {
    return jsonFileName;
  }

  if (sourcePath.startsWith("$fileName|")) {
    if (!jsonFileName) return undefined;
    const opPath = `value${sourcePath.slice("$fileName".length)}`;
    return getNestedValue({ value: jsonFileName }, opPath);
  }

  if (sourcePath === "$s3") {
    return runtimeContext?.s3;
  }

  if (sourcePath.startsWith("$s3.")) {
    const s3Context = runtimeContext?.s3;
    if (!s3Context) return undefined;
    return getNestedValue(s3Context, sourcePath.slice("$s3.".length));
  }

  if (sourcePath.startsWith("$s3|")) {
    const s3Context = runtimeContext?.s3;
    if (!s3Context) return undefined;
    return getNestedValue(s3Context, sourcePath.slice("$s3".length));
  }

  if (sourcePath === "$zipFilename" || sourcePath.startsWith("$zipFilename|")) {
    const zipFilename = runtimeContext?.s3?.filename;
    if (!zipFilename) return undefined;
    if (sourcePath.startsWith("$zipFilename|")) {
      const opPath = `value${sourcePath.slice("$zipFilename".length)}`;
      return getNestedValue({ value: zipFilename }, opPath);
    }
    return zipFilename;
  }

  if (sourcePath === "$timestampFromFilename" || sourcePath.startsWith("$timestampFromFilename|")) {
    // Extract trailing numeric timestamp from JSON filename
    // e.g. "shopname_1_1730385272800773359.json" -> 1730385272800 (ms)
    if (!jsonFileName) return undefined;
    const tsMatch = jsonFileName.match(/(\d{13,})(?:\.json)?$/);
    if (!tsMatch) return undefined;
    const raw = tsMatch[1];
    // Normalise to milliseconds: >15 digits = nanoseconds, >12 digits = microseconds
    let ms: number;
    if (raw.length > 15) {
      ms = Number(raw.slice(0, 13));
    } else if (raw.length > 12) {
      ms = Math.floor(Number(raw) / 1000);
    } else {
      ms = Number(raw);
    }
    if (Number.isNaN(ms)) return undefined;
    if (sourcePath.startsWith("$timestampFromFilename|")) {
      const opPath = `value${sourcePath.slice("$timestampFromFilename".length)}`;
      return getNestedValue({ value: ms }, opPath);
    }
    return ms;
  }

  if (sourcePath === "$match") {
    return runtimeContext?.match;
  }

  if (sourcePath.startsWith("$lookup.")) {
    const lookupPath = sourcePath.slice("$lookup.".length);
    const parts = lookupPath.split(".").map((part) => part.trim());
    if (parts.length !== 3) return undefined;

    const [platformToken, regionToken, keyTypeToken] = parts;
    const keyType = keyTypeToken.toLowerCase();

    const lookupPlatform = platformToken.toLowerCase();
    if (lookupPlatform !== "lazada" && lookupPlatform !== "redmart") return undefined;
    if (regionToken.toLowerCase() !== "region") return undefined;
    if (keyType !== "shop_id" && keyType !== "shop_name") return undefined;

    const shopIdCandidates =
      lookupPlatform === "redmart"
        ? ["shop_id", "shopId", "seller.sellerId", "sellerId"]
        : ["seller.sellerId", "shopId", "shop_id", "sellerId"];
    const shopNameCandidates =
      lookupPlatform === "redmart"
        ? ["shop_name", "shopName", "seller.name", "seller_name", "tracking.seller_name"]
        : ["seller.name", "seller_name", "tracking.seller_name", "shopName", "shop_name"];

    const resolveFromCandidates = (candidates: string[]): unknown => {
      for (const candidate of candidates) {
        const value = getNestedValue(rowData, candidate);
        if (value !== undefined && value !== null && `${value}`.trim() !== "") {
          return value;
        }
      }
      return undefined;
    };

    const platform =
      currentOutput?.platform ??
      runtimeContext?.s3?.vendor ??
      getNestedValue(rowData, "platform") ??
      getNestedValue(effectiveRoot, "platform");
    const region =
      currentOutput?.region ??
      runtimeContext?.s3?.country ??
      getNestedValue(rowData, "region") ??
      getNestedValue(effectiveRoot, "region");
    const shopId =
      currentOutput?.shop_id ??
      resolveFromCandidates(shopIdCandidates) ??
      getNestedValue(rowData, "shop_id") ??
      getNestedValue(effectiveRoot, "shop_id");
    const shopName =
      currentOutput?.shop_name ??
      resolveFromCandidates(shopNameCandidates) ??
      getNestedValue(rowData, "shop_name") ??
      getNestedValue(effectiveRoot, "shop_name");

    const resolved = getIsOfficialShop(platform, region, shopId, shopName);
    if (resolved === undefined) return undefined;

    if (
      keyType === "shop_id" &&
      (shopId === null || shopId === undefined || `${shopId}`.trim() === "")
    ) {
      return undefined;
    }

    if (
      keyType === "shop_name" &&
      (shopName === null || shopName === undefined || `${shopName}`.trim() === "")
    ) {
      return undefined;
    }

    return resolved;
  }

  if (sourcePath.startsWith("$match.")) {
    const matchContext = runtimeContext?.match;
    if (!matchContext) return undefined;
    const key = sourcePath.slice("$match.".length);
    return matchContext[key];
  }

  if (sourcePath.startsWith("$match|")) {
    const matchContext = runtimeContext?.match;
    if (!matchContext) return undefined;
    return getNestedValue(
      matchContext as Record<string, unknown>,
      sourcePath.slice("$match".length),
    );
  }

  if (runtimeContext?.parser === "html") {
    return getHtmlNestedValue(rowData, sourcePath);
  }

  return getNestedValue(rowData, sourcePath, arrayFilter, runtime);
}

/**
 * Validates and transforms a number field
 */
export function validateNumberField(
  value: string,
  fieldName: string,
  mapping: FieldMapping,
  rowNumber: number,
): ValidationResult {
  const errors: ValidationError[] = [];
  const normalizedValue = normalizeNumberInput(fieldName, value);
  const numValue = Number.parseFloat(normalizedValue);

  if (Number.isNaN(numValue)) {
    errors.push({
      row: rowNumber,
      field: fieldName,
      value,
      message: `Field "${fieldName}" must be a valid number`,
      rule: "type",
    });
    return { isValid: false, errors };
  }

  // Range validation
  if (mapping.min !== undefined && numValue < mapping.min) {
    errors.push({
      row: rowNumber,
      field: fieldName,
      value,
      message: `Field "${fieldName}" must be at least ${mapping.min}`,
      rule: "min",
    });
  }
  if (mapping.max !== undefined && numValue > mapping.max) {
    errors.push({
      row: rowNumber,
      field: fieldName,
      value,
      message: `Field "${fieldName}" must be at most ${mapping.max}`,
      rule: "max",
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    transformedValue: numValue,
  };
}

/**
 * Validates and transforms a boolean field
 */
export function validateBooleanField(
  value: string,
  fieldName: string,
  rowNumber: number,
): ValidationResult {
  const lowerValue = value.toLowerCase();

  if (["true", "yes", "1"].includes(lowerValue)) {
    return { isValid: true, errors: [], transformedValue: true };
  }
  if (["false", "no", "0"].includes(lowerValue)) {
    return { isValid: true, errors: [], transformedValue: false };
  }

  return {
    isValid: false,
    errors: [
      {
        row: rowNumber,
        field: fieldName,
        value,
        message: `Field "${fieldName}" must be a boolean`,
        rule: "type",
      },
    ],
  };
}

/**
 * Validates a string field with optional pattern matching
 */
export function validateStringField(
  value: string,
  fieldName: string,
  mapping: FieldMapping,
  rowNumber: number,
): ValidationResult {
  if (mapping.pattern) {
    const regex = new RegExp(mapping.pattern);
    if (!regex.test(value)) {
      return {
        isValid: false,
        errors: [
          {
            row: rowNumber,
            field: fieldName,
            value,
            message: `Field "${fieldName}" does not match required pattern`,
            rule: "pattern",
          },
        ],
      };
    }
  }
  return { isValid: true, errors: [], transformedValue: value };
}

/**
 * Validates a field value against its mapping configuration
 */
function validateField(
  value: string | undefined,
  fieldName: string,
  mapping: FieldMapping,
  rowNumber: number,
  resolvedDefault?: unknown,
): ValidationResult {
  // Apply default before required check — a resolved default satisfies a required field.
  if ((value === undefined || value === "") && mapping.default !== undefined) {
    const effectiveDefault = resolvedDefault !== undefined ? resolvedDefault : mapping.default;
    // Only treat as satisfied if the resolved default is non-empty
    if (effectiveDefault !== undefined && effectiveDefault !== "" && effectiveDefault !== null) {
      return {
        isValid: true,
        errors: [],
        transformedValue: effectiveDefault,
      };
    }
  }

  // Check required (no usable default was available)
  if (mapping.required && (value === undefined || value === "")) {
    return {
      isValid: false,
      errors: [
        {
          row: rowNumber,
          field: fieldName,
          value,
          message: `Field "${fieldName}" is required`,
          rule: "required",
        },
      ],
    };
  }

  // Use default if empty (fallback for literal defaults that resolved as empty)
  if ((value === undefined || value === "") && mapping.default !== undefined) {
    return {
      isValid: true,
      errors: [],
      transformedValue: resolvedDefault !== undefined ? resolvedDefault : mapping.default,
    };
  }

  // Skip validation for empty non-required fields
  if (value === undefined || value === "") {
    return { isValid: true, errors: [], transformedValue: undefined };
  }

  // Type-specific validation
  switch (mapping.type) {
    case "number":
      return validateNumberField(value, fieldName, mapping, rowNumber);
    case "boolean":
      return validateBooleanField(value, fieldName, rowNumber);
    default:
      return validateStringField(value, fieldName, mapping, rowNumber);
  }
}

export function validateRow(
  row: ParsedRow,
  mapping: VendorMapping,
  rootData?: Record<string, unknown>,
  runtimeContext?: RuntimeSourceContext,
): RowValidationResult {
  const errors: ValidationError[] = [];
  const data: Record<string, unknown> = {};
  const computedFields: Array<[string, FieldMapping]> = [];
  // Shared with operation handlers (e.g. a `mapurl` operation's `{region}` token) so they
  // can reuse the row's already-resolved `region` column value instead of re-deriving it.
  const runtime: OperationRuntimeContext = {};

  const processField = (targetField: string, fieldMapping: FieldMapping): void => {
    const resolvedDefault =
      fieldMapping.default !== undefined
        ? resolveDefaultValue(
            fieldMapping.default,
            row.data as Record<string, unknown>,
            rootData,
            runtimeContext,
            data,
            runtime,
          )
        : undefined;

    // Check outputIf condition first (if present)
    if (fieldMapping.outputIf) {
      try {
        const conditionMet = evaluateCondition(
          fieldMapping.outputIf,
          row.data as Record<string, unknown>,
          rootData,
        );
        if (!conditionMet) {
          // Condition failed - output empty value (column still included)
          data[targetField] = "";
          return;
        }
      } catch (error) {
        // If condition evaluation fails, log a warning (once per unique field+message
        // for the container's lifetime, to avoid per-row spam) and output empty value (fail-safe)
        const message = error instanceof Error ? error.message : String(error);
        const failureKey = `${targetField}:${message}`;
        if (!loggedOutputIfFailures.has(failureKey)) {
          loggedOutputIfFailures.add(failureKey);
          console.warn(
            `Failed to evaluate outputIf for ${targetField}: ${message} (further occurrences suppressed)`,
          );
        }
        data[targetField] = "";
        return;
      }
    }

    if (fieldMapping.compute) {
      computedFields.push([targetField, fieldMapping]);
      return;
    }

    // If source is empty, fall back to default (if any)
    if (!fieldMapping.source || fieldMapping.source === "") {
      if (fieldMapping.default !== undefined) {
        data[targetField] = resolvedDefault;
      } else {
        data[targetField] = "";
      }
      return;
    }

    // When `find` is set, locate the first array element matching the condition
    // and resolve `source` against it (stripping the `value.` prefix placeholder)
    let sourceRowData = row.data as Record<string, unknown>;
    let effectiveSource = fieldMapping.source;
    if (fieldMapping.find) {
      const foundItem = findInContext(row.data as Record<string, unknown>, fieldMapping.find);
      if (foundItem) {
        sourceRowData = foundItem;
        effectiveSource = effectiveSource
          .split("||")
          .map((part) => {
            const trimmed = part.trim();
            return trimmed.startsWith("value.") ? trimmed.slice("value.".length) : trimmed;
          })
          .join(" || ");
      }
    }

    // Build array filter function from fieldMapping.filter if present
    // Filter format: "fieldPath|operation:value" e.g. "type|eq:img"
    let arrayFilter: ((items: unknown[]) => unknown[]) | undefined;
    if (fieldMapping.filter) {
      const { basePath: filterPath, operations: filterOps } = parseOperation(fieldMapping.filter);
      arrayFilter = (items: unknown[]) =>
        items.filter((item) => {
          if (!item || typeof item !== "object") return false;
          let val: unknown = (item as Record<string, unknown>)[filterPath];
          for (const op of filterOps) {
            val = applyOperation(val, op);
            if (val === undefined) return false;
          }
          return val === true;
        });
    }

    // Support nested paths using dot notation
    const sourceValue = resolveSourceValue(
      sourceRowData,
      effectiveSource,
      rootData,
      runtimeContext,
      arrayFilter,
      data,
      runtime,
    );
    assignFieldResult(
      data,
      errors,
      targetField,
      fieldMapping,
      row.rowNumber,
      sourceValue,
      resolvedDefault,
    );
  };

  // Process `region` first (if the mapping defines it) so `runtime.region` is available
  // to every other field — e.g. a `mapurl` operation's `{region}` token — without a
  // separate, duplicate resolution pass.
  const columnEntries = Object.entries(mapping.columns);
  const regionIndex = columnEntries.findIndex(([field]) => field === "region");
  if (regionIndex > 0) {
    const [regionEntry] = columnEntries.splice(regionIndex, 1);
    columnEntries.unshift(regionEntry);
  }

  for (const [targetField, fieldMapping] of columnEntries) {
    processField(targetField, fieldMapping);
    if (targetField === "region") {
      runtime.region =
        typeof data.region === "string" && data.region !== "" ? data.region : undefined;
    }
  }

  for (const [targetField, fieldMapping] of computedFields) {
    const resolvedDefault =
      fieldMapping.default !== undefined
        ? resolveDefaultValue(
            fieldMapping.default,
            row.data as Record<string, unknown>,
            rootData,
            runtimeContext,
            data,
            runtime,
          )
        : undefined;

    const computedValue = computeRankingValue(fieldMapping, data, runtimeContext?.ranking);
    assignFieldResult(
      data,
      errors,
      targetField,
      fieldMapping,
      row.rowNumber,
      computedValue,
      resolvedDefault,
    );
  }

  // Update the tracked keyword so the next row can detect keyword changes
  if (runtimeContext?.ranking) {
    const keywordCol = resolveKeywordColumn(Object.keys(data));
    if (keywordCol) {
      runtimeContext.ranking.currentKeyword = String(data[keywordCol] ?? "");
    }
    if (data.region !== undefined) {
      runtimeContext.ranking.currentRegion = String(data.region ?? "");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    data,
  };
}

/**
 * Safely converts a value to string for error messages
 */
function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[complex value]";
  }
}

export function validateUniqueness(
  rows: Array<{ rowNumber: number; data: Record<string, unknown> }>,
  field: string = "sku",
): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const value = row.data[field];
    if (value !== undefined) {
      const stringValue = safeStringify(value);
      const existingRow = seen.get(stringValue);
      if (existingRow === undefined) {
        seen.set(stringValue, row.rowNumber);
      } else {
        errors.push({
          row: row.rowNumber,
          field,
          value: stringValue,
          message: `Duplicate ${field} "${stringValue}" (first seen at row ${existingRow})`,
          rule: "uniqueness",
        });
      }
    }
  }

  return errors;
}
