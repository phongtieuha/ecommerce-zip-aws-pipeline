import type { ReactNode } from "react";
import CountUp from "react-countup";

import { Card, CardContent } from "@/components/ui/card";

type MetricCardProps = {
  title: string;
  value: number | undefined;
  delta?: string;
  subtext?: string;
  valueTone?: "foreground" | "success" | "destructive";
  icon?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
};

export function MetricCard({
  title,
  value,
  delta,
  subtext,
  valueTone = "foreground",
  icon,
  action,
  children,
}: MetricCardProps) {
  const valueClass =
    valueTone === "success"
      ? "text-success"
      : valueTone === "destructive"
        ? "text-destructive"
        : "text-foreground";

  return (
    <Card className="border-border bg-card">
      <CardContent className="flex items-stretch gap-4 pt-6 pb-6">
        {icon && (
          <div className="flex shrink-0 items-center justify-center rounded-lg bg-primary/50 px-5 text-muted-foreground">
            {icon}
          </div>
        )}
        <div className="flex flex-1 items-center gap-4">
          <div className="flex-1">
            <p className="text-sm uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className={`mt-2 text-3xl font-bold tabular-nums ${valueClass}`}>
              {value === undefined ? (
                "—"
              ) : (
                <CountUp end={value} duration={0.45} separator="," preserveValue useEasing />
              )}
            </p>
            {delta ? <p className="mt-1 text-sm text-success-foreground">▲ {delta}</p> : null}
            {subtext ? <p className="mt-1 text-sm text-muted-foreground">{subtext}</p> : null}
            {children}
          </div>
          {action && <div className="flex shrink-0 items-center">{action}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
