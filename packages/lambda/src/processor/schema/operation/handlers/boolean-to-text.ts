import type { OperationHandler } from "../types.js";

export const handleBooleanToText: OperationHandler<"boolean_to_text"> = (value) => {
  if (value === true || value === 1) return "Yes";
  if (value === false || value === 0) return "No";
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return "Yes";
    if (lower === "false" || lower === "0" || lower === "no" || lower === "") return "No";
  }
  return undefined;
};
