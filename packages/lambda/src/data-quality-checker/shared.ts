export type CsvPrimitive = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvPrimitive>;

export type ExpectedPlatformMap = Record<string, string[]>;

export interface ScriptOptions {
  readonly platformOrder?: string[];
  readonly expectedPlatform?: ExpectedPlatformMap;
}

export type RegionPlatformCell = string | Record<string, string>;
export type RegionPlatformMatrixRow = { REGION: string } & Record<string, RegionPlatformCell>;

export const normalizeRegion = (value: CsvPrimitive): string =>
  String(value ?? "")
    .trim()
    .toUpperCase();

export const normalizePlatform = (value: CsvPrimitive): string =>
  String(value ?? "")
    .trim()
    .toUpperCase();

export const isMissing = (value: CsvPrimitive): boolean => {
  if (value === null || value === undefined) {
    return true;
  }

  const str = String(value).trim();
  if (str.length === 0) {
    return true;
  }

  const upper = str.toUpperCase();
  return upper === "NULL" || upper === "N/A" || upper === "NA";
};

export const parseNumber = (value: CsvPrimitive): number | null => {
  if (isMissing(value)) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseBoolean = (value: CsvPrimitive): boolean | null => {
  if (isMissing(value)) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "f", "0", "no", "n"].includes(normalized)) {
    return false;
  }

  return null;
};

export const formatPercent = (ratio: number | null): string => {
  if (ratio === null || !Number.isFinite(ratio)) {
    return "0.0%";
  }

  return `${(ratio * 100).toFixed(1)}%`;
};

export const asNullableKey = (value: CsvPrimitive): string | null => {
  if (isMissing(value)) {
    return null;
  }

  return String(value).trim();
};

export const buildPlatformOrder = (
  rows: CsvRow[],
  platformOrder: string[] | undefined,
): string[] => {
  if (platformOrder && platformOrder.length > 0) {
    return platformOrder.map((item) => item.trim().toUpperCase());
  }

  const unique = new Set<string>();
  for (const row of rows) {
    const platform = normalizePlatform(row.PLATFORM);
    if (platform.length > 0) {
      unique.add(platform);
    }
  }

  return [...unique].sort((a, b) => a.localeCompare(b));
};

export const isPlatformApplicable = (
  region: string,
  platform: string,
  expectedPlatform: ExpectedPlatformMap | undefined,
): boolean => {
  if (!expectedPlatform) {
    return true;
  }

  const expected = expectedPlatform[region];
  if (!expected) {
    return false;
  }

  return expected.map((item) => item.trim().toUpperCase()).includes(platform);
};

export const createEmptyMatrix = (
  regions: string[],
  platformOrder: string[],
): RegionPlatformMatrixRow[] =>
  regions.map((region) => {
    const row: RegionPlatformMatrixRow = { REGION: region };
    for (const platform of platformOrder) {
      row[platform] = "-";
    }
    return row;
  });
