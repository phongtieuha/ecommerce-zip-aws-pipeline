import type { OperationHandler } from "../types.js";

export const handleSum: OperationHandler<"sum"> = (value) => {
  if (Array.isArray(value)) {
    const numbers = value.filter((v) => typeof v === "number");
    if (numbers.length === 0) return undefined;
    return numbers.reduce((acc, n) => acc + n, 0);
  }

  if (value && typeof value === "object") {
    const values = Object.values(value);
    const numbers = values
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
    return numbers.reduce((acc, n) => acc + n, 0);
  }

  return undefined;
};
