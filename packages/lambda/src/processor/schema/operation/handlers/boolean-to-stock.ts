import type { OperationHandler } from "../types.js";

export const handleBooleanToStock: OperationHandler<"boolean_to_stock"> = (value) => {
  if (value === true || value === 1) return 999;
  if (value === false || value === 0) return 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return 999;
    if (lower === "false" || lower === "0" || lower === "no" || lower === "") return 0;
  }
  return undefined;
};
