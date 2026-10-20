import "./fonts.js";
import "./styles/tokens.css";
import "./styles/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./ui/AppShell.js";
import { Overview } from "./routes/Overview.js";
import { Messages } from "./routes/Messages.js";
import { Loads } from "./routes/Loads.js";
import { LoadDetailRoute } from "./routes/LoadDetail.js";
import { Judges } from "./routes/Judges.js";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Overview />} />
            <Route path="messages" element={<Messages />} />
            <Route path="loads" element={<Loads />} />
            <Route path="loads/:id" element={<LoadDetailRoute />} />
            <Route path="loads/:id/:tab" element={<LoadDetailRoute />} />
            <Route path="judges" element={<Judges />} />
            <Route path="judges/:step" element={<Judges />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
