/**
 * @module maps/route
 * @layer pure-core
 * @role Построение учебного маршрута по дорожной сети OSM: сшивка сегментов улиц, учёт произвольной границы и препятствий, кратчайший путь по графу дорог и улица в HUD.
 * @invariants #1 (координаты: правая полоса = смещение вдоль `(-cos h, sin h)`), #7 (чистое ядро без DOM и three), #8 (офлайн).
 * @tests T21, T30, T32
 */
import { SpatialGrid } from "../sim/spatialGrid";
import type { ObstacleBox, RoadSegment, RouteCheckpoint, Vec2, WorldBounds } from "../sim/types";
import {
  clipPolylineToPolygon,
  closestPointOnSegment,
  isInsideWorldBoundary,
  isValidBoundaryPolygon,
} from "./boundary";

const HIGHWAY_FALLBACK_NAMES: Record<string, string> = {
  primary: "Главная улица",
  secondary: "Городская улица",
  tertiary: "Районная улица",
  residential: "Жилая улица",
  living_street: "Жилая зона",
  unclassified: "Учебная улица",
  trunk: "Магистраль",
  motorway: "Шоссе",
  service: "Учебный проезд",
};

const URBAN_HIGHWAYS = new Set([
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
]);

export type RouteCandidate = {
  id: string;
  name: string;
  named: boolean;
  urban: boolean;
  highway: string;
  width: number;
  speedLimitKmh: number;
  lengthM: number;
  segmentsCount: number;
  points: Vec2[];
};

export type BuildRouteOptions = {
  maxPoints?: number;
  spacing?: number;
  /** Явный выбор улицы/цепочки из `listRouteCandidates`. */
  candidateId?: string;
  /** Построить маршрут в обратном направлении по выбранной улице. */
  reverse?: boolean;
  /** Произвольный полигон границы (маршрут строится строго внутри него). */
  boundaryPolygon?: readonly Vec2[];
  /** Охватывающий прямоугольник (для проверки попадания старта и КТ). */
  bounds?: WorldBounds;
  /** Препятствия карты (для выбора стартовой позиции без контакта). */
  obstacles?: readonly ObstacleBox[];
};

export type BuiltRoute = {
  checkpoints: RouteCheckpoint[];
  roadName: string;
  speedLimitKmh: number;
  startPose: { x: number; z: number; h: number } | null;
  /** Осевая линия маршрута по дороге (для построения коридора границы). */
  spine: Vec2[];
  candidateId: string;
  totalLengthM: number;
};

/** Длина ломаной в метрах. */
export function polylineLength(pts: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  }
  return total;
}

/** Точка и локальный курс на полилинии на расстоянии `dist` от начала (м). */
export function samplePolyline(pts: readonly Vec2[], dist: number): { x: number; z: number; h: number } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 1e-6) continue;
    if (acc + len >= dist || i === pts.length - 2) {
      const t = Math.min(1, Math.max(0, (dist - acc) / len));
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        h: Math.atan2(b.x - a.x, b.z - a.z),
      };
    }
    acc += len;
  }
  const last = pts[pts.length - 1] ?? { x: 0, z: 0 };
  const prev = pts[pts.length - 2] ?? last;
  return { x: last.x, z: last.z, h: Math.atan2(last.x - prev.x, last.z - prev.z) };
}

/** Вырезает подучасток полилинии между расстояниями `[fromDist, toDist]`. */
function slicePolyline(pts: readonly Vec2[], fromDist: number, toDist: number): Vec2[] {
  if (pts.length < 2 || toDist <= fromDist) return pts.map((p) => ({ ...p }));
  const start = samplePolyline(pts, fromDist);
  const end = samplePolyline(pts, toDist);
  const out: Vec2[] = [{ x: Number(start.x.toFixed(2)), z: Number(start.z.toFixed(2)) }];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    acc += len;
    if (acc > fromDist + 0.5 && acc < toDist - 0.5) {
      out.push({ x: Number(pts[i + 1].x.toFixed(2)), z: Number(pts[i + 1].z.toFixed(2)) });
    }
  }
  out.push({ x: Number(end.x.toFixed(2)), z: Number(end.z.toFixed(2)) });
  return out;
}

/**
 * Сшивает подряд идущие сегменты одной улицы (в реальном OSM улицы часто разбиты на короткие `way`
 * по 15–40 м между перекрёстками и переходами).
 */
