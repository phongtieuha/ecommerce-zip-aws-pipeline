import * as React from "react";
import { X } from "lucide-react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";

type DrawerContextValue = {
  requestClose: () => void;
};

type DrawerSize = "sm" | "md" | "lg";

const DrawerContext = React.createContext<DrawerContextValue | null>(null);

function Drawer({ onOpenChange, ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  const contextValue = React.useMemo<DrawerContextValue>(
    () => ({
      requestClose: () => onOpenChange?.(false),
    }),
    [onOpenChange],
  );

  return (
    <DrawerContext.Provider value={contextValue}>
      <DrawerPrimitive.Root data-slot="drawer" onOpenChange={onOpenChange} {...props} />
    </DrawerContext.Provider>
  );
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  hideHandle = false,
  onOverlayClick,
  size = "md",
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  hideHandle?: boolean;
  onOverlayClick?: () => void;
  size?: DrawerSize;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onOverlayClick?.();
    }
  };

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay onClick={onOverlayClick} />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        onKeyDown={handleKeyDown}
        className={cn(
          "group/drawer-content fixed z-50 flex h-auto flex-col bg-background",
          "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=top]:rounded-b-lg data-[vaul-drawer-direction=top]:border-b",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:rounded-t-lg data-[vaul-drawer-direction=bottom]:border-t",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:border-l",
          "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:border-r",
          size === "sm" &&
            "data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:w-1/3 data-[vaul-drawer-direction=right]:sm:max-w-none data-[vaul-drawer-direction=left]:w-full data-[vaul-drawer-direction=left]:sm:w-1/3 data-[vaul-drawer-direction=left]:sm:max-w-none",
          size === "md" &&
            "data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:w-1/2 data-[vaul-drawer-direction=right]:sm:max-w-none data-[vaul-drawer-direction=left]:w-full data-[vaul-drawer-direction=left]:sm:w-1/2 data-[vaul-drawer-direction=left]:sm:max-w-none",
          size === "lg" &&
            "data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:w-2/3 data-[vaul-drawer-direction=right]:sm:max-w-none data-[vaul-drawer-direction=left]:w-full data-[vaul-drawer-direction=left]:sm:w-2/3 data-[vaul-drawer-direction=left]:sm:max-w-none",
          className,
        )}
        {...props}
      >
        {!hideHandle && (
          <div className="mx-auto mt-4 hidden h-2 w-24 shrink-0 rounded-full bg-muted group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
        )}
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  const drawerContext = React.useContext(DrawerContext);

  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "relative flex flex-col gap-0.5 p-4 pr-12 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-left",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        data-slot="drawer-header-close"
        aria-label="Close drawer"
        className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => drawerContext?.requestClose()}
      >
        <X className="h-4 w-4" />
      </button>
      {props.children}
    </div>
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
