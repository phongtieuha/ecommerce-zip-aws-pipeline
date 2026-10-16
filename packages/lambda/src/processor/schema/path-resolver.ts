import { applyOperation, parseOperation } from "./operation/index.js";
import type { OperationRuntimeContext } from "./operation/index.js";

function hasResolvedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Get a nested value from an object using dot notation with bracket array index support
 * Supports operations: |length, |sum, |date:pattern, |eq:value, |gt:value, |contain:value, |flatten, |unique, |mapurl:template, |currency
 * Examples:
 *   - "data.rating_star" => accesses obj.data.rating_star
 *   - "data.skus[0].stock" => accesses obj.data.skus[0].stock
 *   - "data.array|length" => returns length of array
 *   - "data.object|sum" => sums values in object
 *   - "data.field|date:YYYY-MM-DD" => formats date
 *   - "data.field|eq:value" => returns boolean comparison
 *   - "data.field|gt:value" => returns boolean comparison
 *   - "data.images|flatten|unique" => returns de-duplicated array
 *   - "cube_metadata.country|currency" => returns currency code from country code
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
  arrayFilter?: (items: unknown[]) => unknown[],
  runtime?: OperationRuntimeContext,
): unknown {
  const fallbackPaths = path
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (fallbackPaths.length > 1) {
    for (const fallbackPath of fallbackPaths) {
      const resolved = getNestedValue(obj, fallbackPath, arrayFilter, runtime);
      if (hasResolvedValue(resolved)) {
        return resolved;
      }
    }

    return undefined;
  }

  // Parse operation from path
  const { basePath, operation, operations } = parseOperation(path);

  let current: unknown = obj;
  let remaining = basePath;

  const resolveDynamicBracketKey = (keyExpr: string): unknown => {
    const trimmed = keyExpr.trim();
    if (!trimmed) return undefined;

    // Numeric array index, e.g. [0]
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    // Dynamic path lookup, e.g. [$expansion.sku_id]
    return getNestedValue(obj, trimmed, arrayFilter, runtime);
  };

  while (remaining) {
    current = tryParseJsonString(current);

    // Handle bracket notation: ['key'], ["key"], [0], [$expansion.sku_id]
    const bracketMatch = remaining.match(/^\[([^\]]+)\]/);
    if (bracketMatch) {
      const rawKey = bracketMatch[1].trim();

      const quotedStringMatch = rawKey.match(/^['"](.+)['"]$/);
      const resolvedKey = quotedStringMatch
        ? quotedStringMatch[1]
        : resolveDynamicBracketKey(rawKey);

      if (resolvedKey === undefined || resolvedKey === null) {
        return undefined;
      }

      if (Array.isArray(current)) {
        const index =
          typeof resolvedKey === "number" ? resolvedKey : Number.parseInt(String(resolvedKey), 10);
        if (Number.isNaN(index)) {
          return undefined;
        }
        current = current[index];
      } else if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[String(resolvedKey)];
      } else {
        return undefined;
      }

      remaining = remaining.slice(bracketMatch[0].length);
      // Skip leading dot if present
      if (remaining.startsWith(".")) {
        remaining = remaining.slice(1);
      }
      continue;
    }

    // Handle dot notation
    const dotIndex = remaining.indexOf(".");
    const bracketIndex = remaining.indexOf("[");
    let nextKey: string;
    let nextRemaining: string;

    if (dotIndex === -1 && bracketIndex === -1) {
      nextKey = remaining;
      nextRemaining = "";
    } else if (dotIndex === -1) {
      nextKey = remaining.slice(0, bracketIndex);
      nextRemaining = remaining.slice(bracketIndex);
    } else if (bracketIndex === -1) {
      nextKey = remaining.slice(0, dotIndex);
      nextRemaining = remaining.slice(dotIndex + 1);
    } else {
      const minIndex = Math.min(dotIndex, bracketIndex);
      nextKey = remaining.slice(0, minIndex);
      nextRemaining = remaining.slice(minIndex + (minIndex === dotIndex ? 1 : 0));
    }

    if (current === null || current === undefined) {
      return undefined;
    }

    // Handle numeric indices in bracket notation or regular object keys
    if (typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[nextKey];
    } else {
      return undefined;
    }

    remaining = nextRemaining;
  }

  // If base path didn't resolve to a value, don't apply operations - let fallback try next path
  if (current === null || current === undefined) {
    return undefined;
  }

  // Auto-parse JSON strings at the terminal value (e.g. stringified responseBody)
  current = tryParseJsonString(current);

  // If JSON parse resulted in null/undefined, don't apply operations
  if (current === null || current === undefined) {
    return undefined;
  }

  // Apply array filter before pipe operations if provided
  if (arrayFilter && Array.isArray(current)) {
    current = arrayFilter(current);
  }

  // Apply operations if present
  if (operations && operations.length > 0) {
    let transformed: unknown = current;
    for (const op of operations) {
      transformed = applyOperation(transformed, op, obj, runtime);
      if (transformed === undefined) {
        return undefined;
      }
    }
    return transformed;
  }

  if (operation) {
    return applyOperation(current, operation, obj, runtime);
  }

  return current;
}

/**
 * Convert a nested value to string for validation/parsing
 */
export function nestedValueToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}