function stitchSegments(
  segs: Array<{ id: string; points: Vec2[]; width: number; highway: string; name?: string; speedLimitKmh?: number }>
): Array<{
  id: string;
  points: Vec2[];
  width: number;
  highway: string;
  name?: string;
  speedLimitKmh: number;
  count: number;
}> {
  const JOIN_TOL = 2.8;
  const used = new Array(segs.length).fill(false);
  const chains: Array<{
    id: string;
    points: Vec2[];
    width: number;
    highway: string;
    name?: string;
    speedLimitKmh: number;
    count: number;
  }> = [];

  // Начинаем сборку с самого длинного сегмента в группе
  const order = segs
    .map((s, idx) => ({ idx, len: polylineLength(s.points) }))
    .sort((a, b) => b.len - a.len)
    .map((x) => x.idx);

  for (const seedIdx of order) {
    if (used[seedIdx]) continue;
    used[seedIdx] = true;
    const seed = segs[seedIdx];
    let pts = seed.points.map((p) => ({ ...p }));
    let widthSum = seed.width;
    let count = 1;
    let limit = seed.speedLimitKmh ?? 0;

    // Продолжаем цепочку вперёд и назад по совпадающим концам (без резкого разворота > 110°)
    let extended = true;
    while (extended && count < 40) {
      extended = false;
      const head = pts[0];
      const headNext = pts[1];
      const tail = pts[pts.length - 1];
      const tailPrev = pts[pts.length - 2];
      const tailDir = Math.atan2(tail.x - tailPrev.x, tail.z - tailPrev.z);
      const headDir = Math.atan2(head.x - headNext.x, head.z - headNext.z);

      for (const j of order) {
        if (used[j]) continue;
        const cand = segs[j];
        const cp = cand.points;
        if (cp.length < 2) continue;
        const cStart = cp[0];
        const cEnd = cp[cp.length - 1];

        // Пристыковка к хвосту (прямо: cStart ≈ tail)
        if (Math.hypot(cStart.x - tail.x, cStart.z - tail.z) <= JOIN_TOL) {
          const d = Math.atan2(cp[1].x - cStart.x, cp[1].z - cStart.z);
          if (Math.cos(d - tailDir) > -0.35) {
            pts = [...pts, ...cp.slice(1).map((p) => ({ ...p }))];
            used[j] = true;
            widthSum += cand.width;
            if (!limit && cand.speedLimitKmh) limit = cand.speedLimitKmh;
            count += 1;
            extended = true;
            break;
          }
        }
        // Пристыковка к хвосту (развёрнуто: cEnd ≈ tail)
        if (Math.hypot(cEnd.x - tail.x, cEnd.z - tail.z) <= JOIN_TOL) {
          const prev = cp[cp.length - 2];
          const d = Math.atan2(prev.x - cEnd.x, prev.z - cEnd.z);
          if (Math.cos(d - tailDir) > -0.35) {
            const rev = [...cp].reverse().slice(1).map((p) => ({ ...p }));
            pts = [...pts, ...rev];
            used[j] = true;
            widthSum += cand.width;
            if (!limit && cand.speedLimitKmh) limit = cand.speedLimitKmh;
            count += 1;
            extended = true;
            break;
          }
        }
        // Пристыковка к началу (прямо: cEnd ≈ head)
        if (Math.hypot(cEnd.x - head.x, cEnd.z - head.z) <= JOIN_TOL) {
          const prev = cp[cp.length - 2];
          const d = Math.atan2(prev.x - cEnd.x, prev.z - cEnd.z);
          if (Math.cos(d - headDir) > -0.35) {
            pts = [...cp.slice(0, -1).map((p) => ({ ...p })), ...pts];
            used[j] = true;
            widthSum += cand.width;
            if (!limit && cand.speedLimitKmh) limit = cand.speedLimitKmh;
            count += 1;
            extended = true;
            break;
          }
        }
      }
    }

    chains.push({
      id: seed.id,
      points: pts,
      width: Number((widthSum / count).toFixed(2)),
      highway: seed.highway,
      name: seed.name,
      speedLimitKmh: limit,
      count,
    });
  }

  return chains;
}

/**
 * Возвращает отсортированный список улиц и дорожных цепочек, пригодных для учебного маршрута.
 * Учитывает произвольную границу `boundaryPolygon`, сшивает сегменты одной улицы и поддерживает безымянные дороги OSM.
 */
