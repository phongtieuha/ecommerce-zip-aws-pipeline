import { DateTime } from "luxon";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export type ShopIdsFeature = "feature1";
export type ShopIdsFeature1Section = "consolidated" | "shop-products" | "product-skus";
export type ShopIdsByRegion = Readonly<Record<string, ReadonlyArray<string>>>;
export type ShopIdsBySection = Partial<Record<ShopIdsFeature1Section, ShopIdsByRegion>>;

type ShopIdsApiResponse = Partial<
  Record<ShopIdsFeature1Section, ReadonlyArray<string> | ShopIdsByRegion>
>;

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

function buildShopIdsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/get-shop-ids";
  return url;
}

function isPastDate(selectedDate: string): boolean {
  const selected = DateTime.fromISO(selectedDate).startOf("day");
  if (!selected.isValid) {
    return false;
  }

  const today = DateTime.local().startOf("day");
  return selected < today;
}

function getFetchTimestamp(): string {
  return DateTime.now().startOf("second").toISO() ?? new Date().toISOString();
}

function normalizeShopIdsBySection(response: ShopIdsApiResponse): ShopIdsBySection {
  const normalized: ShopIdsBySection = {};

  for (const [section, value] of Object.entries(response) as Array<
    [ShopIdsFeature1Section, ShopIdsApiResponse[ShopIdsFeature1Section]]
  >) {
    if (Array.isArray(value)) {
      normalized[section] = {
        unknown: [...value].filter((item): item is string => typeof item === "string"),
      };
      continue;
    }

    if (!value || typeof value !== "object") {
      normalized[section] = {};
      continue;
    }

    const regions = Object.entries(value)
      .filter(([, ids]) => Array.isArray(ids))
      .sort(([left], [right]) => left.localeCompare(right));

    normalized[section] = Object.fromEntries(
      regions.map(([region, ids]) => [
        region,
        (ids as ReadonlyArray<unknown>).filter((item): item is string => typeof item === "string"),
      ]),
    );
  }

  return normalized;
}

async function fetchShopIds(
  date: string,
  accessToken: string,
  feature: ShopIdsFeature,
  sections: ReadonlyArray<ShopIdsFeature1Section>,
  platforms: ReadonlyArray<string>,
): Promise<ShopIdsBySection> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  if (sections.length === 0) {
    throw new Error("At least one section is required.");
  }

  if (platforms.length === 0) {
    throw new Error("At least one platform is required.");
  }

  const url = buildShopIdsUrl(API_URL);
  url.searchParams.set("date", date);
  url.searchParams.set("feature", feature);

  for (const section of sections) {
    url.searchParams.append("section[]", section);
  }

  for (const platform of platforms) {
    const normalized = platform.trim();
    if (normalized.length > 0) {
      url.searchParams.append("platform[]", normalized);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Shop IDs API error: ${response.status}`);
  }

  const payload = (await response.json()) as ShopIdsApiResponse;
  return normalizeShopIdsBySection(payload);
}

export function useShopIds(
  date: string,
  options: {
    readonly feature?: ShopIdsFeature;
    readonly sections: ReadonlyArray<ShopIdsFeature1Section>;
    readonly platforms: ReadonlyArray<string>;
    readonly enabled?: boolean;
  },
) {
  const { setLastApiCallAt, refetchEveryMinutes } = useDashboard();
  const { isAuthenticated, getAccessToken } = useAuth();
  const isPast = isPastDate(date);
  const refetchEveryMs = refetchEveryMinutes * 60 * 1000;

  const feature = options.feature ?? "feature1";
  const sections = [...new Set(options.sections)].sort((left, right) => left.localeCompare(right));
  const platforms = [...new Set(options.platforms.map((item) => item.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );

  const query = useQuery({
    queryKey: ["shop-ids", date, feature, sections.join("|"), platforms.join("|")],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchShopIds(date, accessToken, feature, sections, platforms);
    },
    enabled:
      isAuthenticated && (options.enabled ?? true) && sections.length > 0 && platforms.length > 0,
    staleTime: isPast ? Number.POSITIVE_INFINITY : refetchEveryMs,
    refetchInterval: isPast ? false : refetchEveryMs,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    setLastApiCallAt(getFetchTimestamp());
  }, [query.dataUpdatedAt, setLastApiCallAt]);

  const error = query.error instanceof Error ? query.error.message : query.error;

  return {
    data: query.data ?? {},
    loading: query.isLoading,
    error: error ?? null,
  };
}
