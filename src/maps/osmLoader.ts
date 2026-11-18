/**
 * @module maps/osmLoader
 * @layer pure-core
 * @role Офлайн-парсер выгрузок Overpass OSM JSON и GeoJSON в локальную метрическую сцену (`+Z` север, `−X` восток).
 * @invariants #7 (чистое ядро), #8 (офлайн — никаких сетевых запросов к Overpass), #9 (атрибуция ODbL 1.0).
 * @tests T11, T12, T21
 */
import { buildRouteFromRoads } from "./route";
import type {
  CrosswalkDef,
  MapPackMeta,
  RouteCheckpoint,
  ObstacleBox,
  RoadSegment,
  SpeedZone,
  TrafficSignalDef,
  Vec2,
} from "../sim/types";

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

export type NormalizedOsmPack = {
  meta: MapPackMeta;
  roads: RoadSegment[];
  buildings: ObstacleBox[];
  signals: TrafficSignalDef[];
  crosswalks: CrosswalkDef[];
  speedZones: SpeedZone[];
  suggestedStart: { x: number; z: number; h: number };
  /** Экзаменационный маршрут, собранный по реальной дороге участка */
  routeCheckpoints: RouteCheckpoint[];
  routeRoadName: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
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
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    halfX: w / 2,
    halfZ: l / 2,
    h: 0,
    height,
    color: palette[idx % palette.length],
    label: tags.name ? `здание «${tags.name}»` : "здание OSM",
  };
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
    return parseOverpassElements(obj.elements as OsmElement[], title);
  }
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return parseGeoJsonFeatures(obj.features as GeoJsonFeature[], title);
  }
  throw new Error("Ожидается Overpass OSM JSON (поле elements) или GeoJSON FeatureCollection.");
}

function parseOverpassElements(elements: OsmElement[], title: string): NormalizedOsmPack {
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
  const signals: TrafficSignalDef[] = [];
  const crosswalks: CrosswalkDef[] = [];
  const speedZones: SpeedZone[] = [];

  for (const el of elements) {
    if (el.type === "way" && el.tags) {
      const pts: Vec2[] = [];
      if (Array.isArray(el.geometry)) {
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
        });
        if (maxspeed && maxspeed <= 40 && speedZones.length < 12) {
          const mid = pts[Math.floor(pts.length / 2)];
          speedZones.push({
            id: `sz-${el.id}`,
            x: mid.x,
            z: mid.z,
            signX: mid.x - width / 2 - 1.1,
            signZ: mid.z,
            radius: 28,
            limitKmh: maxspeed,
            label: `Знак 3.24 «${maxspeed}» (${el.tags.name || el.tags.highway})`,
          });
        }
      } else if (el.tags.building && buildings.length < 600) {
        const box = polygonToAabbObstacle(`bld-${el.id}`, pts, el.tags, buildings.length);
        if (box) buildings.push(box);
      }
    }
  }

  // Светофоры и пешеходные переходы из узлов
  for (const el of elements) {
    if (el.type === "node" && el.tags && typeof el.lat === "number" && typeof el.lon === "number") {
      const p = project(el.lat, el.lon);
      if (el.tags.highway === "traffic_signals" && signals.length < 30) {
        signals.push({
          id: `sig-${el.id}`,
          x: p.x - 3.6,
          z: p.z,
          h: 0,
          stopLineX: p.x - 1.8,
          stopLineZ: p.z - 4,
          stopLineWidth: 4.5,
          cycleOffset: (signals.length * 7) % 24,
          greenDuration: 14,
          redDuration: 12,
        });
      } else if (el.tags.highway === "crossing" && crosswalks.length < 20) {
        crosswalks.push({
          id: `cw-${el.id}`,
          cx: p.x,
          cz: p.z,
          width: 7.5,
          length: 3.4,
          h: 0,
          pedSpeed: 1.25,
          pedPhaseOffset: crosswalks.length * 4.5,
        });
      }
    }
  }

  return finalizePack(
    roads,
    buildings,
    signals,
    crosswalks,
    speedZones,
    [Number(minLon.toFixed(5)), Number(minLat.toFixed(5)), Number(maxLon.toFixed(5)), Number(maxLat.toFixed(5))],
    title
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

    if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      const hw = tags.highway || "residential";
      if (!HIGHWAY_WIDTHS[hw] && !tags.highway) return;
      const preset = HIGHWAY_WIDTHS[hw] ?? HIGHWAY_WIDTHS.residential;
      const pts = (g.coordinates as number[][]).map(([lon, lat]) => project(lat, lon));
      if (pts.length >= 2) {
        roads.push({
          id: `gj-road-${f.id ?? idx}`,
          points: pts,
          width: parseNumericTag(tags.width) ?? preset.width,
          lanes: parseNumericTag(tags.lanes) ?? preset.lanes,
          highway: hw,
          name: tags.name,
          hasSolidCenter: preset.lanes >= 2,
          speedLimitKmh: parseNumericTag(tags.maxspeed) ?? preset.limit,
        });
      }
    } else if (g.type === "Polygon" && Array.isArray(g.coordinates) && buildings.length < 600) {
      if (!tags.building && tags.highway) return;
      const ring = (g.coordinates as number[][][])[0];
      if (Array.isArray(ring)) {
        const pts = ring.map(([lon, lat]) => project(lat, lon));
        const box = polygonToAabbObstacle(`gj-bld-${f.id ?? idx}`, pts, tags, buildings.length);
        if (box) buildings.push(box);
      }
    } else if (g.type === "Point" && Array.isArray(g.coordinates)) {
      const [lon, lat] = g.coordinates as number[];
      const p = project(lat, lon);
      if (tags.highway === "traffic_signals" && signals.length < 30) {
        signals.push({
          id: `gj-sig-${f.id ?? idx}`,
          x: p.x - 3.5,
          z: p.z,
          h: 0,
          stopLineX: p.x - 1.8,
          stopLineZ: p.z - 4,
          stopLineWidth: 4.5,
          cycleOffset: signals.length * 6,
          greenDuration: 14,
          redDuration: 12,
        });
      }
    }
  });

  return finalizePack(
    roads,
    buildings,
    signals,
    crosswalks,
    speedZones,
    [Number(minLon.toFixed(5)), Number(minLat.toFixed(5)), Number(maxLon.toFixed(5)), Number(maxLat.toFixed(5))],
    title
  );
}

