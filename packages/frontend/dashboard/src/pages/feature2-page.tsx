import { useMetrics } from "@/actions/metrics-api";
import { DataValidationReportSection } from "@/sections/dashboard/feature2/data-validation-report-section";
import { IngestionSummarySection } from "@/sections/dashboard/feature2/ingestion-summary-section";
import { ProcessingSummarySection } from "@/sections/dashboard/feature2/processing-summary-section";
import { VolumeTrendSection } from "@/sections/dashboard/feature2/volume-trend-section";
import { useDashboard } from "@/lib/dashboard-context";

export function Feature2Page() {
  const { date, setDate } = useDashboard();
  const { data, loading: metricsLoading, error: metricsError } = useMetrics(date, "feature2");

  const feature2Metrics = data?.feature2;
  const showSkeleton = metricsLoading && !feature2Metrics;
  const showMetricsError = Boolean(metricsError);
  const showMetricsMissing = !metricsLoading && !feature2Metrics && !metricsError;
  const canRenderMetrics = Boolean(feature2Metrics);

  const ingestion = feature2Metrics?.ingestion;
  const processing = feature2Metrics?.processing;

  return (
    <div className="space-y-12 transition-opacity duration-200">
      <VolumeTrendSection onBarClick={setDate} />

      <IngestionSummarySection
        showMetricsError={showMetricsError}
        metricsError={metricsError}
        showMetricsMissing={showMetricsMissing}
        showSkeleton={showSkeleton}
        canRenderMetrics={canRenderMetrics}
        ingestion={ingestion}
      />

      <ProcessingSummarySection
        showMetricsError={showMetricsError}
        metricsError={metricsError}
        showMetricsMissing={showMetricsMissing}
        showSkeleton={showSkeleton}
        canRenderMetrics={canRenderMetrics}
        processing={processing}
      />

      <DataValidationReportSection date={date} />
    </div>
  );
}
