/**
 * @module sim/spatialGrid
 * @layer pure-core
 * @role Равномерная пространственная сетка (10 м), точные OBB-коллизии по теореме разделяющих осей (SAT) и геометрия боксов.
 * @invariants #1 (координаты +Z вперёд, +X лево), #7 (без three/window/document).
 * @tests T05, T06, T07, T08, T16
 */
import type { ObstacleBox, ParkingBay, Vec2 } from "./types";
import { CAR, getCarCorners, type CarGeometry } from "./vehicle";

function getBoxCorners(b: ObstacleBox): [Vec2, Vec2, Vec2, Vec2] {
  const fx = Math.sin(b.h);
  const fz = Math.cos(b.h);
  const lx = Math.cos(b.h);
  const lz = -Math.sin(b.h);
  return [
    { x: b.cx + fx * b.halfZ + lx * b.halfX, z: b.cz + fz * b.halfZ + lz * b.halfX },
    { x: b.cx + fx * b.halfZ - lx * b.halfX, z: b.cz + fz * b.halfZ - lz * b.halfX },
    { x: b.cx - fx * b.halfZ - lx * b.halfX, z: b.cz - fz * b.halfZ - lz * b.halfX },
    { x: b.cx - fx * b.halfZ + lx * b.halfX, z: b.cz - fz * b.halfZ + lz * b.halfX },
  ];
}

function projectPoly(corners: readonly Vec2[], ax: number, az: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i].x * ax + corners[i].z * az;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

/** Проверка пересечения двух ориентированных прямоугольников методом разделяющих осей (SAT). */
export function obbOverlap(
  a: readonly [Vec2, Vec2, Vec2, Vec2],
  ah: number,
  b: readonly [Vec2, Vec2, Vec2, Vec2],
  bh: number
): boolean {
  const axes: [number, number][] = [
    [Math.sin(ah), Math.cos(ah)],
    [Math.cos(ah), -Math.sin(ah)],
    [Math.sin(bh), Math.cos(bh)],
    [Math.cos(bh), -Math.sin(bh)],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = axes[i];
    const [minA, maxA] = projectPoly(a, ax, az);
    const [minB, maxB] = projectPoly(b, ax, az);
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

/** Пространственная хэш-сетка (по умолчанию ячейка 10 × 10 м) для быстрой проверки столкновений. */
export class SpatialGrid {
  readonly cellSize: number;
  private readonly cells = new Map<string, ObstacleBox[]>();
  private readonly cornerCache = new Map<string, [Vec2, Vec2, Vec2, Vec2]>();
  readonly totalObstacles: number;

  constructor(obstacles: readonly ObstacleBox[], cellSize = 10) {
    this.cellSize = cellSize;
    this.totalObstacles = obstacles.length;
    for (const obs of obstacles) {
      const corners = getBoxCorners(obs);
      this.cornerCache.set(obs.id, corners);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const c of corners) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z;
        if (c.z > maxZ) maxZ = c.z;
      }
      const gx0 = Math.floor(minX / cellSize);
      const gx1 = Math.floor(maxX / cellSize);
      const gz0 = Math.floor(minZ / cellSize);
      const gz1 = Math.floor(maxZ / cellSize);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const key = `${gx}:${gz}`;
          let bucket = this.cells.get(key);
          if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
          }
          bucket.push(obs);
        }
      }
    }
  }

  /** Возвращает первое препятствие, с которым пересекается автомобиль, либо null. */
  queryCarHit(x: number, z: number, h: number, geo?: CarGeometry): { hit: ObstacleBox | null; checked: number } {
    const carCorners = getCarCorners(x, z, h, geo);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of carCorners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    const gx0 = Math.floor(minX / this.cellSize);
    const gx1 = Math.floor(maxX / this.cellSize);
    const gz0 = Math.floor(minZ / this.cellSize);
    const gz1 = Math.floor(maxZ / this.cellSize);

    const seen = new Set<string>();
    let checked = 0;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.cells.get(`${gx}:${gz}`);
        if (!bucket) continue;
        for (const obs of bucket) {
          if (seen.has(obs.id)) continue;
          seen.add(obs.id);
          checked++;
          const obsCorners = this.cornerCache.get(obs.id)!;
          if (obbOverlap(carCorners, h, obsCorners, obs.h)) {
            return { hit: obs, checked };
          }
        }
      }
    }
    return { hit: null, checked };
  }
}

/** Эталонная проверка полным перебором — используется в автотестах для сверки SpatialGrid. */
export function checkCarCollisionBruteForce(
  x: number,
  z: number,
  h: number,
  obstacles: readonly ObstacleBox[],
  geo?: CarGeometry
): ObstacleBox | null {
  const carCorners = getCarCorners(x, z, h);
  for (const obs of obstacles) {
    if (obbOverlap(carCorners, h, getBoxCorners(obs), obs.h)) {
      return obs;
    }
  }
  return null;
}

