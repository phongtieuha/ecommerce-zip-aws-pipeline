import { DateTime } from "luxon";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export interface VolumeTrendPoint {
  readonly date: string;
  readonly value: number;
  readonly zipFilesFailed: number;
  readonly zipFilesFailedSources: ReadonlyArray<{ readonly file: string }>;
  readonly zipFilesPdpByPlatform: Record<string, number>;
  readonly zipFilesShopProductsByPlatform: Record<string, number>;
  readonly zipFilesKeywordProductsByPlatform: Record<string, number>;
}

export interface VolumeTrendTab {
  readonly key: string;
  readonly label: string;
  readonly color?: string;
  readonly data: ReadonlyArray<VolumeTrendPoint>;
}

export interface VolumeTrendFeature {
  readonly tabs: ReadonlyArray<VolumeTrendTab>;
}

type PartialVolumeTrendResponse = {
  readonly startDate: string;
  readonly endDate: string;
  readonly feature1?: VolumeTrendFeature;
  readonly feature2?: VolumeTrendFeature;
};

interface Feature1VolumeTrendResponse {
  readonly startDate: string;
  readonly endDate: string;
  readonly feature1: VolumeTrendFeature;
}

interface Feature2VolumeTrendResponse {
  readonly startDate: string;
  readonly endDate: string;
  readonly feature2: VolumeTrendFeature;
}

export type FeatureKey = "feature1" | "feature2";

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

const METRIC_ENDPOINTS = {
  zipFilesIngestedTotal: {
    feature1Path: "/feature1/zipFilesIngestedTotal",
    feature2Path: "/feature2/zipFilesIngestedTotal",
  },
  jsonHtmlFilesIngested: {
    feature1Path: "/feature1/jsonHtmlFilesIngested",
    feature2Path: "/feature2/jsonHtmlFilesIngested",
  },
  uniqueProductsIngestedTotal: {
    feature1Path: "/feature1/uniqueProductsIngestedTotal",
    feature2Path: "/feature2/uniqueProductsIngestedTotal",
  },
  uniqueProductsInOutputTotalTotal: {
    feature1Path: "/feature1/uniqueProductsInOutputTotalTotal",
    feature2Path: "/feature2/uniqueProductsInOutputTotalTotal",
  },
} as const;

type MetricKey = keyof typeof METRIC_ENDPOINTS;

function getFetchTimestamp(): string {
  return DateTime.now().startOf("second").toISO() ?? new Date().toISOString();
}

function buildMetricTrendUrl(baseUrl: string, feature: FeatureKey, metric: MetricKey): URL {
  const url = new URL(baseUrl);
  const endpoint = METRIC_ENDPOINTS[metric];
  url.pathname = feature === "feature1" ? endpoint.feature1Path : endpoint.feature2Path;
  return url;
}

async function fetchFeatureMetricTrend(
  feature: FeatureKey,
  metric: MetricKey,
  startDate: string,
  endDate: string,
  accessToken: string,
): Promise<Feature1VolumeTrendResponse | Feature2VolumeTrendResponse> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  const url = buildMetricTrendUrl(API_URL, feature, metric);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Volume trend API error (${metric}): ${response.status}`);
  }

  const tab = (await response.json()) as VolumeTrendTab;
  const base = { startDate, endDate };

  if (feature === "feature1") {
    return { ...base, feature1: { tabs: [tab] } };
  } else {
    return { ...base, feature2: { tabs: [tab] } };
  }
}

async function fetchFeatureVolumeTrend(
  feature: FeatureKey,
  startDate: string,
  endDate: string,
  metricKeys: ReadonlyArray<MetricKey>,
  accessToken: string,
): Promise<Feature1VolumeTrendResponse | Feature2VolumeTrendResponse> {
  const responses = await Promise.all(
    metricKeys.map((metric) =>
      fetchFeatureMetricTrend(feature, metric, startDate, endDate, accessToken),
    ),
  );

  const firstResponse = responses[0];
  const tabs = responses.flatMap((response) => {
    const partialResponse = response as PartialVolumeTrendResponse;
    return feature === "feature1"
      ? (partialResponse.feature1?.tabs ?? [])
      : (partialResponse.feature2?.tabs ?? []);
  });

  if (!firstResponse) {
    const emptyBase = {
      startDate: "",
      endDate: "",
    };

    return feature === "feature1"
      ? {
          ...emptyBase,
          feature1: { tabs: [] },
        }
      : {
          ...emptyBase,
          feature2: { tabs: [] },
        };
  }

  return feature === "feature1"
    ? {
        startDate: firstResponse.startDate,
        endDate: firstResponse.endDate,
        feature1: { tabs },
      }
    : {
        startDate: firstResponse.startDate,
        endDate: firstResponse.endDate,
        feature2: { tabs },
      };
}

function useFeatureMetricTrend(
  preferredFeature: FeatureKey,
  metricKeys: ReadonlyArray<MetricKey>,
  startDate: string,
  endDate: string,
  enabled: boolean = true,
) {
  const { setLastApiCallAt, refetchEveryMinutes } = useDashboard();
  const { isAuthenticated, getAccessToken } = useAuth();
  const refetchEveryMs = refetchEveryMinutes * 60 * 1000;
  const queryScope = metricKeys.join(",");

  const query = useQuery({
    queryKey: ["volume-trends", queryScope, startDate, endDate, preferredFeature],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchFeatureVolumeTrend(preferredFeature, startDate, endDate, metricKeys, accessToken);
    },
    enabled: isAuthenticated && enabled,
    staleTime: refetchEveryMs,
    refetchInterval: refetchEveryMs,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    setLastApiCallAt(getFetchTimestamp());
  }, [query.dataUpdatedAt, setLastApiCallAt]);

  const data = (query.data as PartialVolumeTrendResponse | undefined) ?? null;

  const error = query.error instanceof Error ? query.error.message : query.error;

  return {
    data,
    loading: query.isLoading || query.isFetching,
    error: error ?? null,
  };
}

export function useZipFilesIngestedTotalTrend(
  preferredFeature: FeatureKey,
  startDate: string,
  endDate: string,
  enabled?: boolean,
) {
  return useFeatureMetricTrend(
    preferredFeature,
    ["zipFilesIngestedTotal"],
    startDate,
    endDate,
    enabled,
  );
}

export function useJsonHtmlFilesIngestedTrend(
  preferredFeature: FeatureKey,
  startDate: string,
  endDate: string,
  enabled?: boolean,
) {
  return useFeatureMetricTrend(
    preferredFeature,
    ["jsonHtmlFilesIngested"],
    startDate,
    endDate,
    enabled,
  );
}

export function useUniqueProductsIngestedTotalTrend(
  preferredFeature: FeatureKey,
  startDate: string,
  endDate: string,
  enabled?: boolean,
) {
  return useFeatureMetricTrend(
    preferredFeature,
    ["uniqueProductsIngestedTotal"],
    startDate,
    endDate,
    enabled,
  );
}

export function useUniqueProductsInOutputTotalTotalTrend(
  preferredFeature: FeatureKey,
  startDate: string,
  endDate: string,
  enabled?: boolean,
) {
  return useFeatureMetricTrend(
    preferredFeature,
    ["uniqueProductsInOutputTotalTotal"],
    startDate,
    endDate,
    enabled,
  );
}
