/**
 * @module scenarios/editorOps
 * @layer pure-core
 * @role Чистые операции 2D-редактора карт: размещение, перенос с привязкой к сетке, поворот, узлы дорог, дублирование, удаление, автомаршрут и Undo/Redo.
 * @invariants #1 (координаты +Z север, +X лево, +h влево), #7 (чистое ядро без DOM и three).
 * @tests T29
 */
import { boundsToPolygon, boundingBoxOfPolygon, buildPresetBoundaryPolygon, clampPointToWorldBoundary, insertBoundaryVertex, isValidBoundaryPolygon, removeBoundaryVertex, sanitizeBoundaryPolygon, type BoundaryShapePreset } from "../maps/boundary";
import { buildRouteFromRoads } from "../maps/route";
import type {
  CalibrationConfig,
  ObstacleKind,
  ParkedModelKey,
  ParkingBay,
  ParkingBayKind,
  RoadSignKind,
  Vec2,
} from "../sim/types";
import {
  nextBayId,
  nextCheckpointId,
  nextCrosswalkId,
  nextObstacleId,
  nextRoadId,
  nextSignId,
  nextSignalId,
  type CustomScenarioDef,
} from "./custom";
import {
  buildCheckpointForSign,
  createDefaultCrosswalk,
  createDefaultObstacle,
  createDefaultRoad,
  createDefaultSign,
  createDefaultSignal,
} from "./signs";

/** Инструменты палитры 2D-редактора карт. */
export type EditorTool =
  | "select"
  | "pan"
  | "boundary"
  | "start"
  | "sign"
  | "signal"
  | "crosswalk"
  | "road"
  | "bay"
  | "obstacle"
  | "checkpoint";

/** Выбранный объект или под-ручка на холсте редактора. */
export type EditorSelection =
  | { kind: "start" }
  | { kind: "sign"; id: string }
  | { kind: "sign_zone"; id: string }
  | { kind: "signal"; id: string }
  | { kind: "signal_stopline"; id: string }
  | { kind: "crosswalk"; id: string }
  | { kind: "road"; id: string }
  | { kind: "road_point"; id: string; index: number }
  | { kind: "bay"; id: number }
  | { kind: "obstacle"; id: string }
  | { kind: "checkpoint"; id: string }
  | { kind: "boundary_point"; index: number };

export type PlaceOptions = {
  signKind: RoadSignKind;
  signSpeedLimit: number;
  obstacleKind: ObstacleKind;
  parkedModel: ParkedModelKey;
  bayKind: ParkingBayKind;
  calibration: Pick<CalibrationConfig, "perpBayWidth" | "perpBayLength" | "parBayWidth" | "parBayLength">;
  headingRad?: number;
  snapStep?: number;
  roadWidth?: number;
  cornerRadiusM?: number;
};

const round2 = (v: number): number => Number(v.toFixed(2));

/** Нормализует угол в диапазон `(-PI, +PI]`. */
export function normalizeAngleRad(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return Number(a.toFixed(4));
}

/** Привязывает координату к шагу сетки (`step <= 0` отключает привязку). */
export function snapCoord(value: number, step: number): number {
  if (!(step > 0)) return round2(value);
  return round2(Math.round(value / step) * step);
}

