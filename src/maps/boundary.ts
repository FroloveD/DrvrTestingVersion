/**
 * @module maps/boundary
 * @layer pure-core
 * @role Произвольные (неквадратные) полигональные границы карты и маршрута: принадлежность точки, проекция, обрезка дорог, коридор маршрута и выпуклая оболочка.
 * @invariants #1 (координаты +Z север, +X лево, −X восток), #7 (чистое ядро без DOM и three), #8 (офлайн).
 * @tests T30
 */
import type { Vec2, WorldBounds } from "../sim/types";

/** Максимальный модуль координаты мира (поддерживает реальные городские маршруты до 6×6 км). */
export const MAX_WORLD_COORD = 3000;

const round2 = (v: number): number => Number(v.toFixed(2));
const clampCoord = (v: number): number => Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, v));

/** Знаковая площадь многоугольника по формуле Гаусса (м²). */
export function signedPolygonArea(poly: readonly Vec2[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  }
  return sum * 0.5;
}

/** Площадь произвольного контура границы (м²). */
export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(signedPolygonArea(poly));
}

/** Проверяет, что контур содержит минимум 3 корректные вершины и ненулевую площадь. */
export function isValidBoundaryPolygon(poly: readonly Vec2[] | undefined | null): poly is readonly Vec2[] {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  for (const p of poly) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  }
  return polygonArea(poly) >= 16;
}

/** Очищает и нормализует вершины пользовательского контура (удаляя подряд идущие дубликаты). */
export function sanitizeBoundaryPolygon(raw: readonly Vec2[] | undefined | null): Vec2[] | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const out: Vec2[] = [];
  for (const p of raw) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const pt = { x: round2(clampCoord(p.x)), z: round2(clampCoord(p.z)) };
    const prev = out[out.length - 1];
    if (prev && Math.hypot(pt.x - prev.x, pt.z - prev.z) < 0.2) continue;
    out.push(pt);
  }
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) < 0.2) out.pop();
  }
  return isValidBoundaryPolygon(out) ? out : undefined;
}

/** Вычисляет точный охватывающий прямоугольник `bounds` для произвольного контура. */
export function boundingBoxOfPolygon(poly: readonly Vec2[], pad = 0): WorldBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (!Number.isFinite(minX)) {
    return { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
  }
  return {
    minX: Number(clampCoord(Math.floor(minX - pad)).toFixed(1)),
    maxX: Number(clampCoord(Math.ceil(maxX + pad)).toFixed(1)),
    minZ: Number(clampCoord(Math.floor(minZ - pad)).toFixed(1)),
    maxZ: Number(clampCoord(Math.ceil(maxZ + pad)).toFixed(1)),
  };
}

/** Преобразует прямоугольник `bounds` в 4-вершинный контур (стартовая заготовка для редактирования). */
export function boundsToPolygon(bounds: WorldBounds): Vec2[] {
  return [
    { x: round2(bounds.minX), z: round2(bounds.minZ) },
    { x: round2(bounds.maxX), z: round2(bounds.minZ) },
    { x: round2(bounds.maxX), z: round2(bounds.maxZ) },
    { x: round2(bounds.minX), z: round2(bounds.maxZ) },
  ];
}

/** Ближайшая точка на отрезке `AB` к точке `P`. */
export function closestPointOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): { x: number; z: number; distSq: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-12) {
    const ex = px - ax;
    const ez = pz - az;
    return { x: ax, z: az, distSq: ex * ex + ez * ez, t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const ex = px - cx;
  const ez = pz - cz;
  return { x: cx, z: cz, distSq: ex * ex + ez * ez, t };
}

/**
 * Проверяет принадлежность точки `(px, pz)` произвольному (в том числе невыпуклому) многоугольнику.
 * Точки на самой границе (в пределах 5 см) считаются принадлежащими области.
 */
export function isPointInPolygon(px: number, pz: number, poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (closestPointOnSegment(px, pz, a.x, a.z, b.x, b.z).distSq <= 0.0025) {
      return true;
    }
    const intersects =
      a.z > pz !== b.z > pz &&
      px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Проверяет, что точка находится внутри рабочей границы мира (полигональной либо прямоугольной). */
export function isInsideWorldBoundary(
  x: number,
  z: number,
  bounds: WorldBounds,
  boundaryPolygon?: readonly Vec2[]
): boolean {
  if (isValidBoundaryPolygon(boundaryPolygon)) {
    const bb = boundingBoxOfPolygon(boundaryPolygon, 0.1);
    if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) return false;
    return isPointInPolygon(x, z, boundaryPolygon);
  }
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

/** Удерживает точку `(x, z)` внутри границы мира (для полигона проецирует на ближайшее ребро). */
export function clampPointToWorldBoundary(
  x: number,
  z: number,
  bounds: WorldBounds,
  boundaryPolygon?: readonly Vec2[]
): Vec2 {
  if (isValidBoundaryPolygon(boundaryPolygon)) {
    if (isPointInPolygon(x, z, boundaryPolygon)) return { x, z };
    let bestX = boundaryPolygon[0].x;
    let bestZ = boundaryPolygon[0].z;
    let bestD2 = Infinity;
    for (let i = 0, j = boundaryPolygon.length - 1; i < boundaryPolygon.length; j = i++) {
      const a = boundaryPolygon[j];
      const b = boundaryPolygon[i];
      const cp = closestPointOnSegment(x, z, a.x, a.z, b.x, b.z);
      if (cp.distSq < bestD2) {
        bestD2 = cp.distSq;
        bestX = cp.x;
        bestZ = cp.z;
      }
    }
    return { x: bestX, z: bestZ };
  }
  return {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, z)),
  };
}

