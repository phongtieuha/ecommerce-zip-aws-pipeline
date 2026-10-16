import type { OperationHandler } from "../types.js";

export const handleContain: OperationHandler<"contain"> = (value, operation) => {
  if (value === null || value === undefined) return false;
  return String(value).includes(operation.value);
};
