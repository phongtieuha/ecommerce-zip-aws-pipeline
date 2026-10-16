import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface DataValidationTableProps {
  readonly metricName: string;
  readonly regions: ReadonlyArray<string>;
  readonly platforms: ReadonlyArray<string>;
  readonly regionMatrix: Readonly<
    Record<string, Record<string, string | Readonly<Record<string, string>>>>
  >;
}

function isPositiveMetricValue(rawValue: string): boolean {
  const match = rawValue.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return false;
  }

  return Number(match[0]) > 0;
}

function hasPositiveValidationValue(value: string | Readonly<Record<string, string>>): boolean {
  if (typeof value === "string") {
    return isPositiveMetricValue(value);
  }

  return Object.values(value).some((metricValue) => isPositiveMetricValue(metricValue));
}

function formatValidationCell(value: string | Readonly<Record<string, string>>): string {
  if (typeof value === "string") {
    return value;
  }

  return Object.entries(value)
    .map(([key, metricValue]) => `${key}: ${metricValue}`)
    .join("\n");
}

export function DataValidationTable({
  metricName,
  regions,
  platforms,
  regionMatrix,
}: DataValidationTableProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">{metricName}</h3>
      <div className="overflow-x-auto rounded-md border border-muted">
        <Table>
          <TableHeader>
            <TableRow className="border-muted">
              <TableHead className="min-w-20">REGION</TableHead>
              {platforms.map((platform) => (
                <TableHead key={`${metricName}-${platform}`} className="min-w-36">
                  {platform}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {regions.map((region) => (
              <TableRow key={`${metricName}-${region}`} className="border-muted">
                <TableCell className="font-semibold">{region}</TableCell>
                {platforms.map((platform) => {
                  const cellValue = regionMatrix[region]?.[platform] ?? "-";
                  const highlightCell = hasPositiveValidationValue(cellValue);

                  return (
                    <TableCell
                      key={`${metricName}-${region}-${platform}`}
                      className={`align-top whitespace-pre-wrap font-mono text-xs ${
                        highlightCell ? "bg-red-300 text-red-900" : ""
                      }`}
                    >
                      {formatValidationCell(cellValue)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
