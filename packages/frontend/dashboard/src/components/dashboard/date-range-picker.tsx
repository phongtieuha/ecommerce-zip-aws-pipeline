"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { type DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CardFooter } from "@/components/ui/card";

type DateRangePickerProps = {
  value?: DateRange;
  onChange: (value: DateRange | undefined) => void;
  className?: string;
  maxRangeDays?: number;
};

const DATE_RANGE_PRESETS = [7, 14, 30] as const;

export function DateRangePicker({
  value,
  onChange,
  className,
  maxRangeDays,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState<DateRange | undefined>(value);
  const today = React.useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);

  React.useEffect(() => {
    if (!open) {
      setDraftValue(value);
    }
  }, [value, open]);

  const availablePresets = DATE_RANGE_PRESETS.filter(
    (days) => maxRangeDays === undefined || days <= maxRangeDays,
  );

  function getPresetRange(days: number): DateRange {
    const end = new Date();
    end.setHours(0, 0, 0, 0);

    const start = new Date(end);
    start.setDate(end.getDate() - days + 1);

    return {
      from: start,
      to: end,
    };
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setDraftValue(value);
    }
  }

  function handleApply() {
    onChange(draftValue);
    setOpen(false);
  }

  function handleCancel() {
    setDraftValue(value);
    setOpen(false);
  }

  return (
    <div className={cn("w-fit", className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            id="date-picker-range"
            className={cn(!value && "text-muted-foreground")}
          >
            <CalendarIcon size={18} />
            <div className="flex items-center justify-left flex-1 space-x-3">
              {value?.from ? (
                value.to ? (
                  <>
                    <span>{format(value.from, "dd/MM/yyyy")}</span>
                    <span>-</span>
                    <span>{format(value.to, "dd/MM/yyyy")}</span>
                  </>
                ) : (
                  <span>{format(value.from, "dd/MM/yyyy")}</span>
                )
              ) : (
                <span>Pick a date</span>
              )}
            </div>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto" align="start">
          <div>
            <Calendar
              mode="range"
              defaultMonth={value?.from}
              selected={draftValue}
              onSelect={setDraftValue}
              disabled={{ after: today }}
              max={maxRangeDays}
              numberOfMonths={1}
            />
          </div>
          <CardFooter className="flex flex-wrap gap-2 border-t border-accent pb-3">
            {availablePresets.map((days) => (
              <Button
                key={days}
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setDraftValue(getPresetRange(days))}
              >
                {`Last ${days} days`}
              </Button>
            ))}
          </CardFooter>
          <CardFooter className="flex gap-2 justify-end border-t border-accent">
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="outline" onClick={handleApply}>
              Apply
            </Button>
          </CardFooter>
        </PopoverContent>
      </Popover>
    </div>
  );
}
