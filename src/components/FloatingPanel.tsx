/**
 * @module components/FloatingPanel
 * @layer ui
 * @role Перемещаемая и масштабируемая панель HUD/зеркал (grip `⠿`, удержание 420 мс, хранение в `cdt.layout.v1`).
 * @invariants #14 (перенос за grip или longPress 420 мс; у педалей grip отделён от рабочей зоны).
 * @tests Смоук E, H, K, M (`tests/browser-smoke.mjs`)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

export type PanelLayout = { x: number; y: number; w: number };
export type LayoutMap = Record<string, PanelLayout>;

export const LAYOUT_STORAGE_KEY = "cdt.layout.v1";
/** Длительность удержания для переноса панели (мс). */
export const LONG_PRESS_MS = 420;

export function loadLayout(): LayoutMap {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const map: LayoutMap = {};
    for (const [key, value] of Object.entries(saved)) {
      if (value && typeof value === "object" && [value.x, value.y, value.w].every(Number.isFinite) && value.w > 0) {
        map[key] = { x: value.x, y: value.y, w: value.w };
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function saveLayout(map: LayoutMap): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage blocked
  }
}

type Props = {
  id: string;
  /** Без подписи панель перемещается только за grip-поле или по длительному нажатию */
  title?: string;
  icon?: string;
  layout: PanelLayout | undefined;
  defaults: (containerW: number, containerH: number) => PanelLayout;
  minW: number;
  maxW: number;
  onChange: (id: string, next: PanelLayout) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zIndex?: number;
  /** "header" — за заголовок; "longPress" — удержание 420 мс или grip-поле */
  activation?: "header" | "longPress" | "grip";
  /** Доступное имя ручки. В режиме grip вся верхняя полоска отделена от кнопки педали. */
  gripLabel?: string;
  resizable?: boolean;
  children: ReactNode;
};

/**
 * Плавающая панель внутри 3D-вьюпорта.
 * Перетаскивание — за grip-поле (⋮⋮) либо по длительному нажатию на панель;
 * изменение ширины — за правый нижний угол. Раскладка хранится в localStorage.
 */
export function FloatingPanel({
  id,
  title,
  icon = "grid",
  layout,
  defaults,
  minW,
  maxW,
  onChange,
  containerRef,
  zIndex = 25,
  activation,
  gripLabel = "Перетащить панель",
  resizable = true,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState<PanelLayout | null>(null);
  const [armed, setArmed] = useState(false);
  const current: PanelLayout = layout ?? fallback ?? { x: 12, y: 12, w: minW };
  const mode = activation ?? (title ? "header" : "longPress");
  const dragRef = useRef<{
    mode: "move" | "resize";
    pointerId: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    ow: number;
  } | null>(null);

  const clampPos = useCallback(
    (x: number, y: number, w: number) => {
      const box = containerRef.current;
      const panelH = panelRef.current?.offsetHeight ?? 80;
      const cw = box?.clientWidth ?? 800;
      const ch = box?.clientHeight ?? 600;
      // Скрытый тренажёр (переключение вкладок) даёт размер 0×0 — такие
      // отчёты не должны сдвигать панели в угол и накрывать друг друга
      if (cw <= 0 || ch <= 0) return { x, y };
      return {
        x: Math.max(0, Math.min(x, Math.max(0, cw - w))),
        y: Math.max(0, Math.min(y, Math.max(0, ch - panelH))),
      };
    },
    [containerRef]
  );

  // Без сохранённой позиции панель привязана к своей исходной кромке экрана.
  // При переносе привязка заменяется координатами. Проверяем и высоту самой панели:
  // строки кнопок могут переноситься, даже когда размеры вьюпорта не меняются.
  useEffect(() => {
    const box = containerRef.current;
    const panel = panelRef.current;
    if (!box || !panel) return;
    const reconcile = () => {
      const cw = box.clientWidth, ch = box.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const base = layout ?? defaults(cw, ch);
      const w = Math.min(cw, maxW, Math.max(minW, base.w));
      const next = { ...clampPos(base.x, base.y, w), w };
      if (layout) {
        if (next.x !== layout.x || next.y !== layout.y || w !== layout.w) onChange(id, next);
      } else {
        setFallback(old => old && old.x === next.x && old.y === next.y && old.w === w ? old : next);
      }
    };
    reconcile();
    const observer = new ResizeObserver(reconcile);
    observer.observe(box); observer.observe(panel);
    return () => observer.disconnect();
    // defaults задаёт геометрию для данного id; функция не зависит от состояния заезда.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layout, minW, maxW, containerRef, clampPos, onChange]);

  const beginDrag = (kind: "move" | "resize") => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: kind, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: current.x, oy: current.y, ow: current.w };
    setArmed(true);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      const pos = clampPos(d.ox + dx, d.oy + dy, current.w);
      onChange(id, { ...current, ...pos });
    } else {
      const w = Math.min(containerRef.current?.clientWidth || maxW, Math.max(minW, Math.min(maxW, d.ow + dx)));
      const pos = clampPos(current.x, current.y, w);
      onChange(id, { x: pos.x, y: pos.y, w });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setArmed(false);
  };

  // Длительное нажатие: запускаем перенос панели, если палец не сдвинулся дальше допуска
  const pressRef = useRef<{
    id: number;
    el: HTMLElement;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    timer: number;
    dragging: boolean;
  } | null>(null);

  const bodyDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "longPress" || dragRef.current || pressRef.current) return;
    const el = e.currentTarget;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = current.x;
    const oy = current.y;
    const timer = window.setTimeout(() => {
      const p = pressRef.current;
      if (!p) return;
      p.dragging = true;
      setArmed(true);
      try {
        p.el.setPointerCapture(p.id);
      } catch {
        // указатель уже не активен
      }
    }, LONG_PRESS_MS);
    pressRef.current = { id: e.pointerId, el, sx, sy, ox, oy, timer, dragging: false };
  };

  const bodyMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId || p.dragging) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (Math.abs(dx) > 9 || Math.abs(dy) > 9) {
      window.clearTimeout(p.timer);
      pressRef.current = null;
    }
  };

  const bodyUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    window.clearTimeout(p.timer);
    if (p.dragging && p.el.hasPointerCapture?.(p.id)) {
      p.el.releasePointerCapture(p.id);
    }
    pressRef.current = null;
    setArmed(false);
  };

  const bodyLeave = () => {
    const p = pressRef.current;
    if (p && !p.dragging) {
      window.clearTimeout(p.timer);
      pressRef.current = null;
    }
  };

  useEffect(() => {
    // После long-press указатель может покинуть DOM-панель. Слушаем движение
    // на window, чтобы перенос не зависел от доставки React pointer-события
    // через pointer capture конкретного браузера.
    const movePointer = (event: PointerEvent) => {
      const p = pressRef.current;
      if (!p || !p.dragging || p.id !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - p.sx;
      const dy = event.clientY - p.sy;
      const pos = clampPos(p.ox + dx, p.oy + dy, current.w);
      onChange(id, { ...current, ...pos });
    };
    const cancelAll = () => {
      const p = pressRef.current;
      if (p) window.clearTimeout(p.timer);
      pressRef.current = null;
      dragRef.current = null;
      setArmed(false);
    };
    const cancelPointer = (event: PointerEvent) => {
      if (event.pointerId === pressRef.current?.id || event.pointerId === dragRef.current?.pointerId) cancelAll();
    };
    window.addEventListener("pointermove", movePointer, { passive: false });
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancelAll);
    return () => {
      if (pressRef.current) window.clearTimeout(pressRef.current.timer);
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancelAll);
    };
  }, [clampPos, current, id, onChange]);

  return (
    <div
      ref={panelRef}
      data-hud-panel={id}
      style={{ left: current.x, top: current.y, width: current.w, zIndex }}
      className={`absolute rounded-xl border-2 bg-[#0b1218]/94 shadow-xl overflow-hidden select-none transition-shadow ${
        armed
          ? "border-[#f5b942] shadow-[0_0_24px_rgba(245,185,66,.25)]"
          : mode === "longPress"
            ? "border-[#1f2c38] hover:border-[#2d414f]"
            : "border-[#1f2c38]"
      }`}
      onPointerDown={bodyDown}
      onPointerMove={bodyMove}
      onPointerUp={bodyUp}
      onPointerCancel={bodyUp}
      onPointerLeave={bodyLeave}
      onDoubleClick={(e) => e.stopPropagation()}
      title={mode === "longPress" ? "Удерживайте 0,4 с — панель можно перетащить" : undefined}
    >
      {title && (
        <div
          onPointerDown={beginDrag("move")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="flex items-center gap-1.5 px-2 py-1 bg-[#0a1016]/92 cursor-move touch-none mono text-[9px] text-[#9bafbc]"
          title="Перетащите, чтобы переместить"
        >
          <Icon name={icon} size={11} />
          <span className="truncate">{title}</span>
          <span className="ml-auto text-[#5b6f7d]">⋮⋮</span>
        </div>
      )}
      {mode === "grip" && (
        <button type="button" className="pedal-grab" aria-label={gripLabel} title={`${gripLabel} · потяните или используйте стрелки`}
          onPointerDown={beginDrag("move")} onPointerMove={moveDrag} onPointerUp={endDrag}
          onPointerCancel={endDrag} onLostPointerCapture={endDrag}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 20 : 4;
            const delta: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
            };
            const dir = delta[e.key];
            if (!dir) return;
            e.preventDefault(); e.stopPropagation();
            onChange(id, { ...current, ...clampPos(current.x + dir[0], current.y + dir[1], current.w) });
          }}>
          <svg width="22" height="10" viewBox="0 0 22 10" fill="currentColor" aria-hidden="true">
            {[3, 8, 13, 18].map((x) => <g key={x}><circle cx={x} cy="2.5" r="1.35" /><circle cx={x} cy="7.5" r="1.35" /></g>)}
          </svg>
        </button>
      )}
      <div>{children}</div>

      {/* У педалей ручка находится над рабочей кнопкой и не перекрывает её. */}
      {mode !== "grip" && <div
        onPointerDown={beginDrag("move")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`absolute right-1 top-1 flex items-center gap-[2px] px-1 py-[2px] rounded-md cursor-grab active:cursor-grabbing touch-none transition-opacity ${
          armed ? "bg-[#f5b942] opacity-100" : "bg-[#182430]/85 opacity-70 hover:opacity-100"
        }`}
        onLostPointerCapture={endDrag}
        title={gripLabel}
      >
        <span className={`text-[11px] leading-none ${armed ? "text-[#17130a]" : "text-[#9bafbc]"}`}>⠿</span>
      </div>}

      {resizable && (
        <div
          onPointerDown={beginDrag("resize")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none"
          title="Потяните, чтобы изменить размер"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="absolute right-0.5 bottom-0.5 text-[#9bafbc]">
            <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </div>
      )}
    </div>
  );
}
