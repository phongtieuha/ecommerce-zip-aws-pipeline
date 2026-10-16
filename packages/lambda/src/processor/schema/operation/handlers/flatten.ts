import type { OperationHandler } from "../types.js";

export const handleFlatten: OperationHandler<"flatten"> = (value) => {
  if (!Array.isArray(value)) return undefined;

  const flattened: unknown[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      flattened.push(...item);
    } else {
      flattened.push(item);
    }
  }

  return flattened;
};
