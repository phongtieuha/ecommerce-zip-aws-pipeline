import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

function normalizeExtractedValue(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Some payloads surface empty text as repeated quotes (e.g. "\"\"").
  if (/^["']+$/.test(trimmed)) return undefined;

  return trimmed;
}

export const handleExtractFieldToArray: OperationHandler<"extract_field_to_array"> = (
  value,
  operation,
) => {
  if (!Array.isArray(value)) return undefined;

  const extracted = value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return undefined;

      const results: unknown[] = [];
      for (const fieldName of operation.fieldNames) {
        const extractedValue = getValueByPath(item as Record<string, unknown>, fieldName);
        if (Array.isArray(extractedValue)) {
          for (const entry of extractedValue) {
            const normalized = normalizeExtractedValue(entry);
            if (normalized !== undefined && normalized !== null) {
              results.push(normalized);
            }
          }
        } else if (extractedValue !== undefined && extractedValue !== null) {
          const normalized = normalizeExtractedValue(extractedValue);
          if (normalized !== undefined && normalized !== null) {
            results.push(normalized);
          }
        }
      }

      return results;
    })
    .filter((v): v is unknown => v !== undefined && v !== null);

  return extracted.length > 0 ? extracted : undefined;
};