export function listRouteCandidates(
  roads: readonly RoadSegment[],
  boundaryPolygon?: readonly Vec2[],
  minLengthM = 18
): RouteCandidate[] {
  const hasPoly = isValidBoundaryPolygon(boundaryPolygon);
  const prepared: Array<{
    id: string;
    points: Vec2[];
    width: number;
    highway: string;
    name?: string;
    speedLimitKmh?: number;
  }> = [];

  for (const r of roads) {
    if (r.id === "custom-lot" || !Array.isArray(r.points) || r.points.length < 2) continue;
    if (hasPoly) {
      const clipped = clipPolylineToPolygon(r.points, boundaryPolygon);
      clipped.forEach((pts, idx) => {
        prepared.push({
          id: idx === 0 ? r.id : `${r.id}#${idx + 1}`,
          points: pts,
          width: r.width,
          highway: r.highway,
          name: r.name,
          speedLimitKmh: r.speedLimitKmh,
        });
      });
    } else {
      prepared.push({
        id: r.id,
        points: r.points.map((p) => ({ ...p })),
        width: r.width,
        highway: r.highway,
        name: r.name,
        speedLimitKmh: r.speedLimitKmh,
      });
    }
  }

  // Группируем названные улицы по нормализованному имени для сшивки, безымянные — по классу highway
  const byGroup = new Map<string, typeof prepared>();
  for (const seg of prepared) {
    const cleanName = seg.name?.trim();
    const key = cleanName ? `n:${cleanName.toLowerCase()}` : `u:${seg.highway}`;
    const list = byGroup.get(key) ?? [];
    list.push(seg);
    byGroup.set(key, list);
  }

  const candidates: RouteCandidate[] = [];
  let unnamedIdx = 1;
  for (const group of byGroup.values()) {
    const stitched = stitchSegments(group);
    for (const ch of stitched) {
      const lengthM = Number(polylineLength(ch.points).toFixed(1));
      if (lengthM < minLengthM) continue;
      const named = Boolean(ch.name?.trim());
      const baseName = named
        ? ch.name!.trim()
        : `${HIGHWAY_FALLBACK_NAMES[ch.highway] ?? "Учебная улица"} #${unnamedIdx++}`;
      candidates.push({
        id: ch.id,
        name: baseName,
        named,
        urban: URBAN_HIGHWAYS.has(ch.highway),
        highway: ch.highway,
        width: ch.width,
        speedLimitKmh: ch.speedLimitKmh,
        lengthM,
        segmentsCount: ch.count,
        points: ch.points,
      });
    }
  }

  // Приоритет: 1) названные городские улицы, 2) прочие названные, 3) безымянные городские, 4) остальные; внутри — по длине
  const tier = (c: RouteCandidate): number => {
    if (c.named && c.urban) return 0;
    if (c.named) return 1;
    if (c.urban) return 2;
    return 3;
  };
  candidates.sort((a, b) => {
    const dt = tier(a) - tier(b);
    if (dt !== 0) return dt;
    return b.lengthM - a.lengthM;
  });

  return candidates;
}

