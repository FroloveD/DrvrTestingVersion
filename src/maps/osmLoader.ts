/**
 * @module maps/osmLoader
 * @layer pure-core
 * @role Офлайн-парсер реальных выгрузок `.osm` XML, Overpass OSM JSON и GeoJSON в метрическую сцену WGS84 (`+Z` север, `−X` восток) с устранением конфликтов дорог, зданий, дворов, заборов, знаков, светофоров, `oneway` и `layer`.
 * @invariants #7 (чистое ядро без DOM и three), #8 (офлайн — ноль сетевых запросов к Overpass), #9 (атрибуция ODbL 1.0).
 * @tests T11, T12, T21, T27, T28, T30, T31, T32, T33
 */
import { createDefaultSign, signToSpeedZone } from "../scenarios/signs";
import type {
  CrosswalkDef,
  MapPackMeta,
  ObstacleBox,
  RoadSegment,
  RoadSignDef,
  RoadSignKind,
  RouteCheckpoint,
  SpeedZone,
  TrafficSignalDef,
  Vec2,
  WorldBounds,
} from "../sim/types";
import {
  boundingBoxOfPolygon,
  boundsToPolygon,
  clipPolylineToPolygon,
  isPointInPolygon,
  isValidBoundaryPolygon,
  MAX_WORLD_COORD,
  sanitizeBoundaryPolygon,
} from "./boundary";
import {
  buildDeconflictedBuildingObstacles,
  buildDeconflictedSignal,
  cleanRoadPolyline,
  clipPolylineOutsideRoads,
  createConflictCounters,
  createWgs84Projector,
  deconflictPointObstacle,
  filterConflictingSpeedZones,
  fitSpeedZoneRadius,
  GATE_BARRIER_KINDS,
  type ImportConflictCounters,
  isDrivableOsmWay,
  isDuplicateCrosswalk,
  isDuplicateSignal,
  isNonBlockingBuilding,
  normalizeHeading,
  parseOsmLayer,
  parseOsmMaxspeedKmh,
  parseOsmMeters,
  parseOsmOneway,
  placeSignPostClearOfRoads,
  RoadCorridorIndex,
  summarizeConflictCounters,
} from "./osmDeconflict";
import { parseOsmXmlDocument, type RawOsmElement, type RawOsmMember } from "./osmXml";
import { buildRouteFromRoads, nearestRoadPoint } from "./route";

export type MapImportFormat = "osm_xml" | "osm_json" | "geojson";

type HighwayPreset = {
  width: number;
  lanes: number;
  limit: number;
  /** Приоритет класса дороги (меньше — главнее; используется на примыканиях и для знаков приоритета). */
  rank: number;
};

const HIGHWAY_WIDTHS: Record<string, HighwayPreset> = {
  motorway: { width: 14.0, lanes: 4, limit: 90, rank: 1 },
  motorway_link: { width: 5.5, lanes: 1, limit: 60, rank: 2 },
  trunk: { width: 12.0, lanes: 4, limit: 60, rank: 1 },
  trunk_link: { width: 5.5, lanes: 1, limit: 60, rank: 2 },
  primary: { width: 10.5, lanes: 2, limit: 60, rank: 2 },
  primary_link: { width: 5.2, lanes: 1, limit: 50, rank: 3 },
  secondary: { width: 9.0, lanes: 2, limit: 60, rank: 3 },
  secondary_link: { width: 5.0, lanes: 1, limit: 50, rank: 4 },
  tertiary: { width: 7.5, lanes: 2, limit: 60, rank: 4 },
  tertiary_link: { width: 4.8, lanes: 1, limit: 40, rank: 5 },
  residential: { width: 6.5, lanes: 2, limit: 40, rank: 5 },
  residential_link: { width: 4.8, lanes: 1, limit: 30, rank: 6 },
  unclassified: { width: 6.5, lanes: 2, limit: 60, rank: 5 },
  road: { width: 6.0, lanes: 2, limit: 40, rank: 6 },
  living_street: { width: 5.0, lanes: 1, limit: 20, rank: 6 },
  service: { width: 4.8, lanes: 1, limit: 20, rank: 7 },
};

const NON_CAR_HIGHWAYS = new Set([
  "footway",
  "path",
  "cycleway",
  "steps",
  "pedestrian",
  "bridleway",
  "corridor",
  "platform",
  "track",
]);

const BARRIER_KINDS = new Set([
  "fence",
  "wall",
  "city_wall",
  "guard_rail",
  "jersey_barrier",
  "handrail",
  "hedge",
  "retaining_wall",
]);

export type NormalizedOsmPack = {
  meta: MapPackMeta;
  roads: RoadSegment[];
  buildings: ObstacleBox[];
  /** Дополнительные объекты окружения из тегов OSM (ограждения, бордюры, деревья, опоры, островки). */
  extraObstacles: ObstacleBox[];
  /** Дорожные знаки, распознанные из тегов OSM (`highway=stop|give_way`, `traffic_sign=*`, `amenity=parking`). */
  signs: RoadSignDef[];
  signals: TrafficSignalDef[];
  crosswalks: CrosswalkDef[];
  speedZones: SpeedZone[];
  suggestedStart: { x: number; z: number; h: number };
  /** Экзаменационный маршрут, собранный по реальной дороге участка. */
  routeCheckpoints: RouteCheckpoint[];
  routeRoadName: string;
  /** Точный неквадратный охватывающий прямоугольник участка (до ±3000 м). */
  bounds: WorldBounds;
  /** Произвольный полигон границы участка/маршрута (если задан в файле или при обрезке). */
  boundaryPolygon?: Vec2[];
};

type GeoJsonGeometry = {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
};

type GeoJsonFeature = {
  type: "Feature";
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: GeoJsonGeometry | null;
};

/** Привязка узла OSM к реальному `way` дороги (для точного `direction=forward|backward` и ориентации знаков/светофоров). */
type NodeRoadAttachment = {
  roadId: string;
  width: number;
  rank: number;
  /** Курс вдоль дороги в системе симулятора (уже после разворота `oneway=-1`). */
  h: number;
  /** Был ли исходный `way` OSM развёрнут из-за `oneway=-1`. */
  wasReversed: boolean;
  oneway: boolean;
  layer: number;
  isInterior: boolean;
};

