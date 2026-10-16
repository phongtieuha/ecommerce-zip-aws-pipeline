import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckCircle2, Circle, Download, Eye, ListFilter, XCircle } from "lucide-react";
import { useShopIds } from "@/actions/shop-ids-api";
import type { ShopIdsByRegion } from "@/actions/shop-ids-api";
import { useShopIdsReport } from "@/actions/shop-ids-report-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { SectionNotice } from "@/components/dashboard/section-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PLATFORM_ORDER } from "@/utils/constants";
import { formatLastFetch } from "@/utils/format-last-fetch";
import { sortWithReferenceOrder } from "@/utils/sort-with-reference-order";

export interface ShopIdComparisonRow {
  readonly platform: string;
  readonly shopProductsCount: number | null;
  readonly productSkusCount: number | null;
  readonly mismatch: boolean;
}

interface ShopIdsReportSectionProps {
  readonly date: string;
}

type ShopIdsFilter = "all" | "matched" | "unmatched";

interface RegionShopIdListProps {
  readonly ids: ReadonlyArray<string>;
  readonly rowKeyPrefix: string;
}

function RegionShopIdList({ ids, rowKeyPrefix }: RegionShopIdListProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 33,
    overscan: 12,
    enabled: ids.length > 0,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className="rounded-md border border-muted">
      <div className="border-b border-muted bg-secondary/40 px-2 py-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Shop ID</p>
      </div>
      <div
        ref={viewportRef}
        className="max-h-72 overflow-y-auto"
        role="table"
        aria-label="Shop IDs list"
      >
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow) => {
            const id = ids[virtualRow.index];
            if (!id) {
              return null;
            }

            return (
              <div
                key={`${rowKeyPrefix}-${id}`}
                className="absolute left-0 w-full border-b border-muted px-2 py-2"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                role="row"
              >
                <p className="font-mono text-xs text-white" role="cell">
                  {id}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ShopIdsReportSection({ date }: ShopIdsReportSectionProps) {
  const [selectedRow, setSelectedRow] = useState<ShopIdComparisonRow | null>(null);
  const [filter, setFilter] = useState<ShopIdsFilter>("all");
  const {
    data: shopIdsReport,
    loading: shopIdsReportLoading,
    error: shopIdsReportError,
  } = useShopIdsReport(date);
  const {
    data: selectedShopIds,
    loading: selectedShopIdsLoading,
    error: selectedShopIdsError,
  } = useShopIds(date, {
    sections: ["shop-products", "product-skus"],
    platforms: selectedRow ? [selectedRow.platform] : [],
    enabled: Boolean(selectedRow),
  });

  function openDetails(row: ShopIdComparisonRow) {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFilter("all");
    setSelectedRow(row);
  }

  const formatCount = (value: number | null): string =>
    value === null ? "-" : value.toLocaleString();

  const updatedAt = shopIdsReport?.generatedAt ?? null;
  const rows = (() => {
    const shopProducts = shopIdsReport?.feature1?.["shop-products"] ?? {};
    const productSkus = shopIdsReport?.feature1?.["product-skus"] ?? {};
    const allPlatforms = [...new Set([...Object.keys(shopProducts), ...Object.keys(productSkus)])];
    const platforms = sortWithReferenceOrder(allPlatforms, PLATFORM_ORDER);

    return platforms.map((platform) => {
      const shopProductsCount = shopProducts[platform] ?? null;
      const productSkusCount = productSkus[platform] ?? null;
      return {
        platform,
        shopProductsCount,
        productSkusCount,
        mismatch: shopProductsCount !== productSkusCount,
      };
    });
  })();

  const selectedShopIdSections = ["shop-products", "product-skus"] as const;
  const productSkusIdsByRegion = selectedShopIds["product-skus"] ?? {};
  const shopProductsIdsByRegion = selectedShopIds["shop-products"] ?? {};

  const countShopIdsByRegion = (shopIdsByRegion: ShopIdsByRegion): number =>
    Object.values(shopIdsByRegion).reduce((sum, ids) => sum + ids.length, 0);

  const buildRegionShopKey = (region: string, shopId: string): string => `${region}||${shopId}`;

  const sectionPresenceCounts = selectedShopIdSections.reduce((acc, section) => {
    const idsByRegion = selectedShopIds[section] ?? {};
    for (const [region, ids] of Object.entries(idsByRegion)) {
      const uniqueIds = new Set(ids);
      uniqueIds.forEach((id) => {
        const regionShopKey = buildRegionShopKey(region, id);
        acc.set(regionShopKey, (acc.get(regionShopKey) ?? 0) + 1);
      });
    }
    return acc;
  }, new Map<string, number>());

  const requiredSectionCount = selectedShopIdSections.length;
  const isMatchedAcrossAllSections = (region: string, shopId: string) =>
    (sectionPresenceCounts.get(buildRegionShopKey(region, shopId)) ?? 0) === requiredSectionCount;

  const filterIdsByMode = (shopIdsByRegion: ShopIdsByRegion): ShopIdsByRegion => {
    const filteredEntries = Object.entries(shopIdsByRegion)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([region, ids]) => {
        if (filter === "matched") {
          return [region, ids.filter((id) => isMatchedAcrossAllSections(region, id))] as const;
        }

        if (filter === "unmatched") {
          return [region, ids.filter((id) => !isMatchedAcrossAllSections(region, id))] as const;
        }

        return [region, ids] as const;
      })
      .filter(([, ids]) => ids.length > 0);

    return Object.fromEntries(filteredEntries);
  };

  const filteredProductSkusIdsByRegion = filterIdsByMode(productSkusIdsByRegion);
  const filteredShopProductsIdsByRegion = filterIdsByMode(shopProductsIdsByRegion);
  const totalSelectedShopIds = selectedShopIdSections.reduce(
    (sum, section) => sum + countShopIdsByRegion(selectedShopIds[section] ?? {}),
    0,
  );
  const filteredTotalSelectedShopIds =
    countShopIdsByRegion(filteredProductSkusIdsByRegion) +
    countShopIdsByRegion(filteredShopProductsIdsByRegion);

  const exportShopIdsAsCsv = (sectionLabel: string, shopIdsByRegion: ShopIdsByRegion) => {
    const regionEntries = Object.entries(shopIdsByRegion).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    const rowsCsv = regionEntries
      .flatMap(([region, ids]) => ids.map((id) => `${region},${id}`))
      .join("\n");
    const csvContent = `region,shop_id\n${rowsCsv}`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedRow?.platform ?? "unknown-platform"}_${sectionLabel}_shop-ids_${filter}_${date}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderRegionGroups = (sectionLabel: string, shopIdsByRegion: ShopIdsByRegion) => {
    const regionEntries = Object.entries(shopIdsByRegion).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const totalCount = countShopIdsByRegion(shopIdsByRegion);

    return (
      <Card className="border-border bg-secondary/60">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              {sectionLabel} ({totalCount.toLocaleString()})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={totalCount === 0}
              onClick={() => exportShopIdsAsCsv(sectionLabel, shopIdsByRegion)}
            >
              <Download size={14} />
              Export as CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {regionEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shop IDs match the selected filter.</p>
          ) : (
            <Accordion type="multiple" className="w-full">
              {regionEntries.map(([region, ids]) => (
                <AccordionItem
                  key={`${sectionLabel}-${region}`}
                  value={`${sectionLabel}-${region}`}
                >
                  <AccordionTrigger className="py-3 text-xs uppercase tracking-wide text-foreground hover:text-foreground">
                    <span>
                      {region} ({ids.length.toLocaleString()})
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <RegionShopIdList ids={ids} rowKeyPrefix={`${sectionLabel}-${region}`} />
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold uppercase tracking-wider text-amber-600">
            Shop ID Report
          </h2>
          <Badge variant="outline" className="gap-2">
            <Circle className="h-2 w-2 fill-current" />
            {formatLastFetch(updatedAt)}
          </Badge>
        </div>
      </div>

      {shopIdsReportError ? (
        <SectionNotice
          message={`Failed to load Shop IDs report: ${shopIdsReportError}`}
          tone="destructive"
        />
      ) : shopIdsReportLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <SectionNotice message="Shop IDs report is not available for the selected date." />
      ) : (
        <>
          <Card className="border-border bg-secondary">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Unique Shop IDs
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  Shop-Products vs Product-SKUs
                </h3>
                <div className="overflow-x-auto rounded-md border border-muted">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-muted">
                        <TableHead className="min-w-36">PLATFORM</TableHead>
                        <TableHead className="min-w-36 text-right">SHOP-PRODUCTS</TableHead>
                        <TableHead className="min-w-36 text-right">PRODUCT-SKUS</TableHead>
                        <TableHead className="min-w-32 text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow
                          key={row.platform}
                          className="cursor-pointer border-muted"
                          data-state={
                            selectedRow?.platform === row.platform ? "selected" : undefined
                          }
                          onClick={() => openDetails(row)}
                        >
                          <TableCell className={`font-semibold `}>{row.platform}</TableCell>
                          <TableCell
                            className={`text-right font-mono text-xs tabular-nums ${row.mismatch ? "bg-red-300 text-red-900" : ""}`}
                          >
                            {formatCount(row.shopProductsCount)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-xs tabular-nums ${row.mismatch ? "bg-red-300 text-red-900" : ""}`}
                          >
                            {formatCount(row.productSkusCount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => openDetails(row)}
                            >
                              <Eye size={14} />
                              View details
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>

          <Drawer
            direction="right"
            dismissible={true}
            open={Boolean(selectedRow)}
            onOpenChange={(open) => {
              if (!open) {
                setSelectedRow(null);
              }
            }}
          >
            <DrawerContent hideHandle>
              <DrawerHeader>
                <DrawerTitle>Unique Shop IDs</DrawerTitle>
                <DrawerDescription>Comparison details for the selected platform.</DrawerDescription>
              </DrawerHeader>
              <div
                className="flex-1 select-text overflow-y-auto px-4 py-2 text-sm text-white"
                data-vaul-no-drag
              >
                <div className="space-y-2">
                  <p>
                    <span className="font-semibold">Platform:</span> {selectedRow?.platform ?? "-"}
                  </p>
                  <p>
                    <span className="font-semibold">Status:</span>{" "}
                    {selectedRow?.mismatch ? "Mismatch" : "Match"}
                  </p>

                  {selectedShopIdsError ? (
                    <SectionNotice
                      message={`Failed to load Shop Ids: ${selectedShopIdsError}`}
                      tone="destructive"
                    />
                  ) : selectedShopIdsLoading ? (
                    <Skeleton className="h-28 w-full" />
                  ) : (
                    <>
                      <ButtonGroup aria-label="Filter shop ID rows" className="mb-2">
                        <Button
                          variant={filter === "all" ? "default" : "outline"}
                          size="sm"
                          className="gap-1.5"
                          onClick={() => setFilter("all")}
                        >
                          <ListFilter size={14} />
                          All
                        </Button>
                        <Button
                          variant={filter === "matched" ? "default" : "outline"}
                          size="sm"
                          className="gap-1.5"
                          onClick={() => setFilter("matched")}
                        >
                          <CheckCircle2 size={14} />
                          Matched
                        </Button>
                        <Button
                          variant={filter === "unmatched" ? "default" : "outline"}
                          size="sm"
                          className="gap-1.5"
                          onClick={() => setFilter("unmatched")}
                        >
                          <XCircle size={14} />
                          Unmatched
                        </Button>
                      </ButtonGroup>
                      <p className="text-xs text-muted-foreground">
                        Matched and unmatched compare the combination of region and shop ID.
                      </p>
                      <div className="grid gap-4 lg:grid-cols-2" data-vaul-no-drag>
                        {renderRegionGroups("shop-products", filteredShopProductsIdsByRegion)}
                        {renderRegionGroups("product-skus", filteredProductSkusIdsByRegion)}
                      </div>
                      <p>
                        <span className="font-semibold">
                          Unique 'Region x Shop ID' combinations:
                        </span>{" "}
                        {filteredTotalSelectedShopIds.toLocaleString()}/
                        {totalSelectedShopIds.toLocaleString()}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </DrawerContent>
          </Drawer>
        </>
      )}
    </section>
  );
}