function makeSlug(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, "-").replace(/["'<>]/g, "");
  return cleaned.slice(0, 32) || "street";
}

/**
 * Строит экзаменационный маршрут вдоль выбранной или лучшей дороги участка OSM.
 * Сшивает разорванные сегменты улиц, поддерживает безымянные и короткие дороги,
 * учитывает произвольную полигональную границу и избегает контакта с препятствиями на старте.
 */
export function buildRouteFromRoads(
  roads: readonly RoadSegment[],
  opts?: BuildRouteOptions
): BuiltRoute {
  const maxPoints = Math.max(1, Math.min(12, opts?.maxPoints ?? 6));
  const spacing = Math.max(8, opts?.spacing ?? 24);
  const minLen = Math.min(20, Math.max(12, spacing * 0.75));
  const candidates = listRouteCandidates(roads, opts?.boundaryPolygon, minLen);

  const chosen = opts?.candidateId
    ? candidates.find(
        (c) => c.id === opts.candidateId || c.id.split("+").includes(opts.candidateId!)
      ) ?? candidates[0]
    : candidates[0];

  if (!chosen) {
    return {
      checkpoints: [],
      roadName: "",
      speedLimitKmh: 0,
      startPose: null,
      spine: [],
      candidateId: "",
      totalLengthM: 0,
    };
  }

  const pts = opts?.reverse ? [...chosen.points].reverse() : chosen.points;
  const street = chosen.name;
  const limit = chosen.speedLimitKmh;
  const total = polylineLength(pts);
  const count = Math.max(1, Math.min(maxPoints, Math.floor(total / spacing)));

  // Адаптивный радиус КТ: на широких 4–6-полосных улицах автомобиль в правой полосе надёжно попадает в зону
  const baseRadius = Math.min(14, Math.max(6, Number((chosen.width * 0.5 + 1.5).toFixed(1))));
  const lastRadius = Math.min(15, Math.max(7.5, Number((baseRadius + 1.5).toFixed(1))));
  const slug = makeSlug(street);

  // Оставляем на старте место для разгона и постановки автомобиля до первой КТ
  const startDistBase = Math.min(Math.max(2, total * 0.06), 12);
  const firstDist =
    count === 1
      ? Math.max(startDistBase + baseRadius + 4, total * 0.72)
      : Math.max(startDistBase + baseRadius + 4, total / (count + 1));
  const lastDist = Math.max(firstDist, total - Math.min(14, total * 0.1));

  const checkpoints: RouteCheckpoint[] = [];
  for (let i = 0; i < count; i++) {
    const dist =
      count === 1
        ? Math.min(total - 1, firstDist)
        : firstDist + ((lastDist - firstDist) * i) / (count - 1);
    const { x, z } = samplePolyline(pts, dist);
    const last = i === count - 1;
    checkpoints.push({
      id: `route-${slug}-${i + 1}`,
      x: Number(x.toFixed(1)),
      z: Number(z.toFixed(1)),
      radius: last ? lastRadius : baseRadius,
      instruction: last
        ? `Финиш маршрута на «${street}»${limit ? ` (ограничение ${limit} км/ч)` : ""} — остановитесь в границах проезжей части.`
        : `Продолжайте движение по «${street}», точка ${i + 1}/${count}${limit ? `, ограничение ${limit} км/ч` : ""}. Держите полосу.`,
      requireSignal: undefined,
      isFinalPark: false,
    });
  }

  // Старт — позади первой точки на правой полосе (-left = (-cos h, sin h)), без контакта с препятствиями
  const desiredStartDist = Math.max(1, firstDist - Math.max(12, baseRadius + 5));
  const rightOffset = Math.min(2.4, Math.max(0.9, chosen.width * 0.22));
  const buildStartAt = (dAlong: number, latOffset: number) => {
    const sp = samplePolyline(pts, Math.max(0, Math.min(total - 1, dAlong)));
    const ahead = samplePolyline(pts, Math.min(total, Math.max(dAlong + 3, firstDist)));
    const h = Math.hypot(ahead.x - sp.x, ahead.z - sp.z) > 0.5 ? Math.atan2(ahead.x - sp.x, ahead.z - sp.z) : sp.h;
    const rx = -Math.cos(h) * latOffset;
    const rz = Math.sin(h) * latOffset;
    return {
      x: Number((sp.x + rx).toFixed(1)),
      z: Number((sp.z + rz).toFixed(1)),
      h: Number(h.toFixed(3)),
    };
  };

  let startPose = buildStartAt(desiredStartDist, rightOffset);

  // Если переданы препятствия или произвольная граница — подбираем ближайшую свободную точку старта
  if ((opts?.obstacles && opts.obstacles.length > 0) || isValidBoundaryPolygon(opts?.boundaryPolygon)) {
    const grid = new SpatialGrid(opts?.obstacles ?? [], 10);
    const cp0 = checkpoints[0];
    const isGoodPose = (pose: { x: number; z: number; h: number }): boolean => {
      if (opts?.bounds && !isInsideWorldBoundary(pose.x, pose.z, opts.bounds, opts?.boundaryPolygon)) {
        return false;
      }
      if (!opts?.bounds && isValidBoundaryPolygon(opts?.boundaryPolygon)) {
        const bb = { minX: -3000, maxX: 3000, minZ: -3000, maxZ: 3000 };
        if (!isInsideWorldBoundary(pose.x, pose.z, bb, opts.boundaryPolygon)) return false;
      }
      if (cp0 && Math.hypot(pose.x - cp0.x, pose.z - cp0.z) < cp0.radius + 0.8) {
        return false;
      }
      return !grid.queryCarHit(pose.x, pose.z, pose.h).hit;
    };

    if (!isGoodPose(startPose)) {
      const alongShifts = [0, 3, -3, 6, -6, 9, 12];
      const latCandidates = [rightOffset, rightOffset * 0.5, 0, Math.min(3.2, chosen.width * 0.3)];
      let found = false;
      for (const ds of alongShifts) {
        if (found) break;
        for (const lat of latCandidates) {
          const cand = buildStartAt(desiredStartDist + ds, lat);
          if (isGoodPose(cand)) {
            startPose = cand;
            found = true;
            break;
          }
        }
      }
    }
  }

  const spine = slicePolyline(pts, Math.max(0, desiredStartDist - 4), Math.min(total, lastDist + 4));
  const routeLen = Number(Math.max(0, lastDist - desiredStartDist).toFixed(1));

  return {
    checkpoints,
    roadName: street,
    speedLimitKmh: limit,
    startPose,
    spine,
    candidateId: chosen.id,
    totalLengthM: routeLen,
  };
}

/** Находит ближайшую точку на дорожной сети (для привязки и проверки маршрута). */
export function nearestRoadPoint(
  x: number,
  z: number,
  roads: readonly RoadSegment[]
): { road: RoadSegment; segIndex: number; t: number; x: number; z: number; dist: number; h: number } | null {
  let best: { road: RoadSegment; segIndex: number; t: number; x: number; z: number; dist: number; h: number } | null =
    null;
  for (const road of roads) {
    if (road.id === "custom-lot" || road.points.length < 2) continue;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const cp = closestPointOnSegment(x, z, a.x, a.z, b.x, b.z);
      const dist = Math.sqrt(cp.distSq);
      if (!best || dist < best.dist) {
        best = {
          road,
          segIndex: i,
          t: cp.t,
          x: cp.x,
          z: cp.z,
          dist,
          h: Math.atan2(b.x - a.x, b.z - a.z),
        };
      }
    }
  }
  return best;
}