function parsePositiveInt(val: string | undefined): number | null {
  if (!val) return null;
  const m = String(val).match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Вычисляет согласованные `lanes` и `width` реальной дороги OSM (без зауженных 4-полосных улиц). */
function resolveRoadLanesAndWidth(
  tags: Record<string, string>,
  preset: HighwayPreset,
  oneway: boolean
): { lanes: number; width: number } {
  const lanesTag = parsePositiveInt(tags.lanes);
  const lanesFwd = parsePositiveInt(tags["lanes:forward"]);
  const lanesBwd = parsePositiveInt(tags["lanes:backward"]);
  const explicitLanes =
    lanesTag ??
    (lanesFwd && lanesBwd ? lanesFwd + lanesBwd : oneway && lanesFwd ? lanesFwd : null);

  const lanes = Math.max(1, Math.min(8, explicitLanes ?? preset.lanes));
  const widthTag = parseOsmMeters(tags.width ?? tags["width:carriageway"] ?? tags.est_width);

  let width: number;
  if (widthTag !== null && widthTag >= 2.2) {
    width = widthTag;
  } else if (explicitLanes !== null) {
    const isSlow = tags.highway === "service" || tags.highway === "living_street";
    const laneW = isSlow ? 3.0 : oneway && lanes === 1 ? 3.8 : 3.25;
    width = oneway && lanes === 1 ? Math.min(preset.width, Math.max(3.8, lanes * laneW)) : Math.max(preset.width, lanes * laneW);
  } else {
    width = preset.width;
  }

  return {
    lanes,
    width: Number(Math.min(28, Math.max(3.2, width)).toFixed(2)),
  };
}

/** Переводит компасный/градусный азимут OSM (0° = север, 90° = восток) в курс симулятора `h` (+Z север, +h влево/запад). */
function parseCompassDirectionRad(tags: Record<string, string>): number | null {
  const raw = tags["traffic_signals:direction"] ?? tags["traffic_sign:direction"] ?? tags.direction;
  if (!raw) return null;
  const cardinal: Record<string, number> = {
    N: 0,
    S: Math.PI,
    E: -Math.PI / 2,
    W: Math.PI / 2,
    NE: -Math.PI / 4,
    NW: Math.PI / 4,
    SE: (-3 * Math.PI) / 4,
    SW: (3 * Math.PI) / 4,
  };
  const upper = raw.trim().toUpperCase();
  if (cardinal[upper] !== undefined) return Number(cardinal[upper].toFixed(3));
  const numMatch = raw.trim().match(/^-?\d+(?:\.\d+)?$/);
  if (numMatch) {
    const deg = Number(numMatch[0]);
    if (deg >= -360 && deg <= 360) {
      return Number(normalizeHeading((-deg * Math.PI) / 180).toFixed(3));
    }
  }
  return null;
}

/** Извлекает относительное направление вдоль `way` OSM (`forward` / `backward`). */
function parseRelativeWayDirection(tags: Record<string, string>): "forward" | "backward" | null {
  const raw = (
    tags["traffic_signals:direction"] ??
    tags["traffic_sign:direction"] ??
    tags.direction ??
    ""
  )
    .trim()
    .toLowerCase();
  if (raw === "forward") return "forward";
  if (raw === "backward") return "backward";
  return null;
}

/** Выбирает основную дорогу для узла (для знаков `stop`/`give_way` приоритет у второстепенного примыкания). */
function selectNodeAttachment(
  attachments: readonly NodeRoadAttachment[] | undefined,
  preferMinorRoad: boolean
): NodeRoadAttachment | null {
  if (!attachments || attachments.length === 0) return null;
  if (attachments.length === 1) return attachments[0];
  const sorted = [...attachments].sort((a, b) => {
    // Для знаков уступи/STOP берём более второстепенную улицу; для переходов — более крупную
    if (a.rank !== b.rank) return preferMinorRoad ? b.rank - a.rank : a.rank - b.rank;
    if (a.isInterior !== b.isInterior) return a.isInterior ? -1 : 1;
    return b.width - a.width;
  });
  return sorted[0];
}

function polylineToBarrierObstacles(
  baseId: string,
  pts: readonly Vec2[],
  barrierTag: string,
  limitLeft: number
): ObstacleBox[] {
  const out: ObstacleBox[] = [];
  const isKerb = barrierTag === "kerb";
  for (let i = 0; i < pts.length - 1 && out.length < limitLeft; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.0 || len > 180) continue;
    const cx = (p0.x + p1.x) / 2;
    const cz = (p0.z + p1.z) / 2;
    if (Math.abs(cx) > MAX_WORLD_COORD || Math.abs(cz) > MAX_WORLD_COORD) continue;
    out.push({
      id: `${baseId}-${i + 1}`,
      kind: isKerb ? "curb" : "fence",
      cx: Number(cx.toFixed(2)),
      cz: Number(cz.toFixed(2)),
      halfX: isKerb ? 0.16 : 0.12,
      halfZ: Number((len / 2).toFixed(2)),
      h: Number(Math.atan2(dx, dz).toFixed(3)),
      height: isKerb ? 0.16 : barrierTag === "wall" || barrierTag === "city_wall" ? 1.8 : 1.15,
      color: isKerb ? 0x9aa6b2 : barrierTag === "hedge" ? 0x2f6a44 : 0x64748b,
      label: isKerb ? "бордюр OSM" : `ограждение (${barrierTag})`,
    });
  }
  return out;
}

/** Распознаёт дорожный знак из тегов узла OSM (`highway`, `traffic_sign`, `maxspeed`, `amenity`). */
function classifyOsmNodeSign(tags: Record<string, string>): { kind: RoadSignKind; limitKmh?: number } | null {
  if (tags.highway === "stop") return { kind: "stop" };
  if (tags.highway === "give_way") return { kind: "give_way" };
  if (tags.amenity === "parking" && !tags.building && tags.parking !== "underground") {
    return { kind: "parking" };
  }

  const ts = (tags.traffic_sign ?? "").toLowerCase();
  if (!ts || ts === "no" || ts === "none" || ts === "city_limit") return null;

  if (ts.includes("maxspeed") || ts.includes("3.24")) {
    const fromTag = parseOsmMaxspeedKmh(tags.maxspeed);
    const bracket = ts.match(/(?:3\.24|maxspeed)[^\d]{0,4}(\d{1,3}(?:\s*mph)?)/);
    const fromBracket = bracket ? parseOsmMaxspeedKmh(bracket[1]) : null;
    const limit = fromTag ?? fromBracket ?? 40;
    return { kind: "speed_limit", limitKmh: Math.min(110, Math.max(5, limit)) };
  }
  if (ts.includes("2.5") || /\bstop\b/.test(ts)) return { kind: "stop" };
  if (ts.includes("2.4") || ts.includes("give_way") || ts.includes("yield")) return { kind: "give_way" };
  if (ts.includes("2.1") || ts.includes("priority_road")) return { kind: "main_road" };
  if (ts.includes("5.19") || ts.includes("pedestrian_crossing")) return { kind: "crosswalk" };
  if (ts.includes("3.27") || ts.includes("no_stopping")) return { kind: "no_stopping" };
  if (ts.includes("3.1") || ts.includes("no_entry")) return { kind: "no_entry" };
  if (ts.includes("6.4") || ts.includes("parking")) return { kind: "parking" };
  if (ts.includes("4.1.2") || ts.includes("turn_right")) return { kind: "turn_right" };
  if (ts.includes("4.1.3") || ts.includes("turn_left")) return { kind: "turn_left" };
  if (ts.includes("4.1.1") || ts.includes("ahead_only")) return { kind: "ahead_only" };
  if (ts.includes("5.21") || ts.includes("living_street")) return { kind: "living_zone", limitKmh: 20 };
  return null;
}

/** Сшивает набор `way`-участников отношения `type=multipolygon` в замкнутые полигональные кольца. */
function assembleRelationRings(
  members: readonly RawOsmMember[],
  role: "outer" | "inner",
  wayPointsById: ReadonlyMap<number, Vec2[]>,
  project: (lat: number, lon: number) => Vec2
): Vec2[][] {
  const segs: Vec2[][] = [];
  for (const m of members) {
    if (m.type !== "way") continue;
    const normRole = m.role.trim().toLowerCase();
    if (role === "outer" ? normRole !== "outer" && normRole !== "" : normRole !== "inner") continue;
    let pts: Vec2[] | undefined;
    if (Array.isArray(m.geometry) && m.geometry.length >= 2) {
      pts = m.geometry.map((g) => project(g.lat, g.lon));
    } else {
      pts = wayPointsById.get(m.ref);
    }
    if (pts && pts.length >= 2) segs.push(pts.map((p) => ({ ...p })));
  }
  if (segs.length === 0) return [];

  const used = new Array<boolean>(segs.length).fill(false);
  const rings: Vec2[][] = [];
  const closeTol = 1.5;

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = segs[i];
    let merged = true;
    while (merged) {
      merged = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (chain.length >= 4 && Math.hypot(head.x - tail.x, head.z - tail.z) <= closeTol) break;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const cand = segs[j];
        const cHead = cand[0];
        const cTail = cand[cand.length - 1];
        if (Math.hypot(tail.x - cHead.x, tail.z - cHead.z) <= closeTol) {
          chain = [...chain, ...cand.slice(1)];
          used[j] = true;
          merged = true;
          break;
        }
        if (Math.hypot(tail.x - cTail.x, tail.z - cTail.z) <= closeTol) {
          chain = [...chain, ...[...cand].reverse().slice(1)];
          used[j] = true;
          merged = true;
          break;
        }
      }
    }
    if (chain.length >= 3) rings.push(chain);
  }
  return rings;
}

