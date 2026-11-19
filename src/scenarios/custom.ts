/**
 * @module scenarios/custom
 * @layer pure-core
 * @role Схема, нормализация, офлайн-импорт (OSM XML / Overpass JSON / GeoJSON / JSON), валидация и сборка мира с произвольной границей.
 * @invariants #7 (чистое ядро), #8–#9 (офлайн-импорт + сохранение ODbL 1.0), #15 (снимок `customWorld` в попытке и реплее).
 * @tests T16, T28, T29, T30, T31, T32
 */
import {
  boundingBoxOfPolygon,
  boundsToPolygon,
  buildBoundaryCurbSegments,
  isInsideWorldBoundary,
  isSimplePolygon,
  isValidBoundaryPolygon,
  MAX_WORLD_COORD,
  polygonArea,
  sanitizeBoundaryPolygon,
} from "../maps/boundary";
import { clipPolylineOutsideRoads, RoadCorridorIndex } from "../maps/osmDeconflict";
import { INTERNET_RADIO_STATIONS } from "../audio/radioCatalog";
import { parseMapFileText, type MapImportFormat, type NormalizedOsmPack } from "../maps/osmLoader";
import { PLAYER_CARS } from "../sim/playerCar";
import { isCarInsideBay, SpatialGrid } from "../sim/spatialGrid";
import type {
  CrosswalkDef,
  MapPackMeta,
  ObstacleBox,
  ObstacleKind,
  ParkedModelKey,
  ParkingBay,
  PlayerCarId,
  RoadSegment,
  RoadSignDef,
  RoadSignKind,
  RouteCheckpoint,
  SpeedZone,
  TrafficSignalDef,
  Vec2,
  WorldBounds,
  WorldData,
} from "../sim/types";
import { CAR, VEHICLE_DIMS } from "../sim/vehicle";
import { SIGN_SPEED_ZONE_PREFIX, signToSpeedZone } from "./signs";

/**
 * Пользовательская карта/сценарий инструктора — хранится как данные, без правки кода.
 * Все поля расширения (дороги, знаки, светофоры, переходы, полигон границы, метаданные OSM) опциональны:
 * старые сохранения `cdt.customScenario.v1` и JSON-файлы читаются без миграции.
 */
export type CustomScenarioDef = {
  version: 1;
  title: string;
  subtitle: string;
  brief: string;
  start: { x: number; z: number; h: number };
  defaultSpeedLimitKmh: number;
  lotHalfX: number; // полуразмер асфальтовой площадки по X (м)
  lotHalfZ: number; // полуразмер асфальтовой площадки по Z (м)
  /** Рисовать ли прямоугольную асфальтовую площадку (true для автодрома, false для уличной сети). */
  useLotSurface?: boolean;
  /** Произвольные сегменты дорог (импортированные из OSM/GeoJSON или добавленные в редакторе). */
  roads?: RoadSegment[];
  bays: ParkingBay[];
  /** Препятствия и объекты окружения (авто в занятых боксах достраиваются автоматически). */
  obstacles: ObstacleBox[];
  /** Дорожные знаки (скоростные автоматически порождают SpeedZone в buildCustomWorld). */
  signs?: RoadSignDef[];
  /** Светофоры со стоп-линиями (участвуют в симуляции и 3D-рендере). */
  signals?: TrafficSignalDef[];
  /** Нерегулируемые пешеходные переходы с пешеходами (участвуют в симуляции и 3D-рендере). */
  crosswalks?: CrosswalkDef[];
  checkpoints: RouteCheckpoint[];
  /** Метаданные и атрибуция ODbL 1.0, если карта создана из выгрузки OpenStreetMap. */
  mapMeta?: MapPackMeta;
  /** Охватывающий прямоугольник мира (не обязан быть квадратным; до ±3000 м). */
  bounds: WorldBounds;
  /** Произвольный замкнутый многоугольник границы площадки/маршрута/мира (≥ 3 вершин). */
  boundaryPolygon?: Vec2[];
  /** Установить физический бордюр по всему контуру площадки/границы (прямоугольному или многоугольному). */
  perimeterCurb?: boolean;
  /**
   * Список радиостанций/подключений сценария: id из `audio/radioCatalog.ts`.
   * Отсутствие поля — все станции каталога (старые сценарии не меняются).
   */
  radioStationIds?: string[];
  /**
   * Автомобиль игрока для этого сценария (`sim/playerCar.ts`).
   * Отсутствие поля — учебный Kia Ceed JD (совместимость со старыми файлами сценариев).
   */
  playerCarId?: PlayerCarId;
};

export type EditorImportKind = "scenario" | "backup" | MapImportFormat;

export type EditorImportResult = {
  def: CustomScenarioDef;
  kind: EditorImportKind;
  summary: string;
  /** Исходный необрезанный пакет OSM для повторной неразрушающей обрезки по произвольной границе. */
  rawPack?: NormalizedOsmPack;
};

