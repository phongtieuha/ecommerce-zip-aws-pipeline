import type { OperationHandler } from "../types.js";

export const handleRatingAverage: OperationHandler<"rating_average"> = (value) => {
  if (!Array.isArray(value) || value.length < 6) {
    return undefined;
  }

  const counts = value.map((entry) => {
    if (typeof entry === "number") return entry;
    if (typeof entry === "string") {
      const parsed = Number.parseFloat(entry);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  });

  const total = counts[1] + counts[2] + counts[3] + counts[4] + counts[5];
  if (total <= 0) {
    return undefined;
  }

  return (counts[1] + counts[2] * 2 + counts[3] * 3 + counts[4] * 4 + counts[5] * 5) / total;
};