/** Добавляет авто-знак скоростного режима дороги без дублей на соседних `way` и без наезда на перекрёстки. */
function maybeAddRoadSpeedSign(
  signId: string,
  road: RoadSegment,
  explicitMaxspeed: number | null,
  roadIndex: RoadCorridorIndex,
  signs: RoadSignDef[],
  speedZones: SpeedZone[],
  counters: ImportConflictCounters
): void {
  // Дворовые проезды `service` не создают круговых зон 20 км/ч, чтобы не снижать лимит на соседних улицах
  if (road.highway === "service") return;
  const effective = explicitMaxspeed ?? (road.highway === "living_street" ? 20 : null);
  if (effective === null || effective > 40 || signs.length >= 120 || speedZones.length >= 40) return;

  const pts = road.points;
  const midIdx = Math.floor(pts.length / 2);
  const mid = pts[midIdx];
  const prev = pts[Math.max(0, midIdx - 1)];
  const next = pts[Math.min(pts.length - 1, midIdx + 1)];
  const segH = Number(Math.atan2(next.x - prev.x, next.z - prev.z).toFixed(3));

  // В реальном OSM одна улица разбита на десятки коротких way — не дублируем одинаковый знак каждые 20 м
  const dup = signs.some(
    (s) =>
      (s.kind === "speed_limit" || s.kind === "living_zone") &&
      s.limitKmh === effective &&
      Math.hypot((s.zoneX ?? s.x) - mid.x, (s.zoneZ ?? s.z) - mid.z) < 55
  );
  if (dup) {
    counters.deduplicatedControls += 1;
    return;
  }

  const desiredRadius = Math.min(28, Math.max(12, Math.round(road.width * 2.2)));
  const safeRadius = fitSpeedZoneRadius(mid.x, mid.z, effective, desiredRadius, road.width, road.name, roadIndex);
  if (safeRadius === null) {
    counters.trimmedSpeedZones += 1;
    return;
  }
  if (safeRadius < desiredRadius - 0.5) counters.trimmedSpeedZones += 1;

  const initX = Number((mid.x - Math.cos(segH) * (road.width / 2 + 1.1)).toFixed(2));
  const initZ = Number((mid.z + Math.sin(segH) * (road.width / 2 + 1.1)).toFixed(2));
  const kind: RoadSignKind = road.highway === "living_street" && effective <= 20 ? "living_zone" : "speed_limit";
  const rawSign: RoadSignDef = {
    id: signId,
    kind,
    x: initX,
    z: initZ,
    h: segH,
    limitKmh: effective,
    zoneRadius: safeRadius,
    zoneX: mid.x,
    zoneZ: mid.z,
    label:
      kind === "living_zone"
        ? `Знак 5.21 «Жилая зона» (${road.name || "20 км/ч"})`
        : `Знак 3.24 «${effective}» (${road.name || road.highway})`,
  };
  const placed = placeSignPostClearOfRoads(rawSign, roadIndex);
  if (placed.shifted) counters.alignedSignsAndSignals += 1;
  signs.push(placed.sign);
  const sz = signToSpeedZone(placed.sign);
  if (sz) speedZones.push(sz);
}

function collectPointFeature(
  idSuffix: string,
  p: Vec2,
  tags: Record<string, string>,
  roads: readonly RoadSegment[],
  roadIndex: RoadCorridorIndex,
  attachments: readonly NodeRoadAttachment[] | undefined,
  onNonCarWayOnly: boolean,
  signals: TrafficSignalDef[],
  crosswalks: CrosswalkDef[],
  signs: RoadSignDef[],
  speedZones: SpeedZone[],
  extraObstacles: ObstacleBox[],
  counters: ImportConflictCounters
): void {
  if (Math.abs(p.x) > MAX_WORLD_COORD || Math.abs(p.z) > MAX_WORLD_COORD) return;
  // Железнодорожные/трамвайные светофоры и переезды без автомобильного highway не превращаем в авто-светофоры
  if (tags.railway && !tags.highway) return;

  const isStopOrYield = tags.highway === "stop" || tags.highway === "give_way";
  const isCrossing = tags.highway === "crossing";
  const isSignal = tags.highway === "traffic_signals";

  const attached = selectNodeAttachment(attachments, isStopOrYield || isSignal);
  const snap = !attached && roads.length > 0 ? nearestRoadPoint(p.x, p.z, roads) : null;
  const roadW = attached ? attached.width : snap && snap.dist <= 16 ? snap.road.width : 7.5;
  const roadOneway = attached ? attached.oneway : Boolean(snap?.road.oneway);
  const roadName = snap?.road.name;

  // Вычисляем точный курс с поддержкой и компасных азимутов, и OSM `direction=forward|backward`
  const compassH = parseCompassDirectionRad(tags);
  const relDir = parseRelativeWayDirection(tags);
  let baseH = attached ? attached.h : snap && snap.dist <= 16 ? snap.h : 0;
  if (relDir && attached) {
    // В OSM `forward` означает по исходному порядку узлов way, `backward` — против него
    const flipForOriginal = attached.wasReversed ? relDir === "forward" : relDir === "backward";
    if (flipForOriginal && !attached.oneway) {
      baseH = normalizeHeading(baseH + Math.PI);
    } else if (flipForOriginal && attached.oneway && relDir === "backward") {
      baseH = normalizeHeading(baseH + Math.PI);
    }
  } else if (relDir === "backward" && !attached && snap && !snap.road.oneway) {
    baseH = normalizeHeading(baseH + Math.PI);
  }
  const h = Number((compassH ?? baseH).toFixed(3));

  if (isSignal && signals.length < 48) {
    if (tags["traffic_signals"] === "pedestrian_crossing" && onNonCarWayOnly) return;
    // Отбрасываем чисто пешеходные/трамвайные светофоры вдали от проезжей части
    if (!attached && roads.length > 0 && (!snap || snap.dist > snap.road.width * 0.5 + (onNonCarWayOnly ? 0.6 : 4.5))) {
      return;
    }
    // Пропускаем светофоры на эстакадах/в тоннелях, чтобы они не останавливали улицу на уровне земли
    if (attached && attached.layer !== 0) return;

    const { signal, adjusted } = buildDeconflictedSignal(
      `sig-${idSuffix}`,
      p,
      h,
      { width: roadW, oneway: roadOneway },
      signals.length,
      roadIndex
    );
    if (isDuplicateSignal(signals, signal)) {
      counters.deduplicatedControls += 1;
      return;
    }
    if (adjusted) counters.alignedSignsAndSignals += 1;
    signals.push(signal);
    return;
  }

  if (isCrossing && crosswalks.length < 40) {
    if (tags.crossing === "no" || tags.crossing === "informal") return;
    // Переход на тротуаре/велодорожке в стороне от автодороги не должен рисовать ложную зебру на шоссе
    if (!attached && roads.length > 0) {
      const maxDist = onNonCarWayOnly ? 0.8 : 2.2;
      if (!snap || snap.dist > snap.road.width * 0.5 + maxDist) return;
    }
    if (attached && attached.layer !== 0) return;
    if (isDuplicateCrosswalk(crosswalks, p.x, p.z, h)) {
      counters.deduplicatedControls += 1;
      return;
    }
    crosswalks.push({
      id: `cw-${idSuffix}`,
      cx: p.x,
      cz: p.z,
      width: Number(Math.min(24, Math.max(4.4, roadW)).toFixed(1)),
      length: 3.4,
      h,
      pedSpeed: 1.25,
      pedPhaseOffset: crosswalks.length * 4.5,
    });
    return;
  }

  const signInfo = classifyOsmNodeSign(tags);
  if (signInfo && signs.length < 120) {
    if (onNonCarWayOnly && !attached && signInfo.kind !== "parking") return;
    const rawSign = createDefaultSign(`sign-${idSuffix}`, signInfo.kind, p.x, p.z, h, signInfo.limitKmh);
    if (tags.name) rawSign.label = `${rawSign.label} (${tags.name})`;

    // Если узел знака стоял прямо на оси `highway=*` (как принято в OSM для `highway=stop|give_way`),
    // выносим физическую стойку знака на правую обочину и за пределы перекрёстка
    const { sign, shifted } = placeSignPostClearOfRoads(rawSign, roadIndex);
    if (shifted) counters.alignedSignsAndSignals += 1;

    const dupSign = signs.some(
      (s) => s.kind === sign.kind && s.limitKmh === sign.limitKmh && Math.hypot(s.x - sign.x, s.z - sign.z) < 4.5
    );
    if (dupSign) {
      counters.deduplicatedControls += 1;
      return;
    }

    if ((sign.kind === "speed_limit" || sign.kind === "living_zone") && sign.limitKmh) {
      const zx = sign.zoneX ?? p.x;
      const zz = sign.zoneZ ?? p.z;
      const safeR = fitSpeedZoneRadius(
        zx,
        zz,
        sign.limitKmh,
        sign.zoneRadius ?? 22,
        roadW,
        roadName,
        roadIndex
      );
      if (safeR !== null) {
        if (safeR < (sign.zoneRadius ?? 22) - 0.5) counters.trimmedSpeedZones += 1;
        sign.zoneRadius = safeR;
        sign.zoneX = zx;
        sign.zoneZ = zz;
        const sz = signToSpeedZone(sign);
        if (sz && speedZones.length < 40) speedZones.push(sz);
      } else {
        sign.zoneRadius = 0;
        counters.trimmedSpeedZones += 1;
      }
    }
    signs.push(sign);
    return;
  }

  if (extraObstacles.length >= 240) return;

  let rawObs: ObstacleBox | null = null;
  if (tags.natural === "tree") {
    rawObs = {
      id: `tree-${idSuffix}`,
      kind: "tree",
      cx: p.x,
      cz: p.z,
      halfX: 0.45,
      halfZ: 0.45,
      h: 0,
      height: 4.2,
      color: 0x2f6a44,
      label: "дерево OSM",
    };
  } else if (tags.highway === "street_lamp" || tags.power === "pole") {
    rawObs = {
      id: `pole-${idSuffix}`,
      kind: "pole",
      cx: p.x,
      cz: p.z,
      halfX: 0.18,
      halfZ: 0.18,
      h: 0,
      height: 3.4,
      color: 0x94a3b8,
      label: "опора OSM",
    };
  } else if (tags.traffic_calming === "island") {
    rawObs = {
      id: `island-${idSuffix}`,
      kind: "island",
      cx: p.x,
      cz: p.z,
      halfX: 1.2,
      halfZ: 2.8,
      h,
      height: 0.2,
      color: 0x3b6e4c,
      label: "островок безопасности OSM",
    };
  }

  if (rawObs) {
    const res = deconflictPointObstacle(rawObs, roadIndex);
    if (res.changed) counters.shiftedObstacles += 1;
    if (res.obstacle) extraObstacles.push(res.obstacle);
  }
}

