import { normalizeProductDescriptionValue } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCleanProductDescription: OperationHandler<"clean_product_description"> = (
  value,
) => {
  const normalized = normalizeProductDescriptionValue(value);
  return normalized.length > 0 ? normalized : undefined;
};
