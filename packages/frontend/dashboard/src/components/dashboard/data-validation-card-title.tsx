import { Info } from "lucide-react";
import { CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface DataValidationCardTitleProps {
  readonly title: string;
  readonly description?: string;
}

export function DataValidationCardTitle({ title, description }: DataValidationCardTitleProps) {
  return (
    <div className="flex items-center gap-2">
      <CardTitle>{title}</CardTitle>
      {description ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Show description for ${title}`}
            >
              <Info size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xl whitespace-pre-line text-sm">
            {description}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
