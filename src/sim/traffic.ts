import type { TrafficVehicleDef, Vec2 } from "./types";
import { obbOverlap } from "./spatialGrid";
import { getCarCorners, VEHICLE_DIMS } from "./vehicle";

export type TrafficPose = { x: number; z: number; h: number };

function totalPathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return total;
}

/**
 * Детерминированная поза машины трафика в момент времени t:
 * s = (offset + dir · speed · t) mod L, зацикленное движение вдоль полилинии.
 */
export function trafficPoseAt(def: TrafficVehicleDef, time: number): TrafficPose {
  const pts = def.points;
  if (pts.length < 2) return { x: pts[0].x, z: pts[0].z, h: 0 };
  const total = totalPathLength(pts);
  if (total <= 0) return { x: pts[0].x, z: pts[0].z, h: 0 };

  let s = (def.offset + def.dir * def.speed * time) % total;
  if (s < 0) s += total;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (s <= segLen || i === pts.length - 2) {
      const t = segLen > 0 ? Math.min(1, s / segLen) : 0;
      return {
        x: p0.x + (p1.x - p0.x) * t,
        z: p0.z + (p1.z - p0.z) * t,
        h: Math.atan2(p1.x - p0.x, p1.z - p0.z),
      };
    }
    s -= segLen;
  }
  return { x: pts[0].x, z: pts[0].z, h: 0 };
}

/** Четыре угла кузова машины трафика (габариты модели из VEHICLE_DIMS). */
export function trafficCorners(pose: TrafficPose, def: TrafficVehicleDef): [Vec2, Vec2, Vec2, Vec2] {
  const dim = VEHICLE_DIMS[def.model];
  const fx = Math.sin(pose.h);
  const fz = Math.cos(pose.h);
  const lx = Math.cos(pose.h);
  const lz = -Math.sin(pose.h);
  const hl = dim.length / 2;
  const hw = dim.width / 2;
  return [
    { x: pose.x + fx * hl + lx * hw, z: pose.z + fz * hl + lz * hw },
    { x: pose.x + fx * hl - lx * hw, z: pose.z + fz * hl - lz * hw },
    { x: pose.x - fx * hl - lx * hw, z: pose.z - fz * hl - lz * hw },
    { x: pose.x - fx * hl + lx * hw, z: pose.z - fz * hl + lz * hw },
  ];
}

/** Возвращает движущуюся машину, пересекающуюся с игроком, либо null (предпроверка по дистанции 7 м). */
export function findTrafficHit(
  x: number,
  z: number,
  h: number,
  traffic: readonly TrafficVehicleDef[],
  time: number
): TrafficVehicleDef | null {
  if (traffic.length === 0) return null;
  const carCorners = getCarCorners(x, z, h);
  for (const def of traffic) {
    const pose = trafficPoseAt(def, time);
    if (Math.hypot(pose.x - x, pose.z - z) > 7) continue;
    const corners = trafficCorners(pose, def);
    if (obbOverlap(carCorners, h, corners, pose.h)) return def;
  }
  return null;
}