/** Извлекает `[minLon, minLat, maxLon, maxLat]` из поля `bounds` Overpass JSON или `bbox` GeoJSON. */
function extractJsonExportBbox(obj: Record<string, unknown>): [number, number, number, number] | undefined {
  const b = obj.bounds;
  if (b && typeof b === "object") {
    const rec = b as Record<string, unknown>;
    const minLat = Number(rec.minlat);
    const minLon = Number(rec.minlon);
    const maxLat = Number(rec.maxlat);
    const maxLon = Number(rec.maxlon);
    if (
      Number.isFinite(minLat) &&
      Number.isFinite(minLon) &&
      Number.isFinite(maxLat) &&
      Number.isFinite(maxLon) &&
      maxLat > minLat &&
      maxLon > minLon
    ) {
      return [minLon, minLat, maxLon, maxLat];
    }
  }
  if (Array.isArray(obj.bbox) && obj.bbox.length >= 4) {
    const minLon = Number(obj.bbox[0]);
    const minLat = Number(obj.bbox[1]);
    const maxLon = Number(obj.bbox[obj.bbox.length >= 6 ? 3 : 2]);
    const maxLat = Number(obj.bbox[obj.bbox.length >= 6 ? 4 : 3]);
    if (
      Number.isFinite(minLat) &&
      Number.isFinite(minLon) &&
      Number.isFinite(maxLat) &&
      Number.isFinite(maxLon) &&
      maxLat > minLat &&
      maxLon > minLon
    ) {
      return [minLon, minLat, maxLon, maxLat];
    }
  }
  return undefined;
}

/**
 * Разбирает Overpass OSM JSON (`{ elements, bounds? }`) или GeoJSON (`FeatureCollection`)
 * в нормализованный офлайн-пакет карты с точной проекцией WGS84 и устранением конфликтов с улицами.
 */
export function parseOsmOrGeoJson(raw: unknown, title = "Импортированный участок OSM"): NormalizedOsmPack {
  if (!raw || typeof raw !== "object") {
    throw new Error("Файл пуст или не является корректным JSON-объектом.");
  }
  const obj = raw as Record<string, unknown>;
  const exportBbox = extractJsonExportBbox(obj);

  if (Array.isArray(obj.elements)) {
    return parseOverpassElements(
      obj.elements as RawOsmElement[],
      title,
      "Локальный импорт Overpass OSM JSON (офлайн)",
      exportBbox
    );
  }
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return parseGeoJsonFeatures(obj.features as GeoJsonFeature[], title, exportBbox);
  }
  throw new Error("Ожидается Overpass OSM JSON (поле elements) или GeoJSON FeatureCollection.");
}

/**
 * Разбирает стандартный файл `.osm` (XML с openstreetmap.org / JOSM / Overpass) в офлайн-пакет карты.
 * Учитывает `<bounds/>`, мультиполигоны зданий с дворами, `oneway`, `layer` и устраняет конфликты с дорогами.
 */
export function parseOsmXml(xml: string, title = "Импортированный участок .osm"): NormalizedOsmPack {
  const { elements, exportBbox } = parseOsmXmlDocument(xml);
  return parseOverpassElements(
    elements,
    title,
    "Локальный импорт OSM XML (.osm, офлайн)",
    exportBbox
  );
}

/**
 * Универсальный офлайн-разбор текстового файла карты: автоматически определяет
 * `.osm` XML, Overpass OSM JSON или GeoJSON и сохраняет атрибуцию ODbL 1.0.
 */
export function parseMapFileText(
  text: string,
  fileName = "map.osm",
  customTitle?: string
): { pack: NormalizedOsmPack; format: MapImportFormat } {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("Выбранный файл пуст.");
  }
  const cleanName = fileName.replace(/\.(osm|xml|geojson|json)$/i, "") || "участок";
  const title = customTitle ?? `OSM: ${cleanName}`;

  if (trimmed.startsWith("<")) {
    return { pack: parseOsmXml(trimmed, title), format: "osm_xml" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Не удалось разобрать файл: ожидается .osm XML, Overpass JSON или GeoJSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Файл не содержит объект карты OSM или GeoJSON.");
  }
  const obj = parsed as Record<string, unknown>;
  const format: MapImportFormat = obj.type === "FeatureCollection" ? "geojson" : "osm_json";
  return { pack: parseOsmOrGeoJson(parsed, title), format };
}

