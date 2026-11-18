import type { RoadSegment, RouteCheckpoint } from "../sim/types";

function roadLength(road: RoadSegment): number {
  let total = 0;
  for (let i = 0; i < road.points.length - 1; i++) {
    total += Math.hypot(road.points[i + 1].x - road.points[i].x, road.points[i + 1].z - road.points[i].z);
  }
  return total;
}

/** Точка на полилинии дороги на расстоянии dist от начала (м). */
function pointAtDistance(road: RoadSegment, dist: number): { x: number; z: number } {
  const pts = road.points;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 0) continue;
    if (acc + len >= dist || i === pts.length - 2) {
      const t = len > 0 ? Math.min(1, Math.max(0, (dist - acc) / len)) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += len;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, z: last.z };
}

/**
 * Строит экзаменационный маршрут вдоль самой длинной названной дороги участка.
 * Это привязка к реальному маршруту: контрольные точки стоят на реальной геометрии улицы,
 * а задания экзаменатора содержат её название и ограничение скорости.
 */
export function buildRouteFromRoads(
  roads: readonly RoadSegment[],
  opts?: { maxPoints?: number; spacing?: number }
): { checkpoints: RouteCheckpoint[]; roadName: string; speedLimitKmh: number; startPose: { x: number; z: number; h: number } | null } {
  const maxPoints = opts?.maxPoints ?? 6;
  const spacing = Math.max(8, opts?.spacing ?? 24);

  const road = roads
    .filter((r) => Boolean(r.name?.trim()) && r.points.length >= 2)
    .map((r) => ({ r, len: roadLength(r) }))
    .filter((x) => x.len >= spacing * 1.5)
    .sort((a, b) => b.len - a.len)[0]?.r;

  if (!road) return { checkpoints: [], roadName: "", speedLimitKmh: 0, startPose: null };

  const street = road.name!.trim();
  const limit = road.speedLimitKmh ?? 0;
  const total = roadLength(road);
  const count = Math.max(1, Math.min(maxPoints, Math.floor(total / spacing)));

  // Точки равномерно распределены по улице, не заходя до самого начала и конца
  const checkpoints: RouteCheckpoint[] = [];
  for (let i = 0; i < count; i++) {
    const dist = (total * (i + 1)) / (count + 1);
    const { x, z } = pointAtDistance(road, dist);
    const last = i === count - 1;
    checkpoints.push({
      id: `route-${street.replace(/\s+/g, "-")}-${i + 1}`,
      x: Number(x.toFixed(1)),
      z: Number(z.toFixed(1)),
      radius: last ? 7.5 : 6,
      instruction: last
        ? `Финиш маршрута на «${street}»${limit ? ` (ограничение ${limit} км/ч)` : ""} — остановитесь в границах проезжей части.`
        : `Продолжайте движение по «${street}», точка ${i + 1}/${count}${limit ? `, ограничение ${limit} км/ч` : ""}. Держите полосу.`,
      requireSignal: undefined,
      isFinalPark: false,
    });
  }

  // Старт — на 14 м раньше первой точки, носом вдоль дороги (правостороннее движение)
  const firstDist = (total * 1) / (count + 1);
  const startPt = pointAtDistance(road, Math.max(0, firstDist - 14));
  const ahead = pointAtDistance(road, Math.min(total, firstDist));
  const h = Math.atan2(ahead.x - startPt.x, ahead.z - startPt.z);
  const rx = -Math.cos(h) * Math.min(2.4, Math.max(0.9, road.width * 0.22));
  const rz = Math.sin(h) * Math.min(2.4, Math.max(0.9, road.width * 0.22));
  const startPose = {
    x: Number((startPt.x + rx).toFixed(1)),
    z: Number((startPt.z + rz).toFixed(1)),
    h: Number(h.toFixed(3)),
  };
  return { checkpoints, roadName: street, speedLimitKmh: limit, startPose };
}

/** Название реальной улицы под автомобилем (или ближайшей к нему) для HUD. */
export function streetNameAt(
  x: number,
  z: number,
  roads: readonly RoadSegment[],
  maxDist = 18
): { name: string; limitKmh?: number } | null {
  let best: RoadSegment | null = null;
  let bestDist = maxDist;
  for (const road of roads) {
    if (!road.name?.trim()) continue;
    const pts = road.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const lenSq = abx * abx + abz * abz;
      if (lenSq <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq));
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestDist) {
        bestDist = d;
        best = road;
      }
    }
  }
  if (!best) return null;
  return { name: best.name!.trim(), limitKmh: best.speedLimitKmh };
}
