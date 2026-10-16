import type { OperationHandler } from "../types.js";

export const handleRatingTextToNumber: OperationHandler<"rating_text_to_number"> = (value) => {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "number") {
    return Number.isNaN(value) ? undefined : value;
  }

  const text = String(value).trim();
  if (!text) return undefined;

  if (text.includes("ยังไม่มีการประเมิน")) {
    return 0.0;
  }

  const match = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;

  const parsed = Number.parseFloat(match[1]);
  return Number.isNaN(parsed) ? undefined : parsed;
};
