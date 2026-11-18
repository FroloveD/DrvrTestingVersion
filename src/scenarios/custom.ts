import { isCarInsideBay, SpatialGrid } from "../sim/spatialGrid";
import type {
  ObstacleBox,
  ObstacleKind,
  ParkedModelKey,
  ParkingBay,
  RouteCheckpoint,
  WorldData,
} from "../sim/types";
import { CAR, VEHICLE_DIMS } from "../sim/vehicle";

/** Пользовательский сценарий инструктора — хранится как данные, без правки кода. */
export type CustomScenarioDef = {
  version: 1;
  title: string;
  subtitle: string;
  brief: string;
  start: { x: number; z: number; h: number };
  defaultSpeedLimitKmh: number;
  lotHalfX: number; // полуразмер асфальтовой площадки по X
  lotHalfZ: number; // полуразмер асфальтовой площадки по Z
  bays: ParkingBay[];
  obstacles: ObstacleBox[]; // припаркованные авто в занятых боксах достраиваются автоматически
  checkpoints: RouteCheckpoint[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export const CUSTOM_STORAGE_KEY = "cdt.customScenario.v1";

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
    checkpoints: [],
    bounds: { minX: -22, maxX: 22, minZ: -18, maxZ: 18 },
  };
}

/** Клонирует готовый мир (бокс 90° / параллельная) в редактируемый свой сценарий. */
export function customFromWorld(world: WorldData, title: string): CustomScenarioDef {
  const lotHalfX = Math.max(8, (world.bounds.maxX - world.bounds.minX) / 2 - 4);
  const lotHalfZ = Math.max(8, (world.bounds.maxZ - world.bounds.minZ) / 2 - 4);
  return {
    version: 1,
    title,
    subtitle: `Копия: ${world.title}`,
    brief: world.examinerBrief,
    start: { ...world.start },
    defaultSpeedLimitKmh: world.defaultSpeedLimitKmh,
    lotHalfX: Number(lotHalfX.toFixed(1)),
    lotHalfZ: Number(lotHalfZ.toFixed(1)),
    bays: world.bays.map((b) => ({ ...b })),
    // Припаркованные авто в занятых боксах пересоздадутся в buildCustomWorld
    obstacles: world.obstacles
      .filter((o) => !(o.kind === "parked_car" && o.id.startsWith("parked-bay-")))
      .map((o) => ({ ...o })),
    checkpoints: world.checkpoints.map((c) => ({ ...c })),
    bounds: { ...world.bounds },
  };
}

/** Строит WorldData из пользовательского определения (детерминированно). */
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

  const freeCount = def.bays.filter((b) => !b.occupied).length;
  return {
    scenarioId: "custom",
    title: def.title.trim() || "Свой сценарий",
    subtitle:
      def.subtitle.trim() ||
      (def.checkpoints.length > 0
        ? `Точек маршрута: ${def.checkpoints.length} · свободных мест: ${freeCount}`
        : `Свободных мест: ${freeCount} из ${def.bays.length}`),
    examinerBrief: def.brief.trim() || "Выполните упражнение: припаркуйтесь в свободный бокс.",
    start: { ...def.start },
    bays: def.bays.map((b) => ({ ...b })),
    obstacles,
    roads: [
      {
        id: "custom-lot",
        points: [
          { x: -def.lotHalfX, z: 0 },
          { x: def.lotHalfX, z: 0 },
        ],
        width: def.lotHalfZ * 2,
        lanes: 1,
        highway: "service",
        name: "Своя площадка",
      },
    ],
    signals: [],
    speedZones: [],
    crosswalks: [],
    checkpoints: def.checkpoints.map((c) => ({ ...c })),
    defaultSpeedLimitKmh: def.defaultSpeedLimitKmh,
    embedInAttempt: true,
    bounds: { ...def.bounds },
  };
}

export type CustomValidation = { errors: string[]; warnings: string[] };

function insideBounds(
  x: number,
  z: number,
  bounds: CustomScenarioDef["bounds"]
): boolean {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

/**
 * Проверка своего сценария: errors блокируют заезд, warnings — подсказки инструктору.
 * Использует те же геометрические проверки, что и ядро (isCarInsideBay, SpatialGrid).
 */
export function validateCustomScenario(def: CustomScenarioDef): CustomValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!def.title.trim()) errors.push("Укажите название сценария.");
  if (!Number.isFinite(def.lotHalfX) || def.lotHalfX < 5 || def.lotHalfX > 120) {
    errors.push("Полуразмер площадки по X должен быть от 5 до 120 м.");
  }
  if (!Number.isFinite(def.lotHalfZ) || def.lotHalfZ < 5 || def.lotHalfZ > 120) {
    errors.push("Полуразмер площадки по Z должен быть от 5 до 120 м.");
  }
  if (def.bounds.minX >= def.bounds.maxX || def.bounds.minZ >= def.bounds.maxZ) {
    errors.push("Границы мира заданы неверно: min должен быть меньше max.");
  }
  if (!insideBounds(def.start.x, def.start.z, def.bounds)) {
    errors.push("Стартовая позиция находится за границами мира.");
  }

  const freeBays = def.bays.filter((b) => !b.occupied);
  if (freeBays.length === 0 && def.checkpoints.length === 0) {
    errors.push("Нужен хотя бы один свободный бокс или одна контрольная точка маршрута.");
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
    if (!insideBounds(bay.cx, bay.cz, def.bounds)) {
      errors.push(`Бокс №${bay.id}: центр за границами мира.`);
    }
  }

  for (const o of def.obstacles) {
    if (!(o.halfX > 0 && o.halfZ > 0 && o.halfX <= 60 && o.halfZ <= 60)) {
      errors.push(`Препятствие «${o.label || o.id}»: неверные полуразмеры (0–60 м).`);
    }
  }

  for (const cp of def.checkpoints) {
    if (!(cp.radius > 0 && cp.radius <= 15)) {
      errors.push(`Точка «${cp.id}»: радиус должен быть 0–15 м.`);
    }
    if (!insideBounds(cp.x, cp.z, def.bounds)) {
      errors.push(`Точка «${cp.id}»: находится за границами мира.`);
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

export function nextBayId(def: CustomScenarioDef): number {
  return def.bays.reduce((m, b) => Math.max(m, b.id), 100) + 1;
}

export function nextObstacleId(def: CustomScenarioDef, kind: ObstacleKind): string {
  return `custom-${kind}-${def.obstacles.length + 1}-${Date.now().toString(36).slice(-4)}`;
}

export function nextCheckpointId(def: CustomScenarioDef): string {
  return `cp-custom-${def.checkpoints.length + 1}`;
}

export function loadCustomScenario(): CustomScenarioDef {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return defaultCustomScenario();
    const parsed = JSON.parse(raw) as Partial<CustomScenarioDef>;
    if (!parsed || !Array.isArray(parsed.bays) || !Array.isArray(parsed.obstacles) || !parsed.start) {
      return defaultCustomScenario();
    }
    return { ...defaultCustomScenario(), ...parsed, version: 1 };
  } catch {
    return defaultCustomScenario();
  }
}

export function saveCustomScenario(def: CustomScenarioDef): void {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(def));
  } catch {
    // storage blocked / quota
  }
}
