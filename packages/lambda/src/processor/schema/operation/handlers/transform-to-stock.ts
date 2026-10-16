import type { OperationHandler } from "../types.js";

const IN_STOCK_LABELS = new Set([
  "in stock",
  "available",
  "ready stock",
  "tersedia",
  "còn hàng",
  "con hang",
  "สินค้าพร้อมส่ง",
]);

const OUT_OF_STOCK_LABELS = new Set([
  "out of stock",
  "sold out",
  "unavailable",
  "stok habis",
  "hết hàng",
  "het hang",
  "สินค้าหมด",
]);

export const handleTransformToStock: OperationHandler<"transform_to_stock"> = (value) => {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "number") return value;

  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  const normalized = trimmed.toLowerCase();
  if (IN_STOCK_LABELS.has(normalized)) return 999;
  if (OUT_OF_STOCK_LABELS.has(normalized)) return 0;

  return undefined;
};
