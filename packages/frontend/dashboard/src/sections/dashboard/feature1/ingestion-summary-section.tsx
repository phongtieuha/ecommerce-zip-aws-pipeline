import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Eye,
  FileJson,
  FileX,
  OctagonX,
  Package,
} from "lucide-react";
import type { Feature1Ingestion } from "@/actions/metrics-api";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { BreakdownCard } from "@/components/dashboard/breakdown-card";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SectionNotice } from "@/components/dashboard/section-notice";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorExplanation } from "@/utils/error-map";
import { toCountryBreakdownItems, toPlatformBreakdownItems } from "@/utils/metrics-breakdown";

interface IngestionSummarySectionProps {
  readonly showMetricsError: boolean;
  readonly metricsError: string | null;
  readonly showMetricsMissing: boolean;
  readonly showSkeleton: boolean;
  readonly canRenderMetrics: boolean;
  readonly ingestion: Feature1Ingestion | undefined;
}

export function IngestionSummarySection({
  showMetricsError,
  metricsError,
  showMetricsMissing,
  showSkeleton,
  canRenderMetrics,
  ingestion,
}: IngestionSummarySectionProps) {
  const [zipDrawerOpen, setZipDrawerOpen] = useState(false);
  const [jsonDrawerOpen, setJsonDrawerOpen] = useState(false);

  const failedZipPathSet = useMemo(
    () => new Set((ingestion?.zipFilesFailedSources ?? []).map((source) => source.file)),
    [ingestion?.zipFilesFailedSources],
  );

  const zipShopRows = useMemo(
    () =>
      toPlatformBreakdownItems(ingestion?.zipFilesShopProductsByPlatform).map((row) => {
        const paths = ingestion?.zipFilesShopProductsPathsByPlatform?.[row.label] ?? [];
        const hasFailedZip = paths.some((path) => failedZipPathSet.has(path));
        const statusIcon = ["Tmall-supermarket"].includes(row.label) ? undefined : hasFailedZip ? (
          <AlertTriangle size={14} className="text-amber-500" />
        ) : row.value > 0 ? (
          <CheckCircle2 size={14} className="text-green-500" />
        ) : row.value <= 0 ? (
          <AlertCircle size={14} className="text-red-500" />
        ) : undefined;

        return {
          ...row,
          labelTitle: `${row.label}: ${row.value}`,
          statusIcon,
          hideValue: true,
          tooltipContent:
            paths.length > 0 ? (
              <div className="space-y-1">
                {paths.map((path) => (
                  <p key={`${row.label}-${path}`} className="font-mono text-xs break-all">
                    {path}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No paths for this platform.</p>
            ),
        };
      }),
    [
      failedZipPathSet,
      ingestion?.zipFilesShopProductsByPlatform,
      ingestion?.zipFilesShopProductsPathsByPlatform,
    ],
  );

  const zipPdpRows = useMemo(
    () =>
      toPlatformBreakdownItems(ingestion?.zipFilesPdpByPlatform).map((row) => {
        const paths = ingestion?.zipFilesPdpPathsByPlatform?.[row.label] ?? [];
        const hasFailedZip = paths.some((path) => failedZipPathSet.has(path));
        const statusIcon = hasFailedZip ? (
          <AlertTriangle size={14} className="text-amber-500" />
        ) : row.value > 0 ? (
          <CheckCircle2 size={14} className="text-green-500" />
        ) : row.value <= 0 ? (
          <AlertCircle size={14} className="text-red-500" />
        ) : undefined;

        return {
          ...row,
          labelTitle: `${row.label}: ${row.value}`,
          statusIcon,
          hideValue: true,
          tooltipContent:
            paths.length > 0 ? (
              <div className="space-y-1">
                {paths.map((path) => (
                  <p key={`${row.label}-${path}`} className="font-mono text-xs break-all">
                    {path}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No paths for this platform.</p>
            ),
        };
      }),
    [failedZipPathSet, ingestion?.zipFilesPdpByPlatform, ingestion?.zipFilesPdpPathsByPlatform],
  );

  const jsonByPlatformRows = useMemo(
    () => toPlatformBreakdownItems(ingestion?.jsonFilesByPlatform),
    [ingestion?.jsonFilesByPlatform],
  );
  const jsonByCountryRows = useMemo(
    () => toCountryBreakdownItems(ingestion?.jsonFilesByCountry),
    [ingestion?.jsonFilesByCountry],
  );
  const ingestionProductsByPlatformRows = useMemo(
    () => toPlatformBreakdownItems(ingestion?.uniqueProductsByPlatform),
    [ingestion?.uniqueProductsByPlatform],
  );
  const ingestionProductsByCountryRows = useMemo(
    () => toCountryBreakdownItems(ingestion?.uniqueProductsByCountry),
    [ingestion?.uniqueProductsByCountry],
  );

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold uppercase tracking-wider text-amber-600">
        Ingestion Summary
      </h2>

      {showMetricsError ? (
        <SectionNotice
          message={`Failed to load ingestion metrics: ${metricsError}`}
          tone="destructive"
        />
      ) : showMetricsMissing ? (
        <SectionNotice message="Ingestion metrics response is missing for the selected date." />
      ) : null}

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <Skeleton className="h-36 w-full" />
        ) : canRenderMetrics ? (
          <>
            <MetricCard
              title="ZIP Files Ingested (Total)"
              value={ingestion?.zipFilesTotal}
              icon={<Archive size={26} />}
            />
            <MetricCard
              title="ZIP Files Failed"
              value={ingestion?.zipFilesFailed}
              valueTone={ingestion?.zipFilesFailed ? "destructive" : "foreground"}
              icon={<OctagonX size={26} />}
              action={
                ingestion?.zipFilesFailed ? (
                  <Drawer
                    direction="right"
                    dismissible={false}
                    open={zipDrawerOpen}
                    onOpenChange={setZipDrawerOpen}
                  >
                    <DrawerTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Eye size={14} />
                        View details
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent hideHandle onOverlayClick={() => setZipDrawerOpen(false)}>
                      <DrawerHeader>
                        <DrawerTitle>ZIP Files Failed</DrawerTitle>
                        <DrawerDescription>
                          Details about ZIP file ingestion failures.
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!ingestion?.zipFilesFailedSources?.length ? (
                          <p className="text-sm text-muted-foreground">No failures recorded.</p>
                        ) : (
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-1/2 shrink-0">File</TableHead>
                                <TableHead className="w-1/2 shrink-0">Reason</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {ingestion.zipFilesFailedSources.map((src, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-xs break-all whitespace-normal text-white">
                                    {src.file}
                                  </TableCell>
                                  <TableCell className="text-amber-600">
                                    <p className="whitespace-normal">{src.reason}</p>
                                    {getErrorExplanation(src.reason) && (
                                      <p className="mt-1 text-xs text-muted-foreground whitespace-normal">
                                        {getErrorExplanation(src.reason)}
                                      </p>
                                    )}
                                    {src.diagnostic && (
                                      <div className="mt-3 text-xs space-y-2 border-l-2 border-amber-700 pl-2">
                                        {src.diagnostic.expectedPattern && (
                                          <div>
                                            <span className="font-semibold text-amber-500">
                                              Expected:
                                            </span>{" "}
                                            <span className="text-muted-foreground">
                                              {src.diagnostic.expectedPattern}
                                            </span>
                                          </div>
                                        )}
                                        <div className="space-y-1">
                                          <div>
                                            <span className="font-semibold text-amber-500">
                                              Files in ZIP:
                                            </span>{" "}
                                            <span className="text-muted-foreground">
                                              {src.diagnostic.totalFilesInZip}
                                            </span>
                                          </div>
                                          <div>
                                            <span className="font-semibold text-amber-500">
                                              JSON files:
                                            </span>{" "}
                                            <span className="text-muted-foreground">
                                              {src.diagnostic.jsonFilesFound} found,{" "}
                                              {src.diagnostic.filesMatched} matched
                                            </span>
                                          </div>
                                        </div>
                                        {src.diagnostic.topLevelFolders &&
                                          src.diagnostic.topLevelFolders.length > 0 && (
                                            <div>
                                              <span className="font-semibold text-amber-500">
                                                Folders:
                                              </span>{" "}
                                              <span className="text-muted-foreground">
                                                {src.diagnostic.topLevelFolders.join(", ")}
                                              </span>
                                            </div>
                                          )}
                                        {src.diagnostic.fileExtensionsFound &&
                                          src.diagnostic.fileExtensionsFound.length > 0 && (
                                            <div>
                                              <span className="font-semibold text-amber-500">
                                                Extensions:
                                              </span>{" "}
                                              <span className="text-muted-foreground">
                                                {src.diagnostic.fileExtensionsFound.join(", ")}
                                              </span>
                                            </div>
                                          )}
                                        {src.diagnostic.sampleFilePaths &&
                                          src.diagnostic.sampleFilePaths.length > 0 && (
                                            <div>
                                              <span className="font-semibold text-amber-500">
                                                Sample files:
                                              </span>
                                              <div className="text-muted-foreground space-y-1 mt-1">
                                                {src.diagnostic.sampleFilePaths.map((path, j) => (
                                                  <div key={j} className="ml-2">
                                                    • {path}
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                      </div>
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </div>
                    </DrawerContent>
                  </Drawer>
                ) : undefined
              }
            />
          </>
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {showSkeleton ? (
          <Skeleton className="h-64 w-full" />
        ) : canRenderMetrics ? (
          <>
            <BreakdownCard title="Shop-Products ZIP Files by Platform" rows={zipShopRows} />
            <BreakdownCard title="Product-SKUS ZIP Files by Platform" rows={zipPdpRows} />
          </>
        ) : null}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <Skeleton className="h-36 w-full" />
        ) : canRenderMetrics ? (
          <>
            <MetricCard
              title="JSON/HTML Files Ingested (Total)"
              value={ingestion?.jsonFilesTotal}
              icon={<FileJson size={26} />}
            />
            <MetricCard
              title="JSON/HTML Files Failed"
              value={ingestion?.jsonFilesFailed}
              valueTone={ingestion?.jsonFilesFailed ? "destructive" : "foreground"}
              icon={<FileX size={26} />}
              action={
                ingestion?.jsonFilesFailed ? (
                  <Drawer
                    direction="right"
                    dismissible={false}
                    open={jsonDrawerOpen}
                    onOpenChange={setJsonDrawerOpen}
                  >
                    <DrawerTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Eye size={14} />
                        View details
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent hideHandle onOverlayClick={() => setJsonDrawerOpen(false)}>
                      <DrawerHeader>
                        <DrawerTitle>JSON/HTML Files Failed</DrawerTitle>
                        <DrawerDescription>
                          Details about JSON/HTML file ingestion failures.
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!ingestion?.jsonFilesFailedSources?.length ? (
                          <p className="text-sm text-muted-foreground">No failures recorded.</p>
                        ) : (
                          <Accordion type="multiple" className="w-full">
                            {ingestion.jsonFilesFailedSources.map((group, groupIndex) => (
                              <AccordionItem
                                value={`${group.zipPath}-${groupIndex}`}
                                key={`${group.zipPath}-${groupIndex}`}
                              >
                                <AccordionTrigger className="font-mono text-xs break-all whitespace-normal">
                                  {group.zipPath}
                                </AccordionTrigger>
                                <AccordionContent>
                                  <Table className="table-fixed">
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className="w-1/2 shrink-0">
                                          JSON/HTML File
                                        </TableHead>
                                        <TableHead className="w-1/2 shrink-0">Reason</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {group.jsonPaths.map((src, srcIndex) => (
                                        <TableRow key={`${group.zipPath}-${src.file}-${srcIndex}`}>
                                          <TableCell className="font-mono text-xs break-all whitespace-normal text-white align-top">
                                            {src.file}
                                          </TableCell>
                                          <TableCell className="text-amber-600 align-top">
                                            <p className="whitespace-normal">{src.reason}</p>
                                            {getErrorExplanation(src.reason) && (
                                              <p className="mt-1 text-xs text-muted-foreground whitespace-normal">
                                                {getErrorExplanation(src.reason)}
                                              </p>
                                            )}
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </AccordionContent>
                              </AccordionItem>
                            ))}
                          </Accordion>
                        )}
                      </div>
                    </DrawerContent>
                  </Drawer>
                ) : undefined
              }
            />
          </>
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <BreakdownCard title="JSON/HTML Files by Platform" rows={jsonByPlatformRows} />
            <BreakdownCard title="JSON/HTML Files by Country" rows={jsonByCountryRows} />
          </>
        ) : null}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <Skeleton className="h-36 w-full" />
        ) : canRenderMetrics ? (
          <MetricCard
            title="Unique Products Ingested (Total)"
            value={ingestion?.uniqueProductsTotal}
            icon={<Package size={26} />}
          />
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <BreakdownCard
              title="Unique Products by Platform"
              rows={ingestionProductsByPlatformRows}
            />
            <BreakdownCard
              title="Unique Products by Country"
              rows={ingestionProductsByCountryRows}
            />
          </>
        ) : null}
      </section>
    </section>
  );
}