export const CUSTOM_STORAGE_KEY = "cdt.customScenario.v1";

/** Допустимые id машин сценария и станций тюнера — для валидации при импорте файла. */
export const PLAYER_CAR_IDS: readonly PlayerCarId[] = PLAYER_CARS.map((c) => c.id);
export const RADIO_STATION_IDS: readonly string[] = INTERNET_RADIO_STATIONS.map((st) => st.id);

const PARKED_COLORS: Record<ParkedModelKey, number> = {
  picanto: 0xf2c94c,
  rio: 0x3b82f6,
  ceed: 0xd97706,
  xceed: 0xe6edf2,
  sorento: 0x4b5563,
};

/** Стартовый шаблон: два бокса 90°, один свободный, старт в проезде. */
export function defaultCustomScenario(): CustomScenarioDef {
  return {
    version: 1,
    title: "Мой сценарий",
    subtitle: "2 бокса 90° · старт в проезде",
    brief:
      "Заедьте задним ходом в свободный бокс №101 и удержите остановку. Бокс №102 занят автомобилем.",
    start: { x: -4.9, z: 2.6, h: -Math.PI / 2 },
    defaultSpeedLimitKmh: 20,
    lotHalfX: 16,
    lotHalfZ: 12,
    useLotSurface: true,
    roads: [],
    bays: [
      {
        id: 101,
        label: "Бокс №101 (свой)",
        kind: "perpendicular",
        cx: -1.4,
        cz: -2.65,
        width: 2.5,
        length: 5.3,
        h: 0,
        openSide: "front",
        occupied: false,
        requireReverseEntry: true,
      },
      {
        id: 102,
        label: "Бокс №102 (свой)",
        kind: "perpendicular",
        cx: 1.4,
        cz: -2.65,
        width: 2.5,
        length: 5.3,
        h: 0,
        openSide: "front",
        occupied: true,
        parkedModel: "rio",
        parkedColor: 0x3b82f6,
        requireReverseEntry: true,
      },
    ],
    obstacles: [
      {
        id: "custom-curb-back",
        kind: "curb",
        cx: 0,
        cz: -5.75,
        halfX: 4.4,
        halfZ: 0.18,
        h: 0,
        height: 0.16,
        color: 0x9aa6b2,
        label: "задний бордюр",
      },
      {
        id: "custom-cone-l",
        kind: "cone",
        cx: -0.02,
        cz: -0.1,
        halfX: 0.14,
        halfZ: 0.14,
        h: 0,
        height: 0.55,
        color: 0xf97316,
        label: "разметочный конус",
      },
      {
        id: "custom-bld-1",
        kind: "building",
        cx: -13,
        cz: 9,
        halfX: 4,
        halfZ: 6,
        h: 0,
        height: 9.6,
        color: 0x52616f,
        label: "учебный корпус",
      },
    ],
    signs: [],
    signals: [],
    crosswalks: [],
    checkpoints: [],
    bounds: { minX: -22, maxX: 22, minZ: -18, maxZ: 18 },
  };
}

/** Создаёт чистую площадку для сборки карты с нуля. */
export function emptyCustomScenario(): CustomScenarioDef {
  return {
    version: 1,
    title: "Новая учебная карта",
    subtitle: "Чистая площадка · добавьте дороги, знаки, боксы или КТ",
    brief: "Выполните учебный маршрут или манёвр по заданию инструктора.",
    start: { x: 0, z: -12, h: 0 },
    defaultSpeedLimitKmh: 40,
    lotHalfX: 28,
    lotHalfZ: 24,
    useLotSurface: true,
    roads: [],
    bays: [],
    obstacles: [],
    signs: [],
    signals: [],
    crosswalks: [],
    checkpoints: [
      {
        id: "cp-custom-1",
        x: 0,
        z: 10,
        radius: 5.5,
        instruction: "Проедьте прямо до контрольной точки №1.",
      },
    ],
    bounds: { minX: -36, maxX: 36, minZ: -32, maxZ: 32 },
  };
}

