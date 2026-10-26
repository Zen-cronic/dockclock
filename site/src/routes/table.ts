import type { ReactNode } from "react";
import { matchRoutes, type RouteObject } from "react-router-dom";

// The site's routes in one place, so a test can check every published path still resolves.
// "/" is the landing page; the console lives under the shell. Claim emails, the README and the
// listing link to /judges, /messages, /loads and /loads/<id>, so those paths never move.
export const ROUTE_NAMES = ["landing", "shell", "overview", "messages", "loads", "load", "judges", "fallback"] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

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
      ],
    },
    // Outside the shell, so a mistyped path goes home without loading the console.
    { path: "*", element: el.fallback },
  ];
}

const named = routeTree(Object.fromEntries(ROUTE_NAMES.map((n) => [n, n])) as Record<RouteName, string>);

// The route a path renders (its innermost match), so main.tsx can start that route's chunk with the
// shell's instead of after it.
export function routeNameAt(path: string): RouteName | null {
  // typed loosely: RouteObject and the matcher's route type disagree under exactOptionalPropertyTypes
  const matched = matchRoutes(named as never[], path) as Array<{ route: RouteObject }> | null;
  const leaf = matched?.at(-1)?.route.element;
  return typeof leaf === "string" && (ROUTE_NAMES as readonly string[]).includes(leaf) ? (leaf as RouteName) : null;
}
