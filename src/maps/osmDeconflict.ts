/**
 * @module maps/osmDeconflict
 * @layer pure-core
 * @role Геодезическая точность WGS84 и автоматическое устранение конфликтов при импорте и правке реальных карт OSM/GeoJSON (здания/дворы, заборы/ворота, деревья, знаки, светофоры, переходы, зоны скорости, односторонние улицы и уровни layer).
 * @invariants #1 (координаты +Z север, +X запад/лево, −X восток/право), #7 (чистое ядро без DOM и three), #8 (офлайн).
 * @tests T30, T31, T33
 */
import type {
  CrosswalkDef,
  ObstacleBox,
  RoadSegment,
  RoadSignDef,
  SpeedZone,
  TrafficSignalDef,
  Vec2,
  WorldBounds,
} from "../sim/types";
import { closestPointOnSegment, isPointInPolygon, MAX_WORLD_COORD, polygonArea } from "./boundary";

const round2 = (v: number): number => Number(v.toFixed(2));
const round3 = (v: number): number => Number(v.toFixed(3));

/** Нормализует угол курса в диапазон `(-π, π]`. */
export function normalizeHeading(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// ───────── Локальная касательная проекция на эллипсоиде WGS84 ─────────

const WGS84_A = 6_378_137.0;
const WGS84_E2 = 0.00669437999014;

export type Wgs84Projector = {
  originLat: number;
  originLon: number;
  mPerLat: number;
  mPerLon: number;
  /** Переводит `(lat, lon)` WGS84 в локальные метры симулятора (`+Z` север, `−X` восток, `+X` запад). */
  project: (lat: number, lon: number) => Vec2;
  /** Обратный перевод локальных метров `(x, z)` в географические координаты `(lat, lon)` WGS84. */
  unproject: (x: number, z: number) => { lat: number; lon: number };
};

/**
 * Создаёт точную локальную касательную проекцию на эллипсоиде WGS84 (радиусы кривизны `R_M(φ)` и `R_N(φ)·cos φ`).
 * Убирает искажение пропорций С–Ю / З–В на средних и высоких широтах и позволяет точно перепроецировать объекты.
 */
export function createWgs84Projector(originLat: number, originLon: number): Wgs84Projector {
  const safeLat = Math.max(-85, Math.min(85, originLat));
  const phi = (safeLat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const mPerLat = (Math.PI / 180) * ((WGS84_A * (1 - WGS84_E2)) / (denom * denom * denom));
  const mPerLon = (Math.PI / 180) * (WGS84_A / denom) * Math.cos(phi);

  return {
    originLat: Number(safeLat.toFixed(7)),
    originLon: Number(originLon.toFixed(7)),
    mPerLat,
    mPerLon: Math.max(1, mPerLon),
    project: (lat: number, lon: number): Vec2 => ({
      x: round2(-(lon - originLon) * mPerLon),
      z: round2((lat - safeLat) * mPerLat),
    }),
    unproject: (x: number, z: number): { lat: number; lon: number } => ({
      lat: safeLat + z / mPerLat,
      lon: originLon - x / Math.max(1, mPerLon),
    }),
  };
}

/**
 * Переводит точку `(x, z)` из системы координат одной выгрузки OSM в систему другой выгрузки по точному якорю WGS84.
 * Возвращает `null`, если выгрузки относятся к разным районам (дальше `maxOriginShiftM`, по умолчанию 12 км).
 */
export function reprojectBetweenOrigins(
  pt: Vec2,
  fromOrigin: { lat: number; lon: number },
  toOrigin: { lat: number; lon: number },
  maxOriginShiftM = 12_000
): Vec2 | null {
  const toProj = createWgs84Projector(toOrigin.lat, toOrigin.lon);
  const originDelta = toProj.project(fromOrigin.lat, fromOrigin.lon);
  if (Math.hypot(originDelta.x, originDelta.z) > maxOriginShiftM) return null;
  const fromProj = createWgs84Projector(fromOrigin.lat, fromOrigin.lon);
  const geo = fromProj.unproject(pt.x, pt.z);
  return toProj.project(geo.lat, geo.lon);
}

// ───────── Разбор реальных тегов, единиц измерения и правил движения OSM ─────────

const REGIONAL_MAXSPEED_KMH: Record<string, number> = {
  "ru:urban": 60,
  "ru:rural": 90,
  "ru:living_street": 20,
  "ru:motorway": 110,
  "by:urban": 60,
  "by:rural": 90,
  "by:living_street": 20,
  "by:motorway": 110,
  "kz:urban": 60,
  "kz:rural": 100,
  "kz:living_street": 20,
  "ua:urban": 50,
  "ua:rural": 90,
  "ua:living_street": 20,
  "de:urban": 50,
  "de:rural": 100,
  "de:living_street": 10,
  "de:zone30": 30,
  "de:zone:30": 30,
  "de:zone:20": 20,
  "eu:urban": 50,
  "fr:urban": 50,
  "pl:urban": 50,
  "it:urban": 50,
  "es:urban": 50,
  "cz:urban": 50,
  "fi:urban": 50,
  "ca:urban": 50,
  "gb:nsl_single": 96,
  "gb:nsl_dual": 110,
  "gb:motorway": 110,
  walk: 10,
};

/**
 * Разбирает реальный тег `maxspeed` из OSM в км/ч:
 * поддерживает км/ч, `mph`, `knots`, `walk`, `none` и региональные коды (`RU:urban`, `RU:living_street`, `DE:zone30` и др.).
 */
export function parseOsmMaxspeedKmh(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "none" || s === "signals" || s === "variable" || s === "default" || s === "implicit") {
    return null;
  }
  if (REGIONAL_MAXSPEED_KMH[s] !== undefined) {
    return REGIONAL_MAXSPEED_KMH[s];
  }
  if (s.endsWith(":living_street")) return 20;
  if (s.endsWith(":zone20") || s.endsWith(":zone:20")) return 20;
  if (s.endsWith(":zone30") || s.endsWith(":zone:30")) return 30;
  if (s.endsWith(":urban")) return 50;
  if (s.endsWith(":rural")) return 90;
  if (s.endsWith(":motorway")) return 110;

  const numMatch = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!numMatch) return null;
  const val = Number(numMatch[1].replace(",", "."));
  if (!Number.isFinite(val) || val <= 0) return null;

  let kmh = val;
  if (/\bmph\b/.test(s)) {
    kmh = Math.round(val * 1.609344);
  } else if (/\bknots?\b/.test(s)) {
    kmh = Math.round(val * 1.852);
  } else {
    kmh = Math.round(val);
  }
  return Math.min(110, Math.max(5, kmh));
}

/**
 * Разбирает линейный размер OSM (`width`, `height`, `min_height`) в метрах:
 * поддерживает `7.5`, `7,5 m`, `250 cm`, `24 ft` и футы-дюймы `12'6"`.
 */
export function parseOsmMeters(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // Футы и дюймы вида 14'6" или 14'
  const ftIn = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (ftIn) {
    const ft = Number(ftIn[1]);
    const inch = ftIn[2] ? Number(ftIn[2]) : 0;
    const m = ft * 0.3048 + inch * 0.0254;
    return Number.isFinite(m) ? m : null;
  }

  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const val = Number(m[0].replace(",", "."));
  if (!Number.isFinite(val)) return null;

  if (/\b(?:ft|feet|foot)\b/.test(s)) return val * 0.3048;
  if (/\bcm\b/.test(s)) return val * 0.01;
  if (/\bmm\b/.test(s)) return val * 0.001;
  if (/\bmi\b/.test(s)) return val * 1609.344;
  return val;
}

