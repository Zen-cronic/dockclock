import "./fonts.js";
import "./styles/tokens.css";
import "./styles/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, useLocation, useRoutes } from "react-router-dom";
import { Landing } from "./landing/Landing.js";
import { routeNameAt, routeTree, type RouteName } from "./routes/table.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";

// The landing at "/" is in the first bundle, so it paints without a second round trip. The console
// (its shell, its routes and the data client with its bundled replays and fixtures) loads on the
// first visit to a console path. The shell's chunk and the visited route's chunk are fetched at
// once, not one after the other: loading the shell starts the route's import too. An unknown path
// redirects home without loading the shell. A failed import is caught by the ErrorBoundary.
const shell = () => import("./ui/AppShell.js");
const pages = {
  overview: () => import("./routes/Overview.js").then((m) => m.Overview),
  messages: () => import("./routes/Messages.js").then((m) => m.Messages),
  loads: () => import("./routes/Loads.js").then((m) => m.Loads),
  load: () => import("./routes/LoadDetail.js").then((m) => m.LoadDetailRoute),
  judges: () => import("./routes/Judges.js").then((m) => m.Judges),
} satisfies Partial<Record<RouteName, () => Promise<ComponentType>>>;
type Page = keyof typeof pages;

function preloadPage(path: string): void {
  const name = routeNameAt(path);
  // A failed preload is reported by the route's own import, inside the error boundary.
  if (name && name in pages) void pages[name as Page]().catch(() => undefined);
}

const AppShell = lazy(() => {
  preloadPage(window.location.pathname);
  return shell().then((m) => ({ default: m.AppShell }));
});
const page = (name: Page) => lazy(() => pages[name]().then((c) => ({ default: c })));
const Overview = page("overview");
const Messages = page("messages");
const Loads = page("loads");
const LoadDetailRoute = page("load");
const Judges = page("judges");

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1, refetchOnWindowFocus: false } } });

const later = (el: ReactNode) => <Suspense fallback={null}>{el}</Suspense>;

const routes = routeTree({
  landing: <Landing />,
  shell: later(<AppShell />),
  overview: later(<Overview />),
  messages: later(<Messages />),
  loads: later(<Loads />),
  load: later(<LoadDetailRoute />),
  judges: later(<Judges />),
  fallback: <Navigate to="/" replace />,
});

function App() {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{useRoutes(routes)}</ErrorBoundary>;
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
