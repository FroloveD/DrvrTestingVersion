/**
 * @module scenarios/editorOps
 * @layer pure-core
 * @role Чистые операции 2D-редактора карт: размещение, перенос, поворот, узлы дорог, произвольные границы/коридор/обрезка, автомаршрут, автопочинка и Undo/Redo.
 * @invariants #1 (координаты +Z север, +X лево, +h влево), #7 (чистое ядро без DOM и three).
 * @tests T29, T31, T32
 */
import {
  boundingBoxOfPolygon,
  boundsToPolygon,
  buildConvexHullPolygon,
  buildPresetBoundaryPolygon,
  buildRouteCorridorPolygon,
  clampPointToWorldBoundary,
  clipPolylineToPolygon,
  insertBoundaryVertex,
  isInsideWorldBoundary,
  isSimplePolygon,
  isValidBoundaryPolygon,
  MAX_WORLD_COORD,
  polygonArea,
  removeBoundaryVertex,
  sanitizeBoundaryPolygon,
  type BoundaryShapePreset,
} from "../maps/boundary";
import {
  clipPolylineOutsideRoads,
  deconflictPointObstacle,
  placeSignPostClearOfRoads,
  reprojectBetweenOrigins,
  retractObstacleFromRoads,
  RoadCorridorIndex,
} from "../maps/osmDeconflict";
import {
  buildRouteFromRoads,
  findRoadNetworkPath,
  nearestRoadPoint,
  type BuildRouteOptions,
} from "../maps/route";
import { SpatialGrid } from "../sim/spatialGrid";
import type {
  CalibrationConfig,
  ObstacleKind,
  ParkedModelKey,
  ParkingBay,
  ParkingBayKind,
  RoadSegment,
  RoadSignKind,
  RouteCheckpoint,
  Vec2,
} from "../sim/types";
import {
  buildCustomWorld,
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

/** Инструменты палитры 2D-редактора карт (включая рисование произвольной границы `boundary`). */
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
};

export type CropSummary = {
  def: CustomScenarioDef;
  removedRoads: number;
  splitRoads: number;
  removedObjects: number;
  keptCheckpoints: number;
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
    case "sign": {
      const sn = (def.signs ?? []).find((s) => s.id === sel.id);
      return sn ? { x: sn.x, z: sn.z, h: sn.h, label: sn.label || sn.id } : null;
    }
    case "sign_zone": {
      const sn = (def.signs ?? []).find((s) => s.id === sel.id);
      if (!sn) return null;
      return {
        x: sn.zoneX ?? sn.x,
        z: sn.zoneZ ?? sn.z,
        h: null,
        label: `Зона знака «${sn.label || sn.id}»`,
      };
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
    case "boundary_point": {
      const pt = def.boundaryPolygon?.[sel.index];
      return pt ? { x: pt.x, z: pt.z, h: null, label: `Граница · вершина #${sel.index + 1}` } : null;
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
  const minX = x - margin < bounds.minX ? Math.max(-MAX_WORLD_COORD, Math.floor(x - margin)) : bounds.minX;
  const maxX = x + margin > bounds.maxX ? Math.min(MAX_WORLD_COORD, Math.ceil(x + margin)) : bounds.maxX;
  const minZ = z - margin < bounds.minZ ? Math.max(-MAX_WORLD_COORD, Math.floor(z - margin)) : bounds.minZ;
  const maxZ = z + margin > bounds.maxZ ? Math.min(MAX_WORLD_COORD, Math.ceil(z + margin)) : bounds.maxZ;
  if (minX === bounds.minX && maxX === bounds.maxX && minZ === bounds.minZ && maxZ === bounds.maxZ) {
    return bounds;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Размещает новый объект выбранного класса в точке `(rawX, rawZ)` на карте. */
export function placeObjectAt(
  def: CustomScenarioDef,
  tool: Exclude<EditorTool, "select" | "pan" | "boundary">,
  rawX: number,
  rawZ: number,
  opts: PlaceOptions
): { def: CustomScenarioDef; selection: EditorSelection } {
  const step = opts.snapStep ?? 0;
  const snappedX = snapCoord(rawX, step);
  const snappedZ = snapCoord(rawZ, step);
  // Если задан произвольный полигон границы, мягко удерживаем размещаемый объект внутри него
  const poly = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : undefined;
  const clamped = poly ? clampPointToWorldBoundary(snappedX, snappedZ, def.bounds, poly) : { x: snappedX, z: snappedZ };
  const x = round2(clamped.x);
  const z = round2(clamped.z);
  const h = normalizeAngleRad(opts.headingRad ?? 0);
  const bounds = poly ? def.bounds : expandBoundsIfNeeded(def.bounds, x, z, 8);

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
    const road = createDefaultRoad(id, x, z, h);
    let nextBounds = bounds;
    if (!poly) {
      for (const p of road.points) nextBounds = expandBoundsIfNeeded(nextBounds, p.x, p.z, 10);
    }
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

/** Перемещает выбранный объект, узел дороги или вершину границы в `(rawX, rawZ)` с опциональной сеткой. */
export function moveSelected(
  def: CustomScenarioDef,
  sel: EditorSelection,
  rawX: number,
  rawZ: number,
  snapStep = 0
): CustomScenarioDef {
  if (sel.kind === "boundary_point") {
    if (!def.boundaryPolygon || sel.index < 0 || sel.index >= def.boundaryPolygon.length) return def;
    const bx = Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, snapCoord(rawX, snapStep)));
    const bz = Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, snapCoord(rawZ, snapStep)));
    const nextPoly = def.boundaryPolygon.map((p, i) => (i === sel.index ? { x: bx, z: bz } : p));
    return {
      ...def,
      boundaryPolygon: nextPoly,
      bounds: boundingBoxOfPolygon(nextPoly, 0),
    };
  }

  const sx = snapCoord(rawX, snapStep);
  const sz = snapCoord(rawZ, snapStep);
  const poly = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : undefined;
  const clamped = clampPointToWorldBoundary(sx, sz, def.bounds, poly);
  const clampX = round2(clamped.x);
  const clampZ = round2(clamped.z);

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
        signs: (def.signs ?? []).map((s) =>
          s.id === sel.id ? { ...s, zoneX: clampX, zoneZ: clampZ } : s
        ),
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
  const bounds =
    newPt && !isValidBoundaryPolygon(def.boundaryPolygon)
      ? expandBoundsIfNeeded(def.bounds, (newPt as Vec2).x, (newPt as Vec2).z, 10)
      : def.bounds;
  return { def: { ...def, bounds, roads }, pointIndex };
}

/** Разворачивает порядок узлов выбранной дороги (полезно для односторонних улиц и автомаршрута). */
export function reverseRoadDirection(def: CustomScenarioDef, roadId: string): CustomScenarioDef {
  return {
    ...def,
    roads: (def.roads ?? []).map((r) =>
      r.id === roadId ? { ...r, points: [...r.points].reverse() } : r
    ),
  };
}

/** Дублирует выбранный объект с небольшим смещением, чтобы копию было удобно перетащить. */
export function duplicateSelected(
  def: CustomScenarioDef,
  sel: EditorSelection,
  offset = 2.0
): { def: CustomScenarioDef; selection: EditorSelection } | null {
  const target = primarySelection(sel);
  if (!target || target.kind === "start" || target.kind === "boundary_point") return null;
  const keepPolyBounds = isValidBoundaryPolygon(def.boundaryPolygon);
  const nextB = (x: number, z: number) => (keepPolyBounds ? def.bounds : expandBoundsIfNeeded(def.bounds, x, z));

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
      def: { ...def, bounds: nextB(copy.x, copy.z), signs: [...(def.signs ?? []), copy] },
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
      def: { ...def, bounds: nextB(copy.x, copy.z), signals: [...(def.signals ?? []), copy] },
      selection: { kind: "signal", id },
    };
  }

  if (target.kind === "crosswalk") {
    const src = (def.crosswalks ?? []).find((c) => c.id === target.id);
    if (!src) return null;
    const id = nextCrosswalkId(def);
    const copy = { ...src, id, cx: round2(src.cx + offset), cz: round2(src.cz + offset) };
    return {
      def: { ...def, bounds: nextB(copy.cx, copy.cz), crosswalks: [...(def.crosswalks ?? []), copy] },
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
      def: { ...def, bounds: nextB(copy.cx, copy.cz), bays: [...def.bays, copy] },
      selection: { kind: "bay", id },
    };
  }

  if (target.kind === "obstacle") {
    const src = def.obstacles.find((o) => o.id === target.id);
    if (!src) return null;
    const id = nextObstacleId(def, src.kind);
    const copy = { ...src, id, cx: round2(src.cx + offset), cz: round2(src.cz + offset) };
    return {
      def: { ...def, bounds: nextB(copy.cx, copy.cz), obstacles: [...def.obstacles, copy] },
      selection: { kind: "obstacle", id },
    };
  }

  if (target.kind === "checkpoint") {
    const src = def.checkpoints.find((c) => c.id === target.id);
    if (!src) return null;
    const id = nextCheckpointId(def);
    const copy = { ...src, id, x: round2(src.x + offset), z: round2(src.z + offset) };
    return {
      def: { ...def, bounds: nextB(copy.x, copy.z), checkpoints: [...def.checkpoints, copy] },
      selection: { kind: "checkpoint", id },
    };
  }

  return null;
}