function parseOverpassElements(
  elements: RawOsmElement[],
  title: string,
  source: string,
  exportBbox?: [number, number, number, number]
): NormalizedOsmPack {
  const counters = createConflictCounters();
  const nodeMap = new Map<number, { lat: number; lon: number; tags?: Record<string, string> }>();
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const trackCoord = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  };

  for (const el of elements) {
    if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
      nodeMap.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags });
      trackCoord(el.lat, el.lon);
    } else if (el.type === "way" && Array.isArray(el.geometry)) {
      for (const g of el.geometry) trackCoord(g.lat, g.lon);
    } else if (el.type === "relation" && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (Array.isArray(m.geometry)) {
          for (const g of m.geometry) trackCoord(g.lat, g.lon);
        }
      }
    }
  }

  if (!Number.isFinite(minLat)) {
    throw new Error("В OSM-файле не найдено ни одного узла с координатами (lat/lon).");
  }

  // Точная касательная проекция WGS84 с центром в окне экспорта <bounds/> (или по узлам файла)
  const centerLat = exportBbox ? (exportBbox[1] + exportBbox[3]) / 2 : (minLat + maxLat) / 2;
  const centerLon = exportBbox ? (exportBbox[0] + exportBbox[2]) / 2 : (minLon + maxLon) / 2;
  const projector = createWgs84Projector(centerLat, centerLon);
  const project = projector.project;

  // Точное окно подрезки по <bounds/> (+24 м на примыкание перекрёстков): отсекает километровые хвосты транзитных way
  let clipPoly: Vec2[] | undefined;
  if (exportBbox) {
    const sw = project(exportBbox[1], exportBbox[0]);
    const ne = project(exportBbox[3], exportBbox[2]);
    const margin = 24;
    clipPoly = boundsToPolygon({
      minX: Math.max(-MAX_WORLD_COORD + 20, Math.min(sw.x, ne.x) - margin),
      maxX: Math.min(MAX_WORLD_COORD - 20, Math.max(sw.x, ne.x) + margin),
      minZ: Math.max(-MAX_WORLD_COORD + 20, Math.min(sw.z, ne.z) - margin),
      maxZ: Math.min(MAX_WORLD_COORD - 20, Math.max(sw.z, ne.z) + margin),
    });
  } else {
    const limit = MAX_WORLD_COORD - 40;
    clipPoly = boundsToPolygon({ minX: -limit, maxX: limit, minZ: -limit, maxZ: limit });
  }

  // Собираем геометрию всех way, ворота/шлагбаумы и список узлов пешеходных/рельсовых путей
  const wayPointsById = new Map<number, Vec2[]>();
  const gatePoints: Vec2[] = [];
  const nonCarWayNodes = new Set<number>();
  const nodeAttachments = new Map<number, NodeRoadAttachment[]>();

  for (const el of elements) {
    if (el.type === "node" && el.tags && typeof el.lat === "number" && typeof el.lon === "number") {
      if (
        (el.tags.barrier && GATE_BARRIER_KINDS.has(el.tags.barrier)) ||
        el.tags.entrance === "yes" ||
        el.tags.entrance === "garage"
      ) {
        gatePoints.push(project(el.lat, el.lon));
      }
    } else if (el.type === "way") {
      const rawPts: Vec2[] = [];
      if (Array.isArray(el.geometry) && el.geometry.length > 0) {
        for (const g of el.geometry) rawPts.push(project(g.lat, g.lon));
      } else if (Array.isArray(el.nodes)) {
        for (const nid of el.nodes) {
          const n = nodeMap.get(nid);
          if (n) rawPts.push(project(n.lat, n.lon));
        }
      }
      if (rawPts.length >= 2) {
        wayPointsById.set(el.id, rawPts);
      }
      if (el.tags && Array.isArray(el.nodes)) {
        const hw = el.tags.highway;
        if ((hw && NON_CAR_HIGHWAYS.has(hw)) || (el.tags.railway && !hw)) {
          for (const nid of el.nodes) nonCarWayNodes.add(nid);
        }
      }
    }
  }

  // Проход 1: все реальные проезжие дороги (с `oneway`, `roundabout`, `layer`, `*_link` и реальной шириной полос)
  const roads: RoadSegment[] = [];
  const pendingAutoSpeedSigns: Array<{ signId: string; road: RoadSegment; explicitMaxspeed: number | null }> = [];
  const buildingCandidates: Array<{
    id: string;
    outer: Vec2[];
    inners: Vec2[][];
    tags: Record<string, string>;
    distSq: number;
  }> = [];
  const barrierCandidates: Array<{ id: string; pts: Vec2[]; barrier: string }> = [];
  let explicitBoundary: Vec2[] | undefined;

  // Отмечаем way, входящие в мультиполигоны зданий, чтобы не импортировать их контур дважды
  const consumedBuildingWayIds = new Set<number>();
  for (const el of elements) {
    if (el.type !== "relation" || !el.tags || !Array.isArray(el.members)) continue;
    if (
      !el.tags.building &&
      (el.tags["cdt:boundary"] === "yes" || el.tags.role === "boundary")
    ) {
      const outers = assembleRelationRings(el.members, "outer", wayPointsById, project);
      if (outers[0]) {
        const poly = sanitizeBoundaryPolygon(outers[0]);
        if (poly) explicitBoundary = poly;
      }
      continue;
    }
    const relType = (el.tags.type ?? "").toLowerCase();
    if ((relType === "multipolygon" || relType === "building") && el.tags.building) {
      for (const m of el.members) {
        if (m.type === "way") consumedBuildingWayIds.add(m.ref);
      }
      if (isNonBlockingBuilding(el.tags)) {
        counters.skippedNonBlockingBuildings += 1;
        continue;
      }
      const outers = assembleRelationRings(el.members, "outer", wayPointsById, project);
      const inners = assembleRelationRings(el.members, "inner", wayPointsById, project);
      outers.forEach((outer, oIdx) => {
        const c = outer[0];
        buildingCandidates.push({
          id: oIdx === 0 ? `rel-bld-${el.id}` : `rel-bld-${el.id}-${oIdx + 1}`,
          outer,
          inners,
          tags: el.tags!,
          distSq: c.x * c.x + c.z * c.z,
        });
      });
    }
  }

  for (const el of elements) {
    if (el.type !== "way" || !el.tags) continue;
    const rawPts = wayPointsById.get(el.id);
    if (!rawPts || rawPts.length < 2) continue;

    // Явная пользовательская граница маршрута (`cdt:boundary=yes`)
    if (!el.tags.building && !el.tags.highway && el.tags["cdt:boundary"] === "yes") {
      const poly = sanitizeBoundaryPolygon(rawPts);
      if (poly) explicitBoundary = poly;
      continue;
    }

    const hw = el.tags.highway;
    const preset = hw ? HIGHWAY_WIDTHS[hw] : undefined;
    if (hw && preset) {
      if (!isDrivableOsmWay(el.tags, true)) {
        counters.skippedNonDrivableWays += 1;
        continue;
      }
      const ow = parseOsmOneway(el.tags, hw);
      const layer = parseOsmLayer(el.tags);
      const directedRaw = ow.reverse ? [...rawPts].reverse() : rawPts;
      const directed = cleanRoadPolyline(directedRaw, 0.25);
      if (directed.length < 2) continue;

      const pieces = clipPoly ? clipPolylineToPolygon(directed, clipPoly) : [directed];
      if (pieces.length === 0) continue;

      const { lanes, width } = resolveRoadLanesAndWidth(el.tags, preset, ow.oneway);
      const explicitMaxspeed = parseOsmMaxspeedKmh(el.tags.maxspeed);
      const speedLimitKmh = explicitMaxspeed ?? preset.limit;

      // Привязываем узлы этого way к точному курсу дороги (для светофоров, переходов и знаков STOP/2.4)
      if (Array.isArray(el.nodes) && el.nodes.length >= 2) {
        const orderedNodes = ow.reverse ? [...el.nodes].reverse() : el.nodes;
        const orderedPts: Array<{ nid: number; pt: Vec2 }> = [];
        for (const nid of orderedNodes) {
          const n = nodeMap.get(nid);
          if (n) orderedPts.push({ nid, pt: project(n.lat, n.lon) });
        }
        for (let k = 0; k < orderedPts.length; k++) {
          const prev = orderedPts[Math.max(0, k - 1)].pt;
          const next = orderedPts[Math.min(orderedPts.length - 1, k + 1)].pt;
          if (Math.hypot(next.x - prev.x, next.z - prev.z) < 0.1) continue;
          const segH = Math.atan2(next.x - prev.x, next.z - prev.z);
          const nid = orderedPts[k].nid;
          const list = nodeAttachments.get(nid) ?? [];
          list.push({
            roadId: `way-${el.id}`,
            width,
            rank: preset.rank,
            h: segH,
            wasReversed: ow.reverse,
            oneway: ow.oneway,
            layer,
            isInterior: k > 0 && k < orderedPts.length - 1,
          });
          nodeAttachments.set(nid, list);
        }
      }

      pieces.forEach((pts, pIdx) => {
        const cleaned = cleanRoadPolyline(pts, 0.25);
        if (cleaned.length < 2) return;
        const roadId = pIdx === 0 ? `way-${el.id}` : `way-${el.id}-${pIdx + 1}`;
        const road: RoadSegment = {
          id: roadId,
          points: cleaned,
          width,
          lanes,
          highway: hw,
          name: el.tags!.name,
          // На односторонних улицах осевая линия разделяет попутные полосы (пунктир, а не встречная сплошная)
          hasSolidCenter: !ow.oneway && lanes >= 2 && width >= 7,
          speedLimitKmh,
          ...(ow.oneway ? { oneway: true } : {}),
          ...(ow.roundabout ? { roundabout: true } : {}),
          ...(layer !== 0 ? { layer } : {}),
          ...(el.tags!.service ? { service: el.tags!.service } : {}),
        };
        roads.push(road);
        if (pIdx === 0 && layer === 0) {
          pendingAutoSpeedSigns.push({ signId: `sign-way-${el.id}`, road, explicitMaxspeed });
        }
      });
    } else if (el.tags.building && !consumedBuildingWayIds.has(el.id)) {
      if (isNonBlockingBuilding(el.tags)) {
        counters.skippedNonBlockingBuildings += 1;
        continue;
      }
      const c = rawPts[0];
      buildingCandidates.push({
        id: `bld-${el.id}`,
        outer: rawPts,
        inners: [],
        tags: el.tags,
        distSq: c.x * c.x + c.z * c.z,
      });
    } else if (
      el.tags.barrier &&
      (BARRIER_KINDS.has(el.tags.barrier) || el.tags.barrier === "kerb") &&
      parseOsmLayer(el.tags) === 0
    ) {
      const pieces = clipPoly ? clipPolylineToPolygon(rawPts, clipPoly) : [rawPts];
      pieces.forEach((piece, idx) => {
        barrierCandidates.push({
          id: idx === 0 ? `bar-${el.id}` : `bar-${el.id}-p${idx + 1}`,
          pts: piece,
          barrier: el.tags!.barrier!,
        });
      });
    }
  }

  // Индекс всех наземных проезжих частей для мгновенного устранения конфликтов геометрии
  const roadIndex = new RoadCorridorIndex(roads, true);

  // Проход 2: сохраняем все здания в окне импорта. Визуализация и SpatialGrid используют
  // пространственное разбиение, поэтому глобальный лимит обрезал застройку без необходимости.
  const buildings: ObstacleBox[] = [];
  for (const cand of buildingCandidates) {
    const res = buildDeconflictedBuildingObstacles(
      cand.id,
      cand.outer,
      cand.inners,
      cand.tags,
      buildings.length,
      roadIndex
    );
    if (res.resolvedConflict) counters.adjustedBuildings += 1;
    for (const box of res.boxes) {
      if (!clipPoly || isPointInPolygon(box.cx, box.cz, clipPoly)) {
        buildings.push(box);
      }
    }
  }

  // Проход 3: ограждения, стены и бордюры с автоматической прорезкой проездов и ворот
  const extraObstacles: ObstacleBox[] = [];
  for (const bar of barrierCandidates) {
    if (extraObstacles.length >= 240) break;
    const isKerb = bar.barrier === "kerb";
    const clipped = clipPolylineOutsideRoads(bar.pts, roadIndex, {
      roadClearanceM: isKerb ? 0.25 : 0.6,
      gatePoints,
      gateHalfWidthM: 2.4,
      minPieceLenM: 1.0,
    });
    if (clipped.cutCount > 0) counters.openedBarriers += 1;
    clipped.pieces.forEach((piece, pIdx) => {
      if (extraObstacles.length >= 240) return;
      const segs = polylineToBarrierObstacles(
        pIdx === 0 ? bar.id : `${bar.id}-g${pIdx + 1}`,
        piece,
        bar.barrier,
        240 - extraObstacles.length
      );
      extraObstacles.push(...segs);
    });
  }

  // Проход 4: скоростные знаки дорог и точечные объекты OSM (светофоры, переходы, знаки, деревья, опоры, островки)
  const signs: RoadSignDef[] = [];
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];

  for (const item of pendingAutoSpeedSigns) {
    maybeAddRoadSpeedSign(item.signId, item.road, item.explicitMaxspeed, roadIndex, signs, speedZones, counters);
  }

  for (const el of elements) {
    if (el.type === "node" && el.tags && typeof el.lat === "number" && typeof el.lon === "number") {
      const p = project(el.lat, el.lon);
      if (clipPoly && !isPointInPolygon(p.x, p.z, clipPoly)) continue;
      const atts = nodeAttachments.get(el.id);
      const onNonCarOnly = (!atts || atts.length === 0) && nonCarWayNodes.has(el.id);
      collectPointFeature(
        String(el.id),
        p,
        el.tags,
        roads,
        roadIndex,
        atts,
        onNonCarOnly,
        signals,
        crosswalks,
        signs,
        speedZones,
        extraObstacles,
        counters
      );
    }
  }

  const finalBbox: [number, number, number, number] = exportBbox
    ? [
        Number(exportBbox[0].toFixed(5)),
        Number(exportBbox[1].toFixed(5)),
        Number(exportBbox[2].toFixed(5)),
        Number(exportBbox[3].toFixed(5)),
      ]
    : [
        Number(minLon.toFixed(5)),
        Number(minLat.toFixed(5)),
        Number(maxLon.toFixed(5)),
        Number(maxLat.toFixed(5)),
      ];

  const basePack = finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    finalBbox,
    { lat: projector.originLat, lon: projector.originLon },
    title,
    source,
    undefined,
    counters
  );

  return explicitBoundary ? cropOsmPackToPolygon(basePack, explicitBoundary) : basePack;
}

