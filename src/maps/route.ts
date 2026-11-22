/**
 * @module maps/route
 * @layer pure-core
 * @role Построение учебного маршрута по дорожной сети OSM: сшивка сегментов улиц, учёт произвольной границы и препятствий, кратчайший путь по графу дорог и улица в HUD.
 * @invariants #1 (координаты: правая полоса = смещение вдоль `(-cos h, sin h)`), #7 (чистое ядро без DOM и three), #8 (офлайн).
 * @tests T21, T30, T32, T33
 */
import { SpatialGrid } from "../sim/spatialGrid";
import type { ObstacleBox, RoadSegment, RouteCheckpoint, Vec2, WorldBounds } from "../sim/types";
import {
  clipPolylineToPolygon,
  closestPointOnSegment,
  isInsideWorldBoundary,
  isValidBoundaryPolygon,
} from "./boundary";

/** Производная осевая линия с квадратичными дугами в узлах; исходные RoadSegment.points не изменяются. */
export function roadGeometryPoints(points: readonly { x: number; z: number }[], radiusM = 0, steps = 6): { x: number; z: number }[] {
  if (!(radiusM > 0) || points.length < 3) return points.map((p) => ({ ...p }));
  const out: { x: number; z: number }[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], corner = points[i], next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.z - prev.z);
    const outLen = Math.hypot(next.x - corner.x, next.z - corner.z);
    if (inLen < 0.01 || outLen < 0.01) continue;
    const radius = Math.min(radiusM, inLen * 0.45, outLen * 0.45);
    const a = { x: corner.x + (prev.x - corner.x) / inLen * radius, z: corner.z + (prev.z - corner.z) / inLen * radius };
    const b = { x: corner.x + (next.x - corner.x) / outLen * radius, z: corner.z + (next.z - corner.z) / outLen * radius };
    const last = out[out.length - 1];
    if (Math.hypot(last.x - a.x, last.z - a.z) > 0.01) out.push(a);
    const count = Math.max(2, steps);
    for (let j = 1; j <= count; j++) {
      const t = j / count, u = 1 - t;
      out.push({ x: Number((u*u*a.x + 2*u*t*corner.x + t*t*b.x).toFixed(3)), z: Number((u*u*a.z + 2*u*t*corner.z + t*t*b.z).toFixed(3)) });
    }
  }
  const last = points[points.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].z - last.z) > 0.01) out.push({ ...last });
  return out;
}

const HIGHWAY_FALLBACK_NAMES: Record<string, string> = {
  primary: "Главная улица",
  primary_link: "Съезд главной улицы",
  secondary: "Городская улица",
  secondary_link: "Городской съезд",
  tertiary: "Районная улица",
  tertiary_link: "Районный съезд",
  residential: "Жилая улица",
  residential_link: "Жилой проезд",
  living_street: "Жилая зона",
  unclassified: "Учебная улица",
  road: "Дорога участка",
  trunk: "Магистраль",
  trunk_link: "Съезд магистрали",
  motorway: "Шоссе",
  motorway_link: "Съезд шоссе",
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

const MINOR_SERVICE_KINDS = new Set(["parking_aisle", "driveway", "alley", "emergency_access"]);

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
  /** Односторонний участок или круговое движение (реверс маршрута против потока запрещён). */
  oneway?: boolean;
  roundabout?: boolean;
  points: Vec2[];
};