/** Удаляет выбранный объект, узел дороги или вершину произвольной границы. */
export function deleteSelected(
  def: CustomScenarioDef,
  sel: EditorSelection
): { def: CustomScenarioDef; selection: EditorSelection | null } {
  if (sel.kind === "start") return { def, selection: sel };

  if (sel.kind === "boundary_point") {
    if (!def.boundaryPolygon) return { def, selection: null };
    const nextPoly = removeBoundaryVertex(def.boundaryPolygon, sel.index);
    if (!nextPoly) {
      return { def: clearBoundaryPolygon(def), selection: null };
    }
    return {
      def: {
        ...def,
        boundaryPolygon: nextPoly,
        bounds: boundingBoxOfPolygon(nextPoly, 0),
      },
      selection: { kind: "boundary_point", index: Math.min(sel.index, nextPoly.length - 1) },
    };
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
  const poly = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : undefined;
  if (poly) {
    const c = clampPointToWorldBoundary(cp.x, cp.z, def.bounds, poly);
    cp.x = round2(c.x);
    cp.z = round2(c.z);
  }
  const bounds = poly ? def.bounds : expandBoundsIfNeeded(def.bounds, cp.x, cp.z, 8);
  return {
    def: { ...def, bounds, checkpoints: [...def.checkpoints, cp] },
    checkpointId,
  };
}

// ============================================================================
// ПРОИЗВОЛЬНЫЕ ГРАНИЦЫ КАРТЫ И МАРШРУТА (полигон, коридор, оболочка, обрезка)
// ============================================================================

/** Устанавливает пользовательский многоугольник границы (с проверкой самопересечений и площади). */
export function setCustomBoundaryPolygon(
  def: CustomScenarioDef,
  rawPoints: readonly Vec2[]
): { def: CustomScenarioDef; ok: boolean; error?: string } {
  const sanitized = sanitizeBoundaryPolygon(rawPoints);
  if (!sanitized) {
    return { def, ok: false, error: "Нужно минимум 3 несовпадающие вершины площадью не менее 25 м²." };
  }
  if (!isSimplePolygon(sanitized)) {
    return {
      def,
      ok: false,
      error: "Контур самопересекается — расставьте вершины последовательно по периметру без перехлёста рёбер.",
    };
  }
  if (polygonArea(sanitized) < 25) {
    return { def, ok: false, error: "Слишком узкий контур (площадь менее 25 м²)." };
  }
  return {
    ok: true,
    def: {
      ...def,
      boundaryPolygon: sanitized,
      bounds: boundingBoxOfPolygon(sanitized, 0),
    },
  };
}

/** Вставляет новую вершину в середину ребра `edgeIndex` полигона границы. */
export function insertBoundaryPoint(
  def: CustomScenarioDef,
  edgeIndex: number
): { def: CustomScenarioDef; selection: EditorSelection } | null {
  const base = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : boundsToPolygon(def.bounds);
  const { polygon, insertedIndex } = insertBoundaryVertex(base, edgeIndex);
  return {
    def: {
      ...def,
      boundaryPolygon: polygon,
      bounds: boundingBoxOfPolygon(polygon, 0),
    },
    selection: { kind: "boundary_point", index: insertedIndex },
  };
}

/**
 * Применяет готовый неквадратный шаблон формы площадки / границы мира
 * (`rect` — редактируемый 4-угольник, `l_shape` — Г-образная, `t_shape` — Т-образная,
 * `u_shape` — П-образная, `trapezoid` — трапеция, `octagon` — 8-угольник).
 * Если старт или КТ попали в вогнутый вырез, мягко возвращает их внутрь площадки.
 */
export function applyPresetBoundaryShape(
  def: CustomScenarioDef,
  preset: BoundaryShapePreset
): { def: CustomScenarioDef; vertices: number } {
  const poly = buildPresetBoundaryPolygon(preset, def.bounds);
  const bounds = boundingBoxOfPolygon(poly, 0);
  const streetRoads = (def.roads ?? []).filter((r) => r.id !== "custom-lot" && r.points.length >= 2);
  const startInside = isInsideWorldBoundary(def.start.x, def.start.z, bounds, poly);
  const anyCpOutside = def.checkpoints.some((cp) => !isInsideWorldBoundary(cp.x, cp.z, bounds, poly));

  if (streetRoads.length > 0 && def.useLotSurface === false && (!startInside || anyCpOutside)) {
    const insideCps = def.checkpoints.filter((cp) => isInsideWorldBoundary(cp.x, cp.z, bounds, poly));
    const rebuilt = buildRouteFromRoads(streetRoads, {
      boundaryPolygon: poly,
      obstacles: def.obstacles,
    });
    const nextCps = insideCps.length > 0 ? insideCps : rebuilt.checkpoints;
    const clampedStart = clampPointToWorldBoundary(def.start.x, def.start.z, bounds, poly);
    const nextStart = startInside
      ? def.start
      : rebuilt.startPose && isInsideWorldBoundary(rebuilt.startPose.x, rebuilt.startPose.z, bounds, poly)
        ? rebuilt.startPose
        : { ...def.start, x: round2(clampedStart.x), z: round2(clampedStart.z) };
    return {
      vertices: poly.length,
      def: {
        ...def,
        start: nextStart,
        checkpoints: nextCps,
        boundaryPolygon: poly,
        bounds,
      },
    };
  }

  const startPos = startInside
    ? { x: def.start.x, z: def.start.z }
    : clampPointToWorldBoundary(def.start.x, def.start.z, bounds, poly);
  const checkpoints = def.checkpoints.map((cp) => {
    if (isInsideWorldBoundary(cp.x, cp.z, bounds, poly)) return cp;
    const c = clampPointToWorldBoundary(cp.x, cp.z, bounds, poly);
    return { ...cp, x: round2(c.x), z: round2(c.z) };
  });
  return {
    vertices: poly.length,
    def: {
      ...def,
      start: { ...def.start, x: round2(startPos.x), z: round2(startPos.z) },
      checkpoints,
      boundaryPolygon: poly,
      bounds,
    },
  };
}

/**
 * Помещает выбранный объект карты на передний план (в конец своего слоя отрисовки).
 * Порядок контрольных точек маршрута не меняется, чтобы не нарушить последовательность прохождения.
 */
export function bringSelectionToFront(
  def: CustomScenarioDef,
  sel: EditorSelection | null
): { def: CustomScenarioDef; moved: boolean } {
  const target = primarySelection(sel);
  if (!target) return { def, moved: false };

  const moveLast = <T>(arr: readonly T[], pred: (item: T) => boolean): { list: T[]; moved: boolean } => {
    const idx = arr.findIndex(pred);
    if (idx === -1 || idx === arr.length - 1) return { list: arr as T[], moved: false };
    return { list: [...arr.slice(0, idx), ...arr.slice(idx + 1), arr[idx]], moved: true };
  };

  switch (target.kind) {
    case "obstacle": {
      const r = moveLast(def.obstacles, (o) => o.id === target.id);
      return r.moved ? { def: { ...def, obstacles: r.list }, moved: true } : { def, moved: false };
    }
    case "bay": {
      const r = moveLast(def.bays, (b) => b.id === target.id);
      return r.moved ? { def: { ...def, bays: r.list }, moved: true } : { def, moved: false };
    }
    case "sign": {
      const r = moveLast(def.signs ?? [], (s) => s.id === target.id);
      return r.moved ? { def: { ...def, signs: r.list }, moved: true } : { def, moved: false };
    }
    case "signal": {
      const r = moveLast(def.signals ?? [], (s) => s.id === target.id);
      return r.moved ? { def: { ...def, signals: r.list }, moved: true } : { def, moved: false };
    }
    case "crosswalk": {
      const r = moveLast(def.crosswalks ?? [], (c) => c.id === target.id);
      return r.moved ? { def: { ...def, crosswalks: r.list }, moved: true } : { def, moved: false };
    }
    case "road": {
      const r = moveLast(def.roads ?? [], (rd) => rd.id === target.id);
      return r.moved ? { def: { ...def, roads: r.list }, moved: true } : { def, moved: false };
    }
    default:
      return { def, moved: false };
  }
}

/** Сбрасывает произвольный полигон к точному (неквадратному!) прямоугольнику по содержимому карты. */
export function clearBoundaryPolygon(def: CustomScenarioDef, pad = 12): CustomScenarioDef {
  const without: CustomScenarioDef = { ...def, boundaryPolygon: undefined };
  return fitBoundsToContent(without, pad);
}

/** Собирает опорную ломаную маршрута (по дорожной сети от старта через все КТ или по главной улице). */
function collectActiveRouteSpine(def: CustomScenarioDef): Vec2[] {
  const roads = def.roads ?? [];
  const spine: Vec2[] = [];

  if (def.checkpoints.length > 0) {
    let prev: Vec2 = { x: def.start.x, z: def.start.z };
    spine.push(prev);
    for (const cp of def.checkpoints) {
      const next: Vec2 = { x: cp.x, z: cp.z };
      const net = roads.length > 0 ? findRoadNetworkPath(roads, prev, next) : null;
      const pts = net && net.connected ? net.path : [prev, next];
      for (const p of pts) {
        const last = spine[spine.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.5) spine.push(p);
      }
      prev = next;
    }
    if (spine.length >= 2) return spine;
  }

  if (roads.length > 0) {
    const built = buildRouteFromRoads(roads, { obstacles: def.obstacles });
    if (built.spine.length >= 2) return built.spine;
    return roads[0].points;
  }

  return [
    { x: def.start.x, z: def.start.z },
    ...def.bays.map((b) => ({ x: b.cx, z: b.cz })),
  ];
}

/**
 * Строит произвольную неквадратную границу — коридор шириной `2 * bufferM` м вдоль активного маршрута.
 * Идеально подходит для вытянутых, изогнутых, Г-образных и диагональных городских маршрутов OSM.
 */
export function applyRouteCorridorBoundary(
  def: CustomScenarioDef,
  bufferM = 28
): { def: CustomScenarioDef; vertices: number; ok: boolean } {
  const spine = collectActiveRouteSpine(def);
  const poly = buildRouteCorridorPolygon(spine, Math.max(12, Math.min(180, bufferM)));
  if (poly.length < 3) return { def, vertices: 0, ok: false };
  return {
    ok: true,
    vertices: poly.length,
    def: {
      ...def,
      useLotSurface: (def.roads ?? []).length > 0 ? false : def.useLotSurface,
      boundaryPolygon: poly,
      bounds: boundingBoxOfPolygon(poly, 0),
    },
  };
}

/** Строит выпуклую многоугольную оболочку по дорогам и объектам карты с отступом `padM` м. */
export function applyConvexHullBoundary(
  def: CustomScenarioDef,
  padM = 16
): { def: CustomScenarioDef; vertices: number; ok: boolean } {
  const pts: Vec2[] = [{ x: def.start.x, z: def.start.z }];
  for (const r of def.roads ?? []) {
    for (const p of r.points) pts.push(p);
  }
  for (const cp of def.checkpoints) pts.push({ x: cp.x, z: cp.z });
  for (const b of def.bays) pts.push({ x: b.cx, z: b.cz });
  for (const sn of def.signs ?? []) pts.push({ x: sn.x, z: sn.z });
  for (const sg of def.signals ?? []) pts.push({ x: sg.x, z: sg.z });
  for (const cw of def.crosswalks ?? []) pts.push({ x: cw.cx, z: cw.cz });
  if ((def.roads ?? []).length === 0 || pts.length < 3) {
    for (const o of def.obstacles) pts.push({ x: o.cx, z: o.cz });
  }
  const poly = buildConvexHullPolygon(pts, Math.max(8, Math.min(120, padM)));
  if (poly.length < 3) return { def, vertices: 0, ok: false };
  return {
    ok: true,
    vertices: poly.length,
    def: {
      ...def,
      boundaryPolygon: poly,
      bounds: boundingBoxOfPolygon(poly, 0),
    },
  };
}

/**
 * Обрезает дороги, здания и объекты карты по текущей границе (`boundaryPolygon` или `bounds`)
 * и актуализирует старт и КТ маршрута внутри обрезанного участка.
 */
export function cropScenarioToBoundary(def: CustomScenarioDef): CropSummary {
  const poly = isValidBoundaryPolygon(def.boundaryPolygon)
    ? def.boundaryPolygon
    : boundsToPolygon(def.bounds);
  const nextBounds = boundingBoxOfPolygon(poly, 0);
  const inside = (x: number, z: number) => isInsideWorldBoundary(x, z, nextBounds, poly);

  const srcRoads = def.roads ?? [];
  const nextRoads: RoadSegment[] = [];
  let removedRoads = 0;
  let splitRoads = 0;

  for (const r of srcRoads) {
    const pieces = clipPolylineToPolygon(r.points, poly);
    if (pieces.length === 0) {
      removedRoads += 1;
      continue;
    }
    if (pieces.length > 1) splitRoads += pieces.length - 1;
    pieces.forEach((pts, idx) => {
      nextRoads.push({
        ...r,
        id: idx === 0 ? r.id : `${r.id}-c${idx + 1}`,
        points: pts,
      });
    });
  }

  const nextObstacles = def.obstacles.filter((o) => inside(o.cx, o.cz));
  const nextSigns = (def.signs ?? []).filter((s) => inside(s.x, s.z));
  const nextSignals = (def.signals ?? []).filter(
    (sg) => inside(sg.x, sg.z) && inside(sg.stopLineX, sg.stopLineZ)
  );
  const nextCrosswalks = (def.crosswalks ?? []).filter((cw) => inside(cw.cx, cw.cz));
  const nextBays = def.bays.filter((b) => inside(b.cx, b.cz));

  const removedObjects =
    def.obstacles.length -
    nextObstacles.length +
    ((def.signs ?? []).length - nextSigns.length) +
    ((def.signals ?? []).length - nextSignals.length) +
    ((def.crosswalks ?? []).length - nextCrosswalks.length) +
    (def.bays.length - nextBays.length);

  let nextCheckpoints = def.checkpoints.filter((c) => inside(c.x, c.z));
  let nextStart = { ...def.start };
  let nextBrief = def.brief;

  // Если старые КТ остались снаружи или старт вырезан — пересобираем маршрут по обрезанным дорогам
  if (nextRoads.length > 0 && (nextCheckpoints.length === 0 || !inside(nextStart.x, nextStart.z))) {
    const rebuilt = buildRouteFromRoads(nextRoads, {
      boundaryPolygon: poly,
      obstacles: nextObstacles,
    });
    if (nextCheckpoints.length === 0 && rebuilt.checkpoints.length > 0) {
      nextCheckpoints = rebuilt.checkpoints;
      if (rebuilt.roadName) {
        nextBrief = `Учебный маршрут по «${rebuilt.roadName}» (${rebuilt.checkpoints.length} КТ): соблюдайте знаки, светофоры и указатели поворота (Q/E).`;
      }
    }
    if (!inside(nextStart.x, nextStart.z)) {
      if (rebuilt.startPose && inside(rebuilt.startPose.x, rebuilt.startPose.z)) {
        nextStart = rebuilt.startPose;
      } else {
        const clamped = clampPointToWorldBoundary(nextStart.x, nextStart.z, nextBounds, poly);
        const snap = nearestRoadPoint(clamped.x, clamped.z, nextRoads);
        nextStart = snap && inside(snap.x, snap.z)
          ? { x: snap.x, z: snap.z, h: snap.h }
          : { ...nextStart, x: clamped.x, z: clamped.z };
      }
    }
  } else if (!inside(nextStart.x, nextStart.z)) {
    const clamped = clampPointToWorldBoundary(nextStart.x, nextStart.z, nextBounds, poly);
    nextStart = { ...nextStart, x: clamped.x, z: clamped.z };
  }

  const nextMapMeta = def.mapMeta
    ? {
        ...def.mapMeta,
        roadsCount: nextRoads.length,
        buildingsCount: nextObstacles.filter((o) => o.kind === "building").length,
        signalsCount: nextSignals.length,
        signsCount: nextSigns.length,
      }
    : undefined;

  return {
    removedRoads,
    splitRoads,
    removedObjects,
    keptCheckpoints: nextCheckpoints.length,
    def: {
      ...def,
      brief: nextBrief,
      start: nextStart,
      useLotSurface: nextRoads.length > 0 ? false : def.useLotSurface,
      roads: nextRoads,
      bays: nextBays,
      obstacles: nextObstacles,
      signs: nextSigns,
      signals: nextSignals,
      crosswalks: nextCrosswalks,
      checkpoints: nextCheckpoints,
      ...(nextMapMeta ? { mapMeta: nextMapMeta } : {}),
      bounds: nextBounds,
      ...(isValidBoundaryPolygon(def.boundaryPolygon) ? { boundaryPolygon: poly.map((p) => ({ ...p })) } : {}),
    },
  };
}

/** Пересобирает учебный маршрут и стартовую позицию по текущей дорожной сети (с выбором улицы и реверсом). */
export function rebuildRouteFromEditorRoads(
  def: CustomScenarioDef,
  options: Omit<BuildRouteOptions, "boundaryPolygon" | "obstacles"> = {}
): { def: CustomScenarioDef; count: number; roadName: string; lengthM: number; reverseBlocked?: boolean } {
  const poly = isValidBoundaryPolygon(def.boundaryPolygon) ? def.boundaryPolygon : undefined;
  const route = buildRouteFromRoads(def.roads ?? [], {
    ...options,
    boundaryPolygon: poly,
    obstacles: def.obstacles,
  });
  if (route.checkpoints.length === 0) {
    return { def, count: 0, roadName: "", lengthM: 0 };
  }
  let nextBounds = def.bounds;
  if (!poly) {
    if (route.startPose) nextBounds = expandBoundsIfNeeded(nextBounds, route.startPose.x, route.startPose.z, 12);
    for (const cp of route.checkpoints) nextBounds = expandBoundsIfNeeded(nextBounds, cp.x, cp.z, cp.radius + 6);
  }
  const nextBrief =
    def.mapMeta || (def.roads ?? []).length > 0
      ? `Учебный маршрут по «${route.roadName}» (${route.checkpoints.length} КТ, ${Math.round(route.totalLengthM)} м): соблюдайте знаки, светофоры и указатели поворота (Q/E).`
      : def.brief;
  return {
    def: {
      ...def,
      brief: nextBrief,
      bounds: nextBounds,
      start: route.startPose ?? def.start,
      checkpoints: route.checkpoints,
    },
    count: route.checkpoints.length,
    roadName: route.roadName,
    lengthM: route.totalLengthM,
    ...(route.reverseBlocked ? { reverseBlocked: true } : {}),
  };
}

/**
 * Автоматически устраняет типовые проблемы маршрута после импорта OSM или ручной правки:
 * отсутствие КТ, выход старта/КТ за границу, дубли ID, коллизию старта со зданием, сход КТ с дороги,
 * неверный курс старта и флаг `isFinalPark` при отсутствии парковочных боксов.
 */
export function autoFixScenarioRoute(def: CustomScenarioDef): { def: CustomScenarioDef; fixes: string[] } {
  const fixes: string[] = [];
  let next: CustomScenarioDef = {
    ...def,
    start: { ...def.start },
    bounds: { ...def.bounds },
    checkpoints: def.checkpoints.map((c) => ({ ...c })),
  };

  // 1. Исправляем некорректный полигон границы, если он сломан
  if (next.boundaryPolygon !== undefined && !isValidBoundaryPolygon(next.boundaryPolygon)) {
    const cleaned = sanitizeBoundaryPolygon(next.boundaryPolygon);
    if (cleaned && isSimplePolygon(cleaned)) {
      next = { ...next, boundaryPolygon: cleaned, bounds: boundingBoxOfPolygon(cleaned, 0) };
      fixes.push("Выровнен контур границы карты.");
    } else {
      next = clearBoundaryPolygon(next);
      fixes.push("Сброшен самопересекающийся контур границы.");
    }
  }

  const poly = isValidBoundaryPolygon(next.boundaryPolygon) ? next.boundaryPolygon : undefined;
  const bounds = poly ? boundingBoxOfPolygon(poly, 0) : next.bounds;
  next.bounds = bounds;
  const inside = (x: number, z: number) => isInsideWorldBoundary(x, z, bounds, poly);
  const roads = next.roads ?? [];
  const freeBays = next.bays.filter((b) => !b.occupied);

  // 2. Если КТ нет, но есть дороги — строим маршрут автоматически
  if (next.checkpoints.length === 0 && roads.length > 0 && freeBays.length === 0) {
    const rebuilt = rebuildRouteFromEditorRoads(next);
    if (rebuilt.count > 0) {
      next = rebuilt.def;
      fixes.push(`Построен маршрут по «${rebuilt.roadName}» (${rebuilt.count} КТ).`);
    }
  }

  // 3. Проверяем каждую КТ: уникальность ID, радиус, нахождение внутри границы и на дороге
  const seenIds = new Set<string>();
  const fixedCps: RouteCheckpoint[] = [];
  for (let i = 0; i < next.checkpoints.length; i++) {
    const cp = { ...next.checkpoints[i] };
    if (!cp.id || seenIds.has(cp.id)) {
      let idx = i + 1;
      while (seenIds.has(`cp-fix-${idx}`)) idx += 1;
      cp.id = `cp-fix-${idx}`;
      fixes.push(`Переименована дублирующаяся КТ #${i + 1} → ${cp.id}.`);
    }
    seenIds.add(cp.id);

    if (!(cp.radius >= 2.5 && cp.radius <= 20)) {
      cp.radius = Math.max(3.5, Math.min(12, Number.isFinite(cp.radius) ? cp.radius : 5.5));
      fixes.push(`Скорректирован радиус КТ #${i + 1} (${cp.radius} м).`);
    }

    if (!inside(cp.x, cp.z)) {
      const clamped = clampPointToWorldBoundary(cp.x, cp.z, bounds, poly);
      cp.x = round2(clamped.x);
      cp.z = round2(clamped.z);
      fixes.push(`КТ #${i + 1} возвращена внутрь границы карты.`);
    }

    if (roads.length > 0 && next.useLotSurface === false) {
      const snap = nearestRoadPoint(cp.x, cp.z, roads);
      if (snap && snap.dist > snap.road.width * 0.65 + cp.radius * 0.5) {
        const laneOff = Math.min(2.6, Math.max(0.8, snap.road.width * 0.22));
        const rx = round2(snap.x - Math.cos(snap.h) * laneOff);
        const rz = round2(snap.z + Math.sin(snap.h) * laneOff);
        if (inside(rx, rz)) {
          cp.x = rx;
          cp.z = rz;
          cp.radius = Math.max(cp.radius, Number(Math.min(9.5, snap.road.width * 0.55 + 1.5).toFixed(1)));
          fixes.push(`КТ #${i + 1} привязана к проезжей части «${snap.road.name || snap.road.id}».`);
        }
      }
    }

    if (cp.isFinalPark && freeBays.length === 0) {
      cp.isFinalPark = false;
      fixes.push(`Снят флаг «парковка на финише» у КТ #${i + 1} (на карте нет свободных боксов).`);
    }

    fixedCps.push(cp);
  }
  next = { ...next, checkpoints: fixedCps };

  // 4. Если все КТ лежали на несвязанных с дорогой точках или маршрут разорван — проверяем старт
  const world = buildCustomWorld(next);
  const grid = new SpatialGrid(world.obstacles, 10);
  const isPoseClear = (x: number, z: number, h: number) =>
    inside(x, z) && grid.queryCarHit(x, z, h).hit === null;

  let startChanged = false;
  if (!inside(next.start.x, next.start.z)) {
    const c = clampPointToWorldBoundary(next.start.x, next.start.z, bounds, poly);
    next.start = { ...next.start, x: round2(c.x), z: round2(c.z) };
    startChanged = true;
    fixes.push("Старт автомобиля возвращён внутрь границы карты.");
  }

  // Привязка старта к дороге и проверка направления на односторонней улице OSM
  if (roads.length > 0 && next.useLotSurface === false) {
    const snap = nearestRoadPoint(next.start.x, next.start.z, roads);
    if (snap && snap.dist > snap.road.width * 0.65 + 2.5) {
      const laneOff = snap.road.lanes >= 2 && snap.road.width >= 5.5 ? snap.road.width * 0.23 : 0;
      const sx = round2(snap.x - Math.cos(snap.h) * laneOff);
      const sz = round2(snap.z + Math.sin(snap.h) * laneOff);
      if (inside(sx, sz)) {
        next.start = { x: sx, z: sz, h: round2(snap.h) };
        startChanged = true;
        fixes.push(`Старт перенесён на улицу «${snap.road.name || snap.road.id}».`);
      }
    } else if (snap && snap.road.oneway && snap.dist <= snap.road.width * 0.65 + 1) {
      let owDiff = snap.h - next.start.h;
      while (owDiff > Math.PI) owDiff -= Math.PI * 2;
      while (owDiff <= -Math.PI) owDiff += Math.PI * 2;
      if (Math.abs(owDiff) > (110 * Math.PI) / 180) {
        next.start = { ...next.start, h: normalizeAngleRad(snap.h) };
        startChanged = true;
        fixes.push(`Курс старта развёрнут по одностороннему потоку «${snap.road.name || snap.road.id}».`);
      }
    }
  }

  // Если контрольные точки идут против односторонней улицы — разворачиваем их порядок по потоку
  if (roads.length > 0 && next.checkpoints.length >= 2) {
    let wrongWayLegs = 0;
    for (let i = 0; i < next.checkpoints.length; i++) {
      const from = i === 0 ? next.start : next.checkpoints[i - 1];
      const net = findRoadNetworkPath(roads, from, next.checkpoints[i]);
      if (net.wrongWay) wrongWayLegs += 1;
    }
    if (wrongWayLegs > 0) {
      const revCps = [...next.checkpoints].reverse();
      const firstSnap = nearestRoadPoint(revCps[0].x, revCps[0].z, roads);
      if (firstSnap) {
        const backM = revCps[0].radius + 7;
        const candStart = {
          x: round2(revCps[0].x - Math.sin(firstSnap.h) * backM),
          z: round2(revCps[0].z - Math.cos(firstSnap.h) * backM),
          h: normalizeAngleRad(firstSnap.h),
        };
        const checkFirst = findRoadNetworkPath(roads, revCps[0], revCps[1]);
        if (checkFirst.connected) {
          next = {
            ...next,
            checkpoints: revCps,
            ...(inside(candStart.x, candStart.z) ? { start: candStart } : {}),
          };
          fixes.push("Порядок КТ развёрнут по разрешённому направлению односторонней улицы.");
        }
      }
    }
  }

  // Если старт уже внутри радиуса КТ #1 — отодвигаем его назад по полосе
  const cp0 = next.checkpoints[0];
  if (cp0) {
    const distToCp0 = Math.hypot(cp0.x - next.start.x, cp0.z - next.start.z);
    if (distToCp0 < cp0.radius + 2.0) {
      const snap = roads.length > 0 ? nearestRoadPoint(cp0.x, cp0.z, roads) : null;
      const h = snap ? snap.h : next.start.h;
      const backDist = cp0.radius + 6.5;
      const candX = round2(cp0.x - Math.sin(h) * backDist);
      const candZ = round2(cp0.z - Math.cos(h) * backDist);
      if (isPoseClear(candX, candZ, h)) {
        next.start = { x: candX, z: candZ, h: round2(h) };
        fixes.push("Старт отодвинут перед КТ #1, чтобы точка не засчитывалась мгновенно.");
      }
    } else {
      // Выравниваем курс старта в сторону КТ #1, если автомобиль развёрнут задом к маршруту
      const net = roads.length > 0 ? findRoadNetworkPath(roads, next.start, cp0) : null;
      const aim =
        net && net.connected && net.path.length >= 2
          ? net.path[Math.min(1, net.path.length - 1)]
          : cp0;
      const desiredH = Math.atan2(aim.x - next.start.x, aim.z - next.start.z);
      let dh = desiredH - next.start.h;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh <= -Math.PI) dh += Math.PI * 2;
      if (Math.abs(dh) > (115 * Math.PI) / 180 && isPoseClear(next.start.x, next.start.z, desiredH)) {
        next.start = { ...next.start, h: normalizeAngleRad(desiredH) };
        fixes.push("Курс старта развёрнут по направлению к КТ #1.");
      }
    }
  }

  // Если на старте всё ещё коллизия с препятствием — ищем ближайшую свободную точку на дороге/по спирали
  if (grid.queryCarHit(next.start.x, next.start.z, next.start.h).hit !== null) {
    let freed = false;
    const snap = roads.length > 0 ? nearestRoadPoint(next.start.x, next.start.z, roads) : null;
    if (snap) {
      const h = snap.h;
      for (const along of [0, 5, -5, 10, -10, 16, -16]) {
        for (const lat of [-snap.road.width * 0.22, 0, snap.road.width * 0.22]) {
          const cx = round2(snap.x + Math.sin(h) * along + Math.cos(h) * lat);
          const cz = round2(snap.z + Math.cos(h) * along - Math.sin(h) * lat);
          if (isPoseClear(cx, cz, h)) {
            next.start = { x: cx, z: cz, h: normalizeAngleRad(h) };
            freed = true;
            break;
          }
        }
        if (freed) break;
      }
    }
    if (!freed) {
      for (const r of [3, 6, 10, 15]) {
        for (let k = 0; k < 12; k++) {
          const ang = (k * Math.PI) / 6;
          const cx = round2(next.start.x + Math.cos(ang) * r);
          const cz = round2(next.start.z + Math.sin(ang) * r);
          if (isPoseClear(cx, cz, next.start.h)) {
            next.start = { ...next.start, x: cx, z: cz };
            freed = true;
            break;
          }
        }
        if (freed) break;
      }
    }
    if (freed) {
      fixes.push("Старт выведен из зоны контакта с препятствием.");
    } else if (startChanged) {
      // оставляем перенесённый старт
    }
  }

  return { def: next, fixes };
}

