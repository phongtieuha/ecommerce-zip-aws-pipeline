import type { OperationHandler } from "../types.js";

export const handleMax: OperationHandler<"max"> = (value) => {
  if (Array.isArray(value)) {
    const numbers = value
      .map((v) => {
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const parsed = Number.parseFloat(v);
          return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
      })
      .filter((v): v is number => v !== null);

    if (numbers.length === 0) return undefined;
    return Math.max(...numbers);
  }

  if (value && typeof value === "object") {
    const numbers = Object.values(value)
      .map((v) => {
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const parsed = Number.parseFloat(v);
          return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
      })
      .filter((v): v is number => v !== null);

    if (numbers.length === 0) return undefined;
    return Math.max(...numbers);
  }

  return undefined;
};
