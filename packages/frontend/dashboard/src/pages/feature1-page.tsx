import { useMetrics } from "@/actions/metrics-api";
import { DataValidationReportSection } from "@/sections/dashboard/feature1/data-validation-report-section";
import { IngestionSummarySection } from "@/sections/dashboard/feature1/ingestion-summary-section";
import { ProcessingSummarySection } from "@/sections/dashboard/feature1/processing-summary-section";
import { ProductIdsReportSection } from "@/sections/dashboard/feature1/product-ids-report-section";
import { ShopIdsReportSection } from "@/sections/dashboard/feature1/shop-ids-report-section";
import { VolumeTrendSection } from "@/sections/dashboard/feature1/volume-trend-section";
import { useDashboard } from "@/lib/dashboard-context";

export function Feature1Page() {
  const { date, setDate } = useDashboard();
  const { data, loading: metricsLoading, error: metricsError } = useMetrics(date, "feature1");
  const feature1Metrics = data?.feature1;
  const showSkeleton = metricsLoading && !feature1Metrics;

  const ingestion = feature1Metrics?.ingestion;
  const processing = feature1Metrics?.processing;
  const showMetricsError = Boolean(metricsError);
  const showMetricsMissing = !metricsLoading && !feature1Metrics && !metricsError;
  const canRenderMetrics = Boolean(feature1Metrics);

  return (
    <div className={`space-y-12 transition-opacity duration-200`}>
      <VolumeTrendSection date={date} onBarClick={setDate} />

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

      <ProductIdsReportSection date={date} />

      <ShopIdsReportSection date={date} />
    </div>
  );
}
