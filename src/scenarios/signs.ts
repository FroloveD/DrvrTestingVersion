/**
 * @module scenarios/signs
 * @layer pure-core
 * @role Каталог дорожных знаков и классов препятствий редактора карт, фабрики по умолчанию, связь с SpeedZone и КТ маршрута.
 * @invariants #1 (координаты и курс h), #7 (чистое ядро без three и DOM), #16 (справочные коды ПДД, без новых неподписанных штрафов).
 * @tests T28, T29
 */
import type {
  CrosswalkDef,
  ObstacleBox,
  ObstacleKind,
  ParkedModelKey,
  RoadSegment,
  RoadSignDef,
  RoadSignKind,
  RouteCheckpoint,
  SpeedZone,
  TrafficSignalDef,
} from "../sim/types";
import { VEHICLE_DIMS } from "../sim/vehicle";

export type RoadSignShape = "circle" | "octagon" | "triangle_down" | "diamond" | "square" | "rect";

export type RoadSignSpec = {
  kind: RoadSignKind;
  /** Справочный номер знака ПДД РФ (только учебная ориентация, не экзамен ГИБДД). */
  code: string;
  title: string;
  shortLabel: string;
  shape: RoadSignShape;
  bgColor: string;
  borderColor: string;
  textColor: string;
  defaultLimitKmh?: number;
  defaultZoneLength?: number;
  /** Описание того, как знак влияет на симуляцию. */
  effectNote: string;
  /** Можно ли в один клик создать связанную контрольную точку маршрута. */
  checkpointPreset?: {
    requireStop?: boolean;
    requireSignal?: "left" | "right";
    instruction: string;
    radius: number;
  };
};

/** Полный учебный каталог дорожных знаков редактора и офлайн-импорта OSM. */
export const ROAD_SIGN_CATALOG: readonly RoadSignSpec[] = [
  {
    kind: "speed_limit",
    code: "3.24",
    title: "Ограничение скорости",
    shortLabel: "40",
    shape: "circle",
    bgColor: "#f8fafc",
    borderColor: "#dc2626",
    textColor: "#0f172a",
    defaultLimitKmh: 40,
    defaultZoneLength: 250,
    effectNote: "Ограничение действует по отрезку от знака до заданной длины или ближайшего перекрёстка.",
    checkpointPreset: {
      instruction: "Снизьте скорость по знаку ограничения и продолжайте движение.",
      radius: 7,
    },
  },
  {
    kind: "stop",
    code: "2.5",
    title: "Движение без остановки запрещено (STOP)",
    shortLabel: "STOP",
    shape: "octagon",
    bgColor: "#dc2626",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак; при привязке к КТ маршрута требует полной остановки автомобиля.",
    checkpointPreset: {
      requireStop: true,
      instruction: "Выполните полную остановку у знака 2.5 «STOP», убедитесь в безопасности и продолжайте движение.",
      radius: 5.5,
    },
  },
  {
    kind: "give_way",
    code: "2.4",
    title: "Уступите дорогу",
    shortLabel: "▽",
    shape: "triangle_down",
    bgColor: "#f8fafc",
    borderColor: "#dc2626",
    textColor: "#dc2626",
    effectNote: "2D/3D-ориентир приоритета перед перекрёстком; можно связать с КТ маршрута.",
    checkpointPreset: {
      instruction: "Приближаясь к знаку 2.4 «Уступите дорогу», снизьте скорость и оцените обстановку.",
      radius: 6.5,
    },
  },
  {
    kind: "main_road",
    code: "2.1",
    title: "Главная дорога",
    shortLabel: "◆",
    shape: "diamond",
    bgColor: "#facc15",
    borderColor: "#f8fafc",
    textColor: "#0f172a",
    effectNote: "2D/3D-знак приоритета на главной улице участка.",
  },
  {
    kind: "crosswalk",
    code: "5.19",
    title: "Пешеходный переход",
    shortLabel: "ПЕШ",
    shape: "square",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак перехода; в паре с объектом «Переход (зебра)» включает уступление пешеходу.",
    checkpointPreset: {
      instruction: "Проедьте зону знака 5.19 «Пешеходный переход», уступив дорогу пешеходам.",
      radius: 7,
    },
  },
  {
    kind: "no_stopping",
    code: "3.27",
    title: "Остановка запрещена",
    shortLabel: "✕",
    shape: "circle",
    bgColor: "#1d4ed8",
    borderColor: "#dc2626",
    textColor: "#ef4444",
    effectNote: "2D/3D-ориентир для выбора разрешённого места остановки с инструктором.",
  },
  {
    kind: "no_entry",
    code: "3.1",
    title: "Въезд запрещён («кирпич»)",
    shortLabel: "—",
    shape: "circle",
    bgColor: "#dc2626",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак запрета въезда на встречный проезд или закрытую территорию.",
  },
  {
    kind: "parking",
    code: "6.4",
    title: "Парковка (P)",
    shortLabel: "P",
    shape: "square",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак обозначения парковочных боксов и карманов.",
  },
  {
    kind: "ahead_only",
    code: "4.1.1",
    title: "Движение прямо",
    shortLabel: "↑",
    shape: "circle",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-предписывающий знак; можно связать с КТ проезда перекрёстка прямо.",
    checkpointPreset: {
      instruction: "По знаку 4.1.1 «Движение прямо» продолжите движение прямо через перекрёсток.",
      radius: 7,
    },
  },
  {
    kind: "turn_right",
    code: "4.1.2",
    title: "Движение направо",
    shortLabel: "→",
    shape: "circle",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак; при привязке к КТ проверяет включённый правый поворотник (E).",
    checkpointPreset: {
      requireSignal: "right",
      instruction: "Включите правый поворотник (E) и выполните поворот направо по знаку 4.1.2.",
      radius: 7,
    },
  },
  {
    kind: "turn_left",
    code: "4.1.3",
    title: "Движение налево",
    shortLabel: "←",
    shape: "circle",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    effectNote: "2D/3D-знак; при привязке к КТ проверяет включённый левый поворотник (Q).",
    checkpointPreset: {
      requireSignal: "left",
      instruction: "Включите левый поворотник (Q) и выполните поворот налево по знаку 4.1.3.",
      radius: 7,
    },
  },
  {
    kind: "living_zone",
    code: "5.21",
    title: "Жилая зона (20 км/ч)",
    shortLabel: "20",
    shape: "rect",
    bgColor: "#2563eb",
    borderColor: "#f8fafc",
    textColor: "#ffffff",
    defaultLimitKmh: 20,
    defaultZoneLength: 250,
    effectNote: "Ограничение действует по отрезку от знака до заданной длины или ближайшего перекрёстка.",
    checkpointPreset: {
      instruction: "Въезд в жилую зону (знак 5.21): соблюдайте скорость не более 20 км/ч.",
      radius: 7,
    },
  },
];

