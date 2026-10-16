import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const DEFAULT_LOOKUP_CSV = "Lazada_Redmart_ShopID_ShopName_IsOfficalShop_20260618 - Shop Data.csv";

type OfficialValue = boolean;

interface LookupCacheEntry {
  byShopId: Map<string, OfficialValue>;
  byShopName: Map<string, OfficialValue>;
  ambiguousShopIdKeys: Set<string>;
  ambiguousShopNameKeys: Set<string>;
}

const lookupCache = new Map<string, LookupCacheEntry | null>();

function normalizeToken(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function normalizeShopId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseOfficialValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return undefined;
}

function resolveLookupCsvPath(): string | undefined {
  const overridePath = process.env.OFFICIAL_SHOP_LOOKUP_CSV_PATH;
  if (overridePath && existsSync(overridePath)) {
    return overridePath;
  }

  const candidates = [
    join(process.cwd(), "assets", DEFAULT_LOOKUP_CSV),
    join(process.cwd(), "..", "..", "assets", DEFAULT_LOOKUP_CSV),
    join("/var/task", "assets", DEFAULT_LOOKUP_CSV),
  ];

  return candidates.find((path) => existsSync(path));
}

function markConflict(
  key: string,
  map: Map<string, OfficialValue>,
  ambiguousKeys: Set<string>,
  value: OfficialValue,
): void {
  if (ambiguousKeys.has(key)) return;

  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
    return;
  }

  if (existing !== value) {
    map.delete(key);
    ambiguousKeys.add(key);
  }
}

function buildLookupCache(csvPath: string): LookupCacheEntry {
  const content = readFileSync(csvPath, "utf-8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, unknown>>;

  const byShopId = new Map<string, OfficialValue>();
  const byShopName = new Map<string, OfficialValue>();
  const ambiguousShopIdKeys = new Set<string>();
  const ambiguousShopNameKeys = new Set<string>();

  for (const row of rows) {
    const platform = normalizeToken(row.PLATFORM);
    const region = normalizeToken(row.REGION);
    const shopId = normalizeShopId(row.SHOP_ID);
    const shopName = normalizeToken(row.SHOP_NAME);
    const official = parseOfficialValue(row.IS_OFFICIAL_SHOP);

    if (!platform || !region) continue;
    if (official === undefined) continue;

    if (shopId) {
      const idKey = `${platform}|${region}|${shopId}`;
      markConflict(idKey, byShopId, ambiguousShopIdKeys, official);
    }

    if (shopName) {
      const nameKey = `${platform}|${region}|${shopName}`;
      markConflict(nameKey, byShopName, ambiguousShopNameKeys, official);
    }
  }

  return {
    byShopId,
    byShopName,
    ambiguousShopIdKeys,
    ambiguousShopNameKeys,
  };
}

function getLookupCache(): LookupCacheEntry | undefined {
  const cacheKey = "official_shop";
  if (lookupCache.has(cacheKey)) {
    return lookupCache.get(cacheKey) ?? undefined;
  }

  const csvPath = resolveLookupCsvPath();
  if (!csvPath) {
    console.warn("[lookup] official shop CSV file not found; lookup disabled");
    lookupCache.set(cacheKey, null);
    return undefined;
  }

  try {
    const built = buildLookupCache(csvPath);
    lookupCache.set(cacheKey, built);
    return built;
  } catch (error) {
    console.error(`[lookup] failed to load official shop CSV: ${error}`);
    lookupCache.set(cacheKey, null);
    return undefined;
  }
}

export function clearReferenceDataCache(): void {
  lookupCache.clear();
}

export function getIsOfficialShop(
  platformRaw: unknown,
  regionRaw: unknown,
  shopIdRaw?: unknown,
  shopNameRaw?: unknown,
): boolean | undefined {
  const cache = getLookupCache();
  if (!cache) return undefined;

  const platform = normalizeToken(platformRaw);
  const region = normalizeToken(regionRaw);

  if (!platform || !region) return undefined;

  const shopId = normalizeShopId(shopIdRaw);
  if (shopId) {
    const idKey = `${platform}|${region}|${shopId}`;
    if (!cache.ambiguousShopIdKeys.has(idKey)) {
      const matched = cache.byShopId.get(idKey);
      if (matched !== undefined) return matched;
    }
  }

  const shopName = normalizeToken(shopNameRaw);
  if (shopName) {
    const nameKey = `${platform}|${region}|${shopName}`;
    if (!cache.ambiguousShopNameKeys.has(nameKey)) {
      const matched = cache.byShopName.get(nameKey);
      if (matched !== undefined) return matched;
    }
  }

  return undefined;
}
