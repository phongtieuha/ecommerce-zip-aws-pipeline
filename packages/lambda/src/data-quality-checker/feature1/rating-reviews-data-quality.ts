import {
  asNullableKey,
  buildPlatformOrder,
  createEmptyMatrix,
  formatPercent,
  isMissing,
  normalizePlatform,
  normalizeRegion,
  type CsvRow,
  type RegionPlatformMatrixRow,
  type ScriptOptions,
} from "../shared";

interface RatingsGroup {
  readonly skuFlags: Map<
    string,
    {
      avgNull: boolean;
      reviewNull: boolean;
      ratingNull: boolean;
    }
  >;
}

export interface RatingReviewsSummary {
  readonly REGION: string;
  readonly PLATFORM: string;
  readonly TOTAL_SKU: number;
  readonly AVG_NULL_SKU: number;
  readonly REVIEW_NULL_SKU: number;
  readonly RATING_NULL_SKU: number;
  readonly AVG_NULL_PCT: number | null;
  readonly REVIEW_NULL_PCT: number | null;
  readonly RATING_NULL_PCT: number | null;
}

export interface RatingReviewsResult {
  readonly summary: RatingReviewsSummary[];
  readonly avgMatrix: RegionPlatformMatrixRow[];
  readonly reviewRatingMatrix: RegionPlatformMatrixRow[];
}

const buildGroupKey = (region: string, platform: string): string => `${region}||${platform}`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export const runRatingReviewsDataQuality = (
  rows: CsvRow[],
  options: ScriptOptions = {},
): RatingReviewsResult => {
  const groups = new Map<string, RatingsGroup>();

  for (const row of rows) {
    const region = normalizeRegion(row.REGION);
    const platform = normalizePlatform(row.PLATFORM);
    const skuId = asNullableKey(row.SOURCE_SKU_ID) ?? asNullableKey(row.SOURCE_PRODUCT_ID);

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
        avgNull: true,
        reviewNull: true,
        ratingNull: true,
      });
    }

    const flags = group.skuFlags.get(skuId);
    if (!flags) {
      continue;
    }

    if (!isMissing(row.AVG_RATING)) {
      flags.avgNull = false;
    }
    if (!isMissing(row.REVIEW_COUNT)) {
      flags.reviewNull = false;
    }
    if (!isMissing(row.RATING_COUNT)) {
      flags.ratingNull = false;
    }
  }

  const summary: RatingReviewsSummary[] = [];

  for (const [key, group] of groups.entries()) {
    const [region, platform] = key.split("||");
    const skuEntries = [...group.skuFlags.values()];

    const totalSku = skuEntries.length;
    const avgNull = skuEntries.filter((item) => item.avgNull).length;
    const reviewNull = skuEntries.filter((item) => item.reviewNull).length;
    const ratingNull = skuEntries.filter((item) => item.ratingNull).length;

    summary.push({
      REGION: region,
      PLATFORM: platform,
      TOTAL_SKU: totalSku,
      AVG_NULL_SKU: avgNull,
      REVIEW_NULL_SKU: reviewNull,
      RATING_NULL_SKU: ratingNull,
      AVG_NULL_PCT: ratio(avgNull, totalSku),
      REVIEW_NULL_PCT: ratio(reviewNull, totalSku),
      RATING_NULL_PCT: ratio(ratingNull, totalSku),
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

  const avgMatrix = createEmptyMatrix(regions, platformOrder);
  const reviewRatingMatrix = createEmptyMatrix(regions, platformOrder);

  for (const row of avgMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildGroupKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }

      row[platform] = formatPercent(group.AVG_NULL_PCT);
    }
  }

  for (const row of reviewRatingMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildGroupKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }

      row[platform] = {
        REVIEW_COUNT: formatPercent(group.REVIEW_NULL_PCT),
        RATING_COUNT: formatPercent(group.RATING_NULL_PCT),
      };
    }
  }

  return {
    summary,
    avgMatrix,
    reviewRatingMatrix,
  };
};