/** Возвращает опорную точку и угол выбранного объекта (для ручек переноса и поворота). */
export function getSelectionAnchor(
  def: CustomScenarioDef,
  sel: EditorSelection | null
): { x: number; z: number; h: number | null; label: string } | null {
  if (!sel) return null;
  switch (sel.kind) {
    case "start":
      return { x: def.start.x, z: def.start.z, h: def.start.h, label: "Старт автомобиля" };
    case "boundary_point": {
      const p = def.boundaryPolygon?.[sel.index];
      return p ? { x: p.x, z: p.z, h: null, label: `Граница · вершина #${sel.index + 1}` } : null;
    }
    case "sign": {
      const sn = (def.signs ?? []).find((s) => s.id === sel.id);
      return sn ? { x: sn.x, z: sn.z, h: sn.h, label: sn.label || sn.id } : null;
    }
    case "sign_zone": {
      const sn = (def.signs ?? []).find((s) => s.id === sel.id);
      if (!sn) return null;
      const h = sn.h;
      const startX = sn.x + Math.cos(h) * 3.2;
      const startZ = sn.z - Math.sin(h) * 3.2;
      const length = sn.zoneLength ?? sn.zoneRadius ?? 250;
      return { x: startX + Math.sin(h) * length, z: startZ + Math.cos(h) * length, h: null, label: `Конец участка знака «${sn.label || sn.id}»` };
    }
    case "signal": {
      const sg = (def.signals ?? []).find((s) => s.id === sel.id);
      return sg ? { x: sg.x, z: sg.z, h: sg.h, label: `Светофор ${sg.id}` } : null;
    }
    case "signal_stopline": {
      const sg = (def.signals ?? []).find((s) => s.id === sel.id);
      return sg ? { x: sg.stopLineX, z: sg.stopLineZ, h: sg.h, label: `Стоп-линия ${sg.id}` } : null;
    }
    case "crosswalk": {
      const cw = (def.crosswalks ?? []).find((c) => c.id === sel.id);
      return cw ? { x: cw.cx, z: cw.cz, h: cw.h, label: `Переход ${cw.id}` } : null;
    }
    case "road": {
      const r = (def.roads ?? []).find((rd) => rd.id === sel.id);
      if (!r || r.points.length === 0) return null;
      const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length;
      const cz = r.points.reduce((s, p) => s + p.z, 0) / r.points.length;
      const h =
        r.points.length >= 2
          ? Math.atan2(r.points[r.points.length - 1].x - r.points[0].x, r.points[r.points.length - 1].z - r.points[0].z)
          : 0;
      return { x: round2(cx), z: round2(cz), h: normalizeAngleRad(h), label: r.name || r.id };
    }
    case "road_point": {
      const r = (def.roads ?? []).find((rd) => rd.id === sel.id);
      const pt = r?.points[sel.index];
      return r && pt ? { x: pt.x, z: pt.z, h: null, label: `${r.name || r.id} · узел #${sel.index + 1}` } : null;
    }
    case "bay": {
      const b = def.bays.find((x) => x.id === sel.id);
      return b ? { x: b.cx, z: b.cz, h: b.h, label: b.label } : null;
    }
    case "obstacle": {
      const o = def.obstacles.find((x) => x.id === sel.id);
      return o ? { x: o.cx, z: o.cz, h: o.h, label: o.label || o.id } : null;
    }
    case "checkpoint": {
      const c = def.checkpoints.find((x) => x.id === sel.id);
      return c ? { x: c.x, z: c.z, h: null, label: `КТ ${c.id}` } : null;
    }
  }
}

/** Приводит под-ручку (`sign_zone`, `signal_stopline`, `road_point`) к родительскому объекту для инспектора. */
export function primarySelection(sel: EditorSelection | null): EditorSelection | null {
  if (!sel) return null;
  if (sel.kind === "sign_zone") return { kind: "sign", id: sel.id };
  if (sel.kind === "signal_stopline") return { kind: "signal", id: sel.id };
  if (sel.kind === "road_point") return { kind: "road", id: sel.id };
  return sel;
}

