/**
 * @module maps/routeCatalog
 * @layer pure-core
 * @role Построение и валидация сохраняемых экзаменационных маршрутов поверх дорожного графа OSM.
 * @invariants #1 (метрические координаты), #7 (чистое ядро), #8 (офлайн), #9 (атрибуция ODbL), #15 (снимок мира для реплея).
 * @tests T32
 */
import { isInsideWorldBoundary, isValidBoundaryPolygon } from "./boundary";
import { findRoadNetworkPath, nearestRoadPoint, polylineLength, samplePolyline } from "./route";
import type { CustomScenarioDef } from "../scenarios/custom";
import type { RouteCheckpoint, Vec2 } from "../sim/types";

export type ExamRouteRecord = {
  schema: "cdt.route.v1";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mapFingerprint: string;
  mapTitle: string;
  mapMeta: NonNullable<CustomScenarioDef["mapMeta"]>;
  start: Vec2;
  finish: Vec2;
  path: Vec2[];
  lengthM: number;
  roadNames: string[];
  checkpoints: RouteCheckpoint[];
  /** Полный снимок пользовательского мира для офлайн-запуска и точного реплея. */
  scenarioSnapshot: CustomScenarioDef;
};

export type RouteBuildResult =
  | { ok: true; record: ExamRouteRecord }
  | { ok: false; error: string };

/** Каноническая сериализация: ключи объектов сортируются, порядок геометрических массивов сохраняется. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = stableValue(source[key]);
    }
    return out;
  }
  return value;
}

/** FNV-1a 32-bit для обнаружения смены исходного набора геометрии (не криптографическая подпись). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Идентификатор содержимого карты не зависит от имени файла и времени импорта. */
export function fingerprintOsmScenario(source: CustomScenarioDef): string {
  const payload = {
    bbox: source.mapMeta?.bbox,
    origin: source.mapMeta?.origin,
    bounds: source.bounds,
    boundaryPolygon: source.boundaryPolygon,
    roads: source.roads ?? [],
    obstacles: source.obstacles,
    signs: source.signs ?? [],
    signals: source.signals ?? [],
    crosswalks: source.crosswalks ?? [],
  };
  return `osm-${fnv1a(JSON.stringify(stableValue(payload)))}`;
}

function makeCheckpoints(
  path: readonly Vec2[],
  roads: NonNullable<CustomScenarioDef["roads"]>,
  id: string,
  spacingM: number
): RouteCheckpoint[] {
  const length = polylineLength(path);
  const count = Math.max(2, Math.min(12, Math.ceil(length / spacingM)));
  const checkpoints: RouteCheckpoint[] = [];
  for (let i = 0; i < count; i++) {
    const final = i === count - 1;
    const distance = final ? Math.max(0, length - 1.5) : (length * (i + 1)) / count;
    const point = samplePolyline(path, distance);
    const nearest = nearestRoadPoint(point.x, point.z, roads);
    const roadName = nearest?.road.name?.trim();
    checkpoints.push({
      id: `route-${id}-${i + 1}`,
      x: Number(point.x.toFixed(2)),
      z: Number(point.z.toFixed(2)),
      radius: final ? 8 : 7,
      instruction: final
        ? "Финиш маршрута: остановитесь в безопасном месте."
        : roadName
          ? `Продолжайте движение по улице «${roadName}» согласно маршруту.`
          : `Продолжайте движение по маршруту, контрольная точка ${i + 1}.`,
      ...(final ? { requireStop: true } : {}),
    });
  }
  return checkpoints;
}

/**
 * Создаёт маршрут между двумя точками, привязанными к дорогам OSM.
 * Учитывает one-way, layer, границы мира и сохраняет полный снимок карты.
 */
