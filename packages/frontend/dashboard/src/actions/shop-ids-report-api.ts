import { DateTime } from "luxon";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export type ShopIdsReportFeature1Section = "consolidated" | "shop-products" | "product-skus";

export interface ShopIdsReportResponse {
  readonly date: string;
  readonly generatedAt: string;
  readonly feature1: Readonly<
    Record<ShopIdsReportFeature1Section, Readonly<Record<string, number | null>>>
  >;
}

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

function buildShopIdsReportUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/get-shop-ids-report";
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

async function fetchShopIdsReport(
  date: string,
  accessToken: string,
): Promise<ShopIdsReportResponse> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  const url = buildShopIdsReportUrl(API_URL);
  url.searchParams.set("date", date);

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Shop IDs report API error: ${response.status}`);
  }

  return response.json() as Promise<ShopIdsReportResponse>;
}

export function useShopIdsReport(
  date: string,
  options?: {
    readonly enabled?: boolean;
  },
) {
  const { setLastApiCallAt, refetchEveryMinutes } = useDashboard();
  const { isAuthenticated, getAccessToken } = useAuth();
  const isPast = isPastDate(date);
  const refetchEveryMs = refetchEveryMinutes * 60 * 1000;

  const query = useQuery({
    queryKey: ["shop-ids-report", date],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchShopIdsReport(date, accessToken);
    },
    enabled: isAuthenticated && (options?.enabled ?? true),
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
    data: query.data ?? null,
    loading: query.isLoading,
    error: error ?? null,
  };
}