function expandBoundsIfNeeded(
  bounds: CustomScenarioDef["bounds"],
  x: number,
  z: number,
  margin = 6
): CustomScenarioDef["bounds"] {
  const minX = x - margin < bounds.minX ? Math.max(-600, Math.floor(x - margin)) : bounds.minX;
  const maxX = x + margin > bounds.maxX ? Math.min(600, Math.ceil(x + margin)) : bounds.maxX;
  const minZ = z - margin < bounds.minZ ? Math.max(-600, Math.floor(z - margin)) : bounds.minZ;
  const maxZ = z + margin > bounds.maxZ ? Math.min(600, Math.ceil(z + margin)) : bounds.maxZ;
  if (minX === bounds.minX && maxX === bounds.maxX && minZ === bounds.minZ && maxZ === bounds.maxZ) {
    return bounds;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Размещает новый объект выбранного класса в точке `(rawX, rawZ)` на карте. */
export function placeObjectAt(
  def: CustomScenarioDef,
  tool: Exclude<EditorTool, "select" | "pan">,
  rawX: number,
  rawZ: number,
  opts: PlaceOptions
): { def: CustomScenarioDef; selection: EditorSelection } {
  const step = opts.snapStep ?? 0;
  const x = snapCoord(rawX, step);
  const z = snapCoord(rawZ, step);
  const h = normalizeAngleRad(opts.headingRad ?? 0);
  const bounds = expandBoundsIfNeeded(def.bounds, x, z, 8);

  if (tool === "start") {
    return {
      def: { ...def, bounds, start: { ...def.start, x, z } },
      selection: { kind: "start" },
    };
  }

  if (tool === "sign") {
    const id = nextSignId(def, opts.signKind);
    const limit = opts.signKind === "speed_limit" ? opts.signSpeedLimit : undefined;
    const sign = createDefaultSign(id, opts.signKind, x, z, h, limit);
    return {
      def: { ...def, bounds, signs: [...(def.signs ?? []), sign] },
      selection: { kind: "sign", id },
    };
  }

  if (tool === "signal") {
    const id = nextSignalId(def);
    const sig = createDefaultSignal(id, x, z, h);
    return {
      def: { ...def, bounds, signals: [...(def.signals ?? []), sig] },
      selection: { kind: "signal", id },
    };
  }

  if (tool === "crosswalk") {
    const id = nextCrosswalkId(def);
    const cw = createDefaultCrosswalk(id, x, z, h);
    return {
      def: { ...def, bounds, crosswalks: [...(def.crosswalks ?? []), cw] },
      selection: { kind: "crosswalk", id },
    };
  }

  if (tool === "road") {
    const id = nextRoadId(def);
    const road = { ...createDefaultRoad(id, x, z, h), width: opts.roadWidth ?? 7.5, cornerRadiusM: opts.cornerRadiusM ?? 0 };
    let nextBounds = bounds;
    for (const p of road.points) nextBounds = expandBoundsIfNeeded(nextBounds, p.x, p.z, 10);
    return {
      def: { ...def, bounds: nextBounds, roads: [...(def.roads ?? []), road] },
      selection: { kind: "road", id },
    };
  }

  if (tool === "bay") {
    const id = nextBayId(def);
    const isPar = opts.bayKind === "parallel";
    const bay: ParkingBay = {
      id,
      label: isPar ? `Карман №${id} (свой)` : `Бокс №${id} (свой)`,
      kind: opts.bayKind,
      cx: x,
      cz: z,
      width: isPar ? opts.calibration.parBayWidth : opts.calibration.perpBayWidth,
      length: isPar ? opts.calibration.parBayLength : opts.calibration.perpBayLength,
      h,
      openSide: isPar ? "left" : "front",
      occupied: false,
      requireReverseEntry: true,
    };
    return {
      def: { ...def, bounds, bays: [...def.bays, bay] },
      selection: { kind: "bay", id },
    };
  }

  if (tool === "obstacle") {
    const id = nextObstacleId(def, opts.obstacleKind);
    const obs = createDefaultObstacle(id, opts.obstacleKind, x, z, h, opts.parkedModel);
    return {
      def: { ...def, bounds, obstacles: [...def.obstacles, obs] },
      selection: { kind: "obstacle", id },
    };
  }

  // checkpoint
  const id = nextCheckpointId(def);
  const cp = {
    id,
    x,
    z,
    radius: 5.5,
    instruction: `Проследуйте через точку #${def.checkpoints.length + 1}.`,
  };
  return {
    def: { ...def, bounds, checkpoints: [...def.checkpoints, cp] },
    selection: { kind: "checkpoint", id },
  };
}

/** Перемещает выбранный объект (или его ручку/узел) в новую точку `(rawX, rawZ)` с опциональной сеткой. */
export function moveSelected(
  def: CustomScenarioDef,
  sel: EditorSelection,
  rawX: number,
  rawZ: number,
  snapStep = 0
): CustomScenarioDef {
  if (sel.kind === "boundary_point") {
    if (!def.boundaryPolygon || sel.index < 0 || sel.index >= def.boundaryPolygon.length) return def;
    const next = def.boundaryPolygon.map((p, i) => i === sel.index ? { x: round2(snapCoord(rawX, snapStep)), z: round2(snapCoord(rawZ, snapStep)) } : p);
    return { ...def, boundaryPolygon: next, bounds: boundingBoxOfPolygon(next, 0) };
  }

  const clampX = Math.max(def.bounds.minX, Math.min(def.bounds.maxX, snapCoord(rawX, snapStep)));
  const clampZ = Math.max(def.bounds.minZ, Math.min(def.bounds.maxZ, snapCoord(rawZ, snapStep)));

  switch (sel.kind) {
    case "start":
      return { ...def, start: { ...def.start, x: clampX, z: clampZ } };

    case "sign":
      return {
        ...def,
        signs: (def.signs ?? []).map((s) => {
          if (s.id !== sel.id) return s;
          const dx = clampX - s.x;
          const dz = clampZ - s.z;
          return {
            ...s,
            x: clampX,
            z: clampZ,
            ...(s.zoneX !== undefined ? { zoneX: round2(s.zoneX + dx) } : {}),
            ...(s.zoneZ !== undefined ? { zoneZ: round2(s.zoneZ + dz) } : {}),
          };
        }),
      };

    case "sign_zone":
      return {
        ...def,
        signs: (def.signs ?? []).map((s) => {
          if (s.id !== sel.id) return s;
          const h = s.h;
          const startX = s.x + Math.cos(h) * 3.2;
          const startZ = s.z - Math.sin(h) * 3.2;
          const length = (clampX - startX) * Math.sin(h) + (clampZ - startZ) * Math.cos(h);
          return { ...s, zoneLength: Math.max(0.5, Math.min(2000, round2(length))) };
        }),
      };

    case "signal":
      return {
        ...def,
        signals: (def.signals ?? []).map((sg) => {
          if (sg.id !== sel.id) return sg;
          const dx = clampX - sg.x;
          const dz = clampZ - sg.z;
          return {
            ...sg,
            x: clampX,
            z: clampZ,
            stopLineX: round2(sg.stopLineX + dx),
            stopLineZ: round2(sg.stopLineZ + dz),
          };
        }),
      };

    case "signal_stopline":
      return {
        ...def,
        signals: (def.signals ?? []).map((sg) =>
          sg.id === sel.id ? { ...sg, stopLineX: clampX, stopLineZ: clampZ } : sg
        ),
      };

    case "crosswalk":
      return {
        ...def,
        crosswalks: (def.crosswalks ?? []).map((cw) =>
          cw.id === sel.id ? { ...cw, cx: clampX, cz: clampZ } : cw
        ),
      };

    case "road":
      return {
        ...def,
        roads: (def.roads ?? []).map((r) => {
          if (r.id !== sel.id || r.points.length === 0) return r;
          const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length;
          const cz = r.points.reduce((s, p) => s + p.z, 0) / r.points.length;
          const dx = clampX - cx;
          const dz = clampZ - cz;
          return {
            ...r,
            points: r.points.map((p) => ({ x: round2(p.x + dx), z: round2(p.z + dz) })),
          };
        }),
      };

    case "road_point":
      return {
        ...def,
        roads: (def.roads ?? []).map((r) => {
          if (r.id !== sel.id) return r;
          return {
            ...r,
            points: r.points.map((p, idx) => (idx === sel.index ? { x: clampX, z: clampZ } : p)),
          };
        }),
      };

    case "bay":
      return {
        ...def,
        bays: def.bays.map((b) => (b.id === sel.id ? { ...b, cx: clampX, cz: clampZ } : b)),
      };

    case "obstacle":
      return {
        ...def,
        obstacles: def.obstacles.map((o) => (o.id === sel.id ? { ...o, cx: clampX, cz: clampZ } : o)),
      };

    case "checkpoint":
      return {
        ...def,
        checkpoints: def.checkpoints.map((c) => (c.id === sel.id ? { ...c, x: clampX, z: clampZ } : c)),
      };
  }
}

function rotateOffset(dx: number, dz: number, deltaH: number): Vec2 {
  // При увеличении h (+влево) вектор поворачивается от +Z к +X:
  // dx' = dx*cos(d) + dz*sin(d), dz' = -dx*sin(d) + dz*cos(d)
  const c = Math.cos(deltaH);
  const s = Math.sin(deltaH);
  return {
    x: round2(dx * c + dz * s),
    z: round2(-dx * s + dz * c),
  };
}

/** Задаёт абсолютный курс `h` (рад) выбранному объекту (поворачивая связанные зоны/стоп-линии/узлы). */
export function setSelectedHeading(
  def: CustomScenarioDef,
  sel: EditorSelection,
  newHeadingRad: number
): CustomScenarioDef {
  const target = primarySelection(sel);
  if (!target) return def;
  const h = normalizeAngleRad(newHeadingRad);

  switch (target.kind) {
    case "start":
      return { ...def, start: { ...def.start, h } };

    case "sign":
      return {
        ...def,
        signs: (def.signs ?? []).map((sn) => {
          if (sn.id !== target.id) return sn;
          const dh = h - sn.h;
          if (sn.zoneX !== undefined && sn.zoneZ !== undefined) {
            const rot = rotateOffset(sn.zoneX - sn.x, sn.zoneZ - sn.z, dh);
            return { ...sn, h, zoneX: round2(sn.x + rot.x), zoneZ: round2(sn.z + rot.z) };
          }
          return { ...sn, h };
        }),
      };

    case "signal":
      return {
        ...def,
        signals: (def.signals ?? []).map((sg) => {
          if (sg.id !== target.id) return sg;
          const dh = h - sg.h;
          const rot = rotateOffset(sg.stopLineX - sg.x, sg.stopLineZ - sg.z, dh);
          return {
            ...sg,
            h,
            stopLineX: round2(sg.x + rot.x),
            stopLineZ: round2(sg.z + rot.z),
          };
        }),
      };

    case "crosswalk":
      return {
        ...def,
        crosswalks: (def.crosswalks ?? []).map((cw) => (cw.id === target.id ? { ...cw, h } : cw)),
      };

    case "road":
      return {
        ...def,
        roads: (def.roads ?? []).map((r) => {
          if (r.id !== target.id || r.points.length < 2) return r;
          const curH = Math.atan2(
            r.points[r.points.length - 1].x - r.points[0].x,
            r.points[r.points.length - 1].z - r.points[0].z
          );
          const dh = h - curH;
          const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length;
          const cz = r.points.reduce((s, p) => s + p.z, 0) / r.points.length;
          return {
            ...r,
            points: r.points.map((p) => {
              const rot = rotateOffset(p.x - cx, p.z - cz, dh);
              return { x: round2(cx + rot.x), z: round2(cz + rot.z) };
            }),
          };
        }),
      };

    case "bay":
      return {
        ...def,
        bays: def.bays.map((b) => (b.id === target.id ? { ...b, h } : b)),
      };

    case "obstacle":
      return {
        ...def,
        obstacles: def.obstacles.map((o) => (o.id === target.id ? { ...o, h } : o)),
      };

    default:
      return def;
  }
}

/** Поворачивает выбранный объект на `deltaRad` (+ влево, − вправо). */
export function rotateSelected(
  def: CustomScenarioDef,
  sel: EditorSelection,
  deltaRad: number
): CustomScenarioDef {
  const target = primarySelection(sel);
  const anchor = getSelectionAnchor(def, target);
  if (!target || !anchor || anchor.h === null) return def;
  return setSelectedHeading(def, target, anchor.h + deltaRad);
}

/** Добавляет новый узел в конец ломаной дороги, продолжая её текущее направление. */
export function appendRoadPoint(
  def: CustomScenarioDef,
  roadId: string
): { def: CustomScenarioDef; pointIndex: number } {
  let pointIndex = 0;
  let newPt: Vec2 | null = null;
  const roads = (def.roads ?? []).map((r) => {
    if (r.id !== roadId || r.points.length === 0) return r;
    const last = r.points[r.points.length - 1];
    const prev = r.points.length >= 2 ? r.points[r.points.length - 2] : { x: last.x, z: last.z - 10 };
    const h = Math.atan2(last.x - prev.x, last.z - prev.z);
    const added: Vec2 = {
      x: round2(last.x + Math.sin(h) * 14),
      z: round2(last.z + Math.cos(h) * 14),
    };
    newPt = added;
    pointIndex = r.points.length;
    return { ...r, points: [...r.points, added] };
  });
  const bounds = newPt ? expandBoundsIfNeeded(def.bounds, (newPt as Vec2).x, (newPt as Vec2).z, 10) : def.bounds;
  return { def: { ...def, bounds, roads }, pointIndex };
}

/** Дублирует выбранный объект с небольшим смещением, чтобы копию было удобно перетащить. */
export function duplicateSelected(
  def: CustomScenarioDef,
  sel: EditorSelection,
  offset = 2.0
): { def: CustomScenarioDef; selection: EditorSelection } | null {
  const target = primarySelection(sel);
  if (!target || target.kind === "start") return null;

  if (target.kind === "sign") {
    const src = (def.signs ?? []).find((s) => s.id === target.id);
    if (!src) return null;
    const id = nextSignId(def, src.kind);
    const copy = {
      ...src,
      id,
      x: round2(src.x + offset),
      z: round2(src.z + offset),
      ...(src.zoneX !== undefined ? { zoneX: round2(src.zoneX + offset) } : {}),
      ...(src.zoneZ !== undefined ? { zoneZ: round2(src.zoneZ + offset) } : {}),
    };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.x, copy.z), signs: [...(def.signs ?? []), copy] },
      selection: { kind: "sign", id },
    };
  }

  if (target.kind === "signal") {
    const src = (def.signals ?? []).find((s) => s.id === target.id);
    if (!src) return null;
    const id = nextSignalId(def);
    const copy = {
      ...src,
      id,
      x: round2(src.x + offset),
      z: round2(src.z + offset),
      stopLineX: round2(src.stopLineX + offset),
      stopLineZ: round2(src.stopLineZ + offset),
    };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.x, copy.z), signals: [...(def.signals ?? []), copy] },
      selection: { kind: "signal", id },
    };
  }

  if (target.kind === "crosswalk") {
    const src = (def.crosswalks ?? []).find((c) => c.id === target.id);
    if (!src) return null;
    const id = nextCrosswalkId(def);
    const copy = { ...src, id, cx: round2(src.cx + offset), cz: round2(src.cz + offset) };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.cx, copy.cz), crosswalks: [...(def.crosswalks ?? []), copy] },
      selection: { kind: "crosswalk", id },
    };
  }

  if (target.kind === "road") {
    const src = (def.roads ?? []).find((r) => r.id === target.id);
    if (!src) return null;
    const id = nextRoadId(def);
    const copy = {
      ...src,
      id,
      points: src.points.map((p) => ({ x: round2(p.x + offset * 2), z: round2(p.z + offset * 2) })),
    };
    return {
      def: { ...def, roads: [...(def.roads ?? []), copy] },
      selection: { kind: "road", id },
    };
  }

  if (target.kind === "bay") {
    const src = def.bays.find((b) => b.id === target.id);
    if (!src) return null;
    const id = nextBayId(def);
    const dx = Math.cos(src.h) * (src.width + 0.2);
    const dz = -Math.sin(src.h) * (src.width + 0.2);
    const copy: ParkingBay = {
      ...src,
      id,
      label: src.kind === "parallel" ? `Карман №${id} (свой)` : `Бокс №${id} (свой)`,
      cx: round2(src.cx + dx),
      cz: round2(src.cz + dz),
    };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.cx, copy.cz), bays: [...def.bays, copy] },
      selection: { kind: "bay", id },
    };
  }

  if (target.kind === "obstacle") {
    const src = def.obstacles.find((o) => o.id === target.id);
    if (!src) return null;
    const id = nextObstacleId(def, src.kind);
    const copy = { ...src, id, cx: round2(src.cx + offset), cz: round2(src.cz + offset) };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.cx, copy.cz), obstacles: [...def.obstacles, copy] },
      selection: { kind: "obstacle", id },
    };
  }

  if (target.kind === "checkpoint") {
    const src = def.checkpoints.find((c) => c.id === target.id);
    if (!src) return null;
    const id = nextCheckpointId(def);
    const copy = { ...src, id, x: round2(src.x + offset), z: round2(src.z + offset) };
    return {
      def: { ...def, bounds: expandBoundsIfNeeded(def.bounds, copy.x, copy.z), checkpoints: [...def.checkpoints, copy] },
      selection: { kind: "checkpoint", id },
    };
  }

  return null;
}