function finalizePack(
  roads: RoadSegment[],
  buildings: ObstacleBox[],
  signals: TrafficSignalDef[],
  crosswalks: CrosswalkDef[],
  speedZones: SpeedZone[],
  bbox: [number, number, number, number],
  title: string
): NormalizedOsmPack {
  let minX = -120;
  let maxX = 120;
  let minZ = -120;
  let maxZ = 120;

  for (const r of roads) {
    for (const p of r.points) {
      minX = Math.min(minX, p.x - 25);
      maxX = Math.max(maxX, p.x + 25);
      minZ = Math.min(minZ, p.z - 25);
      maxZ = Math.max(maxZ, p.z + 25);
    }
  }

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
  if (route.checkpoints.length > 0) {
    for (const cp of route.checkpoints) {
      minX = Math.min(minX, cp.x - 12);
      maxX = Math.max(maxX, cp.x + 12);
      minZ = Math.min(minZ, cp.z - 12);
      maxZ = Math.max(maxZ, cp.z + 12);
    }
  }

  return {
    meta: {
      id: `osm-pack-${Date.now()}`,
      title,
      source: "Локальный импорт OSM JSON / GeoJSON (офлайн)",
      attribution: "© OpenStreetMap contributors",
      license: "ODbL 1.0",
      extractedAt: new Date().toISOString().slice(0, 10),
      bbox,
      roadsCount: roads.length,
      buildingsCount: buildings.length,
      signalsCount: signals.length,
    },
    roads,
    buildings,
    signals,
    crosswalks,
    speedZones,
    suggestedStart,
    routeCheckpoints: route.checkpoints,
    routeRoadName: route.roadName,
    bounds: {
      minX: Math.max(-600, minX),
      maxX: Math.min(600, maxX),
      minZ: Math.max(-600, minZ),
      maxZ: Math.min(600, maxZ),
    },
  };
}
