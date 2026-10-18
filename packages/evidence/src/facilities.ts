import type { Facility } from "./geofence.js";

// Fictional facilities with hand-drawn yard polygons, used by fixtures and the demo. Not real sites.
export const FACILITIES: readonly Facility[] = [
  {
    id: "lakeshore-columbus",
    name: "Lakeshore DC, Columbus OH",
    timeZone: "America/New_York",
    polygon: [
      [-82.9406, 39.9012],
      [-82.9351, 39.9012],
      [-82.9351, 39.8981],
      [-82.9406, 39.8981],
    ],
  },
  {
    id: "prairie-joliet",
    name: "Prairie Distribution, Joliet IL",
    timeZone: "America/Chicago",
    polygon: [
      [-88.1312, 41.5021],
      [-88.1254, 41.5021],
      [-88.1254, 41.4987],
      [-88.1312, 41.4987],
    ],
  },
];

// The judge try-it path: judges are wherever they are, so this "yard" is the whole map. A pin is
// still recorded with its server timestamp; only the geofence test is waived, and the name says so.
export const JUDGE_DEMO_FACILITY: Facility = {
  id: "judge-demo",
  name: "Judge demo yard (any location counts)",
  timeZone: "America/New_York",
  polygon: [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
  ],
};

// Facilities supplied at runtime, such as a private demo yard whose polygon must not live in the
// repository. Registered ids may not shadow the built-in fixtures.
const registered = new Map<string, Facility>();

export function registerFacility(facility: Facility): void {
  if (FACILITIES.some((f) => f.id === facility.id)) throw new Error(`facility ${facility.id} is built in`);
  if (facility.polygon.length < 3) throw new Error(`facility ${facility.id} needs a polygon of at least 3 points`);
  registered.set(facility.id, facility);
}

export function facilityById(id: string): Facility {
  const facility = FACILITIES.find((f) => f.id === id) ?? (id === JUDGE_DEMO_FACILITY.id ? JUDGE_DEMO_FACILITY : undefined) ?? registered.get(id);
  if (!facility) throw new Error(`unknown facility ${id}`);
  return facility;
}
