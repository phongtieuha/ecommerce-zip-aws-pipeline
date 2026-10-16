import type { OperationHandler } from "../types.js";

export const handleObjectValues: OperationHandler<"object_values"> = (value) => {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return undefined;
};
