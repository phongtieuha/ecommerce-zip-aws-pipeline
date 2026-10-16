import type { OperationHandler } from "../types.js";

export const handleFirst: OperationHandler<"first"> = (value) => {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : undefined;
  }
  return undefined;
};
