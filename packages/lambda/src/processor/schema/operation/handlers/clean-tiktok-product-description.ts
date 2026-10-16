import { extractTextFieldsOnly } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCleanTikTokProductDescription: OperationHandler<
  "clean_tiktok_product_description"
> = (value) => {
  const extracted = extractTextFieldsOnly(value);
  if (extracted.length === 0) return undefined;
  return extracted.join(" ").replace(/\s+/g, " ").trim();
};
