import type { OperationHandler } from "../types.js";

export const handleJoin: OperationHandler<"join"> = (value, operation) => {
  if (!Array.isArray(value)) return undefined;

  const parts = value
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);

  return parts.join(operation.separator);
};
