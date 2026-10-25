import type { ReactNode } from "react";
import type { RouteObject } from "react-router-dom";

// The site's routes in one place, so a test can check every published path still resolves.
// "/" is the landing page; the console lives under the shell. Claim emails, the README and the
// listing link to /judges, /messages, /loads and /loads/<id>, so those paths never move.
export type RouteName = "landing" | "shell" | "overview" | "messages" | "loads" | "load" | "judges" | "fallback";

export function routeTree(el: Record<RouteName, ReactNode>): RouteObject[] {
  return [
    { path: "/", element: el.landing },
    {
      element: el.shell,
      children: [
        { path: "overview", element: el.overview },
        { path: "messages", element: el.messages },
        { path: "loads", element: el.loads },
        { path: "loads/:id", element: el.load },
        { path: "loads/:id/:tab", element: el.load },
        { path: "judges", element: el.judges },
        { path: "judges/:step", element: el.judges },
        { path: "*", element: el.fallback },
      ],
    },
  ];
}
