import type { OperationHandler } from "../types.js";

export const handleLast: OperationHandler<"last"> = (value) => {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[value.length - 1] : undefined;
  }
  return undefined;
};
