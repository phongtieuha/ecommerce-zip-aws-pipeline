import {
  Link,
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { CalendarDays, Circle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Field, FieldLabel } from "./components/ui/field";
import { Feature1Page } from "@/pages/feature1-page";
import { Feature2Page } from "@/pages/feature2-page";
import { LoginPage } from "@/pages/login";
import { DashboardProvider, useDashboard } from "./lib/dashboard-context";
import { AuthProvider, useAuth } from "./lib/auth";
import { formatLastFetch } from "./utils/format-last-fetch";

const rootRoute = createRootRoute({
  component: () => (
    <AuthProvider>
      <DashboardProvider>
        <Outlet />
      </DashboardProvider>
    </AuthProvider>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const protectedLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected-layout",
  component: DashboardShell,
});

const feature1Route = createRoute({
  getParentRoute: () => protectedLayoutRoute,
  path: "/",
  component: Feature1Page,
});

const feature1AliasRoute = createRoute({
  getParentRoute: () => protectedLayoutRoute,
  path: "/feature-1",
  component: Feature1Page,
});

const feature2Route = createRoute({
  getParentRoute: () => protectedLayoutRoute,
  path: "/feature-2",
  component: Feature2Page,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  protectedLayoutRoute.addChildren([feature1Route, feature1AliasRoute, feature2Route]),
]);

const routerBasepath = normalizeRouterBasePath(import.meta.env.VITE_BASE_PATH);

export const router = createRouter({
  routeTree,
  basepath: routerBasepath,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    readonly router: typeof router;
  }
}

function DashboardShell() {
  const { isAuthenticated, isLoading, userEmail, logout } = useAuth();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const { date, setDate, lastApiCallAt, refetchEveryMinutes } = useDashboard();
  const isTodaySelected = isDateToday(date);

  if (isLoading) {
    return (
      <main className="min-h-screen text-foreground">
        <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6 py-6">
          <p className="text-sm text-muted-foreground">Checking session...</p>
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const tabValue = pathname.endsWith("/feature-2") ? "feature-2" : "feature-1";

  return (
    <main className="min-h-screen text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col gap-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <span className="text-2xl font-bold">FilePipeline</span>
            <div className="flex items-center gap-3">
              {userEmail ? (
                <span className="text-xs text-muted-foreground">{userEmail}</span>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={logout}>
                Sign Out
              </Button>
            </div>
          </div>
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold">ETL Monitoring</h1>
              {isTodaySelected ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="gap-2">
                      <Circle className="h-2 w-2 fill-current" />
                      {formatLastFetch(lastApiCallAt)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{`Refetch every ${refetchEveryMinutes} minutes`}</TooltipContent>
                </Tooltip>
              ) : (
                <Badge variant="outline" className="gap-2">
                  <Circle className="h-2 w-2 fill-current" />
                  {formatLastFetch(lastApiCallAt)}
                </Badge>
              )}
            </div>

            <Field className="min-w-52">
              <FieldLabel htmlFor="dashboard-date-filter">Ingestion and processing for</FieldLabel>
              <div className="relative">
                <Input
                  id="dashboard-date-filter"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label="Filter date"
                  className="w-full scheme-dark bg-card"
                />
                <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-foreground" />
              </div>
            </Field>
          </div>

          <Tabs value={tabValue}>
            <TabsList>
              <TabsTrigger value="feature-1" asChild>
                <Link to="/feature-1" className="group flex flex-row items-center gap-2">
                  <span className="text-muted-foreground group-data-[state=active]:text-primary-foreground">
                    Feature 1
                  </span>
                  <span className="text-xs text-gray-400">shop-products/product-skus</span>
                </Link>
              </TabsTrigger>
              <TabsTrigger value="feature-2" asChild>
                <Link to="/feature-2" className="group flex flex-row items-center gap-2">
                  <span className="text-muted-foreground group-data-[state=active]:text-primary-foreground">
                    Feature 2
                  </span>
                  <span className="text-xs text-gray-400">keyword-products</span>
                </Link>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </header>

        <Outlet />

        <footer className="border-t border-border pt-6 mt-6">
          <p className="text-center text-sm text-muted-foreground">
            Copyright {new Date().getFullYear()} FilePipeline. All Rights Reserved.
          </p>
        </footer>
      </div>
    </main>
  );
}

function normalizeRouterBasePath(basePath: string | undefined) {
  if (!basePath || basePath === "/") {
    return "/";
  }

  const withoutTrailingSlash = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return withoutTrailingSlash.startsWith("/") ? withoutTrailingSlash : `/${withoutTrailingSlash}`;
}

function isDateToday(date: string): boolean {
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

  return date === localToday;
}