/**
 * Устраняет конфликты объектов сценария с реальной дорожной сетью карты:
 * снимает наложение площадки автодрома на улицы OSM, ужимает здания от проезжей части,
 * прорезает проезды в заборах/бордюрах, выносит деревья/столбы/стойки знаков на обочину и чинит маршрут.
 */
export function deconflictScenarioWithRoads(def: CustomScenarioDef): {
  def: CustomScenarioDef;
  fixes: string[];
  changedCount: number;
} {
  const roads = (def.roads ?? []).filter((r) => r.id !== "custom-lot" && r.points.length >= 2);
  if (roads.length === 0) {
    return { def, fixes: [], changedCount: 0 };
  }

  const roadIndex = new RoadCorridorIndex(roads, true);
  const fixes: string[] = [];
  let changedCount = 0;

  // 1. Отключаем прямоугольную/полигональную площадку автодрома, если карта представляет реальную сеть улиц
  let nextUseLot = def.useLotSurface;
  if (def.useLotSurface !== false && (def.mapMeta || (roads.length >= 2 && def.bays.length === 0))) {
    nextUseLot = false;
    changedCount += 1;
    fixes.push("Отключена подложка площадки поверх реальной дорожной сети.");
  }

  // 2. Препятствия: здания ужимаем, заборы/бордюры прорезаем по улицам, деревья/столбы/конусы выносим на обочину
  const nextObstacles = [] as CustomScenarioDef["obstacles"];
  let adjustedBld = 0;
  let openedBar = 0;
  let movedPts = 0;

  for (const obs of def.obstacles) {
    if (obs.kind === "building") {
      const res = retractObstacleFromRoads(obs, roadIndex, 0.45, 2.0);
      if (res.changed) {
        adjustedBld += 1;
        changedCount += 1;
      }
      if (res.obstacle) nextObstacles.push(res.obstacle);
    } else if (obs.kind === "fence" || obs.kind === "curb") {
      const fx = Math.sin(obs.h);
      const fz = Math.cos(obs.h);
      const a: Vec2 = { x: obs.cx - fx * obs.halfZ, z: obs.cz - fz * obs.halfZ };
      const b: Vec2 = { x: obs.cx + fx * obs.halfZ, z: obs.cz + fz * obs.halfZ };
      const margin = obs.kind === "curb" ? 0.25 : 0.55;
      const clipped = clipPolylineOutsideRoads([a, b], roadIndex, { roadClearanceM: margin, minPieceLenM: 0.9 });
      if (clipped.cutCount === 0) {
        nextObstacles.push(obs);
      } else {
        openedBar += 1;
        changedCount += 1;
        clipped.pieces.forEach((piece, pIdx) => {
          const p0 = piece[0];
          const p1 = piece[piece.length - 1];
          const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
          if (len < 0.9) return;
          nextObstacles.push({
            ...obs,
            id: pIdx === 0 ? obs.id : `${obs.id}-s${pIdx + 1}`,
            cx: round2((p0.x + p1.x) * 0.5),
            cz: round2((p0.z + p1.z) * 0.5),
            halfZ: round2(len * 0.5),
          });
        });
      }
    } else if (obs.kind === "tree" || obs.kind === "pole" || obs.kind === "cone" || obs.kind === "island") {
      const res = deconflictPointObstacle(obs, roadIndex);
      if (res.changed) {
        movedPts += 1;
        changedCount += 1;
      }
      if (res.obstacle) nextObstacles.push(res.obstacle);
    } else {
      nextObstacles.push(obs);
    }
  }

  if (adjustedBld > 0) fixes.push(`Ужато/убрано зданий с проезжей части: ${adjustedBld}.`);
  if (openedBar > 0) fixes.push(`Открыто проездов в ограждениях и бордюрах: ${openedBar}.`);
  if (movedPts > 0) fixes.push(`Вынесено объектов с полос на обочину: ${movedPts}.`);

  // 3. Стойки дорожных знаков — с проезжей части на правую обочину
  let movedSigns = 0;
  const nextSigns = (def.signs ?? []).map((s) => {
    const res = placeSignPostClearOfRoads(s, roadIndex);
    if (res.shifted) {
      movedSigns += 1;
      changedCount += 1;
    }
    return res.sign;
  });
  if (movedSigns > 0) fixes.push(`Вынесено стоек знаков на обочину: ${movedSigns}.`);

  const base: CustomScenarioDef = {
    ...def,
    useLotSurface: nextUseLot,
    obstacles: nextObstacles,
    signs: nextSigns,
  };

  // 4. Согласуем старт и контрольные точки с дорогами, границей и `oneway`
  const routeFix = autoFixScenarioRoute(base);
  if (routeFix.fixes.length > 0) {
    changedCount += routeFix.fixes.length;
    fixes.push(...routeFix.fixes);
  }

  return { def: routeFix.def, fixes, changedCount };
}

