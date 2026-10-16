import { normalizeLocalizedNumericText } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleTextToNumber: OperationHandler<"text_to_number"> = (value) => {
  if (!value) return undefined;

  const text = String(value).trim();
  if (!text) return undefined;

  if (
    /^(rp|idr|thb|sgd|rm|usd|vnd|php|myr)\s*/i.test(text) ||
    /[฿$€£¥₫₱]/.test(text) ||
    /^-?[\d,.]+$/.test(text.replace(/\s+/g, ""))
  ) {
    const normalized = normalizeLocalizedNumericText(text);
    if (!normalized) return undefined;

    const localizedNumber = Number.parseFloat(normalized);
    if (!Number.isNaN(localizedNumber)) {
      return localizedNumber;
    }
  }

  const match = text.match(/([0-9]*\.?[0-9]+)\s*([kmb]?)\s*\+?/i);
  if (!match) return undefined;

  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num)) return undefined;

  const multiplier = match[2]?.toLowerCase() || "";
  const multipliers: Record<string, number> = {
    k: 1000,
    m: 1000000,
    b: 1000000000,
  };

  const factor = multipliers[multiplier] || 1;
  return Math.round(num * factor);
};