/** Удаляет выбранный объект (или отдельный узел дороги, если в ней ≥ 3 узлов). */
export function deleteSelected(
  def: CustomScenarioDef,
  sel: EditorSelection
): { def: CustomScenarioDef; selection: EditorSelection | null } {
  if (sel.kind === "start") return { def, selection: sel };
  if (sel.kind === "boundary_point") {
    if (!def.boundaryPolygon) return { def, selection: null };
    const next = removeBoundaryVertex(def.boundaryPolygon, sel.index);
    return next
      ? { def: { ...def, boundaryPolygon: next, bounds: boundingBoxOfPolygon(next, 0) }, selection: { kind: "boundary_point", index: Math.min(sel.index, next.length - 1) } }
      : { def: { ...def, boundaryPolygon: undefined }, selection: null };
  }

  if (sel.kind === "road_point") {
    const road = (def.roads ?? []).find((r) => r.id === sel.id);
    if (!road) return { def, selection: null };
    if (road.points.length <= 2) {
      return {
        def: { ...def, roads: (def.roads ?? []).filter((r) => r.id !== sel.id) },
        selection: null,
      };
    }
    return {
      def: {
        ...def,
        roads: (def.roads ?? []).map((r) =>
          r.id === sel.id ? { ...r, points: r.points.filter((_, idx) => idx !== sel.index) } : r
        ),
      },
      selection: { kind: "road", id: sel.id },
    };
  }

  const target = primarySelection(sel);
  if (!target) return { def, selection: null };

  switch (target.kind) {
    case "sign":
      return { def: { ...def, signs: (def.signs ?? []).filter((s) => s.id !== target.id) }, selection: null };
    case "signal":
      return { def: { ...def, signals: (def.signals ?? []).filter((s) => s.id !== target.id) }, selection: null };
    case "crosswalk":
      return { def: { ...def, crosswalks: (def.crosswalks ?? []).filter((c) => c.id !== target.id) }, selection: null };
    case "road":
      return { def: { ...def, roads: (def.roads ?? []).filter((r) => r.id !== target.id) }, selection: null };
    case "bay":
      return { def: { ...def, bays: def.bays.filter((b) => b.id !== target.id) }, selection: null };
    case "obstacle":
      return { def: { ...def, obstacles: def.obstacles.filter((o) => o.id !== target.id) }, selection: null };
    case "checkpoint":
      return { def: { ...def, checkpoints: def.checkpoints.filter((c) => c.id !== target.id) }, selection: null };
    default:
      return { def, selection: null };
  }
}

