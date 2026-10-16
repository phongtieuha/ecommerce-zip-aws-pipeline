import type { OperationHandler } from "../types.js";

export const handleDivide: OperationHandler<"divide"> = (value, operation) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const numValue = Number.parseFloat(String(value));
  if (Number.isNaN(numValue)) {
    return undefined;
  }

  return numValue / operation.divisor;
};