/** Гарантирует полноту полей CustomScenarioDef для старых и новых файлов. */
export function normalizeCustomScenario(raw: Partial<CustomScenarioDef>): CustomScenarioDef {
  const base = defaultCustomScenario();
  const poly = Array.isArray(raw.boundaryPolygon) ? sanitizeBoundaryPolygon(raw.boundaryPolygon) ?? undefined : undefined;
  const rawBounds = raw.bounds ? { ...base.bounds, ...raw.bounds } : base.bounds;
  const bounds = poly ? boundingBoxOfPolygon(poly, 0) : rawBounds;
  return {
    ...base,
    ...raw,
    version: 1,
    start: raw.start ? { ...base.start, ...raw.start } : base.start,
    bounds,
    boundaryPolygon: poly,
    perimeterCurb: raw.perimeterCurb ? true : undefined,
    // Новые поля сценария: машина заезда и список станций тюнера (неизвестные id отбрасываем)
    playerCarId: PLAYER_CAR_IDS.includes(raw.playerCarId as PlayerCarId) ? (raw.playerCarId as PlayerCarId) : undefined,
    radioStationIds: (() => {
      if (!Array.isArray(raw.radioStationIds)) return undefined;
      const ids = raw.radioStationIds.filter((id): id is string => typeof id === "string" && RADIO_STATION_IDS.includes(id));
      // Пустой список бессмыслен: тюнеру нужен хотя бы один эфир, поэтому поле просто не сохраняется
      return ids.length > 0 ? ids : undefined;
    })(),
    useLotSurface: raw.useLotSurface !== undefined ? Boolean(raw.useLotSurface) : true,
    roads: Array.isArray(raw.roads)
      ? raw.roads.map((r) => ({ ...r, points: Array.isArray(r.points) ? r.points.map((p) => ({ ...p })) : [] }))
      : [],
    bays: Array.isArray(raw.bays) ? raw.bays.map((b) => ({ ...b })) : base.bays,
    obstacles: Array.isArray(raw.obstacles) ? raw.obstacles.map((o) => ({ ...o })) : base.obstacles,
    signs: Array.isArray(raw.signs) ? raw.signs.map((s) => ({ ...s })) : [],
    signals: Array.isArray(raw.signals) ? raw.signals.map((s) => ({ ...s })) : [],
    crosswalks: Array.isArray(raw.crosswalks) ? raw.crosswalks.map((c) => ({ ...c })) : [],
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.map((c) => ({ ...c })) : [],
    mapMeta: raw.mapMeta ? { ...raw.mapMeta, bbox: [...raw.mapMeta.bbox] as [number, number, number, number] } : undefined,
  };
}

/** Переносит знаки и отдельные SpeedZone мира в единый редактируемый массив `signs` без дублей. */
function collectEditableSigns(signs: readonly RoadSignDef[] | undefined, speedZones: readonly SpeedZone[]): RoadSignDef[] {
  const list: RoadSignDef[] = (signs ?? []).map((s) => ({ ...s }));
  const coveredZoneIds = new Set(list.map((s) => `${SIGN_SPEED_ZONE_PREFIX}${s.id}`));
  for (const sz of speedZones) {
    if (coveredZoneIds.has(sz.id)) continue;
    list.push({
      id: `sign-${sz.id}`,
      kind: "speed_limit",
      x: sz.signX,
      z: sz.signZ,
      h: 0,
      limitKmh: sz.limitKmh,
      zoneRadius: sz.radius,
      zoneX: sz.x,
      zoneZ: sz.z,
      label: sz.label,
    });
  }
  return list;
}

/** Клонирует готовый мир (бокс 90°, параллельная, городской маршрут OSM) в редактируемую карту. */
export function customFromWorld(world: WorldData, title: string): CustomScenarioDef {
  const isLot = world.scenarioId === "bay_90";
  const lotHalfX = Math.min(200, Math.max(8, (world.bounds.maxX - world.bounds.minX) / 2 - 4));
  const lotHalfZ = Math.min(200, Math.max(8, (world.bounds.maxZ - world.bounds.minZ) / 2 - 4));
  const roads: RoadSegment[] = isLot
    ? []
    : world.roads
        .filter((r) => r.id !== "custom-lot")
        .map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) }));

  return {
    version: 1,
    title,
    subtitle: `Копия: ${world.title}`,
    brief: world.examinerBrief,
    start: { ...world.start },
    defaultSpeedLimitKmh: world.defaultSpeedLimitKmh,
    lotHalfX: Number(lotHalfX.toFixed(1)),
    lotHalfZ: Number(lotHalfZ.toFixed(1)),
    useLotSurface: isLot,
    roads,
    bays: world.bays.map((b) => ({ ...b })),
    obstacles: world.obstacles
      .filter((o) => !(o.kind === "parked_car" && o.id.startsWith("parked-bay-")))
      .map((o) => ({ ...o })),
    signs: collectEditableSigns(world.signs, world.speedZones),
    signals: world.signals.map((s) => ({ ...s })),
    crosswalks: world.crosswalks.map((c) => ({ ...c })),
    checkpoints: world.checkpoints.map((c) => ({ ...c })),
    ...(world.mapMeta
      ? { mapMeta: { ...world.mapMeta, bbox: [...world.mapMeta.bbox] as [number, number, number, number] } }
      : {}),
    bounds: { ...world.bounds },
    ...(isValidBoundaryPolygon(world.boundaryPolygon)
      ? { boundaryPolygon: world.boundaryPolygon.map((p) => ({ ...p })) }
      : {}),
  };
}

/**
 * Конвертирует офлайн-пакет OSM (`.osm` XML, Overpass JSON или GeoJSON) в редактируемый
 * сценарий инструктора с сохранением неквадратных пропорций и произвольного полигона границы.
 */
