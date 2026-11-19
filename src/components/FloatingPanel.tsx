/**
 * @module components/FloatingPanel
 * @layer ui
 * @role Перемещаемая и масштабируемая панель HUD/зеркал (grip `⠿`, удержание 420 мс с выводом на передний план, хранение в `cdt.layout.v1` / `cdt.layoutOrder.v1`).
 * @invariants #14 (перенос и подъём на передний слой за grip или longPress 420 мс; у педалей grip отделён от рабочей зоны).
 * @tests Смоук E, H, K, M (`tests/browser-smoke.mjs`)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

export type PanelLayout = { x: number; y: number; w: number };
export type LayoutMap = Record<string, PanelLayout>;

export const LAYOUT_STORAGE_KEY = "cdt.layout.v1";
export const LAYER_ORDER_STORAGE_KEY = "cdt.layoutOrder.v1";
export const PANEL_STATE_STORAGE_KEY = "cdt.panelState.v1";

export type PanelStateMap = {
  collapsed: string[];
  closed: string[];
};

const EMPTY_PANEL_STATE: PanelStateMap = { collapsed: [], closed: [] };

function sanitizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0 && item.length <= 48 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out.slice(0, 32);
}

/** Загружает список свёрнутых и закрытых HUD-панелей из `localStorage`. */
export function loadPanelState(): PanelStateMap {
  try {
    const raw = localStorage.getItem(PANEL_STATE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_PANEL_STATE;
    const rec = parsed as Record<string, unknown>;
    return {
      collapsed: sanitizeIdList(rec.collapsed),
      closed: sanitizeIdList(rec.closed),
    };
  } catch {
    return EMPTY_PANEL_STATE;
  }
}

/** Сохраняет список свёрнутых и закрытых HUD-панелей в `localStorage`. */
export function savePanelState(state: PanelStateMap): void {
  try {
    if (state.collapsed.length === 0 && state.closed.length === 0) {
      localStorage.removeItem(PANEL_STATE_STORAGE_KEY);
    } else {
      localStorage.setItem(
        PANEL_STATE_STORAGE_KEY,
        JSON.stringify({
          collapsed: state.collapsed.slice(0, 32),
          closed: state.closed.slice(0, 32),
        })
      );
    }
  } catch {
    // storage blocked
  }
}
/** Длительность удержания для выделения, вывода на передний план и переноса панели (мс). */
export const LONG_PRESS_MS = 420;
/** Базовый z-index для панелей, поднятых пользователем на передний слой (выше всех дефолтных 20..27). */
export const PANEL_PROMOTED_BASE_Z = 28;
/** z-index активно удерживаемой/перетаскиваемой панели (выше всех HUD-панелей, но ниже модальных окон z-50). */
export const PANEL_ACTIVE_Z = 45;

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

/** Загружает сохранённый порядок слоёв HUD-панелей (последний элемент — самый верхний план). */
export function loadLayerOrder(): string[] {
  try {
    const raw = localStorage.getItem(LAYER_ORDER_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.length > 0 && item.length <= 48 && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out.slice(-24);
  } catch {
    return [];
  }
}

/** Сохраняет порядок слоёв HUD-панелей в `localStorage`. */
export function saveLayerOrder(order: string[]): void {
  try {
    if (order.length === 0) {
      localStorage.removeItem(LAYER_ORDER_STORAGE_KEY);
    } else {
      localStorage.setItem(LAYER_ORDER_STORAGE_KEY, JSON.stringify(order.slice(-24)));
    }
  } catch {
    // storage blocked
  }
}

/** Перемещает панель `id` на самый верхний слой стека (без лишнего копирования, если уже сверху). */
export function promotePanelToFront(order: readonly string[], id: string): string[] {
  if (order.length > 0 && order[order.length - 1] === id) return order as string[];
  const next = order.filter((item) => item !== id);
  next.push(id);
  return next.slice(-24);
}

/** Вычисляет итоговый `z-index` панели с учётом пользовательского порядка слоёв. */
export function resolvePanelZIndex(id: string, baseZ: number, order: readonly string[]): number {
  const idx = order.indexOf(id);
  if (idx === -1) return baseZ;
  // Ограничиваем сверху 44, чтобы активная панель (45) и модальные окна (50) всегда были выше
  const start = Math.max(PANEL_PROMOTED_BASE_Z, 44 - order.length);
  return Math.min(44, start + idx);
}

type Props = {
  id: string;
  /** Без подписи панель перемещается только за grip-поле или по длительному нажатию */
  title?: string;
  /** Короткое название панели для кнопок «Свернуть / Закрыть» и свёрнутой шапки */
  label?: string;
  /** Краткая живая сводка, отображаемая когда панель свёрнута */
  collapsedSummary?: string;
  /** Свёрнута ли панель до компактной полоски заголовка */
  collapsed?: boolean;
  /** Переключение свёрнутого состояния (`−` / `+`) */
  onToggleCollapse?: (id: string) => void;
  /** Закрытие панели (`×`); восстановление — через меню «Окна» или «Управление» */
  onClose?: (id: string) => void;
  icon?: string;
  layout: PanelLayout | undefined;
  defaults: (containerW: number, containerH: number) => PanelLayout;
  minW: number;
  maxW: number;
  onChange: (id: string, next: PanelLayout) => void;
  /** Выводит панель на передний план/слой при длительном нажатии/тапе или захвате за ручку. */
  onBringToFront?: (id: string) => void;
  /** Признак того, что панель сейчас находится на самом верхнем пользовательском слое. */
  isFront?: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zIndex?: number;
  /** "header" — за заголовок или удержание 420 мс; "longPress" — удержание 420 мс или grip; "grip" — только за отдельную полоску (педали) */
  activation?: "header" | "longPress" | "grip";
  /** Доступное имя ручки. В режиме grip вся верхняя полоска отделена от кнопки педали. */
  gripLabel?: string;
  resizable?: boolean;
  children: ReactNode;
};

/**
 * Плавающая панель внутри 3D-вьюпорта.
 * Длительное нажатие/тап (0,4 с) или захват за grip-поле (⋮⋮) выделяет панель,
 * помещает её на передний план/слой поверх остальных панелей и позволяет перенести;
 * изменение ширины — за правый нижний угол; кнопки `−`/`+` и `×` сворачивают и закрывают элемент.
 */
export function FloatingPanel({
  id,
  title,
  label,
  collapsedSummary,
  collapsed = false,
  onToggleCollapse,
  onClose,
  icon = "grid",
  layout,
  defaults,
  minW,
  maxW,
  onChange,
  onBringToFront,
  isFront = false,
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
  const suppressClickUntilRef = useRef<number>(0);
  const current: PanelLayout = layout ?? fallback ?? { x: 12, y: 12, w: minW };
  const mode = activation ?? (title ? "header" : "longPress");
  // Длительный клик/тап работает на всех панелях, кроме рабочих поверхностей педалей (инвариант #14)
  const supportsBodyLongPress = mode !== "grip";
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
    if ((e.pointerType === "mouse" && e.button !== 0) || dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: kind, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: current.x, oy: current.y, ow: current.w };
    setArmed(true);
    onBringToFront?.(id);
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

  // Длительное нажатие/тап: выделяет панель, выводит её на передний слой и включает перенос
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
    if (!supportsBodyLongPress || dragRef.current || pressRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
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
      onBringToFront?.(id);
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
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.dragging) {
      if (Math.abs(dx) > 9 || Math.abs(dy) > 9) {
        window.clearTimeout(p.timer);
        pressRef.current = null;
      }
      return;
    }
    e.preventDefault();
    const pos = clampPos(p.ox + dx, p.oy + dy, current.w);
    onChange(id, { ...current, ...pos });
  };

  const bodyUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    window.clearTimeout(p.timer);
    if (p.dragging) {
      // Гасим синтетический click при отпускании длительного нажатия/тапа, чтобы не нажать кнопку под пальцем
      suppressClickUntilRef.current = performance.now() + 220;
      if (p.el.hasPointerCapture?.(p.id)) {
        p.el.releasePointerCapture(p.id);
      }
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

  const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickUntilRef.current > performance.now()) {
      suppressClickUntilRef.current = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (armed || pressRef.current?.dragging) {
      e.preventDefault();
    }
  };

  useEffect(() => {
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
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancelAll);
    return () => {
      if (pressRef.current) window.clearTimeout(pressRef.current.timer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancelAll);
    };
  }, []);

  const effectiveZIndex = armed ? PANEL_ACTIVE_Z : zIndex;
  const panelName = label ?? title ?? id;
  const hasWinControls = Boolean(onToggleCollapse || onClose);
  // В свёрнутом виде широкие панели сжимаются до аккуратной плашки, сохраняя исходную ширину при развороте
  const renderedWidth = collapsed
    ? mode === "grip"
      ? Math.max(current.w, 84)
      : Math.min(Math.max(current.w, 132), 228)
    : current.w;

  const stopBtnPointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
  };

  return (
    <div
      ref={panelRef}
      data-hud-panel={id}
      data-front={isFront || armed ? "true" : undefined}
      data-collapsed={collapsed ? "true" : undefined}
      style={{ left: current.x, top: current.y, width: renderedWidth, zIndex: effectiveZIndex }}
      className={`group absolute rounded-xl border-2 bg-[#0b1218]/94 shadow-xl overflow-hidden select-none transition-shadow ${
        armed
          ? "border-[#f5b942] shadow-[0_0_24px_rgba(245,185,66,.3)]"
          : supportsBodyLongPress
            ? "border-[#1f2c38] hover:border-[#2d414f]"
            : "border-[#1f2c38]"
      }`}
      onPointerDown={bodyDown}
      onPointerMove={bodyMove}
      onPointerUp={bodyUp}
      onPointerCancel={bodyUp}
      onPointerLeave={bodyLeave}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => e.stopPropagation()}
      title={supportsBodyLongPress ? "Удерживайте 0,4 с — вывести на передний план и перетащить" : undefined}
    >
      {collapsed ? (
        <div
          onPointerDown={beginDrag("move")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onToggleCollapse?.(id);
          }}
          className="flex items-center gap-1.5 pl-2 pr-1 py-1 bg-[#0c151d]/96 cursor-grab active:cursor-grabbing touch-none mono text-[10px] text-[#c5d4de]"
          title={`${panelName} (свёрнуто) — перетащите или нажмите «+» для разворота`}
        >
          <span className="truncate font-semibold text-[#d9e6ee]">
            {collapsedSummary ?? panelName}
          </span>
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            {onToggleCollapse && (
              <button
                type="button"
                aria-label={`Развернуть: ${panelName}`}
                title={`Развернуть «${panelName}»`}
                onPointerDown={stopBtnPointer}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse(id);
                }}
                className="grid place-items-center h-4 w-4 rounded text-[11px] font-bold leading-none text-[#52d6bd] hover:bg-[#52d6bd]/20 cursor-pointer"
              >
                +
              </button>
            )}
            {onClose && (
              <button
                type="button"
                aria-label={`Закрыть: ${panelName}`}
                title={`Закрыть «${panelName}»`}
                onPointerDown={stopBtnPointer}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
                className="grid place-items-center h-4 w-4 rounded text-[11px] font-bold leading-none text-[#8fa2ae] hover:text-[#ff8080] hover:bg-[#ff6b6b]/18 cursor-pointer"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {title && (
            <div
              onPointerDown={beginDrag("move")}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="flex items-center gap-1.5 pl-2 pr-1 py-1 bg-[#0a1016]/92 cursor-move touch-none mono text-[9px] text-[#9bafbc]"
              title="Перетащите или удерживайте, чтобы вывести на передний план и переместить"
            >
              <Icon name={icon} size={11} />
              <span className="truncate">{title}</span>
              <div className="ml-auto flex items-center gap-0.5 shrink-0">
                {onToggleCollapse && (
                  <button
                    type="button"
                    aria-label={`Свернуть: ${panelName}`}
                    title={`Свернуть «${panelName}»`}
                    onPointerDown={stopBtnPointer}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCollapse(id);
                    }}
                    className="grid place-items-center h-3.5 w-3.5 rounded text-[11px] leading-none text-[#8fa2ae] hover:text-[#f5b942] hover:bg-white/10 cursor-pointer"
                  >
                    −
                  </button>
                )}
                {onClose && (
                  <button
                    type="button"
                    aria-label={`Закрыть: ${panelName}`}
                    title={`Закрыть «${panelName}»`}
                    onPointerDown={stopBtnPointer}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(id);
                    }}
                    className="grid place-items-center h-3.5 w-3.5 rounded text-[11px] leading-none text-[#8fa2ae] hover:text-[#ff8080] hover:bg-[#ff6b6b]/18 cursor-pointer"
                  >
                    ×
                  </button>
                )}
                <span className="px-0.5 text-[#5b6f7d]">⋮⋮</span>
              </div>
            </div>
          )}
          {mode === "grip" && (
            <div className="pedal-bar">
              {onToggleCollapse && (
                <button
                  type="button"
                  className="pedal-win-btn"
                  aria-label={`Свернуть: ${panelName}`}
                  title={`Свернуть «${panelName}»`}
                  onPointerDown={stopBtnPointer}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCollapse(id);
                  }}
                >
                  −
                </button>
              )}
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
                  onBringToFront?.(id);
                  onChange(id, { ...current, ...clampPos(current.x + dir[0], current.y + dir[1], current.w) });
                }}>
                <svg width="22" height="10" viewBox="0 0 22 10" fill="currentColor" aria-hidden="true">
                  {[3, 8, 13, 18].map((x) => <g key={x}><circle cx={x} cy="2.5" r="1.35" /><circle cx={x} cy="7.5" r="1.35" /></g>)}
                </svg>
              </button>
              {onClose && (
                <button
                  type="button"
                  className="pedal-win-btn pedal-win-btn-close"
                  aria-label={`Закрыть: ${panelName}`}
                  title={`Закрыть «${panelName}»`}
                  onPointerDown={stopBtnPointer}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div>{children}</div>

          {/* Кнопки управления окном (− свернуть, × закрыть) и ручка переноса ⠿ */}
          {mode !== "grip" && !title && (
            <div
              className={`absolute right-1 top-1 flex items-center gap-[1px] px-0.5 py-[1px] rounded-md transition-opacity ${
                armed
                  ? "bg-[#f5b942] opacity-100"
                  : hasWinControls
                    ? "bg-[#131e28]/88 opacity-75 group-hover:opacity-100 focus-within:opacity-100"
                    : "bg-[#182430]/85 opacity-70 hover:opacity-100"
              }`}
            >
              {onToggleCollapse && !armed && (
                <button
                  type="button"
                  aria-label={`Свернуть: ${panelName}`}
                  title={`Свернуть «${panelName}»`}
                  onPointerDown={stopBtnPointer}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCollapse(id);
                  }}
                  className="grid place-items-center h-3.5 w-3.5 rounded text-[10px] font-bold leading-none text-[#9bafbc] hover:text-[#f5b942] hover:bg-white/10 cursor-pointer"
                >
                  −
                </button>
              )}
              {onClose && !armed && (
                <button
                  type="button"
                  aria-label={`Закрыть: ${panelName}`}
                  title={`Закрыть «${panelName}»`}
                  onPointerDown={stopBtnPointer}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(id);
                  }}
                  className="grid place-items-center h-3.5 w-3.5 rounded text-[10px] font-bold leading-none text-[#9bafbc] hover:text-[#ff8080] hover:bg-[#ff6b6b]/20 cursor-pointer"
                >
                  ×
                </button>
              )}
              <div
                onPointerDown={beginDrag("move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                className="grid place-items-center h-3.5 px-0.5 cursor-grab active:cursor-grabbing touch-none"
                title={gripLabel}
              >
                <span className={`text-[10px] leading-none ${armed ? "text-[#17130a]" : "text-[#9bafbc]"}`}>⠿</span>
              </div>
            </div>
          )}

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
        </>
      )}
    </div>
  );
}
