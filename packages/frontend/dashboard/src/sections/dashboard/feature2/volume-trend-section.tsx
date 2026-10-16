import { useMemo, useState } from "react";
import { format } from "date-fns";
import { type DateRange } from "react-day-picker";
import {
  useJsonHtmlFilesIngestedTrend,
  useUniqueProductsIngestedTotalTrend,
  useUniqueProductsInOutputTotalTotalTrend,
  useZipFilesIngestedTotalTrend,
} from "@/actions/volume-trend-api";
import { SectionNotice } from "@/components/dashboard/section-notice";
import {
  getDefaultVolumeTrendApiDateRange,
  type VolumeTrendApiDateRange,
  type VolumeTrendPoint,
  type VolumeTrendTab,
  VolumeTrendCard,
} from "@/components/dashboard/volume-trend-card";

const VOLUME_TREND_TABS: ReadonlyArray<Pick<VolumeTrendTab, "key" | "label">> = [
  { key: "zipFilesIngestedTotal", label: "ZIP Files Ingested (Total)" },
  { key: "jsonHtmlFilesIngested", label: "JSON/HTML Files Ingested" },
  { key: "uniqueProductsIngestedTotal", label: "Unique Products Ingested (Total)" },
  { key: "uniqueProductsInOutputTotalTotal", label: "Unique Products in Output (Total)" },
];

interface VolumeTrendSectionProps {
  readonly onBarClick: (date: string) => void;
}

