// The recorded read-API responses under site/fixtures/api/, looked up by API path, and their photos.
// The console's client and the landing both read them here. The load files (loads/*.json) are
// their own glob, so the landing, which needs one load, does not bundle the lists and the live
// captures; the client adds those (clientFixtureModules in client.ts).
export const loadFixtureModules = import.meta.glob<unknown>("../../fixtures/api/loads/*.json", { eager: true, import: "default" });
const fixturePhotos = import.meta.glob<string>("../../fixtures/api/photos/*", { eager: true, query: "?url", import: "default" });

// Fixture lookup by API path: tries the likely file layouts under site/fixtures/api/.
export function fixtureFor(path: string, modules: Record<string, unknown> = loadFixtureModules): unknown {
  const [route = "", query = ""] = path.replace(/^\/api\//, "").split("?");
  const channel = new URLSearchParams(query).get("channel");
  // site/fixtures/api layout: overview, loads, messages[.channel], loads/<id>[.pack|.emails.<id>]
  const names = [
    channel ? `${route}.${channel}` : route,
    route.replace(/^loads\/([^/]+)\/(.+)$/, (_m, id: string, rest: string) => `loads/${id}.${rest.replace(/\//g, ".")}`),
  ];
  for (const [key, value] of Object.entries(modules)) {
    const rel = key.replace(/^.*fixtures\/api\//, "").replace(/\.json$/, "");
    if (names.includes(rel)) return value;
  }
  throw new Error(`no fixture for ${path}`);
}

// A recorded photo's bundled URL, by file name; anything else is returned as given.
export function fixturePhotoUrl(u: string): string {
  const name = u.split("/").pop() ?? u;
  const hit = Object.entries(fixturePhotos).find(([k]) => k.endsWith(`/${name}`));
  return hit ? hit[1] : u;
}