/**
 * Бесконфликтно обновляет реальную карту OSM, сохраняя расставленные инструктором парковочные боксы,
 * ручные дорожные знаки и контрольные точки с точным перепроецированием по WGS84 (`mapMeta.origin`).
 */
export function mergeUserObjectsOntoOsmMap(
  prevDef: CustomScenarioDef,
  importedDef: CustomScenarioDef
): { def: CustomScenarioDef; keptBays: number; keptSigns: number; keptCheckpoints: number; reprojected: boolean } {
  const fromOrigin = prevDef.mapMeta?.origin;
  const toOrigin = importedDef.mapMeta?.origin;
  const canReproject = Boolean(fromOrigin && toOrigin);
  let reprojected = false;

  const mapPt = (pt: Vec2): Vec2 | null => {
    if (fromOrigin && toOrigin) {
      const rp = reprojectBetweenOrigins(pt, fromOrigin, toOrigin);
      if (!rp) return null;
      if (Math.hypot(rp.x - pt.x, rp.z - pt.z) > 0.05) reprojected = true;
      return rp;
    }
    // Если прежняя сцена тоже была с привязкой к другой области — не смешиваем несовместимые карты
    if (prevDef.mapMeta && !fromOrigin) return pt;
    return pt;
  };

  const poly = isValidBoundaryPolygon(importedDef.boundaryPolygon) ? importedDef.boundaryPolygon : undefined;
  const inside = (p: Vec2) => isInsideWorldBoundary(p.x, p.z, importedDef.bounds, poly);
  const roads = importedDef.roads ?? [];
  const roadIndex = new RoadCorridorIndex(roads, true);
  const bldGrid = new SpatialGrid(importedDef.obstacles, 10);

  // Сохраняем пользовательские боксы, попавшие в новую карту и не врезающиеся в реальные здания OSM
  const keptBays: ParkingBay[] = [];
  for (const b of prevDef.bays) {
    const p = mapPt({ x: b.cx, z: b.cz });
    if (!p || !inside(p)) continue;
    if (bldGrid.queryCarHit(p.x, p.z, b.h).hit) continue;
    keptBays.push({ ...b, cx: round2(p.x), cz: round2(p.z) });
  }

  // Сохраняем только добавленные вручную знаки (не авто-импортированные `sign-way-*` / `gj-sign-*`), без дублей
  const baseSigns = [...(importedDef.signs ?? [])];
  let keptSignsCount = 0;
  for (const s of prevDef.signs ?? []) {
    const isOsmSign =
      s.id.startsWith("sign-way-") ||
      s.id.startsWith("gj-sign-") ||
      /^sign-\d+$/.test(s.id) ||
      s.id.startsWith("sign-gj-");
    if (isOsmSign) continue;
    const p = mapPt({ x: s.x, z: s.z });
    if (!p || !inside(p)) continue;
    const zPt =
      s.zoneX !== undefined && s.zoneZ !== undefined ? mapPt({ x: s.zoneX, z: s.zoneZ }) : undefined;
    const relocated = {
      ...s,
      x: round2(p.x),
      z: round2(p.z),
      ...(zPt ? { zoneX: round2(zPt.x), zoneZ: round2(zPt.z) } : {}),
    };
    const { sign: cleanSign } = placeSignPostClearOfRoads(relocated, roadIndex);
    const dup = baseSigns.some(
      (ex) => ex.kind === cleanSign.kind && Math.hypot(ex.x - cleanSign.x, ex.z - cleanSign.z) < 5
    );
    if (!dup) {
      baseSigns.push(cleanSign);
      keptSignsCount += 1;
    }
  }

  // Сохраняем пользовательские КТ, если они попадают на реальные улицы обновлённой карты
  const candidateCps: RouteCheckpoint[] = [];
  for (const cp of prevDef.checkpoints) {
    const isAutoRoute = cp.id.startsWith("route-");
    if (isAutoRoute && !canReproject) continue;
    const p = mapPt({ x: cp.x, z: cp.z });
    if (!p || !inside(p)) continue;
    const snap = roads.length > 0 ? nearestRoadPoint(p.x, p.z, roads) : null;
    if (snap && snap.dist <= snap.road.width * 0.65 + cp.radius + 4) {
      // Мягко привязываем КТ к обновлённой геометрии улицы
      const onRoad = snap.dist > snap.road.width * 0.55;
      candidateCps.push({
        ...cp,
        x: round2(onRoad ? snap.x : p.x),
        z: round2(onRoad ? snap.z : p.z),
      });
    }
  }

  const useKeptRoute = candidateCps.length >= 1;
  let nextStart = importedDef.start;
  if (useKeptRoute) {
    const sp = mapPt({ x: prevDef.start.x, z: prevDef.start.z });
    if (sp && inside(sp) && !bldGrid.queryCarHit(sp.x, sp.z, prevDef.start.h).hit) {
      nextStart = { x: round2(sp.x), z: round2(sp.z), h: prevDef.start.h };
    }
  }

  const mergedBase: CustomScenarioDef = {
    ...importedDef,
    title: prevDef.mapMeta ? prevDef.title : importedDef.title,
    start: nextStart,
    bays: keptBays,
    signs: baseSigns,
    checkpoints: useKeptRoute ? candidateCps : importedDef.checkpoints,
  };

  const fixed = useKeptRoute ? autoFixScenarioRoute(mergedBase).def : mergedBase;
  return {
    def: fixed,
    keptBays: keptBays.length,
    keptSigns: keptSignsCount,
    keptCheckpoints: useKeptRoute ? fixed.checkpoints.length : 0,
    reprojected,
  };
}