/**
 * Ищет кратчайший путь по графу дорог OSM между двумя точками `(from → to)` (алгоритм Дейкстры).
 * Соединяет перекрёстки с общими и близкими узлами (до 4 м) и точки пересечения сегментов дорог.
 */
export function findRoadNetworkPath(
  roads: readonly RoadSegment[],
  from: Vec2,
  to: Vec2,
  maxSnapMarginM = 10
): { connected: boolean; path: Vec2[]; lengthM: number; roadNames: string[] } {
  const streetRoads = roads.filter((r) => r.id !== "custom-lot" && r.points.length >= 2);
  const directLen = Number(Math.hypot(to.x - from.x, to.z - from.z).toFixed(1));
  if (streetRoads.length === 0) {
    return { connected: false, path: [from, to], lengthM: directLen, roadNames: [] };
  }

  const snapA = nearestRoadPoint(from.x, from.z, streetRoads);
  const snapB = nearestRoadPoint(to.x, to.z, streetRoads);
  if (
    !snapA ||
    !snapB ||
    snapA.dist > snapA.road.width / 2 + maxSnapMarginM ||
    snapB.dist > snapB.road.width / 2 + maxSnapMarginM
  ) {
    return { connected: false, path: [from, to], lengthM: directLen, roadNames: [] };
  }

  // Быстрый случай: обе точки на одном и том же сегменте/дороге
  if (snapA.road.id === snapB.road.id) {
    const r = snapA.road;
    const posA = snapA.segIndex + snapA.t;
    const posB = snapB.segIndex + snapB.t;
    const mid: Vec2[] = [{ x: Number(snapA.x.toFixed(2)), z: Number(snapA.z.toFixed(2)) }];
    if (posA <= posB) {
      for (let k = snapA.segIndex + 1; k <= snapB.segIndex; k++) {
        mid.push({ x: r.points[k].x, z: r.points[k].z });
      }
    } else {
      for (let k = snapA.segIndex; k > snapB.segIndex; k--) {
        mid.push({ x: r.points[k].x, z: r.points[k].z });
      }
    }
    mid.push({ x: Number(snapB.x.toFixed(2)), z: Number(snapB.z.toFixed(2)) });
    const names = r.name?.trim() ? [r.name.trim()] : [];
    return {
      connected: true,
      path: mid,
      lengthM: Number(polylineLength(mid).toFixed(1)),
      roadNames: names,
    };
  }

  // Строим компактный граф узлов дорожной сети (до 1200 узлов — мгновенно для квартала OSM)
  type Edge = { to: number; w: number; roadName?: string };
  const nodes: Vec2[] = [];
  const adj: Edge[][] = [];
  const roadVertexIds = new Map<string, number[]>();

  const addNode = (x: number, z: number): number => {
    // Склеиваем совпадающие узлы перекрёстков в радиусе 3.2 м
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i].x - x) <= 3.2 && Math.abs(nodes[i].z - z) <= 3.2) {
        if (Math.hypot(nodes[i].x - x, nodes[i].z - z) <= 3.2) return i;
      }
    }
    const id = nodes.length;
    nodes.push({ x, z });
    adj.push([]);
    return id;
  };

  const addBiEdge = (u: number, v: number, roadName?: string) => {
    if (u === v) return;
    const w = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
    adj[u].push({ to: v, w, roadName });
    adj[v].push({ to: u, w, roadName });
  };

  for (const r of streetRoads) {
    if (nodes.length > 1400) break;
    const ids: number[] = [];
    for (const p of r.points) ids.push(addNode(p.x, p.z));
    for (let i = 0; i < ids.length - 1; i++) addBiEdge(ids[i], ids[i + 1], r.name);
    roadVertexIds.set(r.id, ids);
  }

  // Подсоединяем Т-образные примыкания (конец одной дороги лежит на ребре другой в пределах 4 м)
  for (const r of streetRoads) {
    const ids = roadVertexIds.get(r.id);
    if (!ids || ids.length < 2) continue;
    for (const endIdx of [ids[0], ids[ids.length - 1]]) {
      const ep = nodes[endIdx];
      for (const other of streetRoads) {
        if (other.id === r.id) continue;
        const oids = roadVertexIds.get(other.id);
        if (!oids) continue;
        for (let i = 0; i < oids.length - 1; i++) {
          const u = oids[i];
          const v = oids[i + 1];
          if (u === endIdx || v === endIdx) continue;
          const cp = closestPointOnSegment(ep.x, ep.z, nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z);
          if (cp.distSq <= Math.pow(other.width * 0.55 + 2.5, 2)) {
            addBiEdge(endIdx, u, other.name);
            addBiEdge(endIdx, v, other.name);
          }
        }
      }
    }
  }

  const attachSnap = (snap: NonNullable<typeof snapA>): number => {
    const id = nodes.length;
    nodes.push({ x: Number(snap.x.toFixed(2)), z: Number(snap.z.toFixed(2)) });
    adj.push([]);
    const rids = roadVertexIds.get(snap.road.id);
    if (rids) {
      const u = rids[snap.segIndex];
      const v = rids[snap.segIndex + 1];
      if (u !== undefined) addBiEdge(id, u, snap.road.name);
      if (v !== undefined) addBiEdge(id, v, snap.road.name);
    }
    return id;
  };

  const src = attachSnap(snapA);
  const dst = attachSnap(snapB);

  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const prevRoad: Array<string | undefined> = new Array(nodes.length);
  const visited = new Uint8Array(nodes.length);
  dist[src] = 0;

  for (let step = 0; step < nodes.length; step++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u === -1 || u === dst || best > directLen * 6 + 400) break;
    visited[u] = 1;
    for (const e of adj[u]) {
      const nd = best + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        prevRoad[e.to] = e.roadName;
      }
    }
  }

  if (!Number.isFinite(dist[dst])) {
    return { connected: false, path: [from, to], lengthM: directLen, roadNames: [] };
  }

  const path: Vec2[] = [];
  const nameSet = new Set<string>();
  let cur = dst;
  while (cur !== -1) {
    path.push(nodes[cur]);
    const rn = prevRoad[cur]?.trim();
    if (rn) nameSet.add(rn);
    cur = prev[cur];
  }
  path.reverse();
  return {
    connected: true,
    path,
    lengthM: Number(polylineLength(path).toFixed(1)),
    roadNames: Array.from(nameSet),
  };
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
    if (road.id === "custom-lot") continue;
    if (!road.name?.trim()) continue;
    const pts = road.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const cp = closestPointOnSegment(x, z, a.x, a.z, b.x, b.z);
      const d = Math.sqrt(cp.distSq);
      if (d < bestDist) {
        bestDist = d;
        best = road;
      }
    }
  }
  if (!best) return null;
  return { name: best.name!.trim(), limitKmh: best.speedLimitKmh };
}
