import { createContext, useContext, useState, type ReactNode } from "react";

interface DashboardContextValue {
  readonly date: string;
  readonly setDate: (date: string) => void;
  readonly lastApiCallAt: string | null;
  readonly setLastApiCallAt: (value: string | null) => void;
  readonly refetchEveryMinutes: number;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);
const REFETCH_EVERY_MINUTES = 30;

function getYesterday(): string {
  return new Date(Date.now() - 86400000).toISOString().split("T")[0]!;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [date, setDate] = useState(getYesterday);
  const [lastApiCallAt, setLastApiCallAt] = useState<string | null>(null);

  return (
    <DashboardContext.Provider
      value={{
        date,
        setDate,
        lastApiCallAt,
        setLastApiCallAt,
        refetchEveryMinutes: REFETCH_EVERY_MINUTES,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}