/** Подгоняет точные (неквадратные!) границы `bounds` по всем объектам карты с отступом `pad` метров. */
export function fitBoundsToContent(def: CustomScenarioDef, pad = 12): CustomScenarioDef {
  if (isValidBoundaryPolygon(def.boundaryPolygon)) {
    return { ...def, bounds: boundingBoxOfPolygon(def.boundaryPolygon, 0) };
  }

  let minX = def.start.x;
  let maxX = def.start.x;
  let minZ = def.start.z;
  let maxZ = def.start.z;

  const include = (x: number, z: number, rx = 0, rz = rx) => {
    if (x - rx < minX) minX = x - rx;
    if (x + rx > maxX) maxX = x + rx;
    if (z - rz < minZ) minZ = z - rz;
    if (z + rz > maxZ) maxZ = z + rz;
  };

  if (def.useLotSurface !== false) {
    include(0, 0, Math.max(def.lotHalfX, 6), Math.max(def.lotHalfZ, 6));
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
      minX: Math.max(-MAX_WORLD_COORD, Math.floor(minX - pad)),
      maxX: Math.min(MAX_WORLD_COORD, Math.ceil(maxX + pad)),
      minZ: Math.max(-MAX_WORLD_COORD, Math.floor(minZ - pad)),
      maxZ: Math.min(MAX_WORLD_COORD, Math.ceil(maxZ + pad)),
    },
  };
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
