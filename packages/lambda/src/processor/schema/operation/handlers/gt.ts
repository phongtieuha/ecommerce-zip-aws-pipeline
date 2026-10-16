import type { OperationHandler } from "../types.js";

export const handleGt: OperationHandler<"gt"> = (value, operation) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const numericValue = Number.parseFloat(String(value));
  const numericTarget = Number.parseFloat(operation.value);

  if (Number.isNaN(numericValue) || Number.isNaN(numericTarget)) {
    return undefined;
  }

  return numericValue > numericTarget;
};