const SIGN_BY_KIND = new Map<RoadSignKind, RoadSignSpec>(ROAD_SIGN_CATALOG.map((s) => [s.kind, s]));

export function getRoadSignSpec(kind: RoadSignKind): RoadSignSpec {
  return SIGN_BY_KIND.get(kind) ?? ROAD_SIGN_CATALOG[0];
}

export function isSpeedSignKind(kind: RoadSignKind): boolean {
  return kind === "speed_limit" || kind === "living_zone";
}

export function formatSignBadge(sign: RoadSignDef): string {
  if (sign.kind === "speed_limit") return String(sign.limitKmh ?? 40);
  if (sign.kind === "living_zone") return sign.limitKmh ? `ЖЗ ${sign.limitKmh}` : "ЖЗ";
  return getRoadSignSpec(sign.kind).shortLabel;
}

/** Создаёт дорожный знак с осмысленными параметрами по умолчанию. */
export function createDefaultSign(
  id: string,
  kind: RoadSignKind,
  x: number,
  z: number,
  h = 0,
  limitOverride?: number
): RoadSignDef {
  const spec = getRoadSignSpec(kind);
  const rx = Number(x.toFixed(2));
  const rz = Number(z.toFixed(2));
  const rh = Number(h.toFixed(3));
  if (isSpeedSignKind(kind)) {
    const limitKmh = limitOverride ?? spec.defaultLimitKmh ?? 40;
    const zoneLength = spec.defaultZoneLength ?? 250;
    const zx = Number((rx + Math.cos(rh) * 3.2).toFixed(2));
    const zz = Number((rz - Math.sin(rh) * 3.2).toFixed(2));
    return {
      id,
      kind,
      x: rx,
      z: rz,
      h: rh,
      limitKmh,
      zoneLength,
      zoneX: zx,
      zoneZ: zz,
      label:
        kind === "living_zone"
          ? `Знак ${spec.code} «Жилая зона» (${limitKmh} км/ч)`
          : `Знак ${spec.code} «${limitKmh} км/ч»`,
    };
  }
  return {
    id,
    kind,
    x: rx,
    z: rz,
    h: rh,
    label: `Знак ${spec.code} «${spec.title}»`,
  };
}

