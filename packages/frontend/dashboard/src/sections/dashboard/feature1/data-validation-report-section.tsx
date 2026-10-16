import { useMemo, useState } from "react";
import { Circle } from "lucide-react";
import type {
  DataValidationFeature1Section,
  DataValidationRegionMatrix,
  DataValidationScriptReport,
} from "@/actions/data-validation-report-api";
import { useDataValidationReport } from "@/actions/data-validation-report-api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataValidationCardTitle } from "@/components/dashboard/data-validation-card-title";
import { DataValidationReportSkeletonCard } from "@/components/dashboard/data-validation-report-skeleton-card";
import { DataValidationTable } from "@/components/dashboard/data-validation-table";
import { SectionNotice } from "@/components/dashboard/section-notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PLATFORM_ORDER, REGION_ORDER } from "@/utils/constants";
import { formatLastFetch } from "@/utils/format-last-fetch";
import { sortWithReferenceOrder } from "@/utils/sort-with-reference-order";

interface DataValidationMetricTable {
  readonly metricName: string;
  readonly regions: string[];
  readonly platforms: string[];
  readonly regionMatrix: DataValidationRegionMatrix;
}

interface DataValidationSectionConfig {
  readonly key: string;
  readonly report: DataValidationScriptReport | null;
  readonly tables: ReadonlyArray<DataValidationMetricTable>;
  readonly missingMessage: string;
}

interface DataValidationSectionDefinition {
  readonly key: string;
  readonly scriptName: string;
  readonly missingMessage: string;
}

interface DataValidationReportSectionProps {
  readonly date: string;
}

const validationViewOptions = [
  { label: "From consolidated", value: "consolidated" },
  { label: "From shop-products", value: "shop-products" },
  { label: "From product-skus", value: "product-skus" },
] as const;

const dataValidationSectionDefinitions: readonly DataValidationSectionDefinition[] = [
  {
    key: "ola-data-quality",
    scriptName: "ola data quality",
    missingMessage: "OLA Data Quality report is not available for the selected date.",
  },
  {
    key: "rating-reviews-data-quality",
    scriptName: "rating & reviews data quality",
    missingMessage: "Rating & Reviews Data Quality report is not available for the selected date.",
  },
  {
    key: "price-competitiveness-quality",
    scriptName: "price competitiveness quality",
    missingMessage:
      "Price Competitiveness Quality - Feature1 report is not available for the selected date.",
  },
] as const;

function findReportByScript(
  reports: ReadonlyArray<DataValidationScriptReport>,
  scriptName: string,
): DataValidationScriptReport | null {
  return reports.find((item) => item.script.trim().toLowerCase() === scriptName) ?? null;
}

function mapMetricTables(report: DataValidationScriptReport | null): DataValidationMetricTable[] {
  if (!report) {
    return [];
  }

  return Object.entries(report.result).map(([metricName, regionMatrix]) => {
    const regions = sortWithReferenceOrder(Object.keys(regionMatrix), REGION_ORDER);

    const platformSet = new Set<string>();
    for (const region of regions) {
      const row = regionMatrix[region];
      for (const platform of Object.keys(row)) {
        platformSet.add(platform);
      }
    }

    const platforms = sortWithReferenceOrder(Array.from(platformSet), PLATFORM_ORDER);

    return {
      metricName,
      regions,
      platforms,
      regionMatrix,
    };
  });
}

export function DataValidationReportSection({ date }: DataValidationReportSectionProps) {
  const [selectedValidationView, setSelectedValidationView] =
    useState<DataValidationFeature1Section>("consolidated");
  const { data: dataValidationReport, loading: dataValidationLoading } = useDataValidationReport(
    date,
    {
      feature: "feature1",
      section: selectedValidationView,
    },
  );

  const dataValidationUpdatedAt = dataValidationReport?.updatedAt ?? null;
  const feature1DataValidationReport =
    dataValidationReport?.feature1?.[selectedValidationView] ?? [];

  const validationSections = useMemo<DataValidationSectionConfig[]>(
    () =>
      dataValidationSectionDefinitions.map((definition) => {
        const report = findReportByScript(feature1DataValidationReport, definition.scriptName);
        return {
          key: definition.key,
          report,
          tables: mapMetricTables(report),
          missingMessage: definition.missingMessage,
        };
      }),
    [feature1DataValidationReport],
  );

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold uppercase tracking-wider text-amber-600">
            Data Validation Report
          </h2>
          <Badge variant="outline" className="gap-2">
            <Circle className="h-2 w-2 fill-current" />
            {formatLastFetch(dataValidationUpdatedAt)}
          </Badge>
        </div>
        <Select
          value={selectedValidationView}
          onValueChange={(value) =>
            setSelectedValidationView(value as DataValidationFeature1Section)
          }
        >
          <SelectTrigger className="min-w-40">
            <SelectValue placeholder="Select source" />
          </SelectTrigger>
          <SelectContent>
            {validationViewOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {validationSections.map((section) =>
        dataValidationLoading ? (
          <DataValidationReportSkeletonCard key={`${section.key}-loading`} />
        ) : !section.report ? (
          <SectionNotice key={`${section.key}-missing`} message={section.missingMessage} />
        ) : (
          <Card key={section.key}>
            <CardHeader>
              <DataValidationCardTitle
                title={section.report.script}
                description={section.report.description}
              />
            </CardHeader>
            <CardContent className="space-y-6">
              {section.tables.map((table) => (
                <DataValidationTable
                  key={table.metricName}
                  metricName={table.metricName}
                  regions={table.regions}
                  platforms={table.platforms}
                  regionMatrix={table.regionMatrix}
                />
              ))}
            </CardContent>
          </Card>
        ),
      )}
    </section>
  );
}
