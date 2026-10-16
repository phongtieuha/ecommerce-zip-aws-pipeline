import type { BreakdownItem } from "@/components/dashboard/breakdown-card";

const PLATFORM_ORDER = [
  "711",
  "JD",
  "Lazada",
  "Momoshop",
  "Redmart",
  "Shopee",
  "Tiktok",
  "Tmall",
  "Tmall-supermarket",
  "Watsons",
] as const;

const COUNTRY_ORDER = ["cn", "id", "my", "ph", "sg", "th", "tw", "vn"] as const;

function toOrderedBreakdownItems(
  grouped: Record<string, number> | undefined,
  preferredOrder: readonly string[],
): BreakdownItem[] {
  const values = grouped ?? {};
  const preferred = new Set(preferredOrder);
  const extraLabels = Object.keys(values)
    .filter((label) => !preferred.has(label))
    .sort((left, right) => left.localeCompare(right));

  return [...preferredOrder, ...extraLabels].map((label) => ({
    label,
    value: values[label] ?? 0,
  }));
}

export function mergeGroupedCounts(
  ...groups: Array<Record<string, number> | undefined>
): Record<string, number> {
  const merged: Record<string, number> = {};

  for (const group of groups) {
    for (const [label, value] of Object.entries(group ?? {})) {
      merged[label] = (merged[label] ?? 0) + value;
    }
  }

  return merged;
}

export function toPlatformBreakdownItems(
  grouped: Record<string, number> | undefined,
): BreakdownItem[] {
  return toOrderedBreakdownItems(grouped, PLATFORM_ORDER);
}

export function toCountryBreakdownItems(
  grouped: Record<string, number> | undefined,
): BreakdownItem[] {
  return toOrderedBreakdownItems(grouped, COUNTRY_ORDER);
}
