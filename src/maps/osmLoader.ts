/**
 * @module maps/osmLoader
 * @layer pure-core
 * @role Офлайн-парсер выгрузок `.osm` XML, Overpass OSM JSON и GeoJSON в метрическую сцену (`+Z` север, `−X` восток) с поддержкой `<bounds>`, OBB зданий и произвольных границ.
 * @invariants #7 (чистое ядро без DOM и three), #8 (офлайн — ноль сетевых запросов к Overpass), #9 (атрибуция ODbL 1.0).
 * @tests T11, T12, T21, T27, T28, T30
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
import { parseOsmXmlDocument, type RawOsmElement } from "./osmXml";
import { buildRouteFromRoads, nearestRoadPoint } from "./route";

export type MapImportFormat = "osm_xml" | "osm_json" | "geojson";

const HIGHWAY_WIDTHS: Record<string, { width: number; lanes: number; limit: number }> = {
  motorway: { width: 14, lanes: 4, limit: 90 },
  trunk: { width: 12, lanes: 4, limit: 60 },
  primary: { width: 10.5, lanes: 2, limit: 60 },
  secondary: { width: 9.0, lanes: 2, limit: 60 },
  tertiary: { width: 7.5, lanes: 2, limit: 60 },
  residential: { width: 6.5, lanes: 2, limit: 40 },
  living_street: { width: 5.0, lanes: 1, limit: 20 },
  unclassified: { width: 6.5, lanes: 2, limit: 60 },
  service: { width: 4.8, lanes: 1, limit: 20 },
};

const BARRIER_KINDS = new Set(["fence", "wall", "guard_rail", "handrail", "hedge", "retaining_wall"]);

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
  /** Произвольный полигон границы участка/маршрута (если задан в GeoJSON или при обрезке). */
  boundaryPolygon?: Vec2[];
};

type GeoJsonFeature = {
  type: "Feature";
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: {
    type: string;
    coordinates: unknown;
  };
};

function parseNumericTag(val: string | undefined): number | null {
  if (!val) return null;
  const m = String(val).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Переводит азимут OSM (0° = север, 90° = восток) в курс симулятора `h` (+Z север, +h влево/на запад). */
function parseDirectionRad(tags: Record<string, string>): number | null {
  const raw = tags.direction ?? tags["traffic_signals:direction"];
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
  const deg = parseNumericTag(raw);
  if (deg !== null && deg >= -360 && deg <= 360) {
    return Number(((-deg * Math.PI) / 180).toFixed(3));
  }
  return null;
}

function projectFactory(centerLat: number, centerLon: number) {
  const mPerLat = 111_132;
  const mPerLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  // +Z = север, -X = восток, +X = запад -> при взгляде вдоль +Z восток справа на экране
  return (lat: number, lon: number): Vec2 => ({
    x: Number((-(lon - centerLon) * mPerLon).toFixed(2)),
    z: Number(((lat - centerLat) * mPerLat).toFixed(2)),
  });
}

/**
 * Строит ориентированный прямоугольник (OBB) здания вдоль его самой длинной стены.
 * В отличие от грубого AABB, здания вдоль диагональных улиц не вылезают углами на проезжую часть.
 */
function polygonToObbObstacle(id: string, pts: Vec2[], tags: Record<string, string>, idx: number): ObstacleBox | null {
  if (pts.length < 3) return null;

  // Находим направление самой длинной стены контура
  let bestLenSq = 0;
  let h = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    if (l2 > bestLenSq) {
      bestLenSq = l2;
      h = Math.atan2(dx, dz);
    }
  }
  // Для почти осевых зданий обнуляем угол, сохраняя компактные координаты
  if (Math.abs(Math.sin(h)) < 0.02) h = 0;
  else if (Math.abs(Math.cos(h)) < 0.02) h = 0;

  // Локальные оси OBB: forward = (sin h, cos h), left = (cos h, -sin h)
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const lx = Math.cos(h);
  const lz = -Math.sin(h);

  let minL = Infinity;
  let maxL = -Infinity;
  let minF = Infinity;
  let maxF = -Infinity;
  for (const p of pts) {
    const pl = p.x * lx + p.z * lz;
    const pf = p.x * fx + p.z * fz;
    if (pl < minL) minL = pl;
    if (pl > maxL) maxL = pl;
    if (pf < minF) minF = pf;
    if (pf > maxF) maxF = pf;
  }

  const w = maxL - minL;
  const l = maxF - minF;
  if (w < 2 || l < 2 || w > 240 || l > 240) return null;
  const midL = (minL + maxL) * 0.5;
  const midF = (minF + maxF) * 0.5;
  const cx = lx * midL + fx * midF;
  const cz = lz * midL + fz * midF;
  if (Math.abs(cx) > MAX_WORLD_COORD || Math.abs(cz) > MAX_WORLD_COORD) return null;

  const heightTag = parseNumericTag(tags.height);
  const levelsTag = parseNumericTag(tags["building:levels"]);
  const height = Math.min(48, Math.max(4.5, heightTag ?? (levelsTag ? levelsTag * 3.2 : 9.6)));
  const palette = [0x4c5d6b, 0x5a6875, 0x625d57, 0x4b5862, 0x58646e];

  return {
    id,
    kind: "building",
    cx: Number(cx.toFixed(2)),
    cz: Number(cz.toFixed(2)),
    halfX: Number((w / 2).toFixed(2)),
    halfZ: Number((l / 2).toFixed(2)),
    h: Number(h.toFixed(3)),
    height,
    color: palette[idx % palette.length],
    label: tags.name ? `здание «${tags.name}»` : "здание OSM",
  };
}

