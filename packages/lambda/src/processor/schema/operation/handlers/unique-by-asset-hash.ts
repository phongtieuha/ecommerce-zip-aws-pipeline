import type { OperationHandler } from "../types.js";

// CDN mirrors of the same image (e.g. p16-.../<hash>~tplv-...jpeg vs p19-.../<hash>~tplv-...jpeg)
// share the same content hash segment; keep only the first URL seen per hash.
function extractAssetKey(url: string): string {
  const withoutQuery = url.split("?")[0];
  const lastSegment = withoutQuery.split("/").pop() ?? withoutQuery;
  const beforeResizeSuffix = lastSegment.split("~")[0];
  return beforeResizeSuffix.toLowerCase();
}

export const handleUniqueByAssetHash: OperationHandler<"unique_by_asset_hash"> = (value) => {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const uniqueValues: unknown[] = [];

  for (const item of value) {
    const key = typeof item === "string" ? extractAssetKey(item) : JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueValues.push(item);
    }
  }

  return uniqueValues;
};