/** Префикс ID SpeedZone, порождённой дорожным знаком редактора (исключает дубль стойки в 3D). */
export const SIGN_SPEED_ZONE_PREFIX = "sz-sign-";

/** Конвертирует скоростной знак в активную SpeedZone ядра (null — если знак не ограничивает скорость). */
export function signToSpeedZone(sign: RoadSignDef, roads: readonly RoadSegment[] = []): SpeedZone | null {
  if (!isSpeedSignKind(sign.kind)) return null;
  const length = sign.zoneLength ?? sign.zoneRadius ?? 250;
  const limitKmh = sign.limitKmh ?? (sign.kind === "living_zone" ? 20 : 40);
  if (!(length > 0) || !(limitKmh > 0)) return null;
  const h = sign.h;
  const x = Number((sign.x + Math.cos(h) * 3.2).toFixed(2));
  const z = Number((sign.z - Math.sin(h) * 3.2).toFixed(2));
  const rx = Math.sin(h), rz = Math.cos(h);
  let endDistance = length;
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      const sx = b.x - a.x, sz = b.z - a.z;
      const segmentLength = Math.hypot(sx, sz);
      const denom = rx * sz - rz * sx;
      if (segmentLength < 0.01 || Math.abs(denom) < segmentLength * 0.12) continue;
      const qx = a.x - x, qz = a.z - z;
      const along = (qx * sz - qz * sx) / denom;
      const across = (qx * rz - qz * rx) / denom;
      if (along > 2.5 && along < endDistance && across >= -0.0001 && across <= 1.0001) endDistance = along;
    }
  }
  return {
    id: `${SIGN_SPEED_ZONE_PREFIX}${sign.id}`,
    x,
    z,
    signX: sign.x,
    signZ: sign.z,
    h,
    length,
    endDistance,
    halfWidth: 4.5,
    limitKmh,
    label: sign.label || `Знак «${limitKmh} км/ч»`,
  };
}

/** Строит связанную контрольную точку маршрута на проезжей части рядом со знаком. */
export function buildCheckpointForSign(sign: RoadSignDef, checkpointId: string): RouteCheckpoint {
  const spec = getRoadSignSpec(sign.kind);
  // Знак обычно стоит справа от полосы — смещаем КТ на ~2.6 м влево (+left = (cos h, -sin h))
  const x = Number((sign.x + Math.cos(sign.h) * 2.6).toFixed(2));
  const z = Number((sign.z - Math.sin(sign.h) * 2.6).toFixed(2));
  const preset = spec.checkpointPreset;
  const instruction =
    sign.kind === "speed_limit"
      ? `Соблюдайте знак 3.24 «${sign.limitKmh ?? 40} км/ч» на участке.`
      : preset?.instruction ?? `Проедьте участок у знака ${spec.code} «${spec.title}».`;
  return {
    id: checkpointId,
    x,
    z,
    radius: preset?.radius ?? 6.5,
    instruction,
    ...(preset?.requireStop ? { requireStop: true } : {}),
    ...(preset?.requireSignal ? { requireSignal: preset.requireSignal } : {}),
  };
}

export type ObstacleSpec = {
  kind: ObstacleKind;
  title: string;
  halfX: number;
  halfZ: number;
  height: number;
  color: number;
  mapFill: string;
  mapStroke: string;
  defaultLabel: string;
};

/** Каталог всех классов статических препятствий и объектов окружения редактора. */
export const OBSTACLE_CATALOG: readonly ObstacleSpec[] = [
  {
    kind: "curb",
    title: "Бордюр",
    halfX: 2.5,
    halfZ: 0.18,
    height: 0.16,
    color: 0x9aa6b2,
    mapFill: "#94a3b8",
    mapStroke: "#cbd5e1",
    defaultLabel: "бордюр",
  },
  {
    kind: "cone",
    title: "Конус",
    halfX: 0.16,
    halfZ: 0.16,
    height: 0.55,
    color: 0xf97316,
    mapFill: "#f97316",
    mapStroke: "#fed7aa",
    defaultLabel: "разметочный конус",
  },
  {
    kind: "pole",
    title: "Столб / опора",
    halfX: 0.2,
    halfZ: 0.2,
    height: 3.2,
    color: 0x94a3b8,
    mapFill: "#cbd5e1",
    mapStroke: "#f8fafc",
    defaultLabel: "опора освещения",
  },
  {
    kind: "fence",
    title: "Ограждение / забор",
    halfX: 3.0,
    halfZ: 0.12,
    height: 1.15,
    color: 0x64748b,
    mapFill: "#64748b",
    mapStroke: "#e2e8f0",
    defaultLabel: "дорожное ограждение",
  },
  {
    kind: "tree",
    title: "Дерево",
    halfX: 0.45,
    halfZ: 0.45,
    height: 4.2,
    color: 0x2f6a44,
    mapFill: "#2f855a",
    mapStroke: "#68d391",
    defaultLabel: "дерево",
  },
  {
    kind: "island",
    title: "Островок / газон",
    halfX: 1.4,
    halfZ: 3.2,
    height: 0.2,
    color: 0x3b6e4c,
    mapFill: "#2d5a3f",
    mapStroke: "#94a3b8",
    defaultLabel: "островок безопасности",
  },
  {
    kind: "building",
    title: "Здание",
    halfX: 4.5,
    halfZ: 6.0,
    height: 9.6,
    color: 0x52616f,
    mapFill: "#334155",
    mapStroke: "#64748b",
    defaultLabel: "здание",
  },
  {
    kind: "parked_car",
    title: "Припаркованный авто",
    halfX: VEHICLE_DIMS.rio.width / 2,
    halfZ: VEHICLE_DIMS.rio.length / 2,
    height: VEHICLE_DIMS.rio.height,
    color: 0x3b82f6,
    mapFill: "#3b82f6",
    mapStroke: "#93c5fd",
    defaultLabel: "припаркованный авто",
  },
];