function polylineToBarrierObstacles(
  baseId: string,
  pts: Vec2[],
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
      height: isKerb ? 0.16 : barrierTag === "wall" ? 1.8 : 1.15,
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
  if (tags.amenity === "parking" && !tags.building) return { kind: "parking" };

  const ts = (tags.traffic_sign ?? "").toLowerCase();
  if (!ts) return null;

  if (ts.includes("maxspeed") || ts.includes("3.24")) {
    const fromTag = parseNumericTag(tags.maxspeed);
    const bracket = ts.match(/(?:3\.24|maxspeed)[^\d]{0,4}(\d{1,3})/);
    const limit = fromTag ?? (bracket ? Number(bracket[1]) : 40);
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

function collectPointFeature(
  idSuffix: string,
  p: Vec2,
  tags: Record<string, string>,
  roads: readonly RoadSegment[],
  signals: TrafficSignalDef[],
  crosswalks: CrosswalkDef[],
  signs: RoadSignDef[],
  speedZones: SpeedZone[],
  extraObstacles: ObstacleBox[]
): void {
  if (Math.abs(p.x) > MAX_WORLD_COORD || Math.abs(p.z) > MAX_WORLD_COORD) return;

  const explicitH = parseDirectionRad(tags);
  // Если в OSM нет тега direction=*, ориентируем светофор/переход/знак вдоль ближайшей улицы
  const snap = explicitH === null && roads.length > 0 ? nearestRoadPoint(p.x, p.z, roads) : null;
  const h = Number((explicitH ?? (snap && snap.dist <= 16 ? snap.h : 0)).toFixed(3));
  const roadW = snap && snap.dist <= 16 ? snap.road.width : 7.5;

  if (tags.highway === "traffic_signals" && signals.length < 40) {
    // Стойка справа от полосы (-left = (-cos h, sin h)), стоп-линия на 4 м раньше по потоку
    const rx = -Math.cos(h);
    const rz = Math.sin(h);
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const halfLane = Math.min(5.5, Math.max(2.6, roadW * 0.5));
    signals.push({
      id: `sig-${idSuffix}`,
      x: Number((p.x + rx * (roadW * 0.5 + 0.9)).toFixed(2)),
      z: Number((p.z + rz * (roadW * 0.5 + 0.9)).toFixed(2)),
      h,
      stopLineX: Number((p.x + rx * (halfLane * 0.45) - fx * 4).toFixed(2)),
      stopLineZ: Number((p.z + rz * (halfLane * 0.45) - fz * 4).toFixed(2)),
      stopLineWidth: Number(Math.min(12, Math.max(3.5, halfLane)).toFixed(2)),
      cycleOffset: (signals.length * 7) % 24,
      greenDuration: 14,
      redDuration: 12,
    });
    return;
  }

  if (tags.highway === "crossing" && crosswalks.length < 35) {
    crosswalks.push({
      id: `cw-${idSuffix}`,
      cx: p.x,
      cz: p.z,
      width: Number(Math.min(24, Math.max(5, roadW)).toFixed(1)),
      length: 3.4,
      h,
      pedSpeed: 1.25,
      pedPhaseOffset: crosswalks.length * 4.5,
    });
    return;
  }

  const signInfo = classifyOsmNodeSign(tags);
  if (signInfo && signs.length < 120) {
    const sign = createDefaultSign(`sign-${idSuffix}`, signInfo.kind, p.x, p.z, h, signInfo.limitKmh);
    if (tags.name) sign.label = `${sign.label} (${tags.name})`;
    signs.push(sign);
    const sz = signToSpeedZone(sign);
    if (sz && speedZones.length < 40) speedZones.push(sz);
    return;
  }

  if (extraObstacles.length >= 220) return;

  if (tags.natural === "tree") {
    extraObstacles.push({
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
    });
  } else if (tags.highway === "street_lamp" || tags.power === "pole") {
    extraObstacles.push({
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
    });
  } else if (tags.traffic_calming === "island") {
    extraObstacles.push({
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
    });
  }
}

/**
 * Разбирает Overpass OSM JSON (`{ elements }`) или GeoJSON (`FeatureCollection`)
 * в нормализованный офлайн-пакет карты с сохранением реальных (неквадратных) границ участка.
 */
export function parseOsmOrGeoJson(raw: unknown, title = "Импортированный участок OSM"): NormalizedOsmPack {
  if (!raw || typeof raw !== "object") {
    throw new Error("Файл пуст или не является корректным JSON-объектом.");
  }
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.elements)) {
    return parseOverpassElements(
      obj.elements as RawOsmElement[],
      title,
      "Локальный импорт Overpass OSM JSON (офлайн)"
    );
  }
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return parseGeoJsonFeatures(obj.features as GeoJsonFeature[], title);
  }
  throw new Error("Ожидается Overpass OSM JSON (поле elements) или GeoJSON FeatureCollection.");
}