export type BuildRouteOptions = {
  maxPoints?: number;
  spacing?: number;
  /** Явный выбор улицы/цепочки из `listRouteCandidates`. */
  candidateId?: string;
  /** Построить маршрут в обратном направлении по выбранной улице (игнорируется на `oneway`). */
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
  /** Истина, если выбранная улица односторонняя и запрошенный реверс был заблокирован по ПДД. */
  reverseBlocked?: boolean;
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
  segs: Array<{
    id: string;
    points: Vec2[];
    width: number;
    highway: string;
    name?: string;
    speedLimitKmh?: number;
    oneway?: boolean;
    roundabout?: boolean;
    service?: string;
  }>
): Array<{
  id: string;
  points: Vec2[];
  width: number;
  highway: string;
  name?: string;
  speedLimitKmh: number;
  count: number;
  oneway: boolean;
  roundabout: boolean;
  minorService: boolean;
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
    oneway: boolean;
    roundabout: boolean;
    minorService: boolean;
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
    let hasOneway = Boolean(seed.oneway);
    let hasRoundabout = Boolean(seed.roundabout);
    const minorService = Boolean(seed.service && MINOR_SERVICE_KINDS.has(seed.service));

    // Продолжаем цепочку вперёд и назад по совпадающим концам (без разворота односторонних улиц против потока)
    let extended = true;
    while (extended && count < 48) {
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
        // Не смешиваем одностороннюю проезжую часть бульвара с двусторонним участком в противоход
        if (Boolean(cand.oneway) !== hasOneway && cand.oneway) continue;
        const cp = cand.points;
        if (cp.length < 2) continue;
        const cStart = cp[0];
        const cEnd = cp[cp.length - 1];

        // Пристыковка к хвосту по ходу движения (cStart ≈ tail)
        if (Math.hypot(cStart.x - tail.x, cStart.z - tail.z) <= JOIN_TOL) {
          const d = Math.atan2(cp[1].x - cStart.x, cp[1].z - cStart.z);
          if (Math.cos(d - tailDir) > -0.35) {
            pts = [...pts, ...cp.slice(1).map((p) => ({ ...p }))];
            used[j] = true;
            widthSum += cand.width;
            if (!limit && cand.speedLimitKmh) limit = cand.speedLimitKmh;
            if (cand.oneway) hasOneway = true;
            if (cand.roundabout) hasRoundabout = true;
            count += 1;
            extended = true;
            break;
          }
        }
        // Пристыковка к хвосту с разворотом (cEnd ≈ tail) — ТОЛЬКО для двусторонних сегментов!
        if (!cand.oneway && !hasOneway && Math.hypot(cEnd.x - tail.x, cEnd.z - tail.z) <= JOIN_TOL) {
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
        // Пристыковка к началу по ходу движения (cEnd ≈ head)
        if (Math.hypot(cEnd.x - head.x, cEnd.z - head.z) <= JOIN_TOL) {
          const prev = cp[cp.length - 2];
          const d = Math.atan2(prev.x - cEnd.x, prev.z - cEnd.z);
          if (Math.cos(d - headDir) > -0.35) {
            pts = [...cp.slice(0, -1).map((p) => ({ ...p })), ...pts];
            used[j] = true;
            widthSum += cand.width;
            if (!limit && cand.speedLimitKmh) limit = cand.speedLimitKmh;
            if (cand.oneway) hasOneway = true;
            if (cand.roundabout) hasRoundabout = true;
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
      oneway: hasOneway,
      roundabout: hasRoundabout,
      minorService,
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
    oneway?: boolean;
    roundabout?: boolean;
    service?: string;
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
          oneway: r.oneway,
          roundabout: r.roundabout,
          service: r.service,
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
        oneway: r.oneway,
        roundabout: r.roundabout,
        service: r.service,
      });
    }
  }

  // Группируем названные улицы по имени (разделяя односторонние проезжие части бульваров и двусторонние)
  const byGroup = new Map<string, typeof prepared>();
  for (const seg of prepared) {
    const cleanName = seg.name?.trim();
    const owFlag = seg.oneway ? "1" : "0";
    const key = cleanName ? `n:${cleanName.toLowerCase()}:${owFlag}` : `u:${seg.highway}:${owFlag}`;
    const list = byGroup.get(key) ?? [];
    list.push(seg);
    byGroup.set(key, list);
  }

  const candidates: Array<RouteCandidate & { minorService: boolean }> = [];
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
        ...(ch.oneway ? { oneway: true } : {}),
        ...(ch.roundabout ? { roundabout: true } : {}),
        minorService: ch.minorService,
        points: ch.points,
      });
    }
  }

  // Приоритет: 1) названные городские улицы, 2) прочие названные, 3) безымянные городские, 4) проезды, 5) парковочные ряды
  const tier = (c: RouteCandidate & { minorService: boolean }): number => {
    if (c.minorService) return 4;
    if (c.roundabout && !c.named) return 3;
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

  return candidates.map(({ minorService: _ignored, ...rest }) => rest);
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

  // Не строим маршрут против шерсти на односторонней улице или кольце из реальной карты OSM
  const reverseBlocked = Boolean(opts?.reverse && chosen.oneway);
  const pts = opts?.reverse && !chosen.oneway ? [...chosen.points].reverse() : chosen.points;
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

  // Старт — позади первой точки на правой полосе (на узкой 1-полосной односторонней — по оси полосы)
  const desiredStartDist = Math.max(1, firstDist - Math.max(12, baseRadius + 5));
  const rightOffset =
    chosen.oneway && chosen.width < 5.6 ? 0 : Math.min(2.4, Math.max(0.9, chosen.width * 0.22));
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
    ...(reverseBlocked ? { reverseBlocked: true } : {}),
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
 * Ищет кратчайший путь по графу дорог OSM между двумя точками `(from → to)` (A* с евклидовой эвристикой).
 * Соединяет перекрёстки с общими и близкими узлами (до 4 м) и точки пересечения сегментов дорог.
 */
export function findRoadNetworkPath(
  roads: readonly RoadSegment[],
  from: Vec2,
  to: Vec2,
  maxSnapMarginM = 10
): { connected: boolean; path: Vec2[]; lengthM: number; roadNames: string[]; wrongWay?: boolean } {
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

  // Быстрый случай: обе точки на одном и том же сегменте/дороге (с учётом одностороннего движения `oneway`)
  let suspectedWrongWay = false;
  if (snapA.road.id === snapB.road.id) {
    const r = snapA.road;
    const distanceAlong = (snap: NonNullable<typeof snapA>): number => {
      let distance = 0;
      for (let i = 0; i < snap.segIndex; i++) {
        distance += Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z);
      }
      const a = r.points[snap.segIndex], b = r.points[snap.segIndex + 1];
      return distance + Math.hypot(b.x - a.x, b.z - a.z) * snap.t;
    };
    const posA = snapA.segIndex + snapA.t;
    const posB = snapB.segIndex + snapB.t;
    const distanceA = distanceAlong(snapA);
    const distanceB = distanceAlong(snapB);
    if (r.oneway && distanceA > distanceB + 0.75) {
      // Движение против одностороннего потока — ищем легальный объезд по графу дорог
      suspectedWrongWay = true;
    } else {
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
  }

  // Строим ориентированный граф дорожной сети с учётом oneway/layer.
  // Пространственные бакеты заменяют полный перебор узлов и сегментов на каждом шаге.
  type Edge = { to: number; w: number; roadName?: string };
  type GraphNode = { x: number; z: number; layer: number; isEndpoint: boolean };
  const nodes: GraphNode[] = [];
  const adj: Edge[][] = [];
  const roadVertexIds = new Map<string, number[]>();
  const nodeCellSize = 4;
  const nodeBuckets = new Map<string, number[]>();
  const cellKey = (x: number, z: number) => `${Math.floor(x / nodeCellSize)}:${Math.floor(z / nodeCellSize)}`;

  const addNode = (x: number, z: number, layer: number, isEndpoint: boolean): number => {
    const cx = Math.floor(x / nodeCellSize);
    const cz = Math.floor(z / nodeCellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidates = nodeBuckets.get(`${cx + dx}:${cz + dz}`);
        if (!candidates) continue;
        for (const i of candidates) {
          const nd = nodes[i];
          const sameLayer = nd.layer === layer;
          // Разные уровни стыкуются только в общей концевой вершине (≤ 1,2 м).
          const tol = sameLayer ? 3.2 : isEndpoint && nd.isEndpoint ? 1.2 : -1;
          if (tol < 0) continue;
          if (Math.abs(nd.x - x) <= tol && Math.abs(nd.z - z) <= tol &&
              Math.hypot(nd.x - x, nd.z - z) <= tol) {
            if (isEndpoint) nd.isEndpoint = true;
            return i;
          }
        }
      }
    }
    const id = nodes.length;
    nodes.push({ x, z, layer, isEndpoint });
    adj.push([]);
    const key = cellKey(x, z);
    const bucket = nodeBuckets.get(key);
    if (bucket) bucket.push(id);
    else nodeBuckets.set(key, [id]);
    return id;
  };

  const addDirEdge = (u: number, v: number, roadName?: string) => {
    if (u === v) return;
    const w = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
    adj[u].push({ to: v, w, roadName });
  };

  const addRoadEdge = (u: number, v: number, oneway: boolean, roadName?: string) => {
    addDirEdge(u, v, roadName);
    if (!oneway) addDirEdge(v, u, roadName);
  };

  for (const r of streetRoads) {
    const layer = r.layer ?? 0;
    const isOw = Boolean(r.oneway);
    const ids: number[] = [];
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i];
      ids.push(addNode(p.x, p.z, layer, i === 0 || i === r.points.length - 1));
    }
    for (let i = 0; i < ids.length - 1; i++) {
      addRoadEdge(ids[i], ids[i + 1], isOw, r.name);
    }
    roadVertexIds.set(r.id, ids);
  }

  // Индексируем дорожные сегменты по AABB с тем же запасом, что и точная проверка примыкания.
  type SegmentRef = { road: RoadSegment; u: number; v: number };
  const segmentCellSize = 32;
  const segmentBuckets = new Map<string, SegmentRef[]>();
  const segmentCellKey = (x: number, z: number) =>
    `${Math.floor(x / segmentCellSize)}:${Math.floor(z / segmentCellSize)}`;
  for (const road of streetRoads) {
    const ids = roadVertexIds.get(road.id);
    if (!ids) continue;
    const pad = road.width * 0.55 + 2.5;
    for (let i = 0; i < ids.length - 1; i++) {
      const u = ids[i], v = ids[i + 1];
      const a = nodes[u], b = nodes[v];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const parts = Math.max(1, Math.ceil(length / segmentCellSize));
      const coveredCells = new Set<string>();
      // Длинная геометрия делится только для индекса; точная проверка остаётся на исходном сегменте.
      for (let part = 0; part < parts; part++) {
        const t0 = part / parts, t1 = (part + 1) / parts;
        const ax = a.x + (b.x - a.x) * t0;
        const az = a.z + (b.z - a.z) * t0;
        const bx = a.x + (b.x - a.x) * t1;
        const bz = a.z + (b.z - a.z) * t1;
        const minX = Math.floor((Math.min(ax, bx) - pad) / segmentCellSize);
        const maxX = Math.floor((Math.max(ax, bx) + pad) / segmentCellSize);
        const minZ = Math.floor((Math.min(az, bz) - pad) / segmentCellSize);
        const maxZ = Math.floor((Math.max(az, bz) + pad) / segmentCellSize);
        for (let cx = minX; cx <= maxX; cx++) {
          for (let cz = minZ; cz <= maxZ; cz++) coveredCells.add(`${cx}:${cz}`);
        }
      }
      const ref = { road, u, v };
      for (const key of coveredCells) {
        const bucket = segmentBuckets.get(key);
        if (bucket) bucket.push(ref);
        else segmentBuckets.set(key, [ref]);
      }
    }
  }

  // Подсоединяем Т-образные примыкания на одном layer. Точная геометрическая проверка сохранена.
  for (const road of streetRoads) {
    const ids = roadVertexIds.get(road.id);
    if (!ids || ids.length < 2) continue;
    const roadLayer = road.layer ?? 0;
    const roadOneway = Boolean(road.oneway);
    const endSpecs: Array<{ idx: number; canExit: boolean; canEnter: boolean }> = [
      { idx: ids[0], canExit: !roadOneway, canEnter: true },
      { idx: ids[ids.length - 1], canExit: true, canEnter: !roadOneway },
    ];
    for (const end of endSpecs) {
      const ep = nodes[end.idx];
      const candidates = segmentBuckets.get(segmentCellKey(ep.x, ep.z)) ?? [];
      for (const segment of candidates) {
        const other = segment.road;
        if (other.id === road.id || (other.layer ?? 0) !== roadLayer) continue;
        const u = segment.u, v = segment.v;
        if (u === end.idx || v === end.idx) continue;
        const cp = closestPointOnSegment(ep.x, ep.z, nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z);
        if (cp.distSq <= Math.pow(other.width * 0.55 + 2.5, 2)) {
          const otherOneway = Boolean(other.oneway);
          if (end.canExit) {
            addDirEdge(end.idx, v, other.name);
            if (!otherOneway) addDirEdge(end.idx, u, other.name);
          }
          if (end.canEnter) {
            addDirEdge(u, end.idx, other.name);
            if (!otherOneway) addDirEdge(v, end.idx, other.name);
          }
        }
      }
    }
  }

  const attachSnap = (snap: NonNullable<typeof snapA>, role: "src" | "dst"): number => {
    const id = nodes.length;
    nodes.push({
      x: Number(snap.x.toFixed(2)),
      z: Number(snap.z.toFixed(2)),
      layer: snap.road.layer ?? 0,
      isEndpoint: false,
    });
    adj.push([]);
    const rids = roadVertexIds.get(snap.road.id);
    const oneway = Boolean(snap.road.oneway);
    if (rids) {
      const u = rids[snap.segIndex];
      const v = rids[snap.segIndex + 1];
      if (role === "src") {
        if (v !== undefined) addDirEdge(id, v, snap.road.name);
        if (!oneway && u !== undefined) addDirEdge(id, u, snap.road.name);
      } else {
        if (u !== undefined) addDirEdge(u, id, snap.road.name);
        if (!oneway && v !== undefined) addDirEdge(v, id, snap.road.name);
      }
    }
    return id;
  };

  const src = attachSnap(snapA, "src");
  const dst = attachSnap(snapB, "dst");
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const prevRoad: Array<string | undefined> = new Array(nodes.length);
  const closed = new Uint8Array(nodes.length);
  dist[src] = 0;

  // A* с евклидовой эвристикой: вес каждого ребра не меньше прямого расстояния между его узлами.
  type HeapItem = { id: number; g: number; f: number };
  const heap: HeapItem[] = [];
  const less = (a: HeapItem, b: HeapItem) =>
    a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && a.id < b.id)));
  const pushHeap = (item: HeapItem) => {
    let i = heap.length;
    heap.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const popHeap = (): HeapItem | undefined => {
    if (heap.length === 0) return undefined;
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i;
        if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return first;
  };

  const heuristic = (id: number) => Math.hypot(nodes[id].x - nodes[dst].x, nodes[id].z - nodes[dst].z);
  // Законный односторонний объезд может быть во много раз длиннее прямой дистанции.
  // Не вводим искусственный предел стоимости: A* завершится при извлечении dst либо исчерпании связной компоненты.
  pushHeap({ id: src, g: 0, f: heuristic(src) });
  while (heap.length > 0) {
    const current = popHeap()!;
    const u = current.id;
    if (closed[u] || current.g !== dist[u]) continue;
    closed[u] = 1;
    if (u === dst) break;
    for (const edge of adj[u]) {
      if (closed[edge.to]) continue;
      const nextG = current.g + edge.w;
      if (nextG < dist[edge.to]) {
        dist[edge.to] = nextG;
        prev[edge.to] = u;
        prevRoad[edge.to] = edge.roadName;
        pushHeap({ id: edge.to, g: nextG, f: nextG + heuristic(edge.to) });
      }
    }
  }

  if (!Number.isFinite(dist[dst])) {
    // Проверяем, был ли бы путь, если игнорировать `oneway` — чтобы точно диагностировать встречку
    if (!suspectedWrongWay && streetRoads.some((r) => r.oneway)) {
      const relaxed = streetRoads.map((r) => (r.oneway ? { ...r, oneway: false } : r));
      const anyDir = findRoadNetworkPath(relaxed, from, to, maxSnapMarginM);
      if (anyDir.connected) suspectedWrongWay = true;
    }
    return {
      connected: false,
      path: [from, to],
      lengthM: directLen,
      roadNames: [],
      ...(suspectedWrongWay ? { wrongWay: true } : {}),
    };
  }

  const path: Vec2[] = [];
  const reverseRoadNames: string[] = [];
  let cur = dst;
  while (cur !== -1) {
    path.push({ x: nodes[cur].x, z: nodes[cur].z });
    const rn = prevRoad[cur]?.trim();
    if (rn) reverseRoadNames.push(rn);
    cur = prev[cur];
  }
  path.reverse();
  reverseRoadNames.reverse();
  const roadNames: string[] = [];
  for (const name of reverseRoadNames) {
    if (roadNames[roadNames.length - 1] !== name) roadNames.push(name);
  }
  return {
    connected: true,
    path,
    lengthM: Number(polylineLength(path).toFixed(1)),
    roadNames,
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
