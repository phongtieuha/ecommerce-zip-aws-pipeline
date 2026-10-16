import type { OperationHandler } from "../types.js";

export const handleNotContain: OperationHandler<"not_contain"> = (value, operation) => {
  if (value === null || value === undefined) return true;
  return !String(value).includes(operation.value);
};