/** Добавляет к маршруту КТ, связанную с выбранным дорожным знаком (STOP, поворот, скорость и т. д.). */
export function attachCheckpointToSign(
  def: CustomScenarioDef,
  signId: string
): { def: CustomScenarioDef; checkpointId: string } | null {
  const sign = (def.signs ?? []).find((s) => s.id === signId);
  if (!sign) return null;
  const checkpointId = nextCheckpointId(def);
  const cp = buildCheckpointForSign(sign, checkpointId);
  const bounds = expandBoundsIfNeeded(def.bounds, cp.x, cp.z, 8);
  return {
    def: { ...def, bounds, checkpoints: [...def.checkpoints, cp] },
    checkpointId,
  };
}

/** Пересобирает учебный маршрут и стартовую позицию по текущей дорожной сети карты. */
export function rebuildRouteFromEditorRoads(
  def: CustomScenarioDef
): { def: CustomScenarioDef; count: number; roadName: string } {
  const route = buildRouteFromRoads(def.roads ?? []);
  if (route.checkpoints.length === 0) {
    return { def, count: 0, roadName: "" };
  }
  return {
    def: {
      ...def,
      start: route.startPose ?? def.start,
      checkpoints: route.checkpoints,
    },
    count: route.checkpoints.length,
    roadName: route.roadName,
  };
}

