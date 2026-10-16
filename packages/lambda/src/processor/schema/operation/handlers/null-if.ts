import type { OperationHandler } from "../types.js";

export const handleNullIf: OperationHandler<"null_if"> = (value, operation) => {
  if (value === null || value === undefined) return undefined;
  const strVal = String(value);
  return strVal === operation.value ? undefined : value;
};
