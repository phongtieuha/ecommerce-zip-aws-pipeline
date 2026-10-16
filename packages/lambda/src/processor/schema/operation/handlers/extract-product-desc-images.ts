import { extractImageReferences } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleExtractProductDescImages: OperationHandler<"extract_product_desc_images"> = (
  value,
) => {
  return extractImageReferences(value);
};
