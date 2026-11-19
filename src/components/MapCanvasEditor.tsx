/**
 * @module components/MapCanvasEditor
 * @layer ui
 * @role Интерактивный 2D-холст редактора карт: зум, панорама, произвольный полигон границы, оверлей проверки маршрута, drag-and-drop и поворот.
 * @invariants #1 (проекция sx = −x, sy = −z: +Z север вверх, +X влево, +h против часовой), #8 (чистый SVG без внешних тайлов).
 * @tests Смоук A, G, O, P (`tests/browser-smoke.mjs`); логика — T28–T32
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSimplePolygon, polygonArea } from "../maps/boundary";
import type { RouteCheckReport } from "../maps/routeCheck";
import type { CustomScenarioDef } from "../scenarios/custom";
import {
  bringSelectionToFront,
  getSelectionAnchor,
  insertBoundaryPoint,
  moveSelected,
  normalizeAngleRad,
  placeObjectAt,
  primarySelection,
  setSelectedHeading,
  snapCoord,
  type EditorSelection,
  type EditorTool,
  type PlaceOptions,
} from "../scenarios/editorOps";
import { formatSignBadge, getObstacleSpec, getRoadSignSpec, isSpeedSignKind } from "../scenarios/signs";
import type { RoadSignDef, Vec2 } from "../sim/types";

export type LayerVisibility = {
  boundary: boolean;
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
  boundary: true,
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
      placedOnDown?: boolean;
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
  /** Отчёт проверки маршрута для подсветки сегментов и проблемных КТ на карте. */
  routeCheck: RouteCheckReport;
  /** Черновые вершины рисуемого от руки полигона границы (в режиме `tool === "boundary"`). */
  draftBoundary: Vec2[];
  onDraftBoundaryChange: (pts: Vec2[]) => void;
  onFinishBoundary: (pts: Vec2[], alsoCrop: boolean) => void;
  onCancelBoundary: () => void;
  /** Счётчик внешнего запроса «Вписать карту в экран» (при импорте, обрезке или смене шаблона). */
  fitSignal: number;
  /** Счётчик внешнего запроса «Сфокусироваться на выбранном объекте» (из панели проверки маршрута). */
  focusSignal: number;
  onSelect: (sel: EditorSelection | null) => void;
  /** Плавное обновление во время перетаскивания (без записи каждого кадра в историю). */
  onLiveChange: (next: CustomScenarioDef) => void;
  /** Фиксация завершённого действия в стек Undo (`before` — состояние до начала жеста). */
  onCommitChange: (next: CustomScenarioDef, before: CustomScenarioDef) => void;
};

function computeFitViewBox(bounds: CustomScenarioDef["bounds"]): ViewBox {
  const rawW = Math.max(12, bounds.maxX - bounds.minX);
  const rawH = Math.max(12, bounds.maxZ - bounds.minZ);
  const pad = Math.max(4, Math.min(45, Math.max(rawW, rawH) * 0.06));
  return {
    x: -bounds.maxX - pad,
    y: -bounds.maxZ - pad,
    w: rawW + pad * 2,
    h: rawH + pad * 2,
  };
}

/**
 * Вычисляет шаг визуальной сетки в метрах от выбранного пользователем `snapStep`:
 * - при `snapStep <= 0` («Выкл») сетка полностью скрывается (`null`);
 * - при обычном масштабе (до ~160 ячеек на экран) рисуется точный шаг `snapStep` (0,5 / 1 / 2 / 5 м);
 * - при сильном отдалении (карты OSM 300–3000 м) линии прореживаются строго кратно `snapStep`.
 */
function resolveVisualGridStep(snapStep: number, viewW: number, viewH: number): number | null {
  if (!(snapStep > 0)) return null;
  const maxSpan = Math.max(viewW, viewH);
  const MAX_CELLS = 160;
  if (maxSpan / snapStep <= MAX_CELLS) return snapStep;
  for (const mult of [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]) {
    const candidate = Number((snapStep * mult).toFixed(4));
    if (maxSpan / candidate <= MAX_CELLS) return candidate;
  }
  return Number((snapStep * 5000).toFixed(4));
}

function formatMetersRu(v: number): string {
  return Number(v.toFixed(2)).toString().replace(".", ",");
}