export function customFromOsmPack(pack: NormalizedOsmPack, customTitle?: string): CustomScenarioDef {
  const signs = collectEditableSigns(pack.signs, pack.speedZones);
  const obstacles: ObstacleBox[] = [
    ...pack.buildings.map((b) => ({ ...b })),
    ...(pack.extraObstacles ?? []).map((o) => ({ ...o })),
  ];
  const spanX = Math.round(pack.bounds.maxX - pack.bounds.minX);
  const spanZ = Math.round(pack.bounds.maxZ - pack.bounds.minZ);
  const parts = [`дорог ${pack.roads.length}`, `КТ ${pack.routeCheckpoints.length}`];
  if (pack.buildings.length > 0) parts.push(`зданий ${pack.buildings.length}`);
  if (pack.signals.length > 0) parts.push(`светофоров ${pack.signals.length}`);
  if (signs.length > 0) parts.push(`знаков ${signs.length}`);
  parts.push(`${spanX}×${spanZ} м`);

  return {
    version: 1,
    title: customTitle?.trim() || pack.meta.title,
    subtitle: `Импорт OSM: ${parts.join(" · ")}`,
    brief: pack.routeRoadName
      ? `Учебный маршрут по «${pack.routeRoadName}» (${pack.routeCheckpoints.length} КТ): соблюдайте знаки, сигналы светофоров и указатели поворота (Q/E).`
      : "Учебный проезд по импортированной карте OSM: соблюдайте дорожные знаки, светофоры и скоростной режим.",
    start: { ...pack.suggestedStart },
    defaultSpeedLimitKmh: 60,
    lotHalfX: 24,
    lotHalfZ: 20,
    useLotSurface: pack.roads.length === 0,
    roads: pack.roads.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) })),
    bays: [],
    obstacles,
    signs,
    signals: pack.signals.map((s) => ({ ...s })),
    crosswalks: pack.crosswalks.map((c) => ({ ...c })),
    checkpoints: pack.routeCheckpoints.map((c) => ({ ...c })),
    mapMeta: {
      ...pack.meta,
      roadsCount: pack.roads.length,
      buildingsCount: pack.buildings.length,
      signalsCount: pack.signals.length,
      signsCount: signs.length,
      bbox: [...pack.meta.bbox] as [number, number, number, number],
    },
    bounds: { ...pack.bounds },
    ...(isValidBoundaryPolygon(pack.boundaryPolygon)
      ? { boundaryPolygon: pack.boundaryPolygon.map((p) => ({ ...p })) }
      : {}),
  };
}

/**
 * Универсальный офлайн-импорт файла в редактор карт.
 * Принимает: `.osm` / `.xml` (OpenStreetMap / JOSM), Overpass `.json`, `.geojson`,
 * сохранённый JSON сценария (`CustomScenarioDef`) и резервную копию `cdt.backup.v1`.
 */
