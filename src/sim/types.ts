/**
 * @module sim/types
 * @layer pure-core
 * @role Единые контракты данных ядра симуляции (InputState, SimState, WorldData, SimEvent, CalibrationConfig).
 * @invariants #1 (координаты и знаки углов), #7 (без three/window/document), #10–11 (maxInnerWheelDeg).
 * @tests T01–T25 (используется всеми тестами ядра)
 *
 * Система координат и единицы измерения:
 * - Оси: `+Z` — вперёд (и север в проекции OSM), `+X` — левый борт (запад), `−X` — правый борт (восток).
 * - Курс `h` (рад): `0` смотрит вдоль `+Z`, `h > 0` — поворот влево (против часовой стрелки сверху).
 * - Единичные векторы кузова: `forward = (sin h, cos h)`, `left = (cos h, -sin h)`, `right = (-cos h, sin h)`.
 * - Угол руля `steerWheelDeg` / `swDeg` (°): `[-540, +540]`, `+` влево, `−` вправо.
 * - Дистанции и габариты — метры (`м`), скорость `v` — `м/с` (пороги знаков/АКПП — `км/ч`), время — секунды (`с`).
 */

/** P — Parking (стояночная блокировка АКПП), R/N/D — рабочие режимы, 1–3 — ручные ступени. */
export type Gear = "P" | "R" | "N" | "D" | "1" | "2" | "3";

export type TurnSignal = "left" | "right" | "hazard" | null;

export type CameraMode = "chase" | "cockpit" | "top" | "orbit";

export type QualityPreset = "low" | "medium" | "high";

export type InputState = {
  throttle: number; // 0..1
  /** Множитель тяги 1..2; отсутствует в старых реплеях и трактуется как 1. */
  throttleMultiplier?: number;
  brake: number; // 0..1
  steerWheelDeg: number; // -540..+540 (+ влево, - вправо)
  gear: Gear;
  engineOn: boolean;
  handbrake: boolean;
  belt: boolean;
  lights: boolean;
  signal: TurnSignal;
};

export type Vec2 = { x: number; z: number };

export type SimState = {
  tick: number;
  time: number; // с
  x: number; // м, центр задней/средней точки отсчёта (центр колёсной базы)
  z: number; // м
  h: number; // рад, + влево
  v: number; // м/с, + вперёд, - назад
  prevV: number; // м/с для продольного ускорения
  maxInnerWheelDeg: number; // действующий предел внутреннего колеса на этом тике
  steer: number; // рад, центральный угол передних колёс (+ влево)
  steerLeft: number; // рад, левое колесо (+X) по Аккерману
  steerRight: number; // рад, правое колесо (-X) по Аккерману
  swDeg: number; // град, -540..+540
  gear: Gear;
  prevGear: Gear;
  autoSubGear: number; // 1..5 в режиме D
  rpm: number; // 0 или 800..6500
  engineOn: boolean;
  handbrake: boolean;
  belt: boolean;
  lights: boolean;
  signal: TurnSignal;
  wheelSpin: number; // рад
  pitch: number; // рад, тангаж кузова
  roll: number; // рад, крен кузова
  // Состояние упражнения и детекторов ошибок
  collisions: number;
  inContact: boolean;
  inLineCross: boolean;
  activeBayId: number | null;
  holdTime: number; // с удержания полной остановки в боксе
  reverseCount: number; // сколько раз включалась R в зоне упражнения
  hasMoved: boolean;
  movedWithoutBeltFlagged: boolean;
  movedWithoutSignalFlagged: boolean;
  extraReverseFlagged: boolean;
  speedingCooldown: number;
  pedestrianCooldown: number;
  redLightPassedIds: string[];
  completedCheckpointIds: string[];
  currentCheckpointIndex: number;
  finished: boolean;
  finishedReason: "completed" | "immediate_fail" | "manual" | null;
  finishedBayId: number | null;
  neutralSecuredAfterFinish: boolean;
  distanceTraveled: number; // м
  statusText: string;
};

export type ObstacleKind =
  | "curb"
  | "parked_car"
  | "building"
  | "pole"
  | "cone"
  | "fence"
  | "tree"
  | "island";