/** Параметр `t ∈ [0, 1]` пересечения отрезка `P0→P1` с ребром `Q0→Q1` (null при параллельности/мимо). */
function segmentIntersectionT(
  p0: Vec2,
  p1: Vec2,
  q0: Vec2,
  q1: Vec2
): number | null {
  const rx = p1.x - p0.x;
  const rz = p1.z - p0.z;
  const sx = q1.x - q0.x;
  const sz = q1.z - q0.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-10) return null;
  const qpx = q0.x - p0.x;
  const qpz = q0.z - p0.z;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
    return Math.max(0, Math.min(1, t));
  }
  return null;
}

/** Проверяет отсутствие самопересечений несмежных рёбер многоугольника. */
export function isSimplePolygon(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a0 = poly[i];
    const a1 = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b0 = poly[j];
      const b1 = poly[(j + 1) % n];
      const t = segmentIntersectionT(a0, a1, b0, b1);
      if (t !== null && t > 1e-5 && t < 1 - 1e-5) return false;
    }
  }
  return true;
}

/**
 * Точно обрезает ломаную линию (дорогу) по произвольному (выпуклому или вогнутому) многоугольнику.
 * Если дорога выходит за контур и возвращается обратно, возвращает все внутренние участки.
 */
export function clipPolylineToPolygon(points: readonly Vec2[], poly: readonly Vec2[]): Vec2[][] {
  if (points.length < 2 || !isValidBoundaryPolygon(poly)) return [];
  const pieces: Vec2[][] = [];
  let current: Vec2[] = [];

  const pushPoint = (pt: Vec2) => {
    const r = { x: round2(pt.x), z: round2(pt.z) };
    const last = current[current.length - 1];
    if (!last || Math.hypot(r.x - last.x, r.z - last.z) > 0.05) {
      current.push(r);
    }
  };

  const flush = () => {
    if (current.length >= 2) {
      let len = 0;
      for (let i = 0; i < current.length - 1; i++) {
        len += Math.hypot(current[i + 1].x - current[i].x, current[i + 1].z - current[i].z);
      }
      if (len >= 1.5) pieces.push(current);
    }
    current = [];
  };

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) < 1e-4) continue;

    const ts: number[] = [0, 1];
    for (let e = 0, prev = poly.length - 1; e < poly.length; prev = e++) {
      const t = segmentIntersectionT(p0, p1, poly[prev], poly[e]);
      if (t !== null && t > 1e-5 && t < 1 - 1e-5) ts.push(t);
    }
    ts.sort((a, b) => a - b);

    // Убираем почти совпадающие параметры пересечения
    const uniq: number[] = [ts[0]];
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - uniq[uniq.length - 1] > 1e-4) uniq.push(ts[k]);
    }

    for (let k = 0; k < uniq.length - 1; k++) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      const tm = (t0 + t1) * 0.5;
      const mx = p0.x + (p1.x - p0.x) * tm;
      const mz = p0.z + (p1.z - p0.z) * tm;
      if (isPointInPolygon(mx, mz, poly)) {
        const a = { x: p0.x + (p1.x - p0.x) * t0, z: p0.z + (p1.z - p0.z) * t0 };
        const b = { x: p0.x + (p1.x - p0.x) * t1, z: p0.z + (p1.z - p0.z) * t1 };
        const last = current[current.length - 1];
        if (last && Math.hypot(a.x - last.x, a.z - last.z) > 0.15) {
          flush();
        }
        pushPoint(a);
        pushPoint(b);
      } else {
        flush();
      }
    }
  }
  flush();
  return pieces;
}

