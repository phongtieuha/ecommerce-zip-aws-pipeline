import type { VendorMapping } from "@filepipeline/shared";

export interface RowToDedup {
  rowNumber: number;
  data: Record<string, unknown>;
}

/**
 * Deduplicate rows based on partition fields and a unique key.
 * Groups rows by partitionBy fields, then within each partition,
 * keeps only the first or last occurrence of each unique key value.
 *
 * @param rows The rows to deduplicate
 * @param mapping The vendor mapping containing rowDeduplication config
 * @returns Deduplicated rows with updated row numbers; logs dedup stats
 */
export function deduplicateRows(rows: RowToDedup[], mapping: VendorMapping): RowToDedup[] {
  const config = mapping.rowDeduplication;
  if (!config) {
    return rows;
  }

  const { partitionBy, key, keep } = config;

  // Group rows by partition
  interface PartitionKey {
    [field: string]: unknown;
  }
  const partitionMap = new Map<string, RowToDedup[]>();

  for (const row of rows) {
    // Build partition key from specified fields
    const partitionKey: PartitionKey = {};
    for (const field of partitionBy) {
      partitionKey[field] = row.data[field];
    }
    const partitionKeyStr = JSON.stringify(partitionKey);

    if (!partitionMap.has(partitionKeyStr)) {
      partitionMap.set(partitionKeyStr, []);
    }
    partitionMap.get(partitionKeyStr)!.push(row);
  }

  // Deduplicate within each partition and recompute rankings
  const dedupedRows: RowToDedup[] = [];
  let totalDupsRemoved = 0;
  const stats: PartitionStat[] = [];
  let globalRowNumber = 0;

  for (const [partitionKeyStr, partitionRows] of partitionMap.entries()) {
    const partitionKey = JSON.parse(partitionKeyStr) as PartitionKey;

    // Track seen keys to identify duplicates
    const seenKeys = new Map<unknown, RowToDedup>();
    const rowsInPartition: RowToDedup[] = [];

    const iterableRows = keep === "last" ? [...partitionRows].reverse() : partitionRows;

    for (const row of iterableRows) {
      const keyValue = row.data[key];

      if (!seenKeys.has(keyValue)) {
        seenKeys.set(keyValue, row);
        rowsInPartition.push(row);
      }
    }

    // Restore original order if keeping last
    if (keep === "last") {
      rowsInPartition.reverse();
    }

    // Update global row numbers as rows pass through dedup
    for (const row of rowsInPartition) {
      globalRowNumber++;
      row.rowNumber = globalRowNumber;
    }

    const dupsInPartition = partitionRows.length - rowsInPartition.length;
    totalDupsRemoved += dupsInPartition;

    stats.push({
      partition: partitionKey,
      before: partitionRows.length,
      after: rowsInPartition.length,
      duplicatesRemoved: dupsInPartition,
    });

    dedupedRows.push(...rowsInPartition);
  }

  // Log dedup stats (summary line is logged by the caller right after this returns)
  if (totalDupsRemoved > 0) {
    const topPartitions = stats
      .sort((a, b) => b.duplicatesRemoved - a.duplicatesRemoved)
      .slice(0, 5);
    for (const stat of topPartitions) {
      console.log(
        `  Partition ${JSON.stringify(stat.partition)}: ${stat.before} → ${stat.after} rows (${stat.duplicatesRemoved} dup(s))`,
      );
    }
  }

  return dedupedRows;
}

interface PartitionStat {
  partition: Record<string, unknown>;
  before: number;
  after: number;
  duplicatesRemoved: number;
}