/** Классы учебных дорожных знаков редактора и импорта OSM (нумерация ПДД РФ справочная). */
export type RoadSignKind =
  | "speed_limit" // 3.24 «Ограничение максимальной скорости»
  | "stop" // 2.5 «Движение без остановки запрещено»
  | "give_way" // 2.4 «Уступите дорогу»
  | "main_road" // 2.1 «Главная дорога»
  | "crosswalk" // 5.19 «Пешеходный переход»
  | "no_stopping" // 3.27 «Остановка запрещена»
  | "no_entry" // 3.1 «Въезд запрещён»
  | "parking" // 6.4 «Парковка (парковочное место)»
  | "ahead_only" // 4.1.1 «Движение прямо»
  | "turn_right" // 4.1.2 «Движение направо»
  | "turn_left" // 4.1.3 «Движение налево»
  | "living_zone"; // 5.21 «Жилая зона» (20 км/ч)

/** Дорожный знак на карте сценария (виден в 2D/3D; скоростные знаки создают SpeedZone). */
export type RoadSignDef = {
  id: string;
  kind: RoadSignKind;
  x: number;
  z: number;
  /** Курс потока, для которого установлен знак (рад, 0 = движение вдоль +Z, + влево). */
  h: number;
  label?: string;
  /** Значение ограничения скорости (км/ч) для speed_limit и living_zone. */
  limitKmh?: number;
  /** Длина участка ограничения вперёд от знака (м). */
  zoneLength?: number;
  /** Устаревшие поля старых сценариев; zoneRadius мигрирует в zoneLength. */
  zoneRadius?: number;
  zoneX?: number;
  zoneZ?: number;
};

export type ParkedModelKey = "picanto" | "rio" | "ceed" | "xceed" | "sorento";

export type ObstacleBox = {
  id: string;
  kind: ObstacleKind;
  cx: number;
  cz: number;
  halfX: number; // полуширина (вдоль локальной +X)
  halfZ: number; // полудлина (вдоль локальной +Z)
  h: number; // рад
  height: number; // м
  color?: number;
  model?: ParkedModelKey;
  label?: string;
};

export type ParkingBayKind = "perpendicular" | "parallel";

export type ParkingBay = {
  id: number;
  label: string;
  kind: ParkingBayKind;
  cx: number;
  cz: number;
  width: number; // размер поперёк машины (м)
  length: number; // размер вдоль машины (м)
  h: number; // ориентация бокса (0 => длина вдоль Z, PI/2 => длина вдоль X)
  openSide: "front" | "back" | "left"; // откуда разрешён заезд без пересечения сплошной линии
  occupied: boolean;
  parkedModel?: ParkedModelKey;
  parkedColor?: number;
  requireReverseEntry?: boolean;
};

export type TrafficLightPhase = "green" | "green_blink" | "yellow" | "red" | "red_yellow";

export type TrafficSignalDef = {
  id: string;
  x: number;
  z: number;
  h: number; // направление движения потока, который регулирует этот светофор
  stopLineX: number;
  stopLineZ: number;
  stopLineWidth: number;
  cycleOffset: number; // с
  greenDuration: number; // с
  redDuration: number; // с
};

export type SpeedZone = {
  id: string;
  x: number;
  z: number;
  signX: number;
  signZ: number;
  h?: number;
  length?: number;
  endDistance?: number;
  halfWidth?: number;
  radius?: number;
  limitKmh: number;
  label: string;
};

export type CrosswalkDef = {
  id: string;
  cx: number;
  cz: number;
  width: number; // ширина дороги (ход пешехода)
  length: number; // длина зебры вдоль дороги
  h: number; // направление дороги
  pedSpeed: number;
  pedPhaseOffset: number;
};

export type PedestrianPose = {
  crosswalkId: string;
  x: number;
  z: number;
  h: number;
  onRoadway: boolean;
  walkPhase: number;
};

export type RouteCheckpoint = {
  id: string;
  x: number;
  z: number;
  radius: number;
  instruction: string;
  requireSignal?: "left" | "right";
  requireStop?: boolean;
  isFinalPark?: boolean;
};

