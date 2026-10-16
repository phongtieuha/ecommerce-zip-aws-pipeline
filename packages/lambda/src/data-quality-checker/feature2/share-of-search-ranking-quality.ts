import {
  asNullableKey,
  buildPlatformOrder,
  createEmptyMatrix,
  formatPercent,
  isMissing,
  normalizePlatform,
  normalizeRegion,
  parseNumber,
  type CsvRow,
  type RegionPlatformMatrixRow,
  type ScriptOptions,
} from "../shared";

interface RankingRow {
  readonly region: string;
  readonly platform: string;
  readonly searchKeyword: string;
  readonly overallRanking: string | null;
  readonly adsRanking: number | null;
  readonly organicRankingMissing: boolean;
}

export interface ShareOfSearchSummary {
  readonly REGION: string;
  readonly PLATFORM: string;
  readonly TOTAL_ROWS: number;
  readonly NULL_OVERALL: number;
  readonly NULL_ADS: number;
  readonly NULL_ORG: number;
  readonly DUP_OVERALL: number;
  readonly BAD_LOGIC: number;
  readonly NULL_OVERALL_PCT: number | null;
  readonly NULL_ADS_PCT: number | null;
  readonly NULL_ORG_PCT: number | null;
  readonly DUP_OVERALL_PCT: number | null;
  readonly BAD_LOGIC_PCT: number | null;
}

export interface ShareOfSearchResult {
  readonly summary: ShareOfSearchSummary[];
  readonly nullMatrix: RegionPlatformMatrixRow[];
  readonly issueMatrix: RegionPlatformMatrixRow[];
}

const buildRegionPlatformKey = (region: string, platform: string): string =>
  `${region}||${platform}`;

const buildDupKey = (
  region: string,
  platform: string,
  searchKeyword: string,
  overallRanking: string,
): string => `${region}||${platform}||${searchKeyword}||${overallRanking}`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export const runShareOfSearchRankingQuality = (
  rows: CsvRow[],
  options: ScriptOptions = {},
): ShareOfSearchResult => {
  const normalizedRows: RankingRow[] = [];

  for (const row of rows) {
    const region = normalizeRegion(row.REGION);
    const platform = normalizePlatform(row.PLATFORM);
    const searchKeyword = asNullableKey(row.SEARCH_KEYWORD);

    if (!region || !platform || !searchKeyword) {
      continue;
    }

    const overallKey = asNullableKey(row.OVERALL_RANKING);
    const adsRanking = parseNumber(row.ADS_RANKING);

    normalizedRows.push({
      region,
      platform,
      searchKeyword,
      overallRanking: overallKey,
      adsRanking,
      organicRankingMissing: isMissing(row.ORGANIC_RANKING),
    });
  }

  const duplicateCounts = new Map<string, number>();

  for (const row of normalizedRows) {
    if (!row.overallRanking) {
      continue;
    }

    const dupKey = buildDupKey(row.region, row.platform, row.searchKeyword, row.overallRanking);
    duplicateCounts.set(dupKey, (duplicateCounts.get(dupKey) ?? 0) + 1);
  }

  const grouped = new Map<
    string,
    {
      totalRows: number;
      nullOverall: number;
      nullAds: number;
      nullOrg: number;
      dupOverall: number;
      badLogic: number;
    }
  >();

  for (const row of normalizedRows) {
    const groupKey = buildRegionPlatformKey(row.region, row.platform);
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        totalRows: 0,
        nullOverall: 0,
        nullAds: 0,
        nullOrg: 0,
        dupOverall: 0,
        badLogic: 0,
      });
    }

    const group = grouped.get(groupKey);
    if (!group) {
      continue;
    }

    group.totalRows += 1;

    const nullOverall = row.overallRanking === null;
    const nullAds = row.adsRanking === null;
    const nullOrg = row.organicRankingMissing;

    if (nullOverall) {
      group.nullOverall += 1;
    }
    if (nullAds) {
      group.nullAds += 1;
    }
    if (nullOrg) {
      group.nullOrg += 1;
    }

    if (row.overallRanking) {
      const dupKey = buildDupKey(row.region, row.platform, row.searchKeyword, row.overallRanking);
      if ((duplicateCounts.get(dupKey) ?? 0) > 1) {
        group.dupOverall += 1;
      }
    }

    if (row.adsRanking === 0 && row.organicRankingMissing) {
      group.badLogic += 1;
    }
  }

  const summary: ShareOfSearchSummary[] = [];

  for (const [key, group] of grouped.entries()) {
    const [region, platform] = key.split("||");

    summary.push({
      REGION: region,
      PLATFORM: platform,
      TOTAL_ROWS: group.totalRows,
      NULL_OVERALL: group.nullOverall,
      NULL_ADS: group.nullAds,
      NULL_ORG: group.nullOrg,
      DUP_OVERALL: group.dupOverall,
      BAD_LOGIC: group.badLogic,
      NULL_OVERALL_PCT: ratio(group.nullOverall, group.totalRows),
      NULL_ADS_PCT: ratio(group.nullAds, group.totalRows),
      NULL_ORG_PCT: ratio(group.nullOrg, group.totalRows),
      DUP_OVERALL_PCT: ratio(group.dupOverall, group.totalRows),
      BAD_LOGIC_PCT: ratio(group.badLogic, group.totalRows),
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
    summary.map((item) => [buildRegionPlatformKey(item.REGION, item.PLATFORM), item]),
  );

  const nullMatrix = createEmptyMatrix(regions, platformOrder);
  const issueMatrix = createEmptyMatrix(regions, platformOrder);

  for (const row of nullMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildRegionPlatformKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }
      row[platform] = {
        OVERALL: formatPercent(group.NULL_OVERALL_PCT),
        ADS: formatPercent(group.NULL_ADS_PCT),
        ORG: formatPercent(group.NULL_ORG_PCT),
      };
    }
  }

  for (const row of issueMatrix) {
    for (const platform of platformOrder) {
      const group = summaryByKey.get(buildRegionPlatformKey(row.REGION, platform));
      if (!group) {
        row[platform] = "-";
        continue;
      }
      row[platform] = {
        DUP_OVERALL: formatPercent(group.DUP_OVERALL_PCT),
        LOGIC_ERROR: formatPercent(group.BAD_LOGIC_PCT),
      };
    }
  }

  return {
    summary,
    nullMatrix,
    issueMatrix,
  };
};