export function VolumeTrendSection({ onBarClick }: VolumeTrendSectionProps) {
  const defaultTrendDateRange = getDefaultVolumeTrendApiDateRange();
  const [activeTrendMetric, setActiveTrendMetric] = useState<string>(VOLUME_TREND_TABS[0]!.key);
  const [trendDateRanges, setTrendDateRanges] = useState<Record<string, VolumeTrendApiDateRange>>(
    () => ({
      zipFilesIngestedTotal: defaultTrendDateRange,
      jsonHtmlFilesIngested: defaultTrendDateRange,
      uniqueProductsIngestedTotal: defaultTrendDateRange,
      uniqueProductsInOutputTotalTotal: defaultTrendDateRange,
    }),
  );

  const zipTrend = useZipFilesIngestedTotalTrend(
    "feature2",
    trendDateRanges.zipFilesIngestedTotal.startDate,
    trendDateRanges.zipFilesIngestedTotal.endDate,
    activeTrendMetric === "zipFilesIngestedTotal",
  );
  const jsonTrend = useJsonHtmlFilesIngestedTrend(
    "feature2",
    trendDateRanges.jsonHtmlFilesIngested.startDate,
    trendDateRanges.jsonHtmlFilesIngested.endDate,
    activeTrendMetric === "jsonHtmlFilesIngested",
  );
  const uniqueProductsTrend = useUniqueProductsIngestedTotalTrend(
    "feature2",
    trendDateRanges.uniqueProductsIngestedTotal.startDate,
    trendDateRanges.uniqueProductsIngestedTotal.endDate,
    activeTrendMetric === "uniqueProductsIngestedTotal",
  );
  const outputProductsTrend = useUniqueProductsInOutputTotalTotalTrend(
    "feature2",
    trendDateRanges.uniqueProductsInOutputTotalTotal.startDate,
    trendDateRanges.uniqueProductsInOutputTotalTotal.endDate,
    activeTrendMetric === "uniqueProductsInOutputTotalTotal",
  );

  const trendDataByKey = {
    zipFilesIngestedTotal: zipTrend.data?.feature2?.tabs?.[0],
    jsonHtmlFilesIngested: jsonTrend.data?.feature2?.tabs?.[0],
    uniqueProductsIngestedTotal: uniqueProductsTrend.data?.feature2?.tabs?.[0],
    uniqueProductsInOutputTotalTotal: outputProductsTrend.data?.feature2?.tabs?.[0],
  } as const;

  const trendTabs = useMemo(
    () =>
      VOLUME_TREND_TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        data: trendDataByKey[tab.key as keyof typeof trendDataByKey]?.data ?? [],
        ...(tab.key === "zipFilesIngestedTotal" &&
          (() => {
            const zipData = trendDataByKey.zipFilesIngestedTotal?.data ?? [];
            const expectedKeywordPlatforms = new Set<string>();
            for (const point of zipData) {
              for (const p of Object.keys(point.zipFilesKeywordProductsByPlatform)) {
                expectedKeywordPlatforms.add(p);
              }
            }
            return {
              getBarColor: (point: VolumeTrendPoint) => {
                const hasZero = [...expectedKeywordPlatforms].some(
                  (p) => !point.zipFilesKeywordProductsByPlatform[p],
                );
                const hasFailedZip = (point.zipFilesFailed ?? 0) > 0;
                if (hasZero) {
                  return "var(--destructive)";
                }
                if (hasFailedZip) {
                  return "var(--ring)";
                }
                return "var(--bar-default)";
              },
              getTooltipExtra: (point: VolumeTrendPoint) => {
                const missingPlatforms = [...expectedKeywordPlatforms].filter(
                  (p) => !point.zipFilesKeywordProductsByPlatform[p],
                );
                const lines: string[] = [];
                if ((point.zipFilesFailed ?? 0) > 0) {
                  lines.push(
                    `ZIP Files Failed: ${point.zipFilesFailed}${point.zipFilesFailedSources.length > 0 ? " | " + point.zipFilesFailedSources.map((src) => src.file).join(", ") : ""}`,
                  );
                }
                if (missingPlatforms.length > 0) {
                  lines.push(`Missing ZIP Files by Platform: ${missingPlatforms.join(", ")}`);
                }
                return lines.length > 0 ? lines.join("\n") : undefined;
              },
            };
          })()),
      })),
    [
      trendDataByKey.jsonHtmlFilesIngested,
      trendDataByKey.uniqueProductsIngestedTotal,
      trendDataByKey.uniqueProductsInOutputTotalTotal,
      trendDataByKey.zipFilesIngestedTotal,
    ],
  );

  const activeTrendState = {
    zipFilesIngestedTotal: zipTrend,
    jsonHtmlFilesIngested: jsonTrend,
    uniqueProductsIngestedTotal: uniqueProductsTrend,
    uniqueProductsInOutputTotalTotal: outputProductsTrend,
  }[activeTrendMetric];
  const activeTrendTab = trendTabs.find((tab) => tab.key === activeTrendMetric);
  const volumeTrendLoading = activeTrendState?.loading ?? false;
  const volumeTrendError = activeTrendState?.error ?? null;
  const showVolumeTrendMissing =
    !volumeTrendLoading && !volumeTrendError && (activeTrendTab?.data.length ?? 0) === 0;

  function handleTrendRangeChange(metricKey: string, range: DateRange | undefined) {
    if (!range?.from || !range?.to) {
      return;
    }

    const startDate = format(range.from, "yyyy-MM-dd");
    const endDate = format(range.to, "yyyy-MM-dd");

    setTrendDateRanges((currentRanges) => ({
      ...currentRanges,
      [metricKey]: {
        startDate,
        endDate,
      },
    }));
  }

  return (
    <section className="space-y-6">
      {volumeTrendError ? (
        <SectionNotice
          message={`Failed to load volume trend: ${volumeTrendError}`}
          tone="destructive"
        />
      ) : showVolumeTrendMissing ? (
        <SectionNotice message="Volume trend response is missing." />
      ) : (
        <VolumeTrendCard
          tabs={trendTabs}
          loading={volumeTrendLoading}
          activeMetric={activeTrendMetric}
          onBarClick={onBarClick}
          onActiveMetricChange={setActiveTrendMetric}
          onRangeChange={handleTrendRangeChange}
        />
      )}
    </section>
  );
}
