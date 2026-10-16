import type { OperationHandler } from "../types.js";

export const handleConcat: OperationHandler<"concat"> = (value, operation) => {
  if (value === null || value === undefined) return undefined;
  return `${String(value)}${operation.value}`;
};
