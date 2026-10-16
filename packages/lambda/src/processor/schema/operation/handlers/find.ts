import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleFind: OperationHandler<"find"> = (value, operation, context) => {
  if (!Array.isArray(value)) return undefined;

  const matchValue = operation.matchValue;
  if (!matchValue) return undefined;

  let targetValue: unknown = matchValue;
  if (matchValue.startsWith("$") && context) {
    targetValue = getValueByPath(context, matchValue);
  }

  if (targetValue === undefined || targetValue === null) {
    return undefined;
  }

  const targetString = String(targetValue);
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const itemObj = item as Record<string, unknown>;
    const skuIdValue = itemObj.skuId;
    if (skuIdValue !== undefined && String(skuIdValue) === targetString) {
      return itemObj;
    }
  }

  return undefined;
};
