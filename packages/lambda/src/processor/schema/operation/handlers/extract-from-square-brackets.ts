import { extractFromSquareBrackets } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleExtractFromSquareBrackets: OperationHandler<"extract_from_square_brackets"> = (
  value,
) => {
  const extracted = extractFromSquareBrackets(value);
  if (extracted.length > 0) {
    return extracted;
  }

  return undefined;
};