const OBS_BY_KIND = new Map<ObstacleKind, ObstacleSpec>(OBSTACLE_CATALOG.map((o) => [o.kind, o]));

export function getObstacleSpec(kind: ObstacleKind): ObstacleSpec {
  return OBS_BY_KIND.get(kind) ?? OBSTACLE_CATALOG[0];
}

export function createDefaultObstacle(
  id: string,
  kind: ObstacleKind,
  x: number,
  z: number,
  h = 0,
  model: ParkedModelKey = "rio"
): ObstacleBox {
  const spec = getObstacleSpec(kind);
  if (kind === "parked_car") {
    const dim = VEHICLE_DIMS[model];
    return {
      id,
      kind,
      cx: Number(x.toFixed(2)),
      cz: Number(z.toFixed(2)),
      halfX: Number((dim.width / 2).toFixed(2)),
      halfZ: Number((dim.length / 2).toFixed(2)),
      h: Number(h.toFixed(3)),
      height: dim.height,
      color: spec.color,
      model,
      label: spec.defaultLabel,
    };
  }
  return {
    id,
    kind,
    cx: Number(x.toFixed(2)),
    cz: Number(z.toFixed(2)),
    halfX: spec.halfX,
    halfZ: spec.halfZ,
    h: Number(h.toFixed(3)),
    height: spec.height,
    color: spec.color,
    label: spec.defaultLabel,
  };
}

export function createDefaultSignal(id: string, x: number, z: number, h = 0): TrafficSignalDef {
  const rx = Number(x.toFixed(2));
  const rz = Number(z.toFixed(2));
  const rh = Number(h.toFixed(3));
  // Стоп-линия по умолчанию на 2.2 м левее стойки (на полосе) и на 1.5 м раньше по ходу
  const stopLineX = Number((rx + Math.cos(rh) * 2.2 - Math.sin(rh) * 1.5).toFixed(2));
  const stopLineZ = Number((rz - Math.sin(rh) * 2.2 - Math.cos(rh) * 1.5).toFixed(2));
  return {
    id,
    x: rx,
    z: rz,
    h: rh,
    stopLineX,
    stopLineZ,
    stopLineWidth: 4.4,
    cycleOffset: 0,
    greenDuration: 14,
    redDuration: 11,
  };
}

export function createDefaultCrosswalk(id: string, cx: number, cz: number, h = 0): CrosswalkDef {
  return {
    id,
    cx: Number(cx.toFixed(2)),
    cz: Number(cz.toFixed(2)),
    width: 8.0,
    length: 3.6,
    h: Number(h.toFixed(3)),
    pedSpeed: 1.3,
    pedPhaseOffset: 0,
  };
}

export function createDefaultRoad(id: string, cx: number, cz: number, h = 0): RoadSegment {
  const halfLen = 14;
  const dx = Math.sin(h) * halfLen;
  const dz = Math.cos(h) * halfLen;
  return {
    id,
    points: [
      { x: Number((cx - dx).toFixed(2)), z: Number((cz - dz).toFixed(2)) },
      { x: Number((cx + dx).toFixed(2)), z: Number((cz + dz).toFixed(2)) },
    ],
    width: 7.5,
    lanes: 2,
    highway: "residential",
    name: "Новая улица",
    hasSolidCenter: false,
    speedLimitKmh: 40,
  };
}