function flattenGeoJsonGeometries(
  geom: GeoJsonGeometry | null | undefined,
  out: GeoJsonGeometry[]
): void {
  if (!geom || !geom.type) return;
  if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
    for (const sub of geom.geometries) flattenGeoJsonGeometries(sub, out);
    return;
  }
  out.push(geom);
}

function parseGeoJsonFeatures(
  features: GeoJsonFeature[],
  title: string,
  exportBbox?: [number, number, number, number]
): NormalizedOsmPack {
  const counters = createConflictCounters();
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const visitCoords = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
      const lon = c[0];
      const lat = c[1];
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
      return;
    }
    for (const sub of c) visitCoords(sub);
  };

  const visitGeom = (g: GeoJsonGeometry | null | undefined): void => {
    if (!g) return;
    if (g.coordinates) visitCoords(g.coordinates);
    if (Array.isArray(g.geometries)) {
      for (const sub of g.geometries) visitGeom(sub);
    }
  };

  for (const f of features) visitGeom(f?.geometry);
  if (!Number.isFinite(minLat)) {
    throw new Error("В GeoJSON не найдено координат.");
  }

  const centerLat = exportBbox ? (exportBbox[1] + exportBbox[3]) / 2 : (minLat + maxLat) / 2;
  const centerLon = exportBbox ? (exportBbox[0] + exportBbox[2]) / 2 : (minLon + maxLon) / 2;
  const projector = createWgs84Projector(centerLat, centerLon);
  const project = projector.project;

  const roads: RoadSegment[] = [];
  const pendingAutoSpeedSigns: Array<{ signId: string; road: RoadSegment; explicitMaxspeed: number | null }> = [];
  const pendingBuildings: Array<{ id: string; outer: Vec2[]; inners: Vec2[][]; tags: Record<string, string> }> = [];
  const pendingBarriers: Array<{ id: string; pts: Vec2[]; barrier: string }> = [];
  const pendingPoints: Array<{ fid: string; p: Vec2; tags: Record<string, string> }> = [];
  const gatePoints: Vec2[] = [];
  let customBoundary: Vec2[] | undefined;

  const handleLineCoords = (lineId: string, coords: number[][], tags: Record<string, string>) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const rawPts = coords
      .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map(([lon, lat]) => project(lat, lon));
    if (rawPts.length < 2) return;

    if (tags.barrier && (BARRIER_KINDS.has(tags.barrier) || tags.barrier === "kerb") && !tags.highway) {
      if (parseOsmLayer(tags) === 0) {
        pendingBarriers.push({ id: `gj-bar-${lineId}`, pts: rawPts, barrier: tags.barrier });
      }
      return;
    }

    if (!tags.highway) {
      // В GeoJSON из Overpass линии рек, ЛЭП, трамваев и границ не должны превращаться в улицы
      if (tags.waterway || tags.railway || tags.power || tags.natural || tags.boundary || tags.landuse || tags.leisure) {
        return;
      }
    }
    const hw = tags.highway || "residential";
    const preset = HIGHWAY_WIDTHS[hw];
    if (!preset) {
      if (tags.highway && !NON_CAR_HIGHWAYS.has(tags.highway)) counters.skippedNonDrivableWays += 1;
      return;
    }
    if (!isDrivableOsmWay(tags, true)) {
      counters.skippedNonDrivableWays += 1;
      return;
    }

    const ow = parseOsmOneway(tags, hw);
    const layer = parseOsmLayer(tags);
    const pts = cleanRoadPolyline(ow.reverse ? [...rawPts].reverse() : rawPts, 0.25);
    if (pts.length < 2) return;

    const { lanes, width } = resolveRoadLanesAndWidth(tags, preset, ow.oneway);
    const explicitMaxspeed = parseOsmMaxspeedKmh(tags.maxspeed);
    const speedLimitKmh = explicitMaxspeed ?? preset.limit;
    const road: RoadSegment = {
      id: `gj-road-${lineId}`,
      points: pts,
      width,
      lanes,
      highway: hw,
      name: tags.name,
      hasSolidCenter: !ow.oneway && lanes >= 2 && width >= 7,
      speedLimitKmh,
      ...(ow.oneway ? { oneway: true } : {}),
      ...(ow.roundabout ? { roundabout: true } : {}),
      ...(layer !== 0 ? { layer } : {}),
      ...(tags.service ? { service: tags.service } : {}),
    };
    roads.push(road);
    if (layer === 0) {
      pendingAutoSpeedSigns.push({ signId: `gj-sign-${lineId}`, road, explicitMaxspeed });
    }
  };

  const handlePolygonRings = (polyId: string, ringsCoords: number[][][], tags: Record<string, string>) => {
    if (!Array.isArray(ringsCoords) || !Array.isArray(ringsCoords[0])) return;
    const toVecRing = (ring: number[][]) =>
      ring
        .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map(([lon, lat]) => project(lat, lon));

    const outer = toVecRing(ringsCoords[0]);
    if (outer.length < 3) return;

    // Явный полигон границы маршрута из GeoJSON (`boundary=route | cdt:boundary=yes | role=boundary`)
    if (
      !tags.building &&
      (tags.boundary === "route" || tags["cdt:boundary"] === "yes" || tags.role === "boundary")
    ) {
      const poly = sanitizeBoundaryPolygon(outer);
      if (poly) customBoundary = poly;
      return;
    }

    // Парки, кварталы `landuse=*`, водоёмы, парковки и административные границы НЕ являются зданиями!
    if (!tags.building) {
      counters.skippedLandusePolygons += 1;
      return;
    }
    if (isNonBlockingBuilding(tags)) {
      counters.skippedNonBlockingBuildings += 1;
      return;
    }
    const inners = ringsCoords.slice(1).map(toVecRing).filter((r) => r.length >= 3);
    pendingBuildings.push({ id: `gj-bld-${polyId}`, outer, inners, tags });
  };

  features.forEach((f, idx) => {
    const rawProps = f?.properties ?? {};
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (v !== undefined && v !== null) tags[k] = String(v);
    }
    const fid = String(f?.id ?? idx);
    const geoms: GeoJsonGeometry[] = [];
    flattenGeoJsonGeometries(f?.geometry, geoms);

    geoms.forEach((g, gIdx) => {
      const gid = geoms.length === 1 ? fid : `${fid}-${gIdx + 1}`;
      if (g.type === "LineString" && Array.isArray(g.coordinates)) {
        handleLineCoords(gid, g.coordinates as number[][], tags);
      } else if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) {
        (g.coordinates as number[][][]).forEach((line, lIdx) => {
          handleLineCoords(`${gid}-${lIdx + 1}`, line, tags);
        });
      } else if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
        handlePolygonRings(gid, g.coordinates as number[][][], tags);
      } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
        (g.coordinates as number[][][][]).forEach((poly, pIdx) => {
          handlePolygonRings(`${gid}-${pIdx + 1}`, poly, tags);
        });
      } else if (g.type === "Point" && Array.isArray(g.coordinates)) {
        const [lon, lat] = g.coordinates as number[];
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const p = project(lat, lon);
          if (tags.barrier && GATE_BARRIER_KINDS.has(tags.barrier)) gatePoints.push(p);
          pendingPoints.push({ fid: gid, p, tags });
        }
      } else if (g.type === "MultiPoint" && Array.isArray(g.coordinates)) {
        (g.coordinates as number[][]).forEach((coord, pIdx) => {
          if (!Array.isArray(coord) || coord.length < 2) return;
          const [lon, lat] = coord;
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const p = project(lat, lon);
            if (tags.barrier && GATE_BARRIER_KINDS.has(tags.barrier)) gatePoints.push(p);
            pendingPoints.push({ fid: `${gid}-${pIdx + 1}`, p, tags });
          }
        });
      }
    });
  });

  const roadIndex = new RoadCorridorIndex(roads, true);

  const buildings: ObstacleBox[] = [];
  for (const b of pendingBuildings) {
    const res = buildDeconflictedBuildingObstacles(b.id, b.outer, b.inners, b.tags, buildings.length, roadIndex);
    if (res.resolvedConflict) counters.adjustedBuildings += 1;
    buildings.push(...res.boxes);
  }

  const extraObstacles: ObstacleBox[] = [];
  for (const bar of pendingBarriers) {
    if (extraObstacles.length >= 240) break;
    const clipped = clipPolylineOutsideRoads(bar.pts, roadIndex, {
      roadClearanceM: bar.barrier === "kerb" ? 0.25 : 0.6,
      gatePoints,
      gateHalfWidthM: 2.4,
      minPieceLenM: 1.0,
    });
    if (clipped.cutCount > 0) counters.openedBarriers += 1;
    clipped.pieces.forEach((piece, pIdx) => {
      if (extraObstacles.length >= 240) return;
      extraObstacles.push(
        ...polylineToBarrierObstacles(
          pIdx === 0 ? bar.id : `${bar.id}-g${pIdx + 1}`,
          piece,
          bar.barrier,
          240 - extraObstacles.length
        )
      );
    });
  }

  const signs: RoadSignDef[] = [];
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];

  for (const item of pendingAutoSpeedSigns) {
    maybeAddRoadSpeedSign(item.signId, item.road, item.explicitMaxspeed, roadIndex, signs, speedZones, counters);
  }
  for (const pt of pendingPoints) {
    collectPointFeature(
      `gj-${pt.fid}`,
      pt.p,
      pt.tags,
      roads,
      roadIndex,
      undefined,
      false,
      signals,
      crosswalks,
      signs,
      speedZones,
      extraObstacles,
      counters
    );
  }

  const finalBbox: [number, number, number, number] = exportBbox
    ? [
        Number(exportBbox[0].toFixed(5)),
        Number(exportBbox[1].toFixed(5)),
        Number(exportBbox[2].toFixed(5)),
        Number(exportBbox[3].toFixed(5)),
      ]
    : [
        Number(minLon.toFixed(5)),
        Number(minLat.toFixed(5)),
        Number(maxLon.toFixed(5)),
        Number(maxLat.toFixed(5)),
      ];

  const basePack = finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    finalBbox,
    { lat: projector.originLat, lon: projector.originLon },
    title,
    "Локальный импорт GeoJSON (офлайн)",
    undefined,
    counters
  );

  return customBoundary ? cropOsmPackToPolygon(basePack, customBoundary) : basePack;
}

