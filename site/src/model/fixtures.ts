// The recorded read-API responses under site/fixtures/api/, looked up by API path, and their photos.
// The console's client and the landing both read them here. The load files (loads/*.json) are
// their own glob, so the landing, which needs one load, does not bundle the lists and the live
// captures; the client adds those (fixtureModules in client.ts) and passes them to fixtureFor.
export const loadFixtureModules = import.meta.glob<unknown>("../../fixtures/api/loads/*.json", { eager: true, import: "default" });
const fixturePhotos = import.meta.glob<string>("../../fixtures/api/photos/*", { eager: true, query: "?url", import: "default" });

// Fixture lookup by API path: tries the likely file layouts under site/fixtures/api/, most specific
// first, and returns the first one that exists (whatever order the glob listed the files in).
// Layout: overview, loads, messages[.channel], loads/<id>[.pack|.emails.<id>]. A channel-filtered
// path gets its own file (messages.rcs) when there is one, else the unfiltered route.
export function fixtureFor(path: string, modules: Record<string, unknown> = loadFixtureModules): unknown {
  const [route = "", query = ""] = path.replace(/^\/api\//, "").split("?");
  const channel = new URLSearchParams(query).get("channel");
  const nested = route.replace(/^loads\/([^/]+)\/(.+)$/, (_m, id: string, rest: string) => `loads/${id}.${rest.replace(/\//g, ".")}`);
  const candidates = [...(channel ? [`${route}.${channel}`] : []), nested, route];
  const byName = new Map(Object.entries(modules).map(([key, value]) => [key.replace(/^.*fixtures\/api\//, "").replace(/\.json$/, ""), value]));
  for (const name of candidates) if (byName.has(name)) return byName.get(name);
  throw new Error(`no fixture for ${path}`);
}

// A recorded photo's bundled URL, by file name; anything else is returned as given.
export function fixturePhotoUrl(u: string): string {
  const name = u.split("/").pop() ?? u;
  const hit = Object.entries(fixturePhotos).find(([k]) => k.endsWith(`/${name}`));
  return hit ? hit[1] : u;
}
