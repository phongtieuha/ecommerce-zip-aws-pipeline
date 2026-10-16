import type { OperationHandler } from "../types.js";

export const handleFilterEmptyStrings: OperationHandler<"filter_empty_strings"> = (value) => {
  if (!Array.isArray(value)) return undefined;

  return value.filter((item) => typeof item !== "string" || item.trim() !== "");
};
