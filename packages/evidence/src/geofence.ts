export type LonLat = readonly [number, number];

export interface Facility {
  id: string;
  name: string;
  // IANA zone the facility writes paperwork times in.
  timeZone: string;
  // Closed ring of [longitude, latitude] points; the first point need not repeat at the end.
  polygon: readonly LonLat[];
}

export interface GeofenceResult {
  inside: boolean;
  distanceMeters: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Ray casting on the lon/lat plane; adequate for facility-sized polygons away from the poles.
export function pointInPolygon(point: LonLat, polygon: readonly LonLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegmentMeters(p: LonLat, a: LonLat, b: LonLat): number {
  const latScale = Math.cos(toRadians(p[1]));
  const ax = (a[0] - p[0]) * latScale;
  const ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * latScale;
  const by = b[1] - p[1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  const closest: LonLat = [p[0] + (ax + t * dx) / latScale, p[1] + ay + t * dy];
  return haversineMeters(p, closest);
}

export function checkGeofence(point: LonLat, facility: Facility): GeofenceResult {
  if (pointInPolygon(point, facility.polygon)) return { inside: true, distanceMeters: 0 };
  let best = Number.POSITIVE_INFINITY;
  const ring = facility.polygon;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) best = Math.min(best, distanceToSegmentMeters(point, a, b));
  }
  return { inside: false, distanceMeters: Math.round(best) };
}
