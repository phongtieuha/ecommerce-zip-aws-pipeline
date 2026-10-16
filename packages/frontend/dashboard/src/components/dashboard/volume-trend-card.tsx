import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { type DateRange } from "react-day-picker";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

export const DEFAULT_VOLUME_TREND_DAYS = 14;
export const MAX_VOLUME_TREND_RANGE_DAYS = 30;

export type VolumeTrendApiDateRange = {
  startDate: string;
  endDate: string;
};

function toDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function getDefaultVolumeTrendApiDateRange(
  days: number = DEFAULT_VOLUME_TREND_DAYS,
): VolumeTrendApiDateRange {
  const safeDays = Math.max(1, Math.floor(days));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - safeDays + 1);

  return {
    startDate: toDateKey(start),
    endDate: toDateKey(end),
  };
}

function toPickerDateRange(value: VolumeTrendApiDateRange): DateRange {
  return {
    from: new Date(`${value.startDate}T00:00:00`),
    to: new Date(`${value.endDate}T00:00:00`),
  };
}

export type VolumeTrendPoint = {
  date: string;
  value: number;
  zipFilesFailed: number;
  zipFilesFailedSources: ReadonlyArray<{ readonly file: string }>;
  zipFilesPdpByPlatform: Record<string, number>;
  zipFilesShopProductsByPlatform: Record<string, number>;
  zipFilesKeywordProductsByPlatform: Record<string, number>;
};

export type VolumeTrendTab = {
  key: string;
  label: string;
  color?: string;
  getBarColor?: (point: VolumeTrendPoint) => string;
  getTooltipExtra?: (point: VolumeTrendPoint) => string | undefined;
  data: ReadonlyArray<VolumeTrendPoint>;
};

type VolumeTrendCardProps = {
  tabs: ReadonlyArray<VolumeTrendTab>;
  title?: string;
  description?: string;
  loading?: boolean;
  activeMetric?: string;
  onBarClick?: (date: string) => void;
  onActiveMetricChange?: (metricKey: string) => void;
  onRangeChange?: (metricKey: string, range: DateRange | undefined) => void;
};

type VolumeTrendTooltipProps = {
  active?: boolean;
  payload?: Array<{
    value?: number | string;
    payload?: VolumeTrendPoint;
  }>;
  getTooltipExtra?: (point: VolumeTrendPoint) => string | undefined;
};

function VolumeTrendTooltip({ active, payload, getTooltipExtra }: VolumeTrendTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload;
  if (!point) {
    return null;
  }

  const extra = getTooltipExtra?.(point);
  const value = payload[0]?.value;

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-mono font-medium text-foreground">
        {Number(value).toLocaleString("en-US")} on {point.date}
      </span>
      {extra &&
        extra.split("\n").map((line, i) => (
          <span key={i} className="text-muted-foreground">
            {line}
          </span>
        ))}
    </div>
  );
}