/**
 * Разбирает стандартный файл `.osm` (XML с openstreetmap.org / JOSM) в офлайн-пакет карты.
 * Учитывает рамку экспорта `<bounds/>` (подрезая длинные транзитные трассы по выбранному окну + буфер).
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
    }
  }

  if (!Number.isFinite(minLat)) {
    throw new Error("В OSM-файле не найдено ни одного узла с координатами (lat/lon).");
  }

  // Центрируем проекцию по окну экспорта <bounds/>, если оно задано, иначе по узлам файла
  const centerLat = exportBbox ? (exportBbox[1] + exportBbox[3]) / 2 : (minLat + maxLat) / 2;
  const centerLon = exportBbox ? (exportBbox[0] + exportBbox[2]) / 2 : (minLon + maxLon) / 2;
  const project = projectFactory(centerLat, centerLon);

  // Мягкое окно подрезки: не даёт 10-километровым хвостам way увести карту за пределы выбранного района
  let clipPoly: Vec2[] | undefined;
  if (exportBbox) {
    const sw = project(exportBbox[1], exportBbox[0]);
    const ne = project(exportBbox[3], exportBbox[2]);
    const margin = 80;
    clipPoly = boundsToPolygon({
      minX: Math.max(-MAX_WORLD_COORD + 30, Math.min(sw.x, ne.x) - margin),
      maxX: Math.min(MAX_WORLD_COORD - 30, Math.max(sw.x, ne.x) + margin),
      minZ: Math.max(-MAX_WORLD_COORD + 30, Math.min(sw.z, ne.z) - margin),
      maxZ: Math.min(MAX_WORLD_COORD - 30, Math.max(sw.z, ne.z) + margin),
    });
  } else {
    const limit = MAX_WORLD_COORD - 40;
    clipPoly = boundsToPolygon({ minX: -limit, maxX: limit, minZ: -limit, maxZ: limit });
  }

  const roads: RoadSegment[] = [];
  const buildings: ObstacleBox[] = [];
  const extraObstacles: ObstacleBox[] = [];
  const signs: RoadSignDef[] = [];
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];

  for (const el of elements) {
    if (el.type === "way" && el.tags) {
      const rawPts: Vec2[] = [];
      if (Array.isArray(el.geometry) && el.geometry.length > 0) {
        for (const g of el.geometry) rawPts.push(project(g.lat, g.lon));
      } else if (Array.isArray(el.nodes)) {
        for (const nid of el.nodes) {
          const n = nodeMap.get(nid);
          if (n) rawPts.push(project(n.lat, n.lon));
        }
      }
      if (rawPts.length < 2) continue;

      if (el.tags.highway && HIGHWAY_WIDTHS[el.tags.highway]) {
        // В OSM oneway=-1 означает движение от последнего узла к первому
        const directed = el.tags.oneway === "-1" ? [...rawPts].reverse() : rawPts;
        const pieces = clipPoly ? clipPolylineToPolygon(directed, clipPoly) : [directed];
        if (pieces.length === 0) continue;

        const preset = HIGHWAY_WIDTHS[el.tags.highway];
        const widthTag = parseNumericTag(el.tags.width);
        const lanesTag = parseNumericTag(el.tags.lanes);
        const maxspeed = parseNumericTag(el.tags.maxspeed);
        const width = Number(Math.min(26, Math.max(3.2, widthTag ?? preset.width)).toFixed(2));
        const lanes = Math.max(1, Math.min(6, Math.round(lanesTag ?? preset.lanes)));
        const speedLimitKmh = maxspeed ? Math.min(110, Math.max(5, maxspeed)) : preset.limit;

        pieces.forEach((pts, pIdx) => {
          const roadId = pIdx === 0 ? `way-${el.id}` : `way-${el.id}-${pIdx + 1}`;
          roads.push({
            id: roadId,
            points: pts,
            width,
            lanes,
            highway: el.tags!.highway,
            name: el.tags!.name,
            hasSolidCenter: lanes >= 2 && width >= 7,
            speedLimitKmh,
          });
          if (pIdx === 0 && maxspeed && maxspeed <= 40 && speedZones.length < 30) {
            const midIdx = Math.floor(pts.length / 2);
            const mid = pts[midIdx];
            const prev = pts[Math.max(0, midIdx - 1)];
            const next = pts[Math.min(pts.length - 1, midIdx + 1)];
            const segH = Number(Math.atan2(next.x - prev.x, next.z - prev.z).toFixed(3));
            const signX = Number((mid.x - Math.cos(segH) * (width / 2 + 1.1)).toFixed(2));
            const signZ = Number((mid.z + Math.sin(segH) * (width / 2 + 1.1)).toFixed(2));
            const kind: RoadSignKind =
              el.tags!.highway === "living_street" && speedLimitKmh <= 20 ? "living_zone" : "speed_limit";
            const sign: RoadSignDef = {
              id: `sign-way-${el.id}`,
              kind,
              x: signX,
              z: signZ,
              h: segH,
              limitKmh: speedLimitKmh,
              zoneRadius: 28,
              zoneX: mid.x,
              zoneZ: mid.z,
              label:
                kind === "living_zone"
                  ? `Знак 5.21 «Жилая зона» (${el.tags!.name || "20 км/ч"})`
                  : `Знак 3.24 «${speedLimitKmh}» (${el.tags!.name || el.tags!.highway})`,
            };
            if (signs.length < 120) signs.push(sign);
            const sz = signToSpeedZone(sign);
            if (sz) speedZones.push(sz);
          }
        });
      } else if (el.tags.building && buildings.length < 600) {
        const box = polygonToObbObstacle(`bld-${el.id}`, rawPts, el.tags, buildings.length);
        if (box && (!clipPoly || isPointInPolygon(box.cx, box.cz, clipPoly))) {
          buildings.push(box);
        }
      } else if (
        el.tags.barrier &&
        (BARRIER_KINDS.has(el.tags.barrier) || el.tags.barrier === "kerb") &&
        extraObstacles.length < 220
      ) {
        // Бордюры (barrier=kerb) часто пересекают проезжую часть на съездах — берём только ограждения/стены или короткие бордюры вне дорог
        const pieces = clipPoly ? clipPolylineToPolygon(rawPts, clipPoly) : [rawPts];
        for (const piece of pieces) {
          if (extraObstacles.length >= 220) break;
          const segs = polylineToBarrierObstacles(
            `bar-${el.id}`,
            piece,
            el.tags.barrier,
            220 - extraObstacles.length
          );
          extraObstacles.push(...segs);
        }
      }
    }
  }

  // Светофоры, переходы, дорожные знаки и точечные объекты из узлов (ориентируются по уже собранным дорогам)
  for (const el of elements) {
    if (el.type === "node" && el.tags && typeof el.lat === "number" && typeof el.lon === "number") {
      const p = project(el.lat, el.lon);
      if (clipPoly && !isPointInPolygon(p.x, p.z, clipPoly)) continue;
      collectPointFeature(String(el.id), p, el.tags, roads, signals, crosswalks, signs, speedZones, extraObstacles);
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

  return finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    finalBbox,
    title,
    source
  );
}

function parseGeoJsonFeatures(features: GeoJsonFeature[], title: string): NormalizedOsmPack {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const visitCoords = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
      const lon = c[0];
      const lat = c[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      return;
    }
    for (const sub of c) visitCoords(sub);
  };

  for (const f of features) {
    if (f?.geometry?.coordinates) visitCoords(f.geometry.coordinates);
  }
  if (!Number.isFinite(minLat)) {
    throw new Error("В GeoJSON не найдено координат.");
  }

  const project = projectFactory((minLat + maxLat) / 2, (minLon + maxLon) / 2);
  const roads: RoadSegment[] = [];
  const buildings: ObstacleBox[] = [];
  const extraObstacles: ObstacleBox[] = [];
  const signs: RoadSignDef[] = [];
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];
  const pendingPoints: Array<{ fid: string; p: Vec2; tags: Record<string, string> }> = [];
  let customBoundary: Vec2[] | undefined;

  features.forEach((f, idx) => {
    const g = f.geometry;
    const rawProps = f.properties ?? {};
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (v !== undefined && v !== null) tags[k] = String(v);
    }
    if (!g) return;
    const fid = String(f.id ?? idx);

    if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      const rawPts = (g.coordinates as number[][]).map(([lon, lat]) => project(lat, lon));
      if (rawPts.length < 2) return;
      if (
        tags.barrier &&
        (BARRIER_KINDS.has(tags.barrier) || tags.barrier === "kerb") &&
        !tags.highway &&
        extraObstacles.length < 220
      ) {
        extraObstacles.push(
          ...polylineToBarrierObstacles(`gj-bar-${fid}`, rawPts, tags.barrier, 220 - extraObstacles.length)
        );
        return;
      }
      const hw = tags.highway || "residential";
      if (!HIGHWAY_WIDTHS[hw] && !tags.highway) return;
      const pts = tags.oneway === "-1" ? [...rawPts].reverse() : rawPts;
      const preset = HIGHWAY_WIDTHS[hw] ?? HIGHWAY_WIDTHS.residential;
      const width = Number(Math.min(26, Math.max(3.2, parseNumericTag(tags.width) ?? preset.width)).toFixed(2));
      const lanes = Math.max(1, Math.min(6, Math.round(parseNumericTag(tags.lanes) ?? preset.lanes)));
      const maxspeed = parseNumericTag(tags.maxspeed);
      const speedLimitKmh = maxspeed ? Math.min(110, Math.max(5, maxspeed)) : preset.limit;
      roads.push({
        id: `gj-road-${fid}`,
        points: pts,
        width,
        lanes,
        highway: hw,
        name: tags.name,
        hasSolidCenter: lanes >= 2,
        speedLimitKmh,
      });
      if (maxspeed && maxspeed <= 40 && signs.length < 120 && speedZones.length < 40) {
        const mid = pts[Math.floor(pts.length / 2)];
        const sign = createDefaultSign(`gj-sign-${fid}`, "speed_limit", mid.x - width / 2 - 1.1, mid.z, 0, speedLimitKmh);
        sign.zoneX = mid.x;
        sign.zoneZ = mid.z;
        signs.push(sign);
        const sz = signToSpeedZone(sign);
        if (sz) speedZones.push(sz);
      }
    } else if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
      const ring = (g.coordinates as number[][][])[0];
      if (!Array.isArray(ring)) return;
      const pts = ring.map(([lon, lat]) => project(lat, lon));
      // Поддержка произвольного полигона границы прямо из GeoJSON (boundary=route | cdt:boundary=yes | role=boundary)
      if (
        !tags.building &&
        (tags.boundary === "route" || tags["cdt:boundary"] === "yes" || tags.role === "boundary")
      ) {
        const poly = sanitizeBoundaryPolygon(pts);
        if (poly) customBoundary = poly;
        return;
      }
      if (!tags.building && tags.highway) return;
      if (buildings.length < 600) {
        const box = polygonToObbObstacle(`gj-bld-${fid}`, pts, tags, buildings.length);
        if (box) buildings.push(box);
      }
    } else if (g.type === "Point" && Array.isArray(g.coordinates)) {
      const [lon, lat] = g.coordinates as number[];
      pendingPoints.push({ fid, p: project(lat, lon), tags });
    }
  });

  for (const pt of pendingPoints) {
    collectPointFeature(`gj-${pt.fid}`, pt.p, pt.tags, roads, signals, crosswalks, signs, speedZones, extraObstacles);
  }

  const basePack = finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    [Number(minLon.toFixed(5)), Number(minLat.toFixed(5)), Number(maxLon.toFixed(5)), Number(maxLat.toFixed(5))],
    title,
    "Локальный импорт GeoJSON (офлайн)"
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
  title: string,
  source: string,
  boundaryPolygon?: Vec2[]
): NormalizedOsmPack {
  // Фильтруем бордюры OSM (barrier=kerb), случайно попавшие прямо на проезжую часть (съезды/переходы)
  const filteredExtras = extraObstacles.filter((o) => {
    if (o.kind !== "curb" || roads.length === 0) return true;
    const snap = nearestRoadPoint(o.cx, o.cz, roads);
    return !snap || snap.dist > snap.road.width * 0.45;
  });

  // Вычисляем точные (неквадратные!) границы по фактической геометрии дорог и объектов
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
  for (const o of filteredExtras) expand(o.cx, o.cz, Math.max(o.halfX, o.halfZ) + 6);
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

  const allObstacles = [...buildings, ...filteredExtras];

  // Старт по умолчанию на первой дороге с правой полосы
  let suggestedStart = { x: -2, z: 0, h: 0 };
  if (roads.length > 0 && roads[0].points.length >= 2) {
    const p0 = roads[0].points[0];
    const p1 = roads[0].points[1];
    const h = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const rx = -Math.cos(h) * (roads[0].width * 0.23);
    const rz = Math.sin(h) * (roads[0].width * 0.23);
    suggestedStart = {
      x: Number((p0.x + Math.sin(h) * 4 + rx).toFixed(2)),
      z: Number((p0.z + Math.cos(h) * 4 + rz).toFixed(2)),
      h: Number(h.toFixed(3)),
    };
  }

  // Строим учебный маршрут с учётом произвольного контура и реальных препятствий OSM
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
    },
    roads,
    buildings,
    extraObstacles: filteredExtras,
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
 * и пересобирает маршрут и стартовую позицию строго внутри новой границы.
 */
export function cropOsmPackToPolygon(pack: NormalizedOsmPack, rawPoly: readonly Vec2[]): NormalizedOsmPack {
  const poly = sanitizeBoundaryPolygon(rawPoly);
  if (!poly) return pack;

  const roads: RoadSegment[] = [];
  for (const r of pack.roads) {
    const pieces = clipPolylineToPolygon(r.points, poly);
    pieces.forEach((pts, idx) => {
      roads.push({
        ...r,
        id: idx === 0 ? r.id : `${r.id}-c${idx + 1}`,
        points: pts,
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
  const speedZones: SpeedZone[] = [];
  for (const sn of signs) {
    const sz = signToSpeedZone(sn);
    if (sz) speedZones.push(sz);
  }

  return finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    pack.meta.bbox,
    pack.meta.title,
    pack.meta.source,
    poly
  );
}
