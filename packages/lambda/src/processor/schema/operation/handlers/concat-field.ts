import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleConcatField: OperationHandler<"concat_field"> = (value, operation, context) => {
  if (value === null || value === undefined) return undefined;

  const suffix = context && operation.path ? getValueByPath(context, operation.path) : undefined;

  if (suffix === null || suffix === undefined) {
    return String(value);
  }

  return `${String(value)}${String(suffix)}`;
};