/** Упрощает ломаную по алгоритму Рамера — Дугласа — Пекера. */
function simplifyPolyline(pts: readonly Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));
  let maxDistSq = 0;
  let splitIdx = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d2 = closestPointOnSegment(pts[i].x, pts[i].z, first.x, first.z, last.x, last.z).distSq;
    if (d2 > maxDistSq) {
      maxDistSq = d2;
      splitIdx = i;
    }
  }
  if (maxDistSq > tolerance * tolerance) {
    const left = simplifyPolyline(pts.slice(0, splitIdx + 1), tolerance);
    const right = simplifyPolyline(pts.slice(splitIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [{ ...first }, { ...last }];
}

/**
 * Строит выпуклую оболочку (алгоритм Эндрю) вокруг набора точек с внешним отступом `padM` (м).
 * Позволяет аккуратно обтянуть диагональный или неквадратный участок дорог и зданий.
 */
export function buildConvexHullPolygon(rawPoints: readonly Vec2[], padM = 18): Vec2[] {
  const pad = Math.max(2, padM);
  const pts = rawPoints
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z))
    .map((p) => ({ x: round2(p.x), z: round2(p.z) }))
    .sort((a, b) => (a.x !== b.x ? a.x - b.x : a.z - b.z));

  const uniq: Vec2[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.5) uniq.push(p);
  }

  if (uniq.length === 0) {
    return boundsToPolygon({ minX: -pad, maxX: pad, minZ: -pad, maxZ: pad });
  }
  if (uniq.length === 1) {
    const c = uniq[0];
    return boundsToPolygon({
      minX: clampCoord(c.x - pad),
      maxX: clampCoord(c.x + pad),
      minZ: clampCoord(c.z - pad),
      maxZ: clampCoord(c.z + pad),
    });
  }
  if (uniq.length === 2) {
    return buildRouteCorridorPolygon(uniq, pad);
  }

  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) {
    return buildRouteCorridorPolygon([uniq[0], uniq[uniq.length - 1]], pad);
  }

  // Раздуваем каждую вершину наружу вдоль биссектрисы внешних нормалей (hull обходится CCW в плоскости X-Z)
  const n = hull.length;
  const expanded: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = hull[(i - 1 + n) % n];
    const cur = hull[i];
    const next = hull[(i + 1) % n];
    const e1x = cur.x - prev.x;
    const e1z = cur.z - prev.z;
    const l1 = Math.hypot(e1x, e1z) || 1;
    const e2x = next.x - cur.x;
    const e2z = next.z - cur.z;
    const l2 = Math.hypot(e2x, e2z) || 1;
    // Внешняя нормаль к CCW-ребру (ex, ez) равна (ez, -ex) / len
    const n1x = e1z / l1;
    const n1z = -e1x / l1;
    const n2x = e2z / l2;
    const n2z = -e2x / l2;
    let bx = n1x + n2x;
    let bz = n1z + n2z;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-4) {
      bx = n1x;
      bz = n1z;
    } else {
      bx /= bl;
      bz /= bl;
    }
    const cosHalf = Math.max(0.55, bx * n1x + bz * n1z);
    const dist = Math.min(pad * 1.65, pad / cosHalf);
    expanded.push({
      x: round2(clampCoord(cur.x + bx * dist)),
      z: round2(clampCoord(cur.z + bz * dist)),
    });
  }

  // Оставляем не более 28 вершин, чтобы контур было удобно править мышью
  if (expanded.length > 28) {
    const step = Math.ceil(expanded.length / 24);
    const decimated = expanded.filter((_, idx) => idx % step === 0);
    if (decimated.length >= 3) return decimated;
  }
  return expanded;
}

/**
 * Строит произвольный полигон-коридор шириной `±bufferM` (м) вдоль ломаной маршрута или улицы.
 * Повторяет изгибы и повороты маршрута без «загона» карты в квадрат.
 */
