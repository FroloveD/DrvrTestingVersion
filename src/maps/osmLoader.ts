/**
 * @module maps/osmLoader
 * @layer pure-core
 * @role Офлайн-парсер выгрузок `.osm` XML, Overpass OSM JSON и GeoJSON в метрическую сцену (`+Z` север, `−X` восток).
 * @invariants #7 (чистое ядро без DOM и three), #8 (офлайн — ноль сетевых запросов к Overpass), #9 (атрибуция ODbL 1.0).
 * @tests T11, T12, T21, T27, T28
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
} from "../sim/types";
import { parseOsmXmlElements, type RawOsmElement } from "./osmXml";
import { buildRouteFromRoads } from "./route";

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
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
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
function parseDirectionRad(tags: Record<string, string>): number {
  const raw = tags.direction ?? tags["traffic_signals:direction"];
  if (!raw) return 0;
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
  return 0;
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

function polygonToAabbObstacle(id: string, pts: Vec2[], tags: Record<string, string>, idx: number): ObstacleBox | null {
  if (pts.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const w = maxX - minX;
  const l = maxZ - minZ;
  if (w < 2 || l < 2 || w > 180 || l > 180) return null;
  const heightTag = parseNumericTag(tags.height);
  const levelsTag = parseNumericTag(tags["building:levels"]);
  const height = Math.min(48, Math.max(4.5, heightTag ?? (levelsTag ? levelsTag * 3.2 : 9.6)));
  const palette = [0x4c5d6b, 0x5a6875, 0x625d57, 0x4b5862, 0x58646e];
  return {
    id,
    kind: "building",
    cx: Number(((minX + maxX) / 2).toFixed(2)),
    cz: Number(((minZ + maxZ) / 2).toFixed(2)),
    halfX: Number((w / 2).toFixed(2)),
    halfZ: Number((l / 2).toFixed(2)),
    h: 0,
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
    if (len < 1.0 || len > 110) continue;
    out.push({
      id: `${baseId}-${i + 1}`,
      kind: isKerb ? "curb" : "fence",
      cx: Number(((p0.x + p1.x) / 2).toFixed(2)),
      cz: Number(((p0.z + p1.z) / 2).toFixed(2)),
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
    // Ищем число скорости после maxspeed или 3.24 (например, RU:3.24[40] или maxspeed=30)
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
  signals: TrafficSignalDef[],
  crosswalks: CrosswalkDef[],
  signs: RoadSignDef[],
  speedZones: SpeedZone[],
  extraObstacles: ObstacleBox[]
): void {
  const h = parseDirectionRad(tags);

  if (tags.highway === "traffic_signals" && signals.length < 30) {
    signals.push({
      id: `sig-${idSuffix}`,
      x: Number((p.x - 3.6).toFixed(2)),
      z: p.z,
      h,
      stopLineX: Number((p.x - 1.8).toFixed(2)),
      stopLineZ: Number((p.z - 4).toFixed(2)),
      stopLineWidth: 4.5,
      cycleOffset: (signals.length * 7) % 24,
      greenDuration: 14,
      redDuration: 12,
    });
    return;
  }

  if (tags.highway === "crossing" && crosswalks.length < 25) {
    crosswalks.push({
      id: `cw-${idSuffix}`,
      cx: p.x,
      cz: p.z,
      width: 7.5,
      length: 3.4,
      h,
      pedSpeed: 1.25,
      pedPhaseOffset: crosswalks.length * 4.5,
    });
    return;
  }

  const signInfo = classifyOsmNodeSign(tags);
  if (signInfo && signs.length < 80) {
    const sign = createDefaultSign(`sign-${idSuffix}`, signInfo.kind, p.x, p.z, h, signInfo.limitKmh);
    if (tags.name) sign.label = `${sign.label} (${tags.name})`;
    signs.push(sign);
    const sz = signToSpeedZone(sign);
    if (sz && speedZones.length < 30) speedZones.push(sz);
    return;
  }

  if (extraObstacles.length >= 160) return;

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
 * в нормализованный офлайн-пакет карты с ограничением 600 зданий.
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
 * Исполняется и в браузере, и в Node.js без DOMParser.
 */
