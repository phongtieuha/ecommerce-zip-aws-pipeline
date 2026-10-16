import * as React from "react";

import { cn } from "@/lib/utils";

const Field = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn("grid gap-1.5", className)} {...props} />;
  },
);

Field.displayName = "Field";

const FieldLabel = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn("text-sm font-medium text-muted-foreground", className)}
        {...props}
      />
    );
  },
);

FieldLabel.displayName = "FieldLabel";

const FieldDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  return <p ref={ref} className={cn("text-xs text-muted-foreground", className)} {...props} />;
});

FieldDescription.displayName = "FieldDescription";

export { Field, FieldDescription, FieldLabel };