export function buildRouteCorridorPolygon(spineRaw: readonly Vec2[], bufferM = 45): Vec2[] {
  const buf = Math.max(10, Math.min(400, bufferM));
  const clean: Vec2[] = [];
  for (const p of spineRaw) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) >= Math.max(2, buf * 0.25)) {
      clean.push({ x: p.x, z: p.z });
    }
  }
  if (spineRaw.length >= 2) {
    const tail = spineRaw[spineRaw.length - 1];
    const last = clean[clean.length - 1];
    if (tail && last && Math.hypot(tail.x - last.x, tail.z - last.z) > 0.5) {
      clean.push({ x: tail.x, z: tail.z });
    }
  }

  if (clean.length < 2) {
    return buildConvexHullPolygon(clean, buf);
  }

  const spine = simplifyPolyline(clean, Math.max(2.5, buf * 0.16));
  // Нормали сегментов: для направления (ux, uz) левая нормаль = (uz, -ux)
  const segNormals: Vec2[] = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const dx = spine[i + 1].x - spine[i].x;
    const dz = spine[i + 1].z - spine[i].z;
    const len = Math.hypot(dx, dz) || 1;
    segNormals.push({ x: dz / len, z: -dx / len });
  }

  const leftSide: Vec2[] = [];
  const rightSide: Vec2[] = [];
  for (let i = 0; i < spine.length; i++) {
    const nPrev = segNormals[Math.max(0, i - 1)];
    const nNext = segNormals[Math.min(segNormals.length - 1, i)];
    let bx = nPrev.x + nNext.x;
    let bz = nPrev.z + nNext.z;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-4) {
      bx = nNext.x;
      bz = nNext.z;
    } else {
      bx /= bl;
      bz /= bl;
    }
    const dot = Math.max(0.62, bx * nNext.x + bz * nNext.z);
    const miter = Math.min(buf * 1.45, buf / dot);
    leftSide.push({
      x: round2(clampCoord(spine[i].x + bx * miter)),
      z: round2(clampCoord(spine[i].z + bz * miter)),
    });
    rightSide.push({
      x: round2(clampCoord(spine[i].x - bx * miter)),
      z: round2(clampCoord(spine[i].z - bz * miter)),
    });
  }

  // Торцевые скосы на старте и финише маршрута (чтобы старт и финиш имели запас buf вдоль дороги)
  const start = spine[0];
  const sNext = spine[1];
  const sLen = Math.hypot(sNext.x - start.x, sNext.z - start.z) || 1;
  const sBackX = -(sNext.x - start.x) / sLen;
  const sBackZ = -(sNext.z - start.z) / sLen;
  const sn0 = segNormals[0];

  const end = spine[spine.length - 1];
  const ePrev = spine[spine.length - 2];
  const eLen = Math.hypot(end.x - ePrev.x, end.z - ePrev.z) || 1;
  const eFwdX = (end.x - ePrev.x) / eLen;
  const eFwdZ = (end.z - ePrev.z) / eLen;
  const snLast = segNormals[segNormals.length - 1];

  const k = 0.72;
  const endCap: Vec2[] = [
    { x: round2(clampCoord(end.x + (eFwdX + snLast.x * k) * buf)), z: round2(clampCoord(end.z + (eFwdZ + snLast.z * k) * buf)) },
    { x: round2(clampCoord(end.x + (eFwdX - snLast.x * k) * buf)), z: round2(clampCoord(end.z + (eFwdZ - snLast.z * k) * buf)) },
  ];
  const startCap: Vec2[] = [
    { x: round2(clampCoord(start.x + (sBackX - sn0.x * k) * buf)), z: round2(clampCoord(start.z + (sBackZ - sn0.z * k) * buf)) },
    { x: round2(clampCoord(start.x + (sBackX + sn0.x * k) * buf)), z: round2(clampCoord(start.z + (sBackZ + sn0.z * k) * buf)) },
  ];

  const candidate = sanitizeBoundaryPolygon([...leftSide, ...endCap, ...rightSide.reverse(), ...startCap]);
  // Проверяем, что при резком развороте/петле коридор не самопересёкся и покрывает всю ось
  if (
    candidate &&
    isSimplePolygon(candidate) &&
    spine.every((pt) => isPointInPolygon(pt.x, pt.z, candidate))
  ) {
    return candidate;
  }

  // Надёжный запасной вариант для самопересекающихся петель и шпилек — выпуклая оболочка с буфером
  return buildConvexHullPolygon(spine, buf);
}

