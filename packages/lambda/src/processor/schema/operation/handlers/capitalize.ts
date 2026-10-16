import type { OperationHandler } from "../types.js";

export const handleCapitalize: OperationHandler<"capitalize"> = (value) => {
  if (value === null || value === undefined) return undefined;

  const trimmed = String(value).trim();
  if (!trimmed) return "";

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
};