function finalizePack(
  roads: RoadSegment[],
  buildings: ObstacleBox[],
  extraObstacles: ObstacleBox[],
  signs: RoadSignDef[],
  signals: TrafficSignalDef[],
  crosswalks: CrosswalkDef[],
  speedZones: SpeedZone[],
  bbox: [number, number, number, number],
  origin: { lat: number; lon: number } | undefined,
  title: string,
  source: string,
  boundaryPolygon?: Vec2[],
  counters?: ImportConflictCounters
): NormalizedOsmPack {
  // Вычисляем точные (неквадратные) границы по фактической геометрии дорог и объектов
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const expand = (x: number, z: number, pad: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (x - pad < minX) minX = x - pad;
    if (x + pad > maxX) maxX = x + pad;
    if (z - pad < minZ) minZ = z - pad;
    if (z + pad > maxZ) maxZ = z + pad;
  };

  for (const r of roads) {
    const pad = Math.max(16, r.width * 0.5 + 12);
    for (const p of r.points) expand(p.x, p.z, pad);
  }
  for (const b of buildings) expand(b.cx, b.cz, Math.max(b.halfX, b.halfZ) + 8);
  for (const o of extraObstacles) expand(o.cx, o.cz, Math.max(o.halfX, o.halfZ) + 6);
  for (const s of signs) expand(s.x, s.z, 10);
  for (const sg of signals) {
    expand(sg.x, sg.z, 10);
    expand(sg.stopLineX, sg.stopLineZ, 10);
  }
  for (const cw of crosswalks) expand(cw.cx, cw.cz, Math.max(cw.width, cw.length) * 0.5 + 8);

  if (!Number.isFinite(minX)) {
    minX = -60;
    maxX = 60;
    minZ = -60;
    maxZ = 60;
  }

  const allObstacles = [...buildings, ...extraObstacles];

  // Старт по умолчанию на первой наземной дороге с учётом одностороннего движения
  let suggestedStart = { x: -2, z: 0, h: 0 };
  const firstSurfaceRoad = roads.find((r) => (r.layer ?? 0) === 0 && r.points.length >= 2) ?? roads[0];
  if (firstSurfaceRoad && firstSurfaceRoad.points.length >= 2) {
    const p0 = firstSurfaceRoad.points[0];
    const p1 = firstSurfaceRoad.points[1];
    const h = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const latOffset =
      firstSurfaceRoad.oneway && firstSurfaceRoad.lanes <= 1 ? 0 : firstSurfaceRoad.width * 0.23;
    const rx = -Math.cos(h) * latOffset;
    const rz = Math.sin(h) * latOffset;
    suggestedStart = {
      x: Number((p0.x + Math.sin(h) * 4 + rx).toFixed(2)),
      z: Number((p0.z + Math.cos(h) * 4 + rz).toFixed(2)),
      h: Number(h.toFixed(3)),
    };
  }

  // Строим учебный маршрут с учётом произвольного контура, `oneway`, `layer` и реальных препятствий OSM
  const route = buildRouteFromRoads(roads, {
    boundaryPolygon,
    obstacles: allObstacles,
  });
  if (route.startPose) suggestedStart = route.startPose;

  expand(suggestedStart.x, suggestedStart.z, 14);
  for (const cp of route.checkpoints) expand(cp.x, cp.z, cp.radius + 8);

  const bounds: WorldBounds = isValidBoundaryPolygon(boundaryPolygon)
    ? boundingBoxOfPolygon(boundaryPolygon, 0)
    : {
        minX: Number(Math.max(-MAX_WORLD_COORD, Math.floor(minX)).toFixed(1)),
        maxX: Number(Math.min(MAX_WORLD_COORD, Math.ceil(maxX)).toFixed(1)),
        minZ: Number(Math.max(-MAX_WORLD_COORD, Math.floor(minZ)).toFixed(1)),
        maxZ: Number(Math.min(MAX_WORLD_COORD, Math.ceil(maxZ)).toFixed(1)),
      };

  const onewayRoadsCount = roads.filter((r) => r.oneway).length;
  const conflictSummary = counters ? summarizeConflictCounters(counters) : { total: 0, notes: [] };

  return {
    meta: {
      id: `osm-pack-${Date.now()}`,
      title,
      source,
      attribution: "© OpenStreetMap contributors",
      license: "ODbL 1.0",
      extractedAt: new Date().toISOString().slice(0, 10),
      bbox,
      roadsCount: roads.length,
      buildingsCount: buildings.length,
      signalsCount: signals.length,
      signsCount: signs.length,
      ...(origin ? { origin } : {}),
      ...(onewayRoadsCount > 0 ? { onewayRoadsCount } : {}),
      ...(conflictSummary.total > 0
        ? {
            resolvedConflictsCount: conflictSummary.total,
            conflictNotes: conflictSummary.notes,
          }
        : {}),
    },
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    suggestedStart,
    routeCheckpoints: route.checkpoints,
    routeRoadName: route.roadName,
    bounds,
    ...(isValidBoundaryPolygon(boundaryPolygon) ? { boundaryPolygon: boundaryPolygon.map((p) => ({ ...p })) } : {}),
  };
}

