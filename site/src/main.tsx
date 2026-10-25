import "./fonts.js";
import "./styles/tokens.css";
import "./styles/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, useRoutes } from "react-router-dom";
import { Landing } from "./landing/Landing.js";
import { routeTree } from "./routes/table.js";

// The landing at "/" is in the first bundle, so it paints without a second round trip. The console
// (its shell, its routes and the data client with its bundled replays and fixtures) loads on the
// first visit to a console path. The data client's replay fallback travels with it.
const AppShell = lazy(() => import("./ui/AppShell.js").then((m) => ({ default: m.AppShell })));
const Overview = lazy(() => import("./routes/Overview.js").then((m) => ({ default: m.Overview })));
const Messages = lazy(() => import("./routes/Messages.js").then((m) => ({ default: m.Messages })));
const Loads = lazy(() => import("./routes/Loads.js").then((m) => ({ default: m.Loads })));
const LoadDetailRoute = lazy(() => import("./routes/LoadDetail.js").then((m) => ({ default: m.LoadDetailRoute })));
const Judges = lazy(() => import("./routes/Judges.js").then((m) => ({ default: m.Judges })));

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
  return useRoutes(routes);
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
