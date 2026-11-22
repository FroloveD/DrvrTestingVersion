/**
 * @module components/MapCanvasEditor
 * @layer ui
 * @role Интерактивный 2D-холст редактора карт: зум, панорама, сетка, слои, размещение кликом, drag-and-drop перенос и поворот объектов.
 * @invariants #1 (проекция sx = −x, sy = −z: +Z север вверх, +X влево, +h против часовой), #8 (чистый SVG без внешних тайлов).
 * @tests Смоук A, G, O (`tests/browser-smoke.mjs`); логика — T28, T29
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSimplePolygon, polygonArea } from "../maps/boundary";
import { nextRoadId, type CustomScenarioDef } from "../scenarios/custom";
import { roadGeometryPoints } from "../maps/route";
import {
  fitBoundsToContent,
  getSelectionAnchor,
  moveSelected,
  normalizeAngleRad,
  placeObjectAt,
  primarySelection,
  setSelectedHeading,
  snapCoord,
  type EditorArea,
  type EditorSelection,
  type EditorTool,
  type PlaceOptions,
} from "../scenarios/editorOps";
import { createDefaultRoad, formatSignBadge, getObstacleSpec, getRoadSignSpec, isSpeedSignKind } from "../scenarios/signs";
import type { RoadSignDef, Vec2 } from "../sim/types";

export type LayerVisibility = {
  roads: boolean;
  bays: boolean;
  obstacles: boolean;
  crosswalks: boolean;
  signals: boolean;
  signs: boolean;
  zones: boolean;
  checkpoints: boolean;
};

export const DEFAULT_LAYERS: LayerVisibility = {
  roads: true,
  bays: true,
  obstacles: true,
  crosswalks: true,
  signals: true,
  signs: true,
  zones: true,
  checkpoints: true,
};

type ViewBox = { x: number; y: number; w: number; h: number };

type DragState =
  | {
      mode: "move";
      selection: EditorSelection;
      offsetX: number;
      offsetZ: number;
      moved: boolean;
      before: CustomScenarioDef;
    }
  | {
      mode: "rotate";
      selection: EditorSelection;
      anchorX: number;
      anchorZ: number;
      moved: boolean;
      before: CustomScenarioDef;
    }
  | {
      mode: "lot_move";
      offsetX: number;
      offsetZ: number;
      moved: boolean;
      before: CustomScenarioDef;
    }
  | {
      mode: "lot_resize";
      fixedX: number;
      fixedZ: number;
      moved: boolean;
      before: CustomScenarioDef;
    }
  | {
      mode: "delete_area";
      startX: number;
      startZ: number;
      currentX: number;
      currentZ: number;
      moved: boolean;
    }
  | {
      mode: "pan";
      startClientX: number;
      startClientY: number;
      startVb: ViewBox;
    };

type Props = {
  def: CustomScenarioDef;
  tool: EditorTool;
  selection: EditorSelection | null;
  snapStep: number;
  layers: LayerVisibility;
  placeOptions: PlaceOptions;
  draftBoundary: Vec2[];
  onDraftBoundaryChange: (points: Vec2[]) => void;
  onFinishBoundary: (points: Vec2[]) => void;
  onCancelBoundary: () => void;
  /** Счётчик внешнего запроса «Вписать карту в экран» (при импорте или смене шаблона). */
  fitSignal: number;
  /** Счётчик внешнего запроса центрирования карты на выбранном объекте. */
  focusSignal: number;
  areaSelection: EditorArea | null;
  onAreaSelection: (area: EditorArea | null) => void;
  multiSelection: EditorSelection[];
  onMultiSelection: (items: EditorSelection[]) => void;
  onSelect: (sel: EditorSelection | null) => void;
  /** Плавное обновление во время перетаскивания (без записи каждого кадра в историю). */
  onLiveChange: (next: CustomScenarioDef) => void;
  /** Фиксация завершённого действия в стек Undo (`before` — состояние до начала жеста). */
  onCommitChange: (next: CustomScenarioDef, before: CustomScenarioDef) => void;
};

function computeFitViewBox(bounds: CustomScenarioDef["bounds"]): ViewBox {
  const pad = Math.max(4, Math.min(20, Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.06));
  const w = Math.max(14, bounds.maxX - bounds.minX + pad * 2);
  const h = Math.max(14, bounds.maxZ - bounds.minZ + pad * 2);
  return {
    x: -bounds.maxX - pad,
    y: -bounds.maxZ - pad,
    w,
    h,
  };
}

/**
 * Вычисляет шаг визуальной сетки от пользовательского шага привязки:
 * - snapStep <= 0 полностью скрывает сетку;
 * - на обычном масштабе линии совпадают с шагом привязки;
 * - на больших OSM-картах линии прореживаются кратно шагу, чтобы не перегружать SVG.
 */
function resolveVisualGridStep(snapStep: number, viewW: number, viewH: number): number | null {
  if (!(snapStep > 0)) return null;
  const maxSpan = Math.max(viewW, viewH);
  const maxCells = 160;
  if (maxSpan / snapStep <= maxCells) return snapStep;
  for (const mult of [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]) {
    const candidate = Number((snapStep * mult).toFixed(4));
    if (maxSpan / candidate <= maxCells) return candidate;
  }
  return Number((snapStep * 5000).toFixed(4));
}

function formatMetersRu(value: number): string {
  return Number(value.toFixed(2)).toString().replace(".", ",");
}