export type RoadSegment = {
  id: string;
  points: Vec2[];
  width: number;
  lanes: number;
  highway: string;
  name?: string;
  hasSolidCenter?: boolean;
  speedLimitKmh?: number;
  /** Радиус скругления углов осевой линии дороги, м; 0/undefined — острые углы. */
  cornerRadiusM?: number;
  /** Высотный уровень OSM: положительное значение — эстакада/мост, отрицательное — тоннель. */
  layer?: number;
  /** Одностороннее движение по ходу points (включая развёрнутые oneway=-1). */
  oneway?: boolean;
  /** Круговое движение OSM (junction=roundabout|circular). */
  roundabout?: boolean;
  /** Подтип сервисного проезда OSM (driveway, parking_aisle, alley и др.). */
  service?: string;
};

export type ScenarioId = "bay_90" | "parallel_v2" | "city_osm" | "custom";

export type CalibrationConfig = {
  /** Предел внутреннего переднего колеса, градусы. Старые записи без поля используют 35°. */
  maxInnerWheelDeg?: number;
  perpBayWidth: number; // по умолчанию 2.5 м (предварительно)
  perpBayLength: number; // 5.3 м в v8 / 5.5 м в README
  aisleWidth: number; // 6.0 м (предварительно)
  parBayLength: number; // 6.0 м (порт из v2, предварительно)
  parBayWidth: number; // 2.2 м (порт из v2, предварительно)
  holdDurationSec: number; // 1.5 с
  maxParkSpeedKmh: number; // рекомендуемый порог скорости при парковке
  showLearnerSign: boolean; // табличка «У» на крыше
};

export type SimEventCode =
  | "collision"
  | "line_cross"
  | "red_light_run"
  | "stop_line_cross"
  | "pedestrian_yield"
  | "speed_limit"
  | "belt_unfastened"
  | "extra_reverse"
  | "neutral_after_stop"
  | "no_turn_signal"
  | "harsh_brake"
  | "park_overspeed";

export type SimEvent = {
  id: string;
  code: SimEventCode;
  tick: number;
  time: number;
  x: number;
  z: number;
  h: number;
  speedKmh: number;
  detail: string;
};

export type MapPackMeta = {
  id: string;
  title: string;
  source: string;
  attribution: string;
  license: string;
  extractedAt: string;
  bbox: [number, number, number, number];
  roadsCount: number;
  buildingsCount: number;
  signalsCount: number;
  signsCount?: number;
  /** Начало локальной метрической проекции WGS84 для точного повторного импорта. */
  origin?: { lat: number; lon: number };
  /** Количество распознанных односторонних участков (включая кольца). */
  onewayRoadsCount?: number;
  /** Число автоматически устранённых конфликтов геометрии/дорог. */
  resolvedConflictsCount?: number;
  /** Сводка устранённых конфликтов импорта для инструктора. */
  conflictNotes?: string[];
};

export type WorldBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

export type WorldData = {
  scenarioId: ScenarioId;
  title: string;
  subtitle: string;
  examinerBrief: string;
  start: { x: number; z: number; h: number };
  bays: ParkingBay[];
  obstacles: ObstacleBox[];
  roads: RoadSegment[];
  /** Дорожные знаки редактора и импорта OSM (опционально для совместимости со старыми записями). */
  signs?: RoadSignDef[];
  signals: TrafficSignalDef[];
  speedZones: SpeedZone[];
  crosswalks: CrosswalkDef[];
  checkpoints: RouteCheckpoint[];
  defaultSpeedLimitKmh: number;
  mapMeta?: MapPackMeta;
  /**
   * Мир нельзя восстановить по номеру сценария и калибровке (свой сценарий, импортированная
   * карта OSM) — его снимок сохраняется в попытке, иначе реплей шёл бы по другому миру.
   */
  embedInAttempt?: boolean;
  bounds: WorldBounds;
  /** Произвольный контур границы рабочей области мира (необязательно). */
  boundaryPolygon?: Vec2[];
  /** Контур асфальтовой площадки автодрома (необязательно). */
  lotPolygon?: Vec2[];
};
