import type { OperationHandler } from "../types.js";

export const handleDate: OperationHandler<"date"> = (value, operation) => {
  if (!value) return undefined;

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value < 10000000000 ? value * 1000 : value);
  } else if (typeof value === "string") {
    const numericValue = Number.parseFloat(value);
    if (!Number.isNaN(numericValue)) {
      date = new Date(numericValue < 10000000000 ? numericValue * 1000 : numericValue);
    } else {
      date = new Date(value);
    }
  } else {
    return undefined;
  }

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  let formatted = operation.pattern;
  formatted = formatted.replace("YYYY", date.getUTCFullYear().toString());
  formatted = formatted.replace("MM", String(date.getUTCMonth() + 1).padStart(2, "0"));
  formatted = formatted.replace("DD", String(date.getUTCDate()).padStart(2, "0"));
  formatted = formatted.replace("HH", String(date.getUTCHours()).padStart(2, "0"));
  formatted = formatted.replace("mm", String(date.getUTCMinutes()).padStart(2, "0"));
  formatted = formatted.replace("ss", String(date.getUTCSeconds()).padStart(2, "0"));

  return formatted;
};
