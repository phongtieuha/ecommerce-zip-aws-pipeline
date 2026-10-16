import { DateTime } from "luxon";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export type ProductIdsFeature = "feature1";
export type ProductIdsFeature1Section = "consolidated" | "shop-products" | "product-skus";
export type ProductIdsByRegion = Readonly<Record<string, ReadonlyArray<string>>>;
export type ProductIdsBySection = Partial<Record<ProductIdsFeature1Section, ProductIdsByRegion>>;

type ProductIdsApiResponse = Partial<
  Record<ProductIdsFeature1Section, ReadonlyArray<string> | ProductIdsByRegion>
>;

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

function buildProductIdsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/get-product-ids";
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

function normalizeProductIdsBySection(response: ProductIdsApiResponse): ProductIdsBySection {
  const normalized: ProductIdsBySection = {};

  for (const [section, value] of Object.entries(response) as Array<
    [ProductIdsFeature1Section, ProductIdsApiResponse[ProductIdsFeature1Section]]
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

async function fetchProductIds(
  date: string,
  accessToken: string,
  feature: ProductIdsFeature,
  sections: ReadonlyArray<ProductIdsFeature1Section>,
  platforms: ReadonlyArray<string>,
): Promise<ProductIdsBySection> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  if (sections.length === 0) {
    throw new Error("At least one section is required.");
  }

  if (platforms.length === 0) {
    throw new Error("At least one platform is required.");
  }

  const url = buildProductIdsUrl(API_URL);
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
    throw new Error(`Product IDs API error: ${response.status}`);
  }

  const payload = (await response.json()) as ProductIdsApiResponse;
  return normalizeProductIdsBySection(payload);
}

export function useProductIds(
  date: string,
  options: {
    readonly feature?: ProductIdsFeature;
    readonly sections: ReadonlyArray<ProductIdsFeature1Section>;
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
    queryKey: ["product-ids", date, feature, sections.join("|"), platforms.join("|")],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchProductIds(date, accessToken, feature, sections, platforms);
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
