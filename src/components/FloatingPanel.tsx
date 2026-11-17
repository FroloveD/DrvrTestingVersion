import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

export type PanelLayout = { x: number; y: number; w: number };
export type LayoutMap = Record<string, PanelLayout>;

export const LAYOUT_STORAGE_KEY = "cdt.layout.v1";

export function loadLayout(): LayoutMap {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LayoutMap) : {};
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
  title: string;
  icon?: string;
  layout: PanelLayout | undefined;
  defaults: (containerW: number, containerH: number) => PanelLayout;
  minW: number;
  maxW: number;
  /** Высота панели задаётся содержимым (аспект сохраняется) */
  onChange: (id: string, next: PanelLayout) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zIndex?: number;
  children: ReactNode;
};

/**
 * Плавающая панель внутри 3D-вьюпорта: перетаскивание за заголовок,
 * изменение ширины за правый нижний угол, раскладка сохраняется в localStorage.
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
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState<PanelLayout | null>(null);
  const current: PanelLayout = layout ?? fallback ?? { x: 12, y: 12, w: minW };

  // Ленивые значения по умолчанию, когда размер контейнера уже известен
  useEffect(() => {
    if (layout) return;
    const box = containerRef.current;
    if (!box) return;
    setFallback(defaults(box.clientWidth, box.clientHeight));
    // defaults намеренно не в зависимостях: читаем только при первом монтировании
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, containerRef]);

  const clampPos = useCallback(
    (x: number, y: number, w: number) => {
      const box = containerRef.current;
      const panelH = panelRef.current?.offsetHeight ?? 80;
      const cw = box?.clientWidth ?? 800;
      const ch = box?.clientHeight ?? 600;
      return {
        x: Math.max(0, Math.min(x, cw - w)),
        y: Math.max(0, Math.min(y, ch - panelH)),
      };
    },
    [containerRef]
  );

  // При изменении размера окна держим панель внутри видимой области
  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const cur = layout ?? current;
      const pos = clampPos(cur.x, cur.y, cur.w);
      if (pos.x !== cur.x || pos.y !== cur.y) onChange(id, { ...cur, ...pos });
    });
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layout, clampPos]);

  const dragRef = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number } | null>(
    null
  );

  const beginDrag = (mode: "move" | "resize") => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, ox: current.x, oy: current.y, ow: current.w };
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      const pos = clampPos(d.ox + dx, d.oy + dy, current.w);
      onChange(id, { ...current, ...pos });
    } else {
      const w = Math.max(minW, Math.min(maxW, d.ow + dx));
      const pos = clampPos(current.x, current.y, w);
      onChange(id, { x: pos.x, y: pos.y, w });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={panelRef}
      style={{ left: current.x, top: current.y, width: current.w, zIndex }}
      className="absolute rounded-xl border-2 border-[#1f2c38] bg-[#0b1218]/94 shadow-xl overflow-hidden select-none"
      onDoubleClick={(e) => e.stopPropagation()}
    >
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
      <div>{children}</div>
      <div
        onPointerDown={beginDrag("resize")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none"
        title="Потяните, чтобы изменить размер"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="absolute right-0.5 bottom-0.5 text-[#9bafbc]">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  );
}
