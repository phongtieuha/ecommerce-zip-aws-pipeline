import type { OperationHandler } from "../types.js";

export const handleBooleanToNumber: OperationHandler<"boolean_to_number"> = (value) => {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return 1;
    if (lower === "false" || lower === "0" || lower === "no" || lower === "") return 0;
  }
  return undefined;
};