/** Подгоняет границы `bounds` по всем объектам карты с отступом `pad` метров. */
export function fitBoundsToContent(def: CustomScenarioDef, pad = 12): CustomScenarioDef {
  let minX = def.start.x;
  let maxX = def.start.x;
  let minZ = def.start.z;
  let maxZ = def.start.z;

  const include = (x: number, z: number, r = 0) => {
    if (x - r < minX) minX = x - r;
    if (x + r > maxX) maxX = x + r;
    if (z - r < minZ) minZ = z - r;
    if (z + r > maxZ) maxZ = z + r;
  };

  if (def.useLotSurface !== false) {
    include(0, 0, Math.max(def.lotHalfX, 6));
    minZ = Math.min(minZ, -def.lotHalfZ);
    maxZ = Math.max(maxZ, def.lotHalfZ);
  }
  for (const r of def.roads ?? []) {
    for (const p of r.points) include(p.x, p.z, r.width / 2 + 2);
  }
  for (const b of def.bays) include(b.cx, b.cz, Math.max(b.width, b.length) / 2);
  for (const o of def.obstacles) include(o.cx, o.cz, Math.max(o.halfX, o.halfZ));
  for (const s of def.signs ?? []) include(s.x, s.z, 2);
  for (const sg of def.signals ?? []) {
    include(sg.x, sg.z, 2);
    include(sg.stopLineX, sg.stopLineZ, sg.stopLineWidth / 2);
  }
  for (const cw of def.crosswalks ?? []) include(cw.cx, cw.cz, Math.max(cw.width, cw.length) / 2);
  for (const cp of def.checkpoints) include(cp.x, cp.z, cp.radius);

  return {
    ...def,
    bounds: {
      minX: Math.max(-600, Math.floor(minX - pad)),
      maxX: Math.min(600, Math.ceil(maxX + pad)),
      minZ: Math.max(-600, Math.floor(minZ - pad)),
      maxZ: Math.min(600, Math.ceil(maxZ + pad)),
    },
  };
}

