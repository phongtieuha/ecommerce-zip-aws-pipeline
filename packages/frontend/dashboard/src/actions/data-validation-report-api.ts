import { DateTime } from "luxon";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { useAuth } from "@/lib/auth";

export type DataValidationFeature = "feature1" | "feature2";
export type DataValidationFeature1Section = "consolidated" | "shop-products" | "product-skus";
export type DataValidationFeature2Section = "keyword-products";
export type DataValidationSection = DataValidationFeature1Section | DataValidationFeature2Section;

export interface DataValidationReportResponse {
  readonly feature1?: Readonly<
    Partial<Record<DataValidationFeature1Section, ReadonlyArray<DataValidationScriptReport>>>
  >;
  readonly feature2?: ReadonlyArray<DataValidationScriptReport>;
  readonly updatedAt?: string | null;
}

export interface DataValidationScriptReport {
  readonly script: string;
  readonly description: string;
  readonly date: string;
  readonly sources: ReadonlyArray<DataValidationSource>;
  readonly result: DataValidationResult;
}

export interface DataValidationSource {
  readonly platform: string;
  readonly country: string;
  readonly sourceKey: string;
}

export type DataValidationResult = Readonly<Record<string, DataValidationRegionMatrix>>;

export type DataValidationRegionMatrix = Readonly<Record<string, DataValidationPlatformMatrix>>;

export type DataValidationPlatformMatrix = Readonly<Record<string, DataValidationCellValue>>;

export type DataValidationCellValue = string | Readonly<Record<string, string>>;

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL as string | undefined;

function buildDataValidationReportUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/get-data-validation-report";
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
  // Drop milliseconds so rapid back-to-back query completions don't force extra rerenders.
  return DateTime.now().startOf("second").toISO() ?? new Date().toISOString();
}

async function fetchDataValidationReport(
  date: string,
  accessToken: string,
  feature: DataValidationFeature,
  section?: DataValidationSection,
): Promise<DataValidationReportResponse> {
  if (!API_URL) {
    throw new Error("VITE_DASHBOARD_API_URL is not configured.");
  }

  const url = buildDataValidationReportUrl(API_URL);
  url.searchParams.set("date", date);
  url.searchParams.set("feature", feature);
  if (section) {
    url.searchParams.set("section", section);
  }

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Data validation report API error: ${response.status}`);
  }

  return response.json() as Promise<DataValidationReportResponse>;
}

export function useDataValidationReport(
  date: string,
  options: {
    readonly feature: DataValidationFeature;
    readonly section?: DataValidationSection;
  },
) {
  const { setLastApiCallAt, refetchEveryMinutes } = useDashboard();
  const { isAuthenticated, getAccessToken } = useAuth();
  const isPast = isPastDate(date);
  const refetchEveryMs = refetchEveryMinutes * 60 * 1000;
  const feature = options.feature;
  const section = options.section;

  const query = useQuery({
    queryKey: ["data-validation-report", date, feature ?? null, section ?? null],
    queryFn: async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated.");
      }

      return fetchDataValidationReport(date, accessToken, feature, section);
    },
    enabled: isAuthenticated,
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
