import type { OperationHandler } from "../types.js";

export const handleEq: OperationHandler<"eq"> = (value, operation) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const stringValue = String(value);
  return stringValue === operation.value;
};