/**
 * Обрезает офлайн-пакет OSM по произвольному многоугольнику (нарисованному от руки или коридору маршрута)
 * с сохранением `origin`, `oneway`, `layer` и пересборкой маршрута строго внутри новой границы.
 */
export function cropOsmPackToPolygon(pack: NormalizedOsmPack, rawPoly: readonly Vec2[]): NormalizedOsmPack {
  const poly = sanitizeBoundaryPolygon(rawPoly);
  if (!poly) return pack;

  const roads: RoadSegment[] = [];
  for (const r of pack.roads) {
    const pieces = clipPolylineToPolygon(r.points, poly);
    pieces.forEach((pts, idx) => {
      const cleaned = cleanRoadPolyline(pts, 0.25);
      if (cleaned.length < 2) return;
      roads.push({
        ...r,
        id: idx === 0 ? r.id : `${r.id}-c${idx + 1}`,
        points: cleaned,
      });
    });
  }

  const buildings = pack.buildings.filter((b) => isPointInPolygon(b.cx, b.cz, poly));
  const extraObstacles = (pack.extraObstacles ?? []).filter((o) => isPointInPolygon(o.cx, o.cz, poly));
  const signs = (pack.signs ?? []).filter((s) => isPointInPolygon(s.x, s.z, poly));
  const signals = pack.signals.filter(
    (sg) => isPointInPolygon(sg.x, sg.z, poly) && isPointInPolygon(sg.stopLineX, sg.stopLineZ, poly)
  );
  const crosswalks = pack.crosswalks.filter((cw) => isPointInPolygon(cw.cx, cw.cz, poly));
  const rawZones: SpeedZone[] = [];
  for (const sn of signs) {
    const sz = signToSpeedZone(sn);
    if (sz) rawZones.push(sz);
  }
  const { zones: speedZones } = filterConflictingSpeedZones(rawZones, roads);

  const cropped = finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    pack.meta.bbox,
    pack.meta.origin,
    pack.meta.title,
    pack.meta.source,
    poly
  );

  // Сохраняем сводку согласования из исходной выгрузки OSM
  if (pack.meta.resolvedConflictsCount) {
    cropped.meta.resolvedConflictsCount = pack.meta.resolvedConflictsCount;
    cropped.meta.conflictNotes = pack.meta.conflictNotes ? [...pack.meta.conflictNotes] : undefined;
  }
  return cropped;
}
