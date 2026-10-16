import type { Facility } from "./geofence.js";

// Fictional facilities with hand-drawn yard polygons, used by fixtures and the demo. Not real sites.
export const FACILITIES: readonly Facility[] = [
  {
    id: "lakeshore-columbus",
    name: "Lakeshore DC, Columbus OH",
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
    polygon: [
      [-88.1312, 41.5021],
      [-88.1254, 41.5021],
      [-88.1254, 41.4987],
      [-88.1312, 41.4987],
    ],
  },
];

export function facilityById(id: string): Facility {
  const facility = FACILITIES.find((f) => f.id === id);
  if (!facility) throw new Error(`unknown facility ${id}`);
  return facility;
}
