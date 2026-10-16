import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handlePairWithSeparator: OperationHandler<"pair_with_separator"> = (
  value,
  operation,
) => {
  if (!Array.isArray(value)) return undefined;

  const paired = value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;

      const val1 = getValueByPath(item as Record<string, unknown>, operation.field1);
      const val2 = getValueByPath(item as Record<string, unknown>, operation.field2);

      if (val1 === undefined || val1 === null || val2 === undefined || val2 === null) {
        return undefined;
      }

      return `${String(val1)}${operation.separator}${String(val2)}`;
    })
    .filter((v): v is string => v !== undefined);

  return paired.length > 0 ? paired : undefined;
};
