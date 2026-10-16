import type { OperationHandler } from "../types.js";

export const handleSplit: OperationHandler<"split"> = (value, operation) => {
  if (value === null || value === undefined) return undefined;

  const str = String(value).trim();
  if (!str) return [];

  const parts = str.split(operation.delimiter).map((s) => s.trim());
  const nonEmpty = parts.filter((s) => s.length > 0);

  return nonEmpty.length > 0 ? nonEmpty : [];
};
