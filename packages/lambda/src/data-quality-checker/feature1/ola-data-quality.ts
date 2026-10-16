import {
  asNullableKey,
  buildPlatformOrder,
  createEmptyMatrix,
  formatPercent,
  isMissing,
  normalizePlatform,
  normalizeRegion,
  parseBoolean,
  parseNumber,
  type CsvRow,
  type RegionPlatformMatrixRow,
  type ScriptOptions,
} from "../shared";

interface OLAGroup {
  readonly skuFlags: Map<
    string,
    {
      stockNull: boolean;
      availNull: boolean;
      mismatch: boolean;
      valid: boolean;
    }
  >;
}

export interface OLAGroupSummary {
  readonly REGION: string;
  readonly PLATFORM: string;
  readonly TOTAL_SKU: number;
  readonly STOCK_NULL: number;
  readonly AVAIL_NULL: number;
  readonly MISMATCH_SKU: number;
  readonly VALID_SKU: number;
  readonly STOCK_NULL_PCT: number | null;
  readonly AVAIL_NULL_PCT: number | null;
  readonly MISMATCH_PCT: number | null;
}

export interface OLAResult {
  readonly summary: OLAGroupSummary[];
  readonly nullMatrix: RegionPlatformMatrixRow[];
  readonly mismatchMatrix: RegionPlatformMatrixRow[];
}

const buildGroupKey = (region: string, platform: string): string => `${region}||${platform}`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export const runOLADataQuality = (rows: CsvRow[], options: ScriptOptions = {}): OLAResult => {
  const groups = new Map<string, OLAGroup>();

  for (const row of rows) {
    const region = normalizeRegion(row.REGION);
    const platform = normalizePlatform(row.PLATFORM);
    const skuId = asNullableKey(row.SOURCE_SKU_ID);

    if (!region || !platform || !skuId) {
      continue;
    }

    const key = buildGroupKey(region, platform);
    if (!groups.has(key)) {
      groups.set(key, { skuFlags: new Map() });
    }

    const group = groups.get(key);
    if (!group) {
      continue;
    }

    if (!group.skuFlags.has(skuId)) {
      group.skuFlags.set(skuId, {
        stockNull: true,
        availNull: true,
        mismatch: false,
        valid: false,
      });
    }

    const skuFlags = group.skuFlags.get(skuId);
    if (!skuFlags) {
      continue;
    }

    const stockMissing = isMissing(row.STOCK);
    const availMissing = isMissing(row.IS_AVAILABLE);

    if (!stockMissing) {
      skuFlags.stockNull = false;
    }
    if (!availMissing) {
      skuFlags.availNull = false;
    }

    const stock = parseNumber(row.STOCK);
    const isAvailable = parseBoolean(row.IS_AVAILABLE);

    if (stock !== null && isAvailable !== null) {
      skuFlags.valid = true;
      const mismatch = (isAvailable && stock === 0) || (!isAvailable && stock !== 0);
      if (mismatch) {
        skuFlags.mismatch = true;
      }
    }
  }

  const summary: OLAGroupSummary[] = [];

  for (const [key, group] of groups.entries()) {
    const [region, platform] = key.split("||");
    const skuEntries = [...group.skuFlags.values()];

    const totalSku = skuEntries.length;
    const stockNull = skuEntries.filter((item) => item.stockNull).length;
    const availNull = skuEntries.filter((item) => item.availNull).length;
    const mismatchSku = skuEntries.filter((item) => item.mismatch).length;
    const validSku = skuEntries.filter((item) => item.valid).length;

    summary.push({
      REGION: region,
      PLATFORM: platform,
      TOTAL_SKU: totalSku,
      STOCK_NULL: stockNull,
      AVAIL_NULL: availNull,
      MISMATCH_SKU: mismatchSku,
      VALID_SKU: validSku,
      STOCK_NULL_PCT: ratio(stockNull, totalSku),
      AVAIL_NULL_PCT: ratio(availNull, totalSku),
      MISMATCH_PCT: ratio(mismatchSku, validSku),
    });
  }

  summary.sort((a, b) =>
    a.REGION === b.REGION ? a.PLATFORM.localeCompare(b.PLATFORM) : a.REGION.localeCompare(b.REGION),
  );

  const regions = [...new Set(summary.map((item) => item.REGION))].sort((a, b) =>
    a.localeCompare(b),
  );
  const platformOrder = buildPlatformOrder(rows, options.platformOrder);

  const summaryByKey = new Map(
    summary.map((item) => [buildGroupKey(item.REGION, item.PLATFORM), item]),
  );

  const nullMatrix = createEmptyMatrix(regions, platformOrder);
  const mismatchMatrix = createEmptyMatrix(regions, platformOrder);

  for (const row of nullMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildGroupKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }

      row[platform] = {
        STOCK: formatPercent(group.STOCK_NULL_PCT),
        IS_AVAILABLE: formatPercent(group.AVAIL_NULL_PCT),
      };
    }
  }

  for (const row of mismatchMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildGroupKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }

      row[platform] = formatPercent(group.MISMATCH_PCT);
    }
  }

  return {
    summary,
    nullMatrix,
    mismatchMatrix,
  };
};