export function buildExamRouteRecord(
  source: CustomScenarioDef,
  from: Vec2,
  to: Vec2,
  title: string,
  id: string,
  createdAt: string,
  checkpointSpacingM = 90
): RouteBuildResult {
  if (!source.mapMeta) {
    return { ok: false, error: "Сначала импортируйте карту OSM во вкладке «Свой сценарий»." };
  }
  const roads = (source.roads ?? []).filter((road) => road.id !== "custom-lot" && road.points.length >= 2);
  if (roads.length === 0) {
    return { ok: false, error: "В исходной карте не найдено дорог, пригодных для маршрутизации." };
  }
  if (![from.x, from.z, to.x, to.z].every(Number.isFinite)) {
    return { ok: false, error: "Начало и конец маршрута должны иметь корректные координаты." };
  }
  const cleanTitle = title.trim().slice(0, 80);
  if (!cleanTitle) return { ok: false, error: "Укажите название маршрута." };

  const startSnap = nearestRoadPoint(from.x, from.z, roads);
  const finishSnap = nearestRoadPoint(to.x, to.z, roads);
  if (!startSnap || !finishSnap) {
    return { ok: false, error: "Не удалось привязать обе точки к дорожной сети." };
  }
  if (startSnap.dist > startSnap.road.width / 2 + 10 || finishSnap.dist > finishSnap.road.width / 2 + 10) {
    return { ok: false, error: "Одна из точек слишком далеко от дороги. Выберите точки ближе к осевой линии." };
  }

  const network = findRoadNetworkPath(roads, from, to, 10);
  if (!network.connected) {
    return {
      ok: false,
      error: network.wrongWay
        ? "Между точками нет разрешённого пути: выбранное направление нарушает one-way."
        : "Дорожная сеть не соединяет выбранные точки. Проверьте участок карты или выберите другие точки.",
    };
  }
  if (network.path.length < 2 || network.lengthM < 25) {
    return { ok: false, error: "Маршрут слишком короткий. Минимальная длина — 25 м." };
  }

  const polygon = isValidBoundaryPolygon(source.boundaryPolygon) ? source.boundaryPolygon : undefined;
  for (const point of network.path) {
    if (!isInsideWorldBoundary(point.x, point.z, source.bounds, polygon)) {
      return { ok: false, error: "Маршрут выходит за границы загруженной карты или рабочей области." };
    }
  }

  let heading = Math.atan2(network.path[1].x - network.path[0].x, network.path[1].z - network.path[0].z);
  if (!Number.isFinite(heading)) heading = startSnap.h;
  const startPose = {
    x: Number(network.path[0].x.toFixed(2)),
    z: Number(network.path[0].z.toFixed(2)),
    h: Number(heading.toFixed(4)),
  };
  const routeId = id.trim();
  if (!routeId) return { ok: false, error: "Не удалось сформировать идентификатор маршрута." };

  const checkpoints = makeCheckpoints(network.path, roads, routeId, Math.max(35, Math.min(250, checkpointSpacingM)));
  const speedLimit = startSnap.road.speedLimitKmh ?? source.defaultSpeedLimitKmh;
  const scenarioSnapshot: CustomScenarioDef = {
    ...source,
    version: 1,
    title: cleanTitle,
    subtitle: `OSM · ${(network.lengthM / 1000).toFixed(2)} км · ${network.roadNames.length} улиц`,
    brief: `Следуйте по сохранённому маршруту длиной ${Math.round(network.lengthM)} м. Соблюдайте знаки, разметку и ограничения скорости.`,
    start: startPose,
    defaultSpeedLimitKmh: speedLimit,
    useLotSurface: false,
    bays: [],
    checkpoints: checkpoints.map((checkpoint) => ({ ...checkpoint })),
    roads: roads.map((road) => ({ ...road, points: road.points.map((point) => ({ ...point })) })),
    obstacles: source.obstacles.map((obstacle) => ({ ...obstacle })),
    signs: (source.signs ?? []).map((sign) => ({ ...sign })),
    signals: (source.signals ?? []).map((signal) => ({ ...signal })),
    crosswalks: (source.crosswalks ?? []).map((crosswalk) => ({ ...crosswalk })),
    mapMeta: { ...source.mapMeta, bbox: [...source.mapMeta.bbox] as [number, number, number, number] },
    boundaryPolygon: source.boundaryPolygon?.map((point) => ({ ...point })),
  };
  const now = createdAt;
  return {
    ok: true,
    record: {
      schema: "cdt.route.v1",
      id: routeId,
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
      mapFingerprint: fingerprintOsmScenario(source),
      mapTitle: source.mapMeta.title,
      mapMeta: { ...source.mapMeta, bbox: [...source.mapMeta.bbox] as [number, number, number, number] },
      start: { x: startPose.x, z: startPose.z },
      finish: { x: Number(network.path[network.path.length - 1].x.toFixed(2)), z: Number(network.path[network.path.length - 1].z.toFixed(2)) },
      path: network.path.map((point) => ({ x: Number(point.x.toFixed(2)), z: Number(point.z.toFixed(2)) })),
      lengthM: network.lengthM,
      roadNames: network.roadNames,
      checkpoints,
      scenarioSnapshot,
    },
  };
}

/** Строгая проверка JSON-записи каталога перед импортом или открытием. */
export function isExamRouteRecord(value: unknown): value is ExamRouteRecord {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<ExamRouteRecord>;
  const snapshot = route.scenarioSnapshot;
  if (
    route.schema !== "cdt.route.v1" ||
    typeof route.id !== "string" || route.id.length === 0 ||
    typeof route.title !== "string" || route.title.trim().length === 0 ||
    typeof route.createdAt !== "string" || !Number.isFinite(Date.parse(route.createdAt)) ||
    typeof route.updatedAt !== "string" || !Number.isFinite(Date.parse(route.updatedAt)) ||
    typeof route.mapFingerprint !== "string" || !/^osm-[0-9a-f]{8}$/.test(route.mapFingerprint) ||
    typeof route.mapTitle !== "string" ||
    !route.mapMeta || !Array.isArray(route.mapMeta.bbox) || route.mapMeta.bbox.length !== 4 ||
    !snapshot || snapshot.version !== 1 || !snapshot.mapMeta ||
    !snapshot.bounds || !snapshot.start ||
    !Array.isArray(snapshot.roads) || snapshot.roads.length === 0 ||
    !Array.isArray(snapshot.obstacles) ||
    !Array.isArray(route.path) || route.path.length < 2 ||
    !route.path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)) ||
    !Number.isFinite(route.lengthM) || route.lengthM! < 25 ||
    !route.start || !Number.isFinite(route.start.x) || !Number.isFinite(route.start.z) ||
    !route.finish || !Number.isFinite(route.finish.x) || !Number.isFinite(route.finish.z) ||
    !Array.isArray(route.roadNames) || !route.roadNames.every((name) => typeof name === "string") ||
    !Array.isArray(route.checkpoints) || route.checkpoints.length < 2 ||
    !route.checkpoints.every((point) =>
      typeof point.id === "string" &&
      typeof point.instruction === "string" &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.z) &&
      Number.isFinite(point.radius) &&
      point.radius > 0
    )
  ) return false;
  return fingerprintOsmScenario(snapshot as CustomScenarioDef) === route.mapFingerprint;
}
