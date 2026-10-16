import { useMemo, useState } from "react";
import { Eye, FileX, OctagonX, Package } from "lucide-react";
import type { CategoryProcessing } from "@/actions/metrics-api";
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
import { toCountryBreakdownItems, toPlatformBreakdownItems } from "@/utils/metrics-breakdown";

interface ProcessingSummarySectionProps {
  readonly showMetricsError: boolean;
  readonly metricsError: string | null;
  readonly showMetricsMissing: boolean;
  readonly showSkeleton: boolean;
  readonly canRenderMetrics: boolean;
  readonly processing: CategoryProcessing | undefined;
}

export function ProcessingSummarySection({
  showMetricsError,
  metricsError,
  showMetricsMissing,
  showSkeleton,
  canRenderMetrics,
  processing,
}: ProcessingSummarySectionProps) {
  const [processingDrawerOpen, setProcessingDrawerOpen] = useState(false);
  const [failedProcessingDrawerOpen, setFailedProcessingDrawerOpen] = useState(false);
  const [mergeDroppedDrawerOpen, setMergeDroppedDrawerOpen] = useState(false);

  const processingProductsByPlatformRows = useMemo(
    () => toPlatformBreakdownItems(processing?.uniqueProductsByPlatform),
    [processing?.uniqueProductsByPlatform],
  );
  const processingProductsByCountryRows = useMemo(
    () => toCountryBreakdownItems(processing?.uniqueProductsByCountry),
    [processing?.uniqueProductsByCountry],
  );

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold uppercase tracking-wider text-amber-600">
        Processing Summary
      </h2>

      {showMetricsError ? (
        <SectionNotice
          message={`Failed to load processing metrics: ${metricsError}`}
          tone="destructive"
        />
      ) : showMetricsMissing ? (
        <SectionNotice message="Processing metrics response is missing for the selected date." />
      ) : null}

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <Skeleton className="h-36 w-full" />
        ) : canRenderMetrics ? (
          <>
            <MetricCard
              title="Unique Products in Output (Total)"
              value={processing?.uniqueProductsTotal}
              icon={<Package size={26} />}
            />
            <MetricCard
              title="Products Failed Processing"
              value={processing?.uniqueProductsFailedProcessing}
              valueTone={processing?.uniqueProductsFailedProcessing ? "destructive" : "foreground"}
              icon={<OctagonX size={26} />}
              action={
                processing?.uniqueProductsFailedProcessing ? (
                  <Drawer
                    direction="right"
                    dismissible={false}
                    open={failedProcessingDrawerOpen}
                    onOpenChange={setFailedProcessingDrawerOpen}
                  >
                    <DrawerTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Eye size={14} />
                        View details
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent
                      hideHandle
                      onOverlayClick={() => setFailedProcessingDrawerOpen(false)}
                    >
                      <DrawerHeader>
                        <DrawerTitle>Products Failed Processing</DrawerTitle>
                        <DrawerDescription>
                          Source files where products failed due to technical processing
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!processing?.uniqueProductsFailedProcessingSources?.length ? (
                          <p className="text-sm text-muted-foreground">
                            No failed processing recorded.
                          </p>
                        ) : (
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-2/5 shrink-0">File</TableHead>
                                <TableHead className="w-1/5 shrink-0 text-right">
                                  Failed Products
                                </TableHead>
                                <TableHead className="w-2/5 shrink-0">Reason</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {processing.uniqueProductsFailedProcessingSources.map((src, i) => (
                                <TableRow key={`${src.file}-${i}`}>
                                  <TableCell className="font-mono text-xs break-all whitespace-normal text-white align-top">
                                    {src.file}
                                  </TableCell>
                                  <TableCell className="font-mono text-right align-top text-amber-600">
                                    {src.failedCount.toLocaleString("en-US")}
                                  </TableCell>
                                  <TableCell className="text-amber-600 align-top">
                                    <p className="whitespace-normal">{src.reason}</p>
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

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <MetricCard
              title="Products Failed Validation"
              value={processing?.uniqueProductsFailed}
              valueTone={processing?.uniqueProductsFailed ? "destructive" : "foreground"}
              icon={<OctagonX size={26} />}
              action={
                processing?.uniqueProductsFailed ? (
                  <Drawer
                    direction="right"
                    dismissible={false}
                    open={processingDrawerOpen}
                    onOpenChange={setProcessingDrawerOpen}
                  >
                    <DrawerTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Eye size={14} />
                        View details
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent hideHandle onOverlayClick={() => setProcessingDrawerOpen(false)}>
                      <DrawerHeader>
                        <DrawerTitle>Products Failed Validation</DrawerTitle>
                        <DrawerDescription>
                          Source files where products failed validation.
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!processing?.uniqueProductsFailedSources?.length ? (
                          <p className="text-sm text-muted-foreground">
                            No failed validation recorded.
                          </p>
                        ) : (
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-2/5 shrink-0">File</TableHead>
                                <TableHead className="w-1/5 shrink-0 text-right">
                                  Failed Products
                                </TableHead>
                                <TableHead className="w-2/5 shrink-0">Reason</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {processing.uniqueProductsFailedSources.map((src, i) => (
                                <TableRow key={`${src.file}-${i}`}>
                                  <TableCell className="font-mono text-xs break-all whitespace-normal text-white align-top">
                                    {src.file}
                                  </TableCell>
                                  <TableCell className="font-mono text-right align-top text-amber-600">
                                    {src.failedCount.toLocaleString("en-US")}
                                  </TableCell>
                                  <TableCell className="text-amber-600 align-top">
                                    <p className="whitespace-normal">{src.reason}</p>
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
            <MetricCard
              title="Rows Merged Into Existing IDs"
              value={processing?.uniqueProductsDroppedAfterMerging}
              icon={<FileX size={26} />}
              action={
                processing?.uniqueProductsDroppedAfterMerging ? (
                  <Drawer
                    direction="right"
                    dismissible={false}
                    open={mergeDroppedDrawerOpen}
                    onOpenChange={setMergeDroppedDrawerOpen}
                  >
                    <DrawerTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Eye size={14} />
                        View details
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent
                      hideHandle
                      onOverlayClick={() => setMergeDroppedDrawerOpen(false)}
                    >
                      <DrawerHeader>
                        <DrawerTitle>Rows Merged Into Existing IDs</DrawerTitle>
                        <DrawerDescription>
                          Source groups where rows were merged into existing product or sku IDs
                          during consolidation.
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!processing?.uniqueProductsDroppedAfterMergingSources?.length ? (
                          <p className="text-sm text-muted-foreground">
                            No merged-row sources recorded.
                          </p>
                        ) : (
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-2/5 shrink-0">Source</TableHead>
                                <TableHead className="w-1/5 shrink-0 text-right">
                                  Merged Rows
                                </TableHead>
                                <TableHead className="w-2/5 shrink-0">Reason</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {processing.uniqueProductsDroppedAfterMergingSources.map((src, i) => (
                                <TableRow key={`${src.file}-${i}`}>
                                  <TableCell className="font-mono text-xs break-all whitespace-normal text-white align-top">
                                    {src.file}
                                  </TableCell>
                                  <TableCell className="font-mono text-right align-top text-amber-600">
                                    {src.failedCount.toLocaleString("en-US")}
                                  </TableCell>
                                  <TableCell className="text-amber-600 align-top">
                                    <p className="whitespace-normal">{src.reason}</p>
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
          <>
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <BreakdownCard
              title="Unique Products by Platform"
              rows={processingProductsByPlatformRows}
            />
            <BreakdownCard
              title="Unique Products by Country"
              rows={processingProductsByCountryRows}
            />
          </>
        ) : null}
      </section>
    </section>
  );
}
