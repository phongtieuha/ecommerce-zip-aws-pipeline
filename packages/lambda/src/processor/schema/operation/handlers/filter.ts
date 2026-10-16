import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleFilter: OperationHandler<"filter"> = (value, operation) => {
  if (!Array.isArray(value)) return undefined;

  const filtered = value.filter((item) => {
    if (!item || typeof item !== "object") return false;

    const itemValue = getValueByPath(item as Record<string, unknown>, operation.path);

    if (itemValue === null || itemValue === undefined) return false;

    const leftValue = Number.isNaN(Number(itemValue)) ? String(itemValue) : Number(itemValue);
    const rightValue = Number.isNaN(Number(operation.value))
      ? operation.value
      : Number(operation.value);

    switch (operation.operator) {
      case ">":
        return typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue > rightValue
          : false;
      case "<":
        return typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue < rightValue
          : false;
      case ">=":
        return typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue >= rightValue
          : false;
      case "<=":
        return typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue <= rightValue
          : false;
      case "==":
      case "===":
        return String(leftValue) === String(rightValue);
      case "!=":
        return String(leftValue) !== String(rightValue);
      default:
        return false;
    }
  });

  return filtered.length > 0 ? filtered : undefined;
};