/** Вставляет новую вершину в середину выбранного ребра (или самого длинного ребра контура). */
export function insertBoundaryVertex(
  poly: readonly Vec2[],
  edgeIndex?: number
): { polygon: Vec2[]; insertedIndex: number } {
  if (poly.length < 3) {
    const base = boundsToPolygon({ minX: -24, maxX: 24, minZ: -24, maxZ: 24 });
    return { polygon: base, insertedIndex: 0 };
  }
  let idx = edgeIndex ?? -1;
  if (idx < 0 || idx >= poly.length) {
    let maxLen = -1;
    idx = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > maxLen) {
        maxLen = d;
        idx = i;
      }
    }
  }
  const a = poly[idx];
  const b = poly[(idx + 1) % poly.length];
  const mid: Vec2 = { x: round2((a.x + b.x) / 2), z: round2((a.z + b.z) / 2) };
  const next = [...poly.slice(0, idx + 1), mid, ...poly.slice(idx + 1)];
  return { polygon: next, insertedIndex: idx + 1 };
}

/** Удаляет вершину контура, если после удаления остаётся не менее 3 вершин. */
export function removeBoundaryVertex(poly: readonly Vec2[], index: number): Vec2[] | null {
  if (poly.length <= 3 || index < 0 || index >= poly.length) return null;
  const next = poly.filter((_, i) => i !== index);
  return isValidBoundaryPolygon(next) ? next : null;
}

/** Готовые неквадратные и вогнутые шаблоны формы площадки / границы игрового мира. */
export type BoundaryShapePreset =
  | "rect"
  | "l_shape"
  | "t_shape"
  | "u_shape"
  | "trapezoid"
  | "octagon";

export const BOUNDARY_SHAPE_PRESETS: ReadonlyArray<{
  id: BoundaryShapePreset;
  label: string;
  hint: string;
}> = [
  { id: "rect", label: "4 угла", hint: "Превратить прямоугольник в редактируемый 4-угольник (двигайте углы и добавляйте вершины)" },
  { id: "l_shape", label: "Г-образная", hint: "Вогнутая Г-образная площадка (6 вершин) с боковым карманом/проездом" },
  { id: "t_shape", label: "Т-образная", hint: "Вогнутая Т-образная площадка (8 вершин) для разворота в 3 приёма и заезда в бокс" },
  { id: "u_shape", label: "П-образная", hint: "Вогнутый П-образный дворик (8 вершин) с двумя рукавами" },
  { id: "trapezoid", label: "Трапеция", hint: "Трапециевидная площадка (4 вершины) с наклонными боковыми сторонами" },
  { id: "octagon", label: "8-угольник", hint: "Многоугольная площадка со скошенными углами (8 вершин)" },
];

/**
 * Строит готовый несамопересекающийся полигон площадки по текущему прямоугольнику `bounds`.
 * Нормализованные координаты `(u, v) ∈ [-1, 1]` переводятся в мир (`+X` влево/запад, `+Z` север).
 */
export function buildPresetBoundaryPolygon(preset: BoundaryShapePreset, bounds: WorldBounds): Vec2[] {
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cz = (bounds.minZ + bounds.maxZ) * 0.5;
  const hx = Math.max(10, (bounds.maxX - bounds.minX) * 0.5);
  const hz = Math.max(10, (bounds.maxZ - bounds.minZ) * 0.5);

  const pt = (u: number, v: number): Vec2 => ({
    x: round2(clampCoord(cx + u * hx)),
    z: round2(clampCoord(cz + v * hz)),
  });

  // Все шаблоны без самопересечений; для Г/Т/П-образных центр (0, 0) гарантированно лежит внутри площадки
  switch (preset) {
    case "rect":
      return [pt(1, 1), pt(-1, 1), pt(-1, -1), pt(1, -1)];
    case "l_shape":
      // Нижняя широкая часть + северный рукав; вырез в правом верхнем углу, центр и боксы внутри
      return [
        pt(1, 1),
        pt(-0.34, 1),
        pt(-0.34, 0.2),
        pt(-1, 0.2),
        pt(-1, -1),
        pt(1, -1),
      ];
    case "t_shape":
      // Широкая верхняя «перекладина» (север) + широкая центральная ножка (юг), центр и боксы внутри
      return [
        pt(1, 1),
        pt(-1, 1),
        pt(-1, 0.16),
        pt(-0.48, 0.16),
        pt(-0.48, -1),
        pt(0.48, -1),
        pt(0.48, 0.16),
        pt(1, 0.16),
      ];
    case "u_shape":
      // П-образный дворик: сплошное основание с юга и через центр + два выраженных северных рукава
      return [
        pt(1, 1),
        pt(0.32, 1),
        pt(0.32, 0.56),
        pt(-0.32, 0.56),
        pt(-0.32, 1),
        pt(-1, 1),
        pt(-1, -1),
        pt(1, -1),
      ];
    case "trapezoid":
      return [pt(0.68, 1), pt(-0.68, 1), pt(-1, -1), pt(1, -1)];
    case "octagon": {
      const k = 0.56;
      return [
        pt(k, 1),
        pt(-k, 1),
        pt(-1, k),
        pt(-1, -k),
        pt(-k, -1),
        pt(k, -1),
        pt(1, -k),
        pt(1, k),
      ];
    }
  }
}

