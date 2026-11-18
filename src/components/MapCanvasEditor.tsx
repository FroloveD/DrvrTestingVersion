/**
 * @module components/MapCanvasEditor
 * @layer ui
 * @role Интерактивный 2D-холст редактора карт: зум, панорама, сетка, слои, размещение кликом, drag-and-drop перенос и поворот объектов.
 * @invariants #1 (проекция sx = −x, sy = −z: +Z север вверх, +X влево, +h против часовой), #8 (чистый SVG без внешних тайлов).
 * @tests Смоук A, G, O (`tests/browser-smoke.mjs`); логика — T28, T29
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CustomScenarioDef } from "../scenarios/custom";
import {
  getSelectionAnchor,
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
import type { RoadSignDef } from "../sim/types";

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
  /** Счётчик внешнего запроса «Вписать карту в экран» (при импорте или смене шаблона). */
  fitSignal: number;
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

function chooseGridStep(viewSpan: number): number {
  if (viewSpan <= 26) return 1;
  if (viewSpan <= 55) return 2;
  if (viewSpan <= 130) return 5;
  if (viewSpan <= 280) return 10;
  if (viewSpan <= 600) return 25;
  return 50;
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
  select: "Клик — выбрать объект · перетаскивание — перенос · янтарный кружок — поворот · пустое место — панорама",
  pan: "Зажмите кнопку мыши (или палец) и перетаскивайте карту · колесо — масштаб",
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
  fitSignal,
  onSelect,
  onLiveChange,
  onCommitChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const defRef = useRef<CustomScenarioDef>(def);
  defRef.current = def;

  const [vb, setVb] = useState<ViewBox>(() => computeFitViewBox(def.bounds));
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);

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

  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const pt = clientToWorld(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.16 : 1 / 1.16;
      zoomBy(factor, pt?.sx, pt?.sy);
    },
    [clientToWorld, zoomBy]
  );

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

  const beginObjectDrag = (e: React.PointerEvent, target: EditorSelection) => {
    if (e.button === 1 || tool === "pan") return;
    // В режиме добавления нового объекта клик по карте ставит новый объект, а в select — тянет существующий
    if (tool !== "select") return;
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
    if (e.button === 1 || tool === "pan" || (tool === "select" && e.shiftKey)) {
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
    if (drag && (drag.mode === "move" || drag.mode === "rotate") && drag.moved) {
      onCommitChange(defRef.current, drag.before);
    }
  };

  // Сетка с адаптивным шагом в метрах
  const gridStep = useMemo(() => chooseGridStep(Math.max(vb.w, vb.h)), [vb.w, vb.h]);
  const gridLines = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    const startX = Math.floor(vb.x / gridStep) * gridStep;
    const endX = vb.x + vb.w;
    const startY = Math.floor(vb.y / gridStep) * gridStep;
    const endY = vb.y + vb.h;
    for (let gx = startX; gx <= endX && xs.length < 120; gx += gridStep) xs.push(Number(gx.toFixed(2)));
    for (let gy = startY; gy <= endY && ys.length < 120; gy += gridStep) ys.push(Number(gy.toFixed(2)));
    return { xs, ys };
  }, [vb, gridStep]);

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
    if (!primary || primary.kind !== k) return false;
    if (k === "start") return true;
    return "id" in primary && primary.id === id;
  };

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
            сетка {gridStep} м · ↑ север (+Z)
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

      {/* Интерактивный SVG-холст карты */}
      <div className="relative rounded-xl bg-[#070d13] border hairline overflow-hidden select-none">
        <svg
          ref={svgRef}
          data-testid="map-editor-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onWheel={handleWheel}
          onPointerDown={handleCanvasPointerDown}
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
          {/* Метрическая сетка */}
          <g style={{ pointerEvents: "none" }}>
            {gridLines.xs.map((gx) => (
              <line
                key={`gx-${gx}`}
                x1={gx}
                y1={vb.y}
                x2={gx}
                y2={vb.y + vb.h}
                stroke={gx === 0 ? "rgba(82,214,189,0.22)" : "rgba(148,163,184,0.07)"}
                strokeWidth={gx === 0 ? thin * 1.1 : thin * 0.65}
              />
            ))}
            {gridLines.ys.map((gy) => (
              <line
                key={`gy-${gy}`}
                x1={vb.x}
                y1={gy}
                x2={vb.x + vb.w}
                y2={gy}
                stroke={gy === 0 ? "rgba(82,214,184,0.22)" : "rgba(148,163,184,0.07)"}
                strokeWidth={gy === 0 ? thin * 1.1 : thin * 0.65}
              />
            ))}
          </g>

          {/* Границы мира */}
          <rect
            x={-def.bounds.maxX}
            y={-def.bounds.maxZ}
            width={def.bounds.maxX - def.bounds.minX}
            height={def.bounds.maxZ - def.bounds.minZ}
            fill="rgba(15,25,35,0.42)"
            stroke="#2b3c4d"
            strokeDasharray={`${scale * 0.9} ${scale * 0.7}`}
            strokeWidth={thin * 1.1}
            style={{ pointerEvents: "none" }}
          />

          {/* Базовая асфальтовая площадка автодрома */}
          {def.useLotSurface !== false && (
            <rect
              x={-def.lotHalfX}
              y={-def.lotHalfZ}
              width={def.lotHalfX * 2}
              height={def.lotHalfZ * 2}
              fill="#19232e"
              stroke="#2a3948"
              strokeWidth={thin}
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
