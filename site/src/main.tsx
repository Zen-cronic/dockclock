import "./fonts.js";
import "./styles/tokens.css";
import "./styles/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, useRoutes } from "react-router-dom";
import { AppShell } from "./ui/AppShell.js";
import { Overview } from "./routes/Overview.js";
import { Messages } from "./routes/Messages.js";
import { Loads } from "./routes/Loads.js";
import { LoadDetailRoute } from "./routes/LoadDetail.js";
import { Judges } from "./routes/Judges.js";
import { routeTree } from "./routes/table.js";

// The landing page is its own chunk with its own fonts; the console does not load it.
const Landing = lazy(() => import("./landing/Landing.js"));

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1, refetchOnWindowFocus: false } } });

const routes = routeTree({
  landing: (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  ),
  shell: <AppShell />,
  overview: <Overview />,
  messages: <Messages />,
  loads: <Loads />,
  load: <LoadDetailRoute />,
  judges: <Judges />,
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
