import type { OperationHandler } from "../types.js";

export const handleUnique: OperationHandler<"unique"> = (value) => {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const uniqueValues: unknown[] = [];

  for (const item of value) {
    let key: string;
    if (item === null) {
      key = "null";
    } else if (item === undefined) {
      key = "undefined";
    } else if (typeof item === "object") {
      try {
        key = `object:${JSON.stringify(item)}`;
      } catch {
        key = `object:${String(item)}`;
      }
    } else {
      key = `${typeof item}:${String(item)}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      uniqueValues.push(item);
    }
  }

  return uniqueValues;
};