/** Перевод точки мира в локальные координаты парковочного бокса (localX — поперёк, localZ — вдоль). */
export function worldToBayLocal(pt: Vec2, bay: ParkingBay): { lx: number; lz: number } {
  const dx = pt.x - bay.cx;
  const dz = pt.z - bay.cz;
  const fx = Math.sin(bay.h);
  const fz = Math.cos(bay.h);
  const leftX = Math.cos(bay.h);
  const leftZ = -Math.sin(bay.h);
  return {
    lx: dx * leftX + dz * leftZ,
    lz: dx * fx + dz * fz,
  };
}

/** Проверка полного вхождения всех четырёх углов кузова в свободный парковочный бокс (допуск 4 см). */
export function isCarInsideBay(x: number, z: number, h: number, bay: ParkingBay, margin = 0.04, geo?: CarGeometry): boolean {
  if (bay.occupied) return false;
  const corners = getCarCorners(x, z, h, geo);
  const halfW = bay.width / 2 + margin;
  const halfL = bay.length / 2 + margin;
  for (const c of corners) {
    const { lx, lz } = worldToBayLocal(c, bay);
    if (Math.abs(lx) > halfW || Math.abs(lz) > halfL) return false;
  }
  // Проверяем выравнивание кузова по оси бокса (±18°)
  const align = Math.abs(Math.cos(h - bay.h));
  return align >= Math.cos((18 * Math.PI) / 180);
}

/** Находит свободный бокс, в котором находится автомобиль целиком. */
export function findCompletedBay(x: number, z: number, h: number, bays: readonly ParkingBay[], geo?: CarGeometry): ParkingBay | null {
  for (const bay of bays) {
    if (isCarInsideBay(x, z, h, bay, 0.04, geo)) return bay;
  }
  return null;
}

/** Находит свободный бокс под центром автомобиля (частичный заезд — для подсказки в HUD). */
export function findBayUnderCarCenter(x: number, z: number, bays: readonly ParkingBay[]): ParkingBay | null {
  for (const bay of bays) {
    if (bay.occupied) continue;
    const { lx, lz } = worldToBayLocal({ x, z }, bay);
    if (Math.abs(lx) <= bay.width / 2 && Math.abs(lz) <= bay.length / 2) return bay;
  }
  return null;
}

/**
 * Проверка наезда углом кузова на боковую/заднюю сплошную линию разметки свободного бокса,
 * когда центр автомобиля уже зашёл в глубину бокса.
 */
export function findBayLineCross(x: number, z: number, h: number, bays: readonly ParkingBay[], geo?: CarGeometry): ParkingBay | null {
  const corners = getCarCorners(x, z, h);
  for (const bay of bays) {
    if (bay.occupied) continue;
    const center = worldToBayLocal({ x, z }, bay);
    // Проверяем только когда машина существенно зашла внутрь бокса
    if (bay.kind === "perpendicular") {
      if (Math.abs(center.lx) > bay.width * 0.52 || Math.abs(center.lz) > bay.length * 0.36) continue;
      const halfW = bay.width / 2 + 0.08;
      for (const c of corners) {
        const p = worldToBayLocal(c, bay);
        // Пересечение боковой линии внутри глубины бокса
        if (Math.abs(p.lz) < bay.length / 2 - 0.35 && Math.abs(p.lx) > halfW) {
          return bay;
        }
      }
    } else {
      // Параллельная парковка: открыта левая сторона (+lx), справа бордюр (-lx), спереди и сзади разметка
      if (Math.abs(center.lx) > bay.width * 0.35 || Math.abs(center.lz) > bay.length * 0.44) continue;
      const halfL = bay.length / 2 + 0.1;
      for (const c of corners) {
        const p = worldToBayLocal(c, bay);
        if (p.lx < bay.width * 0.15 && Math.abs(p.lz) > halfL) {
          return bay;
        }
      }
    }
  }
  return null;
}

/** Минимальное расстояние до правого края параллельного бокса (контроль прижатия к бордюру). */
export function rightCurbClearance(x: number, z: number, h: number, bay: ParkingBay, geo?: CarGeometry): number {
  const corners = getCarCorners(x, z, h);
  let minGap = Infinity;
  for (const c of corners) {
    const p = worldToBayLocal(c, bay);
    const gap = p.lx - -bay.width / 2;
    if (gap < minGap) minGap = gap;
  }
  return Math.max(0, minGap);
}

export function carBoundingRadius(geo?: CarGeometry): number {
  return Math.hypot((geo?.length ?? CAR.length) / 2 + 0.1, (geo?.width ?? CAR.width) / 2);
}
