import { resolveCurrency } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCurrency: OperationHandler<"currency"> = (value, _operation, context) => {
  return resolveCurrency(value, context);
};
