import {
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

export interface PriceCompetitivenessSummary {
  readonly REGION: string;
  readonly PLATFORM: string;
  readonly TOTAL_ROWS: number;
  readonly MISSING_ALL_PRICE_ROWS: number;
  readonly MISSING_ALL_PRICE_PCT: number | null;
}

export interface PriceCompetitivenessIssueRow {
  readonly REGION: string;
  readonly PLATFORM: string;
  readonly RECORD_INDEX: number;
  readonly SOURCE_SKU_ID?: string;
  readonly SOURCE_PRODUCT_ID?: string;
  readonly MISSING_PRICE_FIELDS: string[];
}

export interface PriceCompetitivenessResult {
  readonly summary: PriceCompetitivenessSummary[];
  readonly issueMatrix: RegionPlatformMatrixRow[];
  readonly issueRows: PriceCompetitivenessIssueRow[];
}

const PRICE_FIELDS = [
  "SKU_PRICE_BEFORE_DISCOUNT",
  "SKU_PRICE_AFTER_DISCOUNT",
  "PRICE_MIN_BEFORE_DISCOUNT",
  "PRICE_MIN_AFTER_DISCOUNT",
  "PRICE_MAX_BEFORE_DISCOUNT",
  "PRICE_MAX_AFTER_DISCOUNT",
] as const;

const buildGroupKey = (region: string, platform: string): string => `${region}||${platform}`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const toOptionalText = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
};

export const runPriceCompetitivenessQuality = (
  rows: CsvRow[],
  options: ScriptOptions = {},
): PriceCompetitivenessResult => {
  const grouped = new Map<
    string,
    {
      totalRows: number;
      missingAllPriceRows: number;
    }
  >();

  const issueRows: PriceCompetitivenessIssueRow[] = [];

  rows.forEach((row, index) => {
    const region = normalizeRegion(row.REGION);
    const platform = normalizePlatform(row.PLATFORM);

    if (!region || !platform) {
      return;
    }

    const key = buildGroupKey(region, platform);
    if (!grouped.has(key)) {
      grouped.set(key, {
        totalRows: 0,
        missingAllPriceRows: 0,
      });
    }

    const group = grouped.get(key);
    if (!group) {
      return;
    }

    group.totalRows += 1;

    const missingFields = PRICE_FIELDS.filter((field) => isMissing(row[field]));
    const missingAll = missingFields.length === PRICE_FIELDS.length;

    if (missingAll) {
      group.missingAllPriceRows += 1;
      issueRows.push({
        REGION: region,
        PLATFORM: platform,
        RECORD_INDEX: index,
        SOURCE_SKU_ID: toOptionalText(row.SOURCE_SKU_ID),
        SOURCE_PRODUCT_ID: toOptionalText(row.SOURCE_PRODUCT_ID),
        MISSING_PRICE_FIELDS: [...PRICE_FIELDS],
      });
    }
  });

  const summary: PriceCompetitivenessSummary[] = [];

  for (const [key, group] of grouped.entries()) {
    const [region, platform] = key.split("||");

    summary.push({
      REGION: region,
      PLATFORM: platform,
      TOTAL_ROWS: group.totalRows,
      MISSING_ALL_PRICE_ROWS: group.missingAllPriceRows,
      MISSING_ALL_PRICE_PCT: ratio(group.missingAllPriceRows, group.totalRows),
    });
  }

  summary.sort((a, b) =>
    a.REGION === b.REGION ? a.PLATFORM.localeCompare(b.PLATFORM) : a.REGION.localeCompare(b.REGION),
  );

  issueRows.sort((a, b) =>
    a.REGION === b.REGION
      ? a.PLATFORM === b.PLATFORM
        ? a.RECORD_INDEX - b.RECORD_INDEX
        : a.PLATFORM.localeCompare(b.PLATFORM)
      : a.REGION.localeCompare(b.REGION),
  );

  const regions = [...new Set(summary.map((item) => item.REGION))].sort((a, b) =>
    a.localeCompare(b),
  );
  const platformOrder = buildPlatformOrder(rows, options.platformOrder);

  const summaryByKey = new Map(
    summary.map((item) => [buildGroupKey(item.REGION, item.PLATFORM), item]),
  );

  const issueMatrix = createEmptyMatrix(regions, platformOrder);

  for (const row of issueMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildGroupKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }

      row[platform] = formatPercent(group.MISSING_ALL_PRICE_PCT);
    }
  }

  return {
    summary,
    issueMatrix,
    issueRows,
  };
};