export function VolumeTrendCard({
  tabs,
  title = "Volume Trend",
  description,
  loading = false,
  activeMetric: activeMetricProp,
  onBarClick,
  onActiveMetricChange,
  onRangeChange,
}: VolumeTrendCardProps) {
  const [internalActiveMetric, setInternalActiveMetric] = useState<string>(tabs[0]?.key ?? "");
  const [selectedRanges, setSelectedRanges] = useState<Record<string, DateRange | undefined>>({});
  const defaultSelectedRange = useMemo(
    () => toPickerDateRange(getDefaultVolumeTrendApiDateRange()),
    [],
  );
  const activeMetric = activeMetricProp ?? internalActiveMetric;

  useEffect(() => {
    if (!tabs.some((tab) => tab.key === activeMetric)) {
      const nextMetric = tabs[0]?.key ?? "";
      setInternalActiveMetric(nextMetric);
      onActiveMetricChange?.(nextMetric);
    }
  }, [tabs, activeMetric, onActiveMetricChange]);

  const chartConfig = useMemo(
    () =>
      tabs.reduce((acc, tab) => {
        acc[tab.key] = {
          label: tab.label,
        };
        return acc;
      }, {} as ChartConfig),
    [tabs],
  );

  const activeTab = tabs.find((tab) => tab.key === activeMetric) ?? tabs[0];

  const selectedRange = selectedRanges[activeMetric] ?? defaultSelectedRange;

  const filteredData = useMemo(() => {
    if (!activeTab) return [];

    const fromKey = selectedRange?.from ? format(selectedRange.from, "yyyy-MM-dd") : undefined;
    const toKey = selectedRange?.to ? format(selectedRange.to, "yyyy-MM-dd") : undefined;

    return activeTab.data.filter((point) => {
      if (fromKey && point.date < fromKey) return false;
      if (toKey && point.date > toKey) return false;

      return true;
    });
  }, [activeTab, selectedRange]);

  const chartData = useMemo(
    () =>
      filteredData.map((point) => ({
        ...point,
        fill: activeTab?.getBarColor ? activeTab.getBarColor(point) : "#3b82f6",
      })),
    [filteredData, activeTab],
  );

  function handleRangeChange(range: DateRange | undefined) {
    setSelectedRanges((currentRanges) => ({
      ...currentRanges,
      [activeMetric]: range,
    }));
    onRangeChange?.(activeMetric, range);
  }

  function handleActiveMetricChange(nextMetric: string) {
    setInternalActiveMetric(nextMetric);
    onActiveMetricChange?.(nextMetric);
  }

  if (!activeTab && !loading) {
    return null;
  }

  return (
    <Card className="overflow-hidden border-border/70 bg-card/80 ">
      <Tabs value={activeMetric} onValueChange={handleActiveMetricChange}>
        <CardHeader className="flex flex-col items-stretch border-b border-border p-0 sm:flex-row space-y-0">
          <div className="flex flex-1 flex-col justify-center gap-1 px-6 pt-5 pb-2">
            <CardTitle className="text-lg font-semibold">{title}</CardTitle>
            <div className="flex items-center space-x-3">
              <CardDescription>{description ?? `Showing totals for`}</CardDescription>
              <DateRangePicker
                value={selectedRange}
                onChange={handleRangeChange}
                maxRangeDays={MAX_VOLUME_TREND_RANGE_DAYS}
              />
            </div>
          </div>
          <TabsList
            className="grid
             h-auto w-full grid-cols-1 gap-0 space-x-0 rounded-none border-b border-border bg-transparent p-0 sm:w-auto sm:grid-cols-2 sm:border-b-0"
          >
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                className="data-[state=active]:bg-muted/60 flex w-full items-center justify-start rounded-none border-b border-border px-6 py-4 text-left hover:bg-muted/60 sm:border-b-0 sm:border-l"
              >
                <span className="text-xs text-muted-foreground">{tab.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        <CardContent className="px-2 pt-6 sm:px-6 sm:pt-6">
          {loading ? (
            <Skeleton className="h-64 w-full md:h-72" />
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full md:h-72">
              <BarChart
                accessibilityLayer
                data={chartData}
                margin={{ top: 8, right: 6, left: 12, bottom: 0 }}
                onClick={(chartData) => {
                  const date = chartData.activeLabel as string | undefined;
                  if (date && onBarClick) onBarClick(date);
                }}
                style={onBarClick ? { cursor: "pointer" } : undefined}
              >
                <CartesianGrid vertical={false} stroke="rgba(120, 143, 173, 0.16)" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  minTickGap={18}
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    });
                  }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={72}
                  tickFormatter={(value) => Number(value).toLocaleString("en-US")}
                />
                <ChartTooltip
                  cursor={{ fill: "rgba(59, 130, 246, 0.12)" }}
                  content={<VolumeTrendTooltip getTooltipExtra={activeTab?.getTooltipExtra} />}
                />
                <Bar
                  dataKey="value"
                  name={activeMetric}
                  radius={[0, 0, 0, 0]}
                  fill="#3b82f6"
                  cursor={onBarClick ? "pointer" : undefined}
                />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Tabs>
    </Card>
  );
}