/** Определяет вертикальный уровень `layer` дороги/объекта OSM (`0` — земля, `>0` — мост, `<0` — тоннель). */
export function parseOsmLayer(tags: Record<string, string>): number {
  if (tags.layer !== undefined) {
    const m = String(tags.layer).match(/-?\d+/);
    if (m) {
      const n = Number.parseInt(m[0], 10);
      if (Number.isFinite(n)) return Math.max(-5, Math.min(5, n));
    }
  }
  const bridge = (tags.bridge ?? "").toLowerCase();
  if (bridge && bridge !== "no" && bridge !== "false" && bridge !== "0") return 1;
  const tunnel = (tags.tunnel ?? "").toLowerCase();
  if (tunnel && tunnel !== "no" && tunnel !== "false" && tunnel !== "0") return -1;
  return 0;
}

/** Определяет односторонность, необходимость разворота узлов и признак кольца для `way` OSM. */
export function parseOsmOneway(
  tags: Record<string, string>,
  highway: string
): { oneway: boolean; reverse: boolean; roundabout: boolean } {
  const junc = (tags.junction ?? "").toLowerCase();
  const roundabout = junc === "roundabout" || junc === "circular";
  const raw = (tags.oneway ?? "").trim().toLowerCase();

  if (raw === "-1" || raw === "reverse") {
    return { oneway: true, reverse: true, roundabout };
  }
  if (raw === "no" || raw === "0" || raw === "false") {
    return { oneway: false, reverse: false, roundabout };
  }
  if (raw === "yes" || raw === "1" || raw === "true" || raw === "reversible" || raw === "alternating") {
    return { oneway: raw !== "alternating", reverse: false, roundabout };
  }
  if (roundabout || highway === "motorway" || highway === "motorway_link") {
    return { oneway: true, reverse: false, roundabout };
  }
  return { oneway: false, reverse: false, roundabout: false };
}

const ALLOWED_MOTOR_ACCESS = new Set(["yes", "designated", "official", "permissive", "destination", "customers", "delivery"]);
const FORBIDDEN_ACCESS = new Set(["no", "false", "0", "forestry", "agricultural", "emergency", "bus", "psv", "foot"]);

/**
 * Проверяет, является ли линия OSM реальной проезжей автомобильной дорогой
 * (отсеивает площадные контуры `area=yes`, строящиеся/закрытые и запрещённые для легковых авто участки).
 */
export function isDrivableOsmWay(tags: Record<string, string>, supportedHighway: boolean): boolean {
  if (!supportedHighway) return false;
  if (tags.area === "yes") return false;
  if (tags.indoor === "yes" || tags.abandoned === "yes" || tags.disused === "yes" || tags.razed === "yes") {
    return false;
  }
  if (tags.highway === "busway") return false;

  const motorcar = (tags.motorcar ?? "").toLowerCase();
  const motorVeh = (tags.motor_vehicle ?? "").toLowerCase();
  const vehicle = (tags.vehicle ?? "").toLowerCase();
  const access = (tags.access ?? "").toLowerCase();

  if (ALLOWED_MOTOR_ACCESS.has(motorcar) || ALLOWED_MOTOR_ACCESS.has(motorVeh)) return true;
  if (FORBIDDEN_ACCESS.has(motorcar) || FORBIDDEN_ACCESS.has(motorVeh) || FORBIDDEN_ACCESS.has(vehicle)) {
    return false;
  }
  if (FORBIDDEN_ACCESS.has(access)) return false;
  if (tags.service === "emergency_access" || tags.service === "drive-through") return false;
  return true;
}

const NON_BLOCKING_BUILDINGS = new Set([
  "no",
  "false",
  "roof",
  "carport",
  "canopy",
  "bridge",
  "skyway",
  "ruins",
  "construction",
  "proposed",
  "demolished",
  "collapsed",
  "grandstand",
]);

const NON_BLOCKING_LOCATIONS = new Set(["underground", "underwater", "roof", "overhead", "bridge"]);

/**
 * Определяет сооружения OSM, которые НЕ являются наземным сплошным препятствием для автомобиля:
 * навесы АЗС (`building=roof`), подземные паркинги/переходы (`location=underground`, `layer<0`),
 * надземные переходы (`building=bridge`), арки домов (`min_height >= 3.2 м`) и т. п.
 */
export function isNonBlockingBuilding(tags: Record<string, string>): boolean {
  const b = (tags.building ?? "").trim().toLowerCase();
  if (!b || NON_BLOCKING_BUILDINGS.has(b)) return true;
  const loc = (tags.location ?? "").trim().toLowerCase();
  if (NON_BLOCKING_LOCATIONS.has(loc)) return true;
  const bridge = (tags.bridge ?? "").trim().toLowerCase();
  if (bridge && bridge !== "no" && bridge !== "false") return true;
  const tunnel = (tags.tunnel ?? "").trim().toLowerCase();
  if (tunnel && tunnel !== "no" && tunnel !== "false") return true;
  if (tags.indoor === "yes") return true;

  if (tags.layer !== undefined) {
    const layer = parseOsmLayer(tags);
    if (layer < 0) return true;
    if (layer > 0 && (tags.covered === "yes" || tags["building:min_level"] !== undefined)) return true;
  }
  const minH = parseOsmMeters(tags.min_height ?? tags["building:min_height"]);
  if (minH !== null && minH >= 3.2) return true;
  const minLvl = parseOsmMeters(tags["building:min_level"]);
  if (minLvl !== null && minLvl >= 1) return true;
  return false;
}

/** Узлы ворот/шлагбаумов/въездов OSM, в которых ограждение `barrier=fence|wall` имеет проезд. */
export const GATE_BARRIER_KINDS = new Set([
  "gate",
  "lift_gate",
  "swing_gate",
  "sliding_gate",
  "toll_booth",
  "entrance",
  "sally_port",
  "cattle_grid",
  "chain",
  "rope",
  "bollard",
  "rising_bollard",
  "full-height_turnstile",
]);

// ───────── Пространственный индекс дорожного полотна и устранение геометрических конфликтов ─────────

