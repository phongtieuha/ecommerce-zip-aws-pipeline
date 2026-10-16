import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function DataValidationReportSkeletonCard() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-72" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-56 w-full" />
      </CardContent>
    </Card>
  );
}
