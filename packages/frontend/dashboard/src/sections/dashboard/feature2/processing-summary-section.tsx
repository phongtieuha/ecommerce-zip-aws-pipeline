import { useMemo, useState } from "react";
import { Eye, OctagonX, Package } from "lucide-react";
import type { CategoryProcessing } from "@/actions/metrics-api";
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
          <MetricCard
            title="Unique Records in Output (Total)"
            value={processing?.uniqueProductsTotal}
            icon={<Package size={26} />}
          />
        ) : null}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <MetricCard
              title="Records Failed"
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
                    <DrawerContent
                      hideHandle
                      onOverlayClick={() => setProcessingDrawerOpen(false)}
                      size="lg"
                    >
                      <DrawerHeader>
                        <DrawerTitle>Records Failed in Processing</DrawerTitle>
                        <DrawerDescription>
                          Source files where records were not included in output.
                        </DrawerDescription>
                      </DrawerHeader>
                      <div
                        className="flex-1 overflow-y-auto px-4 py-2 select-text"
                        data-vaul-no-drag
                      >
                        {!processing?.uniqueProductsFailedSources?.length ? (
                          <p className="text-sm text-muted-foreground">
                            No processing drops recorded.
                          </p>
                        ) : (
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-2/5 shrink-0">File</TableHead>
                                <TableHead className="w-1/5 shrink-0 text-right">
                                  Failed Records
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
                                    {src.duplicateKeyBreakdown &&
                                    src.duplicateKeyBreakdown.length > 0 ? (
                                      <Accordion type="single" collapsible className="w-full">
                                        <AccordionItem value={`duplicate-reason-${i}`}>
                                          <AccordionTrigger className="py-0 text-left text-amber-600 hover:no-underline whitespace-break-spaces">
                                            {src.reason}
                                          </AccordionTrigger>
                                          <AccordionContent>
                                            <div className="mt-1 text-xs text-muted-foreground space-y-1">
                                              {src.duplicateKeyBreakdown.map((entry, j) => (
                                                <div key={j} className="font-mono">
                                                  {[
                                                    entry.product_id,
                                                    entry.region,
                                                    entry.search_keyword,
                                                    entry.recorded_on,
                                                  ]
                                                    .filter(Boolean)
                                                    .join(" · ")}{" "}
                                                  <span className="text-amber-500">
                                                    ×{entry.failedCount}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          </AccordionContent>
                                        </AccordionItem>
                                      </Accordion>
                                    ) : (
                                      <p className="whitespace-normal">{src.reason}</p>
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
            <MetricCard
              title="Records Failed Processing"
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
                        <DrawerTitle>Records Failed Processing</DrawerTitle>
                        <DrawerDescription>
                          Source files where records failed due to technical processing
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
                                  Failed Records
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

      <section className="grid gap-6 lg:grid-cols-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : canRenderMetrics ? (
          <>
            <BreakdownCard
              title="Unique Records by Platform"
              rows={processingProductsByPlatformRows}
            />
            <BreakdownCard
              title="Unique Records by Country"
              rows={processingProductsByCountryRows}
            />
          </>
        ) : null}
      </section>
    </section>
  );
}
