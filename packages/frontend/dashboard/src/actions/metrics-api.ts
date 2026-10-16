import { DateTime } from "luxon";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export interface CategoryIngestion {
  readonly zipFilesTotal: number;
  readonly zipFilesFailed: number;
  readonly zipFilesFailedSources: ReadonlyArray<{
    readonly file: string;
    readonly reason: string;
    readonly diagnostic?: {
      readonly expectedPattern?: string;
      readonly totalFilesInZip: number;
      readonly jsonFilesFound: number;
      readonly filesMatched: number;
      readonly topLevelFolders: string[];
      readonly fileExtensionsFound: string[];
      readonly sampleFilePaths: string[];
    };
  }>;
  readonly jsonFilesTotal: number;
  readonly jsonFilesFailed: number;
  readonly jsonFilesFailedSources: ReadonlyArray<{
    readonly zipPath: string;
    readonly jsonPaths: ReadonlyArray<{
      readonly file: string;
      readonly reason: string;
    }>;
  }>;
  readonly jsonFilesByPlatform: Record<string, number>;
  readonly jsonFilesByCountry: Record<string, number>;
  readonly uniqueProductsTotal: number;
  readonly uniqueProductsByPlatform: Record<string, number>;
  readonly uniqueProductsByCountry: Record<string, number>;
}

export interface Feature1Ingestion extends CategoryIngestion {
  readonly zipFilesShopProductsByPlatform: Record<string, number>;
  readonly zipFilesPdpByPlatform: Record<string, number>;
  readonly zipFilesShopProductsPathsByPlatform: Record<string, ReadonlyArray<string>>;
  readonly zipFilesPdpPathsByPlatform: Record<string, ReadonlyArray<string>>;
}

export interface Feature2Ingestion extends CategoryIngestion {
  readonly zipFilesByPlatform: Record<string, number>;
  readonly zipFilesPathsByPlatform: Record<string, ReadonlyArray<string>>;
}

export interface CategoryProcessing {
  readonly uniqueProductsTotal: number;
  readonly uniqueProductsFailed: number;
  readonly uniqueProductsFailedSources: ReadonlyArray<{
    readonly file: string;
    readonly failedCount: number;
    readonly reason: string;
    readonly duplicateKeyBreakdown?: ReadonlyArray<{
      readonly product_id?: string | number;
      readonly region?: string;
      readonly search_keyword?: string;
      readonly recorded_on?: string;
      readonly failedCount: number;
    }>;
  }>;
  readonly uniqueProductsFailedProcessing: number;
  readonly uniqueProductsFailedProcessingSources: ReadonlyArray<{
    readonly file: string;
    readonly failedCount: number;
    readonly reason: string;
  }>;
  readonly uniqueProductsDroppedAfterMerging: number;
  readonly uniqueProductsDroppedAfterMergingSources: ReadonlyArray<{
    readonly file: string;
    readonly failedCount: number;
    readonly reason: string;
  }>;
  readonly uniqueProductsByPlatform: Record<string, number>;
  readonly uniqueProductsByCountry: Record<string, number>;
}

export interface CategoryMetrics {
  readonly ingestion: CategoryIngestion;
  readonly processing: CategoryProcessing;
}

export interface Feature1CategoryMetrics {
  readonly ingestion: Feature1Ingestion;
  readonly processing: CategoryProcessing;
}

export interface Feature2CategoryMetrics {
  readonly ingestion: Feature2Ingestion;
  readonly processing: CategoryProcessing;
}

export interface MetricsResponse {
  readonly date: string;
  readonly feature1: Feature1CategoryMetrics;
  readonly feature2: Feature2CategoryMetrics;
}

type PartialMetricsResponse = {
  readonly date: string;
  readonly feature1?: Feature1CategoryMetrics;
  readonly feature2?: Feature2CategoryMetrics;
};

interface Feature1MetricsResponse {
  readonly date: string;
  readonly feature1: Feature1CategoryMetrics;
}

interface Feature2MetricsResponse {
  readonly date: string;
  readonly feature2: Feature2CategoryMetrics;
}

export type FeatureKey = "feature1" | "feature2";

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

function buildMetricsUrl(baseUrl: string, feature: FeatureKey): URL {
  const url = new URL(baseUrl);
  url.pathname = feature === "feature1" ? "/feature1/metrics" : "/feature2/metrics";
  return url;
}

async function fetchFeatureMetrics(
  feature: FeatureKey,
  date: string,
  accessToken: string,
): Promise<Feature1MetricsResponse | Feature2MetricsResponse> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  const url = buildMetricsUrl(API_URL, feature);
  url.searchParams.set("date", date);

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Metrics API error: ${response.status}`);
  }

  return response.json() as Promise<Feature1MetricsResponse | Feature2MetricsResponse>;
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
  // Drop milliseconds so rapid back-to-back query completions don't force extra rerenders.
  return DateTime.now().startOf("second").toISO() ?? new Date().toISOString();
}

export function useMetrics(date: string, preferredFeature: FeatureKey = "feature1") {
  const { setLastApiCallAt, refetchEveryMinutes } = useDashboard();
  const { isAuthenticated, getAccessToken } = useAuth();
  const secondaryFeature: FeatureKey = preferredFeature === "feature1" ? "feature2" : "feature1";
  const isPast = isPastDate(date);
  const refetchEveryMs = refetchEveryMinutes * 60 * 1000;

  const preferredQuery = useQuery({
    queryKey: ["metrics", date, preferredFeature],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchFeatureMetrics(preferredFeature, date, accessToken);
    },
    enabled: isAuthenticated,
    staleTime: isPast ? Number.POSITIVE_INFINITY : refetchEveryMs,
    refetchInterval: isPast ? false : refetchEveryMs,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const secondaryQuery = useQuery({
    queryKey: ["metrics", date, secondaryFeature],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchFeatureMetrics(secondaryFeature, date, accessToken);
    },
    enabled: isAuthenticated && preferredQuery.isSuccess,
    staleTime: isPast ? Number.POSITIVE_INFINITY : refetchEveryMs,
    refetchInterval: isPast ? false : refetchEveryMs,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!preferredQuery.dataUpdatedAt) return;
    setLastApiCallAt(getFetchTimestamp());
  }, [preferredQuery.dataUpdatedAt, setLastApiCallAt]);

  const merged = {
    date,
    ...(preferredQuery.data as object | undefined),
    ...(secondaryQuery.data as object | undefined),
  } as PartialMetricsResponse;

  const data: PartialMetricsResponse | null =
    merged.feature1 || merged.feature2
      ? {
          date: merged.date ?? date,
          feature1: merged.feature1,
          feature2: merged.feature2,
        }
      : null;

  const preferredError =
    preferredQuery.error instanceof Error ? preferredQuery.error.message : preferredQuery.error;
  const secondaryError =
    secondaryQuery.error instanceof Error ? secondaryQuery.error.message : secondaryQuery.error;

  return {
    data,
    loading: preferredQuery.isLoading,
    error: preferredError ?? secondaryError ?? null,
  };
}
