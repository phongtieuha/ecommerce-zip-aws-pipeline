import type { OperationHandler } from "../types.js";

export const handleLength: OperationHandler<"length"> = (value) => {
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "object") {
    return Object.keys(value).length;
  }
  return undefined;
};
