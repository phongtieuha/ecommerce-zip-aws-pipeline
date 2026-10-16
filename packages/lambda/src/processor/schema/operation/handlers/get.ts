import type { OperationHandler } from "../types.js";

export const handleGet: OperationHandler<"get"> = (value, operation) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;

  const fieldName = operation.fieldName;
  if (!fieldName) return undefined;

  const objValue = value as Record<string, unknown>;
  return objValue[fieldName];
};