/** Описатель прямолинейного сегмента бордюра вдоль одного ребра полигона площадки. */
export type BoundaryCurbSegment = {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  h: number;
};

/**
 * Генерирует сегменты физического бордюра по всем рёбрам произвольного полигона `poly`.
 * Бордюры сдвигаются на половину толщины наружу от контура, чтобы не уменьшать рабочую площадь.
 */
export function buildBoundaryCurbSegments(poly: readonly Vec2[], thickness = 0.28): BoundaryCurbSegment[] {
  if (!isValidBoundaryPolygon(poly)) return [];
  const halfT = Math.max(0.1, thickness * 0.5);
  // Знак площади в X-Z: area2 > 0 => внешняя нормаль ребра (dx, dz) равна (dz, -dx)/len
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area2 += a.x * b.z - b.x * a.z;
  }
  const sign = area2 >= 0 ? 1 : -1;

  const out: BoundaryCurbSegment[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.6) continue;
    const nx = (sign * dz) / len;
    const nz = (-sign * dx) / len;
    out.push({
      cx: round2((a.x + b.x) * 0.5 + nx * halfT),
      cz: round2((a.z + b.z) * 0.5 + nz * halfT),
      halfX: round2(halfT),
      halfZ: round2(len * 0.5),
      h: Number(Math.atan2(dx, dz).toFixed(4)),
    });
  }
  return out;
}

/**
 * Удерживает центр и углы кузова автомобиля внутри произвольного многоугольника границы мира
 * (как выпуклого, так и вогнутого — Г/Т/П-образные площадки, трапеции, коридоры маршрута).
 */
export function clampCarToWorldBoundary(
  x: number,
  z: number,
  h: number,
  halfWidth: number,
  halfLength: number,
  bounds: WorldBounds,
  boundaryPolygon?: readonly Vec2[]
): Vec2 {
  if (!isValidBoundaryPolygon(boundaryPolygon)) {
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
      z: Math.max(bounds.minZ, Math.min(bounds.maxZ, z)),
    };
  }
  // 1. Удерживаем центр автомобиля строго внутри полигона
  let pos = clampPointToWorldBoundary(x, z, bounds, boundaryPolygon);

  // 2. Если какой-то угол кузова вышел за ребро, мягко сдвигаем кузов внутрь (только если центр остаётся внутри)
  const sin = Math.sin(h);
  const cos = Math.cos(h);
  const fwdX = sin * halfLength;
  const fwdZ = cos * halfLength;
  const leftX = cos * halfWidth;
  const leftZ = -sin * halfWidth;
  const offsets: [number, number][] = [
    [fwdX + leftX, fwdZ + leftZ],
    [fwdX - leftX, fwdZ - leftZ],
    [-fwdX + leftX, -fwdZ + leftZ],
    [-fwdX - leftX, -fwdZ - leftZ],
  ];

  let pushX = 0;
  let pushZ = 0;
  let maxPen = 0;
  for (const [ox, oz] of offsets) {
    const cx = pos.x + ox;
    const cz = pos.z + oz;
    if (!isPointInPolygon(cx, cz, boundaryPolygon)) {
      const clamped = clampPointToWorldBoundary(cx, cz, bounds, boundaryPolygon);
      const dx = clamped.x - cx;
      const dz = clamped.z - cz;
      const pen = Math.hypot(dx, dz);
      if (pen > maxPen && pen <= halfLength + halfWidth) {
        maxPen = pen;
        pushX = dx;
        pushZ = dz;
      }
    }
  }
  if (maxPen > 1e-4) {
    const shiftedX = pos.x + pushX;
    const shiftedZ = pos.z + pushZ;
    if (isPointInPolygon(shiftedX, shiftedZ, boundaryPolygon)) {
      pos = { x: shiftedX, z: shiftedZ };
    }
  }
  return pos;
}