/** Отрисовка миниатюры дорожного знака в масштабе карты (`unit` — радиус знака в метрах SVG). */
function SignGlyph({ sign, unit, selected }: { sign: RoadSignDef; unit: number; selected: boolean }) {
  const spec = getRoadSignSpec(sign.kind);
  const badge = formatSignBadge(sign);
  const strokeW = unit * 0.22;
  const deg = (-sign.h * 180) / Math.PI;
  // Короткий штрих показывает направление потока, для которого действует знак
  const dirTipY = -unit * 1.55;

  return (
    <g>
      {selected && (
        <circle
          r={unit * 1.48}
          fill="rgba(245,185,66,0.18)"
          stroke="#f5b942"
          strokeWidth={unit * 0.16}
        />
      )}
      <g transform={`rotate(${deg})`}>
        <line x1={0} y1={-unit * 0.95} x2={0} y2={dirTipY} stroke="#f5b942" strokeWidth={unit * 0.16} />
        <circle cx={0} cy={dirTipY} r={unit * 0.18} fill="#f5b942" />
      </g>

      {spec.shape === "circle" && (
        <circle r={unit} fill={spec.bgColor} stroke={spec.borderColor} strokeWidth={strokeW} />
      )}
      {spec.shape === "octagon" && (
        <polygon
          points={Array.from({ length: 8 }, (_, i) => {
            const a = Math.PI / 8 + (i * Math.PI) / 4;
            return `${(Math.cos(a) * unit * 1.06).toFixed(2)},${(Math.sin(a) * unit * 1.06).toFixed(2)}`;
          }).join(" ")}
          fill={spec.bgColor}
          stroke={spec.borderColor}
          strokeWidth={strokeW * 0.7}
        />
      )}
      {spec.shape === "triangle_down" && (
        <polygon
          points={`${-unit * 1.05},${-unit * 0.82} ${unit * 1.05},${-unit * 0.82} 0,${unit * 1.12}`}
          fill={spec.bgColor}
          stroke={spec.borderColor}
          strokeWidth={strokeW}
          strokeLinejoin="round"
        />
      )}
      {spec.shape === "diamond" && (
        <rect
          x={-unit * 0.78}
          y={-unit * 0.78}
          width={unit * 1.56}
          height={unit * 1.56}
          transform="rotate(45)"
          fill={spec.bgColor}
          stroke={spec.borderColor}
          strokeWidth={strokeW * 0.85}
        />
      )}
      {(spec.shape === "square" || spec.shape === "rect") && (
        <rect
          x={-unit * 0.95}
          y={-unit * (spec.shape === "rect" ? 0.82 : 0.95)}
          width={unit * 1.9}
          height={unit * (spec.shape === "rect" ? 1.64 : 1.9)}
          rx={unit * 0.22}
          fill={spec.bgColor}
          stroke={spec.borderColor}
          strokeWidth={strokeW * 0.7}
        />
      )}

      {spec.shape !== "triangle_down" && spec.shape !== "diamond" && (
        <text
          x={0}
          y={unit * 0.08}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={badge.length >= 4 ? unit * 0.56 : badge.length === 3 ? unit * 0.68 : unit * 0.95}
          fontWeight={800}
          fill={spec.textColor}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {badge}
        </text>
      )}
    </g>
  );
}

const TOOL_HINTS: Record<EditorTool, string> = {
  select: "Площадка: перетаскивание — перенос · объекты — перенос · Ctrl+клик — мультивыбор · пустое место — панорама",
  boundary: "Кликайте, чтобы построить контур площадки; Enter или двойной клик — завершить, Esc — отменить",
  pan: "Зажмите кнопку мыши (или палец) и перетаскивайте карту · колесо — масштаб",
  delete_area: "Зажмите левую кнопку и выделите прямоугольную область. Затем удалите отмеченные объекты кнопкой над картой",
  start: "Кликните по карте, чтобы перенести стартовую позицию автомобиля",
  sign: "Кликните по карте, чтобы установить выбранный дорожный знак (затем можно сразу перетащить)",
  signal: "Кликните по карте, чтобы поставить светофор со стоп-линией 1.12",
  crosswalk: "Кликните по карте, чтобы добавить пешеходный переход «зебра» с пешеходом",
  road: "Кликайте по карте, чтобы последовательно добавить узлы дороги · двойной клик или Enter — завершить · Esc — отменить",
  bay: "Кликните по карте, чтобы разместить парковочный бокс или параллельный карман",
  obstacle: "Кликните по карте, чтобы поставить выбранное препятствие или объект окружения",
  checkpoint: "Кликните по карте, чтобы добавить очередную контрольную точку маршрута (КТ)",
};

