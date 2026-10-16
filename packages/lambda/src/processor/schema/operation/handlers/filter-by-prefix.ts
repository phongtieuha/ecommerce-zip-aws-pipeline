import type { OperationHandler } from "../types.js";

export const handleFilterByPrefix: OperationHandler<"filter_by_prefix"> = (value, operation) => {
  if (!Array.isArray(value)) return undefined;

  return value.filter(
    (item) =>
      typeof item === "string" && operation.prefixes.some((prefix) => item.startsWith(prefix)),
  );
};