export function importEditorFileText(text: string, fileName = "import.json"): EditorImportResult {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("Файл пуст.");
  }

  // XML-выгрузка OpenStreetMap (.osm / .xml)
  if (trimmed.startsWith("<")) {
    const { pack, format } = parseMapFileText(trimmed, fileName);
    const def = customFromOsmPack(pack);
    const spanX = Math.round(def.bounds.maxX - def.bounds.minX);
    const spanZ = Math.round(def.bounds.maxZ - def.bounds.minZ);
    const fixedNote = pack.meta.resolvedConflictsCount
      ? ` · согласовано конфликтов: ${pack.meta.resolvedConflictsCount}`
      : "";
    return {
      def,
      kind: format,
      rawPack: pack,
      summary: `Импортирован .osm «${def.title}» (${spanX}×${spanZ} м): дорог ${def.roads?.length ?? 0}, КТ ${def.checkpoints.length}, знаков ${def.signs?.length ?? 0}, светофоров ${def.signals?.length ?? 0}${fixedNote}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Не удалось прочитать файл: ожидается .osm XML, Overpass JSON, GeoJSON или JSON сценария.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Неверный формат файла.");
  }
  const obj = parsed as Record<string, unknown>;

  // Резервная копия cdt.backup.v1
  if (obj.schema === "cdt.backup.v1" && obj.customScenario && typeof obj.customScenario === "object") {
    const sc = obj.customScenario as Partial<CustomScenarioDef>;
    if (!sc.start || !Array.isArray(sc.bays) || !Array.isArray(sc.obstacles)) {
      throw new Error("В резервной копии повреждён раздел customScenario.");
    }
    const def = normalizeCustomScenario(sc);
    return {
      def,
      kind: "backup",
      summary: `Сценарий «${def.title}» восстановлен из резервной копии`,
    };
  }

  // Выгрузка Overpass OSM JSON или GeoJSON
  if (Array.isArray(obj.elements) || (obj.type === "FeatureCollection" && Array.isArray(obj.features))) {
    const { pack, format } = parseMapFileText(trimmed, fileName);
    const def = customFromOsmPack(pack);
    const label = format === "geojson" ? "GeoJSON" : "Overpass OSM JSON";
    const spanX = Math.round(def.bounds.maxX - def.bounds.minX);
    const spanZ = Math.round(def.bounds.maxZ - def.bounds.minZ);
    const fixedNote = pack.meta.resolvedConflictsCount
      ? ` · согласовано конфликтов: ${pack.meta.resolvedConflictsCount}`
      : "";
    return {
      def,
      kind: format,
      rawPack: pack,
      summary: `Импортирован ${label} «${def.title}» (${spanX}×${spanZ} м): дорог ${def.roads?.length ?? 0}, КТ ${def.checkpoints.length}, знаков ${def.signs?.length ?? 0}, светофоров ${def.signals?.length ?? 0}${fixedNote}`,
    };
  }

  // Собственный JSON сценария
  const sc = obj as Partial<CustomScenarioDef>;
  if (sc.start && Array.isArray(sc.bays) && Array.isArray(sc.obstacles)) {
    const def = normalizeCustomScenario(sc);
    return {
      def,
      kind: "scenario",
      summary: `Сценарий «${def.title || fileName}» загружен в редактор`,
    };
  }

  throw new Error(
    "Формат не распознан: выберите файл .osm (XML), Overpass .json, .geojson или сохранённый JSON сценария."
  );
}

/** Строит WorldData из пользовательского определения карты (полностью детерминированно). */
export function buildCustomWorld(def: CustomScenarioDef): WorldData {
  const obstacles: ObstacleBox[] = def.obstacles
    .filter((o) => !(o.kind === "parked_car" && o.id.startsWith("parked-bay-")))
    .map((o) => ({ ...o }));

  // Автодостройка припаркованных машин в занятых боксах
  for (const bay of def.bays) {
    if (!bay.occupied) continue;
    const model: ParkedModelKey = bay.parkedModel ?? "rio";
    const dim = VEHICLE_DIMS[model];
    obstacles.push({
      id: `parked-bay-${bay.id}`,
      kind: "parked_car",
      cx: bay.cx,
      cz: bay.cz,
      halfX: dim.width / 2,
      halfZ: dim.length / 2,
      h: bay.h,
      height: dim.height,
      color: bay.parkedColor ?? PARKED_COLORS[model],
      model,
      label: `${dim.name} (место №${bay.id})`,
    });
  }

  const validPoly = isValidBoundaryPolygon(def.boundaryPolygon)
    ? def.boundaryPolygon.map((p) => ({ ...p }))
    : undefined;
  const bounds = validPoly ? boundingBoxOfPolygon(validPoly, 0) : { ...def.bounds };
  const useLot = def.useLotSurface !== false;
  // При активном boundaryPolygon асфальтовая площадка принимает точную произвольную форму полигона (а не прямоугольник)
  const lotPolygon = useLot && validPoly ? validPoly.map((p) => ({ ...p })) : undefined;

  const streetRoads: RoadSegment[] = [];
  for (const r of def.roads ?? []) {
    if (Array.isArray(r.points) && r.points.length >= 2) {
      streetRoads.push({ ...r, points: r.points.map((p) => ({ ...p })) });
    }
  }

  if (def.perimeterCurb) {
    const curbRing =
      validPoly ??
      (useLot
        ? boundsToPolygon({
            minX: -def.lotHalfX,
            maxX: def.lotHalfX,
            minZ: -def.lotHalfZ,
            maxZ: def.lotHalfZ,
          })
        : boundsToPolygon(bounds));

    if (streetRoads.length === 0) {
      // На закрытой площадке без внешних улиц — сплошной 3D-бордюр по всему контуру
      const curbSegs = buildBoundaryCurbSegments(curbRing, 0.28);
      curbSegs.forEach((seg, idx) => {
        obstacles.push({
          id: `boundary-curb-${idx + 1}`,
          kind: "curb",
          cx: seg.cx,
          cz: seg.cz,
          halfX: seg.halfX,
          halfZ: seg.halfZ,
          h: seg.h,
          height: 0.16,
          color: 0xcbd5e1,
          label: "Бордюр границы площадки",
        });
      });
    } else {
      // На карте с реальными улицами автоматически оставляем чистые проезды в местах выхода дорог за контур
      const roadIdx = new RoadCorridorIndex(streetRoads, true);
      let area2 = 0;
      for (let i = 0; i < curbRing.length; i++) {
        const a = curbRing[i];
        const b = curbRing[(i + 1) % curbRing.length];
        area2 += a.x * b.z - b.x * a.z;
      }
      const outSign = area2 >= 0 ? 1 : -1;
      const halfT = 0.14;
      let curbIdx = 1;
      for (let i = 0; i < curbRing.length; i++) {
        const a = curbRing[i];
        const b = curbRing[(i + 1) % curbRing.length];
        const clipped = clipPolylineOutsideRoads([a, b], roadIdx, { roadClearanceM: 0.4, minPieceLenM: 0.8 });
        for (const piece of clipped.pieces) {
          for (let k = 0; k < piece.length - 1; k++) {
            const p0 = piece[k];
            const p1 = piece[k + 1];
            const dx = p1.x - p0.x;
            const dz = p1.z - p0.z;
            const len = Math.hypot(dx, dz);
            if (len < 0.6) continue;
            const nx = (outSign * dz) / len;
            const nz = (-outSign * dx) / len;
            obstacles.push({
              id: `boundary-curb-${curbIdx++}`,
              kind: "curb",
              cx: Number(((p0.x + p1.x) * 0.5 + nx * halfT).toFixed(2)),
              cz: Number(((p0.z + p1.z) * 0.5 + nz * halfT).toFixed(2)),
              halfX: halfT,
              halfZ: Number((len * 0.5).toFixed(2)),
              h: Number(Math.atan2(dx, dz).toFixed(4)),
              height: 0.16,
              color: 0xcbd5e1,
              label: "Бордюр границы участка",
            });
          }
        }
      }
    }
  }

  const roads: RoadSegment[] = [];
  if (useLot && !lotPolygon) {
    roads.push({
      id: "custom-lot",
      points: [
        { x: -def.lotHalfX, z: 0 },
        { x: def.lotHalfX, z: 0 },
      ],
      width: def.lotHalfZ * 2,
      lanes: 1,
      highway: "service",
      name: "Своя площадка",
    });
  }
  roads.push(...streetRoads);

  const signs: RoadSignDef[] = (def.signs ?? []).map((s) => ({ ...s }));
  const speedZones: SpeedZone[] = [];
  for (const sign of signs) {
    const sz = signToSpeedZone(sign);
    if (sz) speedZones.push(sz);
  }

  const signals: TrafficSignalDef[] = (def.signals ?? []).map((s) => ({ ...s }));
  const crosswalks: CrosswalkDef[] = (def.crosswalks ?? []).map((c) => ({ ...c }));

  const freeCount = def.bays.filter((b) => !b.occupied).length;
  return {
    scenarioId: "custom",
    title: def.title.trim() || "Свой сценарий",
    subtitle:
      def.subtitle.trim() ||
      (def.checkpoints.length > 0
        ? `Точек маршрута: ${def.checkpoints.length} · знаков: ${signs.length} · свободных мест: ${freeCount}`
        : `Свободных мест: ${freeCount} из ${def.bays.length}`),
    examinerBrief: def.brief.trim() || "Выполните упражнение: припаркуйтесь в свободный бокс.",
    start: { ...def.start },
    bays: def.bays.map((b) => ({ ...b })),
    obstacles,
    roads,
    signs,
    signals,
    speedZones,
    crosswalks,
    checkpoints: def.checkpoints.map((c) => ({ ...c })),
    defaultSpeedLimitKmh: def.defaultSpeedLimitKmh,
    ...(def.mapMeta
      ? { mapMeta: { ...def.mapMeta, bbox: [...def.mapMeta.bbox] as [number, number, number, number] } }
      : {}),
    embedInAttempt: true,
    // Машина и список станций сценария: отсутствие полей — учебный Ceed и весь каталог FM
    ...(def.playerCarId ? { playerCarId: def.playerCarId } : {}),
    ...(def.radioStationIds && def.radioStationIds.length > 0
      ? { radioStationIds: [...def.radioStationIds] }
      : {}),
    bounds,
    ...(validPoly ? { boundaryPolygon: validPoly } : {}),
    ...(lotPolygon ? { lotPolygon } : {}),
  };
}

export type CustomValidation = { errors: string[]; warnings: string[] };

/**
 * Проверка пользовательской карты: errors блокируют заезд, warnings — подсказки инструктору.
 * Учитывает произвольный полигон границы `boundaryPolygon` и реальные масштабы выгрузок OSM (до ±3000 м).
 */
export function validateCustomScenario(def: CustomScenarioDef): CustomValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const useLot = def.useLotSurface !== false;
  const roads = def.roads ?? [];
  const signs = def.signs ?? [];
  const signals = def.signals ?? [];
  const crosswalks = def.crosswalks ?? [];
  const rawPoly = def.boundaryPolygon;

  if (rawPoly !== undefined) {
    if (rawPoly.length < 3) {
      errors.push("Полигон границы должен содержать минимум 3 вершины.");
    } else if (!isSimplePolygon(rawPoly)) {
      errors.push("Контур границы самопересекается — переместите вершины или сбросьте границу.");
    } else if (polygonArea(rawPoly) < 25) {
      errors.push("Площадь контура границы слишком мала (нужно не менее 25 м²).");
    }
  }
  const poly = isValidBoundaryPolygon(rawPoly) ? rawPoly : undefined;
  const effectiveBounds = poly ? boundingBoxOfPolygon(poly, 0) : def.bounds;
  const inside = (x: number, z: number) => isInsideWorldBoundary(x, z, effectiveBounds, poly);

  if (!def.title.trim()) errors.push("Укажите название сценария.");
  if (useLot && !poly) {
    if (!Number.isFinite(def.lotHalfX) || def.lotHalfX < 5 || def.lotHalfX > 400) {
      errors.push("Полуразмер площадки по X должен быть от 5 до 400 м.");
    }
    if (!Number.isFinite(def.lotHalfZ) || def.lotHalfZ < 5 || def.lotHalfZ > 400) {
      errors.push("Полуразмер площадки по Z должен быть от 5 до 400 м.");
    }
  }
  if (
    !Number.isFinite(effectiveBounds.minX) ||
    !Number.isFinite(effectiveBounds.maxX) ||
    !Number.isFinite(effectiveBounds.minZ) ||
    !Number.isFinite(effectiveBounds.maxZ) ||
    effectiveBounds.minX >= effectiveBounds.maxX ||
    effectiveBounds.minZ >= effectiveBounds.maxZ
  ) {
    errors.push("Границы мира заданы неверно: min должен быть меньше max.");
  } else if (
    effectiveBounds.minX < -MAX_WORLD_COORD ||
    effectiveBounds.maxX > MAX_WORLD_COORD ||
    effectiveBounds.minZ < -MAX_WORLD_COORD ||
    effectiveBounds.maxZ > MAX_WORLD_COORD
  ) {
    errors.push(`Границы мира выходят за предел ±${MAX_WORLD_COORD} м.`);
  }

  if (!inside(def.start.x, def.start.z)) {
    errors.push(
      poly
        ? "Стартовая позиция находится за пределами заданного контура границы."
        : "Стартовая позиция находится за границами мира."
    );
  }

  const freeBays = def.bays.filter((b) => !b.occupied);
  if (freeBays.length === 0 && def.checkpoints.length === 0) {
    if (roads.length > 0) {
      warnings.push(
        "Контрольные точки маршрута не заданы: нажмите «Автомаршрут» или «Исправить маршрут» (либо запустите свободный проезд)."
      );
    } else {
      errors.push("Нужен хотя бы один свободный бокс, одна контрольная точка или дорога.");
    }
  }

  const seenIds = new Set<number>();
  for (const bay of def.bays) {
    if (seenIds.has(bay.id)) errors.push(`Повторяющийся номер бокса: №${bay.id}.`);
    seenIds.add(bay.id);
    if (!(bay.width >= 1.9 && bay.width <= 8)) {
      errors.push(`Бокс №${bay.id}: ширина должна быть 1.9–8 м (кузов ${CAR.width} м).`);
    }
    if (!(bay.length >= 4.4 && bay.length <= 12)) {
      errors.push(`Бокс №${bay.id}: длина должна быть 4.4–12 м (кузов ${CAR.length} м).`);
    }
    if (!inside(bay.cx, bay.cz)) {
      if (poly && (def.checkpoints.length > 0 || freeBays.some((fb) => inside(fb.cx, fb.cz)))) {
        warnings.push(
          `Бокс №${bay.id} оказался вне контура площадки — перенесите его внутрь или нажмите «✂ Обрезать по границе».`
        );
      } else {
        errors.push(`Бокс №${bay.id}: центр за границами карты.`);
      }
    }
  }

  const maxObstacleHalf = def.mapMeta || roads.length > 0 ? 200 : 60;
  for (const o of def.obstacles) {
    if (!(o.halfX > 0 && o.halfZ > 0 && o.halfX <= maxObstacleHalf && o.halfZ <= maxObstacleHalf)) {
      errors.push(`Препятствие «${o.label || o.id}»: неверные полуразмеры (0–${maxObstacleHalf} м).`);
    }
  }

  for (const r of roads) {
    if (!Array.isArray(r.points) || r.points.length < 2) {
      errors.push(`Дорога «${r.name || r.id}»: нужно минимум 2 узла.`);
    }
    if (!(r.width >= 2.5 && r.width <= 32)) {
      errors.push(`Дорога «${r.name || r.id}»: ширина должна быть от 2.5 до 32 м.`);
    }
  }

  for (const sn of signs) {
    if (!inside(sn.x, sn.z)) {
      warnings.push(`Знак «${sn.label || sn.id}» находится за границами карты.`);
    }
    if (sn.limitKmh !== undefined && !(sn.limitKmh >= 5 && sn.limitKmh <= 130)) {
      errors.push(`Знак «${sn.label || sn.id}»: ограничение скорости должно быть 5–130 км/ч.`);
    }
    if (sn.zoneRadius !== undefined && !(sn.zoneRadius >= 0 && sn.zoneRadius <= 250)) {
      errors.push(`Знак «${sn.label || sn.id}»: радиус зоны действия должен быть 0–250 м.`);
    }
  }

  for (const sg of signals) {
    if (!(sg.greenDuration >= 3 && sg.greenDuration <= 180 && sg.redDuration >= 3 && sg.redDuration <= 180)) {
      errors.push(`Светофор «${sg.id}»: длительность зелёной и красной фаз должна быть 3–180 с.`);
    }
    if (!(sg.stopLineWidth >= 1.5 && sg.stopLineWidth <= 24)) {
      errors.push(`Светофор «${sg.id}»: ширина стоп-линии должна быть 1.5–24 м.`);
    }
  }

  for (const cw of crosswalks) {
    if (!(cw.width >= 2 && cw.width <= 32 && cw.length >= 1.5 && cw.length <= 15)) {
      errors.push(`Переход «${cw.id}»: ширина 2–32 м, длина 1.5–15 м.`);
    }
  }

  const seenCp = new Set<string>();
  for (const cp of def.checkpoints) {
    if (seenCp.has(cp.id)) {
      errors.push(`Повторяющийся ID контрольной точки: «${cp.id}».`);
    }
    seenCp.add(cp.id);
    if (!(cp.radius > 0 && cp.radius <= 25)) {
      errors.push(`Точка «${cp.id}»: радиус должен быть 0–25 м.`);
    }
    if (!inside(cp.x, cp.z)) {
      errors.push(
        poly
          ? `Точка «${cp.id}» находится за пределами контура границы.`
          : `Точка «${cp.id}»: находится за границами мира.`
      );
    }
    if (cp.isFinalPark && freeBays.length === 0) {
      warnings.push(
        `Точка «${cp.id}» отмечена как финишная парковка, но свободных боксов нет — заезд завершится при проезде точки (или добавьте бокс P).`
      );
    }
  }

  // Предупреждения по геометрии (мир уже собирается, даже если есть замечания)
  try {
    const world = buildCustomWorld(def);
    const grid = new SpatialGrid(world.obstacles, 10);
    const startHit = grid.queryCarHit(def.start.x, def.start.z, def.start.h);
    if (startHit.hit) {
      warnings.push(`На старте контакт с: ${startHit.hit.label || startHit.hit.id}.`);
    }
    for (const bay of freeBays) {
      if (!isCarInsideBay(bay.cx, bay.cz, bay.h, bay)) {
        warnings.push(`Kia Ceed (${CAR.length}×${CAR.width} м) не помещается в бокс №${bay.id}.`);
        continue;
      }
      const hit = grid.queryCarHit(bay.cx, bay.cz, bay.h);
      if (hit.hit) {
        warnings.push(`В боксе №${bay.id} ложный контакт с: ${hit.hit.label || hit.hit.id}.`);
      }
    }
  } catch {
    warnings.push("Не удалось проверить геометрию: пересоберите сценарий из шаблона.");
  }

  return { errors, warnings };
}

function uniqueId(prefix: string, existingIds: Set<string>, startNum: number): string {
  let n = Math.max(1, startNum);
  while (existingIds.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export function nextBayId(def: CustomScenarioDef): number {
  return def.bays.reduce((m, b) => Math.max(m, b.id), 100) + 1;
}

export function nextObstacleId(def: CustomScenarioDef, kind: ObstacleKind): string {
  const ids = new Set(def.obstacles.map((o) => o.id));
  return uniqueId(`custom-${kind}`, ids, def.obstacles.length + 1);
}

export function nextSignId(def: CustomScenarioDef, kind: RoadSignKind): string {
  const list = def.signs ?? [];
  const ids = new Set(list.map((s) => s.id));
  return uniqueId(`sign-${kind}`, ids, list.length + 1);
}

export function nextSignalId(def: CustomScenarioDef): string {
  const list = def.signals ?? [];
  const ids = new Set(list.map((s) => s.id));
  return uniqueId("sig-custom", ids, list.length + 1);
}

export function nextCrosswalkId(def: CustomScenarioDef): string {
  const list = def.crosswalks ?? [];
  const ids = new Set(list.map((c) => c.id));
  return uniqueId("cw-custom", ids, list.length + 1);
}

export function nextRoadId(def: CustomScenarioDef): string {
  const list = def.roads ?? [];
  const ids = new Set(list.map((r) => r.id));
  return uniqueId("road-custom", ids, list.length + 1);
}

export function nextCheckpointId(def: CustomScenarioDef): string {
  const ids = new Set(def.checkpoints.map((c) => c.id));
  return uniqueId("cp-custom", ids, def.checkpoints.length + 1);
}

export function loadCustomScenario(): CustomScenarioDef {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return defaultCustomScenario();
    const parsed = JSON.parse(raw) as Partial<CustomScenarioDef>;
    if (!parsed || !Array.isArray(parsed.bays) || !Array.isArray(parsed.obstacles) || !parsed.start) {
      return defaultCustomScenario();
    }
    return normalizeCustomScenario(parsed);
  } catch {
    return defaultCustomScenario();
  }
}

export function saveCustomScenario(def: CustomScenarioDef): void {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(def));
  } catch {
    // хранилище заблокировано или исчерпана квота
  }
}