export function MapCanvasEditor({
  def,
  tool,
  selection,
  snapStep,
  layers,
  placeOptions,
  fitSignal,
  focusSignal,
  areaSelection,
  onAreaSelection,
  multiSelection,
  onMultiSelection,
  onSelect,
  onLiveChange,
  onCommitChange,
  draftBoundary, onDraftBoundaryChange, onFinishBoundary, onCancelBoundary,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const defRef = useRef<CustomScenarioDef>(def);
  defRef.current = def;

  const [vb, setVb] = useState<ViewBox>(() => computeFitViewBox(def.bounds));
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [lotSelected, setLotSelected] = useState(false);
  const [roadDraftPoints, setRoadDraftPoints] = useState<Array<{ x: number; z: number }>>([]);
  const [areaDraft, setAreaDraft] = useState<EditorArea | null>(null);

  useEffect(() => {
    setVb(computeFitViewBox(def.bounds));
    // Пересчитываем кадр только по явному сигналу (импорт, шаблон, кнопка «Вписать»)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Адаптивный размер маркеров и обводок (хорошо читается и на площадке 30 м, и на квартале 400 м)
  const scale = useMemo(() => Math.max(vb.w, vb.h) / 56, [vb.w, vb.h]);
  const signUnit = Math.max(0.75, Math.min(4.2, scale * 1.15));
  const thin = Math.max(0.09, scale * 0.14);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; z: number; sx: number; sy: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      // Учитываем preserveAspectRatio="xMidYMid meet" (letterbox по краям прямоугольного SVG)
      const scalePx = Math.min(rect.width / vb.w, rect.height / vb.h);
      const drawnW = vb.w * scalePx;
      const drawnH = vb.h * scalePx;
      const padX = (rect.width - drawnW) / 2;
      const padY = (rect.height - drawnH) / 2;
      const sx = vb.x + (clientX - rect.left - padX) / scalePx;
      const sy = vb.y + (clientY - rect.top - padY) / scalePx;
      return { x: Number((-sx).toFixed(2)), z: Number((-sy).toFixed(2)), sx, sy };
    },
    [vb]
  );

  const zoomBy = useCallback((factor: number, focusSx?: number, focusSy?: number) => {
    setVb((prev) => {
      const nw = Math.max(8, Math.min(1500, prev.w * factor));
      const nh = Math.max(8, Math.min(1500, prev.h * factor));
      const cx = focusSx ?? prev.x + prev.w / 2;
      const cy = focusSy ?? prev.y + prev.h / 2;
      const rx = (cx - prev.x) / prev.w;
      const ry = (cy - prev.y) / prev.h;
      return {
        x: cx - nw * rx,
        y: cy - nh * ry,
        w: nw,
        h: nh,
      };
    });
  }, []);

  // React может регистрировать wheel-обработчики как passive: preventDefault()
  // тогда не отменяет прокрутку документа. Нативный listener с passive:false
  // гарантированно оставляет колесо мыши внутри карты.
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const pt = clientToWorld(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.16 : 1 / 1.16;
      zoomBy(factor, pt?.sx, pt?.sy);
    },
    [clientToWorld, zoomBy]
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const fitView = useCallback(() => {
    setVb(computeFitViewBox(def.bounds));
  }, [def.bounds]);

  const centerOnSelection = useCallback(() => {
    const anchor = getSelectionAnchor(def, selection);
    if (!anchor) return;
    setVb((prev) => ({
      ...prev,
      x: -anchor.x - prev.w / 2,
      y: -anchor.z - prev.h / 2,
    }));
  }, [def, selection]);

  useEffect(() => {
    if (focusSignal > 0) centerOnSelection();
  }, [centerOnSelection, focusSignal]);

  const beginLotMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.button !== 0 || tool !== "select") return;
    e.stopPropagation();
    const pt = clientToWorld(e.clientX, e.clientY);
    if (!pt) return;
    setLotSelected(true);
    onSelect(null);
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "lot_move",
      offsetX: (def.lotCenterX ?? 0) - pt.x,
      offsetZ: (def.lotCenterZ ?? 0) - pt.z,
      moved: false,
      before: def,
    };
  };

  const beginLotResize = (e: React.PointerEvent<SVGCircleElement>, cornerX: number, cornerZ: number) => {
    if (e.button !== 0 || tool !== "select") return;
    e.stopPropagation();
    const cx = def.lotCenterX ?? 0;
    const cz = def.lotCenterZ ?? 0;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "lot_resize",
      fixedX: cx - cornerX * def.lotHalfX,
      fixedZ: cz - cornerZ * def.lotHalfZ,
      moved: false,
      before: def,
    };
  };

  const beginObjectDrag = (e: React.PointerEvent, target: EditorSelection) => {
    if (e.button === 1 || tool === "pan") return;
    setLotSelected(false);
    // В режиме границы разрешаем перемещать только вершины контура.
    if (tool !== "select" && !(tool === "boundary" && target.kind === "boundary_point")) return;
    e.stopPropagation();
    const pt = clientToWorld(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) {
      const exists = multiSelection.some((item) => item.kind === target.kind && "id" in item && "id" in target && item.id === target.id);
      onMultiSelection(exists
        ? multiSelection.filter((item) => !(item.kind === target.kind && "id" in item && "id" in target && item.id === target.id))
        : [...multiSelection, target]);
      onSelect(null);
      return;
    }
    const memberGroup = (def.groups ?? []).find((group) => group.members.some((member) => member.kind === target.kind && "id" in member && "id" in target && member.id === target.id));
    const dragTarget: EditorSelection = memberGroup ? { kind: "group", id: memberGroup.id } : target;
    onMultiSelection([]);
    onSelect(dragTarget);
    const anchor = getSelectionAnchor(def, dragTarget);
    if (!pt || !anchor) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "move",
      selection: dragTarget,
      offsetX: anchor.x - pt.x,
      offsetZ: anchor.z - pt.z,
      moved: false,
      before: def,
    };
  };

  const beginRotateDrag = (e: React.PointerEvent) => {
    const primary = primarySelection(selection);
    const anchor = getSelectionAnchor(def, primary);
    if (!primary || !anchor || anchor.h === null) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "rotate",
      selection: primary,
      anchorX: anchor.x,
      anchorZ: anchor.z,
      moved: false,
      before: def,
    };
  };

  const finishRoadDraft = useCallback(() => {
    const points = roadDraftPoints;
    if (points.length < 2) return;
    const before = defRef.current;
    const id = nextRoadId(before);
    const base = createDefaultRoad(id, points[0].x, points[0].z);
    const road = { ...base, points: points.map((p) => ({ ...p })), width: placeOptions.roadWidth ?? 7.5, cornerRadiusM: placeOptions.cornerRadiusM ?? 0 };
    const next = fitBoundsToContent({ ...before, roads: [...(before.roads ?? []), road] });
    onCommitChange(next, before);
    onSelect({ kind: "road", id });
    setRoadDraftPoints([]);
  }, [onCommitChange, onSelect, placeOptions.cornerRadiusM, placeOptions.roadWidth, roadDraftPoints]);

  useEffect(() => {
    if (tool !== "road" || roadDraftPoints.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); finishRoadDraft(); }
      if (e.key === "Escape") { e.preventDefault(); setRoadDraftPoints([]); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finishRoadDraft, roadDraftPoints.length, tool]);

  const handleCanvasClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (tool === "boundary") return;
    if (tool !== "road") return;
    const pt = clientToWorld(e.clientX, e.clientY);
    if (!pt) return;
    const next = { x: snapCoord(pt.x, snapStep), z: snapCoord(pt.z, snapStep) };
    setRoadDraftPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.hypot(last.x - next.x, last.z - next.z) < 0.5) return prev;
      return [...prev, next];
    });
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (tool === "boundary" && draftBoundary.length >= 3) { e.preventDefault(); onFinishBoundary(draftBoundary); }
    else finishRoadDraft();
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "road") return;
    const pt = clientToWorld(e.clientX, e.clientY);
    if (!pt) return;

    // Средняя кнопка, инструмент «Панорама» или Shift+перетаскивание — панорамирование
    if (e.button === 1 || tool === "pan") {
      e.preventDefault();
      svgRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = {
        mode: "pan",
        startClientX: e.clientX,
        startClientY: e.clientY,
        startVb: vb,
      };
      return;
    }

    if (e.button !== 0) return;

    if (tool === "delete_area") {
      e.preventDefault();
      onSelect(null);
      onAreaSelection(null);
      setAreaDraft({ minX: pt.x, maxX: pt.x, minZ: pt.z, maxZ: pt.z });
      svgRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = { mode: "delete_area", startX: pt.x, startZ: pt.z, currentX: pt.x, currentZ: pt.z, moved: false };
      return;
    }

    if (tool === "boundary") {
      const bx = snapStep > 0 ? snapCoord(pt.x, snapStep) : Number(pt.x.toFixed(2));
      const bz = snapStep > 0 ? snapCoord(pt.z, snapStep) : Number(pt.z.toFixed(2));
      if (draftBoundary.length >= 3 && Math.hypot(bx - draftBoundary[0].x, bz - draftBoundary[0].z) <= Math.max(1.8, signUnit * 1.45)) {
        onFinishBoundary(draftBoundary); return;
      }
      const last = draftBoundary[draftBoundary.length - 1];
      if (!last || Math.hypot(bx - last.x, bz - last.z) >= 0.4) onDraftBoundaryChange([...draftBoundary, { x: bx, z: bz }]);
      return;
    }

    if (tool === "select") {
      setLotSelected(false);
      onSelect(null);
      svgRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = {
        mode: "pan",
        startClientX: e.clientX,
        startClientY: e.clientY,
        startVb: vb,
      };
      return;
    }

    // Размещение нового объекта в точке клика (сразу можно потянуть в нужное место)
    const before = def;
    const placed = placeObjectAt(def, tool, pt.x, pt.z, {
      ...placeOptions,
      snapStep,
    });
    onCommitChange(placed.def, before);
    onSelect(placed.selection);
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "move",
      selection: placed.selection,
      offsetX: 0,
      offsetZ: 0,
      moved: false,
      before: placed.def,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = clientToWorld(e.clientX, e.clientY);
    if (pt) {
      setCursor({
        x: snapStep > 0 ? snapCoord(pt.x, snapStep) : Number(pt.x.toFixed(1)),
        z: snapStep > 0 ? snapCoord(pt.z, snapStep) : Number(pt.z.toFixed(1)),
      });
    }

    const drag = dragRef.current;
    if (!drag) return;

    if (drag.mode === "delete_area") {
      const next = { minX: Math.min(drag.startX, pt.x), maxX: Math.max(drag.startX, pt.x), minZ: Math.min(drag.startZ, pt.z), maxZ: Math.max(drag.startZ, pt.z) };
      drag.currentX = pt.x;
      drag.currentZ = pt.z;
      drag.moved = Math.hypot(pt.x - drag.startX, pt.z - drag.startZ) >= 0.5;
      setAreaDraft(next);
      return;
    }

    if (drag.mode === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scalePx = Math.min(rect.width / drag.startVb.w, rect.height / drag.startVb.h);
      const dx = (e.clientX - drag.startClientX) / scalePx;
      const dy = (e.clientY - drag.startClientY) / scalePx;
      setVb({
        ...drag.startVb,
        x: drag.startVb.x - dx,
        y: drag.startVb.y - dy,
      });
      return;
    }

    if (!pt) return;

    if (drag.mode === "lot_move") {
      const next = {
        ...defRef.current,
        lotCenterX: snapCoord(pt.x + drag.offsetX, snapStep),
        lotCenterZ: snapCoord(pt.z + drag.offsetZ, snapStep),
      };
      drag.moved = true;
      onLiveChange(next);
      return;
    }

    if (drag.mode === "lot_resize") {
      const x = snapCoord(pt.x, snapStep);
      const z = snapCoord(pt.z, snapStep);
      const dx = x - drag.fixedX;
      const dz = z - drag.fixedZ;
      const next = {
        ...defRef.current,
        lotCenterX: Number(((x + drag.fixedX) / 2).toFixed(2)),
        lotCenterZ: Number(((z + drag.fixedZ) / 2).toFixed(2)),
        lotHalfX: Math.max(5, Number((Math.abs(dx) / 2).toFixed(2))),
        lotHalfZ: Math.max(5, Number((Math.abs(dz) / 2).toFixed(2))),
      };
      drag.moved = true;
      onLiveChange(next);
      return;
    }

    if (drag.mode === "move") {
      const next = moveSelected(
        defRef.current,
        drag.selection,
        pt.x + drag.offsetX,
        pt.z + drag.offsetZ,
        snapStep
      );
      drag.moved = true;
      onLiveChange(next);
      return;
    }

    if (drag.mode === "rotate") {
      const dx = pt.x - drag.anchorX;
      const dz = pt.z - drag.anchorZ;
      if (Math.hypot(dx, dz) < 0.25) return;
      let rawH = Math.atan2(dx, dz);
      if (snapStep > 0) {
        const stepRad = (5 * Math.PI) / 180;
        rawH = Math.round(rawH / stepRad) * stepRad;
      }
      const next = setSelectedHeading(defRef.current, drag.selection, normalizeAngleRad(rawH));
      drag.moved = true;
      onLiveChange(next);
    }
  };

  const endPointerDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      if (svgRef.current?.hasPointerCapture?.(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId);
      }
    } catch {
      // указатель уже освобождён
    }
    if (drag?.mode === "delete_area") {
      const area = { minX: Math.min(drag.startX, drag.currentX), maxX: Math.max(drag.startX, drag.currentX), minZ: Math.min(drag.startZ, drag.currentZ), maxZ: Math.max(drag.startZ, drag.currentZ) };
      setAreaDraft(null);
      if (drag.moved) onAreaSelection(area);
    }
    if (drag && (drag.mode === "move" || drag.mode === "rotate" || drag.mode === "lot_move" || drag.mode === "lot_resize") && drag.moved) {
      onCommitChange(defRef.current, drag.before);
    }
  };

  // Визуальная сетка синхронизирована с выбранным шагом привязки.
  const gridStep = useMemo(() => resolveVisualGridStep(snapStep, vb.w, vb.h), [snapStep, vb.w, vb.h]);
  const gridLines = useMemo(() => {
    if (gridStep === null) {
      return { xs: [] as number[], ys: [] as number[], majorEvery: 5, x0: vb.x, x1: vb.x + vb.w, y0: vb.y, y1: vb.y + vb.h };
    }
    // Запас по краям сохраняет равномерную сетку при широком SVG и letterbox.
    const padX = Math.max(vb.w, vb.h) * 1.1;
    const padY = Math.max(vb.w, vb.h) * 0.6;
    const x0 = vb.x - padX;
    const x1 = vb.x + vb.w + padX;
    const y0 = vb.y - padY;
    const y1 = vb.y + vb.h + padY;
    const xs: number[] = [];
    const ys: number[] = [];
    const firstI = Math.floor(x0 / gridStep);
    const lastI = Math.ceil(x1 / gridStep);
    for (let i = firstI; i <= lastI && xs.length < 480; i++) {
      xs.push(Number((i * gridStep).toFixed(4)));
    }
    const firstJ = Math.floor(y0 / gridStep);
    const lastJ = Math.ceil(y1 / gridStep);
    for (let j = firstJ; j <= lastJ && ys.length < 360; j++) {
      ys.push(Number((j * gridStep).toFixed(4)));
    }
    return { xs, ys, majorEvery: 5, x0, x1, y0, y1 };
  }, [vb, gridStep]);
  const gridBadgeText = useMemo(() => {
    if (gridStep === null) return "сетка выкл";
    if (Math.abs(gridStep - snapStep) < 1e-6) return `сетка ${formatMetersRu(snapStep)} м`;
    return `привязка ${formatMetersRu(snapStep)} м (линии ${formatMetersRu(gridStep)} м)`;
  }, [gridStep, snapStep]);

  const primary = primarySelection(selection);
  const rotAnchor = getSelectionAnchor(def, primary);
  const rotDist = Math.max(2.6, scale * 3.6);
  const rotHandle =
    rotAnchor && rotAnchor.h !== null
      ? {
          ax: -rotAnchor.x,
          ay: -rotAnchor.z,
          hx: -(rotAnchor.x + Math.sin(rotAnchor.h) * rotDist),
          hy: -(rotAnchor.z + Math.cos(rotAnchor.h) * rotDist),
        }
      : null;

  const isSelected = (k: EditorSelection["kind"], id?: string | number): boolean => {
    if (multiSelection.some((item) => item.kind === k && ("id" in item ? item.id === id : false))) return true;
    if (primary?.kind === "group") {
      const group = (def.groups ?? []).find((item) => item.id === primary.id);
      if (group?.members.some((member) => member.kind === k && member.id === id)) return true;
    }
    if (!primary || primary.kind !== k) return false;
    if (k === "start") return true;
    return "id" in primary && primary.id === id;
  };

  const boundaryPoly = def.boundaryPolygon && def.boundaryPolygon.length >= 3 ? def.boundaryPolygon : null;
  const boundaryValid = boundaryPoly ? isSimplePolygon(boundaryPoly) && polygonArea(boundaryPoly) >= 25 : true;
  const roads = def.roads ?? [];
  const signs = def.signs ?? [];
  const signals = def.signals ?? [];
  const crosswalks = def.crosswalks ?? [];
  const startTipX = -(def.start.x + Math.sin(def.start.h) * Math.max(2.6, scale * 2.2));
  const startTipY = -(def.start.z + Math.cos(def.start.h) * Math.max(2.6, scale * 2.2));

  return (
    <div className="panel p-3 sm:p-4 space-y-2.5">
      {/* Верхняя полоса управления видом 2D-карты */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-extrabold">2D-карта редактора</span>
          <span className="mono text-[10px] text-[#7c909d]">
            {gridBadgeText} · ↑ север (+Z)
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="btn btn-mini"
            title="Приблизить карту"
            onClick={() => zoomBy(1 / 1.28)}
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-mini"
            title="Отдалить карту"
            onClick={() => zoomBy(1.28)}
          >
            −
          </button>
          <button
            type="button"
            className="btn btn-mini"
            title="Показать всю карту целиком"
            onClick={fitView}
          >
            Вписать
          </button>
          {rotAnchor && (
            <button
              type="button"
              className="btn btn-mini"
              title="Центрировать на выбранном объекте"
              onClick={centerOnSelection}
            >
              К объекту
            </button>
          )}
        </div>
      </div>

      {tool === "boundary" && <div className="flex items-center justify-between gap-2 rounded-lg border border-[#52d6bd]/30 bg-[#091017] px-3 py-2 text-[11px]"><span>Контур площадки: {draftBoundary.length} точек · кликните по карте, Enter или двойной клик — замкнуть</span><button type="button" className="btn btn-mini" onClick={onCancelBoundary}>Отмена</button></div>}
      {/* Интерактивный SVG-холст карты */}
      <div className="relative rounded-xl bg-[#070d13] border hairline overflow-hidden select-none">
        <svg
          ref={svgRef}
          data-testid="map-editor-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onPointerDown={handleCanvasPointerDown}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDoubleClick}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onPointerLeave={() => setCursor(null)}
          style={{ touchAction: "none", overscrollBehavior: "contain" }}
          className={`w-full h-[460px] sm:h-[520px] ${
            tool === "pan" ? "cursor-grab active:cursor-grabbing" : tool === "select" ? "cursor-default" : "cursor-crosshair"
          }`}
          role="img"
          aria-label="Интерактивная 2D-карта сценария"
        >
          {/* Метрическая сетка и привязка (скрывается при «СЕТКА: Выкл») */}
          {gridStep !== null && (
            <g data-testid="map-grid" data-grid-step={gridStep} data-snap-step={snapStep} style={{ pointerEvents: "none" }}>
              {gridLines.xs.map((gx) => {
                const isAxis = Math.abs(gx) < 1e-6;
                const isMajor = !isAxis && Math.abs(Math.round(gx / gridStep)) % gridLines.majorEvery === 0;
                return (
                  <line
                    key={`gx-${gx}`}
                    x1={gx}
                    y1={gridLines.y0}
                    x2={gx}
                    y2={gridLines.y1}
                    stroke={isAxis ? "rgba(82,214,189,0.32)" : isMajor ? "rgba(148,176,198,0.22)" : "rgba(148,176,198,0.1)"}
                    strokeWidth={isAxis ? thin * 1.15 : isMajor ? thin * 0.85 : thin * 0.6}
                  />
                );
              })}
              {gridLines.ys.map((gy) => {
                const isAxis = Math.abs(gy) < 1e-6;
                const isMajor = !isAxis && Math.abs(Math.round(gy / gridStep)) % gridLines.majorEvery === 0;
                return (
                  <line
                    key={`gy-${gy}`}
                    x1={gridLines.x0}
                    y1={gy}
                    x2={gridLines.x1}
                    y2={gy}
                    stroke={isAxis ? "rgba(82,214,189,0.32)" : isMajor ? "rgba(148,176,198,0.22)" : "rgba(148,176,198,0.1)"}
                    strokeWidth={isAxis ? thin * 1.15 : isMajor ? thin * 0.85 : thin * 0.6}
                  />
                );
              })}
            </g>
          )}

          {/* Границы мира или точный контур площадки */}
          {boundaryPoly ? <polygon data-testid="map-boundary-polygon" points={boundaryPoly.map(p => `${-p.x},${-p.z}`).join(" ")} fill={def.useLotSurface !== false ? "#19232e" : "rgba(15,25,35,0.42)"} stroke="#2b3c4d" strokeWidth={thin * 1.1} style={{ pointerEvents: "none" }} /> : <rect x={-def.bounds.maxX} y={-def.bounds.maxZ} width={def.bounds.maxX-def.bounds.minX} height={def.bounds.maxZ-def.bounds.minZ} fill="rgba(15,25,35,0.42)" stroke="#2b3c4d" strokeDasharray={`${scale*0.9} ${scale*0.7}`} strokeWidth={thin*1.1} style={{ pointerEvents: "none" }} />}

          {/* Базовая асфальтовая площадка автодрома */}
          {def.useLotSurface !== false && !boundaryPoly && (
            <g data-testid="map-lot-surface">
              <rect
                x={-(def.lotCenterX ?? 0) - def.lotHalfX}
                y={-(def.lotCenterZ ?? 0) - def.lotHalfZ}
                width={def.lotHalfX * 2}
                height={def.lotHalfZ * 2}
                fill={lotSelected ? "#31546a" : "#19232e"}
                fillOpacity={lotSelected ? 0.88 : 1}
                stroke={lotSelected ? "#f5b942" : "#2a3948"}
                strokeWidth={lotSelected ? thin * 2 : thin}
                data-center-x={def.lotCenterX ?? 0}
                data-center-z={def.lotCenterZ ?? 0}
                data-half-x={def.lotHalfX}
                data-half-z={def.lotHalfZ}
                className={tool === "select" ? "cursor-move" : undefined}
                onPointerDown={beginLotMove}
                onClick={(e) => { e.stopPropagation(); setLotSelected(true); }}
              />
              {lotSelected && tool === "select" && ([-1, 1] as const).flatMap((cx) => ([-1, 1] as const).map((cz) => (
                <circle
                  key={`lot-resize-${cx}-${cz}`}
                  data-testid={`map-lot-resize-${cx > 0 ? "e" : "w"}-${cz > 0 ? "n" : "s"}`}
                  cx={-(def.lotCenterX ?? 0) - cx * def.lotHalfX}
                  cy={-(def.lotCenterZ ?? 0) - cz * def.lotHalfZ}
                  r={Math.max(0.85, signUnit * 0.72)}
                  fill="#f5b942"
                  stroke="#101820"
                  strokeWidth={thin * 1.5}
                  className="cursor-nwse-resize"
                  onPointerDown={(e) => beginLotResize(e, cx, cz)}
                />
              )))}
            </g>
          )}

          {tool === "road" && roadDraftPoints.length > 0 && (
            <g data-testid="map-road-draft" pointerEvents="none">
              <polyline points={roadGeometryPoints(roadDraftPoints, placeOptions.cornerRadiusM ?? 0).map((p) => `${-p.x},${-p.z}`).join(" ")} fill="none" stroke="#52d6bd" strokeWidth={placeOptions.roadWidth ?? 7.5} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={0.55} />
              {roadDraftPoints.map((p, i) => <circle key={i} cx={-p.x} cy={-p.z} r={Math.max(0.55, signUnit * 0.55)} fill="#52d6bd" stroke="#0b1118" strokeWidth={thin} />)}
            </g>
          )}

          {(areaSelection || areaDraft) && (() => { const area = areaDraft ?? areaSelection!; return <rect data-testid="map-delete-area" x={-area.maxX} y={-area.maxZ} width={Math.max(0.05, area.maxX-area.minX)} height={Math.max(0.05, area.maxZ-area.minZ)} fill="rgba(248,113,113,0.16)" stroke="#f87171" strokeWidth={Math.max(0.25, thin*2)} strokeDasharray={`${scale*0.9} ${scale*0.55}`} pointerEvents="none" />; })()}

          {boundaryPoly && <g data-testid="map-boundary-overlay"><polygon points={boundaryPoly.map(p => `${-p.x},${-p.z}`).join(" ")} fill="none" stroke={boundaryValid ? "#f5b942" : "#ff6b6b"} strokeDasharray={`${scale} ${scale*0.6}`} strokeWidth={Math.max(0.24,thin*1.8)} />{boundaryPoly.map((p,i)=><circle key={i} cx={-p.x} cy={-p.z} r={Math.max(0.5,signUnit*0.45)} fill="#f5b942" stroke="#071018" strokeWidth={thin} className="cursor-move" onPointerDown={e=>beginObjectDrag(e,{kind:"boundary_point",index:i})} />)}</g>}
          {tool === "boundary" && draftBoundary.length > 0 && <polyline points={draftBoundary.map(p=>`${-p.x},${-p.z}`).join(" ")} fill="none" stroke="#52d6bd" strokeWidth={Math.max(0.25,thin*2)} strokeDasharray={`${scale} ${scale*0.5}`} />}
          {/* Сегменты дорог (импорт OSM и собственные) */}
          {layers.roads &&
            roads.map((r) => {
              const sel = isSelected("road", r.id);
              const pts = roadGeometryPoints(r.points, r.cornerRadiusM ?? 0).map((p) => `${-p.x},${-p.z}`).join(" ");
              return (
                <g key={r.id} data-testid={`map-road-${r.id}`} data-corner-radius={r.cornerRadiusM ?? 0}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={sel ? "#33475b" : "#222f3c"}
                    strokeWidth={r.width}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={tool === "select" ? "cursor-move" : undefined}
                    onPointerDown={(e) => beginObjectDrag(e, { kind: "road", id: r.id })}
                  />
                  {r.lanes >= 2 && (
                    <polyline
                      points={pts}
                      fill="none"
                      stroke="rgba(241,245,249,0.55)"
                      strokeWidth={Math.max(0.14, thin)}
                      strokeDasharray={r.hasSolidCenter ? undefined : `${scale * 0.9} ${scale * 0.9}`}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {sel && (
                    <polyline
                      points={pts}
                      fill="none"
                      stroke="#f5b942"
                      strokeWidth={Math.max(0.22, thin * 1.6)}
                      strokeDasharray={`${scale * 0.7} ${scale * 0.5}`}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {/* Перетаскиваемые узлы выбранной дороги */}
                  {sel &&
                    r.points.map((p, idx) => {
                      const ptSel =
                        selection?.kind === "road_point" &&
                        selection.id === r.id &&
                        selection.index === idx;
                      return (
                        <circle
                          key={`${r.id}-pt-${idx}`}
                          cx={-p.x}
                          cy={-p.z}
                          r={Math.max(0.55, signUnit * 0.55)}
                          fill={ptSel ? "#52d6bd" : "#f5b942"}
                          stroke="#0b1118"
                          strokeWidth={thin * 1.3}
                          className="cursor-move"
                          onPointerDown={(e) => beginObjectDrag(e, { kind: "road_point", id: r.id, index: idx })}
                        />
                      );
                    })}
                </g>
              );
            })}

          {/* Зоны действия знаков ограничения скорости */}
          {layers.signs &&
            layers.zones &&
            signs.map((sn) => {
              const length = sn.zoneLength ?? sn.zoneRadius ?? 250;
              if (!isSpeedSignKind(sn.kind) || !(length > 0)) return null;
              const h = sn.h;
              const startX = sn.x + Math.cos(h) * 3.2;
              const startZ = sn.z - Math.sin(h) * 3.2;
              const endX = startX + Math.sin(h) * length;
              const endZ = startZ + Math.cos(h) * length;
              const sel = isSelected("sign", sn.id);
              return (
                <g key={`zone-${sn.id}`}>
                  <line
                    x1={-startX} y1={-startZ} x2={-endX} y2={-endZ}
                    stroke={sel ? "rgba(248,113,113,0.65)" : "rgba(248,113,113,0.28)"}
                    strokeDasharray={`${scale * 0.8} ${scale * 0.6}`}
                    strokeWidth={Math.max(thin * 2, 0.12)}
                    style={{ pointerEvents: "none" }}
                  />
                  {sel && <circle
                    cx={-endX} cy={-endZ}
                    r={Math.max(0.5, signUnit * 0.48)}
                    fill="#ef4444" stroke="#ffffff" strokeWidth={thin * 1.2}
                    className="cursor-move"
                    onPointerDown={(e) => beginObjectDrag(e, { kind: "sign_zone", id: sn.id })}
                  />}
                </g>
              );
            })}

          {/* Пешеходные переходы «зебра» */}
          {layers.crosswalks &&
            crosswalks.map((cw) => {
              const sel = isSelected("crosswalk", cw.id);
              const stripeCount = Math.max(3, Math.min(14, Math.floor(cw.width / 1.05)));
              return (
                <g
                  key={cw.id}
                  data-testid={`map-crosswalk-${cw.id}`}
                  transform={`translate(${-cw.cx} ${-cw.cz}) rotate(${(-cw.h * 180) / Math.PI})`}
                  className={tool === "select" ? "cursor-move" : undefined}
                  onPointerDown={(e) => beginObjectDrag(e, { kind: "crosswalk", id: cw.id })}
                >
                  <rect
                    x={-cw.width / 2}
                    y={-cw.length / 2}
                    width={cw.width}
                    height={cw.length}
                    fill="rgba(37,99,235,0.12)"
                    stroke={sel ? "#f5b942" : "rgba(147,197,253,0.5)"}
                    strokeWidth={sel ? thin * 2 : thin}
                  />
                  {Array.from({ length: stripeCount }, (_, i) => {
                    const sx = ((i + 0.5) / stripeCount - 0.5) * (cw.width - 0.6);
                    return (
                      <rect
                        key={i}
                        x={sx - 0.22}
                        y={-cw.length / 2 + 0.15}
                        width={0.44}
                        height={Math.max(0.4, cw.length - 0.3)}
                        fill="rgba(248,250,252,0.82)"
                      />
                    );
                  })}
                </g>
              );
            })}

          {/* Парковочные боксы и карманы */}
          {layers.bays &&
            def.bays.map((b) => {
              const sel = isSelected("bay", b.id);
              return (
                <g
                  key={b.id}
                  data-testid={`map-bay-${b.id}`}
                  transform={`translate(${-b.cx} ${-b.cz}) rotate(${(-b.h * 180) / Math.PI})`}
                  className={tool === "select" ? "cursor-move" : undefined}
                  onPointerDown={(e) => beginObjectDrag(e, { kind: "bay", id: b.id })}
                >
                  <rect
                    x={-b.width / 2}
                    y={-b.length / 2}
                    width={b.width}
                    height={b.length}
                    fill={b.occupied ? "rgba(59,130,246,0.28)" : "rgba(82,214,189,0.11)"}
                    stroke={sel ? "#f5b942" : b.occupied ? "#60a5fa" : "#e2e8f0"}
                    strokeWidth={sel ? thin * 2.2 : thin * 1.2}
                  />
                  {/* Зелёный пунктир со стороны разрешённого въезда */}
                  {b.openSide === "front" ? (
                    <line
                      x1={-b.width / 2}
                      y1={-b.length / 2}
                      x2={b.width / 2}
                      y2={-b.length / 2}
                      stroke="#52d6bd"
                      strokeDasharray="0.45 0.35"
                      strokeWidth={thin * 1.6}
                    />
                  ) : (
                    <line
                      x1={-b.width / 2}
                      y1={-b.length / 2}
                      x2={-b.width / 2}
                      y2={b.length / 2}
                      stroke="#52d6bd"
                      strokeDasharray="0.55 0.35"
                      strokeWidth={thin * 1.6}
                    />
                  )}
                  <text
                    x={0}
                    y={0.2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={Math.min(1.2, b.width * 0.42)}
                    fontWeight={700}
                    fill={b.occupied ? "#93c5fd" : "#f5b942"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {b.id}
                  </text>
                </g>
              );
            })}

          {/* Статические препятствия и объекты окружения (8 классов) */}
          {layers.obstacles &&
            def.obstacles.map((o) => {
              const sel = isSelected("obstacle", o.id);
              const spec = getObstacleSpec(o.kind);
              const isRound = o.kind === "tree" || o.kind === "cone" || o.kind === "pole";
              const r =
                o.kind === "tree"
                  ? Math.max(0.85, Math.max(o.halfX, o.halfZ) * 1.8)
                  : Math.max(0.32, Math.max(o.halfX, o.halfZ) * 1.3, signUnit * 0.35);
              return (
                <g
                  key={o.id}
                  data-testid={`map-obstacle-${o.id}`}
                  transform={`translate(${-o.cx} ${-o.cz}) rotate(${(-o.h * 180) / Math.PI})`}
                  className={tool === "select" ? "cursor-move" : undefined}
                  onPointerDown={(e) => beginObjectDrag(e, { kind: "obstacle", id: o.id })}
                >
                  {isRound ? (
                    <circle
                      r={r}
                      fill={spec.mapFill}
                      stroke={sel ? "#f5b942" : spec.mapStroke}
                      strokeWidth={sel ? thin * 2.2 : thin * 1.1}
                      opacity={0.92}
                    />
                  ) : (
                    <rect
                      x={-o.halfX}
                      y={-o.halfZ}
                      width={o.halfX * 2}
                      height={o.halfZ * 2}
                      rx={o.kind === "island" ? Math.min(o.halfX, o.halfZ) * 0.45 : 0}
                      fill={spec.mapFill}
                      stroke={sel ? "#f5b942" : spec.mapStroke}
                      strokeWidth={sel ? thin * 2.2 : thin}
                      strokeDasharray={o.kind === "fence" ? "0.6 0.3" : undefined}
                      opacity={o.kind === "building" ? 0.76 : 0.92}
                    />
                  )}
                  {o.kind === "parked_car" && (
                    <line
                      x1={0}
                      y1={0}
                      x2={0}
                      y2={-o.halfZ * 0.85}
                      stroke="#f8fafc"
                      strokeWidth={thin * 1.3}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                </g>
              );
            })}

          {/* Контрольные точки маршрута (КТ) */}
          {layers.checkpoints &&
            def.checkpoints.map((c, idx) => {
              const sel = isSelected("checkpoint", c.id);
              const color = c.isFinalPark ? "#52d6bd" : c.requireStop ? "#f87171" : "#f5b942";
              const tag = c.requireStop
                ? "STOP"
                : c.requireSignal === "left"
                  ? "←Q"
                  : c.requireSignal === "right"
                    ? "E→"
                    : c.isFinalPark
                      ? "P"
                      : "";
              return (
                <g
                  key={c.id}
                  data-testid={`map-checkpoint-${c.id}`}
                  className={tool === "select" ? "cursor-move" : undefined}
                  onPointerDown={(e) => beginObjectDrag(e, { kind: "checkpoint", id: c.id })}
                >
                  <circle
                    cx={-c.x}
                    cy={-c.z}
                    r={c.radius}
                    fill={sel ? "rgba(245,185,66,0.16)" : "rgba(245,185,66,0.06)"}
                    stroke={color}
                    strokeDasharray={`${scale * 0.6} ${scale * 0.45}`}
                    strokeWidth={sel ? thin * 2 : thin * 1.1}
                  />
                  <circle
                    cx={-c.x}
                    cy={-c.z}
                    r={signUnit * 0.72}
                    fill="#0b1118"
                    stroke={color}
                    strokeWidth={thin * 1.5}
                  />
                  <text
                    x={-c.x}
                    y={-c.z}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={signUnit * 0.78}
                    fontWeight={800}
                    fill={color}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {idx + 1}
                  </text>
                  {tag && (
                    <text
                      x={-c.x}
                      y={-c.z - signUnit * 1.25}
                      textAnchor="middle"
                      fontSize={signUnit * 0.62}
                      fontWeight={800}
                      fill={color}
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {tag}
                    </text>
                  )}
                </g>
              );
            })}

          {/* Светофоры и перетаскиваемые стоп-линии 1.12 */}
          {layers.signals &&
            signals.map((sg) => {
              const sel = isSelected("signal", sg.id);
              const u = signUnit * 0.85;
              return (
                <g key={sg.id} data-testid={`map-signal-${sg.id}`}>
                  <line
                    x1={-sg.x}
                    y1={-sg.z}
                    x2={-sg.stopLineX}
                    y2={-sg.stopLineZ}
                    stroke={sel ? "#f5b942" : "rgba(248,250,252,0.38)"}
                    strokeDasharray={`${scale * 0.45} ${scale * 0.35}`}
                    strokeWidth={thin}
                    style={{ pointerEvents: "none" }}
                  />
                  {/* Стоп-линия 1.12 (перетаскивается независимо от стойки) */}
                  <g
                    transform={`translate(${-sg.stopLineX} ${-sg.stopLineZ}) rotate(${(-sg.h * 180) / Math.PI})`}
                    className={tool === "select" ? "cursor-move" : undefined}
                    onPointerDown={(e) => beginObjectDrag(e, { kind: "signal_stopline", id: sg.id })}
                  >
                    <rect
                      x={-sg.stopLineWidth / 2}
                      y={-Math.max(0.28, thin * 1.8)}
                      width={sg.stopLineWidth}
                      height={Math.max(0.56, thin * 3.6)}
                      fill="#f8fafc"
                      stroke={sel ? "#f5b942" : "#0f172a"}
                      strokeWidth={thin * 0.9}
                    />
                  </g>
                  {/* Корпус светофора с 3 линзами */}
                  <g
                    transform={`translate(${-sg.x} ${-sg.z}) rotate(${(-sg.h * 180) / Math.PI})`}
                    className={tool === "select" ? "cursor-move" : undefined}
                    onPointerDown={(e) => beginObjectDrag(e, { kind: "signal", id: sg.id })}
                  >
                    <rect
                      x={-u * 0.62}
                      y={-u * 1.3}
                      width={u * 1.24}
                      height={u * 2.6}
                      rx={u * 0.3}
                      fill="#0f172a"
                      stroke={sel ? "#f5b942" : "#cbd5e1"}
                      strokeWidth={sel ? thin * 2 : thin * 1.2}
                    />
                    <circle cx={0} cy={-u * 0.72} r={u * 0.3} fill="#ef4444" />
                    <circle cx={0} cy={0} r={u * 0.3} fill="#facc15" />
                    <circle cx={0} cy={u * 0.72} r={u * 0.3} fill="#22c55e" />
                  </g>
                </g>
              );
            })}

          {/* Дорожные знаки (12 классов) */}
          {layers.signs &&
            signs.map((sn) => {
              const sel = isSelected("sign", sn.id);
              return (
                <g
                  key={sn.id}
                  data-testid={`map-sign-${sn.id}`}
                  transform={`translate(${-sn.x} ${-sn.z})`}
                  className={tool === "select" ? "cursor-move" : undefined}
                  onPointerDown={(e) => beginObjectDrag(e, { kind: "sign", id: sn.id })}
                >
                  <SignGlyph sign={sn} unit={signUnit} selected={sel} />
                </g>
              );
            })}

          {/* Стартовая позиция Kia Ceed и стрелка курса */}
          <g
            data-testid="map-start"
            className={tool === "select" ? "cursor-move" : undefined}
            onPointerDown={(e) => beginObjectDrag(e, { kind: "start" })}
          >
            <g transform={`translate(${-def.start.x} ${-def.start.z}) rotate(${(-def.start.h * 180) / Math.PI})`}>
              <rect
                x={-0.89}
                y={-2.16}
                width={1.78}
                height={4.31}
                rx={0.35}
                fill="rgba(82,214,189,0.25)"
                stroke={isSelected("start") ? "#f5b942" : "#52d6bd"}
                strokeWidth={isSelected("start") ? thin * 2.2 : thin * 1.4}
              />
            </g>
            <line
              x1={-def.start.x}
              y1={-def.start.z}
              x2={startTipX}
              y2={startTipY}
              stroke="#52d6bd"
              strokeWidth={Math.max(0.22, thin * 1.8)}
              strokeLinecap="round"
            />
            <circle
              cx={-def.start.x}
              cy={-def.start.z}
              r={Math.max(0.45, signUnit * 0.45)}
              fill="#52d6bd"
              stroke="#071018"
              strokeWidth={thin}
            />
          </g>

          {/* Интерактивная ручка поворота выбранного объекта */}
          {tool === "select" && rotHandle && (
            <g data-testid="map-rotate-handle">
              <line
                x1={rotHandle.ax}
                y1={rotHandle.ay}
                x2={rotHandle.hx}
                y2={rotHandle.hy}
                stroke="#f5b942"
                strokeDasharray={`${scale * 0.45} ${scale * 0.35}`}
                strokeWidth={Math.max(0.16, thin * 1.4)}
                style={{ pointerEvents: "none" }}
              />
              <circle
                cx={rotHandle.hx}
                cy={rotHandle.hy}
                r={Math.max(0.6, signUnit * 0.62)}
                fill="#f5b942"
                stroke="#091017"
                strokeWidth={thin * 1.4}
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={beginRotateDrag}
              />
            </g>
          )}
        </svg>

        {/* Координаты курсора и подсказка внизу холста */}
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap items-center justify-between gap-2 text-[10px]">
          <span className="rounded-md bg-[#080e15]/90 border hairline px-2 py-1 text-[#9bafbc]">
            {TOOL_HINTS[tool]}
          </span>
          <span className="mono rounded-md bg-[#080e15]/90 border hairline px-2 py-1 text-[#d3e0e7]">
            {cursor ? `X: ${cursor.x} м · Z: ${cursor.z} м` : `окно ${Math.round(vb.w)}×${Math.round(vb.h)} м`}
          </span>
        </div>
      </div>
    </div>
  );
}
