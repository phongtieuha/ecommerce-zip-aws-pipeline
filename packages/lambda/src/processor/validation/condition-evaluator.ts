/**
 * Condition evaluator for outputIf expressions
 * Supports: ===, !==, >, >=, <, <=, &&, ||, + (string concatenation)
 * Example: "skus[0].sku_sale_props[0].prop_value_id + '_' + skus[0].sku_sale_props[1].prop_value_id === skus[0].sale_prop_value_ids"
 */

import { getNestedValue } from "../schema/path-resolver";

type ComparisonOperator = "===" | "!==" | ">=" | "<=" | ">" | "<";
type LogicalOperator = "&&" | "||";

/**
 * Evaluate a conditional expression against row data
 * @param condition - The condition expression to evaluate
 * @param rowData - The current row data
 * @param rootData - The root data object (optional, for $root references)
 * @returns boolean - true if condition is met, false otherwise
 */
export function evaluateCondition(
  condition: string,
  rowData: Record<string, unknown>,
  rootData?: Record<string, unknown>,
): boolean {
  const trimmed = condition.trim();
  if (!trimmed) return true;

  // Handle logical operators (&&, ||) - split by lowest precedence first
  // || has lower precedence than &&
  const orParts = splitByOperator(trimmed, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateCondition(part, rowData, rootData));
  }

  const andParts = splitByOperator(trimmed, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateCondition(part, rowData, rootData));
  }

  // Handle comparison operators
  const comparisonOps: ComparisonOperator[] = ["===", "!==", ">=", "<=", ">", "<"];
  for (const op of comparisonOps) {
    const parts = splitByOperator(trimmed, op);
    if (parts.length === 2) {
      const leftValue = evaluateExpression(parts[0].trim(), rowData, rootData);
      const rightValue = evaluateExpression(parts[1].trim(), rowData, rootData);
      return compareValues(leftValue, rightValue, op);
    }
  }

  // If no operators found, evaluate as boolean expression
  const value = evaluateExpression(trimmed, rowData, rootData);
  return toBoolean(value);
}

/**
 * Split a string by an operator, but not if it's inside quotes or field paths
 * This is a simple implementation that handles basic cases
 */
function splitByOperator(expr: string, operator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;

  while (i < expr.length) {
    // Check if we're at the operator
    if (expr.slice(i, i + operator.length) === operator) {
      parts.push(current);
      current = "";
      i += operator.length;
      continue;
    }
    current += expr[i];
    i++;
  }

  if (current) {
    parts.push(current);
  }

  return parts.length > 1 ? parts : [expr];
}

/**
 * Evaluate an expression (handles concatenation with +, field paths, and literals)
 */
function evaluateExpression(
  expr: string,
  rowData: Record<string, unknown>,
  rootData?: Record<string, unknown>,
): unknown {
  const trimmed = expr.trim();

  // Check if it's a string concatenation (contains + outside quotes)
  const concatParts = splitConcatenation(trimmed);
  if (concatParts.length > 1) {
    return concatParts
      .map((part) => {
        const value = evaluateExpression(part.trim(), rowData, rootData);
        return String(value ?? "");
      })
      .join("");
  }

  // Check if it's a literal string (single or double quotes)
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  // Check if it's a number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Check if it's a boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "undefined") return undefined;

  // Otherwise, treat as field path
  return resolveFieldPath(trimmed, rowData, rootData);
}

/**
 * Split by + operator for string concatenation
 * Only splits on + that are outside quotes
 */
function splitConcatenation(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
    } else if (char === "+" && !inSingleQuote && !inDoubleQuote) {
      // Look ahead to check if it's ++ or += (not supported)
      if (i + 1 < expr.length && (expr[i + 1] === "+" || expr[i + 1] === "=")) {
        throw new Error(`Unsupported operator: ${char}${expr[i + 1]}`);
      }
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts.length > 1 ? parts : [expr];
}

/**
 * Resolve a field path from row data
 */
function resolveFieldPath(
  path: string,
  rowData: Record<string, unknown>,
  rootData?: Record<string, unknown>,
): unknown {
  const effectiveRoot = rootData ?? rowData;

  // Handle $root references
  if (path === "$root") {
    return effectiveRoot;
  }

  if (path.startsWith("$root.")) {
    return getNestedValue(effectiveRoot, path.slice("$root.".length));
  }

  // Regular path - use rowData
  return getNestedValue(rowData, path);
}

/**
 * Compare two values using the specified operator
 */
function compareValues(left: unknown, right: unknown, operator: ComparisonOperator): boolean {
  // For === and !==, use strict equality
  if (operator === "===") {
    return left === right;
  }
  if (operator === "!==") {
    return left !== right;
  }

  // For numeric comparisons, convert to numbers
  const leftNum = toNumber(left);
  const rightNum = toNumber(right);

  // If either conversion failed, return false for numeric comparisons
  if (leftNum === null || rightNum === null) {
    return false;
  }

  switch (operator) {
    case ">":
      return leftNum > rightNum;
    case ">=":
      return leftNum >= rightNum;
    case "<":
      return leftNum < rightNum;
    case "<=":
      return leftNum <= rightNum;
    default:
      return false;
  }
}

/**
 * Convert a value to a number, returns null if conversion fails
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Convert a value to boolean
 */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0 && value !== "false" && value !== "0";
  if (typeof value === "number") return value !== 0;
  return true; // Objects, arrays, etc. are truthy
}