export function parseOsmXml(xml: string, title = "Импортированный участок .osm"): NormalizedOsmPack {
  const elements = parseOsmXmlElements(xml);
  return parseOverpassElements(elements, title, "Локальный импорт OSM XML (.osm, офлайн)");
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

function parseOverpassElements(elements: RawOsmElement[], title: string, source: string): NormalizedOsmPack {
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

  const project = projectFactory((minLat + maxLat) / 2, (minLon + maxLon) / 2);
  const roads: RoadSegment[] = [];
  const buildings: ObstacleBox[] = [];
  const extraObstacles: ObstacleBox[] = [];
  const signs: RoadSignDef[] = [];
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];

  for (const el of elements) {
    if (el.type === "way" && el.tags) {
      const pts: Vec2[] = [];
      if (Array.isArray(el.geometry) && el.geometry.length > 0) {
        for (const g of el.geometry) pts.push(project(g.lat, g.lon));
      } else if (Array.isArray(el.nodes)) {
        for (const nid of el.nodes) {
          const n = nodeMap.get(nid);
          if (n) pts.push(project(n.lat, n.lon));
        }
      }
      if (pts.length < 2) continue;

      if (el.tags.highway && HIGHWAY_WIDTHS[el.tags.highway]) {
        const preset = HIGHWAY_WIDTHS[el.tags.highway];
        const widthTag = parseNumericTag(el.tags.width);
        const lanesTag = parseNumericTag(el.tags.lanes);
        const maxspeed = parseNumericTag(el.tags.maxspeed);
        const width = Math.min(22, Math.max(3.8, widthTag ?? preset.width));
        const lanes = Math.max(1, Math.min(6, lanesTag ?? preset.lanes));
        const speedLimitKmh = maxspeed ?? preset.limit;
        roads.push({
          id: `way-${el.id}`,
          points: pts,
          width,
          lanes,
          highway: el.tags.highway,
          name: el.tags.name,
          hasSolidCenter: lanes >= 2 && width >= 7,
          speedLimitKmh,
          layer: parseNumericTag(el.tags.layer) ?? 0,
          oneway: el.tags.oneway === "yes" || el.tags.oneway === "1" || el.tags.oneway === "true",
        });
        if (maxspeed && maxspeed <= 40 && speedZones.length < 20) {
          const midIdx = Math.floor(pts.length / 2);
          const mid = pts[midIdx];
          const prev = pts[Math.max(0, midIdx - 1)];
          const next = pts[Math.min(pts.length - 1, midIdx + 1)];
          const segH = Number(Math.atan2(next.x - prev.x, next.z - prev.z).toFixed(3));
          // Стойка справа от дороги (-left = (-cos h, sin h))
          const signX = Number((mid.x - Math.cos(segH) * (width / 2 + 1.1)).toFixed(2));
          const signZ = Number((mid.z + Math.sin(segH) * (width / 2 + 1.1)).toFixed(2));
          const kind: RoadSignKind = el.tags.highway === "living_street" && maxspeed <= 20 ? "living_zone" : "speed_limit";
          const sign: RoadSignDef = {
            id: `sign-way-${el.id}`,
            kind,
            x: signX,
            z: signZ,
            h: segH,
            limitKmh: maxspeed,
            zoneRadius: 28,
            zoneX: mid.x,
            zoneZ: mid.z,
            label:
              kind === "living_zone"
                ? `Знак 5.21 «Жилая зона» (${el.tags.name || "20 км/ч"})`
                : `Знак 3.24 «${maxspeed}» (${el.tags.name || el.tags.highway})`,
          };
          if (signs.length < 80) signs.push(sign);
          const sz = signToSpeedZone(sign);
          if (sz) speedZones.push(sz);
        }
      } else if (el.tags.building && buildings.length < 600) {
        const box = polygonToAabbObstacle(`bld-${el.id}`, pts, el.tags, buildings.length);
        if (box) buildings.push(box);
      } else if (
        el.tags.barrier &&
        (BARRIER_KINDS.has(el.tags.barrier) || el.tags.barrier === "kerb") &&
        extraObstacles.length < 160
      ) {
        const segs = polylineToBarrierObstacles(
          `bar-${el.id}`,
          pts,
          el.tags.barrier,
          160 - extraObstacles.length
        );
        extraObstacles.push(...segs);
      }
    }
  }

  // Светофоры, переходы, дорожные знаки и точечные объекты из узлов
  for (const el of elements) {
    if (el.type === "node" && el.tags && typeof el.lat === "number" && typeof el.lon === "number") {
      const p = project(el.lat, el.lon);
      collectPointFeature(String(el.id), p, el.tags, signals, crosswalks, signs, speedZones, extraObstacles);
    }
  }

  return finalizePack(
    roads,
    buildings,
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    [Number(minLon.toFixed(5)), Number(minLat.toFixed(5)), Number(maxLon.toFixed(5)), Number(maxLat.toFixed(5))],
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
      const pts = (g.coordinates as number[][]).map(([lon, lat]) => project(lat, lon));
      if (pts.length < 2) return;
      if (
        tags.barrier &&
        (BARRIER_KINDS.has(tags.barrier) || tags.barrier === "kerb") &&
        !tags.highway &&
        extraObstacles.length < 160
      ) {
        extraObstacles.push(
          ...polylineToBarrierObstacles(`gj-bar-${fid}`, pts, tags.barrier, 160 - extraObstacles.length)
        );
        return;
      }
      const hw = tags.highway || "residential";
      if (!HIGHWAY_WIDTHS[hw] && !tags.highway) return;
      const preset = HIGHWAY_WIDTHS[hw] ?? HIGHWAY_WIDTHS.residential;
      const width = parseNumericTag(tags.width) ?? preset.width;
      const lanes = parseNumericTag(tags.lanes) ?? preset.lanes;
      const maxspeed = parseNumericTag(tags.maxspeed);
      roads.push({
        id: `gj-road-${fid}`,
        points: pts,
        width,
        lanes,
        highway: hw,
        name: tags.name,
        hasSolidCenter: lanes >= 2,
        speedLimitKmh: maxspeed ?? preset.limit,
        layer: parseNumericTag(tags.layer) ?? 0,
        oneway: tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "true",
      });
      if (maxspeed && maxspeed <= 40 && signs.length < 80 && speedZones.length < 20) {
        const mid = pts[Math.floor(pts.length / 2)];
        const sign = createDefaultSign(`gj-sign-${fid}`, "speed_limit", mid.x - width / 2 - 1.1, mid.z, 0, maxspeed);
        sign.zoneX = mid.x;
        sign.zoneZ = mid.z;
        signs.push(sign);
        const sz = signToSpeedZone(sign);
        if (sz) speedZones.push(sz);
      }
    } else if (g.type === "Polygon" && Array.isArray(g.coordinates) && buildings.length < 600) {
      if (!tags.building && tags.highway) return;
      const ring = (g.coordinates as number[][][])[0];
      if (Array.isArray(ring)) {
        const pts = ring.map(([lon, lat]) => project(lat, lon));
        const box = polygonToAabbObstacle(`gj-bld-${fid}`, pts, tags, buildings.length);
        if (box) buildings.push(box);
      }
    } else if (g.type === "Point" && Array.isArray(g.coordinates)) {
      const [lon, lat] = g.coordinates as number[];
      const p = project(lat, lon);
      collectPointFeature(`gj-${fid}`, p, tags, signals, crosswalks, signs, speedZones, extraObstacles);
    }
  });

  return finalizePack(
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
  source: string
): NormalizedOsmPack {
  let minX = -120;
  let maxX = 120;
  let minZ = -120;
  let maxZ = 120;

  const expand = (x: number, z: number, pad: number) => {
    minX = Math.min(minX, x - pad);
    maxX = Math.max(maxX, x + pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };

  for (const r of roads) {
    for (const p of r.points) expand(p.x, p.z, 25);
  }
  for (const b of buildings) expand(b.cx, b.cz, Math.max(b.halfX, b.halfZ) + 10);
  for (const s of signs) expand(s.x, s.z, 12);

  // Старт на первой дороге с правой полосы
  let suggestedStart = { x: -2, z: 0, h: 0 };
  if (roads.length > 0 && roads[0].points.length >= 2) {
    const p0 = roads[0].points[0];
    const p1 = roads[0].points[1];
    const h = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    // Смещаемся вправо (-left) на четверть ширины дороги
    const rx = -Math.cos(h) * (roads[0].width * 0.23);
    const rz = Math.sin(h) * (roads[0].width * 0.23);
    suggestedStart = {
      x: Number((p0.x + Math.sin(h) * 4 + rx).toFixed(2)),
      z: Number((p0.z + Math.cos(h) * 4 + rz).toFixed(2)),
      h: Number(h.toFixed(3)),
    };
  }

  const route = buildRouteFromRoads(roads);
  if (route.startPose) suggestedStart = route.startPose;
  for (const cp of route.checkpoints) expand(cp.x, cp.z, 12);

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
    extraObstacles,
    signs,
    signals,
    crosswalks,
    speedZones,
    suggestedStart,
    routeCheckpoints: route.checkpoints,
    routeRoadName: route.roadName,
    bounds: {
      minX: Number(Math.max(-600, minX).toFixed(1)),
      maxX: Number(Math.min(600, maxX).toFixed(1)),
      minZ: Number(Math.max(-600, minZ).toFixed(1)),
      maxZ: Number(Math.min(600, maxZ).toFixed(1)),
    },
  };
}
