import CountUp from "react-countup";
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type BreakdownItem = {
  label: string;
  labelTitle?: string;
  value: number;
  tooltipContent?: ReactNode;
  statusIcon?: ReactNode;
  hideValue?: boolean;
};

type BreakdownCardProps = {
  title: string;
  rows: BreakdownItem[];
};

const DOT_COLOR_CLASSES = [
  "bg-sky-300",
  "bg-cyan-300",
  "bg-rose-200",
  "bg-indigo-300",
  "bg-blue-300",
  "bg-violet-300",
  "bg-neutral-100",
  "bg-slate-300",
  "bg-zinc-300",
  "bg-emerald-400",
  "bg-amber-300",
  "bg-fuchsia-300",
] as const;

export function BreakdownCard({ title, rows }: BreakdownCardProps) {
  return (
    <Card className="border-border bg-secondary">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-12 gap-y-2 md:grid-cols-2">
        {rows.map((row, index) => {
          const rowContent = (
            <div className="grid grid-cols-6 items-center gap-x-2 rounded-md px-2.5">
              <span
                className={`col-span-1 h-2.5 w-2.5 rounded-full ${DOT_COLOR_CLASSES[index % DOT_COLOR_CLASSES.length]}`}
              />
              <span
                className="col-span-3 min-w-0 truncate font-medium text-secondary-foreground"
                title={row.labelTitle ?? row.label}
              >
                {row.label}
              </span>
              {!row.hideValue && (
                <span className="col-span-1 text-right font-semibold tabular-nums text-foreground">
                  <CountUp end={row.value} duration={0.45} separator="," preserveValue useEasing />
                </span>
              )}
              <span
                className={`${row.hideValue ? "col-span-2" : "col-span-1"} flex items-center justify-end`}
              >
                {row.statusIcon ?? null}
              </span>
            </div>
          );

          if (!row.tooltipContent) {
            return <div key={row.label}>{rowContent}</div>;
          }

          return (
            <Tooltip key={row.label}>
              <TooltipTrigger asChild>
                <div className="cursor-help rounded-md transition-colors hover:cursor-pointer hover:bg-slate-800">
                  {rowContent}
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xl p-2">
                <div className="max-h-64 overflow-y-auto">{row.tooltipContent}</div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </CardContent>
    </Card>
  );
}