/** Устанавливает произвольный контур площадки/границы мира после проверки геометрии. */
export function setCustomBoundaryPolygon(def: CustomScenarioDef, points: readonly Vec2[]): { def: CustomScenarioDef; ok: boolean; error?: string } {
  const polygon = sanitizeBoundaryPolygon(points);
  if (!polygon) return { def, ok: false, error: "Нужно минимум 3 несовпадающие вершины площадью не менее 25 м²." };
  return { def: { ...def, boundaryPolygon: polygon, bounds: boundingBoxOfPolygon(polygon, 0) }, ok: true };
}

/** Вставляет вершину в середину выбранного ребра. */
export function insertBoundaryPoint(def: CustomScenarioDef, edgeIndex: number): { def: CustomScenarioDef; selection: EditorSelection } | null {
  const base = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : boundsToPolygon(def.bounds);
  const { polygon, insertedIndex } = insertBoundaryVertex(base, edgeIndex);
  return { def: { ...def, boundaryPolygon: polygon, bounds: boundingBoxOfPolygon(polygon, 0) }, selection: { kind: "boundary_point", index: insertedIndex } };
}

/** Применяет один из готовых шаблонов произвольной формы. */
export function applyPresetBoundaryShape(def: CustomScenarioDef, preset: BoundaryShapePreset): { def: CustomScenarioDef; vertices: number } {
  const polygon = buildPresetBoundaryPolygon(preset, def.bounds);
  const bounds = boundingBoxOfPolygon(polygon, 0);
  const start = clampPointToWorldBoundary(def.start.x, def.start.z, bounds, polygon);
  return { vertices: polygon.length, def: { ...def, boundaryPolygon: polygon, bounds, start: { ...def.start, x: round2(start.x), z: round2(start.z) } } };
}