type IndexedRoadSeg = {
  roadId: string;
  road: RoadSegment;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  h: number;
  layer: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type PointRoadQuery = {
  nearest: {
    road: RoadSegment;
    x: number;
    z: number;
    dist: number;
    /** Знаковый зазор до края асфальта (`< 0` — точка внутри проезжей части). */
    clearance: number;
    /** Единичная внешняя нормаль от оси дороги к точке. */
    nx: number;
    nz: number;
    h: number;
  } | null;
  /** Число различных дорог, проезжая часть которых (с запасом `padM`) накрывает точку. */
  overlappingRoadCount: number;
};

/**
 * Быстрый сеточный индекс сегментов проезжей части (шаг 24 м) для мгновенной проверки
 * пересечений зданий, ограждений, деревьев, знаков и светофоров с реальными улицами OSM.
 */
export class RoadCorridorIndex {
  private readonly cellSize = 24;
  private readonly segs: IndexedRoadSeg[] = [];
  private readonly grid = new Map<string, number[]>();

  constructor(roads: readonly RoadSegment[], surfaceOnly = true) {
    for (const road of roads) {
      if (road.id === "custom-lot" || !Array.isArray(road.points) || road.points.length < 2) continue;
      const layer = road.layer ?? 0;
      if (surfaceOnly && layer !== 0) continue;
      const halfWidth = Math.max(1.5, road.width * 0.5);
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = road.points[i];
        const b = road.points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.25) continue;
        const idx = this.segs.length;
        const seg: IndexedRoadSeg = {
          roadId: road.id,
          road,
          ax: a.x,
          az: a.z,
          bx: b.x,
          bz: b.z,
          halfWidth,
          h: Math.atan2(b.x - a.x, b.z - a.z),
          layer,
          minX: Math.min(a.x, b.x) - halfWidth,
          maxX: Math.max(a.x, b.x) + halfWidth,
          minZ: Math.min(a.z, b.z) - halfWidth,
          maxZ: Math.max(a.z, b.z) + halfWidth,
        };
        this.segs.push(seg);
        const gx0 = Math.floor(seg.minX / this.cellSize);
        const gx1 = Math.floor(seg.maxX / this.cellSize);
        const gz0 = Math.floor(seg.minZ / this.cellSize);
        const gz1 = Math.floor(seg.maxZ / this.cellSize);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const key = `${gx}:${gz}`;
            const bucket = this.grid.get(key);
            if (bucket) bucket.push(idx);
            else this.grid.set(key, [idx]);
          }
        }
      }
    }
  }

  get isEmpty(): boolean {
    return this.segs.length === 0;
  }

  /** Возвращает уникальные индексы сегментов дорог, чьи AABB пересекают заданный прямоугольник. */
  queryBox(minX: number, maxX: number, minZ: number, maxZ: number): IndexedRoadSeg[] {
    if (this.segs.length === 0) return [];
    const gx0 = Math.floor(minX / this.cellSize);
    const gx1 = Math.floor(maxX / this.cellSize);
    const gz0 = Math.floor(minZ / this.cellSize);
    const gz1 = Math.floor(maxZ / this.cellSize);
    // На огромных боксах дешевле обойти список сегментов напрямую
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > this.segs.length * 2) {
      return this.segs.filter(
        (s) => s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ
      );
    }
    const seen = new Set<number>();
    const out: IndexedRoadSeg[] = [];
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const bucket = this.grid.get(`${gx}:${gz}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const s = this.segs[idx];
          if (s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ) {
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  /** Проверяет зазор от точки `(x, z)` до ближайшей проезжей части и число накрывающих дорог. */
  queryPoint(x: number, z: number, padM = 0.4, searchRadiusM = 22): PointRoadQuery {
    const cands = this.queryBox(x - searchRadiusM, x + searchRadiusM, z - searchRadiusM, z + searchRadiusM);
    let best: PointRoadQuery["nearest"] = null;
    const overlapIds = new Set<string>();

    for (const s of cands) {
      const cp = closestPointOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
      const dist = Math.sqrt(cp.distSq);
      const clearance = dist - s.halfWidth;
      if (clearance < padM) {
        overlapIds.add(s.road.name?.trim() ? `n:${s.road.name.trim()}` : `id:${s.roadId}`);
      }
      if (!best || clearance < best.clearance) {
        let nx: number;
        let nz: number;
        if (dist > 1e-4) {
          nx = (x - cp.x) / dist;
          nz = (z - cp.z) / dist;
        } else {
          // Если точка лежит строго на оси дороги — сдвигаем на правую обочину `(-cos h, sin h)`
          nx = -Math.cos(s.h);
          nz = Math.sin(s.h);
        }
        best = { road: s.road, x: cp.x, z: cp.z, dist, clearance, nx, nz, h: s.h };
      }
    }

    return { nearest: best, overlappingRoadCount: overlapIds.size };
  }

  /** Проверяет, не перекрывает ли точка `(x, z)` другую дорогу с более высоким скоростным режимом. */
  hasFasterRoadWithin(x: number, z: number, radiusM: number, zoneLimitKmh: number, ownRoadName?: string): boolean {
    const cands = this.queryBox(x - radiusM, x + radiusM, z - radiusM, z + radiusM);
    const ownNorm = ownRoadName?.trim().toLowerCase();
    for (const s of cands) {
      const otherLimit = s.road.speedLimitKmh ?? 60;
      if (otherLimit < zoneLimitKmh + 15) continue;
      if (ownNorm && s.road.name?.trim().toLowerCase() === ownNorm) continue;
      const cp = closestPointOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
      if (Math.sqrt(cp.distSq) <= radiusM + s.halfWidth * 0.35) {
        return true;
      }
    }
    return false;
  }
}

// ───────── Точная 2D-геометрия отрезок ↔ AABB / отрезок ↔ отрезок ─────────

function segmentsIntersect2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): boolean {
  const cross = (ux: number, uz: number, vx: number, vz: number) => ux * vz - uz * vx;
  const d1 = cross(dx - cx, dz - cz, ax - cx, az - cz);
  const d2 = cross(dx - cx, dz - cz, bx - cx, bz - cz);
  const d3 = cross(bx - ax, bz - az, cx - ax, cz - az);
  const d4 = cross(bx - ax, bz - az, dx - ax, dz - az);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function segmentToSegmentDist(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): number {
  if (segmentsIntersect2D(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  const d1 = closestPointOnSegment(ax, az, cx, cz, dx, dz).distSq;
  const d2 = closestPointOnSegment(bx, bz, cx, cz, dx, dz).distSq;
  const d3 = closestPointOnSegment(cx, cz, ax, az, bx, bz).distSq;
  const d4 = closestPointOnSegment(dx, dz, ax, az, bx, bz).distSq;
  return Math.sqrt(Math.min(d1, d2, d3, d4));
}

/** Клиппинг отрезка `(x0, y0) → (x1, y1)` по прямоугольнику `[minX, maxX] × [minY, maxY]` (Лянга—Барски). */
function clipSegmentToAabb(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): [number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** Точное минимальное расстояние от отрезка `(x0, y0)→(x1, y1)` до прямоугольника `[minX, maxX] × [minY, maxY]`. */
function segmentToAabbDist(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): number {
  if (clipSegmentToAabb(x0, y0, x1, y1, minX, maxX, minY, maxY)) return 0;
  const ptBox = (px: number, py: number) => {
    const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
    const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
    return dx * dx + dy * dy;
  };
  let bestSq = Math.min(ptBox(x0, y0), ptBox(x1, y1));
  const corners: Array<[number, number]> = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  for (const [cx, cy] of corners) {
    const d2 = closestPointOnSegment(cx, cy, x0, y0, x1, y1).distSq;
    if (d2 < bestSq) bestSq = d2;
  }
  return Math.sqrt(bestSq);
}

/** Проверяет, пересекает ли OBB препятствия проезжую часть с заданным запасом `clearanceM`. */
export function doesObstacleOverlapRoads(
  obs: Pick<ObstacleBox, "cx" | "cz" | "halfX" | "halfZ" | "h">,
  roadIndex: RoadCorridorIndex,
  clearanceM = 0.45
): boolean {
  if (roadIndex.isEmpty) return false;
  const diag = Math.hypot(obs.halfX, obs.halfZ) + clearanceM + 1;
  const cands = roadIndex.queryBox(obs.cx - diag, obs.cx + diag, obs.cz - diag, obs.cz + diag);
  if (cands.length === 0) return false;

  const fx = Math.sin(obs.h);
  const fz = Math.cos(obs.h);
  const lx = Math.cos(obs.h);
  const lz = -Math.sin(obs.h);

  for (const s of cands) {
    const aL = (s.ax - obs.cx) * lx + (s.az - obs.cz) * lz;
    const aF = (s.ax - obs.cx) * fx + (s.az - obs.cz) * fz;
    const bL = (s.bx - obs.cx) * lx + (s.bz - obs.cz) * lz;
    const bF = (s.bx - obs.cx) * fx + (s.bz - obs.cz) * fz;
    const dist = segmentToAabbDist(aL, aF, bL, bF, -obs.halfX, obs.halfX, -obs.halfZ, obs.halfZ);
    if (dist < s.halfWidth + clearanceM) return true;
  }
  return false;
}

/**
 * Аккуратно ужимает только те грани прямоугольника `[minL, maxL] × [minF, maxF]` (в осях `h`),
 * которые залезают на проезжую часть, сохраняя противоположный фасад здания нетронутым.
 * Возвращает `null`, если здание целиком перекрывает дорогу и после ужатия стало меньше `minSizeM`.
 */
function retractLocalBoxFromRoads(
  initMinL: number,
  initMaxL: number,
  initMinF: number,
  initMaxF: number,
  h: number,
  roadIndex: RoadCorridorIndex,
  clearanceM: number,
  minSizeM: number
): { minL: number; maxL: number; minF: number; maxF: number; retracted: boolean } | null {
  let minL = initMinL;
  let maxL = initMaxL;
  let minF = initMinF;
  let maxF = initMaxF;
  let retracted = false;

  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const lx = Math.cos(h);
  const lz = -Math.sin(h);

  const toWorld = (l: number, f: number): Vec2 => ({
    x: lx * l + fx * f,
    z: lz * l + fz * f,
  });

  const c0 = toWorld(minL, minF);
  const c1 = toWorld(maxL, minF);
  const c2 = toWorld(maxL, maxF);
  const c3 = toWorld(minL, maxF);
  const pad = clearanceM + 2;
  const cands = roadIndex.queryBox(
    Math.min(c0.x, c1.x, c2.x, c3.x) - pad,
    Math.max(c0.x, c1.x, c2.x, c3.x) + pad,
    Math.min(c0.z, c1.z, c2.z, c3.z) - pad,
    Math.max(c0.z, c1.z, c2.z, c3.z) + pad
  );

  for (const s of cands) {
    const r = s.halfWidth + clearanceM;
    const aL = s.ax * lx + s.az * lz;
    const aF = s.ax * fx + s.az * fz;
    const bL = s.bx * lx + s.bz * lz;
    const bF = s.bx * fx + s.bz * fz;

    if (segmentToAabbDist(aL, aF, bL, bF, minL, maxL, minF, maxF) >= r) continue;

    // Находим участок сегмента дороги, проходящий через расширенный на r прямоугольник
    const hit = clipSegmentToAabb(aL, aF, bL, bF, minL - r, maxL + r, minF - r, maxF + r);
    if (!hit) continue;
    const p0L = aL + (bL - aL) * hit[0];
    const p0F = aF + (bF - aF) * hit[0];
    const p1L = aL + (bL - aL) * hit[1];
    const p1F = aF + (bF - aF) * hit[1];
    const segMinL = Math.min(p0L, p1L);
    const segMaxL = Math.max(p0L, p1L);
    const segMinF = Math.min(p0F, p1F);
    const segMaxF = Math.max(p0F, p1F);

    // Четыре варианта отступа одной грани (выбираем с минимальной потерей площади)
    const w = maxL - minL;
    const l = maxF - minF;
    const options: Array<{ nMinL: number; nMaxL: number; nMinF: number; nMaxF: number; loss: number }> = [];

    const cutMaxL = segMinL - r;
    if (cutMaxL - minL >= minSizeM && cutMaxL < maxL) {
      options.push({ nMinL: minL, nMaxL: cutMaxL, nMinF: minF, nMaxF: maxF, loss: (maxL - cutMaxL) * l });
    }
    const cutMinL = segMaxL + r;
    if (maxL - cutMinL >= minSizeM && cutMinL > minL) {
      options.push({ nMinL: cutMinL, nMaxL: maxL, nMinF: minF, nMaxF: maxF, loss: (cutMinL - minL) * l });
    }
    const cutMaxF = segMinF - r;
    if (cutMaxF - minF >= minSizeM && cutMaxF < maxF) {
      options.push({ nMinL: minL, nMaxL: maxL, nMinF: minF, nMaxF: cutMaxF, loss: (maxF - cutMaxF) * w });
    }
    const cutMinF = segMaxF + r;
    if (maxF - cutMinF >= minSizeM && cutMinF > minF) {
      options.push({ nMinL: minL, nMaxL: maxL, nMinF: cutMinF, nMaxF: maxF, loss: (cutMinF - minF) * w });
    }

    // Если улица идёт по диагонали и срезает только один угол здания — отступаем одновременно по двум граням угла,
    // сохраняя максимально крупную свободную от дороги часть здания (вместо полного удаления дома).
    if (options.length === 0) {
      const midSegL = (p0L + p1L) * 0.5;
      const midSegF = (p0F + p1F) * 0.5;
      const boxMidL = (minL + maxL) * 0.5;
      const boxMidF = (minF + maxF) * 0.5;
      const steps = [0.15, 0.28, 0.4, 0.52, 0.65, 0.78];
      for (const sL of steps) {
        const candMinL = midSegL <= boxMidL ? minL + w * sL : minL;
        const candMaxL = midSegL > boxMidL ? maxL - w * sL : maxL;
        if (candMaxL - candMinL < minSizeM) continue;
        for (const sF of steps) {
          const candMinF = midSegF <= boxMidF ? minF + l * sF : minF;
          const candMaxF = midSegF > boxMidF ? maxF - l * sF : maxF;
          if (candMaxF - candMinF < minSizeM) continue;
          if (segmentToAabbDist(aL, aF, bL, bF, candMinL, candMaxL, candMinF, candMaxF) >= r) {
            const keptArea = (candMaxL - candMinL) * (candMaxF - candMinF);
            options.push({
              nMinL: candMinL,
              nMaxL: candMaxL,
              nMinF: candMinF,
              nMaxF: candMaxF,
              loss: w * l - keptArea,
            });
            break;
          }
        }
      }
    }

    if (options.length === 0) return null;
    options.sort((a, b) => a.loss - b.loss);
    const best = options[0];
    minL = best.nMinL;
    maxL = best.nMaxL;
    minF = best.nMinF;
    maxF = best.nMaxF;
    retracted = true;
  }

  if (maxL - minL < minSizeM || maxF - minF < minSizeM) return null;
  return { minL, maxL, minF, maxF, retracted };
}

/** Ужимает существующий OBB препятствия от проезжей части (для редактора и постобработки). */
export function retractObstacleFromRoads(
  obs: ObstacleBox,
  roadIndex: RoadCorridorIndex,
  clearanceM = 0.45,
  minSizeM = 2.0
): { obstacle: ObstacleBox | null; changed: boolean } {
  if (!doesObstacleOverlapRoads(obs, roadIndex, clearanceM)) {
    return { obstacle: obs, changed: false };
  }
  const fx = Math.sin(obs.h);
  const fz = Math.cos(obs.h);
  const lx = Math.cos(obs.h);
  const lz = -Math.sin(obs.h);
  const cL = obs.cx * lx + obs.cz * lz;
  const cF = obs.cx * fx + obs.cz * fz;

  const res = retractLocalBoxFromRoads(
    cL - obs.halfX,
    cL + obs.halfX,
    cF - obs.halfZ,
    cF + obs.halfZ,
    obs.h,
    roadIndex,
    clearanceM,
    minSizeM
  );
  if (!res) return { obstacle: null, changed: true };
  const midL = (res.minL + res.maxL) * 0.5;
  const midF = (res.minF + res.maxF) * 0.5;
  return {
    changed: res.retracted,
    obstacle: {
      ...obs,
      cx: round2(lx * midL + fx * midF),
      cz: round2(lz * midL + fz * midF),
      halfX: round2((res.maxL - res.minL) * 0.5),
      halfZ: round2((res.maxF - res.minF) * 0.5),
    },
  };
}

const BUILDING_PALETTE = [0x4c5d6b, 0x5a6875, 0x625d57, 0x4b5862, 0x58646e];

export type BuildingDeconflictResult = {
  boxes: ObstacleBox[];
  /** Было ли здание разбито на корпуса, ужато от дороги или исключено из-за конфликта с улицей. */
  resolvedConflict: boolean;
};

/**
 * Преобразует контур реального здания OSM (включая вогнутые Г-/П-образные дома и мультиполигоны
 * с внутренними дворами `innerRings`) в один или несколько OBB без наезда на проезжую часть.
 */
export function buildDeconflictedBuildingObstacles(
  id: string,
  outerPts: readonly Vec2[],
  innerRings: readonly (readonly Vec2[])[],
  tags: Record<string, string>,
  colorIdx: number,
  roadIndex: RoadCorridorIndex
): BuildingDeconflictResult {
  if (outerPts.length < 3 || isNonBlockingBuilding(tags)) {
    return { boxes: [], resolvedConflict: false };
  }

  // Убираем замыкающий дубль первой точки, если он есть
  const ring =
    outerPts.length >= 4 &&
    Math.hypot(outerPts[0].x - outerPts[outerPts.length - 1].x, outerPts[0].z - outerPts[outerPts.length - 1].z) < 0.05
      ? outerPts.slice(0, -1)
      : outerPts;
  if (ring.length < 3) return { boxes: [], resolvedConflict: false };

  // Направление самой длинной стены контура
  let bestLenSq = 0;
  let h = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    if (l2 > bestLenSq) {
      bestLenSq = l2;
      h = Math.atan2(dx, dz);
    }
  }
  if (Math.abs(Math.sin(h)) < 0.02 || Math.abs(Math.cos(h)) < 0.02) h = 0;
  const hRounded = round3(h);

  const fx = Math.sin(hRounded);
  const fz = Math.cos(hRounded);
  const lx = Math.cos(hRounded);
  const lz = -Math.sin(hRounded);

  let minL = Infinity;
  let maxL = -Infinity;
  let minF = Infinity;
  let maxF = -Infinity;
  for (const p of ring) {
    const pl = p.x * lx + p.z * lz;
    const pf = p.x * fx + p.z * fz;
    if (pl < minL) minL = pl;
    if (pl > maxL) maxL = pl;
    if (pf < minF) minF = pf;
    if (pf > maxF) maxF = pf;
  }

  const w = maxL - minL;
  const l = maxF - minF;
  if (w < 2 || l < 2 || w > 280 || l > 280) return { boxes: [], resolvedConflict: false };

  const midL0 = (minL + maxL) * 0.5;
  const midF0 = (minF + maxF) * 0.5;
  const cx0 = lx * midL0 + fx * midF0;
  const cz0 = lz * midL0 + fz * midF0;
  if (Math.abs(cx0) > MAX_WORLD_COORD || Math.abs(cz0) > MAX_WORLD_COORD) {
    return { boxes: [], resolvedConflict: false };
  }

  const heightTag = parseOsmMeters(tags.height);
  const levelsTag = parseOsmMeters(tags["building:levels"]);
  const height = Number(
    Math.min(48, Math.max(4.5, heightTag && heightTag > 0 ? heightTag : levelsTag && levelsTag > 0 ? levelsTag * 3.2 : 9.6)).toFixed(2)
  );
  const color = BUILDING_PALETTE[colorIdx % BUILDING_PALETTE.length];
  const label = tags.name ? `здание «${tags.name}»` : "здание OSM";

  const makeBox = (boxId: string, bMinL: number, bMaxL: number, bMinF: number, bMaxF: number): ObstacleBox => {
    const mL = (bMinL + bMaxL) * 0.5;
    const mF = (bMinF + bMaxF) * 0.5;
    return {
      id: boxId,
      kind: "building",
      cx: round2(lx * mL + fx * mF),
      cz: round2(lz * mL + fz * mF),
      halfX: round2((bMaxL - bMinL) * 0.5),
      halfZ: round2((bMaxF - bMinF) * 0.5),
      h: hRounded,
      height,
      color,
      label,
    };
  };

  const primary = makeBox(id, minL, maxL, minF, maxF);
  const clearanceM = 0.45;

  // Быстрый путь (95 % реальных зданий): OBB не задевает ни одну улицу и нет дворового проезда внутри
  if (!doesObstacleOverlapRoads(primary, roadIndex, clearanceM)) {
    return { boxes: [primary], resolvedConflict: false };
  }

  // Вогнутые Г-/П-/Т-образные дома и мультиполигоны с двором раскладываем на корпуса вокруг проезда
  const outerArea = polygonArea(ring);
  let holesArea = 0;
  for (const hole of innerRings) {
    if (hole.length >= 3) holesArea += polygonArea(hole);
  }
  const fillRatio = Math.max(0, outerArea - holesArea) / Math.max(1, w * l);
  const isConcaveOrCourtyard =
    (innerRings.length > 0 || (ring.length >= 5 && fillRatio < 0.8)) && w >= 8 && l >= 8;

  if (isConcaveOrCourtyard) {
    const nL = Math.min(8, Math.max(3, Math.round(w / 6)));
    const nF = Math.min(8, Math.max(3, Math.round(l / 6)));
    const stepL = w / nL;
    const stepF = l / nF;
    const solid: boolean[][] = Array.from({ length: nF }, () => new Array<boolean>(nL).fill(false));

    for (let r = 0; r < nF; r++) {
      const cMinF = minF + r * stepF;
      const cMaxF = cMinF + stepF;
      const cMidF = (cMinF + cMaxF) * 0.5;
      for (let c = 0; c < nL; c++) {
        const cMinL = minL + c * stepL;
        const cMaxL = cMinL + stepL;
        const cMidL = (cMinL + cMaxL) * 0.5;
        const wx = lx * cMidL + fx * cMidF;
        const wz = lz * cMidL + fz * cMidF;
        if (!isPointInPolygon(wx, wz, ring)) continue;
        let inHole = false;
        for (const hole of innerRings) {
          if (hole.length >= 3 && isPointInPolygon(wx, wz, hole)) {
            inHole = true;
            break;
          }
        }
        if (inHole) continue;
        const probe = makeBox(id, cMinL, cMaxL, cMinF, cMaxF);
        if (!doesObstacleOverlapRoads(probe, roadIndex, clearanceM)) {
          solid[r][c] = true;
        }
      }
    }

    // Жадное объединение соседних ячеек в крупные прямоугольные корпуса (до 5 крыльев на здание)
    const used: boolean[][] = Array.from({ length: nF }, () => new Array<boolean>(nL).fill(false));
    const rawWings: Array<{ minL: number; maxL: number; minF: number; maxF: number; area: number }> = [];

    for (let r = 0; r < nF; r++) {
      for (let c = 0; c < nL; c++) {
        if (!solid[r][c] || used[r][c]) continue;
        let maxC = c;
        while (maxC + 1 < nL && solid[r][maxC + 1] && !used[r][maxC + 1]) maxC++;
        let maxR = r;
        while (maxR + 1 < nF) {
          let rowOk = true;
          for (let k = c; k <= maxC; k++) {
            if (!solid[maxR + 1][k] || used[maxR + 1][k]) {
              rowOk = false;
              break;
            }
          }
          if (!rowOk) break;
          maxR++;
        }
        for (let rr = r; rr <= maxR; rr++) {
          for (let cc = c; cc <= maxC; cc++) used[rr][cc] = true;
        }
        const bMinL = minL + c * stepL;
        const bMaxL = minL + (maxC + 1) * stepL;
        const bMinF = minF + r * stepF;
        const bMaxF = minF + (maxR + 1) * stepF;
        if (bMaxL - bMinL >= 2.2 && bMaxF - bMinF >= 2.2) {
          rawWings.push({
            minL: bMinL,
            maxL: bMaxL,
            minF: bMinF,
            maxF: bMaxF,
            area: (bMaxL - bMinL) * (bMaxF - bMinF),
          });
        }
      }
    }

    if (rawWings.length > 0) {
      rawWings.sort((a, b) => b.area - a.area);
      const top = rawWings.slice(0, 5);
      const boxes = top.map((wing, idx) =>
        makeBox(idx === 0 ? id : `${id}-w${idx + 1}`, wing.minL, wing.maxL, wing.minF, wing.maxF)
      );
      return { boxes, resolvedConflict: true };
    }
  }

  // Обычное здание с углом/фасадом, заступившим на расширенное полотно дороги — ужимаем ближнюю грань
  const trimmed = retractLocalBoxFromRoads(minL, maxL, minF, maxF, hRounded, roadIndex, clearanceM, 2.2);
  if (!trimmed) {
    return { boxes: [], resolvedConflict: true };
  }
  return {
    boxes: [makeBox(id, trimmed.minL, trimmed.maxL, trimmed.minF, trimmed.maxF)],
    resolvedConflict: true,
  };
}

// ───────── Прорезка проездов в ограждениях, стенах и бордюрах ─────────

/**
 * Разрезает ломаную ограждения/стены/бордюра, убирая участки, проходящие по проезжей части улиц
 * или через узлы ворот/шлагбаумов (`gatePoints`). Остальные сегменты забора полностью сохраняются.
 */
export function clipPolylineOutsideRoads(
  pts: readonly Vec2[],
  roadIndex: RoadCorridorIndex,
  opts?: {
    roadClearanceM?: number;
    gatePoints?: readonly Vec2[];
    gateHalfWidthM?: number;
    minPieceLenM?: number;
  }
): { pieces: Vec2[][]; cutCount: number } {
  if (pts.length < 2) return { pieces: [], cutCount: 0 };
  const roadMargin = opts?.roadClearanceM ?? 0.55;
  const gates = opts?.gatePoints ?? [];
  const gateR = opts?.gateHalfWidthM ?? 2.4;
  const minPiece = opts?.minPieceLenM ?? 1.0;

  if (roadIndex.isEmpty && gates.length === 0) {
    return { pieces: [pts.map((p) => ({ ...p }))], cutCount: 0 };
  }

  const pieces: Vec2[][] = [];
  let current: Vec2[] = [];
  let cutCount = 0;

  const flushCurrent = () => {
    if (current.length >= 2) {
      let len = 0;
      for (let i = 0; i < current.length - 1; i++) {
        len += Math.hypot(current[i + 1].x - current[i].x, current[i + 1].z - current[i].z);
      }
      if (len >= minPiece) pieces.push(current);
    }
    current = [];
  };

  const pushSubSeg = (a: Vec2, b: Vec2) => {
    if (Math.hypot(b.x - a.x, b.z - a.z) < 0.15) return;
    if (current.length === 0) {
      current.push({ x: round2(a.x), z: round2(a.z) }, { x: round2(b.x), z: round2(b.z) });
      return;
    }
    const last = current[current.length - 1];
    if (Math.hypot(last.x - a.x, last.z - a.z) <= 0.08) {
      current.push({ x: round2(b.x), z: round2(b.z) });
    } else {
      flushCurrent();
      current.push({ x: round2(a.x), z: round2(a.z) }, { x: round2(b.x), z: round2(b.z) });
    }
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const segLen = Math.hypot(q.x - p.x, q.z - p.z);
    if (segLen < 0.2) continue;

    const pad = roadMargin + 2;
    const roadCands = roadIndex.queryBox(
      Math.min(p.x, q.x) - pad,
      Math.max(p.x, q.x) + pad,
      Math.min(p.z, q.z) - pad,
      Math.max(p.z, q.z) + pad
    );

    // Оставляем только реально конфликтующие сегменты дорог и ближайшие ворота
    const hitRoads = roadCands.filter(
      (s) => segmentToSegmentDist(p.x, p.z, q.x, q.z, s.ax, s.az, s.bx, s.bz) < s.halfWidth + roadMargin
    );
    const hitGates = gates.filter(
      (g) => closestPointOnSegment(g.x, g.z, p.x, p.z, q.x, q.z).distSq < gateR * gateR
    );

    if (hitRoads.length === 0 && hitGates.length === 0) {
      pushSubSeg(p, q);
      continue;
    }

    cutCount += 1;
    const isBlocked = (u: number): boolean => {
      const x = p.x + (q.x - p.x) * u;
      const z = p.z + (q.z - p.z) * u;
      for (const s of hitRoads) {
        const r = s.halfWidth + roadMargin;
        if (closestPointOnSegment(x, z, s.ax, s.az, s.bx, s.bz).distSq < r * r) return true;
      }
      for (const g of hitGates) {
        if ((x - g.x) * (x - g.x) + (z - g.z) * (z - g.z) < gateR * gateR) return true;
      }
      return false;
    };

    const bisectTransition = (lo: number, hi: number, loBlocked: boolean): number => {
      let a = lo;
      let b = hi;
      for (let it = 0; it < 7; it++) {
        const mid = (a + b) * 0.5;
        if (isBlocked(mid) === loBlocked) a = mid;
        else b = mid;
      }
      return loBlocked ? b : a;
    };

    const steps = Math.max(8, Math.min(240, Math.ceil(segLen / 0.55)));
    let prevU = 0;
    let prevBlocked = isBlocked(0);
    let freeStart: number | null = prevBlocked ? null : 0;

    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const b = isBlocked(u);
      if (b !== prevBlocked) {
        const edgeU = bisectTransition(prevU, u, prevBlocked);
        if (prevBlocked) {
          freeStart = edgeU;
        } else if (freeStart !== null) {
          const aPt = { x: p.x + (q.x - p.x) * freeStart, z: p.z + (q.z - p.z) * freeStart };
          const bPt = { x: p.x + (q.x - p.x) * edgeU, z: p.z + (q.z - p.z) * edgeU };
          pushSubSeg(aPt, bPt);
          flushCurrent();
          freeStart = null;
        }
        prevBlocked = b;
      }
      prevU = u;
    }

    if (freeStart !== null) {
      const aPt = { x: p.x + (q.x - p.x) * freeStart, z: p.z + (q.z - p.z) * freeStart };
      pushSubSeg(aPt, q);
    } else {
      flushCurrent();
    }
  }

  flushCurrent();
  return { pieces, cutCount };
}

// ───────── Вынос деревьев, опор, островков, знаков и светофоров с проезжей части ─────────

/**
 * Устраняет конфликт точечного объекта (`tree`, `pole`, `cone`, `island`) с проезжей частью:
 * деревья и столбы выносятся на обочину (или удаляются, если зажаты в центре перекрёстка),
 * а островки безопасности сужаются под реальную ширину проезжей части.
 */
export function deconflictPointObstacle(
  obs: ObstacleBox,
  roadIndex: RoadCorridorIndex
): { obstacle: ObstacleBox | null; changed: boolean } {
  if (roadIndex.isEmpty) return { obstacle: obs, changed: false };

  if (obs.kind === "island") {
    const q = roadIndex.queryPoint(obs.cx, obs.cz, 0.5);
    if (!q.nearest || q.nearest.clearance > 1.5) return { obstacle: obs, changed: false };
    // На перекрёстке двух улиц или на узкой (< 8.6 м) улице островок перегораживает полосу
    if (q.overlappingRoadCount >= 2 || q.nearest.road.width < 8.6) {
      return { obstacle: null, changed: true };
    }
    const maxHalfX = round2(Math.min(obs.halfX, Math.max(0.4, (q.nearest.road.width - 6.6) * 0.5)));
    if (maxHalfX < obs.halfX - 0.02) {
      return { obstacle: { ...obs, halfX: maxHalfX }, changed: true };
    }
    return { obstacle: obs, changed: false };
  }

  const radius = Math.max(obs.halfX, obs.halfZ);
  const minClear = radius + 0.45;
  const q = roadIndex.queryPoint(obs.cx, obs.cz, minClear);
  if (!q.nearest || q.nearest.clearance >= minClear) {
    return { obstacle: obs, changed: false };
  }

  const pushDist = q.nearest.road.width * 0.5 + radius + 0.8;
  // Пробуем ближнюю обочину, затем противоположную (если ближняя попала на примыкающую улицу)
  for (const sign of [1, -1]) {
    const nx = round2(q.nearest.x + q.nearest.nx * sign * pushDist);
    const nz = round2(q.nearest.z + q.nearest.nz * sign * pushDist);
    const check = roadIndex.queryPoint(nx, nz, radius + 0.35);
    if (!check.nearest || check.nearest.clearance >= radius + 0.35) {
      return { obstacle: { ...obs, cx: nx, cz: nz }, changed: true };
    }
  }
  return { obstacle: null, changed: true };
}

/**
 * Размещает стойку дорожного знака на правой обочине вне проезжей части и вне перекрёстков
 * (сохраняя центр действия скоростной зоны `zoneX/zoneZ` на самой дороге).
 */
export function placeSignPostClearOfRoads(
  sign: RoadSignDef,
  roadIndex: RoadCorridorIndex
): { sign: RoadSignDef; shifted: boolean } {
  if (roadIndex.isEmpty) return { sign, shifted: false };
  const q = roadIndex.queryPoint(sign.x, sign.z, 0.55);
  if (!q.nearest || q.nearest.clearance >= 0.55) {
    return { sign, shifted: false };
  }

  const h = sign.h;
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const rx = -Math.cos(h);
  const rz = Math.sin(h);
  const shoulder = q.nearest.road.width * 0.5 + 1.05;

  // Сдвигаем на правую обочину; если там перекрёсток — отступаем на 3.5–7 м до перекрёстка
  for (const backM of [0, 3.5, 7, -3.5]) {
    const baseX = q.nearest.x - fx * backM;
    const baseZ = q.nearest.z - fz * backM;
    const candX = round2(baseX + rx * shoulder);
    const candZ = round2(baseZ + rz * shoulder);
    const check = roadIndex.queryPoint(candX, candZ, 0.4);
    if (!check.nearest || check.nearest.clearance >= 0.4) {
      const preserveZone =
        (sign.kind === "speed_limit" || sign.kind === "living_zone") &&
        sign.zoneX === undefined &&
        sign.zoneZ === undefined;
      return {
        shifted: true,
        sign: {
          ...sign,
          x: candX,
          z: candZ,
          ...(preserveZone ? { zoneX: round2(sign.x), zoneZ: round2(sign.z) } : {}),
        },
      };
    }
  }

  // Запасной вариант — вдоль локальной нормали ближайшей дороги
  const fallbackX = round2(q.nearest.x + q.nearest.nx * shoulder);
  const fallbackZ = round2(q.nearest.z + q.nearest.nz * shoulder);
  return { sign: { ...sign, x: fallbackX, z: fallbackZ }, shifted: true };
}

/**
 * Размещает стойку и стоп-линию светофора на подходе к перекрёстку так, чтобы стойка стояла
 * на правой обочине вне поперечной улицы, а стоп-линия — перед пересечением проезжих частей.
 */
export function buildDeconflictedSignal(
  id: string,
  nodePos: Vec2,
  h: number,
  road: { width: number; oneway?: boolean },
  cycleIndex: number,
  roadIndex: RoadCorridorIndex
): { signal: TrafficSignalDef; adjusted: boolean } {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const rx = -Math.cos(h);
  const rz = Math.sin(h);
  const roadW = Math.max(3.5, road.width);
  const isOneway = Boolean(road.oneway);

  // Базовый отступ стоп-линии: 4 м до узла; если узел стоит в центре перекрёстка, выносим за край поперечной улицы
  let stopBack = 4.0;
  let adjusted = false;
  const atNode = roadIndex.queryPoint(nodePos.x, nodePos.z, 0.2);
  if (atNode.overlappingRoadCount >= 2) {
    for (const candBack of [5.5, 7.5, 9.5, 11.5]) {
      const sx = nodePos.x - fx * candBack;
      const sz = nodePos.z - fz * candBack;
      if (roadIndex.queryPoint(sx, sz, 0.1).overlappingRoadCount <= 1) {
        stopBack = candBack;
        adjusted = true;
        break;
      }
    }
  }

  const laneSpan = isOneway ? Math.min(12, Math.max(3.4, roadW * 0.88)) : Math.min(11, Math.max(3.2, roadW * 0.5));
  const stopRightShift = isOneway ? 0 : laneSpan * 0.45;
  const stopLineX = round2(nodePos.x + rx * stopRightShift - fx * stopBack);
  const stopLineZ = round2(nodePos.z + rz * stopRightShift - fz * stopBack);

  // Стойка светофора — на правой обочине; если попала на поперечную проезжую часть, ставим у стоп-линии
  const shoulder = roadW * 0.5 + 0.95;
  let poleX = round2(nodePos.x + rx * shoulder);
  let poleZ = round2(nodePos.z + rz * shoulder);
  const poleCheck = roadIndex.queryPoint(poleX, poleZ, 0.35);
  if (poleCheck.nearest && poleCheck.nearest.clearance < 0.35) {
    const altX = round2(nodePos.x - fx * (stopBack - 0.8) + rx * shoulder);
    const altZ = round2(nodePos.z - fz * (stopBack - 0.8) + rz * shoulder);
    const altCheck = roadIndex.queryPoint(altX, altZ, 0.25);
    if (!altCheck.nearest || altCheck.nearest.clearance > poleCheck.nearest.clearance) {
      poleX = altX;
      poleZ = altZ;
      adjusted = true;
    }
  }

  return {
    adjusted,
    signal: {
      id,
      x: poleX,
      z: poleZ,
      h: round3(h),
      stopLineX,
      stopLineZ,
      stopLineWidth: round2(laneSpan),
      cycleOffset: (cycleIndex * 7) % 24,
      greenDuration: 14,
      redDuration: 12,
    },
  };
}

/** Проверяет, дублирует ли новый светофор уже добавленный на том же подходе к перекрёстку. */
export function isDuplicateSignal(existing: readonly TrafficSignalDef[], cand: TrafficSignalDef): boolean {
  for (const s of existing) {
    if (Math.cos(s.h - cand.h) < 0.82) continue;
    const dStop = Math.hypot(s.stopLineX - cand.stopLineX, s.stopLineZ - cand.stopLineZ);
    const dPole = Math.hypot(s.x - cand.x, s.z - cand.z);
    if (dStop < 8.5 || dPole < 7.0) return true;
  }
  return false;
}

/** Проверяет, дублирует ли переход уже существующую зебру в той же точке перекрёстка. */
export function isDuplicateCrosswalk(existing: readonly CrosswalkDef[], cx: number, cz: number, h: number): boolean {
  for (const cw of existing) {
    const d = Math.hypot(cw.cx - cx, cw.cz - cz);
    if (d < 4.5) return true;
    if (d < 7.5 && Math.abs(Math.cos(cw.h - h)) > 0.85) return true;
  }
  return false;
}

/** Подбирает безопасный радиус скоростной зоны, не «протекающий» на соседнюю более быструю улицу. */
export function fitSpeedZoneRadius(
  zx: number,
  zz: number,
  limitKmh: number,
  desiredRadius: number,
  roadWidth: number,
  roadName: string | undefined,
  roadIndex: RoadCorridorIndex
): number | null {
  if (roadIndex.isEmpty) return desiredRadius;
  const minR = Math.max(7, round2(roadWidth * 0.75 + 2));
  if (!roadIndex.hasFasterRoadWithin(zx, zz, desiredRadius, limitKmh, roadName)) {
    return desiredRadius;
  }
  for (const cand of [20, 16, 13, 10, minR]) {
    if (cand > desiredRadius) continue;
    if (!roadIndex.hasFasterRoadWithin(zx, zz, cand, limitKmh, roadName)) {
      return round2(cand);
    }
  }
  return null;
}

/** Сводка автоматически устранённых конфликтов при импорте реальной карты. */
export type ImportConflictCounters = {
  skippedNonDrivableWays: number;
  skippedNonBlockingBuildings: number;
  skippedLandusePolygons: number;
  adjustedBuildings: number;
  openedBarriers: number;
  shiftedObstacles: number;
  alignedSignsAndSignals: number;
  deduplicatedControls: number;
  trimmedSpeedZones: number;
};

export function createConflictCounters(): ImportConflictCounters {
  return {
    skippedNonDrivableWays: 0,
    skippedNonBlockingBuildings: 0,
    skippedLandusePolygons: 0,
    adjustedBuildings: 0,
    openedBarriers: 0,
    shiftedObstacles: 0,
    alignedSignsAndSignals: 0,
    deduplicatedControls: 0,
    trimmedSpeedZones: 0,
  };
}

/** Формирует человекочитаемую сводку устранённых конфликтов для `MapPackMeta`. */
export function summarizeConflictCounters(c: ImportConflictCounters): { total: number; notes: string[] } {
  const notes: string[] = [];
  if (c.adjustedBuildings > 0) {
    notes.push(`Согласовано зданий у проезжей части и дворов: ${c.adjustedBuildings}`);
  }
  if (c.openedBarriers > 0) {
    notes.push(`Открыто проездов/ворот в ограждениях и бордюрах: ${c.openedBarriers}`);
  }
  if (c.shiftedObstacles > 0) {
    notes.push(`Вынесено деревьев/опор/островков с полос: ${c.shiftedObstacles}`);
  }
  if (c.alignedSignsAndSignals > 0) {
    notes.push(`Вынесено стоек знаков и стоп-линий на обочину: ${c.alignedSignsAndSignals}`);
  }
  if (c.deduplicatedControls > 0) {
    notes.push(`Убрано дублей светофоров/переходов/знаков: ${c.deduplicatedControls}`);
  }
  if (c.trimmedSpeedZones > 0) {
    notes.push(`Изолировано скоростных зон от соседних магистралей: ${c.trimmedSpeedZones}`);
  }
  const skipped = c.skippedNonBlockingBuildings + c.skippedLandusePolygons + c.skippedNonDrivableWays;
  if (skipped > 0) {
    notes.push(`Отфильтровано навесов, подземных/площадных и закрытых объектов: ${skipped}`);
  }
  const total =
    c.adjustedBuildings +
    c.openedBarriers +
    c.shiftedObstacles +
    c.alignedSignsAndSignals +
    c.deduplicatedControls +
    c.trimmedSpeedZones +
    skipped;
  return { total, notes };
}

/** Охватывающий прямоугольник набора точек с защитным отступом. */
export function computeTightBounds(points: readonly Vec2[], padM = 12): WorldBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (p.x - padM < minX) minX = p.x - padM;
    if (p.x + padM > maxX) maxX = p.x + padM;
    if (p.z - padM < minZ) minZ = p.z - padM;
    if (p.z + padM > maxZ) maxZ = p.z + padM;
  }
  if (!Number.isFinite(minX)) return { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  return {
    minX: round2(Math.max(-MAX_WORLD_COORD, Math.floor(minX))),
    maxX: round2(Math.min(MAX_WORLD_COORD, Math.ceil(maxX))),
    minZ: round2(Math.max(-MAX_WORLD_COORD, Math.floor(minZ))),
    maxZ: round2(Math.min(MAX_WORLD_COORD, Math.ceil(maxZ))),
  };
}

/** Удаляет дублирующиеся и вырожденные соседние вершины ломаной дороги OSM (шаг < `minStepM`). */
export function cleanRoadPolyline(rawPts: readonly Vec2[], minStepM = 0.25): Vec2[] {
  if (rawPts.length === 0) return [];
  const out: Vec2[] = [{ x: round2(rawPts[0].x), z: round2(rawPts[0].z) }];
  for (let i = 1; i < rawPts.length; i++) {
    const p = rawPts[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const prev = out[out.length - 1];
    if (Math.hypot(p.x - prev.x, p.z - prev.z) >= minStepM) {
      out.push({ x: round2(p.x), z: round2(p.z) });
    }
  }
  return out;
}

/** Синхронизирует скоростные зоны со списком знаков с защитой от «протекания» на соседние быстрые улицы. */
export function filterConflictingSpeedZones(
  zones: readonly SpeedZone[],
  roads: readonly RoadSegment[]
): { zones: SpeedZone[]; trimmed: number } {
  const index = new RoadCorridorIndex(roads, true);
  if (index.isEmpty) return { zones: zones.map((z) => ({ ...z })), trimmed: 0 };
  const out: SpeedZone[] = [];
  let trimmed = 0;
  for (const z of zones) {
    const near = index.queryPoint(z.x, z.z, 2);
    const roadW = near.nearest?.road.width ?? 7;
    const roadName = near.nearest?.road.name;
    const safeR = fitSpeedZoneRadius(z.x, z.z, z.limitKmh, z.radius, roadW, roadName, index);
    if (safeR === null) {
      trimmed += 1;
      continue;
    }
    if (safeR < z.radius - 0.1) trimmed += 1;
    out.push({ ...z, radius: safeR });
  }
  return { zones: out, trimmed };
}
