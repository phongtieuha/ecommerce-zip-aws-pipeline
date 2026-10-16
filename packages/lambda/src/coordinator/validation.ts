import type { VendorMapping, FieldMapping, ValidationError } from "@filepipeline/shared";
import { loadVendorMapping } from "../processor/schema/index";

interface GroupedRowValidation {
  readonly row: number;
  readonly validation: Array<{
    readonly field: string;
    readonly value: unknown;
    readonly message: string;
    readonly rule: string;
  }>;
}

export interface CSVValidationResult {
  readonly validRecords: Record<string, any>[];
  readonly errors: ValidationError[];
  readonly invalidRecords: Array<{
    readonly row: number;
    readonly record: Record<string, any>;
    readonly errors: ValidationError[];
  }>;
}

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return defaultValue;
}

/**
 * Validate parsed CSV records against the vendor mapping rules.
 * Checks required fields, types, bounds, patterns, and SKU uniqueness.
 * Returns valid records plus invalid row details with stable row numbers.
 */
export function validateCSVRecords(
  records: Record<string, any>[],
  vendor: string,
): CSVValidationResult {
  const mapping = loadVendorMapping(vendor);
  const errors: ValidationError[] = [];
  const validCandidates: Array<{ row: number; record: Record<string, any> }> = [];
  const invalidRecords: Array<{
    row: number;
    record: Record<string, any>;
    errors: ValidationError[];
  }> = [];

  for (const [rowIndex, record] of records.entries()) {
    const rowNumber = rowIndex + 1;
    const rowErrors = validateRecord(record, mapping, rowNumber);
    if (rowErrors.length === 0) {
      validCandidates.push({ row: rowNumber, record });
    } else {
      errors.push(...rowErrors);
      invalidRecords.push({ row: rowNumber, record, errors: rowErrors });
    }
  }

  const skuColumn = "source_sku_id";
  const seenSkus = new Map<string, number>();
  const duplicateRows = new Set<number>();

  for (const candidate of validCandidates) {
    const skuValue = String(candidate.record[skuColumn] ?? "").trim();
    if (!skuValue) continue;

    const prevRow = seenSkus.get(skuValue);
    if (prevRow !== undefined) {
      const duplicateError: ValidationError = {
        row: candidate.row,
        field: skuColumn,
        value: skuValue,
        message: `Duplicate SKU value "${skuValue}"`,
        rule: "uniqueness",
      };
      duplicateRows.add(candidate.row);
      errors.push(duplicateError);
      invalidRecords.push({
        row: candidate.row,
        record: candidate.record,
        errors: [duplicateError],
      });
    } else {
      seenSkus.set(skuValue, candidate.row);
    }
  }

  const validRecords = validCandidates
    .filter((candidate) => !duplicateRows.has(candidate.row))
    .map((candidate) => candidate.record);

  return { validRecords, errors, invalidRecords };
}

function validateRecord(
  record: Record<string, any>,
  mapping: VendorMapping,
  rowNumber: number,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [columnName, fieldDef] of Object.entries(mapping.columns) as [
    string,
    FieldMapping,
  ][]) {
    const value = record[columnName];
    const isBlank = value === undefined || value === null || String(value).trim() === "";

    if (fieldDef.required && isBlank && fieldDef.default === undefined) {
      errors.push({
        row: rowNumber,
        field: columnName,
        value,
        message: "Required field is empty",
        rule: "required",
      });
      continue;
    }

    if (isBlank) continue;

    const strValue = String(value).trim();

    if (fieldDef.type === "number") {
      const num = parseFloat(strValue);
      if (isNaN(num)) {
        errors.push({
          row: rowNumber,
          field: columnName,
          value,
          message: `Expected a number, got "${strValue}"`,
          rule: "type",
        });
      } else {
        record[columnName] = num;

        if (fieldDef.min !== undefined && num < fieldDef.min) {
          errors.push({
            row: rowNumber,
            field: columnName,
            value,
            message: `Value ${num} is below minimum ${fieldDef.min}`,
            rule: "min",
          });
        }
        if (fieldDef.max !== undefined && num > fieldDef.max) {
          errors.push({
            row: rowNumber,
            field: columnName,
            value,
            message: `Value ${num} exceeds maximum ${fieldDef.max}`,
            rule: "max",
          });
        }
      }
    }

    if (fieldDef.type === "boolean") {
      const normalized = strValue.toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) {
        record[columnName] = true;
      } else if (["false", "no", "0"].includes(normalized)) {
        record[columnName] = false;
      } else {
        errors.push({
          row: rowNumber,
          field: columnName,
          value,
          message: `Expected a boolean, got "${strValue}"`,
          rule: "type",
        });
      }
    }

    if (fieldDef.type === "array") {
      if (Array.isArray(value)) {
        // Keep native arrays as-is.
      } else {
        try {
          const parsed = JSON.parse(strValue);
          if (Array.isArray(parsed)) {
            record[columnName] = parsed;
          } else {
            errors.push({
              row: rowNumber,
              field: columnName,
              value,
              message: `Expected an array, got ${typeof parsed}`,
              rule: "type",
            });
          }
        } catch {
          record[columnName] = strValue
            .split(",")
            .map((item: string) => item.trim())
            .filter(Boolean);
        }
      }
    }

    if (fieldDef.type === "string" && typeof value !== "string") {
      record[columnName] = strValue;
    }

    if (fieldDef.pattern) {
      const checkValue = String(record[columnName]).trim();
      const regex = new RegExp(fieldDef.pattern);
      if (!regex.test(checkValue)) {
        errors.push({
          row: rowNumber,
          field: columnName,
          value: checkValue,
          message: `Does not match pattern "${fieldDef.pattern}"`,
          rule: "pattern",
        });
      }
    }
  }

  return errors;
}

/**
 * Build a grouped error report JSON string from flat validation errors.
 */
export function buildErrorReport(errors: ValidationError[]): string {
  const groupedErrorsMap = new Map<number, GroupedRowValidation>();

  for (const error of errors) {
    const existing = groupedErrorsMap.get(error.row);
    const validation = {
      field: error.field,
      value: error.value,
      message: error.message,
      rule: error.rule,
    };

    if (existing) {
      existing.validation.push(validation);
    } else {
      groupedErrorsMap.set(error.row, {
        row: error.row,
        validation: [validation],
      });
    }
  }

  const groupedErrors = Array.from(groupedErrorsMap.values()).sort((a, b) => a.row - b.row);
  return JSON.stringify(groupedErrors, null, 2);
}