/** Отрисовка миниатюры дорожного знака в масштабе карты (`unit` — радиус знака в метрах SVG). */
function SignGlyph({ sign, unit, selected }: { sign: RoadSignDef; unit: number; selected: boolean }) {
  const spec = getRoadSignSpec(sign.kind);
  const badge = formatSignBadge(sign);
  const strokeW = unit * 0.22;
  const deg = (-sign.h * 180) / Math.PI;
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
  select:
    "Клик — выбрать объект · удержание 0,4 с — на передний план · перетаскивание — перенос · янтарный кружок — поворот",
  pan: "Зажмите кнопку мыши (или палец) и перетаскивайте карту · колесо — масштаб",
  boundary:
    "Задайте произвольную форму площадки/границы: кликайте по карте (точка #1 или Enter — замкнуть) или тяните вершины",
  start: "Кликните по карте, чтобы перенести стартовую позицию автомобиля",
  sign: "Кликните по карте, чтобы установить выбранный дорожный знак (затем можно сразу перетащить)",
  signal: "Кликните по карте, чтобы поставить светофор со стоп-линией 1.12",
  crosswalk: "Кликните по карте, чтобы добавить пешеходный переход «зебра» с пешеходом",
  road: "Кликните по карте, чтобы добавить сегмент дороги (узлы перетаскиваются мышью)",
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
  routeCheck,
  draftBoundary,
  onDraftBoundaryChange,
  onFinishBoundary,
  onCancelBoundary,
  fitSignal,
  focusSignal,
  onSelect,
  onLiveChange,
  onCommitChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const longPressRef = useRef<{
    timer: number;
    startX: number;
    startY: number;
    promoted: boolean;
  } | null>(null);
  const defRef = useRef<CustomScenarioDef>(def);
  defRef.current = def;

  const [vb, setVb] = useState<ViewBox>(() => computeFitViewBox(def.bounds));
  const vbRef = useRef<ViewBox>(vb);
  vbRef.current = vb;
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [frontFlash, setFrontFlash] = useState(false);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
    setFrontFlash(false);
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  useEffect(() => {
    setVb(computeFitViewBox(def.bounds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Адаптивный размер маркеров и обводок (читаемо и на площадке 30 м, и на маршруте OSM 3000 м)
  const scale = useMemo(() => Math.max(vb.w, vb.h) / 56, [vb.w, vb.h]);
  const signUnit = Math.max(0.75, Math.min(14, scale * 1.12));
  const thin = Math.max(0.09, scale * 0.14);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; z: number; sx: number; sy: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const curVb = vbRef.current;
      // Учитываем preserveAspectRatio="xMidYMid meet" (letterbox для неквадратных маршрутов)
      const scalePx = Math.min(rect.width / curVb.w, rect.height / curVb.h);
      const drawnW = curVb.w * scalePx;
      const drawnH = curVb.h * scalePx;
      const padX = (rect.width - drawnW) / 2;
      const padY = (rect.height - drawnH) / 2;
      const sx = curVb.x + (clientX - rect.left - padX) / scalePx;
      const sy = curVb.y + (clientY - rect.top - padY) / scalePx;
      return { x: Number((-sx).toFixed(2)), z: Number((-sy).toFixed(2)), sx, sy };
    },
    []
  );

  const zoomBy = useCallback((factor: number, focusSx?: number, focusSy?: number) => {
    setVb((prev) => {
      const nw = Math.max(8, Math.min(7200, prev.w * factor));
      const nh = Math.max(8, Math.min(7200, prev.h * factor));
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

  // Непассивный обработчик колеса мыши/тачпада: чистый зум без прокрутки страницы и предупреждений браузера
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = clientToWorld(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.16 : 1 / 1.16;
      zoomBy(factor, pt?.sx, pt?.sy);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [clientToWorld, zoomBy]);

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
    if (focusSignal <= 0) return;
    centerOnSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const beginObjectDrag = (e: React.PointerEvent, target: EditorSelection) => {
    if (e.button === 1 || tool === "pan") return;
    // Вершины границы можно перетаскивать и в select, и в boundary (если новый контур ещё не начат)
    const allowBoundaryDrag =
      target.kind === "boundary_point" && (tool === "select" || (tool === "boundary" && draftBoundary.length === 0));
    if (tool !== "select" && !allowBoundaryDrag) return;
    e.stopPropagation();
    const pt = clientToWorld(e.clientX, e.clientY);
    onSelect(target);
    const anchor = getSelectionAnchor(def, target);
    if (!pt || !anchor) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "move",
      selection: target,
      offsetX: anchor.x - pt.x,
      offsetZ: anchor.z - pt.z,
      moved: false,
      before: def,
    };

    // Длительный клик/тап (420 мс без сдвига) выводит выбранный объект на передний слой отрисовки
    clearLongPress();
    const startX = e.clientX;
    const startY = e.clientY;
    const timer = window.setTimeout(() => {
      const lp = longPressRef.current;
      const curDrag = dragRef.current;
      if (!lp || !curDrag || curDrag.mode !== "move") return;
      lp.promoted = true;
      setFrontFlash(true);
      const promoted = bringSelectionToFront(defRef.current, target);
      if (promoted.moved) {
        curDrag.moved = true;
        onLiveChange(promoted.def);
      }
    }, 420);
    longPressRef.current = { timer, startX, startY, promoted: false };
  };

  const handleInsertBoundaryMidpoint = (e: React.PointerEvent, edgeIdx: number) => {
    e.stopPropagation();
    const before = def;
    const res = insertBoundaryPoint(def, edgeIdx);
    if (!res) return;
    onLiveChange(res.def);
    onSelect(res.selection);
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "move",
      selection: res.selection,
      offsetX: 0,
      offsetZ: 0,
      moved: true,
      before,
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

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = clientToWorld(e.clientX, e.clientY);
    if (!pt) return;

    // Средняя кнопка, инструмент «Панорама» или Shift+перетаскивание — панорамирование
    if (e.button === 1 || tool === "pan" || ((tool === "select" || tool === "boundary") && e.shiftKey)) {
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

    // Рисование произвольного полигона границы маршрута по точкам
    if (tool === "boundary") {
      const bx = snapStep > 0 ? snapCoord(pt.x, snapStep) : Number(pt.x.toFixed(2));
      const bz = snapStep > 0 ? snapCoord(pt.z, snapStep) : Number(pt.z.toFixed(2));
      // Клик рядом с первой вершиной (при ≥ 3 точках) замыкает многоугольник
      if (draftBoundary.length >= 3) {
        const first = draftBoundary[0];
        const closeRadius = Math.max(1.8, signUnit * 1.45);
        if (Math.hypot(bx - first.x, bz - first.z) <= closeRadius) {
          onFinishBoundary(draftBoundary, false);
          return;
        }
      }
      const last = draftBoundary[draftBoundary.length - 1];
      if (last && Math.hypot(bx - last.x, bz - last.z) < 0.4) return;
      onDraftBoundaryChange([...draftBoundary, { x: bx, z: bz }]);
      return;
    }

    if (tool === "select") {
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

    // Размещение нового объекта в точке клика (один атомарный шаг Undo даже с немедленным переносом)
    const before = def;
    const placed = placeObjectAt(def, tool, pt.x, pt.z, {
      ...placeOptions,
      snapStep,
    });
    onLiveChange(placed.def);
    onSelect(placed.selection);
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode: "move",
      selection: placed.selection,
      offsetX: 0,
      offsetZ: 0,
      moved: false,
      placedOnDown: true,
      before,
    };
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (tool === "boundary" && draftBoundary.length >= 3) {
      e.preventDefault();
      onFinishBoundary(draftBoundary, false);
    }
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

    if (drag.mode === "move") {
      const lp = longPressRef.current;
      if (lp && !lp.promoted && Math.hypot(e.clientX - lp.startX, e.clientY - lp.startY) > 6) {
        window.clearTimeout(lp.timer);
        longPressRef.current = null;
      }
      if (lp && Math.hypot(e.clientX - lp.startX, e.clientY - lp.startY) < 2) {
        return;
      }
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
    clearLongPress();
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      if (svgRef.current?.hasPointerCapture?.(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId);
      }
    } catch {
      // указатель уже освобождён
    }
    if (drag && (drag.mode === "move" || drag.mode === "rotate")) {
      const placed = drag.mode === "move" && Boolean(drag.placedOnDown);
      if (drag.moved || placed) {
        onCommitChange(defRef.current, drag.before);
      }
    }
  };

  // Метрическая сетка и шаг привязки (управляются кнопками «СЕТКА: Выкл / 0,5 м / 1 м / 2 м / 5 м»)
  const gridStep = useMemo(() => resolveVisualGridStep(snapStep, vb.w, vb.h), [snapStep, vb.w, vb.h]);
  const gridLines = useMemo(() => {
    if (gridStep === null) return { xs: [] as number[], ys: [] as number[], majorEvery: 5, x0: vb.x, x1: vb.x + vb.w, y0: vb.y, y1: vb.y + vb.h };
    // Расширяем покрытие по X/Y на поля letterbox, чтобы сетка равномерно заполняла весь холст
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

  // Множество проблемных КТ/старта по данным проверки маршрута
  const issueByCheckpoint = useMemo(() => {
    const map = new Map<string, "error" | "warning">();
    for (const iss of routeCheck.issues) {
      if (iss.severity === "info") continue;
      if (iss.target?.kind === "checkpoint") {
        const prev = map.get(iss.target.id);
        if (prev !== "error") map.set(iss.target.id, iss.severity);
      }
    }
    return map;
  }, [routeCheck.issues]);

  const startIssue = useMemo(() => {
    let sev: "error" | "warning" | null = null;
    for (const iss of routeCheck.issues) {
      if (iss.severity === "info") continue;
      if (iss.target?.kind === "start") {
        if (iss.severity === "error") return "error";
        sev = "warning";
      }
    }
    return sev;
  }, [routeCheck.issues]);

  const boundaryPoly = def.boundaryPolygon && def.boundaryPolygon.length >= 3 ? def.boundaryPolygon : null;
  const boundaryValid = boundaryPoly ? isSimplePolygon(boundaryPoly) && polygonArea(boundaryPoly) >= 25 : true;
  const showBoundaryMidpoints =
    boundaryPoly !== null &&
    ((tool === "boundary" && draftBoundary.length === 0) || selection?.kind === "boundary_point");

  const draftAreaM2 = useMemo(
    () => (draftBoundary.length >= 3 ? Math.round(polygonArea(draftBoundary)) : 0),
    [draftBoundary]
  );
  const draftSimple = useMemo(
    () => (draftBoundary.length >= 3 ? isSimplePolygon(draftBoundary) : true),
    [draftBoundary]
  );

  const primary = primarySelection(selection);
  const selAnchor = getSelectionAnchor(def, selection);
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
    if (!primary || primary.kind !== k) return false;
    if (k === "start") return true;
    return "id" in primary && primary.id === id;
  };

  const roads = def.roads ?? [];
  const signs = def.signs ?? [];
  const signals = def.signals ?? [];
  const crosswalks = def.crosswalks ?? [];
  const spanX = Math.round(def.bounds.maxX - def.bounds.minX);
  const spanZ = Math.round(def.bounds.maxZ - def.bounds.minZ);
  const startTipX = -(def.start.x + Math.sin(def.start.h) * Math.max(2.6, scale * 2.2));
  const startTipY = -(def.start.z + Math.cos(def.start.h) * Math.max(2.6, scale * 2.2));

  // Путь внешней затемняющей маски вокруг произвольной границы (fill-rule="evenodd")
  const maskOuter = useMemo(() => {
    const m = Math.max(vb.w, vb.h) * 2;
    const x0 = vb.x - m;
    const y0 = vb.y - m;
    const x1 = vb.x + vb.w + m;
    const y1 = vb.y + vb.h + m;
    return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
  }, [vb]);

  const boundaryHolePath = useMemo(() => {
    if (!boundaryPoly) return "";
    return (
      boundaryPoly
        .map((p, i) => `${i === 0 ? "M" : "L"} ${-p.x} ${-p.z}`)
        .join(" ") + " Z"
    );
  }, [boundaryPoly]);

  return (
    <div className="panel p-3 sm:p-4 space-y-2.5">
      {/* Верхняя полоса управления видом 2D-карты */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-extrabold">2D-карта редактора</span>
          <span className="mono text-[10px] text-[#7c909d]" data-testid="map-dimensions-badge">
            {spanX}×{spanZ} м
            {boundaryPoly ? ` · контур ${boundaryPoly.length} т.` : " · прямоуг."} · {gridBadgeText} · ↑ север
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
          {selAnchor && (
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

      {/* Интерактивный SVG-холст карты */}
      <div className="relative rounded-xl bg-[#070d13] border hairline overflow-hidden select-none">
        {/* Плавающая панель завершения рисования произвольного полигона границы */}
        {tool === "boundary" && (
          <div
            data-testid="boundary-draw-bar"
            className="absolute top-2 left-2 right-2 z-10 flex flex-wrap items-center justify-between gap-1.5 rounded-lg bg-[#080e15]/95 border border-[#f5b942]/45 px-2.5 py-1.5 text-[11px]"
          >
            <span className="text-[#e8f0f5]">
              {draftBoundary.length === 0 ? (
                <>
                  <b className="text-[#f5b942]">Контур границы:</b> кликайте по карте для нового многоугольника
                  {boundaryPoly ? " или тяните янтарные вершины текущего" : ""}
                </>
              ) : (
                <>
                  <b className="text-[#f5b942]">Вершин: {draftBoundary.length}</b>
                  {draftBoundary.length >= 3 && (
                    <span className={`ml-2 mono text-[10px] ${draftSimple ? "text-[#52d6bd]" : "text-[#ff8080]"}`}>
                      {draftSimple ? `S ≈ ${draftAreaM2} м²` : "самопересечение рёбер!"}
                    </span>
                  )}
                </>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {draftBoundary.length > 0 && (
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => onDraftBoundaryChange(draftBoundary.slice(0, -1))}
                  title="Убрать последнюю поставленную точку (Backspace)"
                >
                  ↶ Точка
                </button>
              )}
              {draftBoundary.length >= 3 && (
                <>
                  <button
                    type="button"
                    data-testid="boundary-finish-btn"
                    disabled={!draftSimple || draftAreaM2 < 25}
                    className="btn btn-mini text-[#52d6bd] disabled:opacity-40"
                    onClick={() => onFinishBoundary(draftBoundary, false)}
                  >
                    ✓ Замкнуть ({draftBoundary.length})
                  </button>
                  <button
                    type="button"
                    data-testid="boundary-finish-crop-btn"
                    disabled={!draftSimple || draftAreaM2 < 25}
                    className="btn btn-primary btn-mini disabled:opacity-40"
                    onClick={() => onFinishBoundary(draftBoundary, true)}
                  >
                    ✂ Замкнуть и обрезать
                  </button>
                </>
              )}
              <button type="button" className="btn btn-mini" onClick={onCancelBoundary}>
                {draftBoundary.length > 0 ? "Отмена" : "Готово"}
              </button>
            </div>
          </div>
        )}

        <svg
          ref={svgRef}
          data-testid="map-editor-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onPointerDown={handleCanvasPointerDown}
          onDoubleClick={handleCanvasDoubleClick}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onPointerLeave={() => setCursor(null)}
          style={{ touchAction: "none" }}
          className={`w-full h-[460px] sm:h-[520px] ${
            tool === "pan" ? "cursor-grab active:cursor-grabbing" : tool === "select" ? "cursor-default" : "cursor-crosshair"
          }`}
          role="img"
          aria-label="Интерактивная 2D-карта сценария"
        >
          {/* Метрическая сетка и привязка (скрывается при «СЕТКА: Выкл») */}
          {gridStep !== null && (
            <g
              data-testid="map-grid"
              data-grid-step={gridStep}
              data-snap-step={snapStep}
              style={{ pointerEvents: "none" }}
            >
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
                    stroke={
                      isAxis
                        ? "rgba(82,214,189,0.32)"
                        : isMajor
                          ? "rgba(148,176,198,0.22)"
                          : "rgba(148,176,198,0.1)"
                    }
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
                    stroke={
                      isAxis
                        ? "rgba(82,214,189,0.32)"
                        : isMajor
                          ? "rgba(148,176,198,0.22)"
                          : "rgba(148,176,198,0.1)"
                    }
                    strokeWidth={isAxis ? thin * 1.15 : isMajor ? thin * 0.85 : thin * 0.6}
                  />
                );
              })}
            </g>
          )}

          {/* Подложка границ мира и асфальтовой площадки (прямоугольник или произвольный многоугольник) */}
          {boundaryPoly ? (
            <polygon
              data-testid="map-boundary-polygon"
              points={boundaryPoly.map((p) => `${-p.x},${-p.z}`).join(" ")}
              fill={def.useLotSurface !== false ? "#19232e" : "rgba(15,28,39,0.52)"}
              stroke={def.useLotSurface !== false ? "#34495d" : "none"}
              strokeWidth={def.useLotSurface !== false ? thin * 1.2 : 0}
              style={{ pointerEvents: "none" }}
            />
          ) : (
            <rect
              x={-def.bounds.maxX}
              y={-def.bounds.maxZ}
              width={def.bounds.maxX - def.bounds.minX}
              height={def.bounds.maxZ - def.bounds.minZ}
              fill="rgba(15,25,35,0.42)"
              stroke={layers.boundary ? "#2b3c4d" : "none"}
              strokeDasharray={`${scale * 0.9} ${scale * 0.7}`}
              strokeWidth={thin * 1.1}
              style={{ pointerEvents: "none" }}
            />
          )}

          {/* Прямоугольная асфальтовая площадка рисуется только когда НЕ задан произвольный контур */}
          {def.useLotSurface !== false && !boundaryPoly && (
            <rect
              data-testid="map-lot-rect"
              x={-def.lotHalfX}
              y={-def.lotHalfZ}
              width={def.lotHalfX * 2}
              height={def.lotHalfZ * 2}
              fill="#19232e"
              stroke={def.perimeterCurb ? "#cbd5e1" : "#2a3948"}
              strokeWidth={def.perimeterCurb ? thin * 2.1 : thin}
              style={{ pointerEvents: "none" }}
            />
          )}

          {/* Сегменты дорог (импорт OSM и собственные) */}
          {layers.roads &&
            roads.map((r) => {
              const sel = isSelected("road", r.id);
              const pts = r.points.map((p) => `${-p.x},${-p.z}`).join(" ");
              return (
                <g key={r.id}>
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
                      strokeDasharray={r.hasSolidCenter && !r.oneway ? undefined : `${scale * 0.9} ${scale * 0.9}`}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {r.oneway &&
                    r.points.slice(0, -1).map((p0, sIdx) => {
                      const p1 = r.points[sIdx + 1];
                      const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
                      if (segLen < 8) return null;
                      const mx = -(p0.x + p1.x) * 0.5;
                      const my = -(p0.z + p1.z) * 0.5;
                      const deg = (Math.atan2(-(p1.z - p0.z), -(p1.x - p0.x)) * 180) / Math.PI;
                      const asz = Math.max(0.7, Math.min(r.width * 0.28, signUnit * 0.7));
                      return (
                        <path
                          key={`${r.id}-ow-${sIdx}`}
                          d={`M ${-asz} ${-asz * 0.65} L ${asz * 0.75} 0 L ${-asz} ${asz * 0.65}`}
                          transform={`translate(${mx} ${my}) rotate(${deg})`}
                          fill="none"
                          stroke="#52d6bd"
                          strokeOpacity={0.8}
                          strokeWidth={Math.max(0.16, thin * 1.25)}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ pointerEvents: "none" }}
                        />
                      );
                    })}
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

          {/* Оверлей нитки маршрута по улицам (зелёный — связан, янтарный — замечание, красный — разрыв/препятствие) */}
          {layers.checkpoints &&
            routeCheck.legs.map((leg) => {
              if (leg.path.length < 2) return null;
              const stroke =
                leg.status === "ok"
                  ? "rgba(82,214,189,0.72)"
                  : leg.status === "offroad"
                    ? "rgba(245,185,66,0.85)"
                    : "rgba(255,107,107,0.92)";
              const pts = leg.path.map((p) => `${-p.x},${-p.z}`).join(" ");
              return (
                <polyline
                  key={`route-leg-${leg.index}`}
                  data-testid={`map-route-leg-${leg.index}`}
                  points={pts}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={Math.max(0.32, thin * 2.4)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={
                    leg.status !== "ok"
                      ? `${scale * 0.85} ${scale * 0.55}`
                      : `${scale * 1.15} ${scale * 0.55}`
                  }
                  style={{ pointerEvents: "none" }}
                />
              );
            })}

          {/* Зоны действия знаков ограничения скорости */}
          {layers.signs &&
            layers.zones &&
            signs.map((sn) => {
              if (!isSpeedSignKind(sn.kind) || !(sn.zoneRadius && sn.zoneRadius > 0)) return null;
              const zx = sn.zoneX ?? sn.x;
              const zz = sn.zoneZ ?? sn.z;
              const sel = isSelected("sign", sn.id);
              return (
                <g key={`zone-${sn.id}`}>
                  <circle
                    cx={-zx}
                    cy={-zz}
                    r={sn.zoneRadius}
                    fill={sel ? "rgba(239,68,68,0.10)" : "rgba(239,68,68,0.045)"}
                    stroke={sel ? "rgba(248,113,113,0.65)" : "rgba(248,113,113,0.28)"}
                    strokeDasharray={`${scale * 0.8} ${scale * 0.6}`}
                    strokeWidth={thin * 1.1}
                    style={{ pointerEvents: "none" }}
                  />
                  {sel && (
                    <>
                      <line
                        x1={-sn.x}
                        y1={-sn.z}
                        x2={-zx}
                        y2={-zz}
                        stroke="rgba(248,113,113,0.6)"
                        strokeDasharray={`${scale * 0.45} ${scale * 0.45}`}
                        strokeWidth={thin}
                        style={{ pointerEvents: "none" }}
                      />
                      <circle
                        cx={-zx}
                        cy={-zz}
                        r={Math.max(0.5, signUnit * 0.48)}
                        fill="#ef4444"
                        stroke="#ffffff"
                        strokeWidth={thin * 1.2}
                        className="cursor-move"
                        onPointerDown={(e) => beginObjectDrag(e, { kind: "sign_zone", id: sn.id })}
                      />
                    </>
                  )}
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

          {/* Статические препятствия и объекты окружения (8 классов, включая OBB зданий OSM) */}
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

          {/* Контрольные точки маршрута (радиус не перекрывает клики по дорогам/знакам внутри!) */}
          {layers.checkpoints &&
            def.checkpoints.map((c, idx) => {
              const sel = isSelected("checkpoint", c.id);
              const cpIssue = issueByCheckpoint.get(c.id);
              const color =
                cpIssue === "error"
                  ? "#ff6b6b"
                  : c.isFinalPark
                    ? "#52d6bd"
                    : c.requireStop
                      ? "#f87171"
                      : "#f5b942";
              const tag = cpIssue
                ? "!"
                : c.requireStop
                  ? "STOP"
                  : c.requireSignal === "left"
                    ? "←Q"
                    : c.requireSignal === "right"
                      ? "E→"
                      : c.isFinalPark
                        ? "P"
                        : "";
              return (
                <g key={c.id} data-testid={`map-checkpoint-${c.id}`}>
                  <circle
                    cx={-c.x}
                    cy={-c.z}
                    r={c.radius}
                    fill={
                      cpIssue === "error"
                        ? "rgba(255,107,107,0.14)"
                        : sel
                          ? "rgba(245,185,66,0.16)"
                          : "rgba(245,185,66,0.06)"
                    }
                    stroke={color}
                    strokeDasharray={`${scale * 0.6} ${scale * 0.45}`}
                    strokeWidth={sel || cpIssue ? thin * 2 : thin * 1.1}
                    style={{ pointerEvents: "none" }}
                  />
                  <circle
                    cx={-c.x}
                    cy={-c.z}
                    r={Math.max(0.85, signUnit * 0.82)}
                    fill="#0b1118"
                    stroke={color}
                    strokeWidth={sel ? thin * 2.1 : thin * 1.5}
                    className={tool === "select" ? "cursor-move" : undefined}
                    onPointerDown={(e) => beginObjectDrag(e, { kind: "checkpoint", id: c.id })}
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
                      y={-c.z - signUnit * 1.3}
                      textAnchor="middle"
                      fontSize={signUnit * 0.64}
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
            {startIssue && (
              <circle
                cx={-def.start.x}
                cy={-def.start.z}
                r={Math.max(3.2, signUnit * 1.5)}
                fill={startIssue === "error" ? "rgba(255,107,107,0.16)" : "rgba(245,185,66,0.14)"}
                stroke={startIssue === "error" ? "#ff6b6b" : "#f5b942"}
                strokeWidth={thin * 1.7}
                style={{ pointerEvents: "none" }}
              />
            )}
            <g transform={`translate(${-def.start.x} ${-def.start.z}) rotate(${(-def.start.h * 180) / Math.PI})`}>
              <rect
                x={-0.89}
                y={-2.16}
                width={1.78}
                height={4.31}
                rx={0.35}
                fill="rgba(82,214,189,0.25)"
                stroke={isSelected("start") ? "#f5b942" : startIssue === "error" ? "#ff6b6b" : "#52d6bd"}
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

          {/* Затемнение снаружи + контур и перетаскиваемые вершины произвольной границы */}
          {layers.boundary && boundaryPoly && (
            <g data-testid="map-boundary-overlay">
              <path
                d={`${maskOuter} ${boundaryHolePath}`}
                fillRule="evenodd"
                fill="rgba(4,9,14,0.56)"
                style={{ pointerEvents: "none" }}
              />
              {def.perimeterCurb && boundaryValid && (
                <polygon
                  data-testid="map-boundary-curb"
                  points={boundaryPoly.map((p) => `${-p.x},${-p.z}`).join(" ")}
                  fill="none"
                  stroke="#cbd5e1"
                  strokeWidth={Math.max(0.32, thin * 2.4)}
                  strokeLinejoin="round"
                  style={{ pointerEvents: "none" }}
                />
              )}
              <polygon
                points={boundaryPoly.map((p) => `${-p.x},${-p.z}`).join(" ")}
                fill="none"
                stroke={boundaryValid ? "#f5b942" : "#ff6b6b"}
                strokeDasharray={`${scale * 1.05} ${scale * 0.6}`}
                strokeWidth={Math.max(0.24, thin * 1.85)}
                style={{ pointerEvents: "none" }}
              />
              {/* Точки вставки новой вершины на серединах рёбер */}
              {showBoundaryMidpoints &&
                boundaryPoly.map((p, idx) => {
                  const next = boundaryPoly[(idx + 1) % boundaryPoly.length];
                  const mx = -(p.x + next.x) * 0.5;
                  const mz = -(p.z + next.z) * 0.5;
                  return (
                    <circle
                      key={`bmid-${idx}`}
                      data-testid={`map-boundary-mid-${idx}`}
                      cx={mx}
                      cy={mz}
                      r={Math.max(0.48, signUnit * 0.45)}
                      fill="#0b131b"
                      stroke="#52d6bd"
                      strokeWidth={thin * 1.3}
                      className="cursor-copy"
                      onPointerDown={(e) => handleInsertBoundaryMidpoint(e, idx)}
                    >
                      <title>Добавить вершину на ребре #{idx + 1}</title>
                    </circle>
                  );
                })}
              {/* Перетаскиваемые вершины многоугольника границы */}
              {(tool === "select" || (tool === "boundary" && draftBoundary.length === 0)) &&
                boundaryPoly.map((p, idx) => {
                  const ptSel = selection?.kind === "boundary_point" && selection.index === idx;
                  const r = Math.max(0.62, signUnit * (ptSel ? 0.72 : 0.56));
                  return (
                    <rect
                      key={`bvtx-${idx}`}
                      data-testid={`map-boundary-vertex-${idx}`}
                      x={-p.x - r}
                      y={-p.z - r}
                      width={r * 2}
                      height={r * 2}
                      rx={r * 0.35}
                      fill={ptSel ? "#52d6bd" : "#f5b942"}
                      stroke="#091017"
                      strokeWidth={thin * 1.4}
                      className="cursor-move"
                      onPointerDown={(e) => beginObjectDrag(e, { kind: "boundary_point", index: idx })}
                    >
                      <title>{`Вершина границы #${idx + 1} (${p.x}, ${p.z})`}</title>
                    </rect>
                  );
                })}
            </g>
          )}

          {/* Черновой полигон при рисовании произвольной границы от руки */}
          {tool === "boundary" && draftBoundary.length > 0 && (
            <g data-testid="map-boundary-draft" style={{ pointerEvents: "none" }}>
              {draftBoundary.length >= 3 && (
                <polygon
                  points={draftBoundary.map((p) => `${-p.x},${-p.z}`).join(" ")}
                  fill={draftSimple ? "rgba(82,214,189,0.14)" : "rgba(255,107,107,0.16)"}
                  stroke="none"
                />
              )}
              <polyline
                points={draftBoundary.map((p) => `${-p.x},${-p.z}`).join(" ")}
                fill="none"
                stroke={draftSimple ? "#52d6bd" : "#ff6b6b"}
                strokeWidth={Math.max(0.28, thin * 2)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {cursor && (
                <>
                  <line
                    x1={-draftBoundary[draftBoundary.length - 1].x}
                    y1={-draftBoundary[draftBoundary.length - 1].z}
                    x2={-cursor.x}
                    y2={-cursor.z}
                    stroke="#f5b942"
                    strokeDasharray={`${scale * 0.6} ${scale * 0.45}`}
                    strokeWidth={Math.max(0.2, thin * 1.5)}
                  />
                  {draftBoundary.length >= 2 && (
                    <line
                      x1={-cursor.x}
                      y1={-cursor.z}
                      x2={-draftBoundary[0].x}
                      y2={-draftBoundary[0].z}
                      stroke="rgba(82,214,189,0.45)"
                      strokeDasharray={`${scale * 0.5} ${scale * 0.5}`}
                      strokeWidth={thin * 1.2}
                    />
                  )}
                </>
              )}
              {draftBoundary.map((p, idx) => (
                <g key={`draft-${idx}`}>
                  {idx === 0 && draftBoundary.length >= 3 && (
                    <circle
                      cx={-p.x}
                      cy={-p.z}
                      r={Math.max(1.4, signUnit * 1.2)}
                      fill="rgba(82,214,189,0.22)"
                      stroke="#52d6bd"
                      strokeWidth={thin * 1.5}
                    />
                  )}
                  <circle
                    cx={-p.x}
                    cy={-p.z}
                    r={Math.max(0.65, signUnit * 0.62)}
                    fill={idx === 0 ? "#52d6bd" : "#f5b942"}
                    stroke="#091017"
                    strokeWidth={thin * 1.4}
                  />
                </g>
              ))}
            </g>
          )}

          {/* Подсветка объекта, выведенного на передний план длительным нажатием/тапом */}
          {frontFlash && selAnchor && (
            <circle
              cx={-selAnchor.x}
              cy={-selAnchor.z}
              r={Math.max(2.2, signUnit * 1.9)}
              fill="rgba(245,185,66,0.12)"
              stroke="#f5b942"
              strokeWidth={Math.max(0.28, thin * 2.2)}
              style={{ pointerEvents: "none" }}
            />
          )}

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