/** Сбрасывает полигональную границу к прямоугольным границам содержимого карты. */
export function clearBoundaryPolygon(def: CustomScenarioDef, pad = 12): CustomScenarioDef {
  return fitBoundsToContent({ ...def, boundaryPolygon: undefined }, pad);
}

/** Ограниченный стек истории отмен/повторов (`Ctrl+Z` / `Ctrl+Y`) без мутаций. */
export type EditorHistory<T> = {
  past: T[];
  future: T[];
};

export const HISTORY_LIMIT = 40;

export function createEditorHistory<T>(): EditorHistory<T> {
  return { past: [], future: [] };
}

export function pushEditorHistory<T>(hist: EditorHistory<T>, prevState: T): EditorHistory<T> {
  const nextPast = [...hist.past, prevState];
  if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
  return { past: nextPast, future: [] };
}

export function undoEditorHistory<T>(
  hist: EditorHistory<T>,
  current: T
): { history: EditorHistory<T>; state: T } | null {
  if (hist.past.length === 0) return null;
  const state = hist.past[hist.past.length - 1];
  return {
    state,
    history: {
      past: hist.past.slice(0, -1),
      future: [current, ...hist.future].slice(0, HISTORY_LIMIT),
    },
  };
}

export function redoEditorHistory<T>(
  hist: EditorHistory<T>,
  current: T
): { history: EditorHistory<T>; state: T } | null {
  if (hist.future.length === 0) return null;
  const state = hist.future[0];
  return {
    state,
    history: {
      past: [...hist.past, current].slice(-HISTORY_LIMIT),
      future: hist.future.slice(1),
    },
  };
}
